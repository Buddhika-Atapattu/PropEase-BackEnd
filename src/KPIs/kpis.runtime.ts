import { KpiLocalSignalBus } from './shared/kpi-signal-bus.local';
import type { IKpiSignalBus } from './shared/kpi-signal-bus.interface';

import { InMemoryRealtimeTransport } from './realtime/transport/in-memory.transport';
import { RealtimeHubService } from './realtime/runtime/realtime-hub.service';
import { RealtimeTopicBuilder } from './realtime/core/realtime-topic.builder';

import { KpiRegistry } from './registry/kpi.registry';
import { KpiRealtimeBridgeService } from './realtime/runtime/kpi-realtime-bridge.service';

export class KpisRuntime {
  private static instance: KpisRuntime | null = null;

  public static getInstance(): KpisRuntime {
    if (!KpisRuntime.instance) {
      KpisRuntime.instance = new KpisRuntime();
    }
    return KpisRuntime.instance;
  }

  private readonly signalBus: IKpiSignalBus;
  private readonly realtimeHub: RealtimeHubService;
  private readonly topicBuilder: RealtimeTopicBuilder;
  private readonly registry: KpiRegistry;

  private readonly bridge: KpiRealtimeBridgeService;

  private started: boolean;

  private constructor() {
    this.signalBus = new KpiLocalSignalBus();

    const transport = new InMemoryRealtimeTransport();
    this.realtimeHub = new RealtimeHubService(transport);

    this.topicBuilder = new RealtimeTopicBuilder();
    this.registry = new KpiRegistry();

    this.bridge = new KpiRealtimeBridgeService(
      this.signalBus,
      this.realtimeHub,
      this.topicBuilder,
      this.registry
    );

    this.started = false;
  }

  public ensureStarted(): void {
    if (this.started) return;

    this.bridge.start();
    this.started = true;

    console.log('[Success:] [KPI Runtime] KPI realtime bridge started.\n');
  }

  public getSignalBus(): IKpiSignalBus {
    return this.signalBus;
  }

  public getRealtimeHub(): RealtimeHubService {
    return this.realtimeHub;
  }
}
