// Path: src/services/teamManagemement/milestones/milestone.ws.service.ts
// ============================================================================
// Milestone WebSocket Service (Emitter / Gateway Helper) — 100% CLASS-BASED
// ----------------------------------------------------------------------------
// ✅ PURPOSE
// - DTO-first emitter for Milestone events.
// - Best-effort WS: must never break REST.
// ----------------------------------------------------------------------------
// ✅ PROJECT RULES
// - Class-based only
// - exactOptionalPropertyTypes safe (omit optionals; never pass undefined)
// - Singleton allowed (your update)
// ============================================================================

import { Types } from "mongoose";

import { MilestoneWsEvents } from "../../../socket/events/teamManagement/milestones/milestone.ws.events";
import type { MilestoneServerEvent } from "../../../socket/events/teamManagement/milestones/milestone.ws.events";

import type { MilestoneDto } from "../../../types/teamManagement/milestones/milestone.types";
import type { AuthUser } from "../../../types/common";

import { SocketConnectionHandler } from "../../../socket/socket-connection.handler";

// ----------------------------------------------------------------------------
// Payload contracts (DTO-first, stable)
// ----------------------------------------------------------------------------

export interface MilestoneWsContext {
  actor: AuthUser;
  requestId: string;

  teamCode?: string;
  workItemId?: string;
  milestoneId?: string;
  memberUserIds?: string[];
}

export interface MilestoneWsErrorPayload {
  requestId: string;
  message: string;
  code?: string;
  details?: unknown;
}

export interface MilestoneWsReadyPayload {
  requestId: string;
  serverTime: string;
}

export interface MilestoneWsChangedPayload<T> {
  requestId: string;
  actor: AuthUser;
  data: T;
}

export interface MilestoneWsBulkChangedPayload<T> {
  requestId: string;
  actor: AuthUser;
  items: T[];
  other: { total: number };
}

export interface MilestoneWsCountsChangedPayload {
  requestId: string;
  teamCode?: string;
  counts: Record<string, number>;
}

export class MilestoneWsService {
  private static _instance: MilestoneWsService | null = null;

  public static GetInstance(): MilestoneWsService {
    if (!MilestoneWsService._instance) {
      MilestoneWsService._instance = new MilestoneWsService();
    }
    return MilestoneWsService._instance;
  }

  private constructor() {}

  // =========================================================================
  // Handler acquisition (lazy, safe)
  // =========================================================================

