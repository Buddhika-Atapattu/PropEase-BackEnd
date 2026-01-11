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
