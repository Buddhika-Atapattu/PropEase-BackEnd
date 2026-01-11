# Realtime adapters (future)

This folder will contain transport adapters, e.g.

- socket-io.transport.ts
- redis-pubsub.transport.ts

Rule:
KPI domain code must NEVER import Socket.IO or Redis directly.
Only the adapter implements `IRealtimeTransport`.
