// Path: src/models/teamManagement/workItem.model.ts
// ─────────────────────────────────────────────────────────────────────────────
// WorkItem model
//   - Normalised task/work unit spanning all domains (sales, marketing, dev,
//     support, HR, maintenance, cleaning, etc.).
//   - Designed for analytics: per-team, per-agent, per-domain, per-entity
//     (property/tenant/lease/complaint), with time and value metrics.
//
// NOTES:
//   • Identity is *decoupled* from Mongo _id via `id` (human-friendly).
//   • References:
//        teamId      → TeamManagement.id (string code)
//        teamMongoId → TeamManagement._id (ObjectId)
//        createdById / assignedMembers / captainUserId → User._id
//   • Dates are stored as ISO strings (ISODateString) for consistency with
//     your TeamManagement model.
// ─────────────────────────────────────────────────────────────────────────────

import {
    Schema,
    model,
    type Document,
    type Model,
    Types,
} from 'mongoose';

import { ISODateString } from '../../types/common';
import {
    Address,
    GeoLocation,
    TaskEvidence,
    TeamDomain,
} from './teamManagement.model';

// ─────────────────────────────────────────────
// Enums / literal unions
// ─────────────────────────────────────────────

export type WorkItemKind =
    | 'sales_lead'
    | 'property_viewing'
    | 'offer_negotiation'
    | 'lease_signing'
    | 'rent_collection'
    | 'marketing_campaign'
    | 'social_post'
    | 'complaint_handling'
    | 'maintenance_job'
    | 'inspection'
    | 'cleaning_job'
    | 'dev_task'
    | 'support_ticket'
    | 'hr_recruitment'
    | 'hr_training'
    | 'hr_performance_review'
    | 'other';

export type WorkItemStatus =
    | 'draft'
    | 'pending'
    | 'in_progress'
    | 'blocked'
    | 'completed'
    | 'cancelled'
    | 'backlog'
    | 'open'
    | 'done';

export type WorkItemPriority = 'low' | 'medium' | 'high' | 'critical';

// ─────────────────────────────────────────────
// Document interface
// ─────────────────────────────────────────────

export interface IWorkItem extends Document {
    // Identity
    id: string;                   // human-friendly ID like WORK-2025...
    teamId: string;               // TeamManagement.id (code)
    teamMongoId: Types.ObjectId;  // TeamManagement._id (ObjectId)
    domain: TeamDomain;           // snapshot from team at creation time

    // Classification
    kind: WorkItemKind;
    status: WorkItemStatus;
    priority: WorkItemPriority;

    // Ownership & assignment
    createdById: Types.ObjectId;
    createdByUsername: string;
    assignedMembers: Types.ObjectId[]; // full list of users working on this item
    captainUserId?: Types.ObjectId;    // optional task captain

    // Links to core PropEase entities (all optional)
    propertyId?: Types.ObjectId;
    tenantId?: Types.ObjectId;
    leaseId?: Types.ObjectId;
    complaintId?: Types.ObjectId;
    buildingId?: Types.ObjectId;

    // Human info
    title: string;
    description: string;

    // Time fields for analytics
    createdAt: ISODateString;
    updatedAt: ISODateString;
    plannedStartAt?: ISODateString;
    plannedEndAt?: ISODateString;
    startedAt?: ISODateString;
    completedAt?: ISODateString;
    cancelledAt?: ISODateString;

    // Performance metrics
    expectedValue?: number;     // e.g. expected deal value
    actualValue?: number;       // closed amount
    commissionAmount?: number;  // per-deal commission for agent/team
    timeSpentMinutes?: number;  // manual or tracked time spent

    // Location
    location?: GeoLocation;
    address?: Address;

    // Evidence (files / screenshots / docs)
    evidence?: TaskEvidence[];

    // Tags for flexible analytics (e.g. ["facebook", "luxury", "phase-1"])
    tags?: string[];
}

// ─────────────────────────────────────────────
// Schema builder
// ─────────────────────────────────────────────

class WorkItemModelBuilder {
    private readonly now: string = new Date().toISOString();

    private readonly geoLocationSchema: Schema<GeoLocation>;
    private readonly addressSchema: Schema<Address>;
    private readonly taskEvidenceSchema: Schema<TaskEvidence>;

