// Path: src/socket/socket-connection.handler.ts
// Handles per-connection lifecycle & events for Socket.IO.
//
// This version is adapted for the Redis-backed WsTokenRegistryRedis.
//  - Initial wsToken (from HTTP login / MFA) is validated ONCE on connection
//    using registry.consumeToken(...).
//  - After handshake, SocketConnectionHandler becomes the PRIMARY engine that
//    keeps the connection cycle alive:
//      • Rotates guardToken (HTTP guard) via GuardTokenService.
//      • Rotates wsToken (WebSocket guard) via WsTokenRegistryRedis.rotateToken
//        and pushes fresh tokens to FE.
//  - The HTTP controller rotateWsToken(...) remains the LAST LINE OF DEFENCE
//    if the socket-driven rotation ever breaks (e.g. network issues, FE bug).

import { GuardTokenService } from '../services/guard-token.service';
import { wsSecurityEventLogger } from '../services/ws-service/ws-security-event-logger.service';
import type { WsTokenRegistryRedis } from '../services/ws-service/ws-token-registry.redis.service';
import type { Role } from '../types/roles';
import { SocketAuthHelper } from './socket-auth.helper';
import type {
  AuthUser,
  CallAnswerPayload,
  CallCandidatePayload,
  CallEndPayload,
  CallOfferPayload,
  ChatMessagePayload,
  GuardTokenPayload,
  NotificationPayload,
  TypedNamespace,
  TypedSocket
} from './socket-types.type';

// wsToken payload pushed from BE → FE, which FE must store for
// future WebSocket handshakes (reconnect / new tab / refresh).
type WsTokenPushPayload = {
  token: string;
  issuedAt: number;
  validUntil: number;
};

export class SocketConnectionHandler {
  private readonly nsp: TypedNamespace;
  private readonly authHelper: SocketAuthHelper;
  private readonly guardTokenService: GuardTokenService;
  private readonly wsTokenRegistry: WsTokenRegistryRedis;

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

