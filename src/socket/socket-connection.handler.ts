// Path: src/socket/socket-connection.handler.ts
// ============================================================================
// SocketConnectionHandler (READ-ONLY SINGLETON)
// ----------------------------------------------------------------------------
// PURPOSE
// - Owns the Socket.IO namespace "connection lifecycle" (per socket).
// - Enforces authenticated-socket rule (socket.data.authUser must exist).
// - Joins canonical rooms used by ALL modules (user/role/session + KPI audience).
// - Runs heartbeats to detect dead connections.
// - Rotates tokens:
//    1) guardToken  (fast rotation) via GuardTokenService.rotateGuardToken()
//    2) wsToken     (slower rotation) via WsTokenRegistryRedis.rotateToken()
// - Provides emission helpers used by feature services (TeamTask, Comments, etc.)
//
// WHY READ-ONLY SINGLETON?
// - Your architecture allows feature modules to emit realtime updates without
//   passing handler references everywhere.
// - But the handler depends on the Socket namespace, which exists only AFTER
//   SocketBootstrap creates Socket.IO.
// - Previously: controllers/services called GetInstance() during app boot,
//   before SocketBootstrap ran -> crash.
// - Now:
//    ✅ SocketBootstrap calls Init(...) once (system creates instance)
//    ✅ Everyone else can ONLY read the instance via GetInstance() or WaitForInstance()
//
// CRITICAL RULES
// 1) Only SocketBootstrap may call Init(...). Never call "new SocketConnectionHandler(...)"
//    outside bootstrap. Treat constructor as internal.
// 2) Do NOT call GetInstance() in controller constructors.
//    - Use WaitForInstance() in lazy service builders if boot order can race.
// 3) Attach handlers ONCE at namespace level via registerConnectionHandlers().
// 4) Keep room names consistent across modules; UI updates depend on it.
//
// BOOT ORDER HINT (Root cause of your crash)
// - AppServer constructed routers/controllers BEFORE SocketBootstrap.init().
// - TeamTaskController constructor called GetInstance().
// - Instance was not initialized yet -> throw.
// - This file supports both strict usage (GetInstance) and race-safe usage (WaitForInstance).
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
  NotificationPayload,
  TypedNamespace,
  TypedSocket,
} from "./socket-types.type";
import { AuthUser } from '../types/common'

// ============================================================================
// WsTokenPushPayload
// ----------------------------------------------------------------------------
// - Payload pushed BE → FE after wsToken rotation.
// - FE must store `token` for future WebSocket handshakes (reconnect/new tab).
// ============================================================================
type WsTokenPushPayload = {
  token: string;
  issuedAt: number;
  validUntil: number;
};

// ============================================================================
// WaitOptions
// ----------------------------------------------------------------------------
// - Used by WaitForInstance() to avoid boot-order crashes.
// - pollIntervalMs: how frequently we check for Init() completion.
// - maxWaitMs: hard stop to prevent infinite wait and memory leaks.
// ============================================================================
type WaitOptions = {
  pollIntervalMs: number;
  maxWaitMs: number;
};

export class SocketConnectionHandler {
  // --------------------------------------------------------------------------
  // Core dependencies (provided only by SocketBootstrap.Init)
  // --------------------------------------------------------------------------
  private readonly nsp: TypedNamespace;
  private readonly authHelper: SocketAuthHelper;
  private readonly guardTokenService: GuardTokenService;
  private readonly wsTokenRegistry: WsTokenRegistryRedis;

  // --------------------------------------------------------------------------
  // READ-ONLY SINGLETON STORAGE
  // - private: only this class can assign it (via Init)
  // - external modules: can only read via GetInstance / WaitForInstance
  // --------------------------------------------------------------------------
  private static _instance: SocketConnectionHandler | null = null;
  private static _initStarted = false;

  // Conservative defaults: fast enough to avoid blocking, safe enough not to spin.
  private static readonly DEFAULT_WAIT: WaitOptions = {
    pollIntervalMs: 50,
    maxWaitMs: 8_000,
  };

  // --------------------------------------------------------------------------
  // Constructor
  // NOTE:
  // - Keep public (TS emit compatibility), but treat it as INTERNAL.
  // - Only SocketConnectionHandler.Init(...) should create instances.
  // --------------------------------------------------------------------------
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

