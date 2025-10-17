// models/tenant.model.ts
// ============================================================================
// Tenant Model
// - Defines how tenant information is structured and stored in MongoDB.
// - Each document represents one tenant in the PropEase system.
// - Includes basic personal and contact details with audit fields.
// ============================================================================

import {Schema, model, Document} from "mongoose";

// -------------------------- INTERFACE (TypeScript) --------------------------
// This defines the TypeScript "shape" of a Tenant document.
// It ensures you get autocompletion and type-checking when accessing fields.
export interface ITenant extends Document {
  username: string;        // Unique username (used for tenant login or linking)
  image: string;           // Path or URL to tenant’s profile image
  name: string;            // Full name of the tenant
  contactNumber: string;   // Tenant’s phone or mobile number
  email: string;           // Tenant’s email address
  gender: string;          // Gender ("Male", "Female", "Other", etc.)
  addedBy: string;         // Username or ID of the admin/agent who added the tenant
}

// -------------------------- MONGOOSE SCHEMA --------------------------
// Defines how the tenant data is stored inside MongoDB.
// The `required` flag ensures each field must be provided.
// The `default` value ensures the field always exists even if not given.
const TenantSchema: Schema = new Schema(
  {
    username: {type: String, required: true, default: ""},
    image: {type: String, required: true, default: ""},
    name: {type: String, required: true, default: ""},
    contactNumber: {type: String, required: true, default: ""},
    email: {type: String, required: true, default: ""},
    gender: {type: String, required: true, default: ""},
    addedBy: {type: String, required: true, default: ""},
  },
  {
    // `timestamps: true` automatically adds:
    // - createdAt → Date when the document was first created
    // - updatedAt → Date when the document was last updated
    timestamps: true,
  }
);

// -------------------------- MODEL EXPORT --------------------------
// Exports the Mongoose model so it can be imported elsewhere.
// e.g., import { TenantModel } from "../models/tenant.model";
export const TenantModel = model<ITenant>("Tenant", TenantSchema);

// ============================================================================
// Usage example:
//   const newTenant = new TenantModel({ username: "john_doe", name: "John Doe" });
//   await newTenant.save();
// ============================================================================
