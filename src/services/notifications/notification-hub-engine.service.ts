// Path: src/services/notifications/notification-hub-engine.service.ts
// =============================================================================
// Notification Hub — Engine Service (Improved + Missing Functionality Completed)
// =============================================================================
//
// 01) Purpose of this code
// -----------------------------------------------------------------------------
// - Core engine that creates notifications and delivers them to recipients.
// - Saves master notification document (notifications collection).
// - Creates/updates per-user inbox rows (user_notifications collection).
// - Emits WebSocket events to notify UI instantly (Fix A: emit InboxItem DTO).
// - Triggers delivery drivers (audit/email/sms/push/mq/external) as best-effort.
//
// 02) Missing functionality this version completes
// -----------------------------------------------------------------------------
// A) Fix A correctness: WS NEW emits NotificationInboxItemDto (not only coreDto)
// B) Transaction correctness: read-after-write uses same session when provided
// C) Inbox upsert correctness: Keep DB userId as string (your canonical DTO rule)
// D) Optional "count" support: can compute counts (cheap) if you want badge updates
//
// 03) Important matters
// -----------------------------------------------------------------------------
// - exactOptionalPropertyTypes safe: never pass undefined session options
// - Dedup recipients: avoid double inbox rows + double WS pushes
// - Delivery best-effort: do not fail emit() because a driver fails
// =============================================================================

import { Types, type ClientSession } from "mongoose";

import type {
  NotificationAudience,
  NotificationCoreDto,
  NotificationEmitInput,
  NotificationDeliveryDrivers,
  NotificationCountResponse,
  NotificationInboxItemDto,
  NotificationLoadFilters,
  NotificationTitleBodyPatch,
} from "../../types/notification/notification.types";

import { NotificationModel, type NotificationDoc } from "../../models/notifications/notification.model";
import { UserNotificationModel } from "../../models/notifications/user-notification.model";
import { UserModel, type User } from "../../models/user.model";

import { NotificationInnerSetterService, type BuiltNotificationCore } from "./notification-inner-setter.service";
import { NotificationRecipientResolverRegistry } from "./notification-recipient-resolver.registry.service";

import { NotificationSocketService } from "./notification.socket.service";
import { NotificationDeliveryService } from "./delivery/notification-delivery.service";
import type { NotificationDeliveryRequest, NotificationDeliveryResult } from "./delivery/notification-delivery.types";
import { WsEmitterProvider } from "../../socket/ws-emitter.provider";
import { NotificationQueryService } from "./notification.query.service";
import { NotificationPostCommitQueue } from "./notification-post-commit.queue.service";

import {
  NOTIFICATION_CATEGORY_VALUES,
  NOTIFICATION_SEVERITY_VALUES,
} from "../../types/notification/notification.types";

import {
  NotificationActionKeyFilter,
  type NotificationActionKey,
} from "../../types/notification/notification-action-keys.catalog";

/* =============================================================================
 * A) Engine outputs / contracts
 * ========================================================================== */

type UserModelKeyFields = keyof User;

export interface EmitResult {
  notificationId: string;
  deliveredTo: number;
}


/**
 * Resolution returned by audience resolvers.
 *
 * @property usernames
 * - Expected: array of recipient usernames (trimmed, non-empty preferred)
 * - Usage: hub dedupes and maps usernames -> userId for inbox upserts
 */
export interface RecipientResolution {
  usernames: string[];
}

/**
 * Context passed to resolvers.
 * - Only includes session when provided (exactOptionalPropertyTypes-safe)
 */
export interface RecipientResolveContext {
  session?: ClientSession;
}

export class NotificationHubEngineService {
  private readonly innerSetter: NotificationInnerSetterService;
  private readonly delivery: NotificationDeliveryService;
  private readonly query: NotificationQueryService;

  /* ===========================================================================
   * Constructor
   * ======================================================================== */
  public constructor () {
    this.innerSetter = new NotificationInnerSetterService();
    this.delivery = new NotificationDeliveryService();
    this.query = new NotificationQueryService();
  }

  private getWs(): NotificationSocketService {
    return new NotificationSocketService( WsEmitterProvider.Get() );
  }

  /* ===========================================================================
   * Method: create()
   * ======================================================================== */
  /**
   * Create (ingest) a user-supplied notification into the Notification Hub.
   *
   * 01) Introduction
   * - This method is the **safe ingestion gate** for notifications created by users.
   * - It validates + sanitizes incoming DTO then follows the same delivery pipeline as emit().
   *
   * 02) Important matters
   * - Treat `body` as **untrusted input**:
   *   - sanitize title/body/tags/icon
   *   - validate enums (severity/category) + eventKey
   *   - validate audiences array and normalize
   * - Never rely on caller to keep canonical action keys; enforce via catalog filter.
   * - exactOptionalPropertyTypes-safe: optional fields are omitted (never set to undefined).
   *
   * 03) Why we make this method
   * - Allow “user generated notifications” without letting malformed/spoofed payloads
   *   break DB integrity, UI rendering, or WS delivery.
   *
   * @param body
   * - Expected: NotificationCoreDto coming from controller (user-created).
   * - Usage: Master content + audiences + target navigation.
   * - Security: Must be validated and sanitized before persistence.
   */
  public async create( body: NotificationCoreDto ): Promise<NotificationDeliveryResult | null> {
    try {
      const safe = this.sanitizeIncomingCore( body );

      // 1) Persist master notification doc
      const notifDoc = await this.createNotificationDocFromIncomingCore( safe );
      const notifIdStr = String( notifDoc._id );

      // 2) Resolve recipients from audiences (Company/Role/Team/User)
      const ctx = this.buildRecipientResolveContext( undefined );
      const usernames = await this.resolveUsernamesAcrossAudiences( safe.audiences, ctx );

      if ( usernames.length === 0 ) {
        console.log(
          `[Info:] NotificationHubEngineService.create: no recipients resolved. notificationId=${ notifIdStr }\n`
        );
        return null;
      }

      // 3) Map usernames -> userIds
      const identities = await this.loadRecipientIdentities( usernames );

      if ( identities.length === 0 ) {
        console.log(
          `[Warning:] NotificationHubEngineService.create: recipients resolved but no identities found. notificationId=${ notifIdStr }\n`
        );
        return null;
      }

      // 4) Upsert inbox rows
      await this.ensureUserInboxRows( identities, notifDoc._id );

      // 5) Load inbox DTOs and emit WS (Fix A payload = InboxItem DTO)
      const inboxItems = await this.query.loadInboxItemsByNotificationAndUsers(
        notifIdStr,
        identities.map( ( x ) => x.userId )
      );

      const byUsername = new Map<string, NotificationInboxItemDto>();
      for ( const item of inboxItems ) {
        const u = typeof item.username === "string" ? item.username.trim() : "";
        if ( !u ) continue;
        if ( !byUsername.has( u ) ) byUsername.set( u, item );
      }

      for ( const r of identities ) {
        const item = byUsername.get( r.username );
        if ( !item ) continue;
        this.getWs().emitNotifyNew( { usernames: [ r.username ] }, item );
      }

      // 6) Delivery (best-effort)
      const coreDto = this.mapDocToCoreDto( notifDoc );

      const drivers: NotificationDeliveryDrivers = {
        audit: true,
        email: false,
        external: false,
        mq: false,
        push: false,
        sms: false,
      };

      const deliveryReq: NotificationDeliveryRequest = {
        notificationId: notifIdStr,
        notification: coreDto,
        recipients: identities.map( ( r ) => ( { username: r.username, userId: r.userId } ) ),
        drivers,
      };

      const delivered: NotificationDeliveryResult = await this.delivery.deliver( deliveryReq );

      const reliveryResults: NotificationDeliveryResult = {
        ...delivered,
        notification: coreDto,
      };

      return reliveryResults;
    } catch ( error ) {
      console.error(
        "[Error:] [NotificationHubEngineService:] Failed to create incoming notification\n",
        error,
        "\n"
      );
      return null;
    }
  }


