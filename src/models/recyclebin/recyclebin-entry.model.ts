// Path: src/models/recyclebin/recyclebin-entry.model.ts
// =============================================================================
// RecycleBinEntry Model (MongoDB)
// -----------------------------------------------------------------------------
// PURPOSE (Windows-like behavior):
// - Acts as the "Recycle Bin list index" for frontend module.
// - Stores enough metadata for listing/filtering/search/pagination.
// - Stores file manifest (FileMetaPacket[]) so engine can restore/move files.
// - Stores snapshotData (Record<string, unknown>) for fast preview + restore.
//   (Disk snapshot.json still exists as durability source of truth.)
//
// STORAGE STRATEGY:
// - DB = UI index + quick snapshotData (fast list/search).
// - Disk = snapshot.json + meta.json + moved files (durability).
//
// IMPORTANT:
// - Parent deletes only DB domain record AFTER recycle bin engine confirms recorded.
// - Parent never deletes local files.
// =============================================================================

import { Schema, model, type Document, type Model } from "mongoose";

import type { FileMetaPacket } from "../../types/common";

// If your AuthUser is in ../common as you showed:
import type { AuthUser } from "../../types/common";

/* =============================================================================
 * A) Entity Type (DB Document Shape)
 * ========================================================================== */

export type RecycleBinStatus =
  | "recording"          // engine started recording (optional)
  | "recorded"           // snapshot/files/meta written successfully
  | "restore_in_progress"
  | "restored"
  | "purged"
  | "failed";

/**
 * IMPORTANT:
 * We keep this entity “DB-friendly”.
 * - Date fields are stored as Date in MongoDB.
 * - UI DTO conversion will convert to ISO strings.
 */
export interface RecycleBinEntryEntity extends Document {
  sourceKey: string;
  refId: string;

  label: string;
  description?: string;

  deletedAt: Date;
  deletedBy: AuthUser;

  /**
   * Disk pointers (Electron-safe relative paths)
   * Example:
   * - public/recyclebin/teamTask/<refId>/snapshot.json
   */
  recycleDirRelPath: string;
  snapshotRelPath: string;
  metaRelPath: string;
  filesDirRelPath: string;

  /**
   * Stored to support restore/move operations.
   * Uses your FileMetaPacket contract.
   */
  files: FileMetaPacket[];

  /**
   * Snapshot stored in DB for fast preview + restore if disk read is avoided.
   * Keep it JSON-safe (Schema.Types.Mixed).
   */
  snapshotData: Record<string, unknown>;

  /**
   * Extra filter metadata (optional)
   */
  tags?: string[];
  module?: string;
  entity?: string;
  extra?: Record<string, unknown>;

  /**
   * Lifecycle status for enterprise correctness.
   * (Not required by Windows UI, but very useful in real systems.)
   */
  status: RecycleBinStatus;

  /**
   * Optional audit: who restored / purged and when.
   * (These are optional because entry might never be restored/purged.)
   */
  restoredAt?: Date;
  restoredBy?: AuthUser;

  purgedAt?: Date;
  purgedBy?: AuthUser;
}

export interface RecycleBinEntryEntityDto extends Omit<RecycleBinEntryEntity, keyof Document> {}

/* =============================================================================
 * B) Sub Schemas (AuthUser + FileMetaPacket)
 * ========================================================================== */

/**
 * AuthUser schema (based on your AuthUser contract):
 * type AuthUser = {
 *   sub?: string;
 *   userId: Types.ObjectId | string;
 *   username: string;
 *   role: Role;
 *   teamCodes?: string[];
 *   branchId?: string;
 * }
 */
class AuthUserSchemaFactory {
  public static build(): Schema<AuthUser> {
    return new Schema<AuthUser>(
      {
        sub: { type: String, required: false, default: undefined, trim: true },

        // userId can be ObjectId or string -> store as string for flexibility.
        // If you want strict ObjectId, change to Schema.Types.ObjectId.
        userId: { type: Schema.Types.Mixed, required: true },

        username: { type: String, required: true, trim: true },

        // Role is a union type in TS, but in Mongo it’s stored as string.
        role: { type: String, required: true, trim: true },

        teamCodes: { type: [String], required: false, default: undefined },
        branchId: { type: String, required: false, default: undefined, trim: true },
      },
      { _id: false }
    );
  }
}

