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

import { Router, type RequestHandler, Request } from "express";

import { ApiGuardExport } from "../../guard/api-router.guard";
import { ApiResponseBuilder } from "../../utils/api-combiner.builder";

import type {
  NotificationCountResponse,
  NotificationLoadFilters,
  NotificationLoadRequest,
  NotificationLoadResponse,
  NotificationInboxItemDto,
  NotificationCoreDto,
  NotificationTitleBodyPatch,
} from "../../types/notification/notification.types";

import type {
  NotificationPriorityScope,
  NotificationScope,
} from "../../socket/events/notifications/notification.rpc.events";

import { NotificationRestService } from "../../services/notifications/notification.rest.service";
import { NotificationSocketService } from "../../services/notifications/notification.socket.service";
import type { Role } from "../../types/roles";
import { WsEmitterProvider } from "../../socket/ws-emitter.provider";
import type { AuthUser, AuthUserNormalized } from "../../types/common";
import { Types } from "mongoose";
import { NotificationHubEngineService } from "../../services/notifications/notification-hub-engine.service";

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
  scope?: NotificationScope;
  priorityScope?: NotificationPriorityScope;
  request?: Partial<NotificationLoadRequest>;
  filters?: NotificationLoadFilters;
};

export default class NotificationHubController {
  public readonly router: Router;

  private readonly rest: NotificationRestService;
  private readonly socket: NotificationSocketService;
  private readonly hubService: NotificationHubEngineService;

  private static readonly HARD_MAX_LIMIT: number = 500;

  public constructor () {
    this.router = Router();

    this.rest = new NotificationRestService();
    this.socket = new NotificationSocketService( WsEmitterProvider.Get() );
    this.hubService = new NotificationHubEngineService();

    // CRUD Operations
    this.router.post( "/create", this.create );
    this.router.patch( "/update/:notificationId", this.update );
    this.router.delete( "/delete/:notificationId", this.delete );

    // Queries (batch)
    this.router.post( "/inbox/load", this.loadInbox );
    this.router.post( "/inbox/count", this.countInbox );

    // Scope-based queries (user | role | company + priorityScope)
    this.router.post( "/inbox/scope/load", this.loadInboxByScope );
    this.router.post( "/inbox/scope/count", this.countInboxByScope );

    // Mutations (single actions)
    this.router.post( "/inbox/:inboxId/read", this.markRead );
    this.router.post( "/inbox/read-all", this.markAllRead );
    this.router.post( "/inbox/:inboxId/archive", this.archiveOne );
  }

  // =============================================================================
  // Notification CRUD operations
  // =============================================================================
  //
  // NOTE (your rule applied)
  // - Controller validates request shape + auth
  // - Service (Hub Engine) sanitizes and enforces catalog/enum rules again
  // - Update: ONLY title + body (your latest decision)
  // - Delete: hard delete (master + inbox rows) then WS notify:delete
  // =============================================================================

  // =============================================================================
  // Create notification from external
  // =============================================================================

  /**
   * 
   * @param req Express.Request
   * @param res Express.Responsex
   * @returns void
   * 
   * @body {
   * "notification": {
   *    "id": "client-temp-or-empty",
   *    "eventKey": "notification:created",
   *    "category": "System",
   *    "severity": "info",
   *    "title": "Hello",
   *    "body": "Message",
   *    "audiences": [{ "mode": "Company" }],
   *    "createdAt": "2026-02-27T00:00:00.000Z"
   *  }
   * }
   */
  private readonly create: RequestHandler = async ( req, res ): Promise<void> => {
    try {
      const auth: AuthUser | null = await this.getAuthor( req );
      const normalisedAuthor: AuthUserNormalized | null = await this.getNormalisedAuthor( req );

      if ( !auth || !normalisedAuthor ) {
        ApiResponseBuilder.validationError( res, "Auth user required!" );
        return;
      }

      const body = req.body as Record<string, unknown>;
      const notificationData = body[ "notification" ];

      if ( !notificationData || typeof notificationData !== "object" || Array.isArray( notificationData ) ) {
        ApiResponseBuilder.validationError(
          res,
          "Notification body cannot be empty and it should form as follow -> notification:{...body}"
        );
        return;
      }

      // ✅ Clone to prevent mutating req.body reference
      const safeIncoming = { ...( notificationData as Record<string, unknown> ) };

      // ✅ Never trust inbound actor; enforce from auth
      safeIncoming[ "actor" ] = normalisedAuthor;

      const delivered = await this.hubService.create( safeIncoming as unknown as NotificationCoreDto );

      if ( !delivered || !delivered.notification ) {
        ApiResponseBuilder.fail( res, "Failed to create notification!" );
        return;
      }

      ApiResponseBuilder.ok(
        res,
        "notification",
        delivered.notification,
        "Notification created successful!",
        {
          other: { delivered },
        }
      );
      return;
    } catch ( err: unknown ) {
      console.error(
        `[Error:] [NotificationHubController] create failed: ${ err instanceof Error ? err.message : "Unknown error"
        }\n`
      );
      ApiResponseBuilder.error( res, 500, err instanceof Error ? err.message : "Failed to create notification" );
      return;
    }
  };

