// Path: src/guard/api-guard.guard.ts
// ============================================================================
// API Guard Middleware
// ----------------------------------------------------------------------------
// Responsibilities:
//  - Extract sessionToken + guardToken (cookies / headers).
//  - Use GuardTokenService.resolveUserFromTokens(...) to resolve the IUser.
//  - Attach req.user = { username, role, permissions } for downstream handlers.
//  - Enforce module/action permissions based on GUARD_ROUTES + ACCESS_OPTIONS.
//  - Allow selected "public" endpoints to bypass checks.
// ============================================================================

import type {
    NextFunction,
    Request,
    RequestHandler,
    Response,
} from "express";

import { GuardTokenService } from "../services/guard-token.service";
import { ApiResponseBuilder } from "../utils/api-combiner.builder";

import {
    ACCESS_OPTIONS,
    type AccessActionKey,
    type AccessModuleKey,
} from "../source/access-map.source";

import type { IUser, PermissionEntry } from "../models/user.model";
import {
    GUARD_ROUTES,
    GuardedRequest,
    GuardRouteDefinition,
    HttpMethod,
    PUBLIC_ENDPOINTS
} from '../source/guard-routes-map.source';
import type { Role } from "../types/roles";



// ─────────────────────────────────────────────────────────────────────────────
// Core guard implementation
// ─────────────────────────────────────────────────────────────────────────────

class ApiGuard {
    private readonly tokenService = new GuardTokenService();

    /**
     * Main middleware: plug into app.ts as:
     *   app.use("/api-user", apiGuard, userRoute.route);
     */
    public readonly middleware: RequestHandler = async (
        req: Request,
        res: Response,
        next: NextFunction
    ): Promise<void> => {
        try {
            const method = req.method.toUpperCase() as HttpMethod;
            const fullPath = this.getFullPath( req );

            // 1) Public bypass (no auth, no RBAC)
            if ( this.isPublicEndpoint( method, fullPath ) ) {
                return next();
            }

            // 2) Extract tokens
            const { sessionToken, guardToken } = this.extractTokens( req );

            if ( !sessionToken || !guardToken ) {
                ApiResponseBuilder.error(
                    res,
                    401,
                    "Authentication required: missing session or guard token."
                );
                return;
            }

            // 3) Resolve user from tokens
            const user: IUser | null =
                await this.tokenService.resolveUserFromTokens(
                    sessionToken,
                    guardToken
                );

            if ( !user ) {
                ApiResponseBuilder.error(
                    res,
                    401,
                    "Authentication failed: invalid or expired tokens."
                );
                return;
            }

            // 4) Attach to req.user for controllers
            const permissions: PermissionEntry[] = Array.isArray(
                user.access?.permissions
            )
                ? ( user.access!.permissions as PermissionEntry[] )
                : [];

            ( req as unknown as GuardedRequest ).user = {
                username: user.username,
                role: user.role as Role,
                permissions,
            };

            // 5) Route-level permission check
            const routeDef = this.matchGuardRoute( method, fullPath );
            if ( !routeDef ) {
                // No specific rule defined → means "authenticated-only", no RBAC check.
                return next();
            }

            const allowed = this.hasPermissionForRoute(
                user,
                routeDef.module,
                routeDef.action
            );

            if ( !allowed ) {
                ApiResponseBuilder.error(
                    res,
                    403,
                    "Permission denied: insufficient access for this operation."
                );
                return;
            }

            // 6) EXTRA: Only privileged users may change access/permissions
            //    on create/update user operations.
            if ( routeDef.id === "user:create" || routeDef.id === "user:update" ) {
                const touchesAccess = this.requestTouchesUserAccess( req );

                if ( touchesAccess && !this.hasAccessControlAuthority( user ) ) {
                    ApiResponseBuilder.error(
                        res,
                        403,
                        "Permission denied: you are not allowed to grant or revoke access."
                    );
                    return;
                }
            }

            return next();
        } catch ( error ) {
            console.error( "[ApiGuard] error:", error );
            ApiResponseBuilder.error( res, 500, "Internal guard error." );
            return;
        }
    };

    // ───────────────────────────────────────────────────────────────────────────
    // Helpers: path, public endpoints, token extraction, route match
    // ───────────────────────────────────────────────────────────────────────────

    private getFullPath( req: Request ): string {
        const base = req.baseUrl || "";
        const path = ( req.path || req.url || "" ).split( "?" )[ 0 ];
        return base + path;
    }

    private isPublicEndpoint( method: HttpMethod, fullPath: string ): boolean {
        return PUBLIC_ENDPOINTS.some( ( ep ) => {
            if ( ep.method !== "ANY" && ep.method !== method ) return false;
            return ep.pattern.test( fullPath );
        } );
    }

