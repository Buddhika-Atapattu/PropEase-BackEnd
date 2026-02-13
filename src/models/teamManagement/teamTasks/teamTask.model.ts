// Path: src/models/teamManagement/teamTask/teamTask.model.ts
// ============================================================================
// TeamTask Model (Standalone collection) — Meaningful Names ✅
//
// ✅ Standalone team task collection (scalable)
// ✅ deadlinePolicy replaces sla (clear naming)
// ✅ Adds workItemMongoIds + workItemCount (optional cache + fast counts)
// ✅ Hook keeps timing anchors consistent and keeps counts accurate
// ============================================================================

import { Schema, Types, model, type Document, type Model } from "mongoose";

import type { Address, GeoLocation, ISODateString } from "../../../types/common";

import {
  TEAM_DOMAINS,
  type FileMetaBase,
  type TeamDomain,
} from "../../../types/teamManagement/teamMain/teamManagement.types";

import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  TaskDeadlinePolicy,
  type TaskAssigneeHistoryEntry,
  type TaskAuditMeta,
  type TaskBlockedWindow,
  type TaskCompletionConfirmation,
  type TaskCompletionSignature,
  type TaskEvidence,
  type TaskPriority,
  type TaskRuntimeMetrics,
  type TaskStatus,
  type TaskTiming
} from "../../../types/teamManagement/teamTasks/team-tasks.type";


// ─────────────────────────────────────────────
// Root document
// ─────────────────────────────────────────────

export interface ITeamTask extends Document {
  id: string;

  teamCode: string;
  teamMongoId: Types.ObjectId | null;
  domain: TeamDomain | null;

  name: string;
  description: string;

  location?: GeoLocation | null;
  address?: Address | null;

  assignedMembers?: Types.ObjectId[];
  assignedTaskCaptain?: Types.ObjectId;

  /**
   * Optional cache:
   * - Useful for quickly listing member work items under this TeamTask.
   * - True relationship should still live in WorkItem.teamTaskMongoId (child -> parent).
   */
  workItemMongoIds?: Types.ObjectId[];
  workItemCount: number;

  status: TaskStatus | null;
  priority: TaskPriority | null;

  plannedStartAt?: string | null;
  plannedEndAt?: string | null;

  timing: TaskTiming | null;

  deadlinePolicy?: TaskDeadlinePolicy | null;

  metrics?: TaskRuntimeMetrics | null;

  blockedWindows?: TaskBlockedWindow[];
  assigneeHistory?: TaskAssigneeHistoryEntry[];

  completionConfirmation?: TaskCompletionConfirmation | null;

  evidence?: TaskEvidence[] | null;

  notes?: string;
  labels?: string[];

  audit?: TaskAuditMeta | null;

  createdAt: string;
  updatedAt: string;
}

// ─────────────────────────────────────────────
// Model builder (class-based only)
// ─────────────────────────────────────────────

class TeamTaskModelBuilder {
  private readonly geoLocationSchema: Schema<GeoLocation>;
  private readonly addressSchema: Schema<Address>;

  private readonly fileMetaBaseSchema: Schema<FileMetaBase>;
  private readonly evidenceSchema: Schema<TaskEvidence>;

  private readonly timingSchema: Schema<TaskTiming>;
  private readonly deadlinePolicySchema: Schema<TaskDeadlinePolicy>;
  private readonly metricsSchema: Schema<TaskRuntimeMetrics>;
  private readonly blockedWindowSchema: Schema<TaskBlockedWindow>;
  private readonly assigneeHistorySchema: Schema<TaskAssigneeHistoryEntry>;

  private readonly completionSignatureSchema: Schema<TaskCompletionSignature>;
  private readonly completionConfirmationSchema: Schema<TaskCompletionConfirmation>;

  private readonly auditSchema: Schema<TaskAuditMeta>;

