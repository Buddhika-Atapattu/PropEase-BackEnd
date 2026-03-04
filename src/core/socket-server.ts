// Path: src/core/socket-server.ts
//
// Socket.IO server bootstrap for PropEase
// ---------------------------------------
// This class wraps the creation of a Socket.IO server and integrates:
//   - Session-based authentication (NOT JWT-based for initial WS handshake)
//   - Namespace management
//   - Per-socket authorization via GuardTokenService
//   - WS Token validation via Redis-backed WsTokenRegistryRedis (via Provider)
//   - Connection lifecycle handlers via SocketConnectionHandler
//
// ARCHITECTURE NOTES
// ------------------
// 1. Authentication Strategy:
//      - During the handshake, we ONLY validate the sessionToken
//        (cookie or header or handshake.auth).
//      - This proves the connecting socket belongs to an already logged-in user.
//
// 2. Real-time Permission Enforcement:
//      - Once connected, the SocketConnectionHandler can enforce guardToken
//        permissions (e.g., roles, module access).
//
// 3. WebSocket Token (wsToken) Usage:
//      - wsToken is now stored in Redis (WsTokenRegistryRedis), not file logs.
//      - Registry instance is obtained via WsTokenRegistryProvider.getInstance().
//
// 4. Rooms:
//      - user:<username>  → personal notifications
//      - role:<role>      → role-based broadcasting
//      - broadcast        → system-wide broadcasts
//
// ---------------------------------------------------------------------------

import { Server as HttpServer } from 'http';
import { Server as IOServer } from 'socket.io';

import type {
  NotificationPayload,
  TypedNamespace,
  TypedServer,
  TypedSocket
} from '../socket/socket-types.type';

import { AuthUser } from '../types/common';

// Handles extraction of sessionToken from cookies/headers/handshake
import { SocketAuthHelper } from '../socket/socket-auth.helper';

// Handles connection lifecycle, join rooms, chat events, guardToken refresh, etc.
import { SocketConnectionHandler } from '../socket/socket-connection.handler';

// Singleton class for connection handler:
import { SocketServerProvider } from '../socket/socket-server.provider';

// Used during handshake to validate sessionToken → user
import { GuardTokenService } from '../services/guard-token.service';

// Provider for Redis-backed wsToken registry
import { WsTokenRegistryProvider } from '../services/ws-service/ws-token-registry.provider.service';

import { wsSecurityEventLogger } from '../services/ws-service/ws-security-event-logger.service';
import type { PermissionEntry } from '../models/user.model';

// ---------------------------------------------------------------------------
// Options for setting up the Socket.IO server
// ---------------------------------------------------------------------------
type SetupOptions = {
  origins?: string[];        // Allowed CORS origins for WebSocket requests
  jwtSecret: string;         // Used only for auth:update (runtime JWT refresh)
  allowCookieAuth?: boolean; // Allow reading sessionToken from cookies
  namespace?: string;        // Custom namespace or default "/"
};




// ---------------------------------------------------------------------------
// SocketServer Class
// ---------------------------------------------------------------------------
//
// Main responsibilities:
//   1. Attach Socket.IO server to Express/HTTP server
//   2. Perform WS handshake authentication (sessionToken-level)
//   3. Delegate per-connection logic to SocketConnectionHandler
//   4. Provide a notification facade for controllers/services
//
export default class SocketServer {
  private ioServer!: TypedServer;   // The Socket.IO server instance
  private nsp!: TypedNamespace;     // Selected namespace (default "/")

  // Normalised options with defaults applied
  private readonly opts: Required<Omit<SetupOptions, 'namespace'>> & {
    namespace: string;
  };

  private readonly authHelper: SocketAuthHelper;
  private readonly guardTokenService: GuardTokenService;

  // Manages all "on connection" events and handlers
  private connectionHandler!: SocketConnectionHandler;

  // -----------------------------------------------------------------------
  // Constructor: apply default CORS + token handling settings
  // -----------------------------------------------------------------------
  public constructor ( options: SetupOptions ) {
    this.opts = {
      origins: options.origins ?? [ 'http://localhost:4200' ],
      jwtSecret: options.jwtSecret,
      allowCookieAuth: options.allowCookieAuth ?? true,
      namespace: options.namespace ?? '/'
    };

    // Reads sessionToken from cookies/headers/handshake.auth
    this.authHelper = new SocketAuthHelper(
      this.opts.jwtSecret,
      this.opts.allowCookieAuth
    );

    // Resolves user by sessionToken stored in DB (collection: guard tokens)
    this.guardTokenService = new GuardTokenService();
  }

