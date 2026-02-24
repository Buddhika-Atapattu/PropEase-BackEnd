// Path: src/controllers/notifications/notification-hub.controller.ts
// =============================================================================
// Notification Hub Controller (REST + WS bridge) — 100% CLASS-BASED
// -----------------------------------------------------------------------------
// GOAL (your rule):
// - REST = batch state (load, search, pagination, count, filters)
// - WS  = single delta communications (notify:new / patch / count / bulk)
//
// IMPORTANT (your project rules):
// - Constructor MUST NOT accept parameters
// - Use ApiResponseBuilder.ok / ApiResponseBuilder.error only
// - exactOptionalPropertyTypes-safe: NEVER set optional props to undefined
// - Logs prefixed and end with '\n'
// =============================================================================

import { Router, type RequestHandler } from "express";

import { ApiGuardExport } from "../../guard/api-router.guard";
import { ApiResponseBuilder } from "../../utils/api-combiner.builder";

import type {
  NotificationCountResponse,
  NotificationLoadFilters,
  NotificationLoadRequest,
  NotificationLoadResponse,
} from "../../types/notification/notification.types";

import type {
  NotificationPriorityScope,
  NotificationScope,
} from "../../socket/events/notifications/notification.rpc.events";

import { NotificationRestService } from "../../services/notifications/notification.rest.service";
import { NotificationSocketService } from "../../services/notifications/notification.socket.service";
import type { Role } from "../../types/roles";

type ScopeCounts = {
  total: number;
  unread: number;
  prioritized: number;
  unprioritized: number;
};

type InboxScopeLoadBody = {
  scope?: NotificationScope;
  priorityScope?: NotificationPriorityScope;
  request?: Partial<NotificationLoadRequest>;
};

type InboxScopeCountBody = {
  filters?: NotificationLoadFilters;
};

export default class NotificationHubController {
  public readonly router: Router;

  private readonly rest: NotificationRestService;
  private readonly socket: NotificationSocketService;

  public constructor () {
    this.router = Router();

    this.rest = new NotificationRestService();
    this.socket = new NotificationSocketService();

    // Queries (batch)
    this.router.post( "/inbox/load", this.loadInbox );
    this.router.post( "/inbox/count", this.countInbox );

    // ✅ NEW: scope-based queries (user | role | company + priorityScope)
    this.router.post( "/inbox/scope/load", this.loadInboxByScope );
    this.router.post( "/inbox/scope/count", this.countInboxByScope );

    // Mutations (single actions)
    this.router.post( "/inbox/:inboxId/read", this.markRead );
    this.router.post( "/inbox/read-all", this.markAllRead );
    this.router.post( "/inbox/:inboxId/archive", this.archiveOne );
  }

  // =============================================================================
  // A) Queries (basic)
  // =============================================================================

  /**
   * POST /api-notification/inbox/load
   * Body: NotificationLoadRequest
   */
  private readonly loadInbox: RequestHandler = async ( req, res ): Promise<void> => {
    try {
      const auth = await ApiGuardExport.GetAuthUser( req );
      const username = this.safeUsername( auth?.username );

      const body = this.asObject( req.body ) as Partial<NotificationLoadRequest>;
      const request = this.safeLoadRequest( {
        ...body,
        // ✅ force boundary to auth user (never trust body.username)
        username,
      } );

      const data: NotificationLoadResponse = await this.rest.loadInbox( {
        username,
        request,
      } );

      ApiResponseBuilder.ok(
        res,
        "notifications",
        data.items,
        "[notifications:loadInbox] Loaded",
        { pagination: { total: data.other.total } }
      );
      return;
    } catch ( err: unknown ) {
      // eslint-disable-next-line no-console
      console.error(
        `[Error:] [NotificationHubController] loadInbox failed: ${ err instanceof Error ? err.message : "Unknown error"
        }\n`
      );
      ApiResponseBuilder.error( res, 500, err instanceof Error ? err.message : "Failed to load inbox" );
      return;
    }
  };

