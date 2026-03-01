// Path: src/services/teamManagement/workEvent.service.ts
// ─────────────────────────────────────────────────────────────────────────────
// WorkEventService (Pure logging / fire-and-forget)
// - Aligns time buckets with WorkEventModel (UTC-based)
// - exactOptionalPropertyTypes-safe: optional fields are OMITTED (no undefined)
// - Robust ObjectId normalization for workItem + actor
// ─────────────────────────────────────────────────────────────────────────────

import { Types } from "mongoose";

import {
    WorkEventModel,
    type WorkEventKind,
    type WorkEventSource,
    type WorkEventDelta,
    type WorkEventSnapshot,
} from "../../models/teamManagement/workEvent.model";

import type { IWorkItem } from "../../models/teamManagement/workItems/workItem.model";
import type { TeamDomain } from "../../types/teamManagement/teamMain/teamManagement.types";
import type {
    WorkItemPriority,
    WorkItemStatus,
} from "../../types/teamManagement/workItem/workItem.types";

/**
 * Actor context (who triggered the event).
 *
 * @param userId
 * - Expected: Mongo ObjectId or its hex string
 *
 * @param username
 * - Expected: non-empty username string
 *
 * @param role
 * - Expected: role label (Admin/Agent/etc.)
 */
export interface EventActorContext {
    userId?: Types.ObjectId | string | null;
    username?: string | null;
    role?: string | null;
}

/**
 * Base parameters for any WorkEvent log call.
 *
 * @param workItem
 * - Expected: Mongoose WorkItem document (or a compatible object) containing `_id`
 *
 * @param teamId
 * - Expected: Team code/string id stored in WorkEventModel.teamId
 *
 * @param teamMongoId
 * - Expected: Team ObjectId stored in WorkEventModel.teamMongoId
 *
 * @param domain
 * - Expected: TeamDomain enum value
 *
 * @param actor
 * - Optional: actor context (who did the change)
 *
 * @param createdAt
 * - Optional: force event timestamp (useful for replay/import)
 *
 * @param source
 * - Optional: "ui" | "system" | "automation" | "import"
 *
 * @param requestId
 * - Optional: correlation id (if you have requestId middleware)
 *
 * @param deviceId
 * - Optional: device identifier (desktop/mobile/etc.)
 */
interface BaseEventParams {
    workItem: IWorkItem;
    teamId: string;
    teamMongoId: Types.ObjectId;
    domain: TeamDomain;
    actor?: EventActorContext;
    createdAt?: Date;
    source?: WorkEventSource;
    requestId?: string;
    deviceId?: string;
}

/**
 * Create-doc shape for WorkEventModel.create().
 * (Not the Mongoose Document type — this is the insert payload.)
 */
interface WorkEventCreateDoc {
    workItemId: string;
    workItemMongoId: Types.ObjectId;

    teamId: string;
    teamMongoId: Types.ObjectId;

    domain: TeamDomain;
    kind: WorkEventKind;

    actorUserId?: Types.ObjectId;
    actorUsername?: string;
    actorRole?: string;

    source?: WorkEventSource;
    requestId?: string;
    deviceId?: string;

    fromStatus?: WorkItemStatus;
    toStatus?: WorkItemStatus;

    fromPriority?: WorkItemPriority;
    toPriority?: WorkItemPriority;

    delta?: WorkEventDelta[];
    payload?: Record<string, unknown>;
    snapshot?: WorkEventSnapshot;

    createdAt: string;

    year: number;
    month: number;
    day: number;
    yearMonth: string;

    weekOfYear?: number;
    hour?: number;
}

/**
 * Pure logging service – ALWAYS fire-and-forget from controllers.
 * Controllers must NOT depend on its result to decide API response.
 */
export class WorkEventService {
    private constructor () {}

    // ───────────────────────────── Helpers ─────────────────────────────

