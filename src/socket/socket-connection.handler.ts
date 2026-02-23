// Path: src/socket/socket-connection.handler.ts
// ============================================================================
// SocketConnectionHandler (READ-ONLY SINGLETON)
// ----------------------------------------------------------------------------
// ✅ GOAL
// - Centralize ALL room joins for the entire platform.
// - Fix Notification role-room mismatch: join BOTH
//     role:<ROLE>      (legacy)
//     aud.role.<ROLE>  (notifications standard)
//
// FUTURE-PROOF
// - If AuthUser later carries extra audience rooms (authUser.audRooms[]),
//   handler auto-joins them without code changes.
// ============================================================================

import { GuardTokenService } from "../services/guard-token.service";
import { wsSecurityEventLogger } from "../services/ws-service/ws-security-event-logger.service";
import type { WsTokenRegistryRedis } from "../services/ws-service/ws-token-registry.redis.service";
import type { Role } from "../types/roles";
import { SocketAuthHelper } from "./socket-auth.helper";
import type {
  CallAnswerPayload,
  CallCandidatePayload,
  CallEndPayload,
  CallOfferPayload,
  ChatMessagePayload,
  GuardTokenPayload,
  TypedNamespace,
  TypedSocket,
} from "./socket-types.type";

import type { AuthUser } from "../types/common";
import { SocketRooms } from "./events/rooms/socket.rooms";
import type { NotificationPayload } from "./socket-types.type";

// WsTokenPushPayload (BE → FE) after wsToken rotation
type WsTokenPushPayload = {
  token: string;
  issuedAt: number;
  validUntil: number;
};

type WaitOptions = {
  pollIntervalMs: number;
  maxWaitMs: number;
};

export class SocketConnectionHandler {
  private readonly nsp: TypedNamespace;
  private readonly authHelper: SocketAuthHelper;
  private readonly guardTokenService: GuardTokenService;
  private readonly wsTokenRegistry: WsTokenRegistryRedis;

  private static _instance: SocketConnectionHandler | null = null;
  private static _initStarted = false;

  private static readonly DEFAULT_WAIT: WaitOptions = {
    pollIntervalMs: 50,
    maxWaitMs: 8_000,
  };

  public constructor (
    nsp: TypedNamespace,
    authHelper: SocketAuthHelper,
    guardTokenService: GuardTokenService,
    wsTokenRegistry: WsTokenRegistryRedis
  ) {
    this.nsp = nsp;
    this.authHelper = authHelper;
    this.guardTokenService = guardTokenService;
    this.wsTokenRegistry = wsTokenRegistry;
  }

  // Bootstrap-only singleton init
  public static Init(
    nsp: TypedNamespace,
    authHelper: SocketAuthHelper,
    guardTokenService: GuardTokenService,
    wsTokenRegistry: WsTokenRegistryRedis
  ): SocketConnectionHandler {
    if ( SocketConnectionHandler._instance || SocketConnectionHandler._initStarted ) {
      throw new Error(
        "[Error:] [SocketConnectionHandler] Init already executed/started. SocketBootstrap must not run twice.\n"
      );
    }

    SocketConnectionHandler._initStarted = true;

    const handler = new SocketConnectionHandler( nsp, authHelper, guardTokenService, wsTokenRegistry );
    SocketConnectionHandler._instance = handler;

    // eslint-disable-next-line no-console
    console.log( "[Success:] [SocketConnectionHandler] Instance initialized by system (Init).\n" );

    return handler;
  }

  public static GetInstance(): SocketConnectionHandler {
    if ( !SocketConnectionHandler._instance ) {
      throw new Error(
        "[Error:] [SocketConnectionHandler] Instance not registered yet. SocketBootstrap must call Init(...).\n"
      );
    }
    return SocketConnectionHandler._instance;
  }

