// Path: src/KPIs/realtime/transport/socket-io.transport.ts

import type { IRealtimeTransport } from "./realtime-transport.interface";
import type { RealtimeAudience } from "../types/realtime.types";
import type { RealtimeAck, RealtimeEventEnvelope } from "../contracts/realtime.contracts";
import { RealtimeEventSerializer } from "../core/realtime-event.serializer";

// Minimal Socket.IO shape we need (keeps KPI layer transport-agnostic)
type SocketIoLike = {
  to: (room: string) => { emit: (event: string, payload: string) => void };
};

/**
 * SocketIoRealtimeTransport
 * - Implements IRealtimeTransport EXACTLY (same method signatures)
 * - Emits serialized envelope strings to Socket.IO rooms
 * - Also supports local in-process listeners (same pattern as InMemory transport)
 */
export class SocketIoRealtimeTransport implements IRealtimeTransport {
  private readonly io: SocketIoLike;
  private readonly eventName: string;

  private readonly serializer: RealtimeEventSerializer;

  // local in-process subscribers (server-side)
  private readonly listeners: Map<string, Set<(raw: string) => void>> = new Map();

  public constructor(io: SocketIoLike, eventName: string = "kpi") {
    this.io = io;
    this.eventName = eventName;
    this.serializer = new RealtimeEventSerializer();
  }

  public subscribe(audience: RealtimeAudience, handler: (raw: string) => void): void {
    const key = this.audienceKey(audience);

    if (!this.listeners.has(key)) {
      this.listeners.set(key, new Set());
    }

    this.listeners.get(key)!.add(handler);
  }

  public unsubscribe(audience: RealtimeAudience, handler: (raw: string) => void): void {
    const key = this.audienceKey(audience);
    const set = this.listeners.get(key);
    if (!set) return;

    set.delete(handler);

    if (set.size === 0) {
      this.listeners.delete(key);
    }
  }

  public clearAll(): void {
    this.listeners.clear();
  }

  public async publish<T>(envelope: RealtimeEventEnvelope<T>): Promise<RealtimeAck> {
    try {
      // ✅ correct: serializer is an instance (not static)
      const raw: string = this.serializer.serialize(envelope);

      const audiences: RealtimeAudience[] = Array.isArray(envelope.audiences)
        ? [ ...envelope.audiences ]
        : [];

      // (1) Local fanout (server-side handlers)
      for (const aud of audiences) {
        const key = this.audienceKey(aud);
        const set = this.listeners.get(key);
        if (!set || set.size === 0) continue;

        for (const fn of set) {
          try {
            fn(raw);
          } catch (err) {
            console.error("[Warning:] [SocketIoRealtimeTransport] local handler failed.\n", err);
          }
        }
      }

      // (2) Socket.IO fanout (frontend)
      for (const aud of audiences) {
        const room = this.audienceKey(aud);
        this.io.to(room).emit(this.eventName, raw);
      }

      return { accepted: true };
    } catch (err) {
      console.error("[Error:] [SocketIoRealtimeTransport] publish failed.\n", err);
      return {
        accepted: false,
        reason: (err as Error)?.message ?? "publish failed",
      };
    }
  }

  /**
   * Must match your in-memory transport strategy so behaviour stays consistent.
   * Current pattern used in your KPI layer: `aud.${kind}.${id}`
   */
  private audienceKey(audience: RealtimeAudience): string {
    return `aud.${audience.kind}.${audience.id}`;
  }
}