  private tryGetHandler(): SocketConnectionHandler | null {
    try {
      // If socket bootstrap didn't init singleton correctly, this throws.
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

  private buildMilestoneRoom(milestoneId: string): string {
    return `milestone.${milestoneId}`;
  }

  private safeStringId(id: Types.ObjectId | string): string {
    return typeof id === "string" ? id : id.toString();
  }

  // =========================================================================
  // Emit primitives (best-effort)
  // =========================================================================

  private emitToRoom(room: string, event: MilestoneServerEvent, payload: unknown): void {
    try {
      const handler = this.tryGetHandler();
      if (!handler) return;

      handler.emitToRoom(room, event, payload);
    } catch {
      // eslint-disable-next-line no-console
      console.warn(`[Warning:] [MilestoneWsService] emitToRoom failed.\n`);
    }
  }

  private emitToRooms(rooms: string[], event: MilestoneServerEvent, payload: unknown): void {
    for (const room of rooms) {
      this.emitToRoom(room, event, payload);
    }
  }

  // =========================================================================
  // Routing builder (exactOptionalPropertyTypes safe)
  // =========================================================================

  private buildRooms(ctx: MilestoneWsContext, dto?: MilestoneDto): string[] {
    const rooms: string[] = [];

    if (ctx.teamCode) rooms.push(this.buildTeamRoom(ctx.teamCode));
    if (ctx.workItemId) rooms.push(this.buildWorkItemRoom(ctx.workItemId));
    if (ctx.milestoneId) rooms.push(this.buildMilestoneRoom(ctx.milestoneId));

    // Prefer explicit member routing from ctx
    if (ctx.memberUserIds && ctx.memberUserIds.length > 0) {
      for (const uid of ctx.memberUserIds) rooms.push(this.buildMemberRoom(uid));
      return rooms;
    }

    // Fallback: infer member from dto.userId
    if (dto) {
      const raw = (dto as unknown as { userId?: unknown }).userId;

      if (typeof raw === "string" && raw.length > 0) {
        rooms.push(this.buildMemberRoom(raw));
      } else if (raw instanceof Types.ObjectId) {
        rooms.push(this.buildMemberRoom(raw.toString()));
      } else if (raw && typeof raw === "object" && "toString" in raw) {
        rooms.push(this.buildMemberRoom(String((raw as { toString: () => string }).toString())));
      }
    }

    return rooms;
  }

  // =========================================================================
  // Ready / Error
  // =========================================================================

  public emitReady(ctx: MilestoneWsContext): void {
    const rooms = this.buildRooms(ctx);
    if (rooms.length === 0) {
      // eslint-disable-next-line no-console
      console.warn(`[Warning:] [MilestoneWsService] emitReady called without routing rooms.\n`);
      return;
    }

    const payload: MilestoneWsReadyPayload = {
      requestId: ctx.requestId,
      serverTime: new Date().toISOString(),
    };

    this.emitToRooms(rooms, MilestoneWsEvents.Ready, payload);
  }

  public emitError(ctx: MilestoneWsContext, message: string, code?: string, details?: unknown): void {
    const rooms = this.buildRooms(ctx);
    if (rooms.length === 0) {
      // eslint-disable-next-line no-console
      console.warn(`[Warning:] [MilestoneWsService] emitError called without routing rooms.\n`);
      return;
    }

    const payload: MilestoneWsErrorPayload = {
      requestId: ctx.requestId,
      message,
      ...(code ? { code } : {}),
      ...(details ? { details } : {}),
    };

    this.emitToRooms(rooms, MilestoneWsEvents.Error, payload);
  }

  // =========================================================================
  // CRUD emits
  // =========================================================================

  public emitMilestoneCreated(ctx: MilestoneWsContext, dto: MilestoneDto): void {
    const rooms = this.buildRooms(ctx, dto);
    if (rooms.length === 0) return;

    const payload: MilestoneWsChangedPayload<MilestoneDto> = {
      requestId: ctx.requestId,
      actor: ctx.actor,
      data: dto,
    };

    this.emitToRooms(rooms, MilestoneWsEvents.Created, payload);
    this.emitToRooms(rooms, MilestoneWsEvents.ReloadHint, this.buildReloadHint(ctx, dto));
    this.emitCountsChangedHint(ctx, rooms);
  }

  public emitMilestoneUpdated(ctx: MilestoneWsContext, dto: MilestoneDto): void {
    const rooms = this.buildRooms(ctx, dto);
    if (rooms.length === 0) return;

    const payload: MilestoneWsChangedPayload<MilestoneDto> = {
      requestId: ctx.requestId,
      actor: ctx.actor,
      data: dto,
    };

    this.emitToRooms(rooms, MilestoneWsEvents.Updated, payload);
    this.emitToRooms(rooms, MilestoneWsEvents.ReloadHint, this.buildReloadHint(ctx, dto));
    this.emitCountsChangedHint(ctx, rooms);
  }

  public emitMilestoneDeleted(ctx: MilestoneWsContext, milestoneId: Types.ObjectId | string): void {
    const mid = this.safeStringId(milestoneId);

    const nextCtx: MilestoneWsContext = {
      actor: ctx.actor,
      requestId: ctx.requestId,
      ...(ctx.teamCode ? { teamCode: ctx.teamCode } : {}),
      ...(ctx.workItemId ? { workItemId: ctx.workItemId } : {}),
      milestoneId: mid,
      ...(ctx.memberUserIds && ctx.memberUserIds.length > 0 ? { memberUserIds: ctx.memberUserIds } : {}),
    };

    const rooms = this.buildRooms(nextCtx);
    if (rooms.length === 0) return;

    const payload: MilestoneWsChangedPayload<{ milestoneId: string }> = {
      requestId: ctx.requestId,
      actor: ctx.actor,
      data: { milestoneId: mid },
    };

    this.emitToRooms(rooms, MilestoneWsEvents.Deleted, payload);
    this.emitToRooms(rooms, MilestoneWsEvents.ReloadHint, this.buildReloadHint(nextCtx));
    this.emitCountsChangedHint(nextCtx, rooms);
  }

  public emitBulkChanged(ctx: MilestoneWsContext, items: MilestoneDto[], total: number): void {
    const rooms = this.buildRooms(ctx);
    if (rooms.length === 0) return;

    const payload: MilestoneWsBulkChangedPayload<MilestoneDto> = {
      requestId: ctx.requestId,
      actor: ctx.actor,
      items,
      other: { total },
    };

    this.emitToRooms(rooms, MilestoneWsEvents.BulkChanged, payload);
    this.emitCountsChangedHint(ctx, rooms);
  }

  // =========================================================================
  // Evidence emits (milestone-level evidence)
  // =========================================================================

  public emitEvidenceAppended(ctx: MilestoneWsContext, milestoneId: string, dto: MilestoneDto): void {
    const rooms = this.buildRooms({ ...ctx, milestoneId }, dto);
    if (rooms.length === 0) return;

    const payload: MilestoneWsChangedPayload<MilestoneDto> = {
      requestId: ctx.requestId,
      actor: ctx.actor,
      data: dto,
    };

    this.emitToRooms(rooms, MilestoneWsEvents.EvidenceAppended, payload);
    this.emitToRooms(rooms, MilestoneWsEvents.ReloadHint, this.buildReloadHint({ ...ctx, milestoneId }, dto));
  }

  public emitEvidenceRemoved(ctx: MilestoneWsContext, milestoneId: string, dto: MilestoneDto): void {
    const rooms = this.buildRooms({ ...ctx, milestoneId }, dto);
    if (rooms.length === 0) return;

    const payload: MilestoneWsChangedPayload<MilestoneDto> = {
      requestId: ctx.requestId,
      actor: ctx.actor,
      data: dto,
    };

    this.emitToRooms(rooms, MilestoneWsEvents.EvidenceRemoved, payload);
    this.emitToRooms(rooms, MilestoneWsEvents.ReloadHint, this.buildReloadHint({ ...ctx, milestoneId }, dto));
  }

  public emitEvidenceReplaced(ctx: MilestoneWsContext, milestoneId: string, dto: MilestoneDto): void {
    const rooms = this.buildRooms({ ...ctx, milestoneId }, dto);
    if (rooms.length === 0) return;

    const payload: MilestoneWsChangedPayload<MilestoneDto> = {
      requestId: ctx.requestId,
      actor: ctx.actor,
      data: dto,
    };

    this.emitToRooms(rooms, MilestoneWsEvents.EvidenceReplaced, payload);
    this.emitToRooms(rooms, MilestoneWsEvents.ReloadHint, this.buildReloadHint({ ...ctx, milestoneId }, dto));
  }

  // =========================================================================
  // Tags emits
  // =========================================================================

  public emitTagAppended(ctx: MilestoneWsContext, milestoneId: string, dto: MilestoneDto): void {
    const rooms = this.buildRooms({ ...ctx, milestoneId }, dto);
    if (rooms.length === 0) return;

    const payload: MilestoneWsChangedPayload<MilestoneDto> = {
      requestId: ctx.requestId,
      actor: ctx.actor,
      data: dto,
    };

    this.emitToRooms(rooms, MilestoneWsEvents.TagAppended, payload);
    this.emitToRooms(rooms, MilestoneWsEvents.ReloadHint, this.buildReloadHint({ ...ctx, milestoneId }, dto));
  }

  public emitTagRemoved(ctx: MilestoneWsContext, milestoneId: string, dto: MilestoneDto): void {
    const rooms = this.buildRooms({ ...ctx, milestoneId }, dto);
    if (rooms.length === 0) return;

    const payload: MilestoneWsChangedPayload<MilestoneDto> = {
      requestId: ctx.requestId,
      actor: ctx.actor,
      data: dto,
    };

    this.emitToRooms(rooms, MilestoneWsEvents.TagRemoved, payload);
    this.emitToRooms(rooms, MilestoneWsEvents.ReloadHint, this.buildReloadHint({ ...ctx, milestoneId }, dto));
  }

  public emitTagsReplaced(ctx: MilestoneWsContext, milestoneId: string, dto: MilestoneDto): void {
    const rooms = this.buildRooms({ ...ctx, milestoneId }, dto);
    if (rooms.length === 0) return;

    const payload: MilestoneWsChangedPayload<MilestoneDto> = {
      requestId: ctx.requestId,
      actor: ctx.actor,
      data: dto,
    };

    this.emitToRooms(rooms, MilestoneWsEvents.TagsReplaced, payload);
    this.emitToRooms(rooms, MilestoneWsEvents.ReloadHint, this.buildReloadHint({ ...ctx, milestoneId }, dto));
  }

  // =========================================================================
  // UI hint payloads
  // =========================================================================

  private buildReloadHint(ctx: MilestoneWsContext, dto?: MilestoneDto): Record<string, unknown> {
    const payload: Record<string, unknown> = { requestId: ctx.requestId };

    if (ctx.teamCode) payload.teamCode = ctx.teamCode;
    if (ctx.workItemId) payload.workItemId = ctx.workItemId;
    if (ctx.milestoneId) payload.milestoneId = ctx.milestoneId;

    // Fallback infer workItemId from dto if caller didn't supply it
    if (!payload.workItemId && dto) {
      const raw = (dto as unknown as { workItemId?: unknown }).workItemId;

      if (typeof raw === "string") payload.workItemId = raw;
      else if (raw instanceof Types.ObjectId) payload.workItemId = raw.toString();
      else if (raw && typeof raw === "object" && "toString" in raw) {
        payload.workItemId = String((raw as { toString: () => string }).toString());
      }
    }

    return payload;
  }

  private emitCountsChangedHint(ctx: MilestoneWsContext, rooms: string[]): void {
    const payload: MilestoneWsCountsChangedPayload = {
      requestId: ctx.requestId,
      ...(ctx.teamCode ? { teamCode: ctx.teamCode } : {}),
      counts: {},
    };

    this.emitToRooms(rooms, MilestoneWsEvents.CountsChanged, payload);
  }
}
