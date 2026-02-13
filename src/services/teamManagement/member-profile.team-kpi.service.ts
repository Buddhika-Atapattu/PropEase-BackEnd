// Path: src/services/teamManagement/member-profile.team-kpi.service.ts
// ============================================================================
// MemberProfileTeamKpiService
// ----------------------------------------------------------------------------
// Purpose:
//  - Build a "Member Performance Profile" based on historical work:
//      • Team tasks (from TeamManagement.assignTasks array)
//      • Work items (from WorkItem collection)
//      • Work events (from WorkEvent collection)
//      • Customer + Supervisor satisfaction (derived from task completion confirmation)
//  - Output is UI-ready for:
//      • KPI cards (summary)
//      • Trend charts (monthly/weekly/daily bucket)
//      • Recent activity timeline
//
// Notes:
//  - This is READ ONLY (fits your WebSocket rule: invalidate/refetch only).
//  - Avoids any "KPI facts" dependency by deriving satisfaction from signatures.
// ============================================================================

import type { PipelineStage } from 'mongoose';
import type { Model } from 'mongoose';

// You MUST replace these imports with your existing model exports.
// I am using names based on your established Team module architecture.
import { TeamManagementModel } from '../../models/teamManagement/teamMain/teamManagement.model';
import { WorkItemModel } from '../../models/teamManagement/workItems/workItem.model';
import { WorkEventModel } from '../../models/teamManagement/workEvent.model';

// ----------------------------------------------------------------------------
// Types (backend contract)
// ----------------------------------------------------------------------------

export type MemberProfileBucket = 'day' | 'week' | 'month';

export interface MemberProfileQuery {
    memberId: string;
    from: Date;
    to: Date;
    bucket: MemberProfileBucket;
    recentLimit: number;
}

export interface MemberProfileKpiSummary {
    taskCompletionRatePct: number; // 0..100
    customerSatisfactionPct: number; // 0..100
    supervisorSatisfactionPct: number; // 0..100

    participationScore: number; // 0..100

    totalActivities: number;

    totalTasksAssigned: number;
    totalTasksCompleted: number;

    totalWorkItemsAssigned: number;
    totalWorkItemsCompleted: number;

    overdueCount: number;
    blockedCount: number;
    cancelledCount: number;
}

export interface MemberProfileTrendPoint {
    bucket: MemberProfileBucket;
    bucketKey: string; // e.g. "2026-01"
    completionRatePct: number;
    customerSatisfactionPct: number;
    supervisorSatisfactionPct: number;
    participationScore: number;
    activities: number;
}

export interface MemberProfileRecentActivity {
    createdAt: string;

    kind: string;

    teamId?: string;
    teamName?: string;

    workItemId?: string;
    taskId?: string;

    payload?: Record<string, unknown>;
}

export interface MemberPerformanceProfileDto {
    memberId: string;

    from: string;
    to: string;

    summary: MemberProfileKpiSummary;
    trend: MemberProfileTrendPoint[];
    recentActivities: MemberProfileRecentActivity[];
}

// ----------------------------------------------------------------------------
// Service
// ----------------------------------------------------------------------------

export class MemberProfileTeamKpiService {
    private static readonly MAX_RECENT_LIMIT: number = 200;

    // --------------------------------------------------------------------------
    // Public API
    // --------------------------------------------------------------------------

