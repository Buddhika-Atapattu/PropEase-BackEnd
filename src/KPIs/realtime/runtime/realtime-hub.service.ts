import type { RealtimeAck, RealtimeEventEnvelope, RealtimeSubscriptionRequest } from '../contracts/realtime.contracts';
import type { IRealtimeTransport } from '../transport/realtime-transport.interface';
import type { RealtimeAudience } from '../types/realtime.types';
import { RealtimeDeliveryGuard } from '../core/realtime-delivery.guard';
import { RealtimeRegistryService } from './realtime-registry.service';
import { RealtimeEventSerializer } from '../core/realtime-event.serializer';

/**
 * RealtimeHubService is the only class KPI domain should talk to.
 *
 * Responsibilities:
 * - validate envelope (guard)
 * - publish to transport
 * - manage subscriptions (registry + transport binding)
 *
 * NOTE:
 * We don’t expose Socket.IO or Redis here — this keeps coupling low.
 */
export class RealtimeHubService {
  private readonly guard: RealtimeDeliveryGuard;
  private readonly registry: RealtimeRegistryService;
  private readonly serializer: RealtimeEventSerializer;
  private readonly transport: IRealtimeTransport;

  public constructor(transport: IRealtimeTransport) {
    this.transport = transport;
    this.guard = new RealtimeDeliveryGuard();
    this.registry = new RealtimeRegistryService();
    this.serializer = new RealtimeEventSerializer();
  }

  public async publish<T>(envelope: RealtimeEventEnvelope<T>): Promise<RealtimeAck> {
    this.guard.assertPublishable(envelope);

    // Optional: transport-level coalescing can be implemented later
    // by using envelope.hints.allowCoalesce + envelope.hints.dedupeKey.
    return this.transport.publish(envelope);
  }

  /**
   * Subscription is a two-part concept:
   * 1) Registry: track principal -> audience bindings (future auth enforcement)
   * 2) Transport: attach handler to the audience key
   */
  public subscribe(
    req: RealtimeSubscriptionRequest,
    handler: (event: RealtimeEventEnvelope<unknown>) => void
  ): void {
    for (const audience of req.audiences) {
      this.registry.register(req.principal, audience);

      this.transport.subscribe(audience, (raw: string) => {
        // Teaching note:
        // Transport delivers strings (future Redis/pubsub). We decode here.
        const event: RealtimeEventEnvelope<unknown> = this.serializer.deserialize<unknown>(raw);

        // Future hook:
        // Here is where you can enforce "principal can receive this audience"
        // before calling handler(event).
        handler(event);
      });
    }
  }

  public unsubscribe(
    req: RealtimeSubscriptionRequest,
    handler: (event: RealtimeEventEnvelope<unknown>) => void
  ): void {
    // Teaching note:
    // We can’t reliably remove the exact transport handler unless we keep a mapping.
    // For Phase-1, we keep unsubscribe minimal: registry only.
    // When Socket.IO adapter is added, unsubscribe maps to socket.leave(room).
    for (const audience of req.audiences) {
      this.registry.unregister(req.principal, audience);
    }

    // handler param kept for API symmetry / future mapping.
    void handler;
  }

  public shutdown(): void {
    this.transport.clearAll();
  }
}
