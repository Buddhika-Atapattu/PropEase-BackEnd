import { Schema, model, Document } from "mongoose";

/* ========== TYPES & INTERFACES ========== */

// User Role Types
export type Role =
  | "admin"
  | "agent"
  | "tenant"
  | "owner"
  | "operator"
  | "manager"
  | "developer"
  | "user";

// Address
export interface Address {
  street: string;
  houseNumber: string;
  city: string;
  postcode: string;
  country?: string;
  stateOrProvince?: string;
}

// Permissions
export interface PermissionEntry {
  module: string;
  actions: string[];
}

export interface ROLE_ACCESS_MAP {
  role: string;
  permissions: PermissionEntry[];
}

// User Auth Credentials
export interface UserCredentials {
  username: string;
  password: string;
  rememberMe?: boolean;
}

// Country Format (for supporting APIs)
export interface Country {
  name: string;
  code: string;
  emoji: string;
  unicode: string;
  image: string;
}

// Full User Model
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
  role: Role;
  address: Address;
  bio: string;
  isActive: boolean;
  access: ROLE_ACCESS_MAP;
  otpVerifycation: boolean;
  otpToken: string;
  otpTokenExpires: Date;
  emailVerified: boolean;
  emailVerificationToken?: string;
  emailVerificationTokenExpires?: Date;
  autoDelete: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface ITokenMap extends Document {
  token: string;
  username: string;
  type: "view" | "email" | "session" | string;
  expiresAt: Date;
}

/* ========== SCHEMAS ========== */

// Address Sub-schema
const AddressSchema = new Schema<Address>({
  street: { type: String, required: true },
  houseNumber: { type: String, required: true },
  city: { type: String, required: true },
  postcode: { type: String, required: true },
  country: { type: String },
  stateOrProvince: { type: String },
});

// Permissions Sub-schema
const PermissionEntrySchema = new Schema<PermissionEntry>({
  module: { type: String, required: true },
  actions: { type: [String], required: true },
});

// Access Role Sub-schema
const AccessSchema = new Schema<ROLE_ACCESS_MAP>({
  role: { type: String, required: true },
  permissions: { type: [PermissionEntrySchema], required: true },
});

// Main User Schema
export const UserSchema = new Schema<IUser>(
  {
    name: { type: String, required: true },
    username: { type: String, required: true, unique: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    dateOfBirth: { type: Date, required: true },
    age: { type: Number, required: true },
    gender: { type: String, required: true },
    image: { type: String },
    bio: { type: String },
    phoneNumber: { type: String },
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
    address: { type: AddressSchema, required: true },
    isActive: { type: Boolean, default: true },
    access: { type: AccessSchema, required: true },
    otpVerifycation: { type: Boolean, default: false },
    otpToken: { type: String },
    otpTokenExpires: { type: Date },
    emailVerified: { type: Boolean, default: false },
    emailVerificationToken: { type: String },
    emailVerificationTokenExpires: { type: Date },
    autoDelete: { type: Boolean, default: true },
  },
  { timestamps: true }
);

/* ========== EXPORT MODEL ========== */
export const UserModel = model<IUser>("User", UserSchema);
