// Path: src/services/ws-service/ws-security-event-logger.service.ts

import {
  WsSecurityEventModel,
  type IWsSecurityEvent,
  type WsSecurityEventType,
} from '../../models/ws-security-event.model';

export interface WsSecurityEventContext {
  eventType: WsSecurityEventType;

  username?: string | undefined;
  role?: string | undefined;

  sessionToken?: string | undefined;
  guardTokenId?: string | undefined;
  wsToken?: string | undefined;

  socketId?: string | undefined;
  ip?: string | undefined;
  userAgent?: string | undefined;

  reason?: string | undefined;
}

/**
 * WsSecurityEventLogger
 * ---------------------
 * Persists *important* WS security events into MongoDB.
 *
 * Safety features:
 *  - Throttling per (username + eventType) to avoid spamming DB when
 *    something noisy happens.
 */
class WsSecurityEventLogger {
  /** Minimum time between two logs for same (username + eventType) in ms. */
  private readonly minIntervalPerKeyMs: number = 5 * 60 * 1000; // 5 minutes

  /**
   * key → lastLoggedAtMs
   * key format: "<username>|<eventType>"
   * If username is missing, uses "anonymous".
   */
  private readonly lastLogByKey: Map<string, number> = new Map();

  public async log(ctx: WsSecurityEventContext): Promise<void> {
    try {
      const uname: string = (ctx.username || 'anonymous').trim() || 'anonymous';
      const key: string = `${uname}|${ctx.eventType}`;
      const now: number = Date.now();

      const last: number | undefined = this.lastLogByKey.get(key);

      // Throttle repeated logs for the same user + eventType.
      if (last && now - last < this.minIntervalPerKeyMs) {
        // Silently skip – we already logged this situation recently.
        return;
      }

      this.lastLogByKey.set(key, now);

      // Build doc without assigning `string | undefined` to fields.
      const doc: Partial<IWsSecurityEvent> = {
        eventType: ctx.eventType,
      };

      if (ctx.username) {
        doc.username = ctx.username;
      }

      if (ctx.role) {
        // cast only here – model expects Role|string
        doc.role = ctx.role as any;
      }

      if (ctx.sessionToken) {
        doc.sessionToken = ctx.sessionToken;
      }

      if (ctx.guardTokenId) {
        doc.guardTokenId = ctx.guardTokenId;
      }

      if (ctx.wsToken) {
        doc.wsToken = ctx.wsToken;
      }

      if (ctx.socketId) {
        doc.socketId = ctx.socketId;
      }

      if (ctx.ip) {
        doc.ip = ctx.ip;
      }

      if (ctx.userAgent) {
        doc.userAgent = ctx.userAgent;
      }

      if (ctx.reason) {
        doc.reason = ctx.reason;
      }

      await WsSecurityEventModel.create(doc);
    } catch (error) {
      console.error(
        '[Error:] [WsSecurityEventLogger] Failed to persist WS security event:\n',
        error,
        '\n',
      );
    }
  }
}

export const wsSecurityEventLogger = new WsSecurityEventLogger();
