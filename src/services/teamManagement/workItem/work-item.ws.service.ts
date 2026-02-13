// Path: src/services/teamManagement/workItem/work-item.ws.service.ts
// ============================================================================
// WorkItem WebSocket Service (Emitter / Gateway Helper) — 100% CLASS-BASED
// ----------------------------------------------------------------------------
// ✅ PURPOSE
// - Thin, DTO-first emitter for WorkItem domain events.
// - Centralizes all WS emits so controllers/services never hard-code event names.
// - REST remains the source-of-truth; WS emits are best-effort (must never break REST).
// ----------------------------------------------------------------------------
// ✅ CRITICAL FIX (your point)
// - NO constructor dependency on SocketConnectionHandler (avoids boot-order/singleton crashes)
// - Handler is resolved lazily at emit time. If not ready => NO-OP + warning log.
// ----------------------------------------------------------------------------
// ✅ ROOM STRATEGY
// - aud.team.<teamCode>        -> team-wide updates
// - aud.member.<userId>        -> per-member stream
// - workItem.<workItemId>      -> work item detail listeners (use Mongo _id, not code)
// ============================================================================

import { Types } from "mongoose";

import { WorkItemWsEvents } from "../../../socket/events/teamManagement/workItem/work-item.ws.events";
import type { WorkItemServerEvent } from "../../../socket/events/teamManagement/workItem/work-item.ws.events";

import type { AuthUser } from "../../../types/common";
import type { WorkItemDto } from "../../../types/teamManagement/workItem/workItem.types";
import type { MemberActivityDto } from "../../../types/teamManagement/memberActivities/memberActivities.types";

import { SocketConnectionHandler } from "../../../socket/socket-connection.handler";

// ----------------------------------------------------------------------------
// Payload contracts (DTO-first, minimal and stable)
// ----------------------------------------------------------------------------

export interface WorkItemWsContext {
  actor: AuthUser;
  requestId: string;

  teamCode?: string;
  workItemId?: string;

  memberUserIds?: string[];
}

export interface WorkItemWsErrorPayload {
  requestId: string;
  message: string;
  code?: string;
  details?: unknown;
}

export interface WorkItemWsReadyPayload {
  requestId: string;
  serverTime: string;
}

export interface WorkItemWsChangedPayload<T> {
  requestId: string;
  actor: AuthUser;
  data: T;
}

export interface WorkItemWsBulkChangedPayload<T> {
  requestId: string;
  actor: AuthUser;
  items: T[];
  other: { total: number };
}

export interface WorkItemWsCountsChangedPayload {
  requestId: string;
  teamCode?: string;
  counts: Record<string, number>;
}

export interface WorkItemWsActivityAppendedPayload {
  requestId: string;
  actor: AuthUser;
  workItemId: string;
  activity: MemberActivityDto;
}

// ----------------------------------------------------------------------------
// WorkItem WS Service (Emitter) — LAZY handler resolution (no ctor injection)
// ----------------------------------------------------------------------------
export class WorkItemWsService {
  private static _instance: WorkItemWsService | null = null;

  public static GetInstance(): WorkItemWsService {
    if (!WorkItemWsService._instance) {
      WorkItemWsService._instance = new WorkItemWsService();
    }
    return WorkItemWsService._instance;
  }

  private constructor() {}

  // =========================================================================
  // Lazy handler resolution
  // =========================================================================

  private tryGetHandler(): SocketConnectionHandler | null {
    try {
      // Your handler historically throws if singleton isn't initialized.
      // We catch and convert that into a NO-OP WS emit.
      return SocketConnectionHandler.GetInstance();
    } catch {
      return null;
    }
  }

  // =========================================================================
  // Room helpers (class methods only)
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

  private safeStringId(id: Types.ObjectId | string): string {
    return typeof id === "string" ? id : id.toString();
  }

  /**
   * Prefer Mongo _id for room id.
   * Falls back to ctx.workItemId if provided.
   *
   * NOTE:
   * We avoid assuming WorkItemDto shape too hard. Many DTOs expose `_id` or `id`.
   */
  private extractWorkItemIdFromDto(dto: WorkItemDto): string | null {
    const maybe = dto as unknown as { _id?: string; id?: string };
    if (typeof maybe._id === "string" && maybe._id.length > 0) return maybe._id;
    if (typeof maybe.id === "string" && maybe.id.length > 0) return maybe.id;
    return null;
  }

  // =========================================================================
  // Base emit primitives (best-effort)
  // =========================================================================

  private emitToRoom(room: string, event: WorkItemServerEvent, payload: unknown): void {
    const handler = this.tryGetHandler();
    if (!handler) {
      // eslint-disable-next-line no-console
      console.warn(
        `[Warning:] [WorkItemWsService] WS handler not ready. Skip emit (${event}) to room: ${room}\n`
      );
      return;
    }

    handler.emitToRoom(room, event, payload);
  }

