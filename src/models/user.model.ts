// Path: src/models/user.model.ts
// ─────────────────────────────────────────────────────────────────────────────
// PURPOSE:
//   Enterprise-grade User model (types + DB schema) designed for large org +
//   future WhatsApp/Facebook-like features WITHOUT polluting the User document.
//
// KEY DESIGN (IMPORTANT):
//   ✅ User model stores ONLY:
//      - Identity + security + preferences
//      - Access control (RBAC) as STRING KEYS (moduleKey + actionKey[])
//      - Social graph pointers (contacts/following/followers/pins) as ID strings
//      - Chat pointers (rooms membership, pinned rooms, pinned messages refs)
//      - Blog pointers (saved posts refs, creator flags) as ID strings
//
//   ❌ User model does NOT store:
//      - Messages, posts, comments, reactions, receipts (must be in dedicated collections)
//      - Group definitions (must be in ChatRoom / Group collection)
//      - Heavy arrays that grow unbounded (must be paged from their own collections)
//
// WHY:
//   WhatsApp/Facebook-scale operations require separate collections with indexes,
//   otherwise the User document becomes a hot-spot and will blow MongoDB limits.
//
// RULES:
//   ✅ Class-based builders only (no loose helper functions)
//   ✅ Hot-reload safe model registration (no OverwriteModelError)
//   ✅ Sensitive fields always removed via projection + toJSON + toSafeDTO
//   ✅ Keep "public/..." paths as relative for Electron compatibility
//
// ACCESS MAP NOTE:
//   You imported AccessActionOption / AccessModuleOption for UI rendering.
//   Those are UI option structures, NOT what you store in the DB.
//   In the DB you MUST store only the KEYS:
//     - module: AccessModuleKey (string)
//     - actions: AccessActionKey[] (string ids)
// ─────────────────────────────────────────────────────────────────────────────

import {
  Schema,
  model,
  models,
  type Document,
  type Model,
} from "mongoose";

import type { Address } from "./property.model";

// Import ONLY TYPES (no runtime circular deps).
import type {
  AccessActionKey,
  AccessModuleKey,
} from "../source/access-map.source";

/* ========================================================================== *
 * SYSTEM ROLES
 * ========================================================================== */

export type Role =
  | "executive"
  | "board"
  | "director"
  | "ceo"
  | "cfo"
  | "coo"
  | "cto"
  | "cio"
  | "admin"
  | "system"
  | "user"
  | "owner"
  | "tenant"
  | "agent"
  | "broker"
  | "landlord"
  | "leasing"
  | "leasing_manager"
  | "property_manager"
  | "facility_manager"
  | "estate_manager"
  | "operator"
  | "manager"
  | "lead"
  | "supervisor"
  | "captain"
  | "member"
  | "observer"
  | "finance"
  | "accountant"
  | "accounts_payable"
  | "accounts_receivable"
  | "billing"
  | "payroll"
  | "procurement"
  | "legal"
  | "compliance"
  | "auditor"
  | "hr"
  | "reception"
  | "customer_support"
  | "call_center"
  | "developer"
  | "qa"
  | "devops"
  | "it_support"
  | "data_analyst"
  | "mechanic"
  | "carpenter"
  | "electrician"
  | "plumber"
  | "technician"
  | "welder"
  | "driver"
  | "cleaner"
  | "security"
  | "gardener"
  | "painter"
  | "mason"
  | "helper"
  | "inspector"
  | "surveyor"
  | "visitor"
  ;

export const DEFAULT_ROLES: Role[] = [
  "executive",
  "board",
  "director",
  "ceo",
  "cfo",
  "coo",
  "cto",
  "cio",
  "admin",
  "system",
  "user",
  "owner",
  "tenant",
  "agent",
  "broker",
  "landlord",
  "leasing",
  "leasing_manager",
  "property_manager",
  "facility_manager",
  "estate_manager",
  "operator",
  "manager",
  "lead",
  "supervisor",
  "captain",
  "member",
  "observer",
  "finance",
  "accountant",
  "accounts_payable",
  "accounts_receivable",
  "billing",
  "payroll",
  "procurement",
  "legal",
  "compliance",
  "auditor",
  "hr",
  "reception",
  "customer_support",
  "call_center",
  "developer",
  "qa",
  "devops",
  "it_support",
  "data_analyst",
  "mechanic",
  "carpenter",
  "electrician",
  "plumber",
  "technician",
  "welder",
  "driver",
  "cleaner",
  "security",
  "gardener",
  "painter",
  "mason",
  "helper",
  "inspector",
  "surveyor",
  "visitor",
];

