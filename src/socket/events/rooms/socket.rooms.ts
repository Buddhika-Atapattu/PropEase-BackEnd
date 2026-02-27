// Path: src/socket/events/rooms/socket.rooms.ts
// =============================================================================
// SocketRooms — Global Room Registry (SINGLE SOURCE OF TRUTH)
// -----------------------------------------------------------------------------
// Universal rooms (system-wide):
// - "user:<username>"          => per-user (multi-tab safe)
// - "role:<role>"              => role audience
// - "team:<teamCode>"          => team audience
// - "company"                  => whole company / tenant
//
// Security / infra rooms:
// - "session:<sessionToken>"   => per-session (logout/security termination)
// - "broadcast"                => optional global broadcast (rare)
//
// Backward-compat (temporary):
// - audRole/audTeam/audOrg map into universal rooms (to avoid breakage)
// =============================================================================

export class SocketRooms {
  private constructor() {}

  // --------------------------------------------------------------------------
  // Base rooms
  // --------------------------------------------------------------------------
  public static readonly BROADCAST: string = "broadcast";
  public static readonly COMPANY: string = "company";

  public static user(username: string): string {
    const u = this.safeKey(username);
    return `user:${u || "unknown"}`;
  }

  public static session(sessionToken: string): string {
    const s = this.safeKey(sessionToken);
    return `session:${s || "unknown"}`;
  }

  public static role(roleKey: string): string {
    const r = this.safeKey(roleKey);
    return `role:${r || "Unknown"}`;
  }

  public static team( teamCode: string ): string {
    const t = this.safeKey( teamCode );
    return `team:${ t || "Unknown" }`;
  }

  // --------------------------------------------------------------------------
  // Backward compat: map old “ *” calls into universal rooms
  // --------------------------------------------------------------------------
  /** @deprecated use SocketRooms.role() */
  public static audRole(roleKey: string): string {
    return SocketRooms.role( roleKey );
  }

  /** @deprecated use SocketRooms.team() */
  public static audTeam(teamCode: string): string {
    return SocketRooms.team( teamCode );
  }

  /** @deprecated use SocketRooms.COMPANY */
  public static audOrg( _orgId: string ): string {
    return SocketRooms.COMPANY;
  }

  // --------------------------------------------------------------------------
  // Minimal sanitizer (room safe keys)
  // --------------------------------------------------------------------------
  private static safeKey(v: unknown): string {
    const s = typeof v === "string" ? v.trim() : "";
    if (!s) return "";
    if (s === "undefined" || s === "null") return "";
    return s;
  }
}