// Path: src/socket/events/recyclebin/recyclebin.events.ts
// =============================================================================
// RecycleBin — WebSocket Events (SINGLE SOURCE OF TRUTH)
// -----------------------------------------------------------------------------
// ✅ This file is the ONLY place allowed to define:
//    - Room naming conventions
//    - Event names (stable taxonomy)
//    - WS payload contracts
//
// ✅ Room rule (your rule — NO "aud." prefix):
//    - user.<username>
//    - role.<role>
//    - team.<teamCode>
//    - company
//
// SERVICES / GATEWAYS MUST import from this file.
// =============================================================================

import type {
  RecycleBinListItemDto,
  RecycleBinPurgeResult,
  RecycleBinRestorePrepareDto,
  RecycleBinRecordResult,
} from "../../../types/recyclebin/recyclebin.types";

import { SocketRooms } from "../rooms/socket.rooms";

/* =============================================================================
 * A) Rooms (Stable Forever)
 * ========================================================================== */

export class RecycleBinRooms {
  private constructor() {}

  /**
   * Why / for what
   * - Company-level room for global dashboards.
   *
   * Usage hint
   * - Use ONLY when controller confirms the actor has access to company-wide view.
   *
   * Avoid
   * - Do not emit to company for normal user-only operations.
   *
   * Result
   * - All clients joined to "company" can react (refresh list/badge).
   */
  public static readonly COMPANY: string = "company";

  /**
   * Why / for what
   * - Role-level audience.
   *
   * @param roleKey role identifier (e.g. "admin")
   *
   * Usage hint
   * - Emit when recycle bin operation affects a role-scoped dashboard.
   *
   * Avoid
   * - Avoid untrusted payload role strings; role must come from auth user context.
   *
   * Result
   * - Emits into: role.<role>
   */
  public static role(roleKey: string): string {
    const r = typeof roleKey === "string" ? roleKey.trim() : "";
    return SocketRooms.role(r.toLowerCase());
  }

  /**
   * Why / for what
   * - Team-level audience.
   *
   * @param teamCode team code (e.g. "TEAM001")
   *
   * Usage hint
   * - Emit for team dashboards / team recycle bin usage (if used).
   *
   * Avoid
   * - Avoid emitting team events if the module isn’t team-scoped.
   *
   * Result
   * - Emits into: team.<teamCode>
   */
  public static team(teamCode: string): string {
    const t = typeof teamCode === "string" ? teamCode.trim() : "";
    return SocketRooms.team(t);
  }

  /**
   * Why / for what
   * - User-level audience.
   *
   * @param username username (e.g. "buddhika")
   *
   * Usage hint
   * - Most safe default room for recycle operations.
   *
   * Avoid
   * - Do not trust username from payload; controller must use auth user.
   *
   * Result
   * - Emits into: user.<username>
   */
  public static user(username: string): string {
    const u = typeof username === "string" ? username.trim() : "";
    return SocketRooms.user(u);
  }
}

/* =============================================================================
 * B) Event Names (Stable Taxonomy)
 * ========================================================================== */

export class RecycleBinEvents {
  private constructor() {}

  /** Fired when an item is recorded (soft delete into recycle bin). */
  public static readonly SOFT_DELETED: string = "rb:soft-deleted";

  /** Fired when an item is restored (REAL restore complete). */
  public static readonly RESTORED: string = "rb:restored";

  /** Fired when an item is permanently deleted (purged). */
  public static readonly PERMANENT_DELETED: string = "rb:permanent-deleted";

  /** Fired when recycle bin total count changed (badge refresh). */
  public static readonly COUNT: string = "rb:count";

  /** Fallback signal for “reload recycle bin” (bulk changes / maintenance). */
  public static readonly BULK: string = "rb:bulk";

  /** Optional: push a single list item (UI insert/update without full reload). */
  public static readonly ITEM: string = "rb:item";
}

/* =============================================================================
 * C) Payload Contracts (WS Layer Only)
 * ========================================================================== */

/** rb:soft-deleted */
export interface RecycleBinSoftDeletedPayload {
  sourceKey: string;
  refId: string;
  entryId: string;
  result?: RecycleBinRecordResult;
}

/** rb:restored */
export interface RecycleBinRestoredPayload {
  entryId: string;
  sourceKey: string;
  refId: string;
  restoredRefId?: string;
  result?: RecycleBinRestorePrepareDto;
}

/** rb:permanent-deleted */
export interface RecycleBinPermanentDeletedPayload {
  entryId: string;
  sourceKey: string;
  refId: string;
  result?: RecycleBinPurgeResult;
}

/** rb:count */
export interface RecycleBinCountPayload {
  total: number;
}

/** rb:bulk */
export interface RecycleBinBulkPayload {
  reason: "bulk-update" | "system-refresh" | "rebuild";
}

/** rb:item */
export interface RecycleBinListItemPayload {
  item: RecycleBinListItemDto;
}