  /**
   * Safely convert a potential ObjectId/string/null into a Types.ObjectId.
   *
   * @param value
   * - Expected: Types.ObjectId | 24-hex string | null
   *
   * @returns Types.ObjectId | null
   * - Returns null if conversion fails.
   */
    private static toObjectIdOrNull(
        value?: Types.ObjectId | string | null,
  ): Types.ObjectId | null {
      if ( !value ) return null;
      if ( value instanceof Types.ObjectId ) return value;

      try {
        return new Types.ObjectId( String( value ) );
    } catch {
          return null;
      }
  }

  /**
   * Build time-bucket fields used for analytics and efficient querying.
   * IMPORTANT: uses UTC to match WorkEventModel pre-validate hook.
   *
   * @param date
   * - Optional: timestamp for bucketing (defaults to now)
   */
    private static buildTimeBucketsUtc( date?: Date ): {
        createdAtIso: string;
        year: number;
        month: number;
        day: number;
        yearMonth: string;
      hour: number;
  } {
      const raw: Date = date ?? new Date();
      const safe: Date = Number.isNaN( raw.getTime() ) ? new Date() : raw;

      const createdAtIso: string = safe.toISOString();

      const year: number = safe.getUTCFullYear();
      const month: number = safe.getUTCMonth() + 1; // 1–12
      const day: number = safe.getUTCDate(); // 1–31
      const hour: number = safe.getUTCHours();

      const yearMonth: string = `${ year }-${ String( month ).padStart( 2, "0" ) }`;

      return { createdAtIso, year, month, day, yearMonth, hour };
  }

  /**
   * Normalise actor context.
   *
   * @param actor
   * - Optional actor payload (userId/username/role)
   *
   * @returns object with optional fields OMITTED when empty
   */
    private static buildActor( actor?: EventActorContext ): {
        actorUserId?: Types.ObjectId;
        actorUsername?: string;
        actorRole?: string;
    } {
        const actorUserId: Types.ObjectId | null = this.toObjectIdOrNull(
            actor?.userId ?? null,
        );

      const actorUsernameRaw: string = String( actor?.username ?? "" ).trim();
      const actorRoleRaw: string = String( actor?.role ?? "" ).trim();

      return {
          ...( actorUserId ? { actorUserId } : {} ),
          ...( actorUsernameRaw ? { actorUsername: actorUsernameRaw } : {} ),
          ...( actorRoleRaw ? { actorRole: actorRoleRaw } : {} ),
      };
  }

    /**
     * Safely read workItem._id as Types.ObjectId.
     *
     * @param workItem
     * - Expected: object containing `_id` as ObjectId or hex string
     */
    private static readWorkItemMongoIdOrThrow( workItem: IWorkItem ): Types.ObjectId {
        const raw: unknown = ( workItem as unknown as { _id?: unknown; } )._id;

        if ( raw instanceof Types.ObjectId ) return raw;

        const parsed: Types.ObjectId | null = this.toObjectIdOrNull(
            typeof raw === "string" ? raw : null,
        );

        if ( !parsed ) {
            throw new Error( "WORK_ITEM_ID_INVALID: workItem._id is missing/invalid" );
        }

        return parsed;
    }

    // ───────────────────── Low-level generic logger ─────────────────────

  /**
   * Lowest-level logger. All other helper methods call this.
   *
   * @param params.kind
   * - Expected: WorkEventKind union (e.g., "status_changed")
   *
   * @param params.payload
   * - Optional: arbitrary JSON payload for the event
   *
   * @param params.fromStatus / params.toStatus
   * - Optional: status transition markers
   *
   * @param params.fromPriority / params.toPriority
   * - Optional: priority transition markers
   *
   * @param params.delta
   * - Optional: structured diff array (field/from/to)
   *
   * @param params.snapshot
   * - Optional: context snapshot (team/work item info, assignees, etc.)
   */
    public static async logEvent(
        params: BaseEventParams & {
            kind: WorkEventKind;
        payload?: Record<string, unknown>;
        fromStatus?: WorkItemStatus;
        toStatus?: WorkItemStatus;
        fromPriority?: WorkItemPriority;
        toPriority?: WorkItemPriority;
        delta?: WorkEventDelta[];
        snapshot?: WorkEventSnapshot;
    },
  ): Promise<void> {
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
          delta,
          snapshot,
          source,
          requestId,
          deviceId,
      } = params;

