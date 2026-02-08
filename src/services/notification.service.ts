// src/services/notification.service.ts
// ─────────────────────────────────────────────────────────────────────────────
// NotificationService (Future-proof)
// - Master Notification collection + per-user state collection
// - Fan-out logic lives here (deliver notification to audience)
// - Restore / Permanent Delete uses a registry: category -> handler
//
// WHY THIS DESIGN?
// 1) Switch statements become unmaintainable when categories grow.
// 2) Each domain has slightly different restore rules (DB + files).
// 3) A registry lets you "plug in" a new category handler without editing
//    the core service.
//
// HOW TO ADD A NEW MODEL IN FUTURE?
// - Add a handler in buildDomainHandlers() for that category.
// - Provide: getModel(), resolveUploadsRoot(), (optional) normalizeSnapshot()
// - Done. No changes required elsewhere.
//
// IMPORTANT:
// - This file returns plain objects (lean / toObject) for safety in sockets/UI.
// - No "free functions". Everything is class-based.
// - Teaching comments explain WHAT + WHY.
// ─────────────────────────────────────────────────────────────────────────────

import path from "path";
import * as fsp from "fs/promises";

import type {
    ClientSession,
    Connection,
    FilterQuery,
    ProjectionType,
    Types,
    Model,
} from "mongoose";

import type { User } from "../models/user.model";

import { AudienceMode, Role } from "../types/roles";

import RecycleBinService from "./recyclebin.service";

// Master + per-user state
import {
    NotificationModel,
    type Channel as NotificationChannel,
    type DefinedTypes,
    type NotificationEntity,
    type Severity as NotificationSeverity,
    type Title,
    type TitleCategory,
} from "../models/notifications/notification.model";

import { UserNotificationModel } from "../models/notifications/user-notification.model";
import { NotificationPolicySource } from '../source/notifications/notification-policy.source';

// Domain models (plugged into handler registry)
import { UserModel } from "../models/user.model";
import { TenantModel } from "../models/tenant.model";
import { PropertyModel } from "../models/property.model";
import { LeaseModel } from "../models/lease.model";
import { CommentModel } from "../models/comments/comments.model";

// ─────────────────────────────────────────────────────────────────────────────
// DTOs (kept compatible with your current code)
// ─────────────────────────────────────────────────────────────────────────────

export interface NotificationAudienceDTO {
    mode: AudienceMode;
    usernames?: string[];
    roles?: Role[];
}

export const CommentNotificationKind: string[] = [
    "comment",
    ""
];

export interface CommentNotification {

}

export interface NotificationMetadata {
    refId: string;
    data?: Record<string, any>;
}

export interface CreateNotificationDTO {
    title: Title | string;
    body: string;
    type: DefinedTypes; // e.g. "restore" | "permanent_delete" | "create" | "delete" etc.
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

// Restore / permanent delete
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

// Dynamic Helper: actions
export const DOMAIN_ACTIONS = [ "restore", "permanent_delete" ] as const;
export type DomainAction = ( typeof DOMAIN_ACTIONS )[ number ];

// ─────────────────────────────────────────────────────────────────────────────
// Domain handler contract (PLUG-IN POINT)
// ─────────────────────────────────────────────────────────────────────────────
//
// Each category handler knows how to:
// - locate the Mongoose Model (for restore insert)
// - decide where the uploads folder should live for the restored doc
// - (optionally) normalize snapshot before inserting
//
// WHY: "Comment" uploads path is not the same as "Property" uploads path.
// So we keep path logic close to the domain category.
// ─────────────────────────────────────────────────────────────────────────────

interface DomainHandler {
    /** Category literal used by NotificationModel.category */
    category: TitleCategory;

    /**
     * The Mongoose model for this domain.
     * - For restore we insert a new row using the snapshot.
     * - For delete we might want to hard-clean a legacy uploads folder.
     */
    getModel: () => Model<any> | null;

    /**
     * Given refId + snapshot, return the "uploads/..." root folder
     * where media should exist for the restored entity.
     *
     * IMPORTANT: Must return PUBLIC-relative unix style:
     *   "uploads/comments/Complaints/REF/..."
     */
    resolveUploadsRoot: ( refId: string, snapshot?: Record<string, any> ) => string;

