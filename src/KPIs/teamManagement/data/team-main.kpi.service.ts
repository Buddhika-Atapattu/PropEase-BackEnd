// ============================================================================
// Path: src/KPIs/teamManagement/data/team-main.kpi.service.ts
// ============================================================================

import { Types, type PipelineStage } from "mongoose";

import { TeamManagementModel } from "../../../models/teamManagement/teamMain/teamManagement.model";
import type { KpiFilters, KpiTarget, KpiWindow } from "../../shared/kpi.types";

/**
 * TeamMainKpiService
 *
 * INTRODUCTION
 * - Computes Team Main KPIs from the authoritative TeamManagementModel (Teams collection).
 * - No KPI record models. No pre-aggregated KPI collections.
 *
 * IMPORTANT MATTERS
 * - Teams are usually not "time-windowed" metrics by nature (a team exists across time),
 *   but dashboards often require a window for consistency with other KPIs.
 * - We interpret the window as: teams created within the window (createdAt).
 *
 * WHY WE MAKE THIS CLASS
 * - Keeps team-level KPIs isolated and readable.
 * - Uses PipelineStage[] everywhere (prevents Mongoose typing overload errors).
 * - exactOptionalPropertyTypes-safe: optional props are omitted, never set to undefined.
 *
 * KEEP IN MIND
 * - If your Team model does not have createdAt as ISO string/Date, update field constants.
 * - If "activeTeams" should mean "teams with activity in window", we can upgrade later
 *   by joining tasks/work-items/events. For now, "activeTeams" = teams not archived/deleted.
 */
export class TeamMainKpiService {
  // ==========================================================================
  // Field mapping (adjust here if your schema differs)
  // ==========================================================================

  /**
   * Team code field (string)
   */
  private readonly TEAM_CODE_FIELD: string = "teamCode";

  /**
   * Optional status fields. If your schema uses different names, update here.
   * - archived: boolean flag
   * - isDeleted: boolean flag
   */
  private readonly ARCHIVED_FIELD: string = "archived";
  private readonly DELETED_FIELD: string = "isDeleted";

  /**
   * Team members array
   * - Some schemas store `members: [{ userId, ... }]`
   * - Others store `members: [ObjectId]`
   *
   * We'll compute member count using $size on `members`.
   */
  private readonly MEMBERS_FIELD: string = "members";

  /**
   * Anchor date field for window.
   * - If your schema uses createdAt as Date, this still works.
   * - If it uses ISO string, $toDate will convert.
   */
  private readonly CREATED_AT_FIELD: string = "createdAt";

  // ==========================================================================
  // KPIs
  // ==========================================================================

  /**
   * Team Count KPI
   *
   * Output:
   * - { total: number }
   *
   * Scope:
   * - org only (engine enforces this)
   *
   * Window:
   * - teams created within window
   */
  public async teamCount(input: {
    target: KpiTarget;
    window: KpiWindow;
    filters?: KpiFilters;
  }): Promise<{ total: number }> {
    const matchStages: PipelineStage[] = this.buildBaseMatchStages({
      target: input.target,
      window: input.window,
      ...(input.filters ? { filters: input.filters } : {}),
      anchor: "createdAt",
    });

    const rows = await TeamManagementModel.aggregate<{ total: number }>([
      ...matchStages,
      { $count: "total" },
    ]);

    return { total: rows[0]?.total ?? 0 };
  }

  /**
   * Member Count KPI
   *
   * Output:
   * - { total: number }
   *
   * Meaning:
   * - Total members across teams in scope (org/team)
   *
   * Window:
   * - teams created within window
   */
  public async memberCount(input: {
    target: KpiTarget;
    window: KpiWindow;
    filters?: KpiFilters;
  }): Promise<{ total: number }> {
    const matchStages: PipelineStage[] = this.buildBaseMatchStages({
      target: input.target,
      window: input.window,
      ...(input.filters ? { filters: input.filters } : {}),
      anchor: "createdAt",
    });

    const rows = await TeamManagementModel.aggregate<{ total: number }>([
      ...matchStages,
      {
        $project: {
          _id: 0,
          memberCount: {
            $cond: [
              { $isArray: `$${this.MEMBERS_FIELD}` },
              { $size: `$${this.MEMBERS_FIELD}` },
              0,
            ],
          },
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: "$memberCount" },
        },
      },
      { $project: { _id: 0, total: 1 } },
    ]);

