// Path: src/models/teamManagement/workEvent.model.ts
// ─────────────────────────────────────────────────────────────────────────────
// WorkEvent model (KPI-ready, event-driven, analytics-friendly)
//
// FIXES APPLIED
// ✅ Adds Lean-safe DTO export: WorkEventDto (no Types.ObjectId in API layer)
// ✅ Keeps Mongoose Document type: IWorkEvent (ObjectId fields remain here)
// ✅ Removes "default: undefined" anti-pattern (use no default or null)
// ✅ Aligns enums with WorkItem.model exports (priority/status arrays)
// ✅ Fixes schema typing + improves routing key middleware stability
// ✅ Keeps class-based architecture + static helper for middleware math
// ─────────────────────────────────────────────────────────────────────────────

import { Schema, model, type Document, type Model, Types } from "mongoose";

import type { ISODateString } from "../../types/common";
import { TEAM_DOMAINS, type TeamDomain } from "./teamManagement.model";
import {
    WORK_ITEM_PRIORITIES,
    WORK_ITEM_STATUSES,
    type WorkItemPriority,
    type WorkItemStatus,
} from "./workItem.model";

/**
 * KPI/Analytics goal for WorkEvent:
 * - Immutable audit log (append-only)
 * - Enough "routing keys" to aggregate fast (domain, team, user, yearMonth, etc.)
 * - Enough "context snapshot" to compute KPIs even if names/roles change later
 * - Enough "delta" detail to compute advanced metrics (status transitions, assignment ownership history, SLA breaches, etc.)
 */

export type WorkEventKind =
    | "workitem_created"
    | "status_changed"
    | "priority_changed"
    | "assigned_members_changed"
    | "value_updated"
    | "evidence_added"
    | "comment_added"
    | "team_changed"
    | "domain_changed"
    // KPI-ready extensions
    | "sla_updated"
    | "blocked"
    | "unblocked"
    | "timer_started"
    | "timer_stopped"
    | "completion_requested"
    | "completion_confirmed"
    | "completion_rejected"
    | "reopened";

export type WorkEventSource = "ui" | "system" | "automation" | "import";

export interface WorkEventDelta {
    field: string; // ex: "status", "priority", "assignedMembers", "sla.dueAt"
    from?: unknown;
    to?: unknown;
}

export interface WorkEventSnapshot {
    teamName?: string;
    teamCode?: string;

    domain?: TeamDomain;

    workItemName?: string;
    workItemType?: string;

    // At the time of event (Document stores ObjectId; DTO uses string)
    assigneeUserIds?: Types.ObjectId[];
    assigneeUsernames?: string[];

    priority?: WorkItemPriority;
    status?: WorkItemStatus;
}

// ─────────────────────────────────────────────
// DTO (Lean-safe API contract) ✅
// ─────────────────────────────────────────────

export interface WorkEventDto {
    workItemId: string;
    workItemMongoId: string;

    teamId: string;
    teamMongoId: string;

    domain: TeamDomain;

    kind: WorkEventKind;

    actorUserId?: string;
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

    snapshot?: {
        teamName?: string;
        teamCode?: string;
        domain?: TeamDomain;
        workItemName?: string;
        workItemType?: string;
        assigneeUserIds?: string[];
        assigneeUsernames?: string[];
        priority?: WorkItemPriority;
        status?: WorkItemStatus;
    };

    createdAt: ISODateString;

    year: number;
    month: number;
    day: number;
    yearMonth: string;

    weekOfYear?: number;
    hour?: number;
}

// ─────────────────────────────────────────────
// Document type (Mongoose only) ✅
// ─────────────────────────────────────────────

export interface IWorkEvent extends Document {
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

    createdAt: ISODateString;

    year: number;
    month: number;
    day: number;
    yearMonth: string;

    weekOfYear?: number;
    hour?: number;
}

class WorkEventModelBuilder {
    private readonly deltaSchema: Schema<WorkEventDelta>;
    private readonly snapshotSchema: Schema<WorkEventSnapshot>;

