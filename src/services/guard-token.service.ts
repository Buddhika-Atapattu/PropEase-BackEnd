// Path: src/services/guard-token.service.ts

import { randomBytes } from 'crypto';
import { Types } from 'mongoose';

import {
    GuardTokenModel,
    type GuardTokenDocument
} from '../models/guard.model';
import { UserModel, type IUser, type User } from '../models/user.model';

/* ============================================================================ *
 *  Token lifetime & behaviour
 * ========================================================================== */

/**
 * 30 days session lifetime (stable token).
 *  - Stored once per device/login.
 *  - Used as the “anchor” for both HTTP and WebSocket auth.
 */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Guard token rotation overlap:
 *  - We allow BOTH current + previous guardToken for a short window.
 *  - The actual rotation cadence is driven by the WebSocket side
 *    (e.g. every 5s), but from DB perspective we just keep both values.
 *
 * NOTE: we don’t store this window in DB; it’s enforced by caller
 *       via rotate frequency + resolveUserFromTokens accepting previous.
 */
const GUARD_OVERLAP_WINDOW_MS = 10_000; // purely for reasoning/documentation

/**
 * Length (in bytes) of randomly generated tokens.
 * 32 bytes → 64 hex chars.
 */
const TOKEN_BYTES = 32;

/* ============================================================================ *
 *  DTOs
 * ========================================================================== */

export interface IssuedTokens {
    /** 30-day stable token (per device). */
    sessionToken: string;
    /** Short-lived / rotating token. */
    guardToken: string;
    /** Device identifier used for this row. */
    deviceID: string;
}

/* ============================================================================ *
 *  GuardTokenService
 * ========================================================================== */

/**
 * GuardTokenService
 * -----------------
 * Single responsibility: manage guard-token documents.
 */
export class GuardTokenService {

    /* ───────────────────────── Private helpers ───────────────────────── */

    /** Generate a cryptographically-strong random hex token. */
    private generateToken(): string {
        return randomBytes( TOKEN_BYTES ).toString( 'hex' );
    }

    /** Compute a new Date representing 30 days from “now”. */
    private computeSessionExpiry(): Date {
        return new Date( Date.now() + SESSION_TTL_MS );
    }

    /** Normalise deviceID (trim + basic guard). */
    private normalizeDeviceId( deviceID: string | null | undefined ): string {
        return String( deviceID ?? '' ).trim();
    }

    /* ───────────────────────── Issuing tokens ────────────────────────── */

  /**
   * issueForUser
   * ------------
   * Always issues a fresh sessionToken + guardToken for the given user+device.
   * Overwrites any existing GuardTokenDocument for that (userId, deviceID).
   *
   * Typical usage:
   *  - MFA-less login flows.
   *  - Forced re-login on a specific device.
   */
    public async issueForUser( user: User, deviceID: string ): Promise<IssuedTokens | null> {
        const safeDeviceID: string = this.normalizeDeviceId( deviceID );

        if ( !user?.username || !safeDeviceID ) {
            return null;
        }

        const modelUser: IUser | null = await UserModel
            .findOne( { username: user.username } )
            .exec();

        if ( !modelUser ) {
            return null;
        }

        const userId = modelUser._id;

        const sessionToken: string = this.generateToken();
        const guardToken: string = this.generateToken();

        const expiresAt: Date = this.computeSessionExpiry();
        const now: Date = new Date();

        // IMPORTANT:
        //   - Match by (userId + deviceID) so each device has its own row.
        await GuardTokenModel.findOneAndUpdate(
          {
              userId,
              deviceID: safeDeviceID
          },
          {
              userId,
              username: user.username,
              sessionToken,
              guardToken,
            deviceID: safeDeviceID,
              previousGuardToken: undefined,
              expiresAt,
              createdAt: now,
              updatedAt: now
          },
          {
              upsert: true,
              new: true,
              setDefaultsOnInsert: true
          }
      ).exec();

        return { sessionToken, guardToken, deviceID: safeDeviceID };
    }

  /**
   * getOrIssueForUser
   * -----------------
   * Preferred entry point for login (per device):
   *
   * 1) Try to find an existing GuardTokenDocument for this (userId, deviceID)
   *    where expiresAt > now (session still valid).
   * 2) If found → reuse sessionToken + guardToken.
   * 3) If not found → call issueForUser(user, deviceID).
   *
   * This gives "one stable session per device" instead of global per-user.
   */
    public async getOrIssueForUser( user: User, deviceID: string ): Promise<IssuedTokens | null> {
        const safeDeviceID: string = this.normalizeDeviceId( deviceID );

        if ( !user?.username || !safeDeviceID ) {
            return null;
        }

        const userModel: IUser | null = await UserModel
            .findOne( { username: user.username } )
            .exec();

        if ( !userModel ) {
            return null;
        }

        const now: Date = new Date();

        const existing: GuardTokenDocument | null = await GuardTokenModel
            .findOne( {
                userId: userModel._id,
              deviceID: safeDeviceID,
              expiresAt: { $gt: now }
          } )
          .exec();

        if ( existing ) {
            // Keep username snapshot in sync if user changed username.
            if ( existing.username !== user.username ) {
                existing.username = user.username;
                existing.updatedAt = new Date();
                await existing.save();
            }

          return {
              sessionToken: existing.sessionToken,
              guardToken: existing.guardToken,
              deviceID: existing.deviceID
          };
      }

        // No valid session for this device → issue fresh tokens.
        return this.issueForUser( user, safeDeviceID );
    }