    /**
     * Optional snapshot transformer.
     * Example use:
     * - Remove internal fields
     * - Ensure "deleted=false" defaults
     * - Map old keys -> new keys
     */
    normalizeSnapshot?: ( snapshot: Record<string, any> ) => Record<string, any>;
}

export default class NotificationService {
    private readonly bin = new RecycleBinService();

    // ───────────────────────────────────────────────────────────────────────────
    // Title mappings
    // ───────────────────────────────────────────────────────────────────────────

    /** Central map for action+category → Title literal used by UI filters. */
    private readonly ACTION_TITLE_MAP: Record<
        DomainAction,
        Record<TitleCategory, Title | string>
    > = {
            restore: {
            User: "Restore User",
            Tenant: "Restore Tenant",
            Property: "Restore Property",
            Lease: "Restore Lease",
            Agent: "Restore Agent",
            Developer: "Restore Developer",
            Maintenance: "Restore Maintenance",
            Complaint: "Restore Complaint",
            Team: "Restore Team",
            Registration: "Restore Registration",
            Payment: "Restore Payment",
            System: "Restore System",
            Comment: "Restore Comment",
            },
            permanent_delete: {
                User: "Permanent Delete User",
                Tenant: "Permanent Delete Tenant",
                Property: "Permanent Delete Property",
                Lease: "Permanent Delete Lease",
                Agent: "Permanent Delete Agent",
                Developer: "Permanent Delete Developer",
                Maintenance: "Permanent Delete Maintenance",
                Complaint: "Permanent Delete Complaint",
                Team: "Permanent Delete Team",
                Registration: "Permanent Delete Registration",
                Payment: "Permanent Delete Payment",
                System: "Permanent Delete System",
                Comment: "Permanent Delete Comment",
            },
        };

    // ───────────────────────────────────────────────────────────────────────────
    // Domain handler registry (THE MAIN FUTURE-PROOF PART)
    // ───────────────────────────────────────────────────────────────────────────

    /**
     * Registry: category -> handler.
     *
     * To add a new category later:
     * 1) Add a handler inside buildDomainHandlers()
     * 2) Ensure TitleCategory includes that literal
     * 3) Done
     */
    private readonly handlers: ReadonlyMap<TitleCategory, DomainHandler> =
        this.buildDomainHandlers();

    private buildDomainHandlers(): ReadonlyMap<TitleCategory, DomainHandler> {
        const list: DomainHandler[] = [
            {
                category: "User",
                getModel: () => UserModel,
                resolveUploadsRoot: ( refId ) => path.posix.join( "uploads", "users", refId ),
            },
            {
                category: "Tenant",
                getModel: () => TenantModel,
                resolveUploadsRoot: ( refId ) =>
                    path.posix.join( "uploads", "tenants", refId ),
            },
            {
                category: "Property",
                getModel: () => PropertyModel,
                resolveUploadsRoot: ( refId ) =>
                    path.posix.join( "uploads", "properties", refId ),
            },
            {
                category: "Lease",
                getModel: () => LeaseModel,
                resolveUploadsRoot: ( refId ) =>
                    path.posix.join( "uploads", "leases", refId ),
            },

            // ✅ Comment category handler (IMPORTANT):
            // Your comment engine stores attachments under:
            // uploads/comments/<Section>/<RefId>/.../attachments/<commentId>/*
            //
            // For restore/hard-delete we need a stable "root".
            // We store/restore "uploads/comments/<refId>" by default, but you can override
            // with snapshot.__filesRoot if you captured it during recyclebin snapshot.
            {
                category: "Comment",
                getModel: () => CommentModel,
                resolveUploadsRoot: ( refId, snapshot ) => {
                    const snapRoot =
                        typeof snapshot?.__filesRoot === "string"
                            ? snapshot.__filesRoot.trim()
                            : "";
                    if ( snapRoot ) return snapRoot;

                    // Fallback: store comment media bucket by refId
                    // (Your recycle bin will keep full tree under this bucket)
                    return path.posix.join( "uploads", "comments", refId );
                },

                normalizeSnapshot: ( snap ) => {
                    // Example of future-proof migration normalization:
                    // - strip _id because we will insert a NEW doc
                    // - ensure delete flags reset
                    const { _id, ...rest } = snap;
                    return {
                        ...rest,
                        deleted: false,
                        deletedAt: null,
                        deletedBy: null,
                    };
                },
            },
        ];

        return new Map( list.map( ( h ) => [ h.category, h ] ) );
    }

