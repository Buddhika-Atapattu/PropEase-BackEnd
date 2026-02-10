// Path: src/socket/ws-emitter.provider.ts
// ============================================================================
// WsEmitterProvider (Singleton Provider) — PINNED / BOOT-ORDER SAFE
// ----------------------------------------------------------------------------
// PURPOSE
// - Domain services must NOT call SocketConnectionHandler.GetInstance().
// - They call WsEmitterProvider.Get() and emit safely.
// - Before sockets are ready -> NoopEmitter absorbs events (no runtime crash).
// - After sockets are ready  -> SocketBootstrap injects a real emitter.
//
// HOW TO USE (SocketBootstrap)
// - Once SocketConnectionHandler is initialized and ready:
//     WsEmitterProvider.Init(new SocketConnectionHandlerEmitter(SocketConnectionHandler.GetInstance()));
//
// IMPORTANT
// - Only bootstrap should touch SocketConnectionHandler singleton.
// - Domain code depends ONLY on IWsEmitter.
// ============================================================================

import type { Role } from "../types/roles";
import type { NotificationPayload } from "./socket-types.type";
import type { IWsEmitter } from "./ws-emitter.interface";
import { SocketConnectionHandler } from "./socket-connection.handler";

// ----------------------------------------------------------------------------
// 1) NoopEmitter — safe fallback before sockets are ready
// ----------------------------------------------------------------------------
class NoopEmitter implements IWsEmitter {
  public emitToRoom(_room: string, _event: string, _payload: unknown): void {
    // intentionally no-op
  }

  public emitToRooms(_rooms: string[], _event: string, _payload: unknown): void {
    // intentionally no-op
  }

  public emitToUser(_username: string, _event: string, _payload: unknown): void {
    // intentionally no-op
  }

  public emitToRole(_role: Role, _event: string, _payload: unknown): void {
    // intentionally no-op
  }

  public emitToTeamRooms(_teamCode: string, _event: string, _payload: unknown): void {
    // intentionally no-op
  }

  public emitNotification(_notif: NotificationPayload): void {
    // intentionally no-op
  }
}

// ----------------------------------------------------------------------------
// 2) Real emitter adapter — wraps SocketConnectionHandler behind IWsEmitter
// ----------------------------------------------------------------------------
export class SocketConnectionHandlerEmitter implements IWsEmitter {
  private readonly handler: SocketConnectionHandler;

  public constructor(handler: SocketConnectionHandler) {
    this.handler = handler;
  }

  public emitToRoom(room: string, event: string, payload: unknown): void {
    const safeRoom = this.safeStr(room);
    const safeEvent = this.safeStr(event);
    if (!safeRoom || !safeEvent) return;

    this.handler.emitToRoom(safeRoom, safeEvent, payload);
  }

  public emitToRooms(rooms: string[], event: string, payload: unknown): void {
    const safeEvent = this.safeStr(event);
    if (!safeEvent) return;

    const safeRooms = Array.isArray(rooms)
      ? rooms.map((r) => this.safeStr(r)).filter(Boolean)
      : [];

    if (safeRooms.length === 0) return;

    // We intentionally loop (instead of expecting handler-level batch API)
    // to keep IWsEmitter stable even if the handler API changes.
    for (const r of safeRooms) {
      this.handler.emitToRoom(r, safeEvent, payload);
    }
  }

  public emitToUser(username: string, event: string, payload: unknown): void {
    const safeUser = this.safeStr(username);
    const safeEvent = this.safeStr(event);
    if (!safeUser || !safeEvent) return;

    this.handler.emitToUser(safeUser, safeEvent, payload);
  }

  public emitToRole(role: Role, event: string, payload: unknown): void {
    const safeEvent = this.safeStr(event);
    if (!safeEvent) return;

    // Role is already typed; still guard against empty strings coming from casts.
    const safeRole = this.safeStr(role as unknown);
    if (!safeRole) return;

    this.handler.emitToRole(role, safeEvent, payload);
  }

  /**
   * Emits to both team room conventions:
   * - aud.team.<teamCode>  (your canonical audience room)
   * - team:<teamCode>      (optional conventional room)
   */
  public emitToTeamRooms(teamCode: string, event: string, payload: unknown): void {
    const safeTeam = this.safeStr(teamCode);
    const safeEvent = this.safeStr(event);
    if (!safeTeam || !safeEvent) return;

    this.handler.emitToRoom(`aud.team.${safeTeam}`, safeEvent, payload);
    this.handler.emitToRoom(`team:${safeTeam}`, safeEvent, payload);
  }

  /**
   * Notification helper (delegates to your SocketConnectionHandler implementation).
   * Assumption: handler has emitNotification(notif).
   * If your handler method name differs, change it here ONLY (domain stays stable).
   */
  public emitNotification(notif: NotificationPayload): void {
    // Minimal safety: avoid crashing on null/undefined.
    if (!notif) return;

    // If your SocketConnectionHandler has a dedicated notification API:
    // - keep it here so only this adapter knows the handler details.
    this.handler.emitNotification(notif);
  }

  private safeStr(v: unknown): string {
    return typeof v === "string" ? v.trim() : "";
  }
}

// ----------------------------------------------------------------------------
// 3) Provider — single global access point for domain services
// ----------------------------------------------------------------------------
export class WsEmitterProvider {
  private static emitter: IWsEmitter = new NoopEmitter();
  private static isReady = false;

  private constructor() {
    // static-only
  }

  /**
   * Called by SocketBootstrap after WS is ready.
   * You can call this once; repeated calls will override the emitter.
   */
  public static Init(emitter: IWsEmitter): void {
    WsEmitterProvider.emitter = emitter;
    WsEmitterProvider.isReady = true;

    console.log("[Success:] [WsEmitterProvider] WS emitter initialized.\n");
  }

  /**
   * Always safe:
   * - Before Init -> returns NoopEmitter (drops events safely)
   * - After Init  -> returns real emitter
   */
  public static Get(): IWsEmitter {
    return WsEmitterProvider.emitter;
  }

  public static IsReady(): boolean {
    return WsEmitterProvider.isReady;
  }

  /**
   * Convenience for SocketBootstrap (optional):
   * - Avoid exposing SocketConnectionHandler usage throughout the codebase.
   * - SocketBootstrap can do:
   *     WsEmitterProvider.InitFromSocketHandler();
   */
  public static InitFromSocketHandler(): void {
    // IMPORTANT: Only bootstrap should call this.
    // If handler singleton isn't ready, this will throw — which is correct
    // because bootstrap order must be fixed at the socket layer.
    const handler = SocketConnectionHandler.GetInstance();
    WsEmitterProvider.Init(new SocketConnectionHandlerEmitter(handler));
  }

  public static InitFromHandler(handler: SocketConnectionHandler): void {
    WsEmitterProvider.Init(new SocketConnectionHandlerEmitter(handler));
  }
}
