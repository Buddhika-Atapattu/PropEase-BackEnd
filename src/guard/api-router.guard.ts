// Path: src/guard/api-guard.guard.ts
// ============================================================================
// API Guard Middleware
// ----------------------------------------------------------------------------
// Responsibilities:
//  - Extract sessionToken + guardToken (cookies / headers).
//  - Use GuardTokenService.resolveUserFromTokens(...) to resolve the User.
//  - Attach req.user = { userId, username, role, permissions } for downstream.
//  - Enforce module/action permissions based on GUARD_ROUTES + ACCESS_OPTIONS.
//  - Apply per-user rate limiting for protected endpoints.
//  - Enforce MFA for users with multiAuthEnabled (except MFA allowlist).
//  - Allow selected "public" endpoints to bypass checks + rate limiter.
//  - Attach session expiry warning headers when close to expiry.
// ============================================================================

import type { NextFunction, Request, RequestHandler, Response } from 'express';

import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

import { ENV } from '../configs/env.config';

import { GuardTokenService } from '../services/guard-token.service';
import { SessionExpiryService } from '../services/session-expiry.service';

import { ApiResponseBuilder } from '../utils/api-combiner.builder';

import {
    ACCESS_OPTIONS,
    type AccessActionKey,
    type AccessModuleKey,
} from '../source/access-map.source';

import type { User, PermissionEntry } from '../models/user.model';

import {
    GUARD_ROUTES,
    type GuardedRequest,
    type GuardRouteDefinition,
    type HttpMethod,
    PUBLIC_ENDPOINTS,
} from '../source/guard-routes-map.source';

import type { Role } from '../types/roles';

// =============================================================================
// Local helpers (keep this file self-contained + type-safe)
// =============================================================================

type CookieBag = Record<string, unknown>;

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

interface ExtractedTokens {
    sessionToken?: string | undefined;
    guardToken?: string | undefined;
}

class ApiGuard {
    private readonly tokenService = new GuardTokenService();
    private readonly sessionExpiryService = new SessionExpiryService();

    private readonly limiter10per15: RequestHandler;
    private readonly notificationLimiter: RequestHandler;

  /**
   * MFA bypass allowlist:
   * - Keep this VERY small.
   * - Only for endpoints that must work before MFA completion (e.g., logout).
   */
    private readonly MFA_BYPASS_ENDPOINTS: ReadonlyArray<MfaBypassEndpoint> = [
      { method: 'POST', pattern: /^\/api\/auth\/logout$/ },
  ];

    public constructor () {
        const isDev: boolean = ENV.app.NODE_ENV !== 'production';

      /**
       * Rate limiting strategy:
       * - IPv6-safe IP key
       * - If sessionToken exists, include it in key to become "per-user-ish"
       * - Still falls back to IP-only if token missing
       */
      const baseLimiterConfig = {
        windowMs: 15 * 60 * 1000,
        standardHeaders: true,
        legacyHeaders: false,
        message: {
            status: 'error',
            message: 'Too many requests. Please try again later.',
        },
        keyGenerator: ( req: Request ): string => {
            const rawIp: string = String( req.ip ?? '' ).trim();
            const ipKey: string = ipKeyGenerator( rawIp, 64 );

          const { sessionToken } = this.extractTokens( req );

            return sessionToken ? `${ ipKey }:${ sessionToken }` : ipKey;
        },
    } as const;

      // Dev: disable limiters to reduce local friction
      if ( isDev ) {
          const noopLimiter: RequestHandler = ( _req, _res, next ) => next();
          this.limiter10per15 = noopLimiter;
          this.notificationLimiter = noopLimiter;
          return;
      }

      // Prod: strict default limiter + larger bucket for notification bursty traffic
      this.limiter10per15 = rateLimit( {
          ...baseLimiterConfig,
          max: 10,
    } );

      this.notificationLimiter = rateLimit( {
          ...baseLimiterConfig,
        max: 300,
    } );
  }