/* ========================================================================== *
 * ACCESS CONTROL (DB STORES KEYS ONLY)
 * ========================================================================== */

/**
 * Single permission entry stored under user.access.permissions
 *
 * module  : AccessModuleKey  (string)
 * actions : AccessActionKey[] (string action ids)
 */
export interface PermissionEntry {
  module: AccessModuleKey;
  actions: AccessActionKey[];
}

/**
 * User-level access object.
 * - role is duplicated here intentionally so you can build "role templates"
 *   and still allow per-user overrides.
 * - services must ensure access.role == user.role (or decide to allow override).
 */
export interface RoleAccessMap {
  role: Role;
  permissions: PermissionEntry[];
}

/* ========================================================================== *
 * COUNTRY / PHONE
 * ========================================================================== */

export interface CountryCodes {
  name: string;
  code: string;
  flags: {
    png: string;
    svg: string;
    alt?: string;
  };
}

export interface PhoneNumber {
  code: CountryCodes;
  number: string;
}

/* ========================================================================== *
 * SECURITY / PREFERENCES / META
 * ========================================================================== */

export interface UserLoginMetadata {
  failedLoginAttempts: number;
  lastLoginAt?: Date | null;
  lastFailedLoginAt?: Date | null;
  lockedUntil?: Date | null;

  // Extra audit signals (safe to store)
  lastUserAgent?: string | null;
  lastDeviceId?: string | null;
  lastLocationHint?: string | null; // e.g. "Colombo, LK" (NOT precise GPS)
}

export type UiTheme = "light" | "dark" | "system";

export interface UserPreferences {
  theme: UiTheme;
  language: string;
  timeZone?: string | null;
  dateFormat?: string | null;

  // WhatsApp-like UX
  autoDownloadMedia?: boolean;
  enterToSend?: boolean;

  // Privacy visibility (per-user defaults; rooms can override)
  lastSeenVisibility?: "everyone" | "contacts" | "nobody";
  profilePhotoVisibility?: "everyone" | "contacts" | "nobody";
  aboutVisibility?: "everyone" | "contacts" | "nobody";
  readReceiptsEnabled?: boolean;
}

export interface UserNotificationPreferences {
  email: boolean;
  inApp: boolean;
  push?: boolean;
}

/* ========================================================================== *
 * PAYMENTS – USER-LEVEL PAYMENT PROFILE (refs only)
 * ========================================================================== */

export type PaymentCustomerProvider =
  | "stripe"
  | "paypal"
  | "adyen"
  | "braintree"
  | "custom";

export interface UserPaymentProfile {
  provider: PaymentCustomerProvider;
  customerId: string;
  defaultCurrency: string; // "LKR", "USD", ...
  billingEmail?: string | null;

  defaultPaymentMethodRef?: string | null;
  paymentMethodRefs: string[];
}

export interface WalletBalance {
  currency: string;
  available: number;
  pending: number;
  updatedAt?: Date | null;
}

export interface UserWallet {
  enabled: boolean;
  balances: WalletBalance[];
}

/* ========================================================================== *
 * CHAT / SOCIAL – USER COMMUNICATION + GRAPH POINTERS
 * ========================================================================== */

/**
 * Multi-device sessions (NO tokens/keys stored here).
 * Tokens belong in Redis / session store / separate security collection.
 */
export type DevicePlatform = "web" | "desktop" | "android" | "ios" | "other";

export interface UserDevice {
  deviceId: string;              // "x-device-id"
  name: string;                  // "Buddhika Desktop"
  platform: DevicePlatform;
  appVersion?: string | null;

  lastSeenAt?: Date | null;
  lastIp?: string | null;
  revokedAt?: Date | null;
}

