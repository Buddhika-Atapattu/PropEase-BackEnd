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

import * as fsp from 'fs/promises';
import path from 'path';

import {
    ClientSession,
    Connection,
    FilterQuery,
    ProjectionType,
    Types,
} from 'mongoose';

import { type User } from '../models/user.model';
import { AudienceMode, Role } from '../types/roles';
import RecycleBinService from './recyclebin.service';

// Master (notification) + per-user state
import {
    NotificationModel,
    type DefinedTypes,
    type Channel as NotificationChannel,
    type NotificationEntity,
    type Severity as NotificationSeverity,
    type Title,
    type TitleCategory,
} from '../models/notifications/notification.model';

import { UserNotificationModel } from '../models/notifications/user-notification.model';

// IMPORT UTILITIES MODELS
import { LeaseModel } from '../models/lease.model';
import { PropertyModel } from '../models/property.model';
import { TenantModel } from '../models/tenant.model';
import { UserModel } from '../models/user.model';

// ─────────────────────────────────────────────────────────────────────────────
// DTOs (kept as-is, used across controller/service)
// ─────────────────────────────────────────────────────────────────────────────

export interface NotificationAudienceDTO {
    mode: AudienceMode;
    usernames?: string[];
    roles?: Array<'admin' | 'agent' | 'tenant' | 'owner' | 'operator' | 'manager' | 'developer' | 'user'>;
}

export interface NotificationMetadata {
    refId: string;
    data?: Record<string, any>;
}

export interface CreateNotificationDTO {
    title: Title | string;
    body: string;
    type: DefinedTypes;
    severity?: NotificationSeverity;
    audience: NotificationAudienceDTO;
    channels?: NotificationChannel[];
    expiresAt?: Date;
    metadata?: NotificationMetadata;
    icon?: string;
    tags?: string[];
    link?: string;
    source?: string;
    target?: { kind?: TitleCategory; refId?: string; };
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
    metadata?: NotificationMetadata;
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
    category: TitleCategory;
    refId?: string;
    snapshot?: Record<string, any>;
    metadata?: Record<string, any>;
    requestedBy: string;
    useTransaction?: boolean;
}

export interface PermanentDeleteInput {
    category: TitleCategory;
    refId: string;
    metadata?: Record<string, any>;
    requestedBy: string;
    useTransaction?: boolean;
}

export interface DispatchResult {
    ok: boolean;
    message?: string;
    rooms?: string[];
    restored?: any;
}

// ─────────────────────────────────────────────────────────────────────────────
// Dynamic Helper: actions and types
// ─────────────────────────────────────────────────────────────────────────────
export const DOMAIN_ACTIONS = [ 'restore', 'permanent_delete' ] as const;
export type DomainAction = ( typeof DOMAIN_ACTIONS )[ number ];

// ─────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────

export default class NotificationService {
    private readonly bin = new RecycleBinService();

    /** Central map for action+category → Title literal used by UI filters. */
    private readonly ACTION_TITLE_MAP: Record<
        DomainAction,
        Record<TitleCategory, Title | string>
    > = {
            restore: {
                User: 'Restore User',
                Tenant: 'Restore Tenant',
                Property: 'Restore Property',
                Lease: 'Restore Lease',
                Agent: 'Restore Agent',
                Developer: 'Restore Developer',
                Maintenance: 'Restore Maintenance',
                Complaint: 'Restore Complaint',
                Team: 'Restore Team',
                Registration: 'Restore Registration',
                Payment: 'Restore Payment',
                System: 'Restore System',
                Comment: 'Restore Comment'
            },
            permanent_delete: {
                User: 'Permanent Delete User',
                Tenant: 'Permanent Delete Tenant',
                Property: 'Permanent Delete Property',
                Lease: 'Permanent Delete Lease',
                Agent: 'Permanent Delete Agent',
                Developer: 'Permanent Delete Developer',
                Maintenance: 'Permanent Delete Maintenance',
                Complaint: 'Permanent Delete Complaint',
                Team: 'Permanent Delete Team',
                Registration: 'Permanent Delete Registration',
                Payment: 'Permanent Delete Payment',
                System: 'Permanent Delete System',
                Comment: 'Permanent Delete Comment',
            },
        };

    constructor () {}

    // ───────────────────────────────────────────────────────────────────────────
    // Dynamic helpers (titles, bodies, default audience)
    // ───────────────────────────────────────────────────────────────────────────

    private titleFor( action: DomainAction, category: TitleCategory ): Title {
        const t = this.ACTION_TITLE_MAP[ action ]?.[ category ];
        if ( !t ) throw new Error( `Missing Title mapping for action=${ action } category=${ category }` );
        return t as Title;
    }

