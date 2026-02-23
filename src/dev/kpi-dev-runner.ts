// ============================================================================
// DEV ONLY: KPI Engine Smoke Runner
// Path: src/dev/kpi-dev-runner.ts
// ============================================================================

import { TeamManagementKpiEngine } from "../KPIs/teamManagement/kpi.engine";

import type { KpiTarget, KpiWindow } from "../KPIs/shared/kpi.types";

/**
 * DevKpiRunner
 *
 * INTRODUCTION
 * - Allows internal smoke testing without HTTP endpoints.
 *
 * IMPORTANT
 * - DO NOT commit this in production branch.
 * - This runs directly inside Node runtime.
 *
 * WHY THIS EXISTS
 * - System is locked for external testing.
 * - We validate DB + aggregation + dispatch correctness internally.
 */
export class DevKpiRunner {
  public static async run(): Promise<void> {
    const engine = new TeamManagementKpiEngine();

    const target: KpiTarget = {
      scope: "team",
      targetId: "REPLACE_WITH_REAL_TEAM_CODE_OR_OBJECTID"
    };

    const window: KpiWindow = {
      from: new Date("2025-01-01T00:00:00.000Z"),
      to: new Date()
    };

    console.log("[Info:] Running KPI smoke test...\n");

    try {
      const completion = await engine.computeMetric({
        key: "tm.teamTask.completionRate",
        target,
        window
      });

      console.log("[Success:] completionRate\n", completion, "\n");

      const overdue = await engine.computeMetric({
        key: "tm.teamTask.overdueCount",
        target,
        window
      });

      console.log("[Success:] overdueCount\n", overdue, "\n");

      const batch = await engine.computeBatch({
        keys: [
          "tm.teamTask.completionRate",
          "tm.workEvent.todayCount"
        ],
        target,
        window
      });

      console.log("[Success:] batch\n", batch, "\n");

    } catch (error: unknown) {
      console.error("[Error:] KPI Dev Runner failed\n", error);
    }
  }
}