// Path: src/services/notifications/notification.query.service.ts
// =============================================================================
// Notification Hub — Query Service (Enterprise Inbox Queries)
// =============================================================================
//
// FIX SUMMARY (Owner boundary correction)
// - Inbox state belongs to a USER by userId (stable identifier).
// - user_notifications collection is indexed on userId and unique by (userId, notificationId).
// - Querying by username can return empty if username drifted or legacy rows are missing username.
// - We still use username for scope filtering because audiences.mode="User" stores username.
// =============================================================================

import { type ClientSession, type PipelineStage, type FilterQuery, Types } from "mongoose";

import type {
  NotificationCoreDto,
  NotificationInboxItemDto,
  NotificationLoadFilters,
  NotificationLoadRequest,
  NotificationLoadResponse,
  NotificationCountResponse,
} from "../../types/notification/notification.types";

import { UserNotificationModel } from "../../models/notifications/user-notification.model";
import type { NotificationScope, NotificationPriorityScope } from "../../socket/events/notifications/notification.rpc.events";
import { NotificationTypeGuards } from "../../types/notification/notification.type-guards";

/* =============================================================================
 * A) Internal aggregation row shapes (aligned with $project)
 * ========================================================================== */

interface AggRowInbox {
  inboxId: string;

  userId: string;
  username: string;

  isRead: boolean;
  readAt?: string;

  isArchived?: boolean;
  archivedAt?: string;

  isDeleted: boolean;
  deletedAt?: string;

  deliveredAt?: string;

  notification: NotificationCoreDto;
}

interface CountAggRow {
  c: number;
}

interface PriorityCond {
  $or: Array<Record<string, unknown>>;
}

/* =============================================================================
 * B) Query Service (class-based)
 * ========================================================================== */

export class NotificationQueryService {
  private static readonly HARD_MAX_LIMIT: number = 500;
  public constructor () {}

  /* ===========================================================================
   * 01) Load inbox page for a user (default tab)
   * ======================================================================== */

  /**
   * Load inbox listing for a single user (owner boundary).
   *
   * @param userId
   * - Expected: authenticated user's id (MongoId string stored in DB as string)
   * - Usage: owner boundary for reading inbox state rows (stable identifier)
   *
   * @param req
   * - Expected: NotificationLoadRequest containing page/limit/filters
   *
   * @param session
   * - Optional: mongoose ClientSession
   */
  public async loadInboxForUser(
    userId: string,
    req: NotificationLoadRequest,
    session?: ClientSession
  ): Promise<NotificationLoadResponse> {
    const uid = this.safeUserId( userId );

    const page = this.safePage( req.page );
    const limit = this.safeLimit( req.limit );
    const skip = ( page - 1 ) * limit;

    const filters: NotificationLoadFilters = req.filters ?? {};

    const stateMatch = this.buildStateMatch( uid, filters );
    const notifMatch = this.buildNotificationMatch( filters );

    const pipeline = this.buildInboxPipeline( {
      stateMatch,
      notifMatch,
      extraMatches: [],
      sort: { deliveredAt: -1, "n.createdAt": -1, _id: -1 },
      skip,
      limit,
      project: true,
    } );

    const rows = await this.aggregateWithSession<AggRowInbox>( pipeline, session );
    const items = rows.map( ( r ) => this.mapAggRowToInboxItem( r ) );

    const total = await this.countInboxTotalForUser( uid, filters, session );

    return { items, other: { total } };
  }

  /* ===========================================================================
   * 01-B) Load inbox by scope + priorityScope (tabs)
   * ======================================================================== */

