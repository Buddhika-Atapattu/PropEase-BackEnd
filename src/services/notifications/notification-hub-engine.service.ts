// Path: src/services/notifications/notification-hub-engine.service.ts
// =============================================================================
// Notification Hub — Engine Service
// =============================================================================
//
// 01) Purpose of this code
// -----------------------------------------------------------------------------
// - Core engine that creates notifications and delivers them to recipients.
// - Saves master notification document (notifications collection).
// - Creates/updates per-user inbox rows (user_notifications collection).
// - Emits WebSocket events to notify UI instantly.
// - Triggers delivery drivers (audit/email/sms/push/mq/external) as best-effort.
//
// 02) What this code is managing
// -----------------------------------------------------------------------------
// - emit(): end-to-end flow (build core → persist → resolve recipients → inbox upsert → WS → delivery)
// - inbox mutations: markRead / markAllRead / archiveOne
//
// 03) Key things this code highlights
// -----------------------------------------------------------------------------
// - exactOptionalPropertyTypes safety:
//    - never pass `{ session: undefined }`
//    - never call `.session(null)`
// - model correctness: createdAt/expiresAt are Date in DB model
// - stable recipient resolution: supports audiences[] and dedupes usernames
// - inbox consistency: user_notifications rows store username + userId
//
// 04) Need to keep in mind
// -----------------------------------------------------------------------------
// - NotificationResolversBootstrap.init() must run at startup.
// - Resolver registry must return usernames (strings).
// - Inbox filtering uses username in multiple places → keep consistent.
// - If UserNotification schema requires userId, hub MUST provide it.
// =============================================================================

import { Types, type ClientSession } from "mongoose";

import type {
  NotificationAudience,
  NotificationCoreDto,
  NotificationEmitInput,
  NotificationDeliveryDrivers,
} from "../../types/notification/notification.types";

import { NotificationModel, type NotificationDoc } from "../../models/notifications/notification.model";
import { UserNotificationModel } from "../../models/notifications/user-notification.model";
import { UserModel, type User } from "../../models/user.model";

import { NotificationInnerSetterService, type BuiltNotificationCore } from "./notification-inner-setter.service";
import { NotificationRecipientResolverRegistry } from "./notification-recipient-resolver.registry.service";

import { NotificationSocketService } from "./notification.socket.service";
import { NotificationDeliveryService } from "./delivery/notification-delivery.service";
import type { NotificationDeliveryRequest } from "./delivery/notification-delivery.types";



/* =============================================================================
 * A) Engine outputs / contracts
 * ========================================================================== */
export interface RecipientResolution {
  usernames: string[];
}

type UserModelKeyFields = keyof User;
export interface EmitResult {
  notificationId: string;
  deliveredTo: number;
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
  private readonly ws: NotificationSocketService;

  /* ===========================================================================
   * Constructor
   * ===========================================================================
   * 01) Introduction / usage
   * - Creates the Notification Hub engine with required internal services.
   * - No external parameters (your project rule).
   *
   * 02) Important matters
   * - Must remain dependency-light: hub should not hard-wire app boot order.
   * - Must not require session or runtime state in constructor.
   *
   * 03) Why we make this constructor
   * - To keep engine initialization consistent and deterministic.
   *
   * 04) Parameters
   * - None (intentionally)
   *
   * 05) Usage hint
   * - `const hub = new NotificationHubEngineService();`
   *
   * 06) Keep in mind
   * - Resolver bootstrap + delivery bootstrap must run at startup elsewhere.
   * ======================================================================== */
  public constructor () {
    this.innerSetter = new NotificationInnerSetterService();
    this.delivery = new NotificationDeliveryService();
    this.ws = new NotificationSocketService();
  }