/**
 * Chat room membership pointer (source of truth is ChatRoom collection).
 * This is a "quick access list" for UI and routing.
 */
export type RoomRole = "owner" | "admin" | "member" | "viewer";

export interface UserRoomMembership {
  roomId: string;               // ChatRoom id (string form)
  role: RoomRole;

  mutedUntil?: Date | null;
  pinned: boolean;
  archived: boolean;

  nickname?: string | null;
  lastReadAt?: Date | null;     // used for unread calculations in services
}

/**
 * Pinned message pointers (WhatsApp-like).
 * Actual message content lives in Message collection.
 */
export interface UserPinnedMessage {
  roomId: string;
  messageId: string;            // Message id
  pinnedAt?: Date | null;
}

/**
 * Social / graph pointers:
 * - contacts: like WhatsApp contacts (mutual or one-way depending on your rules)
 * - following/followers: like Facebook/Instagram graph (blog/public profile)
 * - pinnedUsers: "pin another user" (quick access)
 */
export interface UserSocialGraph {
  contactUserIds: string[];
  followingUserIds: string[];
  followerUserIds: string[];
  pinnedUserIds: string[];
}

/**
 * Privacy / safety:
 * - blockedUserIds: hard block
 * - allow* rules: default gating for new chats/groups/calls
 */
export interface UserPrivacy {
  blockedUserIds: string[];
  allowMessagesFrom: "everyone" | "contacts" | "nobody";
  allowCallsFrom: "everyone" | "contacts" | "nobody";
  allowGroupAddsFrom: "everyone" | "contacts" | "nobody";
}

/**
 * Presence snapshot. Real-time presence is usually computed in Redis/WS.
 */
export type PresenceState = "online" | "offline" | "away" | "dnd";

export interface UserPresence {
  state: PresenceState;
  lastActiveAt?: Date | null;
}

/**
 * Public profile / blog author identity.
 * Posts themselves belong in Post collection.
 */
export interface UserSocialProfile {
  handle: string;               // "@buddhika"
  displayName: string;
  about?: string | null;
  avatarUrl?: string | null;    // "public/...."
  coverUrl?: string | null;

  isCreator: boolean;           // can publish blogs/feeds
  isPublicProfile: boolean;
}

/**
 * Saved content pointers:
 * - savedPostIds: like Facebook "Saved"
 * - pinnedPostIds: creator pin posts to profile (content stored elsewhere)
 */
export interface UserSavedContent {
  savedPostIds: string[];
  pinnedPostIds: string[];
}

/* ========================================================================== *
 * MAIN USER DOCUMENT
 * ========================================================================== */

export interface IUser extends Document {
  // Core identity
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
  nicOrPassport: string;

  // Org role + access
  role: Role;
  access: RoleAccessMap;

  address: Address;
  isActive: boolean;

  branchId?: string;

  // Verification & OTP (legacy field name kept)
  otpVerifycation: boolean;
  otpToken: string;
  otpTokenExpires?: Date | null;

  emailVerified: boolean;
  emailVerificationToken?: string | null;
  emailVerificationTokenExpires?: Date | null;

  // MFA
  multiAuthEnabled: boolean;
  multiAuthActivatedAt?: Date | null;
  multiAuthSecret?: string | null;

  // Reset
  resetToken?: string | null;
  resetTokenExpiresAt?: Date | null;

  // Admin metadata
  autoDelete: boolean;
  creator: string;
  updator?: string;

  // Preferences + notifications + security meta
  loginMeta: UserLoginMetadata;
  preferences: UserPreferences;
  notificationPreferences: UserNotificationPreferences;

  // Payments (refs only)
  paymentProfile: UserPaymentProfile;
  wallet: UserWallet;

  // WhatsApp/Facebook-like pointers
  devices: UserDevice[];
  rooms: UserRoomMembership[];
  pinnedMessages: UserPinnedMessage[];

  socialGraph: UserSocialGraph;
  privacy: UserPrivacy;
  presence: UserPresence;

  socialProfile: UserSocialProfile;
  savedContent: UserSavedContent;

  createdAt: Date;
  updatedAt: Date;

  toSafeDTO(): User;
}

