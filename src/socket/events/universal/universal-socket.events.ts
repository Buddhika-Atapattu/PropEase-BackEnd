// Path: src/socket/events/universal/universal-socket.events.ts
// =============================================================================
// Universal Socket Contracts (BE ↔ FE)
// -----------------------------------------------------------------------------
// 01) Introduction
// - Central contract for socket lifecycle + security + room semantics.
// - Domain modules (notifications/comments/kpi/...) should NOT re-define these.
//
// 02) Important matters
// - Values must match backend SocketConnectionHandler emits/on() keys.
// - Rooms are universal and shared across all modules.
//
// 03) Why we make this
// - Prevents string drift and "silent socket failures" in production.
// - Enables reuse across all feature modules.
//
// 04) Usage hint
// - socket.on(UniversalSocketEvents.Server.SESSION_TERMINATED, ...)
// - socket.emit(UniversalSocketEvents.Client.SUBSCRIBE, rooms)
// =============================================================================

export class UniversalSocketRooms {
  private constructor() {}

  // Universal rooms
  public static readonly COMPANY: string = "company";
  public static readonly BROADCAST: string = "broadcast";

  // Prefix rooms
  public static readonly USER_PREFIX: string = "user:";
  public static readonly ROLE_PREFIX: string = "role:";
  public static readonly TEAM_PREFIX: string = "team:";
  public static readonly SESSION_PREFIX: string = "session:";

  public static user(username: string): string {
    const u = typeof username === "string" ? username.trim() : "";
    return `${UniversalSocketRooms.USER_PREFIX}${u || "unknown"}`;
  }

  public static role(roleKey: string): string {
    const r = typeof roleKey === "string" ? roleKey.trim() : "";
    return `${UniversalSocketRooms.ROLE_PREFIX}${r || "Unknown"}`;
  }

  public static team(teamCode: string): string {
    const t = typeof teamCode === "string" ? teamCode.trim() : "";
    return `${UniversalSocketRooms.TEAM_PREFIX}${t || "Unknown"}`;
  }

  public static session(sessionToken: string): string {
    const s = typeof sessionToken === "string" ? sessionToken.trim() : "";
    return `${UniversalSocketRooms.SESSION_PREFIX}${s || "Unknown"}`;
  }
}

export class UniversalSocketEvents {
  private constructor() {}

  // ===========================================================================
  // Server → Client
  // ===========================================================================
  public static readonly Server = class {
    private constructor() {}

    // lifecycle / greetings
    public static readonly SERVER_HELLO: string = "server:hello";
    public static readonly SERVER_WELCOME: string = "server:welcome";
    public static readonly SERVER_PING: string = "server:ping";

    // security kill-switch
    public static readonly SESSION_TERMINATED: string = "session:terminated";

    // token pushes
    public static readonly GUARD_UPDATE: string = "guard:update";
    public static readonly WS_TOKEN_UPDATE: string = "ws:token:update";

    // runtime auth update response
    public static readonly AUTH_UPDATED: string = "auth:updated";

    // chat
    public static readonly CHAT_NEW: string = "chat:new";
    public static readonly CHAT_SENT: string = "chat:sent";

    // call events
    public static readonly CALL_OFFER: string = "call:offer";
    public static readonly CALL_ANSWER: string = "call:answer";
    public static readonly CALL_CANDIDATE: string = "call:candidate";
    public static readonly CALL_END: string = "call:end";
  };

  // ===========================================================================
  // Client → Server
  // ===========================================================================
  public static readonly Client = class {
    private constructor() {}

    // telemetry / keepalive
    public static readonly CLIENT_HELLO: string = "client:hello";
    public static readonly CLIENT_PING: string = "client:ping";
    public static readonly CLIENT_PONG: string = "client:pong";

    // room ops
    public static readonly SUBSCRIBE: string = "client:subscribe";
    public static readonly UNSUBSCRIBE: string = "client:unsubscribe";

    // runtime auth update
    public static readonly AUTH_UPDATE: string = "auth:update";

    // ws-token helper
    public static readonly WS_TOKEN_ECHO: string = "ws:token:echo";

    // chat
    public static readonly CHAT_SEND: string = "chat:send";

    // call events (client emits same event names)
    public static readonly CALL_OFFER: string = "call:offer";
    public static readonly CALL_ANSWER: string = "call:answer";
    public static readonly CALL_CANDIDATE: string = "call:candidate";
    public static readonly CALL_END: string = "call:end";
  };
}