    // =============================================================================
    // Exported middleware
    // =============================================================================

    public readonly middleware: RequestHandler = (
        req: Request,
        res: Response,
        next: NextFunction,
    ): void => {
      const method: HttpMethod = req.method.toUpperCase() as HttpMethod;
      const fullPath: string = this.getFullPath( req );

      // 1) Public endpoints bypass EVERYTHING (no tokens, no limiter, no MFA)
      if ( this.isPublicEndpoint( method, fullPath ) ) {
          next();
          return;
      }

      // 2) Choose limiter bucket (example: notifications can be noisier)
      const useNotificationLimiter: boolean = fullPath.startsWith( '/api-notification' );
      const limiter: RequestHandler = useNotificationLimiter
          ? this.notificationLimiter
          : this.limiter10per15;

      limiter( req, res, ( limitErr?: unknown ) => {
          // express-rate-limit already wrote response when it blocks.
          if ( limitErr ) return;

        void this.handleGuardAfterRateLimit( req, res, next, method, fullPath );
    } );
  };

    // =============================================================================
    // Main guard flow (runs AFTER limiter)
    // =============================================================================

    private async handleGuardAfterRateLimit(
        req: Request,
        res: Response,
        next: NextFunction,
        method: HttpMethod,
        fullPath: string,
    ): Promise<void> {
        try {
        // 1) Tokens
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
        const user: User | null = await this.tokenService.resolveUserFromTokens(
            sessionToken,
            guardToken,
        );

        if ( !user ) {
            ApiResponseBuilder.error(
                res,
                401,
                'Authentication failed: invalid or expired tokens.',
            );
            return;
        }

        // 3) MFA enforcement (only when user requires it, except bypass allowlist)
        const mfaRequired: boolean = !!( user as any )?.multiAuthEnabled;

        if ( mfaRequired && !this.isMfaBypassEndpoint( method, fullPath ) ) {
            const mfaStatus: MfaVerificationStatus = this.extractMfaStatus( req );

          if ( mfaStatus !== 'validated' ) {
              ApiResponseBuilder.error(
                  res,
                  401,
                  'Multi-factor authentication required. Please complete verification.',
              );
              return;
          }
      }

        // 4) Attach req.user for downstream handlers (safe + minimal)
        const permissions: PermissionEntry[] = Array.isArray( ( user as any )?.access?.permissions )
            ? ( ( user as any ).access.permissions as PermissionEntry[] )
            : [];

        // Important: userId may be missing if resolveUserFromTokens returns a stripped DTO.
        const userId: string = String( ( user as any )?._id ?? '' ).trim();

        ( req as unknown as GuardedRequest ).user = {
            userId,
            username: user.username,
          name: ( user as any )?.name ?? '',
          image: ( user as any )?.image ?? null,
          role: user.role as Role,
          permissions,
      };

        // 5) RBAC check (ONLY for routes that exist in GUARD_ROUTES)
        //    - If route isn't listed, we still consider it "authenticated",
        //      but not permission-guarded (useful during incremental rollout).
        const routeDef: GuardRouteDefinition | undefined = this.matchGuardRoute( method, fullPath );

        if ( routeDef ) {
            const allowed: boolean = this.hasPermissionForRoute( user, routeDef.module, routeDef.action );

          if ( !allowed ) {
              ApiResponseBuilder.error(
                  res,
                  403,
                  'Permission denied: insufficient access for this operation.',
              );
              return;
          }

          // 6) Extra hardening for access/role modifications (defense-in-depth)
          if ( routeDef.id === 'user:create' || routeDef.id === 'user:update' ) {
              const touchesAccess: boolean = this.requestTouchesUserAccess( req );

            if ( touchesAccess && !this.hasAccessControlAuthority( user ) ) {
                ApiResponseBuilder.error(
                    res,
                    403,
                    'Permission denied: you are not allowed to grant or revoke access.',
                );
                return;
            }
        }
      }

        // 7) Session expiry warning headers (even if route not in GUARD_ROUTES)
        await this.sessionExpiryService.attachWarningHeadersIfNeeded( res, sessionToken );

        next();
        return;
      } catch ( error ) {
          console.error( '[Error:] [ApiGuard] middleware error:\n', error, '\n' );
          ApiResponseBuilder.error( res, 500, 'Internal guard error.' );
          return;
      }
  }