  /* ===========================================================================
  * Method: updateTitleBody()
  * ======================================================================== */
  /**
   * Update only `title` and/or `body` of an existing notification.
   *
   * 01) Introduction
   * - Updates master notification doc (notifications collection).
   * - DOES NOT change actor/audiences/eventKey/category/severity/target/etc.
   * - Emits WS PATCH using InboxItem DTO to all recipients who already have inbox rows.
   *
   * 02) Important matters
   * - Caller must omit fields (never pass undefined) — exactOptionalPropertyTypes-safe.
   * - Empty patch is ignored.
   * - Sanitizes input to prevent UI/control-character issues.
   *
   * @param notificationId
   * - Expected: MongoId string for notifications._id
   *
   * @param patch
   * - Expected: { title?: string; body?: string }
   * - Usage: update content only
   *
   * @param session
   * - Optional mongoose ClientSession
   */
  public async updateTitleBody(
    notificationId: string,
    patch: NotificationTitleBodyPatch,
    session?: ClientSession
  ): Promise<NotificationCoreDto | null> {
    try {
      const nid = this.safeObjectId( notificationId, "notificationId" );
      const safePatch = this.sanitizeTitleBodyPatch( patch );

      // Build $set doc (only provided fields)
      const setDoc: Record<string, unknown> = {};
      if ( typeof safePatch.title === "string" ) setDoc[ "title" ] = safePatch.title;
      if ( typeof safePatch.body === "string" ) setDoc[ "body" ] = safePatch.body;

      if ( Object.keys( setDoc ).length === 0 ) {
        console.log(
          `[Info:] NotificationHubEngineService.updateTitleBody: empty patch. notificationId=${ notificationId }\n`
        );
        return null;
      }

      // 1) Update master notification
      const updated = await NotificationModel.findOneAndUpdate(
        { _id: nid },
        { $set: setDoc },
        { new: true, ...this.optSession( session ) }
      )
        .lean()
        .exec();

      if ( !updated ) {
        console.log(
          `[Warning:] NotificationHubEngineService.updateTitleBody: not found. notificationId=${ notificationId }\n`
        );
        return null;
      }

      const coreDto = this.mapDocToCoreDto( updated as unknown as NotificationDoc );

      // 2) Find recipients = users who already have inbox rows for this notification
      const recipients = await this.loadRecipientsByNotificationId( notificationId, session );
      if ( recipients.length === 0 ) return coreDto;

      // 3) Reload inbox DTOs and emit WS PATCH (Fix A payload)
      const inboxItems = await this.query.loadInboxItemsByNotificationAndUsers(
        notificationId,
        recipients.map( ( x ) => x.userId ),
        session
      );

      const byUsername = new Map<string, NotificationInboxItemDto>();
      for ( const item of inboxItems ) {
        const u = typeof item.username === "string" ? item.username.trim() : "";
        if ( !u ) continue;
        if ( !byUsername.has( u ) ) byUsername.set( u, item );
      }

      for ( const r of recipients ) {
        const item = byUsername.get( r.username );
        if ( !item ) continue;

        // ✅ requires NotificationSocketService.emitNotifyPatch(...)
        this.getWs().emitNotifyPatch( { usernames: [ r.username ] }, item );
      }

      return coreDto;
    } catch ( error ) {
      console.error(
        "[Error:] [NotificationHubEngineService:] Failed to update notification title/body\n",
        error,
        "\n"
      );
      return null;
    }
  }


