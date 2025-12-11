// Path: src/controller/auth.controller.ts
// ============================================================================
// AuthController
// ----------------------------------------------------------------------------
// Responsibilities:
//   - POST /login
//       * Validate username/password
//       * Verify Argon2 password hash
//       * Enforce optional multi-factor authentication (MFA)
//       * Issue:
//           - sessionToken (HTTP APIs)
//           - guardToken   (short-lived API guard)
//           - wsToken      (WebSocket-only token, REDIS-backed)
//       * Set httpOnly cookies (30 days) for sessionToken + guardToken
//
//   - POST /logout
//       * Read sessionToken from cookies / headers
//       * Revoke session in GuardTokenService
//       * Revoke all wsTokens in Redis for that session
//       * Clear cookies
//
//   - POST /regenerate-challenge
//       * Generate a new MFA login challenge for a given username
// ============================================================================

import "dotenv/config";
import { Router, type Request, type Response } from "express";
import * as Argon2 from "argon2";

// ──────────────────────────────────────────────────────────────────────────────
// Models
// ──────────────────────────────────────────────────────────────────────────────
import { USER_MODEL_PROJECTION, UserModel, type IUser, type User } from "../models/user.model";

// ──────────────────────────────────────────────────────────────────────────────
// Services
// ──────────────────────────────────────────────────────────────────────────────
import { GuardTokenService } from "../services/guard-token.service";
// Legacy file-based WsTokenRegistry REMOVED
import { WsTokenRegistryProvider } from "../services/ws-service/ws-token-registry.provider.service";
import { MfaService } from "../services/mfa.service";
import { SocketServerProvider } from '../socket/socket-server.provider';

// ──────────────────────────────────────────────────────────────────────────────
// Utils
// ──────────────────────────────────────────────────────────────────────────────
import { ApiResponseBuilder } from "../utils/api-combiner.builder";
import type { MfaStrength, WsTokenRecord } from "../types/ws-token.types";

// ============================================================================
// Controller
// ============================================================================

export class AuthController {
  // Router exposed to main app
  private readonly router: Router;

  // Services
  private readonly guardTokenService: GuardTokenService;
  private readonly mfaService: MfaService;

  // Optional: central TTL for wsTokens (in seconds)
  private readonly wsTokenTtlSeconds: number = 300;

  // Cookie names (centralised to avoid typos)
  private static readonly SESSION_COOKIE_NAME: string = "sessionToken";
  private static readonly GUARD_COOKIE_NAME: string = "guardToken";

  public constructor () {
    this.router = Router();

    this.guardTokenService = new GuardTokenService();
    this.mfaService = new MfaService();

    this.registerRoutes();
  }

  // --------------------------------------------------------------------------
  // Public: expose router
  // --------------------------------------------------------------------------
  public getRouter(): Router {
    return this.router;
  }

  // --------------------------------------------------------------------------
  // Private: route registration
  // --------------------------------------------------------------------------
  private registerRoutes(): void {
    this.router.post( "/login", this.login.bind( this ) );
    this.router.post( "/logout", this.logout.bind( this ) );
    this.router.post( "/regenerate-challenge", this.generateNewChallenge.bind( this ) );
    this.router.post( "/ws-token/rotate/:username", this.rotateWsToken.bind( this ) );
  }

  /**
   * Issue a Redis-backed wsToken for this user + session.
   * This replaces the legacy file-based WsTokenRegistry.
   */
  private async issueWsTokenForResponse(
    user: IUser,
    sessionId: string,
    mfaStrength: MfaStrength,
    req: Request,
  ): Promise<WsTokenRecord> {
    const registry = await WsTokenRegistryProvider.getInstance();

    const ip: string | undefined = req.ip ?? undefined;
    const userAgent: string | undefined = req.get( "user-agent" ) ?? undefined;

    const record: WsTokenRecord = await registry.issueTokenForUser(
      user,
      sessionId,
      mfaStrength,
      ip,
      userAgent,
      this.wsTokenTtlSeconds,
    );

    return record;
  }

