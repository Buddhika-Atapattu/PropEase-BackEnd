// ============================================================================
// Path: src/KPIs/data/kpi-query.service.ts
// ============================================================================
// KPI Query Service (MongoDB Aggregations)
// ----------------------------------------------------------------------------
// Purpose:
//   Provide reusable, optimized aggregation queries that compute KPIs as:
//
//     - Percent values: 0..100
//     - Actual values: counts, money, durations, ratings (for charts/tables)
//
//   This layer is "DB + math". It does NOT handle:
//     - WebSocket payload formatting
//     - REST controllers
//     - Permission checks
//
//   Those belong to higher layers (registry + realtime).
//
// ----------------------------------------------------------------------------
// Design Principles:
//   1) Always return percent as 0..100 (never 0..1).
//   2) Always include actual values when meaningful.
//   3) Support segmentation by scope: member/team/org/property/branch/region.
//   4) Support filters (dealType, propertyType, currency, priority, etc.).
//   5) Favor indexes:
//        - match on scopeId + time pivot fields (closedAt/submittedAt/occurredAt)
//        - use grouping only after narrowing down with $match
//
// ----------------------------------------------------------------------------
// Mongo mental model (quick mapping):
//   - $match    => SQL WHERE
//   - $group    => SQL GROUP BY
//   - $sum      => SQL SUM() / COUNT()
//   - $avg      => SQL AVG()
//   - $cond     => SQL CASE WHEN
//   - $project  => SQL SELECT (shape output fields)
//   - $addFields=> computed columns
//   - $sort     => SQL ORDER BY
//   - $limit    => SQL LIMIT
// ============================================================================

import { Types, type PipelineStage } from 'mongoose';

import { KpiModelAdapter } from './kpi-model.adapter';
import { KpiPercentageUtil } from '../utils/kpi-percentage.util';

import type {
  KpiMetricValue,
  KpiActualValue,
  KpiQueryTarget,
  KpiQueryFilters,
} from '../shared/kpi-core.types';

/**
 * Window input for DB queries. This is "Date" form (Mongo uses Date).
 * In higher layers (WS/REST), you typically hold ISO strings. Convert there.
 */
export interface KpiDbWindow {
  from: Date;
  to: Date;
}

export interface KpiTeamCompletionRow {
  teamId: string;
  totalTasks: number;
  completedCount: number;
  inProgressCount: number;
  overdueCount: number;
  completionPercent: number;
}

export interface KpiMemberOverdueRow {
  memberId: string;
  overdueCount: number;
}

/**
 * Result wrapper used for leaderboard queries.
 * (This is not a UI table yet; UI shaping can be done by registry.)
 */
export interface KpiTopAgentRow {
  agentId: string;
  dealCount: number;
  totalValue: number;
  commissionTotal: number;
  saleCount: number;
  rentCount: number;
}

/**
 * KPI Query Service class.
 * - Instantiated once in registry/service layers.
 */
export class KpiQueryService {
  private readonly pct: KpiPercentageUtil;

  public constructor () {
    this.pct = new KpiPercentageUtil();
  }