  // ==========================================================================
  // SYSTEM INITIALIZER (bootstrap-only)
  // ----------------------------------------------------------------------------
  // - Creates and stores singleton internally (no external set method).
  // - Must run exactly once.
  //
  // USAGE (in SocketBootstrap):
  //   const handler = SocketConnectionHandler.Init(nsp, authHelper, guardSvc, wsRegistry);
  //   handler.registerConnectionHandlers();
  //
  // WHY not SetInstance(handler)?
  // - SetInstance allows any module to "inject" arbitrary instance.
  // - That becomes an attack vector and also a stability risk (double bootstrap).
  // - Init() forces creation and assignment to be centralized and controlled.
  // ==========================================================================
  public static Init(
    nsp: TypedNamespace,
    authHelper: SocketAuthHelper,
    guardTokenService: GuardTokenService,
    wsTokenRegistry: WsTokenRegistryRedis
  ): SocketConnectionHandler {
    if ( SocketConnectionHandler._instance ) {
      throw new Error(
        "[Error:] [SocketConnectionHandler] Init() already executed. SocketBootstrap must not run twice.\n"
      );
    }
    if ( SocketConnectionHandler._initStarted ) {
      throw new Error(
        "[Error:] [SocketConnectionHandler] Init() already started. SocketBootstrap must not run twice.\n"
      );
    }

    SocketConnectionHandler._initStarted = true;

    const handler = new SocketConnectionHandler(
      nsp,
      authHelper,
      guardTokenService,
      wsTokenRegistry
    );

    SocketConnectionHandler._instance = handler;

    console.log(
      "[Success:] [SocketConnectionHandler] Instance initialized by system (Init).\n"
    );

    return handler;
  }

  // ==========================================================================
  // STRICT READ (fast fail)
  // ----------------------------------------------------------------------------
  // - Use this ONLY when you guarantee SocketBootstrap.Init() already ran.
  // - Good for runtime code paths after boot is complete.
  // - NOT recommended inside constructors that run during app composition.
  // ==========================================================================
  public static GetInstance(): SocketConnectionHandler {
    if ( !SocketConnectionHandler._instance ) {
      throw new Error(
        "[Error:] [SocketConnectionHandler] Instance not registered yet. " +
        "SocketBootstrap.init() must call SocketConnectionHandler.Init(...) before use.\n"
      );
    }
    return SocketConnectionHandler._instance;
  }

  // ==========================================================================
  // SOFT READ (no throw)
  // ----------------------------------------------------------------------------
  // - Useful in diagnostics/health checks.
  // ==========================================================================
  public static GetInstanceOrNull(): SocketConnectionHandler | null {
    return SocketConnectionHandler._instance;
  }

