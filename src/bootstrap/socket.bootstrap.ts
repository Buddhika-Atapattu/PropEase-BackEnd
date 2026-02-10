// Path: src/bootstrap/socket.bootstrap.ts
// ============================================================================
// SocketBootstrap
// ----------------------------------------------------------------------------
// PURPOSE
// - This is the single “composition root” for your WebSocket layer.
// - It wires Socket.IO to the HTTP server, sets up authentication helpers,
//   registers connection handlers, attaches monitoring, and bootstraps
//   feature-specific gateways (Comments, KPI runtime, etc).
//
// WHY THIS FILE MATTERS
// - If the socket layer is “double-attached” or “double-registered”, you get:
//    • duplicate events
//    • memory leaks
//    • handlers firing twice
//    • room-join duplication
// - So this file must remain deterministic and attach each subsystem ONCE.
// ============================================================================

import type { Server as HttpServer } from "http";

import SocketServer from "../core/socket-server";
import { SocketConnectionHandler } from "../socket/socket-connection.handler";
import { SocketAuthHelper } from "../socket/socket-auth.helper";
import type { TypedNamespace } from "../socket/socket-types.type";

import { GuardTokenService } from "../services/guard-token.service";
import TrafficMonitor from "../middleware/trafficMonitor";

import { FRONTEND_ORIGIN, JWT_SECRET } from "../configs/env.config";

import { WsTokenRegistryProvider } from "../services/ws-service/ws-token-registry.provider.service";
import type { WsTokenRegistryRedis } from "../services/ws-service/ws-token-registry.redis.service";

import { KpisRuntime } from "../KPIs/kpis.runtime";

import { CommentsWsGateway } from "../socket/comments/comments-ws.gateway";
import { CommentsWsRegistry } from "../socket/comments/comments-ws.registry";
import { CommentsSourceRegistry } from "../source/comments.source";

import { WsEmitterProvider } from "../socket/ws-emitter.provider";

// ============================================================================
// Result contract for bootstrap
// - Returning these instances makes AppServer/Core testable and explicit.
// - Also helps other bootstraps reuse shared socket services without
//   re-creating them.
// ============================================================================
interface SocketBootstrapResult {
  socketServer: SocketServer;
  io: TypedNamespace;
  socketAuthHelper: SocketAuthHelper;
  guardTokenService: GuardTokenService;
  wsTokenRegistryRedis: WsTokenRegistryRedis;
  socketConnectionHandler: SocketConnectionHandler;
}

export class SocketBootstrap {
  private readonly httpServer: HttpServer;
  private readonly monitor: TrafficMonitor;

  public constructor ( httpServer: HttpServer, monitor: TrafficMonitor ) {
    this.httpServer = httpServer;
    this.monitor = monitor;
  }