  // =========================================================================
  // 1) PROPERTY KPI — Sale vs Rent Mix (% + actuals)
  // ----------------------------------------------------------------------------
  // Output:
  //   percents: salePercent + rentPercent (0..100)
  //   actuals:
  //     - saleCount, rentCount, totalDeals (count)
  //     - saleValue, rentValue, totalValue (money)
  //     - commissionTotal (money)
  //
  // This supports:
  //   - KPI cards (percent)
  //   - donut charts (sale vs rent percents)
  //   - tables (actual counts/values)
  // =========================================================================
  public async getSaleRentMix(
    target: KpiQueryTarget,
    window: KpiDbWindow,
    filters?: KpiQueryFilters,
  ): Promise<KpiMetricValue> {
    const Deal = KpiModelAdapter.getDealFactModel();

    // We only count "won" deals for performance KPIs (business outcomes).
    // If you later need conversion KPIs (won/lost), we can expand this.
    const match: PipelineStage.Match = {
      $match: {
        status: 'won',
        closedAt: { $gte: window.from, $lte: window.to },
        ...this.buildScopeMatch( target ),
        ...this.buildDealFilterMatch( filters ),
      },
    };

    // Group totals + conditional sums.
    // We calculate:
    //   - counts (saleCount, rentCount, totalDeals)
    //   - values (saleValue, rentValue, totalValue)
    //   - commissionTotal
    const pipeline: PipelineStage[] = [
      match,
      {
        $group: {
          _id: null,

          totalDeals: { $sum: 1 },

          saleCount: { $sum: { $cond: [ { $eq: [ '$dealType', 'sale' ] }, 1, 0 ] } },
          rentCount: { $sum: { $cond: [ { $eq: [ '$dealType', 'rent' ] }, 1, 0 ] } },

          totalValue: { $sum: '$dealValue' },

          saleValue: { $sum: { $cond: [ { $eq: [ '$dealType', 'sale' ] }, '$dealValue', 0 ] } },
          rentValue: { $sum: { $cond: [ { $eq: [ '$dealType', 'rent' ] }, '$dealValue', 0 ] } },

          commissionTotal: { $sum: '$commissionAmount' },

          // Currency note:
          // If the company operates multi-currency, you MUST filter by currencyCode
          // or convert values using FX rates. For now, we assume filters.currencyCode.
          currencyCode: { $first: '$currencyCode' },
        },
      },
      {
        $project: {
          _id: 0,
          totalDeals: 1,
          saleCount: 1,
          rentCount: 1,
          totalValue: 1,
          saleValue: 1,
          rentValue: 1,
          commissionTotal: 1,
          currencyCode: 1,
        },
      },
    ];

    const rows = await Deal.aggregate( pipeline ).exec();
    const row = rows[ 0 ] ?? {
      totalDeals: 0,
      saleCount: 0,
      rentCount: 0,
      totalValue: 0,
      saleValue: 0,
      rentValue: 0,
      commissionTotal: 0,
      currencyCode: filters?.currencyCode ?? 'LKR',
    };

    // Percent by count (sale % / rent %)
    // NOTE:
    // - denominator = totalDeals
    // - clamp 0..100
    const salePercent = this.pct.round( this.pct.toPercent( row.saleCount, row.totalDeals ), 2 );
    const rentPercent = this.pct.round( this.pct.toPercent( row.rentCount, row.totalDeals ), 2 );

    const actuals: KpiActualValue[] = [
      { key: 'totalDeals', unit: 'count', value: row.totalDeals, label: 'Total Deals' },

      { key: 'saleCount', unit: 'count', value: row.saleCount, label: 'Sale Deals' },
      { key: 'rentCount', unit: 'count', value: row.rentCount, label: 'Rent Deals' },

      { key: 'totalValue', unit: 'money', value: row.totalValue, currencyCode: row.currencyCode, label: 'Total Value' },
      { key: 'saleValue', unit: 'money', value: row.saleValue, currencyCode: row.currencyCode, label: 'Sale Value' },
      { key: 'rentValue', unit: 'money', value: row.rentValue, currencyCode: row.currencyCode, label: 'Rent Value' },

      { key: 'commissionTotal', unit: 'money', value: row.commissionTotal, currencyCode: row.currencyCode, label: 'Commission Total' },
    ];

    // NOTE (exactOptionalPropertyTypes-safe):
    // - We prepare a note text, but we DO NOT assign `note: undefined`.
    const noteText: string | null =
      row.totalDeals <= 0 ? 'No deals in selected window.' : null;

    const result: KpiMetricValue = {
      percents: [
        { key: 'salePercent', value: { unit: 'percent', value: salePercent }, label: 'Sale %' },
        { key: 'rentPercent', value: { unit: 'percent', value: rentPercent }, label: 'Rent %' },
      ],
      actuals,
    };

    // IMPORTANT (exactOptionalPropertyTypes):
    // - Do NOT set note: undefined
    // - Only attach note when it's a real string
    if ( noteText ) {
      result.note = noteText;
    }

    return result;
  }