  // ========================================================================
  // POST /login
  // ========================================================================
  private async login( req: Request, res: Response ): Promise<void> {
    try {
      const username: string = String( req.body.username ?? "" ).trim();
      const password: string = String( req.body.password ?? "" ).trim();

      // 1) Basic input validation
      if ( !username || !password ) {
        ApiResponseBuilder.error(
          res,
          400,
          "Username and password are required.",
        );
        return;
      }

      // 2) Load user by username (Mongoose document)
      const userDoc: IUser | null = await UserModel.findOne( { username } ).exec();

      if ( !userDoc ) {
        this.respondInvalidCredentials( res );
        return;
      }

      // 3) Password check (argon2)
      const hash: string = userDoc.password;
      if ( !hash ) {
        this.respondInvalidCredentials( res );
        return;
      }

      const validPassword: boolean = await Argon2.verify( hash, password );
      if ( !validPassword ) {
        this.respondInvalidCredentials( res );
        return;
      }

      // 4) Optional: Multi-auth flow (MFA enabled)
      if ( userDoc.multiAuthEnabled ) {
        // Build safe DTO for FE (no password, no resetToken, etc.)
        const safeUser: User = userDoc.toSafeDTO();

        const challenge = await this.mfaService.createLoginChallenge(
          userDoc,
          req.ip,
          req.get( "user-agent" ) ?? undefined,
        );

        ApiResponseBuilder.ok(
          res,
          "other",
          {
            user: safeUser,
            mfaRequired: true,
            multiAuthEnabled: true,
            username: userDoc.username,
            challenge,
          },
          "User verified, multi-authentication required.",
        );
        return;
      }

      // 5) Issue session + guard tokens (JWT-based) for this user
      const tokens = await this.guardTokenService.issueForUser( userDoc );

      if ( !tokens ) {
        ApiResponseBuilder.error( res, 406, "Failed to generate user tokens!" );
        return;
      }

      const isProd: boolean = this.isProductionEnv();

      // 6) Set secure cookies for 30 days
      res.cookie(
        AuthController.SESSION_COOKIE_NAME,
        tokens.sessionToken,
        this.buildCookieOptions( isProd ),
      );

      res.cookie(
        AuthController.GUARD_COOKIE_NAME,
        tokens.guardToken,
        this.buildCookieOptions( isProd ),
      );

      // 7) Issue WebSocket-only token (Redis-backed registry)
      // Use sessionToken as the session identifier for wsTokens.
      const mfaStrength: MfaStrength = userDoc.multiAuthEnabled ? "password_only" : "none";

      let wsRecord: WsTokenRecord | null = null;
      try {
        wsRecord = await this.issueWsTokenForResponse(
          userDoc,
          tokens.sessionToken,
          mfaStrength,
          req,
        );
      } catch ( err ) {
        // If WS token creation fails, we STILL allow HTTP login
        // but log this clearly because realtime will not work.
        console.warn(
          "[auth.login] Failed to issue Redis wsToken for user:",
          userDoc.username,
          err,
        );
      }

      // 8) Final response: send safe DTO as "user" payload
      const safeUser: User = userDoc.toSafeDTO();

      ApiResponseBuilder.ok(
        res,
        "user", // uses the "user" overload of ApiResponseBuilder
        safeUser,
        "Login successful",
        {
          other: {
            // NOTE: You can remove these from payload later if you move to cookie-only auth.
            sessionToken: tokens.sessionToken,
            guardToken: tokens.guardToken,
            wsToken: wsRecord ? wsRecord.token : null,
            // Preserve the same semantics as old WsTokenRegistry:
            // numeric timestamps for issuedAt / validUntil
            wsTokenIssuedAt: wsRecord ? wsRecord.createdAt.getTime() : null,
            wsTokenValidUntil: wsRecord ? wsRecord.expiresAt.getTime() : null,
            mfaVerify: null,
          },
        },
      );
      return;
    } catch ( error ) {
      console.error( "[auth.login] error:", error );
      ApiResponseBuilder.error(
        res,
        500,
        "Login failed due to internal error.",
      );
      return;
    }
  }

  // ========================================================================
  // POST /logout  (idempotent, token & cookie based)
  // ========================================================================
  private async logout( req: Request, res: Response ): Promise<void> {
    try {
      const isProd: boolean = this.isProductionEnv();

      // 1) Extract sessionToken from cookies or header
      const sessionToken: string | undefined = this.extractSessionToken( req );

      // 2) OPTIONAL: username (still available if you need it later)
      const logoutUsername: string | undefined = this.extractUsernameFromBody( req );

      const socketHandler = SocketServerProvider.getHandler();
      if ( socketHandler ) {
        if ( sessionToken ) {
          socketHandler.forceDisconnectSession( sessionToken, 'logout' );
        } else if ( logoutUsername ) {
          socketHandler.forceDisconnectUser( logoutUsername, 'logout' );
        }
      }

      // 3) Revoke token in GuardTokenService (best-effort)
      if ( sessionToken ) {
        try {
          await this.guardTokenService.revokeBySessionToken( sessionToken );
        } catch ( err ) {
          console.warn( "[auth.logout] revokeBySessionToken failed:", err );
          // Continue with wsToken + cookie cleanup; logout remains idempotent.
        }

        // 4) Revoke all wsTokens in Redis for this HTTP session
        try {
          const wsRegistry = await WsTokenRegistryProvider.getInstance();
          await wsRegistry.revokeAllForSession( sessionToken );
        } catch ( err ) {
          console.warn( "[Error: auth logout] revokeAllForSession(wsToken) failed:", err, '\n' );
        }
      } else {
        console.warn(
          "[Warning: auth logout] no session token found; treating as already logged out", '\n'
        );
      }

      // (Optional) logoutUsername is currently not used for ws cleanup anymore.
      // Keep it if you later want to log audit events per user.
      if ( logoutUsername ) {
        console.info( "[Info: auth logout] logout requested for user:", logoutUsername, '\n' );
      }

      // 5) Clear cookies (must match options used in login)
      res.clearCookie( AuthController.SESSION_COOKIE_NAME, {
        httpOnly: true,
        secure: isProd,
        sameSite: "strict",
      } );

      res.clearCookie( AuthController.GUARD_COOKIE_NAME, {
        httpOnly: true,
        secure: isProd,
        sameSite: "strict",
      } );

      // 6) Always respond 200 – logout is idempotent
      ApiResponseBuilder.ok(
        res,
        "other",
        {},
        "Logout successful",
      );
      return;
    } catch ( error ) {
      console.error( "[auth.logout] error:", error );
      ApiResponseBuilder.error(
        res,
        500,
        "Logout failed due to internal error.",
      );
      return;
    }
  }

