// ============================================================================
// Path: src/KPIs/teamManagement/kpi.keys.ts
// ============================================================================

/* ============================================================================
 * Team Management KPI Keys (Module-wise)
 * ----------------------------------------------------------------------------
 * INTRODUCTION
 * - Single source of truth for KPI keys under Team Management.
 * - Covers 6 sections:
 *   1) teamMain
 *   2) teamTask
 *   3) workItem
 *   4) workEvent
 *   5) milestone
 *   6) memberActivity
 *
 * IMPORTANT MATTERS
 * - Keys are stable API identifiers.
 * - Frontend uses keys to request metrics.
 * - Engines use keys to dispatch to correct computation service.
 *
 * WHY WE MAKE THIS FILE
 * - Prevents string duplication across routers/services.
 * - Makes it easy to audit what KPIs exist for the module.
 * ========================================================================== */

export const TM_KPI_KEYS = [
  // --------------------------------------------------------------------------
  // Team Main
  // --------------------------------------------------------------------------
  "tm.teamMain.teamCount",
  "tm.teamMain.memberCount",
  "tm.teamMain.activeTeams",

  // --------------------------------------------------------------------------
  // Team Tasks
  // --------------------------------------------------------------------------
  "tm.teamTask.completionRate",
  "tm.teamTask.overdueCount",
  "tm.teamTask.topOverdueHolders",

  // --------------------------------------------------------------------------
  // Work Items
  // --------------------------------------------------------------------------
  "tm.workItem.statusDistribution",
  "tm.workItem.priorityDistribution",
  "tm.workItem.completedCount",

  // --------------------------------------------------------------------------
  // Work Events
  // --------------------------------------------------------------------------
  "tm.workEvent.eventCount",
  "tm.workEvent.todayCount",
  "tm.workEvent.typeDistribution",

  // --------------------------------------------------------------------------
  // Milestones
  // --------------------------------------------------------------------------
  "tm.milestone.completedRate",
  "tm.milestone.activeCount",
  "tm.milestone.overdueCount",

  // --------------------------------------------------------------------------
  // Member Activities
  // --------------------------------------------------------------------------
  "tm.memberActivity.activeUsers",
  "tm.memberActivity.activityCount",
  "tm.memberActivity.topActiveUsers",
] as const;

export type TeamManagementKpiKey = (typeof TM_KPI_KEYS)[number];