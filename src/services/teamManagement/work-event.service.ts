// Path: src/services/workEvent.service.ts
// ─────────────────────────────────────────────────────────────────────────────
// WorkEventService
//   - Thin helper around WorkEventModel.create()
//   - Hides time-bucket calculations and ObjectId conversions
//   - Provides convenience methods for common events:
//       • status change
//       • priority change
//       • generic event with arbitrary payload
// ─────────────────────────────────────────────────────────────────────────────

import { Types } from 'mongoose';
import {
    IWorkEvent,
    WorkEventModel,
    WorkEventKind,
} from '../../models/teamManagement/workEvent.model';
import { IWorkItem } from '../../models/teamManagement/workItem.model';
import { TeamDomain } from '../../models/teamManagement/teamMain/teamManagement.model';
import {
    WorkItemPriority,
    WorkItemStatus,
} from '../../models/teamManagement/workItem.model';

export interface EventActorContext {
    userId?: Types.ObjectId | string | null;
    username?: string | null;
    role?: string | null;
}

interface BaseEventParams {
    workItem: IWorkItem;
    teamId: string;
    teamMongoId: Types.ObjectId;
    domain: TeamDomain;
    actor?: EventActorContext;
    createdAt?: Date;                        // optional override (for replay)
}

/**
 * Pure logging service – ALWAYS fire-and-forget from controllers.
 * Controllers should NOT depend on its result to decide API response.
 */
export class WorkEventService {

    // ───────────────────────────── Helpers ─────────────────────────────

    /**
     * Safely convert a potential ObjectId/string/null into a Types.ObjectId or undefined.
     */
    private static toObjectId(
        value?: Types.ObjectId | string | null,
    ): Types.ObjectId | undefined {
        if ( !value ) return undefined;
        if ( value instanceof Types.ObjectId ) return value;
        try {
            return new Types.ObjectId( value );
        } catch {
            return undefined;
        }
    }

    /**
     * Build time-bucket fields used for analytics and efficient querying.
     */
    private static buildTimeBuckets( date: Date = new Date() ): {
        createdAtIso: string;
        year: number;
        month: number;
        day: number;
        yearMonth: string;
    } {
        const d = date;
        const createdAtIso = d.toISOString();
        const year = d.getFullYear();
        const month = d.getMonth() + 1; // 1–12
        const day = d.getDate();        // 1–31
        const yearMonth = `${ year }-${ String( month ).padStart( 2, '0' ) }`;

        return { createdAtIso, year, month, day, yearMonth };
    }

    /**
     * Normalise actor (user) context.
     */
    private static buildActor( actor?: EventActorContext ) {
        const actorUserId = this.toObjectId( actor?.userId ?? null );
        const actorUsername =
            ( actor?.username ?? '' ).toString().trim() || undefined;
        const actorRole =
            ( actor?.role ?? '' ).toString().trim() || undefined;

        return { actorUserId, actorUsername, actorRole };
    }

    // ─────────────────────- Low-level generic logger ────────────────────

    /**
     * Lowest-level logger. All other helper methods call this.
     *
     * NOTE (exactOptionalPropertyTypes):
     *  - All optional fields that can be "missing OR undefined" are typed as
     *    `?: T | undefined` so that callers passing `T | undefined` are assignable.
     */
    public static async logEvent( params: BaseEventParams & {
        kind: WorkEventKind;
        payload?: Record<string, unknown> | undefined;
        fromStatus?: WorkItemStatus | undefined;
        toStatus?: WorkItemStatus | undefined;
        fromPriority?: WorkItemPriority | undefined;
        toPriority?: WorkItemPriority | undefined;
    } ): Promise<void> {
        try {
            const {
                workItem,
                teamId,
                teamMongoId,
                domain,
                actor,
                createdAt,
                kind,
                payload,
                fromStatus,
                toStatus,
                fromPriority,
                toPriority,
            } = params;

            // Ensure we always have a proper ObjectId and a canonical string id
            const workItemMongoId: Types.ObjectId = workItem._id as Types.ObjectId;
            const workItemId: string = workItemMongoId.toHexString();

            const {
                createdAtIso,
                year,
                month,
                day,
                yearMonth,
            } = this.buildTimeBuckets( createdAt ?? new Date() );

            const {
                actorUserId,
                actorUsername,
                actorRole,
            } = this.buildActor( actor );

            // Plain event payload – we deliberately do NOT try to satisfy Document here.
            const doc: {
                workItemId: string;
                workItemMongoId: Types.ObjectId;
                teamId: string;
                teamMongoId: Types.ObjectId;
                domain: TeamDomain;
                kind: WorkEventKind;
                actorUserId?: Types.ObjectId | undefined;
                actorUsername?: string | undefined;
                actorRole?: string | undefined;
                fromStatus?: WorkItemStatus | undefined;
                toStatus?: WorkItemStatus | undefined;
                fromPriority?: WorkItemPriority | undefined;
                toPriority?: WorkItemPriority | undefined;
                payload?: Record<string, unknown> | undefined;
                createdAt: string;
                year: number;
                month: number;
                day: number;
                yearMonth: string;
            } = {
                workItemId,
                workItemMongoId,
                teamId,
                teamMongoId,
                domain,
                kind,
                actorUserId,
                actorUsername,
                actorRole,
                fromStatus,
                toStatus,
                fromPriority,
                toPriority,
                payload,
                createdAt: createdAtIso,
                year,
                month,
                day,
                yearMonth,
            };

            // Mongoose adds all Document methods/_id, so we cast once at the boundary.
            await WorkEventModel.create( doc as unknown as IWorkEvent );
        } catch ( err ) {
            // IMPORTANT:
            //  - logging must NEVER crash the main request.
            //  - keep it as console error only.
            //  - if you want, later add winston/pino logger here.
            // eslint-disable-next-line no-console
            console.error( '[WorkEventService] Failed to log event:', err );
        }
    }

