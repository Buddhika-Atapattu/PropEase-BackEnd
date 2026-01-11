import type { RealtimeEventEnvelope } from '../contracts/realtime.contracts';

/**
 * Serializer exists for 2 reasons:
 * 1) future Redis pub/sub requires string payloads
 * 2) hardening: validate shape before pushing to transport
 */
export class RealtimeEventSerializer {
  public serialize<T>(envelope: RealtimeEventEnvelope<T>): string {
    // Teaching note:
    // JSON serialization is the safest lowest-common-denominator format
    // across Node processes, Redis, WebSockets, etc.
    return JSON.stringify(envelope);
  }

  public deserialize<T>(raw: string): RealtimeEventEnvelope<T> {
    // If invalid JSON, let it throw -> caller decides how to handle
    return JSON.parse(raw) as RealtimeEventEnvelope<T>;
  }
}