  /**
   * POST /api-notification/inbox/count
   * Body: { filters: NotificationLoadFilters }
   */
  private readonly countInbox: RequestHandler = async ( req, res ): Promise<void> => {
    try {
      const auth = await ApiGuardExport.GetAuthUser( req );
      const username = this.safeUsername( auth?.username );

      const body = this.asObject( req.body ) as { filters?: unknown; };
      const filters = this.safeFilters( this.asObject( body.filters ) as NotificationLoadFilters );

      const counts: NotificationCountResponse = await this.rest.countInbox( {
        username,
        filters,
      } );

      ApiResponseBuilder.ok(
        res,
        "other",
        { unread: counts.unread },
        "[notifications:countInbox] Counted",
        { pagination: { total: counts.total } }
      );
      return;
    } catch ( err: unknown ) {
      // eslint-disable-next-line no-console
      console.error(
        `[Error:] [NotificationHubController] countInbox failed: ${ err instanceof Error ? err.message : "Unknown error"
        }\n`
      );
      ApiResponseBuilder.error( res, 500, err instanceof Error ? err.message : "Failed to count inbox" );
      return;
    }
  };

  // =============================================================================
  // A2) Queries (NEW: scope-based)
  // =============================================================================

  /**
   * POST /api-notification/inbox/scope/load
   *
   * Body:
   * {
   *   scope: "user" | "role" | "company",
   *   priorityScope?: "all" | "prioritized" | "unprioritized",
   *   request: { page, limit, filters }
   * }
   *
   * Notes:
   * - username is ALWAYS forced from auth
   * - roleKey is ALWAYS forced from auth.role
   */
  private readonly loadInboxByScope: RequestHandler = async ( req, res ): Promise<void> => {
    try {
      const auth = await ApiGuardExport.GetAuthUser( req );
      const username = this.safeUsername( auth?.username );
      const roleKey = this.safeRole( auth?.role );

      const body = this.asObject( req.body ) as InboxScopeLoadBody;

      const scope = this.safeScope( body.scope );
      const priorityScope = this.safePriorityScope( body.priorityScope );

      const reqBody = this.asObject( body.request ) as Partial<NotificationLoadRequest>;

      const request = this.safeLoadRequest( {
        ...reqBody,
        username, // ✅ boundary
      } );

      // ✅ relies on your REST service method that bridges into query.loadInboxForUserByScope(...)
      const data = await this.rest.loadInboxByScope( {
        username,
        roleKey,
        scope,
        priorityScope,
        request,
      } );

      ApiResponseBuilder.ok(
        res,
        "notifications",
        data.items,
        "[notifications:loadInboxByScope] Loaded",
        {
          pagination: { total: data.other.total },
          other: {
            unread: data.other.unread,
            prioritized: data.other.prioritized,
            unprioritized: data.other.unprioritized,
            scope,
            priorityScope,
          },
        }
      );
      return;
    } catch ( err: unknown ) {
      // eslint-disable-next-line no-console
      console.error(
        `[Error:] [NotificationHubController] loadInboxByScope failed: ${ err instanceof Error ? err.message : "Unknown error"
        }\n`
      );
      ApiResponseBuilder.error(
        res,
        500,
        err instanceof Error ? err.message : "Failed to load inbox (scope)"
      );
      return;
    }
  };

