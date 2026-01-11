// ============================================================================
// Path: src/KPIs/shared/kpi-signal-bus.interface.ts
// ============================================================================
// KPI Signal Bus Interface
// ----------------------------------------------------------------------------
// Purpose:
//   Define a small contract so we can swap implementations:
//     - Local EventEmitter (now)
//     - Redis PubSub (later, if you scale horizontally)
// ============================================================================

import type { KpiSignalPayload } from './kpi-signal.types';

export type KpiSignalHandler = (payload: KpiSignalPayload) => void | Promise<void>;

export interface IKpiSignalBus {
  publish(payload: KpiSignalPayload): void;
  subscribe(handler: KpiSignalHandler): void;
  unsubscribe(handler: KpiSignalHandler): void;
}
