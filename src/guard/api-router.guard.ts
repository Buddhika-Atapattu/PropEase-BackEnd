// Path: src/guard/api-guard.guard.ts
// ============================================================================
// API Guard Middleware
// ----------------------------------------------------------------------------
// Responsibilities:
//  - Extract sessionToken + guardToken (cookies / headers).
//  - Use GuardTokenService.resolveUserFromTokens(...) to resolve the User.
//  - Attach req.user = { username, role, permissions } for downstream handlers.
//  - Enforce module/action permissions based on GUARD_ROUTES + ACCESS_OPTIONS.
//  - Apply per-user rate limiting for protected endpoints.
//  - Enforce MFA for users with multiAuthEnabled (except MFA allowlist).
//  - Allow selected "public" endpoints to bypass checks + rate limiter.
// ============================================================================

import { ENV } from '../configs/env.config';
import type {
    NextFunction,
    Request,
    RequestHandler,
    Response,
} from 'express';

import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

import { GuardTokenService } from '../services/guard-token.service';
import { ApiResponseBuilder } from '../utils/api-combiner.builder';

import {
    ACCESS_OPTIONS,
    type AccessActionKey,
    type AccessModuleKey,
} from '../source/access-map.source';

import type { User, PermissionEntry } from '../models/user.model';
import {
    GUARD_ROUTES,
    GuardedRequest,
    GuardRouteDefinition,
    HttpMethod,
    PUBLIC_ENDPOINTS,
} from '../source/guard-routes-map.source';
import type { Role } from '../types/roles';
import { SessionExpiryService } from "../services/session-expiry.service";


// ─────────────────────────────────────────────────────────────────────────────
// MFA types
// ─────────────────────────────────────────────────────────────────────────────

type MfaVerificationStatus =
    | 'validated'
    | 'not_validated'
    | 'pending'
    | 'no_mfa'
    | 'unknown';

interface MfaBypassEndpoint {
    method: HttpMethod | 'ANY';
    pattern: RegExp;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core guard implementation
// ─────────────────────────────────────────────────────────────────────────────

class ApiGuard {
    private readonly tokenService = new GuardTokenService();
    private readonly sessionExpiryService = new SessionExpiryService();

    /**
     * Per-user rate limiter (STRICT):
     *  - 10 requests per 15 minutes
     *  - Keyed by x-session-token when present, otherwise by IP
     *
     * Use for SENSITIVE endpoints: user mgmt, tracking, etc.
     */
    private readonly limiter10per15: RequestHandler;

    /**
     * Relaxed limiter for high-frequency endpoints like notifications:
     *  - 300 requests per 15 minutes (i.e. 1 req / 3s on average)
     *  - Same keying logic (IP + optional x-session-token).
     */
    private readonly notificationLimiter: RequestHandler;

    private readonly MFA_BYPASS_ENDPOINTS: ReadonlyArray<MfaBypassEndpoint> = [
        // example for future, when some routes are guarded but should skip MFA:
        { method: 'POST', pattern: /^\/api\/auth\/logout$/ },
    ];


    public constructor () {
        const isDev: boolean = ENV.app.NODE_ENV !== 'production';
        const baseLimiterConfig = {
            windowMs: 15 * 60 * 1000, // 15 minutes
            standardHeaders: true,
            legacyHeaders: false,
            message: {
                status: 'error',
                message: 'Too many requests. Please try again later.',
            },
            keyGenerator: ( req: Request ): string => {
                // 1) Always derive an IPv6-safe base key from IP
                const rawIp = req.ip || '';
                const ipKey = ipKeyGenerator( rawIp, 64 ); // 64-char stable hash

                // 2) Optionally mix in session token if present
                const sessionHeader =
                    ( req.headers[ 'x-session-token' ] as string | undefined )?.trim();

                return sessionHeader && sessionHeader.length > 0
                    ? `${ ipKey }:${ sessionHeader }`
                    : ipKey;
            },
        } as const;

        if ( isDev ) {
            // DEVELOPMENT MODE → disable rate limiting entirely
            const noopLimiter: RequestHandler = ( _req, _res, next ) => {
                next();
            };

            this.limiter10per15 = noopLimiter;
            this.notificationLimiter = noopLimiter;
        } else {
            // PRODUCTION MODE
            this.limiter10per15 = rateLimit( {
                ...baseLimiterConfig,
                max: 10,
            } );

            this.notificationLimiter = rateLimit( {
                ...baseLimiterConfig,
                max: 300, // 1 req / 3s on average
            } );
        }
    }