  /* ===========================================================================
   * Method: emit()
   * ===========================================================================
   * 01) Introduction / usage
   * - Main entry point to create a notification and distribute it.
   *
   * 02) Important matters
   * - audiences MUST be an array (enforced by innerSetter).
   * - Resolvers return usernames only; hub maps usernames → userId for inbox.
   * - Must be transaction-safe when session is provided (do not pass undefined).
   * - Delivery is best-effort; do not fail business transaction due to driver.
   *
   * 03) Why we make this method
   * - To centralize notification behavior across all modules.
   * - To enforce consistency across persistence, inbox, WS, and delivery.
   *
   * 04) Parameters
   * - input: NotificationEmitInput
   *   - eventKey: the domain event id
   *   - audiences[]: array of audience rules (Company/Role/Team/User)
   *   - actor: who triggered the event
   *   - optional: target/tags/icon/severity/category/vars/delivery flags
   * - session?: ClientSession
   *   - Optional mongoose transaction session.
   *
   * 05) Usage hint
   * - `await hub.emit({ eventKey, audiences: [...], actor, ... }, session?)`
   *
   * 06) Keep in mind
   * - If no recipients resolve, hub still creates master notification record.
   * - User lookup may return fewer identities than usernames if users missing.
   * ========================================================================= */
  public async emit( input: NotificationEmitInput, session?: ClientSession ): Promise<EmitResult> {
    // Step 1: Normalize input into internal core (policy + validation)
    const built: BuiltNotificationCore = this.innerSetter.buildCore( input );

    // Step 2: Persist master notification
    const notifDoc = await this.createNotificationDoc( built, session );

    // Step 3: Resolve usernames across all audiences (deduped)
    const ctx = this.buildRecipientResolveContext( session );
    const usernames = await this.resolveUsernamesAcrossAudiences( built.audiences, ctx );

    if ( usernames.length === 0 ) {
      // eslint-disable-next-line no-console
      console.log( "[Info:] NotificationHubEngineService.emit: no recipients resolved.\n" );
      return { notificationId: String( notifDoc._id ), deliveredTo: 0 };
    }

    // Step 4: Map usernames → {username, userId} using UserModel
    const identities = await this.loadRecipientIdentities( usernames, session );

    if ( identities.length === 0 ) {
      // eslint-disable-next-line no-console
      console.log( "[Warning:] NotificationHubEngineService.emit: recipients resolved but no identities found.\n" );
      return { notificationId: String( notifDoc._id ), deliveredTo: 0 };
    }

    // Step 5: Upsert per-user inbox rows (bulk)
    const deliveredTo = await this.ensureUserInboxRows( identities, notifDoc._id, session );

    // Step 6: Create canonical DTO from persisted doc (single source of truth)
    const coreDto = this.mapDocToCoreDto( notifDoc );

    // Step 7: Emit WS per recipient (username-based routing)
    for ( const r of identities ) {
      this.ws.emitNewToUser( r.username, { item: { notification: coreDto } } );
    }

    // Step 8: Best-effort delivery (policy flags)
    const drivers = this.normalizeDrivers( input.delivery );

    const deliveryReq: NotificationDeliveryRequest = {
      notificationId: String( notifDoc._id ),
      notification: coreDto,
      recipients: identities.map( ( r ) => ( { username: r.username, userId: r.userId } ) ),
      drivers,
    };

    await this.delivery.deliver( deliveryReq );

    return { notificationId: String( notifDoc._id ), deliveredTo };
  }