  public static WaitForInstance( opt?: Partial<WaitOptions> ): Promise<SocketConnectionHandler> {
    const cfg: WaitOptions = { ...SocketConnectionHandler.DEFAULT_WAIT, ...( opt ?? {} ) };

    const instNow = SocketConnectionHandler._instance;
    if ( instNow ) return Promise.resolve( instNow );

    return new Promise<SocketConnectionHandler>( ( resolve, reject ) => {
      const startedAt = Date.now();

      const timer: NodeJS.Timeout = setInterval( () => {
        const inst = SocketConnectionHandler._instance;
        if ( inst ) {
          clearInterval( timer );
          resolve( inst );
          return;
        }

        if ( Date.now() - startedAt >= cfg.maxWaitMs ) {
          clearInterval( timer );
          reject(
            new Error(
              "[Error:] [SocketConnectionHandler] WaitForInstance timed out. SocketBootstrap likely did not call Init(...).\n"
            )
          );
        }
      }, cfg.pollIntervalMs );
    } );
  }

  // Attach once
  public registerConnectionHandlers(): void {
    this.nsp.on( "connection", async ( socket: TypedSocket ) => {
      const authUser = socket.data.authUser as AuthUser | undefined;

      if ( !authUser?.username || !authUser.role ) {
        // eslint-disable-next-line no-console
        console.warn(
          "[Warning:] [SocketConnectionHandler] Missing authUser on connection – disconnecting socket:",
          socket.id,
          "\n"
        );
        socket.disconnect( true );
        return;
      }

      // 1) Join KPI / audience rooms (aud.*.*)
      this.joinAudienceRoomsFromAuth( socket, authUser );

      // 2) Validate wsToken (your existing security)
      await this.tryConsumeWsToken( socket, authUser );

      // 3) Join base rooms (user/session/role/broadcast + aud.role)
      this.joinBaseRooms( socket, authUser );

      // eslint-disable-next-line no-console
      console.log(
        "[Success:] ✅ Socket connected:",
        authUser.username,
        `(role=${ authUser.role }) id=${ socket.id }\n`
      );

      // 4) Start lifecycle engine
      this.handleConnectionLifecycle( socket, authUser );
    } );
  }

  // ==========================================================================
  // Audience join (KPI + Notifications + future modules)
  // ==========================================================================
  private joinAudienceRoomsFromAuth( socket: TypedSocket, authUser: AuthUser ): void {
    // KPI baseline (your runtime expects these)
    socket.join( SocketRooms.audOrg( "org" ) );

    if ( typeof authUser.sub === "string" && authUser.sub.trim() ) {
      socket.join( SocketRooms.audMember( authUser.sub.trim() ) );
    }

    if ( Array.isArray( authUser.teamCodes ) && authUser.teamCodes.length > 0 ) {
      for ( const t of authUser.teamCodes ) {
        if ( typeof t === "string" && t.trim() ) {
          socket.join( SocketRooms.audTeam( t.trim() ) );
        }
      }
    }

    if ( typeof authUser.branchId === "string" && authUser.branchId.trim() ) {
      socket.join( SocketRooms.audBranch( authUser.branchId.trim() ) );
    }

    /**
     * FUTURE: auto-join additional audience rooms (HR/Finance/etc.)
     * - Backward compatible: only used if the property exists.
     * - You can add these later into AuthUser JWT without editing this handler.
     */
    const extraRooms = ( authUser as unknown as { audRooms?: unknown; } ).audRooms;
    if ( Array.isArray( extraRooms ) ) {
      for ( const r of extraRooms ) {
        const room = typeof r === "string" ? r.trim() : "";
        if ( room && SocketAuthHelper.isValidRoomName( room ) ) {
          socket.join( room );
        }
      }
    }

    // eslint-disable-next-line no-console
    console.log( "[Info:] [SocketConnectionHandler] Audience rooms joined.\n" );
  }

  // ==========================================================================
  // Base rooms (MUST include aud.role.<ROLE> for notification delivery)
  // ==========================================================================
  private joinBaseRooms( socket: TypedSocket, user: AuthUser ): void {
    socket.join( SocketRooms.user( user.username ) );
    socket.join( SocketRooms.role( String( user.role ) ) );       // legacy
    socket.join( SocketRooms.audRole( String( user.role ) ) );    // ✅ notifications
    socket.join( SocketRooms.BROADCAST );

    const sessionToken = socket.data.sessionToken as string | undefined;
    if ( sessionToken && sessionToken.trim().length > 0 ) {
      socket.join( SocketRooms.session( sessionToken.trim() ) );
    }
  }

