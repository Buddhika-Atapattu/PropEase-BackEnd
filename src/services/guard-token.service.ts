// Path: src/services/guard-token.service.ts

import { randomBytes } from 'crypto';
import { Types } from 'mongoose';

import {
  GuardTokenModel,
  type GuardTokenDocument,
} from '../models/guard.model';
import { UserModel, type IUser, type User } from '../models/user.model';

/* ============================================================================ *
 * Token lifetime & behaviour
 * ========================================================================== */

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Overlap window for previous guard token acceptance
const GUARD_OVERLAP_WINDOW_MS = 10_000;

// 32 bytes → 64 hex chars
const TOKEN_BYTES = 32;

/* ============================================================================ *
 * DTOs
 * ========================================================================== */

export interface IssuedTokens {
  sessionToken: string;
  guardToken: string;
  deviceID: string;
}

/* ============================================================================ *
 * GuardTokenService
 * ========================================================================== */

export class GuardTokenService {
  /* ───────────────────────── Private helpers ───────────────────────── */

  private generateToken(): string {
    return randomBytes( TOKEN_BYTES ).toString( 'hex' );
  }

  private computeSessionExpiry(): Date {
    return new Date( Date.now() + SESSION_TTL_MS );
  }

  private computePrevGuardExpiry( now = Date.now() ): Date {
    return new Date( now + GUARD_OVERLAP_WINDOW_MS );
  }

  private normalizeDeviceId( deviceID: string | null | undefined ): string {
    return String( deviceID ?? '' ).trim();
  }

  private isDbReady(): boolean {
    const rs = GuardTokenModel.db?.readyState;
    return rs === 1;
  }

  /* ───────────────────────── Issuing tokens ───────────────────────── */

