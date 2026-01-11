// ============================================================================
// Path: src/KPIs/shared/kpi-signal.types.ts
// ============================================================================
// KPI Signal Types
// ----------------------------------------------------------------------------
// Purpose:
//   When facts are inserted via REST, we emit a signal:
//     - "scope changed"
//   Then WS engine decides what to recompute/push.
//
// This avoids tight coupling:
//   REST does NOT call WS directly.
// ============================================================================

import type { KpiDomain, KpiScope } from './kpi-core.types';

export type KpiSignalType =
  | 'facts:deal:inserted'
  | 'facts:satisfaction:inserted'
  | 'facts:maintenance:event'
  | 'facts:team:task';

export interface KpiSignalPayload {
  type: KpiSignalType;

  domain: KpiDomain;
  scope: KpiScope;

  /**
   * The scope target that changed:
   * - scope=member => memberId
   * - scope=team   => teamId
   * - scope=org    => orgId
   * - scope=property => propertyId
   */
  targetId: string;

  /**
   * Additional dimension hints (optional)
   * (Helps downstream decide what else might be affected.)
   */
  orgId?: string;
  teamId?: string;
  memberId?: string;
  propertyId?: string;
  branchId?: string;
  regionId?: string;

  occurredAtISO: string;

  /**
   * Optional explanation for logs/debugging
   */
  reason?: string;
}
