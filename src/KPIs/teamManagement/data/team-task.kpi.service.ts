// ============================================================================
// Path: src/KPIs/teamManagement/data/team-task.kpi.service.ts
// ============================================================================

import { Types, type PipelineStage } from "mongoose";

import { TeamTaskModel } from "../../../models/teamManagement/teamTasks/teamTask.model";
import type { KpiFilters, KpiTarget, KpiWindow } from "../../shared/kpi.types";

/**
 * TeamTaskKpiService
 *
 * INTRODUCTION
 * - Computes Team Task KPIs from the authoritative TeamTaskModel.
 * - No KPI record models. No pre-aggregated KPI collections.
 *
 * IMPORTANT MATTERS
 * - TeamTask dates are stored as ISO strings (createdAt, deadlinePolicy.dueAt),
 *   so we convert them using $toDate inside aggregation.
 * - Scope interpretation (module policy):
 *   - member scope: targetId should be actor.userId (string ObjectId)
 *   - team scope: targetId can be teamCode OR teamMongoId string
 *   - org scope: no orgId field exists in TeamTask, so it returns global within window/filters
 *
 * WHY WE MAKE THIS CLASS
 * - Keeps KPI computations isolated, testable, and readable.
 * - Allows TeamManagement KPI engine to dispatch by key without knowing Mongo logic.
 *
 * KEEP IN MIND
 * - $toDate can throw at runtime if the anchor field is null/invalid.
 *   We guard anchor existence in buildBaseMatchStages() before applying $expr window filters.
 */
export class TeamTaskKpiService {
  /**
   * Completion Rate KPI
   *
   * @param input.target
   * - scope=member -> userId string (ObjectId)
   * - scope=team   -> teamCode OR teamMongoId string
   * - scope=org    -> global (until orgId exists)
   *
   * @param input.window
   * - from/to: validated Date objects
   *
   * @param input.filters
   * - Optional: domain, priority, status (extend later carefully)
   */
  public async completionRate(input: {
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

    const completedStatuses = ["completed", "completed_pending_confirmation"];

    const rows = await TeamTaskModel.aggregate<{ total: number; completed: number }>([
      ...matchStages,
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          completed: {
            $sum: {
              $cond: [{ $in: ["$status", completedStatuses] }, 1, 0],
            },
          },
        },
      },
      { $project: { _id: 0, total: 1, completed: 1 } },
    ]);

    const total = rows[0]?.total ?? 0;
    const completed = rows[0]?.completed ?? 0;

    // Return a percentage with 2 decimal places
    const rate = total > 0 ? Math.round((completed / total) * 10000) / 100 : 0;

