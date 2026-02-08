// Path: src/models/teamManagement/workItem.model.ts
// ─────────────────────────────────────────────────────────────────────────────
// WorkItem model (KPI-ready, event-driven, analytics-friendly)
// ─────────────────────────────────────────────────────────────────────────────

import { Schema, model, type Document, type Model, Types } from "mongoose";

import { ISODateString } from "../../types/common";
import {
    Address,
    GeoLocation,
    TaskEvidence,
    TEAM_DOMAINS,
    type TeamDomain,
} from "./teamManagement.model";

// ─────────────────────────────────────────────
// Enums / literal unions
// ─────────────────────────────────────────────

export const WORK_ITEM_KINDS = [
    "sales_lead",
    "property_viewing",
    "offer_negotiation",
    "lease_signing",
    "rent_collection",
    "marketing_campaign",
    "social_post",
    "complaint_handling",
    "maintenance_job",
    "inspection",
    "cleaning_job",
    "dev_task",
    "support_ticket",
    "hr_recruitment",
    "hr_training",
    "hr_performance_review",
    "other",
] as const;

export type WorkItemKind = ( typeof WORK_ITEM_KINDS )[ number ];

export const WORK_ITEM_STATUSES = [
    "draft",
    "pending",
    "in_progress",
    "blocked",
    "completed",
    "cancelled",
    "backlog",
    "open",
    "done",
] as const;

export type WorkItemStatus = ( typeof WORK_ITEM_STATUSES )[ number ];

export const WORK_ITEM_PRIORITIES = [ "low", "medium", "high", "critical" ] as const;
export type WorkItemPriority = ( typeof WORK_ITEM_PRIORITIES )[ number ];

export type WorkItemSource = "ui" | "system" | "automation" | "import";

// ─────────────────────────────────────────────
// KPI-ready sub types (DTO-friendly)
// ─────────────────────────────────────────────

export interface WorkItemSlaPolicy {
    dueAt?: ISODateString | null;
    breachAt?: ISODateString | null;
    severity?: WorkItemPriority | null;
}

export interface WorkItemBlockedWindow {
    from: ISODateString;
    to?: ISODateString | null;
    reason?: string | null;

    setByUserId?: string; // DTO-friendly
    setByUsername?: string;
}

export interface WorkItemAssigneeHistoryEntry {
    userId: string; // DTO-friendly
    username: string;

    from: ISODateString;
    to?: ISODateString | null;

    changedByUserId?: string;
    changedByUsername?: string;

    reason?: string | null;
}

export interface WorkItemRuntimeMetrics {
    effortPoints?: number;
    complexity?: number;
    estimatedMinutes?: number;
    actualMinutes?: number;

    reopenedCount?: number;
    rejectedCount?: number;

    customerSatisfactionScore?: number; // 1..5
    supervisorQualityScore?: number; // 1..5
}

export interface WorkItemTiming {
    createdAt?: ISODateString;
    updatedAt?: ISODateString;

    firstResponseAt?: ISODateString | null;
    startedAt?: ISODateString | null;
    lastBlockedAt?: ISODateString | null;

    completedAt?: ISODateString | null;
    confirmedAt?: ISODateString | null;
    cancelledAt?: ISODateString | null;

    reopenedAt?: ISODateString | null;
}

export interface WorkItemAuditMeta {
    source?: WorkItemSource;
    requestId?: string;
    deviceId?: string;

    createdById: string; // DTO-friendly
    createdByUsername: string;

    lastUpdatedById?: string;
    lastUpdatedByUsername?: string;
}

export interface WorkItemValueMetrics {
    expectedValue?: number;
    actualValue?: number;
    commissionAmount?: number;
}

// ─────────────────────────────────────────────
// DTO (Lean-safe API contract) ✅
// ─────────────────────────────────────────────

export interface WorkItemDto {
    id: string; // human-friendly id like WORK-2025...
    teamId: string; // TeamManagement.teamCode
    teamMongoId: string; // TeamManagement._id
    domain: TeamDomain;

