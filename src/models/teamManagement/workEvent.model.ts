// Path: src/models/teamManagement/workEvent.model.ts
// ─────────────────────────────────────────────────────────────────────────────
// WorkEvent model
//   - Immutable event log for WorkItem lifecycle and related actions.
//   - Designed for analytics & auditing:
//       • Per work item / per team / per domain
//       • Status / priority change history
//       • Time-series dashboards (year/month/day, yearMonth)
// ─────────────────────────────────────────────────────────────────────────────

import {
    Schema,
    model,
    type Document,
    type Model,
    Types,
} from 'mongoose';

import { ISODateString } from '../../types/common';
import { TeamDomain } from './teamManagement.model';
import {
    WorkItemPriority,
    WorkItemStatus,
} from './workItem.model';

// ─────────────────────────────────────────────
// Event kind
// ─────────────────────────────────────────────

export type WorkEventKind =
    | 'workitem_created'
    | 'status_changed'
    | 'priority_changed'
    | 'assigned_members_changed'
    | 'value_updated'
    | 'evidence_added'
    | 'comment_added'
    | 'team_changed'
    | 'domain_changed';

// ─────────────────────────────────────────────
// Document interface
// ─────────────────────────────────────────────

export interface IWorkEvent extends Document {
    workItemId: string;              // IWorkItem.id (human code)
    workItemMongoId: Types.ObjectId; // IWorkItem._id
    teamId: string;
    teamMongoId: Types.ObjectId;
    domain: TeamDomain;

    kind: WorkEventKind;

    // Actor
    actorUserId?: Types.ObjectId;
    actorUsername?: string;
    actorRole?: string;              // role at time of action (snapshot)

    // Event diff payload
    fromStatus?: WorkItemStatus;
    toStatus?: WorkItemStatus;

    fromPriority?: WorkItemPriority;
    toPriority?: WorkItemPriority;

    // Generic payload – arbitrary extra info (comment text, old/new values, etc.)
    payload?: Record<string, unknown>;

    createdAt: ISODateString;

    // For fast time-based grouping
    year: number;
    month: number;        // 1–12
    day: number;          // 1–31
    yearMonth: string;    // "2025-12"
}

// ─────────────────────────────────────────────
// Model builder
// ─────────────────────────────────────────────

class WorkEventModelBuilder {
    private buildWorkEventSchema(): Schema<IWorkEvent> {
        const schema: Schema<IWorkEvent> = new Schema<IWorkEvent>(
            {
                // Core linkage
                workItemId: {
                    type: String,
                    required: true,
                    index: true,
                    trim: true,
                    unique: true,
                },
                workItemMongoId: {
                    type: Schema.Types.ObjectId,
                    required: true,
                    ref: 'WorkItem',
                    index: true,
                },
                teamId: {
                    type: String,
                    required: true,
                    trim: true,
                    index: true,
                },
                teamMongoId: {
                    type: Schema.Types.ObjectId,
                    required: true,
                    ref: 'TeamManagement',
                    index: true,
                },
                domain: {
                    type: String,
                    enum: [
                        'sales',
                        'development',
                        'support',
                        'operations',
                        'marketing',
                        'finance',
                        'other',
                    ],
                    required: true,
                    index: true,
                },

                // What happened
                kind: {
                    type: String,
                    enum: [
                        'workitem_created',
                        'status_changed',
                        'priority_changed',
                        'assigned_members_changed',
                        'value_updated',
                        'evidence_added',
                        'comment_added',
                        'team_changed',
                        'domain_changed',
                    ],
                    required: true,
                    index: true,
                },

                // Actor
                actorUserId: {
                    type: Schema.Types.ObjectId,
                    ref: 'User',
                    required: false,
                    index: true,
                },
                actorUsername: {
                    type: String,
                    required: false,
                    trim: true,
                },
                actorRole: {
                    type: String,
                    required: false,
                    trim: true,
                },

                // Diffs / changes
                fromStatus: {
                    type: String,
                    enum: [
                        'draft',
                        'pending',
                        'in_progress',
                        'blocked',
                        'completed',
                        'cancelled',
                    ],
                    required: false,
                },
                toStatus: {
                    type: String,
                    enum: [
                        'draft',
                        'pending',
                        'in_progress',
                        'blocked',
                        'completed',
                        'cancelled',
                    ],
                    required: false,
                },

                fromPriority: {
                    type: String,
                    enum: [ 'low', 'medium', 'high', 'critical' ],
                    required: false,
                },
                toPriority: {
                    type: String,
                    enum: [ 'low', 'medium', 'high', 'critical' ],
                    required: false,
                },

                // Generic payload
                payload: {
                    // Arbitrary JSON object
                    type: Schema.Types.Mixed,
                    required: false,
                    default: undefined,
                },

                // Time
                createdAt: {
                    type: String,
                    required: true,
                    default: () => new Date().toISOString(),
                    index: true,
                },

                // Time-bucket fields for analytics
                year: {
                    type: Number,
                    required: true,
                    default: () => new Date().getFullYear(),
                },
                month: {
                    type: Number,
                    required: true,
                    default: () => new Date().getMonth() + 1, // 1–12
                },
                day: {
                    type: Number,
                    required: true,
                    default: () => new Date().getDate(), // 1–31
                },
                yearMonth: {
                    type: String,
                    required: true,
                    default: () => {
                        const d = new Date();
                        const y = d.getFullYear();
                        const m = String( d.getMonth() + 1 ).padStart( 2, '0' );
                        return `${ y }-${ m }`;
                    },
                },
            },
            {
                timestamps: false, // we control createdAt ourselves
            },
        );

        // ─────────────────────────────────────
        // Index strategy
        // ─────────────────────────────────────

        // Per-work-item event timeline
        schema.index( { workItemId: 1, createdAt: 1 } );
        schema.index( { workItemMongoId: 1, createdAt: 1 } );

        // Per-team / per-domain timelines
        schema.index( { teamId: 1, createdAt: 1 } );
        schema.index( { domain: 1, kind: 1, createdAt: 1 } );

        // Time-series aggregations
        schema.index( { year: 1, month: 1, kind: 1 } );
        schema.index( { yearMonth: 1, kind: 1 } );
        schema.index( { yearMonth: 1, domain: 1 } );

        // Actor-based filters
        schema.index( { actorUserId: 1, createdAt: -1 } );
        schema.index( { actorUsername: 1, createdAt: -1 } );

        // Optionally support text search on actorRole / payload.comment-like data
        // (payload is Mixed, so we keep text index simple)
        schema.index( {
            actorUsername: 'text',
            actorRole: 'text',
        } );

        return schema;
    }

    public buildModel(): Model<IWorkEvent> {
        const schema = this.buildWorkEventSchema();
        const WorkEventModel: Model<IWorkEvent> = model<IWorkEvent>(
            'WorkEvent',
            schema,
            'work_events',
        );
        return WorkEventModel;
    }
}

// ─────────────────────────────────────────────
// Exported model instance
// ─────────────────────────────────────────────

const workEventModelBuilder = new WorkEventModelBuilder();

export const WorkEventModel: Model<IWorkEvent> =
    workEventModelBuilder.buildModel();