    public static async buildProfile( input: MemberProfileQuery ): Promise<MemberPerformanceProfileDto> {
        const bucket: MemberProfileBucket = input.bucket;
        const recentLimit: number = this.clampRecentLimit( input.recentLimit );

        const [
            taskAgg,
            workItemAgg,
            eventAgg,
            trendAgg,
            recentAgg,
        ] = await Promise.all( [
            this.aggregateTasks( input.memberId, input.from, input.to ),
            this.aggregateWorkItems( input.memberId, input.from, input.to ),
            this.aggregateWorkEventsCounts( input.memberId, input.from, input.to ),
            this.aggregateTrend( input.memberId, input.from, input.to, bucket ),
            this.aggregateRecentActivities( input.memberId, input.from, input.to, recentLimit ),
        ] );

        const totalTasksAssigned: number = taskAgg.totalAssigned;
        const totalTasksCompleted: number = taskAgg.totalCompleted;

        const totalWorkItemsAssigned: number = workItemAgg.totalAssigned;
        const totalWorkItemsCompleted: number = workItemAgg.totalCompleted;

        const totalActivities: number = eventAgg.totalActivities;

        const completionRatePct: number =
            this.safePct( totalTasksCompleted + totalWorkItemsCompleted, totalTasksAssigned + totalWorkItemsAssigned );

        const customerSatisfactionPct: number = this.safePct( taskAgg.customerSatisfied, taskAgg.customerEligible );
        const supervisorSatisfactionPct: number = this.safePct( taskAgg.supervisorSatisfied, taskAgg.supervisorEligible );

        // Participation Score:
        // - You can adjust weights later without touching UI.
        // - This is intentionally "explainable" and bounded 0..100.
        const participationScore: number = this.computeParticipationScore( {
            completionRatePct,
            customerSatisfactionPct,
            supervisorSatisfactionPct,
            activities: totalActivities,
        } );

        const summary: MemberProfileKpiSummary = {
            taskCompletionRatePct: completionRatePct,
            customerSatisfactionPct,
            supervisorSatisfactionPct,

            participationScore,

            totalActivities,

            totalTasksAssigned,
            totalTasksCompleted,

            totalWorkItemsAssigned,
            totalWorkItemsCompleted,

            overdueCount: workItemAgg.overdueCount,
            blockedCount: workItemAgg.blockedCount,
            cancelledCount: workItemAgg.cancelledCount,
        };

        return {
            memberId: input.memberId,
            from: input.from.toISOString(),
            to: input.to.toISOString(),
            summary,
            trend: trendAgg,
            recentActivities: recentAgg,
        };
    }

    // --------------------------------------------------------------------------
    // Aggregation: Team tasks (from TeamManagement.assignTasks array)
    // --------------------------------------------------------------------------