    kind: WorkItemKind;
    status: WorkItemStatus;
    priority: WorkItemPriority;

    createdById: string;
    createdByUsername: string;

    assignedMembers: string[];
    captainUserId?: string;

    assigneeHistory?: WorkItemAssigneeHistoryEntry[];

    propertyId?: string;
    tenantId?: string;
    leaseId?: string;
    complaintId?: string;
    buildingId?: string;

    title: string;
    description: string;

    plannedStartAt?: ISODateString | null;
    plannedEndAt?: ISODateString | null;

    timing: WorkItemTiming;

    sla?: WorkItemSlaPolicy;
    metrics?: WorkItemRuntimeMetrics;

    blockedWindows?: WorkItemBlockedWindow[];

    value?: WorkItemValueMetrics;

    timeSpentMinutes?: number;

    location?: GeoLocation;
    address?: Address;

    evidence?: TaskEvidence[];

    tags?: string[];

    audit: WorkItemAuditMeta;
}

// ─────────────────────────────────────────────
// Document type (Mongoose only) ✅
// ─────────────────────────────────────────────

export interface IWorkItem extends Document {
    id: string;

    teamId: string;
    teamMongoId: Types.ObjectId;
    domain: TeamDomain;

    kind: WorkItemKind;
    status: WorkItemStatus;
    priority: WorkItemPriority;

    createdById: Types.ObjectId;
    createdByUsername: string;

    assignedMembers: Types.ObjectId[];
    captainUserId?: Types.ObjectId;

    assigneeHistory?: Array<{
        userId: Types.ObjectId;
        username: string;
        from: ISODateString;
        to?: ISODateString | null;
        changedByUserId?: Types.ObjectId;
        changedByUsername?: string;
        reason?: string | null;
    }>;

    propertyId?: Types.ObjectId;
    tenantId?: Types.ObjectId;
    leaseId?: Types.ObjectId;
    complaintId?: Types.ObjectId;
    buildingId?: Types.ObjectId;

    title: string;
    description: string;

    plannedStartAt?: ISODateString | null;
    plannedEndAt?: ISODateString | null;

    timing: WorkItemTiming;

    sla?: WorkItemSlaPolicy;
    metrics?: WorkItemRuntimeMetrics;

    blockedWindows?: Array<{
        from: ISODateString;
        to?: ISODateString | null;
        reason?: string | null;
        setByUserId?: Types.ObjectId;
        setByUsername?: string;
    }>;

    value?: WorkItemValueMetrics;

    timeSpentMinutes?: number;

    location?: GeoLocation;
    address?: Address;

    evidence?: TaskEvidence[];
    tags?: string[];

    audit: {
        source?: WorkItemSource;
        requestId?: string;
        deviceId?: string;

        createdById: Types.ObjectId;
        createdByUsername: string;

        lastUpdatedById?: Types.ObjectId;
        lastUpdatedByUsername?: string;
    };
}

// ─────────────────────────────────────────────
// Schema builder (class-based only)
// ─────────────────────────────────────────────

class WorkItemModelBuilder {
    private readonly geoLocationSchema: Schema<GeoLocation>;
    private readonly addressSchema: Schema<Address>;
    private readonly taskEvidenceSchema: Schema<TaskEvidence>;

    private readonly slaSchema: Schema<WorkItemSlaPolicy>;
    private readonly blockedWindowSchema: Schema;
    private readonly assigneeHistorySchema: Schema;
    private readonly runtimeMetricsSchema: Schema<WorkItemRuntimeMetrics>;
    private readonly timingSchema: Schema<WorkItemTiming>;
    private readonly auditSchema: Schema;
    private readonly valueSchema: Schema<WorkItemValueMetrics>;

