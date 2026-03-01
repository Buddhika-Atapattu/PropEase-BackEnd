// Path: src/services/recyclebin/recyclebin.socket.service.ts
// =============================================================================
// RecycleBinSocketService — WS Push Emitter (Recycle Bin) [ALIGNED + FIXED]
// -----------------------------------------------------------------------------
// ✅ Key fixes
// 1) Rooms: only user / role / team / company (NO aud.* prefix)
// 2) Uses AuthUserNormalized (common types)
// 3) Events are imported from single source of truth
// 4) Fixes "item shorthand property" issue by requiring options.item param
// 5) Emits rb:item using RecycleBinEvents.ITEM (not BULK)
// 6) exactOptionalPropertyTypes-safe (omit optionals, never pass undefined)
// =============================================================================

import type { SocketConnectionHandlerEmitter } from "../../socket/ws-emitter.provider";
import type { AuthUserNormalized } from "../../types/common";

import type {
  RecycleBinRecordResult,
  RecycleBinRestorePrepareDto,
  RecycleBinPurgeResult,
  RecycleBinListItemDto,
} from "../../types/recyclebin/recyclebin.types";

import {
  RecycleBinEvents,
  RecycleBinRooms,
  type RecycleBinSoftDeletedPayload,
  type RecycleBinRestoredPayload,
  type RecycleBinPermanentDeletedPayload,
  type RecycleBinCountPayload,
  type RecycleBinBulkPayload,
  type RecycleBinListItemPayload,
} from "../../socket/events/recyclebin/recyclebin.events";

// =============================================================================
// A) Audience contract (caller decides who receives)
// =============================================================================

export interface RecycleBinWsAudience {
  /**
   * @param usernames
   * - Emits to: user.<username>
   */
  usernames?: string[];

  /**
   * @param roles
   * - Emits to: role.<role>
   */
  roles?: string[];

  /**
   * @param teamCodes
   * - Emits to: team.<teamCode>
   */
  teamCodes?: string[];

  /**
   * @param company
   * - Emits to: company
   */
  company?: boolean;
}

// =============================================================================
// B) Socket service (Emitter-only)
// =============================================================================

export class RecycleBinSocketService {
  /**
   * 01) Why this class and for what
   * - Central push-emitter for recycle bin events.
   * - Prevents event name / room drift.
   *
   * 02) Param usage and purpose
   * @param connectionHandler
   * - Expected: SocketConnectionHandler emitter facade
   * - Purpose: room-based emitting
   *
   * 03) Usage hint
   * - Call AFTER DB/disk actions succeed.
   *
   * 04) Reason to use
   * - One place to enforce room taxonomy and payload shapes.
   *
   * 05) Avoid
   * - Do not emit snapshotData or secrets.
   *
   * 06) Result
   * - FE can refresh recycle bin list/badge smoothly.
   *
   * 07) Return pattern
   * - All methods return void.
   */
  public constructor(
    private readonly connectionHandler: SocketConnectionHandlerEmitter
  ) {}

  /** rb:soft-deleted */
  public emitSoftDeleted(options: {
    audience: RecycleBinWsAudience;
    sourceKey: string;
    refId: string;
    entryId: string;
    actor: AuthUserNormalized; // kept for caller context (not in payload)
    result?: RecycleBinRecordResult;
  }): void {
    const payload: RecycleBinSoftDeletedPayload = {
      sourceKey: options.sourceKey,
      refId: options.refId,
      entryId: options.entryId,
      ...(options.result ? { result: options.result } : {}),
    };

    this.emitToAudience(options.audience, RecycleBinEvents.SOFT_DELETED, payload);
  }

  /** rb:restored */
  public emitRestored(options: {
    audience: RecycleBinWsAudience;
    entryId: string;
    sourceKey: string;
    refId: string;
    actor: AuthUserNormalized;
    restoredRefId?: string;
    result?: RecycleBinRestorePrepareDto;
  }): void {
    const payload: RecycleBinRestoredPayload = {
      entryId: options.entryId,
      sourceKey: options.sourceKey,
      refId: options.refId,
      ...(options.restoredRefId ? { restoredRefId: options.restoredRefId } : {}),
      ...(options.result ? { result: options.result } : {}),
    };

    this.emitToAudience(options.audience, RecycleBinEvents.RESTORED, payload);
  }

  /** rb:permanent-deleted */
  public emitPermanentDeleted(options: {
    audience: RecycleBinWsAudience;
    entryId: string;
    sourceKey: string;
    refId: string;
    actor: AuthUserNormalized;
    result?: RecycleBinPurgeResult;
  }): void {
    const payload: RecycleBinPermanentDeletedPayload = {
      entryId: options.entryId,
      sourceKey: options.sourceKey,
      refId: options.refId,
      ...(options.result ? { result: options.result } : {}),
    };

    this.emitToAudience(
      options.audience,
      RecycleBinEvents.PERMANENT_DELETED,
      payload
    );
  }

  /** rb:count */
  public emitCount(options: {
    audience: RecycleBinWsAudience;
    total: number;
    actor: AuthUserNormalized;
  }): void {
    const payload: RecycleBinCountPayload = { total: options.total };
    this.emitToAudience(options.audience, RecycleBinEvents.COUNT, payload);
  }

  /** rb:bulk */
  public emitBulk(options: {
    audience: RecycleBinWsAudience;
    reason: RecycleBinBulkPayload["reason"];
    actor: AuthUserNormalized;
  }): void {
    const payload: RecycleBinBulkPayload = { reason: options.reason };
    this.emitToAudience(options.audience, RecycleBinEvents.BULK, payload);
  }

  /** rb:item (optional UX enhancer) */
  public emitItem(options: {
    audience: RecycleBinWsAudience;
    item: RecycleBinListItemDto;
    actor: AuthUserNormalized;
  }): void {
    const payload: RecycleBinListItemPayload = { item: options.item };
    this.emitToAudience(options.audience, RecycleBinEvents.ITEM, payload);
  }

  // =============================================================================
  // INTERNAL: emit to the only 4 allowed room families
  // =============================================================================

  private emitToAudience(
    audience: RecycleBinWsAudience,
    eventName: string,
    payload:
      | RecycleBinSoftDeletedPayload
      | RecycleBinRestoredPayload
      | RecycleBinPermanentDeletedPayload
      | RecycleBinCountPayload
      | RecycleBinBulkPayload
      | RecycleBinListItemPayload
  ): void {
    const usernames = this.uniqueNonEmpty(audience.usernames);
    const roles = this.uniqueNonEmpty(audience.roles);
    const teamCodes = this.uniqueNonEmpty(audience.teamCodes);

    for (const u of usernames) {
      this.connectionHandler.emitToRoom(RecycleBinRooms.user(u), eventName, payload);
    }

    for (const r of roles) {
      this.connectionHandler.emitToRoom(RecycleBinRooms.role(r), eventName, payload);
    }

    for (const t of teamCodes) {
      this.connectionHandler.emitToRoom(RecycleBinRooms.team(t), eventName, payload);
    }

    if (audience.company === true) {
      this.connectionHandler.emitToRoom(RecycleBinRooms.COMPANY, eventName, payload);
    }
  }

  private uniqueNonEmpty(values?: string[]): string[] {
    if (!values || values.length === 0) return [];
    const out: string[] = [];
    const seen = new Set<string>();

    for (const v of values) {
      const s = typeof v === "string" ? v.trim() : "";
      if (!s) continue;
      if (seen.has(s)) continue;
      seen.add(s);
      out.push(s);
    }

    return out;
  }
}