  // =========================================================================
  // 2) PROPERTY KPI — Commission Efficiency (% + actuals)
  // ----------------------------------------------------------------------------
  // "Commission %" here means:
  //   commissionTotal / totalDealValue * 100
  //
  // Why it matters:
  //   - lets org compare how much commission earned per unit value
  //   - supports agent/team/org efficiency dashboards
  //
  // Output:
  //   percent: commissionRatePercent (0..100)
  //   actuals: commissionTotal + totalValue
  // =========================================================================
  public async getCommissionEfficiency(
    target: KpiQueryTarget,
    window: KpiDbWindow,
    filters?: KpiQueryFilters,
  ): Promise<KpiMetricValue> {
    const Deal = KpiModelAdapter.getDealFactModel();

    const pipeline: PipelineStage[] = [
      {
        $match: {
          status: 'won',
          closedAt: { $gte: window.from, $lte: window.to },
          ...this.buildScopeMatch( target ),
          ...this.buildDealFilterMatch( filters ),
        },
      },
      {
        $group: {
          _id: null,
          totalValue: { $sum: '$dealValue' },
          commissionTotal: { $sum: '$commissionAmount' },
          currencyCode: { $first: '$currencyCode' },
          totalDeals: { $sum: 1 },
        },
      },
      { $project: { _id: 0, totalValue: 1, commissionTotal: 1, currencyCode: 1, totalDeals: 1 } },
    ];

    const rows = await Deal.aggregate( pipeline ).exec();
    const row = rows[ 0 ] ?? {
      totalValue: 0,
      commissionTotal: 0,
      currencyCode: filters?.currencyCode ?? 'LKR',
      totalDeals: 0,
    };

    const commissionPercent = this.pct.round(
      this.pct.toPercent( row.commissionTotal, row.totalValue ),
      2,
    );

    const actuals: KpiActualValue[] = [
      { key: 'totalDeals', unit: 'count', value: row.totalDeals, label: 'Total Deals' },
      { key: 'totalValue', unit: 'money', value: row.totalValue, currencyCode: row.currencyCode, label: 'Total Value' },
      { key: 'commissionTotal', unit: 'money', value: row.commissionTotal, currencyCode: row.currencyCode, label: 'Commission Total' },
    ];

    // NOTE (exactOptionalPropertyTypes-safe):
    // - compute note text first
    // - attach ONLY when it exists
    const noteText: string | null =
      row.totalValue <= 0 ? 'No total deal value to compute commission %.' : null;

    const result: KpiMetricValue = {
      percent: { unit: 'percent', value: commissionPercent },
      actuals,
    };

    if ( noteText ) {
      result.note = noteText;
    }

    return result;
  }

  // =========================================================================
  // 3) MEMBER/TEAM/ORG KPI — Customer Satisfaction (% + actuals)
  // ----------------------------------------------------------------------------
  // Satisfaction % definition:
  //   avgRating / 5 * 100
  //
  // Output:
  //   percent: satisfactionPercent
  //   actuals:
  //     - avgRating (rating_1_5)
  //     - totalResponses (count)
  // =========================================================================
  public async getCustomerSatisfaction(
    target: KpiQueryTarget,
    window: KpiDbWindow,
    filters?: KpiQueryFilters,
  ): Promise<KpiMetricValue> {
    const Feedback = KpiModelAdapter.getSatisfactionFactModel();

    const pipeline: PipelineStage[] = [
      {
        $match: {
          submittedAt: { $gte: window.from, $lte: window.to },
          ...this.buildScopeMatchForSatisfaction( target ),
          ...this.buildSatisfactionFilterMatch( filters ),
        },
      },
      {
        $group: {
          _id: null,
          totalResponses: { $sum: 1 },
          avgRating: { $avg: '$rating' },
        },
      },
      {
        $project: {
          _id: 0,
          totalResponses: 1,
          avgRating: { $ifNull: [ '$avgRating', 0 ] },
        },
      },
    ];

    const rows = await Feedback.aggregate( pipeline ).exec();
    const row = rows[ 0 ] ?? { totalResponses: 0, avgRating: 0 };

    // Convert rating (0..5) -> percent (0..100)
    const satisfactionPercent = this.pct.round( this.pct.toPercent( row.avgRating, 5 ), 2 );

    const actuals: KpiActualValue[] = [
      { key: 'totalResponses', unit: 'count', value: row.totalResponses, label: 'Responses' },
      { key: 'avgRating', unit: 'rating_1_5', value: this.pct.round( row.avgRating, 2 ), label: 'Avg Rating (1–5)' },
    ];

    const noteText: string | null =
      row.totalResponses <= 0 ? 'No satisfaction responses in selected window.' : null;

    const result: KpiMetricValue = {
      percent: { unit: 'percent', value: satisfactionPercent },
      actuals,
    };

    if ( noteText ) {
      result.note = noteText;
    }

    return result;
  }

