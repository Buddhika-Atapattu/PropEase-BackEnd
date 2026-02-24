// Path: src/services/notifications/notification.query.service.ts
// =============================================================================
// Notification Hub — Query Service (Enterprise Inbox Queries)
// =============================================================================
//
// PURPOSE
// - Provide read-only inbox queries for Notification Hub.
// - Optimized for inbox listing:
//    - pagination
//    - server-side filtering
//    - efficient join with master notifications collection
//
// DATA MODEL (Expected)
// - user_notifications   : per-user state documents
// - notifications        : master notification documents
//
// IMPORTANT SEMANTICS
// - isDeleted  -> trash (deleted items)
// - isArchived -> hidden/archive (not trash)
// - unreadOnly implies: not deleted + not archived + isRead=false
//
// TYPE RULES
// - DTO IDs are strings (no mongoose types in DTO contracts)
// - Dates returned to UI as ISO strings
// =============================================================================

import type { ClientSession, PipelineStage, FilterQuery } from "mongoose";

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

/* =============================================================================
 * A) Internal aggregation row shapes (aligned with $project)
 * ========================================================================== */

/**
 * AggRowInbox must match the EXACT shape produced by the $project stage.
 * If you change $project, update this interface.
 */
interface AggRowInbox {
  inboxId: string;

  userId: string;
  username: string;

  isRead: boolean;
  readAt?: string;

  isDeleted: boolean;

  notification: NotificationCoreDto;
}

