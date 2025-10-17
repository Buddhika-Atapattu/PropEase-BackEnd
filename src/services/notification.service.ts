// src/services/notification.service.ts
// ─────────────────────────────────────────────────────────────────────────────
// NotificationService
// - Create notifications + fan-out to users
// - List notifications and merge per-user state
// - Restore & Permanent Delete from /public/recyclebin/* (JSON + media folders)
// - Category dispatchers call small wrappers, which call generic helpers
// - Everything is class-based; no free functions
// - Comments are beginner-friendly and explain WHY, not just WHAT
// ─────────────────────────────────────────────────────────────────────────────

import path from 'path';                    // build safe file paths
import * as fsp from 'fs/promises';         // async fs (rm, mkdir, etc.)

import {
    FilterQuery,
    ProjectionType,
    ClientSession,
    Types,
    Connection,
} from 'mongoose';

import RecycleBinService from './recyclebin.service';
import {Role, AudienceMode} from '../types/roles';
import {UserModel, type IUser} from '../models/user.model';

// Master (notification) + per-user state
import {
    NotificationModel,
    type NotificationEntity,
    type Title,
    type TitleCategory,
    type DefinedTypes,
    type Severity as NotificationSeverity,
    type Channel as NotificationChannel,
} from '../models/notifications/notification.model';

import {UserNotificationModel} from '../models/notifications/user-notification.model';

// ─────────────────────────────────────────────────────────────────────────────
// DTOs (kept as-is, used across controller/service)
// ─────────────────────────────────────────────────────────────────────────────

export interface NotificationAudienceDTO {
    mode: AudienceMode;
    usernames?: string[];
    roles?: Array<'admin' | 'agent' | 'tenant' | 'owner' | 'operator' | 'manager' | 'developer' | 'user'>;
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
    // optional reference to the domain entity this notification is about
    target?: {kind?: TitleCategory; refId?: string};
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
    page?: number;
    skip?: number;
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

// ─────────────────────────────────────────────────────────────────────────────
// Restore / Permanent delete inputs & results
// ─────────────────────────────────────────────────────────────────────────────

export interface RestoreByCategoryInput {
    category: TitleCategory;                 // which domain collection
    refId?: string;                          // preferred key to find recyclebin entry
    snapshot?: Record<string, any>;          // optional fallback JSON from the request
    metadata?: Record<string, any>;          // free-form audit context
    requestedBy: string;                     // who triggered the action
    useTransaction?: boolean;                // wrap DB writes in a transaction
}

export interface PermanentDeleteInput {
    category: TitleCategory;                 // domain collection
    refId: string;                           // recyclebin entity to destroy
    metadata?: Record<string, any>;
    requestedBy: string;
    useTransaction?: boolean;
}

export interface DispatchResult {
    ok: boolean;                             // success flag
    message?: string;                        // human readable result
    rooms?: string[];                        // Socket.IO rooms to notify
    restored?: any;                          // restored document (or just its id)
}

// ─────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────

export default class NotificationService {
    // Keep one RecycleBinService instance around
    private readonly bin = new RecycleBinService();

    constructor () {}

    // ========== Small helper builders (bulk options, guards, etc.) =============

    private bulkOpts(session?: ClientSession) {
        return session ? {ordered: false as const, session} : {ordered: false as const};
    }

    private findOneAndUpdateOpts(session?: ClientSession) {
        return session
            ? {upsert: true as const, new: false as const, session}
            : {upsert: true as const, new: false as const};
    }

    private deleteOpts(session?: ClientSession) {
        return session ? {session} : {};
    }

    /** Validate audience input early so we fail fast with a clear message. */
    private validateAudience(a: NotificationAudienceDTO) {
        if(!a?.mode) throw new Error('Audience mode is required');
        if(a.mode === 'user' && !a.usernames?.length) throw new Error('Audience usernames are required for mode=user');
        if(a.mode === 'role' && !a.roles?.length) throw new Error('Audience roles are required for mode=role');
    }

