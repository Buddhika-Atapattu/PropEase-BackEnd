import type { ISODateString } from "../../../types/common";
import type {
  NotificationInboxItemDto,
  NotificationCountResponse
} from "../../../types/notification/notification.types";

/** Event names (single source of truth) */
export class NotificationEvents {
  private constructor() {}

  public static readonly NEW = "notify:new";
  public static readonly PATCH = "notify:patch";
  public static readonly COUNT = "notify:count";
  public static readonly BULK = "notify:bulk";

  public static readonly DOMAIN_RESTORED = "notify:domain-restored";
  public static readonly DOMAIN_PURGED = "notify:domain-purged";
}

/** Rooms (single source of truth) */
export class NotificationRooms {
  private constructor() {}

  public static readonly COMPANY = "aud.company";

  public static user(username: string): string {
    return `aud.user.${String(username ?? "").trim()}`;
  }

  public static role(roleKey: string): string {
    return `aud.role.${String(roleKey ?? "").trim()}`;
  }

  public static team(teamCode: string): string {
    return `aud.team.${String(teamCode ?? "").trim()}`;
  }
}

/* =============================================================================
 * Payloads (MUST align to Notification Hub canonical DTOs)
 * ========================================================================== */

export interface NotifyNewPayload {
  item: NotificationInboxItemDto;
  count?: NotificationCountResponse;
}

export interface NotifyPatchPayload {
  inboxId: string;

  /**
   * Delta patch for state fields only.
   * Keep it minimal and DTO-safe.
   */
  patch: {
    isRead?: boolean;
    readAt?: ISODateString;

    isDeleted?: boolean;

    isArchived?: boolean;
    archivedAt?: ISODateString;
  };

  count?: NotificationCountResponse;
}

export type NotifyCountPayload = NotificationCountResponse;

export interface NotifyBulkPayload {
  reason: "bulk-update" | "server-sync" | "policy-change" | "unknown";
  count?: NotificationCountResponse;
}

/* =============================================================================
 * Optional RecycleBin integration payloads (keep DTO-safe)
 * ========================================================================== */

export interface DomainRestoredPayload {
  sourceKey: string;
  refId: string;
  restoredAt: ISODateString;
  restoredBy: { userId: string; username: string };
}

export interface DomainPurgedPayload {
  sourceKey: string;
  refId: string;
  purgedAt: ISODateString;
  purgedBy: { userId: string; username: string };
}