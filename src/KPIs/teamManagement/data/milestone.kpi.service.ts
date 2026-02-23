// ============================================================================
// Path: src/KPIs/teamManagement/data/milestone.kpi.service.ts
// ============================================================================

import { Types, type PipelineStage } from "mongoose";

import { MilestoneModel } from "../../../models/teamManagement/milestones/milestone.model";
import type { KpiFilters, KpiTarget, KpiWindow } from "../../shared/kpi.types";

/**
 * MilestoneKpiService
 *
 * INTRODUCTION
 * - Computes Milestone KPIs from the authoritative MilestoneModel.
 * - No KPI record models. No pre-aggregated KPI collections.
 *
 * IMPORTANT MATTERS
 * - Different projects model milestones differently (date fields + status fields).
 * - To keep this readable AND robust, we centralize “field mapping” as constants.
 * - If your Milestone schema uses different field names, only update the constants
 *   in this file (no need to rewrite pipelines).
 *
 * WHY WE MAKE THIS CLASS
 * - Keeps milestone KPI logic isolated and module-safe.
 * - Uses PipelineStage[] everywhere (prevents Mongoose typing overload errors).
 * - exactOptionalPropertyTypes-safe: optional properties are omitted, never set to undefined.
 *
 * KEEP IN MIND
 * - If your milestone dates are ISO strings, we use $toDate with anchor guards.
 * - If your milestone dates are stored as Date, $toDate still works safely.
 */
export class MilestoneKpiService {
  // ==========================================================================
  // Field mapping (adjust here if your schema differs)
  // ==========================================================================

  /**
   * Team link field
   * - If your milestone stores "teamId" (ObjectId): keep as-is.
   * - If your milestone stores "teamCode": update buildScopeMatch() below.
   */
  private readonly TEAM_ID_FIELD: string = "teamId";

  /**
   * Owner/creator user fields (used for member scope)
   * - We try both fields; if your schema has only one, keep the correct one.
   */
  private readonly OWNER_USER_FIELD: string = "ownerUserId";
  private readonly CREATED_BY_USER_FIELD: string = "createdByUserId";

  /**
   * Status field & values
   */
  private readonly STATUS_FIELD: string = "status";
  private readonly STATUS_COMPLETED_VALUES: string[] = ["completed", "done"];
  private readonly STATUS_CANCELLED_VALUES: string[] = ["cancelled", "canceled"];

  /**
   * Date fields
   * - createdAt: used when anchoring a window on created time
   * - dueAt: used for overdue / schedule KPIs
   *
   * NOTE
   * - If your schema uses "deadlineAt" or "targetDate", set DUE_AT_FIELD accordingly.
   */
  private readonly CREATED_AT_FIELD: string = "createdAt";
  private readonly DUE_AT_FIELD: string = "dueAt";

  // ==========================================================================
  // KPIs
  // ==========================================================================