    /**
     * Main middleware: plug into app.ts as:
     *   app.use("/api-user", apiGuard, userRoute.route);
     *   app.use("/api-notification", apiGuard, notificationController.router);
     *   app.use("/api-tracking", apiGuard, tracking.route);
     */
    public readonly middleware: RequestHandler = (
        req: Request,
        res: Response,
        next: NextFunction,
    ): void => {
        const method = req.method.toUpperCase() as HttpMethod;
        const fullPath = this.getFullPath( req );

        // 1) Public endpoints bypass both rate limiting and auth/RBAC
        if ( this.isPublicEndpoint( method, fullPath ) ) {
            next();
            return;
        }

        // 2) Choose limiter based on path:
        const useNotificationLimiter: boolean =
            fullPath.startsWith( '/api-notification' );

        const limiter = useNotificationLimiter
            ? this.notificationLimiter
            : this.limiter10per15;

        limiter( req, res, ( limitErr?: unknown ) => {
            if ( limitErr ) {
                // Limiter already sent 429 response
                return;
            }

            // 3) Run the actual auth + permission logic
            void this.handleGuardAfterRateLimit( req, res, next, method, fullPath );
        } );
    };

    /**
     * Core guard logic executed AFTER rate limiting has passed.
     */
    private async handleGuardAfterRateLimit(
        req: Request,
        res: Response,
        next: NextFunction,
        method: HttpMethod,
        fullPath: string,
    ): Promise<void> {
        try {
            // 1) Extract tokens from cookies + headers
            const { sessionToken, guardToken } = this.extractTokens( req );

            if ( !sessionToken || !guardToken ) {
                ApiResponseBuilder.error(
                    res,
                    401,
                    'Authentication required: missing session or guard token.',
                );
                return;
            }

            // 2) Resolve user from tokens
            const user: User | null =
                await this.tokenService.resolveUserFromTokens( sessionToken, guardToken );

            if ( !user ) {
                ApiResponseBuilder.error(
                    res,
                    401,
                    'Authentication failed: invalid or expired tokens.',
                );
                return;
            }

            // 3) MFA ENFORCEMENT (before RBAC):
            //    If user has multiAuthEnabled, require X-MFA-Verification=validated
            //    unless the endpoint is in the MFA bypass allowlist.
            const mfaRequired: boolean = !!user.multiAuthEnabled;

            if (
                mfaRequired &&
                !this.isMfaBypassEndpoint( method, fullPath ) // e.g., NOT /api-mfa/* or /api-user/logout
            ) {
                const mfaStatus: MfaVerificationStatus = this.extractMfaStatus( req );

                if ( mfaStatus !== 'validated' ) {
                    // Backend cannot redirect, but FE will see this 401 + message
                    // and route to /mfa/verification.
                    ApiResponseBuilder.error(
                        res,
                        401,
                        'Multi-factor authentication required. Please complete verification.',
                    );
                    return;
                }
            }

            // 4) Attach to req.user for controllers
            const permissions: PermissionEntry[] = Array.isArray(
                user.access?.permissions,
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
                // No specific rule defined → "authenticated-only", no RBAC check.
                next();
                return;
            }

            const allowed = this.hasPermissionForRoute(
                user,
                routeDef.module,
                routeDef.action,
            );

            if ( !allowed ) {
                ApiResponseBuilder.error(
                    res,
                    403,
                    'Permission denied: insufficient access for this operation.',
                );
                return;
            }

            // 6) EXTRA: Only privileged users may change access/permissions
            if ( routeDef.id === 'user:create' || routeDef.id === 'user:update' ) {
                const touchesAccess = this.requestTouchesUserAccess( req );

                if ( touchesAccess && !this.hasAccessControlAuthority( user ) ) {
                    ApiResponseBuilder.error(
                        res,
                        403,
                        'Permission denied: you are not allowed to grant or revoke access.',
                    );
                    return;
                }
            }

            // 7)  Attach session warning headers if session is close to expiry
            await this.sessionExpiryService.attachWarningHeadersIfNeeded(
                res,
                sessionToken
            );

            // 8) All checks passed
            next();
            return;
        } catch ( error ) {
            console.error( '[ApiGuard] error:', error );
            ApiResponseBuilder.error( res, 500, 'Internal guard error.' );
            return;
        }
    }

    // ───────────────────────────────────────────────────────────────────────────
    // Helpers: path, public endpoints, MFA helpers, token extraction, route match
    // ───────────────────────────────────────────────────────────────────────────

    private getFullPath( req: Request ): string {
        const base = req.baseUrl || '';
        const path = ( req.path || req.url || '' ).split( '?' )[ 0 ];
        return base + path;
    }