  // =========================================================================
  // 4) ORG/TARGET KPI — Top Agents Leaderboard (actuals heavy)
  // ----------------------------------------------------------------------------
  // Output supports tables:
  //   - dealCount, totalValue, commissionTotal
  //   - saleCount/rentCount breakdown
  //
  // NOTE:
  //   This returns raw rows. Registry/UI layer can convert to KpiTable.
  // =========================================================================
  public async getTopAgents(
    target: KpiQueryTarget,
    window: KpiDbWindow,
    filters?: KpiQueryFilters,
    limit: number = 10,
  ): Promise<ReadonlyArray<KpiTopAgentRow>> {
    const Deal = KpiModelAdapter.getDealFactModel();

    // Leaderboards should normally only consider won deals.
    // You can add "status: won" always for performance leaderboards.
    const pipeline: PipelineStage[] = [
      {
        $match: {
          status: 'won',
          closedAt: { $gte: window.from, $lte: window.to },
          ...this.buildScopeMatch( target ),
          ...this.buildDealFilterMatch( filters ),
        },
      },
      {
        $group: {
          _id: '$agentId',

          dealCount: { $sum: 1 },
          totalValue: { $sum: '$dealValue' },
          commissionTotal: { $sum: '$commissionAmount' },

          saleCount: { $sum: { $cond: [ { $eq: [ '$dealType', 'sale' ] }, 1, 0 ] } },
          rentCount: { $sum: { $cond: [ { $eq: [ '$dealType', 'rent' ] }, 1, 0 ] } },
        },
      },
      // Sort by total value (most impactful for real estate leaderboard)
      { $sort: { totalValue: -1 } },
      { $limit: Math.max( 1, Math.min( limit, 50 ) ) },
      {
        $project: {
          _id: 0,
          agentId: { $toString: '$_id' },
          dealCount: 1,
          totalValue: 1,
          commissionTotal: 1,
          saleCount: 1,
          rentCount: 1,
        },
      },
    ];

    return await Deal.aggregate( pipeline ).exec();
  }