/**
 * Safe DTO for API (no secrets).
 * (You can move this into contracts later; for now it keeps your current style.)
 */
export interface User extends Omit<
  IUser,
  | "password"
  | "resetToken"
  | "resetTokenExpiresAt"
  | "otpToken"
  | "otpTokenExpires"
  | "emailVerificationToken"
  | "emailVerificationTokenExpires"
  | "multiAuthSecret"
  | "toSafeDTO"
  | keyof Document
> {}

export const USER_MODEL_PROJECTION = {
  password: 0,

  resetToken: 0,
  resetTokenExpiresAt: 0,

  otpToken: 0,
  otpTokenExpires: 0,

  emailVerificationToken: 0,
  emailVerificationTokenExpires: 0,

  multiAuthSecret: 0,

  __v: 0,
};

/* ========================================================================== *
 * SUB-SCHEMA BUILDERS (STATIC-ONLY)
 * ========================================================================== */

export class AddressSubSchemaBuilder {
  private constructor () {}

  public static buildSchema(): Schema<Address> {
    // NOTE:
    // If your Address type is already defined elsewhere with different fields,
    // align these keys exactly. This is a safe baseline.
    return new Schema<Address>(
      {
        street: { type: String, required: true, trim: true, default: "" },
        houseNumber: { type: String, required: true, trim: true, default: "" },
        city: { type: String, required: true, trim: true, default: "" },
        postcode: { type: String, required: true, trim: true, default: "" },

        country: { type: String, required: false, trim: true, default: "" },
        stateOrProvince: { type: String, required: false, trim: true, default: "" },
      } as Record<string, any>,
      { _id: false }
    );
  }
}

export class FlagsSubSchemaBuilder {
  private constructor () {}

  public static buildSchema(): Schema<{ png: string; svg: string; alt?: string; }> {
    return new Schema<{ png: string; svg: string; alt?: string; }>(
      {
        png: { type: String, required: true, default: "" },
        svg: { type: String, required: true, default: "" },
        alt: { type: String, required: false, default: "" },
      },
      { _id: false }
    );
  }
}

export class CountryCodeSubSchemaBuilder {
  private constructor () {}

  public static buildSchema(): Schema<CountryCodes> {
    return new Schema<CountryCodes>(
      {
        name: { type: String, required: true, default: "", trim: true },
        code: { type: String, required: true, default: "", trim: true },
        flags: { type: FlagsSubSchemaBuilder.buildSchema(), required: true },
      },
      { _id: false }
    );
  }
}

export class PhoneNumberSubSchemaBuilder {
  private constructor () {}

  public static buildSchema(): Schema<PhoneNumber> {
    return new Schema<PhoneNumber>(
      {
        code: { type: CountryCodeSubSchemaBuilder.buildSchema(), required: true },
        number: { type: String, required: true, default: "", trim: true },
      },
      { _id: false }
    );
  }
}

export class PermissionEntrySubSchemaBuilder {
  private constructor () {}

  public static buildSchema(): Schema<PermissionEntry> {
    // IMPORTANT:
    // module + actions must be stored as strings (keys), not UI objects.
    return new Schema<PermissionEntry>(
      {
        module: { type: String, required: true, trim: true },
        actions: { type: [ String ], required: true, default: [] },
      },
      { _id: false }
    );
  }
}

export class AccessSubSchemaBuilder {
  private constructor () {}

  public static buildSchema(): Schema<RoleAccessMap> {
    return new Schema<RoleAccessMap>(
      {
        role: { type: String, required: true, trim: true },
        permissions: {
          type: [ PermissionEntrySubSchemaBuilder.buildSchema() ],
          required: true,
          default: [],
        },
      },
      { _id: false }
    );
  }
}

export class LoginMetaSubSchemaBuilder {
  private constructor () {}

  public static buildSchema(): Schema<UserLoginMetadata> {
    return new Schema<UserLoginMetadata>(
      {
        failedLoginAttempts: { type: Number, required: true, default: 0, min: 0 },
        lastLoginAt: { type: Date, required: false, default: null },
        lastFailedLoginAt: { type: Date, required: false, default: null },
        lockedUntil: { type: Date, required: false, default: null },

        lastUserAgent: { type: String, required: false, default: null, trim: true },
        lastDeviceId: { type: String, required: false, default: null, trim: true },
        lastLocationHint: { type: String, required: false, default: null, trim: true },
      },
      { _id: false }
    );
  }
}

