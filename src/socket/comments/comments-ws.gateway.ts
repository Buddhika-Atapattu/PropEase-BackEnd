// Path: src/socket/comments/comments-ws.gateway.ts
// ============================================================================
// CommentsWsGateway (Socket.IO Gateway) — FIXED (Phase 2 Canonical Target)
// ----------------------------------------------------------------------------
// DESIGN:
// - REST is the source of truth for writes.
// - WS is for:
//    ✅ subscribe/unsubscribe to comment streams
//    ✅ broadcast created/updated/deleted events to watchers
//
// STREAM / ROOM MODEL:
// - base room:    comments::<section>::<refId>
// - subsection:   comments::<section>::<refId>::ss::<subSection>
// - module room:  comments::<section>::<refId>::m::<module>
// - scope room:   comments::<section>::<refId>::sk::<scopeKey>::sv::<scopeValue>
//
// SECURITY:
// - Requires authenticated socket (resolve user from socket.data).
// - Canonical validation using CommentTargetRuntimeRegistry (normalize + validateTargetOrThrow)
// ============================================================================

import type { Socket } from "socket.io";

import type {
    CommentDto,
    CommentTargetDto,
} from "../../types/comment.types";

import { CommentTargetRuntimeRegistry } from "../../api/shared/comments/comment-target-runtime.registry";

import {
    CommentsWsSubscribePayload,
    CommentsWsSubscribedPayload,
    CommentsWsUnsubscribePayload,
    CommentsWsUnsubscribedPayload,
    CommentsWsCreatedPayload,
    CommentsWsUpdatedPayload,
    CommentsWsDeletedPayload,
    CommentsWsPinnedPayload,
    CommentsWsUnpinnedPayload,
} from "./comments-ws.types";

import { COMMENTS_WS_EVENTS } from "./comments-ws.events";

import type { TypedNamespace } from "../socket-types.type";
import type { CommentTargetSource } from "../../source/comments.source";

// ----------------------------------------------------------------------------
// Minimal socket user typing (adapter)
// ----------------------------------------------------------------------------

export interface CommentsWsActor {
    userId: string;
    role: string;

    // Optional: attach your permissions map if you want
    access?: Record<string, unknown>;
}

export interface CommentsWsGatewayOptions {
    /**
     * Required mapping for runtime subsection validation:
     * section -> mongoose model name
     *
     * NOTE: In Phase-2 registry, model lock is internal,
     * but you may still keep this for external RBAC/hard checks.
     */
    sectionToModelName: Record<string, string>;

    /**
     * Hook to resolve a user from socket.
     * Default reads: socket.data.user / socket.data.authUser
     */
    resolveActor?: ( socket: Socket ) => CommentsWsActor | null;

    /**
     * Optional RBAC / access hook (enterprise).
     * Return true to allow subscription.
     */
    canSubscribe?: ( actor: CommentsWsActor, target: CommentTargetDto ) => boolean;

    /**
     * Hard safety limits.
     */
    maxRoomsPerSubscribe?: number;
    maxRoomNameLength?: number;
}

export class CommentsWsGateway {
    private readonly io: TypedNamespace;

    private readonly opts: CommentsWsGatewayOptions;

    private readonly targetRegistry: CommentTargetRuntimeRegistry;

    private readonly resolveActor: ( socket: Socket ) => CommentsWsActor | null;

    private readonly canSubscribe: ( ( actor: CommentsWsActor, target: CommentTargetDto ) => boolean ) | null;

    private readonly maxRoomsPerSubscribe: number;

    private readonly maxRoomNameLength: number;

    /** Allowed characters to prevent garbage / injection in room names. */
    private static readonly ROOM_RE: RegExp = /^[a-zA-Z0-9:_-]{1,256}$/;

    public constructor ( io: TypedNamespace, opts: CommentsWsGatewayOptions ) {
        this.io = io;
        this.opts = opts;

        // ✅ Phase-2 registry (no args)
        this.targetRegistry = new CommentTargetRuntimeRegistry();

        this.resolveActor =
            typeof opts.resolveActor === "function"
                ? opts.resolveActor
                : ( socket: Socket ) => this.defaultResolveActor( socket );

        this.canSubscribe = typeof opts.canSubscribe === "function" ? opts.canSubscribe : null;

        this.maxRoomsPerSubscribe =
            typeof opts.maxRoomsPerSubscribe === "number" && Number.isFinite( opts.maxRoomsPerSubscribe )
                ? Math.max( 1, Math.floor( opts.maxRoomsPerSubscribe ) )
                : 8;

        this.maxRoomNameLength =
            typeof opts.maxRoomNameLength === "number" && Number.isFinite( opts.maxRoomNameLength )
                ? Math.max( 32, Math.floor( opts.maxRoomNameLength ) )
                : 180;
    }

