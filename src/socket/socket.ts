// src/socket/socket.ts
import {Server as HttpServer} from 'http';
import {Server as IOServer, Socket} from 'socket.io';
import jwt from 'jsonwebtoken';

type SetupOptions = {
  /** Allowed frontend origins for CORS (Angular dev, etc.) */
  origins?: string[];
  /** JWT secret used to verify tokens */
  jwtSecret: string;
  /** Whether to accept cookies as a secondary token source */
  allowCookieAuth?: boolean;
};

type JwtPayload = {
  /** Optional numeric/UUID subject you may already use */
  sub?: string;
  /** REQUIRED for our design: your unique PK */
  username: string;
  /** REQUIRED: single user role (per your IUser model) */
  role:
  | 'admin' | 'agent' | 'tenant' | 'owner'
  | 'operator' | 'manager' | 'developer' | 'user';
  /** Any other claims you carry… */
  iat?: number;
  exp?: number;
};

export default class SocketServer {
  private io!: IOServer;
  private readonly opts: Required<SetupOptions>; // <-- fixed generic

  constructor (options: SetupOptions) {
    this.opts = {
      origins: options.origins ?? ['http://localhost:4200'],
      jwtSecret: options.jwtSecret,
      allowCookieAuth: options.allowCookieAuth ?? true,
    };
  }

  /** Initialize Socket.IO on top of your existing HTTP server */
  attach(httpServer: HttpServer) {
    this.io = new IOServer(httpServer, {
      cors: {
        origin: this.opts.origins,
        credentials: true,
      },
    });

    // 1) Auth middleware (JWT -> username + role)
    this.io.use((socket, next) => {
      try {
        const token = this.extractToken(socket);
        if(!token) return next(new Error('Unauthorized'));

        const payload = jwt.verify(token, this.opts.jwtSecret) as JwtPayload;

        // Validate required claims for our room model
        if(!payload.username || !payload.role) {
          return next(new Error('Unauthorized'));
        }

        // Stash on socket (typed as any to avoid augmenting Socket interface)
        (socket as any).authUser = {
          username: payload.username,
          role: payload.role,
          sub: payload.sub, // optional
        };
        next();
      } catch {
        next(new Error('Unauthorized'));
      }
    });

    // 2) Connection handler → join rooms
    this.io.on('connection', (socket) => {
      const auth = (socket as any).authUser as {username: string; role: string} | undefined;
      if(!auth?.username || !auth?.role) {
        socket.disconnect(true);
        return;
      }

      // Join per-username, per-role, and broadcast rooms
      socket.join(`user:${auth.username}`);
      socket.join(`role:${auth.role}`);
      socket.join('broadcast');

      console.log(`✅ Socket connected: ${auth.username} (role=${auth.role})`);

      // Optional: ping handler
      // socket.on('ping', () => socket.emit('pong'));
    });

    return this.io;
  }

  /** Access the underlying io (for emitting from controllers/services) */
  get instance(): IOServer {
    if(!this.io) throw new Error('Socket.IO not initialized. Call attach() first.');
    return this.io;
  }

  /* -------------------- Emission Helpers -------------------- */

  /** Emit to a single user’s room (by username PK) */
  emitToUser(username: string, event: string, payload: any) {
    this.instance.to(`user:${username}`).emit(event, payload);
  }

  /** Emit to everyone in a role */
  emitToRole(role: JwtPayload['role'], event: string, payload: any) {
    this.instance.to(`role:${role}`).emit(event, payload);
  }

  /** Emit to all connected sockets that joined 'broadcast' */
  emitBroadcast(event: string, payload: any) {
    this.instance.to('broadcast').emit(event, payload);
  }

  /** Emit the same payload to multiple rooms at once */
  emitToRooms(rooms: string[], event: string, payload: any) {
    rooms.forEach((r) => this.instance.to(r).emit(event, payload));
  }

  /* -------------------- Internals -------------------- */

  /** Helper: extract token from handshake auth, Authorization header, or cookie */
  private extractToken(socket: Socket): string | null {
    // Preferred: client sends { auth: { token } } when connecting
    const fromAuth = (socket.handshake as any).auth?.token as string | undefined;
    if(fromAuth) return fromAuth;

    // Also support Authorization: Bearer <token>
    const authz = socket.handshake.headers.authorization;
    if(authz?.toLowerCase().startsWith('bearer ')) {
      return authz.slice(7).trim();
    }

    if(this.opts.allowCookieAuth) {
      // Secondary: try cookie header (e.g., "token=<jwt>; other=..."). Basic parse.
      const cookie = socket.handshake.headers.cookie ?? '';
      const match = cookie
        .split(';')
        .map((s) => s.trim())
        .find((s) => s.startsWith('token='));
      if(match) return match.split('=')[1] || null;
    }

    return null;
  }
}