  /**
   * Register the global "connection" listener once.
   * All per-socket handlers are defined inside.
   */
  public registerConnectionHandlers(): void {
    this.nsp.on( 'connection', async ( socket: TypedSocket ) => {
      const authUser = socket.data.authUser as AuthUser | undefined;

      if ( !authUser?.username || !authUser.role ) {
        console.warn(
          '[Warning:] [SocketConnectionHandler] Missing authUser on connection – disconnecting socket:',
          socket.id,
          '\n'
        );
        socket.disconnect( true );
        return;
      }

      // ✅ exactOptionalPropertyTypes-safe KPI room join
      const userId = typeof authUser.sub === 'string' ? authUser.sub.trim() : '';
      const branchId =
        typeof ( socket.data as any ).kpiBranchId === 'string'
          ? String( ( socket.data as any ).kpiBranchId ).trim()
          : '';

      const teamCodes: string[] = Array.isArray( ( socket.data as any ).kpiTeams )
        ? ( ( socket.data as any ).kpiTeams as unknown[] )
          .map( ( x ) => String( x ?? '' ).trim() )
          .filter( Boolean )
        : [];

      // KPI room join (multi-team safe)
      // - userId comes from authUser.sub
      // - teams come from authUser.teamCodes (array)
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



      // ──────────────────────────────────────────────────────────────
      // Step 1: Validate initial wsToken from handshake (Redis-backed)
      // ──────────────────────────────────────────────────────────────

      const rawAuth: unknown = socket.handshake.auth;
      const authMeta = ( rawAuth && typeof rawAuth === 'object' ? rawAuth : {} ) as {
        wsToken?: unknown;
      };

      const wsToken: string =
        typeof authMeta.wsToken === 'string' ? authMeta.wsToken.trim() : '';

      console.log(
        '[Info:] [SocketConnectionHandler] Handshake wsToken:',
        wsToken || '(none)',
        'socket=',
        socket.id,
        'user=',
        authUser.username,
        '\n'
      );

      // sessionToken was already validated in SocketServer (handshake middleware)
      const sessionTokenFallback: string | undefined =
        socket.data.sessionToken as string | undefined;

      if ( !wsToken ) {
        // DEV-RELAXED: allow connection even if wsToken is missing.
        console.warn(
          '[Warning:] [SocketConnectionHandler] No wsToken provided in handshake – CONTINUING WITHOUT wsToken protection. socket=',
          socket.id,
          'user=',
          authUser.username,
          '\n'
        );
      } else {
        try {
          // Redis-backed, one-time consume (removes from Redis on success)
          const record = await this.wsTokenRegistry.consumeToken( wsToken );

          if ( !record ) {
            // wsToken INVALID / EXPIRED → apply your rule
            console.warn(
              '[Warning:] [SocketConnectionHandler] Invalid or expired wsToken – re-checking session/guard state. socket=',
              socket.id,
              'user=',
              authUser.username,
              '\n'
            );

            let sessionStillValid: boolean = false;

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
                  '[Error:] [SocketConnectionHandler] Error while re-validating sessionToken after wsToken failure:',
                  innerError,
                  '\n'
                );
              }
            }

            if ( sessionStillValid ) {
              // ✅ wsToken broken/expired, but session+guard are healthy.
              console.warn(
                '[Warning:] [SocketConnectionHandler] wsToken invalid BUT session/guard still valid – falling back to sessionToken as wsSessionId. socket=',
                socket.id,
                'user=',
                authUser.username,
                '\n'
              );

              if ( sessionTokenFallback && sessionTokenFallback.trim().length > 0 ) {
                ( socket.data as any ).wsSessionId = sessionTokenFallback.trim();
              }
            } else {
              // ❌ wsToken invalid AND session/guard invalid → terminate
              console.error(
                '[Error:] [SocketConnectionHandler] wsToken invalid AND session/guard invalid – terminating all sockets for user. socket=',
                socket.id,
                'user=',
                authUser.username,
                '\n'
              );

              socket.emit( 'session:terminated', {
                mode: 'security',
                reason: 'ws_token_and_session_invalid',
                username: authUser.username,
                socketId: socket.id,
                ts: Date.now()
              } );

              const userRoom: string = `user:${ authUser.username }`;
              this.nsp.to( userRoom ).emit( 'session:terminated', {
                mode: 'security',
                reason: 'ws_token_and_session_invalid',
                username: authUser.username,
                ts: Date.now()
              } );
              this.nsp.to( userRoom ).disconnectSockets( true );

              await wsSecurityEventLogger.log( {
                eventType: 'weTokenInvalidAndSessionAndGuardTokensInvalid',
                socketId: socket.id,
                ip: socket.handshake.address,
                userAgent: String( socket.handshake.headers[ 'user-agent' ] ?? '' ),
                reason: 'missing session token and guard token at handshake'
              } );

              socket.disconnect( true );
              return;
            }
          } else {
            // wsToken VALID → normal path
            ( socket.data as any ).wsTokenRecord = {
              token: record.token,
              sessionId: record.sessionId,
              usedAt: record.usedAt,
              createdAt: record.createdAt,
              expiresAt: record.expiresAt,
              mfaStrength: record.mfaStrength,
              ip: record.ip,
              userAgent: record.userAgent
            };

            // Anchor for WS rotation
            ( socket.data as any ).wsSessionId = record.sessionId;
          }
        } catch ( error: unknown ) {
          console.error(
            '[Error:] [SocketConnectionHandler] Error while consuming wsToken from Redis:',
            error,
            '\n'
          );
          // DEV-RELAXED: still allow connection, but no wsToken protection.
        }
      }

      // Final fallback: use validated sessionToken as wsSessionId
      if ( !( socket.data as any ).wsSessionId ) {
        if ( sessionTokenFallback && sessionTokenFallback.trim().length > 0 ) {
          ( socket.data as any ).wsSessionId = sessionTokenFallback.trim();

          console.log(
            '[Info:] [SocketConnectionHandler] wsSessionId fallback set from sessionToken for socket=',
            socket.id,
            'user=',
            authUser.username,
            '\n'
          );
        }
      }

      // Type narrowing (already set in SocketServer, but we re-assert here)
      socket.data.authUser = authUser;

      this.joinBaseRooms( socket, authUser );

      console.log(
        '[Success:] ✅ Socket connected:',
        authUser.username,
        `(role=${ authUser.role }) id=${ socket.id }\n`
      );

