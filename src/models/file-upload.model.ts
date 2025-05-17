// models/file-upload.model.ts
import mongoose from "mongoose";

const userDocumentSchema = new mongoose.Schema(
  {
    username: { type: String, required: true },
    files: [
      {
        originalName: { type: String },
        storedName: { type: String },
        mimeType: { type: String },
        size: { type: String },
        path: { type: String },
        URL: { type: String },
        extension: { type: String },
        download: { type: String },
        uploader: { type: String },
        uploadDate: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true }
);
export const UserDocument = mongoose.model("UserDocument", userDocumentSchema);