    // ───────────────────────────────────────────────────────────────────────────
    // Dynamic helpers (titles, bodies, default audience)
    // ───────────────────────────────────────────────────────────────────────────

    private titleFor( action: DomainAction, category: TitleCategory ): Title {
        const t = this.ACTION_TITLE_MAP[ action ]?.[ category ];
        if ( !t )
            throw new Error(
                `Missing Title mapping for action=${ action } category=${ category }`,
            );
        return t as Title;
    }

    private displayLabelFromSnapshot(
        category: TitleCategory,
        refId: string,
        snapshot?: Record<string, any>,
    ): string {
        const safe = ( v: unknown ) => ( typeof v === "string" ? v.trim() : "" );
        const pick = ( obj: any, keys: string[] ) => {
            for ( const k of keys ) {
                const v = safe( obj?.[ k ] );
                if ( v ) return v;
            }
            return "";
        };

        if ( !snapshot || typeof snapshot !== "object" ) return `(${ refId })`;

        switch ( category ) {
            case "User":
                return (
                    pick( snapshot, [ "name", "username", "email", "_id", "id" ] ) ||
                    `(${ refId })`
                );
            case "Tenant":
                return (
                    pick( snapshot?.tenantInformation, [
                        "fullName",
                        "tenantUsername",
                        "email",
                    ] ) ||
                    pick( snapshot, [ "name", "tenantUsername", "email", "_id", "id" ] ) ||
                    `(${ refId })`
                );
            case "Property":
                return (
                    pick( snapshot, [ "title", "referenceCode", "id", "_id" ] ) ||
                    `(${ refId })`
                );
            case "Lease":
                return (
                    pick( snapshot, [ "leaseID", "id", "_id" ] ) ||
                    pick( snapshot?.tenantInformation, [
                        "fullName",
                        "tenantUsername",
                        "email",
                    ] ) ||
                    `(${ refId })`
                );
            default:
                return (
                    pick( snapshot, [
                        "title",
                        "name",
                        "code",
                        "label",
                        "reference",
                        "ref",
                        "id",
                        "_id",
                    ] ) ||
                    pick( snapshot?.metadata, [ "title", "name", "code", "label" ] ) ||
                    `(${ refId })`
                );
        }
    }

    private bodyFor(
        action: DomainAction,
        category: TitleCategory,
        refId: string,
        requestedBy: string,
        snapshot?: Record<string, any>,
    ): string {
        const label = this.displayLabelFromSnapshot( category, refId, snapshot );
        return action === "restore"
            ? `${ category } ${ label } restored by ${ requestedBy }.`
            : `${ category } ${ label } permanently deleted by ${ requestedBy }.`;
    }

    /** Default audience for domain actions: admin/operator/manager. */
    private defaultAudience( _category: TitleCategory ): NotificationAudienceDTO {
        return { mode: "role", roles: [ "admin", "operator", "manager" ] };
    }

    // ───────────────────────────────────────────────────────────────────────────
    // Public helper: domain-action notification
    // ───────────────────────────────────────────────────────────────────────────

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
            action,
            category,
            refId,
            requestedBy,
            snapshot,
            audience,
            channels,
            severity,
            icon,
            tags,
            link,
            source,
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
            severity: severity ?? ( action === "restore" ? "success" : "warning" ),
            audience: finalAudience,
            ...( channels ? { channels } : {} ),
            metadata,
            ...( icon ? { icon } : {} ),
            ...( tags ? { tags } : {} ),
            ...( link ? { link } : {} ),
            ...( source ? { source } : {} ),
            target: { kind: category, refId },
        };