        const workItemMongoId: Types.ObjectId =
            this.readWorkItemMongoIdOrThrow( workItem );
        const workItemId: string = workItemMongoId.toHexString();

        const buckets = this.buildTimeBucketsUtc( createdAt );
        const actorDoc = this.buildActor( actor );

        const sourceTrim: string = String( source ?? "" ).trim();
        const requestIdTrim: string = String( requestId ?? "" ).trim();
        const deviceIdTrim: string = String( deviceId ?? "" ).trim();

        const doc: WorkEventCreateDoc = {
            workItemId,
            workItemMongoId,
            teamId,
            teamMongoId,
            domain,
            kind,

          ...actorDoc,

          ...( sourceTrim ? { source: sourceTrim as WorkEventSource } : {} ),
          ...( requestIdTrim ? { requestId: requestIdTrim } : {} ),
          ...( deviceIdTrim ? { deviceId: deviceIdTrim } : {} ),

          ...( fromStatus ? { fromStatus } : {} ),
          ...( toStatus ? { toStatus } : {} ),

          ...( fromPriority ? { fromPriority } : {} ),
          ...( toPriority ? { toPriority } : {} ),

          ...( delta && delta.length ? { delta } : {} ),
          ...( payload && Object.keys( payload ).length ? { payload } : {} ),
          ...( snapshot ? { snapshot } : {} ),

          createdAt: buckets.createdAtIso,
          year: buckets.year,
          month: buckets.month,
          day: buckets.day,
          yearMonth: buckets.yearMonth,
          hour: buckets.hour,
      };

