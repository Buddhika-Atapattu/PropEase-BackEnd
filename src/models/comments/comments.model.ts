// Path: src/models/comments/comment.model.ts
// ============================================================================
// Main Comment Model (Standalone / System-wide) — CLASS-BASED
// ----------------------------------------------------------------------------
// ✅ Supports platform-wide Comment Engine
// ✅ Supports Facebook-style nested replies (threading)
// ✅ Supports pinning (pinned + pinnedAtIso + pinnedByUserId)
// ✅ Keeps your existing DTO shape and null/optional rules
// ✅ Adds "scopePairs" for fast querying of commentTarget.scope
// ✅ Stores commentTarget.modelName (authoritative resolved target model name)
// ✅ Model name: "Comment" | collection: "comments"
// ✅ Dev/hot-reload safe: prevents OverwriteModelError
//
// IMPORTANT DESIGN NOTE
//   We keep a FLAT collection and model nesting using thread metadata.
//   We do NOT store nested arrays of replies inside a comment document.
//   Flat + indexed threads is the scalable approach for MongoDB.
// ============================================================================

import mongoose, { Schema, type Model, type HydratedDocument, type Types } from "mongoose";

import type {
  CommentAttachmentDto,
  CommentAuthorDto,
  CommentDto,
  CommentTargetDto,
} from "../../types/comment.types";

import {
  CommentAttachmentSourceValues,
  CommentAudienceValues,
} from "../../types/comment.types";

// =============================================================================
// Extra helper for advanced scope filtering (scopePairs)
// =============================================================================

/**
 * ScopePair is a denormalized form of commentTarget.scope.
 *
 * Why it exists:
 * - `scope` is an object (Mixed) and MongoDB indexing on arbitrary keys is hard.
 * - For fast filters like "scopeKey=teamCode & scopeValue=TEAM-001",
//   we store pairs like: [{k:"teamCode", v:"TEAM-001"}, ...]
 *
 * Rule:
 * - v is stored as string to keep querying consistent and indexable.
 */
export interface ScopePair {
  k: string;
  v: string;
}

// =============================================================================
// Entity + Document Types
// =============================================================================

/**
 * Persisted entity in Mongo.
 * - Extends CommentDto (your canonical contract)
 * - Adds scopePairs (index-friendly helper)
 *
 * NOTE:
 * - CommentDto now includes threading fields (parentCommentId, threadRootId, depth, path)
 *   and pin fields (pinned, pinnedAtIso, pinnedByUserId).
 * - We persist those fields here as well.
 */
export interface CommentEntity extends CommentDto {
  scopePairs?: ScopePair[] | null;
}

/**
 * Hydrated mongoose document type (recommended with Mongoose v6/v7).
 */
export type HydratedCommentDocument = HydratedDocument<CommentEntity> & {
  _id: Types.ObjectId;
  id: string; // virtual string id when { id: true }
};

// =============================================================================
// Schema Factory (class-based)
// =============================================================================

export class CommentModelSchemaFactory {
  // ---------------------------------------------
  // Sub-schema: ScopePair (k/v)
  // ---------------------------------------------
  private buildScopePair(): Schema<ScopePair> {
    return new Schema<ScopePair>(
      {
        k: { type: String, trim: true, required: true },
        v: { type: String, trim: true, required: true },
      },
      {
        _id: false,
        id: false,
      }
    );
  }

  // ---------------------------------------------
  // Sub-schema: CommentTargetDto
  // ---------------------------------------------
  private buildCommentTarget(): Schema<CommentTargetDto> {
    return new Schema<CommentTargetDto>(
      {
        /**
         * section is the top-level domain:
         * Users | Properties | Complaints | Tenants | Leases | Teams
         */
        section: { type: String, trim: true, required: true },

        /**
         * subSection is NOT universal.
         * Your current design rule:
         * - Required ONLY when section === 'Teams'
         * - Optional/undefined for all other sections
         *
         * Examples under Teams:
         * - "Teams" (team-level)
         * - "WorkItems" (task-level)
         * - "Events" (event-level)
         */
        subSection: {
          type: String,
          trim: true,
          required: false,
          default: undefined, // keep omitted when not provided
        },

        /**
         * refId is the target reference:
         * - Users      => username (or future userId)
         * - Properties => property business id
         * - Complaints => complaint code
         * - Tenants    => username
         * - Leases     => leaseID
         * - Teams      => teamCode (or WorkItem id / Event id based on subSection)
         */
        refId: { type: String, trim: true, required: true },

        /**
         * module is an optional "logical module hint" (free text)
         * Example:
         * - "ComplaintEdit"
         * - "TeamTaskView"
         * Not required for engine, but useful for filtering.
         */
        module: { type: String, trim: true, required: false, default: undefined },

        /**
         * scope is an optional flexible object for fine-grained ownership routing.
         * Example:
         *  scope: { teamCode: "TEAM-001", taskId: "WORK-..." }
         */
        scope: { type: Schema.Types.Mixed, required: false, default: null },

        /**
         * modelName is stored as the authoritative resolved model identifier.
         * Design:
         * - FE sends section/subSection/refId
         * - Backend uses CommentsSourceRegistry to resolve:
         *     modelName = "User" | "Property" | "Complaint" | "Tenant" | "Lease" | "TeamManagement" | "WorkItem" | "WorkEvent"
         * - Store it so DB always knows what this comment truly belongs to.
         */
        modelName: { type: String, trim: true, required: false, default: undefined },
      },
      { _id: false, id: false }
    );
  }