  public constructor() {
    this.geoLocationSchema = this.buildGeoLocationSchema();
    this.addressSchema = this.buildAddressSchema();

    this.fileMetaBaseSchema = this.buildFileMetaBaseSchema();
    this.evidenceSchema = this.buildEvidenceSchema();

    this.timingSchema = this.buildTimingSchema();
    this.deadlinePolicySchema = this.buildDeadlinePolicySchema();
    this.metricsSchema = this.buildMetricsSchema();
    this.blockedWindowSchema = this.buildBlockedWindowSchema();
    this.assigneeHistorySchema = this.buildAssigneeHistorySchema();

    this.completionSignatureSchema = this.buildCompletionSignatureSchema();
    this.completionConfirmationSchema = this.buildCompletionConfirmationSchema();

    this.auditSchema = this.buildAuditSchema();
  }

  private buildGeoLocationSchema(): Schema<GeoLocation> {
    return new Schema<GeoLocation>(
      {
        lat: { type: Number, required: true, default: 0 },
        lng: { type: Number, required: true, default: 0 },
        embeddedUrl: { type: String, required: true, default: "" },
      },
      { _id: false, timestamps: false }
    );
  }

  private buildAddressSchema(): Schema<Address> {
    return new Schema<Address>(
      {
        houseNumber: { type: String, required: false, default: "" },
        street: { type: String, required: false, default: "" },
        city: { type: String, required: true, default: "" },
        stateOrProvince: { type: String, required: false, default: "" },
        country: { type: String, required: true, default: "" },
      },
      { _id: false, timestamps: false }
    );
  }

  private buildFileMetaBaseSchema(): Schema<FileMetaBase> {
    return new Schema<FileMetaBase>(
      {
        originalName: { type: String, required: true, default: "" },
        storedName: { type: String, required: true, default: "" },
        extension: { type: String, required: true, default: "" },
        mimeType: { type: String, required: true, default: "" },
        sizeBytes: { type: Number, required: true, default: 0 },
      },
      { _id: false, timestamps: false }
    );
  }

  private buildEvidenceSchema(): Schema<TaskEvidence> {
    return new Schema<TaskEvidence>(
      {
        name: { type: String, required: true, default: "" },

        file: { type: this.fileMetaBaseSchema, required: false, default: null },

        url: { type: String, required: false, default: "" },
        storageKey: { type: String, required: false, default: "" },

        uploadedById: { type: Schema.Types.ObjectId, ref: "User", required: false, default: null },
        uploadedByName: { type: String, required: false, default: "" },

        uploadedAt: {
          type: String,
          required: false,
          default: () => new Date().toISOString(),
        },
      },
      { _id: false, timestamps: false }
    );
  }

  private buildTimingSchema(): Schema<TaskTiming> {
    return new Schema<TaskTiming>(
      {
        createdAt: { type: String, required: false, default: null },
        updatedAt: { type: String, required: false, default: null },

        firstResponseAt: { type: String, required: false, default: null },
        startedAt: { type: String, required: false, default: null },
        lastBlockedAt: { type: String, required: false, default: null },

        completedAt: { type: String, required: false, default: null },
        confirmedAt: { type: String, required: false, default: null },

        cancelledAt: { type: String, required: false, default: null },
      },
      { _id: false, timestamps: false }
    );
  }

  /**
   * deadlinePolicy schema
   * - Use null for date fields (better query semantics)
   */
  private buildDeadlinePolicySchema(): Schema<TaskDeadlinePolicy> {
    return new Schema<TaskDeadlinePolicy>(
      {
        dueAt: { type: String, required: false, default: null },
        breachAt: { type: String, required: false, default: null },
        urgency: {
          type: String,
          enum: ["low", "medium", "high", "critical"],
          required: false,
          default: null,
        },
      },
      { _id: false, timestamps: false }
    );
  }

  private buildMetricsSchema(): Schema<TaskRuntimeMetrics> {
    return new Schema<TaskRuntimeMetrics>(
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
      { _id: false, timestamps: false }
    );
  }

  private buildBlockedWindowSchema(): Schema<TaskBlockedWindow> {
    return new Schema<TaskBlockedWindow>(
      {
        from: { type: String, required: true, default: () => new Date().toISOString() },
        to: { type: String, required: false, default: null },

        reason: { type: String, required: false, default: null },

        setByUserId: { type: Schema.Types.ObjectId, ref: "User", required: false, default: null },
        setByUsername: { type: String, required: false, default: "" },
      },
      { _id: false, timestamps: false }
    );
  }

