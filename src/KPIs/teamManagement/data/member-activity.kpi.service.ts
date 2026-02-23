// ============================================================================
// Path: src/KPIs/teamManagement/data/member-activity.kpi.service.ts
// ============================================================================

import { Types, type PipelineStage } from "mongoose";

import { MemberActivityModel } from "../../../models/teamManagement/memberActivities/memberActivity.model";
import type { KpiFilters, KpiTarget, KpiWindow } from "../../shared/kpi.types";

/**
 * MemberActivityKpiService
 *
 * INTRODUCTION
 * - Computes Member Activity KPIs from the authoritative MemberActivityModel.
 * - No KPI record models. No pre-aggregated KPI collections.
 *
 * IMPORTANT MATTERS
 * - Member activity tracking schemas vary (activityDateTime vs createdAt, actor fields, team fields).
 * - To keep this stable, we centralize field mapping constants here.
 * - If your schema uses different field names, change constants only.
 *
 * WHY WE MAKE THIS CLASS
 * - Keeps member activity KPIs isolated, readable, and safe.
 * - Uses PipelineStage[] everywhere (prevents Mongoose typing overload errors).
 * - exactOptionalPropertyTypes-safe: optional props are omitted, never set to undefined.
 */
export class MemberActivityKpiService {
  // ==========================================================================
  // Field mapping (adjust here if your schema differs)
  // ==========================================================================

  /**
   * Team link field
   * - If your activity stores "teamId" (ObjectId): keep.
   * - If it stores "teamCode": update buildScopeMatch().
   */
  private readonly TEAM_ID_FIELD: string = "teamId";

  /**
   * Actor user field
   * - The user who performed the activity.
   */
  private readonly ACTOR_USER_FIELD: string = "userId";

  /**
   * Activity type field (optional for type-based filters)
   */
  private readonly ACTIVITY_TYPE_FIELD: string = "activityType";

  /**
   * Anchor date field for windows.
   * - If your schema uses "activityDateTime", set it here.
   * - If your schema uses "createdAt", keep as "createdAt".
   */
  private readonly ANCHOR_DATE_FIELD: string = "createdAt";

  // ==========================================================================
  // KPIs
  // ==========================================================================

  /**
   * Active Users KPI
   *
   * Definition:
   * - Number of distinct users who have at least 1 activity in the window.
   *
   * Output:
   * - { total: number }
   */
  public async activeUsers(input: {
    target: KpiTarget;
    window: KpiWindow;
    filters?: KpiFilters;
  }): Promise<{ total: number }> {
    const matchStages: PipelineStage[] = this.buildBaseMatchStages({
      target: input.target,
      window: input.window,
      ...(input.filters ? { filters: input.filters } : {}),
    });

    const rows = await MemberActivityModel.aggregate<{ total: number }>([
      ...matchStages,
      { $group: { _id: `$${this.ACTOR_USER_FIELD}` } },
      { $count: "total" },
    ]);

    return { total: rows[0]?.total ?? 0 };
  }

  /**
   * Activity Count KPI
   *
   * Definition:
   * - Total number of activity documents in the window.
   *
   * Output:
   * - { total: number }
   */
  public async activityCount(input: {
    target: KpiTarget;
    window: KpiWindow;
    filters?: KpiFilters;
  }): Promise<{ total: number }> {
    const matchStages: PipelineStage[] = this.buildBaseMatchStages({
      target: input.target,
      window: input.window,
      ...(input.filters ? { filters: input.filters } : {}),
    });

    const rows = await MemberActivityModel.aggregate<{ total: number }>([
      ...matchStages,
      { $count: "total" },
    ]);

    return { total: rows[0]?.total ?? 0 };
  }