    // =============================================================================
    // Public helpers (used by other parts of the system)
    // =============================================================================

    public getTokens( req: Request ): ExtractedTokens {
        return this.extractTokens( req );
    }

    public async getLoggedUser( req: Request ): Promise<User | null> {
        try {
            const { sessionToken, guardToken } = this.extractTokens( req );

          if ( !sessionToken ) throw new Error( 'Invalid session token' );
          if ( !guardToken ) throw new Error( 'Invalid guard token' );

          const user = await this.tokenService.resolveUserFromTokens( sessionToken, guardToken );

          if ( !user ) throw new Error( 'Invalid user data!' );
          return user;
      } catch ( error ) {
          console.error( '[Error:] [ApiGuard] getLoggedUser:\n', error, '\n' );
          return null;
      }
  }

    // =============================================================================
    // Request parsing helpers
    // =============================================================================

    private getFullPath( req: Request ): string {
        const base: string = String( req.baseUrl ?? '' );
        const raw: string = String( req.path || req.url || '' );
        const clean: string = raw.split( '?' )[ 0 ] ?? '';
        return base + clean;
    }

    private isPublicEndpoint( method: HttpMethod, fullPath: string ): boolean {
        return PUBLIC_ENDPOINTS.some( ( ep ) => {
            if ( ep.method !== 'ANY' && ep.method !== method ) return false;
            return ep.pattern.test( fullPath );
        } );
    }

    private isMfaBypassEndpoint( method: HttpMethod, fullPath: string ): boolean {
        return this.MFA_BYPASS_ENDPOINTS.some( ( ep ) => {
            if ( ep.method !== 'ANY' && ep.method !== method ) return false;
            return ep.pattern.test( fullPath );
        } );
    }

    private extractMfaStatus( req: Request ): MfaVerificationStatus {
        const raw: string =
            String( req.headers[ 'x-mfa-verification' ] ?? '' )
                .trim()
                .toLowerCase();

      switch ( raw ) {
          case 'validated':
              return 'validated';

        case 'not_validated':
            return 'not_validated';

        case 'pending':
            return 'pending';

        case 'no_mfa':
            return 'no_mfa';

        // If FE doesn't send header yet, treat as pending (secure-by-default)
        case '':
            return 'pending';

          default:
              return 'unknown';
      }
  }

    private extractTokens( req: Request ): ExtractedTokens {
        const anyReq = req as Request & { cookies?: CookieBag; };

      // Cookies (require cookie-parser)
      const cookieSession: string = String( anyReq.cookies?.sessionToken ?? '' ).trim();
      const cookieGuard: string = String( anyReq.cookies?.guardToken ?? '' ).trim();

      // Headers (optional for API clients)
      const headerSession: string = String( req.headers[ 'x-session-token' ] ?? '' ).trim();
      const headerGuard: string = String( req.headers[ 'x-guard-token' ] ?? '' ).trim();

      const sessionToken: string = ( cookieSession || headerSession || '' ).trim();
      const guardToken: string = ( cookieGuard || headerGuard || '' ).trim();

      return {
          sessionToken: sessionToken || undefined,
          guardToken: guardToken || undefined,
      };
  }

    private matchGuardRoute( method: HttpMethod, fullPath: string ): GuardRouteDefinition | undefined {
        return GUARD_ROUTES.find( ( r ) => {
            const methodOk: boolean = r.method === method || r.method === 'ANY';
            return methodOk && r.pattern.test( fullPath );
        } );
    }

