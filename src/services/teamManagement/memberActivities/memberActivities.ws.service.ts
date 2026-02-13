// Path: src/services/teamManagement/memberActivities/memberActivities.ws.service.ts
// ============================================================================
// MemberActivities WebSocket Service (Emitter / Gateway Helper) — 100% CLASS-BASED
// ----------------------------------------------------------------------------
// ✅ PURPOSE
// - Thin, DTO-first emitter for MemberActivity domain events.
// - Centralizes WS emits so controllers/services never hard-code event names.
// - MUST NOT hard-depend on SocketConnectionHandler singleton at construction.
//   (Your rule: avoid flow-breaking singleton dependencies)
// ----------------------------------------------------------------------------
// ✅ DESIGN
// - This service does NOT create/own SocketConnectionHandler.
// - It emits only if a handler is available via lazy provider.
// - If handler is not ready: no throw (REST must continue).
// ----------------------------------------------------------------------------
// ✅ ROOM STRATEGY (aligned with your platform)
// - aud.team.<teamCode>          -> team-wide activity stream (captain dashboards)
// - aud.member.<userId>          -> member personal timeline
// - workItem.<workItemId>        -> work item detail watchers
// - memberActivity.<activityId>  -> optional per-activity room (future)
// ============================================================================

import { Types } from "mongoose";

import type { MemberActivityDto } from "../../../types/teamManagement/memberActivities/memberActivities.types";

import {
  MemberActivityWsEvents,
  type MemberActivityServerEvent,
} from "../../../socket/events/teamManagement/memberActivities/memberActivities.ws.events";

import type { AuthUser } from "../../../types/common";
import { SocketConnectionHandler } from "../../../socket/socket-connection.handler";

// ----------------------------------------------------------------------------
// Context + payload contracts (DTO-first)
// ----------------------------------------------------------------------------

export interface MemberActivityWsContext {
  actor: AuthUser;
  requestId: string;

  // routing hints
  teamCode?: string;
  workItemId?: string;
  memberUserIds?: string[]; // usually: [activity.userId]
  activityId?: string;
}

export interface MemberActivityWsErrorPayload {
  requestId: string;
  message: string;
  code?: string;
  details?: unknown;
}

export interface MemberActivityWsReadyPayload {
  requestId: string;
  serverTime: string;
}

export interface MemberActivityWsChangedPayload<T> {
  requestId: string;
  actor: AuthUser;
  data: T;
}

export interface MemberActivityWsBulkChangedPayload<T> {
  requestId: string;
  actor: AuthUser;
  items: T[];
  other: { total: number };
}

export interface MemberActivityWsCountsChangedPayload {
  requestId: string;
  teamCode?: string;
  counts: Record<string, number>;
}

export interface MemberActivityWsEvidenceChangedPayload {
  requestId: string;
  actor: AuthUser;
  activityId: string;
  data: MemberActivityDto;
}

export interface MemberActivityWsBlockerChangedPayload {
  requestId: string;
  actor: AuthUser;
  activityId: string;
  data: MemberActivityDto;
}

// ----------------------------------------------------------------------------
// Lazy Handler Provider (no hard singleton dependency at constructor time)
// ----------------------------------------------------------------------------

export class MemberActivitiesWsService {
  // Singleton instance is OK if it does NOT crash due to handler boot order.
  private static _instance: MemberActivitiesWsService | null = null;

  public static GetInstance(): MemberActivitiesWsService {
    if (!MemberActivitiesWsService._instance) {
      MemberActivitiesWsService._instance = new MemberActivitiesWsService();
    }
    return MemberActivitiesWsService._instance;
  }

  private constructor() {}

  // =========================================================================
  // Handler acquisition (lazy, safe)
  // =========================================================================

  private tryGetHandler(): SocketConnectionHandler | null {
    try {
      // IMPORTANT:
      // Your Socket bootstrap must correctly set the singleton instance.
      // If it's not ready, we return null (REST should NOT fail).
      return SocketConnectionHandler.GetInstance();
    } catch {
      return null;
    }
  }

  // =========================================================================
  // Room helpers
  // =========================================================================

  private buildTeamRoom(teamCode: string): string {
    return `aud.team.${teamCode}`;
  }

  private buildMemberRoom(userId: string): string {
    return `aud.member.${userId}`;
  }

  private buildWorkItemRoom(workItemId: string): string {
    return `workItem.${workItemId}`;
  }

  private buildActivityRoom(activityId: string): string {
    return `memberActivity.${activityId}`;
  }

  private safeStringId(id: Types.ObjectId | string): string {
    return typeof id === "string" ? id : id.toString();
  }

  // =========================================================================
  // Emit primitives (never throw)
  // =========================================================================

  private emitToRoom(room: string, event: MemberActivityServerEvent, payload: unknown): void {
    const handler = this.tryGetHandler();
    if (!handler) return;

    handler.emitToRoom(room, event, payload);
  }

  private emitToRooms(rooms: string[], event: MemberActivityServerEvent, payload: unknown): void {
    const handler = this.tryGetHandler();
    if (!handler) return;

    for (const room of rooms) {
      handler.emitToRoom(room, event, payload);
    }
  }