    /**
     * Build a human label for the entity from the snapshot (or fallback to refId).
     * We try the most meaningful fields per category first, then generic fallbacks.
     */
    private displayLabelFromSnapshot(
        category: TitleCategory,
        refId: string,
        snapshot?: Record<string, any>
    ): string {
        const safe = ( v: unknown ) => ( typeof v === 'string' ? v.trim() : '' );
        const pick = ( obj: any, keys: string[] ) => {
            for ( const k of keys ) {
                const v = safe( obj?.[ k ] );
                if ( v ) return v;
            }
            return '';
        };

        if ( !snapshot || typeof snapshot !== 'object' ) return `(${ refId })`;

        switch ( category ) {
            case 'User':
                return pick( snapshot, [ 'name', 'username', 'email', '_id', 'id' ] ) || `(${ refId })`;
            case 'Tenant':
                return (
                    pick( snapshot?.tenantInformation, [ 'fullName', 'tenantUsername', 'email' ] ) ||
                    pick( snapshot, [ 'name', 'tenantUsername', 'email', '_id', 'id' ] ) ||
                    `(${ refId })`
                );
            case 'Property':
                return pick( snapshot, [ 'title', 'referenceCode', 'id', '_id' ] ) || `(${ refId })`;
            case 'Lease':
                return (
                    pick( snapshot, [ 'leaseID', 'id', '_id' ] ) ||
                    pick( snapshot?.tenantInformation, [ 'fullName', 'tenantUsername', 'email' ] ) ||
                    `(${ refId })`
                );
            default:
                return (
                    pick( snapshot, [ 'title', 'name', 'code', 'label', 'reference', 'ref', 'id', '_id' ] ) ||
                    pick( snapshot?.metadata, [ 'title', 'name', 'code', 'label' ] ) ||
                    `(${ refId })`
                );
        }
    }

    private bodyFor(
        action: DomainAction,
        category: TitleCategory,
        refId: string,
        requestedBy: string,
        snapshot?: Record<string, any>
    ): string {
        const label = this.displayLabelFromSnapshot( category, refId, snapshot );
        return action === 'restore'
            ? `${ category } ${ label } restored by ${ requestedBy }.`
            : `${ category } ${ label } permanently deleted by ${ requestedBy }.`;
    }

    /** Default audience for domain actions: admin/operator/manager. */
    private defaultAudience( _category: TitleCategory ): NotificationAudienceDTO {
        return { mode: 'role', roles: [ 'admin', 'operator', 'manager' ] };
    }

    /**
     * Public helper to create a notification for a domain action.
     * Returns a **plain** NotificationEntity (not a Mongoose document).
     */
    public async notifyDomainAction( input: {
        action: DomainAction;
        category: TitleCategory;
        refId: string;
        requestedBy: string;
        snapshot?: Record<string, any>;
        audience?: NotificationAudienceDTO;
        channels?: NotificationChannel[];
        severity?: NotificationSeverity;
        icon?: string;
        tags?: string[];
        link?: string;
        source?: string;
    } ): Promise<NotificationEntity> {
        const {
            action, category, refId, requestedBy,
            snapshot, audience, channels, severity, icon, tags, link, source,
        } = input;

        const title = this.titleFor( action, category );
        const type: DefinedTypes = action; // 'restore' | 'permanent_delete'
        const body = this.bodyFor( action, category, refId, requestedBy, snapshot );
        const finalAudience = audience ?? this.defaultAudience( category );
        const metadata = { refId, data: { byUser: requestedBy, action, category } };

        const dto: CreateNotificationDTO = {
            title,
            body,
            type,
            severity: severity ?? ( action === 'restore' ? 'success' : 'warning' ),
            audience: finalAudience,
            ...( channels ? { channels } : {} ),
            metadata,
            ...( icon ? { icon } : {} ),
            ...( tags ? { tags } : {} ),
            ...( link ? { link } : {} ),
            ...( source ? { source } : {} ),
            target: { kind: category, refId },
        };

        // IMPORTANT: createNotification now returns a *plain* NotificationEntity
        return this.createNotification( dto, (/* rooms, payload */ ) => {
            // optional socket emission hook if you injected an emitter elsewhere
        } );
    }

    // ───────────────────────────────────────────────────────────────────────────
    // Bulk/guard helpers
    // ───────────────────────────────────────────────────────────────────────────

    private bulkOpts( session?: ClientSession ) {
        return session ? { ordered: false as const, session } : { ordered: false as const };
    }

    private findOneAndUpdateOpts( session?: ClientSession ) {
        return session
            ? { upsert: true as const, new: false as const, session }
            : { upsert: true as const, new: false as const };
    }

    private deleteOpts( session?: ClientSession ) {
        return session ? { session } : {};
    }

