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

/* =============================================================================
 * B) Query Service (class-based)
 * ========================================================================== */

export class NotificationQueryService {
  public constructor() {}

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

    const u = this.safeUsername(username);

    const page = this.safePage(req.page);
    const limit = this.safeLimit(req.limit);
    const skip = (page - 1) * limit;

    const filters: NotificationLoadFilters = req.filters ?? {};

    const stateMatch = this.buildStateMatch(u, filters);
    const notifMatch = this.buildNotificationMatch(filters);

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
      {
        $project: {
          _id: 0,

          // inbox row id
          inboxId: { $toString: "$_id" },

          // user identity (DTO requires string id)
          userId: { $toString: "$userId" },
          username: "$username",

          // state
          isRead: "$isRead",

          // readAt -> string (optional)
          readAt: { $toString: "$readAt" },

          // ✅ correct semantic: deleted refers to isDeleted
          isDeleted: "$isDeleted",

          // master notification core
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

            // ✅ correct: array audiences
            audiences: "$n.audiences",

            // dates -> string
            createdAt: { $toString: "$n.createdAt" },
            expiresAt: { $toString: "$n.expiresAt" },
          },
        },
      },
    ];

    const rows = await this.aggregateWithSession<AggRowInbox>(pipeline, session);

    // Convert aggregation rows to strict DTO
    const items = rows.map((r) => this.mapAggRowToInboxItem(r));

    // Load total count using same filters
    const total = await this.countInboxTotalForUser(u, filters, session);

    return { items, other: { total } };
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

    const u = this.safeUsername(username);

    // TOTAL count respects current filter set
    const total = await this.countInboxTotalForUser(u, { ...filters }, session);

    // UNREAD: enforce unread semantics
    const unreadFilters: NotificationLoadFilters = {
      ...filters,
      unreadOnly: true,
      includeDeleted: false,
      includeArchived: false,
    };

    const unread = await this.countInboxTotalForUser(u, unreadFilters, session);

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
    const stateMatch = this.buildStateMatch(username, filters);
    const notifMatch = this.buildNotificationMatch(filters);

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

    const agg = await this.aggregateWithSession<CountAggRow>(pipeline, session);

    const first = agg[0];
    if (!first) return 0;

    return Number(first.c);
  }

  /* =============================================================================
   * D) Builders: state match + notification match
   * ========================================================================== */

  private buildStateMatch(username: string, filters: NotificationLoadFilters): FilterQuery<unknown> {
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

    if (!filters.includeDeleted) {
      match.isDeleted = false;
    }

    if (!filters.includeArchived) {
      match.isArchived = false;
    }

    if (filters.unreadOnly) {
      match.isRead = false;
      match.isDeleted = false;
      match.isArchived = false;
    }

    return match as FilterQuery<unknown>;
  }

  private buildNotificationMatch(filters: NotificationLoadFilters): FilterQuery<unknown> {
    /**
     * WHY this method exists
     * - notifications collection holds the master message.
     * - After $unwind "$n", the master doc is under "n.*".
     */

    const match: Record<string, unknown> = {};

    if (filters.category) match["n.category"] = filters.category;
    if (filters.severity) match["n.severity"] = filters.severity;

    // Audience mode filter for admin/tools
    // NOTE: audiences is array, so use "n.audiences.mode"
    if (filters.mode) {
      match["n.audiences.mode"] = filters.mode;
    }

    // Search across relevant master fields
    const search = this.safeString(filters.search);
    if (search) {
      const rx = this.escapeRegex(search);
      match["$or"] = [
        { "n.title": { $regex: rx, $options: "i" } },
        { "n.body": { $regex: rx, $options: "i" } },
        { "n.eventKey": { $regex: rx, $options: "i" } },
        { "n.category": { $regex: rx, $options: "i" } },
        { "n.severity": { $regex: rx, $options: "i" } },
      ];
    }

    // Date range filtering (ISO string)
    const from = this.safeIso(filters.from);
    const to = this.safeIso(filters.to);

    if (from || to) {
      const range: Record<string, string> = {};
      if (from) range["$gte"] = from;
      if (to) range["$lte"] = to;
      match["n.createdAt"] = range;
    }

    return match as FilterQuery<unknown>;
  }

  /* =============================================================================
   * E) Mapping: aggregation row -> DTO (final guard)
   * ========================================================================== */

  private mapAggRowToInboxItem(r: AggRowInbox): NotificationInboxItemDto {
    /**
     * WHY this method exists
     * - Even if aggregation projects a DTO-like shape,
     *   we keep one final mapping step to:
     *     - enforce exactOptionalPropertyTypes safe output
     *     - trim strings
     *     - avoid accidental undefined injection
     */

    const inboxId = String(r.inboxId);

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

    if (r.readAt) {
      const iso = this.toIsoMaybe(r.readAt);
      if (iso) {
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
    const agg = UserNotificationModel.aggregate<T>(pipeline);

    if (session) {
      agg.session(session);
    }

    const rows = await agg.exec();
    return Array.isArray(rows) ? rows : [];
  }

  /* =============================================================================
   * G) Safety helpers (class-based)
   * ========================================================================== */

  private safeUsername(v: string): string {
    const u = typeof v === "string" ? v.trim() : "";
    if (!u) {
      throw new Error("NotificationQueryService: username is required.");
    }
    return u;
  }

  private safeString(v: unknown): string {
    if (typeof v === "string") return v.trim();
    if (typeof v === "number") return String(v);
    return "";
  }

  private safeIso(v: unknown): string {
    const s = this.safeString(v);
    if (!s) return "";
    if (!/^\d{4}-\d{2}-\d{2}T/.test(s)) return "";
    return s;
  }

  private escapeRegex(input: string): string {
    return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  private safePage(page: number): number {
    const p = Number(page);
    if (!Number.isFinite(p) || p < 1) return 1;
    return Math.floor(p);
  }

  private safeLimit(limit: number): number {
    const n = Number(limit);
    if (!Number.isFinite(n) || n < 1) return 10;
    return Math.min(Math.floor(n), 100);
  }

  private toIsoMaybe(v: unknown): string {
    if (typeof v === "string") return v;
    if (v instanceof Date) return v.toISOString();
    return "";
  }
}