  private leaveBaseRooms( socket: TypedSocket, user: AuthUser ): void {
    socket.leave( SocketRooms.user( user.username ) );
    socket.leave( SocketRooms.role( String( user.role ) ) );
    socket.leave( SocketRooms.audRole( String( user.role ) ) );
    socket.leave( SocketRooms.BROADCAST );

    const sessionToken = socket.data.sessionToken as string | undefined;
    if ( sessionToken && sessionToken.trim().length > 0 ) {
      socket.leave( SocketRooms.session( sessionToken.trim() ) );
    }
  }

  // ==========================================================================
  // wsToken consume logic (extracted from your big method for cleanliness)
  // ==========================================================================
  private async tryConsumeWsToken( socket: TypedSocket, authUser: AuthUser ): Promise<void> {
    const rawAuth: unknown = socket.handshake.auth;
    const authMeta =
      ( rawAuth && typeof rawAuth === "object" ? rawAuth : {} ) as { wsToken?: unknown; };

    const wsToken = typeof authMeta.wsToken === "string" ? authMeta.wsToken.trim() : "";
    const sessionTokenFallback = socket.data.sessionToken as string | undefined;

    // eslint-disable-next-line no-console
    console.log(
      "[Info:] [SocketConnectionHandler] Handshake wsToken:",
      wsToken || "(none)",
      "socket=",
      socket.id,
      "user=",
      authUser.username,
      "\n"
    );

    if ( !wsToken ) return;

    try {
      const record = await this.wsTokenRegistry.consumeToken( wsToken );

      if ( !record ) {
        // fallback validation
        let sessionStillValid = false;

        if ( sessionTokenFallback && sessionTokenFallback.trim().length > 0 ) {
          try {
            const resolvedUser = await this.guardTokenService.resolveUserBySessionToken(
              sessionTokenFallback.trim()
            );
            if ( resolvedUser && resolvedUser.username === authUser.username ) {
              sessionStillValid = true;
            }
          } catch ( innerError: unknown ) {
            // eslint-disable-next-line no-console
            console.error(
              "[Error:] [SocketConnectionHandler] Session re-check failed after wsToken failure:",
              innerError,
              "\n"
            );
          }
        }

        if ( !sessionStillValid ) {
          // eslint-disable-next-line no-console
          console.error(
            "[Error:] [SocketConnectionHandler] wsToken invalid AND session invalid – terminating user sockets.\n"
          );

          const userRoom = SocketRooms.user( authUser.username );

          this.nsp.to( userRoom ).emit( "session:terminated", {
            mode: "security",
            reason: "ws_token_and_session_invalid",
            username: authUser.username,
            ts: Date.now(),
          } );

          this.nsp.to( userRoom ).disconnectSockets( true );

          await wsSecurityEventLogger.log( {
            eventType: "weTokenInvalidAndSessionAndGuardTokensInvalid",
            socketId: socket.id,
            ip: socket.handshake.address,
            userAgent: String( socket.handshake.headers[ "user-agent" ] ?? "" ),
            reason: "wsToken invalid and session invalid at handshake",
          } );

          socket.disconnect( true );
          return;
        }

        // soft fallback: keep connection, anchor wsSessionId on sessionToken
        if ( sessionTokenFallback && sessionTokenFallback.trim().length > 0 ) {
          ( socket.data as unknown as { wsSessionId?: string; } ).wsSessionId =
            sessionTokenFallback.trim();
        }
        return;
      }

      ( socket.data as unknown as { wsSessionId?: string; } ).wsSessionId = record.sessionId;
    } catch ( error: unknown ) {
      // eslint-disable-next-line no-console
      console.error( "[Error:] [SocketConnectionHandler] consumeToken failed:", error, "\n" );
    }
  }