    private extractTokens(
        req: Request
    ): { sessionToken?: string | undefined; guardToken?: string | undefined; } {
        const anyReq = req as Request & {
            cookies?: Record<string, unknown>;
        };

        const rawSession =
            ( anyReq.cookies?.sessionToken as string | undefined ) ?? undefined;
        const rawGuard =
            ( anyReq.cookies?.guardToken as string | undefined ) ?? undefined;

        const headerSession =
            ( req.headers[ "x-session-token" ] as string | undefined ) ?? undefined;
        const headerGuard =
            ( req.headers[ "x-guard-token" ] as string | undefined ) ?? undefined;

        const sessionToken = ( rawSession || headerSession || "" ).trim() || undefined;
        const guardToken = ( rawGuard || headerGuard || "" ).trim() || undefined;

        return { sessionToken, guardToken };
    }

    private matchGuardRoute(
        method: HttpMethod,
        fullPath: string
    ): GuardRouteDefinition | undefined {
        return GUARD_ROUTES.find(
            ( r ) => r.method === method && r.pattern.test( fullPath )
        );
    }

    // ───────────────────────────────────────────────────────────────────────────
    // Permission model
    // ───────────────────────────────────────────────────────────────────────────

    /**
     * Permission model:
     *  - user.access.permissions is PermissionEntry[]:
     *      { module: string; actions: string[] }
     *  - ACCESS_OPTIONS is the canonical matrix:
     *      - Which modules exist
     *      - Which actions (ids) exist per module
     */
    private hasPermissionForRoute(
        user: IUser,
        module: AccessModuleKey,
        action: AccessActionKey
    ): boolean {
        const role = user.role as Role;
        const permissions: PermissionEntry[] = Array.isArray(
            user.access?.permissions
        )
            ? ( user.access!.permissions as PermissionEntry[] )
            : [];

        // 1) Super-role shortcut
        if ( role === "admin" ) return true;

        // 2) Validate that the module/action exists in ACCESS_OPTIONS
        const moduleOption = ACCESS_OPTIONS.find( ( opt ) => opt.module === module );
        if ( !moduleOption ) {
            console.warn( "[ApiGuard] Unknown module in GUARD_ROUTES:", module );
            return false;
        }

        const actionExists = moduleOption.actions?.some(
            ( a ) => a.id === action
        );
        if ( !actionExists ) {
            console.warn(
                "[ApiGuard] Unknown action in GUARD_ROUTES:",
                module,
                action
            );
            return false;
        }

        // 3) Does the user have this module + action in their PermissionEntry[]?
        const entry = permissions.find( ( p ) => p.module === module );
        if ( !entry || !Array.isArray( entry.actions ) ) {
            return false;
        }

        return entry.actions.includes( action );
    }

    /**
     * Detect if a create/update user request is trying to touch access / permissions.
     * This keeps:
     *   - "simple user create"  → allowed if they have UserManagement:create
     *   - "assign/change access" → requires AccessControl grant/revoke.
     */
    private requestTouchesUserAccess( req: Request ): boolean {
        const body = req.body as Record<string, unknown> | undefined;
        if ( !body || typeof body !== "object" ) return false;

        // Adjust these keys if FE uses different field names
        if ( "access" in body ) return true;
        if ( "accessControl" in body ) return true;
        if ( "permissions" in body ) return true;

        return false;
    }

    /**
     * Check if the acting user is allowed to grant/revoke access.
     * Maps to AccessControl module in ACCESS_OPTIONS.
     */
    private hasAccessControlAuthority( user: IUser ): boolean {
        const role = user.role as Role;
        const permissions: PermissionEntry[] = Array.isArray(
            user.access?.permissions
        )
            ? ( user.access!.permissions as PermissionEntry[] )
            : [];

        // Admin → always allowed
        if ( role === "admin" ) return true;

        const entry = permissions.find( ( p ) => p.module === "AccessControl" );
        if ( !entry || !Array.isArray( entry.actions ) ) {
            return false;
        }

        const allowedActions = new Set( entry.actions );
        return (
            allowedActions.has( "grantAccess" ) ||
            allowedActions.has( "revokeAccess" )
        );
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton instance + exported handler
// ─────────────────────────────────────────────────────────────────────────────

const apiGuardInstance = new ApiGuard();

/**
 * Usage in app.ts:
 *
 *   import { apiGuard } from "./guard/api-guard.guard";
 *   app.use("/api-user", apiGuard, userRoute.route);
 *   app.use("/api-notification", apiGuard, notificationController.router);
 *   app.use("/api-tracking", apiGuard, tracking.route);
 */
export const apiGuard: RequestHandler = apiGuardInstance.middleware;