  /**
   * Completed Rate KPI
   *
   * Definition:
   * - total = milestones within window (anchor defined below)
   * - completed = milestones whose status is in STATUS_COMPLETED_VALUES
   *
   * Window anchor:
   * - Uses createdAt as the anchor (milestones created in the window)
   *
   * Output:
   * - { completed, total, rate }
   */
  public async completedRate(input: {
    target: KpiTarget;
    window: KpiWindow;
    filters?: KpiFilters;
  }): Promise<{ completed: number; total: number; rate: number }> {
    const matchStages: PipelineStage[] = this.buildBaseMatchStages({
      target: input.target,
      window: input.window,
      ...(input.filters ? { filters: input.filters } : {}),
      anchor: "createdAt",
    });

    const rows = await MilestoneModel.aggregate<{ total: number; completed: number }>([
      ...matchStages,
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          completed: {
            $sum: {
              $cond: [
                { $in: [`$${this.STATUS_FIELD}`, this.STATUS_COMPLETED_VALUES] },
                1,
                0,
              ],
            },
          },
        },
      },
      { $project: { _id: 0, total: 1, completed: 1 } },
    ]);

    const total = rows[0]?.total ?? 0;
    const completed = rows[0]?.completed ?? 0;
    const rate = total > 0 ? Math.round((completed / total) * 10000) / 100 : 0;

    return { completed, total, rate };
  }

  /**
   * Active Count KPI
   *
   * Definition:
   * - “Active” milestones are not completed and not cancelled.
   *
   * Window anchor:
   * - Uses createdAt within window (so the count is meaningful over a period)
   *
   * Output:
   * - { active }
   */
  public async activeCount(input: {
    target: KpiTarget;
    window: KpiWindow;
    filters?: KpiFilters;
  }): Promise<{ active: number }> {
    const matchStages: PipelineStage[] = this.buildBaseMatchStages({
      target: input.target,
      window: input.window,
      ...(input.filters ? { filters: input.filters } : {}),
      anchor: "createdAt",
    });

    const rows = await MilestoneModel.aggregate<{ active: number }>([
      ...matchStages,
      {
        $match: {
          [this.STATUS_FIELD]: {
            $nin: [...this.STATUS_COMPLETED_VALUES, ...this.STATUS_CANCELLED_VALUES],
          },
        },
      },
      { $count: "active" },
    ]);

    return { active: rows[0]?.active ?? 0 };
  }

  /**
   * Overdue Count KPI
   *
   * Definition:
   * - overdue when:
   *   - dueAt exists AND dueAt < now
   *   - status is not completed/cancelled
   *
   * Window anchor:
   * - Uses dueAt within window (dashboard relevance)
   *
   * Output:
   * - { overdue }
   */
  public async overdueCount(input: {
    target: KpiTarget;
    window: KpiWindow;
    filters?: KpiFilters;
  }): Promise<{ overdue: number }> {
    const matchStages: PipelineStage[] = this.buildBaseMatchStages({
      target: input.target,
      window: input.window,
      ...(input.filters ? { filters: input.filters } : {}),
      anchor: "dueAt",
    });

    const now = new Date();

    const rows = await MilestoneModel.aggregate<{ overdue: number }>([
      ...matchStages,
      {
        $match: {
          $expr: {
            $and: [
              { $lt: [{ $toDate: `$${this.DUE_AT_FIELD}` }, now] },
              {
                $not: {
                  $in: [
                    `$${this.STATUS_FIELD}`,
                    [...this.STATUS_COMPLETED_VALUES, ...this.STATUS_CANCELLED_VALUES],
                  ],
                },
              },
            ],
          },
        },
      },
      { $count: "overdue" },
    ]);

    return { overdue: rows[0]?.overdue ?? 0 };
  }

  // ==========================================================================
  // Internal helpers (PipelineStage-safe + exactOptionalPropertyTypes-safe)
  // ==========================================================================

  /**
   * Build base pipeline stages based on scope + window + optional filters.
   *
   * @param options.anchor
   * - "createdAt": window applies to CREATED_AT_FIELD
   * - "dueAt": window applies to DUE_AT_FIELD
   *
   * IMPORTANT
   * - Returns PipelineStage[] so spreading into aggregate([...]) is always valid.
   * - Adds an anchor existence guard before using $toDate.
   */
  private buildBaseMatchStages(options: {
    target: KpiTarget;
    window: KpiWindow;
    filters?: KpiFilters;
    anchor?: "createdAt" | "dueAt";
  }): PipelineStage[] {
    const anchor = options.anchor ?? "createdAt";
    const stages: PipelineStage[] = [];

    // 1) Scope match
    const scopeMatch = this.buildScopeMatch(options.target);
    if (scopeMatch) {
      stages.push({ $match: scopeMatch });
    }

    // 2) Anchor existence guard
    if (anchor === "createdAt") {
      stages.push({ $match: { [this.CREATED_AT_FIELD]: { $ne: null } } });
    } else {
      stages.push({ $match: { [this.DUE_AT_FIELD]: { $ne: null } } });
    }

    // 3) Window match
    stages.push({
      $match: this.buildWindowExprMatch({
        window: options.window,
        anchor,
      }),
    });

    // 4) Filters
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
   * - org scope: global (until you add orgId/branchId in milestones)
   * - team scope: expects teamId (ObjectId string) and matches TEAM_ID_FIELD
   * - member scope: expects userId (ObjectId string) and matches owner/creator fields
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

    return {
      $or: [
        { [this.OWNER_USER_FIELD]: userId },
        { [this.CREATED_BY_USER_FIELD]: userId },
      ],
    };
  }

  /**
   * Window expression match.
   * - Uses $toDate so it works for ISO strings or Date fields.
   */
  private buildWindowExprMatch(options: {
    window: KpiWindow;
    anchor: "createdAt" | "dueAt";
  }): Record<string, unknown> {
    const field =
      options.anchor === "dueAt" ? `$${this.DUE_AT_FIELD}` : `$${this.CREATED_AT_FIELD}`;

    return {
      $expr: {
        $and: [
          { $gte: [{ $toDate: field }, options.window.from] },
          { $lte: [{ $toDate: field }, options.window.to] },
        ],
      },
    };
  }

  /**
   * Generic filters mapping (extend carefully, module-wise).
   *
   * Supported filters (optional):
   * - status: string -> STATUS_FIELD
   */
  private buildFilterMatch(filters?: KpiFilters): Record<string, unknown> | null {
    if (!filters) return null;

    const match: Record<string, unknown> = {};

    const status = this.readString(filters, "status");
    if (status) match[this.STATUS_FIELD] = status;

    return Object.keys(match).length > 0 ? match : null;
  }

  private readString(filters: KpiFilters, key: string): string | null {
    const v = filters[key];
    if (typeof v !== "string") return null;
    const s = v.trim();
    return s ? s : null;
  }
}