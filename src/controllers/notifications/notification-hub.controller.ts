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
// - Use `res.status(...).json(...); return;` style via ApiResponseBuilder
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

import { NotificationRestService } from "../../services/notifications/notification.rest.service";
import { NotificationSocketService } from "../../services/notifications/notification.socket.service";

export default class NotificationHubController {
  public readonly router: Router;

  private readonly rest: NotificationRestService;
  private readonly socket: NotificationSocketService;

  public constructor () {
    // ✅ no constructor params (your rule)
    this.router = Router();

    this.rest = new NotificationRestService();
    this.socket = new NotificationSocketService();

    // Queries (batch)
    this.router.post( "/inbox/load", this.loadInbox );
    this.router.post( "/inbox/count", this.countInbox );

    // Mutations (single actions)
    this.router.post( "/inbox/:inboxId/read", this.markRead );
    this.router.post( "/inbox/read-all", this.markAllRead );
    this.router.post( "/inbox/:inboxId/archive", this.archiveOne );
  }

  // =============================================================================
  // A) Queries
  // =============================================================================

  /**
   * POST /api-notification/inbox/load
   * Body: NotificationLoadRequest
   */
  private readonly loadInbox: RequestHandler = async ( req, res ): Promise<void> => {
    try {
      const auth = await ApiGuardExport.GetAuthUser( req );
      const username = this.safeUsername( auth?.username );

      const body = ( req.body ?? {} ) as Partial<NotificationLoadRequest>;
      const request = this.safeLoadRequest( body );

      const data: NotificationLoadResponse = await this.rest.loadInbox( {
        username,
        request,
      } );

      ApiResponseBuilder.ok( res, "notifications", data.items, "[notifications:loadInbox] Loaded", { pagination: { total: data.other.total } } );
      return;
    } catch ( err: unknown ) {
      // eslint-disable-next-line no-console
      console.error(
        `[Error:] [NotificationHubController] loadInbox failed: ${ err instanceof Error ? err.message : "Unknown error"
        }\n`
      );
      ApiResponseBuilder.error(
        res,
        500,
        err instanceof Error ? err.message : "Failed to load inbox"
      );
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

      const filters = this.safeFilters( ( ( req.body as any )?.filters ?? {} ) as NotificationLoadFilters );

      const counts: NotificationCountResponse = await this.rest.countInbox( {
        username,
        filters,
      } );

      ApiResponseBuilder.ok( res, "other", { unread: counts.unread }, "[notifications:countInbox] Counted", { pagination: { total: counts.total } } );
      return;
    } catch ( err: unknown ) {
      // eslint-disable-next-line no-console
      console.error(
        `[Error:] [NotificationHubController] countInbox failed: ${ err instanceof Error ? err.message : "Unknown error"
        }\n`
      );
      ApiResponseBuilder.error(
        res,
        500,
        err instanceof Error ? err.message : "Failed to count inbox"
      );
      return;
    }
  };

  // =============================================================================
  // B) Mutations (single operations + WS deltas)
  // =============================================================================

  /**
   * POST /api-notification/inbox/:inboxId/read
   * - Marks one row read
   * - Emits:
   *   - notify:bulk (reason bulk-update) so UI can refresh current page safely
   *   - notify:count with latest totals
   *
   * NOTE:
   * We intentionally avoid notify:patch here because your WS patch payload
   * needs notificationId + state, and the minimal hub method returns only changed:boolean.
   * If you want PATCH later, we can extend hub/query to return notificationId + new state.
   */
  private readonly markRead: RequestHandler = async ( req, res ): Promise<void> => {
    try {
      const auth = await ApiGuardExport.GetAuthUser( req );
      const username = this.safeUsername( auth?.username );

      const inboxId = this.safeId( req.params?.inboxId, "inboxId" );

      const result = await this.rest.markRead( { username, inboxId } );

      // WS: tell the dialog to reload (single delta communication)
      this.socket.emitBulkToUser( username, { reason: "bulk-update" } );

      // WS: update count badge in real time
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
      ApiResponseBuilder.error(
        res,
        500,
        err instanceof Error ? err.message : "Failed to mark read"
      );
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

      // WS: safest UX is bulk refresh + count push
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
      ApiResponseBuilder.error(
        res,
        500,
        err instanceof Error ? err.message : "Failed to mark all read"
      );
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

      // WS: bulk refresh (archiving changes list composition)
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
      ApiResponseBuilder.error(
        res,
        500,
        err instanceof Error ? err.message : "Failed to archive"
      );
      return;
    }
  };

  // =============================================================================
  // C) Sanitizers (exactOptionalPropertyTypes-safe)
  // =============================================================================

  private safeUsername( v: unknown ): string {
    const u = typeof v === "string" ? v.trim() : "";
    if ( !u ) {
      throw new Error( "NotificationHubController: auth username is required." );
    }
    return u;
  }

  private safeId( v: unknown, label: string ): string {
    const s = typeof v === "string" ? v.trim() : "";
    if ( !s ) {
      throw new Error( `NotificationHubController: ${ label } is required.` );
    }
    return s;
  }

  private safeLoadRequest( body: Partial<NotificationLoadRequest> ): NotificationLoadRequest {
    const page = this.safePage( body.page );
    const limit = this.safeLimit( body.limit );
    const username = this.safeUsername( body.username );

    // filters is required in contract — default to {}
    const filters = this.safeFilters( ( body.filters ?? {} ) as NotificationLoadFilters );

    return { username, filters, page, limit };
  }

  private safeFilters( filters: NotificationLoadFilters ): NotificationLoadFilters {
    const out: NotificationLoadFilters = {};

    if ( filters.category ) out.category = filters.category;
    if ( filters.severity ) out.severity = filters.severity;
    if ( filters.mode ) out.mode = filters.mode;

    const search = this.safeString( filters.search );
    if ( search ) out.search = search;

    const from = this.safeIso( filters.from );
    if ( from ) out.from = from;

    const to = this.safeIso( filters.to );
    if ( to ) out.to = to;

    if ( typeof filters.unreadOnly === "boolean" ) out.unreadOnly = filters.unreadOnly;
    if ( typeof filters.includeDeleted === "boolean" ) out.includeDeleted = filters.includeDeleted;

    return out;
  }

  private safeString( v: unknown ): string {
    if ( typeof v === "string" ) return v.trim();
    if ( typeof v === "number" ) return String( v );
    return "";
  }

  private safeIso( v: unknown ): string {
    const s = this.safeString( v );
    if ( !s ) return "";
    // minimal ISO guard (same style you used)
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
