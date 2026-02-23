// ============================================================================
// Path: src/KPIs/teamManagement/data/work-event.kpi.service.ts
// ============================================================================

import { Types, type PipelineStage } from "mongoose";

import { WorkEventModel } from "../../../models/teamManagement/workEvent.model";
import type { KpiFilters, KpiTarget, KpiWindow } from "../../shared/kpi.types";

/**
 * WorkEventKpiService
 *
 * INTRODUCTION
 * - Computes Work Event KPIs from the authoritative WorkEventModel.
 * - No KPI record models. No pre-aggregated KPI collections.
 *
 * IMPORTANT MATTERS
 * - WorkEvent dates are stored as Date fields (eventDateTime, createdAt).
 * - For dashboard time range KPIs, we anchor on `eventDateTime`.
 *
 * WHY WE MAKE THIS CLASS
 * - Keeps KPI computations isolated, testable, and readable.
 * - Allows TeamManagement KPI engine to dispatch by key without embedding Mongo logic.
 *
 * KEEP IN MIND
 * - team scope expects a teamId ObjectId string if your model stores teamId.
 * - If you store teamCode instead, update buildScopeMatch() accordingly.
 */
export class WorkEventKpiService {
  /**
   * Event Count KPI
   *
   * Output:
   * - { total: number }
   *
   * Window anchor:
   * - eventDateTime within window
   */
  public async eventCount(input: {
    target: KpiTarget;
    window: KpiWindow;
    filters?: KpiFilters;
  }): Promise<{ total: number }> {
    const matchStages: PipelineStage[] = this.buildBaseMatchStages({
      target: input.target,
      window: input.window,
      ...(input.filters ? { filters: input.filters } : {}),
      anchor: "eventDateTime",
    });

    const rows = await WorkEventModel.aggregate<{ total: number }>([
      ...matchStages,
      { $count: "total" },
    ]);

    return { total: rows[0]?.total ?? 0 };
  }

  /**
   * Today Count KPI
   *
   * Output:
   * - { total: number }
   *
   * Logic:
   * - Uses server-local "today" boundaries (00:00 -> 23:59:59.999).
   * - Still respects scope + filters.
   *
   * NOTE
   * - This KPI ignores input.window intentionally because "today" is a fixed concept.
   * - If you want "today within requested timezone", we can add timezone support later.
   */
  public async todayCount(input: {
    target: KpiTarget;
    window: KpiWindow;
    filters?: KpiFilters;
  }): Promise<{ total: number }> {
    // Build scope + filters, but override the window to "today".
    const todayWindow = this.buildTodayWindow();

    const matchStages: PipelineStage[] = this.buildBaseMatchStages({
      target: input.target,
      window: todayWindow,
      ...(input.filters ? { filters: input.filters } : {}),
      anchor: "eventDateTime",
    });

    const rows = await WorkEventModel.aggregate<{ total: number }>([
      ...matchStages,
      { $count: "total" },
    ]);

    return { total: rows[0]?.total ?? 0 };
  }

  /**
   * Type Distribution KPI
   *
   * Output:
   * - [{ type: "meeting", count: 12 }, ...]
   *
   * Window anchor:
   * - eventDateTime within window
   */
  public async typeDistribution(input: {
    target: KpiTarget;
    window: KpiWindow;
    filters?: KpiFilters;
  }): Promise<Array<{ type: string; count: number }>> {
    const matchStages: PipelineStage[] = this.buildBaseMatchStages({
      target: input.target,
      window: input.window,
      ...(input.filters ? { filters: input.filters } : {}),
      anchor: "eventDateTime",
    });

    const rows = await WorkEventModel.aggregate<{ type: string; count: number }>([
      ...matchStages,
      { $group: { _id: "$eventType", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $project: { _id: 0, type: { $ifNull: ["$_id", "unknown"] }, count: 1 } },
    ]);

    return rows;
  }

  // ==========================================================================
  // Internal helpers (PipelineStage-safe + exactOptionalPropertyTypes-safe)
  // ==========================================================================

  /**
   * Build base pipeline stages based on scope + window + optional filters.
   *
   * @param options.anchor
   * - "eventDateTime" (default): window applies to WorkEvent.eventDateTime
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
    anchor?: "eventDateTime";
  }): PipelineStage[] {
    const anchor = options.anchor ?? "eventDateTime";

    const stages: PipelineStage[] = [];

    // 1) Scope match
    const scopeMatch = this.buildScopeMatch(options.target);
    if (scopeMatch) {
      stages.push({ $match: scopeMatch });
    }

    // 2) Anchor existence guard
    if (anchor === "eventDateTime") {
      stages.push({ $match: { eventDateTime: { $ne: null } } });
    }

    // 3) Window match
    stages.push({
      $match: this.buildWindowRangeMatch({
        window: options.window,
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
   * ASSUMPTIONS (adjust if your model differs):
   * - org scope: global (no orgId yet)
   * - team scope: targetId is teamId (ObjectId string) -> matches WorkEvent.teamId
   * - member scope: targetId is userId (ObjectId string) -> matches WorkEvent.createdByUserId
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
      return { teamId: new Types.ObjectId(raw) };
    }

    // member scope
    const userRaw = target.targetId.trim();
    if (!userRaw || !Types.ObjectId.isValid(userRaw)) {
      return { _id: { $exists: false } };
    }

    const userId = new Types.ObjectId(userRaw);

    // If your model uses a different creator field name, change here.
    return { createdByUserId: userId };
  }

  /**
   * Window range match (Date field).
   */
  private buildWindowRangeMatch(options: { window: KpiWindow }): Record<string, unknown> {
    return {
      eventDateTime: {
        $gte: options.window.from,
        $lte: options.window.to,
      },
    };
  }

  /**
   * Generic filters mapping (extend carefully, module-wise).
   *
   * Supported filters (optional):
   * - type: string -> WorkEvent.eventType
   * - status: string -> WorkEvent.status (if exists)
   */
  private buildFilterMatch(filters?: KpiFilters): Record<string, unknown> | null {
    if (!filters) return null;

    const match: Record<string, unknown> = {};

    const type = this.readString(filters, "type");
    if (type) match.eventType = type;

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

  /**
   * Build today's window in server local time.
   *
   * NOTE
   * - If you need timezone-based "today" (Asia/Colombo), we can add that later,
   *   but it requires consistent timezone policy across the backend.
   */
  private buildTodayWindow(): KpiWindow {
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const to = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    return { from, to };
  }
}