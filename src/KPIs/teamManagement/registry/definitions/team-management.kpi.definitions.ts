// ============================================================================
// Path: src/KPIs/registry/definitions/team-management.kpi.definitions.ts
// ============================================================================
// KPI Definitions (Team Management + Property + Maintenance + Member)
// ----------------------------------------------------------------------------
// Purpose:
//   Concrete KPI definitions that map KPI ids to DB query service methods.
// ----------------------------------------------------------------------------
// Included KPIs:
//   1) member_sale_rent_mix
//   2) member_commission_efficiency
//   3) member_customer_satisfaction
//   4) maintenance_sla_compliance
//   5) team_task_completion_rate
//
// Notes:
//   - Snapshot mode is implemented for all 5.
//   - Table mode is implemented for Top Agents as a table KPI in another file.
//   - Series mode will be added after we build time-bucketing helper.
// ============================================================================

import type {
  KpiDefinitionMeta,
  KpiQueryFilters,
  KpiQueryTarget,
  KpiSeries,
  KpiSnapshotItem,
  KpiTable,
} from '../../../shared/kpi-core.types';

import type { KpiDbWindow } from '../../../data/kpi-query.service';
import { BaseKpiDefinition, type KpiDefinitionContext } from '../base/base-kpi.definition';

// ----------------------------------------------------------------------------
// KPI 01: Sale vs Rent Mix
// ----------------------------------------------------------------------------
export class MemberSaleRentMixKpi extends BaseKpiDefinition {
  public readonly meta: KpiDefinitionMeta = {
    id: 'member_sale_rent_mix',
    domain: 'properties',
    title: 'Sale vs Rent Mix',
    description: 'Sale vs rent deal distribution with actual deal counts, values, and commission.',
    visual: 'donut',
    primaryUnit: 'percent',
    supportsPercent: true,
    supportsActuals: true,
    supportedScopes: ['member', 'team', 'org', 'branch', 'region'],
  };

  public async computeSnapshot(
    ctx: KpiDefinitionContext,
    target: KpiQueryTarget,
    window: KpiDbWindow,
    filters?: KpiQueryFilters,
  ): Promise<ReadonlyArray<KpiSnapshotItem>> {
    const value = await ctx.query.getSaleRentMix(target, window, filters);

    const item: KpiSnapshotItem = {
      meta: this.meta,
      value,
      computedAtISO: new Date().toISOString(),
    };

    return [item];
  }

  public async computeSeries(): Promise<ReadonlyArray<KpiSeries>> {
    // Series needs time-bucketing support (day/week/month).
    // We will implement this after registry is stable.
    return [];
  }

  public async computeTable(): Promise<ReadonlyArray<KpiTable>> {
    // Sale/rent mix is not naturally a table KPI.
    return [];
  }
}

// ----------------------------------------------------------------------------
// KPI 02: Commission Efficiency
// ----------------------------------------------------------------------------
export class MemberCommissionEfficiencyKpi extends BaseKpiDefinition {
  public readonly meta: KpiDefinitionMeta = {
    id: 'member_commission_efficiency',
    domain: 'members',
    title: 'Commission Efficiency',
    description: 'Commission as a percentage of total deal value, plus actual commission and total value.',
    visual: 'card',
    primaryUnit: 'percent',
    supportsPercent: true,
    supportsActuals: true,
    supportedScopes: ['member', 'team', 'org', 'branch', 'region'],
  };

  public async computeSnapshot(
    ctx: KpiDefinitionContext,
    target: KpiQueryTarget,
    window: KpiDbWindow,
    filters?: KpiQueryFilters,
  ): Promise<ReadonlyArray<KpiSnapshotItem>> {
    const value = await ctx.query.getCommissionEfficiency(target, window, filters);

    const item: KpiSnapshotItem = {
      meta: this.meta,
      value,
      computedAtISO: new Date().toISOString(),
    };

    return [item];
  }

  public async computeSeries(): Promise<ReadonlyArray<KpiSeries>> {
    return [];
  }

  public async computeTable(): Promise<ReadonlyArray<KpiTable>> {
    return [];
  }
}

