// src/models/user.model.ts
// ─────────────────────────────────────────────────────────────────────────────
// PURPOSE:
//   User model (types + DB schema) in a class-based, composable pattern.
//   - All sub-schemas are built via dedicated static-only builder classes.
//   - No business logic: only structure & indexing.
// NOTE:
//   Controllers/services handle validation, hashing, and domain logic.
// ─────────────────────────────────────────────────────────────────────────────

import {
  Schema,
  model,
  type Document,
  type Model,
} from 'mongoose';

import type { Address } from './property.model';

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

/** Simple credential DTO (not stored directly in this collection). */
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

/** Country code info for phone numbers. */
export interface CountryCodes {
  name: string;
  code: string;
  flags: {
    png: string;
    svg: string;
    alt?: string;
  };
}

/** Phone number structure attached to User. */
export interface PhoneNumber {
  code: CountryCodes;
  number: string;
}

/* --------------------------------------------------------------------------
 * FUTURE-READY SUPPORT TYPES
 * ------------------------------------------------------------------------*/

/**
 * Login metadata for security controls:
 * - failedLoginAttempts: for lockout rules
 * - lastLoginAt: last successful login (for audit)
 * - lastFailedLoginAt: last failed attempt
 * - lockedUntil: account temporarily locked until this date
 */
export interface UserLoginMetadata {
  failedLoginAttempts: number;
  lastLoginAt?: Date | null;
  lastFailedLoginAt?: Date | null;
  lockedUntil?: Date | null;
}

/**
 * Notification preferences (can be expanded later):
 * - email: enable/disable email notifications
 * - inApp: enable/disable in-app notifications
 */
export interface UserNotificationPreferences {
  email: boolean;
  inApp: boolean;
}

/**
 * User preferences for UX:
 * - theme: 'light' | 'dark' | 'system'
 * - language: e.g. 'en', 'si'
 * - timeZone: e.g. 'Asia/Colombo'
 * - dateFormat: e.g. 'YYYY-MM-DD'
 */
export interface UserPreferences {
  theme: 'light' | 'dark' | 'system';
  language: string;
  timeZone?: string | null;
  dateFormat?: string | null;
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
  phoneNumber?: PhoneNumber;
  bio: string;
  nationality: string;
  nicOrPassport: string

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
  multiAuthEnabled: boolean;          // user chose to enable MFA
  multiAuthActivatedAt?: Date | null; // when QR + foreign app completed
  multiAuthSecret: string | null;

  // Reset & recovery
  resetToken?: string | null;
  resetTokenExpiresAt?: Date | null;

  // Future-ready: login metadata & preferences
  loginMeta: UserLoginMetadata;
  preferences: UserPreferences;
  notificationPreferences: UserNotificationPreferences;

  // Timestamps (added automatically by Mongoose)
  createdAt: Date;
  updatedAt: Date;

  // Helper: convert to safe DTO for API responses
  toSafeDTO(): User;
}

/** User interface without document internals + sensitive fields. */
export interface User extends Omit<
  IUser,
  // Remove Mongoose internals and sensitive fields for DTO:
  | 'password'
  | 'resetToken'
  | 'resetTokenExpiresAt'
  | 'toSafeDTO'
  | keyof Document
> {}

export const USER_MODEL_PROJECTION = {
  password: 0,
  resetToken: 0,
  resetTokenExpiresAt: 0,
  multiAuthSecret: 0,
  otpToken: 0,
  otpTokenExpires: 0,
  emailVerificationToken: 0,
  emailVerificationTokenExpires: 0,
  __v: 0,
};

/** Optional: token map type (declared here if referenced externally). */
export interface ITokenMap extends Document {
  token: string;
  username: string;
  type: 'view' | 'email' | 'session' | string;
  expiresAt: Date;
}

/* ============================================================================
 * SUB-SCHEMA BUILDERS (STATIC-ONLY CLASSES)
 * ==========================================================================*/

/**
 * AddressSubSchemaBuilder
 * -----------------------
 * Builds the inline Address sub-schema used on the User document.
 */