  /**
   * Load inbox items under a scope tab:
   * - scope = user | role | company
   * - priorityScope = all | prioritized | unprioritized
   *
   * NOTE
   * - Owner boundary is still userId (state rows).
   * - Scope boundary uses username/roleKey because master audiences store those fields.
   *
   * @param userId
   * - Expected: authenticated user's id (MongoId string)
   *
   * @param username
   * - Expected: authenticated user's username (used only for scope=User audience matching)
   *
   * @param roleKey
   * - Expected: authenticated user's role key (used only for scope=Role audience matching)
   */
  public async loadInboxForUserByScope(
    userId: string,
    username: string,
    roleKey: string,
    scope: NotificationScope = "company",
    priorityScope: NotificationPriorityScope,
    req: NotificationLoadRequest,
    session?: ClientSession
  ): Promise<{
    items: NotificationInboxItemDto[];
    other: { total: number; unread: number; prioritized: number; unprioritized: number; };
  }> {
    const uid = this.safeUserId( userId );
    const uname = this.safeUsername( username );
    const r = this.safeString( roleKey );

    const page = this.safePage( req.page );
    const limit = this.safeLimit( req.limit );
    const skip = ( page - 1 ) * limit;

    const filters: NotificationLoadFilters = req.filters ?? {};

    const stateMatch = this.buildStateMatch( uid, filters );
    const notifMatch = this.buildNotificationMatch( filters );

    const scopeMatch = this.buildScopeMatch( scope, uname, r );
    const priorityMatch = this.buildPriorityMatch( priorityScope, uname );

    const pipeline = this.buildInboxPipeline( {
      stateMatch,
      notifMatch,
      extraMatches: [ scopeMatch, priorityMatch ],
      sort: { deliveredAt: -1 },
      skip,
      limit,
      project: true,
    } );

    const rows = await this.aggregateWithSession<AggRowInbox>( pipeline, session );
    const items = rows.map( ( x ) => this.mapAggRowToInboxItem( x ) );

    const counts = await this.countInboxForUserByScope( uid, uname, r, scope ?? "company", filters, session );

    const total = await this.countInboxForUserByScopeAndPriority( uid, uname, r, scope ?? "company", priorityScope, filters, session );
    const unread = await this.countUnreadForUserByScopeAndPriority( uid, uname, r, scope ?? "company", priorityScope, filters, session );

    return {
      items,
      other: {
        total,
        unread,
        prioritized: counts.prioritized,
        unprioritized: counts.unprioritized,
      },
    };
  }

  /* ===========================================================================
   * 02) Count inbox totals
   * ======================================================================== */

  /**
   * Counts for user inbox (default view):
   * - total
   * - unread
   *
   * @param userId
   * - Expected: authenticated user's id (MongoId string)
   */
  /**
 * Counts for default inbox view (ALL scope), split by audience priority model.
 *
 * RULE
 * - prioritized   : direct-to-user (audiences.mode="User" with this username)
 * - unprioritized : role/company broadcasts (and NOT direct-to-user)
 *
 * NOTE
 * - We need username here because canonical User-audience stores username.
 */
  public async countInboxForUser(
    userId: string,
    username: string,
    filters: NotificationLoadFilters,
    session?: ClientSession
  ): Promise<NotificationCountResponse> {
    const uid = this.safeUserId( userId );
    const uname = this.safeUsername( username );

    // total (respect filters)
    const total = await this.countInboxTotalForUser( uid, { ...filters }, session );

    // unread (force unread semantics)
    const unreadFilters: NotificationLoadFilters = {
      ...filters,
      unreadOnly: true,
      includeDeleted: false,
      includeArchived: false,
    };
    const unread = await this.countInboxTotalForUser( uid, unreadFilters, session );

    // prioritized/unprioritized are computed on the SAME base filters
    // (do NOT force unreadOnly unless you explicitly want unread-priority counts)
    const prioritized = await this.countByPriorityOnly( uid, uname, "prioritized", { ...filters }, session );
    const unprioritized = await this.countByPriorityOnly( uid, uname, "unprioritized", { ...filters }, session );

    return { total, unread, prioritized, unprioritized };
  }

