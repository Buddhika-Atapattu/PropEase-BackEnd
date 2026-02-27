// Path: src/types/notification/notification.types.ts
// =============================================================================
// Notification Hub — Canonical Types (NO mongoose types)
// =============================================================================
//
// PURPOSE
// - This file is the CONTRACT for Notification Hub.
// - It must remain framework-agnostic:
//    ✅ NO mongoose types
//    ✅ NO express types
//    ✅ NO DB-specific shapes
//
// WHY THIS MATTERS
// - These types are shared across layers (controller/service/WS/frontend).
// - If we import mongoose types here, we couple the whole system to Mongo.
// - Enterprise rule: DTOs carry IDs as strings (ObjectId is DB internal).
// =============================================================================

import type { ISODateString } from "../common";
import type { Role } from "../roles";
import type { NotificationActionKey } from "./notification-action-keys.catalog";


/* =============================================================================
 * 01) Basic domain enums / unions
 * ========================================================================== */

export type NotificationSeverity = "info" | "success" | "warning" | "error";

export type NotificationCategory =
  | "User"
  | "Tenant"
  | "Property"
  | "Lease"
  | "Complaint"
  | "Payment"
  | "Team"
  | "Comment"
  | "System"
  | "Security"
  | "Audit";

/**
 * Optional audience filter (admin/tools).
 * NOTE: audiences is an array, query service must match on "n.audiences.mode".
 */
export interface NotificationLoadFilters {
  category?: NotificationCategory;
  severity?: NotificationSeverity;
  mode?: "User" | "Team" | "Company" | "Role";
  search?: string;
  from?: ISODateString;
  to?: ISODateString;
  unreadOnly?: boolean;
  includeDeleted?: boolean;
  includeArchived?: boolean;
}

/** ✅ Runtime enum lists used by WS/REST sanitizers (NO undefined values). */
export const NOTIFICATION_CATEGORY_VALUES = [
  "User",
  "Tenant",
  "Property",
  "Lease",
  "Complaint",
  "Payment",
  "Team",
  "Comment",
  "System",
  "Security",
  "Audit",
] as const satisfies readonly NotificationCategory[];

export const NOTIFICATION_SEVERITY_VALUES = [
  "info",
  "success",
  "warning",
  "error",
] as const satisfies readonly NotificationSeverity[];

export const NOTIFICATION_AUDIENCE_MODE_VALUES = [
  "User",
  "Team",
  "Company",
  "Role",
] as const satisfies readonly NonNullable<NotificationLoadFilters[ "mode" ]>[];
/**
 * EventKey is your "event identity".
 * - Enterprise recommended: bind this to NotificationActionKey (catalog) later
 *   once you migrate fully.
 * - For now keep string to avoid breaking old emitters.
 */
export type NotificationEventKey = NotificationActionKey;

/* =============================================================================
 * 02) Audience model (who should receive the notification)
 * ========================================================================== */

/**
 * Audience definition:
 * - Company: everyone
 * - Role   : users with a specific roleKey
 * - Team   : users under a teamCode
 * - User   : a specific user by username
 */
export type NotificationAudience =
  | { mode: "Company"; }
  | { mode: "Role"; roleKey: Role; }
  | { mode: "Team"; teamCode: string; }
  | { mode: "User"; username: string; };

/* =============================================================================
 * 03) Actor model (who triggered the event)
 * ========================================================================== */

/**
 * Actor identity used for audit.
 * Must NOT contain ObjectId types (keep as string).
 */
export interface NotificationActorDto {
  userId: string;
  username: string;
  role: string;

  /**
   * Optional scoping hints (useful for filtering/audit).
   * exactOptionalPropertyTypes-safe:
   * - omit these properties when absent (do not set undefined)
   */
  teamCodes?: string[];
  branchId?: string;
}

/* =============================================================================
 * 04) Target navigation model (what object does this notification refer to)
 * ========================================================================== */

/**
 * NotificationTarget:
 * - Used by frontend to open correct screen and load correct resource.
 *
 * NOTE
 * - "route" is legacy (path string).
 * - "actionKey" is the canonical enterprise navigation key.
 *   Example:
 *     actionKey = "user:account.created"
 *     params = { userId: "..." }
 */
export interface NotificationTarget {
  module?: string; // optional display grouping, e.g. "User Management"
  category?: string; // optional display grouping, e.g. "User"
  refId?: string; // usually the entity id

  /**
   * ⚠️ Legacy router string path (avoid in new code).
   * Keep only for fallback compatibility.
   */
  route?: string;