  // ========================================================================
  // POST /regenerate-challenge
  // ------------------------------------------------------------------------
  // Generates a new MFA login challenge for a given username.
  // Used when:
  //   - QR / code expired
  //   - FE wants to refresh challenge without re-sending password
  // ========================================================================
  private async generateNewChallenge( req: Request, res: Response ): Promise<void> {
    try {
      const username: string = String( req.body.username ?? "" ).trim();

      if ( !username ) {
        ApiResponseBuilder.validationError( res, "Username is required!" );
        return;
      }

      const userDoc: IUser | null = await UserModel.findOne( { username } ).exec();

      if ( !userDoc ) {
        ApiResponseBuilder.notFound( res, "User not found!" );
        return;
      }

      const challenge = await this.mfaService.createLoginChallenge(
        userDoc,
        req.ip,
        req.get( "user-agent" ) ?? undefined,
      );

      if ( !challenge ) {
        ApiResponseBuilder.error( res, 406, "Failed to create login challenge!" );
        return;
      }

      ApiResponseBuilder.ok(
        res,
        "other",
        { challenge },
        "Challenge created successfully!",
      );
      return;
    } catch ( error ) {
      console.error( "[auth.generateNewChallenge] error:", error );
      ApiResponseBuilder.internalError( res, error );
      return;
    }
  }

  private async rotateWsToken( req: Request<{ username: string; }>, res: Response ): Promise<void> {
    try {
      const username = String( req.params.username ?? '' ).trim();

      if ( !username ) {
        ApiResponseBuilder.validationError( res, 'Username is required!' );
        return;
      }

      const user: IUser | null = await UserModel.findOne( { username } );

      if ( !user ) {
        ApiResponseBuilder.notFound( res, 'User not found!' );
        return;
      }

      const tokens = await this.guardTokenService.getOrIssueForUser( user );
      const sessionId = tokens?.sessionToken;

      if ( !sessionId ) {
        ApiResponseBuilder.error( res, 401, 'No session available' );
        return;
      }

      const wsRegistry = await WsTokenRegistryProvider.getInstance();
      const newRecord = await wsRegistry.rotateToken( sessionId );

      if ( !newRecord ) {
        ApiResponseBuilder.error( res, 400, 'Unable to rotate ws token' );
        return;
      }

      ApiResponseBuilder.ok(
        res,
        'other',
        {
          wsToken: newRecord.token,
          expiresAt: newRecord.expiresAt
        }
      );
    }
    catch ( error ) {
      console.error( '[Error:]', error, '\n' );
      ApiResponseBuilder.internalError( res, error );
      return;
    }
  }

  // ========================================================================
  // Private helpers
  // ========================================================================

  /** Centralised "invalid credentials" response – keeps message consistent. */
  private respondInvalidCredentials( res: Response ): void {
    ApiResponseBuilder.error(
      res,
      401,
      "Invalid username or password.",
    );
  }

  /** True when running in production mode. */
  private isProductionEnv(): boolean {
    return process.env.NODE_ENV === "production";
  }

  /** Build standard cookie options (30-day, httpOnly, sameSite=strict). */
  private buildCookieOptions( isProd: boolean ): {
    httpOnly: boolean;
    secure: boolean;
    sameSite: "strict";
    maxAge: number;
  } {
    return {
      httpOnly: true,
      secure: isProd,
      sameSite: "strict",
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    };
  }

  /** Extracts sessionToken from cookies or `x-session-token` header. */
  private extractSessionToken( req: Request ): string | undefined {
    // Cast to include cookies without forcing dependency on cookie-parser types
    const reqWithCookies = req as Request & {
      cookies?: Record<string, unknown>;
    };

    const cookieTokenRaw: unknown = reqWithCookies.cookies
      ? reqWithCookies.cookies[ AuthController.SESSION_COOKIE_NAME ]
      : undefined;

    const cookieToken: string | undefined =
      typeof cookieTokenRaw === "string" && cookieTokenRaw.trim().length > 0
        ? cookieTokenRaw.trim()
        : undefined;

    const headerTokenRaw: unknown = req.headers[ "x-session-token" ];
    const headerToken: string | undefined =
      typeof headerTokenRaw === "string" && headerTokenRaw.trim().length > 0
        ? headerTokenRaw.trim()
        : undefined;

    return cookieToken || headerToken;
  }

  /** Safely extracts an optional username from request body. */
  private extractUsernameFromBody( req: Request ): string | undefined {
    if ( !req.body || typeof req.body.username !== "string" ) {
      return undefined;
    }
    const raw: string = req.body.username.trim();
    return raw.length > 0 ? raw : undefined;
  }
}
