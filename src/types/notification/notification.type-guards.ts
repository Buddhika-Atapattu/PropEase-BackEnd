// Path: src/types/notification/notification.type-guards.ts
// =============================================================================
// Notification Hub — Runtime Type Guards (Static Class)
// -----------------------------------------------------------------------------
// PURPOSE
// - Runtime validation for Notification Hub DTO contracts (NO mongoose types).
// - Works in backend + frontend.
// - Provides type guards: isX(v): v is X
//
// IMPORTANT
// - This is NOT a schema validator; it's a lightweight guard layer.
// - It is designed to protect WS payloads + REST bodies at runtime.
// =============================================================================

import type {
    NotificationSeverity,
    NotificationCategory,
    NotificationLoadFilters,
    NotificationAudience,
    NotificationActorDto,
    NotificationTarget,
    NotificationDeliveryDrivers,
    NotificationEmitInput,
    NotificationCoreDto,
    NotificationUserStateDto,
    NotificationInboxItemDto,
    NotificationLoadRequest,
    NotificationLoadResponse,
    NotificationCountResponse,
} from "./notification.types";

import {
    NOTIFICATION_CATEGORY_VALUES,
    NOTIFICATION_SEVERITY_VALUES,
    NOTIFICATION_AUDIENCE_MODE_VALUES,
} from "./notification.types";

export class NotificationTypeGuards {
    private constructor () {}

    /* =============================================================================
     * A) Tiny primitives
     * ========================================================================== */

    public static isRecord( v: unknown ): v is Record<string, unknown> {
        return !!v && typeof v === "object" && !Array.isArray( v );
    }

    public static isNonEmptyString( v: unknown ): v is string {
        return typeof v === "string" && v.trim().length > 0;
    }

    public static isString( v: unknown ): v is string {
        return typeof v === "string";
    }

    public static isBoolean( v: unknown ): v is boolean {
        return typeof v === "boolean";
    }

    public static isStringArray( v: unknown ): v is string[] {
        return Array.isArray( v ) && v.every( ( x ) => this.isNonEmptyString( x ) );
    }

    /** Best-effort ISO check (keeps it lightweight). */
    public static isIsoDateString( v: unknown ): v is string {
        if ( !this.isNonEmptyString( v ) ) return false;
        // "2026-02-26T..." minimal pattern
        return /^\d{4}-\d{2}-\d{2}T/.test( v.trim() );
    }

    public static isOneOf<T extends readonly string[]>( v: unknown, allowed: T ): v is T[ number ] {
        return this.isString( v ) && ( allowed as readonly string[] ).includes( v );
    }

    /* =============================================================================
     * B) Enums / unions
     * ========================================================================== */

    public static isSeverity( v: unknown ): v is NotificationSeverity {
        return this.isOneOf( v, NOTIFICATION_SEVERITY_VALUES );
    }

    public static isCategory( v: unknown ): v is NotificationCategory {
        return this.isOneOf( v, NOTIFICATION_CATEGORY_VALUES );
    }

    public static isAudienceMode( v: unknown ): v is NonNullable<NotificationLoadFilters[ "mode" ]> {
        return this.isOneOf( v, NOTIFICATION_AUDIENCE_MODE_VALUES );
    }

    /* =============================================================================
     * C) Audience (discriminated union)
     * ========================================================================== */

    public static isAudience( v: unknown ): v is NotificationAudience {
        if ( !this.isRecord( v ) ) return false;

        const mode = v[ "mode" ];
        if ( !this.isString( mode ) ) return false;

        if ( mode === "Company" ) {
            // { mode: "Company" }
            return true;
        }

        if ( mode === "Role" ) {
            // { mode: "Role"; roleKey: Role }
            // Role is a string union at type-level; at runtime we can only ensure non-empty string.
            return this.isNonEmptyString( v[ "roleKey" ] );
        }

        if ( mode === "Team" ) {
            // { mode: "Team"; teamCode: string }
            return this.isNonEmptyString( v[ "teamCode" ] );
        }

        if ( mode === "User" ) {
            // { mode: "User"; username: string }
            return this.isNonEmptyString( v[ "username" ] );
        }

        return false;
    }

    public static isAudienceArray( v: unknown ): v is NotificationAudience[] {
        return Array.isArray( v ) && v.every( ( x ) => this.isAudience( x ) );
    }

    /* =============================================================================
     * D) Actor / Target / Drivers
     * ========================================================================== */

    public static isActor( v: unknown ): v is NotificationActorDto {
        if ( !this.isRecord( v ) ) return false;

        if ( !this.isNonEmptyString( v[ "userId" ] ) ) return false;
        if ( !this.isNonEmptyString( v[ "username" ] ) ) return false;
        if ( !this.isNonEmptyString( v[ "role" ] ) ) return false;

        // optionals
        if ( v[ "teamCodes" ] !== undefined && !this.isStringArray( v[ "teamCodes" ] ) ) return false;
        if ( v[ "branchId" ] !== undefined && !this.isNonEmptyString( v[ "branchId" ] ) ) return false;

        return true;
    }

