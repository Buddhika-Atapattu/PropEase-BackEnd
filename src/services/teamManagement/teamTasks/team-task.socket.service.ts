// Path: src/services/teamManagement/team-task.socket.service.ts
// ============================================================================
// TeamTaskSocketService — DTO-first, Event-safe, Ref-safe (FIXED + Provider)
// ----------------------------------------------------------------------------
// KEY FIXES
// - Uses WsEmitterProvider.Get() -> IWsEmitter (no SocketConnectionHandler import)
// - Uses emitter.emitToTeamRooms(teamCode, ...) instead of duplicating rooms
// - Centralizes emitter access via getEmitter()
// - Warns when bulk events have empty taskIds (still allowed, but visible)
// ============================================================================

import type { Role } from "../../../types/roles";
import type { AuthUser } from "../../../socket/socket-types.type";
import type { TeamTaskDto } from "../../../types/teamManagement/teamTasks/team-tasks.type";

import { TeamTaskWsEvents } from "../../../socket/events/teamManagement/teamTasks/team-task.ws.events";
import { WsEmitterProvider } from "../../../socket/ws-emitter.provider";
import type { IWsEmitter } from "../../../socket/ws-emitter.interface";

// ----------------------------------------------------------------------------
// Event name union (server events only)
// ----------------------------------------------------------------------------
export type TeamTaskServerEventName =
  | typeof TeamTaskWsEvents.Ready
  | typeof TeamTaskWsEvents.Error
  | typeof TeamTaskWsEvents.Created
  | typeof TeamTaskWsEvents.Updated
  | typeof TeamTaskWsEvents.Deleted
  | typeof TeamTaskWsEvents.BulkChanged
  | typeof TeamTaskWsEvents.ReloadHint
  | typeof TeamTaskWsEvents.CountsChanged;

export type TeamTaskSocketScope = "team" | "member" | "org" | "role" | "user";

// ----------------------------------------------------------------------------
// Meta (correlation + auditing)
// ----------------------------------------------------------------------------
export interface TeamTaskSocketEventMeta {
  ts: number;
  requestId?: string;
  actor?: {
    userId?: string;
    username?: string;
    role?: string;
  };
}

// ----------------------------------------------------------------------------
// Ref model (no fake empty values)
// ----------------------------------------------------------------------------
export interface TeamTaskSingleRef {
  kind: "single";
  taskId: string;
  taskMongoId: string;
  teamCode: string;
  teamMongoId: string;
  domain: string;
}

export interface TeamTaskBulkRef {
  kind: "bulk";
  teamCode: string;
  teamMongoId?: string;
  domain?: string;

  // REQUIRED (can be empty if you want "reload all", but warn in logs)
  taskIds: string[];
  taskMongoIds?: string[];
}

/**
 * Team-level ref (no specific tasks; used for Ready/Error/CountsChanged etc.)
 */
export interface TeamTaskTeamRef {
  kind: "team";
  teamCode: string;
  teamMongoId?: string;
  domain?: string;
}

export type TeamTaskRef = TeamTaskSingleRef | TeamTaskBulkRef | TeamTaskTeamRef;

// ----------------------------------------------------------------------------
// Event envelope (consistent across all server events)
// ----------------------------------------------------------------------------
export interface TeamTaskSocketEventPayload<TData> {
  event: TeamTaskServerEventName;
  scope: TeamTaskSocketScope;
  ref: TeamTaskRef;
  data: TData;
  meta: TeamTaskSocketEventMeta;
}

// ----------------------------------------------------------------------------
// Context passed from controller/service
// ----------------------------------------------------------------------------
export interface TeamTaskWsContext {
  actor?: AuthUser;
  requestId?: string;

  // Optional: emit to `user:<username>` rooms in addition to aud.member.<id>
  assignedMemberUsernames?: string[];
}

export class TeamTaskSocketService {
  public constructor() {
    // no singleton dependency; safe to construct anytime
  }

  // ==========================================================================
  // 1) READY
  // ==========================================================================
  public emitReady(input: {
    teamCode: string;
    message?: string;
    actor?: AuthUser;
    requestId?: string;
  }): void {
    const teamCode = this.safeStr(input.teamCode);
    if (!teamCode) return;

    const message = this.safeStr(input.message);

    const payload: TeamTaskSocketEventPayload<{ ok: true; message?: string }> = {
      event: TeamTaskWsEvents.Ready,
      scope: "team",
      ref: { kind: "team", teamCode },
      data: message ? { ok: true, message } : { ok: true },
      meta: this.buildMeta(input.actor, input.requestId),
    };

    this.emitToTeam(teamCode, payload);
  }

