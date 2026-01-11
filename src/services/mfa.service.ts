// Path: src/services/mfa.service.ts
// ============================================================================
// MFA Service
// ----------------------------------------------------------------------------
// Responsibilities:
//   - Create pairing records for a user and generate TOTP secrets / otpauth URI
//   - Confirm pairing (device + platform) and enable multi-auth for user
//   - Deactivate multi-auth (clear secret, flags, and pairing records)
//   - Get pairing status (pending / confirmed / expired / not_found)
//   - Verify initial pairing code (pairingToken + TOTP code)
//   - Verify user TOTP code by username
//
// NOTES:
//   - All crypto / TOTP logic is here, controllers only orchestrate HTTP.
//   - Throws in some methods (createPairingForUser, confirmPairing) and uses
//     try/catch with null-return in others; controllers must handle null safely.
// ============================================================================

import { randomBytes } from 'crypto';
import { Types } from 'mongoose';
import { authenticator } from 'otplib';

import {
  UserModel,
  User,
  IUser,
} from '../models/user.model';
import {
  MfaPairingModel,
  type MfaPairingDocument,
} from '../models/mfa/mfa-pairing.model';
import { MfaLoginChallengeModel, type MfaLoginChallengeDocument } from '../models/mfa/mfa-login-challenge.model';

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export interface MfaPairingPayload {
  pairingToken: string;
  expiresAt: Date;
  uri: string;          // TOTP otpauth:// URI to encode into QR
}

export type MfaPairingStatus = 'pending' | 'confirmed' | 'expired' | 'not_found';

// ──────────────────────────────────────────────────────────────────────────────
// Service
// ──────────────────────────────────────────────────────────────────────────────

export class MfaService {
  private readonly issuer: string = 'PropEase';

  // ────────────────────────────────────────────────────────────────────────────
  // Helpers
  // ────────────────────────────────────────────────────────────────────────────

  private sanitizeString( value: unknown ): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  private getNow(): Date {
    return new Date();
  }

