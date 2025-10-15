// src/services/notification.service.ts

import {
    FilterQuery,
    ProjectionType,
    ClientSession,
    Types,
    // types only:
    MongooseBulkWriteOptions,
    QueryOptions,
} from 'mongoose';
import {Role, AudienceMode} from '../types/roles';
import {UserModel, IUser} from '../models/user.model';

import {NotificationModel} from '../models/notifications/notification.model';

import type {
    Title,
    TitleCategory,
    DefinedTypes,
    Severity as NotificationSeverity,
    Channel as NotificationChannel,
    NotificationEntity,
} from '../models/notifications/notification.model';

import {UserNotificationModel} from '../models/notifications/user-notification.model';


/* ────────────────────────────────────────────────────────────────────────────
 * DTOs aligned with FE shape
 * ──────────────────────────────────────────────────────────────────────────── */

export interface NotificationAudienceDTO {
    mode: AudienceMode;
    usernames?: string[]; // explicit user targeting
    roles?: Array<
        'admin' | 'agent' | 'tenant' | 'owner' | 'operator' | 'manager' | 'developer' | 'user'
    >; // role-based
}

export interface CreateNotificationDTO {
    title: Title;
    body: string;
    type: DefinedTypes;
    severity?: NotificationSeverity;
    audience: NotificationAudienceDTO;
    channels?: NotificationChannel[];
    expiresAt?: Date;
    metadata?: Record<string, any>;
    icon?: string;
    tags?: string[];
    link?: string;
    source?: string;
}

export interface UserNotificationStateDTO {
    _id?: string;
    username: string;
    notificationId: string;
    isRead: boolean;
    isArchived: boolean;
    deliveredAt: Date;
    readAt?: Date;
}

export interface NotificationWithStateDTO {
    _id: string;
    title: Title;
    category: TitleCategory;
    body: string;
    type: DefinedTypes;
    severity?: NotificationSeverity;
    audience: NotificationAudienceDTO;
    channels?: NotificationChannel[];
    createdAt: string;
    expiresAt?: string;
    metadata?: Record<string, any>;
    icon?: string;
    tags?: string[];
    link?: string;
    source?: string;
    userState: {
        isRead: boolean;
        isArchived: boolean;
        deliveredAt: string;
        readAt?: string;
    };
}

export interface ListOptions {
    limit?: number;
    page?: number; // 0-based
    skip?: number; // legacy
    onlyUnread?: boolean;
    category?: TitleCategory;
    titles?: Title[];
    type?: string;
    severity?: NotificationSeverity;
    channel?: NotificationChannel;
    search?: string;
    createdAfter?: Date;
    createdBefore?: Date;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Service
 * ──────────────────────────────────────────────────────────────────────────── */
export default class NotificationService {
    constructor () {}

    /* =========================================================================
     * Utilities for strict-safe Mongoose options (exactOptionalPropertyTypes)
     * ========================================================================= */

    /** BulkWrite options with ordered=false and optional session (no undefined/null leakage) */
    private bulkOpts(
        session?: ClientSession
    ): {ordered: false} | {ordered: false; session: ClientSession} {
        return session ? {ordered: false, session} : {ordered: false};
    }

    /** findOneAndUpdate options with upsert/new and optional session (no undefined/null leakage) */
    private findOneAndUpdateOpts(
        session?: ClientSession
    ):
        | {upsert: true; new: false}
        | {upsert: true; new: false; session: ClientSession} {
        return session ? {upsert: true, new: false, session} : {upsert: true, new: false};
    }

    /** Delete options with optional session (compatible with Mongoose v6+) */
    private deleteOpts(session?: ClientSession): {session: ClientSession} | {} {
        return session ? {session} : {};
    }

    /* =========================================================================
     * Creation (masters) + Fan-out delivery (per-user state)
     * ========================================================================= */

    /** Guard audience payload for safety & early failure. */
    private validateAudience(a: NotificationAudienceDTO) {
        if(!a?.mode) throw new Error('Audience mode is required');
        if(a.mode === 'user' && !a.usernames?.length) {
            throw new Error('Audience usernames are required for mode=user');
        }
        if(a.mode === 'role' && !a.roles?.length) {
            throw new Error('Audience roles are required for mode=role');
        }
    }