    // ───────────────── HIGH-LEVEL HELPERS (recommended) ─────────────────

    public static async logWorkItemCreated( params: BaseEventParams ): Promise<void> {
        await this.logEvent( {
            ...params,
            kind: 'workitem_created',
            payload: {
                title: params.workItem.title,
                status: params.workItem.status,
                priority: params.workItem.priority,
            },
        } );
    }

    public static async logStatusChange( params: BaseEventParams & {
        // fromStatus may be missing (first status) OR explicitly undefined.
        fromStatus?: WorkItemStatus | undefined;
        toStatus: WorkItemStatus;
    } ): Promise<void> {
        const { fromStatus, toStatus } = params;

        await this.logEvent( {
            ...params,
            kind: 'status_changed',
            fromStatus,
            toStatus,
            payload: {
                fromStatus,
                toStatus,
            },
        } );
    }

    public static async logPriorityChange( params: BaseEventParams & {
        fromPriority?: WorkItemPriority | undefined;
        toPriority: WorkItemPriority;
    } ): Promise<void> {
        const { fromPriority, toPriority } = params;

        await this.logEvent( {
            ...params,
            kind: 'priority_changed',
            fromPriority,
            toPriority,
            payload: {
                fromPriority,
                toPriority,
            },
        } );
    }

    public static async logValueUpdated( params: BaseEventParams & {
        previousExpected?: number | undefined;
        previousActual?: number | undefined;
    } ): Promise<void> {
        const wi = params.workItem;

        await this.logEvent( {
            ...params,
            kind: 'value_updated',
            payload: {
                previousExpected: params.previousExpected,
                previousActual: params.previousActual,
                expectedValue: wi.expectedValue,
                actualValue: wi.actualValue,
                commissionAmount: wi.commissionAmount,
            },
        } );
    }

    public static async logEvidenceAdded( params: BaseEventParams & {
        evidenceCountAdded: number;
    } ): Promise<void> {
        await this.logEvent( {
            ...params,
            kind: 'evidence_added',
            payload: {
                evidenceCountAdded: params.evidenceCountAdded,
            },
        } );
    }

    public static async logCommentAdded( params: BaseEventParams & {
        commentId?: string | undefined;
        commentPreview?: string | undefined;
    } ): Promise<void> {
        await this.logEvent( {
            ...params,
            kind: 'comment_added',
            payload: {
                commentId: params.commentId,
                commentPreview: params.commentPreview,
            },
        } );
    }

    public static async logTeamChanged( params: BaseEventParams & {
        fromTeamId: string;
        toTeamId: string;
    } ): Promise<void> {
        await this.logEvent( {
            ...params,
            kind: 'team_changed',
            payload: {
                fromTeamId: params.fromTeamId,
                toTeamId: params.toTeamId,
            },
        } );
    }

    public static async logDomainChanged( params: BaseEventParams & {
        fromDomain: TeamDomain;
        toDomain: TeamDomain;
    } ): Promise<void> {
        await this.logEvent( {
            ...params,
            kind: 'domain_changed',
            payload: {
                fromDomain: params.fromDomain,
                toDomain: params.toDomain,
            },
        } );
    }
}
