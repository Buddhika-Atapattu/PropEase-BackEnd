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

import type {
  AuthUser,
  ChatMessagePayload,
  CallAnswerPayload,
  CallCandidatePayload,
  CallEndPayload,
  CallOfferPayload,
  GuardTokenPayload,
  NotificationPayload,
  TypedNamespace,
  TypedSocket
} from './socket-types.type';
import { SocketAuthHelper } from './socket-auth.helper';
import type { Role } from '../types/roles';
import { GuardTokenService } from '../services/guard-token.service';
import type { WsTokenRegistryRedis } from '../services/ws-service/ws-token-registry.redis.service';
import { wsSecurityEventLogger } from '../services/ws-service/ws-security-event-logger.service';

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

      // ──────────────────────────────────────────────────────────────
      // Step 1: Validate initial wsToken from handshake (Redis-backed)
      // ──────────────────────────────────────────────────────────────
      //
      // FE sends this during connection:
      //   io(url, { auth: { sessionToken, wsToken } })
      //
      // - wsToken is generated in AuthController / MfaController using
      //   WsTokenRegistryRedis.issueTokenForUser(...).
      // - Here we CONSUME it ONCE via consumeToken(token). This removes
      //   the token from Redis and from the session index.
      //
      // SECURITY RULE (your design):
      //   • If wsToken is INVALID:
      //        - Re-check sessionToken via GuardTokenService.
      //        - If session/guard VALID  → treat as internal issue,
      //          fallback to sessionToken as wsSessionId and continue.
      //        - If session/guard INVALID → potential hijack / logout:
      //          emit session:terminated and close ALL WS connections
      //          for this user.
      //
      //   • If wsToken is MISSING:
      //        - DEV-RELAXED: warn + continue using sessionToken only.
      // ──────────────────────────────────────────────────────────────

      const rawAuth: unknown = socket.handshake.auth;
      const authMeta = ( rawAuth && typeof rawAuth === 'object'
        ? rawAuth
        : {} ) as { wsToken?: unknown; };

      const wsToken: string =
        typeof authMeta.wsToken === 'string'
          ? authMeta.wsToken.trim()
          : '';

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
            // ──────────────────────────────────────────────────────
            // wsToken INVALID / EXPIRED → apply your rule
            // ──────────────────────────────────────────────────────
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
                const resolvedUser = await this.guardTokenService.resolveUserBySessionToken(
                  sessionTokenFallback.trim()
                );

                if (
                  resolvedUser &&
                  resolvedUser.username === authUser.username
                ) {
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
              // ✅ Interpretation:
              //   - wsToken broken/expired, but session+guard are healthy.
              //   - Treat as internal ws-token rotation issue.
              //   - System should self-heal using sessionToken as wsSessionId.
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
              // ❌ Interpretation:
              //   - wsToken invalid AND session/guard invalid.
              //   - Possible reasons:
              //       • Original user logged out
              //       • Session was revoked
              //       • Potential hijack / replay attempt
              //   - To protect the system:
              //       • Emit a termination event (auditing)
              //       • Kill ALL sockets for this user

              
              console.error(
                '[Error:] [SocketConnectionHandler] wsToken invalid AND session/guard invalid – terminating all sockets for user. socket=',
                socket.id,
                'user=',
                authUser.username,
                '\n'
              );

              

              // Notify this socket explicitly
              socket.emit( 'session:terminated', {
                mode: 'security',
                reason: 'ws_token_and_session_invalid',
                username: authUser.username,
                socketId: socket.id,
                ts: Date.now()
              } );

              // Kill all sockets for this user (including any others already connected)
              const userRoom: string = `user:${ authUser.username }`;
              this.nsp.to( userRoom ).emit( 'session:terminated', {
                mode: 'security',
                reason: 'ws_token_and_session_invalid',
                username: authUser.username,
                ts: Date.now()
              } );
              this.nsp.to( userRoom ).disconnectSockets( true );

              // Admin log in termination
              await wsSecurityEventLogger.log( {
                eventType: 'weTokenInvalidAndSessionAndGuardTokensInvalid',
                socketId: socket.id,
                ip: socket.handshake.address,
                userAgent: userRoom,
                reason: 'missing session token and guard token at handshake'
              } );

              // Also disconnect this socket in case it is not yet in the room
              socket.disconnect( true );
              return; // ⛔ Do NOT continue lifecycle for this connection
            }
          } else {
            // ──────────────────────────────────────────────────────
            // wsToken VALID → normal path
            // ──────────────────────────────────────────────────────
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

            // This is the anchor for WS rotation:
            // WsTokenRegistryRedis.rotateToken(sessionId) uses this.
            ( socket.data as any ).wsSessionId = record.sessionId;

            // console.info(
            //   '[Success:] [SocketConnectionHandler] wsToken accepted (Redis) for socket:',
            //   {
            //     socketId: socket.id,
            //     user: authUser.username,
            //     sessionId: record.sessionId,
            //     usedAt: record.usedAt
            //   },
            //   '\n'
            // );
          }
        } catch ( error: unknown ) {
          console.error(
            '[Error:] [SocketConnectionHandler] Error while consuming wsToken from Redis:',
            error,
            '\n'
          );
          // DEV-RELAXED: still allow connection, but no wsToken protection.
          // SessionToken was already validated at handshake level.
        }
      }

      // 🔁 Final fallback:
      // If wsSessionId is STILL missing at this point (e.g. no wsToken at all),
      // we fall back to the validated sessionToken to keep ws rotation working.
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

  private handleConnectionLifecycle(
    socket: TypedSocket,
    auth: AuthUser
  ): void {
    let lastClientPongAt = Date.now();
    let lastServerHelloAt = 0;

    // 1) Server → Client greeting (basic handshake info)
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

    // 2) Client → Server greeting
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

    // 3) Client → Server ping (simple echo)
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

    // 4) Server → Client heartbeat (soft liveness check; detects dead sockets)
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
          }
        );
    }, 15_000 );

    // Extra optional client pong hook
    socket.on( 'client:pong', () => {
      lastClientPongAt = Date.now();
    } );

    // 5) Guard token rotation flow (continuous, short-lived HTTP guard token)
    //
    // This is the ROTATION FLOW FOR HTTP GUARD TOKEN:
    //   - Uses GuardTokenService.rotateGuardToken(sessionToken)
    //   - Emits "guard:update" periodically to keep FE guard token fresh
    //   - FE must use this guard token for protected HTTP calls.
    //
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
          // Not necessarily an error → often means existing token still valid.
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
        const expiresAt: number = issuedAt + 10_000; // 10s overlap window

        const payload: GuardTokenPayload = {
          token: newGuardToken,
          issuedAt,
          expiresAt
        };

        socket.emit( 'guard:update', payload );

        // console.info(
        //   '[Success:] [guard:update] Guard token rotated and pushed to client.',
        //   {
        //     socketId: socket.id,
        //     user: currentUser.username,
        //     issuedAt,
        //     expiresAt
        //   },
        //   '\n'
        // );
      } catch ( error: unknown ) {
        console.error(
          '[Error:] [guard:update] Guard token rotation failed:',
          error,
          '\n'
        );
      }
    };

    // Initial guard token push + periodic refresh
    void pushGuardToken();
    const guardTimer = setInterval( () => {
      void pushGuardToken();
    }, 5_000 );

    // 6) WS token rotation flow (continuous, Redis-backed wsToken)
    //
    // This is the PRIMARY WS TOKEN ROTATION ENGINE:
    //   - Uses WsTokenRegistryRedis.rotateToken(sessionId) with wsSessionId
    //     set during handshake (from consumed wsToken).
    //   - Emits "ws:token:update" to FE with a fresh wsToken regularly.
    //   - FE must:
    //       • Listen to 'ws:token:update' and store the token.
    //       • Use that token in the NEXT WebSocket handshake (reconnect / new tab).
    //   - If this rotation fails repeatedly, FE can use the HTTP
    //     rotateWsToken(...) endpoint as a last-resort recovery path.
    //
    const wsTokenTimer: NodeJS.Timeout | null =
      this.registerWsTokenRotation( socket, auth );

    // 7) Dynamic room membership
    socket.on( 'client:subscribe', ( rooms?: unknown ) => {
      for ( const room of SocketAuthHelper.safeRooms( rooms ) ) {
        socket.join( room );
      }
    } );

    socket.on( 'client:unsubscribe', ( rooms?: unknown ) => {
      for ( const room of SocketAuthHelper.safeRooms( rooms ) ) {
        socket.leave( room );
      }
    } );

    // 8) Runtime auth/token update
    this.registerRuntimeAuthUpdate( socket );

    // 9) Notifications / chat / calls
    this.registerNotificationAck( socket );
    this.registerChatEvents( socket );
    this.registerCallEvents( socket );

    // 10) Cleanup – stop all timers on disconnect
    socket.on( 'disconnecting', ( reason: string ) => {
      clearInterval( heartbeatTimer );
      clearInterval( guardTimer );
      if ( wsTokenTimer ) {
        clearInterval( wsTokenTimer );
      }
      console.log(
        '[Info:] ↘️  Socket disconnecting:',
        auth.username,
        `(${ reason }) id=${ socket.id }\n`
      );
    } );

    socket.on( 'disconnect', ( reason: string ) => {
      clearInterval( heartbeatTimer );
      clearInterval( guardTimer );
      if ( wsTokenTimer ) {
        clearInterval( wsTokenTimer );
      }
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

  /**
   * Primary WS token rotation cycle.
   *
   * Responsibilities:
   *  - Periodically rotate wsToken in Redis for this socket's sessionId.
   *  - Push fresh wsToken to FE via `ws:token:update`.
   *  - Provide `ws:token:echo` for FE/dev tools to inspect the last payload.
   *
   * FE responsibilities:
   *  - Listen to 'ws:token:update' and store the latest token somewhere safe.
   *  - On the NEXT WebSocket connection, send that token in the handshake:
   *        io(url, { auth: { sessionToken, wsToken } })
   *
   * Notes:
   *  - This uses WsTokenRegistryRedis.rotateToken(sessionId) as the main path.
   *  - If this rotation fails (no session / no valid Redis token), the HTTP
   *    controller rotateWsToken(...) acts as last-resort recovery line.
   */
  private registerWsTokenRotation( socket: TypedSocket, auth: AuthUser ): NodeJS.Timeout | null {
    let lastWsTokenPayload: WsTokenPushPayload | null = null;

    const pushWsToken = async (): Promise<void> => {
      try {
        const wsSessionId: string | undefined = ( socket.data as any ).wsSessionId;

        if ( !wsSessionId ) {
          console.warn(
            '[Warning:]',
            '[ws:token:update] Missing wsSessionId on socket – skipping ws token rotation. socket=',
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
            '[Warning:]',
            '[ws:token:update] WsTokenRegistryRedis.rotateToken returned null – no new wsToken issued. socket=',
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

        // Remember the last payload so FE can 'echo' and debug.
        lastWsTokenPayload = payload;

        // Primary push: BE → FE. FE must store this for the next WS handshake.
        socket.emit( 'ws:token:update', payload );

        // console.info(
        //   '[Success:]',
        //   '[ws:token:update] New wsToken rotated and pushed to client.',
        //   {
        //     socketId: socket.id,
        //     user: auth.username,
        //     issuedAt,
        //     validUntil
        //   },
        //   '\n'
        // );
      } catch ( error: unknown ) {
        console.error(
          '[Error:]',
          '[ws:token:update] WS token rotation failed:',
          error,
          '\n'
        );
      }
    };

    // Expose echo for FE/dev tools: tells FE what last payload was.
    socket.on(
      'ws:token:echo',
      ( ack?: ( res: {
        ok: boolean;
        payload?: WsTokenPushPayload | null;
        reason?: string;
      } ) => void ) => {
        try {
          if ( !ack ) {
            return;
          }

          if ( !lastWsTokenPayload ) {
            ack( {
              ok: false,
              payload: null,
              reason: 'no_ws_token_pushed_yet'
            } );
            return;
          }

          ack( {
            ok: true,
            payload: lastWsTokenPayload
          } );
        } catch ( error: unknown ) {
          console.error(
            '[Error:]',
            '[ws:token:echo] Failed to echo ws token payload:',
            error,
            '\n'
          );
          if ( ack ) {
            ack( {
              ok: false,
              payload: null,
              reason: 'internal_error'
            } );
          }
        }
      }
    );

    // Initial push: give FE at least one wsToken soon after connection.
    void pushWsToken();

    // Periodic rotation.
    //
    // IMPORTANT:
    //   - This interval is your primary wsToken rotation engine.
    //   - If it fails (warnings/errors), FE can fall back to calling
    //     the HTTP rotateWsToken controller as last line of defence.
    const wsTokenTimer: NodeJS.Timeout = setInterval( () => {
      void pushWsToken();
    }, 60_000 ); // e.g., rotate every 60s (tune as needed)

    return wsTokenTimer;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Auth update
  // ──────────────────────────────────────────────────────────────────────────

  private registerRuntimeAuthUpdate( socket: TypedSocket ): void {
    socket.on(
      'auth:update',
      (
        token: string,
        ack?: ( res: { ok: boolean; reason?: string; } ) => void
      ) => {
        try {
          const nextUser = this.authHelper.decodeAuthUser( token );

          const previousUser = socket.data.authUser;
          if ( previousUser ) {
            this.leaveBaseRooms( socket, previousUser );
          }

          socket.data.authUser = nextUser;
          this.joinBaseRooms( socket, nextUser );

          if ( ack ) {
            ack( { ok: true } );
          }

          socket.emit( 'auth:updated', {
            ok: true,
            user: nextUser
          } );

          // console.info(
          //   '[Success:] [auth:update] Runtime auth user updated for socket:',
          //   socket.id,
          //   'user=',
          //   nextUser.username,
          //   '\n'
          // );
        } catch ( error: unknown ) {
          console.error(
            '[Error:] [auth:update] Failed to update runtime auth:',
            error,
            '\n'
          );

          if ( ack ) {
            ack( { ok: false, reason: 'invalid token' } );
          }

          socket.emit( 'auth:updated', {
            ok: false,
            reason: 'invalid token'
          } );
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
      (
        _payload: { notificationId?: string; },
        ack?: ( res: { ok: boolean; } ) => void
      ) => {
        // TODO: link this with a DB "delivered" flag if needed.
        if ( ack ) {
          ack( { ok: true } );
        }
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

          if ( !sender?.username ) {
            throw new Error( 'unauthenticated' );
          }

          const normalized: ChatMessagePayload = {
            ...msg,
            from: sender.username,
            createdAt: msg.createdAt || new Date().toISOString()
          };

          if ( normalized.to ) {
            this.emitToUser(
              normalized.to,
              'chat:new',
              normalized
            );
          }

          if (
            normalized.roomId &&
            SocketAuthHelper.isValidRoomName( normalized.roomId )
          ) {
            this.emitToRooms(
              [ normalized.roomId ],
              'chat:new',
              normalized
            );
          }

          socket.emit( 'chat:sent', normalized );

          if ( ack ) {
            ack( { ok: true } );
          }
        } catch ( error: unknown ) {
          console.error(
            '[Error:] [chat:send] failed:',
            error,
            '\n'
          );
          if ( ack ) {
            ack( { ok: false } );
          }
        }
      }
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Call signalling events
  // ──────────────────────────────────────────────────────────────────────────

  private registerCallEvents( socket: TypedSocket ): void {
    socket.on(
      'call:offer',
      (
        payload: CallOfferPayload,
        ack?: ( res: { ok: boolean; } ) => void
      ) => {
        this.relayCallEvent( socket, 'call:offer', payload, ack );
      }
    );

    socket.on(
      'call:answer',
      (
        payload: CallAnswerPayload,
        ack?: ( res: { ok: boolean; } ) => void
      ) => {
        this.relayCallEvent( socket, 'call:answer', payload, ack );
      }
    );

    socket.on(
      'call:candidate',
      (
        payload: CallCandidatePayload,
        ack?: ( res: { ok: boolean; } ) => void
      ) => {
        this.relayCallEvent( socket, 'call:candidate', payload, ack );
      }
    );

    socket.on(
      'call:end',
      (
        payload: CallEndPayload,
        ack?: ( res: { ok: boolean; } ) => void
      ) => {
        this.relayCallEvent( socket, 'call:end', payload, ack );
      }
    );
  }

  private relayCallEvent<TPayload extends { to: string; }>(
    socket: TypedSocket,
    eventName: 'call:offer' | 'call:answer' | 'call:candidate' | 'call:end',
    payload: TPayload,
    ack?: ( res: { ok: boolean; } ) => void
  ): void {
    try {
      const sender = socket.data.authUser;
      if ( !sender?.username ) {
        throw new Error( 'unauthenticated' );
      }

      const normalized = {
        ...payload,
        from: sender.username
      };

      this.emitToUser(
        normalized.to,
        eventName,
        normalized
      );

      if ( ack ) {
        ack( { ok: true } );
      }
    } catch ( error: unknown ) {
      console.error(
        '[Error:]',
        `[${ eventName }] failed:`,
        error,
        '\n'
      );
      if ( ack ) {
        ack( { ok: false } );
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Room utilities
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Join base rooms:
   *  - user:<username>    → per-user targeting
   *  - role:<role>        → RBAC / broadcast by role
   *  - broadcast          → global broadcast channel
   *  - session:<token>    → optional, for force-disconnect by session
   */
  private joinBaseRooms( socket: TypedSocket, user: AuthUser ): void {
    socket.join( `user:${ user.username }` );
    socket.join( `role:${ user.role }` );
    socket.join( 'broadcast' );

    // Session-scoped room (requires your auth middleware to set socket.data.sessionToken)
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

  public emitToUser(
    username: string,
    event: string,
    payload: unknown
  ): void {
    this.nsp.to( `user:${ username }` ).emit( event, payload );
  }

  public emitToRole(
    role: Role,
    event: string,
    payload: unknown
  ): void {
    this.nsp.to( `role:${ role }` ).emit( event, payload );
  }

  public emitToRooms(
    rooms: string[],
    event: string,
    payload: unknown
  ): void {
    if ( !rooms || rooms.length === 0 ) {
      return;
    }
    this.nsp.to( rooms ).emit( event, payload );
  }

  // Public helper for notifications – can be used by SocketServer as well.
  public emitNotification( notif: NotificationPayload ): void {
    const { audience } = notif;
    if ( !audience ) {
      return;
    }

    const event = 'notification:new';

    if ( audience.mode === 'broadcast' ) {
      this.nsp.to( 'broadcast' ).emit( event, notif );
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
  // Forced disconnect helpers (backend → FE)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Forcefully disconnect ALL sockets for a given username.
   *
   * Flow:
   *  1) Emit "session:terminated" to user room with a semantic reason.
   *  2) Disconnect all sockets in that room (server-side).
   *
   * Typical usage:
   *  - Hard logout from all devices.
   *  - Account disabled / locked.
   */
  public forceDisconnectUser( username: string, reason?: string ): void {
    const safeUser: string = String( username ?? '' ).trim();
    if ( !safeUser ) {
      console.warn(
        '[Warning:] [SocketConnectionHandler] forceDisconnectUser called with empty username\n'
      );
      return;
    }

    const room: string = `user:${ safeUser }`;

    // 1) Notify FE that session was terminated by backend
    this.nsp.to( room ).emit( 'session:terminated', {
      mode: 'user',
      username: safeUser,
      reason: reason ?? 'force_logout',
      ts: Date.now()
    } );

    // 2) Physically disconnect sockets on server-side
    this.nsp.to( room ).disconnectSockets( true );

    console.log(
      '[Info:] [SocketConnectionHandler] forceDisconnectUser – disconnected all sockets for user=',
      safeUser,
      '\n'
    );
  }

  /**
   * Forcefully disconnect ALL sockets bound to a given sessionToken.
   *
   * Requirements:
   *  - joinBaseRooms() (or your auth middleware) must join `session:<sessionToken>`
   *    so sockets are grouped by logical session.
   *
   * Typical usage:
   *  - When you invalidate a sessionToken in GuardTokenService.
   *  - When you detect suspicious activity on a single session and want to
   *    kill that session only (not all sessions of that user).
   */
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

  /**
   * Optional helper: disconnect by role (e.g., when freezing all "agent" users).
   */
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

}