    /** Compute Socket.IO rooms for broadcast/user/role. */
    private roomsForAudience(a: NotificationAudienceDTO): string[] {
        const rooms = new Set<string>();
        if(a.mode === 'broadcast') rooms.add('broadcast');
        if(a.mode === 'user') (a.usernames ?? []).forEach(u => rooms.add(`user:${u}`));
        if(a.mode === 'role') (a.roles ?? []).forEach(r => rooms.add(`role:${r}`));
        return Array.from(rooms);
    }

    /** Turn the audience into a Mongoose query for users. */
    private userQueryForAudience(a: NotificationAudienceDTO): FilterQuery<IUser> {
        if(a.mode === 'broadcast') return {isActive: true};
        if(a.mode === 'user') return {isActive: true, username: {$in: a.usernames ?? []}};
        return {isActive: true, role: {$in: a.roles ?? []}};
    }

    /** Create/Upsert per-user states for the given notification. */
    private async deliverToAudience(notification: NotificationEntity, session?: ClientSession) {
        const q = this.userQueryForAudience(notification.audience as NotificationAudienceDTO);
        const cursor = UserModel.find(q).select({username: 1}).lean().cursor();   // stream users to avoid huge memory

        const ops: any[] = [];
        const notifId = String(notification._id);
        const now = new Date();

        for await(const u of cursor) {
            if(!u?.username) continue;

            ops.push({
                updateOne: {
                    filter: {username: u.username, notificationId: notifId},
                    update: {$setOnInsert: {deliveredAt: now, isRead: false, isArchived: false}},
                    upsert: true,
                },
            });

            // flush in chunks to keep memory steady
            if(ops.length >= 1000) {
                await UserNotificationModel.bulkWrite(ops, this.bulkOpts(session));
                ops.length = 0;
            }
        }

        if(ops.length) await UserNotificationModel.bulkWrite(ops, this.bulkOpts(session));
    }

    // ============================ Creation =====================================

    /**
     * Create a master notification and fan-out per-user states.
     * FE benefits because reads can include `userState` immediately.
     */
    async createNotification(
        doc: CreateNotificationDTO,
        emit?: (rooms: string[], payload: NotificationEntity) => void,
        session?: ClientSession
    ) {
        this.validateAudience(doc.audience);

        // create returns an array when we pass array payloads
        const [persisted] = await NotificationModel.create(
            [{...doc, createdAt: new Date()}],
            session ? {session} : undefined
        );

        // convert to POJO to avoid Mongoose docs leaking into sockets
        const plain = typeof (persisted as any).toObject === 'function'
            ? (persisted as any).toObject()
            : (persisted as any);

        // ensure per-user states exist
        await this.deliverToAudience(plain, session);

        // optional socket emission
        emit?.(this.roomsForAudience(doc.audience), plain);

        return persisted;
    }

    // ============================ Listing ======================================

    private buildAudienceFilter(username: string, role: Role) {
        if(role === 'admin') return {} as FilterQuery<NotificationEntity>;
        return {
            $or: [
                {'audience.mode': 'broadcast'},
                {'audience.mode': 'user', 'audience.usernames': username},
                {'audience.mode': 'role', 'audience.roles': role},
            ],
        } as FilterQuery<NotificationEntity>;
    }

    private buildListFilters(opts: ListOptions) {
        const f: FilterQuery<NotificationEntity> = {};
        if(opts.category) f.category = opts.category;
        if(opts.titles?.length) f.title = {$in: opts.titles};
        if(opts.type) f.type = opts.type;
        if(opts.severity) f.severity = opts.severity;
        if(opts.channel) f.channels = opts.channel;

        if(opts.createdAfter || opts.createdBefore) {
            f.createdAt = {};
            if(opts.createdAfter) (f.createdAt as any).$gte = opts.createdAfter;
            if(opts.createdBefore) (f.createdAt as any).$lte = opts.createdBefore;
        }

        if(opts.search?.trim()) {
            const q = opts.search.trim();
            f.$or = [
                {title: {$regex: q, $options: 'i'}},
                {body: {$regex: q, $options: 'i'}},
                {tags: {$elemMatch: {$regex: q, $options: 'i'}}},
            ];
        }

        // hide expired
        const now = new Date();
        f.$and = [{$or: [{expiresAt: {$exists: false}}, {expiresAt: {$gt: now}}]}];

        return f;
    }

