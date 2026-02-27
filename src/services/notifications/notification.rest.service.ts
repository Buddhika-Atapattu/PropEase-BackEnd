// Path: src/services/notifications/notification.rest.service.ts
// =============================================================================
// Notification Hub — REST Service (Fix A + userId owner boundary)
// =============================================================================
//
// 01) Introduction / usage
// - Controller-facing façade for Notification Hub.
// - Split:
//    A) Queries  -> NotificationQueryService
//    B) Commands -> NotificationHubEngineService
//
// 02) Important matters
// - Owner boundary is userId (string MongoId) for user_notifications.
// - username + roleKey are still needed for scope tabs (audiences are username/role/company).
// - exactOptionalPropertyTypes-safe: omit optional props (never pass undefined).
//
// 03) Why we make this change
// - Your DB/index and upsert model are keyed by userId.
// - Using username for state reads/writes is weaker and can drift.
// - This service becomes the single point that guarantees userId is always used.
//
// 04) Keep in mind
// - Query layer must expose userId-based methods (see notes below).
// - Hub engine mutations must accept userId boundary (see notes below).
// =============================================================================

import type { ClientSession } from "mongoose";

import type {
  NotificationLoadFilters,
  NotificationLoadRequest,
  NotificationLoadResponse,
  NotificationCountResponse,
  NotificationEmitInput,
  NotificationInboxItemDto,
  NotificationUserStateDto,
} from "../../types/notification/notification.types";

import {
  NOTIFICATION_CATEGORY_VALUES,
  NOTIFICATION_SEVERITY_VALUES,
  NOTIFICATION_AUDIENCE_MODE_VALUES,
} from "../../types/notification/notification.types";

import type { Role } from "../../types/roles";

import { NotificationQueryService } from "./notification.query.service";
import { NotificationHubEngineService, type EmitResult } from "./notification-hub-engine.service";

import type {
  NotificationScope,
  NotificationPriorityScope,
} from "../../socket/events/notifications/notification.rpc.events";
import { UserModel } from "../../models/user.model";
import { MongoIdUtil } from "../../utils/mongo-id.util";

/* =============================================================================
 * A) REST payload shapes (controller -> service)
 * ========================================================================== */

export interface NotificationInboxLoadHttpInput {
  userId: string;
  username: string;
  request: NotificationLoadRequest;
  session?: ClientSession;
}

export interface NotificationInboxCountHttpInput {
  userId: string;
  username: string;
  filters: NotificationLoadFilters;
  session?: ClientSession;
}

export interface NotificationScopeLoadHttpInput {
  userId: string;
  username: string;
  roleKey: Role;
  scope: NotificationScope;
  priorityScope?: NotificationPriorityScope;
  request: NotificationLoadRequest;
  session?: ClientSession;
}

export interface NotificationScopeCountHttpInput {
  userId: string;
  username: string;
  roleKey: Role;
  scope: NotificationScope;
  filters?: NotificationLoadFilters;
  session?: ClientSession;
}

export interface NotificationEmitHttpInput {
  input: NotificationEmitInput;
  session?: ClientSession;
}

export interface NotificationMarkReadHttpInput {
  userId: string;
  username: string;
  inboxId: string;
  session?: ClientSession;
}

export interface NotificationMarkAllReadHttpInput {
  userId: string;
  username: string;
  session?: ClientSession;
}

export interface NotificationArchiveOneHttpInput {
  userId: string;
  username: string;
  inboxId: string;
  session?: ClientSession;
}

/* =============================================================================
 * B) REST Service (class-based façade)
 * ========================================================================== */

export class NotificationRestService {
  private readonly query: NotificationQueryService;
  private readonly hub: NotificationHubEngineService;
  private static readonly HARD_MAX_LIMIT: number = 500;

  public constructor () {
    this.query = new NotificationQueryService();
    this.hub = new NotificationHubEngineService();
  }

  /* =======================================================================
   * 1) Query operations (read-only)
   * ===================================================================== */

  /**
   * Load inbox list for the current user (default view).
   *
   * @param input.userId
   * - Expected: authenticated user's MongoId string
   * - Usage: owner boundary for user_notifications
   *
   * @param input.username
   * - Expected: authenticated username (kept for DTO + potential legacy filters)
   *
   * @param input.request
   * - Expected: NotificationLoadRequest (page/limit/filters)
   *
   * @param input.session
   * - Optional: mongoose ClientSession
   */
  public async loadInbox( input: NotificationInboxLoadHttpInput ): Promise<NotificationLoadResponse> {
    const userId = this.safeUserId( input?.userId );
    const username = this.safeUsername( input?.username );

    const req = this.safeLoadRequest( {
      username, // tolerated; query will not trust it as boundary
      page: input?.request?.page ?? 1,
      limit: input?.request?.limit ?? 0,
      filters: input?.request?.filters ?? {},
    } );

    const data: NotificationLoadResponse = await this.query.loadInboxForUser( userId, req, input?.session );
    console.log( data, '\n\n' );
    // ✅ MUST be userId-based in query layer
    return data;
  }

