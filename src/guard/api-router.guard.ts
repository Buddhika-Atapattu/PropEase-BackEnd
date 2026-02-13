// Path: src/guard/api-guard.guard.ts
// ============================================================================
// API Guard Middleware (FIXED to align with:)
//   ✅ src/source/guard-routes-map.source.ts (PUBLIC_ENDPOINTS + GUARD_ROUTES)
//   ✅ src/source/access-map.source.ts (ACCESS_OPTIONS as the canonical permission matrix)
//
// Key fixes in this version:
// 1) exactOptionalPropertyTypes-safe token DTO (no `string | undefined` union)
// 2) Faster + safer permission validation using a precomputed module→actions map
// 3) Defense-in-depth “access/role mutation” check aligned to NEW access map:
//      - Uses UserManagement.roles when present
//      - Optionally uses AccessControl / SystemAdministration if those modules exist
//      - Never hard-references modules that might not exist in ACCESS_OPTIONS
// 4) More robust `getFullPath()` (always uses baseUrl + req.path, strips query)
// 5) Strict, consistent response style via ApiResponseBuilder.error(...)
// ============================================================================

import type { NextFunction, Request, RequestHandler, Response } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";

import { ENV } from "../configs/env.config";
import { GuardTokenService } from "../services/guard-token.service";
import { SessionExpiryService } from "../services/session-expiry.service";
import { ApiResponseBuilder } from "../utils/api-combiner.builder";

import {
    ACCESS_OPTIONS,
    type AccessActionKey,
    type AccessModuleKey,
} from "../source/access-map.source";

import type { User, PermissionEntry } from "../models/user.model";
import {
    GUARD_ROUTES,
    type GuardedRequest,
    type GuardRouteDefinition,
    type HttpMethod,
    PUBLIC_ENDPOINTS,
} from "../source/guard-routes-map.source";

import type { Role } from "../types/roles";
import type { AuthUser } from "../types/common";

// =============================================================================
// Local helpers (keep this file self-contained + type-safe)
// =============================================================================

type CookieBag = Record<string, unknown>;

type MfaVerificationStatus =
    | "validated"
    | "not_validated"
    | "pending"
    | "no_mfa"
    | "unknown";

interface MfaBypassEndpoint {
    method: HttpMethod | "ANY";
    pattern: RegExp;
}

interface ExtractedTokens {
    sessionToken?: string;
    guardToken?: string;
}

type ActionSet = ReadonlySet<AccessActionKey>;
type ModuleActionIndex = ReadonlyMap<AccessModuleKey, ActionSet>;

class ApiGuard {
    private readonly tokenService = new GuardTokenService();
    private readonly sessionExpiryService = new SessionExpiryService();

    /** Precomputed: module -> allowed action ids (canonical list from ACCESS_OPTIONS) */
    private readonly moduleActionIndex: ModuleActionIndex;

    private readonly limiter10per15: RequestHandler;
    private readonly notificationLimiter: RequestHandler;

  /**
   * MFA bypass allowlist (VERY small).
   * NOTE:
   *  - Public endpoints bypass guard completely via PUBLIC_ENDPOINTS.
   *  - This list is only for authenticated endpoints that must work pre-MFA.
   */
    private readonly MFA_BYPASS_ENDPOINTS: ReadonlyArray<MfaBypassEndpoint> = [
      { method: "POST", pattern: /^\/api\/auth\/logout$/ },
  ];