    public constructor () {
        this.geoLocationSchema = this.buildGeoLocationSchema();
        this.addressSchema = this.buildAddressSchema();
        this.taskEvidenceSchema = this.buildTaskEvidenceSchema();
    }

    // ─────────────────────────────────────────
    // Subdocument schemas (mirroring team model)
    // ─────────────────────────────────────────

    private buildGeoLocationSchema(): Schema<GeoLocation> {
        const geoSchema: Schema<GeoLocation> = new Schema<GeoLocation>(
            {
                lat: { type: Number, required: true, default: 0 },
                lng: { type: Number, required: true, default: 0 },
                embeddedUrl: { type: String, required: true, default: '' },
            },
            {
                _id: false,
                timestamps: false,
            },
        );
        return geoSchema;
    }

    private buildAddressSchema(): Schema<Address> {
        const addrSchema: Schema<Address> = new Schema<Address>(
            {
                houseNumber: { type: String, required: false, default: '' },
                street: { type: String, required: false, default: '' },
                city: { type: String, required: true, default: '' },
                provinceOrState: { type: String, required: false, default: '' },
                country: { type: String, required: true, default: '' },
            },
            {
                _id: false,
                timestamps: false,
            },
        );
        return addrSchema;
    }

    private buildTaskEvidenceSchema(): Schema<TaskEvidence> {
        const evidenceSchema: Schema<TaskEvidence> = new Schema<TaskEvidence>(
            {
                name: { type: String, required: true, default: '' },
                file: {
                    type: new Schema(
                        {
                            originalName: {
                                type: String,
                                required: true,
                                default: `file_${ this.now }`,
                            },
                            storedName: {
                                type: String,
                                required: true,
                                default: `stored_${ this.now }`,
                            },
                            extension: { type: String, required: true, default: '' },
                            mimeType: { type: String, required: true, default: '' },
                            sizeBytes: { type: Number, required: true, default: 0 },
                        },
                        { _id: false, timestamps: false },
                    ),
                    required: false,
                },
                url: { type: String, required: false, default: '' },
                storageKey: { type: String, required: false, default: '' },
                uploadedById: {
                    type: Schema.Types.ObjectId,
                    ref: 'User',
                    required: false,
                },
                uploadedByName: { type: String, required: false, default: '' },
                uploadedAt: {
                    type: String,
                    required: false,
                    default: this.now,
                },
            },
            {
                _id: false,
                timestamps: false,
            },
        );
        return evidenceSchema;
    }

    // ─────────────────────────────────────────
    // Root WorkItem schema
    // ─────────────────────────────────────────

