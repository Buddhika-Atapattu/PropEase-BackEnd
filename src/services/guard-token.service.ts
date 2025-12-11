// Path: src/services/guard-token.service.ts

import { randomBytes } from 'crypto';
import { Types } from 'mongoose';

import {
    GuardTokenModel,
    type GuardTokenDocument
} from '../models/guard.model';
import { UserModel, type IUser, type User } from '../models/user.model';

/* ============================================================================
 *  Token lifetime & behaviour
 * ==========================================================================*/

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

/* ============================================================================
 *  DTOs
 * ==========================================================================*/

/**
 * IssuedTokens
 * ------------
 * Tiny DTO representing:
 *  - sessionToken: 30-day stable token (stored in cookies / headers)
 *  - guardToken  : short-lived / rotating token (extra protection)
 */
export interface IssuedTokens {
    sessionToken: string;
    guardToken: string;
}

/* ============================================================================
 *  GuardTokenService
 * ==========================================================================*/

/**
 * GuardTokenService
 * -----------------
 * Single responsibility: manage guard-token documents.
 *
 * Responsibilities:
 *  - Issue both session + guard tokens for a user.
 *  - Reuse existing valid session if available.
 *  - Rotate guard token (keep same session token).
 *  - Resolve user from (sessionToken, guardToken).
 *  - Resolve user from sessionToken only (for WebSocket handshake).
 *  - Revoke tokens on logout.
 *
 * IMPORTANT:
 *  - We deliberately do NOT swallow errors here. Controllers / guards
 *    are expected to wrap calls in try/catch and respond with proper
 *    API errors. This keeps debugging easier.
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

    /* ───────────────────────── Issuing tokens ────────────────────────── */

    /**
     * issueForUser
     * ------------
     * Always issues a fresh sessionToken + guardToken for the given user.
     * Overwrites any existing GuardTokenDocument for that user (upsert).
     *
     * Typical usage:
     *  - MFA-less login flows.
     *  - Forced re-login (e.g. admin revoke & re-issue).
     */
    public async issueForUser( user: User ): Promise<IssuedTokens | null> {

        const username: string = user.username;

        if ( !username ) {
            return null;
        }

        const modelUser: IUser | null = await UserModel.findOne( { username } ).exec();

        if ( !modelUser ) {
            return null;
        }

        const userId = modelUser._id;

        const sessionToken: string = this.generateToken();
        const guardToken: string = this.generateToken();

        const expiresAt: Date = this.computeSessionExpiry();
        const now: Date = new Date();

        await GuardTokenModel.findOneAndUpdate(
            { userId },
            {
                userId,
                username,
                sessionToken,
                guardToken,
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

        return { sessionToken, guardToken };
    }

    /**
     * getOrIssueForUser
     * -----------------
     * Preferred entry point for login:
     *
     * 1) Try to find an existing GuardTokenDocument for this user
     *    where expiresAt > now (session still valid).
     * 2) If found → reuse sessionToken + guardToken.
     *    Also sync username if it changed.
     * 3) If not found → call issueForUser(user).
     *
     * This keeps a single stable session per user (per device) instead of
     * spamming new rows on every login.
     */
    public async getOrIssueForUser( user: User ): Promise<IssuedTokens | null> {
        const now: Date = new Date();

        const userModel: IUser | null = await UserModel.findOne( { username: user.username } );

        if ( !userModel ) {
            return null;
        }

        const existing: GuardTokenDocument | null = await GuardTokenModel
            .findOne( {
                userId: userModel._id,
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
                guardToken: existing.guardToken
            };
        }

        // No valid session → issue fresh tokens.
        return this.issueForUser( user );
    }

    /* ───────────────────────── Rotation ──────────────────────────────── */

    /**
     * rotateGuardToken
     * ----------------
     * Changes only guardToken, keeps same sessionToken.
     *
     * Intended usage:
     *  - Called periodically from WebSocket lifecycle (e.g. every 5 seconds).
     *  - resolveUserFromTokens accepts BOTH current + previous guardToken,
     *    giving you ~ GUARD_OVERLAP_WINDOW_MS of overlap.
     *
     * NOTE:
     *  - If sessionToken is expired → returns null (caller should treat as
     *    “user logged out / session dead”).
     */
    public async rotateGuardToken( sessionToken: string ): Promise<string | null> {
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
     * Completely remove all sessions for a given user (global logout).
     *
     * Example usage:
     *  - Admin disables user.
     *  - Security incident → force logout from all devices.
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

    // Inside GuardTokenService class
    public async findBySessionToken( sessionToken: string ) {
        if ( !sessionToken || !sessionToken.trim() ) {
            return null;
        }

        try {
            const tokenDoc = await GuardTokenModel
                .findOne( { sessionToken: sessionToken.trim() } )
                .exec();

            return tokenDoc;
        } catch ( error ) {
            console.error( "[GuardTokenService.findBySessionToken] error:", error );
            return null;
        }
    }

}
