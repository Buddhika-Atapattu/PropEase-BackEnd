import type { RealtimeAck, RealtimeEventEnvelope } from '../contracts/realtime.contracts';
import type { RealtimeAudience } from '../types/realtime.types';

/**
 * Transport interface = your “plug point”.
 *
 * In-memory now:
 * - fast, single process
 *
 * Socket.IO later:
 * - deliver to rooms/users
 *
 * Redis pub/sub later:
 * - multi-instance fan-out
 */
export interface IRealtimeTransport {
  publish<T>(envelope: RealtimeEventEnvelope<T>): Promise<RealtimeAck>;

  /**
   * Register a handler for a given audience key.
   * This models a “room subscription” without exposing Socket.IO.
   */
  subscribe(audience: RealtimeAudience, handler: (raw: string) => void): void;

  unsubscribe(audience: RealtimeAudience, handler: (raw: string) => void): void;

  /**
   * For shutdowns/tests.
   */
  clearAll(): void;
}
