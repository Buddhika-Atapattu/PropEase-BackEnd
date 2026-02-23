// Path: src/services/notifications/notification.rest.service.ts
// =============================================================================
// Notification Hub — REST Service (Controller-facing Command + Query Facade)
// -----------------------------------------------------------------------------
// PURPOSE:
// - Controller-friendly façade for Notification Hub
// - Owns all HTTP-input sanitization + mapping into engine/query calls
// - Keeps controllers thin (ApiResponseBuilder stays in controller)
// - exactOptionalPropertyTypes-safe: omit optionals, never pass undefined
//
// DESIGN:
// - READ operations -> NotificationQueryService
// - MUTATIONS -> NotificationHubEngineService (your hub already contains markRead/markAllRead/archiveOne)
// - NO constructor parameters (your rule)
//
// IMPORTANT:
// - 100% class-based
// - TypeScript-strict, no `any`
// =============================================================================

import type { ClientSession } from "mongoose";

import type {
    NotificationLoadFilters,
    NotificationLoadRequest,
    NotificationLoadResponse,
    NotificationCountResponse,
    NotificationEmitInput,
} from "../../types/notification/notification.types";

import { NotificationQueryService } from "./notification.query.service";
import { NotificationHubEngineService, type EmitResult } from "./notification-hub-engine.service";

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
        // ✅ NO constructor params (your rule)
        this.query = new NotificationQueryService();
        this.hub = new NotificationHubEngineService();
    }

    /* ===========================================================================
     * 1) Query operations (read-only)
     * ======================================================================== */

    public async loadInbox( input: NotificationInboxLoadHttpInput ): Promise<NotificationLoadResponse> {
        const username = this.safeUsername( input.username );
        const req = this.safeLoadRequest( input.request );

        // Query service is read-only and optimized for inbox list
        return this.query.loadInboxForUser( username, req, input.session );
    }

    public async countInbox( input: NotificationInboxCountHttpInput ): Promise<NotificationCountResponse> {
        const username = this.safeUsername( input.username );
        const filters = this.safeFilters( input.filters );

        return this.query.countInboxForUser( username, filters, input.session );
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
     * Uses hub.markRead(username, inboxId, session?)
     */
    public async markRead( input: NotificationMarkReadHttpInput ): Promise<{ changed: boolean; }> {
        const username = this.safeUsername( input.username );
        const inboxId = this.safeId( input.inboxId, "inboxId" );

        const changed = await this.hub.markRead( username, inboxId, input.session );
        return { changed };
    }

    /**
     * Mark ALL inbox rows read.
     * Uses hub.markAllRead(username, session?)
     */
    public async markAllRead( input: NotificationMarkAllReadHttpInput ): Promise<{ changedCount: number; }> {
        const username = this.safeUsername( input.username );

        const changedCount = await this.hub.markAllRead( username, input.session );
        return { changedCount };
    }

    /**
     * Archive ONE inbox row.
     * Uses hub.archiveOne(username, inboxId, session?)
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

    private safeUsername( v: string ): string {
        const u = typeof v === "string" ? v.trim() : "";
        if ( !u ) {
            throw new Error( "NotificationRestService: username is required." );
        }
        return u;
    }

    private safeId( v: unknown, label: string ): string {
        const s = typeof v === "string" ? v.trim() : "";
        if ( !s ) {
            throw new Error( `NotificationRestService: ${ label } is required.` );
        }
        return s;
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

    private safeLoadRequest( req: NotificationLoadRequest ): NotificationLoadRequest {
        const page = this.safePage( req.page );
        const limit = this.safeLimit( req.limit );
        const username = this.safeUsername( req.username );

        // ✅ NotificationLoadRequest.filters is REQUIRED by your contract
        const filters = req.filters ? this.safeFilters( req.filters ) : this.safeFilters( {} );

        // ✅ Correct property name: "filters"
        return { username, filters, page, limit };
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
}
