// Path: src/services/notifications/notification.rest.service.ts
// =============================================================================
// Notification Hub — REST Service (Controller-facing Command + Query Facade)
// =============================================================================

import type { ClientSession } from "mongoose";

import type {
    NotificationLoadFilters,
    NotificationLoadRequest,
    NotificationLoadResponse,
    NotificationCountResponse,
    NotificationEmitInput,
    NotificationInboxItemDto,
} from "../../types/notification/notification.types";

import {
    NOTIFICATION_CATEGORY_VALUES,
    NOTIFICATION_SEVERITY_VALUES,
    NOTIFICATION_AUDIENCE_MODE_VALUES,
} from "../../types/notification/notification.types";

import type { Role } from "../../types/roles";

import { NotificationQueryService } from "./notification.query.service";
import { NotificationHubEngineService, type EmitResult } from "./notification-hub-engine.service";

import type {
    NotificationScope,
    NotificationPriorityScope,
} from "../../socket/events/notifications/notification.rpc.events";

/* =============================================================================
 * A) REST payload shapes (controller -> service)
 * ========================================================================== */

export interface NotificationInboxLoadHttpInput {
    username: string;
    request: NotificationLoadRequest;
    session?: ClientSession;
}

export interface NotificationInboxCountHttpInput {
    username: string;
    filters: NotificationLoadFilters;
    session?: ClientSession;
}

export interface NotificationScopeLoadHttpInput {
    username: string;
    roleKey: Role;
    scope: NotificationScope;
    priorityScope?: NotificationPriorityScope;
    request: NotificationLoadRequest;
    session?: ClientSession;
}

export interface NotificationScopeCountHttpInput {
    username: string;
    roleKey: Role;
    filters?: NotificationLoadFilters;
    session?: ClientSession;
}

export interface NotificationEmitHttpInput {
    input: NotificationEmitInput;
    session?: ClientSession;
}

export interface NotificationMarkReadHttpInput {
    username: string;
    inboxId: string;
    session?: ClientSession;
}

export interface NotificationMarkAllReadHttpInput {
    username: string;
    session?: ClientSession;
}

export interface NotificationArchiveOneHttpInput {
    username: string;
    inboxId: string;
    session?: ClientSession;
}

/* =============================================================================
 * B) REST Service (class-based façade)
 * ========================================================================== */

export class NotificationRestService {
    private readonly query: NotificationQueryService;
    private readonly hub: NotificationHubEngineService;

    public constructor () {
      this.query = new NotificationQueryService();
      this.hub = new NotificationHubEngineService();
  }

    /* ===========================================================================
     * 1) Query operations (read-only)
     * ======================================================================== */
 
    /**
     * Load inbox list for the current user (default view).
     *
     * @param input.username
     * - Expected: logged-in username
     *
     * @param input.request
     * - Expected: NotificationLoadRequest (page/limit/filters)
     *
     * @param input.session
     * - Optional mongoose ClientSession (transaction context)
     */
    public async loadInbox( input: NotificationInboxLoadHttpInput ): Promise<NotificationLoadResponse> {
        const username = this.safeUsername( input.username );
        const req = this.safeLoadRequest( { ...input.request, username } );

      return this.query.loadInboxForUser( username, req, input.session );
  }

    /**
     * Count inbox totals for current user (total + unread).
     *
     * @param input.username
     * - Expected: logged-in username
     *
     * @param input.filters
     * - Expected: NotificationLoadFilters
     */
    public async countInbox( input: NotificationInboxCountHttpInput ): Promise<NotificationCountResponse> {
        const username = this.safeUsername( input.username );
        const filters = this.safeFilters( input.filters );

        return this.query.countInboxForUser( username, filters, input.session );
    }

    /**
     * Load inbox by scope (user / role / company) and priorityScope.
     * This is the REST backup of the WS RPC LIST_GET.
     *
     * @param input.username
     * - Expected: logged-in username
     *
     * @param input.roleKey
     * - Expected: current role (Role union)
     *
     * @param input.scope
     * - Expected: "user" | "role" | "company"
     *
     * @param input.priorityScope
     * - Optional: "all" | "prioritized" | "unprioritized"
     *
     * @param input.request
     * - Expected: NotificationLoadRequest (page/limit/filters)
     */
    public async loadInboxByScope( input: NotificationScopeLoadHttpInput ): Promise<{
        items: NotificationInboxItemDto[];
        other: { total: number; unread: number; prioritized: number; unprioritized: number; };
    }> {
        const username = this.safeUsername( input.username );
        const roleKey = this.safeRole( input.roleKey );

        const scope = this.safeScope( input.scope );
        const priorityScope = this.safePriorityScope( input.priorityScope );

        const req: NotificationLoadRequest = {
            username,
            page: this.safePage( input.request?.page ),
            limit: this.safeLimit( input.request?.limit ),
            filters: this.safeFilters( input.request?.filters ),
        };

        return this.query.loadInboxForUserByScope(
            username,
            roleKey,
            scope,
            priorityScope,
            req
        );
    }

    /**
     * Count scope totals (total/unread/prioritized/unprioritized).
     * REST backup of WS COUNT_GET.
     *
     * @param input.username - current user
     * @param input.roleKey  - current role
     * @param input.filters  - optional filters for future extension
     */
    public async countScopes( input: NotificationScopeCountHttpInput ): Promise<{
        total: number;
        unread: number;
        prioritized: number;
        unprioritized: number;
    }> {
        const username = this.safeUsername( input.username );
        const roleKey = this.safeRole( input.roleKey );
        const filters = this.safeFilters( input.filters );

        return this.query.countInboxForUserWithScopes( username, roleKey, filters );
    }