  // ==========================================================================
  // init()
  // --------------------------------------------------------------------------
  // BOOT ORDER (important):
  // 1) Build server config (origins, jwtSecret)
  // 2) Create SocketServer wrapper
  // 3) Attach to HTTP server -> get io namespace
  // 4) Create helpers: auth + guardToken + wsToken registry
  // 5) Register connection handler (rooms, auth handshake, token refresh, etc.)
  // 6) Attach monitor (traffic + socket analytics)
  // 7) Attach feature gateways (Comments, KPI runtime)
  // ==========================================================================
  public async init(): Promise<SocketBootstrapResult> {
    // ------------------------------------------------------------------------
    // 0) JWT secret normalization
    // WHY:
    // - Socket auth is security-critical.
    // - `.trim()` avoids invisible whitespace issues from env variables.
    // NOTE:
    // - Keeping "defaultsecret" can be OK in dev, but in production you should
    //   fail-fast if JWT_SECRET is missing. (You can enforce later.)
    // ------------------------------------------------------------------------
    const jwtSecret: string = ( JWT_SECRET || "defaultsecret" ).trim();

    // ------------------------------------------------------------------------
    // 0.1) Allowed origins list
    // WHY:
    // - CORS for sockets is different from HTTP; you MUST explicitly control it.
    // - Filter removes empty/whitespace entries (no undefined/empty origins).
    // ------------------------------------------------------------------------
    const origins: string[] = [
      "http://localhost:4200",
      ( FRONTEND_ORIGIN || "" ).trim(),
    ].filter( ( x ): x is string => Boolean( x && String( x ).trim() ) );

    // ------------------------------------------------------------------------
    // 1) Create SocketServer wrapper (your project abstraction)
    // WHY:
    // - Keeps socket server configuration in one place.
    // - Allows sharing patterns across projects: auth, CORS, cookie auth, etc.
    // ------------------------------------------------------------------------
    const socketServer: SocketServer = new SocketServer( {
      origins,
      jwtSecret,
      allowCookieAuth: true,
    } );

    // ------------------------------------------------------------------------
    // 2) Attach Socket.IO to HTTP server
    // WHY:
    // - This is the single “real attach” point.
    // - Must happen before any handler/gateway tries to use `io`.
    // ------------------------------------------------------------------------
    const io: TypedNamespace = await socketServer.attach( this.httpServer );

    // ------------------------------------------------------------------------
    // 3) Helpers
    // 3.1 SocketAuthHelper
    // WHY:
    // - Centralises token verification/decoding and auth extraction for sockets.
    // - The boolean flag (true) in your implementation likely indicates:
    //   allow cookie auth / allow legacy / strict mode. Keep consistent.
    //
    // 3.2 GuardTokenService
    // WHY:
    // - Your HTTP layer uses guard tokens (fast-rotating).
    // - Socket layer needs the same logic to validate/refresh user sessions.
    // ------------------------------------------------------------------------
    const socketAuthHelper: SocketAuthHelper = new SocketAuthHelper( jwtSecret, true );
    const guardTokenService: GuardTokenService = new GuardTokenService();

    // ------------------------------------------------------------------------
    // 4) Resolve wsToken registry (Redis-backed)
    // WHY:
    // - WS tokens rotate slower than guard tokens.
    // - Redis registry allows:
    //    • cross-instance validation (future scaling)
    //    • token revoke
    //    • session continuity
    // ------------------------------------------------------------------------
    const wsTokenRegistryRedis: WsTokenRegistryRedis =
      await WsTokenRegistryProvider.getInstance();

    // ------------------------------------------------------------------------
    // 5) Connection handler
    // WHY:
    // - This is the canonical place where sockets are authenticated and placed
    //   into correct rooms:
    //    • aud.team.<teamCode>
    //    • aud.member.<userId>
    //    • user:<username>
    //    • (optional) team:<teamCode>
    //
    // - If you do NOT centralize this, each gateway will “invent its own” room
    //   logic and you will get mismatches and missing UI updates.
    //
    // IMPORTANT:
    // - registerConnectionHandlers() must run exactly once.
    // ------------------------------------------------------------------------
    // ✅ Create + register singleton (bootstrap-only)
    const socketConnectionHandler: SocketConnectionHandler = SocketConnectionHandler.Init(
      io,
      socketAuthHelper,
      guardTokenService,
      wsTokenRegistryRedis
    );

    // ✅ Attach namespace handlers ONCE
    socketConnectionHandler.registerConnectionHandlers();

    // ✅ Now it is safe, because _instance exists
    WsEmitterProvider.InitFromHandler( socketConnectionHandler );


    // ------------------------------------------------------------------------
    // 6) Attach socket monitor ONCE
    // WHY:
    // - Your TrafficMonitor is not just logging; it’s system-level observability.
    // - Must not be attached multiple times (duplicate logs & overhead).
    // ------------------------------------------------------------------------
    this.monitor.installSocket( io );

    // =========================================================================
    // 7) COMMENTS WS GATEWAY (attach ONCE, canonical)
    // -------------------------------------------------------------------------
    // WHY we do it here:
    // - SocketBootstrap is the system root for WS. Gateways belong here.
    //
    // WHY we build sectionToModelName from CommentsSourceRegistry:
    // - The source registry is your "single source of truth" for:
    //    • which sections exist
    //    • which mongoose model is associated
    //    • future validation rules (Phase-2/Phase-4)
    //
    // IMPORTANT:
    // - This map is “legacy/aux” to help the gateway/RBAC perform quick lookups.
    // - Canonical validation should still be driven by CommentsSourceRegistry.
    // =========================================================================
    try {
      const sectionToModelName: Record<string, string> = {};

      // Registry -> stable mapping
      // NOTE:
      // - We key by section only (NOT subsection).
      // - First-seen wins. That means for Teams, the first registered source
      //   becomes the default model for section "Teams".
      for ( const src of CommentsSourceRegistry.getAllSources() ) {
        if ( !sectionToModelName[ src.section ] ) {
          sectionToModelName[ src.section ] = src.mongooseModelName;
        }
      }

      const commentsGateway: CommentsWsGateway = new CommentsWsGateway( io, {
        sectionToModelName,

        // Optional RBAC hook (enable later)
        // canSubscribe: (actor, target) => {
        //   return true;
        // },
      } );

      // Attach once -> gateway registers its socket events
      commentsGateway.attach();

      // Persist gateway instance in registry for other parts of the backend
      CommentsWsRegistry.setGateway( commentsGateway );

      console.log( "[Info:] [SocketBootstrap] Comments WS gateway attached.\n" );
    } catch ( err ) {
      console.error( "[Warning:] [SocketBootstrap] Comments WS attach failed.\n", err );
    }

    // =========================================================================
    // 8) KPI Runtime boot (WS-only)
    // -------------------------------------------------------------------------
    // WHY:
    // - KPI runtime emits realtime updates (dashboards, charts, monitoring).
    // - This should happen AFTER io is attached and connection handler is ready,
    //   so KPI runtime can broadcast to valid rooms/users.
    // =========================================================================
    try {
      KpisRuntime.getInstance().startRealtime( io );
      console.log( "[Info:] [SocketBootstrap] KPI runtime realtime started.\n" );
    } catch ( err ) {
      console.error( "[Warning:] [SocketBootstrap] KPI runtime realtime start failed.\n", err );
    }

    // ------------------------------------------------------------------------
    // 9) Return handles
    // WHY:
    // - Allows AppServer/Core to keep references for future integration tests,
    //   health checks, and controlled shutdown strategies.
    // ------------------------------------------------------------------------
    return {
      socketServer,
      io,
      socketAuthHelper,
      guardTokenService,
      wsTokenRegistryRedis,
      socketConnectionHandler,
    };
  }
}