  // ==========================================================================
  // Lifecycle (your existing logic preserved)
  // ==========================================================================
  private handleConnectionLifecycle( socket: TypedSocket, auth: AuthUser ): void {
    let lastClientPongAt = Date.now();

    socket.emit( "server:hello", {
      sid: socket.id,
      username: auth.username,
      role: auth.role,
      ts: Date.now(),
      server: { name: "prop-ease-api", version: "1.0.0" },
    } );

    socket.on( "client:hello", ( _payload: unknown, ack?: ( resp: { ok: boolean; serverTime: number; } ) => void ) => {
      const serverTime = Date.now();
      if ( ack ) ack( { ok: true, serverTime } );

      socket.emit( "server:welcome", { ok: true, user: socket.data.authUser as AuthUser, serverTime } );
    } );

    socket.on( "client:ping", ( payload: { t0?: number; } | undefined, ack?: ( resp: { pong: true; ts: number; serverTs: number; } ) => void ) => {
      const t0 = typeof payload?.t0 === "number" ? payload.t0 : Date.now();
      if ( ack ) ack( { pong: true, ts: t0, serverTs: Date.now() } );
    } );

    const heartbeatTimer: NodeJS.Timeout = setInterval( () => {
      const startedAt = Date.now();

      socket.timeout( 4_000 ).emit( "server:ping", { t: startedAt }, ( err?: Error ) => {
        if ( !err ) lastClientPongAt = Date.now();

        if ( Date.now() - lastClientPongAt > 60_000 ) {
          // eslint-disable-next-line no-console
          console.warn(
            "[Warning:] [SocketConnectionHandler] Heartbeat timeout – disconnecting socket:",
            socket.id,
            "user=",
            auth.username,
            "\n"
          );
          socket.disconnect( true );
        }
      } );
    }, 15_000 );

    socket.on( "client:pong", () => {
      lastClientPongAt = Date.now();
    } );

    // Guard token rotation (fast)
    const pushGuardToken = async (): Promise<void> => {
      try {
        const currentUser = socket.data.authUser as AuthUser | undefined;
        const sessionToken = socket.data.sessionToken as string | undefined;

        if ( !currentUser || !sessionToken ) return;

        const newGuardToken = await this.guardTokenService.rotateGuardToken( sessionToken );
        if ( !newGuardToken ) return;

        const issuedAt = Date.now();
        const expiresAt = issuedAt + 10_000;

        const payload: GuardTokenPayload = { token: newGuardToken, issuedAt, expiresAt };
        socket.emit( "guard:update", payload );
      } catch ( error: unknown ) {
        // eslint-disable-next-line no-console
        console.error( "[Error:] [guard:update] rotation failed:", error, "\n" );
      }
    };

    void pushGuardToken();
    const guardTimer: NodeJS.Timeout = setInterval( () => void pushGuardToken(), 5_000 );

    const wsTokenTimer: NodeJS.Timeout | null = this.registerWsTokenRotation( socket, auth );

    socket.on( "client:subscribe", ( rooms?: unknown ) => {
      for ( const room of SocketAuthHelper.safeRooms( rooms ) ) socket.join( room );
    } );

    socket.on( "client:unsubscribe", ( rooms?: unknown ) => {
      for ( const room of SocketAuthHelper.safeRooms( rooms ) ) socket.leave( room );
    } );

    this.registerRuntimeAuthUpdate( socket );
    this.registerChatEvents( socket );
    this.registerCallEvents( socket );

    socket.on( "disconnecting", ( reason: string ) => {
      clearInterval( heartbeatTimer );
      clearInterval( guardTimer );
      if ( wsTokenTimer ) clearInterval( wsTokenTimer );

      // eslint-disable-next-line no-console
      console.log( "[Info:] ↘️  Socket disconnecting:", auth.username, `(${ reason }) id=${ socket.id }\n` );
    } );

    socket.on( "disconnect", ( reason: string ) => {
      clearInterval( heartbeatTimer );
      clearInterval( guardTimer );
      if ( wsTokenTimer ) clearInterval( wsTokenTimer );

      // eslint-disable-next-line no-console
      console.log( "[Info:] ↘️  Socket disconnected:", auth.username, `(${ reason }) id=${ socket.id }\n` );
    } );
  }

