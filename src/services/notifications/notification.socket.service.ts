// Path: src/services/notifications/notification.socket.service.ts

import type { IWsEmitter } from "../../socket/ws-emitter.interface";
import { NotificationEvents, NotificationRooms } from "../../socket/events/notifications/notification.events";
import type {
  NotificationCountResponse,
  NotificationInboxItemDto,
} from "../../types/notification/notification.types";

export type RecipientTargets = {
  usernames?: string[];
  roles?: string[];
  teamCodes?: string[];
  company?: boolean;
};

/**
 * Bulk refresh payload (WS)
 * - UI uses this to re-fetch inbox list safely (server-side truth).
 */
export interface NotificationBulkPayload {
  reason: "bulk-update" | "bulk-refresh" | "sync" | "unknown";
}

/**
 * NotificationSocketService
 * -----------------------------------------------------------------------------
 * 01) Introduction
 * - Single, stable WebSocket emission API for notifications.
 * - Emits to your universal rooms:
 *    user:<username>, role:<roleKey>, team:<teamCode>, company
 *
 * 02) Important matters
 * - Methods NEVER throw (invalid recipients are ignored safely).
 * - All payloads are UI-ready:
 *    NEW/PATCH => { item, ...(count?) }
 *    DELETE    => { notificationId }
 *    BULK      => { reason }
 * - exactOptionalPropertyTypes-safe: optionals are omitted unless present.
 *
 * 03) Why we make this class
 * - Centralize WS routing rules so Hub/Controllers never re-implement room logic.
 *
 * 04) Constructor
 * @param emitter
 * - Expected: implementation of IWsEmitter (Socket.IO wrapper)
 * - Usage: low-level room emission
 */
export class NotificationSocketService {
  public constructor ( private readonly emitter: IWsEmitter ) {}

  /* ===========================================================================
   * Method: emitToUserNew()
   * =========================================================================== */
  /**
   * Emit notify:new to a single user room.
   *
   * @param username
   * - Expected: target username
   *
   * @param item
   * - Expected: NotificationInboxItemDto (UI list-ready inbox row)
   *
   * @param count
   * - Optional: NotificationCountResponse
   */
  public emitToUserNew( username: string, item: NotificationInboxItemDto, count?: NotificationCountResponse ): void {
    const u = this.safeUsernameOrEmpty( username );
    if ( !u ) return;

    this.emitNotifyNew( { usernames: [ u ] }, item, count );
  }

  /* ===========================================================================
   * Method: emitNotifyPatch()
   * =========================================================================== */
  /**
   * Emit notify:patch to recipients.
   *
   * 01) Introduction
   * - Used when an existing notification content is updated (title/body).
   * - Payload is the same as NEW: inbox item DTO (Fix A principle).
   *
   * 02) Important matters
   * - Does NOT throw.
   * - Skips empty/invalid usernames/keys.
   *
   * @param recipients
   * - Expected: usernames/roles/teamCodes/company targets
   *
   * @param item
   * - Expected: NotificationInboxItemDto (updated view)
   *
   * @param count
   * - Optional: NotificationCountResponse (if you decide to recompute)
   */
  public emitNotifyPatch(
    recipients: RecipientTargets,
    item: NotificationInboxItemDto,
    count?: NotificationCountResponse
  ): void {
    const payload = count ? { item, count } : { item };

    for ( const u of recipients.usernames ?? [] ) {
      const user = this.safeUsernameOrEmpty( u );
      if ( !user ) continue;
      this.emitter.emitToRoom( NotificationRooms.user( user ), NotificationEvents.PATCH, payload );
    }

    for ( const r of recipients.roles ?? [] ) {
      const role = this.safeKeyOrEmpty( r );
      if ( !role ) continue;
      this.emitter.emitToRoom( NotificationRooms.role( role ), NotificationEvents.PATCH, payload );
    }

    for ( const t of recipients.teamCodes ?? [] ) {
      const team = this.safeKeyOrEmpty( t );
      if ( !team ) continue;
      this.emitter.emitToRoom( NotificationRooms.team( team ), NotificationEvents.PATCH, payload );
    }

    if ( recipients.company === true ) {
      this.emitter.emitToRoom( NotificationRooms.COMPANY, NotificationEvents.PATCH, payload );
    }
  }