  /**
     * Fetch a single field (keyof User) as string[] for given user ObjectIds.
     *
     * Why this method exists
     * - Multiple parent flows already know (a) which users and (b) which field is required.
     * - We only want a projection read (least privilege) and return a simple array.
     *
     * @param membersIDs
     * - Expected: Types.ObjectId[]
     * - Usage: list of user _id values (duplicates allowed; will be deduped)
     *
     * @param key
     * - Expected: keyof User
     * - Usage: which user field should be extracted (ex: "email", "username")
     *
     * Keep in mind
     * - Return type is string[] so this is intended for string-like fields.
     * - If the selected field is not a string, it will be ignored (not pushed).
     * - This does NOT guarantee ordering by ids; it returns values found in DB order.
     */
  public async fetchUserFieldAsStringArray(
    membersIDs: Types.ObjectId[],
    key: UserModelKeyFields
  ): Promise<string[]> {
    // 1) Normalize ids (dedupe + stable)
    const normalizedIds = this.normalizeObjectIds( membersIDs );
    if ( normalizedIds.length === 0 ) return [];

    // 2) Projection-only select (Mongo accepts dynamic projection keys)
    const projection: Record<string, 0 | 1> = { [ String( key ) ]: 1 };

    // 3) Query lean + extract string values safely
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

      // Avoid duplicates (common when multiple users share blank/aliases etc.)
      if ( seen.has( val ) ) continue;
      seen.add( val );

      out.push( val );
    }