  /**
   * Top Active Users KPI
   *
   * Definition:
   * - Top users by activity count within the window.
   *
   * Output:
   * - [{ userId: "<string>", count: <number> }, ...]
   */
  public async topActiveUsers(input: {
    target: KpiTarget;
    window: KpiWindow;
    filters?: KpiFilters;
  }): Promise<Array<{ userId: string; count: number }>> {
    const matchStages: PipelineStage[] = this.buildBaseMatchStages({
      target: input.target,
      window: input.window,
      ...(input.filters ? { filters: input.filters } : {}),
    });

    const rows = await MemberActivityModel.aggregate<{ userId: string; count: number }>([
      ...matchStages,
      { $group: { _id: `$${this.ACTOR_USER_FIELD}`, count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 },
      { $project: { _id: 0, userId: { $toString: "$_id" }, count: 1 } },
    ]);

    return rows;
  }

  // ==========================================================================
  // Internal helpers (PipelineStage-safe + exactOptionalPropertyTypes-safe)
  // ==========================================================================

  /**
   * Build base pipeline stages based on scope + window + optional filters.
   *
   * IMPORTANT
   * - Returns PipelineStage[] so spreading into aggregate([...]) is always valid.
   * - Adds anchor existence guard to avoid $toDate errors when anchor is missing.
   *
   * Window anchor:
   * - Uses ANCHOR_DATE_FIELD (createdAt / activityDateTime) within window
   */
  private buildBaseMatchStages(options: {
    target: KpiTarget;
    window: KpiWindow;
    filters?: KpiFilters;
  }): PipelineStage[] {
    const stages: PipelineStage[] = [];

    // 1) Scope match
    const scopeMatch = this.buildScopeMatch(options.target);
    if (scopeMatch) {
      stages.push({ $match: scopeMatch });
    }

    // 2) Anchor existence guard
    stages.push({ $match: { [this.ANCHOR_DATE_FIELD]: { $ne: null } } });

    // 3) Window match
    stages.push({
      $match: this.buildWindowExprMatch({
        window: options.window,
      }),
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
   * Policy:
   * - org scope: global (until you add orgId/branchId in member activities)
   * - team scope: expects teamId (ObjectId string) and matches TEAM_ID_FIELD
   * - member scope: expects userId (ObjectId string) and matches ACTOR_USER_FIELD
   */
  private buildScopeMatch(target: KpiTarget): Record<string, unknown> | null {
    if (target.scope === "org") {
      return null;
    }

    if (target.scope === "team") {
      const raw = target.targetId.trim();
      if (!raw || !Types.ObjectId.isValid(raw)) {
        return { _id: { $exists: false } };
      }
      return { [this.TEAM_ID_FIELD]: new Types.ObjectId(raw) };
    }

    // member scope
    const userRaw = target.targetId.trim();
    if (!userRaw || !Types.ObjectId.isValid(userRaw)) {
      return { _id: { $exists: false } };
    }

    const userId = new Types.ObjectId(userRaw);

    return { [this.ACTOR_USER_FIELD]: userId };
  }

  /**
   * Window expression match.
   * - Uses $toDate so it works for ISO strings or Date fields.
   */
  private buildWindowExprMatch(options: { window: KpiWindow }): Record<string, unknown> {
    const fieldExpr = `$${this.ANCHOR_DATE_FIELD}`;

    return {
      $expr: {
        $and: [
          { $gte: [{ $toDate: fieldExpr }, options.window.from] },
          { $lte: [{ $toDate: fieldExpr }, options.window.to] },
        ],
      },
    };
  }

  /**
   * Generic filters mapping (extend carefully, module-wise).
   *
   * Supported filters (optional):
   * - type: string -> ACTIVITY_TYPE_FIELD
   */
  private buildFilterMatch(filters?: KpiFilters): Record<string, unknown> | null {
    if (!filters) return null;

    const match: Record<string, unknown> = {};

    const type = this.readString(filters, "type");
    if (type) match[this.ACTIVITY_TYPE_FIELD] = type;

    return Object.keys(match).length > 0 ? match : null;
  }

  private readString(filters: KpiFilters, key: string): string | null {
    const v = filters[key];
    if (typeof v !== "string") return null;
    const s = v.trim();
    return s ? s : null;
  }
}