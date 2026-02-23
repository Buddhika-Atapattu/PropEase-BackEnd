// ============================================================================
// Path: src/KPIs/teamManagement/kpi.engine.ts
// ============================================================================

import type { KpiFilters, KpiTarget, KpiWindow } from "../shared/kpi.types";

import { TeamMainKpiService } from "./data/team-main.kpi.service";
import { TeamTaskKpiService } from "./data/team-task.kpi.service";
import { WorkItemKpiService } from "./data/work-item.kpi.service";
import { WorkEventKpiService } from "./data/work-event.kpi.service";
import { MilestoneKpiService } from "./data/milestone.kpi.service";
import { MemberActivityKpiService } from "./data/member-activity.kpi.service";

/**
 * TeamManagementKpiEngine
 *
 * INTRODUCTION
 * - Single dispatch point for ALL Team Management KPI keys.
 * - KPI keys are a strict union for compile-time safety (frontend + backend contract).
 *
 * IMPORTANT MATTERS
 * - NEVER trust req.params.key directly; always validate with isKey().
 * - exactOptionalPropertyTypes-safe:
 *   - If filters is undefined, omit the property in downstream calls.
 *
 * WHY WE MAKE THIS CLASS
 * - Eliminates endpoint-per-metric growth.
 * - Provides one stable API surface: listKeys / computeMetric / computeBatch.
 *
 * KEEP IN MIND
 * - Scope RBAC should be enforced here OR in a separate guard layer.
 *   This engine contains a minimal "allowed scope per key" policy.
 */
export class TeamManagementKpiEngine {
  // --------------------------------------------------------------------------
  // Services (module-wise)
  // --------------------------------------------------------------------------

  private readonly teamMain: TeamMainKpiService;
  private readonly teamTask: TeamTaskKpiService;
  private readonly workItem: WorkItemKpiService;
  private readonly workEvent: WorkEventKpiService;
  private readonly milestone: MilestoneKpiService;
  private readonly memberActivity: MemberActivityKpiService;

  public constructor() {
    this.teamMain = new TeamMainKpiService();
    this.teamTask = new TeamTaskKpiService();
    this.workItem = new WorkItemKpiService();
    this.workEvent = new WorkEventKpiService();
    this.milestone = new MilestoneKpiService();
    this.memberActivity = new MemberActivityKpiService();
  }

  // --------------------------------------------------------------------------
  // Key registry (single source of truth)
  // --------------------------------------------------------------------------

  /**
   * KPI_KEYS
   *
   * - as const gives you a literal union type.
   * - This becomes the canonical allowed keys list.
   */
  public static readonly KPI_KEYS = [
    // Team Main
    "tm.teamMain.teamCount",
    "tm.teamMain.memberCount",
    "tm.teamMain.activeTeams",

    // Team Task
    "tm.teamTask.completionRate",
    "tm.teamTask.overdueCount",
    "tm.teamTask.topOverdueHolders",

    // Work Item
    "tm.workItem.statusDistribution",
    "tm.workItem.priorityDistribution",
    "tm.workItem.completedCount",

    // Work Event
    "tm.workEvent.eventCount",
    "tm.workEvent.todayCount",
    "tm.workEvent.typeDistribution",

    // Milestone
    "tm.milestone.completedRate",
    "tm.milestone.activeCount",
    "tm.milestone.overdueCount",

    // Member Activity
    "tm.memberActivity.activeUsers",
    "tm.memberActivity.activityCount",
    "tm.memberActivity.topActiveUsers",
  ] as const;

  /**
   * TeamManagementKpiKey
   * - strict union of allowed keys derived from KPI_KEYS
   */
  public static readonly KPI_KEY_SET: ReadonlySet<string> = new Set<string>(TeamManagementKpiEngine.KPI_KEYS);

  public type!: never; // (intentional: prevents TS from auto-converting class to namespace in some setups)

  // NOTE: declare type alias via `export type` below the class in your codebase if you prefer.
  // Here we expose it via a method-driven pattern to avoid namespace merges.

  /**
   * listKeys()
   *
   * - Used by /keys endpoint so frontend can render dropdowns safely.
   */
  public listKeys(): Array<{ key: TeamManagementKpiEngine.TeamManagementKpiKey; scopes: Array<"member" | "team" | "org">; label: string }> {
    return TeamManagementKpiEngine.KPI_KEYS.map((k) => ({
      key: k,
      scopes: this.getAllowedScopesForKey(k),
      label: this.getLabelForKey(k),
    }));
  }

