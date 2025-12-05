// Path: src/services/guard-token.service.ts

import { randomBytes } from 'crypto';
import { Types } from 'mongoose';

import {
    GuardTokenModel,
    type GuardTokenDocument
} from '../models/guard.model';
import { UserModel, type IUser } from '../models/user.model';
import SocketServer from '../socket/socket'

/**
 * IssuedTokens
 * ------------
 * Tiny DTO representing:
 *  - sessionToken: 30-day stable token (stored in cookies, used by guard layer)
 *  - guardToken  : short-lived / rotating token (extra protection)
 */
export interface IssuedTokens {
    sessionToken: string;
    guardToken: string;
}

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
 *  - Revoke tokens on logout.
 */
export class GuardTokenService {

    /**
     * issueForUser
     * ------------
     * Always issues a fresh sessionToken + guardToken for the given user.
     * Overwrites any existing GuardTokenDocument for that user (upsert).
     */
    public async issueForUser( user: IUser ): Promise<IssuedTokens> {
        const userId: Types.ObjectId = user._id;
        const username: string = user.username;

        const sessionToken: string = randomBytes( 32 ).toString( 'hex' );
        const guardToken: string = randomBytes( 32 ).toString( 'hex' );

        const expiresAt: Date = new Date( Date.now() + 30 * 24 * 60 * 60 * 1000 ); // 30 days
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
     *    where expiresAt > now.
     * 2) If found → reuse sessionToken + guardToken.
     *    Also sync username if it changed.
     * 3) If not found → call issueForUser(user).
     */
    public async getOrIssueForUser( user: IUser ): Promise<IssuedTokens> {
        const now: Date = new Date();

        const existing: GuardTokenDocument | null = await GuardTokenModel
            .findOne( {
                userId: user._id,
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

    /**
     * rotateGuardToken
     * ----------------
     * Changes only guardToken, keeps same sessionToken.
     * Useful for your “every X seconds via WebSocket” idea.
     */
    public async rotateGuardToken( sessionToken: string ): Promise<string | null> {
        const doc: GuardTokenDocument | null = await GuardTokenModel
            .findOne( { sessionToken } )
            .exec();

        if ( !doc ) {
            return null;
        }

        const newGuard: string = randomBytes( 32 ).toString( 'hex' );

        doc.previousGuardToken = doc.guardToken;
        doc.guardToken = newGuard;
        doc.updatedAt = new Date();

        await doc.save();

        return newGuard;
    }

    /**
     * resolveUserFromTokens
     * ---------------------
     * Given a main sessionToken and a guardToken, returns the IUser if:
     *  - sessionToken exists and is not expired.
     *  - guardToken matches current or previous guard token (overlap window).
     */
    public async resolveUserFromTokens(
        sessionToken: string,
        guardToken: string
    ): Promise<IUser | null> {
        const now: Date = new Date();

        const doc: GuardTokenDocument | null = await GuardTokenModel
            .findOne( {
                sessionToken,
                expiresAt: { $gt: now }
            } )
            .exec();

        if ( !doc ) {
            return null;
        }

        const matchesCurrent: boolean = doc.guardToken === guardToken;
        const matchesPrevious: boolean =
            typeof doc.previousGuardToken === 'string' &&
            doc.previousGuardToken === guardToken;

        if ( !matchesCurrent && !matchesPrevious ) {
            return null;
        }

        const user: IUser | null = await UserModel.findById( doc.userId ).exec();
        return user;
    }

    /**
     * revokeForUser
     * -------------
     * Completely remove all sessions for a given user (global logout).
     */
    public async revokeForUser( userId: Types.ObjectId ): Promise<void> {
        await GuardTokenModel.deleteMany( { userId } ).exec();
    }

    /**
     * revokeBySessionToken
     * --------------------
     * Remove session by its token (device-specific logout).
     */
    public async revokeBySessionToken( sessionToken: string ): Promise<void> {
        await GuardTokenModel.deleteOne( { sessionToken } ).exec();
    }
}