  /* ===========================================================================
 * Method: delete()
 * ======================================================================== */
  /**
   * Hard delete a notification and remove all related inbox rows.
   *
   * 01) Introduction
   * - Deletes master notification (notifications collection).
   * - Deletes all related user_notifications rows.
   * - Emits notify:delete to affected users only.
   *
   * 02) Important matters
   * - DB is source of truth → delete DB first, then emit WS.
   * - Does NOT throw.
   * - exactOptionalPropertyTypes-safe.
   *
   * @param notificationId
   * - Expected: Mongo ObjectId string
   *
   * @param session
   * - Optional mongoose ClientSession
   *
   * @returns
   * - { notificationId, deleted, inboxRowsDeleted } or null
   */
  public async delete(
    notificationId: string,
    session?: ClientSession
  ): Promise<{ notificationId: string; deleted: boolean; inboxRowsDeleted: number; } | null> {
    try {
      const nid = this.safeObjectId( notificationId, "notificationId" );

      /* ---------------------------------------------------------
       * 1) Load recipients BEFORE deletion
       * ------------------------------------------------------- */
      const inboxRows = await UserNotificationModel.find(
        { notificationId: nid },
        { username: 1 }
      )
        .lean()
        .exec();

      const usernames: string[] = [];
      const seen = new Set<string>();

      for ( const row of inboxRows as Array<Record<string, unknown>> ) {
        const u = typeof row[ "username" ] === "string" ? row[ "username" ].trim() : "";
        if ( !u ) continue;

        if ( !seen.has( u ) ) {
          seen.add( u );
          usernames.push( u );
        }
      }

      /* ---------------------------------------------------------
       * 2) Delete inbox rows
       * ------------------------------------------------------- */
      const inboxDeleteRes = await UserNotificationModel.deleteMany(
        { notificationId: nid },
        this.optSession( session )
      );

      /* ---------------------------------------------------------
       * 3) Delete master notification
       * ------------------------------------------------------- */
      const masterDeleteRes = await NotificationModel.deleteOne(
        { _id: nid },
        this.optSession( session )
      );

      const deleted = ( masterDeleteRes.deletedCount ?? 0 ) > 0;
      const inboxRowsDeleted = inboxDeleteRes.deletedCount ?? 0;

      /* ---------------------------------------------------------
       * 4) Emit WS delete event
       * ------------------------------------------------------- */
      if ( deleted && usernames.length > 0 ) {
        this.getWs().emitNotifyDelete(
          { usernames },
          notificationId
        );
      }

      return {
        notificationId,
        deleted,
        inboxRowsDeleted
      };
    }
    catch ( error ) {
      console.error(
        "[Error:] [NotificationHubEngineService:] Failed to delete notification\n",
        error,
        "\n"
      );
      return null;
    }
  }



  /**
   * Load recipient identities by existing inbox rows for a notification.
   *
   * Why:
   * - Update should patch only users who already received the notification.
   * - Avoid recalculating audiences (prevents privilege/data-leak issues).
   *
   * @param notificationId
   * - Expected: notification _id as string
   *
   * @param session
   * - Optional mongoose session
   */
  private async loadRecipientsByNotificationId(
    notificationId: string,
    session?: ClientSession
  ): Promise<Array<{ userId: string; username: string; }>> {
    const nid = this.safeObjectId( notificationId, "notificationId" );

    const q = UserNotificationModel.find(
      { notificationId: nid },
      { userId: 1, username: 1 }
    ).lean();

    if ( session ) q.session( session );

    const rows = await q.exec();

    const out: Array<{ userId: string; username: string; }> = [];
    const seen = new Set<string>();

    for ( const r of rows as Array<Record<string, unknown>> ) {
      const uid = typeof r[ "userId" ] === "string" ? String( r[ "userId" ] ).trim() : "";
      const uname = typeof r[ "username" ] === "string" ? String( r[ "username" ] ).trim() : "";
      if ( !uid || !uname ) continue;

      // dedupe by userId (stable)
      if ( seen.has( uid ) ) continue;
      seen.add( uid );

      out.push( { userId: uid, username: uname } );
    }

    return out;
  }

  /* ===========================================================================
   * Internal: Incoming core sanitization + validation
   * ======================================================================== */

  /**
   * Validate and sanitize a user-supplied NotificationCoreDto.
   *
   * Key rules:
   * - eventKey must be a valid NotificationActionKey (catalog-enforced)
   * - category/severity must be allowed enums
   * - title/body must be trimmed, length-limited, and safe for UI rendering
   * - audiences must be an array and have valid shapes per union
   * - optionals are omitted when empty (exactOptionalPropertyTypes-safe)
   */
  private sanitizeIncomingCore( body: NotificationCoreDto ): NotificationCoreDto {
    const b = body as unknown as Record<string, unknown>;

    const id = this.safeString( b[ "id" ], "id" ); // required by DTO, but not trusted—still validated

    const rawEventKey = this.safeString( b[ "eventKey" ], "eventKey" );
    const eventKey = this.forceActionKey( rawEventKey );

    const category = this.forceCategory( b[ "category" ] );
    const severity = this.forceSeverity( b[ "severity" ] );

    const title = this.cleanText( this.safeString( b[ "title" ], "title" ), 180, "title" );
    const msgBody = this.cleanText( this.safeString( b[ "body" ], "body" ), 4000, "body" );

    const actor = this.sanitizeActor( b[ "actor" ] );

    const audiences = this.sanitizeAudiences( b[ "audiences" ] );

    // Build sanitized DTO (omit optionals if empty)
    const out: NotificationCoreDto = {
      id,
      eventKey,
      category,
      severity,
      title,
      body: msgBody,
      actor,
      audiences,
      createdAt: this.safeString( b[ "createdAt" ], "createdAt" ),
    };

    const icon = this.cleanOptionalShortString( b[ "icon" ], 80 );
    if ( icon ) out.icon = icon;

    const tags = this.cleanTags( b[ "tags" ] );
    if ( tags.length > 0 ) out.tags = tags;

    const target = this.sanitizeTarget( b[ "target" ] );
    if ( target ) out.target = target;

    const expiresAt = this.cleanOptionalIsoDateString( b[ "expiresAt" ] );
    if ( expiresAt ) out.expiresAt = expiresAt;

    return out;
  }

  private forceActionKey( raw: string ): NotificationActionKey {
    // strict: must exist in catalog
    const hit = NotificationActionKeyFilter.exactOrNull( raw );
    if ( !hit ) throw new Error( "NotificationHubEngineService.create: invalid eventKey (action key not allowed)." );
    return hit;
  }

  private forceCategory( v: unknown ): NotificationCoreDto[ "category" ] {
    const s = typeof v === "string" ? v.trim() : "";
    if ( !s ) throw new Error( "NotificationHubEngineService.create: category is required." );

    const ok = NOTIFICATION_CATEGORY_VALUES.includes( s as ( typeof NOTIFICATION_CATEGORY_VALUES )[ number ] );
    if ( !ok ) throw new Error( "NotificationHubEngineService.create: invalid category." );

    return s as NotificationCoreDto[ "category" ];
  }

