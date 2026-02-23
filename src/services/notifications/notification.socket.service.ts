// Path: src/services/notifications/notification.socket.service.ts
// =============================================================================
// Notification Hub — WebSocket Service (Emitter / Gateway Helper)
// -----------------------------------------------------------------------------
// PURPOSE:
// - Emits WS events for Notification Hub using SocketConnectionHandler
// - ✅ Uses NotificationEvents + NotificationRooms as single source of truth
//
// RULES (your rules):
// - 100% class-based
// - No `any`
// - exactOptionalPropertyTypes-safe
// - Console logs prefixed and end with '\n'
// - ✅ No constructor parameters (your preference)
// =============================================================================

import { SocketConnectionHandler } from "../../socket/socket-connection.handler";

import {
  NotificationEvents,
  NotificationRooms,
  type NotifyNewPayload,
  type NotifyPatchPayload,
  type NotifyCountPayload,
  type NotifyBulkPayload,
  type DomainRestoredPayload,
  type DomainPurgedPayload,
} from "../../socket/events/notifications/notification.events";

export class NotificationSocketService {
  private handler: SocketConnectionHandler | null;

  public constructor() {
    this.handler = null;
  }

  /* ===========================================================================
   * 1) Core notification UI events
   * ======================================================================== */

  public emitNewToUser(username: string, payload: NotifyNewPayload): void {
    const u = this.safeUsername(username);
    const room = NotificationRooms.user(u);
    this.emitToRoom(room, NotificationEvents.NEW, payload);
  }

  public emitPatchToUser(username: string, payload: NotifyPatchPayload): void {
    const u = this.safeUsername(username);
    const room = NotificationRooms.user(u);
    this.emitToRoom(room, NotificationEvents.PATCH, payload);
  }

  public emitCountToUser(username: string, payload: NotifyCountPayload): void {
    const u = this.safeUsername(username);
    const room = NotificationRooms.user(u);
    this.emitToRoom(room, NotificationEvents.COUNT, payload);
  }

  public emitBulkToUser(username: string, payload: NotifyBulkPayload): void {
    const u = this.safeUsername(username);
    const room = NotificationRooms.user(u);
    this.emitToRoom(room, NotificationEvents.BULK, payload);
  }

  /* ===========================================================================
   * 2) Optional audience broadcasts (admin/team dashboards)
   * ======================================================================== */

  public emitNewToCompany(payload: NotifyNewPayload): void {
    this.emitToRoom(NotificationRooms.COMPANY, NotificationEvents.NEW, payload);
  }

  public emitNewToRole(roleKey: string, payload: NotifyNewPayload): void {
    this.emitToRoom(NotificationRooms.role(roleKey), NotificationEvents.NEW, payload);
  }

  public emitNewToTeam(teamCode: string, payload: NotifyNewPayload): void {
    this.emitToRoom(NotificationRooms.team(teamCode), NotificationEvents.NEW, payload);
  }

  /* ===========================================================================
   * 3) Optional RecycleBin hub integration events
   * ======================================================================== */

  public emitDomainRestoredToCompany(payload: DomainRestoredPayload): void {
    this.emitToRoom(NotificationRooms.COMPANY, NotificationEvents.DOMAIN_RESTORED, payload);
  }

  public emitDomainPurgedToCompany(payload: DomainPurgedPayload): void {
    this.emitToRoom(NotificationRooms.COMPANY, NotificationEvents.DOMAIN_PURGED, payload);
  }

  /* =============================================================================
   * Internal: emit wrapper
   * ========================================================================== */

  private emitToRoom<TPayload>(room: string, event: string, payload: TPayload): void {
    try {
      const handler = this.getHandler();
      handler.emitToRoom(room, event, payload);
    } catch (err: unknown) {
      // eslint-disable-next-line no-console
      console.error(
        `[Error:] NotificationSocketService.emitToRoom failed: ${
          err instanceof Error ? err.message : "Unknown error"
        }\n`
      );
    }
  }

  /**
   * Lazy handler resolver:
   * - avoids constructor params
   * - avoids boot-order issues if you later switch to WaitForInstance()
   */
  private getHandler(): SocketConnectionHandler {
    if (this.handler) return this.handler;

    // If your project has a strict singleton pattern, switch this to:
    // this.handler = SocketConnectionHandler.GetInstance();
    // OR:
    // this.handler = await SocketConnectionHandler.WaitForInstance(); (then make async)
    //
    // For now, keep it simple and aligned to your existing usage.
    this.handler = (SocketConnectionHandler as unknown as {
      GetInstance: () => SocketConnectionHandler;
    }).GetInstance();

    return this.handler;
  }

  private safeUsername(v: string): string {
    const u = typeof v === "string" ? v.trim() : "";
    if (!u) {
      throw new Error("NotificationSocketService: username is required.");
    }
    return u;
  }
}
