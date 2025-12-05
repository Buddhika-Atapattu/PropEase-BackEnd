// Path: src/services/mfa.service.ts

import { randomBytes } from 'crypto';
import { Types } from 'mongoose';

import { MfaPairingModel, type MfaPairingDocument } from '../models/mfa-pairing.model';
import { UserModel, type IUser } from '../models/user.model';

export interface MfaPairingPayload {
  pairingToken: string;
  expiresAt: Date;
  uri: string;          // String that will be encoded into QR
}

/**
 * MfaService
 * ----------
 * Handles:
 *   - Creating pairing records + QR payload for multi-auth.
 *   - Confirming pairing when the foreign app sends the token.
 */
export class MfaService {

  /**
   * createPairingForUser
   * --------------------
   * Generates a short-lived pairing token and creates a record.
   *
   * Flow:
   *   1) Clean up any previous unconfirmed pairings for the user.
   *   2) Generate random pairingToken.
   *   3) Set expiresAt ~ 5 minutes from now.
   *   4) Build a custom URI that your mobile app understands.
   */
  public async createPairingForUser(user: IUser): Promise<MfaPairingPayload> {
    const userId: Types.ObjectId = user._id;
    const username: string = user.username;

    // Remove old, unconfirmed pairings for this user (keep DB clean)
    await MfaPairingModel.deleteMany({
      userId,
      confirmed: false
    }).exec();

    const pairingToken: string = randomBytes(24).toString('hex');
    const expiresAt: Date = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

    const doc = new MfaPairingModel({
      userId,
      username,
      pairingToken,
      confirmed: false,
      expiresAt
    });

    await doc.save();

    // Build the URI that becomes the QR content.
    // Your foreign app can register a custom scheme "propease-mfa://"
    // and parse ?token=...&username=...
    const uri: string =
      `propease-mfa://pair?token=${ encodeURIComponent(pairingToken) }` +
      `&username=${ encodeURIComponent(username) }`;

    return {
      pairingToken,
      expiresAt,
      uri
    };
  }

  /**
   * confirmPairing
   * --------------
   * Foreign app calls this once QR is scanned and user approves on phone.
   *
   * If successful:
   *   - marks pairing as confirmed
   *   - enables multiAuth on user
   *   - optionally stores device metadata
   */
  public async confirmPairing(
    pairingToken: string,
    deviceName?: string,
    devicePlatform?: string
  ): Promise<IUser | null> {
    const now: Date = new Date();

    const pairing: MfaPairingDocument | null = await MfaPairingModel.findOne({
      pairingToken,
      confirmed: false,
      expiresAt: { $gt: now }
    }).exec();

    if (!pairing) {
      return null; // invalid / expired / already used
    }

    // Find user
    const user: IUser | null = await UserModel.findById(pairing.userId).exec();

    if (!user) {
      return null;
    }

    // Mark pairing as confirmed and attach device meta
    pairing.confirmed = true;
    if (deviceName) pairing.deviceName = deviceName;
    if (devicePlatform) pairing.devicePlatform = devicePlatform;
    pairing.updatedAt = new Date();
    await pairing.save();

    // Enable multi-auth on user
    (user as any).multiAuthEnabled = true;
    (user as any).multiAuthActivatedAt = new Date();

    await user.save();

    return user;
  }
}