export class NotificationPreferencesSubSchemaBuilder {
  private constructor () {}

  public static buildSchema(): Schema<UserNotificationPreferences> {
    return new Schema<UserNotificationPreferences>(
      {
        email: { type: Boolean, required: true, default: true },
        inApp: { type: Boolean, required: true, default: true },
        push: { type: Boolean, required: false, default: true },
      },
      { _id: false }
    );
  }
}

export class PreferencesSubSchemaBuilder {
  private constructor () {}

  public static buildSchema(): Schema<UserPreferences> {
    return new Schema<UserPreferences>(
      {
        theme: {
          type: String,
          enum: [ "light", "dark", "system" ],
          required: true,
          default: "system",
        },
        language: { type: String, required: true, default: "en", trim: true },
        timeZone: { type: String, required: false, default: null, trim: true },
        dateFormat: { type: String, required: false, default: null, trim: true },

        autoDownloadMedia: { type: Boolean, required: false, default: true },
        enterToSend: { type: Boolean, required: false, default: true },

        lastSeenVisibility: { type: String, required: false, default: "everyone" },
        profilePhotoVisibility: { type: String, required: false, default: "everyone" },
        aboutVisibility: { type: String, required: false, default: "everyone" },

        readReceiptsEnabled: { type: Boolean, required: false, default: true },
      },
      { _id: false }
    );
  }
}

export class WalletBalanceSubSchemaBuilder {
  private constructor () {}

  public static buildSchema(): Schema<WalletBalance> {
    return new Schema<WalletBalance>(
      {
        currency: { type: String, required: true, trim: true, default: "LKR" },
        available: { type: Number, required: true, default: 0, min: 0 },
        pending: { type: Number, required: true, default: 0, min: 0 },
        updatedAt: { type: Date, required: false, default: null },
      },
      { _id: false }
    );
  }
}

export class WalletSubSchemaBuilder {
  private constructor () {}

  public static buildSchema(): Schema<UserWallet> {
    return new Schema<UserWallet>(
      {
        enabled: { type: Boolean, required: true, default: false },
        balances: { type: [ WalletBalanceSubSchemaBuilder.buildSchema() ], required: true, default: [] },
      },
      { _id: false }
    );
  }
}

export class PaymentProfileSubSchemaBuilder {
  private constructor () {}

  public static buildSchema(): Schema<UserPaymentProfile> {
    return new Schema<UserPaymentProfile>(
      {
        provider: { type: String, required: true, default: "custom", trim: true },
        customerId: { type: String, required: true, default: "", trim: true },
        defaultCurrency: { type: String, required: true, default: "LKR", trim: true },
        billingEmail: { type: String, required: false, default: null, trim: true },

        defaultPaymentMethodRef: { type: String, required: false, default: null, trim: true },
        paymentMethodRefs: { type: [ String ], required: true, default: [] },
      },
      { _id: false }
    );
  }
}

export class UserDeviceSubSchemaBuilder {
  private constructor () {}

  public static buildSchema(): Schema<UserDevice> {
    return new Schema<UserDevice>(
      {
        deviceId: { type: String, required: true, trim: true },
        name: { type: String, required: true, default: "", trim: true },
        platform: { type: String, required: true, default: "other", trim: true },
        appVersion: { type: String, required: false, default: null, trim: true },

        lastSeenAt: { type: Date, required: false, default: null },
        lastIp: { type: String, required: false, default: null, trim: true },
        revokedAt: { type: Date, required: false, default: null },
      },
      { _id: false }
    );
  }
}

export class UserRoomMembershipSubSchemaBuilder {
  private constructor () {}

