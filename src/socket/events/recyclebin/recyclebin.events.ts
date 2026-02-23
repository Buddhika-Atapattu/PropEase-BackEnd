// Path: src/socket/events/recyclebin/recyclebin.events.ts
// =============================================================================
// RecycleBin — WebSocket Events (SINGLE SOURCE OF TRUTH)
// -----------------------------------------------------------------------------
// ✅ This file is the ONLY place allowed to define:
//    - RecycleBin event names (stable taxonomy)
//    - Room naming conventions
//    - WS payload contracts
//
// SERVICES / GATEWAYS MUST import from this file.
// =============================================================================

import type {
  RecycleBinListItemDto,
  RecycleBinMeta,
  RecycleBinPermanentDeleteResult,
  RecycleBinRestoreResult,
  RecycleBinSoftDeleteResult,
} from "../../../types/recyclebin/recyclebin.types";

/* =============================================================================
 * A) Rooms (Stable Forever)
 * ========================================================================== */

export class RecycleBinRooms {
  private constructor() {}

  /**
   * Company-level room.
   * Use for admin recycle-bin dashboards (global view).
   */
  public static readonly COMPANY: string = "aud.company";

  /**
   * Role-level room.
   * Example: aud.role.Admin
   */
  public static role(roleKey: string): string {
    const r = typeof roleKey === "string" ? roleKey.trim() : "";
    return `aud.role.${r || "Unknown"}`;
  }

  /**
   * Team-level room.
   * Example: aud.team.TEAM001
   */
  public static team(teamCode: string): string {
    const t = typeof teamCode === "string" ? teamCode.trim() : "";
    return `aud.team.${t || "Unknown"}`;
  }

  /**
   * ✅ User-level room (PropEase standard)
   * Example: user:buddhika
   */
  public static user(username: string): string {
    const u = typeof username === "string" ? username.trim() : "";
    return `user:${u || "unknown"}`;
  }
}

/* =============================================================================
 * B) Event Names (Stable Taxonomy)
 * ========================================================================== */

export class RecycleBinEvents {
  private constructor() {}

  /**
   * Fired when an item is soft-deleted into recycle bin.
   * FE should:
   * - remove it from the original module list immediately
   * - optionally show a toast
   * - refresh recycle bin list/counts if user is on that module
   */
  public static readonly SOFT_DELETED: string = "rb:soft-deleted";

  /**
   * Fired when an item is restored from recycle bin.
   * FE should:
   * - refresh the original module list
   * - refresh recycle bin list/counts
   */
  public static readonly RESTORED: string = "rb:restored";

  /**
   * Fired when an item is permanently deleted.
   * FE should:
   * - remove it from recycle bin list immediately
   * - refresh recycle bin counts
   */
  public static readonly PERMANENT_DELETED: string = "rb:permanent-deleted";

  /**
   * Fired when recycle bin counts changed (total items).
   * (Unread concept does not apply here — use total only.)
   */
  public static readonly COUNT: string = "rb:count";

  /**
   * Fallback signal for “reload your recycle-bin view”.
   * Useful for bulk operations / maintenance jobs.
   */
  public static readonly BULK: string = "rb:bulk";
}

/* =============================================================================
 * C) Payload Contracts (WS Layer Only)
 * ========================================================================== */

/**
 * rb:soft-deleted
 */
export interface RecycleBinSoftDeletedPayload {
  sourceKey: string;
  refId: string;

  /**
   * DB entry id created for the recyclebin list
   */
  entryId: string;

  /**
   * Optional meta for UI preview (if you want to show immediate modal/toast)
   * NOTE: Meta includes _id as ObjectId in your types; when sending to FE,
   * always convert it to string at controller/gateway level.
   */
  meta?: RecycleBinMeta;

  /**
   * Result returned from engine (optional)
   */
  result?: RecycleBinSoftDeleteResult;
}

/**
 * rb:restored
 */
export interface RecycleBinRestoredPayload {
  entryId: string;
  sourceKey: string;
  refId: string;

  restoredRefId?: string;

  result?: RecycleBinRestoreResult;
}

/**
 * rb:permanent-deleted
 */
export interface RecycleBinPermanentDeletedPayload {
  entryId: string;
  sourceKey: string;
  refId: string;

  result?: RecycleBinPermanentDeleteResult;
}

/**
 * rb:count
 * The recycle bin module can show a small badge (total deleted items).
 */
export interface RecycleBinCountPayload {
  total: number;
}

/**
 * rb:bulk
 */
export interface RecycleBinBulkPayload {
  reason: "bulk-update" | "system-refresh" | "rebuild";
}

/**
 * Optional: server can push a single list item (for UI insert/remove).
 * This is not required, but useful for a smooth UX.
 */
export interface RecycleBinListItemPayload {
  item: RecycleBinListItemDto;
}