/**
 * FileMetaPacket schema (based on your FileMetaPacket contract).
 * This supports restore and also allows the UI to show attachments in recycle entry.
 */
class FileMetaPacketSchemaFactory {
  public static build(): Schema<FileMetaPacket> {
    return new Schema<FileMetaPacket>(
      {
        originalName: { type: String, required: true, trim: true },
        storedName: { type: String, required: true, trim: true },

        extension: { type: String, required: true, trim: true },
        mimeType: { type: String, required: true, trim: true },
        sizeBytes: { type: Number, required: true },

        // PropEase rule: relativePath is under "public/" and no leading "/"
        relativePath: { type: String, required: true, trim: true },
        publicUrl: { type: String, required: true, trim: true },
        absDiskPath: { type: String, required: true, trim: true },

        fieldName: { type: String, required: true, trim: true },
        uploadedAtIso: { type: String, required: true, trim: true },

        encoding: { type: String, required: false, default: undefined, trim: true },
        checksumSha256: { type: String, required: false, default: undefined, trim: true },
      },
      { _id: false }
    );
  }
}

/* =============================================================================
 * C) Main Schema Factory (100% class-based)
 * ========================================================================== */

class RecycleBinEntrySchemaFactory {
  public static build(): Schema<RecycleBinEntryEntity> {
    const authUserSchema = AuthUserSchemaFactory.build();
    const fileMetaSchema = FileMetaPacketSchemaFactory.build();

    const schema = new Schema<RecycleBinEntryEntity>(
      {
        sourceKey: { type: String, required: true, trim: true, index: true },
        refId: { type: String, required: true, trim: true, index: true },

        label: { type: String, required: true, trim: true, maxlength: 300 },
        description: { type: String, required: false, default: undefined, trim: true, maxlength: 2000 },

        deletedAt: { type: Date, required: true, index: true },
        deletedBy: { type: authUserSchema, required: true },

        recycleDirRelPath: { type: String, required: true, trim: true },
        snapshotRelPath: { type: String, required: true, trim: true },
        metaRelPath: { type: String, required: true, trim: true },
        filesDirRelPath: { type: String, required: true, trim: true },

        files: { type: [fileMetaSchema], required: true, default: [] },

        snapshotData: { type: Schema.Types.Mixed, required: true },

        tags: { type: [String], required: false, default: undefined },
        module: { type: String, required: false, default: undefined, trim: true },
        entity: { type: String, required: false, default: undefined, trim: true },
        extra: { type: Schema.Types.Mixed, required: false, default: undefined },

        status: { type: String, required: true, default: "recorded", trim: true },

        restoredAt: { type: Date, required: false, default: undefined },
        restoredBy: { type: authUserSchema, required: false, default: undefined },

        purgedAt: { type: Date, required: false, default: undefined },
        purgedBy: { type: authUserSchema, required: false, default: undefined },
      },
      {
        timestamps: false,
        versionKey: false,
        collection: "recyclebin_entries",
      }
    );

    // Prevent duplicate recycle entries for same (sourceKey, refId)
    schema.index({ sourceKey: 1, refId: 1 }, { unique: true });

    // Optional helpful index for UI search modules
    schema.index({ label: 1 });
    schema.index({ "deletedBy.username": 1 });

    return schema;
  }
}

/* =============================================================================
 * D) Model Export (class-based wrapper)
 * ========================================================================== */

export class RecycleBinEntryModelProvider {
  private static readonly MODEL_NAME = "RecycleBinEntry";
  private static _model: Model<RecycleBinEntryEntity> | null = null;

  public static getModel(): Model<RecycleBinEntryEntity> {
    if (!this._model) {
      const schema = RecycleBinEntrySchemaFactory.build();
      this._model = model<RecycleBinEntryEntity>(this.MODEL_NAME, schema);
    }
    return this._model;
  }
}

// ✅ Common export style used in many PropEase modules:
export const RecycleBinEntryModel: Model<RecycleBinEntryEntity> =
  RecycleBinEntryModelProvider.getModel();