  private buildAssigneeHistorySchema(): Schema<TaskAssigneeHistoryEntry> {
    return new Schema<TaskAssigneeHistoryEntry>(
      {
        userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true, default: null },
        username: { type: String, required: true, trim: true, index: true, default: null },

        from: { type: String, required: true, default: () => new Date().toISOString() },
        to: { type: String, required: false, default: null },

        changedByUserId: { type: Schema.Types.ObjectId, ref: "User", required: false, default: null },
        changedByUsername: { type: String, required: false, default: "" },

        reason: { type: String, required: false, default: null },
      },
      { _id: false, timestamps: false }
    );
  }

  private buildCompletionSignatureSchema(): Schema<TaskCompletionSignature> {
    return new Schema<TaskCompletionSignature>(
      {
        role: { type: String, enum: [ "customer", "supervisor" ], required: true, default: null },

        signerUserId: { type: Schema.Types.ObjectId, ref: "User", required: false, default: null },
        signerUsername: { type: String, required: false, default: "" },
        signerName: { type: String, required: false, default: "" },

        signatureFile: { type: this.fileMetaBaseSchema, required: false },
        signatureUrl: { type: String, required: false, default: "" },
        signatureStorageKey: { type: String, required: false, default: "" },

        signedAt: { type: String, required: false, default: () => new Date().toISOString() },
      },
      { _id: false, timestamps: false }
    );
  }

  private buildCompletionConfirmationSchema(): Schema<TaskCompletionConfirmation> {
    return new Schema<TaskCompletionConfirmation>(
      {
        status: {
          type: String,
          enum: [ "not_required", "pending", "rejected", "confirmed" ],
          required: true,
          default: "not_required",
        },

        requiredRoles: { type: [String], required: false, default: [] },

        signatures: { type: [ this.completionSignatureSchema ], required: false, default: [] },

        confirmedAt: { type: String, required: false, default: "" },
        confirmedByUserId: { type: Schema.Types.ObjectId, ref: "User", required: false, default: null },
        confirmedByUsername: { type: String, required: false, default: "" },

        rejectedAt: { type: String, required: false, default: "" },
        rejectedByUserId: { type: Schema.Types.ObjectId, ref: "User", required: false, default: null },
        rejectedByUsername: { type: String, required: false, default: "" },

        rejectReason: { type: String, required: false, default: "" },
      },
      { _id: false, timestamps: false }
    );
  }

  private buildAuditSchema(): Schema<TaskAuditMeta> {
    return new Schema<TaskAuditMeta>(
      {
        source: {
          type: String,
          enum: [ "ui", "system", "automation", "import" ],
          required: false,
          default: "ui",
        },

        requestId: { type: String, required: false, default: "" },
        deviceId: { type: String, required: false, default: "" },

        createdByUserId: { type: Schema.Types.ObjectId, ref: "User", required: false, default: null },
        createdByUsername: { type: String, required: false, default: "" },

        lastUpdatedByUserId: { type: Schema.Types.ObjectId, ref: "User", required: false, default: null },
        lastUpdatedByUsername: { type: String, required: false, default: "" },
      },
      { _id: false, timestamps: false }
    );
  }

  private buildSchema(): Schema<ITeamTask> {
    const schema: Schema<ITeamTask> = new Schema<ITeamTask>(
      {
        id: { type: String, required: true, unique: true, trim: true, index: true, default: null },

        teamCode: { type: String, required: true, trim: true, index: true, default: null },
        teamMongoId: { type: Schema.Types.ObjectId, required: true, ref: "TeamManagement", index: true, default: null },
        domain: { type: String, enum: [ ...TEAM_DOMAINS ], required: true, index: true, default: null },

        name: { type: String, required: true, trim: true, default: null },
        description: { type: String, required: false, default: "" },

        location: { type: this.geoLocationSchema, required: false, default: null },
        address: { type: this.addressSchema, required: false, default: null },

        assignedMembers: [ { type: Schema.Types.ObjectId, ref: "User", required: false, index: true, default: null } ],
        assignedTaskCaptain: { type: Schema.Types.ObjectId, ref: "User", required: false, index: true, default: null },

        workItemMongoIds: [ { type: Schema.Types.ObjectId, ref: "WorkItem", required: false, index: true, default: null } ],
        workItemCount: { type: Number, required: true, default: 0, index: true },

        status: { type: String, enum: [...TASK_STATUSES], required: true, default: "draft", index: true },
        priority: { type: String, enum: [...TASK_PRIORITIES], required: true, default: "medium", index: true },

        plannedStartAt: { type: String, required: false, default: "" },
        plannedEndAt: { type: String, required: false, default: "" },

        // Ensure timing always exists so hook can safely write into it.
        timing: { type: this.timingSchema, required: true, default: {} },

        deadlinePolicy: { type: this.deadlinePolicySchema, required: false, default: null },

        metrics: { type: this.metricsSchema, required: false, default: null },

        blockedWindows: { type: [this.blockedWindowSchema], required: false, default: [] },
        assigneeHistory: { type: [this.assigneeHistorySchema], required: false, default: [] },

        completionConfirmation: { type: this.completionConfirmationSchema, required: false, default: null },

        evidence: { type: [this.evidenceSchema], required: false, default: [] },

        notes: { type: String, required: false, default: "" },
        labels: { type: [String], required: false, default: [] },

        audit: { type: this.auditSchema, required: false, default: null },

        createdAt: { type: String, required: true, default: () => new Date().toISOString(), index: true },
        updatedAt: { type: String, required: true, default: () => new Date().toISOString(), index: true },
      },
      { timestamps: false }
    );

    // Indexes
    schema.index({ teamCode: 1, createdAt: -1 });
    schema.index({ teamMongoId: 1, createdAt: -1 });
    schema.index({ teamCode: 1, status: 1, priority: 1 });
    schema.index({ "deadlinePolicy.dueAt": 1, status: 1, priority: 1 });

    schema.index({ assignedMembers: 1, status: 1 });
    schema.index({ assignedTaskCaptain: 1, status: 1 });

    schema.index({ name: "text", description: "text", labels: "text" });

    // Keep timing anchors consistent + maintain derived fields
    schema.pre<ITeamTask>("save", function (next) {
      try {
        const now: ISODateString = new Date().toISOString();

        this.updatedAt = now;

        // timing always exists (schema default {}), but keep guard for safety
        if (!this.timing) this.timing = {};
        if (!this.timing.createdAt) this.timing.createdAt = now;
        this.timing.updatedAt = now;

        if (this.status === "in_progress" && !this.timing.startedAt) this.timing.startedAt = now;
        if (this.status === "blocked") this.timing.lastBlockedAt = now;

        if (
          (this.status === "completed" || this.status === "completed_pending_confirmation") &&
          !this.timing.completedAt
        ) {
          this.timing.completedAt = now;
        }

        if (this.status === "cancelled" && !this.timing.cancelledAt) {
          this.timing.cancelledAt = now;
        }

        if (!Array.isArray(this.evidence)) this.evidence = [];
        if (!Array.isArray(this.labels)) this.labels = [];
        if (!Array.isArray(this.blockedWindows)) this.blockedWindows = [];
        if (!Array.isArray(this.assigneeHistory)) this.assigneeHistory = [];

        if (!this.metrics) this.metrics = {};
        if (typeof this.metrics.reopenedCount !== "number") this.metrics.reopenedCount = 0;
        if (typeof this.metrics.rejectedCount !== "number") this.metrics.rejectedCount = 0;

        // ✅ Keep work item cache consistent (dedupe + count)
        if (!Array.isArray(this.workItemMongoIds)) this.workItemMongoIds = [];

        const unique: string[] = Array.from( new Set( this.workItemMongoIds.map( ( id ) => String( id ) ) ) );
        this.workItemMongoIds = unique.map( ( s ) => new Types.ObjectId( s ) );
        this.workItemCount = unique.length;

        next();
        return;
      } catch (err) {
        next(err as Error);
        return;
      }
    });

    return schema;
  }

  public buildModel(): Model<ITeamTask> {
    const schema: Schema<ITeamTask> = this.buildSchema();
    return model<ITeamTask>("TeamTask", schema, "team_tasks");
  }
}

const teamTaskModelBuilder: TeamTaskModelBuilder = new TeamTaskModelBuilder();
export const TeamTaskModel: Model<ITeamTask> = teamTaskModelBuilder.buildModel();