  // =============================================================================
  // Update notification from external
  // =============================================================================
  private readonly update: RequestHandler = async ( req, res ): Promise<void> => {
    try {
      const auth: AuthUser | null = await this.getAuthor( req );

      if ( !auth ) {
        ApiResponseBuilder.validationError( res, "Auth user required!" );
        return;
      }

      const notificationId = this.safeParamString( req.params?.[ "notificationId" ], "notificationId" );
      if ( !notificationId ) {
        ApiResponseBuilder.validationError( res, "notificationId is required!" );
        return;
      }

      const body = req.body as Record<string, unknown>;
      const patchRaw = body[ "patch" ];

      if ( !patchRaw || typeof patchRaw !== "object" || Array.isArray( patchRaw ) ) {
        ApiResponseBuilder.validationError(
          res,
          "Update body must form as follow -> patch:{ title?: string, body?: string }"
        );
        return;
      }

      const patch = this.extractTitleBodyPatch( patchRaw );

      if ( !patch ) {
        ApiResponseBuilder.validationError( res, "Nothing to update. Provide patch.title and/or patch.body" );
        return;
      }

      // IMPORTANT: RBAC/ownership boundary
      // - If you want: only admins OR the original actor.userId can update
      // - Since your NotificationCoreDto actor is stored in master doc,
      //   enforce in service (preferred) OR add a service method validateOwnership.
      // For now: call service updateTitleBody (service should enforce policy if required).
      const updated = await this.hubService.updateTitleBody( notificationId, patch );

      if ( !updated ) {
        ApiResponseBuilder.fail( res, "Failed to update notification!" );
        return;
      }

      ApiResponseBuilder.ok(
        res,
        "notification",
        updated,
        "Notification updated successful!",
        { other: { notificationId } }
      );
      return;
    } catch ( err: unknown ) {
      console.error(
        `[Error:] [NotificationHubController] update failed: ${ err instanceof Error ? err.message : "Unknown error"
        }\n`
      );
      ApiResponseBuilder.error( res, 500, err instanceof Error ? err.message : "Failed to update notification" );
      return;
    }
  };

  // =============================================================================
  // Delete notification from external
  // =============================================================================
  private readonly delete: RequestHandler = async ( req, res ): Promise<void> => {
    try {
      const auth: AuthUser | null = await this.getAuthor( req );

      if ( !auth ) {
        ApiResponseBuilder.validationError( res, "Auth user required!" );
        return;
      }

      const notificationId = this.safeParamString( req.params?.[ "notificationId" ], "notificationId" );
      if ( !notificationId ) {
        ApiResponseBuilder.validationError( res, "notificationId is required!" );
        return;
      }

      // Same policy note as update:
      // - Only admin or original actor can delete.
      const deleted = await this.hubService.delete( notificationId );

      if ( !deleted ) {
        ApiResponseBuilder.fail( res, "Failed to delete notification!" );
        return;
      }

      ApiResponseBuilder.ok(
        res,
        "other",
        { deleted },
        "Notification deleted successful!",
      );
      return;
    } catch ( err: unknown ) {
      console.error(
        `[Error:] [NotificationHubController] delete failed: ${ err instanceof Error ? err.message : "Unknown error"
        }\n`
      );
      ApiResponseBuilder.error( res, 500, err instanceof Error ? err.message : "Failed to delete notification" );
      return;
    }
  };

  // =============================================================================
  // A) Queries (basic)
  // =============================================================================