    /** Compute Socket.IO rooms for this audience. */
    private roomsForAudience(a: NotificationAudienceDTO): string[] {
        const rooms = new Set<string>();
        if(a.mode === 'broadcast') rooms.add('broadcast');
        if(a.mode === 'user') (a.usernames ?? []).forEach((u) => rooms.add(`user:${u}`));
        if(a.mode === 'role') (a.roles ?? []).forEach((r) => rooms.add(`role:${r}`));
        return Array.from(rooms);
    }

    /**
     * Translate audience to a User query.
     * - broadcast → all active users
     * - user      → those usernames (and active)
     * - role      → users in those roles (and active)
     */
    private userQueryForAudience(a: NotificationAudienceDTO): FilterQuery<IUser> {
        if(a.mode === 'broadcast') {
            return {isActive: true};
        }
        if(a.mode === 'user') {
            return {isActive: true, username: {$in: a.usernames ?? []}};
        }
        // mode === 'role'
        return {isActive: true, role: {$in: a.roles ?? []}};
    }

    /**
     * Fan-out: upsert one `UserNotification` row for each eligible user.
     * - Uses a cursor to stream users.
     * - Batches bulkWrite to avoid huge payloads.
     * - Upsert is idempotent and safe for retries.
     */
    private async deliverToAudience(notification: NotificationEntity, session?: ClientSession) {
        const q = this.userQueryForAudience(notification.audience as NotificationAudienceDTO);
        const cursor = UserModel.find(q).select({username: 1}).lean().cursor();

        const ops: any[] = [];
        const notifId = String(notification._id);
        const now = new Date();

        for await(const u of cursor) {
            if(!u?.username) continue;

            ops.push({
                updateOne: {
                    filter: {username: u.username, notificationId: notifId},
                    update: {
                        $setOnInsert: {
                            deliveredAt: now,
                            isRead: false,
                            isArchived: false,
                        },
                    },
                    upsert: true,
                },
            });

            // Flush every 1k operations to keep memory and doc size in check
            if(ops.length >= 1000) {
                await UserNotificationModel.bulkWrite(ops, this.bulkOpts(session));
                ops.length = 0;
            }
        }

        // Flush remaining ops
        if(ops.length) {
            await UserNotificationModel.bulkWrite(ops, this.bulkOpts(session));
        }
    }

    /**
     * Create a master notification.
     * - Schema pre-validate derives `category` from `title`.
     * - Immediately fan-out per-user state rows.
     * - Optionally emit to Socket.IO rooms.
     */
    async createNotification(
        doc: CreateNotificationDTO,
        emit?: (rooms: string[], payload: NotificationEntity) => void,
        session?: ClientSession
    ) {
        this.validateAudience(doc.audience);

        // Create as an array to support transactions (Mongo needs array when session is used)
        const saved = await NotificationModel.create([{...doc, createdAt: new Date()}], session ? {session} : undefined);
        const persisted = saved[0];

        // Fan-out to all eligible users now (so FE won't see missing userState)
        await this.deliverToAudience(
            typeof (persisted as any).toObject === 'function' ? (persisted as any).toObject() : (persisted as any),
            session
        );

        // Socket emit to audience rooms
        const payload: NotificationEntity =
            typeof (persisted as any).toObject === 'function' ? (persisted as any).toObject() : (persisted as any);
        emit?.(this.roomsForAudience(doc.audience), payload);

        return persisted;
    }

    /* =========================================================================
     * Listing / Counting (masters) + Ensuring states exist
     * ========================================================================= */

    /** Audience visibility for master query (what masters a user can see). */
    private buildAudienceFilter(username: string, role: Role) {
        // ⬇️ Admin override: see *all* notifications, regardless of audience targeting
        if(role === 'admin') {
            return {} as FilterQuery<NotificationEntity>;
        }

        // Non-admin: original audience rules
        return {
            $or: [
                {'audience.mode': 'broadcast'},
                {'audience.mode': 'user', 'audience.usernames': username},
                {'audience.mode': 'role', 'audience.roles': role},
            ],
        } as FilterQuery<NotificationEntity>;
    }