  /**
   * Always issues fresh sessionToken + guardToken for a given user+device.
   * Overwrites any existing GuardTokenDocument for that (userId, deviceID).
   */
  public async issueForUser( user: User, deviceID: string ): Promise<IssuedTokens | null> {
    const safeDeviceID = this.normalizeDeviceId( deviceID );

    if ( !user?.username || !safeDeviceID ) return null;

    const modelUser: IUser | null = await UserModel
      .findOne( { username: user.username } )
      .exec();

    if ( !modelUser ) return null;

    const sessionToken = this.generateToken();
    const guardToken = this.generateToken();
    const expiresAt = this.computeSessionExpiry();

    // IMPORTANT:
    // - We clear previousGuardToken + expiry because this is a fresh issue
    // - We do NOT set createdAt/updatedAt manually (timestamps: true handles that)
    await GuardTokenModel.findOneAndUpdate(
      { userId: modelUser._id, deviceID: safeDeviceID },
      {
        userId: modelUser._id,
        username: user.username,
        sessionToken,
        guardToken,
        deviceID: safeDeviceID,
        previousGuardToken: undefined,
        previousGuardTokenExpiresAt: undefined,
        expiresAt,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).exec();

    return { sessionToken, guardToken, deviceID: safeDeviceID };
  }

  /**
   * Login-friendly:
   * - Reuse existing (userId + deviceID) row if not expired
   * - Else issue fresh
   */
  public async getOrIssueForUser( user: User, deviceID: string ): Promise<IssuedTokens | null> {
    const safeDeviceID = this.normalizeDeviceId( deviceID );
    if ( !user?.username || !safeDeviceID ) return null;

    const userModel: IUser | null = await UserModel
      .findOne( { username: user.username } )
      .exec();

    if ( !userModel ) return null;

    const now = new Date();

    const existing: GuardTokenDocument | null = await GuardTokenModel
      .findOne( {
        userId: userModel._id,
        deviceID: safeDeviceID,
        expiresAt: { $gt: now },
      } )
      .exec();

    if ( existing ) {
      // keep username snapshot synced if user renamed
      if ( existing.username !== user.username ) {
        existing.username = user.username;
        await existing.save();
      }

      return {
        sessionToken: existing.sessionToken,
        guardToken: existing.guardToken,
        deviceID: existing.deviceID,
      };
    }

    return this.issueForUser( user, safeDeviceID );
  }

  /* ───────────────────────── Rotation ───────────────────────── */

  /**
   * Rotate guardToken only, keep sessionToken.
   * Stores previousGuardToken with expiry window.
   */
  public async rotateGuardToken( sessionToken: string ): Promise<string | null> {
    const trimmedSession = String( sessionToken ?? '' ).trim();
    if ( !trimmedSession ) return null;

    if ( !this.isDbReady() ) return null;

    const now = new Date();

    const doc: GuardTokenDocument | null = await GuardTokenModel
      .findOne( {
        sessionToken: trimmedSession,
        expiresAt: { $gt: now },
      } )
      .exec();

    if ( !doc ) return null;

    const newGuard = this.generateToken();

    // Overlap logic:
    // - previous token remains valid ONLY until previousGuardTokenExpiresAt
    doc.previousGuardToken = doc.guardToken;
    doc.previousGuardTokenExpiresAt = this.computePrevGuardExpiry( Date.now() );

    doc.guardToken = newGuard;

    await doc.save();
    return newGuard;
  }

  /* ───────────────────────── Resolution ───────────────────────── */

  /**
   * Resolve user if:
   * - sessionToken exists and not expired
   * - guardToken matches current OR matches previous within overlap time window
   */
  public async resolveUserFromTokens( sessionToken: string, guardToken: string ): Promise<User | null> {
    const st = String( sessionToken ?? '' ).trim();
    const gt = String( guardToken ?? '' ).trim();
    if ( !st || !gt ) return null;

    const now = new Date();

    const doc: GuardTokenDocument | null = await GuardTokenModel
      .findOne( {
        sessionToken: st,
        expiresAt: { $gt: now },
      } )
      .exec();

    if ( !doc ) return null;

    // 1) Current guard token match
    if ( doc.guardToken === gt ) {
      const user = await UserModel.findById( doc.userId ).exec();
      return user ? user.toSafeDTO() : null;
    }

    // 2) Previous guard token match WITH expiry enforcement
    const prev = typeof doc.previousGuardToken === 'string' ? doc.previousGuardToken : '';
    if ( prev && prev === gt ) {
      const prevExp = doc.previousGuardTokenExpiresAt instanceof Date
        ? doc.previousGuardTokenExpiresAt
        : null;

      // If no expiry stored -> treat as invalid (secure default)
      if ( !prevExp ) return null;

      // Must be within overlap window
      if ( prevExp.getTime() <= now.getTime() ) return null;

      const user = await UserModel.findById( doc.userId ).exec();
      return user ? user.toSafeDTO() : null;
    }

    return null;
  }

  /**
   * Resolve user from session token only (Socket handshake).
   */
  public async resolveUserBySessionToken( sessionToken: string ): Promise<User | null> {
    const st = String( sessionToken ?? '' ).trim();
    if ( !st ) return null;

    const now = new Date();

    const doc: GuardTokenDocument | null = await GuardTokenModel
      .findOne( {
        sessionToken: st,
        expiresAt: { $gt: now },
      } )
      .exec();

    if ( !doc ) return null;

    return await UserModel.findById( doc.userId ).exec();
  }

  /* ───────────────────────── Revocation / cleanup ──────────────────── */

  public async revokeForUser( userId: Types.ObjectId ): Promise<void> {
    await GuardTokenModel.deleteMany( { userId } ).exec();
  }

  public async revokeBySessionToken( sessionToken: string ): Promise<void> {
    const st = String( sessionToken ?? '' ).trim();
    if ( !st ) return;

    await GuardTokenModel.deleteOne( { sessionToken: st } ).exec();
  }

  public async findBySessionToken( sessionToken: string ): Promise<GuardTokenDocument | null> {
    const st = String( sessionToken ?? '' ).trim();
    if ( !st ) return null;

    try {
      return await GuardTokenModel.findOne( { sessionToken: st } ).exec();
    } catch ( error ) {
      console.error( '[Error:] [GuardTokenService.findBySessionToken] error:\n', error, '\n' );
      return null;
    }
  }
}
