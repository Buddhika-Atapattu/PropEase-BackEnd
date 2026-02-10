// ============================================================================
// Path: src/KPIs/realtime/runtime/kpi-realtime-bridge.service.ts
// ============================================================================
// KPI Realtime Bridge (SignalBus -> RealtimeHub)
// ----------------------------------------------------------------------------
// Why this class exists:
//   - REST ingestion MUST NOT talk to websocket/realtime directly.
//   - Instead: REST -> DB write -> SignalBus.publish(...)
//   - Bridge listens to signals and publishes realtime events.
//
// Phase-1 behavior (enterprise-safe):
//   - publish "scope invalidated" events (small payload) so UI can refetch.
//   - avoid expensive compute storms and large payload fan-outs.
//
// Phase-2 (optional):
//   - compute snapshots via KpiRegistry and push them as payloads.
// ============================================================================

import type { IKpiSignalBus, KpiSignalHandler } from '../../shared/kpi-signal-bus.interface';
import type { KpiSignalPayload } from '../../shared/kpi-signal.types';
import type { KpiScope as CoreScope, KpiDomain } from '../../shared/kpi-core.types';

import type { RealtimeEventEnvelope } from '../contracts/realtime.contracts';
import type { RealtimeAudience, RealtimeDeliveryHints } from '../types/realtime.types';

import { RealtimeHubService } from './realtime-hub.service';
import { RealtimeTopicBuilder } from '../core/realtime-topic.builder';
import { KpiRegistry } from '../../teamManagement/registry/kpi.registry';

interface KpiInvalidationPayload {
  kind: 'kpi_scope_invalidated';
  signal: KpiSignalPayload;
}

export class KpiRealtimeBridgeService {
  private readonly bus: IKpiSignalBus;
  private readonly hub: RealtimeHubService;
  private readonly topicBuilder: RealtimeTopicBuilder;
  private readonly registry: KpiRegistry;

  private handler: KpiSignalHandler | null;

  public constructor(
    bus: IKpiSignalBus,
    hub: RealtimeHubService,
    topicBuilder: RealtimeTopicBuilder,
    registry: KpiRegistry,
  ) {
    this.bus = bus;
    this.hub = hub;
    this.topicBuilder = topicBuilder;
    this.registry = registry;

    this.handler = null;
  }

  public start(): void {
    if (this.handler) return;

    this.handler = (payload) => this.onSignal(payload);
    this.bus.subscribe(this.handler);

    console.log('[Success:] [KPI Realtime] Bridge subscribed to KPI SignalBus.\n');
  }

  public stop(): void {
    if (!this.handler) return;

    this.bus.unsubscribe(this.handler);
    this.handler = null;

    console.log('[Info:] [KPI Realtime] Bridge unsubscribed from KPI SignalBus.\n');
  }

  // =========================================================================
  // Signal -> Realtime publish
  // =========================================================================
  private async onSignal(signal: KpiSignalPayload): Promise<void> {
    try {
      const audiences: ReadonlyArray<RealtimeAudience> = this.buildAudiences(signal);
      if (audiences.length === 0) return;

      const scopeForTopic = this.mapScopeForTopic(signal.scope, signal.domain);
      const topic = this.topicBuilder.buildKpiTopic(scopeForTopic, signal.targetId, 'signal', signal.type);

      const hints: RealtimeDeliveryHints = {
        allowCoalesce: true,
        dedupeKey: topic,
        priority: 'normal',
      };

      const payload: KpiInvalidationPayload = {
        kind: 'kpi_scope_invalidated',
        signal,
      };

      const envelope: RealtimeEventEnvelope<KpiInvalidationPayload> = {
        eventId: this.makeEventId(),
        topic,
        producer: { kind: 'system', principalId: 'kpi-runtime' },
        audiences,
        eventType: 'KPI_FACT_INGESTED',
        occurredAt: new Date().toISOString(),
        hints,
        payload,
      };

      await this.hub.publish(envelope);

      // Teaching note:
      // registry is not used in Phase-1; kept here because Phase-2 will use it
      // to compute snapshots before publishing.
      void this.registry;
    } catch (err) {
      console.log('[Error:] [KPI Realtime] Bridge failed while publishing.\n', err);
    }
  }

  // =========================================================================
  // Audience mapping (future: Socket.IO rooms)
  // =========================================================================
  private buildAudiences(signal: KpiSignalPayload): ReadonlyArray<RealtimeAudience> {
    const items: RealtimeAudience[] = [];

    // 1) Primary scope (always)
    items.push(this.scopeAudience(signal.scope, signal.targetId));

    // 2) Dimension hints (only when present)
    if (signal.orgId) items.push({ kind: 'org', id: signal.orgId });
    if (signal.branchId) items.push({ kind: 'branch', id: signal.branchId });
    if (signal.propertyId) items.push({ kind: 'property', id: signal.propertyId });
    if (signal.teamId) items.push({ kind: 'team', id: signal.teamId });
    if (signal.memberId) items.push({ kind: 'member', id: signal.memberId });

    return this.unique(items);
  }

  private scopeAudience(scope: CoreScope, id: string): RealtimeAudience {
    if (scope === 'org') return { kind: 'org', id };
    if (scope === 'branch') return { kind: 'branch', id };
    if (scope === 'property') return { kind: 'property', id };
    if (scope === 'team') return { kind: 'team', id };
    if (scope === 'member') return { kind: 'member', id };

    // region is not a realtime audience kind yet -> map to branch-like room
    if (scope === 'region') return { kind: 'branch', id };

    return { kind: 'org', id };
  }

  private unique(items: ReadonlyArray<RealtimeAudience>): ReadonlyArray<RealtimeAudience> {
    const seen = new Set<string>();
    const out: RealtimeAudience[] = [];

    for (const a of items) {
      const k = `${a.kind}:${a.id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(a);
    }
    return out;
  }

  // =========================================================================
  // Topic scope mapping
  // =========================================================================
  private mapScopeForTopic(scope: CoreScope, domain: KpiDomain): import('../types/realtime.types').KpiScope {
    // realtime.types.KpiScope includes 'maintenance' and 'organisation'
    if (scope === 'org') return 'organisation';
    if (scope === 'branch') return 'branch';
    if (scope === 'property') return 'property';
    if (scope === 'team') return 'team';
    if (scope === 'member') return 'member';

    // region not supported yet -> map as branch
    if (scope === 'region') return 'branch';

    // domain hint: if maintenance domain but org scope missing, still safe fallback
    if (domain === 'maintenance') return 'maintenance';

    return 'organisation';
  }

  private makeEventId(): string {
    return `evt_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }
}