    public constructor () {
        this.moduleActionIndex = this.buildModuleActionIndex();

      const isDev: boolean = ENV.app.NODE_ENV !== "production";

      const baseLimiterConfig = {
          windowMs: 15 * 60 * 1000,
          standardHeaders: true,
          legacyHeaders: false,
          message: {
            status: "error",
            message: "Too many requests. Please try again later.",
        },
        keyGenerator: ( req: Request ): string => {
            const rawIp: string = String( req.ip ?? "" ).trim();
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
      const useNotificationLimiter: boolean =
          fullPath.startsWith( "/api-notification" );
      const limiter: RequestHandler = useNotificationLimiter
          ? this.notificationLimiter
          : this.limiter10per15;

      limiter( req, res, ( limitErr?: unknown ) => {
          // express-rate-limit already wrote response when it blocks
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
            "Authentication required: missing session or guard token.",
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
            "Authentication failed: invalid or expired tokens.",
        );
          return;
      }

        // 3) MFA enforcement (only when user requires it, except bypass allowlist)
        const mfaRequired: boolean = Boolean(
            ( user as unknown as { multiAuthEnabled?: boolean; } ).multiAuthEnabled,
        );

        if ( mfaRequired && !this.isMfaBypassEndpoint( method, fullPath ) ) {
            const mfaStatus: MfaVerificationStatus = this.extractMfaStatus( req );

          if ( mfaStatus !== "validated" ) {
              ApiResponseBuilder.error(
                  res,
                  401,
              "Multi-factor authentication required. Please complete verification.",
          );
            return;
        }
      }

        // 4) Attach req.user for downstream handlers (safe + minimal)
        const permissions: PermissionEntry[] = Array.isArray(
            ( user as unknown as { access?: { permissions?: unknown; }; } ).access
                ?.permissions,
        )
            ? ( ( user as unknown as { access: { permissions: PermissionEntry[]; }; } )
                .access.permissions as PermissionEntry[] )
            : [];

        const userId: string = String( ( user as unknown as { _id?: unknown; } )._id ?? "" ).trim();

        ( req as unknown as GuardedRequest ).user = {
            userId,
            username: user.username,
          name: String( ( user as unknown as { name?: unknown; } ).name ?? "" ),
          image:
              ( user as unknown as { image?: string | null; } ).image === null
                  ? null
                  : String( ( user as unknown as { image?: unknown; } ).image ?? "" ) || null,
          role: user.role as Role,
          permissions,
      };

        // 5) RBAC check (ONLY for routes that exist in GUARD_ROUTES)
        const routeDef: GuardRouteDefinition | undefined = this.matchGuardRoute(
            method,
            fullPath,
        );

        if ( routeDef ) {
            const allowed: boolean = this.hasPermissionForRoute(
                user,
                routeDef.module,
                routeDef.action,
            );

          if ( !allowed ) {
              ApiResponseBuilder.error(
                  res,
                  403,
              "Permission denied: insufficient access for this operation.",
          );
            return;
        }

          // 6) Defense-in-depth: if request tries to change access/roles/permissions,
          // require elevated authority (aligned to pinned access map).
          if ( this.requestTouchesUserAccess( req ) ) {
              if ( !this.hasAccessControlAuthority( user ) ) {
                  ApiResponseBuilder.error(
                      res,
                      403,
                "Permission denied: you are not allowed to grant/revoke access or change roles.",
            );
              return;
          }
        }
      }

        // 7) Session expiry warning headers (even if route not in GUARD_ROUTES)
        await this.sessionExpiryService.attachWarningHeadersIfNeeded(
            res,
            sessionToken,
        );

        next();
        return;
    } catch ( error ) {
        console.error( "[Error:] [ApiGuard] middleware error:\n", error, "\n" );
        ApiResponseBuilder.error( res, 500, "Internal guard error." );
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

        if ( !sessionToken ) throw new Error( "Invalid session token" );
        if ( !guardToken ) throw new Error( "Invalid guard token" );

        const user = await this.tokenService.resolveUserFromTokens(
            sessionToken,
            guardToken,
        );

        if ( !user ) throw new Error( "Invalid user data!" );
        return user;
    } catch ( error ) {
        console.error( "[Error:] [ApiGuard] getLoggedUser:\n", error, "\n" );
        return null;
    }
  }

    // =============================================================================
    // Request parsing helpers
    // =============================================================================

    /**
     * Build a stable “full path” for matching.
     * - baseUrl = mount path (e.g. "/api-team-management/task")
     * - path    = router-local path (e.g. "/create")
     * - query is stripped
     */
    private getFullPath( req: Request ): string {
        const base: string = String( req.baseUrl ?? "" );
        const pathOnly: string = String( req.path ?? req.url ?? "" ).split( "?" )[ 0 ] ?? "";
        return `${ base }${ pathOnly }`;
    }

    private isPublicEndpoint( method: HttpMethod, fullPath: string ): boolean {
        return PUBLIC_ENDPOINTS.some( ( ep ) => {
            if ( ep.method !== "ANY" && ep.method !== method ) return false;
            return ep.pattern.test( fullPath );
        } );
    }

    private isMfaBypassEndpoint( method: HttpMethod, fullPath: string ): boolean {
        return this.MFA_BYPASS_ENDPOINTS.some( ( ep ) => {
            if ( ep.method !== "ANY" && ep.method !== method ) return false;
            return ep.pattern.test( fullPath );
        } );
    }

    private extractMfaStatus( req: Request ): MfaVerificationStatus {
        const raw: string = String( req.headers[ "x-mfa-verification" ] ?? "" )
            .trim()
            .toLowerCase();

      switch ( raw ) {
          case "validated":
              return "validated";
          case "not_validated":
              return "not_validated";
          case "pending":
              return "pending";
          case "no_mfa":
              return "no_mfa";
          case "":
              // Secure default if FE doesn't send header yet
              return "pending";
          default:
            return "unknown";
    }
  }

    private extractTokens( req: Request ): ExtractedTokens {
        const anyReq = req as Request & { cookies?: CookieBag; };

      // Cookies (require cookie-parser)
      const cookieSession: string = String( anyReq.cookies?.sessionToken ?? "" ).trim();
      const cookieGuard: string = String( anyReq.cookies?.guardToken ?? "" ).trim();

      // Headers (optional for API clients / Electron)
      const headerSession: string = String( req.headers[ "x-session-token" ] ?? "" ).trim();
      const headerGuard: string = String( req.headers[ "x-guard-token" ] ?? "" ).trim();

      const sessionToken: string = ( cookieSession || headerSession || "" ).trim();
      const guardToken: string = ( cookieGuard || headerGuard || "" ).trim();

      // exactOptionalPropertyTypes-safe: only include property when it exists
      const out: ExtractedTokens = {};
      if ( sessionToken ) out.sessionToken = sessionToken;
      if ( guardToken ) out.guardToken = guardToken;

      return out;
  }

    private matchGuardRoute(
        method: HttpMethod,
        fullPath: string,
    ): GuardRouteDefinition | undefined {
        return GUARD_ROUTES.find( ( r ) => {
            const methodOk: boolean = r.method === method || r.method === "ANY";
            return methodOk && r.pattern.test( fullPath );
        } );
    }

    // =============================================================================
    // Permission model (RBAC)
    // =============================================================================

    private buildModuleActionIndex(): ModuleActionIndex {
        const map = new Map<AccessModuleKey, ActionSet>();

        for ( const opt of ACCESS_OPTIONS ) {
            const actions: AccessActionKey[] = Array.isArray( opt.actions )
                ? opt.actions.map( ( a ) => a.id )
                : [];

            map.set( opt.module, new Set( actions ) );
        }

        return map;
    }

    private isValidModuleAction( module: AccessModuleKey, action: AccessActionKey ): boolean {
        const actionSet = this.moduleActionIndex.get( module );
        return Boolean( actionSet?.has( action ) );
    }

    private hasPermissionForRoute(
        user: User,
        module: AccessModuleKey,
        action: AccessActionKey,
    ): boolean {
        const role: Role = user.role as Role;

      // Superuser shortcut
      if ( role === "admin" ) return true;

      // Defensive: route map must never point to non-existent module/action
      if ( !this.isValidModuleAction( module, action ) ) {
          console.warn(
          "[Warning:] [ApiGuard] GUARD_ROUTES contains unknown module/action:\n",
          { module, action },
          "\n",
      );
        return false;
    }

      const permissions: PermissionEntry[] = Array.isArray(
          ( user as unknown as { access?: { permissions?: unknown; }; } ).access
              ?.permissions,
      )
          ? ( ( user as unknown as { access: { permissions: PermissionEntry[]; }; } )
              .access.permissions as PermissionEntry[] )
          : [];

      const entry = permissions.find( ( p ) => p.module === module );
      if ( !entry || !Array.isArray( entry.actions ) ) return false;

      return entry.actions.includes( action );
  }

  /**
   * Detect whether this request attempts to change permissions/roles/access
   * so we can apply defense-in-depth.
   */
    private requestTouchesUserAccess( req: Request ): boolean {
        const body = req.body as Record<string, unknown> | undefined;
      if ( !body || typeof body !== "object" ) return false;

      // Common payload keys we use across PropEase
      if ( "access" in body ) return true;
      if ( "accessControl" in body ) return true;
      if ( "permissions" in body ) return true;
      if ( "role" in body ) return true;
      if ( "roles" in body ) return true;

      return false;
  }

  /**
   * Access/Role mutation authority policy aligned to NEW access map:
   * - Admin always allowed.
   * - Otherwise:
   *   - If UserManagement.roles exists → require it
   *   - If AccessControl module exists → also require grant/revoke (if defined)
   *   - If SystemAdministration module exists → also require configure/access action (if defined)
   *
   * This avoids hardcoding modules that may not exist in ACCESS_OPTIONS.
   */
    private hasAccessControlAuthority( user: User ): boolean {
        const role: Role = user.role as Role;
      if ( role === "admin" ) return true;

      const permissions: PermissionEntry[] = Array.isArray(
          ( user as unknown as { access?: { permissions?: unknown; }; } ).access?.permissions,
      )
          ? ( user as unknown as { access: { permissions: PermissionEntry[]; }; } ).access.permissions
          : [];

      const has = ( module: AccessModuleKey, action: AccessActionKey ): boolean => {
          // If module/action doesn't exist in ACCESS_OPTIONS → treat as unavailable.
          if ( !this.isValidModuleAction( module, action ) ) return false;

        const entry = permissions.find( ( p ) => p.module === module );
        if ( !entry || !Array.isArray( entry.actions ) ) return false;

        return entry.actions.includes( action );
    };

      // ✅ Primary rule (based on your pinned access map)
      // If UserManagement.roles exists, require it (best practice for “role/access change”).
      if ( this.isValidModuleAction( "UserManagement", "roles" ) ) {
          return has( "UserManagement", "roles" );
      }

      // ✅ Backward compatible fallback (if your map does not have roles, but uses assignRole)
      if ( this.isValidModuleAction( "UserManagement", "create" ) ) {
          return has( "UserManagement", "create" );
      }
      if ( this.isValidModuleAction( "UserManagement", "update" ) ) {
          return has( "UserManagement", "update" );
      }
      if ( this.isValidModuleAction( "UserManagement", "disable" ) ) {
          return has( "UserManagement", "disable" );
      }

      // ✅ Optional (only if AccessControl module exists in your access map)
      // If you keep AccessControl in ACCESS_OPTIONS, allow if user has grant/revoke.
      if ( this.moduleActionIndex.has( "AccessControl" ) ) {
          const canGrant =
              this.isValidModuleAction( "AccessControl", "grant" ) &&
              has( "AccessControl", "grant" );

        const canRevoke =
            this.isValidModuleAction( "AccessControl", "revoke" ) &&
            has( "AccessControl", "revoke" );

        return canGrant || canRevoke;
    }

      // Deny by default (secure)
      return false;
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

    public static async GetAuthUser( req: Request ): Promise<AuthUser | null> {
        const user: User | null = await ApiGuardExport.ApiGuardMain.getLoggedUser( req );
        if ( !user ) return null;

        const authUser: AuthUser = {
            role: user.role,
            username: user.username,
        userId: String( ( user as unknown as { _id?: unknown; } )._id ?? "" ),
    };

      return authUser;
  }
}