  /**
   * Counts under scope tabs:
   * - prioritized
   * - unprioritized
   * - total/unread (scope-aware)
   *
   * @param userId
   * - Expected: authenticated user's id (MongoId string)
   *
   * @param username
   * - Expected: authenticated user's username (for scope=User)
   *
   * @param roleKey
   * - Expected: authenticated user's roleKey (for scope=Role)
   */
  public async countInboxForUserByScope(
    userId: string,
    username: string,
    roleKey: string,
    scope: NotificationScope = "company",
    filters: NotificationLoadFilters,
    session?: ClientSession
  ): Promise<{
    total: number;
    unread: number;
    prioritized: number;
    unprioritized: number;
  }> {
    const uid = this.safeUserId( userId );
    const uname = this.safeUsername( username );
    const role = this.safeNonEmptyString( roleKey, 'Role key' );

    const prioritized = await this.countByScopeAndPriority( uid, uname, role, scope, "prioritized", filters, session );
    const unprioritized = await this.countByScopeAndPriority( uid, uname, role, scope, "unprioritized", filters, session );

    // ✅ FIX: total/unread must respect scope + priority=all (scope-aware)
    const total = await this.countInboxForUserByScopeAndPriority( uid, uname, role, scope ?? "company", "all", { ...filters }, session );
    const unread = await this.countUnreadForUserByScopeAndPriority( uid, uname, role, scope ?? "company", "all", { ...filters }, session );

    return { total, unread, prioritized, unprioritized };
  }

  /* ===========================================================================
   * Fix A helpers
   * ======================================================================== */

  public async loadInboxItemById(
    inboxId: string,
    userId: string,
    session?: ClientSession
  ): Promise<NotificationInboxItemDto | null> {
    if ( !Types.ObjectId.isValid( inboxId ) ) return null;

    const inboxObjectId = new Types.ObjectId( inboxId );
    const uid = this.safeUserId( userId );

    const pipeline: PipelineStage[] = [
      { $match: { _id: inboxObjectId, userId: uid } },
      {
        $lookup: {
          from: "notifications",
          localField: "notificationId",
          foreignField: "_id",
          as: "n",
        },
      },
      { $unwind: { path: "$n", preserveNullAndEmptyArrays: false } },
      this.buildInboxProject(),
    ];

    const rows = await this.aggregateWithSession<AggRowInbox>( pipeline, session );
    const first = rows[ 0 ];
    return first ? this.mapAggRowToInboxItem( first ) : null;
  }

  public async loadInboxItemsByNotificationAndUsers(
    notificationId: string,
    userIds: string[],
    session?: ClientSession
  ): Promise<NotificationInboxItemDto[]> {
    const notifId = typeof notificationId === "string" ? notificationId.trim() : "";
    if ( !notifId || !Types.ObjectId.isValid( notifId ) ) return [];

    const normalizedUserIds = this.normalizeStringIds( userIds );
    if ( normalizedUserIds.length === 0 ) return [];

    const notifObjectId = new Types.ObjectId( notifId );

    const pipeline: PipelineStage[] = [
      {
        $match: {
          notificationId: notifObjectId,
          userId: { $in: normalizedUserIds },
        },
      },
      {
        $lookup: {
          from: "notifications",
          localField: "notificationId",
          foreignField: "_id",
          as: "n",
        },
      },
      { $unwind: { path: "$n", preserveNullAndEmptyArrays: false } },
      this.buildInboxProject(),
    ];

    const rows = await this.aggregateWithSession<AggRowInbox>( pipeline, session );
    return rows.map( ( r ) => this.mapAggRowToInboxItem( r ) );
  }

  /* =============================================================================
   * C) Internal count helpers
   * ========================================================================== */

  /**
 * Count by priorityScope only (no scope tabs).
 *
 * @param userId  owner boundary (state rows)
 * @param username used for User-audience matching
 * @param priorityScope prioritized | unprioritized
 */
  private async countByPriorityOnly(
    userId: string,
    username: string,
    priorityScope: NotificationPriorityScope,
    filters: NotificationLoadFilters,
    session?: ClientSession
  ): Promise<number> {
    const stateMatch = this.buildStateMatch( userId, filters );
    const notifMatch = this.buildNotificationMatch( filters );

    const priorityMatch = this.buildPriorityMatch( priorityScope, username );

    const pipeline: PipelineStage[] = [
      { $match: stateMatch },
      ...this.buildLookupAndMasterMatchPipeline( { notifMatch } ),
      { $match: priorityMatch },
      { $count: "c" },
    ];

    const rows = await this.aggregateWithSession<CountAggRow>( pipeline, session );
    const first = rows[ 0 ];
    return first ? Number( first.c ) : 0;
  }