  private buildRooms(ctx: MemberActivityWsContext): string[] {
    const rooms: string[] = [];

    if (ctx.teamCode) rooms.push(this.buildTeamRoom(ctx.teamCode));
    if (ctx.workItemId) rooms.push(this.buildWorkItemRoom(ctx.workItemId));
    if (ctx.activityId) rooms.push(this.buildActivityRoom(ctx.activityId));

    if (ctx.memberUserIds && ctx.memberUserIds.length > 0) {
      for (const uid of ctx.memberUserIds) rooms.push(this.buildMemberRoom(uid));
    }

    // de-dupe
    return Array.from(new Set(rooms));
  }

  // =========================================================================
  // Ready / Error
  // =========================================================================

  public emitReady(ctx: MemberActivityWsContext): void {
    const rooms = this.buildRooms(ctx);
    if (rooms.length === 0) return;

    const payload: MemberActivityWsReadyPayload = {
      requestId: ctx.requestId,
      serverTime: new Date().toISOString(),
    };

    this.emitToRooms(rooms, MemberActivityWsEvents.Ready, payload);
  }

  public emitError(ctx: MemberActivityWsContext, message: string, code?: string, details?: unknown): void {
    const rooms = this.buildRooms(ctx);
    if (rooms.length === 0) {
      // eslint-disable-next-line no-console
      console.warn(`[Warning:] [MemberActivitiesWsService] emitError called without routing info.\n`);
      return;
    }

    const payload: MemberActivityWsErrorPayload = {
      requestId: ctx.requestId,
      message,
      ...(code ? { code } : {}),
      ...(details ? { details } : {}),
    };

    this.emitToRooms(rooms, MemberActivityWsEvents.Error, payload);
  }

  // =========================================================================
  // CRUD emits
  // =========================================================================

  public emitActivityCreated(ctx: MemberActivityWsContext, dto: MemberActivityDto): void {
    const payload: MemberActivityWsChangedPayload<MemberActivityDto> = {
      requestId: ctx.requestId,
      actor: ctx.actor,
      data: dto,
    };

    const rooms = this.buildRooms({
      ...ctx,
      activityId: ctx.activityId ?? this.safeStringId((dto as unknown as { _id?: Types.ObjectId | string })._id ?? ""),
    });

    this.emitToRooms(rooms, MemberActivityWsEvents.Created, payload);
    this.emitReloadHint(rooms, ctx);
    this.emitCountsChangedSignal(rooms, ctx);
  }

  public emitActivityUpdated(ctx: MemberActivityWsContext, dto: MemberActivityDto): void {
    const payload: MemberActivityWsChangedPayload<MemberActivityDto> = {
      requestId: ctx.requestId,
      actor: ctx.actor,
      data: dto,
    };

    const rooms = this.buildRooms(ctx);
    this.emitToRooms(rooms, MemberActivityWsEvents.Updated, payload);
    this.emitReloadHint(rooms, ctx);
    this.emitCountsChangedSignal(rooms, ctx);
  }

  public emitActivityDeleted(ctx: MemberActivityWsContext, activityId: Types.ObjectId | string): void {
    const id = this.safeStringId(activityId);

    const payload: MemberActivityWsChangedPayload<{ activityId: string }> = {
      requestId: ctx.requestId,
      actor: ctx.actor,
      data: { activityId: id },
    };

    const rooms = this.buildRooms({ ...ctx, activityId: id });
    this.emitToRooms(rooms, MemberActivityWsEvents.Deleted, payload);
    this.emitReloadHint(rooms, ctx);
    this.emitCountsChangedSignal(rooms, ctx);
  }

  public emitBulkChanged(ctx: MemberActivityWsContext, items: MemberActivityDto[], total: number): void {
    const rooms = this.buildRooms(ctx);
    if (rooms.length === 0) return;

    const payload: MemberActivityWsBulkChangedPayload<MemberActivityDto> = {
      requestId: ctx.requestId,
      actor: ctx.actor,
      items,
      other: { total },
    };

    this.emitToRooms(rooms, MemberActivityWsEvents.BulkChanged, payload);
    this.emitCountsChangedSignal(rooms, ctx);
  }

  // =========================================================================
  // Evidence emits
  // =========================================================================

  public emitEvidenceAppended(ctx: MemberActivityWsContext, activityId: Types.ObjectId | string, dto: MemberActivityDto): void {
    const id = this.safeStringId(activityId);

    const payload: MemberActivityWsEvidenceChangedPayload = {
      requestId: ctx.requestId,
      actor: ctx.actor,
      activityId: id,
      data: dto,
    };

    const rooms = this.buildRooms({ ...ctx, activityId: id });
    this.emitToRooms(rooms, MemberActivityWsEvents.EvidenceAppended, payload);
    this.emitReloadHint(rooms, ctx);
  }