  // =========================================================================
  // 5) MAINTENANCE KPI — SLA Compliance (% + actuals)
  // ----------------------------------------------------------------------------
  // SLA compliance definition:
  //   % of tickets that are completed/closed within SLA minutes.
  //
  // Data source:
  //   kpi_maintenance_event_facts holds event timeline:
  //     opened -> completed/closed
  //
  // How we compute:
  //   - Group by ticketId
  //   - Derive:
  //       openedAt = min occurredAt where eventType=opened
  //       closedAt = min occurredAt where eventType in [completed, closed]
  //       slaMinutes = first SLA minutes found (stored on events)
  //   - Compute durationMinutes = (closedAt - openedAt) / 60000
  //   - Compare durationMinutes <= slaMinutes => compliant
  //
  // Output:
  //   percent: slaCompliancePercent (0..100)
  //   actuals: compliantCount, totalClosedTickets, avgResolutionMinutes (optional)
  // =========================================================================
  public async getMaintenanceSlaCompliance(
    target: KpiQueryTarget,
    window: KpiDbWindow,
    filters?: KpiQueryFilters,
  ): Promise<KpiMetricValue> {
    const Ev = KpiModelAdapter.getMaintenanceEventFactModel();

    const match: PipelineStage.Match = {
      $match: {
        occurredAt: { $gte: window.from, $lte: window.to },
        ...this.buildScopeMatchForMaintenance( target ),
        ...this.buildMaintenanceFilterMatch( filters ),
      },
    };

    const pipeline: PipelineStage[] = [
      match,

      // Group event timeline per ticket
      {
        $group: {
          _id: '$ticketId',

          // openedAt = earliest "opened" event time
          openedAt: {
            $min: {
              $cond: [ { $eq: [ '$eventType', 'opened' ] }, '$occurredAt', null ],
            },
          },

          // closedAt = earliest time among completed/closed
          closedAt: {
            $min: {
              $cond: [ { $in: [ '$eventType', [ 'completed', 'closed' ] ] }, '$occurredAt', null ],
            },
          },

          // SLA minutes can be stored on all events; we pick the first non-null
          slaMinutes: { $max: '$slaMinutes' },
        },
      },

      // Keep only tickets that have both opened and closed times
      {
        $match: {
          openedAt: { $ne: null },
          closedAt: { $ne: null },
        },
      },

      // Compute duration (minutes) and compliance boolean
      {
        $addFields: {
          durationMinutes: {
            $divide: [ { $subtract: [ '$closedAt', '$openedAt' ] }, 60000 ],
          },
          isCompliant: {
            $cond: [
              {
                $lte: [
                  { $divide: [ { $subtract: [ '$closedAt', '$openedAt' ] }, 60000 ] },
                  '$slaMinutes',
                ],
              },
              1,
              0,
            ],
          },
        },
      },

      // Aggregate final KPI totals
      {
        $group: {
          _id: null,
          totalClosedTickets: { $sum: 1 },
          compliantCount: { $sum: '$isCompliant' },
          avgResolutionMinutes: { $avg: '$durationMinutes' },
        },
      },

      {
        $project: {
          _id: 0,
          totalClosedTickets: 1,
          compliantCount: 1,
          avgResolutionMinutes: { $ifNull: [ '$avgResolutionMinutes', 0 ] },
        },
      },
    ];

    const rows = await Ev.aggregate( pipeline ).exec();
    const row = rows[ 0 ] ?? { totalClosedTickets: 0, compliantCount: 0, avgResolutionMinutes: 0 };

    const slaPercent = this.pct.round( this.pct.toPercent( row.compliantCount, row.totalClosedTickets ), 2 );

    const actuals: KpiActualValue[] = [
      { key: 'totalClosedTickets', unit: 'count', value: row.totalClosedTickets, label: 'Closed Tickets' },
      { key: 'compliantCount', unit: 'count', value: row.compliantCount, label: 'SLA Compliant' },
      { key: 'avgResolutionMinutes', unit: 'duration_ms', value: this.minutesToMs( row.avgResolutionMinutes ), label: 'Avg Resolution (ms)' },
    ];

    const noteText: string | null =
      row.totalClosedTickets <= 0 ? 'No closed tickets in selected window.' : null;

    const result: KpiMetricValue = {
      percent: { unit: 'percent', value: slaPercent },
      actuals,
    };

    if ( noteText ) {
      result.note = noteText;
    }

    return result;
  }