    // ==========================================================================
    // Attach handlers
    // ==========================================================================

    public attach(): void {
        this.io.on( "connection", ( socket: Socket ) => {
            socket.on(
                COMMENTS_WS_EVENTS.SUBSCRIBE,
                async ( payload: CommentsWsSubscribePayload, ack?: ( x: unknown ) => void ) => {
                    try {
                        const out = await this.handleSubscribe( socket, payload );
                        if ( typeof ack === "function" ) ack( { ok: true, data: out } );
                    } catch ( err: unknown ) {
                        if ( typeof ack === "function" ) {
                            ack( { ok: false, message: this.safeErr( err ) } );
                        }
                    }
                },
            );

            socket.on(
                COMMENTS_WS_EVENTS.UNSUBSCRIBE,
                async ( payload: CommentsWsUnsubscribePayload, ack?: ( x: unknown ) => void ) => {
                    try {
                        const out = await this.handleUnsubscribe( socket, payload );
                        if ( typeof ack === "function" ) ack( { ok: true, data: out } );
                    } catch ( err: unknown ) {
                        if ( typeof ack === "function" ) {
                            ack( { ok: false, message: this.safeErr( err ) } );
                        }
                    }
                },
            );
        } );
    }

    // ==========================================================================
    // Subscribe / Unsubscribe
    // ==========================================================================

    private async handleSubscribe(
        socket: Socket,
        payload: CommentsWsSubscribePayload,
    ): Promise<CommentsWsSubscribedPayload> {
        const actor = this.resolveActor( socket );
        if ( !actor ) throw new Error( "Not authenticated." );

        const target = this.assertTarget( payload?.target );

        // Optional RBAC hook
        if ( this.canSubscribe && !this.canSubscribe( actor, target ) ) {
            throw new Error( "Permission denied for this target." );
        }

        // ✅ Canonical runtime validation for focus subsection/module/scope pair
        this.assertValidFocus( target, payload?.focus );

        const rooms = this.buildRooms( target, payload?.focus );

        if ( rooms.length > this.maxRoomsPerSubscribe ) {
            throw new Error( `Too many rooms requested. Max is ${ this.maxRoomsPerSubscribe }.` );
        }

        for ( const r of rooms ) {
            await socket.join( r );
        }

        const msg: CommentsWsSubscribedPayload = { target, rooms };

        socket.emit( COMMENTS_WS_EVENTS.SUBSCRIBED, msg );

        return msg;
    }

    private async handleUnsubscribe(
        socket: Socket,
        payload: CommentsWsUnsubscribePayload,
    ): Promise<CommentsWsUnsubscribedPayload> {
        const actor = this.resolveActor( socket );
        if ( !actor ) throw new Error( "Not authenticated." );

        const target = this.assertTarget( payload?.target );

        // ✅ Canonical runtime validation for focus subsection/module/scope pair
        this.assertValidFocus( target, payload?.focus );

        const rooms = this.buildRooms( target, payload?.focus );

        for ( const r of rooms ) {
            await socket.leave( r );
        }

        const msg: CommentsWsUnsubscribedPayload = { target, rooms };

        socket.emit( COMMENTS_WS_EVENTS.UNSUBSCRIBED, msg );

        return msg;
    }

    // ==========================================================================
    // Broadcast API (called by REST/controller after writes)
    // ==========================================================================

    public broadcastCreated( target: CommentTargetDto, comment: CommentDto ): void {
        const safeTarget = this.assertTarget( target );
        const rooms = this.buildRooms( safeTarget );

        const payload: CommentsWsCreatedPayload = { target: safeTarget, comment };

        for ( const r of rooms ) {
            this.io.to( r ).emit( COMMENTS_WS_EVENTS.CREATED, payload );
        }
    }

    public broadcastUpdated( params: {
        target: CommentTargetDto;
        id: string;
        patch?: Record<string, unknown>;
        updatedComment?: CommentDto;
    } ): void {
        const safeTarget = this.assertTarget( params.target );
        const id = String( params.id ?? "" ).trim();
        if ( !id ) return;

        const rooms = this.buildRooms( safeTarget );

        const payload: CommentsWsUpdatedPayload = {
            target: safeTarget,
            id,
            ...( params.patch ? { patch: params.patch } : {} ),
            ...( params.updatedComment ? { updatedComment: params.updatedComment } : {} ),
        };

        for ( const r of rooms ) {
            this.io.to( r ).emit( COMMENTS_WS_EVENTS.UPDATED, payload );
        }
    }

