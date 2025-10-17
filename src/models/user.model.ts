// ==========================================================
// File: src/models/user.model.ts
// Description: Mongoose schema and TypeScript model definition
//              for system users (admins, agents, tenants, etc.)
// ==========================================================

import {Schema, model, Document} from "mongoose";

/* ==========================================================
   📘 TYPES & INTERFACES
   ========================================================== */

/**
 * Defines all valid user roles within the system.
 * Extend this list as the application introduces new user categories.
 */
export type Role =
  | "admin"
  | "agent"
  | "tenant"
  | "owner"
  | "operator"
  | "manager"
  | "developer"
  | "user";

/**
 * Represents a standard address structure used by users.
 * This structure may later be reused by other entities (e.g., Property).
 */
export interface Address {
  street: string;
  houseNumber: string;
  city: string;
  postcode: string;
  country?: string;
  stateOrProvince?: string;
}

/**
 * Defines a single permission entry per module.
 * Example: { module: "property", actions: ["create", "edit", "delete"] }
 */
export interface PermissionEntry {
  module: string;
  actions: string[];
}

/**
 * Represents the access control map for a given role,
 * including all permission entries for the modules accessible by that role.
 */
export interface ROLE_ACCESS_MAP {
  role: string;
  permissions: PermissionEntry[];
}

/**
 * Basic structure for user authentication credentials.
 */
export interface UserCredentials {
  username: string;
  password: string;
  rememberMe?: boolean;
}

/**
 * Country representation (used for UI data or external API responses).
 */
export interface Country {
  name: string;
  code: string;
  emoji: string;
  unicode: string;
  image: string;
}

/**
 * Full Mongoose document representation for a User.
 * Includes timestamps and OTP/email verification fields.
 */
export interface IUser extends Document {
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
  role: Role;
  address: Address;
  isActive: boolean;
  access: ROLE_ACCESS_MAP;
  otpVerifycation: boolean; // Whether user verified via OTP
  otpToken: string;
  otpTokenExpires: Date;
  emailVerified: boolean;
  emailVerificationToken?: string;
  emailVerificationTokenExpires?: Date;
  autoDelete: boolean; // If true, user will be soft-deleted after inactivity
  creator: string; // Created by (username or system)
  updator?: string; // Last updated by
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Token mapping model (e.g., for password reset, session, or email verification).
 */
interface ITokenMap extends Document {
  token: string;
  username: string;
  type: "view" | "email" | "session" | string;
  expiresAt: Date;
}

/* ==========================================================
   🧩 SCHEMAS
   ========================================================== */

/**
 * Sub-schema for Address.
 * Embedded directly inside User documents.
 */
const AddressSchema = new Schema<Address>({
  street: {type: String, required: true},
  houseNumber: {type: String, required: true},
  city: {type: String, required: true},
  postcode: {type: String, required: true},
  country: {type: String},
  stateOrProvince: {type: String},
});

/**
 * Sub-schema for PermissionEntry.
 * Defines permissions for individual modules.
 */
const PermissionEntrySchema = new Schema<PermissionEntry>({
  module: {type: String, required: true},
  actions: {type: [String], required: true},
});

/**
 * Sub-schema for Access Map.
 * Each user holds one access role mapping that lists all permissions.
 */
const AccessSchema = new Schema<ROLE_ACCESS_MAP>({
  role: {type: String, required: true},
  permissions: {type: [PermissionEntrySchema], required: true},
});

/**
 * Main User Schema defining all fields and relationships.
 * Includes validation, enum constraints, and timestamp metadata.
 */
export const UserSchema = new Schema<IUser>(
  {
    // ─────────────── Basic Info ───────────────
    name: {type: String, required: true},
    username: {type: String, required: true, unique: true},
    email: {type: String, required: true, unique: true},
    password: {type: String, required: true},
    dateOfBirth: {type: Date, required: true},
    age: {type: Number, required: true},
    gender: {type: String, required: true},
    image: {type: String},
    bio: {type: String},
    phoneNumber: {type: String},

    // ─────────────── Role & Access ───────────────
    role: {
      type: String,
      enum: [
        "admin",
        "agent",
        "tenant",
        "owner",
        "operator",
        "manager",
        "developer",
        "user",
      ],
      required: true,
    },
    address: {type: AddressSchema, required: true},
    isActive: {type: Boolean, default: true},
    access: {type: AccessSchema, required: true},

    // ─────────────── Verification & OTP ───────────────
    otpVerifycation: {type: Boolean, default: false},
    otpToken: {type: String},
    otpTokenExpires: {type: Date},
    emailVerified: {type: Boolean, default: false},
    emailVerificationToken: {type: String},
    emailVerificationTokenExpires: {type: Date},

    // ─────────────── Admin Controls ───────────────
    autoDelete: {type: Boolean, default: true},
    creator: {type: String, required: true},
    updator: {type: String, required: false},
  },
  {
    timestamps: true, // Automatically adds createdAt & updatedAt
  }
);

/* ==========================================================
   📤 EXPORT MODEL
   ========================================================== */

/**
 * The exported Mongoose model for user documents.
 * Used across controllers, middleware, and services.
 */
export const UserModel = model<IUser>("User", UserSchema);