    return out;
  }

  /* ===========================================================================
   * Method: markRead()
   * ===========================================================================
   * 01) Introduction / usage
   * - Marks a single inbox row as read for the given username owner.
   *
   * 02) Important matters
   * - This mutates ONLY user_notifications (per-user state).
   * - Must enforce ownership via username in the filter.
   * - exactOptionalPropertyTypes-safe session option object.
   *
   * 03) Why we make this method
   * - Master notification doc should remain immutable; per-user state changes here.
   *
   * 04) Parameters
   * - username: string (owner boundary)
   * - inboxId: string (user_notifications._id)
   * - session?: ClientSession
   *
   * 05) Usage hint
   * - `await hub.markRead(auth.username, inboxId, session?)`
   *
   * 06) Keep in mind
   * - Only changes rows where isRead=false and isArchived=false.
   * ========================================================================= */
  public async markRead( username: string, inboxId: string, session?: ClientSession ): Promise<boolean> {
    const u = this.safeUsername( username );
    const id = this.safeObjectId( inboxId, "inboxId" );

    const res = await UserNotificationModel.updateOne(
      { _id: id, username: u, isRead: false, isArchived: false },
      { $set: { isRead: true, readAt: new Date() } },
      this.optSession( session )
    );

    return ( res.modifiedCount ?? 0 ) > 0;
  }

  /* ===========================================================================
   * Method: markAllRead()
   * ===========================================================================
   * 01) Introduction / usage
   * - Marks all unread inbox rows as read for a username owner.
   *
   * 02) Important matters
   * - Ownership boundary enforced by username.
   * - Only affects non-archived, unread rows.
   *
   * 03) Why we make this method
   * - Efficient bulk action for notification UI (one-click mark-all).
   *
   * 04) Parameters
   * - username: string (owner)
   * - session?: ClientSession
   *
   * 05) Usage hint
   * - `const count = await hub.markAllRead(auth.username, session?)`
   *
   * 06) Keep in mind
   * - Returns modifiedCount (rows changed).
   * ========================================================================= */
  public async markAllRead( username: string, session?: ClientSession ): Promise<number> {
    const u = this.safeUsername( username );

    const res = await UserNotificationModel.updateMany(
      { username: u, isRead: false, isArchived: false },
      { $set: { isRead: true, readAt: new Date() } },
      this.optSession( session )
    );

    return res.modifiedCount ?? 0;
  }

  /* ===========================================================================
   * Method: archiveOne()
   * ===========================================================================
   * 01) Introduction / usage
   * - Archives a single inbox row (hide from default views).
   *
   * 02) Important matters
   * - Ownership enforced by username.
   * - Archive is a per-user action; do not modify master notification.
   *
   * 03) Why we make this method
   * - Inbox “declutter” feature: archive without deleting.
   *
   * 04) Parameters
   * - username: string
   * - inboxId: string
   * - session?: ClientSession
   *
   * 05) Usage hint
   * - `await hub.archiveOne(auth.username, inboxId, session?)`
   *
   * 06) Keep in mind
   * - This does not delete anything; it only toggles isArchived.
   * ========================================================================= */
  public async archiveOne( username: string, inboxId: string, session?: ClientSession ): Promise<boolean> {
    const u = this.safeUsername( username );
    const id = this.safeObjectId( inboxId, "inboxId" );

    const res = await UserNotificationModel.updateOne(
      { _id: id, username: u, isArchived: false },
      { $set: { isArchived: true, archivedAt: new Date() } },
      this.optSession( session )
    );

    return ( res.modifiedCount ?? 0 ) > 0;
  }

  // ===========================================================================
  // Internal: Recipient resolution
  // ===========================================================================

  /* ===========================================================================
   * Method: buildRecipientResolveContext()
   * ===========================================================================
   * 01) Introduction / usage
   * - Builds resolver context object with optional session.
   *
   * 02) Important matters
   * - exactOptionalPropertyTypes-safe:
   *   - return {} instead of { session: undefined }
   *
   * 03) Why we make this method
   * - Keep session handling consistent across all resolver calls.
   *
   * 04) Parameters
   * - session?: ClientSession
   *
   * 05) Usage hint
   * - `const ctx = this.buildRecipientResolveContext(session)`
   *
   * 06) Keep in mind
   * - Never pass null session to resolvers.
   * ========================================================================= */
  private buildRecipientResolveContext( session?: ClientSession ): RecipientResolveContext {
    return session ? { session } : {};
  }

  /* ===========================================================================
   * Method: resolveUsernamesAcrossAudiences()
   * ===========================================================================
   * 01) Introduction / usage
   * - Resolves usernames for all audiences and dedupes final list.
   *
   * 02) Important matters
   * - Each audience uses registry resolver → returns { usernames: string[] }.
   * - Hub dedupes to avoid duplicate inbox entries + duplicate WS emits.
   *
   * 03) Why we make this method
   * - Centralized, stable recipient resolution pipeline.
   *
   * 04) Parameters
   * - audiences: NotificationAudience[]
   * - ctx: RecipientResolveContext
   *
   * 05) Usage hint
   * - Called internally by emit().
   *
   * 06) Keep in mind
   * - If resolver returns invalid data, registry sanitizes it.
   * ========================================================================= */
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

  /* ===========================================================================
   * Method: dedupeUsernames()
   * ===========================================================================
   * 01) Introduction / usage
   * - Removes duplicates and trims whitespace.
   *
   * 02) Important matters
   * - Prevents duplicate inbox upserts / WS events / delivery calls.
   *
   * 03) Why we make this method
   * - Notification can have multiple audiences; overlap is expected.
   *
   * 04) Parameters
   * - usernames: string[]
   *
   * 05) Usage hint
   * - internal helper only.
   *
   * 06) Keep in mind
   * - Empty/invalid strings are removed.
   * ========================================================================= */
  private dedupeUsernames( usernames: string[] ): string[] {
    const cleaned = ( Array.isArray( usernames ) ? usernames : [] )
      .map( ( u ) => ( typeof u === "string" ? u.trim() : "" ) )
      .filter( ( u ) => u.length > 0 );

    return Array.from( new Set( cleaned ) );
  }

  // ===========================================================================
  // Internal: User identity mapping
  // ===========================================================================

  /* ===========================================================================
   * Method: loadRecipientIdentities()
   * ===========================================================================
   * 01) Introduction / usage
   * - Converts usernames[] into { username, userId }[] by querying UserModel.
   *
   * 02) Important matters
   * - Hub must provide userId because inbox rows often require it.
   * - Must respect transaction session if provided.
   *
   * 03) Why we make this method
   * - Resolvers are intentionally lightweight: they return usernames only.
   * - Hub centralizes identity mapping for consistency and schema compliance.
   *
   * 04) Parameters
   * - usernames: string[] (deduped, trimmed)
   * - session?: ClientSession
   *
   * 05) Usage hint
   * - Called internally by emit().
   *
   * 06) Keep in mind
   * - Some usernames may not exist → they are dropped safely.
   * - Ordering is preserved based on input list.
   * ========================================================================= */
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

  // ===========================================================================
  // Internal: Persistence
  // ===========================================================================

  /* ===========================================================================
   * Method: createNotificationDoc()
   * ===========================================================================
   * 01) Introduction / usage
   * - Creates the master notification document in notifications collection.
   *
   * 02) Important matters
   * - createdAt must be Date (DB field).
   * - expiresAt must be Date (DB field).
   * - audiences stored as array (canonical rule).
   * - exactOptionalPropertyTypes: omit optional keys when absent.
   *
   * 03) Why we make this method
   * - One central place to construct DB payload and enforce invariants.
   *
   * 04) Parameters
   * - built: BuiltNotificationCore (already normalized & validated)
   * - session?: ClientSession
   *
   * 05) Usage hint
   * - Called internally by emit().
   *
   * 06) Keep in mind
   * - Uses NotificationModel.create([payload], options) for session support.
   * ========================================================================= */
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

  /* ===========================================================================
   * Method: ensureUserInboxRows()
   * ===========================================================================
   * 01) Introduction / usage
   * - Upserts per-user inbox rows into user_notifications collection.
   *
   * 02) Important matters
   * - Uses bulkWrite upsert to avoid N queries.
   * - filter uses { userId, notificationId } to ensure uniqueness.
   * - Sets username on insert to support username-based filtering in UI.
   *
   * 03) Why we make this method
   * - Inbox is per-user state, required for read/archive features.
   *
   * 04) Parameters
   * - recipients: Array<{ username, userId }>
   * - notificationId: Types.ObjectId (master notification _id)
   * - session?: ClientSession
   *
   * 05) Usage hint
   * - Called internally by emit().
   *
   * 06) Keep in mind
   * - deliveredAt is set on insert only (first delivery time).
   * ========================================================================= */
  private async ensureUserInboxRows(
    recipients: Array<{ username: string; userId: string; }>,
    notificationId: Types.ObjectId,
    session?: ClientSession
  ): Promise<number> {
    if ( !Array.isArray( recipients ) || recipients.length === 0 ) return 0;

    const now = new Date();

    const ops = recipients.map( ( r ) => ( {
      updateOne: {
        filter: { userId: r.userId, notificationId },
        update: {
          $setOnInsert: {
            userId: r.userId,
            username: r.username,
            notificationId,

            isRead: false,
            isArchived: false,

            deliveredAt: now,
          },
        },
        upsert: true,
      },
    } ) );

    const res = await UserNotificationModel.bulkWrite( ops, this.optSession( session ) );
    return ( res.upsertedCount ?? 0 ) + ( res.matchedCount ?? 0 );
  }

  // ===========================================================================
  // Internal: DTO mapping
  // ===========================================================================

  /* ===========================================================================
   * Method: mapDocToCoreDto()
   * ===========================================================================
   * 01) Introduction / usage
   * - Converts NotificationDoc (DB truth) into NotificationCoreDto (contract).
   *
   * 02) Important matters
   * - createdAt/expiresAt must output ISO strings (DTO contract).
   * - audiences must be array in DTO (fallback to [] for safety).
   * - exactOptionalPropertyTypes: omit optional props when missing.
   *
   * 03) Why we make this method
   * - Avoid leaking mongoose doc shape to UI/WS/delivery.
   *
   * 04) Parameters
   * - doc: NotificationDoc
   *
   * 05) Usage hint
   * - Called internally by emit().
   *
   * 06) Keep in mind
   * - doc.createdAt should be Date in model; fallback exists for safety only.
   * ========================================================================= */
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
        ? ( ( doc as unknown as { audiences: NotificationAudience[]; } ).audiences )
        : [],
      createdAt: doc.createdAt instanceof Date ? doc.createdAt.toISOString() : new Date().toISOString(),
    };

    if ( doc.icon ) dto.icon = doc.icon;
    if ( Array.isArray( doc.tags ) && doc.tags.length > 0 ) dto.tags = doc.tags;
    if ( doc.target ) dto.target = doc.target;
    if ( doc.expiresAt instanceof Date ) dto.expiresAt = doc.expiresAt.toISOString();

    return dto;
  }

  // ===========================================================================
  // Internal: Delivery flags normalization
  // ===========================================================================

  /* ===========================================================================
   * Method: normalizeDrivers()
   * ===========================================================================
   * 01) Introduction / usage
   * - Normalizes delivery policy flags to a stable default object.
   *
   * 02) Important matters
   * - Avoid undefined optional props issues by returning full object always.
   * - Suggested default: audit=true, others=false unless requested.
   *
   * 03) Why we make this method
   * - Keeps delivery logic consistent across all callers.
   *
   * 04) Parameters
   * - input?: NotificationDeliveryDrivers
   *
   * 05) Usage hint
   * - internal helper called by emit().
   *
   * 06) Keep in mind
   * - If you later add env-driven policy, change defaults here.
   * ========================================================================= */
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

  // ===========================================================================
  // Safety helpers
  // ===========================================================================

  /* ===========================================================================
   * Method: optSession()
   * ===========================================================================
   * 01) Introduction / usage
   * - Returns mongoose options object containing session only when present.
   *
   * 02) Important matters
   * - exactOptionalPropertyTypes-safe: do not return { session: undefined }.
   *
   * 03) Why we make this method
   * - Prevent common bugs: `.session(null)` / `{session: undefined}`.
   *
   * 04) Parameters
   * - session?: ClientSession
   *
   * 05) Usage hint
   * - `Model.create([...], this.optSession(session))`
   *
   * 06) Keep in mind
   * - Always prefer this over inline `{ session }`.
   * ========================================================================= */
  private optSession( session?: ClientSession ): {} | { session: ClientSession; } {
    return session ? { session } : {};
  }

  /* ===========================================================================
   * Method: safeUsername()
   * ===========================================================================
   * 01) Introduction / usage
   * - Validates and normalizes username input.
   *
   * 02) Important matters
   * - Username is used as ownership boundary in inbox operations.
   *
   * 03) Why we make this method
   * - Prevent accidental broad updates due to empty username.
   *
   * 04) Parameters
   * - v: unknown
   *
   * 05) Usage hint
   * - internal helper for markRead/markAllRead/archiveOne.
   *
   * 06) Keep in mind
   * - Throws error if invalid.
   * ========================================================================= */
  private safeUsername( v: unknown ): string {
    const u = typeof v === "string" ? v.trim() : "";
    if ( !u ) throw new Error( "NotificationHubEngineService: username is required." );
    return u;
  }

  /* ===========================================================================
   * Method: safeObjectId()
   * ===========================================================================
   * 01) Introduction / usage
   * - Validates and converts string into Types.ObjectId.
   *
   * 02) Important matters
   * - Prevents invalid IDs causing silent no-op or injection patterns.
   *
   * 03) Why we make this method
   * - Ensure consistent ObjectId parsing & error messaging.
   *
   * 04) Parameters
   * - v: unknown (expected string)
   * - label: string (for error messages)
   *
   * 05) Usage hint
   * - internal helper for inbox operations.
   *
   * 06) Keep in mind
   * - Throws error if invalid.
   * ========================================================================= */
  private safeObjectId( v: unknown, label: string ): Types.ObjectId {
    const s = typeof v === "string" ? v.trim() : "";
    if ( !s || !Types.ObjectId.isValid( s ) ) throw new Error( `NotificationHubEngineService: ${ label } is invalid.` );
    return new Types.ObjectId( s );
  }

  /**
     * Normalize ObjectIds by removing duplicates (stable order).
     */
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