  public static buildSchema(): Schema<UserRoomMembership> {
    return new Schema<UserRoomMembership>(
      {
        roomId: { type: String, required: true, trim: true },
        role: { type: String, required: true, default: "member", trim: true },

        mutedUntil: { type: Date, required: false, default: null },
        pinned: { type: Boolean, required: true, default: false },
        archived: { type: Boolean, required: true, default: false },

        nickname: { type: String, required: false, default: null, trim: true },
        lastReadAt: { type: Date, required: false, default: null },
      },
      { _id: false }
    );
  }
}

export class UserPinnedMessageSubSchemaBuilder {
  private constructor () {}

  public static buildSchema(): Schema<UserPinnedMessage> {
    return new Schema<UserPinnedMessage>(
      {
        roomId: { type: String, required: true, trim: true },
        messageId: { type: String, required: true, trim: true },
        pinnedAt: { type: Date, required: false, default: null },
      },
      { _id: false }
    );
  }
}

export class UserSocialGraphSubSchemaBuilder {
  private constructor () {}

  public static buildSchema(): Schema<UserSocialGraph> {
    return new Schema<UserSocialGraph>(
      {
        contactUserIds: { type: [ String ], required: true, default: [] },
        followingUserIds: { type: [ String ], required: true, default: [] },
        followerUserIds: { type: [ String ], required: true, default: [] },
        pinnedUserIds: { type: [ String ], required: true, default: [] },
      },
      { _id: false }
    );
  }
}

export class UserPrivacySubSchemaBuilder {
  private constructor () {}

  public static buildSchema(): Schema<UserPrivacy> {
    return new Schema<UserPrivacy>(
      {
        blockedUserIds: { type: [ String ], required: true, default: [] },
        allowMessagesFrom: { type: String, required: true, default: "everyone", trim: true },
        allowCallsFrom: { type: String, required: true, default: "everyone", trim: true },
        allowGroupAddsFrom: { type: String, required: true, default: "everyone", trim: true },
      },
      { _id: false }
    );
  }
}

export class UserPresenceSubSchemaBuilder {
  private constructor () {}

  public static buildSchema(): Schema<UserPresence> {
    return new Schema<UserPresence>(
      {
        state: { type: String, required: true, default: "offline", trim: true },
        lastActiveAt: { type: Date, required: false, default: null },
      },
      { _id: false }
    );
  }
}

export class UserSocialProfileSubSchemaBuilder {
  private constructor () {}

  public static buildSchema(): Schema<UserSocialProfile> {
    return new Schema<UserSocialProfile>(
      {
        handle: { type: String, required: true, default: "", trim: true },
        displayName: { type: String, required: true, default: "", trim: true },
        about: { type: String, required: false, default: null, trim: true },

        avatarUrl: { type: String, required: false, default: null, trim: true },
        coverUrl: { type: String, required: false, default: null, trim: true },

        isCreator: { type: Boolean, required: true, default: false },
        isPublicProfile: { type: Boolean, required: true, default: true },
      },
      { _id: false }
    );
  }
}

export class UserSavedContentSubSchemaBuilder {
  private constructor () {}

  public static buildSchema(): Schema<UserSavedContent> {
    return new Schema<UserSavedContent>(
      {
        savedPostIds: { type: [ String ], required: true, default: [] },
        pinnedPostIds: { type: [ String ], required: true, default: [] },
      },
      { _id: false }
    );
  }
}

/* ========================================================================== *
 * USER MODEL BUILDER
 * ========================================================================== */

export class UserModelBuilder {
  private constructor () {}