  // ---------------------------------------------
  // Sub-schema: CommentAuthorDto
  // ---------------------------------------------
  private buildCommentAuthor(): Schema<CommentAuthorDto> {
    return new Schema<CommentAuthorDto>(
      {
        authorId: { type: String, trim: true, required: true },
        name: { type: String, trim: true, required: true },

        // role?: CommentAudience | null
        role: {
          type: String,
          enum: CommentAudienceValues,
          required: false,
          default: null,
        },

        image: { type: String, trim: true, required: false, default: null },
      },
      { _id: false, id: false }
    );
  }

  // ---------------------------------------------
  // Sub-schema: CommentAttachmentDto
  // ---------------------------------------------
  private buildCommentAttachment(): Schema<CommentAttachmentDto> {
    return new Schema<CommentAttachmentDto>(
      {
        url: { type: String, trim: true, required: true },
        name: { type: String, trim: true, required: true },

        mimetype: { type: String, trim: true, required: false, default: null },

        source: { type: String, enum: CommentAttachmentSourceValues, required: true },

        relativePath: { type: String, trim: true, required: true },

        sizeBytes: { type: Number, required: false, default: null },
        uploadedAtIso: { type: String, trim: true, required: false, default: null },
        checksumSha256: { type: String, trim: true, required: false, default: null },
      },
      { _id: false, id: false }
    );
  }

