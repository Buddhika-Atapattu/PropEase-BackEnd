// Path: src/socket/socket.ts
//
// Socket.IO server bootstrap for PropEase
//  - Auth via JWT (username + role)
//  - Base rooms: user:<username>, role:<role>, broadcast
//  - Notification dispatch helpers
//  - Basic chat + WebRTC signalling scaffolding
//  - Guard token push (BE → FE) every few seconds
// ---------------------------------------------------------------------------

import { Server as HttpServer } from 'http';
import {
  Server as IOServer,
  Namespace,
  Socket as IOSocket,
  type DefaultEventsMap
} from 'socket.io';
import jwt from 'jsonwebtoken';
import type { Role } from "../types/roles";

// ──────────────────────────────────────────────────────────────────────────────
// Domain types
// ──────────────────────────────────────────────────────────────────────────────


type SetupOptions = {
  origins?: string[];
  jwtSecret: string;
  allowCookieAuth?: boolean;
  namespace?: string;
};

type JwtPayload = {
  sub?: string;
  username: string;
  role: Role;
  iat?: number;
  exp?: number;
};

type AuthUser = {
  username: string;
  role: Role;
  sub?: string;
};

/**
 * Socket.IO "data" bag for each connection.
 * Used to store the authenticated user.
 */
type SocketAuthData = {
  authUser?: AuthUser;
};

// Typed aliases for Socket.IO objects in this server
type TypedServer = IOServer<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  SocketAuthData
>;
type TypedNamespace = Namespace<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  SocketAuthData
>;
type TypedSocket = IOSocket<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  SocketAuthData
>;

// ──────────────────────────────────────────────────────────────────────────────
/** Notification / chat / call payload contracts
 *  (keep in sync with FE where applicable)
 */
// ──────────────────────────────────────────────────────────────────────────────

export type AudienceMode = 'user' | 'role' | 'broadcast';

export interface NotificationAudience {
  mode: AudienceMode;
  usernames?: string[];
  roles?: Role[];
}

export interface NotificationPayload {
  _id: string;
  title: string;
  body: string;
  category: string;
  type: string;
  severity?: 'info' | 'success' | 'warning' | 'error';
  audience: NotificationAudience;
  createdAt: string;
  // extend with extra fields when needed
}

export interface ChatMessagePayload {
  id: string;
  roomId?: string;   // e.g. "chat:tenant-123-owner-7"
  from: string;      // enforced by backend (socket auth)
  to?: string;       // direct message target username
  text?: string;
  createdAt: string;
}

// For now, use unknown for SDP / ICE shapes (we only relay them).
// If you add WebRTC types to tsconfig, you can switch to RTCSessionDescriptionInit / RTCIceCandidateInit.
export interface CallSignalBase {
  callId: string;    // unique call/session id
  from: string;      // caller username (enforced server-side)
  to: string;        // callee username
}

export interface CallOfferPayload extends CallSignalBase {
  sdp: unknown;
  kind: 'audio' | 'video' | 'screen' | 'audio_video';
}

export interface CallAnswerPayload extends CallSignalBase {
  sdp: unknown;
}

export interface CallCandidatePayload extends CallSignalBase {
  candidate: unknown;
}

export interface CallEndPayload extends CallSignalBase {
  reason?: string;
}

// Guard token payload (BE → FE)
export interface GuardTokenPayload {
  token: string;   // opaque guard token (short-lived JWT)
  issuedAt: number;
  expiresAt: number;
}

// ──────────────────────────────────────────────────────────────────────────────
// Socket server
// ──────────────────────────────────────────────────────────────────────────────

export default class SocketServer {
  private ioServer!: TypedServer;
  private nsp!: TypedNamespace;

  private readonly opts: Required<Omit<SetupOptions, 'namespace'>> & {
    namespace: string;
  };

  constructor ( options: SetupOptions ) {
    this.opts = {
      origins: options.origins ?? [ 'http://localhost:4200' ],
      jwtSecret: options.jwtSecret,
      allowCookieAuth: options.allowCookieAuth ?? true,
      namespace: options.namespace ?? '/'
    };
  }

