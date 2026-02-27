// Path: src/services/notifications/delivery/notification-delivery.types.ts
// =============================================================================
// Notification Delivery — Types & Driver Contracts
// =============================================================================
//
// 01) Purpose of this code
// -----------------------------------------------------------------------------
// - Defines the delivery layer request/recipient/result contracts.
// - Defines the driver interface used by each channel (email/sms/push/mq/audit/external).
//
// 02) What this code is managing
// -----------------------------------------------------------------------------
// - NotificationDeliveryRequest   : what hub sends to delivery service
// - NotificationDeliveryRecipient : who to deliver to
// - NotificationDeliveryResult    : aggregated delivery results
// - NotificationDeliveryDriver    : strict driver interface contract
//
// 03) Key things this code highlights
// -----------------------------------------------------------------------------
// - Strict typing (no any)
// - exactOptionalPropertyTypes-safe: optional fields are truly optional (omit when not set)
// - Supports multi-channel delivery using `NotificationDeliveryDrivers` flags.
//
// 04) Need to keep in mind
// -----------------------------------------------------------------------------
// - Delivery runs AFTER hub persistence and inbox row creation.
// - Delivery should be best-effort (drivers should not crash hub).
// - Real SMS/Email/Push requires provider integration (Twilio/SMTP/FCM/etc).
// =============================================================================

import type {
  NotificationCoreDto,
  NotificationDeliveryDrivers,
} from "../../../types/notification/notification.types";



/* =============================================================================
 * A) Delivery enums
 * ========================================================================== */

export type DeliveryChannel = "email" | "sms" | "push" | "mq" | "audit" | "external";

export type DeliveryStatus = "delivered" | "failed" | "skipped";

/* =============================================================================
 * B) Recipient identity (what drivers can use)
 * ========================================================================== */

export interface NotificationDeliveryRecipient {
  /**
   * Primary identity currently used across the system.
   */
  username: string;

  /**
   * Useful for push tokens, external integrations, future preference systems.
   */
  userId?: string;

  /**
   * Optional contact points (future):
   * - Drivers may skip if these are missing.
   */
  email?: string;
  phoneE164?: string;
  pushTokens?: string[];
  role?: string;
}

/* =============================================================================
 * C) Delivery request (WHAT HUB SENDS)
 * ========================================================================== */

export interface NotificationDeliveryRequest {
  /**
   * Master notification id (notifications collection).
   */
  notificationId: string;

  /**
   * Canonical DTO that represents this notification.
   * - Safe to send to WS, email templates, MQ payload, etc.
   */
  notification: NotificationCoreDto;

  /**
   * Final resolved recipients (deduped).
   */
  recipients: NotificationDeliveryRecipient[];

  /**
   * Channel switches (audit/email/sms/push/mq/external)
   */
  drivers: NotificationDeliveryDrivers;

  /**
   * Optional correlation id (future observability).
   */
  requestId?: string;
}

/* =============================================================================
 * C.1) Context alias (backward-compatible)
 * ============================================================================
 * Why:
 * - Some drivers prefer the name "Context" because it represents runtime data
 *   given to a driver during a delivery attempt.
 * - Internally, it is exactly the same shape as NotificationDeliveryRequest.
 */
export type NotificationDeliveryContext = NotificationDeliveryRequest;

/* =============================================================================
 * D) Delivery results
 * ========================================================================== */

export interface DeliveryAttemptResult {
  channel: DeliveryChannel;
  status: DeliveryStatus;

  attempted: number;
  delivered: number;
  failed: number;

  /**
   * Optional diagnostics.
   * Keep short; detailed logs go to audit stream.
   */
  errorMessage?: string;
}

export interface NotificationDeliveryResult {
  notificationId: string;

  results: DeliveryAttemptResult[];

  notification?: NotificationCoreDto;
  notifications?: NotificationCoreDto[];

  other: {
    attemptedTotal: number;
    deliveredTotal: number;
    failedTotal: number;
  };
}

/* =============================================================================
 * E) Driver contract (single definition only)
 * ========================================================================== */

export interface NotificationDeliveryDriver {
  /**
   * 01) Why this method
   * - Each driver delivers to a specific channel (Email/SMS/Push/MQ/Audit/External).
   *
   * 02) How to use this method
   * - Called by NotificationDeliveryService when orchestration decides to run it.
   *
   * 03) Parameters and why
   * - req: includes notification + recipients + channel enable flags.
   *
   * 04) Return
   * - DeliveryAttemptResult describing what happened for this driver.
   */
  deliver(req: NotificationDeliveryRequest): Promise<DeliveryAttemptResult>;

  /**
   * Identify which channel this driver belongs to.
   */
  channel(): DeliveryChannel;

  /**
   * Config enable flag (global driver enable).
   * - Note: per-notification enable uses `req.drivers`
   */
  isEnabled(): boolean;
}