  /**
   * POST /api-notification/inbox/load
   * Body: NotificationLoadRequest (username ignored; forced from auth)
   */
  private readonly loadInbox: RequestHandler = async ( req, res ): Promise<void> => {
    try {
      const auth = await this.getAuthor( req );

      if ( !auth ) {
        ApiResponseBuilder.validationError( res, 'Auth user required!' );
        return;
      }
      const userId = this.safeUserId( auth?.userId );
      const username = this.safeUsername( auth?.username );

      const body = this.asObject( req.body ) as Partial<NotificationLoadRequest>;
      const request = this.safeLoadRequest( {
        ...body,
        // keep only for backward tolerance if FE sends it
        username,
      } );

      const data: NotificationLoadResponse = await this.rest.loadInbox( {
        userId,
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
   * Body: { filters?: NotificationLoadFilters }
   */
  private readonly countInbox: RequestHandler = async ( req, res ): Promise<void> => {
    try {
      const auth = await this.getAuthor( req );
      if ( !auth ) {
        ApiResponseBuilder.validationError( res, 'Auth user required!' );
        return;
      }
      const userId = this.safeUserId( auth?.userId );

      const username = this.safeUsername( auth?.username );

      const body = this.asObject( req.body ) as { filters?: unknown; };
      const filters = this.safeFilters( this.asObject( body.filters ) as NotificationLoadFilters );


      const counts: NotificationCountResponse = await this.rest.countInbox( {
        userId,
        username,
        filters,
      } );

      ApiResponseBuilder.ok(
        res,
        "other",
        { counts },
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
  // A2) Queries (scope-based)
  // =============================================================================

  /**
   * POST /api-notification/inbox/scope/load
   *
   * Body:
   * {
   *   scope?: "user" | "role" | "company",
   *   priorityScope?: "all" | "prioritized" | "unprioritized",
   *   request?: { page, limit, filters }
   * }
   *
   * Notes:
   * - username is ALWAYS forced from auth
   * - roleKey is ALWAYS forced from auth.role
   */
  private readonly loadInboxByScope: RequestHandler = async ( req, res ): Promise<void> => {
    try {

      const auth = await this.getAuthor( req );

      if ( !auth ) {
        ApiResponseBuilder.validationError( res, 'Auth user required!' );
        return;
      }

      const userId = this.safeUserId( auth?.userId );
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

      const data = await this.rest.loadInboxByScope( {
        userId,
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
   *   scope?: "user" | "role" | "company",
   *   priorityScope?: "all" | "prioritized" | "unprioritized",
   *   filters?: NotificationLoadFilters,
   *   request?: { page, limit }   // optional; ignored for count but tolerated
   * }
   *
   * IMPORTANT FIX
   * - Your current REST service exposes countScopes(username, roleKey, filters)
   *   BUT that method is not scope-aware.
   *
   * Controller Strategy (no extra service method required)
   * - Call `loadInboxByScope()` with limit=1 and read the `other.*` counts.
   * - This keeps scope+priority semantics consistent with the scope load pipeline.
   */
  private readonly countInboxByScope: RequestHandler = async ( req, res ): Promise<void> => {
    try {
      const auth = await this.getAuthor( req );
      if ( !auth ) {
        ApiResponseBuilder.validationError( res, 'Auth user required!' );
        return;
      }
      const userId = this.safeUserId( auth?.userId );
      const username = this.safeUsername( auth?.username );
      const roleKey = this.safeRole( auth?.role );

      const body = this.asObject( req.body ) as InboxScopeCountBody;

      const scope = this.safeScope( body.scope );
      const priorityScope = this.safePriorityScope( body.priorityScope );

      const filters = this.safeFilters( this.asObject( body.filters ) as NotificationLoadFilters );

      // build a “minimal request” purely to reuse the SAME scope-count semantics
      const request: NotificationLoadRequest = {
        username,  // keep for backward tolerance; scope tab needs username anyway
        page: 1,
        limit: 0,
        filters,
      };

      const data = await this.rest.loadInboxByScope( {
        userId,
        username,
        roleKey,
        scope,
        priorityScope,
        request,
      } );

      const counts: ScopeCounts = {
        total: data.other.total,
        unread: data.other.unread,
        prioritized: data.other.prioritized,
        unprioritized: data.other.unprioritized,
      };

      ApiResponseBuilder.ok(
        res,
        "other",
        counts,
        "[notifications:countInboxByScope] Counted",
        { pagination: { total: counts.total } }
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
      const auth = await this.getAuthor( req );
      if ( !auth ) {
        ApiResponseBuilder.validationError( res, 'Auth user required!' );
        return;
      }
      const userId = this.safeUserId( auth?.userId );
      const username = this.safeUsername( auth?.username );

      const inboxId = this.safeId( req.params?.inboxId, "inboxId" );

      const result = await this.rest.markRead( { userId, username, inboxId } );

      // WS: safest UX is “bulk changed” + count update
      // NOTE: these methods must exist on your NotificationSocketService.
      this.socket.emitBulkToUser( username, { reason: "bulk-update" } );

      const counts = await this.rest.countInbox( { userId, username, filters: {} } );
      this.socket.emitCountToUser( username, {
        total: counts.total,
        unread: counts.unread,
        prioritized: counts.prioritized,
        unprioritized: counts.unprioritized
      } );

      ApiResponseBuilder.ok(
        res,
        "other",
        { changed: result.changed, inboxId, counts },
        "[notifications:markRead] Updated",
        { pagination: { total: counts.total } }
      );
      return;
    } catch ( err: unknown ) {
      // eslint-disable-next-line no-console
      console.error( `[Error:] [NotificationHubController] markRead failed: ${ err instanceof Error ? err.message : "Unknown error" } \n` );
      ApiResponseBuilder.error( res, 500, err instanceof Error ? err.message : "Failed to mark read" );
      return;
    }
  };

  /**
   * POST /api-notification/inbox/read-all
   */
  private readonly markAllRead: RequestHandler = async ( req, res ): Promise<void> => {
    try {
      const auth = await this.getAuthor( req );
      if ( !auth ) {
        ApiResponseBuilder.validationError( res, 'Auth user required!' );
        return;
      }
      const userId = this.safeUserId( auth?.userId );
      const username = this.safeUsername( auth?.username );

      const result = await this.rest.markAllRead( { userId, username } );

      this.socket.emitBulkToUser( username, { reason: "bulk-update" } );

      const counts = await this.rest.countInbox( { userId, username, filters: {} } );
      this.socket.emitCountToUser( username, {
        total: counts.total,
        unread: counts.unread,
        prioritized: counts.prioritized,
        unprioritized: counts.unprioritized
      } );

      ApiResponseBuilder.ok(
        res,
        "other",
        { changedCount: result.changedCount, counts },
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
      const auth = await this.getAuthor( req );
      if ( !auth ) {
        ApiResponseBuilder.validationError( res, 'Auth user required!' );
        return;
      }
      const userId = this.safeUserId( auth?.userId );
      const username = this.safeUsername( auth?.username );

      const inboxId = this.safeId( req.params?.inboxId, "inboxId" );

      const result = await this.rest.archiveOne( { userId, username, inboxId } );

      this.socket.emitBulkToUser( username, { reason: "bulk-update" } );

      const counts = await this.rest.countInbox( { userId, username, filters: {} } );
      this.socket.emitCountToUser( username, {
        total: counts.total,
        unread: counts.unread,
        prioritized: counts.prioritized,
        unprioritized: counts.unprioritized
      } );

      ApiResponseBuilder.ok(
        res,
        "other",
        { changed: result.changed, inboxId, counts },
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

  /**
   * Normalize auth userId into a non-empty string.
   *
   * Accepts:
   * - string
   * - Mongo ObjectId instance
   *
   * Rejects:
   * - null
   * - undefined
   * - empty string
   */
  private safeUserId( v: unknown ): string {
    // Case 1: Already string
    if ( typeof v === "string" ) {
      const s = v.trim();
      if ( !s ) {
        throw new Error( "NotificationHubController: auth userId is required." );
      }
      return s;
    }

    // Case 2: ObjectId-like (has toString())
    if ( v && typeof v === "object" ) {
      const maybe = v as { toString?: () => string; };

      if ( typeof maybe.toString === "function" ) {
        const s = maybe.toString().trim();

        if ( !s ) {
          throw new Error( "NotificationHubController: auth userId is required." );
        }

        return s;
      }
    }

    throw new Error( "NotificationHubController: auth userId is required." );
  }

  private safeRole( v: unknown ): Role {
    const s = typeof v === "string" ? v.trim() : "";
    // If your Role union is strict, replace with allow-list validation.
    return ( s || "user" ) as Role;
  }

  private safeId( v: unknown, label: string ): string {
    const s = typeof v === "string" ? v.trim() : "";
    if ( !s ) throw new Error( `NotificationHubController: ${ label } is required.` );
    return s;
  }

  private safeLoadRequest( body: Partial<NotificationLoadRequest> ): NotificationLoadRequest {
    const page = this.safePage( body.page ) ?? 1;
    const limit = this.safeLimit( body.limit ) ?? 0;
    const username = this.safeUsername( body.username );

    // filters is required in your backend contract -> default to {}
    const filters = this.safeFilters( this.asObject( body.filters ) as NotificationLoadFilters );

    return { username, filters, page, limit };
  }

  private safeFilters( filters: NotificationLoadFilters ): NotificationLoadFilters {
    const out: NotificationLoadFilters = {};

    // exactOptionalPropertyTypes-safe: assign ONLY when actually present
    if ( filters && filters.category !== undefined ) out.category = filters.category;
    if ( filters && filters.severity !== undefined ) out.severity = filters.severity;
    if ( filters && filters.mode !== undefined ) out.mode = filters.mode;

    const search = this.safeString( filters?.search );
    if ( search ) out.search = search;

    const from = this.safeIso( filters?.from );
    if ( from ) out.from = from;

    const to = this.safeIso( filters?.to );
    if ( to ) out.to = to;

    if ( typeof filters?.unreadOnly === "boolean" ) out.unreadOnly = filters.unreadOnly;
    if ( typeof filters?.includeDeleted === "boolean" ) out.includeDeleted = filters.includeDeleted;
    if ( typeof filters?.includeArchived === "boolean" ) out.includeArchived = filters.includeArchived;

    return out;
  }

  private async getAuthor( req: Request ): Promise<AuthUser | null> {
    return await ApiGuardExport.GetAuthUser( req );
  }

  private async getNormalisedAuthor( req: Request ): Promise<AuthUserNormalized | null> {
    return await ApiGuardExport.GetNormalisedAuthUser( req );
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

  private safeLimit( limit: unknown ): number {
    const n = typeof limit === 'number' ? limit : 0;
    // const n = Number(limit);

    // ✅ "load all" contract:
    // - limit = 0 or -1 means "load all", but we still protect with HARD_MAX_LIMIT.
    if ( Number.isFinite( n ) && ( n === 0 || n === -1 ) ) {
      return NotificationHubController.HARD_MAX_LIMIT;
    }

    // normal paging behavior
    if ( !Number.isFinite( n ) || n < 1 ) return 100;

    // keep your existing safety ceiling, but align with hard max
    return Math.min( Math.floor( n ), NotificationHubController.HARD_MAX_LIMIT );
  }

  // =============================================================================
  // Controller-only utilities (class-based, no any)
  // =============================================================================

  /**
   * Extract a strict title/body patch from unknown payload.
   *
   * @param raw
   * - Expected: object containing optional title/body
   * - Returns: null if no usable fields exist
   */
  private extractTitleBodyPatch( raw: unknown ): NotificationTitleBodyPatch | null {
    const obj = raw && typeof raw === "object" && !Array.isArray( raw ) ? ( raw as Record<string, unknown> ) : null;
    if ( !obj ) return null;

    const out: NotificationTitleBodyPatch = {};

    const title = typeof obj[ "title" ] === "string" ? obj[ "title" ].trim() : "";
    const body = typeof obj[ "body" ] === "string" ? obj[ "body" ].trim() : "";

    // NOTE: controller only checks presence; service sanitizes length/control chars.
    if ( title ) out.title = title;
    if ( body ) out.body = body;

    return Object.keys( out ).length > 0 ? out : null;
  }

  /**
   * Safe param string extractor.
   *
   * @param v - unknown param
   * @param label - field name for logs/errors
   */
  private safeParamString( v: unknown, label: string ): string {
    const s = typeof v === "string" ? v.trim() : "";
    if ( !s ) {
      console.error( `[Warning:] [NotificationHubController] Missing param: ${ label }\n` );
      return "";
    }
    return s;
  }
} 