    public constructor () {
        this.deltaSchema = this.buildDeltaSchema();
        this.snapshotSchema = this.buildSnapshotSchema();
    }

    private buildDeltaSchema(): Schema<WorkEventDelta> {
        return new Schema<WorkEventDelta>(
            {
                field: { type: String, required: true, trim: true },
                // IMPORTANT:
                // - Don't set default undefined (it makes documents noisy)
                // - When absent, Mongo simply doesn't store the field.
                from: { type: Schema.Types.Mixed, required: false },
                to: { type: Schema.Types.Mixed, required: false },
            },
            { _id: false, timestamps: false },
        );
    }

    private buildSnapshotSchema(): Schema<WorkEventSnapshot> {
        return new Schema<WorkEventSnapshot>(
            {
                teamName: { type: String, required: false, default: "" },
                teamCode: { type: String, required: false, default: "" },

                domain: { type: String, enum: [ ...TEAM_DOMAINS ], required: false },

                workItemName: { type: String, required: false, default: "" },
                workItemType: { type: String, required: false, default: "" },

                assigneeUserIds: [ { type: Schema.Types.ObjectId, ref: "User", required: false } ],
                assigneeUsernames: [ { type: String, required: false, default: "" } ],

                priority: { type: String, enum: [ ...WORK_ITEM_PRIORITIES ], required: false },
                status: { type: String, enum: [ ...WORK_ITEM_STATUSES ], required: false },
            },
            { _id: false, timestamps: false },
        );
    }

    private buildYearMonth( d: Date ): string {
        const y: number = d.getUTCFullYear();
        const m: string = String( d.getUTCMonth() + 1 ).padStart( 2, "0" );
        return `${ y }-${ m }`;
    }