    private validateAudience( a: NotificationAudienceDTO ) {
        if ( !a?.mode ) throw new Error( 'Audience mode is required' );
        if ( a.mode === 'user' && !a.usernames?.length ) throw new Error( 'Audience usernames are required for mode=user' );
        if ( a.mode === 'role' && !a.roles?.length ) throw new Error( 'Audience roles are required for mode=role' );
    }

    private roomsForAudience( a: NotificationAudienceDTO ): string[] {
        const rooms = new Set<string>();
        if ( a.mode === 'broadcast' ) rooms.add( 'broadcast' );
        if ( a.mode === 'user' ) ( a.usernames ?? [] ).forEach( u => rooms.add( `user:${ u }` ) );
        if ( a.mode === 'role' ) ( a.roles ?? [] ).forEach( r => rooms.add( `role:${ r }` ) );
        return Array.from( rooms );
    }

    private userQueryForAudience( a: NotificationAudienceDTO ): FilterQuery<User> {
        if ( a.mode === 'broadcast' ) return { isActive: true };
        if ( a.mode === 'user' ) return { isActive: true, username: { $in: a.usernames ?? [] } };
        return { isActive: true, role: { $in: a.roles ?? [] } };
    }

    /**
     * Deliver a master notification to all users in the audience by upserting
     * per-user state rows. Accepts a **plain** NotificationEntity.
     */
    private async deliverToAudience( notification: NotificationEntity, session?: ClientSession ) {
        const q = this.userQueryForAudience( notification.audience as NotificationAudienceDTO );
        const cursor = UserModel.find( q ).select( { username: 1 } ).lean().cursor();

        const ops: any[] = [];
        const notifId = String( notification._id );
        const now = new Date();

        for await ( const u of cursor ) {
            if ( !u?.username ) continue;

            ops.push( {
                updateOne: {
                    filter: { username: u.username, notificationId: notifId },
                    update: { $setOnInsert: { deliveredAt: now, isRead: false, isArchived: false } },
                    upsert: true,
                },
            } );

            if ( ops.length >= 1000 ) {
                await UserNotificationModel.bulkWrite( ops, this.bulkOpts( session ) );
                ops.length = 0;
            }
        }

        if ( ops.length ) await UserNotificationModel.bulkWrite( ops, this.bulkOpts( session ) );
    }

    // ───────────────────────────────────────────────────────────────────────────
    // Creation (FIXED: always return a plain NotificationEntity, not a doc)
    // ───────────────────────────────────────────────────────────────────────────

    /**
     * Create a master notification and fan-out per-user states.
     * RETURNS: a **plain** NotificationEntity (safe for sockets/UI).
     *
     * Why not `Model.create([doc])`? Its typing allows `undefined` for `[0]`
     * in strict mode. Using `new Model(doc).save()` guarantees a single doc.
     */
    public async createNotification(
        doc: CreateNotificationDTO,
        emit?: ( rooms: string[], payload: NotificationEntity ) => void,
        session?: ClientSession
    ): Promise<NotificationEntity> {
        this.validateAudience( doc.audience );

        const m = new NotificationModel( { ...doc, createdAt: new Date() } );
        const persistedDoc = await m.save( session ? { session } : undefined );

        // Convert to a plain object (no Mongoose getters/methods)
        const plain = ( typeof ( persistedDoc as any ).toObject === 'function'
            ? ( persistedDoc as any ).toObject()
            : ( persistedDoc as any ) ) as NotificationEntity;

        // Create per-user states now that we have the final _id
        await this.deliverToAudience( plain, session );

        // Optional socket emission
        emit?.( this.roomsForAudience( doc.audience ), plain );

        return plain; // <— guarantees a NotificationEntity (not undefined)
    }

    // ───────────────────────────────────────────────────────────────────────────
    // Listing
    // ───────────────────────────────────────────────────────────────────────────

    private buildAudienceFilter( username: string, role: Role ) {
        if ( role === 'admin' ) return {} as FilterQuery<NotificationEntity>;
        return {
            $or: [
                { 'audience.mode': 'broadcast' },
                { 'audience.mode': 'user', 'audience.usernames': username },
                { 'audience.mode': 'role', 'audience.roles': role },
            ],
        } as FilterQuery<NotificationEntity>;
    }

    private buildListFilters( opts: ListOptions ) {
        const f: FilterQuery<NotificationEntity> = {};
        if ( opts.category ) f.category = opts.category;
        if ( opts.titles?.length ) f.title = { $in: opts.titles };
        if ( opts.type ) f.type = opts.type;
        if ( opts.severity ) f.severity = opts.severity;
        if ( opts.channel ) f.channels = opts.channel;

        if ( opts.createdAfter || opts.createdBefore ) {
            f.createdAt = {};
            if ( opts.createdAfter ) ( f.createdAt as any ).$gte = opts.createdAfter;
            if ( opts.createdBefore ) ( f.createdAt as any ).$lte = opts.createdBefore;
        }

        if ( opts.search?.trim() ) {
            const q = opts.search.trim();
            f.$or = [
                { title: { $regex: q, $options: 'i' } },
                { body: { $regex: q, $options: 'i' } },
                { tags: { $elemMatch: { $regex: q, $options: 'i' } } },
            ];
        }

        // hide expired
        const now = new Date();
        f.$and = [ { $or: [ { expiresAt: { $exists: false } }, { expiresAt: { $gt: now } } ] } ];

        return f;
    }