  // ---------------------------------------------
  // Main schema: Comment
  // ---------------------------------------------
  public buildCommentSchema(): Schema<CommentEntity> {
    const CommentTargetSchema = this.buildCommentTarget();
    const CommentAuthorSchema = this.buildCommentAuthor();
    const CommentAttachmentSchema = this.buildCommentAttachment();
    const ScopePairSchema = this.buildScopePair();

    const schema = new Schema<CommentEntity>(
      {
        // -------------------------------------------------------------------
        // 1) Target (where this comment belongs)
        // -------------------------------------------------------------------
        commentTarget: { type: CommentTargetSchema, required: true },

        // -------------------------------------------------------------------
        // 2) Identity
        // -------------------------------------------------------------------
        /**
         * commentId is your business id string.
         * Even though Mongo has _id, commentId is useful for:
         * - URL friendliness
         * - cursor formats
         * - federation in future (multi-db)
         */
        commentId: { type: String, trim: true, required: true, index: true },

        // -------------------------------------------------------------------
        // 3) Author / visibility
        // -------------------------------------------------------------------
        byUserId: { type: String, trim: true, required: true, index: true },
        byName: { type: String, trim: true, required: true },
        byUsername: { type: String, trim: true, required: true },
        byAvatarUrl: { type: String, trim: true, required: false, default: null },

        audience: {
          type: String,
          enum: CommentAudienceValues,
          required: true,
          index: true,
        },

        // -------------------------------------------------------------------
        // 4) Content
        // -------------------------------------------------------------------
        messageHtml: { type: String, required: true },

        // -------------------------------------------------------------------
        // 5) Threading (Facebook-style nested replies)
        // -------------------------------------------------------------------
        /**
         * parentCommentId:
         * - null => top-level comment
         * - string => reply to that comment
         *
         * NOTE:
         * - This stores your business id (commentId), not Mongo _id.
         *   That keeps APIs consistent and portable.
         */
        parentCommentId: { type: String, trim: true, required: false, default: null, index: true },

        /**
         * threadRootId:
         * - For top-level: threadRootId = commentId
         * - For replies:   threadRootId = root top-level commentId
         *
         * WHY:
         * - Lets you load a whole thread with a single indexed query.
         */
        threadRootId: { type: String, trim: true, required: false, default: null, index: true },

        /**
         * depth:
         * - 0 for top-level
         * - 1 for reply
         * - 2 for reply-to-reply ...
         *
         * Enforce maximum depth in CommentEngineService (business rule).
         */
        depth: { type: Number, required: false, default: 0, index: true },

        /**
         * path:
         * A stable ordering key for nested rendering.
         * Example:
         *  "ROOTID"
         *  "ROOTID/REPLY1"
         *  "ROOTID/REPLY1/REPLY2"
         *
         * Benefits:
         * - When sorted ascending by path, replies are naturally grouped.
         * - Efficient pagination within a thread.
         */
        path: { type: String, trim: true, required: false, default: null, index: true },

        // -------------------------------------------------------------------
        // 6) Pin support
        // -------------------------------------------------------------------
        /**
         * pinned:
         * - true => pinned comment (usually pinned top-level; your service decides)
         */
        pinned: { type: Boolean, required: false, default: false, index: true },

        pinnedAtIso: { type: String, trim: true, required: false, default: null, index: true },
        pinnedByUserId: { type: String, trim: true, required: false, default: null },

        // -------------------------------------------------------------------
        // 7) Attachments + author block
        // -------------------------------------------------------------------
        attachments: { type: [CommentAttachmentSchema], required: false, default: null },
        author: { type: CommentAuthorSchema, required: false, default: null },

        // -------------------------------------------------------------------
        // 8) ScopePairs helper
        // -------------------------------------------------------------------
        scopePairs: { type: [ScopePairSchema], required: false, default: null },

        // -------------------------------------------------------------------
        // 9) Timestamps (ISO strings by your design)
        // -------------------------------------------------------------------
        createdAtIso: {
          type: String,
          trim: true,
          required: true,
          index: true,
          default: () => new Date().toISOString(),
        },
        updatedAtIso: {
          type: String,
          trim: true,
          required: true,
          index: true,
          default: () => new Date().toISOString(),
        },
      },
      {
        collection: "comments",
        timestamps: false, // you store createdAtIso/updatedAtIso manually
        versionKey: false,
        minimize: false,
        id: true,
        toJSON: { virtuals: true },
        toObject: { virtuals: true },
      }
    );

    // =========================================================================
    // Index Strategy (must match your load patterns)
    // =========================================================================

    /**
     * Primary feed index:
     * Load comments for a target (section/subSection/refId), newest-first.
     *
     * Example query:
     *  find({ commentTarget.section, commentTarget.subSection, commentTarget.refId })
     *  sort({ createdAtIso: -1 })
     */
    schema.index({
      "commentTarget.section": 1,
      "commentTarget.subSection": 1,
      "commentTarget.refId": 1,
      createdAtIso: -1,
    });

    /**
     * Optional filter index: audience + target.
     * Useful if audience filtering is common in list APIs.
     */
    schema.index({
      "commentTarget.section": 1,
      "commentTarget.subSection": 1,
      "commentTarget.refId": 1,
      audience: 1,
      createdAtIso: -1,
    });

    /**
     * Thread loading index:
     * Load full thread by threadRootId and order by path.
     *
     * Example:
     *  find({ threadRootId })
     *  sort({ path: 1 })
     */
    schema.index({
      threadRootId: 1,
      path: 1,
    });

    /**
     * Replies loading index:
     * Load direct children of a comment (for "View replies").
     *
     * Example:
     *  find({ parentCommentId })
     *  sort({ createdAtIso: 1 })
     */
    schema.index({
      parentCommentId: 1,
      createdAtIso: 1,
    });

    /**
     * Pinned-first index (target-specific):
     * Load pinned comments for a target.
     *
     * Example:
     *  find({ target..., pinned: true }).sort({ pinnedAtIso: -1 })
     */
    schema.index({
      "commentTarget.section": 1,
      "commentTarget.subSection": 1,
      "commentTarget.refId": 1,
      pinned: 1,
      pinnedAtIso: -1,
    });

    /**
     * Module filter index:
     * If you frequently filter by commentTarget.module.
     */
    schema.index({
      "commentTarget.section": 1,
      "commentTarget.subSection": 1,
      "commentTarget.refId": 1,
      "commentTarget.module": 1,
      createdAtIso: -1,
    });

    /**
     * ScopePairs index:
     * Supports queries like:
     *  find({ "scopePairs.k": "teamCode", "scopePairs.v": "TEAM-001" })
     */
    schema.index({ "scopePairs.k": 1, "scopePairs.v": 1 });

    return schema;
  }
}

// =============================================================================
// Model Export (singleton provider)
// =============================================================================

export class CommentModelProvider {
  private static model: Model<CommentEntity> | null = null;

  public static getModel(): Model<CommentEntity> {
    if (this.model) return this.model;

    const factory = new CommentModelSchemaFactory();
    const schema = factory.buildCommentSchema();

    /**
     * ✅ Canonical model name: "Comment"
     * - avoids OverwriteModelError in dev/hot reload
     * - collection is pinned to "comments" by schema option
     */
    this.model =
      (mongoose.models.Comment as Model<CommentEntity> | undefined) ??
      mongoose.model<CommentEntity>("Comment", schema);

    return this.model;
  }
}

// ✅ Final export required by you
export const CommentModel: Model<CommentEntity> = CommentModelProvider.getModel();
