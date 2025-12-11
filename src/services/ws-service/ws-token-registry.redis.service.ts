// Path: src/services/ws-service/ws-token-registry.redis.service.ts

import { randomBytes } from 'crypto';
import type { RedisClientType } from 'redis';
import type { WsTokenRecord, MfaStrength } from '../../types/ws-token.types';
import type { IUser } from '../../models/user.model';

/**
 * WsTokenRegistryRedis
 * --------------------
 * Redis-backed registry for short-lived, one-time WebSocket tokens.
 *
 * Key design:
 *   - Single token:  wst:<token>  → JSON(WsTokenRecord), TTL ~ 5 min
 *   - Session index: wst:s:<sessionId> → Set<token>  (for revoke-all-on-logout)
 *
 * Usage flow:
 *   1) After login + MFA: issueTokenForUser(...) → returns WsTokenRecord.
 *      FE receives wsToken and opens Socket.IO with it.
 *   2) Socket.IO auth middleware: consumeToken(token) → if valid, attach user.
 *      Token is one-time: removed from Redis on successful consume.
 *   3) On logout / forced logout: revokeAllForSession(sessionId).
 *   4) On ws-token rotation: rotateToken(sessionId) → new token, old ones revoked.
 */
export class WsTokenRegistryRedis {

  private readonly redis: RedisClientType;

  private readonly tokenPrefix: string = 'wst';     // single token key
  private readonly sessionPrefix: string = 'wst:s'; // per-session index key

  // Default TTL for a wsToken in seconds (e.g. 5 minutes)
  private readonly defaultTtlSeconds: number = 300;

