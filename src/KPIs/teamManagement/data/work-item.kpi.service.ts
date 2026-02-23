// ============================================================================
// Path: src/KPIs/teamManagement/data/work-item.kpi.service.ts
// ============================================================================

import { Types, type PipelineStage } from "mongoose";

import { WorkItemModel } from "../../../models/teamManagement/workItems/workItem.model";
import type { KpiFilters, KpiTarget, KpiWindow } from "../../shared/kpi.types";

/**
 * WorkItemKpiService
 *
 * INTRODUCTION
 * - Computes Work Item KPIs from the authoritative WorkItemModel.
 * - No KPI record models. No pre-aggregated KPI collections.
 *
 * IMPORTANT MATTERS
 * - WorkItem uses Date fields (assignedAt, expectedCompleteAt, completedAt, createdAt).
 * - For dashboard time ranges, we anchor KPI windows on `assignedAt` by default
 *   (meaning: items assigned within the window).
 *
 * WHY WE MAKE THIS CLASS
 * - Keeps KPI computations isolated and readable.
 * - Allows TeamManagement KPI engine to dispatch by key without embedding Mongo logic.
 *
 * KEEP IN MIND
 * - team scope requires a teamId (ObjectId string) because WorkItem stores teamId only.
 *   If your engine provides teamCode, either:
 *   1) send teamMongoId instead, OR
 *   2) add a lookup step in the engine (teamCode -> teamId).
 */
export class WorkItemKpiService {
  /**
   * Status Distribution KPI
   *
   * Output:
   * - [{ status: "assigned", count: 10 }, ...]
   *
   * Window anchor:
   * - assignedAt within window (default)
   */
  public async statusDistribution(input: {
    target: KpiTarget;
    window: KpiWindow;
    filters?: KpiFilters;
  }): Promise<Array<{ status: string; count: number }>> {
    const matchStages: PipelineStage[] = this.buildBaseMatchStages({
      target: input.target,
      window: input.window,
      ...(input.filters ? { filters: input.filters } : {}),
      anchor: "assignedAt",
    });

    const rows = await WorkItemModel.aggregate<{ status: string; count: number }>([
      ...matchStages,
      { $group: { _id: "$statusCurrent", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $project: { _id: 0, status: { $ifNull: ["$_id", "unknown"] }, count: 1 } },
    ]);

    return rows;
  }

  /**
   * Priority Distribution KPI
   *
   * Output:
   * - [{ priority: "high", count: 5 }, ...]
   *
   * Window anchor:
   * - assignedAt within window (default)
   */
  public async priorityDistribution(input: {
    target: KpiTarget;
    window: KpiWindow;
    filters?: KpiFilters;
  }): Promise<Array<{ priority: string; count: number }>> {
    const matchStages: PipelineStage[] = this.buildBaseMatchStages({
      target: input.target,
      window: input.window,
      ...(input.filters ? { filters: input.filters } : {}),
      anchor: "assignedAt",
    });

    const rows = await WorkItemModel.aggregate<{ priority: string; count: number }>([
      ...matchStages,
      { $group: { _id: "$priority", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $project: { _id: 0, priority: { $ifNull: ["$_id", "unknown"] }, count: 1 } },
    ]);

    return rows;
  }

  /**
   * Completed Count KPI
   *
   * Output:
   * - { completed: number }
   *
   * Window anchor:
   * - completedAt within window (because this is a completion metric)
   */
  public async completedCount(input: {
    target: KpiTarget;
    window: KpiWindow;
    filters?: KpiFilters;
  }): Promise<{ completed: number }> {
    const matchStages: PipelineStage[] = this.buildBaseMatchStages({
      target: input.target,
      window: input.window,
      ...(input.filters ? { filters: input.filters } : {}),
      anchor: "completedAt",
    });

    const rows = await WorkItemModel.aggregate<{ completed: number }>([
      ...matchStages,
      // completedAt exists (defensive; buildBaseMatchStages already guards, but keep explicit intent)
      { $match: { completedAt: { $ne: null } } },
      { $count: "completed" },
    ]);

    return { completed: rows[0]?.completed ?? 0 };
  }

  // ==========================================================================
  // Internal helpers (PipelineStage-safe + exactOptionalPropertyTypes-safe)
  // ==========================================================================

  /**
   * Build base pipeline stages based on scope + window + optional filters.
   *
   * @param options.anchor
   * - "assignedAt" (default): items assigned in window
   * - "completedAt": items completed in window
   *
   * IMPORTANT (Typing)
   * - Returns PipelineStage[] so spreading into aggregate([...]) is always valid.
   *
   * IMPORTANT (Runtime safety)
   * - Adds an anchor existence guard before applying range matching.
   */
  private buildBaseMatchStages(options: {
    target: KpiTarget;
    window: KpiWindow;
    filters?: KpiFilters;
    anchor?: "assignedAt" | "completedAt";
  }): PipelineStage[] {
    const anchor = options.anchor ?? "assignedAt";

    const stages: PipelineStage[] = [];

    // 1) Scope match
    const scopeMatch = this.buildScopeMatch(options.target);
    if (scopeMatch) {
      stages.push({ $match: scopeMatch });
    }

    // 2) Anchor existence guard
    if (anchor === "assignedAt") {
      stages.push({ $match: { assignedAt: { $ne: null } } });
    } else {
      stages.push({ $match: { completedAt: { $ne: null } } });
    }

    // 3) Window match
    stages.push({
      $match: this.buildWindowRangeMatch({
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
   * - org scope: global (WorkItem has no orgId yet)
   * - team scope: requires teamId ObjectId string (matches WorkItem.teamId)
   * - member scope: matches WorkItem.assignedToUserIds contains userId
   */
  private buildScopeMatch(target: KpiTarget): Record<string, unknown> | null {
    if (target.scope === "org") {
      // Until WorkItem has orgId/branchId, org scope behaves as global.
      return null;
    }

    if (target.scope === "team") {
      const raw = target.targetId.trim();
      if (!raw || !Types.ObjectId.isValid(raw)) {
        // If engine sends teamCode, this will safely produce no results.
        return { _id: { $exists: false } };
      }
      return { teamId: new Types.ObjectId(raw) };
    }

    // member scope
    const userRaw = target.targetId.trim();
    if (!userRaw || !Types.ObjectId.isValid(userRaw)) {
      return { _id: { $exists: false } };
    }

    const userId = new Types.ObjectId(userRaw);

    return {
      assignedToUserIds: userId,
    };
  }

  /**
   * Window range match for Date fields.
   */
  private buildWindowRangeMatch(options: {
    window: KpiWindow;
    anchor: "assignedAt" | "completedAt";
  }): Record<string, unknown> {
    const field = options.anchor === "assignedAt" ? "assignedAt" : "completedAt";

    return {
      [field]: {
        $gte: options.window.from,
        $lte: options.window.to,
      },
    };
  }

  /**
   * Generic filters mapping (extend carefully, module-wise).
   *
   * Supported filters (optional):
   * - status: string   -> WorkItem.statusCurrent
   * - priority: string -> WorkItem.priority
   */
  private buildFilterMatch(filters?: KpiFilters): Record<string, unknown> | null {
    if (!filters) return null;

    const match: Record<string, unknown> = {};

    const status = this.readString(filters, "status");
    if (status) match.statusCurrent = status;

    const priority = this.readString(filters, "priority");
    if (priority) match.priority = priority;

    return Object.keys(match).length > 0 ? match : null;
  }

  private readString(filters: KpiFilters, key: string): string | null {
    const v = filters[key];
    if (typeof v !== "string") return null;
    const s = v.trim();
    return s ? s : null;
  }
}