        return this.createNotification( dto, (/* rooms, payload */ ) => {
            // Optional: plug socket emitter here if you inject it
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
        if ( !a?.mode ) throw new Error( "Audience mode is required" );
        if ( a.mode === "user" && !a.usernames?.length )
            throw new Error( "Audience usernames are required for mode=user" );
        if ( a.mode === "role" && !a.roles?.length )
            throw new Error( "Audience roles are required for mode=role" );
    }

    /**
     * Rooms are how Socket.IO "fans out" messages without iterating every user.
     * Example:
     * - role:admin
     * - user:buddhika
     * - broadcast
     */
    private roomsForAudience( a: NotificationAudienceDTO ): string[] {
        const rooms = new Set<string>();
        if ( a.mode === "broadcast" ) rooms.add( "broadcast" );
        if ( a.mode === "user" ) ( a.usernames ?? [] ).forEach( ( u ) => rooms.add( `user:${ u }` ) );
        if ( a.mode === "role" ) ( a.roles ?? [] ).forEach( ( r ) => rooms.add( `role:${ r }` ) );
        return Array.from( rooms );
    }

    private userQueryForAudience( a: NotificationAudienceDTO ): FilterQuery<User> {
        if ( a.mode === "broadcast" ) return { isActive: true };
        if ( a.mode === "user" )
            return { isActive: true, username: { $in: a.usernames ?? [] } };
        return { isActive: true, role: { $in: a.roles ?? [] } };
    }

    /**
     * Fan-out a master notification to per-user state rows.
     *
     * WHY TWO COLLECTIONS?
     * - Master notification is the "message"
     * - UserNotification is the "delivery + read/archive state per user"
     *
     * This pattern scales better than embedding 1M users inside the master doc.
     */
    private async deliverToAudience(
        notification: NotificationEntity,
        session?: ClientSession,
    ) {
        const q = this.userQueryForAudience(
            notification.audience as NotificationAudienceDTO,
        );

    // Cursor avoids loading all users into memory.
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

            // Batch to avoid giant bulk array
            if ( ops.length >= 1000 ) {
                await UserNotificationModel.bulkWrite( ops, this.bulkOpts( session ) );
                ops.length = 0;
            }
        }

        if ( ops.length ) await UserNotificationModel.bulkWrite( ops, this.bulkOpts( session ) );
    }

    // ───────────────────────────────────────────────────────────────────────────
    // Create notification (returns plain object)
    // ───────────────────────────────────────────────────────────────────────────

    public async createNotification(
        doc: CreateNotificationDTO,
        emit?: ( rooms: string[], payload: NotificationEntity ) => void,
        session?: ClientSession,
    ): Promise<NotificationEntity> {
        NotificationPolicySource.validateCreateDoc( doc, "warn" );
        this.validateAudience( doc.audience );

        // Using `new Model().save()` avoids strict-mode typing pitfalls of Model.create([...])
        const m = new NotificationModel( { ...doc, createdAt: new Date() } );
        const persistedDoc = await m.save( session ? { session } : undefined );

        // Convert to plain object for sockets/FE safety
        const plain = ( typeof ( persistedDoc as any ).toObject === "function"
            ? ( persistedDoc as any ).toObject()
            : ( persistedDoc as any ) ) as NotificationEntity;

        await this.deliverToAudience( plain, session );

        emit?.( this.roomsForAudience( doc.audience ), plain );

        return plain;
    }

    // ───────────────────────────────────────────────────────────────────────────
    // Listing
    // ───────────────────────────────────────────────────────────────────────────