  /* ===========================================================================
   * Method: emitNotifyDelete()
   * =========================================================================== */
  /**
   * Emit notify:delete to recipients.
   *
   * Purpose
   * - Used when a notification is removed (hard delete / purge).
   * - UI should remove any inbox rows that reference this notificationId.
   *
   * @param recipients
   * - Expected: usernames/roles/teamCodes/company targets
   *
   * @param notificationId
   * - Expected: MongoId string for notifications._id
   */
  public emitNotifyDelete( recipients: RecipientTargets, notificationId: string ): void {
    const id = this.safeKeyOrEmpty( notificationId );
    if ( !id ) return;

    const payload = { notificationId: id };

    for ( const u of recipients.usernames ?? [] ) {
      const user = this.safeUsernameOrEmpty( u );
      if ( !user ) continue;
      this.emitter.emitToRoom( NotificationRooms.user( user ), NotificationEvents.DELETE, payload );
    }

    for ( const r of recipients.roles ?? [] ) {
      const role = this.safeKeyOrEmpty( r );
      if ( !role ) continue;
      this.emitter.emitToRoom( NotificationRooms.role( role ), NotificationEvents.DELETE, payload );
    }

    for ( const t of recipients.teamCodes ?? [] ) {
      const team = this.safeKeyOrEmpty( t );
      if ( !team ) continue;
      this.emitter.emitToRoom( NotificationRooms.team( team ), NotificationEvents.DELETE, payload );
    }

    if ( recipients.company === true ) {
      this.emitter.emitToRoom( NotificationRooms.COMPANY, NotificationEvents.DELETE, payload );
    }
  }

  /* ===========================================================================
   * Method: emitNotifyNew()
   * =========================================================================== */
  public emitNotifyNew(
    recipients: RecipientTargets,
    item: NotificationInboxItemDto,
    count?: NotificationCountResponse
  ): void {
    const payload = count ? { item, count } : { item };

    for ( const u of recipients.usernames ?? [] ) {
      const user = this.safeUsernameOrEmpty( u );
      if ( !user ) continue;
      this.emitter.emitToRoom( NotificationRooms.user( user ), NotificationEvents.NEW, payload );
    }

    for ( const r of recipients.roles ?? [] ) {
      const role = this.safeKeyOrEmpty( r );
      if ( !role ) continue;
      this.emitter.emitToRoom( NotificationRooms.role( role ), NotificationEvents.NEW, payload );
    }

    for ( const t of recipients.teamCodes ?? [] ) {
      const team = this.safeKeyOrEmpty( t );
      if ( !team ) continue;
      this.emitter.emitToRoom( NotificationRooms.team( team ), NotificationEvents.NEW, payload );
    }

    if ( recipients.company === true ) {
      this.emitter.emitToRoom( NotificationRooms.COMPANY, NotificationEvents.NEW, payload );
    }
  }

  /* ===========================================================================
   * Method: emitCountUpdate()
   * =========================================================================== */
  public emitCountUpdate( recipients: RecipientTargets, count: NotificationCountResponse ): void {
    for ( const u of recipients.usernames ?? [] ) {
      const user = this.safeUsernameOrEmpty( u );
      if ( !user ) continue;
      this.emitter.emitToRoom( NotificationRooms.user( user ), NotificationEvents.COUNT, count );
    }

    for ( const r of recipients.roles ?? [] ) {
      const role = this.safeKeyOrEmpty( r );
      if ( !role ) continue;
      this.emitter.emitToRoom( NotificationRooms.role( role ), NotificationEvents.COUNT, count );
    }

    for ( const t of recipients.teamCodes ?? [] ) {
      const team = this.safeKeyOrEmpty( t );
      if ( !team ) continue;
      this.emitter.emitToRoom( NotificationRooms.team( team ), NotificationEvents.COUNT, count );
    }

    if ( recipients.company === true ) {
      this.emitter.emitToRoom( NotificationRooms.COMPANY, NotificationEvents.COUNT, count );
    }
  }

  /* ===========================================================================
   * Method: emitBulkToUser()
   * =========================================================================== */
  public emitBulkToUser( username: string, payload: NotificationBulkPayload ): void {
    const u = this.safeUsernameOrEmpty( username );
    if ( !u ) return;

    this.emitter.emitToRoom( NotificationRooms.user( u ), NotificationEvents.BULK, payload );
  }

  /* ===========================================================================
   * Method: emitCountToUser()
   * =========================================================================== */
  public emitCountToUser( username: string, count: NotificationCountResponse ): void {
    const u = this.safeUsernameOrEmpty( username );
    if ( !u ) return;

    this.emitter.emitToRoom( NotificationRooms.user( u ), NotificationEvents.COUNT, count );
  }

  /* ===========================================================================
   * Backwards-compatible aliases (DO NOT REMOVE)
   * =========================================================================== */
  public emitCountToRecipients( recipients: RecipientTargets, count: NotificationCountResponse ): void {
    this.emitCountUpdate( recipients, count );
  }

  public emitBulkRefreshToUser( username: string, reason?: NotificationBulkPayload[ "reason" ] ): void {
    this.emitBulkToUser( username, { reason: reason ?? "bulk-refresh" } );
  }

  // ========================================================================
  // Internal sanitizers (no throwing)
  // ========================================================================

  private safeUsernameOrEmpty( v: unknown ): string {
    const s = typeof v === "string" ? v.trim() : "";
    return s;
  }

  private safeKeyOrEmpty( v: unknown ): string {
    const s = typeof v === "string" ? v.trim() : "";
    return s;
  }
}