    private buildProjection(): ProjectionType<NotificationEntity> {
        return {
            title: 1, category: 1, body: 1, type: 1, severity: 1,
            audience: 1, channels: 1, createdAt: 1, expiresAt: 1,
            metadata: 1, icon: 1, tags: 1, link: 1, source: 1, target: 1,
        };
    }

    private async ensureStatesForMasters( username: string, masters: NotificationEntity[], session?: ClientSession ) {
        await Promise.all(
            masters.map( n =>
                UserNotificationModel.findOneAndUpdate(
                    { username, notificationId: String( n._id ) },
                    { $setOnInsert: { deliveredAt: new Date(), isRead: false, isArchived: false } },
                    this.findOneAndUpdateOpts( session )
                )
            )
        );
    }

    private async fetchStatesMap(
        username: string,
        masterIds: string[],
        onlyUnread?: boolean
    ): Promise<Map<string, UserNotificationStateDTO>> {
        const stateFilter: FilterQuery<any> = { username, notificationId: { $in: masterIds } };
        if ( onlyUnread ) stateFilter.isRead = false;

        const states = await UserNotificationModel.find( stateFilter )
            .select( { username: 1, notificationId: 1, isRead: 1, isArchived: 1, deliveredAt: 1, readAt: 1 } )
            .lean<UserNotificationStateDTO[]>();

        return new Map( states.map( s => [ String( s.notificationId ), s ] ) );
    }

    private iso( v?: Date | string ) {
        if ( !v ) return undefined;
        if ( v instanceof Date ) return v.toISOString();
        const asDate = new Date( v );
        return Number.isNaN( asDate.getTime() ) ? String( v ) : asDate.toISOString();
    }