    public constructor () {
        this.geoLocationSchema = this.buildGeoLocationSchema();
        this.addressSchema = this.buildAddressSchema();
        this.taskEvidenceSchema = this.buildTaskEvidenceSchema();

      this.slaSchema = this.buildSlaSchema();
      this.blockedWindowSchema = this.buildBlockedWindowSchema();
      this.assigneeHistorySchema = this.buildAssigneeHistorySchema();
      this.runtimeMetricsSchema = this.buildRuntimeMetricsSchema();
      this.timingSchema = this.buildTimingSchema();
      this.auditSchema = this.buildAuditSchema();
      this.valueSchema = this.buildValueSchema();
  }

    private nowIso(): string {
        return new Date().toISOString();
    }

    private buildGeoLocationSchema(): Schema<GeoLocation> {
      return new Schema<GeoLocation>(
          {
              lat: { type: Number, required: true, default: 0 },
              lng: { type: Number, required: true, default: 0 },
            embeddedUrl: { type: String, required: true, default: "" },
        },
        { _id: false, timestamps: false },
    );
  }

    private buildAddressSchema(): Schema<Address> {
      return new Schema<Address>(
          {
            houseNumber: { type: String, required: false, default: "" },
            street: { type: String, required: false, default: "" },
            city: { type: String, required: true, default: "" },
            provinceOrState: { type: String, required: false, default: "" },
            country: { type: String, required: true, default: "" },
        },
        { _id: false, timestamps: false },
    );
  }

    private buildTaskEvidenceSchema(): Schema<TaskEvidence> {
      const fileMetaSchema: Schema = new Schema(
          {
            originalName: { type: String, required: true, default: "" },
            storedName: { type: String, required: true, default: "" },
            extension: { type: String, required: true, default: "" },
            mimeType: { type: String, required: true, default: "" },
            sizeBytes: { type: Number, required: true, default: 0 },
        },
        { _id: false, timestamps: false },
      );

      return new Schema<TaskEvidence>(
          {
              name: { type: String, required: true, default: "" },
              file: { type: fileMetaSchema, required: false },

              url: { type: String, required: false, default: "" },
              storageKey: { type: String, required: false, default: "" },

              uploadedById: { type: Schema.Types.ObjectId, ref: "User", required: false },
              uploadedByName: { type: String, required: false, default: "" },
              uploadedAt: { type: String, required: false, default: () => new Date().toISOString() },
          },
        { _id: false, timestamps: false },
    );
    }

    private buildSlaSchema(): Schema<WorkItemSlaPolicy> {
        return new Schema<WorkItemSlaPolicy>(
            {
                dueAt: { type: String, required: false, default: null },
                breachAt: { type: String, required: false, default: null },
                severity: { type: String, enum: [ ...WORK_ITEM_PRIORITIES ], required: false, default: null },
            },
        { _id: false, timestamps: false },
    );
    }

    private buildBlockedWindowSchema(): Schema {
        return new Schema(
            {
                from: { type: String, required: true, default: () => new Date().toISOString() },
                to: { type: String, required: false, default: null },
                reason: { type: String, required: false, default: null },

                setByUserId: { type: Schema.Types.ObjectId, ref: "User", required: false },
                setByUsername: { type: String, required: false, default: "" },
            },
        { _id: false, timestamps: false },
    );
    }

    private buildAssigneeHistorySchema(): Schema {
        return new Schema(
            {
            userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
            username: { type: String, required: true, trim: true, index: true },

            from: { type: String, required: true, default: () => new Date().toISOString() },
            to: { type: String, required: false, default: null },

            changedByUserId: { type: Schema.Types.ObjectId, ref: "User", required: false },
            changedByUsername: { type: String, required: false, default: "" },

            reason: { type: String, required: false, default: null },
        },
        { _id: false, timestamps: false },
    );
  }

