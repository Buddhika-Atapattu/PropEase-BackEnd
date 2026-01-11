import type { RealtimeEventEnvelope } from '../contracts/realtime.contracts';

/**
 * Central policy checks BEFORE transport:
 * - prevents "broadcast everything" mistakes
 * - enforces required metadata
 *
 * This is NOT auth. Auth lives in your security layer.
 * This is a safety guard for event publishing discipline.
 */
export class RealtimeDeliveryGuard {
  public assertPublishable<T>(envelope: RealtimeEventEnvelope<T>): void {
    if (!envelope.eventId || envelope.eventId.trim().length < 8) {
      throw new Error('RealtimeDeliveryGuard: eventId is required and must be at least 8 chars.');
    }

    if (!envelope.topic || envelope.topic.trim().length < 5) {
      throw new Error('RealtimeDeliveryGuard: topic is required.');
    }

    if (!envelope.producer || !envelope.producer.principalId) {
      throw new Error('RealtimeDeliveryGuard: producer is required.');
    }

    if (!envelope.audiences || envelope.audiences.length === 0) {
      // Teaching note:
      // Avoid silent “global broadcast”.
      // Force the publisher to explicitly define who should receive.
      throw new Error('RealtimeDeliveryGuard: audiences must be non-empty (no implicit broadcast).');
    }

    if (!envelope.occurredAt) {
      throw new Error('RealtimeDeliveryGuard: occurredAt is required.');
    }

    if (!envelope.hints) {
      throw new Error('RealtimeDeliveryGuard: hints are required.');
    }
  }
}