    private buildAudienceFilter( username: string, role: Role ) {
        if ( role === "admin" ) return {} as FilterQuery<NotificationEntity>;
        return {
            $or: [
                { "audience.mode": "broadcast" },
                { "audience.mode": "user", "audience.usernames": username },
                { "audience.mode": "role", "audience.roles": role },
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
                { title: { $regex: q, $options: "i" } },
                { body: { $regex: q, $options: "i" } },
                { tags: { $elemMatch: { $regex: q, $options: "i" } } },
            ];
        }

        // Hide expired
        const now = new Date();
        f.$and = [ { $or: [ { expiresAt: { $exists: false } }, { expiresAt: { $gt: now } } ] } ];

        return f;
    }

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
            target: 1,
        };
    }

    private async ensureStatesForMasters(
        username: string,
        masters: NotificationEntity[],
        session?: ClientSession,
    ) {
        await Promise.all(
            masters.map( ( n ) =>
                UserNotificationModel.findOneAndUpdate(
                    { username, notificationId: String( n._id ) },
                    { $setOnInsert: { deliveredAt: new Date(), isRead: false, isArchived: false } },
                    this.findOneAndUpdateOpts( session ),
                ),
            ),
        );
    }

    private async fetchStatesMap(
        username: string,
        masterIds: string[],
        onlyUnread?: boolean,
    ): Promise<Map<string, UserNotificationStateDTO>> {
        const stateFilter: FilterQuery<any> = { username, notificationId: { $in: masterIds } };
        if ( onlyUnread ) stateFilter.isRead = false;

        const states = await UserNotificationModel.find( stateFilter )
            .select( { username: 1, notificationId: 1, isRead: 1, isArchived: 1, deliveredAt: 1, readAt: 1 } )
            .lean<UserNotificationStateDTO[]>();

        return new Map( states.map( ( s ) => [ String( s.notificationId ), s ] ) );
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
        onlyUnread?: boolean,
    ): NotificationWithStateDTO[] {
        return masters
            .map( ( n ) => {
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
        const page = Number.isFinite( opts.skip )
            ? Math.floor( ( opts.skip as number ) / ( opts.limit ?? 20 ) )
            : Math.max( 0, opts.page ?? 0 );

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

        const ids = masters.map( ( m ) => String( m._id ) );
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
            { upsert: true },
        );
    }

    public markManyRead( username: string, notificationIds: Array<string | Types.ObjectId> ) {
        const ids = notificationIds.map( String );
        return UserNotificationModel.updateMany(
            { username, notificationId: { $in: ids }, isRead: false },
            { $set: { isRead: true, readAt: new Date() } },
        );
    }

    public markAllRead( username: string ) {
        return UserNotificationModel.updateMany(
            { username, isRead: false },
            { $set: { isRead: true, readAt: new Date() } },
        );
    }

    public archiveAll( username: string ) {
        return UserNotificationModel.updateMany(
            { username, isArchived: false },
            { $set: { isArchived: true } },
        );
    }

    public deleteAllStatesForUser( username: string, session?: ClientSession ) {
        return UserNotificationModel.deleteMany( { username }, this.deleteOpts( session ) );
    }

    public deleteStatesForUser(
        username: string,
        notificationIds: Array<string | Types.ObjectId>,
        session?: ClientSession,
    ) {
        const ids = notificationIds.map( String );
        return UserNotificationModel.deleteMany(
            { username, notificationId: { $in: ids } },
            this.deleteOpts( session ),
        );
    }

    // ───────────────────────────────────────────────────────────────────────────
    // Restore / Permanent delete (future-proof via registry)
    // ───────────────────────────────────────────────────────────────────────────

    public async restoreByCategory( input: RestoreByCategoryInput ): Promise<DispatchResult> {
        const { category, refId, snapshot, requestedBy } = input;
        const metadata = input.metadata ?? {};
        const useTransaction = !!input.useTransaction;

        const safeRefId = typeof refId === "string" ? refId.trim() : "";
        if ( !safeRefId ) return { ok: false, message: "refId is required for restore" };

        if ( useTransaction ) {
            const conn: Connection = NotificationModel.db;
            const session = await conn.startSession();
            try {
                session.startTransaction();
                const res = await this.restoreGeneric( category, safeRefId, metadata, requestedBy, session, snapshot );
                await session.commitTransaction();
                session.endSession();
                return res;
            } catch ( e: any ) {
                await session.abortTransaction();
                session.endSession();
                return { ok: false, message: e?.message || "Restore failed (tx)" };
            }
        }

        return this.restoreGeneric( category, safeRefId, metadata, requestedBy, undefined, snapshot );
    }

    public async permanentDeleteByCategory( input: PermanentDeleteInput ): Promise<DispatchResult> {
        const { category, requestedBy } = input;
        const metadata = input.metadata ?? {};
        const useTransaction = !!input.useTransaction;

        const refId = typeof input.refId === "string" ? input.refId.trim() : "";
        if ( !refId ) return { ok: false, message: "refId is required for permanent delete" };

        if ( useTransaction ) {
            const conn: Connection = NotificationModel.db;
            const session = await conn.startSession();
            try {
                session.startTransaction();
                const res = await this.hardDeleteGeneric( category, refId, metadata, requestedBy, session );
                await session.commitTransaction();
                session.endSession();
                return res;
            } catch ( e: any ) {
                await session.abortTransaction();
                session.endSession();
                return { ok: false, message: e?.message || "Permanent delete failed (tx)" };
            }
        }

        return this.hardDeleteGeneric( category, refId, metadata, requestedBy );
    }

    /**
     * Restore algorithm (generic, domain-specific rules come from handler):
     *
     * 1) Read snapshot from recyclebin/<category>/<refId>/snapshot.json
     * 2) Normalize snapshot (handler.normalizeSnapshot)
     * 3) Insert new document into DB (transaction optional)
     * 4) Restore folder from recyclebin/<category>/<refId>/ -> uploads root
     * 5) Purge recycle bin
     * 6) Return rooms so UI can refresh
     */
    private async restoreGeneric(
        category: TitleCategory,
        refId: string,
        metadata: Record<string, any>,
        requestedBy: string,
        session?: ClientSession,
        incomingSnapshot?: Record<string, any>,
    ): Promise<DispatchResult> {
        const handler = this.handlers.get( category );
        if ( !handler ) return { ok: false, message: `Restore not supported for category "${ category }"` };

        const Model = handler.getModel();
        if ( !Model ) return { ok: false, message: `${ category } model unavailable` };

        const fileSnap = await this.bin.readSnapshot( category, refId );
        const payload =
            fileSnap.ok && fileSnap.data
                ? ( fileSnap.data as Record<string, any> )
                : incomingSnapshot ?? null;

        if ( !payload ) {
            return { ok: false, message: `No snapshot found in recyclebin for ${ category }/${ refId }` };
        }

        const normalized = handler.normalizeSnapshot ? handler.normalizeSnapshot( payload ) : payload;

        // Insert new doc (you may choose to preserve _id in future, but this is safer)
        const created = await new ( Model as any )( normalized ).save( session ? { session } : undefined );

        // Restore media tree (best-effort)
        try {
            // The handler returns "uploads/..." public-relative root
            const destRel = handler.resolveUploadsRoot( String( created._id ), payload );
            await this.bin.restoreFolder( category, refId, destRel );
        } catch ( e ) {
            console.warn( `[Warning:] [NotificationService] restore media move warning.\n`, e, "\n" );
        }

        // Purge recycle bin (best-effort)
        try {
            await this.bin.purge( category, refId );
        } catch {}

        // Send a domain-action notification (optional, but recommended)
        try {
            await this.notifyDomainAction( {
                action: "restore",
                category,
                refId: String( created._id ),
                requestedBy,
                snapshot: payload,
            } );
        } catch {}

        return {
            ok: true,
            message: `${ category } restored`,
            restored: { _id: created._id },
            rooms: this.roomsOnRestore( category.toLowerCase(), { ...metadata, byUser: requestedBy } ),
        };
    }

    /**
     * Permanent delete algorithm:
     * 1) Purge recyclebin folder for that refId
     * 2) Optionally remove leftover uploads folder (legacy cleanup)
     * 3) Send notification
     */
    private async hardDeleteGeneric(
        category: TitleCategory,
        refId: string,
        metadata: Record<string, any>,
        requestedBy: string,
        _session?: ClientSession,
    ): Promise<DispatchResult> {
        const handler = this.handlers.get( category );

        // 1) Purge recycle bin
        await this.bin.purge( category, refId );

        // 2) Legacy cleanup: delete leftover uploads folder if it exists
        // WHY legacy cleanup matters:
        // - If some older code deleted DB but didn't move files correctly
        // - Or if snapshot restore happened partly
        if ( handler ) {
            try {
                const uploadsRel = handler.resolveUploadsRoot( refId );
                // process.cwd() may differ in dist; prefer absolute from your own public root if you have it elsewhere
                const abs = path.resolve( process.cwd(), "public", uploadsRel.replace( /^uploads\//, "uploads/" ) );
                await fsp.rm( abs, { recursive: true, force: true } );
            } catch ( e ) {
                console.warn( `[Warning:] [NotificationService] leftover public folder cleanup warning.\n`, e, "\n" );
            }
        }

        // 3) Notify
        try {
            await this.notifyDomainAction( {
                action: "permanent_delete",
                category,
                refId,
                requestedBy,
            } );
        } catch {}

        return {
            ok: true,
            message: `${ category } permanently deleted`,
            rooms: this.roomsOnDelete( category.toLowerCase(), { ...metadata, byUser: requestedBy } ),
        };
    }

    // ───────────────────────────────────────────────────────────────────────────
    // Live update rooms
    // ───────────────────────────────────────────────────────────────────────────

    private roomsOnRestore( kind: string, meta: Record<string, any> = {} ): string[] {
        const rooms: string[] = [];
        if ( typeof meta?.byUser === "string" && meta.byUser.trim() ) rooms.push( `user:${ meta.byUser.trim() }` );
        rooms.push( `domain:${ kind }` );
        rooms.push( "role:admin" );
        return rooms;
    }

    private roomsOnDelete( kind: string, meta: Record<string, any> = {} ): string[] {
        const rooms: string[] = [];
        if ( typeof meta?.byUser === "string" && meta.byUser.trim() ) rooms.push( `user:${ meta.byUser.trim() }` );
        rooms.push( `domain:${ kind }` );
        rooms.push( "role:admin" );
        return rooms;
    }

    // ───────────────────────────────────────────────────────────────────────────
    // Change streams (optional)
    // ───────────────────────────────────────────────────────────────────────────

    public watchChanges( io?: import( "socket.io" ).Namespace ) {
        try {
            const notifStream = NotificationModel.watch( [], { fullDocument: "updateLookup" } );
            notifStream.on( "change", async ( ev: any ) => {
                if ( ev.operationType === "insert" ) {
                    const n = ev.fullDocument as NotificationEntity;
                    await this.deliverToAudience( n );
                    if ( io ) {
                        const rooms = this.roomsForAudience( n.audience as any );
                        rooms.forEach( ( room ) => io.to( room ).emit( "notification.new", n ) );
                    }
                }
            } );
        } catch {
            /* change streams unavailable — ok */
        }

        try {
            const userStream = UserModel.watch( [], { fullDocument: "updateLookup" } );
            userStream.on( "change", async ( ev: any ) => {
                if ( ev.operationType === "insert" ) {
                    const u = ev.fullDocument as User;
                    if ( u?.isActive ) await this.backfillForUser( u.username, u.role );
                } else if ( ev.operationType === "update" && ev.updateDescription?.updatedFields ) {
                    const updated = ev.updateDescription.updatedFields;
                    if ( "role" in updated || "isActive" in updated ) {
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

        const ops = masters.map( ( m ) => ( {
            updateOne: {
                filter: { username, notificationId: String( m._id ) },
                update: { $setOnInsert: { deliveredAt: new Date(), isRead: false, isArchived: false } },
                upsert: true,
            },
        } ) );

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
        session?: ClientSession,
    ) {
        await this.backfillForUser( username, newRole, session );

        if ( !removeNoLongerEligible ) return { added: true, removed: false };

        const inScopeNow = await NotificationModel.find( this.buildAudienceFilter( username, newRole ), { _id: 1 } )
            .lean<{ _id: Types.ObjectId; }[]>();

        const keep = new Set( inScopeNow.map( ( x ) => String( x._id ) ) );
        const existing = await UserNotificationModel.find( { username } ).select( { notificationId: 1 } ).lean();

        const removeIds = existing.map( ( s ) => s.notificationId ).filter( ( id ) => !keep.has( String( id ) ) );
        if ( removeIds.length ) {
            await UserNotificationModel.deleteMany(
                { username, notificationId: { $in: removeIds } },
                this.deleteOpts( session ),
            );
        }

        return { added: true, removed: removeIds.length > 0 };
    }
}