    private buildRuntimeMetricsSchema(): Schema<WorkItemRuntimeMetrics> {
        return new Schema<WorkItemRuntimeMetrics>(
            {
            effortPoints: { type: Number, required: false, default: 0 },
            complexity: { type: Number, required: false, default: 1 },
            estimatedMinutes: { type: Number, required: false, default: 0 },
            actualMinutes: { type: Number, required: false, default: 0 },

            reopenedCount: { type: Number, required: false, default: 0 },
            rejectedCount: { type: Number, required: false, default: 0 },

            customerSatisfactionScore: { type: Number, required: false, default: 0 },
            supervisorQualityScore: { type: Number, required: false, default: 0 },
        },
        { _id: false, timestamps: false },
    );
  }

    private buildTimingSchema(): Schema<WorkItemTiming> {
        return new Schema<WorkItemTiming>(
            {
            createdAt: { type: String, required: true, default: () => new Date().toISOString() },
            updatedAt: { type: String, required: true, default: () => new Date().toISOString() },

            firstResponseAt: { type: String, required: false, default: null },
            startedAt: { type: String, required: false, default: null },
            lastBlockedAt: { type: String, required: false, default: null },

            completedAt: { type: String, required: false, default: null },
            confirmedAt: { type: String, required: false, default: null },
            cancelledAt: { type: String, required: false, default: null },

            reopenedAt: { type: String, required: false, default: null },
        },
        { _id: false, timestamps: false },
    );
  }

    private buildAuditSchema(): Schema {
        return new Schema(
            {
                source: { type: String, enum: [ "ui", "system", "automation", "import" ], required: false, default: "ui" },
                requestId: { type: String, required: false, default: "", index: true },
                deviceId: { type: String, required: false, default: "" },

            createdById: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
            createdByUsername: { type: String, required: true, trim: true },

            lastUpdatedById: { type: Schema.Types.ObjectId, ref: "User", required: false },
            lastUpdatedByUsername: { type: String, required: false, default: "" },
        },
        { _id: false, timestamps: false },
    );
  }

    private buildValueSchema(): Schema<WorkItemValueMetrics> {
        return new Schema<WorkItemValueMetrics>(
            {
                expectedValue: { type: Number, required: false, default: 0 },
                actualValue: { type: Number, required: false, default: 0 },
                commissionAmount: { type: Number, required: false, default: 0 },
            },
        { _id: false, timestamps: false },
    );
  }

    private buildWorkItemSchema(): Schema<IWorkItem> {
        const schema: Schema<IWorkItem> = new Schema<IWorkItem>(
            {
            id: { type: String, required: true, unique: true, trim: true, index: true },

            teamId: { type: String, required: true, trim: true, index: true },
            teamMongoId: { type: Schema.Types.ObjectId, required: true, ref: "TeamManagement", index: true },

            domain: { type: String, enum: [ ...TEAM_DOMAINS ], required: true, index: true },

            kind: { type: String, enum: [ ...WORK_ITEM_KINDS ], required: true, default: "other", index: true },
            status: { type: String, enum: [ ...WORK_ITEM_STATUSES ], required: true, default: "draft", index: true },
            priority: { type: String, enum: [ ...WORK_ITEM_PRIORITIES ], required: true, default: "medium", index: true },

            createdById: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
            createdByUsername: { type: String, required: true, trim: true },

            assignedMembers: [ { type: Schema.Types.ObjectId, ref: "User", required: false, index: true } ],
            captainUserId: { type: Schema.Types.ObjectId, ref: "User", required: false, index: true },

            assigneeHistory: { type: [ this.assigneeHistorySchema ], required: false, default: [] },

            propertyId: { type: Schema.Types.ObjectId, ref: "Property", required: false, index: true },
            tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: false, index: true },
            leaseId: { type: Schema.Types.ObjectId, ref: "LeaseAgreement", required: false, index: true },
            complaintId: { type: Schema.Types.ObjectId, ref: "Complaint", required: false, index: true },
            buildingId: { type: Schema.Types.ObjectId, ref: "Building", required: false, index: true },

            title: { type: String, required: true, trim: true },
            description: { type: String, required: false, default: "" },

            plannedStartAt: { type: String, required: false, default: null },
            plannedEndAt: { type: String, required: false, default: null },

            timing: { type: this.timingSchema, required: true },

            sla: { type: this.slaSchema, required: false },
            metrics: { type: this.runtimeMetricsSchema, required: false },

            blockedWindows: { type: [ this.blockedWindowSchema ], required: false, default: [] },

            value: { type: this.valueSchema, required: false },

            timeSpentMinutes: { type: Number, required: false, default: 0 },

            location: { type: this.geoLocationSchema, required: false },
            address: { type: this.addressSchema, required: false },

            evidence: { type: [ this.taskEvidenceSchema ], required: false, default: [] },

            tags: { type: [ String ], required: false, default: [] },

            audit: { type: this.auditSchema, required: true },
        },
        { timestamps: false },
    );