  // -----------------------------------------------------------------------
  // attach()
  //
  // Creates the Socket.IO server on top of an existing Node HTTP server.
  // Enables CORS, sets heartbeat intervals, registers auth middleware,
  // and mounts the namespace.
  //
  // NOTE:
  //   This is now async because we must await WsTokenRegistryProvider
  //   to get the Redis-backed registry instance.
  // -----------------------------------------------------------------------
  public async attach( httpServer: HttpServer ): Promise<TypedNamespace> {
    const io: TypedServer = new IOServer(
      httpServer,
      {
        cors: {
          origin: this.opts.origins,
          credentials: true
        },
        pingInterval: 25_000, // heartbeat freq
        pingTimeout: 20_000   // when to consider client dead
      }
    );

    this.ioServer = io;

    // Use root namespace "/" unless user defined a custom namespace
    this.nsp =
      this.opts.namespace === '/'
        ? io.sockets
        : io.of( this.opts.namespace );

    // -------------------------------------------------------------------
    // 1) AUTH MIDDLEWARE (HANDSHAKE LEVEL)
    //
    // This verifies ONLY the sessionToken.
    // No JWT is needed for the WS handshake.
    //
    // IMPORTANT:
    //   wsToken validation (one-time, Redis-based) runs LATER
    //   inside SocketConnectionHandler during connection handling.
    // -------------------------------------------------------------------
    this.nsp.use(
      async ( socket: TypedSocket, next ) => {
        try {
          // Extract sessionToken from:
          //   - handshake.auth.sessionToken
          //   - cookies (if allowCookieAuth enabled)
          //   - headers
          const rawSessionToken: string | null =
            this.authHelper.extractSessionToken( socket );

          // Normalise user-agent header to a single string
          const uaHeader = socket.handshake.headers[ 'user-agent' ];
          const userAgent: string | undefined =
            typeof uaHeader === 'string'
              ? uaHeader
              : Array.isArray( uaHeader )
                ? ( uaHeader as string[] ).join( '; ' )
                : undefined;

          if ( !rawSessionToken || rawSessionToken.trim().length === 0 ) {
            // No token at all → deny + log (no username known yet → omit username)
            await wsSecurityEventLogger.log( {
              eventType: 'wsTokenDenied',
              socketId: socket.id,
              ip: socket.handshake.address,
              userAgent,
              reason: 'missing session token at handshake'
            } );

            next( new Error( 'Unauthorized' ) );
            return;
          }

          // Now we have a guaranteed, trimmed session token string
          const sessionToken: string = rawSessionToken.trim();

          // Validate token → return user from GuardTokenService
          const user = await this.guardTokenService.resolveUserBySessionToken(
            sessionToken
          );

          if ( !user ) {
            await wsSecurityEventLogger.log( {
              eventType: 'wsTokenDenied',
              // username is unknown here → omit the property instead of using undefined
              sessionToken,
              socketId: socket.id,
              ip: socket.handshake.address,
              userAgent,
              reason: 'invalid/expired session token at handshake'
            } );

            console.warn(
              '[Warning:] [socket auth] Invalid or expired sessionToken – rejecting socket:',
              socket.id,
              '\n'
            );

            next(
              new Error(
                '[Unauthorized] invalid or expired sessionToken – rejecting socket'
              )
            );
            return;
          }

          // Minimal information stored on socket for downstream handlers
          const authUser: AuthUser = {
            name: user.name,
            username: user.username,
            role: user.role as any,
            userId: user._id
          };

          socket.data.authUser = authUser;
          socket.data.sessionToken = sessionToken;

          const permissions = user?.access?.permissions;
          const guardActions = this.buildGuardActions( permissions );
          if ( guardActions.length > 0 ) socket.data.guardActions = guardActions;

          // NEXT STEP:
          // The wsToken will be validated "post-handshake"
          // inside SocketConnectionHandler.registerConnectionHandlers().
          next();
        }
        catch ( error: unknown ) {
          const message: string =
            error instanceof Error ? error.message : String( error );
          console.error(
            '[Error:] [socket auth] Error during handshake:',
            message,
            '\n'
          );
          next(
            new Error(
              '[Unauthorized:] error during handshake: ' + message
            )
          );
        }
      }
    );

    return this.nsp;
  }


  // -----------------------------------------------------------------------
  // attachToApp()
  //
  // Stores the namespace + SocketServer instance on Express.app
  // so that controllers can broadcast notifications using:
  //
  //     req.app.get('socketServer').emitNotification(...)
  //
  // -----------------------------------------------------------------------
  public attachToApp( app: import( 'express' ).Express ): void {
    app.set( 'io', this.nsp );
    app.set( 'socketServer', this );
  }

  // -----------------------------------------------------------------------
  // get instance()
  //
  // Provides direct access to the namespace object. Used by controllers
  // if they need room-level broadcasting without using emitNotification().
  // -----------------------------------------------------------------------
  public get instance(): TypedNamespace {
    if ( !this.nsp ) {
      throw new Error( 'Socket.IO not initialized. Call attach() first.' );
    }
    return this.nsp;
  }

  // -----------------------------------------------------------------------
  // emitNotification()
  //
  // Controllers call this to send real-time notifications.
  // The actual dispatch logic lives inside SocketConnectionHandler.
  // -----------------------------------------------------------------------
  public emitNotification( notif: NotificationPayload ): void {
    if ( !this.connectionHandler ) {
      throw new Error( 'SocketConnectionHandler not initialised.' );
    }
    this.connectionHandler.emitNotification( notif );
  }

  /**
   * Expose the underlying SocketConnectionHandler instance.
   * Useful for bootstrap / diagnostics / advanced wiring.
   */
  public getConnectionHandler(): SocketConnectionHandler {
    if ( !this.connectionHandler ) {
      throw new Error( 'SocketConnectionHandler not initialised. Call attach() first.' );
    }
    return this.connectionHandler;
  }

  /**
   * Build flattened guardActions list from DB permissions.
   *
   * @param permissions
   * - Expected: user.access.permissions (PermissionEntry[])
   *
   * @returns string[]
   * - Example: ["PaymentBilling:create", "LeaseManagement:view"]
   */
  private buildGuardActions( permissions: PermissionEntry[] | undefined | null ): string[] {
    if ( !Array.isArray( permissions ) || permissions.length === 0 ) return [];

    const out: string[] = [];

    for ( const p of permissions ) {
      const mod = typeof p?.module === "string" ? p.module.trim() : "";
      if ( !mod ) continue;

      const acts = Array.isArray( p?.actions ) ? p.actions : [];
      for ( const a of acts ) {
        const act = typeof a === "string" ? a.trim() : "";
        if ( !act ) continue;
        out.push( `${ mod }:${ act }` );
      }
    }

    // dedupe
    return Array.from( new Set( out ) );
  }
}
