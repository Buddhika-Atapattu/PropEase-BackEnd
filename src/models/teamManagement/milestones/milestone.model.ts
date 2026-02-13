// Path: src/models/teamManagement/milestones/milestone.model.ts
// ============================================================================
// Milestone Model (Mongoose + TypeScript) — 100% CLASS-BASED (your rule)
// ----------------------------------------------------------------------------
// ✅ PURPOSE
// - Stores planned milestone objects (calendar-like "plan layer") for members.
// - Keeps MemberActivity as the heavy "timeline/log layer".
// - Supports evidence on milestone itself (optional) without bloating WorkItem.
// ----------------------------------------------------------------------------
// ✅ RELATIONS
// - 1 WorkItem -> many Milestones
// - 1 User     -> many Milestones
// - 1 Team     -> many Milestones
//
// ✅ YOUR PROJECT RULES RESPECTED
// - Class-based export (no function-style model assembly)
// - Strong typing (no any)
// - exactOptionalPropertyTypes safe: omit optionals (never force undefined)
// - Model caching safe (avoids OverwriteModelError)
// ============================================================================

import { Schema, model, models, Types, type Document, type Model } from "mongoose";

import {
  MILESTONE_STATUS,
  MILESTONE_PRIORITY,
  type MilestoneDto,
  type MilestoneEvidence,
} from "../../../types/teamManagement/milestones/milestone.types";

// ----------------------------------------------------------------------------
// Document type
// ----------------------------------------------------------------------------
export interface IMilestone extends Document, Omit<MilestoneDto, '_id'> {}

// ----------------------------------------------------------------------------
// Factory (static-only; class-based)
// ----------------------------------------------------------------------------
export class MilestoneModelFactory {
  private constructor() {}

  private static readonly MODEL_NAME = "Milestone";

  // ---------------------------
  // Sub Schemas
  // ---------------------------

  private static readonly MilestoneEvidenceSchema: Schema<MilestoneEvidence> =
    new Schema<MilestoneEvidence>(
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

  // ---------------------------
  // Main Schema
  // ---------------------------

  private static readonly MilestoneSchema: Schema<IMilestone> = new Schema<IMilestone>(
    {
      // Relations
      workItemId: {
        type: Schema.Types.ObjectId,
        required: true,
        ref: "WorkItem",
        index: true,
      },
      teamId: {
        type: Schema.Types.ObjectId,
        required: true,
        ref: "TeamManagement",
        index: true,
      },
      userId: {
        type: Schema.Types.ObjectId,
        required: true,
        ref: "User",
        index: true,
      },

      // Audit
      createdByUserId: {
        type: Schema.Types.ObjectId,
        required: true,
        ref: "User",
        index: true,
      },
      updatedByUserId: { type: Schema.Types.ObjectId, required: false, ref: "User" },

      requestId: { type: String, required: false, trim: true, index: true },
      source: { type: String, required: false, enum: ["rest", "ws", "system"] },

      // Planning fields
      title: { type: String, required: true, trim: true },
      notes: { type: String, required: false, trim: true },

      startAt: { type: Date, required: true, index: true },
      endAt: { type: Date, required: true, index: true },
      allDay: { type: Boolean, required: true },
      timezone: { type: String, required: false, trim: true },

      // Status & priority
      status: { type: String, required: true, enum: MILESTONE_STATUS, index: true },
      priority: { type: String, required: true, enum: MILESTONE_PRIORITY, index: true },

      // Optional progress target impact
      progressTarget: { type: Number, required: false, min: 0, max: 100 },

      // Optional lightweight tags
      tags: { type: [String], required: false },

      // Optional evidence at milestone level
      evidence: { type: [MilestoneModelFactory.MilestoneEvidenceSchema], required: false },
    },
    { timestamps: true, versionKey: false }
  );

  // ---------------------------
  // Index strategy (industrial-grade)
  // ---------------------------

  private static ensureIndexes(): void {
    // Member calendar view (range queries)
    MilestoneModelFactory.MilestoneSchema.index({ userId: 1, startAt: 1, endAt: 1 });

    // WorkItem plan view
    MilestoneModelFactory.MilestoneSchema.index({ workItemId: 1, startAt: 1 });

    // Team dashboards / reporting
    MilestoneModelFactory.MilestoneSchema.index({ teamId: 1, status: 1, priority: 1, startAt: 1 });

    // Open items quick filter
    MilestoneModelFactory.MilestoneSchema.index({ teamId: 1, status: 1 });
  }

  // ---------------------------
  // Hooks (calendar correctness)
  // ---------------------------

  private static attachHooks(): void {
    MilestoneModelFactory.MilestoneSchema.pre("validate", function (next) {
      const doc = this as IMilestone;

      if (doc.endAt.getTime() < doc.startAt.getTime()) {
        next(new Error("endAt must be greater than or equal to startAt."));
        return;
      }

      next();
    });
  }

  // ---------------------------
  // Build model (safe compile)
  // ---------------------------

  public static buildModel(): Model<IMilestone> {
    MilestoneModelFactory.ensureIndexes();
    MilestoneModelFactory.attachHooks();

    // Avoid OverwriteModelError in watch mode / tests
    if (models[MilestoneModelFactory.MODEL_NAME]) {
      return models[MilestoneModelFactory.MODEL_NAME] as Model<IMilestone>;
    }

    return model<IMilestone>(MilestoneModelFactory.MODEL_NAME, MilestoneModelFactory.MilestoneSchema);
  }
}

// ----------------------------------------------------------------------------
// Export compiled model (single import path across the project)
// ----------------------------------------------------------------------------
export const MilestoneModel = MilestoneModelFactory.buildModel();