  private registerWsTokenRotation( socket: TypedSocket, auth: AuthUser ): NodeJS.Timeout | null {
    let lastWsTokenPayload: WsTokenPushPayload | null = null;

    const pushWsToken = async (): Promise<void> => {
      try {
        const wsSessionId = ( socket.data as unknown as { wsSessionId?: string; } ).wsSessionId;

        if ( !wsSessionId ) return;

        const newRecord = await this.wsTokenRegistry.rotateToken( wsSessionId );
        if ( !newRecord ) return;

        const issuedAt = Date.now();
        const validUntil =
          newRecord.expiresAt instanceof Date
            ? newRecord.expiresAt.getTime()
            : new Date( newRecord.expiresAt as unknown as string ).getTime();

        const payload: WsTokenPushPayload = { token: newRecord.token, issuedAt, validUntil };
        lastWsTokenPayload = payload;

        socket.emit( "ws:token:update", payload );
      } catch ( error: unknown ) {
        // eslint-disable-next-line no-console
        console.error( "[Error:] [ws:token:update] rotation failed:", error, "\n" );
      }
    };

    socket.on( "ws:token:echo", ( ack?: ( res: { ok: boolean; payload?: WsTokenPushPayload | null; reason?: string; } ) => void ) => {
      if ( !ack ) return;
      if ( !lastWsTokenPayload ) {
        ack( { ok: false, payload: null, reason: "no_ws_token_pushed_yet" } );
        return;
      }
      ack( { ok: true, payload: lastWsTokenPayload } );
    } );

    void pushWsToken();
    return setInterval( () => void pushWsToken(), 60_000 );
  }

  private registerRuntimeAuthUpdate( socket: TypedSocket ): void {
    socket.on( "auth:update", ( token: string, ack?: ( res: { ok: boolean; reason?: string; } ) => void ) => {
      try {
        const nextUser = this.authHelper.decodeAuthUser( token );

        const previousUser = socket.data.authUser as AuthUser | undefined;
        if ( previousUser ) this.leaveBaseRooms( socket, previousUser );

        socket.data.authUser = nextUser;
        this.joinAudienceRoomsFromAuth( socket, nextUser );
        this.joinBaseRooms( socket, nextUser );

        if ( ack ) ack( { ok: true } );
        socket.emit( "auth:updated", { ok: true, user: nextUser } );
      } catch ( error: unknown ) {
        // eslint-disable-next-line no-console
        console.error( "[Error:] [auth:update] Failed:", error, "\n" );
        if ( ack ) ack( { ok: false, reason: "invalid token" } );
        socket.emit( "auth:updated", { ok: false, reason: "invalid token" } );
      }
    } );
  }

  private registerChatEvents( socket: TypedSocket ): void {
    socket.on( "chat:send", ( msg: ChatMessagePayload, ack?: ( res: { ok: boolean; } ) => void ) => {
      try {
        const sender = socket.data.authUser as AuthUser | undefined;
        if ( !sender?.username ) throw new Error( "unauthenticated" );

        const normalized: ChatMessagePayload = {
          ...msg,
          from: sender.username,
          createdAt: msg.createdAt || new Date().toISOString(),
        };

        if ( normalized.to ) this.emitToUser( normalized.to, "chat:new", normalized );
        if ( normalized.roomId && SocketAuthHelper.isValidRoomName( normalized.roomId ) ) {
          this.emitToRooms( [ normalized.roomId ], "chat:new", normalized );
        }

        socket.emit( "chat:sent", normalized );
        if ( ack ) ack( { ok: true } );
      } catch ( error: unknown ) {
        // eslint-disable-next-line no-console
        console.error( "[Error:] [chat:send] failed:", error, "\n" );
        if ( ack ) ack( { ok: false } );
      }
    } );
  }

  private registerCallEvents( socket: TypedSocket ): void {
    socket.on( "call:offer", ( payload: CallOfferPayload, ack?: ( res: { ok: boolean; } ) => void ) => {
      this.relayCallEvent( socket, "call:offer", payload, ack );
    } );

    socket.on( "call:answer", ( payload: CallAnswerPayload, ack?: ( res: { ok: boolean; } ) => void ) => {
      this.relayCallEvent( socket, "call:answer", payload, ack );
    } );

    socket.on( "call:candidate", ( payload: CallCandidatePayload, ack?: ( res: { ok: boolean; } ) => void ) => {
      this.relayCallEvent( socket, "call:candidate", payload, ack );
    } );

    socket.on( "call:end", ( payload: CallEndPayload, ack?: ( res: { ok: boolean; } ) => void ) => {
      this.relayCallEvent( socket, "call:end", payload, ack );
    } );
  }

