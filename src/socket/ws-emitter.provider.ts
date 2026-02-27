// Path: src/socket/ws-emitter.provider.ts
// ============================================================================
// WsEmitterProvider — boot-order safe WS emitter
// - Emits ONLY using SocketRooms (universal naming)
// ============================================================================

import type { Role } from "../types/roles";
import type { NotificationPayload } from "./socket-types.type";
import type { IWsEmitter } from "./ws-emitter.interface";
import { SocketConnectionHandler } from "./socket-connection.handler";

// ----------------------------------------------------------------------------
// 1) NoopEmitter — safe fallback before sockets are ready
// ----------------------------------------------------------------------------
class NoopEmitter implements IWsEmitter {
  public emitToRoom( _room: string, _event: string, _payload: unknown ): void {}
  public emitToRooms( _rooms: string[], _event: string, _payload: unknown ): void {}
  public emitToUser( _username: string, _event: string, _payload: unknown ): void {}
  public emitToRole( _role: Role, _event: string, _payload: unknown ): void {}
  public emitToTeamRooms( _teamCode: string, _event: string, _payload: unknown ): void {}
  public emitNotification( _notif: NotificationPayload ): void {}
}

// ----------------------------------------------------------------------------
// 2) Real emitter adapter
// ----------------------------------------------------------------------------
export class SocketConnectionHandlerEmitter implements IWsEmitter {
  private readonly handler: SocketConnectionHandler;

  public constructor(handler: SocketConnectionHandler) {
    this.handler = handler;
  }

  public emitToRoom(room: string, event: string, payload: unknown): void {
    const r = this.safeStr( room );
    const e = this.safeStr( event );
    if ( !r || !e ) return;
    this.handler.emitToRoom( r, e, payload );
  }

  public emitToRooms(rooms: string[], event: string, payload: unknown): void {
    const e = this.safeStr( event );
    if ( !e ) return;

    const safeRooms = Array.isArray(rooms)
      ? rooms.map( ( x ) => this.safeStr( x ) ).filter( ( x ): x is string => x.length > 0 )
      : [];

    if (safeRooms.length === 0) return;
    this.handler.emitToRooms( safeRooms, e, payload );
  }

  public emitToUser(username: string, event: string, payload: unknown): void {
    const u = this.safeStr( username );
    const e = this.safeStr( event );
    if ( !u || !e ) return;
    this.handler.emitToUser( u, e, payload );
  }

  public emitToRole(role: Role, event: string, payload: unknown): void {
    const e = this.safeStr( event );
    if ( !e ) return;
    this.handler.emitToRole( role, e, payload );
  }

  // IMPORTANT: universal team room is team:<teamCode>
  public emitToTeamRooms(teamCode: string, event: string, payload: unknown): void {
    const t = this.safeStr( teamCode );
    const e = this.safeStr( event );
    if ( !t || !e ) return;
    this.handler.emitToTeam( t, e, payload );
  }

  public emitNotification( notif: NotificationPayload ): void {
    if ( !notif ) return;
    this.handler.emitNotification(notif);
  }

  private safeStr(v: unknown): string {
    return typeof v === "string" ? v.trim() : "";
  }
}

// ----------------------------------------------------------------------------
// 3) Provider
// ----------------------------------------------------------------------------
export class WsEmitterProvider {
  private static emitter: IWsEmitter = new NoopEmitter();
  private static isReady = false;

  private constructor () {}

  public static Init(emitter: IWsEmitter): void {
    WsEmitterProvider.emitter = emitter;
    WsEmitterProvider.isReady = true;
    // eslint-disable-next-line no-console
    console.log("[Success:] [WsEmitterProvider] WS emitter initialized.\n");
  }

  public static Get(): IWsEmitter {
    return WsEmitterProvider.emitter;
  }

  public static IsReady(): boolean {
    return WsEmitterProvider.isReady;
  }

  public static InitFromSocketHandler(): void {
    const handler = SocketConnectionHandler.GetInstance();
    WsEmitterProvider.Init(new SocketConnectionHandlerEmitter(handler));
  }

  public static InitFromHandler(handler: SocketConnectionHandler): void {
    WsEmitterProvider.Init(new SocketConnectionHandlerEmitter(handler));
  }
}