  /**
   * POST /api-notification/inbox/scope/count
   *
   * Body:
   * {
   *   filters?: NotificationLoadFilters
   * }
   *
   * Returns:
   * { total, unread, prioritized, unprioritized }
   *
   * Notes:
   * - username + roleKey forced from auth
   * - filters sanitized (exactOptionalPropertyTypes-safe)
   */
  private readonly countInboxByScope: RequestHandler = async ( req, res ): Promise<void> => {
    try {
      const auth = await ApiGuardExport.GetAuthUser( req );
      const username = this.safeUsername( auth?.username );
      const roleKey = this.safeRole( auth?.role );

      const body = this.asObject( req.body ) as InboxScopeCountBody;
      const filters = this.safeFilters( this.asObject( body.filters ) as NotificationLoadFilters );

      // ✅ relies on your REST service method that bridges into query.countInboxForUserWithScopes(...)
      const counts: ScopeCounts = await this.rest.countScopes( {
        username,
        roleKey,
        filters,
      } );

      ApiResponseBuilder.ok(
        res,
        "other",
        {
          total: counts.total,
          unread: counts.unread,
          prioritized: counts.prioritized,
          unprioritized: counts.unprioritized,
        },
        "[notifications:countInboxByScope] Counted",
        {
          pagination: {
            total: counts.total,
          }
        }
      );
      return;
    } catch ( err: unknown ) {
      // eslint-disable-next-line no-console
      console.error(
        `[Error:] [NotificationHubController] countInboxByScope failed: ${ err instanceof Error ? err.message : "Unknown error"
        }\n`
      );
      ApiResponseBuilder.error(
        res,
        500,
        err instanceof Error ? err.message : "Failed to count inbox (scope)"
      );
      return;
    }
  };

  // =============================================================================
  // B) Mutations (single operations + WS deltas)
  // =============================================================================

  /**
   * POST /api-notification/inbox/:inboxId/read
   */
  private readonly markRead: RequestHandler = async ( req, res ): Promise<void> => {
    try {
      const auth = await ApiGuardExport.GetAuthUser( req );
      const username = this.safeUsername( auth?.username );

      const inboxId = this.safeId( req.params?.inboxId, "inboxId" );

      const result = await this.rest.markRead( { username, inboxId } );

      // WS: safest UX is bulk refresh + count push
      this.socket.emitBulkToUser( username, { reason: "bulk-update" } );

      const counts = await this.rest.countInbox( { username, filters: {} } );
      this.socket.emitCountToUser( username, { total: counts.total, unread: counts.unread } );

      ApiResponseBuilder.ok(
        res,
        "other",
        { changed: result.changed, inboxId, unread: counts.unread },
        "[notifications:markRead] Updated",
        { pagination: { total: counts.total } }
      );
      return;
    } catch ( err: unknown ) {
      // eslint-disable-next-line no-console
      console.error(
        `[Error:] [NotificationHubController] markRead failed: ${ err instanceof Error ? err.message : "Unknown error"
        }\n`
      );
      ApiResponseBuilder.error( res, 500, err instanceof Error ? err.message : "Failed to mark read" );
      return;
    }
  };

  /**
   * POST /api-notification/inbox/read-all
   */
  private readonly markAllRead: RequestHandler = async ( req, res ): Promise<void> => {
    try {
      const auth = await ApiGuardExport.GetAuthUser( req );
      const username = this.safeUsername( auth?.username );

      const result = await this.rest.markAllRead( { username } );

      this.socket.emitBulkToUser( username, { reason: "bulk-update" } );

      const counts = await this.rest.countInbox( { username, filters: {} } );
      this.socket.emitCountToUser( username, { total: counts.total, unread: counts.unread } );

      ApiResponseBuilder.ok(
        res,
        "other",
        { changedCount: result.changedCount, unread: counts.unread },
        "[notifications:markAllRead] Updated",
        { pagination: { total: counts.total } }
      );
      return;
    } catch ( err: unknown ) {
      // eslint-disable-next-line no-console
      console.error(
        `[Error:] [NotificationHubController] markAllRead failed: ${ err instanceof Error ? err.message : "Unknown error"
        }\n`
      );
      ApiResponseBuilder.error( res, 500, err instanceof Error ? err.message : "Failed to mark all read" );
      return;
    }
  };

