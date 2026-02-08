import type {
  IsoDateString,
  RealtimeAudience,
  RealtimeDeliveryHints,
  RealtimePrincipal,
  RealtimeTopic,
} from '../types/realtime.types';

/**
 * KPI Realtime event envelope.
 *
 * WHY ENVELOPE?
 * - You need consistent metadata across all KPI events
 * - You need traceability (requestId/correlationId)
 * - You need future Redis/pubsub compatibility (serialization-friendly)
 */
export interface RealtimeEventEnvelope<TPayload> {
  // Stable identity for tracing & dedupe
  eventId: string;

  // Topic is the routing key (similar to "exchange routing key" in AMQP)
  topic: RealtimeTopic;

  // Who produced it (system/service/user)
  producer: RealtimePrincipal;

  // Who should receive it (fan-out targets)
  audiences: ReadonlyArray<RealtimeAudience>;

  // Semantic type, useful for client-side handling
  eventType:
  | 'KPI_FACT_INGESTED'
  | 'KPI_PROJECTION_UPDATED'
  | 'KPI_ALERT_RAISED'
  | 'KPI_ALERT_RESOLVED'
  | 'KPI_SLA_BREACH'
  | 'KPI_TASK_DEADLINE_WARNING'
  | 'KPI_HEALTH'
  | 'CUSTOM';

  // Time metadata
  occurredAt: IsoDateString;

  // Optional tracing (set by your API gateway / middleware)
  correlationId?: string;
  requestId?: string;

  // Optional delivery tuning (transport may ignore)
  hints: RealtimeDeliveryHints;

  // Actual business payload (projection snapshot / alert / etc.)
  payload: TPayload;
}

/**
 * Minimal "ack" shape (useful when you add WebSocket).
 * In-memory transport doesn't need it, but contract is ready.
 */
export interface RealtimeAck {
  accepted: boolean;
  reason?: string;
}

/**
 * Subscription request.
 * In Socket.IO adapter later, this maps to "socket joins room(s)".
 */
export interface RealtimeSubscriptionRequest {
  principal: RealtimePrincipal;
  audiences: ReadonlyArray<RealtimeAudience>;
}


// ----------------------------------------------------------------------------
// Socket event names (single source of truth)
// ----------------------------------------------------------------------------
//
// Design rule:
// - Backend only EMITS KPI events on one event name: KPI_SOCKET_EVENTS.EVENT
// - Frontend can REQUEST subscriptions using KPI_SOCKET_EVENTS.SUBSCRIBE
// - Later we can support unsubscribe if needed
//
// Why constants?
// - Prevent mismatched strings between FE/BE
// - Makes refactors safe
//
export const KPI_SOCKET_EVENTS = {
  SUBSCRIBE: "kpi:subscribe",
  UNSUBSCRIBE: "kpi:unsubscribe",
  EVENT: "kpi:event",
} as const;

// Room naming convention (Socket.IO rooms)
// Example rooms:
//   kpi:aud:org:<orgId>
//   kpi:aud:team:<teamCode>
//   kpi:aud:user:<userId>
export const KPI_SOCKET_ROOMS = {
  ORG: ( orgId: string ) => `kpi:aud:org:${ orgId }`,
  TEAM: ( teamCode: string ) => `kpi:aud:team:${ teamCode }`,
  USER: ( userId: string ) => `kpi:aud:user:${ userId }`,
} as const;