  private relayCallEvent<TPayload extends { to: string; }>(
    socket: TypedSocket,
    eventName: "call:offer" | "call:answer" | "call:candidate" | "call:end",
    payload: TPayload,
    ack?: ( res: { ok: boolean; } ) => void
  ): void {
    try {
      const sender = socket.data.authUser as AuthUser | undefined;
      if ( !sender?.username ) throw new Error( "unauthenticated" );

      const normalized = { ...payload, from: sender.username };
      this.emitToUser( normalized.to, eventName, normalized );

      if ( ack ) ack( { ok: true } );
    } catch ( error: unknown ) {
      // eslint-disable-next-line no-console
      console.error( "[Error:]", `[${ eventName }] failed:`, error, "\n" );
      if ( ack ) ack( { ok: false } );
    }
  }

  // ==========================================================================
  // Emission helpers (namespace-scoped)
  // ==========================================================================
  public emitToUser( username: string, event: string, payload: unknown ): void {
    this.nsp.to( SocketRooms.user( username ) ).emit( event, payload );
  }

  public emitToRole( role: Role, event: string, payload: unknown ): void {
    this.nsp.to( SocketRooms.role( String( role ) ) ).emit( event, payload );
  }

  public emitToRooms( rooms: string[], event: string, payload: unknown ): void {
    const safeEvent = this.safeSocketEvent( event );
    const safeRooms = this.safeRoomList( rooms );

    if ( !safeEvent || safeRooms.length === 0 ) return;
    this.nsp.to( safeRooms ).emit( safeEvent, payload );
  }

  public emitToRoom( room: string, event: string, payload: unknown ): void {
    const safeEvent = this.safeSocketEvent( event );
    const safeRoom = this.safeRoom( room );

    if ( !safeEvent || !safeRoom ) return;
    this.nsp.to( safeRoom ).emit( safeEvent, payload );
  }

  // ==========================================================================
  // Safety helpers
  // ==========================================================================
  private safeSocketEvent( v: unknown ): string {
    const s = typeof v === "string" ? v.trim() : "";
    return s.length > 0 ? s : "";
  }

  private safeRoom( v: unknown ): string {
    const s = typeof v === "string" ? v.trim() : "";
    if ( !s ) return "";
    if ( s === "undefined" || s === "null" ) return "";
    return s;
  }

  private safeRoomList( v: unknown ): string[] {
    if ( !Array.isArray( v ) ) return [];
    const out: string[] = [];
    for ( const x of v ) {
      const r = this.safeRoom( x );
      if ( r ) out.push( r );
    }
    return out;
  }

  // ==========================================================================
  // Forced disconnect helpers (logout / security / admin kick)
  // ==========================================================================

/**
 * Force-disconnect all sockets that belong to a session token.
 *
 * Typical use:
 * - Logout by session token
 * - Session invalidation
 * - Security termination
 *
 * NOTE:
 * - Public API is void so callers don't need to await.
 * - Internally we do async resolution to also terminate the user's room.
 */
  public forceDisconnectSession( sessionToken: string, reason: string ): void {
    const token = typeof sessionToken === "string" ? sessionToken.trim() : "";
    const why = typeof reason === "string" ? reason.trim() : "forced_disconnect";

  if ( !token ) return;

  // fire-and-forget (caller doesn't await)
  void this.forceDisconnectSessionAsync( token, why );
}