      this.handleConnectionLifecycle( socket, authUser );
    } );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Lifecycle / heartbeat / guard token + ws token rotation flow
  // ──────────────────────────────────────────────────────────────────────────

  private handleConnectionLifecycle( socket: TypedSocket, auth: AuthUser ): void {
    let lastClientPongAt = Date.now();

    socket.emit( 'server:hello', {
      sid: socket.id,
      username: auth.username,
      role: auth.role,
      ts: Date.now(),
      server: { name: 'prop-ease-api', version: '1.0.0' }
    } );

    socket.on(
      'client:hello',
      ( _payload: unknown, ack?: ( resp: { ok: boolean; serverTime: number; } ) => void ) => {
        const serverTime = Date.now();
        if ( ack ) ack( { ok: true, serverTime } );

        socket.emit( 'server:welcome', {
          ok: true,
          user: socket.data.authUser as AuthUser,
          serverTime
        } );
      }
    );

    socket.on(
      'client:ping',
      (
        payload: { t0?: number; } | undefined,
        ack?: ( resp: { pong: true; ts: number; serverTs: number; } ) => void
      ) => {
        const t0 = typeof payload?.t0 === 'number' ? payload.t0 : Date.now();
        if ( ack ) ack( { pong: true, ts: t0, serverTs: Date.now() } );
      }
    );

    const heartbeatTimer = setInterval( () => {
      const startedAt = Date.now();

      socket.timeout( 4_000 ).emit( 'server:ping', { t: startedAt }, ( err?: Error ) => {
        if ( !err ) lastClientPongAt = Date.now();

        if ( Date.now() - lastClientPongAt > 60_000 ) {
          console.warn(
            '[Warning:] [SocketConnectionHandler] Heartbeat timeout – disconnecting socket:',
            socket.id,
            'user=',
            auth.username,
            '\n'
          );
          socket.disconnect( true );
        }
      } );
    }, 15_000 );

    socket.on( 'client:pong', () => {
      lastClientPongAt = Date.now();
    } );

    // Guard token rotation
    const pushGuardToken = async (): Promise<void> => {
      try {
        const currentUser: AuthUser | undefined = socket.data.authUser as AuthUser | undefined;
        const sessionToken: string | undefined = socket.data.sessionToken as string | undefined;

        if ( !currentUser || !sessionToken ) {
          console.warn(
            '[Warning:] [guard:update] Missing authUser or sessionToken on socket – skipping guard token rotation. socket=',
            socket.id,
            '\n'
          );
          return;
        }

        const newGuardToken: string | null =
          await this.guardTokenService.rotateGuardToken( sessionToken );

        if ( !newGuardToken ) {
          console.warn(
            '[Warning:] [guard:update] GuardTokenService.rotateGuardToken returned null – no new guard token issued. socket=',
            socket.id,
            'user=',
            currentUser.username,
            '\n'
          );
          return;
        }

        const issuedAt: number = Date.now();
        const expiresAt: number = issuedAt + 10_000;

        const payload: GuardTokenPayload = { token: newGuardToken, issuedAt, expiresAt };
        socket.emit( 'guard:update', payload );
      } catch ( error: unknown ) {
        console.error( '[Error:] [guard:update] Guard token rotation failed:', error, '\n' );
      }
    };

    void pushGuardToken();
    const guardTimer = setInterval( () => void pushGuardToken(), 5_000 );

    // WS token rotation
    const wsTokenTimer: NodeJS.Timeout | null = this.registerWsTokenRotation( socket, auth );

    socket.on( 'client:subscribe', ( rooms?: unknown ) => {
      for ( const room of SocketAuthHelper.safeRooms( rooms ) ) socket.join( room );
    } );

    socket.on( 'client:unsubscribe', ( rooms?: unknown ) => {
      for ( const room of SocketAuthHelper.safeRooms( rooms ) ) socket.leave( room );
    } );

    this.registerRuntimeAuthUpdate( socket );
    this.registerNotificationAck( socket );
    this.registerChatEvents( socket );
    this.registerCallEvents( socket );

    socket.on( 'disconnecting', ( reason: string ) => {
      clearInterval( heartbeatTimer );
      clearInterval( guardTimer );
      if ( wsTokenTimer ) clearInterval( wsTokenTimer );

      console.log(
        '[Info:] ↘️  Socket disconnecting:',
        auth.username,
        `(${ reason }) id=${ socket.id }\n`
      );
    } );

    socket.on( 'disconnect', ( reason: string ) => {
      clearInterval( heartbeatTimer );
      clearInterval( guardTimer );
      if ( wsTokenTimer ) clearInterval( wsTokenTimer );

      console.log(
        '[Info:] ↘️  Socket disconnected:',
        auth.username,
        `(${ reason }) id=${ socket.id }\n`
      );
    } );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // WS token rotation + echo (primary cycle, Redis-backed)
  // ──────────────────────────────────────────────────────────────────────────

  private registerWsTokenRotation( socket: TypedSocket, auth: AuthUser ): NodeJS.Timeout | null {
    let lastWsTokenPayload: WsTokenPushPayload | null = null;

    const pushWsToken = async (): Promise<void> => {
      try {
        const wsSessionId: string | undefined = ( socket.data as any ).wsSessionId;

        if ( !wsSessionId ) {
          console.warn(
            '[Warning:] [ws:token:update] Missing wsSessionId on socket – skipping ws token rotation. socket=',
            socket.id,
            'user=',
            auth.username,
            '\n'
          );
          return;
        }

        const newRecord = await this.wsTokenRegistry.rotateToken( wsSessionId );

        if ( !newRecord ) {
          console.warn(
            '[Warning:] [ws:token:update] WsTokenRegistryRedis.rotateToken returned null – no new wsToken issued. socket=',
            socket.id,
            'user=',
            auth.username,
            '\n'
          );
          return;
        }

        const issuedAt: number = Date.now();
        const validUntil: number =
          newRecord.expiresAt instanceof Date
            ? newRecord.expiresAt.getTime()
            : new Date( newRecord.expiresAt as unknown as string ).getTime();

        const payload: WsTokenPushPayload = {
          token: newRecord.token,
          issuedAt,
          validUntil
        };

        lastWsTokenPayload = payload;
        socket.emit( 'ws:token:update', payload );
      } catch ( error: unknown ) {
        console.error( '[Error:] [ws:token:update] WS token rotation failed:', error, '\n' );
      }
    };

    socket.on(
      'ws:token:echo',
      ( ack?: ( res: { ok: boolean; payload?: WsTokenPushPayload | null; reason?: string; } ) => void ) => {
        try {
          if ( !ack ) return;

          if ( !lastWsTokenPayload ) {
            ack( { ok: false, payload: null, reason: 'no_ws_token_pushed_yet' } );
            return;
          }

          ack( { ok: true, payload: lastWsTokenPayload } );
        } catch ( error: unknown ) {
          console.error( '[Error:] [ws:token:echo] Failed to echo ws token payload:', error, '\n' );
          if ( ack ) ack( { ok: false, payload: null, reason: 'internal_error' } );
        }
      }
    );

    void pushWsToken();

    const wsTokenTimer: NodeJS.Timeout = setInterval( () => void pushWsToken(), 60_000 );
    return wsTokenTimer;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Auth update
  // ──────────────────────────────────────────────────────────────────────────

  private registerRuntimeAuthUpdate( socket: TypedSocket ): void {
    socket.on(
      'auth:update',
      ( token: string, ack?: ( res: { ok: boolean; reason?: string; } ) => void ) => {
        try {
          const nextUser = this.authHelper.decodeAuthUser( token );

          const previousUser = socket.data.authUser;
          if ( previousUser ) this.leaveBaseRooms( socket, previousUser );

          socket.data.authUser = nextUser;
          this.joinBaseRooms( socket, nextUser );

          if ( ack ) ack( { ok: true } );

          socket.emit( 'auth:updated', { ok: true, user: nextUser } );
        } catch ( error: unknown ) {
          console.error( '[Error:] [auth:update] Failed to update runtime auth:', error, '\n' );

          if ( ack ) ack( { ok: false, reason: 'invalid token' } );
          socket.emit( 'auth:updated', { ok: false, reason: 'invalid token' } );
        }
      }
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Notification ACK
  // ──────────────────────────────────────────────────────────────────────────

  private registerNotificationAck( socket: TypedSocket ): void {
    socket.on(
      'notification:ack',
      ( _payload: { notificationId?: string; }, ack?: ( res: { ok: boolean; } ) => void ) => {
        if ( ack ) ack( { ok: true } );
      }
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Chat events
  // ──────────────────────────────────────────────────────────────────────────

  private registerChatEvents( socket: TypedSocket ): void {
    socket.on(
      'chat:send',
      ( msg: ChatMessagePayload, ack?: ( res: { ok: boolean; } ) => void ) => {
        try {
          const sender = socket.data.authUser;

          if ( !sender?.username ) throw new Error( 'unauthenticated' );

          const normalized: ChatMessagePayload = {
            ...msg,
            from: sender.username,
            createdAt: msg.createdAt || new Date().toISOString()
          };

          if ( normalized.to ) {
            this.emitToUser( normalized.to, 'chat:new', normalized );
          }

          if ( normalized.roomId && SocketAuthHelper.isValidRoomName( normalized.roomId ) ) {
            this.emitToRooms( [ normalized.roomId ], 'chat:new', normalized );
          }

          socket.emit( 'chat:sent', normalized );
          if ( ack ) ack( { ok: true } );
        } catch ( error: unknown ) {
          console.error( '[Error:] [chat:send] failed:', error, '\n' );
          if ( ack ) ack( { ok: false } );
        }
      }
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Call signalling events
  // ──────────────────────────────────────────────────────────────────────────

  private registerCallEvents( socket: TypedSocket ): void {
    socket.on( 'call:offer', ( payload: CallOfferPayload, ack?: ( res: { ok: boolean; } ) => void ) => {
      this.relayCallEvent( socket, 'call:offer', payload, ack );
    } );

    socket.on(
      'call:answer',
      ( payload: CallAnswerPayload, ack?: ( res: { ok: boolean; } ) => void ) => {
        this.relayCallEvent( socket, 'call:answer', payload, ack );
      }
    );

    socket.on(
      'call:candidate',
      ( payload: CallCandidatePayload, ack?: ( res: { ok: boolean; } ) => void ) => {
        this.relayCallEvent( socket, 'call:candidate', payload, ack );
      }
    );

    socket.on( 'call:end', ( payload: CallEndPayload, ack?: ( res: { ok: boolean; } ) => void ) => {
      this.relayCallEvent( socket, 'call:end', payload, ack );
    } );
  }

  private relayCallEvent<TPayload extends { to: string; }>(
    socket: TypedSocket,
    eventName: 'call:offer' | 'call:answer' | 'call:candidate' | 'call:end',
    payload: TPayload,
    ack?: ( res: { ok: boolean; } ) => void
  ): void {
    try {
      const sender = socket.data.authUser;
      if ( !sender?.username ) throw new Error( 'unauthenticated' );

      const normalized = { ...payload, from: sender.username };
      this.emitToUser( normalized.to, eventName, normalized );

      if ( ack ) ack( { ok: true } );
    } catch ( error: unknown ) {
      console.error( '[Error:]', `[${ eventName }] failed:`, error, '\n' );
      if ( ack ) ack( { ok: false } );
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Room utilities
  // ──────────────────────────────────────────────────────────────────────────

  private joinBaseRooms( socket: TypedSocket, user: AuthUser ): void {
    socket.join( `user:${ user.username }` );
    socket.join( `role:${ user.role }` );
    socket.join( 'broadcast' );

    const sessionToken: string | undefined = socket.data.sessionToken as string | undefined;
    if ( sessionToken && sessionToken.trim().length > 0 ) {
      socket.join( `session:${ sessionToken.trim() }` );
    }
  }

  private leaveBaseRooms( socket: TypedSocket, user: AuthUser ): void {
    socket.leave( `user:${ user.username }` );
    socket.leave( `role:${ user.role }` );
    socket.leave( 'broadcast' );

    const sessionToken: string | undefined = socket.data.sessionToken as string | undefined;
    if ( sessionToken && sessionToken.trim().length > 0 ) {
      socket.leave( `session:${ sessionToken.trim() }` );
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Emission helpers (scoped to this namespace)
  // ──────────────────────────────────────────────────────────────────────────

  public emitToUser( username: string, event: string, payload: unknown ): void {
    this.nsp.to( `user:${ username }` ).emit( event, payload );
  }

  public emitToRole( role: Role, event: string, payload: unknown ): void {
    this.nsp.to( `role:${ role }` ).emit( event, payload );
  }

  public emitToRooms( rooms: string[], event: string, payload: unknown ): void {
    if ( !rooms || rooms.length === 0 ) return;
    this.nsp.to( rooms ).emit( event, payload );
  }

  public emitNotification( notif: NotificationPayload ): void {
    const { audience } = notif;
    if ( !audience ) return;

    const event = 'notification:new';

    if ( audience.mode === 'broadcast' ) {
      this.nsp.to( 'broadcast' ).emit( event, notif );
      return;
    }

    if ( audience.mode === 'user' && audience.usernames?.length ) {
      for ( const username of audience.usernames ) this.emitToUser( username, event, notif );
    }

    if ( audience.mode === 'role' && audience.roles?.length ) {
      for ( const role of audience.roles ) this.emitToRole( role, event, notif );
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Forced disconnect helpers (backend → FE)
  // ──────────────────────────────────────────────────────────────────────────

  public forceDisconnectUser( username: string, reason?: string ): void {
    const safeUser: string = String( username ?? '' ).trim();
    if ( !safeUser ) {
      console.warn( '[Warning:] [SocketConnectionHandler] forceDisconnectUser called with empty username\n' );
      return;
    }

    const room: string = `user:${ safeUser }`;

    this.nsp.to( room ).emit( 'session:terminated', {
      mode: 'user',
      username: safeUser,
      reason: reason ?? 'force_logout',
      ts: Date.now()
    } );

    this.nsp.to( room ).disconnectSockets( true );

    console.log(
      '[Info:] [SocketConnectionHandler] forceDisconnectUser – disconnected all sockets for user=',
      safeUser,
      '\n'
    );
  }

  public forceDisconnectSession( sessionToken: string, reason?: string ): void {
    const safeSession: string = String( sessionToken ?? '' ).trim();
    if ( !safeSession ) {
      console.warn(
        '[Warning:] [SocketConnectionHandler] forceDisconnectSession called with empty sessionToken\n'
      );
      return;
    }

    const room: string = `session:${ safeSession }`;

    this.nsp.to( room ).emit( 'session:terminated', {
      mode: 'session',
      sessionToken: safeSession,
      reason: reason ?? 'session_invalidated',
      ts: Date.now()
    } );

    this.nsp.to( room ).disconnectSockets( true );

    console.log(
      '[Info:] [SocketConnectionHandler] forceDisconnectSession – disconnected all sockets for session=',
      safeSession,
      '\n'
    );
  }

  public forceDisconnectRole( role: Role, reason?: string ): void {
    const room: string = `role:${ role }`;

    this.nsp.to( room ).emit( 'session:terminated', {
      mode: 'role',
      role,
      reason: reason ?? 'role_forced_logout',
      ts: Date.now()
    } );

    this.nsp.to( room ).disconnectSockets( true );

    console.log(
      '[Info:] [SocketConnectionHandler] forceDisconnectRole – disconnected all sockets for role=',
      role,
      '\n'
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // KPI rooms (aud.*.*) — MUST match KPI transport keys
  // ──────────────────────────────────────────────────────────────────────────

  private joinKpiRooms(
    socket: TypedSocket,
    ctx: { userId?: string; teamCodes?: string[]; branchId?: string; }
  ): void {
    // Always join org room
    socket.join( "aud.org.org" );

    // Join all team rooms (multi-team)
    if ( Array.isArray( ctx.teamCodes ) ) {
      for ( const teamCode of ctx.teamCodes ) {
        if ( typeof teamCode === "string" && teamCode.trim() ) {
          socket.join( `aud.team.${ teamCode.trim() }` );
        }
      }
    }

    // Join member room
    if ( typeof ctx.userId === "string" && ctx.userId.trim() ) {
      socket.join( `aud.member.${ ctx.userId.trim() }` );
    }

    // Join branch room
    if ( typeof ctx.branchId === "string" && ctx.branchId.trim() ) {
      socket.join( `aud.branch.${ ctx.branchId.trim() }` );
    }

    console.log( "[Info:] [SocketConnectionHandler] KPI rooms joined.\n", {
      userId: ctx.userId ?? null,
      teamCodes: ctx.teamCodes ?? [],
      branchId: ctx.branchId ?? null,
    } );
  }

}