// ----------------------------------------------------------------------------
// KPI 03: Customer Satisfaction
// ----------------------------------------------------------------------------
export class MemberCustomerSatisfactionKpi extends BaseKpiDefinition {
  public readonly meta: KpiDefinitionMeta = {
    id: 'member_customer_satisfaction',
    domain: 'members',
    title: 'Customer Satisfaction',
    description: 'Satisfaction percent derived from average rating (1–5), including response count.',
    visual: 'card',
    primaryUnit: 'percent',
    supportsPercent: true,
    supportsActuals: true,
    supportedScopes: ['member', 'team', 'org', 'branch', 'region'],
  };

  public async computeSnapshot(
    ctx: KpiDefinitionContext,
    target: KpiQueryTarget,
    window: KpiDbWindow,
    filters?: KpiQueryFilters,
  ): Promise<ReadonlyArray<KpiSnapshotItem>> {
    const value = await ctx.query.getCustomerSatisfaction(target, window, filters);

    const item: KpiSnapshotItem = {
      meta: this.meta,
      value,
      computedAtISO: new Date().toISOString(),
    };

    return [item];
  }

  public async computeSeries(): Promise<ReadonlyArray<KpiSeries>> {
    return [];
  }

  public async computeTable(): Promise<ReadonlyArray<KpiTable>> {
    return [];
  }
}

// ----------------------------------------------------------------------------
// KPI 04: Maintenance SLA Compliance
// ----------------------------------------------------------------------------
export class MaintenanceSlaComplianceKpi extends BaseKpiDefinition {
  public readonly meta: KpiDefinitionMeta = {
    id: 'maintenance_sla_compliance',
    domain: 'maintenance',
    title: 'Maintenance SLA Compliance',
    description: 'Percent of tickets completed within SLA, plus counts and average resolution time.',
    visual: 'card',
    primaryUnit: 'percent',
    supportsPercent: true,
    supportsActuals: true,
    supportedScopes: ['member', 'team', 'org', 'property', 'branch', 'region'],
  };

  public async computeSnapshot(
    ctx: KpiDefinitionContext,
    target: KpiQueryTarget,
    window: KpiDbWindow,
    filters?: KpiQueryFilters,
  ): Promise<ReadonlyArray<KpiSnapshotItem>> {
    const value = await ctx.query.getMaintenanceSlaCompliance(target, window, filters);

    const item: KpiSnapshotItem = {
      meta: this.meta,
      value,
      computedAtISO: new Date().toISOString(),
    };

    return [item];
  }

  public async computeSeries(): Promise<ReadonlyArray<KpiSeries>> {
    return [];
  }

  public async computeTable(): Promise<ReadonlyArray<KpiTable>> {
    return [];
  }
}

// ----------------------------------------------------------------------------
// KPI 05: Task Completion Rate
// ----------------------------------------------------------------------------
export class TeamTaskCompletionRateKpi extends BaseKpiDefinition {
  public readonly meta: KpiDefinitionMeta = {
    id: 'team_task_completion_rate',
    domain: 'team',
    title: 'Task Completion Rate',
    description: 'Task completion percent with totals, in-progress, and overdue counts.',
    visual: 'card',
    primaryUnit: 'percent',
    supportsPercent: true,
    supportsActuals: true,
    supportedScopes: ['member', 'team', 'org', 'branch', 'region'],
  };

  public async computeSnapshot(
    ctx: KpiDefinitionContext,
    target: KpiQueryTarget,
    window: KpiDbWindow,
    filters?: KpiQueryFilters,
  ): Promise<ReadonlyArray<KpiSnapshotItem>> {
    const value = await ctx.query.getTaskCompletionRate(target, window, filters);

    const item: KpiSnapshotItem = {
      meta: this.meta,
      value,
      computedAtISO: new Date().toISOString(),
    };

    return [item];
  }

  public async computeSeries(): Promise<ReadonlyArray<KpiSeries>> {
    return [];
  }

  public async computeTable(): Promise<ReadonlyArray<KpiTable>> {
    return [];
  }
}