    public static isTarget( v: unknown ): v is NotificationTarget {
        if ( !this.isRecord( v ) ) return false;

        // all optional, but if present must be correct
        if ( v[ "module" ] !== undefined && !this.isNonEmptyString( v[ "module" ] ) ) return false;
        if ( v[ "category" ] !== undefined && !this.isNonEmptyString( v[ "category" ] ) ) return false;
        if ( v[ "refId" ] !== undefined && !this.isNonEmptyString( v[ "refId" ] ) ) return false;

        if ( v[ "route" ] !== undefined && !this.isNonEmptyString( v[ "route" ] ) ) return false;

        // actionKey is a string union in types; at runtime only ensure string
        if ( v[ "actionKey" ] !== undefined && !this.isNonEmptyString( v[ "actionKey" ] ) ) return false;

        if ( v[ "params" ] !== undefined && !this.isRecord( v[ "params" ] ) ) return false;

        return true;
    }

    public static isDrivers( v: unknown ): v is NotificationDeliveryDrivers {
        if ( !this.isRecord( v ) ) return false;

        return (
            this.isBoolean( v[ "audit" ] ) &&
            this.isBoolean( v[ "email" ] ) &&
            this.isBoolean( v[ "external" ] ) &&
            this.isBoolean( v[ "mq" ] ) &&
            this.isBoolean( v[ "push" ] ) &&
            this.isBoolean( v[ "sms" ] )
        );
    }

    /* =============================================================================
     * E) Filters / Requests / Responses
     * ========================================================================== */

    public static isLoadFilters( v: unknown ): v is NotificationLoadFilters {
        if ( !this.isRecord( v ) ) return false;

        if ( v[ "category" ] !== undefined && !this.isCategory( v[ "category" ] ) ) return false;
        if ( v[ "severity" ] !== undefined && !this.isSeverity( v[ "severity" ] ) ) return false;

        // mode uses your runtime list ("User"|"Team"|"Company"|"Role")
        if ( v[ "mode" ] !== undefined && !this.isAudienceMode( v[ "mode" ] ) ) return false;

        if ( v[ "search" ] !== undefined && !this.isString( v[ "search" ] ) ) return false;

        if ( v[ "from" ] !== undefined && !this.isIsoDateString( v[ "from" ] ) ) return false;
        if ( v[ "to" ] !== undefined && !this.isIsoDateString( v[ "to" ] ) ) return false;

        if ( v[ "unreadOnly" ] !== undefined && !this.isBoolean( v[ "unreadOnly" ] ) ) return false;
        if ( v[ "includeDeleted" ] !== undefined && !this.isBoolean( v[ "includeDeleted" ] ) ) return false;
        if ( v[ "includeArchived" ] !== undefined && !this.isBoolean( v[ "includeArchived" ] ) ) return false;

        return true;
    }

    public static isLoadRequest( v: unknown ): v is NotificationLoadRequest {
        if ( !this.isRecord( v ) ) return false;

        if ( !this.isNonEmptyString( v[ "username" ] ) ) return false;

        const page = v[ "page" ];
        const limit = v[ "limit" ];
        if ( typeof page !== "number" || !Number.isFinite( page ) || page < 1 ) return false;
        if ( typeof limit !== "number" || !Number.isFinite( limit ) || limit < 1 ) return false;

        if ( v[ "filters" ] !== undefined && !this.isLoadFilters( v[ "filters" ] ) ) return false;

        return true;
    }

    public static isCountResponse( v: unknown ): v is NotificationCountResponse {
        if ( !this.isRecord( v ) ) return false;
        const total = v[ "total" ];
        const unread = v[ "unread" ];
        return typeof total === "number" && Number.isFinite( total ) && typeof unread === "number" && Number.isFinite( unread );
    }

    public static isLoadResponse( v: unknown ): v is NotificationLoadResponse {
        if ( !this.isRecord( v ) ) return false;

        const items = v[ "items" ];
        const other = v[ "other" ];

        if ( !Array.isArray( items ) || !items.every( ( x ) => this.isInboxItem( x ) ) ) return false;
        if ( !this.isRecord( other ) ) return false;

        const total = other[ "total" ];
        if ( typeof total !== "number" || !Number.isFinite( total ) ) return false;

        return true;
    }

    /* =============================================================================
     * F) Core DTOs
     * ========================================================================== */

    public static isCoreDto( v: unknown ): v is NotificationCoreDto {
        if ( !this.isRecord( v ) ) return false;

        if ( !this.isNonEmptyString( v[ "id" ] ) ) return false;
        if ( !this.isNonEmptyString( v[ "eventKey" ] ) ) return false; // actionKey is string at runtime
        if ( !this.isCategory( v[ "category" ] ) ) return false;
        if ( !this.isSeverity( v[ "severity" ] ) ) return false;

        if ( !this.isNonEmptyString( v[ "title" ] ) ) return false;
        if ( !this.isNonEmptyString( v[ "body" ] ) ) return false;

        if ( !this.isActor( v[ "actor" ] ) ) return false;
        if ( !this.isAudienceArray( v[ "audiences" ] ) ) return false;

        if ( !this.isIsoDateString( v[ "createdAt" ] ) ) return false;

        // optionals
        if ( v[ "icon" ] !== undefined && !this.isNonEmptyString( v[ "icon" ] ) ) return false;
        if ( v[ "tags" ] !== undefined && !( Array.isArray( v[ "tags" ] ) && v[ "tags" ].every( ( x ) => typeof x === "string" ) ) ) return false;
        if ( v[ "target" ] !== undefined && !this.isTarget( v[ "target" ] ) ) return false;
        if ( v[ "expiresAt" ] !== undefined && !this.isIsoDateString( v[ "expiresAt" ] ) ) return false;

        return true;
    }