  // ==========================================================================
  // RACE-SAFE READ (poll wait)
  // ----------------------------------------------------------------------------
  // - This is your “interval check” to prevent future boot-order crashes.
  // - Use when a class can be constructed before SocketBootstrap finishes.
  //
  // Typical usage (controller lazy service builder):
  //   const handler = await SocketConnectionHandler.WaitForInstance();
  //
  // You should still fix boot order eventually (best practice),
  // but this prevents the server from dying during development and future edits.
  // ==========================================================================
  public static WaitForInstance(
    opt?: Partial<WaitOptions>
  ): Promise<SocketConnectionHandler> {
    const cfg: WaitOptions = {
      ...SocketConnectionHandler.DEFAULT_WAIT,
      ...( opt ?? {} ),
    };

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
              "[Error:] [SocketConnectionHandler] WaitForInstance timed out. " +
              "SocketBootstrap likely did not call Init(...), or boot order is wrong.\n"
            )
          );
        }
      }, cfg.pollIntervalMs );
    } );
  }

  // ==========================================================================
  // Namespace-level registration (attach ONCE)
  // ----------------------------------------------------------------------------
  // - This registers one namespace-level "connection" listener.
  // - Every socket gets its own per-connection logic inside.
  //
  // DO NOT call this multiple times. If you accidentally call it twice:
  // - you will attach duplicate listeners
  // - events will run twice
  // - memory leak + unexpected behavior
  // ==========================================================================
  public registerConnectionHandlers(): void {
    this.nsp.on( "connection", async ( socket: TypedSocket ) => {
    // ----------------------------------------------------------------------
    // 0) Auth user must exist (handshake middleware responsibility)
    // WHY:
    // - Every downstream handler depends on identity (username/role/teams).
    // - If missing, the socket is "untrusted" -> disconnect immediately.
    // ----------------------------------------------------------------------
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

      // ----------------------------------------------------------------------
      // 1) KPI rooms join (aud.*.*)
      // WHY:
      // - KPI runtime emits to aud.org / aud.team / aud.member / aud.branch
      // - Joining these rooms here guarantees analytics/KPI events reach FE.
      // ----------------------------------------------------------------------
      const kpiCtx: { userId?: string; teamCodes?: string[]; branchId?: string; } = {};

      if ( typeof authUser.sub === "string" && authUser.sub.trim() ) {
        kpiCtx.userId = authUser.sub.trim();
      }

      if ( Array.isArray( authUser.teamCodes ) && authUser.teamCodes.length > 0 ) {
        const cleanedTeams = authUser.teamCodes
          .map( ( x ) => ( typeof x === "string" ? x.trim() : "" ) )
          .filter( ( x ) => x.length > 0 );

        if ( cleanedTeams.length > 0 ) {
          kpiCtx.teamCodes = cleanedTeams;
        }
      }

      if ( typeof authUser.branchId === "string" && authUser.branchId.trim() ) {
        kpiCtx.branchId = authUser.branchId.trim();
      }

      this.joinKpiRooms( socket, kpiCtx );

      // ----------------------------------------------------------------------
      // 2) Validate initial wsToken (optional hardening)
      // SECURITY MODEL:
      // - sessionToken baseline is validated by handshake middleware (SocketServer).
      // - wsToken is an additional one-time token consumed from Redis to prevent
      //   replay attacks and to secure reconnect/new-tab handshakes.
      //
      // DEV RELAXED:
      // - if wsToken missing -> allow connection (but weaker)
      // - if wsToken invalid -> try sessionToken fallback, else terminate user session
      // ----------------------------------------------------------------------
      const rawAuth: unknown = socket.handshake.auth;
      const authMeta =
        ( rawAuth && typeof rawAuth === "object" ? rawAuth : {} ) as { wsToken?: unknown; };

      const wsToken = typeof authMeta.wsToken === "string" ? authMeta.wsToken.trim() : "";

      console.log(
        "[Info:] [SocketConnectionHandler] Handshake wsToken:",
        wsToken || "(none)",
        "socket=",
        socket.id,
        "user=",
        authUser.username,
        "\n"
      );

      const sessionTokenFallback = socket.data.sessionToken as string | undefined;

      if ( !wsToken ) {
        console.warn(
          "[Warning:] [SocketConnectionHandler] No wsToken provided in handshake – CONTINUING WITHOUT wsToken protection. socket=",
          socket.id,
          "user=",
          authUser.username,
          "\n"
        );
      } else {
        try {
          // consumeToken removes the token from Redis if valid (one-time use)
          const record = await this.wsTokenRegistry.consumeToken( wsToken );

          if ( !record ) {
          // wsToken invalid/expired -> attempt session validation fallback
            console.warn(
              "[Warning:] [SocketConnectionHandler] Invalid or expired wsToken – re-checking session/guard state. socket=",
              socket.id,
              "user=",
              authUser.username,
              "\n"
            );

            let sessionStillValid = false;

            if ( sessionTokenFallback && sessionTokenFallback.trim().length > 0 ) {
              try {
                const resolvedUser =
                  await this.guardTokenService.resolveUserBySessionToken(
                    sessionTokenFallback.trim()
                  );

                if ( resolvedUser && resolvedUser.username === authUser.username ) {
                  sessionStillValid = true;
                }
              } catch ( innerError: unknown ) {
                console.error(
                  "[Error:] [SocketConnectionHandler] Error while re-validating sessionToken after wsToken failure:",
                  innerError,
                  "\n"
                );
              }
            }

            if ( sessionStillValid ) {
            // soft fallback: keep connection, anchor wsSessionId on sessionToken
              console.warn(
                "[Warning:] [SocketConnectionHandler] wsToken invalid BUT session still valid – using sessionToken as wsSessionId. socket=",
                socket.id,
                "user=",
                authUser.username,
                "\n"
              );

              if ( sessionTokenFallback && sessionTokenFallback.trim().length > 0 ) {
                ( socket.data as unknown as { wsSessionId?: string; } ).wsSessionId =
                  sessionTokenFallback.trim();
              }
            } else {
              // hard fail: both wsToken and session baseline invalid -> kill user sessions
              console.error(
                "[Error:] [SocketConnectionHandler] wsToken invalid AND session invalid – terminating all sockets for user. socket=",
                socket.id,
                "user=",
                authUser.username,
                "\n"
              );

              socket.emit( "session:terminated", {
                mode: "security",
                reason: "ws_token_and_session_invalid",
                username: authUser.username,
                socketId: socket.id,
                ts: Date.now(),
              } );

              const userRoom = `user:${ authUser.username }`;

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
                reason: "missing session token and guard token at handshake",
              } );

              socket.disconnect( true );
              return;
            }
          } else {
            // wsToken OK: store a safe subset of record for debugging/audit
            ( socket.data as unknown as { wsTokenRecord?: unknown; } ).wsTokenRecord = {
              token: record.token,
              sessionId: record.sessionId,
              usedAt: record.usedAt,
              createdAt: record.createdAt,
              expiresAt: record.expiresAt,
              mfaStrength: record.mfaStrength,
              ip: record.ip,
              userAgent: record.userAgent,
            };

            // Anchor rotation on sessionId from Redis record
            ( socket.data as unknown as { wsSessionId?: string; } ).wsSessionId =
              record.sessionId;
          }
        } catch ( error: unknown ) {
          console.error(
            "[Error:] [SocketConnectionHandler] Error while consuming wsToken from Redis:",
            error,
            "\n"
          );
          // DEV relaxed: keep connection, but weaker wsToken guarantees
        }
      }

      // ----------------------------------------------------------------------
      // 3) Final fallback: if wsSessionId still missing, use sessionToken.
      // WHY:
      // - Allows wsToken rotation even when wsToken was skipped.
      // ----------------------------------------------------------------------
      const wsSessionIdCurrent = ( socket.data as unknown as { wsSessionId?: string; } )
        .wsSessionId;

      if ( !wsSessionIdCurrent ) {
        if ( sessionTokenFallback && sessionTokenFallback.trim().length > 0 ) {
          ( socket.data as unknown as { wsSessionId?: string; } ).wsSessionId =
            sessionTokenFallback.trim();

          console.log(
            "[Info:] [SocketConnectionHandler] wsSessionId fallback set from sessionToken for socket=",
            socket.id,
            "user=",
            authUser.username,
            "\n"
          );
        }
      }

      // Re-assert identity on socket (defensive)
      socket.data.authUser = authUser;

      // ----------------------------------------------------------------------
      // 4) Join base rooms
      // WHY:
      // - user:<username>   per-user updates (multi-tab safe)
      // - role:<role>       role broadcasts (admin, etc.)
      // - session:<token>   per-session updates
      // - broadcast         global messages
      // ----------------------------------------------------------------------
      this.joinBaseRooms( socket, authUser );

      console.log(
        "[Success:] ✅ Socket connected:",
        authUser.username,
        `(role=${ authUser.role }) id=${ socket.id }\n`
      );

      // ----------------------------------------------------------------------
      // 5) Start lifecycle engine
      // - heartbeat timer
      // - guard token rotation
      // - ws token rotation
      // - runtime feature event wiring
      // ----------------------------------------------------------------------
      this.handleConnectionLifecycle( socket, authUser );
    } );
  }

  // ==========================================================================
  // Connection lifecycle
  // ==========================================================================
  private handleConnectionLifecycle( socket: TypedSocket, auth: AuthUser ): void {
    let lastClientPongAt = Date.now();

    // Immediate hello makes FE confident the socket is alive.
    socket.emit( "server:hello", {
      sid: socket.id,
      username: auth.username,
      role: auth.role,
      ts: Date.now(),
      server: { name: "prop-ease-api", version: "1.0.0" },
    } );

    socket.on(
      "client:hello",
      ( _payload: unknown, ack?: ( resp: { ok: boolean; serverTime: number; } ) => void ) => {
        const serverTime = Date.now();
        if ( ack ) ack( { ok: true, serverTime } );

        socket.emit( "server:welcome", {
          ok: true,
          user: socket.data.authUser as AuthUser,
          serverTime,
        } );
      }
    );

    socket.on(
      "client:ping",
      (
        payload: { t0?: number; } | undefined,
        ack?: ( resp: { pong: true; ts: number; serverTs: number; } ) => void
      ) => {
        const t0 = typeof payload?.t0 === "number" ? payload.t0 : Date.now();
        if ( ack ) ack( { pong: true, ts: t0, serverTs: Date.now() } );
      }
    );

    // Heartbeat (server -> client ping + timeout)
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

    // Guard token rotation (fast)
    const pushGuardToken = async (): Promise<void> => {
      try {
        const currentUser = socket.data.authUser as AuthUser | undefined;
        const sessionToken = socket.data.sessionToken as string | undefined;

        if ( !currentUser || !sessionToken ) {
          console.warn(
            "[Warning:] [guard:update] Missing authUser or sessionToken on socket – skipping guard token rotation. socket=",
            socket.id,
            "\n"
          );
          return;
        }

        const newGuardToken = await this.guardTokenService.rotateGuardToken( sessionToken );

        if ( !newGuardToken ) {
          console.warn(
            "[Warning:] [guard:update] rotateGuardToken returned null – no new guard token issued. socket=",
            socket.id,
            "user=",
            currentUser.username,
            "\n"
          );
          return;
        }

        const issuedAt = Date.now();
        const expiresAt = issuedAt + 10_000;

        const payload: GuardTokenPayload = { token: newGuardToken, issuedAt, expiresAt };
        socket.emit( "guard:update", payload );
      } catch ( error: unknown ) {
        console.error( "[Error:] [guard:update] Guard token rotation failed:", error, "\n" );
      }
    };

    void pushGuardToken();
    const guardTimer: NodeJS.Timeout = setInterval( () => void pushGuardToken(), 5_000 );

    // WS token rotation (slower)
    const wsTokenTimer: NodeJS.Timeout | null = this.registerWsTokenRotation( socket, auth );

    // Runtime subscribe/unsubscribe (safe room list)
    socket.on( "client:subscribe", ( rooms?: unknown ) => {
      for ( const room of SocketAuthHelper.safeRooms( rooms ) ) socket.join( room );
    } );

    socket.on( "client:unsubscribe", ( rooms?: unknown ) => {
      for ( const room of SocketAuthHelper.safeRooms( rooms ) ) socket.leave( room );
    } );

    // Feature channels
    this.registerRuntimeAuthUpdate( socket );
    this.registerNotificationAck( socket );
    this.registerChatEvents( socket );
    this.registerCallEvents( socket );

    // Cleanup to avoid memory leaks
    socket.on( "disconnecting", ( reason: string ) => {
      clearInterval( heartbeatTimer );
      clearInterval( guardTimer );
      if ( wsTokenTimer ) clearInterval( wsTokenTimer );

      console.log(
        "[Info:] ↘️  Socket disconnecting:",
        auth.username,
        `(${ reason }) id=${ socket.id }\n`
      );
    } );

    socket.on( "disconnect", ( reason: string ) => {
      clearInterval( heartbeatTimer );
      clearInterval( guardTimer );
      if ( wsTokenTimer ) clearInterval( wsTokenTimer );

      console.log(
        "[Info:] ↘️  Socket disconnected:",
        auth.username,
        `(${ reason }) id=${ socket.id }\n`
      );
    } );
  }

  // ==========================================================================
  // WS token rotation (Redis-backed)
  // ==========================================================================
  private registerWsTokenRotation( socket: TypedSocket, auth: AuthUser ): NodeJS.Timeout | null {
    let lastWsTokenPayload: WsTokenPushPayload | null = null;

    const pushWsToken = async (): Promise<void> => {
      try {
        const wsSessionId = ( socket.data as unknown as { wsSessionId?: string; } ).wsSessionId;

        if ( !wsSessionId ) {
          console.warn(
            "[Warning:] [ws:token:update] Missing wsSessionId – skipping rotation. socket=",
            socket.id,
            "user=",
            auth.username,
            "\n"
          );
          return;
        }

        const newRecord = await this.wsTokenRegistry.rotateToken( wsSessionId );

        if ( !newRecord ) {
          console.warn(
            "[Warning:] [ws:token:update] rotateToken returned null – no new wsToken issued. socket=",
            socket.id,
            "user=",
            auth.username,
            "\n"
          );
          return;
        }

        const issuedAt = Date.now();
        const validUntil =
          newRecord.expiresAt instanceof Date
            ? newRecord.expiresAt.getTime()
            : new Date( newRecord.expiresAt as unknown as string ).getTime();

        const payload: WsTokenPushPayload = {
          token: newRecord.token,
          issuedAt,
          validUntil,
        };

        lastWsTokenPayload = payload;
        socket.emit( "ws:token:update", payload );
      } catch ( error: unknown ) {
        console.error( "[Error:] [ws:token:update] WS token rotation failed:", error, "\n" );
      }
    };

    // Echo last token payload (debug + client recovery)
    socket.on(
      "ws:token:echo",
      ( ack?: ( res: { ok: boolean; payload?: WsTokenPushPayload | null; reason?: string; } ) => void ) => {
        try {
          if ( !ack ) return;

          if ( !lastWsTokenPayload ) {
            ack( { ok: false, payload: null, reason: "no_ws_token_pushed_yet" } );
            return;
          }

          ack( { ok: true, payload: lastWsTokenPayload } );
        } catch ( error: unknown ) {
          console.error( "[Error:] [ws:token:echo] Failed to echo ws token payload:", error, "\n" );
          if ( ack ) ack( { ok: false, payload: null, reason: "internal_error" } );
        }
      }
    );

    void pushWsToken();
    const wsTokenTimer: NodeJS.Timeout = setInterval( () => void pushWsToken(), 60_000 );
    return wsTokenTimer;
  }

  // ==========================================================================
  // Runtime auth update
  // ==========================================================================
  private registerRuntimeAuthUpdate( socket: TypedSocket ): void {
    socket.on(
      "auth:update",
      ( token: string, ack?: ( res: { ok: boolean; reason?: string; } ) => void ) => {
        try {
          const nextUser = this.authHelper.decodeAuthUser( token );

          const previousUser = socket.data.authUser;
          if ( previousUser ) this.leaveBaseRooms( socket, previousUser );

          socket.data.authUser = nextUser;
          this.joinBaseRooms( socket, nextUser );

          if ( ack ) ack( { ok: true } );
          socket.emit( "auth:updated", { ok: true, user: nextUser } );
        } catch ( error: unknown ) {
          console.error( "[Error:] [auth:update] Failed to update runtime auth:", error, "\n" );

          if ( ack ) ack( { ok: false, reason: "invalid token" } );
          socket.emit( "auth:updated", { ok: false, reason: "invalid token" } );
        }
      }
    );
  }

  private registerNotificationAck( socket: TypedSocket ): void {
    socket.on(
      "notification:ack",
      ( _payload: { notificationId?: string; }, ack?: ( res: { ok: boolean; } ) => void ) => {
        if ( ack ) ack( { ok: true } );
      }
    );
  }

  // ==========================================================================
  // Chat events (simple relay)
  // ==========================================================================
  private registerChatEvents( socket: TypedSocket ): void {
    socket.on(
      "chat:send",
      ( msg: ChatMessagePayload, ack?: ( res: { ok: boolean; } ) => void ) => {
        try {
          const sender = socket.data.authUser;
          if ( !sender?.username ) throw new Error( "unauthenticated" );

          const normalized: ChatMessagePayload = {
            ...msg,
            from: sender.username,
            createdAt: msg.createdAt || new Date().toISOString(),
          };

          if ( normalized.to ) {
            this.emitToUser( normalized.to, "chat:new", normalized );
          }

          if ( normalized.roomId && SocketAuthHelper.isValidRoomName( normalized.roomId ) ) {
            this.emitToRooms( [ normalized.roomId ], "chat:new", normalized );
          }

          socket.emit( "chat:sent", normalized );
          if ( ack ) ack( { ok: true } );
        } catch ( error: unknown ) {
          console.error( "[Error:] [chat:send] failed:", error, "\n" );
          if ( ack ) ack( { ok: false } );
        }
      }
    );
  }

  // ==========================================================================
  // Call signalling events (offer/answer/candidate/end)
  // ==========================================================================
  private registerCallEvents( socket: TypedSocket ): void {
    socket.on( "call:offer", ( payload: CallOfferPayload, ack?: ( res: { ok: boolean; } ) => void ) => {
      this.relayCallEvent( socket, "call:offer", payload, ack );
    } );

    socket.on( "call:answer", ( payload: CallAnswerPayload, ack?: ( res: { ok: boolean; } ) => void ) => {
      this.relayCallEvent( socket, "call:answer", payload, ack );
    } );

    socket.on(
      "call:candidate",
      ( payload: CallCandidatePayload, ack?: ( res: { ok: boolean; } ) => void ) => {
        this.relayCallEvent( socket, "call:candidate", payload, ack );
      }
    );

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
      const sender = socket.data.authUser;
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
  // Room utilities (base rooms)
  // ==========================================================================
  private joinBaseRooms( socket: TypedSocket, user: AuthUser ): void {
    socket.join( `user:${ user.username }` );
    socket.join( `role:${ user.role }` );
    socket.join( "broadcast" );

    const sessionToken = socket.data.sessionToken as string | undefined;
    if ( sessionToken && sessionToken.trim().length > 0 ) {
      socket.join( `session:${ sessionToken.trim() }` );
    }
  }

  private leaveBaseRooms( socket: TypedSocket, user: AuthUser ): void {
    socket.leave( `user:${ user.username }` );
    socket.leave( `role:${ user.role }` );
    socket.leave( "broadcast" );

    const sessionToken = socket.data.sessionToken as string | undefined;
    if ( sessionToken && sessionToken.trim().length > 0 ) {
      socket.leave( `session:${ sessionToken.trim() }` );
    }
  }

  // ==========================================================================
  // Emission helpers (namespace-scoped)
  // ----------------------------------------------------------------------------
  // USAGE GUIDANCE:
  // - emitToUser: used for per-user UI updates (notifications, personal tasks)
  // - emitToRole: admin broadcast updates
  // - emitToTeamRooms: team room + KPI team audience room
  //
  // IMPORTANT:
  // - These helpers only sanitize minimal aspects (empty room/event protection).
  // - You may tighten allowed event names if you want stricter security later.
  // ==========================================================================
  public emitToUser( username: string, event: string, payload: unknown ): void {
    this.nsp.to( `user:${ username }` ).emit( event, payload );
  }

  public emitToRole( role: Role, event: string, payload: unknown ): void {
    this.nsp.to( `role:${ role }` ).emit( event, payload );
  }

  public emitToRooms( rooms: string[], event: string, payload: unknown ): void {
    const safeEvent = this.safeSocketEvent( event );
    const safeRooms = this.safeRoomList( rooms );

    if ( !safeEvent || safeRooms.length === 0 ) {
      console.warn( "[Warning:] [SocketConnectionHandler] emitToRooms skipped (invalid event/rooms)\n", {
        event,
        rooms,
      } );
      return;
    }

    this.nsp.to( safeRooms ).emit( safeEvent, payload );
  }

  public emitToRoom( room: string, event: string, payload: unknown ): void {
    const safeEvent = this.safeSocketEvent( event );
    const safeRoom = this.safeRoom( room );

    if ( !safeEvent || !safeRoom ) {
      console.warn( "[Warning:] [SocketConnectionHandler] emitToRoom skipped (invalid event/room)\n", {
        event,
        room,
      } );
      return;
    }

    this.nsp.to( safeRoom ).emit( safeEvent, payload );
  }

  /**
   * emitToTeamRooms
   * - Emits to BOTH:
   *   1) KPI room:     aud.team.<teamCode>   (auto-joined at connect)
   *   2) Feature room: team:<teamCode>       (FE may subscribe to)
   */
  public emitToTeamRooms( teamCode: string, event: string, payload: unknown ): void {
    const safeTeam = this.safeRoomTeamCode( teamCode );
    const safeEvent = this.safeSocketEvent( event );

    if ( !safeTeam || !safeEvent ) {
      console.warn( "[Warning:] [SocketConnectionHandler] emitToTeamRooms skipped (invalid team/event)\n", {
        teamCode,
        event,
      } );
      return;
    }

    const rooms = [ `aud.team.${ safeTeam }`, `team:${ safeTeam }` ];
    this.nsp.to( rooms ).emit( safeEvent, payload );
  }

  public emitNotification( notif: NotificationPayload ): void {
    const { audience } = notif;
    if ( !audience ) return;

    const event = "notification:new";

    if ( audience.mode === "broadcast" ) {
      this.nsp.to( "broadcast" ).emit( event, notif );
      return;
    }

    if ( audience.mode === "user" && audience.usernames?.length ) {
      for ( const username of audience.usernames ) this.emitToUser( username, event, notif );
    }

    if ( audience.mode === "role" && audience.roles?.length ) {
      for ( const role of audience.roles ) this.emitToRole( role, event, notif );
    }
  }

  // ==========================================================================
  // Forced disconnect helpers (admin/security)
  // ==========================================================================
  public forceDisconnectUser( username: string, reason?: string ): void {
    const safeUser = String( username ?? "" ).trim();
    if ( !safeUser ) {
      console.warn( "[Warning:] [SocketConnectionHandler] forceDisconnectUser called with empty username\n" );
      return;
    }

    const room = `user:${ safeUser }`;

    this.nsp.to( room ).emit( "session:terminated", {
      mode: "user",
      username: safeUser,
      reason: reason ?? "force_logout",
      ts: Date.now(),
    } );

    this.nsp.to( room ).disconnectSockets( true );

    console.log(
      "[Info:] [SocketConnectionHandler] forceDisconnectUser – disconnected all sockets for user=",
      safeUser,
      "\n"
    );
  }

  public forceDisconnectSession( sessionToken: string, reason?: string ): void {
    const safeSession = String( sessionToken ?? "" ).trim();
    if ( !safeSession ) {
      console.warn( "[Warning:] [SocketConnectionHandler] forceDisconnectSession called with empty sessionToken\n" );
      return;
    }

    const room = `session:${ safeSession }`;

    this.nsp.to( room ).emit( "session:terminated", {
      mode: "session",
      sessionToken: safeSession,
      reason: reason ?? "session_invalidated",
      ts: Date.now(),
    } );

    this.nsp.to( room ).disconnectSockets( true );

    console.log(
      "[Info:] [SocketConnectionHandler] forceDisconnectSession – disconnected all sockets for session=",
      safeSession,
      "\n"
    );
  }

  public forceDisconnectRole( role: Role, reason?: string ): void {
    const room = `role:${ role }`;

    this.nsp.to( room ).emit( "session:terminated", {
      mode: "role",
      role,
      reason: reason ?? "role_forced_logout",
      ts: Date.now(),
    } );

    this.nsp.to( room ).disconnectSockets( true );

    console.log(
      "[Info:] [SocketConnectionHandler] forceDisconnectRole – disconnected all sockets for role=",
      role,
      "\n"
    );
  }

  // ==========================================================================
  // KPI rooms (aud.*.*) — MUST MATCH KPI runtime keys exactly
  // ==========================================================================
  private joinKpiRooms(
    socket: TypedSocket,
    ctx: { userId?: string; teamCodes?: string[]; branchId?: string; }
  ): void {
    socket.join( "aud.org.org" );

    if ( Array.isArray( ctx.teamCodes ) ) {
      for ( const teamCode of ctx.teamCodes ) {
        if ( typeof teamCode === "string" && teamCode.trim() ) {
          socket.join( `aud.team.${ teamCode.trim() }` );
        }
      }
    }

    if ( typeof ctx.userId === "string" && ctx.userId.trim() ) {
      socket.join( `aud.member.${ ctx.userId.trim() }` );
    }

    if ( typeof ctx.branchId === "string" && ctx.branchId.trim() ) {
      socket.join( `aud.branch.${ ctx.branchId.trim() }` );
    }

    console.log( "[Info:] [SocketConnectionHandler] KPI rooms joined.\n", {
      userId: ctx.userId ?? null,
      teamCodes: ctx.teamCodes ?? [],
      branchId: ctx.branchId ?? null,
    } );
  }

  // ==========================================================================
  // Safety helpers (minimal sanitization)
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

  private safeRoomTeamCode( v: unknown ): string {
    return typeof v === "string" ? v.trim() : "";
  }
}