  private async countInboxTotalForUser(
    userId: string,
    filters: NotificationLoadFilters,
    session?: ClientSession
  ): Promise<number> {
    const stateMatch = this.buildStateMatch( userId, filters );
    const notifMatch = this.buildNotificationMatch( filters );

    const pipeline: PipelineStage[] = [
      { $match: stateMatch },
      ...this.buildLookupAndMasterMatchPipeline( { notifMatch } ),
      { $count: "c" },
    ];

    const agg = await this.aggregateWithSession<CountAggRow>( pipeline, session );
    const first = agg[ 0 ];
    return first ? Number( first.c ) : 0;
  }

  private async countByScopeAndPriority(
    userId: string,
    username: string,
    roleKey: string,
    scope: NotificationScope,
    priorityScope: NotificationPriorityScope,
    filters: NotificationLoadFilters,
    session?: ClientSession
  ): Promise<number> {
    const stateMatch = this.buildStateMatch( userId, filters );
    const notifMatch = this.buildNotificationMatch( filters );
    const uname = this.safeUsername( username );

    const scopeMatch = this.buildScopeMatch( scope, username, roleKey );
    const priorityMatch = this.buildPriorityMatch( priorityScope, uname );

    const pipeline: PipelineStage[] = [
      { $match: stateMatch },
      ...this.buildLookupAndMasterMatchPipeline( { notifMatch } ),
      { $match: scopeMatch },
      { $match: priorityMatch },
      { $count: "c" },
    ];

    const rows = await this.aggregateWithSession<CountAggRow>( pipeline, session );
    const first = rows[ 0 ];
    return first ? Number( first.c ) : 0;
  }

  private async countInboxForUserByScopeAndPriority(
    userId: string,
    username: string,
    roleKey: string,
    scope: NotificationScope = "company",
    priorityScope: NotificationPriorityScope,
    filters: NotificationLoadFilters,
    session?: ClientSession
  ): Promise<number> {
    return this.countByScopeAndPriority( userId, username, roleKey, scope, priorityScope, { ...filters }, session );
  }

  private async countUnreadForUserByScopeAndPriority(
    userId: string,
    username: string,
    roleKey: string,
    scope: NotificationScope,
    priorityScope: NotificationPriorityScope,
    filters: NotificationLoadFilters,
    session?: ClientSession
  ): Promise<number> {
    const unreadFilters: NotificationLoadFilters = {
      ...filters,
      unreadOnly: true,
      includeDeleted: false,
      includeArchived: false,
    };

    return this.countByScopeAndPriority( userId, username, roleKey, scope, priorityScope, unreadFilters, session );
  }

  /* =============================================================================
   * D) Builders: pipelines + matches
   * ========================================================================== */

  private buildLookupAndMasterMatchPipeline( input: { notifMatch: FilterQuery<unknown>; } ): PipelineStage[] {
    return [
      {
        $lookup: {
          from: "notifications",
          localField: "notificationId",
          foreignField: "_id",
          as: "n",
        },
      },
      { $unwind: "$n" },
      { $match: input.notifMatch },
    ];
  }

  private buildInboxPipeline( input: {
    stateMatch: FilterQuery<unknown>;
    notifMatch: FilterQuery<unknown>;
    extraMatches: Array<FilterQuery<unknown>>;
    sort: Record<string, 1 | -1>;
    skip: number;
    limit: number;
    project: boolean;
  } ): PipelineStage[] {
    const pipeline: PipelineStage[] = [];

    pipeline.push( { $match: input.stateMatch } );
    pipeline.push( ...this.buildLookupAndMasterMatchPipeline( { notifMatch: input.notifMatch } ) );

    for ( const m of input.extraMatches ) {
      if ( m && Object.keys( m as Record<string, unknown> ).length > 0 ) {
        pipeline.push( { $match: m } );
      }
    }

    pipeline.push( { $sort: input.sort } );
    pipeline.push( { $skip: input.skip } );
    pipeline.push( { $limit: input.limit } );

    if ( input.project ) {
      pipeline.push( this.buildInboxProject() );
    }

    return pipeline;
  }

