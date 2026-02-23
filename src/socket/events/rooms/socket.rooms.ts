// Path: src/socket/events/rooms/socket.rooms.ts
// =============================================================================
// SocketRooms — Global Room Registry (SINGLE SOURCE OF TRUTH)
// -----------------------------------------------------------------------------
// PURPOSE
// - One canonical room naming convention for the entire platform.
// - Notifications, Team modules, future HR/Finance modules MUST reuse this.
//
// DESIGN
// - "user:<username>"          => per-user (multi-tab safe)
// - "session:<sessionToken>"   => per-session
// - "role:<role>"              => legacy role room (kept for backward compat)
// - "broadcast"                => global
//
// - "aud.role.<role>"          => audience-role (notifications standard)
// - "aud.team.<teamCode>"      => audience-team (kpi + team modules)
// - "aud.member.<userId>"      => audience-member (kpi / personal)
// - "aud.branch.<branchId>"    => audience-branch
// - "aud.org.<orgId>"          => audience-org (default org)
//
// FUTURE SAFE
// - add new audiences without touching handler logic by putting them into token:
//   authUser.audRooms = ["aud.hr.dept.SALES", "aud.finance.approver", ...]
// =============================================================================

export class SocketRooms {
  private constructor() {}

  // --------------------------------------------------------------------------
  // Base rooms
  // --------------------------------------------------------------------------
  public static readonly BROADCAST: string = "broadcast";

  public static user(username: string): string {
    const u = this.safeKey(username);
    return `user:${u || "unknown"}`;
  }

  public static session(sessionToken: string): string {
    const s = this.safeKey(sessionToken);
    return `session:${s || "unknown"}`;
  }

  /** Legacy role room (kept because other modules may still emit to role:<role>) */
  public static role(roleKey: string): string {
    const r = this.safeKey(roleKey);
    return `role:${r || "Unknown"}`;
  }

  // --------------------------------------------------------------------------
  // Audience rooms (enterprise standard)
  // --------------------------------------------------------------------------
  public static audRole(roleKey: string): string {
    const r = this.safeKey(roleKey);
    return `aud.role.${r || "Unknown"}`;
  }

  public static audTeam(teamCode: string): string {
    const t = this.safeKey(teamCode);
    return `aud.team.${t || "Unknown"}`;
  }

  public static audMember(userId: string): string {
    const m = this.safeKey(userId);
    return `aud.member.${m || "Unknown"}`;
  }

  public static audBranch(branchId: string): string {
    const b = this.safeKey(branchId);
    return `aud.branch.${b || "Unknown"}`;
  }

  public static audOrg(orgId: string): string {
    const o = this.safeKey(orgId);
    return `aud.org.${o || "org"}`;
  }

  /**
   * Future extension (HR/Finance/etc.)
   * Example:
   *  SocketRooms.aud("hr.dept", "SALES")   -> "aud.hr.dept.SALES"
   *  SocketRooms.aud("finance", "approver")-> "aud.finance.approver"
   */
  public static aud(scope: string, key: string): string {
    const s = this.safeKey(scope).replace(/:/g, "."); // prevent colon creating "user:" style
    const k = this.safeKey(key);
    return `aud.${s || "Unknown"}.${k || "Unknown"}`;
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
