// Path: src/KPIs/kpis.runtime.ts

import { KpiLocalSignalBus } from "./shared/kpi-signal-bus.local";
import type { IKpiSignalBus } from "./shared/kpi-signal-bus.interface";

import { InMemoryRealtimeTransport } from "./realtime/transport/in-memory.transport";
import { CompositeRealtimeTransport } from "./realtime/transport/composite.transport";
import { SocketIoRealtimeTransport } from "./realtime/transport/socket-io.transport";

import { RealtimeHubService } from "./realtime/runtime/realtime-hub.service";
import { RealtimeTopicBuilder } from "./realtime/core/realtime-topic.builder";

import { KpiRegistry } from "./registry/kpi.registry";
import { KpiRealtimeBridgeService } from "./realtime/runtime/kpi-realtime-bridge.service";

export class KpisRuntime {
  private static instance: KpisRuntime | null = null;

  public static getInstance(): KpisRuntime {
    if ( !KpisRuntime.instance ) {
      KpisRuntime.instance = new KpisRuntime();
    }
    return KpisRuntime.instance;
  }

  private readonly signalBus: IKpiSignalBus;

  // We keep ONE hub for lifetime; we extend transport underneath.
  private readonly transport: CompositeRealtimeTransport;
  private readonly realtimeHub: RealtimeHubService;

  private readonly topicBuilder: RealtimeTopicBuilder;
  private readonly registry: KpiRegistry;

  private bridge: KpiRealtimeBridgeService;

  private started: boolean;
  private socketRealtimeAttached: boolean;

  private constructor () {
    this.signalBus = new KpiLocalSignalBus();

    // Default: in-memory transport always available (safe for local runs/tests)
    this.transport = new CompositeRealtimeTransport( [
      new InMemoryRealtimeTransport(),
    ] );

    // Hub uses composite transport (can fan-out later to Socket.IO as well)
    this.realtimeHub = new RealtimeHubService( this.transport );

    this.topicBuilder = new RealtimeTopicBuilder();
    this.registry = new KpiRegistry();

    // Bridge wires KPI signals -> realtime hub publish
    this.bridge = new KpiRealtimeBridgeService(
      this.signalBus,
      this.realtimeHub,
      this.topicBuilder,
      this.registry
    );

    this.started = false;
    this.socketRealtimeAttached = false;
  }

  /**
   * Start KPI runtime (safe to call multiple times).
   * Uses current transport stack (in-memory by default).
   */
  public ensureStarted(): void {
    if ( this.started ) return;

    this.bridge.start();
    this.started = true;

    console.log( "[Success:] [KpisRuntime] KPI realtime bridge started.\n" );
  }

  /**
   * Attach Socket.IO realtime transport (WS-only).
   *
   * IMPORTANT:
   * - This does NOT replace the hub/bridge.
   * - It only adds another transport to the composite fan-out.
   * - Safe to call even AFTER ensureStarted().
   */
  public startRealtime( io: unknown ): void {
    if ( this.socketRealtimeAttached ) {
      // Still make sure runtime is started (idempotent)
      this.ensureStarted();
      return;
    }

    // Attach Socket.IO transport for frontend delivery
    const socketTransport: SocketIoRealtimeTransport = new SocketIoRealtimeTransport( io as any, "kpi" );
    this.transport.addTransport( socketTransport );

    this.socketRealtimeAttached = true;

    console.log( "[Info:] [KpisRuntime] Socket.IO realtime transport attached.\n" );

    // Start bridge if not started yet
    this.ensureStarted();
  }

  public getSignalBus(): IKpiSignalBus {
    return this.signalBus;
  }

  public getRealtimeHub(): RealtimeHubService {
    return this.realtimeHub;
  }
}
