// ============================================================================
// Path: src/KPIs/registry/kpi.registry.ts
// ============================================================================
// KPI Registry
// ----------------------------------------------------------------------------
// Purpose:
//   Central place that knows:
//     - which KPI ids exist
//     - which class computes each KPI
//     - how to execute a KPI request by mode (snapshot/series/table)
//
// This is the layer that higher systems call:
//   - REST controllers (submit triggers / manual refresh)
//   - WebSocket engine (push updates)
// ----------------------------------------------------------------------------
// Strict TS rules:
//   - No `any`
//   - Strong typed maps
//   - Validate KPI ids at runtime
// ============================================================================

import type {
  KpiRequestPayload,
  KpiSnapshotItem,
  KpiSeries,
  KpiTable,
} from '../shared/kpi-core.types';

import type { KpiDbWindow } from '../data/kpi-query.service';
import { KpiQueryService } from '../data/kpi-query.service';

import { BaseKpiDefinition, type KpiDefinitionContext } from './base/base-kpi.definition';

import {
  MemberSaleRentMixKpi,
  MemberCommissionEfficiencyKpi,
  MemberCustomerSatisfactionKpi,
  MaintenanceSlaComplianceKpi,
  TeamTaskCompletionRateKpi,
} from './definitions/team-management.kpi.definitions';

import { TopAgentsByValueKpi } from './definitions/leaderboards.kpi.definitions';

export interface KpiRegistryResult {
  snapshots: ReadonlyArray<KpiSnapshotItem>;
  series: ReadonlyArray<KpiSeries>;
  tables: ReadonlyArray<KpiTable>;
}

/**
 * KPI Registry Implementation.
 * This class owns:
 *   - KPI list
 *   - id->definition map
 *   - execution routing by mode
 */
export class KpiRegistry {
  private readonly queryService: KpiQueryService;
  private readonly ctx: KpiDefinitionContext;

  private readonly defs: ReadonlyArray<BaseKpiDefinition>;
  private readonly byId: ReadonlyMap<string, BaseKpiDefinition>;

  public constructor(queryService?: KpiQueryService) {
    // Allow injection for testing, but default is real query service.
    this.queryService = queryService ?? new KpiQueryService();

    // Context passed into all definitions (loose coupling).
    this.ctx = {
      query: {
        getSaleRentMix: this.queryService.getSaleRentMix.bind(this.queryService),
        getCommissionEfficiency: this.queryService.getCommissionEfficiency.bind(this.queryService),
        getCustomerSatisfaction: this.queryService.getCustomerSatisfaction.bind(this.queryService),
        getMaintenanceSlaCompliance: this.queryService.getMaintenanceSlaCompliance.bind(this.queryService),
        getTaskCompletionRate: this.queryService.getTaskCompletionRate.bind(this.queryService),
        getTopAgents: this.queryService.getTopAgents.bind(this.queryService),
      },
    };

    // Register KPI definitions here (single source of truth).
    this.defs = [
      new MemberSaleRentMixKpi(),
      new MemberCommissionEfficiencyKpi(),
      new MemberCustomerSatisfactionKpi(),
      new MaintenanceSlaComplianceKpi(),
      new TeamTaskCompletionRateKpi(),
      new TopAgentsByValueKpi(),
    ] as const;

    // Build id -> definition map.
    const map = new Map<string, BaseKpiDefinition>();
    for (const d of this.defs) {
      map.set(d.meta.id, d);
    }
    this.byId = map;
  }

  /**
   * List all KPI definitions (for UI KPI picker).
   */
  public listDefinitions(): ReadonlyArray<import('../shared/kpi-core.types').KpiDefinitionMeta> {
    return this.defs.map((d) => d.meta);
  }

  /**
   * Execute a KPI request payload.
   * The payload can request multiple KPI ids in one call.
   */
  public async execute(
    payload: KpiRequestPayload,
    window: KpiDbWindow,
  ): Promise<KpiRegistryResult> {
    const requestedIds: ReadonlyArray<string> = this.resolveRequestedKpis(payload.kpiIds);

    const snapshots: KpiSnapshotItem[] = [];
    const series: KpiSeries[] = [];
    const tables: KpiTable[] = [];

    for (const id of requestedIds) {
      const def = this.byId.get(id);
      if (!def) continue;

      // Mode routing:
      // snapshot => computeSnapshot
      // series   => computeSeries
      // table    => computeTable
      if (payload.mode === 'snapshot') {
        const items = await def.computeSnapshot(this.ctx, payload.target, window, payload.filters);
        for (const it of items) snapshots.push(it);
      }

      if (payload.mode === 'series') {
        const items = await def.computeSeries(this.ctx, payload.target, window, payload.filters);
        for (const it of items) series.push(it);
      }

      if (payload.mode === 'table') {
        const items = await def.computeTable(this.ctx, payload.target, window, payload.filters);
        for (const it of items) tables.push(it);
      }
    }

    return { snapshots, series, tables };
  }

  // =========================================================================
  // INTERNAL HELPERS
  // =========================================================================

  /**
   * Resolve requested KPI ids.
   * If undefined/empty => return a default set suitable for dashboards.
   */
  private resolveRequestedKpis(kpiIds?: ReadonlyArray<string>): ReadonlyArray<string> {
    if (kpiIds && kpiIds.length > 0) return kpiIds;

    // Default dashboard KPIs (safe set):
    return [
      'member_sale_rent_mix',
      'member_commission_efficiency',
      'member_customer_satisfaction',
      'maintenance_sla_compliance',
      'team_task_completion_rate',
    ] as const;
  }
}