    private isPublicEndpoint( method: HttpMethod, fullPath: string ): boolean {
        return PUBLIC_ENDPOINTS.some( ( ep ) => {
            if ( ep.method !== 'ANY' && ep.method !== method ) return false;
            return ep.pattern.test( fullPath );
        } );
    }

    private isMfaBypassEndpoint(
        method: HttpMethod,
        fullPath: string,
    ): boolean {
        return this.MFA_BYPASS_ENDPOINTS.some( ( ep ) => {
            if ( ep.method !== 'ANY' && ep.method !== method ) {
                return false;
            }
            return ep.pattern.test( fullPath );
        } );
    }

    /**
     * Extract MFA verification status from header:
     *  - Header from FE: X-MFA-Verification: validated | not_validated | pending | no_mfa | ...
     *  - All keys are lowercased in Node's req.headers.
     */
    private extractMfaStatus( req: Request ): MfaVerificationStatus {
        const raw =
            ( req.headers[ 'x-mfa-verification' ] as string | undefined )?.trim().toLowerCase() ??
            '';

        switch ( raw ) {
            case 'validated':
                return 'validated';
            case 'not_validated':
                return 'not_validated';
            case 'pending':
                return 'pending';
            case 'no_mfa':
                return 'no_mfa';
            case '':
                // if not provided but user has MFA enabled, treat as pending
                return 'pending';
            default:
                return 'unknown';
        }
    }

    private extractTokens(
        req: Request,
    ): { sessionToken?: string | undefined; guardToken?: string | undefined; } {
        const anyReq = req as Request & {
            cookies?: Record<string, unknown>;
        };

        const rawSession =
            ( anyReq.cookies?.sessionToken as string | undefined ) ?? undefined;
        const rawGuard =
            ( anyReq.cookies?.guardToken as string | undefined ) ?? undefined;

        const headerSession =
            ( req.headers[ 'x-session-token' ] as string | undefined ) ?? undefined;
        const headerGuard =
            ( req.headers[ 'x-guard-token' ] as string | undefined ) ?? undefined;

        const sessionToken = ( rawSession || headerSession || '' ).trim() || undefined;
        const guardToken = ( rawGuard || headerGuard || '' ).trim() || undefined;

        return { sessionToken, guardToken };
    }

    private matchGuardRoute(
        method: HttpMethod,
        fullPath: string,
    ): GuardRouteDefinition | undefined {
        return GUARD_ROUTES.find(
            ( r ) => r.method === method && r.pattern.test( fullPath ),
        );
    }

    // ───────────────────────────────────────────────────────────────────────────
    // Permission model
    // ───────────────────────────────────────────────────────────────────────────

    private hasPermissionForRoute(
        user: User,
        module: AccessModuleKey,
        action: AccessActionKey,
    ): boolean {
        const role = user.role as Role;
        const permissions: PermissionEntry[] = Array.isArray(
            user.access?.permissions,
        )
            ? ( user.access!.permissions as PermissionEntry[] )
            : [];

        // 1) Super-role shortcut
        if ( role === 'admin' ) return true;

        // 2) Validate that the module/action exists in ACCESS_OPTIONS
        const moduleOption = ACCESS_OPTIONS.find( ( opt ) => opt.module === module );
        if ( !moduleOption ) {
            console.warn( '[ApiGuard] Unknown module in GUARD_ROUTES:', module );
            return false;
        }

        const actionExists = moduleOption.actions?.some( ( a ) => a.id === action );
        if ( !actionExists ) {
            console.warn(
                '[ApiGuard] Unknown action in GUARD_ROUTES:',
                module,
                action,
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

    private requestTouchesUserAccess( req: Request ): boolean {
        const body = req.body as Record<string, unknown> | undefined;
        if ( !body || typeof body !== 'object' ) return false;

        if ( 'access' in body ) return true;
        if ( 'accessControl' in body ) return true;
        if ( 'permissions' in body ) return true;

        return false;
    }

    private hasAccessControlAuthority( user: User ): boolean {
        const role = user.role as Role;
        const permissions: PermissionEntry[] = Array.isArray(
            user.access?.permissions,
        )
            ? ( user.access!.permissions as PermissionEntry[] )
            : [];

        if ( role === 'admin' ) return true;

        const entry = permissions.find( ( p ) => p.module === 'AccessControl' );
        if ( !entry || !Array.isArray( entry.actions ) ) {
            return false;
        }

        const allowedActions = new Set( entry.actions );
        return (
            allowedActions.has( 'grantAccess' ) || allowedActions.has( 'revokeAccess' )
        );
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton instance + exported handler
// ─────────────────────────────────────────────────────────────────────────────

const apiGuardInstance = new ApiGuard();

export const apiGuard: RequestHandler = apiGuardInstance.middleware;