    public broadcastDeleted( target: CommentTargetDto, id: string ): void {
        const safeTarget = this.assertTarget( target );
        const safeId = String( id ?? "" ).trim();
        if ( !safeId ) return;

        const rooms = this.buildRooms( safeTarget );

        const payload: CommentsWsDeletedPayload = { target: safeTarget, id: safeId };

        for ( const r of rooms ) {
            this.io.to( r ).emit( COMMENTS_WS_EVENTS.DELETED, payload );
        }
    }


    public broadcastPinned( params: {
        target: CommentTargetDto;
        id: string;
        pinnedAtIso: string;
        pinnedByUserId: string;
    } ): void {
        const safeTarget = this.assertTarget( params.target );
        const id = String( params.id ?? "" ).trim();
        if ( !id ) return;

        const pinnedAtIso = String( params.pinnedAtIso ?? "" ).trim();
        const pinnedByUserId = String( params.pinnedByUserId ?? "" ).trim();
        if ( !pinnedAtIso || !pinnedByUserId ) return;

        const rooms = this.buildRooms( safeTarget );

        const payload: CommentsWsPinnedPayload = {
            target: safeTarget,
            id,
            pinnedAtIso,
            pinnedByUserId,
        };

        for ( const r of rooms ) {
            this.io.to( r ).emit( COMMENTS_WS_EVENTS.PINNED, payload );
        }
    }

    public broadcastUnpinned( target: CommentTargetDto, id: string ): void {
        const safeTarget = this.assertTarget( target );
        const safeId = String( id ?? "" ).trim();
        if ( !safeId ) return;

        const rooms = this.buildRooms( safeTarget );

        const payload: CommentsWsUnpinnedPayload = { target: safeTarget, id: safeId };

        for ( const r of rooms ) {
            this.io.to( r ).emit( COMMENTS_WS_EVENTS.UNPINNED, payload );
        }
    }

    // ==========================================================================
    // Internals
    // ==========================================================================

    private defaultResolveActor( socket: Socket ): CommentsWsActor | null {
        const s = socket as unknown as {
            data?: {
                user?: unknown;
                authUser?: unknown;
            };
        };

        const raw = ( s?.data?.user ?? s?.data?.authUser ) as unknown;
        if ( !raw || typeof raw !== "object" ) return null;

        const u = raw as Record<string, unknown>;

        const userId = String( u[ "userId" ] ?? u[ "_id" ] ?? u[ "id" ] ?? "" ).trim();
        const role = String( u[ "role" ] ?? "" ).trim();

        if ( !userId || !role ) return null;

        const out: CommentsWsActor = { userId, role };

        const access = u[ "access" ];
        if ( access && typeof access === "object" ) {
            out.access = access as Record<string, unknown>;
        }

        return out;
    }

    /**
     * ✅ Canonical target assert:
     * - Applies legacy normalization (WorkItems/Events -> Teams + subSection)
     * - Ensures required fields exist
     * - Returns DTO without undefined optionals
     */
    private assertTarget( target: CommentTargetDto | null | undefined ): CommentTargetDto {
        if ( !target ) throw new Error( "target is required." );

        const sectionRaw = String( ( target as unknown as { section?: unknown; } ).section ?? "" ).trim();
        const refIdRaw = String( ( target as unknown as { refId?: unknown; } ).refId ?? "" ).trim();

        if ( !sectionRaw ) throw new Error( "target.section is required." );
        if ( !refIdRaw ) throw new Error( "target.refId is required." );

        const subRaw =
            typeof ( target as unknown as { subSection?: unknown; } ).subSection === "string"
                ? String( ( target as unknown as { subSection?: unknown; } ).subSection ?? "" ).trim()
                : undefined;

        const module =
            typeof ( target as unknown as { module?: unknown; } ).module === "string"
                ? String( ( target as unknown as { module?: unknown; } ).module ?? "" ).trim()
                : "";

        const modelName =
            typeof ( target as unknown as { modelName?: unknown; } ).modelName === "string"
                ? String( ( target as unknown as { modelName?: unknown; } ).modelName ?? "" ).trim()
                : "";

        const scopeRaw = ( target as unknown as { scope?: unknown; } ).scope;
        const scope =
            scopeRaw && typeof scopeRaw === "object" ? ( scopeRaw as Record<string, unknown> ) : null;

        // ✅ Normalize + validate (this also resolves authoritative source)
        const normalized = this.targetRegistry.normalizeSectionAndSubSection( sectionRaw, subRaw );

        const validated = this.targetRegistry.validateTargetOrThrow( {
            section: normalized.section,
            subSection: normalized.subSection,
            refId: refIdRaw,
        } );

        // ✅ modelName override check must compare against resolved source
        if ( modelName ) {
            this.targetRegistry.resolveModelNameOrThrow( validated.source, modelName );
        }

        // ✅ Build DTO without undefined optionals (exactOptionalPropertyTypes safe)
        const out: Record<string, unknown> = {
            section: validated.section,
            refId: validated.refId,
            scope,
        };

        if ( validated.subSection ) out[ "subSection" ] = validated.subSection;
        if ( module ) out[ "module" ] = module;
        if ( modelName ) out[ "modelName" ] = modelName;

        return out as CommentTargetDto;
    }


