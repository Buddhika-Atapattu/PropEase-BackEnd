// Path: src/socket/socket-auth.helper.ts
// Centralised helper for Socket.IO auth-related operations.

import jwt from "jsonwebtoken";
import type { AuthUser, JwtPayload, TypedSocket } from "./socket-types.type";
import type { Role } from "../types/roles";

export class SocketAuthHelper {
  /** Restrictive room-name regex (anti-garbage / anti-injection). */
  private static readonly ROOM_RE: RegExp = /^[a-z0-9:/_-]{1,64}$/i;

  private readonly jwtSecret: string;
  private readonly allowCookieAuth: boolean;

  public constructor ( jwtSecret: string, allowCookieAuth: boolean ) {
    this.jwtSecret = jwtSecret;
    this.allowCookieAuth = allowCookieAuth;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Small safe parsers (exactOptionalPropertyTypes-safe)
  // ──────────────────────────────────────────────────────────────────────────

  private static asString( v: unknown ): string | undefined {
    if ( typeof v !== "string" ) return undefined;
    const t = v.trim();
    return t ? t : undefined;
  }

  private static asStringArray( v: unknown ): string[] | undefined {
    if ( !Array.isArray( v ) ) return undefined;
    const out: string[] = v
      .map( ( x ) => ( typeof x === "string" ? x.trim() : "" ) )
      .filter( ( x ) => x.length > 0 );

    return out.length ? out : undefined;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Token extraction helpers (handshake → strings)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Extract a *legacy* JWT auth token from the handshake.
   *
   * CURRENT DESIGN (2025-12):
   *  - Primary identity for sockets is handled via `sessionToken`
   *    (see extractSessionToken + GuardTokenService).
   *  - JWT-based socket auth is *optional* / legacy and ONLY read
   *    from `handshake.auth.token`.
   *
   * IMPORTANT:
   *  - We NO LONGER auto-read Authorization: Bearer <token> here,
   *    because HTTP interceptors may send random hex session tokens
   *    there, which are not JWTs.
   */
  public extractAuthToken( socket: TypedSocket ): string | null {
    const authHandshake = socket.handshake as {
      auth?: { token?: string; };
    };

    const fromAuth = authHandshake.auth?.token;
    if ( typeof fromAuth === "string" && fromAuth.trim().length > 0 ) {
      return fromAuth.trim();
    }

    return null;
  }

  /**
   * Extract sessionToken for this socket from:
   *  - handshake.auth.sessionToken
   *  - cookie: sessionToken=<hex>
   *  - (optionally) x-session-token header – useful for non-browser clients
   *
   * NOTE:
   *  - This is the *primary* path we care about in the current design.
   *  - This value is what GuardTokenService will treat as "session".
   */
  public extractSessionToken( socket: TypedSocket ): string | null {
    // 1) handshake.auth.sessionToken
    const authHandshake = socket.handshake as {
      auth?: { sessionToken?: string; };
    };

    const fromAuth: string | undefined = authHandshake.auth?.sessionToken;
    if ( typeof fromAuth === "string" && fromAuth.trim().length > 0 ) {
      return fromAuth.trim();
    }

    // 2) Cookie: sessionToken=<value>
    const cookieHeader: string = socket.handshake.headers.cookie ?? "";
    if ( cookieHeader ) {
      const segments: string[] = cookieHeader
        .split( ";" )
        .map( ( s: string ) => s.trim() )
        .filter( ( s: string ) => s.length > 0 );

      for ( const segment of segments ) {
        if ( segment.startsWith( "sessionToken=" ) ) {
          const [ , rawValue ] = segment.split( "=" );
          const token: string = ( rawValue ?? "" ).trim();
          if ( token.length > 0 ) {
            return token;
          }
        }
      }
    }

    // 3) Optional header for non-browser clients
    const headerValue = socket.handshake.headers[ "x-session-token" ];
    if ( typeof headerValue === "string" && headerValue.trim().length > 0 ) {
      return headerValue.trim();
    }

    return null;
  }

  /**
   * Extract WebSocket-only token (wsToken) from the handshake.
   *
   * CURRENT DESIGN:
   *  - Issued by WsTokenRegistryRedis.issueTokenForUser(...)
   *  - Validated ONCE during initial WebSocket handshake via
   *    WsTokenRegistryRedis.consumeToken(...)
   *  - Single-use / short-lived – NOT reused across connections.
   *
   * SOURCE:
   *  - handshake.auth.wsToken (set by FE SocketService.init({...}))
   */
  public extractWsToken( socket: TypedSocket ): string | null {
    const authHandshake = socket.handshake as {
      auth?: { wsToken?: string; };
    };

    const fromAuth: string | undefined = authHandshake.auth?.wsToken;
    if ( typeof fromAuth === "string" && fromAuth.trim().length > 0 ) {
      return fromAuth.trim();
    }

    return null;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // JWT → AuthUser mapping (legacy)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Decode + verify a *JWT* and map to AuthUser.
   *
   * CURRENT DESIGN:
   *  - This is now a *legacy helper* for the `auth:update` flow or
   *    special clients that still send JWTs.
   *  - It will ONLY attempt verification if the token "looks like" a JWT
   *    (3 dot-separated segments). Any other token (e.g., random hex
   *    sessionToken) is rejected as non-JWT BEFORE calling jwt.verify.
   */
  public decodeAuthUser( token: string ): AuthUser {
    const trimmed = typeof token === "string" ? token.trim() : "";

    if ( trimmed.length === 0 ) {
      throw new Error( "Unauthorized: empty token" );
    }

    // Simple heuristic: JWT must have 3 dot-separated parts.
    const parts = trimmed.split( "." );
    const looksLikeJwt = parts.length === 3;

    if ( !looksLikeJwt ) {
      throw new Error( "Unauthorized: non-JWT token supplied to decodeAuthUser" );
    }

    const decoded: unknown = jwt.verify( trimmed, this.jwtSecret );

    if ( !SocketAuthHelper.isJwtPayload( decoded ) ) {
      throw new Error( "Unauthorized: invalid JWT payload" );
    }

    if ( !decoded.username || !decoded.role ) {
      throw new Error( "Unauthorized: bad payload" );
    }

    return SocketAuthHelper.toAuthUser( decoded );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Room helpers
  // ──────────────────────────────────────────────────────────────────────────

  /** Only allow simple room names (a-z0-9:/-_), up to 64 chars. */
  public static isValidRoomName( room: string ): boolean {
    return SocketAuthHelper.ROOM_RE.test( room );
  }

  /** Sanity filter for room arrays coming from clients. */
  public static safeRooms( rooms: unknown ): string[] {
    if ( !Array.isArray( rooms ) ) {
      return [];
    }

    const result: string[] = [];

    for ( const item of rooms ) {
      if ( typeof item !== "string" ) continue;

      const trimmed = item.trim();
      if ( trimmed.length > 0 && SocketAuthHelper.isValidRoomName( trimmed ) ) {
        result.push( trimmed );
      }
    }

    return result;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Internal mapping helpers
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * IMPORTANT:
   * - We only attach optional fields if they exist.
   * - This keeps exactOptionalPropertyTypes happy.
   * - Multi-team supported: teamCodes: string[]
   */
  private static toAuthUser( payload: JwtPayload ): AuthUser {
    const base: AuthUser = {
      username: payload.username,
      role: payload.role,
    };

    const sub = SocketAuthHelper.asString( ( payload as any ).sub );
    if ( sub ) base.sub = sub;

    const branchId = SocketAuthHelper.asString( ( payload as any ).branchId );
    if ( branchId ) ( base as any ).branchId = branchId;

    const teamCodes = SocketAuthHelper.asStringArray( ( payload as any ).teamCodes );
    if ( teamCodes ) ( base as any ).teamCodes = teamCodes;

    return base;
  }

  private static isJwtPayload( decoded: unknown ): decoded is JwtPayload {
    if ( typeof decoded !== "object" || decoded === null ) {
      return false;
    }

    const candidate = decoded as {
      username?: unknown;
      role?: unknown;
    };

    const hasValidUsername =
      typeof candidate.username === "string" && candidate.username.trim().length > 0;

    const validRoles: Role[] = [
      "admin",
      "agent",
      "tenant",
      "owner",
      "operator",
      "manager",
      "developer",
      "user",
    ];

    const hasValidRole = validRoles.includes( candidate.role as Role );

    return hasValidUsername && hasValidRole;
  }
}