  /**
   * ✅ Canonical navigation key.
   * - Must exist in your NotificationActionKey catalog.
   * - Frontend will map actionKey -> route id/screen.
   */
  actionKey?: NotificationActionKey;

  /**
   * Runtime params for UI navigation.
   * Example:
   *  params: { userId: "..." }
   */
  params?: Record<string, unknown>;
}

/* =============================================================================
 * 05) Delivery switches (which channels to run)
 * ========================================================================== */

/**
 * Delivery channel enable switches.
 * - These are NOT "real provider" integrations.
 * - They decide which drivers should run for a notification.
 */
export interface NotificationDeliveryDrivers {
  audit: boolean;
  email: boolean;
  external: boolean;
  mq: boolean;
  push: boolean;
  sms: boolean;
}

/* =============================================================================
 * 06) Emit input (caller -> hub engine)
 * ========================================================================== */

/**
 * NotificationEmitInput
 * - Payload passed into NotificationHubEngineService.emit()
 *
 * CANONICAL RULE:
 * - "audiences" MUST be an array even when you have only one audience.
 */
export interface NotificationEmitInput {
  eventKey: NotificationEventKey;

  /**
   * ✅ Always array (even single audience)
   */
  audiences: NotificationAudience[];


  /**
   * ⚠️ TEMP LEGACY
   * - kept only as a runtime fallback for older emitters
   * - new code must not use it
   */
  audience?: NotificationAudience;

  actor: NotificationActorDto;

  target?: NotificationTarget;

  /**
   * Optional per-notification delivery switches.
   * - Hub engine should normalize defaults when missing.
   */
  delivery?: NotificationDeliveryDrivers;

  /**
   * Variables for message templating.
   * Example:
   *  vars: { username: "John", propertyId: "..." }
   */
  vars?: Record<string, unknown>;

  /**
   * Optional: allow emitter to override category/severity if needed.
   * Otherwise hub may compute defaults.
   */
  category?: NotificationCategory;
  severity?: NotificationSeverity;

  icon?: string;
  tags?: string[];
}




/* =============================================================================
 * 07) Core notification DTO (returned to UI)
 * ========================================================================== */

/**
 * NotificationCoreDto
 * - This is the "master notification content" returned to UI.
 * - Date values must be ISO strings.
 */
export interface NotificationCoreDto {
  id: string;

  eventKey: NotificationEventKey;
  category: NotificationCategory;
  severity: NotificationSeverity;

  title: string;
  body: string;

  icon?: string;
  tags?: string[];

  target?: NotificationTarget;

  actor: NotificationActorDto;

  /**
   * ✅ stored + returned as array
   */
  audiences: NotificationAudience[];

  createdAt: string;
  expiresAt?: string;
}

export interface NotificationUserStateDto {
  userId: string;
  username?: string;

  notificationId: string;

  isRead: boolean;
  readAt?: ISODateString;

  /**
   * Soft delete (trash)
   */
  isDeleted: boolean;
  deletedAt?: ISODateString;

  /**
   * Archive (hide without deleting)
   */
  isArchived: boolean;
  archivedAt?: ISODateString;

  deliveredAt: ISODateString;
  notification?: NotificationCoreDto;
}

/* =============================================================================
 * 08) Inbox item DTO (state + core content)
 * ========================================================================== */

/**
 * NotificationInboxItemDto
 * - Represents a row in the user's inbox list.
 * - State fields are flattened (no nested "state" object).
 *
 * IMPORTANT:
 * - userId is string (DTO contract)
 * - isDeleted refers to trash state (not archived)
 */
export interface NotificationInboxItemDto {
  inboxId: string;

  userId: string;
  username: string;

  isRead?: boolean;
  readAt?: string;

  isDeleted?: boolean;

  isArchived?: boolean;
  archivedAt?: string;
  deletedAt?: string;
  deliveredAt?: string;

  notification?: NotificationCoreDto;
}

/* =============================================================================
 * 09) Load / filter contracts
 * ========================================================================== */

export interface NotificationLoadRequest {
  username: string;
  page: number;
  limit: number;
  filters?: NotificationLoadFilters;
}

export interface NotificationLoadResponse {
  items: NotificationInboxItemDto[];
  other: { total: number; };
}

export interface NotificationCountResponse {
  total: number;
  unread: number;
  prioritized: number;
  unprioritized: number;
}


export interface NotificationTitleBodyPatch {
  title?: string;
  body?: string;
}