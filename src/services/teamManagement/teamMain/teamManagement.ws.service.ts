// Path: src/services/teamManagement/teamMain/teamManagement.ws.service.ts
// ============================================================================
// TeamManagementWsService — Server-side WS emitter for Team Management (MAIN)
// ----------------------------------------------------------------------------
// PURPOSE
// - Emit canonical Team WS events after REST mutations.
// - Keep WS event names centralized via TeamWsEvents (no string typos).
// - Use your SocketConnectionHandler pattern (emitToRoom/emitToRole/emitToUser).
//
// ROOM STRATEGY (recommended)
// - Team details viewers:    team.<teamCode>
// - Team list viewers:       role.admin,  role.Operator (extend as needed)
//
// NOTE
// - This service is DTO-only (do NOT pass mongoose docs).
// - If Socket handler singleton boot order can be an issue, we use lazy resolution.
// ============================================================================

import { TeamWsEvents } from "../../../socket/events/teamManagement/teamMain/teamManagement.ws.events";
import { SocketConnectionHandler } from "../../../socket/socket-connection.handler";

// Path: src/services/teamManagement/teamMain/teamManagement.ws.service.ts

export interface TeamWsActor {
  // ✅ username is your unique key (required)
  username: string;

  // ✅ role is required in AuthUser
  role: string;

  // ✅ keep optional, because your AuthUser.sub is optional
  userId?: string;

  // ✅ optional scoping hints (matches AuthUser)
  teamCodes?: string[];
  branchId?: string;
}

export interface TeamWsContext {
  requestId: string;
  actor: TeamWsActor;
}


export interface TeamWsContext {
  requestId: string;
  actor: TeamWsActor;
}

export type TeamListInvalidateReason = "created" | "updated" | "deleted" | "bulkChanged";

export interface TeamListInvalidateDto {
  reason: TeamListInvalidateReason;
  teamCode?: string;
  teamId?: string;
  hints?: {
    likelyAffectsSort?: boolean;
    likelyAffectsFilters?: boolean;
  };
}

export interface TeamCountsChangedDto {
  // Keep this flexible: FE can update sidebar badges without refetching full lists.
  // Only include values you actually compute (omit absent optional props).
  totalTeams?: number;
  totalActive?: number;
  totalInactive?: number;
  byDomain?: Record<string, number>;
}

export class TeamManagementWsService {
  public constructor() {}

  // --------------------------------------------------------------------------
  // Lazy handler resolution (prevents crash if singleton is not ready yet)
  // --------------------------------------------------------------------------
  private async getHandler(): Promise<SocketConnectionHandler> {
    // Your project already uses WaitForInstance() in other modules.
    // If your handler does not yet have it, add it there (recommended).
    const handler = await SocketConnectionHandler.WaitForInstance();
    return handler;
  }

  private buildEnvelope<T>(event: string, ctx: TeamWsContext, data: T): {
    event: string;
    requestId: string;
    actor: TeamWsActor;
    at: string;
    data: T;
  } {
    return {
      event,
      requestId: ctx.requestId,
      actor: { ...ctx.actor },
      at: new Date().toISOString(),
      data,
    };
  }

  // --------------------------------------------------------------------------
  // Emission helpers
  // --------------------------------------------------------------------------
  private async emitToListRoles(eventName: string, payload: unknown): Promise<void> {
    const h = await this.getHandler();

    // Extend roles as required by your access-map.
    await h.emitToRole("admin", eventName, payload);
    await h.emitToRole("operator", eventName, payload);
  }

  private async emitToTeamRoom(teamCode: string, eventName: string, payload: unknown): Promise<void> {
    const h = await this.getHandler();
    await h.emitToRoom( ` team.${ teamCode }`, eventName, payload );
  }

  // --------------------------------------------------------------------------
  // Public API — use these after REST success paths
  // --------------------------------------------------------------------------
  public async emitCreated(ctx: TeamWsContext, teamDto: unknown): Promise<void> {
    const payload = this.buildEnvelope(TeamWsEvents.Created, ctx, teamDto);

    await this.emitToListRoles(TeamWsEvents.Created, payload);
    await this.emitListInvalidate(ctx, { reason: "created" });

    // Optional: also emit to team room (if your UI can open detail immediately)
    const anyTeam = teamDto as { teamCode?: string };
    if (anyTeam?.teamCode) {
      await this.emitToTeamRoom(anyTeam.teamCode, TeamWsEvents.Created, payload);
    }
  }

  public async emitUpdated(ctx: TeamWsContext, teamCode: string, teamDto: unknown): Promise<void> {
    const payload = this.buildEnvelope(TeamWsEvents.Updated, ctx, teamDto);

    // Team details viewers
    await this.emitToTeamRoom(teamCode, TeamWsEvents.Updated, payload);

    // Team list viewers refetch current page
    await this.emitListInvalidate(ctx, {
      reason: "updated",
      teamCode,
      hints: { likelyAffectsSort: true },
    });
  }

  public async emitDeleted(ctx: TeamWsContext, teamCode: string, teamId: string): Promise<void> {
    const payload = this.buildEnvelope(TeamWsEvents.Deleted, ctx, { teamCode, teamId });

    await this.emitToListRoles(TeamWsEvents.Deleted, payload);
    await this.emitToTeamRoom(teamCode, TeamWsEvents.Deleted, payload);

    await this.emitListInvalidate(ctx, { reason: "deleted", teamCode, teamId });
  }

  public async emitBulkChanged(ctx: TeamWsContext, note?: string): Promise<void> {
    const payload = this.buildEnvelope(TeamWsEvents.BulkChanged, ctx, { note: note ?? "bulk changed" });
    await this.emitToListRoles(TeamWsEvents.BulkChanged, payload);
    await this.emitListInvalidate(ctx, { reason: "bulkChanged" });
  }

  public async emitListInvalidate(ctx: TeamWsContext, dto: TeamListInvalidateDto): Promise<void> {
    const payload = this.buildEnvelope(TeamWsEvents.ListInvalidate, ctx, dto);
    await this.emitToListRoles(TeamWsEvents.ListInvalidate, payload);
  }

  public async emitReloadHint(ctx: TeamWsContext, message: string): Promise<void> {
    const payload = this.buildEnvelope(TeamWsEvents.ReloadHint, ctx, { message });
    await this.emitToListRoles(TeamWsEvents.ReloadHint, payload);
  }

  public async emitCountsChanged(ctx: TeamWsContext, dto: TeamCountsChangedDto): Promise<void> {
    const payload = this.buildEnvelope(TeamWsEvents.CountsChanged, ctx, dto);
    await this.emitToListRoles(TeamWsEvents.CountsChanged, payload);
  }

  private async emitToActorUser(ctx: TeamWsContext, eventName: string, payload: unknown): Promise<void> {
    const h = await this.getHandler();
    const username = ctx.actor.username;
    if (!username) return;
  
    // ✅ username is unique => stable room
    await h.emitToRoom(`user:${username}`, eventName, payload);
  }
}
