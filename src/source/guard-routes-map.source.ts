// Path: src/source/guard-routes-map.source.ts
// ============================================================================
// Guard Routes Map Source (API Guard Source of Truth) — MATCHES NEW ACCESS MAP
// ----------------------------------------------------------------------------
// ✅ Aligns with src/source/access-map.source.ts (latest)
// ✅ Every GuardRouteDefinition.module/action is valid AccessModuleKey/AccessActionKey
// ✅ Regex patterns are query-safe (match "/path" and "/path?x=y")
// ✅ Includes TeamTasks, WorkItems, WorkEvents, MemberActivities, Milestones, Comments,
//    Notifications, RecycleBin, Leases, Properties, Tenants, Tracking/Audit, Places, FileTransfer
//
// IMPORTANT:
// - Some legacy routers do not have a dedicated module in the access map (e.g. FileTransfer).
//   Those are mapped to the closest business module (TenantManagement / PropertyManagement).
// - If you later add a dedicated module, only change the module/action mapping here.
//
// RULE YOU REQUESTED:
// ✅ Every action MUST have description (description is REQUIRED, not optional).
// ============================================================================

import type { Request } from "express";
import type { PermissionEntry } from "../models/user.model";
import type { Role } from "../types/roles";

import type { AccessActionKey, AccessModuleKey } from "./access-map.source";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "ANY";

export interface GuardRouteDefinition {
  id: string;
  method: HttpMethod;
  pattern: RegExp;
  module: AccessModuleKey;
  action: AccessActionKey;

  /** REQUIRED: human-readable reason for this permission mapping */
  description: string;
}

export interface GuardedUser {
  userId: string;
  username: string;
  name: string;
  image: string | null;
  role: Role;
  permissions?: PermissionEntry[];
}

export type GuardedRequest = Request & { user?: GuardedUser; };

// ─────────────────────────────────────────────────────────────────────────────
// Global Express.Request augmentation
// ─────────────────────────────────────────────────────────────────────────────
declare global {
  namespace Express {
    interface Request {
      user?: GuardedUser;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Class wrapper (pattern builder)
// ─────────────────────────────────────────────────────────────────────────────
class GuardRoutesMapSource {
  public static withOptionalQuery( base: RegExp ): RegExp {
    const src = base.source;
    if ( src.includes( "\\?" ) ) return base;

    const rebuilt = src.endsWith( "$" )
      ? src.slice( 0, -1 ) + "(?:\\?.*)?$"
      : src + "(?:\\?.*)?$";

    return new RegExp( rebuilt );
  }

  public static p( rx: RegExp ): RegExp {
    return GuardRoutesMapSource.withOptionalQuery( rx );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public endpoints (bypass guard)
// ─────────────────────────────────────────────────────────────────────────────

export interface PublicEndpoint {
  method: HttpMethod;
  pattern: RegExp;
  reason: string;
}

export const PUBLIC_ENDPOINTS: ReadonlyArray<PublicEndpoint> = [
  // =========================================================================
  // AUTH & MFA
  // =========================================================================
  {
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api\/auth\/login$/ ),
    reason: "AuthController login",
  },
  {
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api\/auth\/logout$/ ),
    reason: "AuthController logout",
  },
  {
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api\/auth\/regenerate-challenge$/ ),
    reason: "Regenerate login challenge",
  },
  {
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api\/auth\/ws-token\/rotate\/[^/]+$/ ),
    reason: "Rotate WS token during auth flow",
  },

  // MFA
  {
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api\/mfa\/initiate$/ ),
    reason: "MFA initiate",
  },
  {
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api\/mfa\/confirm$/ ),
    reason: "MFA confirm",
  },
  {
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api\/mfa\/activate$/ ),
    reason: "MFA activate",
  },
  {
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api\/mfa\/initial-verify$/ ),
    reason: "MFA initial verify",
  },
  {
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api\/mfa\/user-verify$/ ),
    reason: "MFA user verify",
  },
  {
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api\/mfa\/status\/[^/]+$/ ),
    reason: "MFA status",
  },
  {
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api\/mfa\/deactive\/[^/]+$/ ),
    reason: "MFA deactive",
  },

  // =========================================================================
  // SHARED LOGIN ENTRYPOINT (mounted under /api-user)
  // =========================================================================
  {
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-user\/verify-user$/ ),
    reason: "Shared login entry route (UserRoute.verify-user)",
  },

  // =========================================================================
  // VALIDATOR (mounted as /api-validator)
  // =========================================================================
  {
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-validator\/email-validator\/.+$/ ),
    reason: "Public email validation",
  },

  // =========================================================================
  // SECURITY INCIDENT REPORTING (public intake)
  // =========================================================================
  {
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-report\/security$/ ),
    reason: "Security incident reporting from FE",
  },

  // =========================================================================
  // COMMENTS ENGINE (Public READ endpoints)
  // =========================================================================
  {
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-comments\/load$/ ),
    reason: "Public read: load",
  },
  {
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-comments\/load-advanced$/ ),
    reason: "Public read: load-advanced",
  },
  {
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-comments\/count-advanced$/ ),
    reason: "Public read: count-advanced",
  },
  {
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-comments\/count-load$/ ),
    reason: "Public read: count-load",
  },
  {
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-comments\/get\/[^/]+$/ ),
    reason: "Public read: get by id",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Guarded routes (protected)
// ─────────────────────────────────────────────────────────────────────────────

