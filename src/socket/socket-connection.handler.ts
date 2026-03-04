// Path: src/socket/socket-connection.handler.ts
// ============================================================================
// SocketConnectionHandler (READ-ONLY SINGLETON)
// ----------------------------------------------------------------------------
// ✅ Joins ONLY universal rooms:
//     user:<username>
//     role:<role>
//     team:<teamCode>
//     company 
// - Keeps session:<token> for auth/security kill switch.
// - Keeps broadcast (optional global)
// ============================================================================

import { GuardTokenService } from "../services/guard-token.service";
import { wsSecurityEventLogger } from "../services/ws-service/ws-security-event-logger.service";
import type { WsTokenRegistryRedis } from "../services/ws-service/ws-token-registry.redis.service";
import type { Role } from "../types/roles";
import { UniversalSocketRooms } from './events/universal/universal-socket.events';
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
import { NotificationRoomsJoinHelper } from "./helpers/notification-room-join.helper";
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
        console.warn(
          "[Warning:] [SocketConnectionHandler] Missing authUser on connection – disconnecting socket:",
          socket.id,
          "\n"
        );
        socket.disconnect( true );
        return;
      }

      // 1) Validate wsToken (security)
      await this.tryConsumeWsToken( socket, authUser );

      // 2) Join universal rooms
      this.joinUniversalRooms( socket, authUser );

      NotificationRoomsJoinHelper.joinForAuth( socket, authUser );

      console.log(
        "[Success:] ✅ Socket connected:",
        authUser.username,
        `(role=${ authUser.role }) id=${ socket.id }\n`
      );

      // 3) Start lifecycle engine
      this.handleConnectionLifecycle( socket, authUser );
    } );
  }

  // ==========================================================================
  // Universal rooms join
  // ==========================================================================
  private joinUniversalRooms( socket: TypedSocket, user: AuthUser ): void {
    socket.join( UniversalSocketRooms.user( user.username ) );
    socket.join( UniversalSocketRooms.role( String( user.role ) ) );
    socket.join( UniversalSocketRooms.COMPANY );

    if ( Array.isArray( user.teamCodes ) ) {
      for ( const t of user.teamCodes ) {
        const teamCode = typeof t === "string" ? t.trim() : "";
        if ( teamCode ) socket.join( UniversalSocketRooms.team( teamCode ) );
      }
    }

    socket.join( UniversalSocketRooms.BROADCAST );

    // Security / session room
    const sessionToken = socket.data.sessionToken as string | undefined;
    if ( sessionToken && sessionToken.trim() ) {
      socket.join( UniversalSocketRooms.session( sessionToken.trim() ) );
    }

    console.log( "[Info:] [SocketConnectionHandler] Universal rooms joined.\n" );
  }

  private leaveUniversalRooms( socket: TypedSocket, user: AuthUser ): void {
    socket.leave( UniversalSocketRooms.user( user.username ) );
    socket.leave( UniversalSocketRooms.role( String( user.role ) ) );
    socket.leave( UniversalSocketRooms.COMPANY );
    socket.leave( UniversalSocketRooms.BROADCAST );

    if ( Array.isArray( user.teamCodes ) ) {
      for ( const t of user.teamCodes ) {
        const teamCode = typeof t === "string" ? t.trim() : "";
        if ( teamCode ) socket.leave( UniversalSocketRooms.team( teamCode ) );
      }
    }

    const sessionToken = socket.data.sessionToken as string | undefined;
    if ( sessionToken && sessionToken.trim() ) {
      socket.leave( UniversalSocketRooms.session( sessionToken.trim() ) );
    }
  }

  // ==========================================================================
  // wsToken consume logic (unchanged)
  // ==========================================================================
  private async tryConsumeWsToken( socket: TypedSocket, authUser: AuthUser ): Promise<void> {
    const rawAuth: unknown = socket.handshake.auth;
    const authMeta =
      ( rawAuth && typeof rawAuth === "object" ? rawAuth : {} ) as { wsToken?: unknown; };

    const wsToken = typeof authMeta.wsToken === "string" ? authMeta.wsToken.trim() : "";
    const sessionTokenFallback = socket.data.sessionToken as string | undefined;

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
        let sessionStillValid = false;

        if ( sessionTokenFallback && sessionTokenFallback.trim() ) {
          try {
            const resolvedUser = await this.guardTokenService.resolveUserBySessionToken(
              sessionTokenFallback.trim()
            );
            if ( resolvedUser && resolvedUser.username === authUser.username ) {
              sessionStillValid = true;
            }
          } catch ( innerError: unknown ) {
            console.error(
              "[Error:] [SocketConnectionHandler] Session re-check failed after wsToken failure:",
              innerError,
              "\n"
            );
          }
        }

        if ( !sessionStillValid ) {
          console.error(
            "[Error:] [SocketConnectionHandler] wsToken invalid AND session invalid – terminating user sockets.\n"
          );

          const userRoom = UniversalSocketRooms.user( authUser.username );

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

        if ( sessionTokenFallback && sessionTokenFallback.trim() ) {
          ( socket.data as unknown as { wsSessionId?: string; } ).wsSessionId = sessionTokenFallback.trim();
        }
        return;
      }

      ( socket.data as unknown as { wsSessionId?: string; } ).wsSessionId = record.sessionId;
    } catch ( error: unknown ) {
      console.error( "[Error:] [SocketConnectionHandler] consumeToken failed:", error, "\n" );
    }
  }

  /* ===========================================================================
  * Method: forceDisconnectSession()
  * ===========================================================================
  * 01) Introduction / usage
  * - Force-disconnects ALL sockets that belong to a specific session token.
  * - Used for logout, token revocation, or security termination.
  *
  * 02) Important matters
  * - Uses the session room convention: UniversalSocketRooms.session(<sessionToken>)
  * - Emits a termination event BEFORE disconnecting sockets (best UX).
  * - Never throws; if token invalid/empty → no-op.
  *
  * 03) Why we make this method
  * - Gives REST flows (logout, token rotate, MFA step-up) a server-side kill switch.
  *
  * 04) Parameters
  * @param sessionToken
  * - Expected: non-empty string
  * - Usage: identifies the session room to terminate (session:<token>)
  *
  * @param reason
  * - Expected: short reason label (ex: "logout", "security", "revoked")
  * - Usage: helps FE show correct UX and helps audit logs
  *
  * 05) Usage hint
  * - `handler.forceDisconnectSession(sessionToken, "logout")`
  *
  * 06) Keep in mind
  * - This disconnects ALL sockets in that session room (multi-tab/device).
  * ========================================================================= */
  public forceDisconnectSession( sessionToken: string, reason: string ): void {
    try {
      const token = this.safeTokenOrEmpty( sessionToken );
      if ( !token ) return;

      const why = this.safeReasonOrDefault( reason, "forced_disconnect" );
      const room = UniversalSocketRooms.session( token );

      // 1) Notify UI (optional, but safest UX)
      this.nsp.to( room ).emit( "session:terminated", {
        mode: "server",
        reason: why,
        sessionToken: token,
        ts: Date.now(),
      } );

      // 2) Hard disconnect
      this.nsp.to( room ).disconnectSockets( true );

      console.log(
        "[Info:] [SocketConnectionHandler] forceDisconnectSession executed:",
        `session=${ token }`,
        `reason=${ why }\n`
      );
    } catch ( error: unknown ) {
      console.error( "[Error:] [SocketConnectionHandler] forceDisconnectSession failed:", error, "\n" );
    }
  }

  /* ===========================================================================
   * Method: forceDisconnectUser()
   * ===========================================================================
   * 01) Introduction / usage
   * - Force-disconnects ALL sockets that belong to a username.
   * - Used for logout by username, admin kick, security termination, etc.
   *
   * 02) Important matters
   * - Uses the user room convention: UniversalSocketRooms.user(<username>)
   * - Emits a termination event BEFORE disconnecting sockets.
   * - Never throws; if username invalid/empty → no-op.
   *
   * 03) Why we make this method
   * - Some flows only know username (ex: admin panel, account disable).
   *
   * 04) Parameters
   * @param username
   * - Expected: non-empty string
   * - Usage: identifies the user room to terminate (user:<username>)
   *
   * @param reason
   * - Expected: short label (ex: "logout", "admin_kick", "disabled")
   *
   * 05) Usage hint
   * - `handler.forceDisconnectUser("john", "logout")`
   *
   * 06) Keep in mind
   * - Disconnects ALL sockets in the user room (multi-tab/device).
   * ========================================================================= */
  public forceDisconnectUser( username: string, reason: string ): void {
    try {
      const u = this.safeUsernameOrEmpty( username );
      if ( !u ) return;

      const why = this.safeReasonOrDefault( reason, "forced_disconnect" );
      const room = UniversalSocketRooms.user( u );

      // 1) Notify UI
      this.nsp.to( room ).emit( "session:terminated", {
        mode: "server",
        reason: why,
        username: u,
        ts: Date.now(),
      } );

      // 2) Hard disconnect
      this.nsp.to( room ).disconnectSockets( true );

      console.log(
        "[Info:] [SocketConnectionHandler] forceDisconnectUser executed:",
        `user=${ u }`,
        `reason=${ why }\n`
      );
    } catch ( error: unknown ) {
      console.error( "[Error:] [SocketConnectionHandler] forceDisconnectUser failed:", error, "\n" );
    }
  }

  // ========================================================================
  // Internal sanitizers (strict, no throwing to callers)
  // ========================================================================

  private safeUsernameOrEmpty( v: unknown ): string {
    const s = typeof v === "string" ? v.trim() : "";
    return s;
  }

  private safeTokenOrEmpty( v: unknown ): string {
    const s = typeof v === "string" ? v.trim() : "";
    // keep it permissive; session tokens can be JWT-like or random strings
    if ( !s ) return "";
    if ( s === "undefined" || s === "null" ) return "";
    return s;
  }

  private safeReasonOrDefault( v: unknown, fallback: string ): string {
    const s = typeof v === "string" ? v.trim() : "";
    return s ? s : fallback;
  }

  // ==========================================================================
  // Lifecycle: rejoin universal rooms on auth:update
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

    socket.on(
      "client:ping",
      ( payload: { t0?: number; } | undefined, ack?: ( resp: { pong: true; ts: number; serverTs: number; } ) => void ) => {
        const t0 = typeof payload?.t0 === "number" ? payload.t0 : Date.now();
        if ( ack ) ack( { pong: true, ts: t0, serverTs: Date.now() } );
      }
    );

    const heartbeatTimer: NodeJS.Timeout = setInterval( () => {
      const startedAt = Date.now();

      socket.timeout( 4_000 ).emit( "server:ping", { t: startedAt }, ( err?: Error ) => {
        if ( !err ) lastClientPongAt = Date.now();

        if ( Date.now() - lastClientPongAt > 60_000 ) {
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
        console.error( "[Error:] [guard:update] rotation failed:", error, "\n" );
      }
    };

    void pushGuardToken();
    const guardTimer: NodeJS.Timeout = setInterval( () => void pushGuardToken(), 5_000 );

    const wsTokenTimer: NodeJS.Timeout | null = this.registerWsTokenRotation( socket );

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
      console.log( "[Info:] ↘️  Socket disconnecting:", auth.username, `(${ reason }) id=${ socket.id }\n` );
    } );

    socket.on( "disconnect", ( reason: string ) => {
      clearInterval( heartbeatTimer );
      clearInterval( guardTimer );
      if ( wsTokenTimer ) clearInterval( wsTokenTimer );
      console.log( "[Info:] ↘️  Socket disconnected:", auth.username, `(${ reason }) id=${ socket.id }\n` );
    } );
  }

  private registerWsTokenRotation( socket: TypedSocket ): NodeJS.Timeout | null {
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
        if ( previousUser ) this.leaveUniversalRooms( socket, previousUser );

        socket.data.authUser = nextUser;
        this.joinUniversalRooms( socket, nextUser );

        NotificationRoomsJoinHelper.joinForAuth( socket, nextUser );

        if ( ack ) ack( { ok: true } );
        socket.emit( "auth:updated", { ok: true, user: nextUser } );
      } catch ( error: unknown ) {
        console.error( "[Error:] [auth:update] Failed:", error, "\n" );
        if ( ack ) ack( { ok: false, reason: "invalid token" } );
        socket.emit( "auth:updated", { ok: false, reason: "invalid token" } );
      }
    } );
  }

  // ==========================================================================
  // Chat events (RESTORED)
  // ==========================================================================
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

        // optional room-based chat
        if ( normalized.roomId && SocketAuthHelper.isValidRoomName( normalized.roomId ) ) {
          this.emitToRoom( normalized.roomId, "chat:new", normalized );
        }

        socket.emit( "chat:sent", normalized );
        if ( ack ) ack( { ok: true } );
      } catch ( error: unknown ) {
        console.error( "[Error:] [chat:send] failed:", error, "\n" );
        if ( ack ) ack( { ok: false } );
      }
    } );
  }

  // ==========================================================================
  // Call events (RESTORED)
  // ==========================================================================
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
      console.error( "[Error:]", `[${ eventName }] failed:`, error, "\n" );
      if ( ack ) ack( { ok: false } );
    }
  }

  // ==========================================================================
  // Emission helpers
  // ==========================================================================
  public emitToUser( username: string, event: string, payload: unknown ): void {
    this.nsp.to( UniversalSocketRooms.user( username ) ).emit( event, payload );
  }

  public emitToRole( role: Role, event: string, payload: unknown ): void {
    this.nsp.to( UniversalSocketRooms.role( String( role ) ) ).emit( event, payload );
  }

  public emitToTeam( teamCode: string, event: string, payload: unknown ): void {
    this.nsp.to( UniversalSocketRooms.team( teamCode ) ).emit( event, payload );
  }

  public emitToRoom( room: string, event: string, payload: unknown ): void {
    const safeEvent = this.safeSocketEvent( event );
    const safeRoom = this.safeRoom( room );
    if ( !safeEvent || !safeRoom ) return;
    this.nsp.to( safeRoom ).emit( safeEvent, payload );
  }

  public emitToRooms( rooms: string[], event: string, payload: unknown ): void {
    const safeEvent = this.safeSocketEvent( event );
    const safeRooms = this.safeRoomList( rooms );
    if ( !safeEvent || safeRooms.length === 0 ) return;
    this.nsp.to( safeRooms ).emit( safeEvent, payload );
  }

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
  // Notifications (UNIVERSAL rooms only)
  // ==========================================================================
  public emitNotification( notif: NotificationPayload ): void {
    if ( !notif ) return;

    // Default push event is notify:new unless caller includes notif.event
    const event = this.safeSocketEvent( ( notif as unknown as { event?: unknown; } ).event ?? "notify:new" );
    if ( !event ) return;

    const usernames = this.extractUsernamesFromNotification( notif );
    const roles = this.extractRolesFromNotification( notif );
    const teams = this.extractTeamsFromNotification( notif );
    const broadcast = this.extractBroadcastFlag( notif );
    const company = this.extractCompanyFlag( notif );

    for ( const u of usernames ) this.emitToUser( u, event, notif );
    for ( const r of roles ) this.nsp.to( UniversalSocketRooms.role( r ) ).emit( event, notif );
    for ( const t of teams ) this.nsp.to( UniversalSocketRooms.team( t ) ).emit( event, notif );

    if ( company ) this.nsp.to( UniversalSocketRooms.COMPANY ).emit( event, notif );
    if ( broadcast ) this.nsp.to( UniversalSocketRooms.BROADCAST ).emit( event, notif );
  }

  private extractBroadcastFlag( notif: NotificationPayload ): boolean {
    const v = ( notif as unknown as { broadcast?: unknown; } ).broadcast;
    return v === true;
  }

  private extractCompanyFlag( notif: NotificationPayload ): boolean {
    const v = ( notif as unknown as { company?: unknown; } ).company;
    return v === true;
  }

  private extractUsernamesFromNotification( notif: NotificationPayload ): string[] {
    const out: string[] = [];
    const one = ( notif as unknown as { username?: unknown; } ).username;
    const many = ( notif as unknown as { usernames?: unknown; } ).usernames;

    this.pushSafeString( out, one );
    this.pushSafeStringArray( out, many );

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

  private extractRolesFromNotification( notif: NotificationPayload ): string[] {
    const out: string[] = [];
    const one = ( notif as unknown as { role?: unknown; } ).role;
    const many = ( notif as unknown as { roles?: unknown; } ).roles;

    this.pushSafeString( out, one );
    this.pushSafeStringArray( out, many );

    const audiences = ( notif as unknown as { audiences?: unknown; } ).audiences;
    if ( Array.isArray( audiences ) ) {
      for ( const a of audiences ) {
        if ( !a || typeof a !== "object" ) continue;
        const kind = this.safeRoom( ( a as { kind?: unknown; } ).kind );
        if ( kind !== "role" ) continue;

        this.pushSafeString( out, ( a as { role?: unknown; } ).role );
        this.pushSafeStringArray( out, ( a as { roles?: unknown; } ).roles );
      }
    }

    return this.dedupe( out );
  }

  private extractTeamsFromNotification( notif: NotificationPayload ): string[] {
    const out: string[] = [];

    // Accept either:
    // - team / teams
    // - audiences[] kind === "team"
    const one = ( notif as unknown as { team?: unknown; } ).team;
    const many = ( notif as unknown as { teams?: unknown; } ).teams;

    this.pushSafeString( out, one );
    this.pushSafeStringArray( out, many );

    const audiences = ( notif as unknown as { audiences?: unknown; } ).audiences;
    if ( Array.isArray( audiences ) ) {
      for ( const a of audiences ) {
        if ( !a || typeof a !== "object" ) continue;
        const kind = this.safeRoom( ( a as { kind?: unknown; } ).kind );
        if ( kind !== "team" ) continue;

        this.pushSafeString( out, ( a as { team?: unknown; } ).team );
        this.pushSafeStringArray( out, ( a as { teams?: unknown; } ).teams );
      }
    }

    return this.dedupe( out );
  }

  private pushSafeString( out: string[], v: unknown ): void {
    const s = typeof v === "string" ? v.trim() : "";
    if ( s ) out.push( s );
  }

  private pushSafeStringArray( out: string[], v: unknown ): void {
    if ( !Array.isArray( v ) ) return;
    for ( const x of v ) this.pushSafeString( out, x );
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