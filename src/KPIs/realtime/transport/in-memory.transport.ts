import type { IRealtimeTransport } from './realtime-transport.interface';
import type { RealtimeAck, RealtimeEventEnvelope } from '../contracts/realtime.contracts';
import type { RealtimeAudience } from '../types/realtime.types';
import { RealtimeEventSerializer } from '../core/realtime-event.serializer';

/**
 * InMemoryRealtimeTransport
 * - single-process event bus
 * - deterministic for unit tests
 *
 * IMPORTANT:
 * This is NOT a "message queue". If the process dies, messages are gone.
 * That’s fine for Phase-1; later Redis replaces this without touching KPI logic.
 */
export class InMemoryRealtimeTransport implements IRealtimeTransport {
  private readonly serializer: RealtimeEventSerializer;
  private readonly listeners: Map<string, Set<(raw: string) => void>>;

  public constructor() {
    this.serializer = new RealtimeEventSerializer();
    this.listeners = new Map<string, Set<(raw: string) => void>>();
  }

  public async publish<T>(envelope: RealtimeEventEnvelope<T>): Promise<RealtimeAck> {
    const raw: string = this.serializer.serialize(envelope);

    // Fan-out: event may target multiple audiences
    for (const audience of envelope.audiences) {
      const key: string = this.audienceKey(audience);
      const handlers: Set<(raw: string) => void> | undefined = this.listeners.get(key);

      if (!handlers || handlers.size === 0) continue;

      // Teaching note:
      // We execute handlers synchronously for predictability.
      // If you want isolation, wrap in queueMicrotask / setImmediate.
      for (const handler of handlers) {
        try {
          handler(raw);
        } catch {
          // Transport should not crash the publisher.
          // Real logging will be added via your kernel logger later.
        }
      }
    }

    return { accepted: true };
  }

  public subscribe(audience: RealtimeAudience, handler: (raw: string) => void): void {
    const key: string = this.audienceKey(audience);

    let set: Set<(raw: string) => void> | undefined = this.listeners.get(key);
    if (!set) {
      set = new Set<(raw: string) => void>();
      this.listeners.set(key, set);
    }
    set.add(handler);
  }

  public unsubscribe(audience: RealtimeAudience, handler: (raw: string) => void): void {
    const key: string = this.audienceKey(audience);
    const set: Set<(raw: string) => void> | undefined = this.listeners.get(key);
    if (!set) return;

    set.delete(handler);
    if (set.size === 0) this.listeners.delete(key);
  }

  public clearAll(): void {
    this.listeners.clear();
  }

  private audienceKey(audience: RealtimeAudience): string {
    // Room key format is stable across transports:
    //  aud.branch.<id>
    //  aud.team.<id>
    //  aud.org.org
    return `aud.${audience.kind}.${audience.id}`;
  }
}