  private async forceDisconnectSessionAsync( sessionToken: string, reason: string ): Promise<void> {
    try {
      const token = sessionToken.trim();
      const why = reason.trim() || "forced_disconnect";

    // 1) Kill all sockets in the session room (fast + direct)
    const sessionRoom = SocketRooms.session( token );

    this.nsp.to( sessionRoom ).emit( "session:terminated", {
      mode: "logout",
      reason: why,
      sessionToken: token,
      ts: Date.now(),
    } );

    this.nsp.to( sessionRoom ).disconnectSockets( true );

    // 2) Optional: also terminate all sockets for the resolved user (covers multi-tabs, other sessions)
    //    This makes logout behave consistently even if some sockets didn't join the session room yet.
    const resolvedUser = await this.guardTokenService.resolveUserBySessionToken( token );
    const username = typeof resolvedUser?.username === "string" ? resolvedUser.username.trim() : "";

    if ( username ) {
      this.forceDisconnectUser( username, why );
    }

    // eslint-disable-next-line no-console
    console.log(
      "[Info:] [SocketConnectionHandler] forceDisconnectSession executed:",
      token,
      `(user=${ username || "unknown" }) reason=${ why }\n`
    );
  } catch ( error: unknown ) {
    // eslint-disable-next-line no-console
    console.error(
      "[Error:] [SocketConnectionHandler] forceDisconnectSessionAsync failed:",
      error,
      "\n"
    );
  }
}

  /**
   * Force-disconnect all sockets that belong to a username (user room).
   *
   * Typical use:
   * - Logout by username
   * - Admin kick
   * - Security termination
   */
  public forceDisconnectUser( username: string, reason: string ): void {
    const user = typeof username === "string" ? username.trim() : "";
    const why = typeof reason === "string" ? reason.trim() : "forced_disconnect";

    if ( !user ) return;

  const userRoom = SocketRooms.user( user );

  this.nsp.to( userRoom ).emit( "session:terminated", {
    mode: "logout",
    reason: why,
    username: user,
    ts: Date.now(),
  } );

  this.nsp.to( userRoom ).disconnectSockets( true );

  // eslint-disable-next-line no-console
  console.log(
    "[Info:] [SocketConnectionHandler] forceDisconnectUser executed:",
    user,
    `reason=${ why }\n`
  );
  }

  // ==========================================================================
  // Notifications (central dispatch)
  // ==========================================================================

  /**
   * Emit a notification payload to all intended audiences.
   *
   * WHY THIS EXISTS:
   * - Controllers/services should NOT know room naming conventions.
   * - Handler already guarantees role room joins:
   *     role:<ROLE>      (legacy)
   *     aud.role.<ROLE>  (notifications standard)
   * - This method keeps delivery consistent across the whole platform.
   */
  public emitNotification( notif: NotificationPayload ): void {
    if ( !notif ) return;

    // Default event name (change here if your FE listens on a different one)
    const event = this.safeSocketEvent(
      ( notif as unknown as { event?: unknown; } ).event ?? "notification:new",
    );
    if ( !event ) return;

    const usernames = this.extractUsernamesFromNotification( notif );
    const rooms = this.extractRoomsFromNotification( notif );
    const roles = this.extractRolesFromNotification( notif );
    const broadcast = this.extractBroadcastFlag( notif );

    // 1) Direct users
    for ( const u of usernames ) {
      this.emitToUser( u, event, notif );
    }

    // 2) Direct rooms (supports aud.team.*, aud.member.*, custom rooms, etc.)
    for ( const r of rooms ) {
      this.emitToRoom( r, event, notif );
    }

    // 3) Roles (emit to BOTH legacy + aud.role)
    for ( const role of roles ) {
      const safeRole = this.safeRoom( role );
      if ( !safeRole ) continue;

      // legacy role room
      this.nsp.to( SocketRooms.role( safeRole ) ).emit( event, notif );
      // notifications standard
      this.nsp.to( SocketRooms.audRole( safeRole ) ).emit( event, notif );
    }

    // 4) Broadcast (if explicitly requested)
    if ( broadcast ) {
      this.nsp.to( SocketRooms.BROADCAST ).emit( event, notif );
    }
  }

  // --------------------------------------------------------------------------
  // Notification target extraction (tolerant to payload shape changes)
  // --------------------------------------------------------------------------

  private extractBroadcastFlag( notif: NotificationPayload ): boolean {
    const v = ( notif as unknown as { broadcast?: unknown; } ).broadcast;
    return v === true;
  }