  // =========================================================================
  // 6) TEAM/MEMBER KPI — Task Completion Rate (% + actuals)
  // ----------------------------------------------------------------------------
  // Completion rate definition:
  //   completedCount / totalTasks * 100
  //
  // Output:
  //   percent: completionPercent
  //   actuals: totalTasks, completedCount, inProgressCount, overdueCount
  //
  // NOTE:
  //   This uses the projection collection kpi_team_task_facts.
  // =========================================================================
  public async getTaskCompletionRate(
    target: KpiQueryTarget,
    window: KpiDbWindow,
    filters?: KpiQueryFilters,
  ): Promise<KpiMetricValue> {
    const Task = KpiModelAdapter.getTeamTaskFactModel();

    // We match on createdAtISO for windowing.
    // You can also measure by completedAtISO for "completed within window".
    const match: PipelineStage.Match = {
      $match: {
        createdAtISO: { $gte: window.from, $lte: window.to },
        ...this.buildScopeMatchForTasks( target ),
        ...this.buildTaskFilterMatch( filters ),
      },
    };

    const now = new Date();

    const pipeline: PipelineStage[] = [
      match,
      {
        $group: {
          _id: null,
          totalTasks: { $sum: 1 },

          completedCount: { $sum: { $cond: [ { $eq: [ '$status', 'completed' ] }, 1, 0 ] } },
          inProgressCount: { $sum: { $cond: [ { $eq: [ '$status', 'in_progress' ] }, 1, 0 ] } },

          // Overdue = dueAt exists and dueAt < now and not completed/cancelled
          overdueCount: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $ne: [ '$dueAtISO', null ] },
                    { $lt: [ '$dueAtISO', now ] },
                    { $not: [ { $in: [ '$status', [ 'completed', 'cancelled' ] ] } ] },
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
      },
      { $project: { _id: 0, totalTasks: 1, completedCount: 1, inProgressCount: 1, overdueCount: 1 } },
    ];

    const rows = await Task.aggregate( pipeline ).exec();
    const row = rows[ 0 ] ?? { totalTasks: 0, completedCount: 0, inProgressCount: 0, overdueCount: 0 };

    const completionPercent = this.pct.round( this.pct.toPercent( row.completedCount, row.totalTasks ), 2 );

    const actuals: KpiActualValue[] = [
      { key: 'totalTasks', unit: 'count', value: row.totalTasks, label: 'Total Tasks' },
      { key: 'completedCount', unit: 'count', value: row.completedCount, label: 'Completed' },
      { key: 'inProgressCount', unit: 'count', value: row.inProgressCount, label: 'In Progress' },
      { key: 'overdueCount', unit: 'count', value: row.overdueCount, label: 'Overdue' },
    ];

    const noteText: string | null =
      row.totalTasks <= 0 ? 'No tasks in selected window.' : null;

    const result: KpiMetricValue = {
      percent: { unit: 'percent', value: completionPercent },
      actuals,
    };

    if ( noteText ) {
      result.note = noteText;
    }

    return result;
  }

  /**
   * Org KPI — Task Completion Rate by Team (for bar charts / team comparisons)
   *
   * Mental model:
   * - $match   = SQL WHERE (orgId + window + optional filters)
   * - $group   = SQL GROUP BY teamId (counts per team)
   * - $project = SELECT computed fields + percent
   * - $sort    = ORDER BY completionPercent DESC / overdueCount DESC
   */
  public async getTaskCompletionRateByTeam(
    orgTarget: KpiQueryTarget,
    window: KpiDbWindow,
    filters?: KpiQueryFilters,
  ): Promise<KpiTeamCompletionRow[]> {
    const Task = KpiModelAdapter.getTeamTaskFactModel();

    // Force org scope here (caller should pass scope='org')
    const match: PipelineStage.Match = {
      $match: {
        createdAtISO: { $gte: window.from, $lte: window.to },
        ...this.buildScopeMatchForTasks( orgTarget ),
        ...this.buildTaskFilterMatch( filters ),
        teamId: { $ne: null }, // ignore tasks without teamId (keeps chart clean)
      },
    };

    const now = new Date();

    const pipeline: PipelineStage[] = [
      match,
      {
        $group: {
          _id: '$teamId',
          totalTasks: { $sum: 1 },
          completedCount: { $sum: { $cond: [ { $eq: [ '$status', 'completed' ] }, 1, 0 ] } },
          inProgressCount: { $sum: { $cond: [ { $eq: [ '$status', 'in_progress' ] }, 1, 0 ] } },

          overdueCount: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $ne: [ '$dueAtISO', null ] },
                    { $lt: [ '$dueAtISO', now ] },
                    { $not: [ { $in: [ '$status', [ 'completed', 'cancelled' ] ] } ] },
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
      },
      {
        $project: {
          _id: 0,
          teamId: { $toString: '$_id' },
          totalTasks: 1,
          completedCount: 1,
          inProgressCount: 1,
          overdueCount: 1,
          completionPercent: {
            $cond: [
              { $gt: [ '$totalTasks', 0 ] },
              { $multiply: [ { $divide: [ '$completedCount', '$totalTasks' ] }, 100 ] },
              0,
            ],
          },
        },
      },
      { $sort: { completionPercent: -1, overdueCount: -1 } },
    ];

    const rows = await Task.aggregate( pipeline ).exec();

    // Round percent in JS to keep consistent with your other KPIs
    return rows.map( ( r: any ): KpiTeamCompletionRow => {
      const pct = typeof r.completionPercent === 'number' ? r.completionPercent : 0;
      return {
        teamId: String( r.teamId ?? '' ),
        totalTasks: Number( r.totalTasks ?? 0 ),
        completedCount: Number( r.completedCount ?? 0 ),
        inProgressCount: Number( r.inProgressCount ?? 0 ),
        overdueCount: Number( r.overdueCount ?? 0 ),
        completionPercent: this.pct.round( pct, 2 ),
      };
    } );
  }