export class AddressSubSchemaBuilder {
  private constructor () {}

  public static buildSchema(): Schema<Address> {
    return new Schema<Address>(
      {
        street: { type: String, required: true, trim: true },
        houseNumber: { type: String, required: true, trim: true },
        city: { type: String, required: true, trim: true },
        postcode: { type: String, required: true, trim: true },
        country: { type: String, trim: true },
        stateOrProvince: { type: String, trim: true },
      },
      { _id: false },
    );
  }
}

/**
 * FlagsSubSchemaBuilder
 * ---------------------
 * Builds the flags object attached to country codes (PNG/SVG/alt).
 */
export class FlagsSubSchemaBuilder {
  private constructor () {}

  public static buildSchema(): Schema<{ png: string; svg: string; alt?: string; }> {
    return new Schema<{ png: string; svg: string; alt?: string; }>(
      {
        png: {
          type: String,
          required: true,
          default: '',
        },
        svg: {
          type: String,
          required: true,
          default: '',
        },
        alt: {
          type: String,
          required: false,
          default: '',
        },
      },
      { _id: false },
    );
  }
}

/**
 * CountryCodeSubSchemaBuilder
 * ---------------------------
 * Builds the CountryCodes sub-schema (name, code, flags).
 */
export class CountryCodeSubSchemaBuilder {
  private constructor () {}

  public static buildSchema(): Schema<CountryCodes> {
    return new Schema<CountryCodes>(
      {
        name: {
          type: String,
          required: true,
          default: '',
        },
        code: {
          type: String,
          required: true,
          default: '',
        },
        flags: {
          type: FlagsSubSchemaBuilder.buildSchema(),
          required: true,
        },
      },
      { _id: false },
    );
  }
}

/**
 * PhoneNumberSubSchemaBuilder
 * ---------------------------
 * Builds the PhoneNumber sub-schema used in the User document.
 */
export class PhoneNumberSubSchemaBuilder {
  private constructor () {}

  public static buildSchema(): Schema<PhoneNumber> {
    return new Schema<PhoneNumber>(
      {
        code: {
          type: CountryCodeSubSchemaBuilder.buildSchema(),
          required: true,
        },
        number: {
          type: String,
          required: true,
          default: '',
        },
      },
      { _id: false },
    );
  }
}

/**
 * PermissionEntrySubSchemaBuilder
 * -------------------------------
 * At DB level we store module/actions as strings; TS enforces that the
 * values align with AccessModuleKey/AccessActionKey.
 */
export class PermissionEntrySubSchemaBuilder {
  private constructor () {}

  public static buildSchema(): Schema<PermissionEntry> {
    return new Schema<PermissionEntry>(
      {
        module: { type: String, required: true, trim: true },
        actions: { type: [ String ], required: true, default: [] },
      },
      { _id: false },
    );
  }
}

/**
 * AccessSubSchemaBuilder
 * ----------------------
 * Wraps role + permissions as an embedded object.
 */
export class AccessSubSchemaBuilder {
  private constructor () {}

  public static buildSchema(): Schema<ROLE_ACCESS_MAP> {
    return new Schema<ROLE_ACCESS_MAP>(
      {
        role: { type: String, required: true, trim: true },
        permissions: {
          type: [ PermissionEntrySubSchemaBuilder.buildSchema() ],
          required: true,
          default: [],
        },
      },
      { _id: false },
    );
  }
}

/**
 * LoginMetaSubSchemaBuilder
 * -------------------------
 * Stores security-related login metadata.
 */
export class LoginMetaSubSchemaBuilder {
  private constructor () {}

  public static buildSchema(): Schema<UserLoginMetadata> {
    return new Schema<UserLoginMetadata>(
      {
        failedLoginAttempts: {
          type: Number,
          required: true,
          default: 0,
          min: 0,
        },
        lastLoginAt: {
          type: Date,
          required: false,
          default: null,
        },
        lastFailedLoginAt: {
          type: Date,
          required: false,
          default: null,
        },
        lockedUntil: {
          type: Date,
          required: false,
          default: null,
        },
      },
      { _id: false },
    );
  }
}

