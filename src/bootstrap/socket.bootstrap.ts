// Path: src/bootstrap/socket.bootstrap.ts

import type { Server as HttpServer } from 'http';

import SocketServer from '../core/socket-server';
import { SocketConnectionHandler } from '../socket/socket-connection.handler';
import { SocketAuthHelper } from '../socket/socket-auth.helper';
import type { TypedNamespace } from '../socket/socket-types.type';
import { GuardTokenService } from '../services/guard-token.service';
import TrafficMonitor from '../middleware/trafficMonitor';
import { FRONTEND_ORIGIN, JWT_SECRET } from '../configs/env.config';
import { WsTokenRegistryProvider } from '../services/ws-service/ws-token-registry.provider.service';
import type { WsTokenRegistryRedis } from '../services/ws-service/ws-token-registry.redis.service';

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

  public constructor( httpServer: HttpServer, monitor: TrafficMonitor ) {
    this.httpServer = httpServer;
    this.monitor = monitor;
  }

  /**
   * Initialise Socket.IO and related helpers.
   *
   * Responsibilities:
   *   - Create SocketServer with CORS + JWT secret config.
   *   - Attach Socket.IO to the existing HTTP server (async, because Redis).
   *   - Resolve the shared Redis-backed wsToken registry.
   *   - Expose the SocketConnectionHandler instance created by SocketServer.
   *   - Install TrafficMonitor hooks on the namespace.
   */
  public async init(): Promise<SocketBootstrapResult> {
    const jwtSecret: string = ( JWT_SECRET || 'defaultsecret' ).trim();

    const origins: string[] = [
      'http://localhost:4200',
      ( FRONTEND_ORIGIN || '' ).trim() || undefined
    ].filter( Boolean ) as string[];

    // 1) Create the SocketServer wrapper
    const socketServer: SocketServer = new SocketServer( {
      origins,
      jwtSecret,
      allowCookieAuth: true
    } );

    // 2) Attach Socket.IO to the HTTP server
    //    NOTE: attach() is async because it awaits WsTokenRegistryProvider
    const io: TypedNamespace = await socketServer.attach( this.httpServer );

    // 3) Create helpers that controllers/services may want to reuse directly
    const socketAuthHelper: SocketAuthHelper = new SocketAuthHelper(
      jwtSecret,
      true
    );

    const guardTokenService: GuardTokenService = new GuardTokenService();

    // 4) Resolve the Redis-backed wsToken registry instance
    const wsTokenRegistryRedis: WsTokenRegistryRedis =
      await WsTokenRegistryProvider.getInstance();

    // 5) Get the connection handler created inside SocketServer
    const socketConnectionHandler: SocketConnectionHandler =
      socketServer.getConnectionHandler();

    // 6) Attach socket monitor for metrics / debugging
    this.monitor.installSocket( io );

    return {
      socketServer,
      io,
      socketAuthHelper,
      guardTokenService,
      wsTokenRegistryRedis,
      socketConnectionHandler
    };
  }
}