  private extractUsernamesFromNotification( notif: NotificationPayload ): string[] {
    const out: string[] = [];

    // common fields
    const one = ( notif as unknown as { username?: unknown; } ).username;
    const many = ( notif as unknown as { usernames?: unknown; } ).usernames;

    this.pushSafeString( out, one );
    this.pushSafeStringArray( out, many );

    // audiences[]
    const audiences = ( notif as unknown as { audiences?: unknown; } ).audiences;
    if ( Array.isArray( audiences ) ) {
      for ( const a of audiences ) {
        if ( !a || typeof a !== "object" ) continue;

        const kind = this.safeRoom( ( a as { kind?: unknown; } ).kind );
        if ( kind !== "user" ) continue;

        this.pushSafeString( out, ( a as { username?: unknown; } ).username );
        this.pushSafeStringArray( out, ( a as { usernames?: unknown; } ).usernames );
      }
    }

    return this.dedupe( out );
  }

  private extractRoomsFromNotification( notif: NotificationPayload ): string[] {
    const out: string[] = [];

    // common fields
    const one = ( notif as unknown as { room?: unknown; } ).room;
    const many = ( notif as unknown as { rooms?: unknown; } ).rooms;

    this.pushSafeRoom( out, one );
    this.pushSafeRoomArray( out, many );

    // audiences[]
    const audiences = ( notif as unknown as { audiences?: unknown; } ).audiences;
    if ( Array.isArray( audiences ) ) {
      for ( const a of audiences ) {
        if ( !a || typeof a !== "object" ) continue;

        const kind = this.safeRoom( ( a as { kind?: unknown; } ).kind );
        if ( kind !== "room" ) continue;

        this.pushSafeRoom( out, ( a as { room?: unknown; } ).room );
        this.pushSafeRoomArray( out, ( a as { rooms?: unknown; } ).rooms );
      }
    }

    return this.dedupe( out );
  }

  private extractRolesFromNotification( notif: NotificationPayload ): string[] {
    const out: string[] = [];

    // common fields
    const one = ( notif as unknown as { role?: unknown; } ).role;
    const many = ( notif as unknown as { roles?: unknown; } ).roles;

    this.pushSafeRole( out, one );
    this.pushSafeRoleArray( out, many );

    // audiences[]
    const audiences = ( notif as unknown as { audiences?: unknown; } ).audiences;
    if ( Array.isArray( audiences ) ) {
      for ( const a of audiences ) {
        if ( !a || typeof a !== "object" ) continue;

        const kind = this.safeRoom( ( a as { kind?: unknown; } ).kind );
        if ( kind !== "role" ) continue;

        this.pushSafeRole( out, ( a as { role?: unknown; } ).role );
        this.pushSafeRoleArray( out, ( a as { roles?: unknown; } ).roles );
      }
    }

    return this.dedupe( out );
  }

  // --------------------------------------------------------------------------
  // Small helpers (safe + dedupe)
  // --------------------------------------------------------------------------

  private pushSafeString( out: string[], v: unknown ): void {
    const s = typeof v === "string" ? v.trim() : "";
    if ( s ) out.push( s );
  }

  private pushSafeStringArray( out: string[], v: unknown ): void {
    if ( !Array.isArray( v ) ) return;
    for ( const x of v ) this.pushSafeString( out, x );
  }

  private pushSafeRoom( out: string[], v: unknown ): void {
    const r = this.safeRoom( v );
    if ( r && SocketAuthHelper.isValidRoomName( r ) ) out.push( r );
  }

  private pushSafeRoomArray( out: string[], v: unknown ): void {
    if ( !Array.isArray( v ) ) return;
    for ( const x of v ) this.pushSafeRoom( out, x );
  }

  private pushSafeRole( out: string[], v: unknown ): void {
    // role rooms are built by SocketRooms.role()/audRole(), so we only need a safe string
    const s = this.safeRoom( v );
    if ( s ) out.push( s );
  }

  private pushSafeRoleArray( out: string[], v: unknown ): void {
    if ( !Array.isArray( v ) ) return;
    for ( const x of v ) this.pushSafeRole( out, x );
  }

  private dedupe( list: string[] ): string[] {
    const set = new Set<string>();
    for ( const x of list ) {
      const s = typeof x === "string" ? x.trim() : "";
      if ( s ) set.add( s );
    }
    return Array.from( set );
  }

}