  /**
   * KPI — Most Critical Task Holders (overdue count leaderboard)
   * Works for scope: org / team.
   *
   * Note:
   * - We treat "critical" as "overdue and not completed/cancelled"
   *   because your fact model keeps priority as free string (project-specific).
   */
  public async getTopOverdueTaskHolders(
    target: KpiQueryTarget,
    window: KpiDbWindow,
    topN: number,
    filters?: KpiQueryFilters,
  ): Promise<KpiMemberOverdueRow[]> {
    const Task = KpiModelAdapter.getTeamTaskFactModel();

    const now = new Date();

    const match: PipelineStage.Match = {
      $match: {
        createdAtISO: { $gte: window.from, $lte: window.to },
        ...this.buildScopeMatchForTasks( target ),
        ...this.buildTaskFilterMatch( filters ),

        memberId: { $ne: null },

        // overdue definition
        dueAtISO: { $ne: null, $lt: now },
        status: { $nin: [ 'completed', 'cancelled' ] },
      },
    };

    const pipeline: PipelineStage[] = [
      match,
      { $group: { _id: '$memberId', overdueCount: { $sum: 1 } } },
      {
        $project: {
          _id: 0,
          memberId: { $toString: '$_id' },
          overdueCount: 1,
        },
      },
      { $sort: { overdueCount: -1 } },
      { $limit: Math.max( 1, Math.min( 50, topN ) ) },
    ];

    const rows = await Task.aggregate( pipeline ).exec();

    return rows.map( ( r: any ): KpiMemberOverdueRow => {
      return {
        memberId: String( r.memberId ?? '' ),
        overdueCount: Number( r.overdueCount ?? 0 ),
      };
    } );
  }

  // =========================================================================
  // INTERNAL HELPERS
  // =========================================================================

  /**
   * Build scope match for deal facts.
   * This decides which field is compared against targetId depending on scope.
   */
  private buildScopeMatch( target: KpiQueryTarget ): Record<string, unknown> {
    const id = this.toObjectId( target.targetId );

    // Rule:
    // - member scope => compare to agentId
    // - team scope   => compare to teamId
    // - org scope    => compare to orgId
    // - property scope => compare to propertyId
    // - region/branch supported too
    if ( target.scope === 'member' ) return { agentId: id };
    if ( target.scope === 'team' ) return { teamId: id };
    if ( target.scope === 'property' ) return { propertyId: id };
    if ( target.scope === 'branch' ) return { branchId: id };
    if ( target.scope === 'region' ) return { regionId: id };
    return { orgId: id };
  }

  /**
   * Satisfaction facts use the same scope semantics as deals (agent/team/org/etc.).
   */
  private buildScopeMatchForSatisfaction( target: KpiQueryTarget ): Record<string, unknown> {
    // Agent satisfaction is computed by agentId at member scope.
    return this.buildScopeMatch( target );
  }

  /**
   * Maintenance events can be scoped by:
   * - memberId (technician/handler)
   * - teamId
   * - orgId
   * - propertyId
   * - branch/region
   */
  private buildScopeMatchForMaintenance( target: KpiQueryTarget ): Record<string, unknown> {
    const id = this.toObjectId( target.targetId );

    if ( target.scope === 'member' ) return { memberId: id };
    if ( target.scope === 'team' ) return { teamId: id };
    if ( target.scope === 'property' ) return { propertyId: id };
    if ( target.scope === 'branch' ) return { branchId: id };
    if ( target.scope === 'region' ) return { regionId: id };
    return { orgId: id };
  }

  /**
   * Task facts scope match:
   * - member => memberId
   * - team => teamId
   * - org => orgId
   * - property (optional) => propertyId
   */
  private buildScopeMatchForTasks( target: KpiQueryTarget ): Record<string, unknown> {
    const id = this.toObjectId( target.targetId );

    if ( target.scope === 'member' ) return { memberId: id };
    if ( target.scope === 'team' ) return { teamId: id };
    if ( target.scope === 'property' ) return { propertyId: id };
    if ( target.scope === 'branch' ) return { branchId: id };
    if ( target.scope === 'region' ) return { regionId: id };
    return { orgId: id };
  }