    /** Build additional master filters (category, search, time window, etc.). */
    private buildListFilters(opts: ListOptions) {
        const f: FilterQuery<NotificationEntity> = {};

        if(opts.category) f.category = opts.category;
        if(opts.titles?.length) f.title = {$in: opts.titles};
        if(opts.type) f.type = opts.type;
        if(opts.severity) f.severity = opts.severity;
        if(opts.channel) f.channels = opts.channel;

        // time window
        if(opts.createdAfter || opts.createdBefore) {
            f.createdAt = {};
            if(opts.createdAfter) (f.createdAt as any).$gte = opts.createdAfter;
            if(opts.createdBefore) (f.createdAt as any).$lte = opts.createdBefore;
        }

        // simple contains search (title/body/tags)
        if(opts.search?.trim()) {
            const q = opts.search.trim();
            f.$or = [
                {title: {$regex: q, $options: 'i'}},
                {body: {$regex: q, $options: 'i'}},
                {tags: {$elemMatch: {$regex: q, $options: 'i'}}},
            ];
        }

        // ignore expired
        const now = new Date();
        f.$and = [{$or: [{expiresAt: {$exists: false}}, {expiresAt: {$gt: now}}]}];

        return f;
    }

    /** Projection used by list queries (lean for speed). */
    private buildProjection(): ProjectionType<NotificationEntity> {
        return {
            title: 1,
            category: 1,
            body: 1,
            type: 1,
            severity: 1,
            audience: 1,
            channels: 1,
            createdAt: 1,
            expiresAt: 1,
            metadata: 1,
            icon: 1,
            tags: 1,
            link: 1,
            source: 1,
        };
    }

    /** Ensure per-user state rows exist for all provided masters (idempotent). */
    private async ensureStatesForMasters(
        username: string,
        masters: NotificationEntity[],
        session?: ClientSession
    ) {
        await Promise.all(
            masters.map((n) =>
                UserNotificationModel.findOneAndUpdate(
                    {username, notificationId: String(n._id)},
                    {
                        $setOnInsert: {
                            deliveredAt: new Date(),
                            isRead: false,
                            isArchived: false,
                        },
                    },
                    this.findOneAndUpdateOpts(session)
                )
            )
        );
    }

    /** Fetch `UserNotification` rows as a Map by notificationId for fast merging. */
    private async fetchStatesMap(
        username: string,
        masterIds: string[],
        onlyUnread?: boolean
    ): Promise<Map<string, UserNotificationStateDTO>> {
        const stateFilter: FilterQuery<any> = {username, notificationId: {$in: masterIds}};
        if(onlyUnread) stateFilter.isRead = false;

        const states = await UserNotificationModel.find(stateFilter)
            .select({username: 1, notificationId: 1, isRead: 1, isArchived: 1, deliveredAt: 1, readAt: 1})
            .lean<UserNotificationStateDTO[]>();

        return new Map(states.map((s) => [String(s.notificationId), s]));
    }

    /** ISO-safe helper (accepts Date or string). */
    private iso(v?: Date | string) {
        if(!v) return undefined;
        if(v instanceof Date) return v.toISOString();
        const asDate = new Date(v);
        return Number.isNaN(asDate.getTime()) ? String(v) : asDate.toISOString();
    }

    /** Merge masters + per-user state → FE DTO, respecting `onlyUnread`. */
    private mergeToDTO(
        masters: NotificationEntity[],
        stateById: Map<string, UserNotificationStateDTO>,
        onlyUnread?: boolean
    ): NotificationWithStateDTO[] {
        return masters
            .map((n) => {
                const s = stateById.get(String(n._id));
                if(onlyUnread && s?.isRead) return null; // strictly filter read rows when asked

                const createdAtISO = this.iso(n.createdAt)!;
                const expiresAtISO = this.iso(n.expiresAt);

                return {
                    _id: String(n._id),
                    title: n.title as Title,
                    category: n.category as TitleCategory,
                    body: n.body,
                    type: n.type,
                    severity: n.severity as NotificationSeverity | undefined,
                    audience: n.audience as NotificationAudienceDTO,
                    channels: n.channels as NotificationChannel[] | undefined,
                    createdAt: createdAtISO,
                    expiresAt: expiresAtISO,
                    metadata: n.metadata,
                    icon: n.icon,
                    tags: n.tags,
                    link: n.link,
                    source: n.source,
                    userState: s
                        ? {
                            isRead: !!s.isRead,
                            isArchived: !!s.isArchived,
                            deliveredAt: this.iso(s.deliveredAt)!,
                            readAt: this.iso(s.readAt),
                        }
                        : {
                            // In the unlikely case upsert hasn’t completed yet
                            isRead: false,
                            isArchived: false,
                            deliveredAt: createdAtISO,
                        },
                } as NotificationWithStateDTO;
            })
            .filter((x): x is NotificationWithStateDTO => Boolean(x));
    }