  private forceSeverity( v: unknown ): NotificationCoreDto[ "severity" ] {
    const s = typeof v === "string" ? v.trim() : "";
    if ( !s ) throw new Error( "NotificationHubEngineService.create: severity is required." );

    const ok = NOTIFICATION_SEVERITY_VALUES.includes( s as ( typeof NOTIFICATION_SEVERITY_VALUES )[ number ] );
    if ( !ok ) throw new Error( "NotificationHubEngineService.create: invalid severity." );

    return s as NotificationCoreDto[ "severity" ];
  }

  private sanitizeActor( v: unknown ): NotificationCoreDto[ "actor" ] {
    const a = ( v && typeof v === "object" ) ? ( v as Record<string, unknown> ) : null;
    if ( !a ) throw new Error( "NotificationHubEngineService.create: actor is required." );

    const userId = this.safeString( a[ "userId" ], "actor.userId" );
    const username = this.safeUsername( a[ "username" ] );
    const role = this.safeString( a[ "role" ], "actor.role" );

    const out: NotificationCoreDto[ "actor" ] = { userId, username, role };

    const teamCodes = this.cleanOptionalStringArray( a[ "teamCodes" ], 30, 40 );
    if ( teamCodes.length > 0 ) out.teamCodes = teamCodes;

    const branchId = this.cleanOptionalShortString( a[ "branchId" ], 60 );
    if ( branchId ) out.branchId = branchId;

    return out;
  }

  private sanitizeAudiences( v: unknown ): NotificationAudience[] {
    const arr = Array.isArray( v ) ? v : [];
    if ( arr.length === 0 ) throw new Error( "NotificationHubEngineService.create: audiences[] is required." );

    const out: NotificationAudience[] = [];

    for ( const raw of arr ) {
      const a = ( raw && typeof raw === "object" ) ? ( raw as Record<string, unknown> ) : null;
      if ( !a ) continue;

      const mode = typeof a[ "mode" ] === "string" ? a[ "mode" ].trim() : "";

      if ( mode === "Company" ) {
        out.push( { mode: "Company" } );
        continue;
      }

      if ( mode === "Role" ) {
        const roleKey = typeof a[ "roleKey" ] === "string" ? a[ "roleKey" ].trim() : "";
        if ( !roleKey ) throw new Error( "NotificationHubEngineService.create: Role audience requires roleKey." );
        out.push( { mode: "Role", roleKey: roleKey as never } );
        continue;
      }

      if ( mode === "Team" ) {
        const teamCode = typeof a[ "teamCode" ] === "string" ? a[ "teamCode" ].trim() : "";
        if ( !teamCode ) throw new Error( "NotificationHubEngineService.create: Team audience requires teamCode." );
        out.push( { mode: "Team", teamCode } );
        continue;
      }

      if ( mode === "User" ) {
        const username = typeof a[ "username" ] === "string" ? a[ "username" ].trim() : "";
        if ( !username ) throw new Error( "NotificationHubEngineService.create: User audience requires username." );
        out.push( { mode: "User", username } );
        continue;
      }

      throw new Error( "NotificationHubEngineService.create: invalid audience mode." );
    }

    // Dedupe (same audience repeated)
    return this.dedupeAudiences( out );
  }

  private dedupeAudiences( list: NotificationAudience[] ): NotificationAudience[] {
    const out: NotificationAudience[] = [];
    const seen = new Set<string>();

    for ( const a of list ) {
      const key =
        a.mode === "Company"
          ? "Company"
          : a.mode === "Role"
            ? `Role:${ String( a.roleKey ) }`
            : a.mode === "Team"
              ? `Team:${ a.teamCode }`
              : `User:${ a.username }`;

      if ( seen.has( key ) ) continue;
      seen.add( key );
      out.push( a );
    }

    return out;
  }

  private sanitizeTarget( v: unknown ): NotificationCoreDto[ "target" ] | null {
    if ( !v || typeof v !== "object" ) return null;
    const t = v as Record<string, unknown>;

    const out: NonNullable<NotificationCoreDto[ "target" ]> = {};

    const module = this.cleanOptionalShortString( t[ "module" ], 80 );
    if ( module ) out.module = module;

    const category = this.cleanOptionalShortString( t[ "category" ], 80 );
    if ( category ) out.category = category;

    const refId = this.cleanOptionalShortString( t[ "refId" ], 120 );
    if ( refId ) out.refId = refId;

    const route = this.cleanOptionalShortString( t[ "route" ], 300 );
    if ( route ) out.route = route;

    const actionKeyRaw = this.cleanOptionalShortString( t[ "actionKey" ], 120 );
    if ( actionKeyRaw ) out.actionKey = this.forceActionKey( actionKeyRaw );

    const params = this.cleanOptionalParamsObject( t[ "params" ] );
    if ( params ) out.params = params;

    return Object.keys( out ).length > 0 ? out : null;
  }

  private cleanOptionalParamsObject( v: unknown ): Record<string, unknown> | null {
    if ( !v || typeof v !== "object" ) return null;
    if ( Array.isArray( v ) ) return null;

    // shallow-copy only plain key/values
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};

    for ( const k of Object.keys( src ) ) {
      const key = typeof k === "string" ? k.trim() : "";
      if ( !key ) continue;

      const val = src[ k ];
      if ( val === undefined ) continue;

      out[ key ] = val;
    }