    private buildWorkEventSchema(): Schema<IWorkEvent> {
        const schema: Schema<IWorkEvent> = new Schema<IWorkEvent>(
            {
                // Work item (many events per work item => NOT unique)
                workItemId: { type: String, required: true, index: true, trim: true },
                workItemMongoId: { type: Schema.Types.ObjectId, required: true, ref: "WorkItem", index: true },

                teamId: { type: String, required: true, trim: true, index: true },
                teamMongoId: { type: Schema.Types.ObjectId, required: true, ref: "TeamManagement", index: true },

                domain: { type: String, enum: [ ...TEAM_DOMAINS ], required: true, index: true },

                kind: {
                    type: String,
                    enum: [
                        "workitem_created",
                        "status_changed",
                        "priority_changed",
                        "assigned_members_changed",
                        "value_updated",
                        "evidence_added",
                        "comment_added",
                        "team_changed",
                        "domain_changed",
                        "sla_updated",
                        "blocked",
                        "unblocked",
                        "timer_started",
                        "timer_stopped",
                        "completion_requested",
                        "completion_confirmed",
                        "completion_rejected",
                        "reopened",
                    ],
                    required: true,
                    index: true,
                },

                actorUserId: { type: Schema.Types.ObjectId, ref: "User", required: false, index: true },
                actorUsername: { type: String, required: false, trim: true, index: true },
                actorRole: { type: String, required: false, trim: true },

                source: { type: String, enum: [ "ui", "system", "automation", "import" ], required: false, default: "ui" },
                requestId: { type: String, required: false, default: "", index: true },
                deviceId: { type: String, required: false, default: "" },

                fromStatus: { type: String, enum: [ ...WORK_ITEM_STATUSES ], required: false },
                toStatus: { type: String, enum: [ ...WORK_ITEM_STATUSES ], required: false },

                fromPriority: { type: String, enum: [ ...WORK_ITEM_PRIORITIES ], required: false },
                toPriority: { type: String, enum: [ ...WORK_ITEM_PRIORITIES ], required: false },

                delta: { type: [ this.deltaSchema ], required: false, default: [] },

                payload: { type: Schema.Types.Mixed, required: false },

                snapshot: { type: this.snapshotSchema, required: false },

                createdAt: { type: String, required: true, default: () => new Date().toISOString(), index: true },

                year: { type: Number, required: true, default: () => new Date().getUTCFullYear(), index: true },
                month: { type: Number, required: true, default: () => new Date().getUTCMonth() + 1, index: true },
                day: { type: Number, required: true, default: () => new Date().getUTCDate(), index: true },

                yearMonth: { type: String, required: true, default: () => this.buildYearMonth( new Date() ), index: true },

                weekOfYear: { type: Number, required: false, default: () => WorkEventModelBuilderStatic.calculateWeekOfYearUTC( new Date() ), index: true },
                hour: { type: Number, required: false, default: () => new Date().getUTCHours(), index: true },
            },
            { timestamps: false },
        );

        // Core analytics indexes
        schema.index( { workItemId: 1, createdAt: 1 } );
        schema.index( { workItemMongoId: 1, createdAt: 1 } );

        schema.index( { teamId: 1, createdAt: 1 } );
        schema.index( { teamMongoId: 1, createdAt: 1 } );

        schema.index( { domain: 1, kind: 1, createdAt: 1 } );

        schema.index( { year: 1, month: 1, kind: 1 } );
        schema.index( { yearMonth: 1, kind: 1 } );
        schema.index( { yearMonth: 1, domain: 1 } );

        schema.index( { actorUserId: 1, createdAt: -1 } );
        schema.index( { actorUsername: 1, createdAt: -1 } );

        schema.index( { year: 1, weekOfYear: 1, domain: 1 } );
        schema.index( { year: 1, weekOfYear: 1, kind: 1 } );

        schema.index( { actorUsername: "text", actorRole: "text" } );

        // Keep routing keys consistent if createdAt is manually provided
        schema.pre<IWorkEvent>( "validate", function ( next ) {
            try {
                const createdAtRaw: string = String( this.createdAt ?? "" ).trim();
                const d: Date = createdAtRaw ? new Date( createdAtRaw ) : new Date();

                const safe: Date = isNaN( d.getTime() ) ? new Date() : d;

                this.createdAt = safe.toISOString();

                this.year = safe.getUTCFullYear();
                this.month = safe.getUTCMonth() + 1;
                this.day = safe.getUTCDate();

                this.yearMonth = `${ safe.getUTCFullYear() }-${ String( safe.getUTCMonth() + 1 ).padStart( 2, "0" ) }`;
                this.weekOfYear = WorkEventModelBuilderStatic.calculateWeekOfYearUTC( safe );
                this.hour = safe.getUTCHours();

                next();
                return;
            } catch ( err ) {
                next( err as Error );
                return;
            }
        } );

        return schema;
    }

    public buildModel(): Model<IWorkEvent> {
        const schema: Schema<IWorkEvent> = this.buildWorkEventSchema();
        return model<IWorkEvent>( "WorkEvent", schema, "work_events" );
    }
}

/**
 * Middleware-safe static helper.
 * Keeps class-based style without relying on instance method calls from hooks.
 */
class WorkEventModelBuilderStatic {
    public static calculateWeekOfYearUTC( d: Date ): number {
        const date: Date = new Date( Date.UTC( d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() ) );
        const dayNum: number = date.getUTCDay() || 7; // Mon=1..Sun=7
        date.setUTCDate( date.getUTCDate() + 4 - dayNum ); // Thursday anchor
        const yearStart: Date = new Date( Date.UTC( date.getUTCFullYear(), 0, 1 ) );
        const diffDays: number = Math.floor( ( date.getTime() - yearStart.getTime() ) / 86400000 );
        return Math.floor( diffDays / 7 ) + 1;
    }
}

const workEventModelBuilder: WorkEventModelBuilder = new WorkEventModelBuilder();
export const WorkEventModel: Model<IWorkEvent> = workEventModelBuilder.buildModel();
