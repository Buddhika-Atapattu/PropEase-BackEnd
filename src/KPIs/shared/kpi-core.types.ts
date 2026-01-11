// ============================================================================
// Path: src/KPIs/shared/kpi-core.types.ts
// ============================================================================
// KPI Core Types (Single Source of Truth)
// ----------------------------------------------------------------------------
// Why this file exists:
//   You want KPIs that show BOTH:
//     1) percentage values (0..100%)
//     2) actual values (money, count, duration, etc.) for charts/tables
//
//   Also you want KPIs across large real estate company scopes:
//     - member (agent/employee)
//     - team
//     - org (whole company)
//     - property
//     - branch, region (common in real estate)
// ----------------------------------------------------------------------------
// Rules:
//   - All percentages are 0..100 (never 0..1)
//   - KPI payload must support:
//       - snapshot cards (single value)
//       - time series charts (line/bar/stacked)
//       - tables (leaderboards, rankings)
//   - Keep this file generic; domain-specific types go elsewhere.
// ============================================================================

/**
 * KPI Domain = which business area the KPI belongs to.
 * Real estate needs more than "teams". It needs properties + maintenance + org.
 */
export type KpiDomain =
  | 'properties'
  | 'maintenance'
  | 'team'
  | 'members'
  | 'organisation';

/**
 * KPI Scope = what level we are calculating KPIs for.
 * - member: single agent/employee
 * - team: a team of people
 * - org: entire company
 * - property: single property KPIs
 * - branch/region: realistic real estate company breakdown
 */
export type KpiScope =
  | 'member'
  | 'team'
  | 'org'
  | 'property'
  | 'branch'
  | 'region';

/**
 * Window presets. These are "client-friendly shortcuts".
 * We also support custom date ranges.
 */
export type KpiWindowPreset = '7d' | '30d' | '90d' | 'ytd' | 'custom';

/**
 * Chart granularity defines how points are grouped.
 * Example: window=90d + granularity=week => 13 points (approx).
 */
export type KpiGranularity = 'day' | 'week' | 'month' | 'quarter';

/**
 * Full window definition used by all KPI requests.
 * Important:
 * - keep timezone as explicit text to avoid server/client mismatch
 * - time range uses ISO strings so it stays stable across FE and BE
 */
export interface KpiTimeWindow {
  preset: KpiWindowPreset;
  fromISO: string;
  toISO: string;
  granularity: KpiGranularity;
  timezone: string; // example: 'Asia/Colombo'
}

/**
 * KPI unit types.
 * - percent: ALWAYS 0..100
 * - count: integer values
 * - money: requires currency code
 * - duration_ms: time durations for response/resolution KPIs
 * - rating_1_5: raw satisfaction rating
 *
 * NOTE:
 * - We keep "percent" separate because the system requires every KPI to
 *   return percentage when meaningful, plus actuals for tables/charts.
 */
export type KpiUnit =
  | 'percent'
  | 'count'
  | 'money'
  | 'duration_ms'
  | 'rating_1_5';

/**
 * UI "visual hint" for the frontend. This is optional but very useful.
 * It helps FE auto-render KPI responses without hard-coding everywhere.
 */
export type KpiVisualType =
  | 'card'
  | 'line'
  | 'bar'
  | 'stacked_bar'
  | 'donut'
  | 'table'
  | 'leaderboard';

/**
 * An "actual" value that is shown alongside %.
 * Example for sale vs rent KPI:
 * - % sale, % rent
 * - actual: saleCount, rentCount, saleValue, rentValue, commission
 */
export interface KpiActualValue {
  /**
   * ID so that FE can place the number in charts/tables.
   * Example: "saleCount", "rentValue", "commissionTotal"
   */
  key: string;

  /**
   * Unit for the value.
   */
  unit: Exclude<KpiUnit, 'percent'>;

  /**
   * The numeric value.
   * - count: integer
   * - money: decimal
   * - duration_ms: ms
   * - rating_1_5: 1..5
   */
  value: number;

  /**
   * currencyCode is required when unit is "money"
   * Example: "LKR", "USD"
   */
  currencyCode?: string;

  /**
   * Optional label for UI tables
   */
  label?: string;
}

/**
 * Percent value.
 * Always 0..100.
 */
export interface KpiPercentValue {
  unit: 'percent';
  value: number; // 0..100
}

/**
 * KPI value container.
 * Why it is structured like this:
 * - A single KPI often needs both % and actuals.
 * - We keep % separate so it is guaranteed to be 0..100.
 * - actuals is an array to support multiple numbers per KPI.
 */
export interface KpiMetricValue {
  /**
   * Optional primary percent.
   * Some KPIs have one percent (ex: occupancy rate).
   */
  percent?: KpiPercentValue;