/**
 * $count output shape.
 */
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
  public constructor () {}

  /* ===========================================================================
   * 01) Load inbox page for a user
   * ======================================================================== */

  public async loadInboxForUser(
    username: string,
    req: NotificationLoadRequest,
    session?: ClientSession
  ): Promise<NotificationLoadResponse> {
    /**
     * WHY this method exists
     * - UI needs paginated inbox listing.
     * - Must apply both:
     *    1) per-user filters (read/deleted/archived)
     *    2) master notification filters (category/severity/search/date)
     *
     * HOW to use
     * - Called from NotificationRestService.loadInbox(...)
     *
     * PARAMETERS
     * - username: inbox owner boundary (security + filtering)
     * - req: pagination + filters
     * - session: optional transaction session (rare for read ops)
     *
     * RETURNS
     * - items: NotificationInboxItemDto[]
     * - other.total: total count for current filters
     */

    const u = this.safeUsername( username );

    const page = this.safePage( req.page );
    const limit = this.safeLimit( req.limit );
    const skip = ( page - 1 ) * limit;

    const filters: NotificationLoadFilters = req.filters ?? {};

    const stateMatch = this.buildStateMatch( u, filters );
    const notifMatch = this.buildNotificationMatch( filters );

    const pipeline: PipelineStage[] = [
      // 1) Filter per-user rows (user_notifications)
      { $match: stateMatch },

      // 2) Sort by arrival time
      { $sort: { deliveredAt: -1 } },

      // 3) Pagination
      { $skip: skip },
      { $limit: limit },

      // 4) Join master notification (notifications)
      {
        $lookup: {
          from: "notifications",
          localField: "notificationId",
          foreignField: "_id",
          as: "n",
        },
      },

      // 5) Flatten joined array
      { $unwind: "$n" },

      // 6) Apply master notification filters (after join)
      { $match: notifMatch },

      // 7) Final projection into DTO-friendly shape
      this.buildInboxProject(),
    ];

    const rows = await this.aggregateWithSession<AggRowInbox>( pipeline, session );

    // Convert aggregation rows to strict DTO
    const items = rows.map( ( r ) => this.mapAggRowToInboxItem( r ) );

    // Load total count using same filters
    const total = await this.countInboxTotalForUser( u, filters, session );

    return { items, other: { total } };
  }

  /**
   * Load inbox by “scope” (user/role/company) and “priorityScope”.
   *
   * @param username
   * - Expected: inbox owner username (security boundary in user_notifications).
   *
   * @param roleKey
   * - Expected: current user role string (used only for scope="role" match).
   *
   * @param scope
   * - Expected: "user" | "role" | "company"
   *
   * @param priorityScope
   * - Expected: "all" | "prioritized" | "unprioritized"
   *
   * @param req
   * - Expected: NotificationLoadRequest (page/limit/filters)
   *
   * @param session
   * - Optional: mongoose ClientSession for transactional reads (rare but supported)
   */
  public async loadInboxForUserByScope(
    username: string,
    roleKey: string,
    scope: NotificationScope,
    priorityScope: NotificationPriorityScope,
    req: NotificationLoadRequest,
    session?: ClientSession
  ): Promise<{
    items: NotificationInboxItemDto[];
    other: { total: number; unread: number; prioritized: number; unprioritized: number; };
  }> {
    const u = this.safeUsername( username );
    const r = this.safeString( roleKey );

    const page = this.safePage( req.page );
    const limit = this.safeLimit( req.limit );
    const skip = ( page - 1 ) * limit;

    const filters: NotificationLoadFilters = req.filters ?? {};

    const stateMatch = this.buildStateMatch( u, filters );
    const notifMatch = this.buildNotificationMatch( filters );

    const scopeMatch = this.buildScopeMatch( scope, u, r );
    const priorityMatch = this.buildPriorityMatch( priorityScope );

    const pipeline: PipelineStage[] = [
      { $match: stateMatch },
      { $sort: { deliveredAt: -1 } },
      { $skip: skip },
      { $limit: limit },
      {
        $lookup: {
          from: "notifications",
          localField: "notificationId",
          foreignField: "_id",
          as: "n",
        },
      },
      { $unwind: "$n" },
      { $match: notifMatch },
      { $match: scopeMatch },
      { $match: priorityMatch },

      // ✅ MUST be the SAME $project as loadInboxForUser
      this.buildInboxProject(),
    ];

    // ✅ pass session
    const rows = await this.aggregateWithSession<AggRowInbox>( pipeline, session );
    const items = rows.map( ( x ) => this.mapAggRowToInboxItem( x ) );

    // ✅ pass real filters (don’t ignore)
    const counts = await this.countInboxForUserWithScopes( u, r, filters /*, session if you add it */ );

    return { items, other: counts };
  }

  /**
   * Counts for:
   * - total
   * - unread
   * - prioritized
   * - unprioritized
   *
   * @param username
   * - Expected: inbox owner username
   *
   * @param roleKey
   * - Expected: current user role
   *
   * @param filters
   * - Expected: NotificationLoadFilters (same semantics as list filters)
   *
   * @param session
   * - Optional: mongoose session
   */
  public async countInboxForUserWithScopes(
    username: string,
    roleKey: string,
    filters: NotificationLoadFilters,
    session?: ClientSession
  ): Promise<{ total: number; unread: number; prioritized: number; unprioritized: number; }> {
    const u = this.safeUsername( username );
    const r = this.safeString( roleKey );

    // ✅ total/unread MUST respect filters + session
    const base = await this.countInboxForUser( u, { ...filters }, session );

    // prioritized/unprioritized should also respect filters + session
    const prioritized = await this.countByPriority( u, r, "prioritized", { ...filters }, session );
    const unprioritized = await this.countByPriority( u, r, "unprioritized", { ...filters }, session );

    return {
      total: base.total,
      unread: base.unread,
      prioritized,
      unprioritized,
    };
  }

  /* ===========================================================================
   * 02) Count inbox totals (total + unread)
   * ======================================================================== */

  public async countInboxForUser(
    username: string,
    filters: NotificationLoadFilters,
    session?: ClientSession
  ): Promise<NotificationCountResponse> {
    /**
     * WHY this method exists
     * - UI badges need counts:
     *    - total inbox count (for current filter set)
     *    - unread count (unread + not deleted + not archived)
     *
     * HOW to use
     * - Called from NotificationRestService.countInbox(...)
     */

    const u = this.safeUsername( username );

    // TOTAL count respects current filter set
    const total = await this.countInboxTotalForUser( u, { ...filters }, session );

    // UNREAD: enforce unread semantics
    const unreadFilters: NotificationLoadFilters = {
      ...filters,
      unreadOnly: true,
      includeDeleted: false,
      includeArchived: false,
    };

    const unread = await this.countInboxTotalForUser( u, unreadFilters, session );

    return { total, unread };
  }

  /* =============================================================================
   * C) Internal: count using join + filters (same semantics as load)
   * ========================================================================== */

  private async countInboxTotalForUser(
    username: string,
    filters: NotificationLoadFilters,
    session?: ClientSession
  ): Promise<number> {
    const stateMatch = this.buildStateMatch( username, filters );
    const notifMatch = this.buildNotificationMatch( filters );

    const pipeline: PipelineStage[] = [
      { $match: stateMatch },
      {
        $lookup: {
          from: "notifications",
          localField: "notificationId",
          foreignField: "_id",
          as: "n",
        },
      },
      { $unwind: "$n" },
      { $match: notifMatch },
      { $count: "c" },
    ];

    const agg = await this.aggregateWithSession<CountAggRow>( pipeline, session );

    const first = agg[ 0 ];
    if ( !first ) return 0;

    return Number( first.c );
  }


  public async countInboxForUserByScope(
    username: string,
    roleKey: string,
    scope: NotificationScope,
    priorityScope: NotificationPriorityScope,
    filters: NotificationLoadFilters,
    session?: ClientSession
  ): Promise<{ total: number; unread: number; prioritized: number; unprioritized: number; }> {
    const u = this.safeUsername( username );
    const r = this.safeString( roleKey );

    const stateMatch = this.buildStateMatch( u, { ...filters } );
    const notifMatch = this.buildNotificationMatch( { ...filters } );
    const scopeMatch = this.buildScopeMatch( scope, u, r );
    const priorityMatch = this.buildPriorityMatch( priorityScope );

    const total = await this.countWithPipeline(
      {
        state: stateMatch,
        notif: notifMatch,
        scope: scopeMatch,
        priority: priorityMatch,
      },
      session
    );

    const unreadFilters: NotificationLoadFilters = {
      ...filters,
      unreadOnly: true,
      includeDeleted: false,
      includeArchived: false,
    };

    const unreadStateMatch = this.buildStateMatch( u, unreadFilters );
    const unreadNotifMatch = this.buildNotificationMatch( unreadFilters );

    const unread = await this.countWithPipeline(
      {
        state: unreadStateMatch,
        notif: unreadNotifMatch,
        scope: scopeMatch,
        priority: priorityMatch,

      },
      session
    );

    const prioritized = await this.countWithPipeline(
      {
        state: stateMatch,
        notif: notifMatch,
        scope: scopeMatch,
        priority: this.buildPriorityMatch( "prioritized" ),

      },
      session
    );

    const unprioritized = await this.countWithPipeline(
      {
        state: stateMatch,
        notif: notifMatch,
        scope: scopeMatch,
        priority: this.buildPriorityMatch( "prioritized" ),

      },
      session
    );

    return { total, unread, prioritized, unprioritized };
  }

  private async countWithPipeline(
    input: {
      state: FilterQuery<unknown>;
      notif: FilterQuery<unknown>;
      scope?: FilterQuery<unknown>;
      priority?: FilterQuery<unknown>;
    },
    session?: ClientSession
  ): Promise<number> {
    const pipeline: PipelineStage[] = [];

    // ✅ Required matches (never undefined)
    pipeline.push( { $match: input.state } as unknown as PipelineStage );
    pipeline.push( {
      $lookup: {
        from: "notifications",
        localField: "notificationId",
        foreignField: "_id",
        as: "n",
      },
    } );
    pipeline.push( { $unwind: "$n" } );
    pipeline.push( { $match: input.notif } as unknown as PipelineStage );

    // ✅ Optional matches (only push if present)
    if ( input.scope ) {
      pipeline.push( { $match: input.scope } as unknown as PipelineStage );
    }

    if ( input.priority ) {
      pipeline.push( { $match: input.priority } as unknown as PipelineStage );
    }

    pipeline.push( { $count: "c" } );

    const rows = await this.aggregateWithSession<CountAggRow>( pipeline, session );
    return rows[ 0 ]?.c ? Number( rows[ 0 ].c ) : 0;
  }

  /* =============================================================================
   * D) Builders: state match + notification match
   * ========================================================================== */

  private buildStateMatch( username: string, filters: NotificationLoadFilters ): FilterQuery<unknown> {
    /**
     * WHY this method exists
     * - user_notifications contains per-user state.
     * - This method builds the $match for that collection.
     *
     * SEMANTICS
     * - includeDeleted=false => isDeleted=false
     * - includeArchived=false => isArchived=false
     * - unreadOnly => isRead=false AND isDeleted=false AND isArchived=false
     */

    const match: Record<string, unknown> = { username };

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
    /**
     * WHY this method exists
     * - notifications collection holds the master message.
     * - After $unwind "$n", the master doc is under "n.*".
     */

    const match: Record<string, unknown> = {};

    if ( filters.category ) match[ "n.category" ] = filters.category;
    if ( filters.severity ) match[ "n.severity" ] = filters.severity;

    // Audience mode filter for admin/tools
    // NOTE: audiences is array, so use "n.audiences.mode"
    if ( filters.mode ) {
      match[ "n.audiences.mode" ] = filters.mode;
    }

    // Search across relevant master fields
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

    // Date range filtering (ISO string)
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

  /* =============================================================================
   * E) Mapping: aggregation row -> DTO (final guard)
   * ========================================================================== */

  private mapAggRowToInboxItem( r: AggRowInbox ): NotificationInboxItemDto {
    /**
     * WHY this method exists
     * - Even if aggregation projects a DTO-like shape,
     *   we keep one final mapping step to:
     *     - enforce exactOptionalPropertyTypes safe output
     *     - trim strings
     *     - avoid accidental undefined injection
     */

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

    if ( r.readAt ) {
      const iso = this.toIsoMaybe( r.readAt );
      if ( iso ) {
        return { ...base, readAt: iso };
      }
    }

    return base;
  }

  /* =============================================================================
   * F) Aggregation executor (session-safe + strict typing)
   * ========================================================================== */

  private async aggregateWithSession<T>(
    pipeline: PipelineStage[],
    session?: ClientSession
  ): Promise<T[]> {
    const agg = UserNotificationModel.aggregate<T>( pipeline );

    if ( session ) {
      agg.session( session );
    }

    const rows = await agg.exec();
    return Array.isArray( rows ) ? rows : [];
  }

  /* =============================================================================
   * G) Safety helpers (class-based)
   * ========================================================================== */

  private safeUsername( v: string ): string {
    const u = typeof v === "string" ? v.trim() : "";
    if ( !u ) {
      throw new Error( "NotificationQueryService: username is required." );
    }
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
    if ( !Number.isFinite( n ) || n < 1 ) return 10;
    return Math.min( Math.floor( n ), 100 );
  }

  private toIsoMaybe( v: unknown ): string {
    if ( typeof v === "string" ) return v;
    if ( v instanceof Date ) return v.toISOString();
    return "";
  }

  private async countByPriority(
    username: string,
    roleKey: string,
    priorityScope: NotificationPriorityScope,
    filters: NotificationLoadFilters,
    session?: ClientSession
  ): Promise<number> {
    // per-user state match (includes unreadOnly/includeDeleted/includeArchived semantics)
    const stateMatch = this.buildStateMatch( username, filters );

    // master notification match (category/severity/search/date/mode)
    const notifMatch = this.buildNotificationMatch( filters );

    // priority filter (severity/tags)
    const priorityMatch = this.buildPriorityMatch( priorityScope );

    // NOTE:
    // - roleKey currently not used here because priority count is for the user's inbox.
    // - if you later want role/company priority counts separately, you can add scopeMatch too.

    const pipeline: PipelineStage[] = [
      { $match: stateMatch },
      {
        $lookup: {
          from: "notifications",
          localField: "notificationId",
          foreignField: "_id",
          as: "n",
        },
      },
      { $unwind: "$n" },
      { $match: notifMatch },
      { $match: priorityMatch },
      { $count: "c" },
    ];

    const rows = await this.aggregateWithSession<CountAggRow>( pipeline, session );
    return rows[ 0 ]?.c ? Number( rows[ 0 ].c ) : 0;
  }

  /**
   * Build match for "scope" tabs (user / role / company).
   *
   * @param scope
   * - Expected: "user" | "role" | "company"
   *
   * @param username
   * - Expected: current auth username
   * - Used only for scope="user" to match { mode:"User", username }
   *
   * @param roleKey
   * - Expected: current auth role (Role)
   * - Used only for scope="role" to match { mode:"Role", roleKey }
   */
  private buildScopeMatch(
    scope: NotificationScope,
    username: string,
    roleKey: string
  ): FilterQuery<unknown> {
    if ( scope === "user" ) {
      return {
        "n.audiences": {
          $elemMatch: {
            mode: "User",
            $or: [
              { username },
              { userId: username }, // remove if not used
            ],
          },
        },
      } as FilterQuery<unknown>;
    }

    if ( scope === "role" ) {
      return {
        "n.audiences": {
          $elemMatch: { mode: "Role", roleKey },
        },
      } as FilterQuery<unknown>;
    }

    // company
    return {
      "n.audiences": {
        $elemMatch: { mode: "Company" },
      },
    } as FilterQuery<unknown>;
  }



  private buildPriorityMatch( priorityScope: NotificationPriorityScope ): FilterQuery<unknown> {
    if ( priorityScope === "all" ) {
      return {} as FilterQuery<unknown>;
    }

    const cond: PriorityCond = {
      $or: [
        { "n.severity": { $in: [ "warning", "error" ] } },
        { "n.tags": { $in: [ "priority" ] } },
      ],
    };

    if ( priorityScope === "prioritized" ) {
      return cond as unknown as FilterQuery<unknown>;
    }

    // unprioritized = NOT(prioritized)
    return { $nor: [ cond ] } as unknown as FilterQuery<unknown>;
  }

  private buildInboxProject(): PipelineStage.Project {
    return {
      $project: {
        _id: 0,
        inboxId: { $toString: "$_id" },
        userId: { $toString: "$userId" },
        username: "$username",
        isRead: "$isRead",
        readAt: {
          $cond: [
            { $ifNull: [ "$readAt", false ] },
            { $toString: "$readAt" },
            "$$REMOVE",
          ],
        },
        isDeleted: "$isDeleted",
        notification: {
          id: { $toString: "$n._id" },
          eventKey: "$n.eventKey",
          category: "$n.category",
          severity: "$n.severity",
          title: "$n.title",
          body: "$n.body",
          icon: "$n.icon",
          tags: "$n.tags",
          target: "$n.target",
          actor: "$n.actor",
          audiences: "$n.audiences",
          createdAt: { $toString: "$n.createdAt" },
          expiresAt: {
            $cond: [
              { $ifNull: [ "$n.expiresAt", false ] },
              { $toString: "$expiresAt" },
              "$$REMOVE",
            ],

          },
        },
      },
    };
  }
}