    public static isUserStateDto( v: unknown ): v is NotificationUserStateDto {
        if ( !this.isRecord( v ) ) return false;

        if ( !this.isNonEmptyString( v[ "userId" ] ) ) return false;
        if ( v[ "username" ] !== undefined && !this.isNonEmptyString( v[ "username" ] ) ) return false;

        if ( !this.isNonEmptyString( v[ "notificationId" ] ) ) return false;

        if ( !this.isBoolean( v[ "isRead" ] ) ) return false;
        if ( v[ "readAt" ] !== undefined && !this.isIsoDateString( v[ "readAt" ] ) ) return false;

        if ( !this.isBoolean( v[ "isDeleted" ] ) ) return false;
        // deletedAt in your type is Date (not ISO). At runtime we may see string/Date.
        // Best-effort accept ISO string OR Date object.
        if ( v[ "deletedAt" ] !== undefined && !( this.isIsoDateString( v[ "deletedAt" ] ) || v[ "deletedAt" ] instanceof Date ) ) return false;

        if ( !this.isBoolean( v[ "isArchived" ] ) ) return false;
        if ( v[ "archivedAt" ] !== undefined && !this.isIsoDateString( v[ "archivedAt" ] ) ) return false;

        if ( !this.isIsoDateString( v[ "deliveredAt" ] ) ) return false;

        if ( v[ "notification" ] !== undefined && !this.isCoreDto( v[ "notification" ] ) ) return false;

        return true;
    }

    public static isInboxItem( v: unknown ): v is NotificationInboxItemDto {
        if ( !this.isRecord( v ) ) return false;

        // required in your interface
        if ( !this.isNonEmptyString( v[ "inboxId" ] ) ) return false;
        if ( !this.isNonEmptyString( v[ "userId" ] ) ) return false;
        if ( !this.isNonEmptyString( v[ "username" ] ) ) return false;

        // optionals
        if ( v[ "isRead" ] !== undefined && !this.isBoolean( v[ "isRead" ] ) ) return false;
        
        if ( v[ "readAt" ] !== undefined && !this.isIsoDateString( v[ "readAt" ] ) ) return false;

        if ( v[ "isDeleted" ] !== undefined && !this.isBoolean( v[ "isDeleted" ] ) ) return false;

        if ( v[ "notification" ] !== undefined && !this.isCoreDto( v[ "notification" ] ) ) return false;

        if ( v[ "isArchived" ] !== undefined && !this.isBoolean( v[ "isArchived" ] ) ) return false;

        if ( v[ "archivedAt" ] !== undefined && !this.isIsoDateString( v[ "archivedAt" ] ) ) return false;

        if ( v[ "deletedAt" ] !== undefined && !this.isIsoDateString( v[ "deletedAt" ] ) ) return false;

        if ( v[ "deliveredAt" ] !== undefined && !this.isIsoDateString( v[ "deliveredAt" ] ) ) return false;

        return true;
    }

    /* =============================================================================
     * G) Emit input
     * ========================================================================== */

    public static isEmitInput( v: unknown ): v is NotificationEmitInput {
        if ( !this.isRecord( v ) ) return false;

        if ( !this.isNonEmptyString( v[ "eventKey" ] ) ) return false;

        // audiences MUST be array
        if ( !this.isAudienceArray( v[ "audiences" ] ) ) return false;

        // legacy "audience" if present must be valid
        if ( v[ "audience" ] !== undefined && !this.isAudience( v[ "audience" ] ) ) return false;

        if ( !this.isActor( v[ "actor" ] ) ) return false;

        if ( v[ "target" ] !== undefined && !this.isTarget( v[ "target" ] ) ) return false;
        if ( v[ "delivery" ] !== undefined && !this.isDrivers( v[ "delivery" ] ) ) return false;

        if ( v[ "vars" ] !== undefined && !this.isRecord( v[ "vars" ] ) ) return false;

        if ( v[ "category" ] !== undefined && !this.isCategory( v[ "category" ] ) ) return false;
        if ( v[ "severity" ] !== undefined && !this.isSeverity( v[ "severity" ] ) ) return false;

        if ( v[ "icon" ] !== undefined && !this.isNonEmptyString( v[ "icon" ] ) ) return false;
        if ( v[ "tags" ] !== undefined && !( Array.isArray( v[ "tags" ] ) && v[ "tags" ].every( ( x ) => typeof x === "string" ) ) ) return false;

        return true;
    }
}