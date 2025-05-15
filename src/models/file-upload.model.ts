// models/file-upload.model.ts
import mongoose from "mongoose";

const userDocumentSchema = new mongoose.Schema(
  {
    username: { type: String, required: true },
    files: [
      {
        originalName: String,
        storedName: String,
        mimeType: String,
        size: Number,
        path: String,
        URL: String,
        extension: String,
        download: String,
        uploadDate: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true }
);

export const UserDocument = mongoose.model("UserDocument", userDocumentSchema);
