// Path: src/socket/events/notifications/notification.events.ts
// =============================================================================
// NotificationEvents + NotificationRooms (BE ↔ FE contract)
// -----------------------------------------------------------------------------
// Rooms are now universal:
//   user:<username>, role:<role>, team:<teamCode>, company
// =============================================================================

export class NotificationEvents {
  private constructor() {}

  public static readonly NEW = "notify:new";
  public static readonly PATCH = "notify:patch";
  public static readonly DELETE =  "notify:delete";
  public static readonly COUNT = "notify:count";
  public static readonly BULK = "notify:bulk";

  public static readonly DOMAIN_RESTORED = "notify:domain-restored";
  public static readonly DOMAIN_PURGED = "notify:domain-purged";
}

export class NotificationRooms {
  private constructor() {}

  public static readonly COMPANY: string = "company";

  public static user(username: string): string {
    const u = typeof username === "string" ? username.trim() : "";
    return `user:${ u || "unknown" }`;
  }

  public static role(roleKey: string): string {
    const r = typeof roleKey === "string" ? roleKey.trim() : "";
    return `role:${ r || "Unknown" }`;
  }

  public static team(teamCode: string): string {
    const t = typeof teamCode === "string" ? teamCode.trim() : "";
    return `team:${ t || "Unknown" }`;
  }
}