  public static buildSchema(): Schema<IUser> {
    const addressSchema = AddressSubSchemaBuilder.buildSchema();
    const accessSchema = AccessSubSchemaBuilder.buildSchema();
    const phoneNumberSchema = PhoneNumberSubSchemaBuilder.buildSchema();

    const loginMetaSchema = LoginMetaSubSchemaBuilder.buildSchema();
    const preferencesSchema = PreferencesSubSchemaBuilder.buildSchema();
    const notificationPrefsSchema = NotificationPreferencesSubSchemaBuilder.buildSchema();

    const paymentProfileSchema = PaymentProfileSubSchemaBuilder.buildSchema();
    const walletSchema = WalletSubSchemaBuilder.buildSchema();

    const deviceSchema = UserDeviceSubSchemaBuilder.buildSchema();
    const roomMembershipSchema = UserRoomMembershipSubSchemaBuilder.buildSchema();
    const pinnedMessageSchema = UserPinnedMessageSubSchemaBuilder.buildSchema();

    const socialGraphSchema = UserSocialGraphSubSchemaBuilder.buildSchema();
    const privacySchema = UserPrivacySubSchemaBuilder.buildSchema();
    const presenceSchema = UserPresenceSubSchemaBuilder.buildSchema();
    const socialProfileSchema = UserSocialProfileSubSchemaBuilder.buildSchema();
    const savedContentSchema = UserSavedContentSubSchemaBuilder.buildSchema();

    const userSchema = new Schema<IUser>(
      {
        // ── Identity
        name: { type: String, required: true, trim: true },
        username: { type: String, required: true, unique: true, trim: true, index: true },
        email: { type: String, required: true, unique: true, trim: true, index: true },
        password: { type: String, required: true },

        dateOfBirth: { type: Date, required: true },
        age: { type: Number, required: true, min: 0 },
        gender: { type: String, required: true, trim: true },

        image: { type: String, required: false, trim: true },
        phoneNumber: { type: phoneNumberSchema, required: false },

        bio: { type: String, required: true, default: "", trim: true },
        nationality: { type: String, required: true, default: "", trim: true },
        nicOrPassport: { type: String, required: true, default: "", trim: true },

        // ── Org Role & Access
        role: { type: String, enum: DEFAULT_ROLES, required: true, index: true },
        access: {
          type: accessSchema,
          required: true,
          default: (): RoleAccessMap => ( {
            role: "user",
            permissions: [],
          } ),
        },

        address: { type: addressSchema, required: true },
        isActive: { type: Boolean, required: true, default: true, index: true },

        branchId: { type: String, required: false, trim: true, default: null },

        // ── OTP / email verification (legacy kept)
        otpVerifycation: { type: Boolean, required: true, default: false },
        otpToken: { type: String, required: true, default: "" },
        otpTokenExpires: { type: Date, required: false, default: null },

        emailVerified: { type: Boolean, required: true, default: false, index: true },
        emailVerificationToken: { type: String, required: false, default: null },
        emailVerificationTokenExpires: { type: Date, required: false, default: null },

        // ── MFA (secret must never be exposed)
        multiAuthEnabled: { type: Boolean, required: true, default: false },
        multiAuthActivatedAt: { type: Date, required: false, default: null },
        multiAuthSecret: { type: String, required: false, default: null },

        // ── Reset
        resetToken: { type: String, required: false, default: null, trim: true },
        resetTokenExpiresAt: { type: Date, required: false, default: null },

        // ── Admin meta
        autoDelete: { type: Boolean, required: true, default: true },
        creator: { type: String, required: true, trim: true },
        updator: { type: String, required: false, trim: true },

        // ── Security + preferences
        loginMeta: {
          type: loginMetaSchema,
          required: true,
          default: (): UserLoginMetadata => ( {
            failedLoginAttempts: 0,
            lastLoginAt: null,
            lastFailedLoginAt: null,
            lockedUntil: null,
            lastUserAgent: null,
            lastDeviceId: null,
            lastLocationHint: null,
          } ),
        },
        preferences: {
          type: preferencesSchema,
          required: true,
          default: (): UserPreferences => ( {
            theme: "system",
            language: "en",
            timeZone: null,
            dateFormat: null,
            autoDownloadMedia: true,
            enterToSend: true,
            lastSeenVisibility: "everyone",
            profilePhotoVisibility: "everyone",
            aboutVisibility: "everyone",
            readReceiptsEnabled: true,
          } ),
        },
        notificationPreferences: {
          type: notificationPrefsSchema,
          required: true,
          default: (): UserNotificationPreferences => ( {
            email: true,
            inApp: true,
            push: true,
          } ),
        },

        // ── Payments
        paymentProfile: {
          type: paymentProfileSchema,
          required: true,
          default: (): UserPaymentProfile => ( {
            provider: "custom",
            customerId: "",
            defaultCurrency: "LKR",
            billingEmail: null,
            defaultPaymentMethodRef: null,
            paymentMethodRefs: [],
          } ),
        },
        wallet: {
          type: walletSchema,
          required: true,
          default: (): UserWallet => ( {
            enabled: false,
            balances: [],
          } ),
        },

        // ── WhatsApp / social pointers
        devices: { type: [ deviceSchema ], required: true, default: [] },
        rooms: { type: [ roomMembershipSchema ], required: true, default: [] },
        pinnedMessages: { type: [ pinnedMessageSchema ], required: true, default: [] },

        socialGraph: {
          type: socialGraphSchema,
          required: true,
          default: (): UserSocialGraph => ( {
            contactUserIds: [],
            followingUserIds: [],
            followerUserIds: [],
            pinnedUserIds: [],
          } ),
        },
        privacy: {
          type: privacySchema,
          required: true,
          default: (): UserPrivacy => ( {
            blockedUserIds: [],
            allowMessagesFrom: "everyone",
            allowCallsFrom: "everyone",
            allowGroupAddsFrom: "everyone",
          } ),
        },
        presence: {
          type: presenceSchema,
          required: true,
          default: (): UserPresence => ( {
            state: "offline",
            lastActiveAt: null,
          } ),
        },

        socialProfile: {
          type: socialProfileSchema,
          required: true,
          default: (): UserSocialProfile => ( {
            handle: "",
            displayName: "",
            about: null,
            avatarUrl: null,
            coverUrl: null,
            isCreator: false,
            isPublicProfile: true,
          } ),
        },
        savedContent: {
          type: savedContentSchema,
          required: true,
          default: (): UserSavedContent => ( {
            savedPostIds: [],
            pinnedPostIds: [],
          } ),
        },
      },
      {
        timestamps: true,
        versionKey: false,
        minimize: true,
      }
    );

    /* ====================================================================== *
     * INDEXES (scale-ready)
     * ====================================================================== */

    // Directory search (admin/user picker/chat invite)
    userSchema.index( {
      name: "text",
      email: "text",
      username: "text",
      "socialProfile.handle": "text",
      "socialProfile.displayName": "text",
    } );

    // Common filtering
    userSchema.index( { role: 1, isActive: 1 } );

    // Fast handle lookup (public profile)
    userSchema.index( { "socialProfile.handle": 1 } );

    // Device lookup (multi-device security)
    userSchema.index( { "devices.deviceId": 1 } );

    // Room membership quick checks
    userSchema.index( { "rooms.roomId": 1 } );

    // Social graph lookups
    userSchema.index( { "socialGraph.contactUserIds": 1 } );
    userSchema.index( { "socialGraph.followingUserIds": 1 } );

    /* ====================================================================== *
     * OUTPUT SANITIZATION
     * ====================================================================== */

    userSchema.set( "toJSON", {
      transform: ( _doc, ret: any ) => {
        const out = ret as Record<string, unknown>;

        delete out.password;

        delete out.resetToken;
        delete out.resetTokenExpiresAt;

        delete out.otpToken;
        delete out.otpTokenExpires;

        delete out.emailVerificationToken;
        delete out.emailVerificationTokenExpires;

        delete out.multiAuthSecret;

        delete out.__v;

        return out;
      },
    } );

    userSchema.method( "toSafeDTO", function toSafeDTO( this: IUser ): User {
      const raw = this.toObject( { getters: false, virtuals: false } ) as Record<string, unknown>;

      delete raw.password;

      delete raw.resetToken;
      delete raw.resetTokenExpiresAt;

      delete raw.otpToken;
      delete raw.otpTokenExpires;

      delete raw.emailVerificationToken;
      delete raw.emailVerificationTokenExpires;

      delete raw.multiAuthSecret;

      delete raw.__v;

      return raw as User;
    } );

    return userSchema;
  }

  public static getModel(): Model<IUser> {
    if ( models.User ) {
      return models.User as Model<IUser>;
    }

    const schema = this.buildSchema();
    return model<IUser>( "User", schema, "users" );
  }
}

/* ========================================================================== *
 * MODEL EXPORT
 * ========================================================================== */

export const UserModel: Model<IUser> = UserModelBuilder.getModel();