    private static async aggregateTasks(
        memberId: string,
        from: Date,
        to: Date,
    ): Promise<{
        totalAssigned: number;
        totalCompleted: number;

        customerEligible: number;
        customerSatisfied: number;

        supervisorEligible: number;
        supervisorSatisfied: number;
    }> {
        // Why unwind?
        // - assignTasks is stored inside Team document.
        // - We need to treat each task as a row (SQL mental model: Team JOIN Task).
        const pipeline: PipelineStage[] = [
            {
                $project: {
                    teamCode: 1,
                    teamName: 1,
                    assignTasks: 1,
                },
            },
            { $unwind: '$assignTasks' },

            // Task-level match for member participation:
            // - assignedMembers contains memberId OR captain is memberId
            {
                $match: {
                    $or: [
                        { 'assignTasks.assignedMembers': memberId },
                        { 'assignTasks.assignedTaskCaptain': memberId },
                    ],
                },
            },

            // Date range filter:
            // We consider "assigned date" based on createdAt if available; fallback to plannedStartAt.
            // If your DB stores these as strings, convert them to Date in BE persistence (recommended).
            {
                $addFields: {
                    _taskAssignedAt: {
                        $ifNull: [
                            '$assignTasks.createdAt',
                            '$assignTasks.plannedStartAt',
                        ],
                    },
                    _taskCompletedAt: '$assignTasks.completedAt',
                },
            },
            {
                $match: {
                    _taskAssignedAt: { $gte: from, $lte: to },
                },
            },

            // Group totals + satisfaction from completionConfirmation
            {
                $group: {
                    _id: null,

                    totalAssigned: { $sum: 1 },

                    totalCompleted: {
                        $sum: {
                            $cond: [
                                {
                                    $or: [
                                        { $eq: [ '$assignTasks.status', 'completed' ] },
                                        { $eq: [ '$assignTasks.status', 'completed_pending_confirmation' ] },
                                        { $ne: [ '$_taskCompletedAt', null ] },
                                    ],
                                },
                                1,
                                0,
                            ],
                        },
                    },

                    // Satisfaction Eligibility:
                    // A task is eligible if completionConfirmation exists OR status indicates completion.
                    customerEligible: {
                        $sum: {
                            $cond: [
                                { $ne: [ '$assignTasks.completionConfirmation', null ] },
                                1,
                                0,
                            ],
                        },
                    },
                    supervisorEligible: {
                        $sum: {
                            $cond: [
                                { $ne: [ '$assignTasks.completionConfirmation', null ] },
                                1,
                                0,
                            ],
                        },
                    },

                    // Customer satisfied:
                    // Rule:
                    //  - confirmation.status == 'confirmed' AND a signature role='customer' exists
                    customerSatisfied: {
                        $sum: {
                            $cond: [
                                {
                                    $and: [
                                        { $eq: [ '$assignTasks.completionConfirmation.status', 'confirmed' ] },
                                        {
                                            $gt: [
                                                {
                                                    $size: {
                                                        $filter: {
                                                            input: { $ifNull: [ '$assignTasks.completionConfirmation.signatures', [] ] },
                                                            as: 'sig',
                                                            cond: { $eq: [ '$$sig.role', 'customer' ] },
                                                        },
                                                    },
                                                },
                                                0,
                                            ],
                                        },
                                    ],
                                },
                                1,
                                0,
                            ],
                        },
                    },

                    // Supervisor satisfied:
                    // Rule:
                    //  - confirmation.status == 'confirmed' AND a signature role='supervisor' exists
                    supervisorSatisfied: {
                        $sum: {
                            $cond: [
                                {
                                    $and: [
                                        { $eq: [ '$assignTasks.completionConfirmation.status', 'confirmed' ] },
                                        {
                                            $gt: [
                                                {
                                                    $size: {
                                                        $filter: {
                                                            input: { $ifNull: [ '$assignTasks.completionConfirmation.signatures', [] ] },
                                                            as: 'sig',
                                                            cond: { $eq: [ '$$sig.role', 'supervisor' ] },
                                                        },
                                                    },
                                                },
                                                0,
                                            ],
                                        },
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
                    totalAssigned: { $ifNull: [ '$totalAssigned', 0 ] },
                    totalCompleted: { $ifNull: [ '$totalCompleted', 0 ] },

                    customerEligible: { $ifNull: [ '$customerEligible', 0 ] },
                    customerSatisfied: { $ifNull: [ '$customerSatisfied', 0 ] },

                    supervisorEligible: { $ifNull: [ '$supervisorEligible', 0 ] },
                    supervisorSatisfied: { $ifNull: [ '$supervisorSatisfied', 0 ] },
                },
            },
        ];

        const rows: Array<any> = await ( TeamManagementModel as unknown as Model<any> ).aggregate( pipeline ).exec();
        const row: any = rows?.[ 0 ] ?? {};

        return {
            totalAssigned: Number( row.totalAssigned ?? 0 ),
            totalCompleted: Number( row.totalCompleted ?? 0 ),

            customerEligible: Number( row.customerEligible ?? 0 ),
            customerSatisfied: Number( row.customerSatisfied ?? 0 ),

            supervisorEligible: Number( row.supervisorEligible ?? 0 ),
            supervisorSatisfied: Number( row.supervisorSatisfied ?? 0 ),
        };
    }

    // --------------------------------------------------------------------------
    // Aggregation: Work items
    // --------------------------------------------------------------------------

    private static async aggregateWorkItems(
        memberId: string,
        from: Date,
        to: Date,
    ): Promise<{
        totalAssigned: number;
        totalCompleted: number;
        overdueCount: number;
        blockedCount: number;
        cancelledCount: number;
    }> {
        const pipeline: PipelineStage[] = [
            {
                $match: {
                    assignedMembers: memberId,
                    createdAt: { $gte: from, $lte: to },
                },
            },
            {
                $group: {
                    _id: null,
                    totalAssigned: { $sum: 1 },
                    totalCompleted: {
                        $sum: {
                            $cond: [
                                { $in: [ '$status', [ 'completed', 'done' ] ] },
                                1,
                                0,
                            ],
                        },
                    },
                    blockedCount: {
                        $sum: { $cond: [ { $eq: [ '$status', 'blocked' ] }, 1, 0 ] },
                    },
                    cancelledCount: {
                        $sum: { $cond: [ { $eq: [ '$status', 'cancelled' ] }, 1, 0 ] },
                    },
                    overdueCount: {
                        $sum: {
                            $cond: [
                                {
                                    $and: [
                                        { $in: [ '$status', [ 'pending', 'in_progress', 'blocked', 'open', 'backlog' ] ] },
                                        { $ne: [ '$plannedEndAt', null ] },
                                        { $lt: [ '$plannedEndAt', new Date() ] },
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
                    totalAssigned: { $ifNull: [ '$totalAssigned', 0 ] },
                    totalCompleted: { $ifNull: [ '$totalCompleted', 0 ] },
                    overdueCount: { $ifNull: [ '$overdueCount', 0 ] },
                    blockedCount: { $ifNull: [ '$blockedCount', 0 ] },
                    cancelledCount: { $ifNull: [ '$cancelledCount', 0 ] },
                },
            },
        ];

        const rows: Array<any> = await ( WorkItemModel as unknown as Model<any> ).aggregate( pipeline ).exec();
        const row: any = rows?.[ 0 ] ?? {};

        return {
            totalAssigned: Number( row.totalAssigned ?? 0 ),
            totalCompleted: Number( row.totalCompleted ?? 0 ),
            overdueCount: Number( row.overdueCount ?? 0 ),
            blockedCount: Number( row.blockedCount ?? 0 ),
            cancelledCount: Number( row.cancelledCount ?? 0 ),
        };
    }

    // --------------------------------------------------------------------------
    // Aggregation: Work events count (participation proxy)
    // --------------------------------------------------------------------------

    private static async aggregateWorkEventsCounts(
        memberId: string,
        from: Date,
        to: Date,
    ): Promise<{ totalActivities: number; }> {
        const pipeline: PipelineStage[] = [
            {
                $match: {
                    actorUserId: memberId,
                    createdAt: { $gte: from, $lte: to },
                },
            },
            {
                $group: {
                    _id: null,
                    totalActivities: { $sum: 1 },
                },
            },
            {
                $project: {
                    _id: 0,
                    totalActivities: { $ifNull: [ '$totalActivities', 0 ] },
                },
            },
        ];

        const rows: Array<any> = await ( WorkEventModel as unknown as Model<any> ).aggregate( pipeline ).exec();
        const row: any = rows?.[ 0 ] ?? {};
        return { totalActivities: Number( row.totalActivities ?? 0 ) };
    }

    // --------------------------------------------------------------------------
    // Trend aggregation (chart-ready)
    // - Uses WorkEvent.yearMonth / year / month / day fields (you already store these)
    // - This keeps it fast and index-friendly.
    // --------------------------------------------------------------------------

    private static async aggregateTrend(
        memberId: string,
        from: Date,
        to: Date,
        bucket: MemberProfileBucket,
    ): Promise<MemberProfileTrendPoint[]> {
        const keyExpr: any = this.getBucketKeyExpression( bucket );

        const pipeline: PipelineStage[] = [
            {
                $match: {
                    actorUserId: memberId,
                    createdAt: { $gte: from, $lte: to },
                },
            },
            {
                $group: {
                    _id: keyExpr,
                    activities: { $sum: 1 },
                },
            },
            {
                $project: {
                    _id: 0,
                    bucketKey: '$_id',
                    activities: 1,
                },
            },
            { $sort: { bucketKey: 1 } },
        ];

        const rows: Array<any> = await ( WorkEventModel as unknown as Model<any> ).aggregate( pipeline ).exec();

        // We only have event counts per bucket here.
        // The other metrics are derived using a conservative scoring baseline per bucket.
        // (We can evolve this later to include per-bucket completion/satisfaction using a larger pipeline.)
        return ( rows ?? [] ).map( ( r: any ) => {
            const activities: number = Number( r.activities ?? 0 );

            const participationScore: number = this.clampPct( activities >= 50 ? 100 : ( activities / 50 ) * 100 );

            return {
                bucket,
                bucketKey: String( r.bucketKey ?? '' ),
                completionRatePct: 0,
                customerSatisfactionPct: 0,
                supervisorSatisfactionPct: 0,
                participationScore,
                activities,
            };
        } );
    }

    private static getBucketKeyExpression( bucket: MemberProfileBucket ): any {
        // Uses your WorkEvent fields: yearMonth, year, month, day.
        // SQL mental model:
        // - GROUP BY bucketKey
        // Mongo mental model:
        // - $group: { _id: <expression> }
        if ( bucket === 'month' ) return '$yearMonth';

        if ( bucket === 'week' ) {
            // Week key from date (ISO week), still safe even if you don't store it.
            // If your Mongo version doesn't support $isoWeek, switch to $week (less strict).
            return {
                $concat: [
                    { $toString: '$year' },
                    '-W',
                    {
                        $cond: [
                            { $lt: [ { $isoWeek: '$createdAt' }, 10 ] },
                            { $concat: [ '0', { $toString: { $isoWeek: '$createdAt' } } ] },
                            { $toString: { $isoWeek: '$createdAt' } },
                        ],
                    },
                ],
            };
        }

        // day
        return {
            $dateToString: { format: '%Y-%m-%d', date: '$createdAt' },
        };
    }

    // --------------------------------------------------------------------------
    // Recent activity timeline (UI list)
    // --------------------------------------------------------------------------

    private static async aggregateRecentActivities(
        memberId: string,
        from: Date,
        to: Date,
        limit: number,
    ): Promise<MemberProfileRecentActivity[]> {
        const pipeline: PipelineStage[] = [
            {
                $match: {
                    actorUserId: memberId,
                    createdAt: { $gte: from, $lte: to },
                },
            },
            { $sort: { createdAt: -1 } },
            { $limit: limit },
            {
                $project: {
                    _id: 0,
                    createdAt: 1,
                    kind: 1,

                    teamId: 1,
                    payload: 1,

                    // Optional mapping (depends on your schema)
                    workItemId: 1,
                    taskId: 1,
                },
            },
        ];

        const rows: Array<any> = await ( WorkEventModel as unknown as Model<any> ).aggregate( pipeline ).exec();

        return ( rows ?? [] ).map( ( r: any ): MemberProfileRecentActivity => {
            const base: MemberProfileRecentActivity = {
                createdAt: ( r.createdAt instanceof Date ? r.createdAt.toISOString() : String( r.createdAt ?? '' ) ),
                kind: String( r.kind ?? '' ),
            };

            // IMPORTANT for exactOptionalPropertyTypes:
            // - Do NOT set optional props to undefined
            // - Only attach them when they have a real value

            if ( r.teamId ) {
                base.teamId = String( r.teamId );
            }

            if ( r.workItemId ) {
                base.workItemId = String( r.workItemId );
            }

            if ( r.taskId ) {
                base.taskId = String( r.taskId );
            }

            if ( r.payload && typeof r.payload === 'object' ) {
                base.payload = r.payload as Record<string, unknown>;
            }

            return base;
        } );

    }

    // --------------------------------------------------------------------------
    // Scoring helpers
    // --------------------------------------------------------------------------

    private static computeParticipationScore( input: {
        completionRatePct: number;
        customerSatisfactionPct: number;
        supervisorSatisfactionPct: number;
        activities: number;
    } ): number {
        // Weighting:
        // - Completion: 40%
        // - Customer:   30%
        // - Supervisor: 20%
        // - Activity:   10% (normalized to 0..100 by cap=100 events)
        const activityPct: number = this.clampPct( ( Math.min( 100, Math.max( 0, input.activities ) ) / 100 ) * 100 );

        const score: number =
            ( input.completionRatePct * 0.40 ) +
            ( input.customerSatisfactionPct * 0.30 ) +
            ( input.supervisorSatisfactionPct * 0.20 ) +
            ( activityPct * 0.10 );

        return this.clampPct( score );
    }

    private static safePct( numerator: number, denominator: number ): number {
        if ( !Number.isFinite( numerator ) || !Number.isFinite( denominator ) || denominator <= 0 ) return 0;
        return this.clampPct( ( numerator / denominator ) * 100 );
    }

    private static clampPct( v: number ): number {
        if ( !Number.isFinite( v ) ) return 0;
        if ( v < 0 ) return 0;
        if ( v > 100 ) return 100;
        return Math.round( v * 100 ) / 100;
    }

    private static clampRecentLimit( v: number ): number {
        const n: number = Number( v );
        if ( !Number.isFinite( n ) || n <= 0 ) return 50;
        return Math.min( this.MAX_RECENT_LIMIT, Math.floor( n ) );
    }
}
