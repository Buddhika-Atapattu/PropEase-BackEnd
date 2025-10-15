//src/socket/socket.ts
import {Server as HttpServer} from 'http';
import {Server as IOServer, Socket, Namespace} from 'socket.io';
import jwt from 'jsonwebtoken';

export type Role =
  | 'admin' | 'agent' | 'tenant' | 'owner'
  | 'operator' | 'manager' | 'developer' | 'user';

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

type AuthUser = {username: string; role: Role; sub?: string};

// Small helper to safely build AuthUser without ever assigning `undefined`
function toAuthUser(p: JwtPayload): AuthUser {
  const base = {username: p.username, role: p.role} as const;
  return p.sub ? {...base, sub: p.sub} : base;
}


// small helper: only allow simple room names (a-z0-9:/-_)
const ROOM_RE = /^[a-z0-9:/_-]{1,64}$/i;
const safeRooms = (rooms: unknown) =>
  (Array.isArray(rooms) ? rooms : [])
    .filter((r): r is string => typeof r === 'string' && ROOM_RE.test(r));

export default class SocketServer {
  private ioServer!: IOServer;
  private nsp!: Namespace;

  private readonly opts: Required<Omit<SetupOptions, 'namespace'>> & {namespace: string};

  constructor (options: SetupOptions) {
    this.opts = {
      origins: options.origins ?? ['http://localhost:4200'],
      jwtSecret: options.jwtSecret,
      allowCookieAuth: options.allowCookieAuth ?? true,
      namespace: options.namespace ?? '/',
    };
  }


  /** Initialize Socket.IO on top of your existing HTTP server */
  attach(httpServer: HttpServer) {
    // Add explicit ping settings (Socket.IO already pings, we’ll add an app heartbeat too)
    const io = new IOServer(httpServer, {
      cors: {origin: this.opts.origins, credentials: true},
      pingInterval: 25000, // default 25000
      pingTimeout: 20000,  // default 20000
      // NOTE: keep defaults unless you have special infra constraints
    });

    this.ioServer = io;
    this.nsp = this.opts.namespace === '/' ? io.sockets : io.of(this.opts.namespace);

    // -------- Auth middleware --------
    this.nsp.use((socket, next) => {
      try {
        const token = this.extractToken(socket);
        if(!token) return next(new Error('Unauthorized: no token'));
        const payload = jwt.verify(token, this.opts.jwtSecret) as JwtPayload;
        if(!payload.username || !payload.role) return next(new Error('Unauthorized: bad payload'));

        socket.data.authUser = toAuthUser(payload);   // ✅ omit sub if undefined
        next();
      } catch(e: any) {
        console.warn('[socket auth] token rejected:', e?.message || e);
        next(new Error('Unauthorized'));
      }
    });

    // -------- Connection lifecycle --------
    this.nsp.on('connection', (socket: Socket) => {
      // ---------- auth from handshake (your middleware already verified the token) ----------
      const auth = socket.data.authUser as {username: string; role: Role} | undefined;
      if(!auth?.username || !auth?.role) return socket.disconnect(true);

      // keep the canonical copy on socket.data
      socket.data.authUser = auth;

      // ---------- join base rooms & greet ----------
      this.joinBaseRooms(socket, auth);
      console.log(`✅ Socket connected: ${auth.username} (role=${auth.role}) id=${socket.id}`);

      // track liveness/latency for this socket
      let lastClientPongAt = Date.now();
      let lastServerHelloAt = 0;

      // 1) Server → Client greeting
      socket.emit('server:hello', {
        sid: socket.id,
        username: auth.username,
        role: auth.role,
        ts: Date.now(),
        server: {name: 'prop-ease-api', version: '1.0.0'},
      });

      // 2) Client → Server greeting (single handler, with ack + server welcome)
      socket.on('client:hello', (payload: any, ack?: (resp: {ok: boolean; serverTime: number}) => void) => {
        lastServerHelloAt = Date.now();
        ack?.({ok: true, serverTime: lastServerHelloAt});
        socket.emit('server:welcome', {
          ok: true,
          user: socket.data.authUser as AuthUser,
          serverTime: lastServerHelloAt,
        });
      });

      // 3) Client → Server ping (client measures RTT using ack)
      socket.on('client:ping', (ts: number, ack?: (resp: {pong: true; ts: number; serverTs: number}) => void) => {
        ack?.({pong: true, ts, serverTs: Date.now()});
      });

      // 4) Server → Client ping (server measures client responsiveness)
      // use timeout-wrapped acks to auto-fail if the client doesn't answer
      const hb = setInterval(() => {
        const startedAt = Date.now();
        socket
          .timeout(4000)
          .emit('server:ping', {t: startedAt}, (err?: Error, clientNow?: number) => {
            if(!err) {
              lastClientPongAt = Date.now();
            }
            if(Date.now() - lastClientPongAt > 60000) socket.disconnect(true);
          });
      }, 15000);

      // (optional) client may proactively pong without ack
      socket.on('client:pong', () => {lastClientPongAt = Date.now();});

      // ---------- dynamic room membership (safe) ----------
      socket.on('client:subscribe', (rooms?: unknown) => {
        for(const r of safeRooms(rooms)) socket.join(r);
      });
      socket.on('client:unsubscribe', (rooms?: unknown) => {
        for(const r of safeRooms(rooms)) socket.leave(r);
      });

      // ---------- runtime auth/token update ----------
      socket.on('auth:update', (token: string, ack?: (res: {ok: boolean; reason?: string}) => void) => {
        try {
          const payload = jwt.verify(token, this.opts.jwtSecret) as JwtPayload;
          if(!payload.username || !payload.role) throw new Error('bad token');

          const prev = socket.data.authUser as AuthUser | undefined;
          if(prev) this.leaveBaseRooms(socket, prev);

          const nextUser = toAuthUser(payload);         // ✅ safe build
          socket.data.authUser = nextUser;
          this.joinBaseRooms(socket, nextUser);

          ack?.({ok: true});
          socket.emit('auth:updated', {ok: true, user: nextUser});
        } catch {
          ack?.({ok: false, reason: 'invalid token'});
          socket.emit('auth:updated', {ok: false, reason: 'invalid token'});
        }
      });


      // ---------- notification delivery ACK (optional) ----------
      socket.on('notification:ack', (p: {notificationId: string}, ack?: (res: {ok: boolean}) => void) => {
        ack?.({ok: true});
      });

      // ---------- cleanup ----------
      // 🔧 clean up both on 'disconnecting' and 'disconnect'
      socket.on('disconnecting', (reason) => {
        clearInterval(hb);
        // Optional: log current rooms being left
        // console.log('leaving rooms', [...socket.rooms]);
        console.log(`↘️  Socket disconnecting: ${auth.username} (${reason}) id=${socket.id}`);
      });

      socket.on('disconnect', (reason) => {
        clearInterval(hb);
        console.log(`↘️  Socket disconnected: ${auth.username} (${reason}) id=${socket.id}`);
      });
    });

    return this.nsp;
  }

