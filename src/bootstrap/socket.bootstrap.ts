// Path: src/bootstrap/socket.bootstrap.ts

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

  public async init(): Promise<SocketBootstrapResult> {
    const jwtSecret: string = ( JWT_SECRET || "defaultsecret" ).trim();

    const origins: string[] = [
      "http://localhost:4200",
      ( FRONTEND_ORIGIN || "" ).trim(),
    ].filter( ( x ): x is string => Boolean( x && String( x ).trim() ) );

    // 1) Create SocketServer wrapper
    const socketServer: SocketServer = new SocketServer( {
      origins,
      jwtSecret,
      allowCookieAuth: true,
    } );

    // 2) Attach Socket.IO to HTTP server
    const io: TypedNamespace = await socketServer.attach( this.httpServer );

    // 3) Helpers
    const socketAuthHelper: SocketAuthHelper = new SocketAuthHelper( jwtSecret, true );
    const guardTokenService: GuardTokenService = new GuardTokenService();

    // 4) Resolve wsToken registry
    const wsTokenRegistryRedis: WsTokenRegistryRedis =
      await WsTokenRegistryProvider.getInstance();

    // 5) Connection handler from SocketServer
    const socketConnectionHandler: SocketConnectionHandler =
      socketServer.getConnectionHandler();

    // 6) Attach socket monitor ONCE
    this.monitor.installSocket( io );

    // ----------------------------------------------------------------------------
    // ✅ COMMENTS WS GATEWAY (attach ONCE, canonical)
    // ----------------------------------------------------------------------------
    try {
      /**
       * IMPORTANT:
       * - In Phase-2/Phase-4, validation + model lock are driven by CommentsSourceRegistry.
       * - This `sectionToModelName` is only a legacy/aux mapping (RBAC / external checks).
       * - Therefore we build it from the registry using canonical mongoose model names.
       */
      const sectionToModelName: Record<string, string> = {};

      for ( const src of CommentsSourceRegistry.getAllSources() ) {
        // We key by section only (not subsection)
        // Use first-seen model as default for that section.
        // Teams will likely map to TeamManagement (subSection "Teams") by insertion order.
        if ( !sectionToModelName[ src.section ] ) {
          sectionToModelName[ src.section ] = src.mongooseModelName;
        }
      }

      const commentsGateway = new CommentsWsGateway( io, {
        sectionToModelName,

        // Optional RBAC hook (enable later)
        // canSubscribe: (actor, target) => {
        //   return true;
        // },
      } );

      commentsGateway.attach();
      CommentsWsRegistry.setGateway( commentsGateway );

      console.log( "[Info:] [SocketBootstrap] Comments WS gateway attached.\n" );
    } catch ( err ) {
      console.error( "[Warning:] [SocketBootstrap] Comments WS attach failed.\n", err );
    }

    // ----------------------------------------------------------------------------
    // KPI Runtime boot (WS-only)
    // ----------------------------------------------------------------------------
    try {
      KpisRuntime.getInstance().startRealtime( io );
      console.log( "[Info:] [SocketBootstrap] KPI runtime realtime started.\n" );
    } catch ( err ) {
      console.error( "[Warning:] [SocketBootstrap] KPI runtime realtime start failed.\n", err );
    }

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