    /**
     * Main list used by FE.
     * - Pull masters in user’s audience, apply filters/pagination
     * - Ensure per-user states exist (idempotent)
     * - Merge and return DTOs (optionally onlyUnread)
     */
    async listForUser(username: string, role: Role, opts: ListOptions = {}) {
        const limit = Math.max(1, opts.limit ?? 20);
        const page = Number.isFinite(opts.skip)
            ? Math.floor((opts.skip as number) / (opts.limit ?? 20))
            : Math.max(0, opts.page ?? 0);
        const onlyUnread = !!opts.onlyUnread;

        const audienceFilter = this.buildAudienceFilter(username, role);
        const extraFilters = this.buildListFilters(opts);
        const masterFilter: FilterQuery<NotificationEntity> = {...audienceFilter, ...extraFilters};

        const masters = await NotificationModel.find(masterFilter, this.buildProjection())
            .sort({createdAt: -1})
            .skip(page * limit)
            .limit(limit)
            .lean<NotificationEntity[]>();

        // ensure state rows exist so FE always receives userState
        await this.ensureStatesForMasters(username, masters);

        const ids = masters.map((m) => String(m._id));
        const stateById = await this.fetchStatesMap(username, ids, onlyUnread);

        return this.mergeToDTO(masters, stateById, onlyUnread);
    }

    /** Count masters (for pagination meta). If you need `onlyUnread` in count, you’d join with states. */
    async countForUser(username: string, role: Role, opts: ListOptions = {}) {
        const audienceFilter = this.buildAudienceFilter(username, role);
        const extraFilters = this.buildListFilters(opts);
        const masterFilter: FilterQuery<NotificationEntity> = {...audienceFilter, ...extraFilters};
        return NotificationModel.countDocuments(masterFilter).exec();
    }

    /* =========================================================================
     * Read / Archive / Delete (per-user state)
     * ========================================================================= */

    /** Mark one notification as read (upsert-safe). */
    markRead(username: string, notificationId: string) {
        return UserNotificationModel.updateOne(
            {username, notificationId: String(notificationId)},
            {$set: {isRead: true, readAt: new Date()}},
            {upsert: true}
        );
        // options object here doesn't need session; add a session param + this.findOneAndUpdateOpts if you want
    }

    /** Mark a set of notifications as read. */
    markManyRead(username: string, notificationIds: Array<string | Types.ObjectId>) {
        const ids = notificationIds.map(String);
        return UserNotificationModel.updateMany(
            {username, notificationId: {$in: ids}, isRead: false},
            {$set: {isRead: true, readAt: new Date()}}
        );
    }

    /** Mark ALL notifications as read (fast bulk). */
    markAllRead(username: string) {
        return UserNotificationModel.updateMany(
            {username, isRead: false},
            {$set: {isRead: true, readAt: new Date()}}
        );
    }

    /** Soft delete everything (archive flag). */
    archiveAll(username: string) {
        return UserNotificationModel.updateMany(
            {username, isArchived: false},
            {$set: {isArchived: true}}
        );
    }

    /** Hard delete all per-user state rows (does NOT remove master notifications). */
    deleteAllStatesForUser(username: string, session?: ClientSession) {
        return UserNotificationModel.deleteMany({username}, this.deleteOpts(session));
    }

    /** Hard delete a subset of per-user states. */
    deleteStatesForUser(
        username: string,
        notificationIds: Array<string | Types.ObjectId>,
        session?: ClientSession
    ) {
        const ids = notificationIds.map(String);
        return UserNotificationModel.deleteMany(
            {username, notificationId: {$in: ids}},
            this.deleteOpts(session)
        );
    }

    /**
     * Remove state rows that reference a non-existing master notification.
     * (Good housekeeping, run occasionally or on demand.)
     */
    async pruneOrphanStates(session?: ClientSession) {
        const orphans = await (UserNotificationModel as any)
            .aggregate([
                {
                    $lookup: {
                        from: 'notifications',
                        localField: 'notificationId',
                        foreignField: '_id',
                        as: 'n',
                    },
                },
                {$match: {n: {$size: 0}}},
                {$project: {_id: 1}},
            ])
            .session(session ?? null); // expects ClientSession | null

        if(!orphans.length) return 0;

        const ids = orphans.map((o: any) => o._id);
        const res = await UserNotificationModel.deleteMany({_id: {$in: ids}}, this.deleteOpts(session));
        return res.deletedCount || 0;
    }

    /* =========================================================================
     * Backfill / Auto-monitoring (keeps FE in sync across user changes)
     * ========================================================================= */