  private emitToRooms(rooms: string[], event: WorkItemServerEvent, payload: unknown): void {
    if (rooms.length === 0) return;
    for (const room of rooms) this.emitToRoom(room, event, payload);
  }

  // =========================================================================
  // Ready / Error
  // =========================================================================

  private emitReadyToRoom(room: string, requestId: string): void {
    const payload: WorkItemWsReadyPayload = {
      requestId,
      serverTime: new Date().toISOString(),
    };
    this.emitToRoom(room, WorkItemWsEvents.Ready, payload);
  }

  public emitReady(ctx: WorkItemWsContext): void {
    if (ctx.teamCode) {
      this.emitReadyToRoom(this.buildTeamRoom(ctx.teamCode), ctx.requestId);
    }

    if (ctx.memberUserIds && ctx.memberUserIds.length > 0) {
      const payload: WorkItemWsReadyPayload = {
        requestId: ctx.requestId,
        serverTime: new Date().toISOString(),
      };
      const rooms = ctx.memberUserIds.map((id) => this.buildMemberRoom(id));
      this.emitToRooms(rooms, WorkItemWsEvents.Ready, payload);
    }
  }

  public emitError(ctx: WorkItemWsContext, message: string, code?: string, details?: unknown): void {
    const payload: WorkItemWsErrorPayload = {
      requestId: ctx.requestId,
      message,
      ...(code ? { code } : {}),
      ...(details ? { details } : {}),
    };

    const rooms: string[] = [];

    if (ctx.teamCode) rooms.push(this.buildTeamRoom(ctx.teamCode));
    if (ctx.workItemId) rooms.push(this.buildWorkItemRoom(ctx.workItemId));

    if (ctx.memberUserIds && ctx.memberUserIds.length > 0) {
      for (const uid of ctx.memberUserIds) rooms.push(this.buildMemberRoom(uid));
    }

    if (rooms.length === 0) {
      // eslint-disable-next-line no-console
      console.warn(`[Warning:] [WorkItemWsService] emitError called without routing info.\n`);
      return;
    }

    this.emitToRooms(rooms, WorkItemWsEvents.Error, payload);
  }

  // =========================================================================
  // Domain emits (Created / Updated / Deleted / BulkChanged)
  // =========================================================================

  public emitWorkItemCreated(ctx: WorkItemWsContext, dto: WorkItemDto): void {
    const payload: WorkItemWsChangedPayload<WorkItemDto> = {
      requestId: ctx.requestId,
      actor: ctx.actor,
      data: dto,
    };

    const rooms = this.buildRoomsForWorkItemChange(ctx, dto);
    this.emitToRooms(rooms, WorkItemWsEvents.Created, payload);

    this.emitReloadHint(rooms, ctx);
    this.emitCountsChangedHint(rooms, ctx);
  }

  public emitWorkItemUpdated(ctx: WorkItemWsContext, dto: WorkItemDto): void {
    const payload: WorkItemWsChangedPayload<WorkItemDto> = {
      requestId: ctx.requestId,
      actor: ctx.actor,
      data: dto,
    };

    const rooms = this.buildRoomsForWorkItemChange(ctx, dto);
    this.emitToRooms(rooms, WorkItemWsEvents.Updated, payload);

    this.emitReloadHint(rooms, ctx);
    this.emitCountsChangedHint(rooms, ctx);
  }

  public emitWorkItemDeleted(
    ctx: WorkItemWsContext,
    workItemId: Types.ObjectId | string,
    teamCode: string,
    memberUserIds: Array<Types.ObjectId | string>
  ): void {
    const wid = this.safeStringId(workItemId);

    const payload: WorkItemWsChangedPayload<{ workItemId: string }> = {
      requestId: ctx.requestId,
      actor: ctx.actor,
      data: { workItemId: wid },
    };

    const rooms: string[] = [this.buildTeamRoom(teamCode), this.buildWorkItemRoom(wid)];

    for (const uid of memberUserIds) rooms.push(this.buildMemberRoom(this.safeStringId(uid)));

    this.emitToRooms(rooms, WorkItemWsEvents.Deleted, payload);

    // Use correct ctx (do NOT mutate memberUserIds with room names)
    const nextCtx: WorkItemWsContext = {
      actor: ctx.actor,
      requestId: ctx.requestId,
      teamCode,
      workItemId: wid,
      memberUserIds: rooms
        .filter((r) => r.startsWith("aud.member."))
        .map((r) => r.replace("aud.member.", "")),
    };

    this.emitReloadHint(rooms, nextCtx);
    this.emitCountsChangedHint(rooms, nextCtx);
  }