  public constructor(redisClient: RedisClientType) {
    this.redis = redisClient;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Issue a new wsToken for a user/session after successful login + MFA.
   */
  public async issueTokenForUser(
    user: IUser,
    sessionId: string,
    mfaStrength: MfaStrength,
    ip?: string,
    userAgent?: string,
    ttlSeconds?: number
  ): Promise<WsTokenRecord> {
    return this.issueTokenInternal(
      String(user._id),
      user.username,
      String(sessionId),
      mfaStrength,
      ip,
      userAgent,
      ttlSeconds
    );
  }

  /**
   * Validate and consume a wsToken (one-time).
   * Returns WsTokenRecord if valid, otherwise null.
   * Token key is always removed on success/failure once fetched.
   */
  public async consumeToken(token: string): Promise<WsTokenRecord | null> {
    const safeToken: string = String(token ?? '').trim();

    if (!safeToken) {
      return null;
    }

    const tokenKey: string = this.buildTokenKey(safeToken);
    const serialized: string | null = await this.redis.get(tokenKey);

    if (!serialized) {
      // Not found or already expired at Redis level
      return null;
    }

    const record: WsTokenRecord | null = this.deserializeRecord(serialized);

    // Token is one-time; delete immediately (regardless of validity)
    await this.redis.del(tokenKey);

    if (!record) {
      return null;
    }

    const now: Date = new Date();

    // Handle expiry explicitly (TTL should normally enforce this, but double-check)
    if (record.expiresAt.getTime() <= now.getTime()) {
      if (record.sessionId) {
        const expiredSessionKey: string = this.buildSessionKey(record.sessionId);
        await this.redis.sRem(expiredSessionKey, safeToken);
      }
      return null;
    }

    // Mark as used for caller; we still keep the record in memory (not in Redis)
    record.usedAt = now;

    // Remove from session index as well
    if (record.sessionId) {
      const sessionKey: string = this.buildSessionKey(record.sessionId);
      await this.redis.sRem(sessionKey, safeToken);
    }

    return record;
  }

  /**
   * Rotate wsToken for a given HTTP session.
   *
   * Behaviour:
   *   - Looks up all tokens under the session index (wst:s:<sessionId>).
   *   - Cleans up any corrupted or expired token records.
   *   - Chooses the latest valid WsTokenRecord (by createdAt) as a snapshot.
   *   - Issues a new token with the same user/session/mfa/ip/userAgent context.
   *   - Revokes all previous tokens for that session (deletes keys + removes from set),
   *     except the newly issued one.
   *
   * Returns:
   *   - New WsTokenRecord if rotation succeeds.
   *   - null if sessionId is invalid or no valid tokens exist to rotate from.
   */
  public async rotateToken(sessionId: string, ttlSeconds?: number): Promise<WsTokenRecord | null> {
    const safeSessionId: string = String(sessionId ?? '').trim();

    if (!safeSessionId) {
      return null;
    }

    const sessionKey: string = this.buildSessionKey(safeSessionId);
    const tokens: string[] = await this.redis.sMembers(sessionKey);

    if (!tokens || tokens.length === 0) {
      // No tokens currently registered for this session
      return null;
    }

    const now: Date = new Date();
    let latestRecord: WsTokenRecord | null = null;

    // 1) Iterate over all tokens under the session index
    for (const token of tokens) {
      const tokenKey: string = this.buildTokenKey(token);
      const serialized: string | null = await this.redis.get(tokenKey);

      if (!serialized) {
        // Record missing in Redis → cleanup index
        await this.redis.sRem(sessionKey, token);
        continue;
      }

      const record: WsTokenRecord | null = this.deserializeRecord(serialized);

      if (!record) {
        // Corrupted JSON or incompatible structure → drop it
        await this.redis.del(tokenKey);
        await this.redis.sRem(sessionKey, token);
        continue;
      }

      // Expiry check (defensive; TTL should handle most cases)
      if (record.expiresAt.getTime() <= now.getTime()) {
        await this.redis.del(tokenKey);
        await this.redis.sRem(sessionKey, token);
        continue;
      }

      if (!latestRecord) {
        latestRecord = record;
        continue;
      }

      const createdCurrent: Date = new Date(record.createdAt);
      const createdLatest: Date = new Date(latestRecord.createdAt);

      if (createdCurrent.getTime() > createdLatest.getTime()) {
        latestRecord = record;
      }
    }

    if (!latestRecord) {
      // Nothing valid left to rotate from
      return null;
    }

    // 2) Determine TTL for the new token:
    //    Prefer remaining TTL of the latest token if Redis still tracks it.
    let effectiveTtlSeconds: number | undefined = ttlSeconds;

    try {
      const latestTokenKey: string = this.buildTokenKey(latestRecord.token);
      const remainingTtl: number = await this.redis.ttl(latestTokenKey); // -2: no key, -1: no TTL

      if (remainingTtl > 0) {
        effectiveTtlSeconds = remainingTtl;
      }
    } catch (error) {
      // If ttl() fails for some reason, we silently fall back to provided/default TTL.
      console.error('[Error:] [WsTokenRegistryRedis] Failed to read TTL for latest wsToken.\n', error);
    }

    // 3) Issue a fresh token with the same context (user, session, MFA, IP, UA)
    const newRecord: WsTokenRecord = await this.issueTokenInternal(
      latestRecord.userId,
      latestRecord.username,
      latestRecord.sessionId,
      latestRecord.mfaStrength,
      latestRecord.ip,
      latestRecord.userAgent,
      effectiveTtlSeconds
    );

    // 4) Revoke all previous tokens for this session except the new one
    await this.revokeOtherTokensForSession(safeSessionId, newRecord.token);

    return newRecord;
  }

  /**
   * Just read a token without consuming it.
   * Rarely needed, but useful for debugging.
   */
  public async getToken(token: string): Promise<WsTokenRecord | null> {
    const safeToken: string = String(token ?? '').trim();

    if (!safeToken) {
      return null;
    }

    const tokenKey: string = this.buildTokenKey(safeToken);
    const serialized: string | null = await this.redis.get(tokenKey);

    if (!serialized) {
      return null;
    }

    return this.deserializeRecord(serialized);
  }

  /**
   * Revoke a single token (e.g. suspicious activity).
   */
  public async revokeToken(token: string): Promise<void> {
    const safeToken: string = String(token ?? '').trim();

    if (!safeToken) {
      return;
    }

    const tokenKey: string = this.buildTokenKey(safeToken);
    await this.redis.del(tokenKey);
  }

  /**
   * Revoke all tokens belonging to a given HTTP session.
   * Use this on logout / session invalidation.
   */
  public async revokeAllForSession(sessionId: string): Promise<void> {
    const safeSessionId: string = String(sessionId ?? '').trim();

    if (!safeSessionId) {
      return;
    }

    const sessionKey: string = this.buildSessionKey(safeSessionId);
    const tokens: string[] = await this.redis.sMembers(sessionKey);

    if (tokens.length > 0) {
      const tokenKeys: string[] = tokens.map((t: string) => this.buildTokenKey(t));
      for (const key of tokenKeys) {
        await this.redis.del(key);
      }
    }

    await this.redis.del(sessionKey);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ──────────────────────────────────────────────────────────────────────────

  private buildTokenKey(token: string): string {
    return `${this.tokenPrefix}:${token}`;
  }

  private buildSessionKey(sessionId: string): string {
    return `${this.sessionPrefix}:${sessionId}`;
  }

  private toPositiveInt(value: number | undefined, fallback: number): number {
    if (!Number.isFinite(value as number)) {
      return fallback;
    }

    const n: number = Number(value);

    if (n <= 0) {
      return fallback;
    }

    return Math.floor(n);
  }

  /**
   * Core token issuance logic shared by:
   *   - issueTokenForUser()
   *   - rotateToken()
   */
  private async issueTokenInternal(
    userId: string,
    username: string,
    sessionId: string,
    mfaStrength: MfaStrength,
    ip?: string,
    userAgent?: string,
    ttlSeconds?: number
  ): Promise<WsTokenRecord> {
    const now: Date = new Date();
    const ttl: number = this.toPositiveInt(ttlSeconds, this.defaultTtlSeconds);
    const expiresAt: Date = new Date(now.getTime() + ttl * 1000);

    // 32 bytes → 64 char hex token
    const token: string = randomBytes(32).toString('hex');

    const record: WsTokenRecord = {
      token,
      userId,
      username,
      sessionId: String(sessionId),
      mfaStrength,
      createdAt: now,
      expiresAt,
      usedAt: null,
      ip,
      userAgent
    };

    const tokenKey: string = this.buildTokenKey(token);
    const sessionKey: string = this.buildSessionKey(sessionId);

    const serialized: string = this.serializeRecord(record);

    // Store token with TTL
    await this.redis.set(tokenKey, serialized, { EX: ttl });

    // Register token under session index for later revoke/rotation
    await this.redis.sAdd(sessionKey, token);
    // Let index live a bit longer than individual tokens
    await this.redis.expire(sessionKey, ttl * 2);

    return record;
  }

  /**
   * Revoke all tokens for a session, except the one we want to keep.
   * Used after issuing a fresh token via rotateToken().
   */
  private async revokeOtherTokensForSession(sessionId: string, keepToken: string): Promise<void> {
    const safeSessionId: string = String(sessionId ?? '').trim();

    if (!safeSessionId) {
      return;
    }

    const sessionKey: string = this.buildSessionKey(safeSessionId);
    const tokens: string[] = await this.redis.sMembers(sessionKey);

    if (!tokens || tokens.length === 0) {
      return;
    }

    for (const token of tokens) {
      if (token === keepToken) {
        continue;
      }

      const tokenKey: string = this.buildTokenKey(token);
      await this.redis.del(tokenKey);
      await this.redis.sRem(sessionKey, token);
    }
  }

  private serializeRecord(record: WsTokenRecord): string {
    return JSON.stringify({
      ...record,
      createdAt: record.createdAt.toISOString(),
      expiresAt: record.expiresAt.toISOString(),
      usedAt: record.usedAt ? record.usedAt.toISOString() : null
    });
  }

  private deserializeRecord(json: string): WsTokenRecord | null {
    try {
      const raw: unknown = JSON.parse(json);

      if (!raw || typeof raw !== 'object') {
        return null;
      }

      const obj: Record<string, unknown> = raw as Record<string, unknown>;

      const createdAtIso: string = String(obj.createdAt ?? '');
      const expiresAtIso: string = String(obj.expiresAt ?? '');
      const usedAtIso: string = String(obj.usedAt ?? '');

      const record: WsTokenRecord = {
        token: String(obj.token ?? ''),
        userId: String(obj.userId ?? ''),
        username: String(obj.username ?? ''),
        sessionId: String(obj.sessionId ?? ''),
        mfaStrength: (obj.mfaStrength as MfaStrength) ?? 'none',
        createdAt: createdAtIso ? new Date(createdAtIso) : new Date(),
        expiresAt: expiresAtIso ? new Date(expiresAtIso) : new Date(),
        usedAt: usedAtIso ? new Date(usedAtIso) : null,
        ip: obj.ip ? String(obj.ip) : undefined,
        userAgent: obj.userAgent ? String(obj.userAgent) : undefined
      };

      if (!record.token || !record.userId) {
        return null;
      }

      return record;
    } catch (error) {
      console.error('[Error:] [WsTokenRegistryRedis] Failed to parse record JSON.\n', error);
      return null;
    }
  }
}