    /* ───────────────────────── Rotation ──────────────────────────────── */

  /**
   * rotateGuardToken
   * ----------------
   * Changes only guardToken, keeps same sessionToken.
   *
   * Used by:
   *  - WebSocket layer every N seconds.
   *
   * NOTE:
   *  - This method is sessionToken-centric (per device), which is OK because
   *    each device stores its own unique sessionToken.
   */
    public async rotateGuardToken( sessionToken: string ): Promise<string | null> {
        if ( !sessionToken || !sessionToken.trim() ) {
            return null;
        }

        const trimmedSession = sessionToken.trim();
        const now: Date = new Date();

        const doc: GuardTokenDocument | null = await GuardTokenModel
            .findOne( {
              sessionToken: trimmedSession,
              expiresAt: { $gt: now }
          } )
          .exec();

        if ( !doc ) {
            // Session either not found or expired
            return null;
        }

        const newGuard: string = this.generateToken();

        doc.previousGuardToken = doc.guardToken;
        doc.guardToken = newGuard;
        doc.updatedAt = new Date();

        await doc.save();

        return newGuard;
    }

    /* ───────────────────────── Resolution ────────────────────────────── */

    /**
     * resolveUserFromTokens
     * ---------------------
     * Given a main sessionToken and a guardToken, returns the User if:
     *  - sessionToken exists and is not expired.
     *  - guardToken matches current OR previous guard token (overlap window).
     *
     * Used by:
     *  - ApiGuard (HTTP requests) to authenticate + authorise users.
     */
    public async resolveUserFromTokens(
        sessionToken: string,
        guardToken: string
    ): Promise<User | null> {
        if (
            !sessionToken ||
            !sessionToken.trim() ||
            !guardToken ||
            !guardToken.trim()
        ) {
            return null;
        }

        const now: Date = new Date();

        const doc: GuardTokenDocument | null = await GuardTokenModel
            .findOne( {
                sessionToken: sessionToken.trim(),
                expiresAt: { $gt: now }
            } )
            .exec();

        if ( !doc ) {
            return null;
        }

        const trimmedGuard = guardToken.trim();

        const matchesCurrent: boolean = doc.guardToken === trimmedGuard;
        const matchesPrevious: boolean =
            typeof doc.previousGuardToken === 'string' &&
            doc.previousGuardToken === trimmedGuard;

        if ( !matchesCurrent && !matchesPrevious ) {
            // guardToken is outside the overlap window
            return null;
        }

        const user: IUser | null = await UserModel.findById( doc.userId ).exec();
        if ( !user ) {
            return null;
        }

        return user.toSafeDTO();
    }

    /**
     * resolveUserBySessionToken
     * -------------------------
     * Resolve user from sessionToken only.
     *
     * Used by:
     *  - Socket.IO handshake (SocketServer): we authenticate the socket
     *    based on a valid sessionToken, then guardToken rotation is handled
     *    separately via WebSocket (BE → FE).
     */
    public async resolveUserBySessionToken(
        sessionToken: string
    ): Promise<User | null> {
        if ( !sessionToken || !sessionToken.trim() ) {
            return null;
        }

        const now: Date = new Date();

        const doc: GuardTokenDocument | null = await GuardTokenModel
            .findOne( {
                sessionToken: sessionToken.trim(),
                expiresAt: { $gt: now }
            } )
            .exec();

        if ( !doc ) {
            return null;
        }

        const user: User | null = await UserModel.findById( doc.userId ).exec();
        return user;
    }

    /* ───────────────────────── Revocation / cleanup ──────────────────── */

  /**
   * revokeForUser
   * -------------
   * Completely remove all sessions for a given user (global logout from all devices).
   */
    public async revokeForUser( userId: Types.ObjectId ): Promise<void> {
        await GuardTokenModel.deleteMany( { userId } ).exec();
    }

    /**
     * revokeBySessionToken
     * --------------------
     * Remove session by its token (device-specific logout).
     *
     * Used by:
     *  - /logout endpoint (AuthController) to invalidate current device only.
     */
    public async revokeBySessionToken( sessionToken: string ): Promise<void> {
        if ( !sessionToken || !sessionToken.trim() ) {
            return;
        }

        await GuardTokenModel.deleteOne( {
            sessionToken: sessionToken.trim()
        } ).exec();
    }

    /**
     * findBySessionToken
     * ------------------
     * Helper for diagnostics / admin tooling.
     */
    public async findBySessionToken(
        sessionToken: string
    ): Promise<GuardTokenDocument | null> {
        if ( !sessionToken || !sessionToken.trim() ) {
            return null;
        }

        try {
          const tokenDoc: GuardTokenDocument | null = await GuardTokenModel
              .findOne( { sessionToken: sessionToken.trim() } )
              .exec();

          return tokenDoc;
      } catch ( error ) {
            console.error(
                '[Error:] [GuardTokenService.findBySessionToken] error:\n',
                error,
                '\n'
            );
            return null;
        }
    }
}