    /* ===========================================================================
     * 2) Command operations (mutations via hub engine)
     * ======================================================================== */

    public async emit( input: NotificationEmitHttpInput ): Promise<EmitResult> {
        if ( !input || !input.input ) {
            throw new Error( "NotificationRestService.emit: input is required." );
        }
      return this.hub.emit( input.input, input.session );
  }

  /**
   * Mark ONE inbox row read.
   *
   * @param input.username - inbox owner username
   * @param input.inboxId  - inbox row id (string)
   */
    public async markRead( input: NotificationMarkReadHttpInput ): Promise<{ changed: boolean; }> {
        const username = this.safeUsername( input.username );
        const inboxId = this.safeId( input.inboxId, "inboxId" );

      const changed = await this.hub.markRead( username, inboxId, input.session );
      return { changed };
  }

  /**
   * Mark ALL inbox rows read.
   *
   * @param input.username - inbox owner username
   */
    public async markAllRead( input: NotificationMarkAllReadHttpInput ): Promise<{ changedCount: number; }> {
        const username = this.safeUsername( input.username );

      const changedCount = await this.hub.markAllRead( username, input.session );
      return { changedCount };
  }

  /**
   * Archive ONE inbox row.
   *
   * @param input.username - inbox owner username
   * @param input.inboxId  - inbox row id (string)
   */
    public async archiveOne( input: NotificationArchiveOneHttpInput ): Promise<{ changed: boolean; }> {
        const username = this.safeUsername( input.username );
        const inboxId = this.safeId( input.inboxId, "inboxId" );

      const changed = await this.hub.archiveOne( username, inboxId, input.session );
      return { changed };
  }

    /* =============================================================================
     * C) Sanitizers (exactOptionalPropertyTypes-safe)
     * ========================================================================== */

    private safeUsername( v: unknown ): string {
        const u = typeof v === "string" ? v.trim() : "";
      if ( !u ) throw new Error( "NotificationRestService: username is required." );
      return u;
  }

    private safeRole( v: unknown ): Role {
        const s = typeof v === "string" ? v.trim() : "";
      if ( !s ) throw new Error( "NotificationRestService: role is required." );
      return s as Role;
  }

    private safeId( v: unknown, label: string ): string {
        const s = typeof v === "string" ? v.trim() : "";
        if ( !s ) throw new Error( `NotificationRestService: ${ label } is required.` );
      return s;
  }

    private safeScope( v: unknown ): NotificationScope {
        if ( v === "user" || v === "role" || v === "company" ) return v;
        throw new Error( "NotificationRestService: invalid scope." );
    }

    private safePriorityScope( v: unknown ): NotificationPriorityScope {
        if ( v === "prioritized" || v === "unprioritized" || v === "all" ) return v;
        return "all";
    }

    private safeLoadRequest( req: NotificationLoadRequest ): NotificationLoadRequest {
        const username = this.safeUsername( req?.username );
        const page = this.safePage( req?.page );
        const limit = this.safeLimit( req?.limit );

      // filters is required by your contract; if missing, use empty object
      const filters = this.safeFilters( req?.filters );

      return { username, filters, page, limit };
  }

    private safeFilters( filters: unknown ): NotificationLoadFilters {
        const raw = filters && typeof filters === "object" ? ( filters as Record<string, unknown> ) : {};
        const out: NotificationLoadFilters = {};

      // category
      if ( this.isNonEmptyString( raw[ "category" ] ) ) {
          const cat = this.asEnumLiteral( raw[ "category" ], NOTIFICATION_CATEGORY_VALUES );
          if ( cat ) out.category = cat;
      }

      // severity
      if ( this.isNonEmptyString( raw[ "severity" ] ) ) {
          const sev = this.asEnumLiteral( raw[ "severity" ], NOTIFICATION_SEVERITY_VALUES );
          if ( sev ) out.severity = sev;
      }

      // mode
      if ( this.isNonEmptyString( raw[ "mode" ] ) ) {
          const mode = this.asEnumLiteral( raw[ "mode" ], NOTIFICATION_AUDIENCE_MODE_VALUES );
          if ( mode ) out.mode = mode;
    }

      // search
      if ( this.isNonEmptyString( raw[ "search" ] ) ) out.search = raw[ "search" ].trim();

      // from/to (best-effort ISO strings)
      if ( this.isNonEmptyString( raw[ "from" ] ) ) out.from = raw[ "from" ].trim();
      if ( this.isNonEmptyString( raw[ "to" ] ) ) out.to = raw[ "to" ].trim();

      // booleans
      if ( typeof raw[ "unreadOnly" ] === "boolean" ) out.unreadOnly = raw[ "unreadOnly" ];
      if ( typeof raw[ "includeDeleted" ] === "boolean" ) out.includeDeleted = raw[ "includeDeleted" ];
      if ( typeof raw[ "includeArchived" ] === "boolean" ) out.includeArchived = raw[ "includeArchived" ];

      return out;
  }

    private safePage( v: unknown ): number {
        const n = Number( v );
        if ( !Number.isFinite( n ) || n < 1 ) return 1;
        return Math.floor( n );
    }

    private safeLimit( v: unknown ): number {
        const n = Number( v );
        if ( !Number.isFinite( n ) || n < 1 ) return 10;
        return Math.min( Math.floor( n ), 100 );
    }

    private asEnumLiteral<T extends string>( value: string, allowed: readonly T[] ): T | null {
        const v = value.trim() as T;
        return allowed.includes( v ) ? v : null;
    }

    private isNonEmptyString( v: unknown ): v is string {
        return typeof v === "string" && v.trim().length > 0;
    }
}