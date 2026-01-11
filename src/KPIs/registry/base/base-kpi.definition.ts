// ============================================================================
// Path: src/KPIs/registry/base/base-kpi.definition.ts
// ============================================================================
// KPI Base Definition Contract (Registry Layer)
// ----------------------------------------------------------------------------
// Purpose:
//   Provide a strict, consistent way to register KPIs and compute them.
//   Each KPI definition:
//
//     - declares metadata (id/title/domain/scopes/visual)
//     - knows how to compute:
//         - snapshot (card)
//         - series (chart)
//         - table  (leaderboard/table)
//
//   The registry orchestrates these definitions.
// ----------------------------------------------------------------------------
// Why a base class (instead of plain objects):
//   - Keeps strong typing + intellisense
//   - Encapsulates logic (mapping, validation, shared helpers)
//   - Avoids fragile “string maps” scattered around the codebase
// ----------------------------------------------------------------------------
// Notes on TypeScript strictness (new TS versions):
//   - No `any`
//   - Optional properties are set ONLY when values exist (exactOptionalPropertyTypes-safe)
// ============================================================================

import type {
  KpiDefinitionMeta,
  KpiQueryFilters,
  KpiQueryTarget,
  KpiSeries,
  KpiSnapshotItem,
  KpiTable,
} from '../../shared/kpi-core.types';
import type { KpiDbWindow } from '../../data/kpi-query.service';

/**
 * Registry context:
 * We pass shared services/utilities to definitions through this context to keep
 * loose coupling. Definitions do not new-up DB services.
 */
export interface KpiDefinitionContext {
  // DB query engine (aggregation methods)
  query: {
    getSaleRentMix: (target: KpiQueryTarget, window: KpiDbWindow, filters?: KpiQueryFilters) => Promise<import('../../shared/kpi-core.types').KpiMetricValue>;
    getCommissionEfficiency: (target: KpiQueryTarget, window: KpiDbWindow, filters?: KpiQueryFilters) => Promise<import('../../shared/kpi-core.types').KpiMetricValue>;
    getCustomerSatisfaction: (target: KpiQueryTarget, window: KpiDbWindow, filters?: KpiQueryFilters) => Promise<import('../../shared/kpi-core.types').KpiMetricValue>;
    getMaintenanceSlaCompliance: (target: KpiQueryTarget, window: KpiDbWindow, filters?: KpiQueryFilters) => Promise<import('../../shared/kpi-core.types').KpiMetricValue>;
    getTaskCompletionRate: (target: KpiQueryTarget, window: KpiDbWindow, filters?: KpiQueryFilters) => Promise<import('../../shared/kpi-core.types').KpiMetricValue>;
    getTopAgents: (target: KpiQueryTarget, window: KpiDbWindow, filters?: KpiQueryFilters, limit?: number) => Promise<ReadonlyArray<import('../../data/kpi-query.service').KpiTopAgentRow>>;
  };
}

/**
 * Base definition:
 * - Concrete KPI definitions extend this and implement required methods.
 */
export abstract class BaseKpiDefinition {
  // Metadata is constant and never changes at runtime.
  public abstract readonly meta: KpiDefinitionMeta;

  /**
   * Snapshot (card) output.
   * If KPI does not support snapshot mode, return empty array.
   */
  public abstract computeSnapshot(
    ctx: KpiDefinitionContext,
    target: KpiQueryTarget,
    window: KpiDbWindow,
    filters?: KpiQueryFilters,
  ): Promise<ReadonlyArray<KpiSnapshotItem>>;

  /**
   * Series output (chart).
   * If KPI does not support series mode, return empty array.
   *
   * NOTE:
   * Series typically requires bucket windows (day/week/month).
   * We will implement a shared time-bucketing helper later.
   */
  public abstract computeSeries(
    ctx: KpiDefinitionContext,
    target: KpiQueryTarget,
    window: KpiDbWindow,
    filters?: KpiQueryFilters,
  ): Promise<ReadonlyArray<KpiSeries>>;

  /**
   * Table output (leaderboard/table).
   * If KPI does not support table mode, return empty array.
   */
  public abstract computeTable(
    ctx: KpiDefinitionContext,
    target: KpiQueryTarget,
    window: KpiDbWindow,
    filters?: KpiQueryFilters,
  ): Promise<ReadonlyArray<KpiTable>>;

  // =========================================================================
  // Shared Helpers (optional-property safe)
  // =========================================================================

  /**
   * Sets note only when noteText exists.
   * This avoids "note: undefined" problems in strict TS configs.
   */
  protected attachNote<T extends { note?: string }>(base: T, noteText: string | null): T {
    if (noteText) {
      base.note = noteText;
    }
    return base;
  }
}