  // ==========================================================================
  // 2) ERROR
  // ==========================================================================
  public emitError(input: {
    teamCode: string;
    code: string;
    message: string;
    details?: unknown;
    actor?: AuthUser;
    requestId?: string;
  }): void {
    const teamCode = this.safeStr(input.teamCode);
    if (!teamCode) return;

    const payload: TeamTaskSocketEventPayload<{
      ok: false;
      code: string;
      message: string;
      details?: unknown;
    }> = {
      event: TeamTaskWsEvents.Error,
      scope: "team",
      ref: { kind: "team", teamCode },
      data: {
        ok: false,
        code: this.safeStr(input.code),
        message: this.safeStr(input.message),
        ...(typeof input.details !== "undefined" ? { details: input.details } : {}),
      },
      meta: this.buildMeta(input.actor, input.requestId),
    };

    this.emitToTeam(teamCode, payload);
  }

  // ==========================================================================
  // 3) CREATED / UPDATED / DELETED
  // ==========================================================================
  public emitTaskCreated(dto: TeamTaskDto, ctx?: TeamTaskWsContext): void {
    const payload = this.buildSingleDtoPayload(TeamTaskWsEvents.Created, "team", dto, ctx);
    this.emitToTeam(dto.teamCode, payload);
    this.emitToMembers(dto, payload, ctx);
  }

  public emitTaskUpdated(dto: TeamTaskDto, ctx?: TeamTaskWsContext): void {
    const payload = this.buildSingleDtoPayload(TeamTaskWsEvents.Updated, "team", dto, ctx);
    this.emitToTeam(dto.teamCode, payload);
    this.emitToMembers(dto, payload, ctx);
  }

  public emitTaskDeleted(dto: TeamTaskDto, ctx?: TeamTaskWsContext): void {
    const payload = this.buildSingleDtoPayload(TeamTaskWsEvents.Deleted, "team", dto, ctx);
    this.emitToTeam(dto.teamCode, payload);
    this.emitToMembers(dto, payload, ctx);
  }

  // ==========================================================================
  // 4) BULK CHANGED
  // ==========================================================================
  public emitBulkChanged(input: {
    teamCode: string;
    reason: string;

    taskIds?: string[];
    taskMongoIds?: string[];

    teamMongoId?: string;
    domain?: string;

    actor?: AuthUser;
    requestId?: string;
  }): void {
    const teamCode = this.safeStr(input.teamCode);
    if (!teamCode) return;

    const taskIds = Array.isArray(input.taskIds)
      ? input.taskIds.map((x) => this.safeStr(x)).filter(Boolean)
      : [];

    const taskMongoIds = Array.isArray(input.taskMongoIds)
      ? input.taskMongoIds.map((x) => this.safeStr(x)).filter(Boolean)
      : [];

    if (taskIds.length === 0 && taskMongoIds.length === 0) {
      console.warn(
        "[Warning:] [TeamTaskSocketService] emitBulkChanged called with empty taskIds/taskMongoIds (treated as reload-all hint)\n"
      );
    }

    const ref: TeamTaskBulkRef = {
      kind: "bulk",
      teamCode,
      taskIds,
      ...(this.safeStr(input.teamMongoId) ? { teamMongoId: this.safeStr(input.teamMongoId) } : {}),
      ...(this.safeStr(input.domain) ? { domain: this.safeStr(input.domain) } : {}),
      ...(taskMongoIds.length > 0 ? { taskMongoIds } : {}),
    };

    const payload: TeamTaskSocketEventPayload<{ reason: string }> = {
      event: TeamTaskWsEvents.BulkChanged,
      scope: "team",
      ref,
      data: { reason: this.safeStr(input.reason) },
      meta: this.buildMeta(input.actor, input.requestId),
    };

    this.emitToTeam(teamCode, payload);
  }

  // ==========================================================================
  // 5) RELOAD HINT
  // ==========================================================================
  public emitReloadHint(input: {
    teamCode: string;
    reason: string;
    taskId?: string;
    taskMongoId?: string;
    actor?: AuthUser;
    requestId?: string;
  }): void {
    const teamCode = this.safeStr(input.teamCode);
    if (!teamCode) return;

    const taskId = this.safeStr(input.taskId);
    const taskMongoId = this.safeStr(input.taskMongoId);

    const ref: TeamTaskRef =
      taskId || taskMongoId
        ? {
            kind: "bulk",
            teamCode,
            taskIds: taskId ? [taskId] : [],
            ...(taskMongoId ? { taskMongoIds: [taskMongoId] } : {}),
          }
        : { kind: "team", teamCode };

    const payload: TeamTaskSocketEventPayload<{ reason: string }> = {
      event: TeamTaskWsEvents.ReloadHint,
      scope: "team",
      ref,
      data: { reason: this.safeStr(input.reason) },
      meta: this.buildMeta(input.actor, input.requestId),
    };

    this.emitToTeam(teamCode, payload);
  }

