// Path: src/types/ws-token.types.ts

export type MfaStrength =
  | 'none'                // no MFA at all (not recommended for real users)
  | 'password_only'       // password login, MFA disabled for this account
  | 'password_plus_totp'; // password + TOTP (Google Authenticator style)

/**
 * WsTokenRecord
 * -------------
 * Stored in Redis as JSON + TTL.
 * Represents a one-time token used by FE to open a Socket.IO connection.
 */
export interface WsTokenRecord {
  token: string;       // random hex string sent to FE
  userId: string;      // Mongo _id as string
  username: string;    // snapshot for logs / debug
  sessionId: string;   // your HTTP session / access token id

  mfaStrength: MfaStrength;

  createdAt: Date;
  expiresAt: Date;
  usedAt?: Date | null;

  ip?: string | undefined;
  userAgent?: string | undefined;
}