  public emitBulkChanged(ctx: WorkItemWsContext, items: WorkItemDto[], total: number): void {
    const payload: WorkItemWsBulkChangedPayload<WorkItemDto> = {
      requestId: ctx.requestId,
      actor: ctx.actor,
      items,
      other: { total },
    };

    const rooms: string[] = [];
    if (ctx.teamCode) rooms.push(this.buildTeamRoom(ctx.teamCode));
    if (ctx.memberUserIds && ctx.memberUserIds.length > 0) {
      for (const uid of ctx.memberUserIds) rooms.push(this.buildMemberRoom(uid));
    }

    if (rooms.length === 0) {
      // eslint-disable-next-line no-console
      console.warn(`[Warning:] [WorkItemWsService] emitBulkChanged called without teamCode/memberUserIds.\n`);
      return;
    }

    this.emitToRooms(rooms, WorkItemWsEvents.BulkChanged, payload);
    this.emitCountsChangedHint(rooms, ctx);
  }

  // =========================================================================
  // Activity stream emits
  // =========================================================================

  public emitActivityAppended(
    ctx: WorkItemWsContext,
    workItemId: Types.ObjectId | string,
    teamCode: string,
    memberUserIds: Array<Types.ObjectId | string>,
    activity: MemberActivityDto
  ): void {
    const wid = this.safeStringId(workItemId);

    const payload: WorkItemWsActivityAppendedPayload = {
      requestId: ctx.requestId,
      actor: ctx.actor,
      workItemId: wid,
      activity,
    };

    const rooms: string[] = [this.buildTeamRoom(teamCode), this.buildWorkItemRoom(wid)];
    for (const uid of memberUserIds) rooms.push(this.buildMemberRoom(this.safeStringId(uid)));

    this.emitToRooms(rooms, WorkItemWsEvents.ActivityAppended, payload);

    // Hint for FE to patch/refetch WorkItem snapshot if needed
    this.emitToRooms(rooms, WorkItemWsEvents.ReloadHint, {
      requestId: ctx.requestId,
      teamCode,
      workItemId: wid,
    });
  }

  // =========================================================================
  // UI hint emits
  // =========================================================================

  private emitReloadHint(rooms: string[], ctx: WorkItemWsContext): void {
    const payload: { requestId: string; teamCode?: string; workItemId?: string } = {
      requestId: ctx.requestId,
      ...(ctx.teamCode ? { teamCode: ctx.teamCode } : {}),
      ...(ctx.workItemId ? { workItemId: ctx.workItemId } : {}),
    };

    this.emitToRooms(rooms, WorkItemWsEvents.ReloadHint, payload);
  }

  public emitCountsChanged(ctx: WorkItemWsContext, counts: Record<string, number>): void {
    const payload: WorkItemWsCountsChangedPayload = {
      requestId: ctx.requestId,
      ...(ctx.teamCode ? { teamCode: ctx.teamCode } : {}),
      counts,
    };

    const rooms: string[] = [];
    if (ctx.teamCode) rooms.push(this.buildTeamRoom(ctx.teamCode));
    if (ctx.memberUserIds && ctx.memberUserIds.length > 0) {
      for (const uid of ctx.memberUserIds) rooms.push(this.buildMemberRoom(uid));
    }

    if (rooms.length === 0) {
      // eslint-disable-next-line no-console
      console.warn(`[Warning:] [WorkItemWsService] emitCountsChanged called without routing info.\n`);
      return;
    }

    this.emitToRooms(rooms, WorkItemWsEvents.CountsChanged, payload);
  }

  /**
   * Counts hint (no real counts). FE can refetch counts via REST if it cares.
   * This avoids type issues and avoids emitting incorrect payload shapes.
   */
  private emitCountsChangedHint(rooms: string[], ctx: WorkItemWsContext): void {
    const payload: WorkItemWsCountsChangedPayload = {
      requestId: ctx.requestId,
      ...(ctx.teamCode ? { teamCode: ctx.teamCode } : {}),
      counts: {},
    };

    this.emitToRooms(rooms, WorkItemWsEvents.CountsChanged, payload);
  }

  // =========================================================================
  // Room routing helper for create/update
  // =========================================================================

  private buildRoomsForWorkItemChange(ctx: WorkItemWsContext, dto: WorkItemDto): string[] {
    const rooms: string[] = [];

    if (ctx.teamCode) rooms.push(this.buildTeamRoom(ctx.teamCode));

    // Use Mongo id for the work item room when available
    const wid = this.extractWorkItemIdFromDto(dto) ?? ctx.workItemId ?? null;
    if (wid) rooms.push(this.buildWorkItemRoom(wid));

    // Prefer explicit routing from ctx (service/controller knows assigned members)
    if (ctx.memberUserIds && ctx.memberUserIds.length > 0) {
      for (const uid of ctx.memberUserIds) rooms.push(this.buildMemberRoom(uid));
      return rooms;
    }

    // Fallback: try to read assignedToUserIds from dto if present (optional field)
    const maybe = dto as unknown as { assignedToUserIds?: string[] };
    if (maybe.assignedToUserIds && maybe.assignedToUserIds.length > 0) {
      for (const uid of maybe.assignedToUserIds) rooms.push(this.buildMemberRoom(uid));
    }

    return rooms;
  }
}