  /**
   * ✅ OWNER BOUNDARY (state rows): userId
   */
  private buildStateMatch( userId: string, filters: NotificationLoadFilters ): FilterQuery<unknown> {
    const match: Record<string, unknown> = { userId };

    if ( !filters.includeDeleted ) {
      match.isDeleted = false;
    }

    if ( !filters.includeArchived ) {
      match.isArchived = false;
    }

    if ( filters.unreadOnly ) {
      match.isRead = false;
      match.isDeleted = false;
      match.isArchived = false;
    }

    return match as FilterQuery<unknown>;
  }

  private buildNotificationMatch( filters: NotificationLoadFilters ): FilterQuery<unknown> {
    const match: Record<string, unknown> = {};

    if ( filters.category ) match[ "n.category" ] = filters.category;
    if ( filters.severity ) match[ "n.severity" ] = filters.severity;

    if ( filters.mode ) {
      match[ "n.audiences" ] = { $elemMatch: { mode: filters.mode } };
    }

    const search = this.safeString( filters.search );
    if ( search ) {
      const rx = this.escapeRegex( search );
      match[ "$or" ] = [
        { "n.title": { $regex: rx, $options: "i" } },
        { "n.body": { $regex: rx, $options: "i" } },
        { "n.eventKey": { $regex: rx, $options: "i" } },
        { "n.category": { $regex: rx, $options: "i" } },
        { "n.severity": { $regex: rx, $options: "i" } },
      ];
    }

    const fromIso = this.safeIso( filters.from );
    const toIso = this.safeIso( filters.to );

    if ( fromIso || toIso ) {
      const range: Record<string, Date> = {};
      if ( fromIso ) range[ "$gte" ] = new Date( fromIso );
      if ( toIso ) range[ "$lte" ] = new Date( toIso );
      match[ "n.createdAt" ] = range;
    }

    return match as FilterQuery<unknown>;
  }

  /**
   * Scope matching applies to MASTER notification audiences (not to state rows).
   * - User scope uses username because canonical audience stores username.
   * - Role scope uses roleKey.
   * - Company scope is mode=Company.
   */
  private buildScopeMatch( scope: NotificationScope, username: string, roleKey: string ): FilterQuery<unknown> {
    const safeScope = scope.trim().toLowerCase();

    if ( safeScope === "user" ) {
      const u = username.trim();
      return {
        $or: [
          { "n.audiences": { $elemMatch: { mode: "User", username: u } } },
          { "n.audiences": { $elemMatch: { mode: "User", username: { $regex: new RegExp( `^${ this.escapeRegex( u ) }$`, "i" ) } } } },
        ],
      } as FilterQuery<unknown>;
    }

    if ( safeScope === "role" ) {
      const r = roleKey.trim();
      const rx = new RegExp( `^${ this.escapeRegex( r ) }$`, "i" );

      return {
        $or: [
          { "n.audiences": { $elemMatch: { mode: "Role", roleKey: r } } },
          { "n.audiences": { $elemMatch: { mode: "Role", roleKey: { $regex: rx } } } },

          // ✅ legacy support (if older docs used `role`)
          { "n.audiences": { $elemMatch: { mode: "Role", role: r } } },
          { "n.audiences": { $elemMatch: { mode: "Role", role: { $regex: rx } } } },
        ],
      } as FilterQuery<unknown>;
    }

    return {
      "n.audiences": { $elemMatch: { mode: "Company" } },
    } as FilterQuery<unknown>;
  }