  /**
   * POST /api-notification/inbox/:inboxId/archive
   */
  private readonly archiveOne: RequestHandler = async ( req, res ): Promise<void> => {
    try {
      const auth = await ApiGuardExport.GetAuthUser( req );
      const username = this.safeUsername( auth?.username );

      const inboxId = this.safeId( req.params?.inboxId, "inboxId" );

      const result = await this.rest.archiveOne( { username, inboxId } );

      this.socket.emitBulkToUser( username, { reason: "bulk-update" } );

      const counts = await this.rest.countInbox( { username, filters: {} } );
      this.socket.emitCountToUser( username, { total: counts.total, unread: counts.unread } );

      ApiResponseBuilder.ok(
        res,
        "other",
        { changed: result.changed, inboxId, unread: counts.unread },
        "[notifications:archiveOne] Updated",
        { pagination: { total: counts.total } }
      );
      return;
    } catch ( err: unknown ) {
      // eslint-disable-next-line no-console
      console.error(
        `[Error:] [NotificationHubController] archiveOne failed: ${ err instanceof Error ? err.message : "Unknown error"
        }\n`
      );
      ApiResponseBuilder.error( res, 500, err instanceof Error ? err.message : "Failed to archive" );
      return;
    }
  };

  // =============================================================================
  // C) Sanitizers (exactOptionalPropertyTypes-safe)
  // =============================================================================

  private asObject( v: unknown ): Record<string, unknown> {
    if ( v && typeof v === "object" ) return v as Record<string, unknown>;
    return {};
  }

  private safeUsername( v: unknown ): string {
    const u = typeof v === "string" ? v.trim() : "";
    if ( !u ) throw new Error( "NotificationHubController: auth username is required." );
    return u;
  }

  private safeRole( v: unknown ): Role {
    // Keep it permissive; your Role union is project-defined.
    // If Role is a strict union, swap to an allow-list check.
    return ( typeof v === "string" && v.trim() ? v.trim() : "user" ) as Role;
  }

  private safeId( v: unknown, label: string ): string {
    const s = typeof v === "string" ? v.trim() : "";
    if ( !s ) throw new Error( `NotificationHubController: ${ label } is required.` );
    return s;
  }

  private safeLoadRequest( body: Partial<NotificationLoadRequest> ): NotificationLoadRequest {
    const page = this.safePage( body.page );
    const limit = this.safeLimit( body.limit );
    const username = this.safeUsername( body.username );

    // filters is required in your backend contract -> default to {}
    const filters = this.safeFilters( this.asObject( body.filters ) as NotificationLoadFilters );

    return { username, filters, page, limit };
  }

  private safeFilters( filters: NotificationLoadFilters ): NotificationLoadFilters {
    const out: NotificationLoadFilters = {};

    // ✅ IMPORTANT for exactOptionalPropertyTypes:
    // Only assign when value is truly present (not undefined).
    if ( filters.category !== undefined ) out.category = filters.category;
    if ( filters.severity !== undefined ) out.severity = filters.severity;
    if ( filters.mode !== undefined ) out.mode = filters.mode;

    const search = this.safeString( filters.search );
    if ( search ) out.search = search;

    const from = this.safeIso( filters.from );
    if ( from ) out.from = from;

    const to = this.safeIso( filters.to );
    if ( to ) out.to = to;

    if ( typeof filters.unreadOnly === "boolean" ) out.unreadOnly = filters.unreadOnly;
    if ( typeof filters.includeDeleted === "boolean" ) out.includeDeleted = filters.includeDeleted;
    if ( typeof filters.includeArchived === "boolean" ) out.includeArchived = filters.includeArchived;

    return out;
  }

  private safeScope( v: unknown ): NotificationScope {
    if ( v === "user" || v === "role" || v === "company" ) return v;
    return "user";
  }

  private safePriorityScope( v: unknown ): NotificationPriorityScope {
    if ( v === "all" || v === "prioritized" || v === "unprioritized" ) return v;
    return "all";
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

  private safePage( v: unknown ): number {
    const n = typeof v === "number" ? v : Number( v );
    if ( !Number.isFinite( n ) || n < 1 ) return 1;
    return Math.floor( n );
  }

  private safeLimit( v: unknown ): number {
    const n = typeof v === "number" ? v : Number( v );
    if ( !Number.isFinite( n ) || n < 1 ) return 10;
    return Math.min( Math.floor( n ), 100 );
  }
}