    return { total: rows[0]?.total ?? 0 };
  }

  /**
   * Active Teams KPI
   *
   * Output:
   * - { total: number }
   *
   * Definition (baseline):
   * - A team is "active" if it is not archived and not deleted.
   *
   * Window:
   * - teams created within window
   */
  public async activeTeams(input: {
    target: KpiTarget;
    window: KpiWindow;
    filters?: KpiFilters;
  }): Promise<{ total: number }> {
    const matchStages: PipelineStage[] = this.buildBaseMatchStages({
      target: input.target,
      window: input.window,
      ...(input.filters ? { filters: input.filters } : {}),
      anchor: "createdAt",
    });

    const rows = await TeamManagementModel.aggregate<{ total: number }>([
      ...matchStages,
      {
        $match: {
          [this.ARCHIVED_FIELD]: { $ne: true },
          [this.DELETED_FIELD]: { $ne: true },
        },
      },
      { $count: "total" },
    ]);

    return { total: rows[0]?.total ?? 0 };
  }

  // ==========================================================================
  // Internal helpers (PipelineStage-safe + exactOptionalPropertyTypes-safe)
  // ==========================================================================

  /**
   * Base pipeline stages:
   * - scope match
   * - anchor existence guard
   * - window match
   * - optional filters
   */
  private buildBaseMatchStages(options: {
    target: KpiTarget;
    window: KpiWindow;
    filters?: KpiFilters;
    anchor?: "createdAt";
  }): PipelineStage[] {
    const stages: PipelineStage[] = [];

    // 1) Scope match
    const scopeMatch = this.buildScopeMatch(options.target);
    if (scopeMatch) {
      stages.push({ $match: scopeMatch });
    }

    // 2) Anchor existence guard
    stages.push({ $match: { [this.CREATED_AT_FIELD]: { $ne: null } } });

    // 3) Window match ($toDate so it works for Date or ISO string)
    stages.push({
      $match: this.buildWindowExprMatch({ window: options.window }),
    });

    // 4) Optional filters
    const filterMatch = this.buildFilterMatch(options.filters);
    if (filterMatch) {
      stages.push({ $match: filterMatch });
    }

    return stages;
  }

  /**
   * Scope -> Mongo match object
   *
   * Assumptions:
   * - org scope: global (no orgId on teams)
   * - team scope: targetId is teamId (ObjectId string) OR teamCode
   *   - if ObjectId => _id match
   *   - else => teamCode match
   * - member scope: not used for team-main KPIs; returns safe "no results"
   */
  private buildScopeMatch(target: KpiTarget): Record<string, unknown> | null {
    if (target.scope === "org") {
      return null;
    }

    if (target.scope === "team") {
      const raw = target.targetId.trim();
      if (!raw) return null;

      if (Types.ObjectId.isValid(raw)) {
        return { _id: new Types.ObjectId(raw) };
      }
      return { [this.TEAM_CODE_FIELD]: raw };
    }

    // member scope should not query teams directly here
    return { _id: { $exists: false } };
  }

  private buildWindowExprMatch(options: { window: KpiWindow }): Record<string, unknown> {
    return {
      $expr: {
        $and: [
          { $gte: [{ $toDate: `$${this.CREATED_AT_FIELD}` }, options.window.from] },
          { $lte: [{ $toDate: `$${this.CREATED_AT_FIELD}` }, options.window.to] },
        ],
      },
    };
  }

  /**
   * Optional filters (module-wise)
   *
   * Supported filters (optional):
   * - teamCode: string -> teamCode
   */
  private buildFilterMatch(filters?: KpiFilters): Record<string, unknown> | null {
    if (!filters) return null;

    const match: Record<string, unknown> = {};

    const teamCode = this.readString(filters, "teamCode");
    if (teamCode) match[this.TEAM_CODE_FIELD] = teamCode;

    return Object.keys(match).length > 0 ? match : null;
  }

  private readString(filters: KpiFilters, key: string): string | null {
    const v = filters[key];
    if (typeof v !== "string") return null;
    const s = v.trim();
    return s ? s : null;
  }
}