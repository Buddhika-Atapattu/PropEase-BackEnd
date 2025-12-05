// Path: src/controller/auth.controller.ts
// ============================================================================
// AuthController
// ----------------------------------------------------------------------------
// - POST /login
//   * Validates username/password
//   * Verifies Argon2 password hash
//   * Issues sessionToken + guardToken via GuardTokenService
//   * Sets httpOnly cookies (30 days)
// - POST /logout
//   * Reads sessionToken from cookies
//   * Revokes it via GuardTokenService
//   * Clears cookies
// ============================================================================

import { Router, type Request, type Response } from "express";
import * as Argon2 from "argon2";

import { UserModel, type IUser } from "../models/user.model";
import { GuardTokenService } from "../services/guard-token.service";
import { ApiResponseBuilder } from "../utils/api-combiner.builder";

export class AuthController {
  private readonly router: Router;
  private readonly guardTokenService: GuardTokenService;

  public constructor () {
    this.router = Router();
    this.guardTokenService = new GuardTokenService();
    this.registerRoutes();
  }

  /** Expose router to be mounted by the main app. */
  public getRouter(): Router {
    return this.router;
  }

  /** Map HTTP routes to controller methods. */
  private registerRoutes(): void {
    this.router.post( "/login", this.login.bind( this ) );
    this.router.post( "/logout", this.logout.bind( this ) );
  }

  // ==========================================================================
  // POST /login
  // ==========================================================================
  private async login( req: Request, res: Response ): Promise<void> {
    try {
      const username: string = String( req.body.username ?? "" ).trim();
      const password: string = String( req.body.password ?? "" ).trim();

      // 1) Basic input validation
      if ( !username || !password ) {
        ApiResponseBuilder.error(
          res,
          400,
          "Username and password are required."
        );
        return;
      }

      // 2) Load user by username
      const user: IUser | null = await UserModel.findOne( { username } ).exec();

      if ( !user ) {
        ApiResponseBuilder.error(
          res,
          401,
          "Invalid username or password."
        );
        return;
      }


      // 3) Password check (adapt field name to your model)
      //    If your schema uses `password` for the hash, use that.
      const hash: string | undefined = ( user as any ).password;
      if ( !hash ) {
        ApiResponseBuilder.error(
          res,
          401,
          "Invalid username or password."
        );
        return;
      }

      const validPassword: boolean = await Argon2.verify( hash, password );
      if ( !validPassword ) {
        ApiResponseBuilder.error(
          res,
          401,
          "Invalid username or password."
        );
        return;
      }

      // 4) Optional: Multi-auth flow (if you support MFA in this project)
      if ( ( user as unknown as IUser ).multiAuthEnabled ) {
        // Do NOT issue tokens yet; FE should perform the MFA step.
        const plain = user.toObject ? user.toObject() : ( user as any );
        const { password: _omit, ...userWithoutPassword } = plain;

        ApiResponseBuilder.ok(
          res,
          "other",
          {
            user: userWithoutPassword,
            mfaRequired: true,
            multiAuthEnabled: true,
            username: user.username
          },
          "User verified, multi-authentication required."
        );
        return;
      }

      // 5) Issue main + guard tokens
      const tokens = await this.guardTokenService.issueForUser( user );

      // 6) Set secure cookies for 30 days
      const isProd = process.env.NODE_ENV === "production";

      res.cookie( "sessionToken", tokens.sessionToken, {
        httpOnly: true,
        secure: isProd,
        sameSite: "strict",
        maxAge: 30 * 24 * 60 * 60 * 1000
      } );

      // Optional: also store guardToken in httpOnly cookie
      res.cookie( "guardToken", tokens.guardToken, {
        httpOnly: true,
        secure: isProd,
        sameSite: "strict",
        maxAge: 30 * 24 * 60 * 60 * 1000
      } );

      // 7) Final response: only expose what FE really needs
      ApiResponseBuilder.ok(
        res,
        "user",
        user,
        "Login successful",
        {
          other: {
            sessionToken: tokens.sessionToken, // remove if you want cookie-only
            guardToken: tokens.guardToken
          }
        }
      );
      return;
    } catch ( error ) {
      console.error( "[auth.login] error:", error );
      ApiResponseBuilder.error(
        res,
        500,
        "Login failed due to internal error."
      );
      return;
    }
  }

  // ========================================================================
  // POST /logout  (idempotent, token & cookie based)
  // ========================================================================
  private async logout( req: Request, res: Response ): Promise<void> {
    try {
      const isProd: boolean = process.env.NODE_ENV === "production";

      // ───────────────────────────────────────────────────────────────────
      // 1) Try to read sessionToken from secure cookies (primary source)
      // ───────────────────────────────────────────────────────────────────
      const reqWithCookies = req as Request & {
        cookies?: Record<string, unknown>;
      };

      const cookieTokenRaw: unknown = reqWithCookies.cookies
        ? reqWithCookies.cookies[ "sessionToken" ]
        : undefined;

      const cookieToken: string | undefined =
        typeof cookieTokenRaw === "string" && cookieTokenRaw.trim().length > 0
          ? cookieTokenRaw.trim()
          : undefined;

      // ───────────────────────────────────────────────────────────────────
      // 2) Fallback: optional header-based session token (for APIs / tools)
      //    - FE does NOT need this, but it’s useful for CLI / tests.
      // ───────────────────────────────────────────────────────────────────
      const headerTokenRaw: unknown = req.headers[ "x-session-token" ];
      const headerToken: string | undefined =
        typeof headerTokenRaw === "string" && headerTokenRaw.trim().length > 0
          ? headerTokenRaw.trim()
          : undefined;

      const sessionToken: string | undefined = cookieToken || headerToken;

      // ───────────────────────────────────────────────────────────────────
      // 3) Revoke token in GuardTokenService (best-effort)
      //    - If token is missing or already invalid → treat as "already out".
      // ───────────────────────────────────────────────────────────────────
      if ( sessionToken ) {
        try {
          await this.guardTokenService.revokeBySessionToken( sessionToken );
        } catch ( err ) {
          // Do NOT leak details, just log server-side.
          console.warn( "[auth.logout] revokeBySessionToken failed:", err );
          // We still continue to clear cookies and return 200.
        }
      } else {
        // No token → already logged out (from a security POV this is fine).
        console.info( "[auth.logout] no session token found; treating as already logged out" );
      }

      // ───────────────────────────────────────────────────────────────────
      // 4) Clear cookies (must match options used in login)
      // ───────────────────────────────────────────────────────────────────
      res.clearCookie( "sessionToken", {
        httpOnly: true,
        secure: isProd,
        sameSite: "strict",
      } );

      res.clearCookie( "guardToken", {
        httpOnly: true,
        secure: isProd,
        sameSite: "strict",
      } );

      // ───────────────────────────────────────────────────────────────────
      // 5) Always respond 200 – logout is idempotent
      //    - Never reveal whether token existed or not.
      // ───────────────────────────────────────────────────────────────────
      ApiResponseBuilder.ok(
        res,
        "other",
        {},
        "Logout successful"
      );
      return;
    } catch ( error ) {
      console.error( "[auth.logout] error:", error );
      ApiResponseBuilder.error(
        res,
        500,
        "Logout failed due to internal error."
      );
      return;
    }
  }
}