  /**
   * isKey()
   *
   * - Type guard to convert untrusted string -> strict union type.
   */
  public isKey(key: string): key is TeamManagementKpiEngine.TeamManagementKpiKey {
    return TeamManagementKpiEngine.KPI_KEY_SET.has(key);
  }

  /**
   * computeMetric()
   *
   * @param input.key
   * - MUST be validated via isKey() in caller
   */
  public async computeMetric(input: {
    key: TeamManagementKpiEngine.TeamManagementKpiKey;
    target: KpiTarget;
    window: KpiWindow;
    filters?: KpiFilters;
  }): Promise<unknown> {
    this.assertScopeAllowed(input.key, input.target.scope);

    // Dispatch by key
    switch (input.key) {
      // ----------------------------------------------------------------------
      // Team Main
      // ----------------------------------------------------------------------
      case "tm.teamMain.teamCount":
        return await this.teamMain.teamCount(this.buildServiceInput(input));
      case "tm.teamMain.memberCount":
        return await this.teamMain.memberCount(this.buildServiceInput(input));
      case "tm.teamMain.activeTeams":
        return await this.teamMain.activeTeams(this.buildServiceInput(input));

      // ----------------------------------------------------------------------
      // Team Task
      // ----------------------------------------------------------------------
      case "tm.teamTask.completionRate":
        return await this.teamTask.completionRate(this.buildServiceInput(input));
      case "tm.teamTask.overdueCount":
        return await this.teamTask.overdueCount(this.buildServiceInput(input));
      case "tm.teamTask.topOverdueHolders":
        return await this.teamTask.topOverdueHolders(this.buildServiceInput(input));

      // ----------------------------------------------------------------------
      // Work Item
      // ----------------------------------------------------------------------
      case "tm.workItem.statusDistribution":
        return await this.workItem.statusDistribution(this.buildServiceInput(input));
      case "tm.workItem.priorityDistribution":
        return await this.workItem.priorityDistribution(this.buildServiceInput(input));
      case "tm.workItem.completedCount":
        return await this.workItem.completedCount(this.buildServiceInput(input));

      // ----------------------------------------------------------------------
      // Work Event
      // ----------------------------------------------------------------------
      case "tm.workEvent.eventCount":
        return await this.workEvent.eventCount(this.buildServiceInput(input));
      case "tm.workEvent.todayCount":
        return await this.workEvent.todayCount(this.buildServiceInput(input));
      case "tm.workEvent.typeDistribution":
        return await this.workEvent.typeDistribution(this.buildServiceInput(input));

      // ----------------------------------------------------------------------
      // Milestone
      // ----------------------------------------------------------------------
      case "tm.milestone.completedRate":
        return await this.milestone.completedRate(this.buildServiceInput(input));
      case "tm.milestone.activeCount":
        return await this.milestone.activeCount(this.buildServiceInput(input));
      case "tm.milestone.overdueCount":
        return await this.milestone.overdueCount(this.buildServiceInput(input));

      // ----------------------------------------------------------------------
      // Member Activity
      // ----------------------------------------------------------------------
      case "tm.memberActivity.activeUsers":
        return await this.memberActivity.activeUsers(this.buildServiceInput(input));
      case "tm.memberActivity.activityCount":
        return await this.memberActivity.activityCount(this.buildServiceInput(input));
      case "tm.memberActivity.topActiveUsers":
        return await this.memberActivity.topActiveUsers(this.buildServiceInput(input));

      default:
        // TS should never reach here because input.key is a union.
        return { error: "Unknown KPI key" };
    }
  }