/**
 * NotificationPreferencesSubSchemaBuilder
 * ---------------------------------------
 * Controls email / in-app notification toggles.
 */
export class NotificationPreferencesSubSchemaBuilder {
  private constructor () {}

  public static buildSchema(): Schema<UserNotificationPreferences> {
    return new Schema<UserNotificationPreferences>(
      {
        email: {
          type: Boolean,
          required: true,
          default: true,
        },
        inApp: {
          type: Boolean,
          required: true,
          default: true,
        },
      },
      { _id: false },
    );
  }
}

/**
 * PreferencesSubSchemaBuilder
 * ---------------------------
 * Stores UX preferences such as theme / language / timezone.
 */
export class PreferencesSubSchemaBuilder {
  private constructor () {}

  public static buildSchema(): Schema<UserPreferences> {
    return new Schema<UserPreferences>(
      {
        theme: {
          type: String,
          enum: [ 'light', 'dark', 'system' ],
          required: true,
          default: 'system',
        },
        language: {
          type: String,
          required: true,
          default: 'en',
          trim: true,
        },
        timeZone: {
          type: String,
          required: false,
          default: null,
          trim: true,
        },
        dateFormat: {
          type: String,
          required: false,
          default: null,
          trim: true,
        },
      },
      { _id: false },
    );
  }
}

/* ============================================================================
 * USER MODEL BUILDER
 * ==========================================================================*/

/**
 * UserModelBuilder
 * ----------------
 * Central point for building the User schema & model.
 * - Composes all sub-schemas via their static builder classes.
 * - Applies indexes and collection naming conventions.
 */
export class UserModelBuilder {
  private constructor () {}

