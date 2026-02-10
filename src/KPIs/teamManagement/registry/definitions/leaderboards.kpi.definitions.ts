// ============================================================================
// Path: src/KPIs/registry/definitions/leaderboards.kpi.definitions.ts
// ============================================================================
// KPI Definitions (Leaderboards)
// ----------------------------------------------------------------------------
// Purpose:
//   Table-focused KPIs (leaderboards).
//
// Included KPIs:
//   1) top_agents_by_value
// ============================================================================

import type {
  KpiDefinitionMeta,
  KpiQueryFilters,
  KpiQueryTarget,
  KpiSeries,
  KpiSnapshotItem,
  KpiTable,
  KpiTableColumn,
  KpiTableRow,
} from '../../../shared/kpi-core.types';

import type { KpiDbWindow } from '../../../data/kpi-query.service';
import { BaseKpiDefinition, type KpiDefinitionContext } from '../base/base-kpi.definition';

export class TopAgentsByValueKpi extends BaseKpiDefinition {
  public readonly meta: KpiDefinitionMeta = {
    id: 'top_agents_by_value',
    domain: 'members',
    title: 'Top Agents (by Total Value)',
    description: 'Leaderboard ranking agents by total deal value, including counts and commission.',
    visual: 'leaderboard',
    primaryUnit: 'money',
    supportsPercent: false,
    supportsActuals: true,
    supportedScopes: ['team', 'org', 'branch', 'region'],
  };

  public async computeSnapshot(): Promise<ReadonlyArray<KpiSnapshotItem>> {
    // Leaderboards are not snapshots.
    return [];
  }

  public async computeSeries(): Promise<ReadonlyArray<KpiSeries>> {
    return [];
  }

  public async computeTable(
    ctx: KpiDefinitionContext,
    target: KpiQueryTarget,
    window: KpiDbWindow,
    filters?: KpiQueryFilters,
  ): Promise<ReadonlyArray<KpiTable>> {
    const rows = await ctx.query.getTopAgents(target, window, filters, 10);

    const columns: ReadonlyArray<KpiTableColumn> = [
      { key: 'dealCount', label: 'Deals', unit: 'count' },
      { key: 'saleCount', label: 'Sale Deals', unit: 'count' },
      { key: 'rentCount', label: 'Rent Deals', unit: 'count' },
      { key: 'totalValue', label: 'Total Value', unit: 'money' },
      { key: 'commissionTotal', label: 'Commission', unit: 'money' },
    ];

    const currencyCode: string = (filters?.currencyCode ? String(filters.currencyCode).toUpperCase() : 'LKR');

    const tableRows: KpiTableRow[] = rows.map((r) => {
      const row: KpiTableRow = {
        id: r.agentId,
        // label will be replaced later by registry using user enrichment (optional).
        label: `Agent ${r.agentId}`,
        cells: {
          dealCount: { actuals: [{ key: 'dealCount', unit: 'count', value: r.dealCount }] },
          saleCount: { actuals: [{ key: 'saleCount', unit: 'count', value: r.saleCount }] },
          rentCount: { actuals: [{ key: 'rentCount', unit: 'count', value: r.rentCount }] },
          totalValue: { actuals: [{ key: 'totalValue', unit: 'money', value: r.totalValue, currencyCode }] },
          commissionTotal: { actuals: [{ key: 'commissionTotal', unit: 'money', value: r.commissionTotal, currencyCode }] },
        },
      };

      return row;
    });

    const table: KpiTable = {
      meta: this.meta,
      columns,
      rows: tableRows,
      computedAtISO: new Date().toISOString(),
    };

    return [table];
  }
}