  /**
   * Count inbox totals for current user (total + unread).
   *
   * @param input.userId
   * - Expected: authenticated user's MongoId string (owner boundary)
   *
   * @param input.filters
   * - Expected: NotificationLoadFilters
   *
   * @param input.session
   * - Optional: mongoose ClientSession
   */
  public async countInbox( input: NotificationInboxCountHttpInput ): Promise<NotificationCountResponse> {
    const userId = this.safeUserId( input?.userId );
    const filters = this.safeFilters( input?.filters );
    const username = this.safeUsername( input?.username );

    // ✅ MUST be userId-based in query layer
    return this.query.countInboxForUser( userId, username, filters, input?.session );
  }

  /**
   * Load inbox by scope (user / role / company) and priorityScope.
   *
   * @param input.userId
   * - Expected: authenticated user's MongoId string (owner boundary)
   *
   * @param input.username
   * - Expected: authenticated username (needed for "User" audience scope filter)
   *
   * @param input.roleKey
   * - Expected: Role union (needed for "Role" audience scope filter)
   */
  public async loadInboxByScope( input: NotificationScopeLoadHttpInput ): Promise<{
    items: NotificationInboxItemDto[];
    other: { total: number; unread: number; prioritized: number; unprioritized: number; };
  }> {
    const userId = this.safeUserId( input?.userId );
    const username = this.safeUsername( input?.username );
    const roleKey = this.safeRole( input?.roleKey );

    const scope = this.safeScope( input?.scope );
    const priorityScope = this.safePriorityScope( input?.priorityScope );

    const req: NotificationLoadRequest = this.safeLoadRequest( {
      username, // tolerated for request shape, but boundary is userId
      page: input?.request?.page ?? 1,
      limit: input?.request?.limit ?? 0,
      filters: input?.request?.filters ?? {},
    } );

    // ✅ MUST be userId-based in query layer
    return this.query.loadInboxForUserByScope(
      userId,
      username,
      roleKey,
      scope ?? "company",
      priorityScope ?? "all",
      req,
      input?.session
    );
  }

  /**
   * Count scope totals (total/unread/prioritized/unprioritized).
   */
  public async countScopes( input: NotificationScopeCountHttpInput ): Promise<{
    total: number;
    unread: number;
    prioritized: number;
    unprioritized: number;
  }> {
    const userId = this.safeUserId( input?.userId );
    const username = this.safeUsername( input?.username );
    const roleKey = this.safeRole( input?.roleKey );
    const filters = this.safeFilters( input?.filters );
    const scope = this.safeScope( input?.scope ) ?? "company";

    // ✅ MUST be userId-based in query layer
    return this.query.countInboxForUserByScope( userId, username, roleKey, scope, filters, input?.session );
  }

  /* =======================================================================
   * 2) Command operations (mutations via hub engine)
   * ===================================================================== */

  /**
   * Emit a notification (create master doc + inbox rows + WS push + drivers).
   *
   * @param input.input
   * - Expected: NotificationEmitInput
   *
   * @param input.session
   * - Optional mongoose session
   */
  public async emit( input: NotificationEmitHttpInput ): Promise<EmitResult> {
    if ( !input || !input.input ) {
      throw new Error( "NotificationRestService.emit: input is required." );
    }

    return this.hub.emit( input.input, input.session );
  }

  /**
   * Mark ONE inbox row read.
   *
   * @param input.userId
   * - Expected: authenticated user's MongoId string (owner boundary)
   *
   * @param input.username
   * - Expected: authenticated username (kept for optional safety double-check)
   *
   * @param input.inboxId
   * - Expected: inbox row id (string)
   */
  public async markRead( input: NotificationMarkReadHttpInput ): Promise<{ changed: boolean; }> {
    const userId = this.safeUserId( input?.userId );
    const username = this.safeUsername( input?.username );
    const inboxId = this.safeId( input?.inboxId, "inboxId" );

    // ✅ MUST be userId-based in hub engine
    const changed = await this.hub.markRead( userId, username, inboxId, input?.session );
    return { changed };
  }

  /**
   * Mark ALL inbox rows read.
   */
  public async markAllRead( input: NotificationMarkAllReadHttpInput ): Promise<{ changedCount: number; }> {
    const userId = this.safeUserId( input?.userId );
    const username = this.safeUsername( input?.username );

    // ✅ MUST be userId-based in hub engine
    const changedCount = await this.hub.markAllRead( userId, username, input?.session );
    return { changedCount };
  }

  /**
   * Archive ONE inbox row.
   */
  public async archiveOne( input: NotificationArchiveOneHttpInput ): Promise<{ changed: boolean; }> {
    const userId = this.safeUserId( input?.userId );
    const username = this.safeUsername( input?.username );
    const inboxId = this.safeId( input?.inboxId, "inboxId" );

    // ✅ MUST be userId-based in hub engine
    const changed = await this.hub.archiveOne( userId, username, inboxId, input?.session );
    return { changed };
  }


