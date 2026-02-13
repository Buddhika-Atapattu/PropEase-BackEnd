// Path: src/models/teamManagement/workItems/memberActivity.model.ts
// ============================================================================
// MemberActivity Model (Mongoose + TypeScript) — 100% CLASS-BASED (your rule)
// ----------------------------------------------------------------------------
// ✅ PURPOSE
// - Heavy timeline/calendar collection for progress tracking per WorkItem
// - Google Calendar-like event structure: startAt/endAt/allDay/title/status
// - Each activity belongs to exactly one WorkItem + one member (userId)
// ----------------------------------------------------------------------------
// ✅ DESIGN NOTES
// - 1 WorkItem -> many MemberActivities
// - Supports multiple members under one WorkItem (userId partitions the activities)
// - This stores milestones/targets/evidence/blockers without bloating WorkItem
// ----------------------------------------------------------------------------
// ✅ YOUR PROJECT RULES RESPECTED
// - Class-based export (no function-style model assembly)
// - Strong typing (no any)
// - exactOptionalPropertyTypes safe (omit optionals; do not force undefined)
// ============================================================================

import { Schema, model, type Document, type Model } from "mongoose";

import {
  MEMBER_ACTIVITY_TYPE,
  MEMBER_ACTIVITY_STATUS,
  type MemberActivityDto,
  type MemberActivityEvidence,
  type MemberActivityBlocker,
} from "../../../types/teamManagement/memberActivities/memberActivities.types";

export interface IMemberActivity extends Document, Omit<MemberActivityDto, '_id'> {}

export class MemberActivityModelFactory {
  private constructor () {}

  private static readonly MODEL_NAME = "MemberActivity";

  // ---------------------------
  // Sub Schemas (static)
  // ---------------------------

  private static readonly MemberActivityEvidenceSchema: Schema<MemberActivityEvidence> =
    new Schema<MemberActivityEvidence>(
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

  private static readonly MemberActivityBlockerSchema: Schema<MemberActivityBlocker> =
    new Schema<MemberActivityBlocker>(
      {
        title: { type: String, required: true, trim: true },
        details: { type: String, required: false, trim: true },
        severity: { type: String, required: true, enum: [ "low", "medium", "high" ] },
        reportedAt: { type: Date, required: true },
        resolvedAt: { type: Date, required: false },
      },
      { _id: false }
    );

  // ---------------------------
  // Main Schema (static)
  // ---------------------------

  private static readonly MemberActivitySchema: Schema<IMemberActivity> =
    new Schema<IMemberActivity>(
      {
        // Relations
        workItemId: { type: Schema.Types.ObjectId, required: true, ref: "WorkItem", index: true },
        teamId: { type: Schema.Types.ObjectId, required: true, ref: "TeamManagement", index: true },

        // Owner member (the planner)
        userId: { type: Schema.Types.ObjectId, required: true, ref: "User", index: true },

        // Audit / governance
        createdByUserId: { type: Schema.Types.ObjectId, required: true, ref: "User", index: true },
        requestId: { type: String, required: false, trim: true, index: true },
        source: { type: String, required: false, enum: [ "rest", "ws", "system" ] },

        // Type classification
        type: { type: String, required: true, enum: MEMBER_ACTIVITY_TYPE, index: true },

        // Calendar event shape (Google Calendar style)
        title: { type: String, required: true, trim: true },
        notes: { type: String, required: false, trim: true },

        startAt: { type: Date, required: true, index: true },
        endAt: { type: Date, required: true, index: true },
        allDay: { type: Boolean, required: true },
        timezone: { type: String, required: false, trim: true },

        status: { type: String, required: true, enum: MEMBER_ACTIVITY_STATUS, index: true },

        // Optional progress deltas (used by progress_update/milestone completion)
        progressBefore: { type: Number, required: false, min: 0, max: 100 },
        progressAfter: { type: Number, required: false, min: 0, max: 100 },

        // Optional milestone identifier (helpful for updating the same milestone without scanning)
        milestoneId: { type: String, required: false, trim: true, index: true },

        // Heavy payloads live here, not on WorkItem
        evidence: { type: [ MemberActivityModelFactory.MemberActivityEvidenceSchema ], required: false },
        blockers: { type: [ MemberActivityModelFactory.MemberActivityBlockerSchema ], required: false },
      },
      {
        timestamps: true,
        versionKey: false,
      }
    );

  // ---------------------------
  // Index setup (static)
  // ---------------------------

  private static ensureIndexes(): void {
    // Timeline for one work item (paged)
    MemberActivityModelFactory.MemberActivitySchema.index( { workItemId: 1, createdAt: -1 } );

    // Calendar range queries (per member)
    MemberActivityModelFactory.MemberActivitySchema.index( { userId: 1, startAt: 1, endAt: 1 } );

    // Calendar range queries (per work item)
    MemberActivityModelFactory.MemberActivitySchema.index( { workItemId: 1, startAt: 1, endAt: 1 } );

    // Reporting by team + type
    MemberActivityModelFactory.MemberActivitySchema.index( { teamId: 1, type: 1, createdAt: -1 } );
  }

  // ---------------------------
  // Schema validation hooks (class method)
  // ---------------------------

  private static attachHooks(): void {
    // Ensure endAt >= startAt (calendar correctness)
    MemberActivityModelFactory.MemberActivitySchema.pre( "validate", function ( next ) {
      const doc = this as IMemberActivity;

      if ( doc.endAt.getTime() < doc.startAt.getTime() ) {
        next( new Error( "endAt must be greater than or equal to startAt." ) );
        return;
      }

      next();
    } );
  }

  // ---------------------------
  // Public creator (static)
  // ---------------------------

  public static buildModel(): Model<IMemberActivity> {
    MemberActivityModelFactory.ensureIndexes();
    MemberActivityModelFactory.attachHooks();

    return model<IMemberActivity>(
      MemberActivityModelFactory.MODEL_NAME,
      MemberActivityModelFactory.MemberActivitySchema
    );
  }
}

export const MemberActivityModel = MemberActivityModelFactory.buildModel();