  /** Attach namespace to Express for req.app.get('io') usage */
  attachToApp(app: import('express').Express) {
    app.set('io', this.nsp);
  }

  get instance(): Namespace {
    if(!this.nsp) throw new Error('Socket.IO not initialized. Call attach() first.');
    return this.nsp;
  }

  // ---------- Emission helpers ----------
  emitToUser(username: string, event: string, payload: any) {
    this.instance.to(`user:${username}`).emit(event, payload);
  }
  emitToRole(role: Role, event: string, payload: any) {
    this.instance.to(`role:${role}`).emit(event, payload);
  }
  emitBroadcast(event: string, payload: any) {
    this.instance.to('broadcast').emit(event, payload);
  }
  emitToRooms(rooms: string[], event: string, payload: any) {
    if(!rooms?.length) return;
    this.instance.to(rooms).emit(event, payload);
  }

  // ---------- Internals ----------
  private extractToken(socket: Socket): string | null {
    const fromAuth = (socket.handshake as any).auth?.token as string | undefined;
    if(fromAuth) return fromAuth;

    const authz = socket.handshake.headers.authorization;
    if(authz?.toLowerCase().startsWith('bearer ')) return authz.slice(7).trim();

    if(this.opts.allowCookieAuth) {
      const cookie = socket.handshake.headers.cookie ?? '';
      const match = cookie.split(';').map(s => s.trim()).find(s => s.startsWith('token='));
      if(match) return match.split('=')[1] || null;
    }
    return null;
  }

  private joinBaseRooms(socket: Socket, user: AuthUser) {
    socket.join(`user:${user.username}`);
    socket.join(`role:${user.role}`);
    socket.join('broadcast');
  }

  private leaveBaseRooms(socket: Socket, user: AuthUser) {
    socket.leave(`user:${user.username}`);
    socket.leave(`role:${user.role}`);
    socket.leave('broadcast');
  }
}