  /**
 * Priority scope is audience-mode based (NOT severity/tags).
 *
 * RULE
 * - prioritized   : audiences contains User for THIS username (case-insensitive)
 * - unprioritized : audiences contains Company or Role (optionally Team if you decide),
 *                   AND does NOT contain User for THIS username
 * - all           : no extra match
 *
 * NOTE
 * - Your canonical NotificationAudience(User) stores username, not userId.
 * - If you have legacy docs storing userId in audiences, we support it defensively.
 */
  private buildPriorityMatch(
    priorityScope: NotificationPriorityScope,
    username: string
  ): FilterQuery<unknown> {
    if ( priorityScope === "all" ) {
      return {} as FilterQuery<unknown>;
    }

    const u = this.safeNonEmptyString( username, "Username" ).trim();
    const rxUser = new RegExp( `^${ this.escapeRegex( u ) }$`, "i" );

    // "Direct" audience match (prioritized)
    // Supports:
    // - canonical: { mode:"User", username:"..." }
    // - legacy : { mode:"User", userId:"..." }  (only if exists in DB; harmless otherwise)
    const userAudienceMatch: FilterQuery<unknown> = {
      "n.audiences": {
        $elemMatch: {
          mode: "User",
          $or: [
            { username: u },
            { username: { $regex: rxUser } },

            // legacy (optional) — safe even if field does not exist
            // eslint-disable-next-line @typescript-eslint/naming-convention
            { userId: u },
            // eslint-disable-next-line @typescript-eslint/naming-convention
            { userId: { $regex: rxUser } },
          ],
        } as Record<string, unknown>,
      },
    } as FilterQuery<unknown>;

    // "Overall" audience match (unprioritized)
    // Based on your requirement: Role or Company.
    // If you later want Team included, add: { mode:"Team", teamCode: ... } logic.
    const roleOrCompanyMatch: FilterQuery<unknown> = {
      $or: [
        { "n.audiences": { $elemMatch: { mode: "Company" } } },
        { "n.audiences": { $elemMatch: { mode: "Role" } } },
      ],
    } as FilterQuery<unknown>;

    if ( priorityScope === "prioritized" ) {
      return userAudienceMatch;
    }

    // unprioritized
    // - must be role/company
    // - must NOT be direct user audience
    return {
      $and: [
        roleOrCompanyMatch,
        { $nor: [ userAudienceMatch as unknown as Record<string, unknown> ] },
      ],
    } as unknown as FilterQuery<unknown>;
  }

  /* =============================================================================
   * E) Projection and mapping
   * ========================================================================== */

  private buildInboxProject(): PipelineStage.Project {
    return {
      $project: {
        _id: 0,

        inboxId: { $toString: "$_id" },

        // userId is stored as string in DB, do NOT $toString an already-string value
        userId: "$userId",
        username: "$username",

        isRead: "$isRead",
        readAt: {
          $cond: [ { $ifNull: [ "$readAt", false ] }, { $toString: "$readAt" }, "$$REMOVE" ],
        },

        isArchived: "$isArchived",
        archivedAt: {
          $cond: [ { $ifNull: [ "$archivedAt", false ] }, { $toString: "$archivedAt" }, "$$REMOVE" ],
        },

        isDeleted: "$isDeleted",
        deletedAt: {
          $cond: [ { $ifNull: [ "$deletedAt", false ] }, { $toString: "$deletedAt" }, "$$REMOVE" ],
        },

        deliveredAt: {
          $cond: [ { $ifNull: [ "$deliveredAt", false ] }, { $toString: "$deliveredAt" }, "$$REMOVE" ],
        },

        notification: {
          id: { $toString: "$n._id" },
          eventKey: "$n.eventKey",
          category: "$n.category",
          severity: "$n.severity",
          title: "$n.title",
          body: "$n.body",
          audiences: "$n.audiences",
          createdAt: { $toString: "$n.createdAt" },

          icon: { $ifNull: [ "$n.icon", "$$REMOVE" ] },
          tags: { $ifNull: [ "$n.tags", "$$REMOVE" ] },
          target: { $ifNull: [ "$n.target", "$$REMOVE" ] },
          actor: { $ifNull: [ "$n.actor", "$$REMOVE" ] },

          expiresAt: {
            $cond: [ { $ifNull: [ "$n.expiresAt", false ] }, { $toString: "$n.expiresAt" }, "$$REMOVE" ],
          },
        },
      },
    };
  }