  /** Build the main User schema (composition of all sub-schemas). */
  public static buildSchema(): Schema<IUser> {
    const addressSchema: Schema<Address> = AddressSubSchemaBuilder.buildSchema();
    const accessSchema: Schema<ROLE_ACCESS_MAP> = AccessSubSchemaBuilder.buildSchema();
    const phoneNumberSchema: Schema<PhoneNumber> = PhoneNumberSubSchemaBuilder.buildSchema();
    const loginMetaSchema: Schema<UserLoginMetadata> = LoginMetaSubSchemaBuilder.buildSchema();
    const preferencesSchema: Schema<UserPreferences> = PreferencesSubSchemaBuilder.buildSchema();
    const notificationPrefsSchema: Schema<UserNotificationPreferences> =
      NotificationPreferencesSubSchemaBuilder.buildSchema();

    const userSchema: Schema<IUser> = new Schema<IUser>(
      {
        // ── Basic Info
        name: {
          type: String,
          required: true,
          trim: true,
        },
        username: {
          type: String,
          required: true,
          unique: true,
          trim: true,
          index: true,
        },
        email: {
          type: String,
          required: true,
          unique: true,
          trim: true,
          index: true,
        },
        password: {
          type: String,
          required: true, // hashed in services
        },
        dateOfBirth: {
          type: Date,
          required: true,
        },
        age: {
          type: Number,
          required: true,
          min: 0,
        },
        gender: {
          type: String,
          required: true,
          trim: true,
        },
        image: {
          type: String,
          trim: true,
        },
        bio: {
          type: String,
          default: '',
          trim: true,
        },
        nationality: {
          type: String,
          default: '',
          trim: true,
          required: true,
        },
        nicOrPassport: {
          type: String,
          default: '',
          trim: true,
          required: true,
        },
        phoneNumber: {
          type: phoneNumberSchema,
          required: false,
        },

        // ── Role & Access
        role: {
          type: String,
          enum: [
            'admin',
            'agent',
            'tenant',
            'owner',
            'operator',
            'manager',
            'developer',
            'user',
          ],
          required: true,
          index: true,
        },
        address: {
          type: addressSchema,
          required: true,
        },
        isActive: {
          type: Boolean,
          default: true,
          index: true,
        },

        // Default: user with no explicit permissions yet.
        access: {
          type: accessSchema,
          required: true,
          default: (): ROLE_ACCESS_MAP => ( {
            role: 'user',
            permissions: [],
          } ),
        },

        // ── Verification & OTP
        otpVerifycation: {
          type: Boolean,
          default: false,
        },
        otpToken: {
          type: String,
          default: '',
        },
        otpTokenExpires: {
          type: Date,
        },
        emailVerified: {
          type: Boolean,
          default: false,
          index: true,
        },
        emailVerificationToken: {
          type: String,
        },
        emailVerificationTokenExpires: {
          type: Date,
        },

        // ── MFA
        multiAuthEnabled: {
          type: Boolean,
          required: true,
          default: false,
        },
        multiAuthActivatedAt: {
          type: Date,
          required: false,
          default: null,
        },
        multiAuthSecret: {
          type: String,
          required: false,
          default: null,
        },

        // ── Reset tokens
        resetToken: {
          type: String,
          required: false,
          trim: true,
          default: null,
        },
        resetTokenExpiresAt: {
          type: Date,
          required: false,
          default: null,
        },

        // ── Admin Controls
        autoDelete: {
          type: Boolean,
          default: true,
        },
        creator: {
          type: String,
          required: true,
          trim: true,
        },
        updator: {
          type: String,
          trim: true,
        },

        // ── Login & preferences (future-ready)
        loginMeta: {
          type: loginMetaSchema,
          required: true,
          default: (): UserLoginMetadata => ( {
            failedLoginAttempts: 0,
            lastLoginAt: null,
            lastFailedLoginAt: null,
            lockedUntil: null,
          } ),
        },
        preferences: {
          type: preferencesSchema,
          required: true,
          default: (): UserPreferences => ( {
            theme: 'system',
            language: 'en',
            timeZone: null,
            dateFormat: null,
          } ),
        },
        notificationPreferences: {
          type: notificationPrefsSchema,
          required: true,
          default: (): UserNotificationPreferences => ( {
            email: true,
            inApp: true,
          } ),
        },
      },
      {
        timestamps: true, // adds createdAt, updatedAt
        versionKey: false,
        minimize: true,
      },
    );

    // Helpful compound/text indexes for search & filtering
    userSchema.index( {
      name: 'text',
      email: 'text',
      username: 'text',
    } );

    // Extra index: active users by role (admin/manager dashboards)
    userSchema.index( {
      role: 1,
      isActive: 1,
    } );

    // ──────────────────────────────────────────────────────────────────────
    // toJSON transform – remove sensitive fields from generic JSON output.
    // ──────────────────────────────────────────────────────────────────────
    userSchema.set( 'toJSON', {
      transform: ( _doc, ret: any ) => {
        const out = ret as Record<string, unknown>;

        delete out.password;
        delete out.resetToken;
        delete out.resetTokenExpiresAt;
        delete out.__v;

        return out;
      },
    } );


    // ──────────────────────────────────────────────────────────────────────
    // toSafeDTO – explicit DTO builder for API responses.
    // IMPORTANT: this does NOT modify the DB; only the in-memory object.
    // ──────────────────────────────────────────────────────────────────────
    userSchema.method( "toSafeDTO", function toSafeDTO( this: IUser ): User {
      // Cast to a mutable record so TS allows deletion
      const raw = this.toObject( {
        getters: false,
        virtuals: false,
      } ) as Record<string, unknown>;

      // Delete sensitive fields safely
      delete raw.password;
      delete raw.resetToken;
      delete raw.resetTokenExpiresAt;
      delete raw.__v;

      return raw as User;
    } );


    return userSchema;
  }

  /** Create and return the Mongoose model instance. */
  public static getModel(): Model<IUser> {
    const schema: Schema<IUser> = this.buildSchema();
    // Explicit collection name for consistency: 'users'
    return model<IUser>( 'User', schema, 'users' );
  }
}

/* ============================================================================
 * MODEL EXPORT
 * ==========================================================================*/

export const UserModel: Model<IUser> = UserModelBuilder.getModel();
