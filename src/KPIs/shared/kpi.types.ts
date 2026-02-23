// ============================================================================
// Path: src/KPIs/shared/kpi.types.ts
// ============================================================================

/* ============================================================================
 * KPI Shared Types (Module-wise KPI Architecture)
 * ----------------------------------------------------------------------------
 * INTRODUCTION
 * - Shared contracts used by all KPI modules (teamManagement, leaseManagement,
 *   payments, propertyManagement, ...).
 * - No domain-model imports here (no TeamTaskModel, no LeaseModel).
 *
 * IMPORTANT MATTERS
 * - DTO-safe: IDs are strings.
 * - Optional fields are modeled so callers can omit them safely.
 * - Designed to work with role/job-role enforced scope checks (see kpi.guard.ts).
 *
 * WHY WE MAKE THIS FILE
 * - Keeps KPI engines consistent across modules.
 * - Prevents KPI spaghetti and tight coupling between modules.
 * ========================================================================== */

export type KpiScope = "member" | "team" | "org";

/**
 * KPI Time Window
 *
 * @param from
 * - Expected: Date (validated by KpiWindowParser)
 *
 * @param to
 * - Expected: Date (validated by KpiWindowParser)
 */
export interface KpiWindow {
  from: Date;
  to: Date;
}

/**
 * KPI Query Target
 *
 * @param scope
 * - Expected: "member" | "team" | "org"
 *
 * @param targetId
 * - Expected:
 *   - scope=member -> userId (string) or username (string) depending on module policy
 *   - scope=team   -> teamCode or teamMongoId as string (module decides)
 *   - scope=org    -> orgId as string (if you add org support later)
 */
export interface KpiTarget {
  scope: KpiScope;
  targetId: string;
}

/**
 * KPI Filters (generic, JSON-safe)
 *
 * Notes:
 * - KPI modules can define their own richer filter types and narrow this.
 * - Keep values JSON-safe: string/number/boolean/string[]/number[].
 */
export type KpiFilters = Record<string, string | number | boolean | string[] | number[]>;

/**
 * KPI Metric Envelope (stable response shape)
 *
 * WHY THIS EXISTS
 * - Makes FE handling consistent and makes realtime emission trivial later.
 * - Every KPI endpoint can return { metric: KpiMetricEnvelope<T> }.
 *
 * @template TValue
 * - The computed KPI value payload (module-defined).
 */
export interface KpiMetricEnvelope<TValue> {
  key: string;
  scope: KpiScope;
  targetId: string;

  window: {
    fromISO: string;
    toISO: string;
  };

  generatedAtISO: string;
  value: TValue;
}

/**
 * KPI Engine Request (internal module engine input)
 *
 * @param key
 * - KPI key e.g. "tm.teamTask.completionRate"
 *
 * @param target
 * - scope + targetId after scope enforcement
 *
 * @param window
 * - validated from/to dates
 *
 * @param filters
 * - optional JSON-safe filters
 */
export interface KpiEngineRequest {
  key: string;
  target: KpiTarget;
  window: KpiWindow;
  filters?: KpiFilters;
}

/**
 * KPI Definition
 * - A registered KPI computation unit.
 */
export interface KpiDefinition<TValue> {
  key: string;
  allowedScopes: ReadonlyArray<KpiScope>;
  compute(input: {
    target: KpiTarget;
    window: KpiWindow;
    filters?: KpiFilters;
  }): Promise<TValue>;
}