  private mapAggRowToInboxItem( r: AggRowInbox ): NotificationInboxItemDto {
    const inboxId = String( r.inboxId );

    const userId = typeof r.userId === "string" ? r.userId.trim() : "";
    const username = typeof r.username === "string" ? r.username.trim() : "";

    const base: NotificationInboxItemDto = {
      inboxId,
      userId,
      username,
      isRead: !!r.isRead,
      isDeleted: !!r.isDeleted,
      notification: r.notification,
    };

    const out: Record<string, unknown> = { ...base };

    if ( r.readAt ) {
      const iso = this.toIsoMaybe( r.readAt );
      if ( iso ) out.readAt = iso;
    }

    if ( typeof r.isArchived === "boolean" ) out.isArchived = r.isArchived;

    if ( r.archivedAt ) {
      const iso = this.toIsoMaybe( r.archivedAt );
      if ( iso ) out.archivedAt = iso;
    }

    if ( r.deletedAt ) {
      const iso = this.toIsoMaybe( r.deletedAt );
      if ( iso ) out.deletedAt = iso;
    }

    if ( r.deliveredAt ) {
      const iso = this.toIsoMaybe( r.deliveredAt );
      if ( iso ) out.deliveredAt = iso;
    }

    if ( !NotificationTypeGuards.isInboxItem( out ) ) {
      throw new Error( "[Error:] [Notification inbox item validation failed!]\n" );
    }
    return out;
  }

  /* =============================================================================
   * F) Aggregation executor
   * ========================================================================== */

  private async aggregateWithSession<T>( pipeline: PipelineStage[], session?: ClientSession ): Promise<T[]> {
    const agg = UserNotificationModel.aggregate<T>( pipeline );
    if ( session ) agg.session( session );

    const rows = await agg.exec();
    const sorted = Array.isArray( rows )
      ? rows.slice().sort( ( a: any, b: any ) => {
        const da = new Date( a?.deliveredAt ?? 0 ).getTime();
        const db = new Date( b?.deliveredAt ?? 0 ).getTime();
        return db - da;
      } )
      : [];

    return sorted;
  }

  /* =============================================================================
   * G) Safety helpers
   * ========================================================================== */

  private safeUserId( v: unknown ): string {
    const s = typeof v === "string" ? v.trim() : "";
    if ( !s ) throw new Error( "NotificationQueryService: userId is required." );
    return s;
  }

  private safeUsername( v: unknown ): string {
    const u = typeof v === "string" ? v.trim() : "";
    if ( !u ) throw new Error( "NotificationQueryService: username is required." );
    return u;
  }

  private safeString( v: unknown ): string {
    if ( typeof v === "string" ) return v.trim();
    if ( typeof v === "number" ) return String( v );
    return "";
  }

  private safeIso( v: unknown ): string {
    const s = this.safeString( v );
    if ( !s ) return "";
    if ( !/^\d{4}-\d{2}-\d{2}T/.test( s ) ) return "";
    return s;
  }

  private escapeRegex( input: string ): string {
    return input.replace( /[.*+?^${}()|[\]\\]/g, "\\$&" );
  }

  private safePage( page: number ): number {
    const p = Number( page );
    if ( !Number.isFinite( p ) || p < 1 ) return 1;
    return Math.floor( p );
  }

  private safeLimit( limit: number ): number {
    const n = Number( limit );

    // ✅ "load all" contract:
    // - limit = 0 or -1 means "load all", but we still protect with HARD_MAX_LIMIT.
    if ( Number.isFinite( n ) && ( n === 0 || n === -1 ) ) {
      return NotificationQueryService.HARD_MAX_LIMIT;
    }

    // normal paging behavior
    if ( !Number.isFinite( n ) || n < 1 ) return 100;

    // keep your existing safety ceiling, but align with hard max
    return Math.min( Math.floor( n ), NotificationQueryService.HARD_MAX_LIMIT );
  }

  private toIsoMaybe( v: unknown ): string {
    if ( typeof v === "string" ) {
      const s = v.trim();
      if ( !s ) return "";
      return s;
    }
    if ( v instanceof Date ) return v.toISOString();
    return "";
  }

  private safeNonEmptyString( v: unknown, label: string ): string {
    const s = typeof v === "string" ? v.trim() : "";
    if ( !s ) throw new Error( `NotificationQueryService: ${ label } is required.` );
    return s;
  }

  private normalizeStringIds( values: string[] ): string[] {
    const list = Array.isArray( values ) ? values : [];
    const out: string[] = [];
    const seen = new Set<string>();

    for ( const v of list ) {
      const s = typeof v === "string" ? v.trim() : "";
      if ( !s ) continue;
      if ( seen.has( s ) ) continue;
      seen.add( s );
      out.push( s );
    }

    return out;
  }
}