  /**
   * Optional secondary percents.
   * Used when KPI has multiple percent outputs.
   * Example: sale vs rent ratio:
   *   - salePercent
   *   - rentPercent
   */
  percents?: ReadonlyArray<{
    key: string; // "salePercent", "rentPercent"
    value: KpiPercentValue;
    label?: string;
  }>;

  /**
   * Actual values (count/money/duration/rating).
   * These are used for charts and tables.
   */
  actuals?: ReadonlyArray<KpiActualValue>;

  /**
   * Optional targets (goal setting)
   * Example: SLA compliance target 95%
   */
  targetPercent?: number; // 0..100

  /**
   * Optional notes for UI (ex: "Low sample size")
   */
  note?: string;
}

/**
 * KPI definition metadata used by the registry.
 * It allows:
 * - auto listing KPIs
 * - FE dynamic rendering hints
 * - strong contract of what each KPI represents
 */
export interface KpiDefinitionMeta {
  id: string; // stable KPI ID string (example: "member_sale_rent_ratio")
  domain: KpiDomain;

  title: string;
  description: string;

  visual: KpiVisualType;

  /**
   * The unit that is the "main highlight" (usually percent).
   */
  primaryUnit: KpiUnit;

  /**
   * These flags enforce your requirement:
   * - percent always exists where meaningful
   * - actuals exist for chart/table values
   */
  supportsPercent: boolean;
  supportsActuals: boolean;

  /**
   * Scopes where this KPI is valid.
   * Example: "member_sale_rent_ratio" valid in member/team/org scopes.
   */
  supportedScopes: ReadonlyArray<KpiScope>;
}

/**
 * A single KPI card snapshot item.
 * Example: Occupancy rate for org in last 30 days.
 */
export interface KpiSnapshotItem {
  meta: KpiDefinitionMeta;
  value: KpiMetricValue;
  computedAtISO: string;
}

/**
 * Time series point for charts.
 */
export interface KpiSeriesPoint {
  tISO: string; // timestamp of bucket start or label point
  value: KpiMetricValue;
}

/**
 * A chart series result for a KPI.
 */
export interface KpiSeries {
  meta: KpiDefinitionMeta;
  points: ReadonlyArray<KpiSeriesPoint>;
  computedAtISO: string;
}

/**
 * Table column definition for KPI tables.
 */
export interface KpiTableColumn {
  key: string;
  label: string;
  unit: KpiUnit;
}

/**
 * Each row in KPI table.
 * Example: Top agents table row:
 * - id: agentId
 * - label: agentName (optional)
 * - cells: keys -> KPI metric values
 */
export interface KpiTableRow {
  id: string;
  label: string;
  cells: Record<string, KpiMetricValue>;
}

/**
 * KPI table / leaderboard structure.
 */
export interface KpiTable {
  meta: KpiDefinitionMeta;
  columns: ReadonlyArray<KpiTableColumn>;
  rows: ReadonlyArray<KpiTableRow>;
  computedAtISO: string;
}

/**
 * Target definition: what KPI is requested and where.
 */
export interface KpiQueryTarget {
  scope: KpiScope;
  targetId: string; // memberId/teamId/orgId/propertyId/branchId/regionId
}

/**
 * Filters support real estate segmentation.
 * You can add fields later without breaking old clients.
 */
export interface KpiQueryFilters {
  /**
   * Real estate segmentation
   */
  regionId?: string;
  branchId?: string;

  /**
   * Property-related segmentation
   */
  propertyType?: 'apartment' | 'house' | 'land' | 'commercial' | 'other';

  /**
   * Deal-related segmentation
   */
  dealType?: 'sale' | 'rent';
  currencyCode?: string;

  /**
   * Member/team segmentation
   */
  agentId?: string;
  teamId?: string;

  /**
   * Maintenance segmentation
   */
  priority?: 'low' | 'medium' | 'high' | 'urgent';
}

/**
 * WS/REST payload for requesting KPIs.
 * This is reusable across API and WS.
 */
export interface KpiRequestPayload {
  domain: KpiDomain;
  target: KpiQueryTarget;
  window: KpiTimeWindow;

  /**
   * KPI IDs requested. If empty/undefined => server default set.
   */
  kpiIds?: ReadonlyArray<string>;

  /**
   * Optional segmentation filters.
   */
  filters?: KpiQueryFilters;

  /**
   * Mode defines what shape is expected:
   * - snapshot: returns cards (KpiSnapshotItem[])
   * - series: returns chart series (KpiSeries[])
   * - table: returns tables/leaderboards (KpiTable[])
   */
  mode: 'snapshot' | 'series' | 'table';
}