  /**
   * Deal filters:
   * - dealType (sale/rent)
   * - propertyType
   * - currencyCode (important for money KPI correctness)
   * - agentId/teamId segmentation if requested
   *
   * This returns additional $match fields.
   */
  private buildDealFilterMatch( filters?: KpiQueryFilters ): Record<string, unknown> {
    const match: Record<string, unknown> = {};

    if ( !filters ) return match;

    if ( filters.dealType === 'sale' || filters.dealType === 'rent' ) {
      match.dealType = filters.dealType;
    }

    if ( filters.propertyType ) {
      match.propertyType = filters.propertyType;
    }

    if ( filters.currencyCode ) {
      match.currencyCode = String( filters.currencyCode ).toUpperCase();
    }

    // Optional segmentation overrides:
    // (This is useful when scope=org but you want only one team or one agent)
    if ( filters.agentId ) {
      match.agentId = this.toObjectId( filters.agentId );
    }
    if ( filters.teamId ) {
      match.teamId = this.toObjectId( filters.teamId );
    }

    // Real estate dimensions
    if ( filters.branchId ) {
      match.branchId = this.toObjectId( filters.branchId );
    }
    if ( filters.regionId ) {
      match.regionId = this.toObjectId( filters.regionId );
    }

    return match;
  }

  private buildSatisfactionFilterMatch( filters?: KpiQueryFilters ): Record<string, unknown> {
    const match: Record<string, unknown> = {};
    if ( !filters ) return match;

    if ( filters.agentId ) match.agentId = this.toObjectId( filters.agentId );
    if ( filters.teamId ) match.teamId = this.toObjectId( filters.teamId );

    if ( filters.branchId ) match.branchId = this.toObjectId( filters.branchId );
    if ( filters.regionId ) match.regionId = this.toObjectId( filters.regionId );

    return match;
  }

  private buildMaintenanceFilterMatch( filters?: KpiQueryFilters ): Record<string, unknown> {
    const match: Record<string, unknown> = {};
    if ( !filters ) return match;

    if ( filters.priority ) match.priority = filters.priority;

    if ( filters.teamId ) match.teamId = this.toObjectId( filters.teamId );
    if ( filters.agentId ) {
      // In maintenance world, "agentId" concept maps to "memberId" (technician).
      match.memberId = this.toObjectId( filters.agentId );
    }

    if ( filters.branchId ) match.branchId = this.toObjectId( filters.branchId );
    if ( filters.regionId ) match.regionId = this.toObjectId( filters.regionId );

    return match;
  }

  private buildTaskFilterMatch( filters?: KpiQueryFilters ): Record<string, unknown> {
    const match: Record<string, unknown> = {};
    if ( !filters ) return match;

    if ( filters.priority ) match.priority = filters.priority;

    if ( filters.teamId ) match.teamId = this.toObjectId( filters.teamId );
    if ( filters.agentId ) match.memberId = this.toObjectId( filters.agentId );

    if ( filters.branchId ) match.branchId = this.toObjectId( filters.branchId );
    if ( filters.regionId ) match.regionId = this.toObjectId( filters.regionId );

    return match;
  }

  /**
   * Safe ObjectId conversion.
   * - If invalid ObjectId string is passed, we throw (fail fast).
   * - This prevents silent wrong KPI calculations.
   */
  private toObjectId( raw: string ): Types.ObjectId {
    if ( !Types.ObjectId.isValid( raw ) ) {
      // Throwing here is intentional: invalid IDs should never produce KPIs.
      throw new Error( `Invalid ObjectId: ${ raw }` );
    }
    return new Types.ObjectId( raw );
  }

  /**
   * Converts minutes to milliseconds.
   * We store duration KPI unit as "duration_ms" to stay consistent across system.
   */
  private minutesToMs( minutes: number ): number {
    if ( !Number.isFinite( minutes ) || minutes <= 0 ) return 0;
    return Math.round( minutes * 60_000 );
  }
}