    /**
     * Ensure a user has state rows for ALL masters currently visible to them.
     * Call on login, or when enabling a user, etc.
     */
    async backfillForUser(username: string, role: Role, session?: ClientSession) {
        const audienceFilter = this.buildAudienceFilter(username, role);
        const masters = await NotificationModel.find(audienceFilter, {_id: 1}).lean<
            Pick<NotificationEntity, '_id'>[]
        >();
        if(!masters.length) return 0;

        const ops = masters.map((m) => ({
            updateOne: {
                filter: {username, notificationId: String(m._id)},
                update: {$setOnInsert: {deliveredAt: new Date(), isRead: false, isArchived: false}},
                upsert: true,
            },
        }));
        if(!ops.length) return 0;

        const res = await UserNotificationModel.bulkWrite(ops, this.bulkOpts(session));
        return (res.upsertedCount ?? 0) + (res.modifiedCount ?? 0);
    }

    /**
     * Push a historic/older notification to all eligible users now.
     * Useful after audience policy changes or migrations.
     */
    async backfillForAllUsersForNotification(notificationId: string, session?: ClientSession) {
        const n = await NotificationModel.findById(notificationId).lean<NotificationEntity | null>();
        if(!n) return 0;
        await this.deliverToAudience(n, session);
        return 1;
    }

    /**
     * Keep per-user states aligned with role transitions.
     * - Backfill for the new role.
     * - (Optional) Remove states for masters no longer visible to the user.
     */
    async syncForUserRoleChange(
        username: string,
        oldRole: Role,
        newRole: Role,
        removeNoLongerEligible = false,
        session?: ClientSession
    ) {
        // Always add rows the user SHOULD see now
        await this.backfillForUser(username, newRole, session);

        if(!removeNoLongerEligible) return {added: true, removed: false};

        // Optionally remove any states not in the new audience
        const inScopeNow = await NotificationModel.find(this.buildAudienceFilter(username, newRole), {_id: 1}).lean<
            {_id: Types.ObjectId}[]
        >();
        const keep = new Set(inScopeNow.map((x) => String(x._id)));

        const existing = await UserNotificationModel.find({username}).select({notificationId: 1}).lean();

        const removeIds = existing.map((s) => s.notificationId).filter((id) => !keep.has(String(id)));

        if(removeIds.length) {
            await UserNotificationModel.deleteMany(
                {username, notificationId: {$in: removeIds}},
                this.deleteOpts(session)
            );
        }

        return {added: true, removed: removeIds.length > 0};
    }

    /**
     * Optional: live auto-monitoring via Mongo Change Streams.
     * - New notifications → deliver immediately + emit to rooms
     * - New users / role changes → backfill/sync
     * Call once at app bootstrap if your MongoDB supports change streams.
     */
    watchChanges(io?: import('socket.io').Namespace) {
        // Watch notifications
        try {
            const notifStream = NotificationModel.watch([], {fullDocument: 'updateLookup'});
            notifStream.on('change', async (ev: any) => {
                if(ev.operationType === 'insert') {
                    const n = ev.fullDocument as NotificationEntity;

                    // Deliver to all eligible users now
                    await this.deliverToAudience(n);

                    // Emit to rooms so FE can update in real-time
                    if(io) {
                        const rooms = this.roomsForAudience(n.audience as any);
                        rooms.forEach((room) => io.to(room).emit('notification.new', n));
                    }
                }
            });
        } catch {
            // Change streams not available (standalone mongo, tests, etc.) — safe to ignore
        }

        // Watch users (new accounts, role toggles, activation changes)
        try {
            const userStream = UserModel.watch([], {fullDocument: 'updateLookup'});
            userStream.on('change', async (ev: any) => {
                if(ev.operationType === 'insert') {
                    const u = ev.fullDocument as IUser;
                    if(u?.isActive) {
                        await this.backfillForUser(u.username, u.role);
                    }
                } else if(ev.operationType === 'update' && ev.updateDescription?.updatedFields) {
                    const updated = ev.updateDescription.updatedFields;
                    if('role' in updated || 'isActive' in updated) {
                        const u = ev.fullDocument as IUser;
                        if(!u) return;
                        if(u.isActive) {
                            await this.backfillForUser(u.username, u.role);
                        } else {
                            // If deactivated, you may prefer archiving their state rows
                            await this.archiveAll(u.username);
                        }
                    }
                }
            });
        } catch {
            // Change streams not available — safe to ignore
        }
    }
}