  private generateRandomToken( bytes: number = 32 ): string {
    return randomBytes( bytes ).toString( 'hex' );
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Pairing creation + confirmation
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Creates a new pairing for a given user:
   *  - Deletes any previous unconfirmed pairings for that user
   *  - Generates a new TOTP secret
   *  - Generates a random pairingToken (short-lived, separate from TOTP code)
   *  - Stores TOTP secret on user (multiAuthSecret)
   *  - Returns payload with pairingToken + otpauth URI
   */
  public async createPairingForUser( user: IUser ): Promise<MfaPairingPayload> {
    const userId: Types.ObjectId = user._id;
    const username: string = user.username;

    // 1) Clean old pending pairings
    await MfaPairingModel.deleteMany( {
      userId,
      confirmed: false,
    } ).exec();

    // 2) Generate TOTP secret (Base32) – shared with authenticator app
    const totpSecret: string = authenticator.generateSecret();

    // 3) Generate short-lived pairing token (separate from TOTP)
    const pairingToken: string = randomBytes( 24 ).toString( 'hex' );
    const expiresAt: Date = new Date( Date.now() + 5 * 60 * 1000 ); // 5 minutes

    // 4) Build standard otpauth:// URI for Authenticator apps
    const otpauthUri: string = authenticator.keyuri( username, this.issuer, totpSecret );

    // 5) Persist pairing + secret in DB
    const doc: MfaPairingDocument = new MfaPairingModel( {
      userId,
      username,
      pairingToken,
      confirmed: false,
      expiresAt,
      multiAuthSecret: totpSecret,
    } );

    await doc.save();

    // 6) Also store the TOTP secret on the user for later verification
    // user.multiAuthSecret = totpSecret;
    // user.multiAuthEnabled = false;
    // await user.save();

    return {
      pairingToken,
      expiresAt,
      uri: otpauthUri, // this is what goes into the QR
    };
  }

  /**
   * Confirms a pairing using the pairingToken. If valid:
   *  - Marks the pairing as confirmed and stores device info (if provided)
   *  - Enables multi-auth on the user and copies pairing secret to user
   */
  public async confirmPairing(
    pairingToken: string,
    deviceName?: string,
    devicePlatform?: string,
  ): Promise<IUser | null> {
    // 1) Basic sanitisation
    const token: string = String( pairingToken ?? '' ).trim();
    if ( !token ) {
      return null;
    }

    const now: Date = this.getNow();

    // 2) Load pairing that is already OTP-confirmed and still valid
    const pairing: MfaPairingDocument | null = await MfaPairingModel.findOne( {
      pairingToken: token,
      confirmed: true,
      expiresAt: { $gt: now },
    } ).exec();

    if ( !pairing ) {
      return null;
    }

    // 3) Load user
    const userDoc: IUser | null = await UserModel.findById( pairing.userId ).exec();
    if ( !userDoc ) {
      return null;
    }

    // 4) Update pairing metadata (device info)
    if ( deviceName && deviceName.trim().length > 0 ) {
      pairing.deviceName = deviceName.trim();
    }
    if ( devicePlatform && devicePlatform.trim().length > 0 ) {
      pairing.devicePlatform = devicePlatform.trim();
    }
    // If schema uses timestamps, no need to manually touch updatedAt
    await pairing.save();

    // 5) Enable MFA on user
    userDoc.multiAuthEnabled = true;
    userDoc.multiAuthActivatedAt = now;
    userDoc.multiAuthSecret = pairing.multiAuthSecret;
    await userDoc.save();

    return userDoc;
  }


  // ────────────────────────────────────────────────────────────────────────────
  // Deactivate multi-auth
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Deactivates multi-auth for a given username:
   *  - Validates username
   *  - Clears user's MFA flags and secret
   *  - Deletes any pairing records for this user
   */
  public async deactivateMultiAuth( username: string ): Promise<IUser | null> {
    try {
      const safeUsername: string = this.sanitizeString( username );

      if ( !safeUsername ) {
        throw new Error( 'Invalid username.' );
      }

      // 1) Find the user
      const user: IUser | null = await UserModel.findOne( { username: safeUsername } ).exec();
      if ( !user ) {
        throw new Error( 'User not found.' );
      }

      // 2) Disable MFA data
      user.multiAuthEnabled = false;
      user.multiAuthActivatedAt = null;
      user.multiAuthSecret = null;

      // Optional: wipe out old pairing records
      await MfaPairingModel.deleteMany( { userId: user._id } ).exec();

      // 3) Save user
      await user.save();

      return user;
    } catch ( error ) {
      console.error( '[deactivateMultiAuth] error:', error );
      return null;
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Pairing status
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Returns status for a given pairingToken:
   *  - 'not_found'
   *  - 'expired'
   *  - 'confirmed'
   *  - 'pending'
   */
  public async getPairingStatus( pairingToken: string ): Promise<MfaPairingStatus> {
    const now: Date = this.getNow();

    const pairing: MfaPairingDocument | null = await MfaPairingModel.findOne( {
      pairingToken,
    } ).exec();

    if ( !pairing ) {
      return 'not_found';
    }

    if ( pairing.expiresAt <= now ) {
      return 'expired';
    }

    if ( pairing.confirmed ) {
      return 'confirmed';
    }

    return 'pending';
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Code verification
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * verifyInitial
   * -------------
   * Verifies the first TOTP code against the pairing's secret:
   *  - Confirms the pairing if the code is valid and not expired.
   *  - Returns the pairing document (controller will sanitize).
   */
  public async verifyInitial(
    pairingToken: string,
    code: string,
  ): Promise<MfaPairingDocument | null> {
    try {
      const safeCode: string = this.sanitizeString( code );
      if ( !safeCode ) {
        throw new Error( 'Invalid code.' );
      }

      const pairing: MfaPairingDocument | null = await MfaPairingModel.findOne( {
        pairingToken,
      } ).exec();

      if ( !pairing ) {
        throw new Error( 'Pairing not found.' );
      }

      const now: Date = this.getNow();
      if ( pairing.expiresAt <= now ) {
        throw new Error( 'Pairing expired.' );
      }

      if ( !pairing.multiAuthSecret ) {
        throw new Error( 'Pairing secret is missing.' );
      }

      const isConfirmed: boolean = authenticator.check(
        safeCode,
        pairing.multiAuthSecret,
      );

      if ( !isConfirmed ) {
        throw new Error( 'Code does not match.' );
      }

      pairing.confirmed = true;
      await pairing.save();

      return pairing;
    } catch ( error ) {
      console.error( '[verifyInitial] error:', error );
      return null;
    }
  }

  /**
   * verifyUser
   * ----------
   * Verifies a TOTP code against the user's stored multiAuthSecret:
   *  - Finds the user by username
   *  - Checks that multiAuthSecret exists
   *  - Validates the TOTP code
   */
  public async verifyUser( token: string, code: string ): Promise<IUser | null> {
    try {
      const safeToken: string = this.sanitizeString( token );
      const safeCode: string = this.sanitizeString( code );

      if ( !safeToken ) {
        throw new Error( 'Invalid username.' );
      }

      if ( !safeCode ) {
        throw new Error( 'Invalid code.' );
      }


      const tokenRes = await MfaLoginChallengeModel.findOne( { token: safeToken } );

      const username = tokenRes?.username;

      if ( !username ) {
        throw new Error( 'Invalid username!' );
      }

      const user: IUser | null = await UserModel.findOne( {
        username,
      } ).exec();

      if ( !user ) {
        throw new Error( 'User not found.' );
      }

      if ( !user.multiAuthSecret ) {
        throw new Error( 'Multi-auth secret is missing in user.' );
      }

      const isConfirmed: boolean = authenticator.check(
        safeCode,
        user.multiAuthSecret,
      );

      if ( !isConfirmed ) {
        throw new Error( 'Code does not match.' );
      }

      return user;
    } catch ( error ) {
      console.error( '[verifyUser] error:', error );
      return null;
    }
  }

  // ──────────────────────────────────────────────────────────
  //  Login MFA challenge (mfaToken after password login)
  //  - used during /auth/login + /mfa/user-verify
  // ──────────────────────────────────────────────────────────

  public async createLoginChallenge(
    user: IUser,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<MfaLoginChallengeDocument> {
    const now: Date = this.getNow();

    // cleanup old expired, unused for this user (optional)
    await MfaLoginChallengeModel.deleteMany( {
      userId: user._id,
      used: false,
      expiresAt: { $lte: now },
    } ).exec();

    const token: string = this.generateRandomToken( 32 );
    const expiresAt: Date = new Date( now.getTime() + 5 * 60_000 ); // 5 min

    const doc = new MfaLoginChallengeModel( {
      userId: user._id as Types.ObjectId,
      username: user.username,
      token,
      createdAt: now,
      expiresAt,
      used: false,
      ipAddress: ipAddress ?? undefined,
      userAgent: userAgent ?? undefined,
    } );

    await doc.save();
    return doc;
  }

  public async verifyLoginCodeWithToken(
    challengeToken: string,
    code: string,
  ): Promise<User | null> {
    const now: Date = this.getNow();

    const challenge: MfaLoginChallengeDocument | null =
      await MfaLoginChallengeModel.findOne( {
        token: challengeToken,
        used: false,
        expiresAt: { $gt: now },
      } ).exec();

    if ( !challenge ) {
      return null;
    }

    const user: IUser | null = await UserModel.findById( challenge.userId ).exec();
    if ( !user || !user.multiAuthEnabled || !user.multiAuthSecret ) {
      return null;
    }

    const trimmedCode: string = ( code || '' ).trim();
    if ( !trimmedCode ) {
      return null;
    }

    const isValid: boolean = authenticator.check(
      trimmedCode,
      user.multiAuthSecret,
    );

    if ( !isValid ) {
      return null;
    }

    challenge.used = true;
    challenge.usedAt = now;
    await challenge.save();

    return user.toSafeDTO();
  }

}
