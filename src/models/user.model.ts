// src/models/user.model.ts
// ─────────────────────────────────────────────────────────────────────────────
// PURPOSE: User model (types + DB schema) in a class-based pattern.
// NOTE: No business logic here — controllers/services handle operations.
// ─────────────────────────────────────────────────────────────────────────────

import { Schema, model, type Document, type Model } from 'mongoose';
import { Address } from './property.model';

// Import ONLY types from access-map to avoid runtime circular deps.
import type {
  AccessModuleKey,
  AccessActionKey,
} from '../source/access-map.source';

/* ============================================================================
 * TYPES & INTERFACES
 * ==========================================================================*/

/** Valid user roles within the system. */
export type Role =
  | 'admin'
  | 'agent'
  | 'tenant'
  | 'owner'
  | 'operator'
  | 'manager'
  | 'developer'
  | 'user';

/**
 * One permission entry for a given module.
 * - `module`  → must be one of AccessModuleKey (aligned with ACCESS_OPTIONS).
 * - `actions` → allowed actions for that module (AccessActionKey[]).
 */
export interface PermissionEntry {
  module: AccessModuleKey;
  actions: AccessActionKey[];
}

/** Role → list of permission entries. */
export interface ROLE_ACCESS_MAP {
  role: Role;
  permissions: PermissionEntry[];
}

/** Simple credential DTO (not stored directly here). */
export interface UserCredentials {
  username: string;
  password: string;
  rememberMe?: boolean;
}

/** Country DTO used elsewhere in the app (kept here for completeness). */
export interface Country {
  name: string;
  code: string;
  emoji: string;
  unicode: string;
  image: string;
}

/** Full Mongoose document representation for a User. */
export interface IUser extends Document {
  // Basic
  name: string;
  username: string;
  email: string;
  password: string;
  dateOfBirth: Date;
  age: number;
  gender: string;
  image?: string;
  phoneNumber?: string;
  bio: string;

  // Role & access
  role: Role;
  address: Address;
  isActive: boolean;
  access: ROLE_ACCESS_MAP;

  // Verification
  otpVerifycation: boolean;
  otpToken: string;
  otpTokenExpires: Date;
  emailVerified: boolean;
  emailVerificationToken?: string;
  emailVerificationTokenExpires?: Date;

  // Admin controls
  autoDelete: boolean;
  creator: string;
  updator?: string;

  // MFA
  multiAuthEnabled: boolean;     // user chose to enable MFA
  multiAuthActivatedAt?: Date;   // when QR + foreign app completed

  // Timestamps (added automatically by Mongoose)
  createdAt: Date;
  updatedAt: Date;
}

/** Optional: token map type (declared here if referenced externally). */
interface ITokenMap extends Document {
  token: string;
  username: string;
  type: 'view' | 'email' | 'session' | string;
  expiresAt: Date;
}

/* ============================================================================
 * CLASS-BASED BUILDER
 * ==========================================================================*/

export class UserModelBuilder {
  /** Build sub-schemas (kept private and class-based). */
  private static buildSubSchemas() {
    const AddressSchema = new Schema<Address>(
      {
        street: { type: String, required: true, trim: true },
        houseNumber: { type: String, required: true, trim: true },
        city: { type: String, required: true, trim: true },
        postcode: { type: String, required: true, trim: true },
        country: { type: String, trim: true },
        stateOrProvince: { type: String, trim: true },
      },
      { _id: false }
    );

    // NOTE: at DB level we still store strings; TS types enforce AccessModuleKey/AccessActionKey.
    const PermissionEntrySchema = new Schema<PermissionEntry>(
      {
        module: { type: String, required: true, trim: true },
        actions: { type: [ String ], required: true, default: [] },
      },
      { _id: false }
    );

    const AccessSchema = new Schema<ROLE_ACCESS_MAP>(
      {
        role: { type: String, required: true, trim: true },
        permissions: { type: [ PermissionEntrySchema ], required: true, default: [] },
      },
      { _id: false }
    );

    return { AddressSchema, PermissionEntrySchema, AccessSchema };
  }

  /** Build the main User schema. */
  public static buildSchema(): Schema<IUser> {
    const { AddressSchema, AccessSchema } = this.buildSubSchemas();

    const UserSchema = new Schema<IUser>(
      {
        // ── Basic Info
        name: { type: String, required: true, trim: true },
        username: { type: String, required: true, unique: true, trim: true, index: true },
        email: { type: String, required: true, unique: true, trim: true, index: true },
        password: { type: String, required: true }, // hashed in services
        dateOfBirth: { type: Date, required: true },
        age: { type: Number, required: true, min: 0 },
        gender: { type: String, required: true, trim: true },
        image: { type: String, trim: true },
        bio: { type: String, default: '', trim: true },
        phoneNumber: { type: String, trim: true },

        // ── Role & Access
        role: {
          type: String,
          enum: [ 'admin', 'agent', 'tenant', 'owner', 'operator', 'manager', 'developer', 'user' ],
          required: true,
          index: true,
        },
        address: { type: AddressSchema, required: true },
        isActive: { type: Boolean, default: true, index: true },

        // Default: user with no explicit permissions yet.
        access: {
          type: AccessSchema,
          required: true,
          default: () => ( {
            role: 'user',
            permissions: [],
          } ),
        },

        // ── Verification & OTP
        otpVerifycation: { type: Boolean, default: false },
        otpToken: { type: String, default: '' },
        otpTokenExpires: { type: Date },
        emailVerified: { type: Boolean, default: false, index: true },
        emailVerificationToken: { type: String },
        emailVerificationTokenExpires: { type: Date },

        // ── MFA
        multiAuthEnabled: {
          type: Boolean,
          required: true,
          default: false,
        },
        multiAuthActivatedAt: {
          type: Date,
          required: false,
          default: undefined, // no activation date until MFA is actually activated
        },

        // ── Admin Controls
        autoDelete: { type: Boolean, default: true },
        creator: { type: String, required: true, trim: true },
        updator: { type: String, trim: true },
      },
      {
        timestamps: true, // adds createdAt, updatedAt
        versionKey: false,
        minimize: true,
      }
    );

    // Helpful compound/text indexes for search & filtering
    UserSchema.index( { name: 'text', email: 'text', username: 'text' } );

    return UserSchema;
  }

  /** Create and return the Mongoose model instance. */
  public static getModel(): Model<IUser> {
    const schema = this.buildSchema();
    // Explicit collection name for consistency: 'users'
    return model<IUser>( 'User', schema, 'users' );
  }
}

/* ============================================================================
 * MODEL EXPORT
 * ==========================================================================*/

export const UserModel = UserModelBuilder.getModel();