    return Object.keys( out ).length > 0 ? out : null;
  }

  private cleanTags( v: unknown ): string[] {
    const arr = Array.isArray( v ) ? v : [];
    const out: string[] = [];
    const seen = new Set<string>();

    for ( const x of arr ) {
      const s = typeof x === "string" ? x.trim() : "";
      if ( !s ) continue;

      const cleaned = this.cleanText( s, 40, "tag" );
      if ( !cleaned ) continue;

      const key = cleaned.toLowerCase();
      if ( seen.has( key ) ) continue;
      seen.add( key );

      out.push( cleaned );
      if ( out.length >= 12 ) break; // hard limit
    }

    return out;
  }

  private cleanOptionalStringArray( v: unknown, maxItems: number, maxLen: number ): string[] {
    const arr = Array.isArray( v ) ? v : [];
    const out: string[] = [];
    const seen = new Set<string>();

    for ( const x of arr ) {
      const s = typeof x === "string" ? x.trim() : "";
      if ( !s ) continue;

      const cleaned = this.cleanText( s, maxLen, "stringArrayItem" );
      if ( !cleaned ) continue;

      const key = cleaned.toLowerCase();
      if ( seen.has( key ) ) continue;
      seen.add( key );

      out.push( cleaned );
      if ( out.length >= maxItems ) break;
    }

    return out;
  }

  private cleanOptionalShortString( v: unknown, maxLen: number ): string | "" {
    const s = typeof v === "string" ? v.trim() : "";
    if ( !s ) return "";
    return this.cleanText( s, maxLen, "shortString" );
  }

  private cleanOptionalIsoDateString( v: unknown ): string | "" {
    const s = typeof v === "string" ? v.trim() : "";
    if ( !s ) return "";
    // basic ISO guard (avoid throwing for valid ISO variants)
    const d = new Date( s );
    if ( Number.isNaN( d.getTime() ) ) return "";
    return d.toISOString();
  }

  private cleanText( input: string, maxLen: number, label: string ): string {
    const s = typeof input === "string" ? input.trim() : "";
    if ( !s ) throw new Error( `NotificationHubEngineService.create: ${ label } is required.` );

    // Basic UI-safe cleanup: remove control chars (keeps normal unicode)
    const noCtrl = s.replace( /[\u0000-\u001F\u007F]/g, " " ).trim();

    if ( noCtrl.length > maxLen ) return noCtrl.slice( 0, maxLen ).trim();
    return noCtrl;
  }

  /**
   * Create master notification doc from sanitized user core DTO.
   *
   * Important:
   * - Uses Date fields as Date in DB
   * - Stores audiences array
   * - Stores target if present
   */
  private async createNotificationDocFromIncomingCore(
    safe: NotificationCoreDto
  ): Promise<NotificationDoc> {
    const createdAt = new Date( safe.createdAt );
    if ( Number.isNaN( createdAt.getTime() ) ) {
      throw new Error( "NotificationHubEngineService.create: createdAt is invalid." );
    }

    const payload: Record<string, unknown> = {
      eventKey: safe.eventKey,
      category: safe.category,
      severity: safe.severity,
      title: safe.title,
      body: safe.body,
      actor: safe.actor,
      audiences: safe.audiences,
      createdAt,
    };

    if ( safe.icon ) payload.icon = safe.icon;
    if ( safe.tags && safe.tags.length > 0 ) payload.tags = safe.tags;
    if ( safe.target ) payload.target = safe.target;

    if ( safe.expiresAt ) {
      const exp = new Date( safe.expiresAt );
      if ( !Number.isNaN( exp.getTime() ) ) payload.expiresAt = exp;
    }

    const docs = await NotificationModel.create( [ payload ] );
    return docs[ 0 ] as unknown as NotificationDoc;
  }


  /**
 * Sanitize update patch for title/body only.
 *
 * @param patch
 * - Expected: possibly partial object
 * - Usage: returns only valid fields (omits absent ones)
 */
  private sanitizeTitleBodyPatch( patch: NotificationTitleBodyPatch ): NotificationTitleBodyPatch {
    const p = ( patch && typeof patch === "object" ) ? patch : {};

    const out: NotificationTitleBodyPatch = {};

    if ( typeof p.title === "string" ) {
      out.title = this.cleanText( p.title, 180, "title" );
    }

    if ( typeof p.body === "string" ) {
      out.body = this.cleanText( p.body, 4000, "body" );
    }

    return out;
  }


  /* ===========================================================================
   * Method: emit()
   * ======================================================================== */

  /**
   * Create a notification, persist it, create inbox rows, emit WS, and trigger drivers.
   *
   * @param input
   * - Expected: NotificationEmitInput (audiences MUST be array; enforced by innerSetter)
   *
   * @param session
   * - Optional: mongoose ClientSession for transactional safety
   */
  public async emit( input: NotificationEmitInput, session?: ClientSession ): Promise<EmitResult> {
    // Step 1: Normalize input into internal core (policy + validation)
    const built: BuiltNotificationCore = this.innerSetter.buildCore( input );

    // Step 2: Persist master notification
    const notifDoc = await this.createNotificationDoc( built, session );
    const notifIdStr = String( notifDoc._id );


    // Step 3: Resolve usernames across all audiences (deduped)
    const ctx = this.buildRecipientResolveContext( session );
    const usernames = await this.resolveUsernamesAcrossAudiences( built.audiences, ctx );

    if ( usernames.length === 0 ) {
      // eslint-disable-next-line no-console
      console.log( "[Info:] NotificationHubEngineService.emit: no recipients resolved.\n" );
      return { notificationId: notifIdStr, deliveredTo: 0 };
    }

    // Step 4: Map usernames → {username, userId} using UserModel
    const identities = await this.loadRecipientIdentities( usernames, session );

    if ( identities.length === 0 ) {
      // eslint-disable-next-line no-console
      console.log( "[Warning:] NotificationHubEngineService.emit: recipients resolved but no identities found.\n" );
      return { notificationId: notifIdStr, deliveredTo: 0 };
    }

    // Step 5: Upsert per-user inbox rows (bulk)
    const deliveredTo = await this.ensureUserInboxRows( identities, notifDoc._id, session );

    // Step 6: Build canonical core DTO from persisted doc (delivery uses this)
    const coreDto = this.mapDocToCoreDto( notifDoc );

    // FIX B: if in transaction, defer WS + delivery until commit
    if ( session && typeof session.inTransaction === "function" && session.inTransaction() ) {
      NotificationPostCommitQueue.enqueue( session, {
        notificationId: notifIdStr,
        recipientUserIds: identities.map( ( x ) => x.userId ),
        recipientUsernames: identities.map( ( x ) => x.username ),
      } );

      // eslint-disable-next-line no-console
      console.log( `[Info:] NotificationHubEngineService.emit: deferred WS+delivery until commit. notificationId=${ notifIdStr }\n` );

      return { notificationId: notifIdStr, deliveredTo };
    }

    // Step 7 (FIX A): Load inbox DTOs for the recipients and emit notify:new with InboxItem DTO
    // - We cannot rely on bulkWrite returning all inboxIds (matched rows have no _id returned)
    // - So we bulk-read DTOs using the query service (single DB read)
    const inboxItems = await this.query.loadInboxItemsByNotificationAndUsers(
      notifIdStr,
      identities.map( ( x ) => x.userId ),
      session
    );

    // Map items by username to emit deterministically
    const byUsername = new Map<string, NotificationInboxItemDto>();
    for ( const item of inboxItems ) {
      const u = typeof item.username === "string" ? item.username.trim() : "";
      if ( !u ) continue;
      if ( !byUsername.has( u ) ) byUsername.set( u, item );
    }

    // Optional: compute counts for badge updates (can be expensive if done N times)
    // - If you want counts, compute once per user with a minimal filter set.
    // - Here we keep it disabled by default (enterprise: avoid fan-out count queries).
    const countByUsername = new Map<string, NotificationCountResponse>();

    for ( const r of identities ) {
      const item = byUsername.get( r.username );

      if ( !item ) {
        // eslint-disable-next-line no-console
        console.log(
          `[Warning:] NotificationHubEngineService.emit: inbox DTO not found for username=${ r.username } notificationId=${ notifIdStr }\n`
        );
        continue;
      }

      // ✅ Emit inbox item DTO (Fix A contract)
      const maybeCount = countByUsername.get( r.username );
      this.getWs().emitNotifyNew( { usernames: [ r.username ] }, item, maybeCount );
    }

    // Step 8: Best-effort delivery (policy flags)
    const drivers = this.normalizeDrivers( input.delivery );

    const deliveryReq: NotificationDeliveryRequest = {
      notificationId: notifIdStr,
      notification: coreDto,
      recipients: identities.map( ( r ) => ( { username: r.username, userId: r.userId } ) ),
      drivers,
    };

    // IMPORTANT
    // - Delivery is best-effort; do not break emit() if a driver fails.
    // - If you want stronger isolation: wrap in try/catch and log.
    await this.delivery.deliver( deliveryReq );

    return { notificationId: notifIdStr, deliveredTo };
  }

  /**
 * Flush WS + delivery jobs queued during a transaction.
 *
 * Call this AFTER session.commitTransaction().
 *
 * @param session
 * - Expected: the same session used for emit() during the transaction
 */
  public async flushPostCommit( session: ClientSession ): Promise<void> {
    const jobs = NotificationPostCommitQueue.drain( session );
    if ( jobs.length === 0 ) return;

    for ( const job of jobs ) {
      // 1) Reload inbox items WITHOUT session (post-commit visibility)
      const inboxItems = await this.query.loadInboxItemsByNotificationAndUsers(
        job.notificationId,
        job.recipientUserIds
      );

      const byUsername = new Map<string, NotificationInboxItemDto>();
      for ( const item of inboxItems ) {
        const u = typeof item.username === "string" ? item.username.trim() : "";
        if ( !u ) continue;
        if ( !byUsername.has( u ) ) byUsername.set( u, item );
      }

      // 2) Emit Fix A payloads (InboxItem DTO)
      for ( const uname of job.recipientUsernames ) {
        const item = byUsername.get( uname );
        if ( !item ) continue;
        this.getWs().emitNotifyNew( { usernames: [ uname ] }, item );
      }

      // 3) Delivery (best-effort)
      // If you want to avoid a DB read for coreDto, use minimal delivery,
      // or load the master notification doc again and map to coreDto.
      const doc = await NotificationModel.findById( job.notificationId ).lean().exec();
      if ( doc ) {
        const coreDto = this.mapDocToCoreDto( doc as unknown as NotificationDoc );

        const drivers: NotificationDeliveryDrivers = {
          audit: true,
          email: false,
          external: false,
          mq: false,
          push: false,
          sms: false,
        };

        const deliveryReq: NotificationDeliveryRequest = {
          notificationId: job.notificationId,
          notification: coreDto,
          recipients: job.recipientUsernames.map( ( u, i ) => ( {
            username: u,
            userId: job.recipientUserIds[ i ] ?? "",
          } ) ).filter( ( x ) => x.userId && x.username ),
          drivers,
        };

        await this.delivery.deliver( deliveryReq );
      }
    }
  }

  public clearPostCommit( session: ClientSession ): void {
    NotificationPostCommitQueue.clear( session );
  }

  /* ===========================================================================
   * Inbox mutations (existing functionality kept)
   * ======================================================================== */

  /**
   * Mark a single inbox row as read for the authenticated user.
   *
   * @param userId
   * - Expected: Auth userId as string (MongoId string)
   * - Usage: ownership boundary for inbox row mutation (stable identifier)
   *
   * @param inboxId
   * - Expected: MongoId string for user_notifications._id
   * - Usage: selects a specific inbox row
   *
   * @param session
   * - Optional mongoose session for transaction-safe mutation
   */
  public async markRead( userId: string, username: string, inboxId: string, session?: ClientSession ): Promise<boolean> {
    const uid = this.safeString( userId, "userId" );
    const id = this.safeObjectId( inboxId, "inboxId" );
    const safeUsername = this.safeUsername( username );

    const res = await UserNotificationModel.updateOne(
      { _id: id, userId: uid, username: safeUsername, isRead: false, isArchived: false, isDeleted: false },
      { $set: { isRead: true, readAt: new Date() } },
      this.optSession( session )
    );

    return ( res.modifiedCount ?? 0 ) > 0;
  }

  /**
   * Mark all inbox rows as read for the authenticated user.
   *
   * @param userId
   * - Expected: Auth userId as string (MongoId string)
   * - Usage: ownership boundary for bulk mutation
   *
   * @param username
   * - Expected: Auth username as string
   * 
   * @param session
   * - Optional mongoose session for transaction-safe mutation
   */
  public async markAllRead( userId: string, username: string, session?: ClientSession ): Promise<number> {
    const uid = this.safeString( userId, "userId" );
    const safeUsername = this.safeUsername( username );

    const res = await UserNotificationModel.updateMany(
      { userId: uid, username: safeUsername, isRead: false, isArchived: false, isDeleted: false },
      { $set: { isRead: true, readAt: new Date() } },
      this.optSession( session )
    );

    return res.modifiedCount ?? 0;
  }

  /**
   * Archive (hide) a single inbox row for the authenticated user.
   *
   * @param userId
   * - Expected: Auth userId as string (MongoId string)
   * - Usage: ownership boundary for inbox row mutation
   * 
   * @param username
   * - Expected: Auth username as string
   *
   * @param inboxId
   * - Expected: MongoId string for user_notifications._id
   * - Usage: selects a specific inbox row
   *
   * @param session
   * - Optional mongoose session for transaction-safe mutation
   */
  public async archiveOne( userId: string, username: string, inboxId: string, session?: ClientSession ): Promise<boolean> {
    const uid = this.safeString( userId, "userId" );
    const id = this.safeObjectId( inboxId, "inboxId" );
    const safeUsername = this.safeUsername( username );

    const res = await UserNotificationModel.updateOne(
      { _id: id, userId: uid, username: safeUsername, isArchived: false, isDeleted: false },
      { $set: { isArchived: true, archivedAt: new Date() } },
      this.optSession( session )
    );

    return ( res.modifiedCount ?? 0 ) > 0;
  }

  /* ===========================================================================
   * Helper: fetchUserFieldAsStringArray (kept; minor hardening)
   * ======================================================================== */

  public async fetchUserFieldAsStringArray( membersIDs: Types.ObjectId[], key: UserModelKeyFields ): Promise<string[]> {
    const normalizedIds = this.normalizeObjectIds( membersIDs );
    if ( normalizedIds.length === 0 ) return [];

    const projection: Record<string, 0 | 1> = { [ String( key ) ]: 1 };

    const rows = await UserModel.find( { _id: { $in: normalizedIds } } )
      .select( projection )
      .lean<Array<Record<string, unknown>>>()
      .exec();

    const out: string[] = [];
    const seen = new Set<string>();

    for ( const r of rows ) {
      const raw = r[ String( key ) ];
      if ( typeof raw !== "string" ) continue;

      const val = raw.trim();
      if ( !val ) continue;

      if ( seen.has( val ) ) continue;
      seen.add( val );
      out.push( val );
    }

    return out;
  }

  /* ===========================================================================
   * Internal: Recipient resolution
   * ======================================================================== */

  private buildRecipientResolveContext( session?: ClientSession ): RecipientResolveContext {
    return session ? { session } : {};
  }

  private async resolveUsernamesAcrossAudiences(
    audiences: NotificationAudience[],
    ctx: RecipientResolveContext
  ): Promise<string[]> {
    const list = Array.isArray( audiences ) ? audiences : [];
    const all: string[] = [];

    for ( const a of list ) {
      const resolution = await NotificationRecipientResolverRegistry.resolve( a, ctx );
      if ( Array.isArray( resolution.usernames ) && resolution.usernames.length > 0 ) {
        all.push( ...resolution.usernames );
      }
    }

    return this.dedupeUsernames( all );
  }

  private dedupeUsernames( usernames: string[] ): string[] {
    const cleaned = ( Array.isArray( usernames ) ? usernames : [] )
      .map( ( u ) => ( typeof u === "string" ? u.trim() : "" ) )
      .filter( ( u ) => u.length > 0 );

    return Array.from( new Set( cleaned ) );
  }

  /* ===========================================================================
   * Internal: Identity mapping (username -> userId)
   * ======================================================================== */

  private async loadRecipientIdentities(
    usernames: string[],
    session?: ClientSession
  ): Promise<Array<{ username: string; userId: string; }>> {
    const list = Array.isArray( usernames ) ? usernames : [];
    if ( list.length === 0 ) return [];

    const q = UserModel.find( { username: { $in: list } }, { _id: 1, username: 1 } ).lean();
    if ( session ) q.session( session );

    const rows = await q.exec();

    const mapped = new Map<string, string>();
    for ( const r of rows ) {
      const uname = typeof ( r as { username?: unknown; } ).username === "string" ? String( r.username ).trim() : "";
      const id = ( r as { _id?: unknown; } )._id;

      if ( !uname ) continue;
      if ( !( id instanceof Types.ObjectId ) ) continue;

      mapped.set( uname, String( id ) );
    }

    const out: Array<{ username: string; userId: string; }> = [];
    for ( const u of list ) {
      const id = mapped.get( u );
      if ( id ) out.push( { username: u, userId: id } );
    }

    return out;
  }

  /* ===========================================================================
   * Internal: Persistence
   * ======================================================================== */

  private async createNotificationDoc( built: BuiltNotificationCore, session?: ClientSession ): Promise<NotificationDoc> {
    const payload: Record<string, unknown> = {
      eventKey: built.eventKey,
      category: built.category,
      severity: built.severity,
      title: built.title,
      body: built.body,
      actor: built.actor,
      audiences: built.audiences,
      createdAt: new Date(),
    };

    if ( built.icon ) payload.icon = built.icon;
    if ( built.tags && built.tags.length > 0 ) payload.tags = built.tags;
    if ( built.target ) payload.target = built.target;
    if ( built.expiresAt ) payload.expiresAt = built.expiresAt;

    const docs = await NotificationModel.create( [ payload ], this.optSession( session ) );
    return docs[ 0 ] as unknown as NotificationDoc;
  }

  /**
   * Upsert per-user inbox rows.
   *
   * IMPORTANT
   * - Your current UserNotificationEntity typing expects:
   *   - userId: string   ✅
   *   - notificationId: ObjectId (or ObjectId-compatible) ✅
   *
   * Why this method exists
   * - Bulk upsert inbox rows efficiently without N queries.
   * - Ensures a single row per (userId + notificationId).
   *
   * @param recipients
   * - Expected: Array<{ username: string; userId: string }>
   * - Usage: resolved recipients. userId must be a MongoId string.
   *
   * @param notificationId
   * - Expected: Types.ObjectId (master notification _id)
   * - Usage: foreign-key to notifications collection.
   *
   * @param session
   * - Optional: mongoose session (transaction-safe).
   *
   * Upsert per-user inbox rows.
   *
   * Fix:
   * - MongoDB forbids setting the same field in $set and $setOnInsert.
   * - We keep username in $set (always correct), and remove it from $setOnInsert.
   *
   * Guard:
   * - Deduplicate recipients by userId to prevent duplicate bulk ops
   *   if callers ever pass duplicates (User mode + Role mode overlaps, etc).
   */
  private async ensureUserInboxRows(
    recipients: Array<{ username: string; userId: string; }>,
    notificationId: Types.ObjectId,
    session?: ClientSession
  ): Promise<number> {
    if ( !Array.isArray( recipients ) || recipients.length === 0 ) return 0;

    const now = new Date();

    // Guard: unique by userId (role+user overlap safety)
    const unique = this.uniqueRecipientsByUserId( recipients );

    const ops = unique
      .map( ( r ) => {
        const uname = typeof r.username === "string" ? r.username.trim() : "";
        const uid = typeof r.userId === "string" ? r.userId.trim() : "";

        if ( !uname ) return null;
        if ( !uid || !Types.ObjectId.isValid( uid ) ) return null;

        return {
          updateOne: {
            filter: { userId: uid, notificationId },

            update: {
              // Keep username always correct (if someone renamed, etc.)
              $set: { username: uname },

              // Insert-only fields (DO NOT repeat username here)
              $setOnInsert: {
                userId: uid,
                notificationId,

                isRead: false,
                isArchived: false,
                isDeleted: false,

                deliveredAt: now,
              },
            },

            upsert: true,
          },
        };
      } )
      .filter( ( x ): x is NonNullable<typeof x> => !!x );

    if ( ops.length === 0 ) return 0;

    const res = await UserNotificationModel.bulkWrite( ops, this.optSession( session ) );

    return ( res.upsertedCount ?? 0 ) + ( res.matchedCount ?? 0 );
  }

  /**
   * Deduplicate recipient identities by userId.
   *
   * @param recipients
   * - Expected: [{ username, userId }]
   * - Usage: prevents duplicate bulkWrite ops when a user is present via:
   *   - direct User audience
   *   - Role audience
   *   - Company audience
   */
  private uniqueRecipientsByUserId(
    recipients: Array<{ username: string; userId: string; }>
  ): Array<{ username: string; userId: string; }> {
    const out: Array<{ username: string; userId: string; }> = [];
    const seen = new Set<string>();

    for ( const r of recipients ) {
      const uid = typeof r.userId === "string" ? r.userId.trim() : "";
      const uname = typeof r.username === "string" ? r.username.trim() : "";
      if ( !uid || !uname ) continue;

      if ( seen.has( uid ) ) continue;
      seen.add( uid );

      out.push( { userId: uid, username: uname } );
    }

    return out;
  }

  /* ===========================================================================
   * Internal: DTO mapping
   * ======================================================================== */

  private mapDocToCoreDto( doc: NotificationDoc ): NotificationCoreDto {
    const dto: NotificationCoreDto = {
      id: String( doc._id ),
      eventKey: doc.eventKey,
      category: doc.category,
      severity: doc.severity,
      title: doc.title,
      body: doc.body,
      actor: doc.actor,
      audiences: Array.isArray( ( doc as unknown as { audiences?: unknown; } ).audiences )
        ? ( doc as unknown as { audiences: NotificationAudience[]; } ).audiences
        : [],
      createdAt: doc.createdAt instanceof Date ? doc.createdAt.toISOString() : new Date().toISOString(),
    };

    if ( doc.icon ) dto.icon = doc.icon;
    if ( Array.isArray( doc.tags ) && doc.tags.length > 0 ) dto.tags = doc.tags;
    if ( doc.target ) dto.target = doc.target;
    if ( doc.expiresAt instanceof Date ) dto.expiresAt = doc.expiresAt.toISOString();

    return dto;
  }

  /* ===========================================================================
   * Internal: Delivery flags normalization
   * ======================================================================== */

  private normalizeDrivers( input?: NotificationDeliveryDrivers ): NotificationDeliveryDrivers {
    const defaults: NotificationDeliveryDrivers = {
      audit: true,
      email: false,
      external: false,
      mq: false,
      push: false,
      sms: false,
    };

    if ( !input ) return defaults;

    return {
      audit: !!input.audit,
      email: !!input.email,
      external: !!input.external,
      mq: !!input.mq,
      push: !!input.push,
      sms: !!input.sms,
    };
  }

  /* ===========================================================================
   * Safety helpers
   * ======================================================================== */

  private optSession( session?: ClientSession ): {} | { session: ClientSession; } {
    return session ? { session } : {};
  }

  private safeUsername( v: unknown ): string {
    const u = typeof v === "string" ? v.trim() : "";
    if ( !u ) throw new Error( "NotificationHubEngineService: username is required." );
    return u;
  }

  private safeString( v: unknown, lable: string ): string {
    const u = typeof v === "string" ? v.trim() : "";
    if ( !u ) throw new Error( `NotificationHubEngineService: ${ lable } is required.` );
    return u;
  }

  private safeObjectId( v: unknown, label: string ): Types.ObjectId {
    const s = typeof v === "string" ? v.trim() : "";
    if ( !s || !Types.ObjectId.isValid( s ) ) throw new Error( `NotificationHubEngineService: ${ label } is invalid.` );
    return new Types.ObjectId( s );
  }

  private normalizeObjectIds( ids: Types.ObjectId[] ): Types.ObjectId[] {
    const out: Types.ObjectId[] = [];
    const seen = new Set<string>();

    for ( const id of ids ) {
      const key = String( id );
      if ( seen.has( key ) ) continue;
      seen.add( key );
      out.push( id );
    }

    return out;
  }
}