// Path: src/models/teamManagement/workItems/workItem.model.ts
// ============================================================================
// WorkItem Model (Mongoose + TypeScript) — 100% CLASS-BASED
// ----------------------------------------------------------------------------
// ✅ FIXED
// - WorkItemDto is API shape (string ids, ISO strings) -> NOT used for DB typing
// - Introduced WorkItemDb (DB shape) for Mongoose schema typing
// - Avoids "never" / type confusion / incorrect Omit usage
// - exactOptionalPropertyTypes safe (schema optionals are truly optional)
// ============================================================================

import { Schema, model, models, Types, type Document, type Model } from "mongoose";

import {
  DEADLINE_POLICY,
  WORK_ITEM_PRIORITY,
  WORK_ITEM_STATUS,
  type DeadlinePolicy,
  type WorkItemPriority,
  type WorkItemStatus,
  type WorkItemEvidence,
  type WorkItemMemberProgress,
} from "../../../types/teamManagement/workItem/workItem.types";

// ----------------------------------------------------------------------------
// DB types (Mongo storage shape) — ObjectId + Date
// ----------------------------------------------------------------------------

export interface WorkItemEvidenceDb extends Omit<WorkItemEvidence, "uploadedAt"> {
  uploadedAt: Date;
}

export interface WorkItemMemberProgressDb extends Omit<WorkItemMemberProgress, "userId" | "lastActivityAt"> {
  userId: Types.ObjectId;
  lastActivityAt: Date;
}

export interface WorkItemDb {
  // Identity
  workItemCode: string;
  teamId: Types.ObjectId;

  // Optional link to TeamTask
  taskId?: Types.ObjectId;

  // Assignment
  assignedByUserId: Types.ObjectId;
  assignedToUserIds: Types.ObjectId[];
  assignedAt: Date;

  // Schedule / expectations
  expectedStartAt?: Date;
  expectedCompleteAt: Date;
  deadlinePolicy: DeadlinePolicy;
  graceMinutes?: number;

  // Snapshot
  statusCurrent: WorkItemStatus;
  priority: WorkItemPriority;
  progressCurrent: number;
  lastActivityAt?: Date;
  completedAt?: Date;
  completedByUserId?: Types.ObjectId;

  // Optional: tiny per-member snapshot
  memberProgress?: WorkItemMemberProgressDb[];

  // Optional: completion evidence summary
  completionEvidenceSummary?: WorkItemEvidenceDb[];

  // Governance
  createdByUserId: Types.ObjectId;
  updatedByUserId?: Types.ObjectId;

  // Timestamps (added by schema)
  createdAt: Date;
  updatedAt: Date;
}

export interface IWorkItem extends Document, WorkItemDb {}

// ----------------------------------------------------------------------------
// Factory (class-based)
// ----------------------------------------------------------------------------
export class WorkItemModelFactory {
  private constructor() {}

  private static readonly MODEL_NAME = "WorkItem";

  // ---------------------------
  // Sub Schemas (static)
  // ---------------------------

  private static readonly WorkItemEvidenceSchema: Schema<WorkItemEvidenceDb> =
    new Schema<WorkItemEvidenceDb>(
      {
        label: { type: String, required: true, trim: true },
        relPath: { type: String, required: true, trim: true },
        url: { type: String, required: true, trim: true },
        mimeType: { type: String, required: true, trim: true },
        originalName: { type: String, required: true, trim: true },
        sizeBytes: { type: Number, required: true, min: 0 },
        uploadedAt: { type: Date, required: true },
      },
      { _id: false }
    );

  private static readonly WorkItemMemberProgressSchema: Schema<WorkItemMemberProgressDb> =
    new Schema<WorkItemMemberProgressDb>(
      {
        userId: { type: Schema.Types.ObjectId, required: true, ref: "User" },
        progress: { type: Number, required: true, min: 0, max: 100 },
        status: { type: String, required: true, enum: WORK_ITEM_STATUS },
        lastActivityAt: { type: Date, required: true },
      },
      { _id: false }
    );

  // ---------------------------
  // Main Schema (static)
  // ---------------------------

  private static readonly WorkItemSchema: Schema<IWorkItem> = new Schema<IWorkItem>(
    {
      workItemCode: { type: String, required: true, unique: true, index: true },

      teamId: { type: Schema.Types.ObjectId, required: true, ref: "TeamManagement", index: true },

      taskId: { type: Schema.Types.ObjectId, required: false, ref: "TeamTask", index: true },

      assignedByUserId: { type: Schema.Types.ObjectId, required: true, ref: "User", index: true },

      assignedToUserIds: {
        type: [Schema.Types.ObjectId],
        required: true,
        ref: "User",
        index: true,
        validate: {
          validator: (arr: Types.ObjectId[]) => Array.isArray(arr) && arr.length > 0,
          message: "assignedToUserIds must contain at least one member.",
        },
      },

      assignedAt: { type: Date, required: true, index: true },

      expectedStartAt: { type: Date, required: false },
      expectedCompleteAt: { type: Date, required: true, index: true },

      deadlinePolicy: { type: String, required: true, enum: DEADLINE_POLICY },
      graceMinutes: { type: Number, required: false, min: 0 },

      statusCurrent: { type: String, required: true, enum: WORK_ITEM_STATUS, index: true },
      priority: { type: String, required: true, enum: WORK_ITEM_PRIORITY, index: true },
      progressCurrent: { type: Number, required: true, min: 0, max: 100, index: true },

      lastActivityAt: { type: Date, required: false, index: true },

      completedAt: { type: Date, required: false, index: true },
      completedByUserId: { type: Schema.Types.ObjectId, required: false, ref: "User" },

      memberProgress: { type: [WorkItemModelFactory.WorkItemMemberProgressSchema], required: false },

      completionEvidenceSummary: { type: [WorkItemModelFactory.WorkItemEvidenceSchema], required: false },

      createdByUserId: { type: Schema.Types.ObjectId, required: true, ref: "User", index: true },
      updatedByUserId: { type: Schema.Types.ObjectId, required: false, ref: "User" },
    },
    {
      timestamps: true,
      versionKey: false,
    }
  );

  // ---------------------------
  // Indexes (static)
  // ---------------------------

  private static ensureIndexes(): void {
    // Team dashboards: status + priority
    WorkItemModelFactory.WorkItemSchema.index({ teamId: 1, statusCurrent: 1, priority: 1 });

    // Member dashboard: member + status
    WorkItemModelFactory.WorkItemSchema.index({ teamId: 1, assignedToUserIds: 1, statusCurrent: 1 });

    // Overdue lists: deadline + status
    WorkItemModelFactory.WorkItemSchema.index({ expectedCompleteAt: 1, statusCurrent: 1 });
  }

  // ---------------------------
  // Build model (static)
  // ---------------------------

  public static buildModel(): Model<IWorkItem> {
    WorkItemModelFactory.ensureIndexes();

    // Hot-reload safe (prevents OverwriteModelError)
    if (models[WorkItemModelFactory.MODEL_NAME]) {
      return models[WorkItemModelFactory.MODEL_NAME] as Model<IWorkItem>;
    }

    return model<IWorkItem>(WorkItemModelFactory.MODEL_NAME, WorkItemModelFactory.WorkItemSchema);
  }
}

// ----------------------------------------------------------------------------
// Export compiled model
// ----------------------------------------------------------------------------
export const WorkItemModel = WorkItemModelFactory.buildModel();
