// Path: src/KPIs/realtime/transport/composite.transport.ts

import type { IRealtimeTransport } from "./realtime-transport.interface";
import type { RealtimeAudience } from "../types/realtime.types";
import type { RealtimeAck, RealtimeEventEnvelope } from "../contracts/realtime.contracts";

/**
 * CompositeRealtimeTransport
 * - Fan-out to multiple transports (InMemory + Socket.IO)
 * - Keeps your KPI runtime transport-agnostic
 */
export class CompositeRealtimeTransport implements IRealtimeTransport {
  private readonly transports: IRealtimeTransport[] = [];

  public constructor(initial: IRealtimeTransport[] = []) {
    this.transports = [ ...initial ];
  }

  public addTransport(transport: IRealtimeTransport): void {
    this.transports.push(transport);
  }

  public async publish<T>(envelope: RealtimeEventEnvelope<T>): Promise<RealtimeAck> {
    let acceptedAny = false;

    for (const t of this.transports) {
      try {
        const ack = await t.publish(envelope);
        if (ack.accepted) acceptedAny = true;
      } catch (err) {
        console.error("[Warning:] [CompositeRealtimeTransport] publish failed on a transport.\n", err);
      }
    }

    return { accepted: acceptedAny };
  }

  public subscribe(audience: RealtimeAudience, handler: (raw: string) => void): void {
    for (const t of this.transports) {
      try {
        t.subscribe(audience, handler);
      } catch (err) {
        console.error("[Warning:] [CompositeRealtimeTransport] subscribe failed on a transport.\n", err);
      }
    }
  }

  public unsubscribe(audience: RealtimeAudience, handler: (raw: string) => void): void {
    for (const t of this.transports) {
      try {
        t.unsubscribe(audience, handler);
      } catch (err) {
        console.error("[Warning:] [CompositeRealtimeTransport] unsubscribe failed on a transport.\n", err);
      }
    }
  }

  public clearAll(): void {
    for (const t of this.transports) {
      try {
        t.clearAll();
      } catch (err) {
        console.error("[Warning:] [CompositeRealtimeTransport] clearAll failed on a transport.\n", err);
      }
    }
  }
}