  public emitEvidenceRemoved(ctx: MemberActivityWsContext, activityId: Types.ObjectId | string, dto: MemberActivityDto): void {
    const id = this.safeStringId(activityId);

    const payload: MemberActivityWsEvidenceChangedPayload = {
      requestId: ctx.requestId,
      actor: ctx.actor,
      activityId: id,
      data: dto,
    };

    const rooms = this.buildRooms({ ...ctx, activityId: id });
    this.emitToRooms(rooms, MemberActivityWsEvents.EvidenceRemoved, payload);
    this.emitReloadHint(rooms, ctx);
  }

  public emitEvidenceReplaced(ctx: MemberActivityWsContext, activityId: Types.ObjectId | string, dto: MemberActivityDto): void {
    const id = this.safeStringId(activityId);

    const payload: MemberActivityWsEvidenceChangedPayload = {
      requestId: ctx.requestId,
      actor: ctx.actor,
      activityId: id,
      data: dto,
    };

    const rooms = this.buildRooms({ ...ctx, activityId: id });
    this.emitToRooms(rooms, MemberActivityWsEvents.EvidenceReplaced, payload);
    this.emitReloadHint(rooms, ctx);
  }

  // =========================================================================
  // Blocker emits
  // =========================================================================

  public emitBlockerAppended(ctx: MemberActivityWsContext, activityId: Types.ObjectId | string, dto: MemberActivityDto): void {
    const id = this.safeStringId(activityId);

    const payload: MemberActivityWsBlockerChangedPayload = {
      requestId: ctx.requestId,
      actor: ctx.actor,
      activityId: id,
      data: dto,
    };

    const rooms = this.buildRooms({ ...ctx, activityId: id });
    this.emitToRooms(rooms, MemberActivityWsEvents.BlockerAppended, payload);
    this.emitReloadHint(rooms, ctx);
  }

  public emitBlockerUpdated(ctx: MemberActivityWsContext, activityId: Types.ObjectId | string, dto: MemberActivityDto): void {
    const id = this.safeStringId(activityId);

    const payload: MemberActivityWsBlockerChangedPayload = {
      requestId: ctx.requestId,
      actor: ctx.actor,
      activityId: id,
      data: dto,
    };

    const rooms = this.buildRooms({ ...ctx, activityId: id });
    this.emitToRooms(rooms, MemberActivityWsEvents.BlockerUpdated, payload);
    this.emitReloadHint(rooms, ctx);
  }

  public emitBlockerResolved(ctx: MemberActivityWsContext, activityId: Types.ObjectId | string, dto: MemberActivityDto): void {
    const id = this.safeStringId(activityId);

    const payload: MemberActivityWsBlockerChangedPayload = {
      requestId: ctx.requestId,
      actor: ctx.actor,
      activityId: id,
      data: dto,
    };

    const rooms = this.buildRooms({ ...ctx, activityId: id });
    this.emitToRooms(rooms, MemberActivityWsEvents.BlockerResolved, payload);
    this.emitReloadHint(rooms, ctx);
  }

  public emitBlockerRemoved(ctx: MemberActivityWsContext, activityId: Types.ObjectId | string, dto: MemberActivityDto): void {
    const id = this.safeStringId(activityId);

    const payload: MemberActivityWsBlockerChangedPayload = {
      requestId: ctx.requestId,
      actor: ctx.actor,
      activityId: id,
      data: dto,
    };

    const rooms = this.buildRooms({ ...ctx, activityId: id });
    this.emitToRooms(rooms, MemberActivityWsEvents.BlockerRemoved, payload);
    this.emitReloadHint(rooms, ctx);
  }

  // =========================================================================
  // UI hint emits
  // =========================================================================

  private emitReloadHint(rooms: string[], ctx: MemberActivityWsContext): void {
    if (rooms.length === 0) return;

    this.emitToRooms(rooms, MemberActivityWsEvents.ReloadHint, {
      requestId: ctx.requestId,
      ...(ctx.teamCode ? { teamCode: ctx.teamCode } : {}),
      ...(ctx.workItemId ? { workItemId: ctx.workItemId } : {}),
      ...(ctx.activityId ? { activityId: ctx.activityId } : {}),
    });
  }

  public emitCountsChanged(ctx: MemberActivityWsContext, counts: Record<string, number>): void {
    const rooms = this.buildRooms(ctx);
    if (rooms.length === 0) return;

    const payload: MemberActivityWsCountsChangedPayload = {
      requestId: ctx.requestId,
      ...(ctx.teamCode ? { teamCode: ctx.teamCode } : {}),
      counts,
    };

    this.emitToRooms(rooms, MemberActivityWsEvents.CountsChanged, payload);
  }

  private emitCountsChangedSignal(rooms: string[], ctx: MemberActivityWsContext): void {
    if (rooms.length === 0) return;

    // Signal-only; FE can refetch counts via REST
    const payload: MemberActivityWsCountsChangedPayload = {
      requestId: ctx.requestId,
      ...(ctx.teamCode ? { teamCode: ctx.teamCode } : {}),
      counts: {},
    };

    this.emitToRooms(rooms, MemberActivityWsEvents.CountsChanged, payload);
  }
}
