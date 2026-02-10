// Path: src/socket/ws-emitter.interface.ts
// ============================================================================
// WsEmitter (Interface)
// ----------------------------------------------------------------------------
// PURPOSE
// - Decouple domain socket services from SocketConnectionHandler singleton.
// - Allow "NoopEmitter" when sockets are not bootstrapped yet (no runtime crash).
// ============================================================================

import type { Role } from "../types/roles";
import type { NotificationPayload } from "./socket-types.type";

export interface IWsEmitter {
  emitToRoom(room: string, event: string, payload: unknown): void;

  emitToRooms(room: string[], event: string, payload: unknown): void;

  emitToUser(username: string, event: string, payload: unknown): void;

  emitToRole(role: Role, event: string, payload: unknown): void;

  emitToTeamRooms( teamCode: string, event: string, payload: unknown ): void;

  emitNotification( notif: NotificationPayload ): void;

  
}