    return { completed, total, rate };
  }

  /**
   * Overdue Count KPI
   *
   * Definition:
   * - overdue when:
   *   - deadlinePolicy.dueAt exists AND dueAt < now
   *   - status is not completed/cancelled
   *
   * Window rule:
   * - We anchor the window on dueAt (not createdAt) for dashboard relevance.
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
    const notOverdueStatuses = ["completed", "completed_pending_confirmation", "cancelled"];

    const rows = await TeamTaskModel.aggregate<{ overdue: number }>([
      ...matchStages,
      {
        $match: {
          $expr: {
            $and: [
              { $lt: [{ $toDate: "$deadlinePolicy.dueAt" }, now] },
              { $not: { $in: ["$status", notOverdueStatuses] } },
            ],
          },
        },
      },
      { $count: "overdue" },
    ]);

    return { overdue: rows[0]?.overdue ?? 0 };
  }

  /**
   * Top Overdue Holders KPI
   *
   * Definition:
   * - Uses assignedTaskCaptain as "holder"
   * - Counts overdue tasks per captain
   *
   * Output:
   * - { userId: "<string>", overdue: <number> }[]
   */
  public async topOverdueHolders(input: {
    target: KpiTarget;
    window: KpiWindow;
    filters?: KpiFilters;
  }): Promise<Array<{ userId: string; overdue: number }>> {
    const matchStages: PipelineStage[] = this.buildBaseMatchStages({
      target: input.target,
      window: input.window,
      ...(input.filters ? { filters: input.filters } : {}),
      anchor: "dueAt",
    });

    const now = new Date();
    const notOverdueStatuses = ["completed", "completed_pending_confirmation", "cancelled"];

    const rows = await TeamTaskModel.aggregate<{ userId: string; overdue: number }>([
      ...matchStages,

      // Must have a captain assigned to attribute overdue ownership
      { $match: { assignedTaskCaptain: { $ne: null } } },

      // Overdue conditions
      {
        $match: {
          $expr: {
            $and: [
              { $lt: [{ $toDate: "$deadlinePolicy.dueAt" }, now] },
              { $not: { $in: ["$status", notOverdueStatuses] } },
            ],
          },
        },
      },

      // Count by captain
      { $group: { _id: "$assignedTaskCaptain", overdue: { $sum: 1 } } },
      { $sort: { overdue: -1 } },
      { $limit: 10 },

      // Normalize to DTO-safe strings
      { $project: { _id: 0, userId: { $toString: "$_id" }, overdue: 1 } },
    ]);

    return rows;
  }

  // ==========================================================================
  // Internal helpers (class-based, reusable, typed)
  // ==========================================================================

  /**
   * Build base pipeline stages based on scope + window + optional filters.
   *
   * @param options.anchor
   * - "createdAt" (default): window applies to TeamTask.createdAt
   * - "dueAt": window applies to TeamTask.deadlinePolicy.dueAt
   *
   * IMPORTANT (Typing)
   * - Returns PipelineStage[] so spreading into aggregate([...]) is always valid.
   *
   * IMPORTANT (Runtime safety)
   * - Adds an anchor existence guard before $toDate to avoid conversion errors.
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

    // 2) Anchor existence guard (prevents $toDate runtime errors)
    if (anchor === "createdAt") {
      stages.push({ $match: { createdAt: { $ne: null } } });
    } else {
      stages.push({ $match: { "deadlinePolicy.dueAt": { $ne: null } } });
    }

    // 3) Window match (expr using $toDate)
    stages.push({
      $match: this.buildWindowExprMatch({
        window: options.window,
        anchor,
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
   * NOTE
   * - org scope currently returns null (global) because TeamTask has no orgId/branchId.
   * - team scope accepts teamCode or teamMongoId (ObjectId string).
   * - member scope expects a userId (ObjectId string) and matches captain or assignedMembers.
   */
  private buildScopeMatch(target: KpiTarget): Record<string, unknown> | null {
    if (target.scope === "org") {
      return null;
    }

    if (target.scope === "team") {
      const raw = target.targetId.trim();
      if (!raw) return null;

      if (Types.ObjectId.isValid(raw)) {
        return { teamMongoId: new Types.ObjectId(raw) };
      }
      return { teamCode: raw };
    }

    // member scope
    const userRaw = target.targetId.trim();
    if (!userRaw || !Types.ObjectId.isValid(userRaw)) {
      // safe "no results" guard if invalid member id is supplied
      return { _id: { $exists: false } };
    }

    const userId = new Types.ObjectId(userRaw);

    return {
      $or: [{ assignedTaskCaptain: userId }, { assignedMembers: userId }],
    };
  }

  /**
   * Window expression match.
   *
   * - Uses $toDate because stored fields are ISO strings.
   * - Uses $expr so we can compare against Date objects from the server.
   */
  private buildWindowExprMatch(options: {
    window: KpiWindow;
    anchor: "createdAt" | "dueAt";
  }): Record<string, unknown> {
    const field = options.anchor === "dueAt" ? "$deadlinePolicy.dueAt" : "$createdAt";

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
   * - domain: string   -> TeamTask.domain
   * - priority: string -> TeamTask.priority
   * - status: string   -> TeamTask.status
   */
  private buildFilterMatch(filters?: KpiFilters): Record<string, unknown> | null {
    if (!filters) return null;

    const match: Record<string, unknown> = {};

    const domain = this.readString(filters, "domain");
    if (domain) match.domain = domain;

    const priority = this.readString(filters, "priority");
    if (priority) match.priority = priority;

    const status = this.readString(filters, "status");
    if (status) match.status = status;

    return Object.keys(match).length > 0 ? match : null;
  }

  private readString(filters: KpiFilters, key: string): string | null {
    const v = filters[key];
    if (typeof v !== "string") return null;
    const s = v.trim();
    return s ? s : null;
  }
}