  // ==========================================================================
  // 6) COUNTS CHANGED
  // ==========================================================================
  public emitCountsChanged(input: {
    teamCode: string;
    reason: string;
    actor?: AuthUser;
    requestId?: string;
  }): void {
    const teamCode = this.safeStr(input.teamCode);
    if (!teamCode) return;

    const payload: TeamTaskSocketEventPayload<{ reason: string }> = {
      event: TeamTaskWsEvents.CountsChanged,
      scope: "team",
      ref: { kind: "team", teamCode },
      data: { reason: this.safeStr(input.reason) },
      meta: this.buildMeta(input.actor, input.requestId),
    };

    this.emitToTeam(teamCode, payload);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Emit routing (rooms)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Team broadcast:
   * Uses emitter.emitToTeamRooms(teamCode, ...) which already emits to:
   * - aud.team.<teamCode>
   * - team:<teamCode>
   */
  private emitToTeam(teamCode: string, payload: TeamTaskSocketEventPayload<unknown>): void {
    const safeTeam = this.safeStr(teamCode);
    if (!safeTeam) {
      console.warn("[Warning:] [TeamTaskSocketService] emitToTeam called with empty teamCode\n");
      return;
    }

    const emitter = this.getEmitter();
    emitter.emitToTeamRooms(safeTeam, payload.event, payload);

    console.log(
      "[Info:] [TeamTaskSocketService] emitToTeam -> team=",
      safeTeam,
      "event=",
      payload.event,
      "\n"
    );
  }

  /**
   * Member broadcast:
   * - aud.member.<userId> from dto.assignedMembers (preferred)
   * - user:<username> from ctx.assignedMemberUsernames (optional)
   */
  private emitToMembers(
    dto: TeamTaskDto,
    payload: TeamTaskSocketEventPayload<unknown>,
    ctx?: TeamTaskWsContext
  ): void {
    const emitter = this.getEmitter();

    const memberIds = Array.isArray(dto.assignedMembers) ? dto.assignedMembers : [];
    for (const memberId of memberIds) {
      const id = this.safeStr(memberId);
      if (!id) continue;
      emitter.emitToRoom(`aud.member.${id}`, payload.event, payload);
    }

    const usernames = Array.isArray(ctx?.assignedMemberUsernames) ? ctx!.assignedMemberUsernames : [];
    for (const un of usernames) {
      const safeUn = this.safeStr(un);
      if (!safeUn) continue;

      // Your IWsEmitter.emitToUser should route to user:<username> internally,
      // but your handler already does that; we keep API consistent.
      emitter.emitToUser(safeUn, payload.event, payload);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Payload builder for single-task DTO events
  // ──────────────────────────────────────────────────────────────────────────

  private buildSingleDtoPayload(
    event: TeamTaskServerEventName,
    scope: TeamTaskSocketScope,
    dto: TeamTaskDto,
    ctx?: TeamTaskWsContext
  ): TeamTaskSocketEventPayload<TeamTaskDto> {
    const ref: TeamTaskSingleRef = {
      kind: "single",
      taskId: this.safeStr(dto.id),
      taskMongoId: this.safeStr(dto.mongoId),
      teamCode: this.safeStr(dto.teamCode),
      teamMongoId: this.safeStr(dto.teamMongoId),
      domain: this.safeStr(dto.domain),
    };

    return {
      event,
      scope,
      ref,
      data: dto,
      meta: this.buildMeta(ctx?.actor, ctx?.requestId),
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Meta builder (exactOptionalPropertyTypes safe)
  // ──────────────────────────────────────────────────────────────────────────

  private buildMeta(actor?: AuthUser, requestId?: string): TeamTaskSocketEventMeta {
    const meta: TeamTaskSocketEventMeta = { ts: Date.now() };

    const req = this.safeStr(requestId);
    if (req) meta.requestId = req;

    if (actor) {
      const obj: { userId?: string; username?: string; role?: string } = {};

      const id = this.safeStr(actor.sub);
      const un = this.safeStr(actor.username);
      const rl = this.safeStr(actor.role);

      if (id) obj.userId = id;
      if (un) obj.username = un;
      if (rl) obj.role = rl;

      if (Object.keys(obj).length > 0) meta.actor = obj;
    }

    return meta;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Optional org admin broadcast helper
  // ──────────────────────────────────────────────────────────────────────────

  public emitToOrgAdmins(event: TeamTaskServerEventName, payload: unknown): void {
    const emitter = this.getEmitter();

    // TODO: if you have a Role enum, use it directly.
    const adminRoles: Role[] = ["admin" as Role];

    for (const r of adminRoles) {
      emitter.emitToRole(r, event, payload);
    }

    console.log(
      "[Info:] [TeamTaskSocketService] emitToOrgAdmins -> roles=",
      adminRoles,
      "event=",
      event,
      "\n"
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Provider accessor (centralize)
  // ──────────────────────────────────────────────────────────────────────────

  private getEmitter(): IWsEmitter {
    // Provider guarantees a valid IWsEmitter (real or Noop).
    // This means domain code never crashes due to boot-order.
    return WsEmitterProvider.Get();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Sanitizer
  // ──────────────────────────────────────────────────────────────────────────

  private safeStr(v: unknown): string {
    return typeof v === "string" ? v.trim() : "";
  }
}
