// src/models/file-upload.model.ts
// ─────────────────────────────────────────────────────────────────────────────
// PURPOSE: Store user-uploaded document metadata (e.g. scanned files, images)
// PATTERN: Class-based (no free functions or inline schema code)
// ─────────────────────────────────────────────────────────────────────────────

import { Schema, model, type Document, type Model } from 'mongoose';

/* ============================================================================
 * 1) Interface definitions (strong typing)
 * ==========================================================================*/

/** Shape of a single file metadata entry inside the "files" array */
export interface UploadedFile {
  originalName?: string;
  storedName?: string;
  mimeType?: string;
  size?: string;
  path?: string;
  URL?: string;
  extension?: string;
  download?: string;
  uploader?: string;
  uploadDate?: Date;
}

/** Main document interface for each user's uploaded file set */
export interface UserDocumentEntity extends Document {
  username: string;
  files: UploadedFile[];
  createdAt: Date;
  updatedAt: Date;
}

/* ============================================================================
 * 2) Class to encapsulate schema creation & model registration
 * ==========================================================================*/

export class FileUploadModel {
  /** 
   * Build and return the Mongoose Schema for user documents. 
   * We use static so it can be reused cleanly from services if needed.
   */
  public static buildSchema(): Schema<UserDocumentEntity> {
    // Nested sub-schema for individual files
    const FileSchema = new Schema<UploadedFile>(
      {
        originalName: { type: String, trim: true },
        storedName: { type: String, trim: true },
        mimeType: { type: String, trim: true },
        size: { type: String, trim: true },
        path: { type: String, trim: true },
        URL: { type: String, trim: true },
        extension: { type: String, trim: true },
        download: { type: String, trim: true },
        uploader: { type: String, trim: true },
        uploadDate: { type: Date, default: Date.now },
      },
      { _id: false } // no subdocument _id fields to reduce noise
    );

    // Main schema for each user's document group
    const UserDocumentSchema = new Schema<UserDocumentEntity>(
      {
        username: { type: String, required: true, trim: true, index: true },
        files: { type: [ FileSchema ], default: [] },
      },
      { timestamps: true } // automatically adds createdAt & updatedAt
    );

    return UserDocumentSchema;
  }

  /** 
   * Create and return the Mongoose model instance.
   * This avoids multiple compilation errors if hot-reloaded in dev mode.
   */
  public static getModel(): Model<UserDocumentEntity> {
    const schema = this.buildSchema();
    // Use collection name "user_documents" to stay plural & consistent
    return model<UserDocumentEntity>( 'UserDocument', schema, 'user_documents' );
  }
}

/* ============================================================================
 * 3) Export a ready-to-use model instance
 * ==========================================================================*/
export const UserDocumentModel = FileUploadModel.getModel();

/* ============================================================================
 * NOTES
 * ============================================================================
 * • This model only defines document structure and timestamps.
 *   It does NOT perform uploads, moves, or deletions — those belong in
 *   your controller or service layer.
 * • Each record represents one username with an array of uploaded files.
 * • `timestamps: true` automatically maintains `createdAt` and `updatedAt`.
 * • Index on `username` lets you quickly fetch all uploads for a user.
 * ============================================================================
 */