  public async findUserIdByUsernameOrThrow(
    username: string,
    session?: ClientSession
  ): Promise<string> {
    const uname = typeof username === "string" ? username.trim() : "";
    if ( !uname ) {
      throw new Error( "Invalid username." );
    }

    const doc = await UserModel.findOne(
      { username: uname },
      { _id: 1 },
      session ? { session } : undefined
    )
      .lean()
      .exec();

    if ( !doc?._id ) {
      throw new Error( `User not found: ${ uname }` );
    }

    return MongoIdUtil.toIdString( doc._id );
  }


  /* =============================================================================
   * C) Sanitizers (exactOptionalPropertyTypes-safe)
   * ========================================================================== */

  private safeUserId( v: unknown ): string {
    const s = typeof v === "string" ? v.trim() : "";
    if ( !s ) throw new Error( "NotificationRestService: userId is required." );
    return s;
  }

  private safeUsername( v: unknown ): string {
    const u = typeof v === "string" ? v.trim() : "";
    if ( !u ) throw new Error( "NotificationRestService: username is required." );
    return u;
  }

  private safeRole( v: unknown ): Role {
    const s = typeof v === "string" ? v.trim() : "";
    if ( !s ) throw new Error( "NotificationRestService: role is required." );
    return s as Role;
  }

  private safeId( v: unknown, label: string ): string {
    const s = typeof v === "string" ? v.trim() : "";
    if ( !s ) throw new Error( `NotificationRestService: ${ label } is required.` );
    return s;
  }

  private safeScope( v: unknown ): NotificationScope {
    if ( v === "user" || v === "role" || v === "company" ) return v;
    throw new Error( "NotificationRestService: invalid scope." );
  }

  private safePriorityScope( v: unknown ): NotificationPriorityScope {
    if ( v === "prioritized" || v === "unprioritized" || v === "all" ) return v;
    return "all";
  }

  private safeLoadRequest( input: {
    username: string;
    page: unknown;
    limit: unknown;
    filters: unknown;
  } ): NotificationLoadRequest {
    const username = this.safeUsername( input.username );
    const page = this.safePage( input.page );
    const limit = this.safeLimit( input.limit );
    const filters = this.safeFilters( input.filters );

    return { username, filters, page, limit };
  }

  private safeFilters( filters: unknown ): NotificationLoadFilters {
    const raw = filters && typeof filters === "object" ? ( filters as Record<string, unknown> ) : {};
    const out: NotificationLoadFilters = {};

    if ( this.isNonEmptyString( raw[ "category" ] ) ) {
      const cat = this.asEnumLiteral( raw[ "category" ], NOTIFICATION_CATEGORY_VALUES );
      if ( cat ) out.category = cat;
    }

    if ( this.isNonEmptyString( raw[ "severity" ] ) ) {
      const sev = this.asEnumLiteral( raw[ "severity" ], NOTIFICATION_SEVERITY_VALUES );
      if ( sev ) out.severity = sev;
    }

    if ( this.isNonEmptyString( raw[ "mode" ] ) ) {
      const mode = this.asEnumLiteral( raw[ "mode" ], NOTIFICATION_AUDIENCE_MODE_VALUES );
      if ( mode ) out.mode = mode;
    }

    if ( this.isNonEmptyString( raw[ "search" ] ) ) out.search = raw[ "search" ].trim();
    if ( this.isNonEmptyString( raw[ "from" ] ) ) out.from = raw[ "from" ].trim();
    if ( this.isNonEmptyString( raw[ "to" ] ) ) out.to = raw[ "to" ].trim();

    if ( typeof raw[ "unreadOnly" ] === "boolean" ) out.unreadOnly = raw[ "unreadOnly" ];
    if ( typeof raw[ "includeDeleted" ] === "boolean" ) out.includeDeleted = raw[ "includeDeleted" ];
    if ( typeof raw[ "includeArchived" ] === "boolean" ) out.includeArchived = raw[ "includeArchived" ];

    return out;
  }

  private safePage( v: unknown ): number {
    const n = Number( v );
    if ( !Number.isFinite( n ) || n < 1 ) return 1;
    return Math.floor( n );
  }

  private safeLimit( limit: unknown ): number {
    const n = typeof limit === 'number' ? limit : 0;
    // const n = Number(limit);

    // ✅ "load all" contract:
    // - limit = 0 or -1 means "load all", but we still protect with HARD_MAX_LIMIT.
    if ( Number.isFinite( n ) && ( n === 0 || n === -1 ) ) {
      return NotificationRestService.HARD_MAX_LIMIT;
    }

    // normal paging behavior
    if ( !Number.isFinite( n ) || n < 1 ) return 100;

    // keep your existing safety ceiling, but align with hard max
    return Math.min( Math.floor( n ), NotificationRestService.HARD_MAX_LIMIT );
  }

  private asEnumLiteral<T extends string>( value: string, allowed: readonly T[] ): T | null {
    const v = value.trim() as T;
    return allowed.includes( v ) ? v : null;
  }

  private isNonEmptyString( v: unknown ): v is string {
    return typeof v === "string" && v.trim().length > 0;
  }
}