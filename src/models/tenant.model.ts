// src/models/tenant.model.ts
// ─────────────────────────────────────────────────────────────────────────────
// PURPOSE: Tenant model (types + DB schema) in a class-based pattern.
// NOTE: Controllers/services handle all operations; this file only declares
//       types, builds the schema, and registers the model.
// ─────────────────────────────────────────────────────────────────────────────

import {Schema, model, type Document, type Model} from 'mongoose';

// -------------------------- INTERFACES (TypeScript) --------------------------

export interface ITenant extends Document {
  username: string;      // Unique username (used for tenant login or linking)
  image: string;         // Path or URL to tenant’s profile image
  name: string;          // Full name of the tenant
  contactNumber: string; // Tenant’s phone or mobile number
  email: string;         // Tenant’s email address
  gender: string;        // Gender ("Male", "Female", "Other", etc.)
  addedBy: string;       // Username or ID of the admin/agent who added the tenant
  createdAt: Date;       // via timestamps
  updatedAt: Date;       // via timestamps
}

// -------------------------- CLASS-BASED BUILDER ------------------------------

export class TenantModelBuilder {
  /** Build and return the Mongoose schema for Tenant. */
  public static buildSchema(): Schema<ITenant> {
    const TenantSchema = new Schema<ITenant>(
      {
        username: {type: String, required: true, default: ''},
        image: {type: String, required: true, default: ''},
        name: {type: String, required: true, default: ''},
        contactNumber: {type: String, required: true, default: ''},
        email: {type: String, required: true, default: ''},
        gender: {type: String, required: true, default: ''},
        addedBy: {type: String, required: true, default: ''},
      },
      {
        timestamps: true, // adds createdAt & updatedAt automatically
      }
    );

    // Optional helpful indexes (kept non-unique to preserve original behavior)
    TenantSchema.index({username: 1});
    TenantSchema.index({email: 1});

    return TenantSchema;
  }

  /** Create and return the Mongoose model instance. */
  public static getModel(): Model<ITenant> {
    const schema = this.buildSchema();
    // Explicit collection name for consistency: 'tenants'
    return model<ITenant>('Tenant', schema, 'tenants');
  }
}

// -------------------------- MODEL EXPORT ------------------------------------

export const TenantModel = TenantModelBuilder.getModel();

/*
Usage example:
  const newTenant = new TenantModel({ username: 'john_doe', name: 'John Doe', ... });
  await newTenant.save();
*/