    // =============================================================================
    // Permission model (RBAC)
    // =============================================================================

    private hasPermissionForRoute(
        user: User,
        module: AccessModuleKey,
        action: AccessActionKey,
    ): boolean {
      const role: Role = user.role as Role;

      const permissions: PermissionEntry[] = Array.isArray( ( user as any )?.access?.permissions )
          ? ( ( user as any ).access.permissions as PermissionEntry[] )
          : [];

      // Superuser shortcut
      if ( role === 'admin' ) return true;

      // Validate module + action exist in canonical ACCESS_OPTIONS (defensive)
      const moduleOption = ACCESS_OPTIONS.find( ( opt ) => opt.module === module );

      if ( !moduleOption ) {
          console.warn(
              '[Warning:] [ApiGuard] Unknown module in GUARD_ROUTES:',
              module,
              '\n',
          );
          return false;
      }

      const actionExists: boolean = !!moduleOption.actions?.some( ( a ) => a.id === action );

      if ( !actionExists ) {
          console.warn(
          '[Warning:] [ApiGuard] Unknown action in GUARD_ROUTES:',
          module,
          action,
          '\n',
        );
        return false;
    }

      // Check user permission entry
      const entry = permissions.find( ( p ) => p.module === module );

      if ( !entry || !Array.isArray( entry.actions ) ) return false;

      return entry.actions.includes( action );
  }

    /**
     * Defense-in-depth:
     * Even if route permission allows user:create/user:update,
     * only some users should be allowed to grant/revoke permissions.
     */
    private requestTouchesUserAccess( req: Request ): boolean {
        const body = req.body as Record<string, unknown> | undefined;

      if ( !body || typeof body !== 'object' ) return false;

      if ( 'access' in body ) return true;
      if ( 'accessControl' in body ) return true;
      if ( 'permissions' in body ) return true;

      return false;
  }

    /**
     * "Access Control Authority" policy:
     * - Admin always allowed.
     * - Otherwise must have:
     *   - UserManagement.assignRole
     *   - AccessControl.grantAccess OR AccessControl.revokeAccess
     */
    private hasAccessControlAuthority( user: User ): boolean {
        const role: Role = user.role as Role;

        const permissions: PermissionEntry[] = Array.isArray( ( user as any )?.access?.permissions )
            ? ( ( user as any ).access.permissions as PermissionEntry[] )
            : [];

      if ( role === 'admin' ) return true;

      const userManagementEntry = permissions.find( ( p ) => p.module === 'UserManagement' );

      if ( !userManagementEntry || !Array.isArray( userManagementEntry.actions ) ) return false;

      const userManagementAllowed: boolean = new Set( userManagementEntry.actions ).has( 'assignRole' );

      const accessEntry = permissions.find( ( p ) => p.module === 'AccessControl' );

      if ( !accessEntry || !Array.isArray( accessEntry.actions ) ) return false;

      const accessAllowedActions = new Set( accessEntry.actions );

      const accessManagementAllowed: boolean =
          accessAllowedActions.has( 'grantAccess' ) || accessAllowedActions.has( 'revokeAccess' );

      return userManagementAllowed && accessManagementAllowed;
  }
}

// =============================================================================
// Singleton instance + exported handler
// =============================================================================

const apiGuardInstance = new ApiGuard();

export const apiGuard: RequestHandler = apiGuardInstance.middleware;

export class ApiGuardExport {
    // ✅ IMPORTANT: reuse singleton (do NOT new ApiGuard())
    private static ApiGuardMain: ApiGuard = apiGuardInstance;

    public static GetTokens( req: Request ): ExtractedTokens {
        return ApiGuardExport.ApiGuardMain.getTokens( req );
    }

    public static async GetLoggedUser( req: Request ): Promise<User | null> {
        return await ApiGuardExport.ApiGuardMain.getLoggedUser( req );
    }
}