  /**
   * computeBatch()
   *
   * - Computes multiple KPI keys for a dashboard in one request.
   * - Returns { [key]: metricResult } (no throwing for individual failures).
   *
   * IMPORTANT
   * - Keeps API resilient: one broken KPI should not break the whole dashboard.
   */
  public async computeBatch(input: {
    keys: Array<TeamManagementKpiEngine.TeamManagementKpiKey>;
    target: KpiTarget;
    window: KpiWindow;
    filters?: KpiFilters;
  }): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};

    for (const key of input.keys) {
      try {
        const metric = await this.computeMetric({
          key,
          target: input.target,
          window: input.window,
          ...(input.filters ? { filters: input.filters } : {}),
        });

        out[key] = metric;
      } catch (error: unknown) {
        out[key] = {
          error: "KPI compute failed",
          // Keep it minimal (no sensitive info). Logs belong server-side.
        };
      }
    }

    return out;
  }

  // --------------------------------------------------------------------------
  // Internal utilities
  // --------------------------------------------------------------------------

  private buildServiceInput(input: {
    target: KpiTarget;
    window: KpiWindow;
    filters?: KpiFilters;
  }): { target: KpiTarget; window: KpiWindow; filters?: KpiFilters } {
    // exactOptionalPropertyTypes-safe: omit filters when undefined
    return {
      target: input.target,
      window: input.window,
      ...(input.filters ? { filters: input.filters } : {}),
    };
  }

  private assertScopeAllowed(key: TeamManagementKpiEngine.TeamManagementKpiKey, scope: "member" | "team" | "org"): void {
    const allowed = this.getAllowedScopesForKey(key);
    if (!allowed.includes(scope)) {
      throw new Error(`Scope not allowed for KPI key: ${key}`);
    }
  }

  private getAllowedScopesForKey(key: TeamManagementKpiEngine.TeamManagementKpiKey): Array<"member" | "team" | "org"> {
    // Keep policy simple and explicit.
    // You can later make this depend on system role / team job role in the guard layer.
    switch (key) {
      // Org-only (example: counting teams is meaningless for member)
      case "tm.teamMain.teamCount":
      case "tm.teamMain.memberCount":
      case "tm.teamMain.activeTeams":
        return ["org"];

      // Member / Team / Org
      case "tm.teamTask.completionRate":
      case "tm.teamTask.overdueCount":
      case "tm.workItem.statusDistribution":
      case "tm.workItem.priorityDistribution":
      case "tm.workItem.completedCount":
      case "tm.workEvent.eventCount":
      case "tm.workEvent.todayCount":
      case "tm.workEvent.typeDistribution":
      case "tm.milestone.completedRate":
      case "tm.milestone.activeCount":
      case "tm.milestone.overdueCount":
      case "tm.memberActivity.activeUsers":
      case "tm.memberActivity.activityCount":
      case "tm.memberActivity.topActiveUsers":
        return ["member", "team", "org"];

      // Team / Org only
      case "tm.teamTask.topOverdueHolders":
        return ["team", "org"];

      default:
        return ["member"];
    }
  }

  private getLabelForKey(key: TeamManagementKpiEngine.TeamManagementKpiKey): string {
    switch (key) {
      case "tm.teamMain.teamCount":
        return "Teams: Total";
      case "tm.teamMain.memberCount":
        return "Teams: Total Members";
      case "tm.teamMain.activeTeams":
        return "Teams: Active";

      case "tm.teamTask.completionRate":
        return "Team Tasks: Completion Rate";
      case "tm.teamTask.overdueCount":
        return "Team Tasks: Overdue Count";
      case "tm.teamTask.topOverdueHolders":
        return "Team Tasks: Top Overdue Holders";

      case "tm.workItem.statusDistribution":
        return "Work Items: Status Distribution";
      case "tm.workItem.priorityDistribution":
        return "Work Items: Priority Distribution";
      case "tm.workItem.completedCount":
        return "Work Items: Completed Count";

      case "tm.workEvent.eventCount":
        return "Work Events: Count";
      case "tm.workEvent.todayCount":
        return "Work Events: Today";
      case "tm.workEvent.typeDistribution":
        return "Work Events: Type Distribution";

      case "tm.milestone.completedRate":
        return "Milestones: Completed Rate";
      case "tm.milestone.activeCount":
        return "Milestones: Active Count";
      case "tm.milestone.overdueCount":
        return "Milestones: Overdue Count";

      case "tm.memberActivity.activeUsers":
        return "Member Activity: Active Users";
      case "tm.memberActivity.activityCount":
        return "Member Activity: Activity Count";
      case "tm.memberActivity.topActiveUsers":
        return "Member Activity: Top Active Users";

      default:
        return key;
    }
  }
}

// ============================================================================
// Type export (clean, reusable in router + controller)
// ============================================================================

export namespace TeamManagementKpiEngine  {
  export type TeamManagementKpiKey = (typeof TeamManagementKpiEngine.KPI_KEYS)[number];
}