    private buildProjection(): ProjectionType<NotificationEntity> {
        return {
            title: 1, category: 1, body: 1, type: 1, severity: 1,
            audience: 1, channels: 1, createdAt: 1, expiresAt: 1,
            metadata: 1, icon: 1, tags: 1, link: 1, source: 1, target: 1,
        };
    }

    private async ensureStatesForMasters(username: string, masters: NotificationEntity[], session?: ClientSession) {
        await Promise.all(
            masters.map(n =>
                UserNotificationModel.findOneAndUpdate(
                    {username, notificationId: String(n._id)},
                    {$setOnInsert: {deliveredAt: new Date(), isRead: false, isArchived: false}},
                    this.findOneAndUpdateOpts(session)
                )
            )
        );
    }

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

        return new Map(states.map(s => [String(s.notificationId), s]));
    }

    private iso(v?: Date | string) {
        if(!v) return undefined;
        if(v instanceof Date) return v.toISOString();
        const asDate = new Date(v);
        return Number.isNaN(asDate.getTime()) ? String(v) : asDate.toISOString();
    }

    private mergeToDTO(
        masters: NotificationEntity[],
        stateById: Map<string, UserNotificationStateDTO>,
        onlyUnread?: boolean
    ): NotificationWithStateDTO[] {
        return masters
            .map(n => {
                const s = stateById.get(String(n._id));
                if(onlyUnread && s?.isRead) return null;

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
                        : {isRead: false, isArchived: false, deliveredAt: createdAtISO},
                } as NotificationWithStateDTO;
            })
            .filter((x): x is NotificationWithStateDTO => Boolean(x));
    }

    async listForUser(username: string, role: Role, opts: ListOptions = {}) {
        const limit = Math.max(1, opts.limit ?? 20);
        const page = Number.isFinite(opts.skip) ? Math.floor((opts.skip as number) / (opts.limit ?? 20)) : Math.max(0, opts.page ?? 0);
        const onlyUnread = !!opts.onlyUnread;

        const audienceFilter = this.buildAudienceFilter(username, role);
        const extraFilters = this.buildListFilters(opts);
        const masterFilter: FilterQuery<NotificationEntity> = {...audienceFilter, ...extraFilters};

        const masters = await NotificationModel.find(masterFilter, this.buildProjection())
            .sort({createdAt: -1})
            .skip(page * limit)
            .limit(limit)
            .lean<NotificationEntity[]>();

        await this.ensureStatesForMasters(username, masters);

        const ids = masters.map(m => String(m._id));
        const stateById = await this.fetchStatesMap(username, ids, onlyUnread);

        return this.mergeToDTO(masters, stateById, onlyUnread);
    }

    async countForUser(username: string, role: Role, opts: ListOptions = {}) {
        const audienceFilter = this.buildAudienceFilter(username, role);
        const extraFilters = this.buildListFilters(opts);
        const masterFilter: FilterQuery<NotificationEntity> = {...audienceFilter, ...extraFilters};
        return NotificationModel.countDocuments(masterFilter).exec();
    }

    // ========================== Per-user state ops ==============================

    markRead(username: string, notificationId: string) {
        return UserNotificationModel.updateOne(
            {username, notificationId: String(notificationId)},
            {$set: {isRead: true, readAt: new Date()}},
            {upsert: true}
        );
    }

    markManyRead(username: string, notificationIds: Array<string | Types.ObjectId>) {
        const ids = notificationIds.map(String);
        return UserNotificationModel.updateMany(
            {username, notificationId: {$in: ids}, isRead: false},
            {$set: {isRead: true, readAt: new Date()}}
        );
    }

    markAllRead(username: string) {
        return UserNotificationModel.updateMany(
            {username, isRead: false},
            {$set: {isRead: true, readAt: new Date()}}
        );
    }

    archiveAll(username: string) {
        return UserNotificationModel.updateMany(
            {username, isArchived: false},
            {$set: {isArchived: true}}
        );
    }

    deleteAllStatesForUser(username: string, session?: ClientSession) {
        return UserNotificationModel.deleteMany({username}, this.deleteOpts(session));
    }

    deleteStatesForUser(username: string, notificationIds: Array<string | Types.ObjectId>, session?: ClientSession) {
        const ids = notificationIds.map(String);
        return UserNotificationModel.deleteMany({username, notificationId: {$in: ids}}, this.deleteOpts(session));
    }

    async pruneOrphanStates(session?: ClientSession) {
        const orphans = await (UserNotificationModel as any)
            .aggregate([
                {$lookup: {from: 'notifications', localField: 'notificationId', foreignField: '_id', as: 'n'}},
                {$match: {n: {$size: 0}}},
                {$project: {_id: 1}},
            ])
            .session(session ?? null);

        if(!orphans.length) return 0;
        const ids = orphans.map((o: any) => o._id);
        const res = await UserNotificationModel.deleteMany({_id: {$in: ids}}, this.deleteOpts(session));
        return res.deletedCount || 0;
    }

    // ========================= Restore / Hard Delete ============================

    /**
     * RESTORE public API (controller calls this).
     * - Reads snapshot JSON from /public/recyclebin/<category>/<refId>/data.json
     * - Recreates the DB row (with deleted flags cleared)
     * - Moves media folder from recyclebin back to its original dest
     * - Optionally runs inside a transaction
     */
    async restoreByCategory(input: RestoreByCategoryInput): Promise<DispatchResult> {
        const {category, refId, snapshot, requestedBy} = input;
        const metadata = input.metadata ?? {};
        const useTransaction = !!input.useTransaction;

        // Pick a session if the caller wants a transaction
        if(useTransaction) {
            const conn: Connection = NotificationModel.db;
            const session = await conn.startSession();
            try {
                session.startTransaction();

                // Only include properties that exist; avoids {refId: undefined}
                const payload = {
                    category,
                    metadata,
                    requestedBy,
                    ...(refId ? {refId} : {}),
                    ...(snapshot ? {snapshot} : {}),
                } as const;

                const res = await this._restoreDispatcher(payload, session);
                await session.commitTransaction();
                session.endSession();
                return res;
            } catch(e: any) {
                await session.abortTransaction();
                session.endSession();
                return {ok: false, message: e?.message || 'Restore failed (tx)'};
            }
        }

        // Non-transaction path
        const payload = {
            category,
            metadata,
            requestedBy,
            ...(refId ? {refId} : {}),
            ...(snapshot ? {snapshot} : {}),
        } as const;

        return this._restoreDispatcher(payload);
    }

    /**
     * PERMANENT DELETE public API (controller calls this).
     * - Purges recyclebin copy for that entity
     * - Also tries to remove any leftover original public folder (defense-in-depth)
     */
    async permanentDeleteByCategory(input: PermanentDeleteInput): Promise<DispatchResult> {
        const {category} = input;
        const metadata = input.metadata ?? {};
        const requestedBy = input.requestedBy;
        const useTransaction = !!input.useTransaction;

        const refId = typeof input.refId === 'string' ? input.refId.trim() : '';
        if(!refId) return {ok: false, message: 'refId is required for permanent delete'};

        if(useTransaction) {
            const conn: Connection = NotificationModel.db;
            const session = await conn.startSession();
            try {
                session.startTransaction();
                const res = await this._permanentDeleteDispatcher({category, refId, metadata, requestedBy}, session);
                await session.commitTransaction();
                session.endSession();
                return res;
            } catch(e: any) {
                await session.abortTransaction();
                session.endSession();
                return {ok: false, message: e?.message || 'Permanent delete failed (tx)'};
            }
        }

        return this._permanentDeleteDispatcher({category, refId, metadata, requestedBy});
    }

    // ----------------------- Dispatchers (internal) ----------------------------

    private async _restoreDispatcher(
        input: {category: TitleCategory; refId?: string; snapshot?: Record<string, any>; metadata: any; requestedBy: string},
        session?: ClientSession
    ): Promise<DispatchResult> {
        const {category} = input;

        // We keep small category methods to stay class-based and future-extensible
        switch(category) {
            case 'User': return this.restoreUser(input, session);
            case 'Tenant': return this.restoreTenant(input, session);
            case 'Property': return this.restoreProperty(input, session);
            case 'Lease': return this.restoreLease(input, session);
            case 'Agent': return this.restoreAgent(input, session);
            case 'Developer': return this.restoreDeveloper(input, session);
            case 'Maintenance': return this.restoreMaintenance(input, session);
            case 'Complaint': return this.restoreComplaint(input, session);
            case 'Team': return this.restoreTeam(input, session);
            case 'Registration':
            case 'Payment':
            case 'System':
            default:
                return {ok: false, message: `Restore not supported for category "${category}"`};
        }
    }

    private async _permanentDeleteDispatcher(
        input: {category: TitleCategory; refId: string; metadata: any; requestedBy: string},
        _session?: ClientSession
    ): Promise<DispatchResult> {
        const {category} = input;

        switch(category) {
            case 'User': return this.hardDeleteUser(input);
            case 'Tenant': return this.hardDeleteTenant(input);
            case 'Property': return this.hardDeleteProperty(input);
            case 'Lease': return this.hardDeleteLease(input);
            case 'Agent': return this.hardDeleteAgent(input);
            case 'Developer': return this.hardDeleteDeveloper(input);
            case 'Maintenance': return this.hardDeleteMaintenance(input);
            case 'Complaint': return this.hardDeleteComplaint(input);
            case 'Team': return this.hardDeleteTeam(input);
            case 'Registration':
            case 'Payment':
            case 'System':
            default:
                return {ok: false, message: `Permanent delete not supported for category "${category}"`};
        }
    }

    // --------------------- Generic helpers (core logic) ------------------------

    /**
     * Get the Mongoose model for a TitleCategory without importing it directly.
     * This avoids circular imports. Update names if your model names differ.
     */
    private getModelFor(category: TitleCategory) {
        switch(category) {
            case 'User': return NotificationModel.db.model('User');
            case 'Tenant': return NotificationModel.db.model('Tenant');
            case 'Property': return NotificationModel.db.model('Property');
            case 'Lease': return NotificationModel.db.model('Lease');
            case 'Agent': return NotificationModel.db.model('Agent');
            case 'Developer': return NotificationModel.db.model('Developer');
            case 'Maintenance': return NotificationModel.db.model('Maintenance');
            case 'Complaint': return NotificationModel.db.model('Complaint');
            case 'Team': return NotificationModel.db.model('Team');
            case 'Registration': return NotificationModel.db.model('Registration');
            case 'Payment': return NotificationModel.db.model('Payment');
            case 'System': return NotificationModel.db.model('SystemEvent');
            default: return null;
        }
    }

    /**
     * Compute where original files live by category (relative to /public).
     * Prefer snapshot.__filesRoot if your deletion step saved it.
     */
    private resolveDestFolder(category: TitleCategory, refId: string, snapshot?: Record<string, any>): string {
        if(snapshot && typeof snapshot.__filesRoot === 'string' && snapshot.__filesRoot.trim()) {
            return snapshot.__filesRoot.trim();
        }
        const base = 'uploads';
        switch(category) {
            case 'User': return path.posix.join(base, 'users', refId);
            case 'Tenant': return path.posix.join(base, 'tenants', refId);
            case 'Property': return path.posix.join(base, 'properties', refId);
            case 'Lease': return path.posix.join(base, 'leases', refId);
            case 'Agent': return path.posix.join(base, 'agents', refId);
            case 'Developer': return path.posix.join(base, 'developers', refId);
            case 'Maintenance': return path.posix.join(base, 'maintenance', refId);
            case 'Complaint': return path.posix.join(base, 'complaints', refId);
            case 'Team': return path.posix.join(base, 'teams', refId);
            case 'Registration': return path.posix.join(base, 'registrations', refId);
            case 'Payment': return path.posix.join(base, 'payments', refId);
            case 'System': return path.posix.join(base, 'system', refId);
            default: return path.posix.join(base, 'misc', refId);
        }
    }

    /**
     * Generic RESTORE:
     * 1) read JSON from recyclebin
     * 2) insert into DB with deleted flags cleared
     * 3) move media folder back under /public/<dest>
     * 4) purge recyclebin copy
     */
    private async restoreGeneric(
        category: TitleCategory,
        refId: string,
        metadata: Record<string, any>,
        session?: ClientSession,
        incomingSnapshot?: Record<string, any>
    ): Promise<DispatchResult> {
        // 1) model lookup
        const Model = this.getModelFor(category);
        if(!Model) return {ok: false, message: `${category} model unavailable`};

        // 2) prefer recyclebin copy; fallback to payload snapshot
        const fileSnap = await this.bin.readSnapshot(category, refId);
        const payload = (fileSnap.ok && fileSnap.data) ? fileSnap.data : (incomingSnapshot ?? null);
        if(!payload) return {ok: false, message: `No snapshot found in recyclebin for ${category}/${refId}`};

        // 3) clear deletion flags and (optionally) _id strategy
        const {_id, ...rest} = payload;
        const toInsert = {
            ...rest,
            deleted: false,
            deletedAt: null,
            deletedBy: null,
        };

        // If you want to keep the same _id, replace with: const [doc] = await Model.create([{ _id, ...toInsert }], ...)
        const [doc] = await (Model as any).create([toInsert], session ? {session} : undefined);

        // 4) move media back
        try {
            const destRel = this.resolveDestFolder(category, String(doc._id), payload);
            await this.bin.restoreFolder(category, refId, destRel);
        } catch(e) {
            console.warn(`[restore:${category}] Media move warning:`, e);
        }

        // 5) purge recyclebin copy
        try {await this.bin.purge(category, refId);} catch {}

        return {
            ok: true,
            message: `${category} restored`,
            restored: {_id: doc._id},
            rooms: this.roomsOnRestore(category.toLowerCase(), metadata),
        };
    }

    /**
     * Generic HARD DELETE:
     * - purge recyclebin copy
     * - remove original dest folder under /public if it exists (safe + force)
     */
    private async hardDeleteGeneric(
        category: TitleCategory,
        refId: string,
        metadata: Record<string, any>
    ): Promise<DispatchResult> {
        // remove recyclebin copy
        await this.bin.purge(category, refId);

        // attempt to cleanup original dest folder too
        try {
            const destRel = this.resolveDestFolder(category, refId);
            const abs = path.resolve(process.cwd(), 'public', destRel);
            await fsp.rm(abs, {recursive: true, force: true});
        } catch(e) {
            console.warn(`[hardDelete:${category}] leftover public folder cleanup warning:`, e);
        }

        return {ok: true, message: `${category} permanently deleted`, rooms: this.roomsOnDelete(category.toLowerCase(), metadata)};
    }

    // ---------------------- Category restore (thin wrappers) --------------------

    private async restoreUser({refId, metadata, snapshot}: {refId?: string; metadata: any; snapshot?: Record<string, any>}, s?: ClientSession) {if(!refId) return {ok: false, message: 'refId required for restore'}; return this.restoreGeneric('User', refId, metadata, s, snapshot);}
    private async restoreTenant({refId, metadata, snapshot}: {refId?: string; metadata: any; snapshot?: Record<string, any>}, s?: ClientSession) {if(!refId) return {ok: false, message: 'refId required for restore'}; return this.restoreGeneric('Tenant', refId, metadata, s, snapshot);}
    private async restoreProperty({refId, metadata, snapshot}: {refId?: string; metadata: any; snapshot?: Record<string, any>}, s?: ClientSession) {if(!refId) return {ok: false, message: 'refId required for restore'}; return this.restoreGeneric('Property', refId, metadata, s, snapshot);}
    private async restoreLease({refId, metadata, snapshot}: {refId?: string; metadata: any; snapshot?: Record<string, any>}, s?: ClientSession) {if(!refId) return {ok: false, message: 'refId required for restore'}; return this.restoreGeneric('Lease', refId, metadata, s, snapshot);}
    private async restoreAgent({refId, metadata, snapshot}: {refId?: string; metadata: any; snapshot?: Record<string, any>}, s?: ClientSession) {if(!refId) return {ok: false, message: 'refId required for restore'}; return this.restoreGeneric('Agent', refId, metadata, s, snapshot);}
    private async restoreDeveloper({refId, metadata, snapshot}: {refId?: string; metadata: any; snapshot?: Record<string, any>}, s?: ClientSession) {if(!refId) return {ok: false, message: 'refId required for restore'}; return this.restoreGeneric('Developer', refId, metadata, s, snapshot);}
    private async restoreMaintenance({refId, metadata, snapshot}: {refId?: string; metadata: any; snapshot?: Record<string, any>}, s?: ClientSession) {if(!refId) return {ok: false, message: 'refId required for restore'}; return this.restoreGeneric('Maintenance', refId, metadata, s, snapshot);}
    private async restoreComplaint({refId, metadata, snapshot}: {refId?: string; metadata: any; snapshot?: Record<string, any>}, s?: ClientSession) {if(!refId) return {ok: false, message: 'refId required for restore'}; return this.restoreGeneric('Complaint', refId, metadata, s, snapshot);}
    private async restoreTeam({refId, metadata, snapshot}: {refId?: string; metadata: any; snapshot?: Record<string, any>}, s?: ClientSession) {if(!refId) return {ok: false, message: 'refId required for restore'}; return this.restoreGeneric('Team', refId, metadata, s, snapshot);}

    // ---------------------- Category hard delete (thin wrappers) ----------------

    private async hardDeleteUser({refId, metadata}: {refId: string; metadata: any}) {return this.hardDeleteGeneric('User', refId, metadata);}
    private async hardDeleteTenant({refId, metadata}: {refId: string; metadata: any}) {return this.hardDeleteGeneric('Tenant', refId, metadata);}
    private async hardDeleteProperty({refId, metadata}: {refId: string; metadata: any}) {return this.hardDeleteGeneric('Property', refId, metadata);}
    private async hardDeleteLease({refId, metadata}: {refId: string; metadata: any}) {return this.hardDeleteGeneric('Lease', refId, metadata);}
    private async hardDeleteAgent({refId, metadata}: {refId: string; metadata: any}) {return this.hardDeleteGeneric('Agent', refId, metadata);}
    private async hardDeleteDeveloper({refId, metadata}: {refId: string; metadata: any}) {return this.hardDeleteGeneric('Developer', refId, metadata);}
    private async hardDeleteMaintenance({refId, metadata}: {refId: string; metadata: any}) {return this.hardDeleteGeneric('Maintenance', refId, metadata);}
    private async hardDeleteComplaint({refId, metadata}: {refId: string; metadata: any}) {return this.hardDeleteGeneric('Complaint', refId, metadata);}
    private async hardDeleteTeam({refId, metadata}: {refId: string; metadata: any}) {return this.hardDeleteGeneric('Team', refId, metadata);}

    // ===================== Room helpers for live updates ========================

    private roomsOnRestore(kind: string, meta: Record<string, any> = {}): string[] {
        const rooms: string[] = [];
        if(typeof meta?.byUser === 'string' && meta.byUser.trim()) rooms.push(`user:${meta.byUser.trim()}`);
        rooms.push(`domain:${kind}`);
        rooms.push('role:admin');
        return rooms;
    }

    private roomsOnDelete(kind: string, meta: Record<string, any> = {}): string[] {
        const rooms: string[] = [];
        if(typeof meta?.byUser === 'string' && meta.byUser.trim()) rooms.push(`user:${meta.byUser.trim()}`);
        rooms.push(`domain:${kind}`);
        rooms.push('role:admin');
        return rooms;
    }

    // ====================== Change streams (optional) ===========================

    watchChanges(io?: import('socket.io').Namespace) {
        // Watch Notification inserts and fan-out automatically
        try {
            const notifStream = NotificationModel.watch([], {fullDocument: 'updateLookup'});
            notifStream.on('change', async (ev: any) => {
                if(ev.operationType === 'insert') {
                    const n = ev.fullDocument as NotificationEntity;
                    await this.deliverToAudience(n);
                    if(io) {
                        const rooms = this.roomsForAudience(n.audience as any);
                        rooms.forEach(room => io.to(room).emit('notification.new', n));
                    }
                }
            });
        } catch {
            /* change streams unavailable — ok */
        }

        // Example: on user changes, backfill notification states as needed
        try {
            const userStream = UserModel.watch([], {fullDocument: 'updateLookup'});
            userStream.on('change', async (ev: any) => {
                if(ev.operationType === 'insert') {
                    const u = ev.fullDocument as IUser;
                    if(u?.isActive) await this.backfillForUser(u.username, u.role);
                } else if(ev.operationType === 'update' && ev.updateDescription?.updatedFields) {
                    const updated = ev.updateDescription.updatedFields;
                    if('role' in updated || 'isActive' in updated) {
                        const u = ev.fullDocument as IUser;
                        if(!u) return;
                        if(u.isActive) await this.backfillForUser(u.username, u.role);
                        else await this.archiveAll(u.username);
                    }
                }
            });
        } catch {
            /* change streams unavailable — ok */
        }
    }

    // ============================= Backfill helpers =============================

    async backfillForUser(username: string, role: Role, session?: ClientSession) {
        const audienceFilter = this.buildAudienceFilter(username, role);
        const masters = await NotificationModel.find(audienceFilter, {_id: 1}).lean<{_id: Types.ObjectId}[]>();
        if(!masters.length) return 0;

        const ops = masters.map(m => ({
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

    async backfillForAllUsersForNotification(notificationId: string, session?: ClientSession) {
        const n = await NotificationModel.findById(notificationId).lean<NotificationEntity | null>();
        if(!n) return 0;
        await this.deliverToAudience(n, session);
        return 1;
    }

    async syncForUserRoleChange(
        username: string,
        _oldRole: Role,
        newRole: Role,
        removeNoLongerEligible = false,
        session?: ClientSession
    ) {
        await this.backfillForUser(username, newRole, session);

        if(!removeNoLongerEligible) return {added: true, removed: false};

        const inScopeNow = await NotificationModel
            .find(this.buildAudienceFilter(username, newRole), {_id: 1})
            .lean<{_id: Types.ObjectId}[]>();

        const keep = new Set(inScopeNow.map(x => String(x._id)));
        const existing = await UserNotificationModel.find({username}).select({notificationId: 1}).lean();

        const removeIds = existing.map(s => s.notificationId).filter(id => !keep.has(String(id)));
        if(removeIds.length) {
            await UserNotificationModel.deleteMany({username, notificationId: {$in: removeIds}}, this.deleteOpts(session));
        }

        return {added: true, removed: removeIds.length > 0};
    }
}