    private buildWorkItemSchema(): Schema<IWorkItem> {
        const schema: Schema<IWorkItem> = new Schema<IWorkItem>(
            {
                // Identity
                id: {
                    type: String,
                    required: true,
                    unique: true,
                    trim: true,
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
                },

                // Classification
                kind: {
                    type: String,
                    enum: [
                        'sales_lead',
                        'property_viewing',
                        'offer_negotiation',
                        'lease_signing',
                        'rent_collection',
                        'marketing_campaign',
                        'social_post',
                        'complaint_handling',
                        'maintenance_job',
                        'inspection',
                        'cleaning_job',
                        'dev_task',
                        'support_ticket',
                        'hr_recruitment',
                        'hr_training',
                        'hr_performance_review',
                        'other',
                    ],
                    required: true,
                    default: 'other',
                },
                status: {
                    type: String,
                    enum: [
                        'draft',
                        'pending',
                        'in_progress',
                        'blocked',
                        'completed',
                        'cancelled',
                        'backlog',
                        'open',
                        'done',
                    ],
                    required: true,
                    default: 'draft',
                },
                priority: {
                    type: String,
                    enum: [ 'low', 'medium', 'high', 'critical' ],
                    required: true,
                    default: 'medium',
                },

                // Ownership & assignment
                createdById: {
                    type: Schema.Types.ObjectId,
                    ref: 'User',
                    required: true,
                    index: true,
                },
                createdByUsername: {
                    type: String,
                    required: true,
                    trim: true,
                },
                assignedMembers: [
                    {
                        type: Schema.Types.ObjectId,
                        ref: 'User',
                        required: false,
                    },
                ],
                captainUserId: {
                    type: Schema.Types.ObjectId,
                    ref: 'User',
                    required: false,
                },

                // Links to other entities (all optional)
                propertyId: {
                    type: Schema.Types.ObjectId,
                    ref: 'Property',
                    required: false,
                    index: true,
                },
                tenantId: {
                    type: Schema.Types.ObjectId,
                    ref: 'Tenant',
                    required: false,
                    index: true,
                },
                leaseId: {
                    type: Schema.Types.ObjectId,
                    ref: 'LeaseAgreement',
                    required: false,
                    index: true,
                },
                complaintId: {
                    type: Schema.Types.ObjectId,
                    ref: 'Complaint',
                    required: false,
                    index: true,
                },
                buildingId: {
                    type: Schema.Types.ObjectId,
                    ref: 'Building',
                    required: false,
                    index: true,
                },

                // Human info
                title: {
                    type: String,
                    required: true,
                    trim: true,
                },
                description: {
                    type: String,
                    required: false,
                    default: '',
                },

                // Time fields (ISODateString)
                createdAt: {
                    type: String,
                    required: true,
                    default: () => new Date().toISOString(),
                },
                updatedAt: {
                    type: String,
                    required: true,
                    default: () => new Date().toISOString(),
                },
                plannedStartAt: {
                    type: String,
                    required: false,
                    default: '',
                },
                plannedEndAt: {
                    type: String,
                    required: false,
                    default: '',
                },
                startedAt: {
                    type: String,
                    required: false,
                    default: '',
                },
                completedAt: {
                    type: String,
                    required: false,
                    default: '',
                },
                cancelledAt: {
                    type: String,
                    required: false,
                    default: '',
                },

                // Performance metrics
                expectedValue: {
                    type: Number,
                    required: false,
                    default: 0,
                },
                actualValue: {
                    type: Number,
                    required: false,
                    default: 0,
                },
                commissionAmount: {
                    type: Number,
                    required: false,
                    default: 0,
                },
                timeSpentMinutes: {
                    type: Number,
                    required: false,
                    default: 0,
                },

                // Location
                location: {
                    type: this.geoLocationSchema,
                    required: false,
                },
                address: {
                    type: this.addressSchema,
                    required: false,
                },

                // Evidence
                evidence: {
                    type: [ this.taskEvidenceSchema ],
                    required: false,
                    default: [],
                },

                // Tags
                tags: {
                    type: [ String ],
                    required: false,
                    default: [],
                },
            },
            {
                // We keep timestamps as ISO strings manually (createdAt, etc.)
                timestamps: false,
            },
        );

        // ─────────────────────────────────────
        // Index strategy for analytics
        // ─────────────────────────────────────


        // Per-team timeline
        schema.index( { teamId: 1, createdAt: -1 } );
        schema.index( { teamMongoId: 1, createdAt: -1 } );

        // Domain & workload breakdowns
        schema.index( { domain: 1, kind: 1, status: 1 } );

        // Per-user performance views
        schema.index( { createdById: 1, createdAt: -1 } );
        schema.index( { 'assignedMembers': 1, createdAt: -1 } );
        schema.index( { captainUserId: 1, createdAt: -1 } );

        // Entity-centric lookups
        schema.index( { propertyId: 1, createdAt: -1 } );
        schema.index( { tenantId: 1, createdAt: -1 } );
        schema.index( { leaseId: 1, createdAt: -1 } );
        schema.index( { complaintId: 1, createdAt: -1 } );

        // Text search for dashboards (title / description / tags)
        schema.index( {
            title: 'text',
            description: 'text',
            tags: 'text',
        } );

        return schema;
    }

    public buildModel(): Model<IWorkItem> {
        const schema = this.buildWorkItemSchema();
        const WorkItemModel: Model<IWorkItem> = model<IWorkItem>(
            'WorkItem',
            schema,
            'work_items',
        );
        return WorkItemModel;
    }
}

// ─────────────────────────────────────────────
// Exported model instance
// ─────────────────────────────────────────────

const workItemModelBuilder = new WorkItemModelBuilder();

export const WorkItemModel: Model<IWorkItem> =
    workItemModelBuilder.buildModel();
