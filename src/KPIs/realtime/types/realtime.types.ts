/* eslint-disable @typescript-eslint/consistent-type-definitions */

/**
 * Realtime layer must be:
 * - Transport-agnostic (in-memory now, Socket.IO later, Redis pub/sub later)
 * - Strictly typed (exactOptionalPropertyTypes enabled)
 * - Class-based architecture (no free functions)
 */

export type IsoDateString = string;

export type KpiScope =
  | 'organisation'
  | 'branch'
  | 'property'
  | 'maintenance'
  | 'team'
  | 'member';

export type RealtimeTopic = string;

/**
 * Who is allowed to receive realtime?
 * We do NOT implement authentication here — we only carry identity claims
 * that your existing security layer can supply.
 */
export type RealtimePrincipalKind = 'system' | 'user' | 'service';

export interface RealtimePrincipal {
  kind: RealtimePrincipalKind;
  principalId: string; // userId | serviceId | "system"
  role?: string;       // optional because not always available
  branchId?: string;   // optional scoping hints
}

/**
 * A "target" is where we fan-out:
 * - socket room (later)
 * - userId (later)
 * - branchId (later)
 * - org-wide broadcast topic
 */
export type RealtimeAudienceKind =
  | 'org'
  | 'branch'
  | 'property'
  | 'team'
  | 'member'
  | 'user';

export interface RealtimeAudience {
  kind: RealtimeAudienceKind;
  id: string; // e.g., branchId, propertyId, teamId, memberId, userId, or "org"
}

/**
 * Delivery hints for transports (Socket / Redis / etc.)
 */
export interface RealtimeDeliveryHints {
  /**
   * If true, transport may drop older messages for the same "dedupeKey"
   * to avoid flooding clients (good for high-frequency KPI updates).
   */
  allowCoalesce: boolean;

  /**
   * Optional de-duplication key (e.g. "team:123:kpi:summary")
   * When allowCoalesce=true, transport can keep only the latest.
   */
  dedupeKey?: string;

  /**
   * Message priority hint (transport may ignore).
   */
  priority: 'low' | 'normal' | 'high';
}

// -----------------------------------------------------------------------------
// Realtime payload envelope + handler contracts
// -----------------------------------------------------------------------------

/**
 * Unified envelope for realtime KPI publishing.
 * Transport MUST NOT mutate this payload.
 */
export interface RealtimeEnvelope<TPayload = unknown> {
  topic: RealtimeTopic;

  /** KPI scope, used for routing + UI grouping */
  scope: KpiScope;

  /** Who should receive it (fan-out target) */
  audience: RealtimeAudience;

  /** Who produced it (optional, filled by your security layer/runtime) */
  principal?: RealtimePrincipal;

  /** When it was produced (ISO string) */
  publishedAt: IsoDateString;

  /** Data payload (KPI snapshot / delta / summary etc.) */
  payload: TPayload;

  /** Delivery hints for transports (optional) */
  hints?: RealtimeDeliveryHints;
}

/** Callback for subscribers (in-memory / internal observers). */
export type RealtimeHandler = ( envelope: RealtimeEnvelope ) => void;

/** Unsubscribe callback. */
export type RealtimeUnsubscribe = () => void;
