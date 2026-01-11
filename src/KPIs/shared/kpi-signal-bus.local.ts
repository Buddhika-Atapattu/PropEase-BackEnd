// ============================================================================
// Path: src/KPIs/shared/kpi-signal-bus.local.ts
// ============================================================================
// KPI Local Signal Bus
// ----------------------------------------------------------------------------
// Purpose:
//   Local in-process pub/sub.
//   Perfect for single-server deployment.
//   Later replace with Redis if multi-instance.
// ============================================================================

import { EventEmitter } from 'events';
import type { IKpiSignalBus, KpiSignalHandler } from './kpi-signal-bus.interface';
import type { KpiSignalPayload } from './kpi-signal.types';

export class KpiLocalSignalBus implements IKpiSignalBus {
  private readonly emitter: EventEmitter;
  private readonly handlers: Set<KpiSignalHandler>;
  private readonly eventName: string;

  public constructor() {
    this.emitter = new EventEmitter();
    this.handlers = new Set();
    this.eventName = 'kpi:signal';
  }

  public publish(payload: KpiSignalPayload): void {
    this.emitter.emit(this.eventName, payload);
  }

  public subscribe(handler: KpiSignalHandler): void {
    if (this.handlers.has(handler)) return;

    this.handlers.add(handler);
    this.emitter.on(this.eventName, handler);
  }

  public unsubscribe(handler: KpiSignalHandler): void {
    if (!this.handlers.has(handler)) return;

    this.handlers.delete(handler);
    this.emitter.off(this.eventName, handler);
  }
}