  /**
   * Initialize Socket.IO on top of an existing HTTP server.
   * Returns the namespace instance for further customization if needed.
   */
  public attach( httpServer: HttpServer ): TypedNamespace {
    const io: TypedServer = new IOServer<
      DefaultEventsMap,
      DefaultEventsMap,
      DefaultEventsMap,
      SocketAuthData
    >(
      httpServer,
      {
        cors: {
          origin: this.opts.origins,
          credentials: true
        },
        pingInterval: 25_000,
        pingTimeout: 20_000
      }
    );

    this.ioServer = io;
    this.nsp =
      this.opts.namespace === '/'
        ? io.sockets
        : io.of( this.opts.namespace );

    // ──────────────────────────────────────────────────────────────────────
    // Auth middleware
    // ──────────────────────────────────────────────────────────────────────
    this.nsp.use( ( socket: TypedSocket, next ) => {
      try {
        const token = this.extractToken( socket );

        if ( !token ) {
          next( new Error( 'Unauthorized: no token' ) );
          return;
        }

        const decoded = jwt.verify( token, this.opts.jwtSecret );

        if ( !SocketServer.isJwtPayload( decoded ) ) {
          next( new Error( 'Unauthorized: invalid JWT payload' ) );
          return;
        }

        if ( !decoded.username || !decoded.role ) {
          next( new Error( 'Unauthorized: bad payload' ) );
          return;
        }

        socket.data.authUser = SocketServer.toAuthUser( decoded );
        next();
      } catch ( error: unknown ) {
        const message =
          error instanceof Error ? error.message : String( error );
        console.warn( '[socket auth] token rejected:', message );
        next( new Error( 'Unauthorized' ) );
      }
    } );

    // ──────────────────────────────────────────────────────────────────────
    // Connection lifecycle + events
    // ──────────────────────────────────────────────────────────────────────
    this.nsp.on( 'connection', ( socket: TypedSocket ) => {
      const auth = socket.data.authUser;

      if ( !auth?.username || !auth.role ) {
        socket.disconnect( true );
        return;
      }

      // Re-assign to ensure type narrowing
      socket.data.authUser = auth;
      this.joinBaseRooms( socket, auth );

      console.log(
        `✅ Socket connected: ${ auth.username } (role=${ auth.role }) id=${ socket.id }`
      );

      let lastClientPongAt = Date.now();
      let lastServerHelloAt = 0;

      // 1) Server → Client greeting
      socket.emit( 'server:hello', {
        sid: socket.id,
        username: auth.username,
        role: auth.role,
        ts: Date.now(),
        server: {
          name: 'prop-ease-api',
          version: '1.0.0'
        }
      } );

      // 2) Client → Server greeting (FE usually calls emitWithAck('client:hello', ...))
      socket.on(
        'client:hello',
        (
          _payload: unknown,
          ack?: ( resp: { ok: boolean; serverTime: number; } ) => void
        ) => {
          lastServerHelloAt = Date.now();
          if ( ack ) {
            ack( { ok: true, serverTime: lastServerHelloAt } );
          }

          socket.emit( 'server:welcome', {
            ok: true,
            user: socket.data.authUser as AuthUser,
            serverTime: lastServerHelloAt
          } );
        }
      );

      // 3) Client → Server ping (FE uses this for latency checks)
      socket.on(
        'client:ping',
        (
          payload: { t0?: number; } | undefined,
          ack?: ( resp: {
            pong: true;
            ts: number;
            serverTs: number;
          } ) => void
        ) => {
          const t0 =
            typeof payload?.t0 === 'number'
              ? payload.t0
              : Date.now();

          if ( ack ) {
            ack( {
              pong: true,
              ts: t0,
              serverTs: Date.now()
            } );
          }
        }
      );

      // 4) Server → Client heartbeat (server-side health check)
      const heartbeatTimer = setInterval( () => {
        const startedAt = Date.now();

        socket
          .timeout( 4_000 )
          .emit(
            'server:ping',
            { t: startedAt },
            ( err?: Error, clientNow?: number ) => {
              if ( !err && typeof clientNow === 'number' ) {
                lastClientPongAt = Date.now();
              }

              // If client is silent for too long, drop the socket.
              if ( Date.now() - lastClientPongAt > 60_000 ) {
                socket.disconnect( true );
              }
            }
          );
      }, 15_000 );

      socket.on( 'client:pong', () => {
        lastClientPongAt = Date.now();
      } );

      // Guard token auto-push every 5 seconds (BE → FE)
      const pushGuardToken = (): void => {
        try {
          const currentUser = socket.data.authUser;
          if ( !currentUser ) {
            return;
          }

          const guardToken = this.buildGuardToken( currentUser );
          socket.emit( 'guard:update', guardToken );
        } catch ( error: unknown ) {
          console.error( '[guard:update] failed:', error );
        }
      };

      // push immediately on connect, then every 5s
      pushGuardToken();
      const guardTimer = setInterval( pushGuardToken, 5_000 );

      // Dynamic room membership
      socket.on( 'client:subscribe', ( rooms?: unknown ) => {
        for ( const room of SocketServer.safeRooms( rooms ) ) {
          socket.join( room );
        }
      } );

      socket.on( 'client:unsubscribe', ( rooms?: unknown ) => {
        for ( const room of SocketServer.safeRooms( rooms ) ) {
          socket.leave( room );
        }
      } );

      // Runtime auth/token update (e.g., refresh privilege)
      socket.on(
        'auth:update',
        (
          token: string,
          ack?: ( res: { ok: boolean; reason?: string; } ) => void
        ) => {
          try {
            const decoded = jwt.verify( token, this.opts.jwtSecret );

            if ( !SocketServer.isJwtPayload( decoded ) ) {
              throw new Error( 'invalid payload' );
            }

            if ( !decoded.username || !decoded.role ) {
              throw new Error( 'bad token' );
            }

            const previousUser = socket.data.authUser;
            if ( previousUser ) {
              this.leaveBaseRooms( socket, previousUser );
            }

            const nextUser = SocketServer.toAuthUser( decoded );
            socket.data.authUser = nextUser;
            this.joinBaseRooms( socket, nextUser );

            if ( ack ) {
              ack( { ok: true } );
            }

            socket.emit( 'auth:updated', {
              ok: true,
              user: nextUser
            } );
          } catch {
            if ( ack ) {
              ack( { ok: false, reason: 'invalid token' } );
            }

            socket.emit( 'auth:updated', {
              ok: false,
              reason: 'invalid token'
            }
            );
          }
        }
      );

      // Notification delivery ACK hook
      socket.on(
        'notification:ack',
        (
          payload: { notificationId?: string; },
          ack?: ( res: { ok: boolean; } ) => void
        ) => {
          // TODO: mark "delivered" in DB by (socket.data.authUser, payload.notificationId)
          if ( ack ) {
            ack( { ok: true } );
          }
        }
      );

      // CHAT: basic real-time messaging
      socket.on(
        'chat:send',
        ( msg: ChatMessagePayload, ack?: ( res: { ok: boolean; } ) => void ) => {
          try {
            const sender = socket.data.authUser;

            if ( !sender?.username ) {
              throw new Error( 'unauthenticated' );
            }

            const normalized: ChatMessagePayload = {
              ...msg,
              from: sender.username,
              createdAt: msg.createdAt || new Date().toISOString()
            };

            // Direct message → send to user room
            if ( normalized.to ) {
              this.emitToUser(
                normalized.to,
                'chat:new',
                normalized
              );
            }

            // Optional: room-based chats
            if (
              normalized.roomId &&
              SocketServer.isValidRoomName( normalized.roomId )
            ) {
              this.emitToRooms(
                [ normalized.roomId ],
                'chat:new',
                normalized
              );
            }

            // Echo back to sender for optimistic UI
            socket.emit( 'chat:sent', normalized );

            if ( ack ) {
              ack( { ok: true } );
            }
          } catch ( error: unknown ) {
            console.error( '[chat:send] failed:', error );
            if ( ack ) {
              ack( { ok: false } );
            }
          }
        }
      );

      // CALL: WebRTC signalling relay
      socket.on(
        'call:offer',
        (
          payload: CallOfferPayload,
          ack?: ( res: { ok: boolean; } ) => void
        ) => {
          try {
            const sender = socket.data.authUser;
            if ( !sender?.username ) {
              throw new Error( 'unauthenticated' );
            }

            const normalized: CallOfferPayload = {
              ...payload,
              from: sender.username
            };

            this.emitToUser(
              normalized.to,
              'call:offer',
              normalized
            );

            if ( ack ) {
              ack( { ok: true } );
            }
          } catch ( error: unknown ) {
            console.error( '[call:offer] failed:', error );
            if ( ack ) {
              ack( { ok: false } );
            }
          }
        }
      );

      socket.on(
        'call:answer',
        (
          payload: CallAnswerPayload,
          ack?: ( res: { ok: boolean; } ) => void
        ) => {
          try {
            const sender = socket.data.authUser;
            if ( !sender?.username ) {
              throw new Error( 'unauthenticated' );
            }

            const normalized: CallAnswerPayload = {
              ...payload,
              from: sender.username
            };

            this.emitToUser(
              normalized.to,
              'call:answer',
              normalized
            );

            if ( ack ) {
              ack( { ok: true } );
            }
          } catch ( error: unknown ) {
            console.error( '[call:answer] failed:', error );
            if ( ack ) {
              ack( { ok: false } );
            }
          }
        }
      );

      socket.on(
        'call:candidate',
        (
          payload: CallCandidatePayload,
          ack?: ( res: { ok: boolean; } ) => void
        ) => {
          try {
            const sender = socket.data.authUser;
            if ( !sender?.username ) {
              throw new Error( 'unauthenticated' );
            }

            const normalized: CallCandidatePayload = {
              ...payload,
              from: sender.username
            };

            this.emitToUser(
              normalized.to,
              'call:candidate',
              normalized
            );

            if ( ack ) {
              ack( { ok: true } );
            }
          } catch ( error: unknown ) {
            console.error( '[call:candidate] failed:', error );
            if ( ack ) {
              ack( { ok: false } );
            }
          }
        }
      );

      socket.on(
        'call:end',
        (
          payload: CallEndPayload,
          ack?: ( res: { ok: boolean; } ) => void
        ) => {
          try {
            const sender = socket.data.authUser;
            if ( !sender?.username ) {
              throw new Error( 'unauthenticated' );
            }

            const normalized: CallEndPayload = {
              ...payload,
              from: sender.username
            };

            this.emitToUser(
              normalized.to,
              'call:end',
              normalized
            );

            if ( ack ) {
              ack( { ok: true } );
            }
          } catch ( error: unknown ) {
            console.error( '[call:end] failed:', error );
            if ( ack ) {
              ack( { ok: false } );
            }
          }
        }
      );

      // Cleanup
      socket.on( 'disconnecting', ( reason: string ) => {
        clearInterval( heartbeatTimer );
        clearInterval( guardTimer );
        console.log(
          `↘️  Socket disconnecting: ${ auth.username } (${ reason }) id=${ socket.id }`
        );
      } );

      socket.on( 'disconnect', ( reason: string ) => {
        clearInterval( heartbeatTimer );
        clearInterval( guardTimer );
        console.log(
          `↘️  Socket disconnected: ${ auth.username } (${ reason }) id=${ socket.id }`
        );
      } );
    } );

    return this.nsp;
  }