    /**
     * Validates focus fields for correctness.
     * - If focus.subSection is provided, it must be valid for (section/subSection rule-set)
     * - If scopeKey/value used, they must be provided together.
     */
    private assertValidFocus(
        target: CommentTargetDto,
        focus?: { subSection?: string; module?: string; scopeKey?: string; scopeValue?: string; },
    ): void {
        if ( !focus ) return;

        const focusSub = typeof focus.subSection === "string" ? focus.subSection.trim() : "";
        const focusScopeKey = typeof focus.scopeKey === "string" ? focus.scopeKey.trim() : "";
        const focusScopeValue = typeof focus.scopeValue === "string" ? focus.scopeValue.trim() : "";

        // scope pair must be complete
        if ( ( focusScopeKey && !focusScopeValue ) || ( !focusScopeKey && focusScopeValue ) ) {
            throw new Error( "focus.scopeKey and focus.scopeValue must be provided together." );
        }

        // subSection: focus overrides, must validate if present
        if ( focusSub ) {
            const section = String( ( target as unknown as { section?: unknown; } ).section ?? "" ).trim();
            const refId = String( ( target as unknown as { refId?: unknown; } ).refId ?? "" ).trim();

            // apply legacy normalization again (safe)
            const normalized = this.targetRegistry.normalizeSectionAndSubSection( section, focusSub );

            this.targetRegistry.validateTargetOrThrow( {
                section: normalized.section,
                subSection: normalized.subSection,
                refId,
            } );
        }
    }

    private buildRooms(
        target: CommentTargetDto,
        focus?: { subSection?: string; module?: string; scopeKey?: string; scopeValue?: string; },
    ): string[] {
        const sectionRaw = String( ( target as unknown as { section?: unknown; } ).section ?? "" ).trim();
        const refId = String( ( target as unknown as { refId?: unknown; } ).refId ?? "" ).trim();

        // base always exists
        const base = this.sanitizeRoom( `comments::${ sectionRaw }::${ refId }` );
        const rooms: string[] = [ base ];

        // subSection (effective: focus overrides target)
        const subFromTarget =
            typeof ( target as unknown as { subSection?: unknown; } ).subSection === "string"
                ? String( ( target as unknown as { subSection?: unknown; } ).subSection ?? "" ).trim()
                : "";

        const subFromFocus = focus && typeof focus.subSection === "string" ? focus.subSection.trim() : "";
        const effectiveSub = subFromFocus || subFromTarget;

        if ( effectiveSub ) {
            rooms.push( this.sanitizeRoom( `comments::${ sectionRaw }::${ refId }::ss::${ effectiveSub }` ) );
        }

        // module (effective: focus overrides target.module)
        const modFromTarget =
            typeof ( target as unknown as { module?: unknown; } ).module === "string"
                ? String( ( target as unknown as { module?: unknown; } ).module ?? "" ).trim()
                : "";

        const modFromFocus = focus && typeof focus.module === "string" ? focus.module.trim() : "";
        const mod = modFromFocus || modFromTarget;

        if ( mod ) {
            rooms.push( this.sanitizeRoom( `comments::${ sectionRaw }::${ refId }::m::${ mod }` ) );
        }

        // scopeKey/scopeValue (ONLY when pair complete)
        const scopeKey = focus && typeof focus.scopeKey === "string" ? focus.scopeKey.trim() : "";
        const scopeValue = focus && typeof focus.scopeValue === "string" ? focus.scopeValue.trim() : "";
        if ( scopeKey && scopeValue ) {
            rooms.push( this.sanitizeRoom( `comments::${ sectionRaw }::${ refId }::sk::${ scopeKey }::sv::${ scopeValue }` ) );
        }

        // uniqueness
        return Array.from( new Set( rooms ) );
    }

    private sanitizeRoom( room: string ): string {
        const safe = String( room ?? "" ).trim();
        if ( !safe ) throw new Error( "Invalid room name." );

        const trimmed = safe.length > this.maxRoomNameLength ? safe.slice( 0, this.maxRoomNameLength ) : safe;

        const normalized = trimmed.replace( /[^a-zA-Z0-9:_-]/g, "_" );

        if ( !CommentsWsGateway.ROOM_RE.test( normalized ) ) {
            throw new Error( "Unsafe room name detected." );
        }

        return normalized;
    }

    private safeErr( err: unknown ): string {
        const msg = err instanceof Error ? err.message : String( err );
        return msg || "Unknown error";
    }
}