export const GUARD_ROUTES: ReadonlyArray<GuardRouteDefinition> = [
  // =========================================================================
  // USER MANAGEMENT (/api-user) → AccessMap: UserManagement
  // =========================================================================
  {
    id: "user:list-all",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-user\/users$/ ),
    module: "UserManagement",
    action: "view",
    description: "UserManagement.view → List all users",
  },
  {
    id: "user:count-all",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-user\/users-count$/ ),
    module: "UserManagement",
    action: "view",
    description: "UserManagement.view → Count all users",
  },
  {
    id: "user:list-paged",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-user\/users-with-pagination\/\d+\/\d+$/ ),
    module: "UserManagement",
    action: "view",
    description: "UserManagement.view → List users with pagination",
  },
  {
    id: "user:create",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-user\/create-user$/ ),
    module: "UserManagement",
    action: "create",
    description: "UserManagement.create → Create a new user account",
  },
  {
    id: "user:update",
    method: "PUT",
    pattern: GuardRoutesMapSource.p( /^\/api-user\/user-update\/[^/]+$/ ),
    module: "UserManagement",
    action: "update",
    description: "UserManagement.update → Update an existing user by username",
  },
  {
    id: "user:delete",
    method: "DELETE",
    pattern: GuardRoutesMapSource.p( /^\/api-user\/user-delete\/[^/]+$/ ),
    module: "UserManagement",
    action: "delete",
    description: "UserManagement.delete → Legacy delete route mapped to delete permission",
  },
  {
    id: "user:docs-upload",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-user\/user-document-upload\/[^/]+$/ ),
    module: "UserManagement",
    action: "update",
    description: "UserManagement.update → Upload user documents (profile / ID / etc.)",
  },
  {
    id: "user:docs-list",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-user\/uploads\/[^/]+\/documents$/ ),
    module: "UserManagement",
    action: "view",
    description: "UserManagement.view → List user documents",
  },
  {
    id: "user:get-by-username",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-user\/user-username\/[^/]+$/ ),
    module: "UserManagement",
    action: "view",
    description: "UserManagement.view → Get user by username",
  },
  {
    id: "user:get-by-id",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-user\/user-id\/[^/]+$/ ),
    module: "UserManagement",
    action: "view",
    description: "UserManagement.view → Get user by id",
  },
  {
    id: "user:get-by-email",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-user\/user-email\/[^/]+$/ ),
    module: "UserManagement",
    action: "view",
    description: "UserManagement.view → Get user by email",
  },
  {
    id: "user:get-by-phone",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-user\/user-phone$/ ),
    module: "UserManagement",
    action: "view",
    description: "UserManagement.view → Get user by phone",
  },
  {
    id: "user:email-verify",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-user\/emailverifycation\/[^/]+$/ ),
    module: "UserManagement",
    action: "update",
    description: "UserManagement.update → Verify email (legacy endpoint)",
  },
  {
    id: "user:token-generate",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-user\/generate-token$/ ),
    module: "UserManagement",
    action: "update",
    description: "UserManagement.update → Generate user token (legacy)",
  },
  {
    id: "user:get-by-token",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-user\/user-token\/[^/]+$/ ),
    module: "UserManagement",
    action: "view",
    description: "UserManagement.view → Get user by token",
  },
  {
    id: "user:rich-user-data",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-user\/user-data\/[^/]+$/ ),
    module: "UserManagement",
    action: "view",
    description: "UserManagement.view → Get rich user data bundle",
  },
  {
    id: "user:get-section-key",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-user\/user-section-key\/[^/]+\/[^/]+$/ ),
    module: "UserManagement",
    action: "view",
    description: "UserManagement.view → Resolve a user section key (legacy helper)",
  },

  // =========================================================================
  // NOTIFICATION CENTER (/api-notification) → AccessMap: NotificationCenter
  // =========================================================================
  // =============================================================================
  // Notification Center — Guard Routes (match router paths exactly)
  // Base mount assumed: /api-notification
  // Endpoints (router):
  //   POST /inbox/load
  //   POST /inbox/count
  //   POST /inbox/scope/load
  //   POST /inbox/scope/count
  //   POST /inbox/:inboxId/read
  //   POST /inbox/read-all
  //   POST /inbox/:inboxId/archive
  // =============================================================================

  {
    id: "notify:inbox-load",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-notification\/inbox\/load$/ ),
    module: "NotificationCenter",
    action: "list",
    description: "NotificationCenter.list → Load inbox items (legacy load)",
  },
  {
    id: "notify:inbox-count",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-notification\/inbox\/count$/ ),
    module: "NotificationCenter",
    action: "count",
    description: "NotificationCenter.count → Count inbox items (legacy count)",
  },

  // ✅ NEW: scope-based queries (user | role | company + priorityScope)
  {
    id: "notify:inbox-scope-load",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-notification\/inbox\/scope\/load$/ ),
    module: "NotificationCenter",
    action: "list",
    description: "NotificationCenter.list → Load inbox items by scope",
  },
  {
    id: "notify:inbox-scope-count",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-notification\/inbox\/scope\/count$/ ),
    module: "NotificationCenter",
    action: "count",
    description: "NotificationCenter.count → Count inbox items by scope",
  },

  // Mutations
  {
    id: "notify:mark-read-one",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-notification\/inbox\/[^/]+\/read$/ ),
    module: "NotificationCenter",
    action: "markRead",
    description: "NotificationCenter.markRead → Mark one inbox item as read",
  },
  {
    id: "notify:mark-read-all",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-notification\/inbox\/read-all$/ ),
    module: "NotificationCenter",
    action: "markRead",
    description: "NotificationCenter.markRead → Mark all inbox items as read",
  },
  {
    id: "notify:archive-one",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-notification\/inbox\/[^/]+\/archive$/ ),
    module: "NotificationCenter",
    action: "archive",
    description: "NotificationCenter.archive → Archive one inbox item",
  },

  // =========================================================================
  // AUDIT / TRACKING (/api-tracking) → AccessMap: AuditLogs
  // =========================================================================
  {
    id: "audit:track-login",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-tracking\/track-logged-user-login$/ ),
    module: "AuditLogs",
    action: "create",
    description: "AuditLogs.create → Track logged-user login event",
  },
  {
    id: "audit:logged-user-count",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-tracking\/get-logged-user-tracking-count\/[^/]+$/ ),
    module: "AuditLogs",
    action: "view",
    description: "AuditLogs.view → Count login tracking rows for a user",
  },
  {
    id: "audit:logged-user-list",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-tracking\/get-logged-user-tracking\/[^/]+$/ ),
    module: "AuditLogs",
    action: "view",
    description: "AuditLogs.view → List login tracking rows for a user",
  },
  {
    id: "audit:all-users-counts",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-tracking\/get-all-users-login-counts$/ ),
    module: "AuditLogs",
    action: "filter",
    description: "AuditLogs.filter → Get aggregated login counts across all users",
  },
  {
    id: "audit:file-activity",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-tracking\/user-file-management-activity\/[^/]+\/\d+\/\d+$/ ),
    module: "AuditLogs",
    action: "view",
    description: "AuditLogs.view → Read file management activity (paged)",
  },
  {
    id: "audit:track-activity",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-tracking\/track-activity$/ ),
    module: "AuditLogs",
    action: "create",
    description: "AuditLogs.create → Track generic user activity event",
  },
  {
    id: "audit:activities-by-user",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-tracking\/activities\/[^/]+\/\d+\/\d+$/ ),
    module: "AuditLogs",
    action: "view",
    description: "AuditLogs.view → List recent activities for a user (paged)",
  },
  {
    id: "audit:recent-feed",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-tracking\/recent$/ ),
    module: "AuditLogs",
    action: "view",
    description: "AuditLogs.view → Recent audit feed (system-wide)",
  },

  // =========================================================================
  // FILE TRANSFER (/api-file-transfer) → map to TenantManagement (closest)
  // =========================================================================
  {
    id: "file-transfer:tenant-mobile-upload",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-file-transfer\/get-tenant-mobile-file-upload\/[^/]+$/ ),
    module: "TenantManagement",
    action: "update",
    description: "TenantManagement.update → Issue tenant mobile upload token/endpoint (legacy FileTransfer)",
  },
  {
    id: "file-transfer:get-by-tenant-reason",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-file-transfer\/get-reason-file-uploads-by-tenant-username\/[^/]+$/ ),
    module: "TenantManagement",
    action: "view",
    description: "TenantManagement.view → List file uploads by tenant username + reason (legacy FileTransfer)",
  },
  {
    id: "file-transfer:convert-to-pdf",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-file-transfer\/convert-to-pdf$/ ),
    module: "TenantManagement",
    action: "update",
    description: "TenantManagement.update → Convert uploads to PDF (legacy FileTransfer)",
  },

  // =========================================================================
  // LEASE MANAGEMENT (/api-lease) → AccessMap: LeaseManagement
  // =========================================================================
  {
    id: "lease:register",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-lease\/register\/[^/]+$/ ),
    module: "LeaseManagement",
    action: "create",
    description: "LeaseManagement.create → Register a new lease agreement",
  },
  {
    id: "lease:update-agreement",
    method: "PUT",
    pattern: GuardRoutesMapSource.p( /^\/api-lease\/update-lease-agreement\/[^/]+$/ ),
    module: "LeaseManagement",
    action: "update",
    description: "LeaseManagement.update → Update lease agreement data",
  },
  {
    id: "lease:delete-agreement-doc",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-lease\/delete-lease-document\/[^/]+$/ ),
    module: "LeaseManagement",
    action: "delete",
    description: "LeaseManagement.delete → Delete a lease document (legacy endpoint)",
  },
  {
    id: "lease:preview",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-lease\/preview-lease-agreement\/[^/]+$/ ),
    module: "LeaseManagement",
    action: "view",
    description: "LeaseManagement.view → Preview lease agreement (HTML/PDF preview)",
  },
  {
    id: "lease:agreement-pdf",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-lease\/lease-agreement-pdf\/[^/]+\/[^/]+\/[^/]+$/ ),
    module: "LeaseManagement",
    action: "view",
    description: "LeaseManagement.view → Generate/download lease agreement PDF",
  },
  {
    id: "lease:view-one",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-lease\/lease-agreement\/[^/]+$/ ),
    module: "LeaseManagement",
    action: "view",
    description: "LeaseManagement.view → View a single lease agreement",
  },
  {
    id: "lease:list-by-user",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-lease\/lease-agreements\/[^/]+$/ ),
    module: "LeaseManagement",
    action: "view",
    description: "LeaseManagement.view → List lease agreements by user/tenant identifier",
  },
  {
    id: "lease:update-status",
    method: "PUT",
    pattern: GuardRoutesMapSource.p( /^\/api-lease\/lease-status-updated\/[^/]+$/ ),
    module: "LeaseManagement",
    action: "update",
    description: "LeaseManagement.update → Update lease status/workflow state",
  },
  {
    id: "lease:list-all",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-lease\/all-leases$/ ),
    module: "LeaseManagement",
    action: "view",
    description: "LeaseManagement.view → List all leases (admin/ops)",
  },
  {
    id: "lease:count-all",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-lease\/get-lease-count$/ ),
    module: "LeaseManagement",
    action: "view",
    description: "LeaseManagement.view → Count all leases",
  },
  {
    id: "lease:props-without-lease",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-lease\/get-properties-that-does-not-have-lease$/ ),
    module: "PropertyManagement",
    action: "view",
    description: "PropertyManagement.view → List properties without leases (lease helper query)",
  },
  {
    id: "lease:props-without-lease-count",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-lease\/get-all-properties-count-without-leases$/ ),
    module: "PropertyManagement",
    action: "view",
    description: "PropertyManagement.view → Count properties without leases (lease helper query)",
  },
  {
    id: "lease:get-tenant-by-username",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-lease\/get-tenant-by-username\/[^/]+$/ ),
    module: "UserManagement",
    action: "view",
    description: "UserManagement.view → Resolve tenant user by username (lease flow helper)",
  },

  // =========================================================================
  // PAYMENTS (/api-payments) → AccessMap: PaymentBilling
  // =========================================================================
  {
    // POST /api-payment/create
    id: "payment:create",
    method: "POST",
    pattern: /^\/api-payments\/create(?:\?.*)?$/i,
    module: "PaymentBilling",
    action: "create",
    description: "Create payment + persist invoice snapshot + generate invoice PDF.",
  },
  {
    // GET /api-payment/invoice/:paymentId
    id: "payment:invoice",
    method: "GET",
    pattern: /^\/api-payments\/invoice\/[^\/\?]+(?:\?.*)?$/i,
    module: "PaymentBilling",
    action: "invoice",
    description: "Resolve invoice PDF by paymentId (returns relPath + url).",
  },
  // =========================================================================
  // PLACES (/api-places) → AccessMap: PropertyManagement.view
  // =========================================================================
  {
    id: "places:autocomplete",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-places\/autocomplete$/ ),
    module: "PropertyManagement",
    action: "view",
    description: "PropertyManagement.view → Places autocomplete (address/location helper)",
  },

  // =========================================================================
  // PROPERTY MANAGEMENT (/api-property) → AccessMap: PropertyManagement
  // =========================================================================
  {
    id: "property:create-legacy",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-property\/insert-property\/[^/]+$/ ),
    module: "PropertyManagement",
    action: "create",
    description: "PropertyManagement.create → Create a property (legacy insert endpoint)",
  },
  {
    id: "property:list-paged",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-property\/get-all-properties-with-pagination\/\d+\/\d+\/?$/ ),
    module: "PropertyManagement",
    action: "view",
    description: "PropertyManagement.view → List properties with pagination",
  },
  {
    id: "property:get-one",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-property\/get-single-property-by-id\/[^/]+$/ ),
    module: "PropertyManagement",
    action: "view",
    description: "PropertyManagement.view → Get a single property by id",
  },
  {
    id: "property:get-section",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-property\/get-single-property-section-by-id\/[^/]+$/ ),
    module: "PropertyManagement",
    action: "view",
    description: "PropertyManagement.view → Get a specific property section by id",
  },
  {
    id: "property:delete-legacy",
    method: "DELETE",
    pattern: GuardRoutesMapSource.p( /^\/api-property\/delete-property\/[^/]+\/[^/]+$/ ),
    module: "PropertyManagement",
    action: "delete",
    description: "PropertyManagement.delete → Delete a property (legacy delete endpoint)",
  },
  {
    id: "property:update-legacy",
    method: "PUT",
    pattern: GuardRoutesMapSource.p( /^\/api-property\/update-property\/[^/]+$/ ),
    module: "PropertyManagement",
    action: "update",
    description: "PropertyManagement.update → Update a property (legacy update endpoint)",
  },
  {
    id: "property:list-all",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-property\/get-all-properties\/?$/ ),
    module: "PropertyManagement",
    action: "view",
    description: "PropertyManagement.view → List all properties",
  },
  {
    id: "property:count-all",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-property\/get-all-properties-count\/?$/ ),
    module: "PropertyManagement",
    action: "view",
    description: "PropertyManagement.view → Count all properties",
  },

  // =========================================================================
  // TENANTS (/api-tenant) → AccessMap: TenantManagement
  // =========================================================================
  {
    id: "tenant:create",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-tenant\/insertTenant$/ ),
    module: "TenantManagement",
    action: "create",
    description: "TenantManagement.create → Create a tenant",
  },
  {
    id: "tenant:list-all",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-tenant\/get-all-tenants$/ ),
    module: "TenantManagement",
    action: "view",
    description: "TenantManagement.view → List all tenants",
  },
  {
    id: "tenant:count-all",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-tenant\/get-all-tenants-count$/ ),
    module: "TenantManagement",
    action: "view",
    description: "TenantManagement.view → Count all tenants",
  },
  {
    id: "tenant:list-paged",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-tenant\/get-all-tenants-with-pagination$/ ),
    module: "TenantManagement",
    action: "view",
    description: "TenantManagement.view → List tenants with pagination (legacy)",
  },
  {
    id: "tenant:list-none",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-tenant\/get-all-none-tenants-with-pagination$/ ),
    module: "TenantManagement",
    action: "view",
    description: "TenantManagement.view → List non-tenants with pagination (legacy)",
  },
  {
    id: "tenant:count-none",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-tenant\/get-all-none-tenants-count$/ ),
    module: "TenantManagement",
    action: "view",
    description: "TenantManagement.view → Count non-tenants (legacy)",
  },
  {
    id: "tenant:delete",
    method: "DELETE",
    pattern: GuardRoutesMapSource.p( /^\/api-tenant\/delete-tenant\/[^/]+\/[^/]+$/ ),
    module: "TenantManagement",
    action: "delete",
    description: "TenantManagement.delete → Delete a tenant (legacy delete endpoint)",
  },

  // =========================================================================
  // COMPLAINTS (legacy mounted under /api-tenant/...) → AccessMap: ComplaintsManagement
  // =========================================================================
  {
    id: "complaint:create",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-tenant\/create-complaint$/ ),
    module: "ComplaintsManagement",
    action: "create",
    description: "ComplaintsManagement.create → Create a complaint",
  },
  {
    id: "complaint:get",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-tenant\/complaint\/[^/]+$/ ),
    module: "ComplaintsManagement",
    action: "view",
    description: "ComplaintsManagement.view → Get complaint by id",
  },
  {
    id: "complaint:list-by-tenant",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-tenant\/complaints\/tenant\/[^/]+$/ ),
    module: "ComplaintsManagement",
    action: "view",
    description: "ComplaintsManagement.view → List complaints by tenant",
  },
  {
    id: "complaint:count-by-tenant",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-tenant\/complaints-count\/tenant\/[^/]+$/ ),
    module: "ComplaintsManagement",
    action: "view",
    description: "ComplaintsManagement.view → Count complaints by tenant",
  },
  {
    id: "complaint:list-all",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-tenant\/complaints\/all$/ ),
    module: "ComplaintsManagement",
    action: "view",
    description: "ComplaintsManagement.view → List all complaints",
  },
  {
    id: "complaint:count-all",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-tenant\/complaints-count\/all$/ ),
    module: "ComplaintsManagement",
    action: "view",
    description: "ComplaintsManagement.view → Count all complaints",
  },
  {
    id: "complaint:by-section",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-tenant\/complaints-by-section\/all\/[^/]+$/ ),
    module: "ComplaintsManagement",
    action: "view",
    description: "ComplaintsManagement.view → List complaints by section",
  },
  {
    id: "complaint:post-comments",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-tenant\/complaints\/post-comments$/ ),
    module: "ComplaintsManagement",
    action: "workflow",
    description: "ComplaintsManagement.workflow → Post comments to a complaint thread",
  },
  {
    id: "complaint:list-comments",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-tenant\/complaints\/[^/]+\/comments$/ ),
    module: "ComplaintsManagement",
    action: "view",
    description: "ComplaintsManagement.view → List comments for a complaint",
  },
  {
    id: "complaint:by-status",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-tenant\/complaints\/all\/status\/[^/]+$/ ),
    module: "ComplaintsManagement",
    action: "view",
    description: "ComplaintsManagement.view → List complaints by status",
  },
  {
    id: "complaint:count-by-status",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-tenant\/complaints\/all\/count\/status\/[^/]+$/ ),
    module: "ComplaintsManagement",
    action: "view",
    description: "ComplaintsManagement.view → Count complaints by status",
  },

  // =========================================================================
  // TEAM MANAGEMENT — TEAMS (/api-team-management) → AccessMap: TeamManagement.Teams
  // =========================================================================
  {
    id: "team:create",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/create$/ ),
    module: "TeamManagement.Teams",
    action: "create",
    description: "TeamManagement.Teams.create → Create a team",
  },
  {
    id: "team:get-by-name",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/teamName\/[^/]+$/ ),
    module: "TeamManagement.Teams",
    action: "view",
    description: "TeamManagement.Teams.view → Get team by name",
  },
  {
    id: "team:list-all",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/all$/ ),
    module: "TeamManagement.Teams",
    action: "view",
    description: "TeamManagement.Teams.view → List all teams",
  },
  {
    id: "team:upload-logo",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/upload\/logo\/[^/]+$/ ),
    module: "TeamManagement.Teams",
    action: "update",
    description: "TeamManagement.Teams.update → Upload/update team logo",
  },
  {
    id: "team:stats-total",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/stats\/teams-total$/ ),
    module: "TeamManagement.Teams",
    action: "monitor",
    description: "TeamManagement.Teams.monitor → Total teams stats",
  },
  {
    id: "team:stats-total-domain",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/stats\/teams-total\/domain\/[^/]+$/ ),
    module: "TeamManagement.Teams",
    action: "monitor",
    description: "TeamManagement.Teams.monitor → Total teams stats by domain",
  },
  {
    id: "team:users-no-team",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/users\/no-team$/ ),
    module: "TeamManagement.Teams",
    action: "view",
    description: "TeamManagement.Teams.view → Users with no team",
  },
  {
    id: "team:users-no-team-count",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/users\/no-team\/count$/ ),
    module: "TeamManagement.Teams",
    action: "view",
    description: "TeamManagement.Teams.view → Count users with no team",
  },
  {
    id: "team:users-in-teams",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/users\/in-teams$/ ),
    module: "TeamManagement.Teams",
    action: "view",
    description: "TeamManagement.Teams.view → Users in teams",
  },
  {
    id: "team:users-in-teams-count",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/users\/in-teams\/count$/ ),
    module: "TeamManagement.Teams",
    action: "view",
    description: "TeamManagement.Teams.view → Count users in teams",
  },
  {
    id: "team:users-no-team-domain",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/users\/no-team\/domain\/[^/]+$/ ),
    module: "TeamManagement.Teams",
    action: "view",
    description: "TeamManagement.Teams.view → Users with no team filtered by domain",
  },
  {
    id: "team:users-no-team-domain-count",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/users\/no-team\/domain\/[^/]+\/count$/ ),
    module: "TeamManagement.Teams",
    action: "view",
    description: "TeamManagement.Teams.view → Count users with no team by domain",
  },
  {
    id: "team:users-in-teams-domain",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/users\/in-teams\/domain\/[^/]+$/ ),
    module: "TeamManagement.Teams",
    action: "view",
    description: "TeamManagement.Teams.view → Users in teams filtered by domain",
  },
  {
    id: "team:users-in-teams-domain-count",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/users\/in-teams\/domain\/[^/]+\/count$/ ),
    module: "TeamManagement.Teams",
    action: "view",
    description: "TeamManagement.Teams.view → Count users in teams by domain",
  },
  {
    id: "team:users-all",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/users\/all\/?$/ ),
    module: "TeamManagement.Teams",
    action: "view",
    description: "TeamManagement.Teams.view → List all users (team analytics helper)",
  },
  {
    id: "team:update",
    method: "PATCH",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/update\/[^/]+$/ ),
    module: "TeamManagement.Teams",
    action: "update",
    description: "TeamManagement.Teams.update → Update team by teamCode",
  },
  {
    id: "team:delete",
    method: "DELETE",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/delete\/[^/]+$/ ),
    module: "TeamManagement.Teams",
    action: "delete",
    description: "TeamManagement.Teams.delete → Delete team by teamCode",
  },
  {
    id: "team:get-by-code",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/[^/]+$/ ),
    module: "TeamManagement.Teams",
    action: "view",
    description: "TeamManagement.Teams.view → Get team by teamCode (catch-all, must be last)",
  },

  // =========================================================================
  // TEAM TASKS (/api-team-management/task) → AccessMap: TeamManagement.TeamTasks
  // =========================================================================
  {
    id: "team-task:get",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/task\/get\/[^/]+\/?$/ ),
    module: "TeamManagement.TeamTasks",
    action: "view",
    description: "TeamManagement.TeamTasks.view → Get a task by mongo id",
  },
  {
    id: "team-task:list",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/task\/list\/?$/ ),
    module: "TeamManagement.TeamTasks",
    action: "view",
    description: "TeamManagement.TeamTasks.view → List tasks (advanced filters in body)",
  },
  {
    id: "team-task:count",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/task\/count\/?$/ ),
    module: "TeamManagement.TeamTasks",
    action: "view",
    description: "TeamManagement.TeamTasks.view → Count tasks (advanced filters in body)",
  },
  {
    id: "team-task:key-values",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/task\/key-values\/?$/ ),
    module: "TeamManagement.TeamTasks",
    action: "view",
    description: "TeamManagement.TeamTasks.view → Load key-values for task filters/selects",
  },
  {
    id: "team-task:create",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/task\/create\/?$/ ),
    module: "TeamManagement.TeamTasks",
    action: "create",
    description: "TeamManagement.TeamTasks.create → Create a task",
  },
  {
    id: "team-task:update",
    method: "PATCH",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/task\/update\/[^/]+\/?$/ ),
    module: "TeamManagement.TeamTasks",
    action: "update",
    description: "TeamManagement.TeamTasks.update → Update task fields (general patch)",
  },
  {
    id: "team-task:delete",
    method: "DELETE",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/task\/delete\/[^/]+\/?$/ ),
    module: "TeamManagement.TeamTasks",
    action: "delete",
    description: "TeamManagement.TeamTasks.delete → Delete a task",
  },
  {
    id: "team-task:get-all-for-team",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/task\/get-all-for-team\/[^/]+\/?$/ ),
    module: "TeamManagement.TeamTasks",
    action: "view",
    description: "TeamManagement.TeamTasks.view → Get all tasks for a team",

  },
  {
    id: "team-task:get-count-for-team",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/task\/get-count-for-team\/[^/]+\/?$/ ),
    module: "TeamManagement.TeamTasks",
    action: "view",
    description: "TeamManagement.TeamTasks.view → Get all tasks for a team",

  },
  {
    id: "team-task:evidence-delete",
    method: "DELETE",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/task\/evidence\/[^/]+\/[^/]+\/?$/ ),
    module: "TeamManagement.TeamTasks",
    action: "evidence",
    description: "TeamManagement.TeamTasks.evidence → Remove a task evidence item",
  },
  {
    id: "team-task:status",
    method: "PATCH",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/task\/status\/[^/]+\/?$/ ),
    module: "TeamManagement.TeamTasks",
    action: "workflow",
    description: "TeamManagement.TeamTasks.workflow → Set task status (workflow transition)",
  },
  {
    id: "team-task:priority",
    method: "PATCH",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/task\/priority\/[^/]+\/?$/ ),
    module: "TeamManagement.TeamTasks",
    action: "workflow",
    description: "TeamManagement.TeamTasks.workflow → Set task priority (workflow governance)",
  },
  {
    id: "team-task:labels-set",
    method: "PATCH",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/task\/labels\/set\/[^/]+\/?$/ ),
    module: "TeamManagement.TeamTasks",
    action: "workflow",
    description: "TeamManagement.TeamTasks.workflow → Replace labels list on a task",
  },
  {
    id: "team-task:labels-add",
    method: "PATCH",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/task\/labels\/add\/[^/]+\/?$/ ),
    module: "TeamManagement.TeamTasks",
    action: "workflow",
    description: "TeamManagement.TeamTasks.workflow → Add labels to a task",
  },
  {
    id: "team-task:labels-remove",
    method: "PATCH",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/task\/labels\/remove\/[^/]+\/?$/ ),
    module: "TeamManagement.TeamTasks",
    action: "workflow",
    description: "TeamManagement.TeamTasks.workflow → Remove labels from a task",
  },
  {
    id: "team-task:members-set",
    method: "PATCH",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/task\/members\/set\/[^/]+\/?$/ ),
    module: "TeamManagement.TeamTasks",
    action: "assign",
    description: "TeamManagement.TeamTasks.assign → Replace assigned members on a task",
  },
  {
    id: "team-task:members-add",
    method: "PATCH",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/task\/members\/add\/[^/]+\/?$/ ),
    module: "TeamManagement.TeamTasks",
    action: "assign",
    description: "TeamManagement.TeamTasks.assign → Add assigned members to a task",
  },
  {
    id: "team-task:members-remove",
    method: "PATCH",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/task\/members\/remove\/[^/]+\/?$/ ),
    module: "TeamManagement.TeamTasks",
    action: "assign",
    description: "TeamManagement.TeamTasks.assign → Remove assigned members from a task",
  },
  {
    id: "team-task:captain",
    method: "PATCH",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/task\/captain\/[^/]+\/?$/ ),
    module: "TeamManagement.TeamTasks",
    action: "assign",
    description: "TeamManagement.TeamTasks.assign → Set/replace task captain",
  },
  {
    id: "team-task:location",
    method: "PATCH",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/task\/location\/[^/]+\/?$/ ),
    module: "TeamManagement.TeamTasks",
    action: "update",
    description: "TeamManagement.TeamTasks.update → Update task geo-location fields",
  },
  {
    id: "team-task:address",
    method: "PATCH",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/task\/address\/[^/]+\/?$/ ),
    module: "TeamManagement.TeamTasks",
    action: "update",
    description: "TeamManagement.TeamTasks.update → Update task address fields",
  },
  {
    id: "team-task:notes",
    method: "PATCH",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/task\/notes\/[^/]+\/?$/ ),
    module: "TeamManagement.TeamTasks",
    action: "update",
    description: "TeamManagement.TeamTasks.update → Update task notes content",
  },
  {
    id: "team-task:audit-get",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/task\/audit\/[^/]+\/?$/ ),
    module: "TeamManagement.TeamTasks",
    action: "audit",
    description: "TeamManagement.TeamTasks.audit → Read task audit policy/settings",
  },
  {
    id: "team-task:audit-set",
    method: "PATCH",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/task\/audit\/set\/[^/]+\/?$/ ),
    module: "TeamManagement.TeamTasks",
    action: "audit",
    description: "TeamManagement.TeamTasks.audit → Set task audit policy/settings",
  },
  {
    id: "team-task:audit-patch",
    method: "PATCH",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/task\/audit\/patch\/[^/]+\/?$/ ),
    module: "TeamManagement.TeamTasks",
    action: "audit",
    description: "TeamManagement.TeamTasks.audit → Patch task audit policy/settings",
  },
  {
    id: "team-task:audit-clear",
    method: "PATCH",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/task\/audit\/clear\/[^/]+\/?$/ ),
    module: "TeamManagement.TeamTasks",
    action: "audit",
    description: "TeamManagement.TeamTasks.audit → Clear task audit policy/settings",
  },
  {
    id: "team-task:timing-get",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/task\/timing\/[^/]+\/?$/ ),
    module: "TeamManagement.TeamTasks",
    action: "workflow",
    description: "TeamManagement.TeamTasks.workflow → Read task timing rules/settings",
  },
  {
    id: "team-task:timing-set",
    method: "PATCH",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/task\/timing\/set\/[^/]+\/?$/ ),
    module: "TeamManagement.TeamTasks",
    action: "workflow",
    description: "TeamManagement.TeamTasks.workflow → Set task timing rules/settings",
  },
  {
    id: "team-task:timing-patch",
    method: "PATCH",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/task\/timing\/patch\/[^/]+\/?$/ ),
    module: "TeamManagement.TeamTasks",
    action: "workflow",
    description: "TeamManagement.TeamTasks.workflow → Patch task timing rules/settings",
  },
  {
    id: "team-task:timing-clear",
    method: "PATCH",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/task\/timing\/clear\/[^/]+\/?$/ ),
    module: "TeamManagement.TeamTasks",
    action: "workflow",
    description: "TeamManagement.TeamTasks.workflow → Clear task timing rules/settings",
  },
  {
    id: "team-task:sla",
    method: "PATCH",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/task\/sla\/[^/]+\/?$/ ),
    module: "TeamManagement.TeamTasks",
    action: "workflow",
    description: "TeamManagement.TeamTasks.workflow → Set SLA policy for the task",
  },
  {
    id: "team-task:usernames",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/task\/users\/usernames\/[^/]+\/?$/ ),
    module: "TeamManagement.TeamTasks",
    action: "view",
    description: "TeamManagement.TeamTasks.view → Get usernames under a task context",
  },
  {
    id: "team-task:users",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/task\/users\/[^/]+\/?$/ ),
    module: "TeamManagement.TeamTasks",
    action: "view",
    description: "TeamManagement.TeamTasks.view → Get user objects under a task context",
  },

  // =========================================================================
  // WORK ITEMS (/api-work-item) → AccessMap: TeamManagement.WorkItems
  // =========================================================================
  {
    id: "work-item:list",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-work-item\/list\/?$/ ),
    module: "TeamManagement.WorkItems",
    action: "view",
    description: "TeamManagement.WorkItems.view → List work items",
  },
  {
    id: "work-item:count",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-work-item\/count\/?$/ ),
    module: "TeamManagement.WorkItems",
    action: "view",
    description: "TeamManagement.WorkItems.view → Count work items",
  },
  {
    id: "work-item:get",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-work-item\/[^/]+\/?$/ ),
    module: "TeamManagement.WorkItems",
    action: "view",
    description: "TeamManagement.WorkItems.view → Get work item by id",
  },
  {
    id: "work-item:create",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-work-item\/create\/?$/ ),
    module: "TeamManagement.WorkItems",
    action: "create",
    description: "TeamManagement.WorkItems.create → Create a work item",
  },
  {
    id: "work-item:update",
    method: "PATCH",
    pattern: GuardRoutesMapSource.p( /^\/api-work-item\/[^/]+\/?$/ ),
    module: "TeamManagement.WorkItems",
    action: "update",
    description: "TeamManagement.WorkItems.update → Update a work item",
  },
  {
    id: "work-item:delete",
    method: "DELETE",
    pattern: GuardRoutesMapSource.p( /^\/api-work-item\/[^/]+\/?$/ ),
    module: "TeamManagement.WorkItems",
    action: "delete",
    description: "TeamManagement.WorkItems.delete → Delete a work item",
  },
  {
    id: "work-item:status",
    method: "PATCH",
    pattern: GuardRoutesMapSource.p( /^\/api-work-item\/[^/]+\/status\/?$/ ),
    module: "TeamManagement.WorkItems",
    action: "workflow",
    description: "TeamManagement.WorkItems.workflow → Set work item status",
  },
  {
    id: "work-item:priority",
    method: "PATCH",
    pattern: GuardRoutesMapSource.p( /^\/api-work-item\/[^/]+\/priority\/?$/ ),
    module: "TeamManagement.WorkItems",
    action: "workflow",
    description: "TeamManagement.WorkItems.workflow → Set work item priority",
  },
  {
    id: "work-item:due-at",
    method: "PATCH",
    pattern: GuardRoutesMapSource.p( /^\/api-work-item\/[^/]+\/due-at\/?$/ ),
    module: "TeamManagement.WorkItems",
    action: "workflow",
    description: "TeamManagement.WorkItems.workflow → Set/update work item due date/time",
  },
  {
    id: "work-item:assigned-members",
    method: "PATCH",
    pattern: GuardRoutesMapSource.p( /^\/api-work-item\/[^/]+\/assigned-members\/?$/ ),
    module: "TeamManagement.WorkItems",
    action: "assign",
    description: "TeamManagement.WorkItems.assign → Set/replace assigned members for work item",
  },
  {
    id: "work-item:activity",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-work-item\/[^/]+\/activity\/?$/ ),
    module: "TeamManagement.MemberActivities",
    action: "create",
    description: "TeamManagement.MemberActivities.create → Create a member activity under a work item",
  },

  // =========================================================================
  // WORK EVENTS (/api-work-event) → AccessMap: TeamManagement.WorkEvents
  // =========================================================================
  {
    id: "work-event:list-all",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-work-event\/all\/?$/ ),
    module: "TeamManagement.WorkEvents",
    action: "view",
    description: "TeamManagement.WorkEvents.view → List all work events",
  },
  {
    id: "work-event:list-by-workitem",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-work-event\/by-workitem\/[^/]+$/ ),
    module: "TeamManagement.WorkEvents",
    action: "view",
    description: "TeamManagement.WorkEvents.view → List work events by workItem",
  },
  {
    id: "work-event:list-by-team",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-work-event\/by-team\/[^/]+$/ ),
    module: "TeamManagement.WorkEvents",
    action: "view",
    description: "TeamManagement.WorkEvents.view → List work events by team",
  },
  {
    id: "work-event:stats-by-workitem",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-work-event\/stats\/workitem\/[^/]+$/ ),
    module: "TeamManagement.WorkEvents",
    action: "view",
    description: "TeamManagement.WorkEvents.view → Work event statistics by workItem",
  },

  // =========================================================================
  // MEMBER ACTIVITIES (/api-team-management/member-activities) → AccessMap: TeamManagement.MemberActivities
  // =========================================================================
  {
    id: "member-act:list",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/member-activities\/list\/?$/ ),
    module: "TeamManagement.MemberActivities",
    action: "view",
    description: "TeamManagement.MemberActivities.view → List member activities",
  },
  {
    id: "member-act:count",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/member-activities\/count\/?$/ ),
    module: "TeamManagement.MemberActivities",
    action: "view",
    description: "TeamManagement.MemberActivities.view → Count member activities",
  },
  {
    id: "member-act:get",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/member-activities\/[^/]+\/?$/ ),
    module: "TeamManagement.MemberActivities",
    action: "view",
    description: "TeamManagement.MemberActivities.view → Get member activity by id",
  },
  {
    id: "member-act:create",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/member-activities\/create\/?$/ ),
    module: "TeamManagement.MemberActivities",
    action: "create",
    description: "TeamManagement.MemberActivities.create → Create a member activity",
  },
  {
    id: "member-act:update",
    method: "PATCH",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/member-activities\/[^/]+\/?$/ ),
    module: "TeamManagement.MemberActivities",
    action: "update",
    description: "TeamManagement.MemberActivities.update → Update a member activity",
  },
  {
    id: "member-act:delete",
    method: "DELETE",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/member-activities\/[^/]+\/?$/ ),
    module: "TeamManagement.MemberActivities",
    action: "delete",
    description: "TeamManagement.MemberActivities.delete → Delete a member activity",
  },
  {
    id: "member-act:evi-append",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/member-activities\/[^/]+\/evidence\/append\/?$/ ),
    module: "TeamManagement.MemberActivities",
    action: "evidence",
    description: "TeamManagement.MemberActivities.evidence → Append evidence to activity",
  },
  {
    id: "member-act:evi-replace",
    method: "PATCH",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/member-activities\/[^/]+\/evidence\/replace\/?$/ ),
    module: "TeamManagement.MemberActivities",
    action: "evidence",
    description: "TeamManagement.MemberActivities.evidence → Replace evidence list on activity",
  },
  {
    id: "member-act:evi-remove",
    method: "PATCH",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/member-activities\/[^/]+\/evidence\/remove\/?$/ ),
    module: "TeamManagement.MemberActivities",
    action: "evidence",
    description: "TeamManagement.MemberActivities.evidence → Remove evidence from activity",
  },
  {
    id: "member-act:blocker-append",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/member-activities\/[^/]+\/blockers\/append\/?$/ ),
    module: "TeamManagement.MemberActivities",
    action: "blockers",
    description: "TeamManagement.MemberActivities.blockers → Append blocker to activity",
  },
  {
    id: "member-act:blocker-update",
    method: "PATCH",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/member-activities\/[^/]+\/blockers\/update\/?$/ ),
    module: "TeamManagement.MemberActivities",
    action: "blockers",
    description: "TeamManagement.MemberActivities.blockers → Update blocker on activity",
  },
  {
    id: "member-act:blocker-resolve",
    method: "PATCH",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/member-activities\/[^/]+\/blockers\/resolve\/?$/ ),
    module: "TeamManagement.MemberActivities",
    action: "blockers",
    description: "TeamManagement.MemberActivities.blockers → Resolve blocker on activity",
  },
  {
    id: "member-act:blocker-remove",
    method: "PATCH",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/member-activities\/[^/]+\/blockers\/remove\/?$/ ),
    module: "TeamManagement.MemberActivities",
    action: "blockers",
    description: "TeamManagement.MemberActivities.blockers → Remove blocker from activity",
  },

  // =========================================================================
  // MILESTONES (/api-team-management/milestones) → AccessMap: TeamManagement.Milestones
  // =========================================================================
  {
    id: "ms:list",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/milestones\/list\/?$/ ),
    module: "TeamManagement.Milestones",
    action: "view",
    description: "TeamManagement.Milestones.view → List milestones",
  },
  {
    id: "ms:count",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/milestones\/count\/?$/ ),
    module: "TeamManagement.Milestones",
    action: "view",
    description: "TeamManagement.Milestones.view → Count milestones",
  },
  {
    id: "ms:get",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/milestones\/[^/]+\/?$/ ),
    module: "TeamManagement.Milestones",
    action: "view",
    description: "TeamManagement.Milestones.view → Get milestone by id",
  },
  {
    id: "ms:create",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/milestones\/create\/?$/ ),
    module: "TeamManagement.Milestones",
    action: "create",
    description: "TeamManagement.Milestones.create → Create a milestone",
  },
  {
    id: "ms:update",
    method: "PATCH",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/milestones\/[^/]+\/?$/ ),
    module: "TeamManagement.Milestones",
    action: "update",
    description: "TeamManagement.Milestones.update → Update milestone",
  },
  {
    id: "ms:delete",
    method: "DELETE",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/milestones\/[^/]+\/?$/ ),
    module: "TeamManagement.Milestones",
    action: "delete",
    description: "TeamManagement.Milestones.delete → Delete milestone",
  },
  {
    id: "ms:evi-append",
    method: "PATCH",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/milestones\/[^/]+\/evidence\/append\/?$/ ),
    module: "TeamManagement.Milestones",
    action: "evidence",
    description: "TeamManagement.Milestones.evidence → Append evidence to milestone",
  },
  {
    id: "ms:evi-remove",
    method: "PATCH",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/milestones\/[^/]+\/evidence\/remove\/?$/ ),
    module: "TeamManagement.Milestones",
    action: "evidence",
    description: "TeamManagement.Milestones.evidence → Remove evidence from milestone",
  },
  {
    id: "ms:evi-replace",
    method: "PATCH",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/milestones\/[^/]+\/evidence\/replace\/?$/ ),
    module: "TeamManagement.Milestones",
    action: "evidence",
    description: "TeamManagement.Milestones.evidence → Replace evidence list on milestone",
  },
  {
    id: "ms:tags-append",
    method: "PATCH",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/milestones\/[^/]+\/tags\/append\/?$/ ),
    module: "TeamManagement.Milestones",
    action: "tags",
    description: "TeamManagement.Milestones.tags → Append tags to milestone",
  },
  {
    id: "ms:tags-remove",
    method: "PATCH",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/milestones\/[^/]+\/tags\/remove\/?$/ ),
    module: "TeamManagement.Milestones",
    action: "tags",
    description: "TeamManagement.Milestones.tags → Remove tags from milestone",
  },
  {
    id: "ms:tags-replace",
    method: "PATCH",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/milestones\/[^/]+\/tags\/replace\/?$/ ),
    module: "TeamManagement.Milestones",
    action: "tags",
    description: "TeamManagement.Milestones.tags → Replace tags list on milestone",
  },

  // =========================================================================
  // KPI MONITORING (/api-kpis + /api-team-management/kpi) → AccessMap: KpiMonitoring
  // =========================================================================
  {
    id: "team-kpi:keys",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/kpi\/keys$/ ),
    module: "KpiMonitoring",
    action: "view",
    description: "KpiMonitoring.view → Team KPI: list supported KPI keys for UI discovery",
  },
  {
    id: "team-kpi:metric",
    method: "GET",
    // Matches: /api-team-management/kpi/metric/<key>
    // - <key> is a single path segment (no slashes)
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/kpi\/metric\/[^/]+$/ ),
    module: "KpiMonitoring",
    action: "view",
    description: "KpiMonitoring.view → Team KPI: compute single metric by key (REST snapshot)",
  },
  {
    id: "team-kpi:batch",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/kpi\/batch$/ ),
    module: "KpiMonitoring",
    action: "view",
    description: "KpiMonitoring.view → Team KPI: compute multiple metrics by keys (dashboard batch)",
  },
  {
    id: "team-kpi:member-profile",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/kpi\/member-profile$/ ),
    module: "KpiMonitoring",
    action: "view",
    description: "KpiMonitoring.view → Team KPI: member profile analytics",
  },

  // =========================================================================
  // COMMENTS ENGINE (PROTECTED WRITE + PIN OPS) → AccessMap: CommentEngine
  // =========================================================================
  {
    id: "comments:add",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-comments\/add\/?$/ ),
    module: "CommentEngine",
    action: "create",
    description: "CommentEngine.create → Add a new comment (write)",
  },
  {
    id: "comments:edit",
    method: "PATCH",
    pattern: GuardRoutesMapSource.p( /^\/api-comments\/edit\/[^/]+\/?$/ ),
    module: "CommentEngine",
    action: "update",
    description: "CommentEngine.update → Edit/update an existing comment",
  },
  {
    id: "comments:delete",
    method: "DELETE",
    pattern: GuardRoutesMapSource.p( /^\/api-comments\/delete\/[^/]+\/?$/ ),
    module: "CommentEngine",
    action: "delete",
    description: "CommentEngine.delete → Delete a comment",
  },
  {
    id: "comments:pin",
    method: "PATCH",
    pattern: GuardRoutesMapSource.p( /^\/api-comments\/pin\/[^/]+\/?$/ ),
    module: "CommentEngine",
    action: "pin",
    description: "CommentEngine.pin → Pin a comment",
  },
  {
    id: "comments:unpin",
    method: "PATCH",
    pattern: GuardRoutesMapSource.p( /^\/api-comments\/unpin\/[^/]+\/?$/ ),
    module: "CommentEngine",
    action: "pin",
    description: "CommentEngine.pin → Unpin a comment (mapped to pin permission)",
  },
  {
    id: "comments:pin-toggle",
    method: "PATCH",
    pattern: GuardRoutesMapSource.p( /^\/api-comments\/pin-toggle\/[^/]+\/?$/ ),
    module: "CommentEngine",
    action: "pin",
    description: "CommentEngine.pin → Toggle pin state (mapped to pin permission)",
  },

  // =========================================================================
  // RECYCLE BIN (/api-recyclebin) → AccessMap: RecycleBin
  // =========================================================================
  {
    id: "recyclebin:list",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-recyclebin\/list\/?$/ ),
    module: "RecycleBin",
    action: "list",
    description: "RecycleBin.list → List recycle bin entries (minimal listing)",
  },
  {
    id: "recyclebin:count",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-recyclebin\/count\/?$/ ),
    module: "RecycleBin",
    action: "count",
    description: "RecycleBin.count → Count recycle bin entries",
  },
  {
    id: "recyclebin:view-snapshot",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-recyclebin\/[^/]+\/snapshot\/?$/ ),
    module: "RecycleBin",
    action: "view_snapshot",
    description: "RecycleBin.view_snapshot → View snapshot (sensitive content read)",
  },
  {
    id: "recyclebin:restore-prepare",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-recyclebin\/[^/]+\/restore\/prepare\/?$/ ),
    module: "RecycleBin",
    action: "restore",
    description: "RecycleBin.restore → Prepare restore (pre-flight validation/lock)",
  },
  {
    id: "recyclebin:restore-mark",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-recyclebin\/[^/]+\/restore\/mark\/?$/ ),
    module: "RecycleBin",
    action: "restore",
    description: "RecycleBin.restore → Mark/commit restore for an entry",
  },
  {
    id: "recyclebin:purge",
    method: "DELETE",
    pattern: GuardRoutesMapSource.p( /^\/api-recyclebin\/[^/]+\/purge\/?$/ ),
    module: "RecycleBin",
    action: "purge",
    description: "RecycleBin.purge → Permanently purge an entry (irreversible)",
  },
];

/**
 * Make this file a module so the `declare global` block is applied correctly
 * under moduleResolution: "NodeNext".
 */
export {};