  /**
   * Build a short-lived guard token for FE (e.g., to drive HTTP guards).
   * TTL and payload can be tuned as needed.
   */
  private buildGuardToken( user: AuthUser ): GuardTokenPayload {
    const issuedAt = Date.now();
    const expiresAt = issuedAt + 10_000; // 10s TTL

    const payload: JwtPayload = {
      username: user.username,
      role: user.role,
      iat: Math.floor( issuedAt / 1000 ),
      exp: Math.floor( expiresAt / 1000 )
    };

    if ( user.sub ) {
      payload.sub = user.sub;
    }

    const token = jwt.sign( payload, this.opts.jwtSecret, {
      algorithm: 'HS256'
    } );

    return {
      token,
      issuedAt,
      expiresAt
    };
  }

  /**
   * Attach the namespace instance to Express so controllers can use it via
   * req.app.get('io') or req.app.get('socketServer').
   */
  public attachToApp( app: import( 'express' ).Express ): void {
    app.set( 'io', this.nsp );
    app.set( 'socketServer', this );
  }

  /**
   * Get the active namespace. Throws if attach() has not been called yet.
   */
  public get instance(): TypedNamespace {
    if ( !this.nsp ) {
      throw new Error( 'Socket.IO not initialized. Call attach() first.' );
    }
    return this.nsp;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Emission helpers
  // ──────────────────────────────────────────────────────────────────────────

  public emitToUser(
    username: string,
    event: string,
    payload: unknown
  ): void {
    this.instance.to( `user:${ username }` ).emit( event, payload );
  }

  public emitToRole(
    role: Role,
    event: string,
    payload: unknown
  ): void {
    this.instance.to( `role:${ role }` ).emit( event, payload );
  }

  public emitBroadcast(
    event: string,
    payload: unknown
  ): void {
    this.instance.to( 'broadcast' ).emit( event, payload );
  }

  public emitToRooms(
    rooms: string[],
    event: string,
    payload: unknown
  ): void {
    if ( !rooms || rooms.length === 0 ) {
      return;
    }
    this.instance.to( rooms ).emit( event, payload );
  }

  /**
   * Notification-specific helper.
   * Uses unified event name `notification:new` to match FE NotificationService.
   */
  public emitNotification( notif: NotificationPayload ): void {
    const { audience } = notif;
    if ( !audience ) {
      return;
    }

    const event = 'notification:new';

    if ( audience.mode === 'broadcast' ) {
      this.emitBroadcast( event, notif );
      return;
    }

    if ( audience.mode === 'user' && audience.usernames?.length ) {
      for ( const username of audience.usernames ) {
        this.emitToUser( username, event, notif );
      }
    }

    if ( audience.mode === 'role' && audience.roles?.length ) {
      for ( const role of audience.roles ) {
        this.emitToRole( role, event, notif );
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Internals
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Extract token from:
   *  - socket.handshake.auth.token
   *  - Authorization: Bearer <token>
   *  - cookie: token=<token> (if allowCookieAuth)
   */
  private extractToken( socket: TypedSocket ): string | null {
    // 1) handshake.auth.token
    const authHandshake = socket.handshake as {
      auth?: { token?: string; };
    };

    const fromAuth = authHandshake.auth?.token;
    if ( typeof fromAuth === 'string' && fromAuth.trim().length > 0 ) {
      return fromAuth.trim();
    }

    // 2) Authorization header
    const authHeader = socket.handshake.headers.authorization;
    if ( authHeader ) {
      const value = authHeader.trim();
      if ( value.toLowerCase().startsWith( 'bearer ' ) ) {
        const token = value.slice( 7 ).trim();
        if ( token.length > 0 ) {
          return token;
        }
      }
    }

    // 3) Cookie
    if ( this.opts.allowCookieAuth ) {
      const cookieHeader = socket.handshake.headers.cookie ?? '';
      if ( cookieHeader ) {
        const segments = cookieHeader
          .split( ';' )
          .map( ( s ) => s.trim() )
          .filter( ( s ) => s.length > 0 );

        for ( const segment of segments ) {
          if ( segment.startsWith( 'token=' ) ) {
            const [ , rawValue ] = segment.split( '=' );
            const token = ( rawValue ?? '' ).trim();
            if ( token.length > 0 ) {
              return token;
            }
          }
        }
      }
    }

    return null;
  }

  private joinBaseRooms( socket: TypedSocket, user: AuthUser ): void {
    socket.join( `user:${ user.username }` );
    socket.join( `role:${ user.role }` );
    socket.join( 'broadcast' );
  }

  private leaveBaseRooms( socket: TypedSocket, user: AuthUser ): void {
    socket.leave( `user:${ user.username }` );
    socket.leave( `role:${ user.role }` );
    socket.leave( 'broadcast' );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Static helpers (no global functions, to keep everything class-based)
  // ──────────────────────────────────────────────────────────────────────────

  /** Only allow simple room names (a-z0-9:/-_), up to 64 chars. */
  private static readonly ROOM_RE: RegExp = /^[a-z0-9:/_-]{1,64}$/i;

  private static isValidRoomName( room: string ): boolean {
    return SocketServer.ROOM_RE.test( room );
  }

  private static safeRooms( rooms: unknown ): string[] {
    if ( !Array.isArray( rooms ) ) {
      return [];
    }

    const result: string[] = [];

    for ( const item of rooms ) {
      if ( typeof item !== 'string' ) {
        continue;
      }

      const trimmed = item.trim();
      if ( trimmed.length > 0 && SocketServer.isValidRoomName( trimmed ) ) {
        result.push( trimmed );
      }
    }

    return result;
  }

  private static toAuthUser( payload: JwtPayload ): AuthUser {
    const base: AuthUser = {
      username: payload.username,
      role: payload.role
    };

    if ( payload.sub ) {
      base.sub = payload.sub;
    }

    return base;
  }

  private static isJwtPayload( decoded: unknown ): decoded is JwtPayload {
    if ( typeof decoded !== 'object' || decoded === null ) {
      return false;
    }

    const candidate = decoded as {
      username?: unknown;
      role?: unknown;
    };

    const hasValidUsername =
      typeof candidate.username === 'string' &&
      candidate.username.trim().length > 0;

    const validRoles: Role[] = [
      'admin',
      'agent',
      'tenant',
      'owner',
      'operator',
      'manager',
      'developer',
      'user'
    ];

    const hasValidRole = validRoles.includes(
      candidate.role as Role
    );

    return hasValidUsername && hasValidRole;
  }
}