        // Fire-and-forget insert. We still await to avoid unhandled rejection noise.
        await WorkEventModel.create( doc );
    } catch ( err ) {
    // eslint-disable-next-line no-console
          console.error(
              `[Error:] [WorkEventService] Failed to log event: ${ String(
                  ( err as Error )?.message ?? err,
              ) }\n`,
          );
      }
  }

    // ───────────────── HIGH-LEVEL HELPERS (recommended) ─────────────────

    /**
     * Log work item created event.
     *
     * @param params
     * - Uses BaseEventParams fields
     */
    public static async logWorkItemCreated( params: BaseEventParams ): Promise<void> {
        await this.logEvent( {
            ...params,
        kind: "workitem_created",
        payload: {
            title: ( params.workItem as unknown as { title?: unknown; } ).title,
            status: ( params.workItem as unknown as { status?: unknown; } ).status,
            priority: ( params.workItem as unknown as { priority?: unknown; } ).priority,
        },
    } );
  }

    /**
     * Log status transition event.
     *
     * @param params.fromStatus
     * - Optional previous status
     *
     * @param params.toStatus
     * - Required next status
     */
    public static async logStatusChange(
        params: BaseEventParams & {
            fromStatus?: WorkItemStatus;
            toStatus: WorkItemStatus;
      },
  ): Promise<void> {
      const { fromStatus, toStatus } = params;

      await this.logEvent( {
          ...params,
        kind: "status_changed",
        ...( fromStatus ? { fromStatus } : {} ),
        toStatus,
        payload: {
            ...( fromStatus ? { fromStatus } : {} ),
            toStatus,
        },
        delta: [
            {
                field: "status",
                ...( fromStatus ? { from: fromStatus } : {} ),
                to: toStatus,
            },
        ],
    } );
  }

    /**
     * Log priority transition event.
     *
     * @param params.fromPriority
     * - Optional previous priority
     *
     * @param params.toPriority
     * - Required next priority
     */
    public static async logPriorityChange(
        params: BaseEventParams & {
            fromPriority?: WorkItemPriority;
            toPriority: WorkItemPriority;
      },
  ): Promise<void> {
      const { fromPriority, toPriority } = params;

      await this.logEvent( {
          ...params,
        kind: "priority_changed",
        ...( fromPriority ? { fromPriority } : {} ),
        toPriority,
        payload: {
            ...( fromPriority ? { fromPriority } : {} ),
            toPriority,
        },
        delta: [
            {
                field: "priority",
                ...( fromPriority ? { from: fromPriority } : {} ),
                to: toPriority,
            },
        ],
    } );
  }

    /**
     * Log numeric value update event.
     *
     * @param params.previousExpected
     * - Optional: prior expected value (number)
     *
     * @param params.previousActual
     * - Optional: prior actual value (number)
     */
    public static async logValueUpdated(
        params: BaseEventParams & {
            previousExpected?: number;
            previousActual?: number;
        },
    ): Promise<void> {
        const wi = params.workItem as unknown as {
            expectedValue?: unknown;
            actualValue?: unknown;
            commissionAmount?: unknown;
        };

      await this.logEvent( {
          ...params,
        kind: "value_updated",
        payload: {
            ...( typeof params.previousExpected === "number"
                ? { previousExpected: params.previousExpected }
                : {} ),
            ...( typeof params.previousActual === "number"
                ? { previousActual: params.previousActual }
                : {} ),
            expectedValue: wi.expectedValue,
            actualValue: wi.actualValue,
            commissionAmount: wi.commissionAmount,
        },
    } );
  }

    /**
     * Log evidence added event.
     *
     * @param params.evidenceCountAdded
     * - Required: how many evidence items were added
     */
    public static async logEvidenceAdded(
        params: BaseEventParams & { evidenceCountAdded: number; },
    ): Promise<void> {
        await this.logEvent( {
            ...params,
        kind: "evidence_added",
        payload: { evidenceCountAdded: params.evidenceCountAdded },
    } );
    }

    /**
     * Log comment added event.
     *
     * @param params.commentId
     * - Optional: comment id
     *
     * @param params.commentPreview
     * - Optional: short preview text
     */
    public static async logCommentAdded(
        params: BaseEventParams & {
            commentId?: string;
            commentPreview?: string;
        },
  ): Promise<void> {
      const commentIdTrim: string = String( params.commentId ?? "" ).trim();
      const commentPreviewTrim: string = String( params.commentPreview ?? "" ).trim();

      await this.logEvent( {
          ...params,
        kind: "comment_added",
        payload: {
            ...( commentIdTrim ? { commentId: commentIdTrim } : {} ),
            ...( commentPreviewTrim ? { commentPreview: commentPreviewTrim } : {} ),
        },
    } );
  }

    /**
     * Log team changed event.
     *
     * @param params.fromTeamId
     * - Required: previous teamId string
     *
     * @param params.toTeamId
     * - Required: new teamId string
     */
    public static async logTeamChanged(
        params: BaseEventParams & { fromTeamId: string; toTeamId: string; },
    ): Promise<void> {
        await this.logEvent( {
            ...params,
        kind: "team_changed",
        payload: { fromTeamId: params.fromTeamId, toTeamId: params.toTeamId },
        delta: [
            { field: "teamId", from: params.fromTeamId, to: params.toTeamId },
        ],
    } );
  }

    /**
     * Log domain changed event.
     *
     * @param params.fromDomain
     * - Required: previous domain
     *
     * @param params.toDomain
     * - Required: new domain
     */
    public static async logDomainChanged(
        params: BaseEventParams & { fromDomain: TeamDomain; toDomain: TeamDomain; },
    ): Promise<void> {
        await this.logEvent( {
            ...params,
        kind: "domain_changed",
        payload: { fromDomain: params.fromDomain, toDomain: params.toDomain },
        delta: [
            { field: "domain", from: params.fromDomain, to: params.toDomain },
        ],
    } );
  }
}