    private mergeToDTO(
        masters: NotificationEntity[],
        stateById: Map<string, UserNotificationStateDTO>,
        onlyUnread?: boolean
    ): NotificationWithStateDTO[] {
        return masters
            .map( n => {
                const s = stateById.get( String( n._id ) );
                if ( onlyUnread && s?.isRead ) return null;

                const createdAtISO = this.iso( n.createdAt )!;
                const expiresAtISO = this.iso( n.expiresAt );

                return {
                    _id: String( n._id ),
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
                            deliveredAt: this.iso( s.deliveredAt )!,
                            readAt: this.iso( s.readAt ),
                        }
                        : { isRead: false, isArchived: false, deliveredAt: createdAtISO },
                } as NotificationWithStateDTO;
            } )
            .filter( ( x ): x is NotificationWithStateDTO => Boolean( x ) );
    }

    public async listForUser( username: string, role: Role, opts: ListOptions = {} ) {
        const limit = Math.max( 1, opts.limit ?? 20 );
        const page = Number.isFinite( opts.skip ) ? Math.floor( ( opts.skip as number ) / ( opts.limit ?? 20 ) ) : Math.max( 0, opts.page ?? 0 );
        const onlyUnread = !!opts.onlyUnread;

        const audienceFilter = this.buildAudienceFilter( username, role );
        const extraFilters = this.buildListFilters( opts );
        const masterFilter: FilterQuery<NotificationEntity> = { ...audienceFilter, ...extraFilters };

        const masters = await NotificationModel.find( masterFilter, this.buildProjection() )
            .sort( { createdAt: -1 } )
            .skip( page * limit )
            .limit( limit )
            .lean<NotificationEntity[]>();

        await this.ensureStatesForMasters( username, masters );

        const ids = masters.map( m => String( m._id ) );
        const stateById = await this.fetchStatesMap( username, ids, onlyUnread );

        return this.mergeToDTO( masters, stateById, onlyUnread );
    }

    public async countForUser( username: string, role: Role, opts: ListOptions = {} ) {
        const audienceFilter = this.buildAudienceFilter( username, role );
        const extraFilters = this.buildListFilters( opts );
        const masterFilter: FilterQuery<NotificationEntity> = { ...audienceFilter, ...extraFilters };
        return NotificationModel.countDocuments( masterFilter ).exec();
    }

    // ───────────────────────────────────────────────────────────────────────────
    // Per-user state ops
    // ───────────────────────────────────────────────────────────────────────────

    public markRead( username: string, notificationId: string ) {
        return UserNotificationModel.updateOne(
            { username, notificationId: String( notificationId ) },
            { $set: { isRead: true, readAt: new Date() } },
            { upsert: true }
        );
    }

    public markManyRead( username: string, notificationIds: Array<string | Types.ObjectId> ) {
        const ids = notificationIds.map( String );
        return UserNotificationModel.updateMany(
            { username, notificationId: { $in: ids }, isRead: false },
            { $set: { isRead: true, readAt: new Date() } }
        );
    }

    public markAllRead( username: string ) {
        return UserNotificationModel.updateMany(
            { username, isRead: false },
            { $set: { isRead: true, readAt: new Date() } }
        );
    }

    public archiveAll( username: string ) {
        return UserNotificationModel.updateMany(
            { username, isArchived: false },
            { $set: { isArchived: true } }
        );
    }

    public deleteAllStatesForUser( username: string, session?: ClientSession ) {
        return UserNotificationModel.deleteMany( { username }, this.deleteOpts( session ) );
    }

    public deleteStatesForUser( username: string, notificationIds: Array<string | Types.ObjectId>, session?: ClientSession ) {
        const ids = notificationIds.map( String );
        return UserNotificationModel.deleteMany( { username, notificationId: { $in: ids } }, this.deleteOpts( session ) );
    }

    public async pruneOrphanStates( session?: ClientSession ) {
        const orphans = await ( UserNotificationModel as any )
            .aggregate( [
                { $lookup: { from: 'notifications', localField: 'notificationId', foreignField: '_id', as: 'n' } },
                { $match: { n: { $size: 0 } } },
                { $project: { _id: 1 } },
            ] )
            .session( session ?? null );

        if ( !orphans.length ) return 0;
        const ids = orphans.map( ( o: any ) => o._id );
        const res = await UserNotificationModel.deleteMany( { _id: { $in: ids } }, this.deleteOpts( session ) );
        return res.deletedCount || 0;
    }

    // ───────────────────────────────────────────────────────────────────────────
    // Restore / Hard Delete
    // ───────────────────────────────────────────────────────────────────────────

    public async restoreByCategory( input: RestoreByCategoryInput ): Promise<DispatchResult> {
        const { category, refId, snapshot, requestedBy } = input;
        const metadata = input.metadata ?? {};
        const useTransaction = !!input.useTransaction;

        if ( useTransaction ) {
            const conn: Connection = NotificationModel.db;
            const session = await conn.startSession();
            try {
                session.startTransaction();

                const payload = {
                    category,
                    metadata,
                    requestedBy,
                    ...( refId ? { refId } : {} ),
                    ...( snapshot ? { snapshot } : {} ),
                } as const;

                const res = await this._restoreDispatcher( payload, session );
                await session.commitTransaction();
                session.endSession();
                return res;
            } catch ( e: any ) {
                await session.abortTransaction();
                session.endSession();
                return { ok: false, message: e?.message || 'Restore failed (tx)' };
            }
        }

        const payload = {
            category,
            metadata,
            requestedBy,
            ...( refId ? { refId } : {} ),
            ...( snapshot ? { snapshot } : {} ),
        } as const;

        return this._restoreDispatcher( payload );
    }

    public async permanentDeleteByCategory( input: PermanentDeleteInput ): Promise<DispatchResult> {
        const { category } = input;
        const metadata = input.metadata ?? {};
        const requestedBy = input.requestedBy;
        const useTransaction = !!input.useTransaction;

        const refId = typeof input.refId === 'string' ? input.refId.trim() : '';
        if ( !refId ) return { ok: false, message: 'refId is required for permanent delete' };

        if ( useTransaction ) {
            const conn: Connection = NotificationModel.db;
            const session = await conn.startSession();
            try {
                session.startTransaction();
                const res = await this._permanentDeleteDispatcher( { category, refId, metadata, requestedBy }, session );
                await session.commitTransaction();
                session.endSession();
                return res;
            } catch ( e: any ) {
                await session.abortTransaction();
                session.endSession();
                return { ok: false, message: e?.message || 'Permanent delete failed (tx)' };
            }
        }

        return this._permanentDeleteDispatcher( { category, refId, metadata, requestedBy } );
    }

    private async _restoreDispatcher(
        input: { category: TitleCategory; refId?: string; snapshot?: Record<string, any>; metadata: any; requestedBy: string; },
        session?: ClientSession
    ): Promise<DispatchResult> {
        const { category } = input;
        switch ( category ) {
            case 'User': return this.restoreUser( input, session );
            case 'Tenant': return this.restoreTenant( input, session );
            case 'Property': return this.restoreProperty( input, session );
            case 'Lease': return this.restoreLease( input, session );
            case 'Agent': return this.restoreAgent( input, session );
            case 'Developer': return this.restoreDeveloper( input, session );
            case 'Maintenance': return this.restoreMaintenance( input, session );
            case 'Complaint': return this.restoreComplaint( input, session );
            case 'Team': return this.restoreTeam( input, session );
            case 'Registration':
            case 'Payment':
            case 'System':
            default:
                return { ok: false, message: `Restore not supported for category "${ category }"` };
        }
    }

    private async _permanentDeleteDispatcher(
        input: { category: TitleCategory; refId: string; metadata: any; requestedBy: string; },
        _session?: ClientSession
    ): Promise<DispatchResult> {
        const { category } = input;
        switch ( category ) {
            case 'User': return this.hardDeleteUser( input );
            case 'Tenant': return this.hardDeleteTenant( input );
            case 'Property': return this.hardDeleteProperty( input );
            case 'Lease': return this.hardDeleteLease( input );
            case 'Agent': return this.hardDeleteAgent( input );
            case 'Developer': return this.hardDeleteDeveloper( input );
            case 'Maintenance': return this.hardDeleteMaintenance( input );
            case 'Complaint': return this.hardDeleteComplaint( input );
            case 'Team': return this.hardDeleteTeam( input );
            case 'Registration':
            case 'Payment':
            case 'System':
            default:
                return { ok: false, message: `Permanent delete not supported for category "${ category }"` };
        }
    }

    // ───────────────────────────────────────────────────────────────────────────
    // Generic restore/hard-delete helpers
    // ───────────────────────────────────────────────────────────────────────────

    private getModelFor( category: TitleCategory ) {
        switch ( category ) {
            case 'User': return UserModel;
            case 'Tenant': return TenantModel;
            case 'Property': return PropertyModel;
            case 'Lease': return LeaseModel;
            // Add more here when you wire those models
            default: return null;
        }
    }

    private resolveDestFolder( category: TitleCategory, refId: string, snapshot?: Record<string, any> ): string {
        if ( snapshot && typeof snapshot.__filesRoot === 'string' && snapshot.__filesRoot.trim() ) {
            return snapshot.__filesRoot.trim();
        }
        const base = 'uploads';
        switch ( category ) {
            case 'User': return path.posix.join( base, 'users', refId );
            case 'Tenant': return path.posix.join( base, 'tenants', refId );
            case 'Property': return path.posix.join( base, 'properties', refId );
            case 'Lease': return path.posix.join( base, 'leases', refId );
            case 'Agent': return path.posix.join( base, 'agents', refId );
            case 'Developer': return path.posix.join( base, 'developers', refId );
            case 'Maintenance': return path.posix.join( base, 'maintenance', refId );
            case 'Complaint': return path.posix.join( base, 'complaints', refId );
            case 'Team': return path.posix.join( base, 'teams', refId );
            case 'Registration': return path.posix.join( base, 'registrations', refId );
            case 'Payment': return path.posix.join( base, 'payments', refId );
            case 'System': return path.posix.join( base, 'system', refId );
            default: return path.posix.join( base, 'misc', refId );
        }
    }

    private async restoreGeneric(
        category: TitleCategory,
        refId: string,
        metadata: Record<string, any>,
        session?: ClientSession,
        incomingSnapshot?: Record<string, any>
    ): Promise<DispatchResult> {
        const Model = this.getModelFor( category );
        if ( !Model ) return { ok: false, message: `${ category } model unavailable` };

        const fileSnap = await this.bin.readSnapshot( category, refId );
        const payload = ( fileSnap.ok && fileSnap.data ) ? fileSnap.data : ( incomingSnapshot ?? null );
        if ( !payload ) return { ok: false, message: `No snapshot found in recyclebin for ${ category }/${ refId }` };

        const { _id, ...rest } = payload;
        const toInsert = { ...rest, deleted: false, deletedAt: null, deletedBy: null };

        // Insert new doc (or switch to {_id, ...toInsert} if you want to keep the same id)
        const [ doc ] = await ( Model as any ).create( [ toInsert ], session ? { session } : undefined );

        try {
            const destRel = this.resolveDestFolder( category, String( doc._id ), payload );
            await this.bin.restoreFolder( category, refId, destRel );
        } catch ( e ) {
            console.warn( `[restore:${ category }] Media move warning:`, e );
        }

        try { await this.bin.purge( category, refId ); } catch {}

        return {
            ok: true,
            message: `${ category } restored`,
            restored: { _id: doc._id },
            rooms: this.roomsOnRestore( category.toLowerCase(), metadata ),
        };
    }

    private async hardDeleteGeneric(
        category: TitleCategory,
        refId: string,
        metadata: Record<string, any>
    ): Promise<DispatchResult> {
        await this.bin.purge( category, refId );

        try {
            const destRel = this.resolveDestFolder( category, refId );
            const abs = path.resolve( process.cwd(), 'public', destRel );
            await fsp.rm( abs, { recursive: true, force: true } );
        } catch ( e ) {
            console.warn( `[hardDelete:${ category }] leftover public folder cleanup warning:`, e );
        }

        return { ok: true, message: `${ category } permanently deleted`, rooms: this.roomsOnDelete( category.toLowerCase(), metadata ) };
    }

    private async restoreUser( { refId, metadata, snapshot }: { refId?: string; metadata: any; snapshot?: Record<string, any>; }, s?: ClientSession ) {
        if ( !refId ) return { ok: false, message: 'refId required for restore' };
        return this.restoreGeneric( 'User', refId, metadata, s, snapshot );
    }
    private async restoreTenant( { refId, metadata, snapshot }: { refId?: string; metadata: any; snapshot?: Record<string, any>; }, s?: ClientSession ) {
        if ( !refId ) return { ok: false, message: 'refId required for restore' };
        return this.restoreGeneric( 'Tenant', refId, metadata, s, snapshot );
    }
    private async restoreProperty( { refId, metadata, snapshot }: { refId?: string; metadata: any; snapshot?: Record<string, any>; }, s?: ClientSession ) {
        if ( !refId ) return { ok: false, message: 'refId required for restore' };
        return this.restoreGeneric( 'Property', refId, metadata, s, snapshot );
    }
    private async restoreLease( { refId, metadata, snapshot }: { refId?: string; metadata: any; snapshot?: Record<string, any>; }, s?: ClientSession ) {
        if ( !refId ) return { ok: false, message: 'refId required for restore' };
        return this.restoreGeneric( 'Lease', refId, metadata, s, snapshot );
    }
    private async restoreAgent( { refId, metadata, snapshot }: { refId?: string; metadata: any; snapshot?: Record<string, any>; }, s?: ClientSession ) {
        if ( !refId ) return { ok: false, message: 'refId required for restore' };
        return this.restoreGeneric( 'Agent', refId, metadata, s, snapshot );
    }
    private async restoreDeveloper( { refId, metadata, snapshot }: { refId?: string; metadata: any; snapshot?: Record<string, any>; }, s?: ClientSession ) {
        if ( !refId ) return { ok: false, message: 'refId required for restore' };
        return this.restoreGeneric( 'Developer', refId, metadata, s, snapshot );
    }
    private async restoreMaintenance( { refId, metadata, snapshot }: { refId?: string; metadata: any; snapshot?: Record<string, any>; }, s?: ClientSession ) {
        if ( !refId ) return { ok: false, message: 'refId required for restore' };
        return this.restoreGeneric( 'Maintenance', refId, metadata, s, snapshot );
    }
    private async restoreComplaint( { refId, metadata, snapshot }: { refId?: string; metadata: any; snapshot?: Record<string, any>; }, s?: ClientSession ) {
        if ( !refId ) return { ok: false, message: 'refId required for restore' };
        return this.restoreGeneric( 'Complaint', refId, metadata, s, snapshot );
    }
    private async restoreTeam( { refId, metadata, snapshot }: { refId?: string; metadata: any; snapshot?: Record<string, any>; }, s?: ClientSession ) {
        if ( !refId ) return { ok: false, message: 'refId required for restore' };
        return this.restoreGeneric( 'Team', refId, metadata, s, snapshot );
    }

    private async hardDeleteUser( { refId, metadata }: { refId: string; metadata: any; } ) { return this.hardDeleteGeneric( 'User', refId, metadata ); }
    private async hardDeleteTenant( { refId, metadata }: { refId: string; metadata: any; } ) { return this.hardDeleteGeneric( 'Tenant', refId, metadata ); }
    private async hardDeleteProperty( { refId, metadata }: { refId: string; metadata: any; } ) { return this.hardDeleteGeneric( 'Property', refId, metadata ); }
    private async hardDeleteLease( { refId, metadata }: { refId: string; metadata: any; } ) { return this.hardDeleteGeneric( 'Lease', refId, metadata ); }
    private async hardDeleteAgent( { refId, metadata }: { refId: string; metadata: any; } ) { return this.hardDeleteGeneric( 'Agent', refId, metadata ); }
    private async hardDeleteDeveloper( { refId, metadata }: { refId: string; metadata: any; } ) { return this.hardDeleteGeneric( 'Developer', refId, metadata ); }
    private async hardDeleteMaintenance( { refId, metadata }: { refId: string; metadata: any; } ) { return this.hardDeleteGeneric( 'Maintenance', refId, metadata ); }
    private async hardDeleteComplaint( { refId, metadata }: { refId: string; metadata: any; } ) { return this.hardDeleteGeneric( 'Complaint', refId, metadata ); }
    private async hardDeleteTeam( { refId, metadata }: { refId: string; metadata: any; } ) { return this.hardDeleteGeneric( 'Team', refId, metadata ); }

    // ───────────────────────────────────────────────────────────────────────────
    // Live update rooms
    // ───────────────────────────────────────────────────────────────────────────

    private roomsOnRestore( kind: string, meta: Record<string, any> = {} ): string[] {
        const rooms: string[] = [];
        if ( typeof meta?.byUser === 'string' && meta.byUser.trim() ) rooms.push( `user:${ meta.byUser.trim() }` );
        rooms.push( `domain:${ kind }` );
        rooms.push( 'role:admin' );
        return rooms;
    }

    private roomsOnDelete( kind: string, meta: Record<string, any> = {} ): string[] {
        const rooms: string[] = [];
        if ( typeof meta?.byUser === 'string' && meta.byUser.trim() ) rooms.push( `user:${ meta.byUser.trim() }` );
        rooms.push( `domain:${ kind }` );
        rooms.push( 'role:admin' );
        return rooms;
    }

    // ───────────────────────────────────────────────────────────────────────────
    // Change streams (optional)
    // ───────────────────────────────────────────────────────────────────────────

    public watchChanges( io?: import( 'socket.io' ).Namespace ) {
        try {
            const notifStream = NotificationModel.watch( [], { fullDocument: 'updateLookup' } );
            notifStream.on( 'change', async ( ev: any ) => {
                if ( ev.operationType === 'insert' ) {
                    const n = ev.fullDocument as NotificationEntity;
                    await this.deliverToAudience( n );
                    if ( io ) {
                        const rooms = this.roomsForAudience( n.audience as any );
                        rooms.forEach( room => io.to( room ).emit( 'notification.new', n ) );
                    }
                }
            } );
        } catch {
            /* change streams unavailable — ok */
        }

        try {
            const userStream = UserModel.watch( [], { fullDocument: 'updateLookup' } );
            userStream.on( 'change', async ( ev: any ) => {
                if ( ev.operationType === 'insert' ) {
                    const u = ev.fullDocument as User;
                    if ( u?.isActive ) await this.backfillForUser( u.username, u.role );
                } else if ( ev.operationType === 'update' && ev.updateDescription?.updatedFields ) {
                    const updated = ev.updateDescription.updatedFields;
                    if ( 'role' in updated || 'isActive' in updated ) {
                        const u = ev.fullDocument as User;
                        if ( !u ) return;
                        if ( u.isActive ) await this.backfillForUser( u.username, u.role );
                        else await this.archiveAll( u.username );
                    }
                }
            } );
        } catch {
            /* change streams unavailable — ok */
        }
    }

    // ───────────────────────────────────────────────────────────────────────────
    // Backfill helpers
    // ───────────────────────────────────────────────────────────────────────────

    public async backfillForUser( username: string, role: Role, session?: ClientSession ) {
        const audienceFilter = this.buildAudienceFilter( username, role );
        const masters = await NotificationModel.find( audienceFilter, { _id: 1 } ).lean<{ _id: Types.ObjectId; }[]>();
        if ( !masters.length ) return 0;

        const ops = masters.map( m => ( {
            updateOne: {
                filter: { username, notificationId: String( m._id ) },
                update: { $setOnInsert: { deliveredAt: new Date(), isRead: false, isArchived: false } },
                upsert: true,
            },
        } ) );

        if ( !ops.length ) return 0;
        const res = await UserNotificationModel.bulkWrite( ops, this.bulkOpts( session ) );
        return ( res.upsertedCount ?? 0 ) + ( res.modifiedCount ?? 0 );
    }

    public async backfillForAllUsersForNotification( notificationId: string, session?: ClientSession ) {
        const n = await NotificationModel.findById( notificationId ).lean<NotificationEntity | null>();
        if ( !n ) return 0;
        await this.deliverToAudience( n, session );
        return 1;
    }

    public async syncForUserRoleChange(
        username: string,
        _oldRole: Role,
        newRole: Role,
        removeNoLongerEligible = false,
        session?: ClientSession
    ) {
        await this.backfillForUser( username, newRole, session );

        if ( !removeNoLongerEligible ) return { added: true, removed: false };

        const inScopeNow = await NotificationModel
            .find( this.buildAudienceFilter( username, newRole ), { _id: 1 } )
            .lean<{ _id: Types.ObjectId; }[]>();

        const keep = new Set( inScopeNow.map( x => String( x._id ) ) );
        const existing = await UserNotificationModel.find( { username } ).select( { notificationId: 1 } ).lean();

        const removeIds = existing.map( s => s.notificationId ).filter( id => !keep.has( String( id ) ) );
        if ( removeIds.length ) {
            await UserNotificationModel.deleteMany( { username, notificationId: { $in: removeIds } }, this.deleteOpts( session ) );
        }

        return { added: true, removed: removeIds.length > 0 };
    }
}