      // Index strategy
      schema.index( { teamId: 1, "timing.createdAt": -1 } );
      schema.index( { teamMongoId: 1, "timing.createdAt": -1 } );

      schema.index( { domain: 1, kind: 1, status: 1, priority: 1 } );

      schema.index( { createdById: 1, "timing.createdAt": -1 } );
      schema.index( { assignedMembers: 1, "timing.createdAt": -1 } );
      schema.index( { captainUserId: 1, "timing.createdAt": -1 } );

      schema.index( { propertyId: 1, "timing.createdAt": -1 } );
      schema.index( { tenantId: 1, "timing.createdAt": -1 } );
      schema.index( { leaseId: 1, "timing.createdAt": -1 } );
      schema.index( { complaintId: 1, "timing.createdAt": -1 } );

      schema.index( { "sla.dueAt": 1, status: 1, priority: 1 } );

      schema.index( { title: "text", description: "text", tags: "text" } );

      // Keep timing anchors consistent (ISO strings)
      schema.pre<IWorkItem>( "save", function ( next ) {
          try {
              const now: string = new Date().toISOString();

              if ( !this.timing ) {
                  this.timing = { createdAt: now, updatedAt: now };
              }

              if ( !this.timing.createdAt ) {
                  this.timing.createdAt = now;
              }

              this.timing.updatedAt = now;

              if ( this.status === "in_progress" && !this.timing.startedAt ) {
                  this.timing.startedAt = now;
              }

              if ( ( this.status === "completed" || this.status === "done" ) && !this.timing.completedAt ) {
                  this.timing.completedAt = now;
              }

          if ( this.status === "blocked" ) {
              this.timing.lastBlockedAt = now;
          }

          if ( this.status === "cancelled" && !this.timing.cancelledAt ) {
              this.timing.cancelledAt = now;
          }

          if ( !Array.isArray( this.tags ) ) this.tags = [];
          if ( !Array.isArray( this.evidence ) ) this.evidence = [];
          if ( !Array.isArray( this.blockedWindows ) ) this.blockedWindows = [];
          if ( !Array.isArray( this.assigneeHistory ) ) this.assigneeHistory = [];

          if ( !this.metrics ) this.metrics = {};
          if ( typeof this.metrics.reopenedCount !== "number" ) this.metrics.reopenedCount = 0;
          if ( typeof this.metrics.rejectedCount !== "number" ) this.metrics.rejectedCount = 0;
          if ( typeof this.metrics.effortPoints !== "number" ) this.metrics.effortPoints = 0;
          if ( typeof this.metrics.complexity !== "number" ) this.metrics.complexity = 1;

          if ( !this.audit ) {
              this.audit = { createdById: this.createdById, createdByUsername: this.createdByUsername };
          }

            next();
            return;
        } catch ( err ) {
            next( err as Error );
            return;
        }
    } );

      return schema;
  }

    public buildModel(): Model<IWorkItem> {
      const schema: Schema<IWorkItem> = this.buildWorkItemSchema();
      return model<IWorkItem>( "WorkItem", schema, "work_items" );
  }
}

const workItemModelBuilder: WorkItemModelBuilder = new WorkItemModelBuilder();
export const WorkItemModel: Model<IWorkItem> = workItemModelBuilder.buildModel();
