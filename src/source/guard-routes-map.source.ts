// src/source/guard-routes-map.source.ts
// ============================================================================
// Guard Routes Map Source (API Guard Source of Truth)
// ----------------------------------------------------------------------------
// Purpose:
//   - Central, explicit mapping of:
//       1) PUBLIC_ENDPOINTS  → bypass token + permission checks
//       2) GUARD_ROUTES      → protected endpoints mapped to (module, action)
//   - Used by apiGuard to decide:
//       - isPublic?  → allow immediately
//       - else match guarded route → check permission
//
// CRITICAL FIXES INCLUDED (based on your actual bootstrap mounts):
//   ✅ TeamTask routes MUST include "/api-team-management/task/..."
//      because RoutesBootstrap mounts:
//        this.app.use('/api-team-management/task', apiGuard, teamTaskRouter.route)
//
//   ✅ Add public login entry route:
//        POST /api-user/verify-user
//
//   ✅ Regex patterns are query-safe:
//        They match both "/path" and "/path?x=y" if apiGuard uses req.originalUrl.
//        (If your apiGuard uses req.path, this is still harmless.)
//
// Notes:
//   - This file is intentionally explicit and verbose.
//   - Keep REGEX patterns precise; avoid "catch-all" routes.
// ============================================================================

import type { Request } from "express";
import type { PermissionEntry } from "../models/user.model";
import type { Role } from "../types/roles";

import {
  type AccessActionKey,
  type AccessModuleKey,
} from "./access-map.source";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "ANY";

export interface GuardRouteDefinition {
  /** Internal id for logging / debugging (e.g. "user:create") */
  id: string;
  method: HttpMethod;

  /**
   * Regex pattern to match the request path.
   * IMPORTANT:
   *  - This file is written to match req.originalUrl safely (allows "?query").
   *  - If apiGuard uses req.path, these still match correctly.
   */
  pattern: RegExp;

  /** Permission module */
  module: AccessModuleKey;

  /** Permission action */
  action: AccessActionKey;

  /** Optional human-readable reason */
  description?: string;
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
//   - Makes req.user (GuardedUser | undefined) available everywhere
//   - Safe: only adds an optional property, does not break existing code
// ─────────────────────────────────────────────────────────────────────────────
declare global {
  namespace Express {
    interface Request {
      /** Authenticated user injected by apiGuard (if any) */
      user?: GuardedUser;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Class wrapper (keeps logic centralized + lets us enforce consistency)
//  - You asked for class-based style everywhere.
//  - We still export arrays for direct import usage.
// ─────────────────────────────────────────────────────────────────────────────
class GuardRoutesMapSource {
  /**
   * Make endpoint regex "query-safe":
   * - If apiGuard uses req.originalUrl → includes "?a=b"
   * - If apiGuard uses req.path        → no "?a=b"
   *
   * Pattern strategy:
   *  - For exact endpoints: "^/path(?:\\?.*)?$"
   *  - For endpoints already ending with "/?": we still attach "(?:\\?.*)?$"
   */
  public static withOptionalQuery( base: RegExp ): RegExp {
    // We cannot mutate a RegExp, so we rebuild a new one.
    // This expects base already anchored with ^...$ or ^...\/?$.
    const src = base.source;

    // If the regex already allows query, keep it.
    if ( src.includes( "\\?" ) ) return base;

    // Replace ending "$" with "(?:\\?.*)?$"
    // Works for patterns like:  ^\/api-user\/users$
    // And also for:            ^\/api-user\/users\/?$
    const rebuilt = src.endsWith( "$" )
      ? src.slice( 0, -1 ) + "(?:\\?.*)?$"
      : src + "(?:\\?.*)?$";

    return new RegExp( rebuilt );
  }

  /**
   * Helper for building patterns consistently.
   * Use this when you want to ensure query-safety automatically.
   */
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

/**
 * Endpoints that do NOT require tokens or permission checks.
 * Keep this list small and very explicit.
 */
export const PUBLIC_ENDPOINTS: ReadonlyArray<PublicEndpoint> = [
  // =========================================================================
  // AUTH & MFA (mounted in RoutesBootstrap as /api/auth and /api/mfa)
  // =========================================================================

  {
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api\/auth\/login$/ ),
    reason: "AuthController login",
  },
  {
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api\/auth\/logout$/ ),
    reason: "AuthController logout (callable even if cookies/session broken)",
  },
  {
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api\/auth\/regenerate-challenge$/ ),
    reason: "Regenerate login challenge",
  },

  // POST /api/auth/ws-token/rotate/:username
  {
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api\/auth\/ws-token\/rotate\/[^/]+$/ ),
    reason: "Rotate WS token during auth flow",
  },

  // MFA
  {
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api\/mfa\/initiate$/ ),
    reason: "MFA initiate (before session/guard enforcement)",
  },
  {
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api\/mfa\/confirm$/ ),
    reason: "MFA confirm (foreign app → backend)",
  },
  {
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api\/mfa\/activate$/ ),
    reason: "MFA activate (alias)",
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
  // IMPORTANT:
  //  - You already said /verify-user is global shared login route.
  //  - Must be public or the guard blocks login itself.
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
  // SECURITY INCIDENT REPORTING
  // =========================================================================
  {
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-report\/security$/ ),
    reason: "Security incident reporting from FE",
  },

  // =========================================================================
  // COMMENTS ENGINE (PUBLIC READ) - mounted: /api-comments
  // =========================================================================
  {
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-comments\/load$/ ),
    reason: "Public read: offset load (query-based)",
  },
  {
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-comments\/load-advanced$/ ),
    reason: "Public read: advanced load (offset/cursor, query-based)",
  },
  {
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-comments\/count-advanced$/ ),
    reason: "Public read: advanced count (query-based)",
  },
  {
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-comments\/get\/[^/]+$/ ),
    reason: "Public read: get single comment by commentId or _id",
  },


];

export const GUARD_ROUTES: ReadonlyArray<GuardRouteDefinition> = [
  // =========================================================================
  // USER MANAGEMENT (/api-user)
  // =========================================================================

  {
    id: "user:list-all",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-user\/users$/ ),
    module: "UserManagement",
    action: "view",
    description: "List all users",
  },
  {
    id: "user:count-all",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-user\/users-count$/ ),
    module: "UserManagement",
    action: "view",
    description: "Get total user count",
  },
  {
    id: "user:list-paginated",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-user\/users-with-pagination\/\d+\/\d+$/ ),
    module: "UserManagement",
    action: "view",
    description: "List users with pagination",
  },
  {
    id: "user:create",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-user\/create-user$/ ),
    module: "UserManagement",
    action: "create",
    description: "Create user",
  },
  {
    id: "user:update",
    method: "PUT",
    pattern: GuardRoutesMapSource.p( /^\/api-user\/user-update\/[^/]+$/ ),
    module: "UserManagement",
    action: "update",
    description: "Update user by username",
  },
  {
    id: "user:delete",
    method: "DELETE",
    pattern: GuardRoutesMapSource.p( /^\/api-user\/user-delete\/[^/]+\/[^/]+$/ ),
    module: "UserManagement",
    action: "delete",
    description: "Delete user by username",
  },
  {
    id: "user:documents-upload",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-user\/user-document-upload\/[^/]+$/ ),
    module: "UserManagement",
    action: "update",
    description: "Upload documents for a user",
  },
  {
    id: "user:documents-list",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-user\/uploads\/[^/]+\/documents$/ ),
    module: "UserManagement",
    action: "view",
    description: "List uploaded documents for a user",
  },
  {
    id: "user:get-by-username",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-user\/user-username\/[^/]+$/ ),
    module: "UserManagement",
    action: "view",
    description: "Get user by username",
  },
  {
    id: "user:get-by-id",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-user\/user-id\/[^/]+$/ ),
    module: "UserManagement",
    action: "view",
    description: "Get user by ID",
  },
  {
    id: "user:get-by-email",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-user\/user-email\/[^/]+$/ ),
    module: "UserManagement",
    action: "view",
    description: "Get user by email",
  },
  {
    id: "user:get-by-phone",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-user\/user-phone$/ ),
    module: "UserManagement",
    action: "view",
    description: "Get user by phone number",
  },
  {
    id: "user:email-verification",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-user\/emailverifycation\/[^/]+$/ ),
    module: "UserManagement",
    action: "update",
    description: "Verify user email by token",
  },
  {
    id: "user:generate-token",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-user\/generate-token$/ ),
    module: "UserManagement",
    action: "update",
    description: "Generate verification/reset token for a user",
  },
  {
    id: "user:get-by-token",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-user\/user-token\/[^/]+$/ ),
    module: "UserManagement",
    action: "view",
    description: "Get user by verification token",
  },
  {
    id: "user:get-user-data",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-user\/user-data\/[^/]+$/ ),
    module: "UserManagement",
    action: "view",
    description: "Get rich user data by username",
  },
  {
    id: "user:get-section-key",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-user\/user-section-key\/[^/]+\/[^/]+$/ ),
    module: "UserManagement",
    action: "view",
    description: "Get specific user section by key",
  },

  // =========================================================================
  // NOTIFICATIONS (/api-notification)
  // Mapped to TenantManagement because Access Map includes `sendNotification`
  // =========================================================================

  {
    id: "notification:create",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-notification\/create$/ ),
    module: "TenantManagement",
    action: "sendNotification",
    description: "Create/send a notification",
  },
  {
    id: "notification:mark-read",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-notification\/[^/]+\/read$/ ),
    module: "TenantManagement",
    action: "update",
    description: "Mark notification as read",
  },
  {
    id: "notification:mark-read-many",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-notification\/read-many$/ ),
    module: "TenantManagement",
    action: "update",
    description: "Bulk mark notifications as read",
  },
  {
    id: "notification:mark-read-all",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-notification\/read-all$/ ),
    module: "TenantManagement",
    action: "update",
    description: "Mark all notifications as read",
  },
  {
    id: "notification:restore",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-notification\/restore$/ ),
    module: "TenantManagement",
    action: "update",
    description: "Restore items via notification (domain restore)",
  },
  {
    id: "notification:permanent-delete",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-notification\/permanent-delete$/ ),
    module: "TenantManagement",
    action: "delete",
    description: "Permanent delete via notification (domain hard-delete)",
  },
  {
    id: "notification:list-mine",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-notification\/?$/ ),
    module: "TenantManagement",
    action: "view",
    description: "List current user's notifications",
  },

  // =========================================================================
  // AUDIT / TRACKING (/api-tracking)
  // Mapped to AuditLogs (Access map supports view/filter/export/monitor)
  // =========================================================================

  {
    id: "tracking:track-login",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-tracking\/track-logged-user-login$/ ),
    module: "AuditLogs",
    action: "monitor",
    description: "Track login event for logged-in user",
  },
  {
    id: "tracking:user-login-count",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-tracking\/get-logged-user-tracking-count\/[^/]+$/ ),
    module: "AuditLogs",
    action: "view",
    description: "Get total login count for a user",
  },
  {
    id: "tracking:user-login-tracking",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-tracking\/get-logged-user-tracking\/[^/]+$/ ),
    module: "AuditLogs",
    action: "view",
    description: "Get paged login tracking for a user",
  },
  {
    id: "tracking:all-users-login-counts",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-tracking\/get-all-users-login-counts$/ ),
    module: "AuditLogs",
    action: "filter",
    description: "Login counts for all users (date range via query)",
  },
  {
    id: "tracking:file-activity",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-tracking\/user-file-management-activity\/[^/]+\/\d+\/\d+$/ ),
    module: "AuditLogs",
    action: "view",
    description: "User file management activity",
  },
  {
    id: "tracking:track-activity",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-tracking\/track-activity$/ ),
    module: "AuditLogs",
    action: "monitor",
    description: "Track generic activity event",
  },
  {
    id: "tracking:activities-by-user",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-tracking\/activities\/[^/]+\/\d+\/\d+$/ ),
    module: "AuditLogs",
    action: "view",
    description: "Tracked activities for a user (paged)",
  },
  {
    id: "tracking:created-users-total-by-creator",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-tracking\/get-total-of-created-users-based-on-creator\/[^/]+$/ ),
    module: "AuditLogs",
    action: "view",
    description: "Total users created by a creator",
  },
  {
    id: "tracking:created-users-by-creator",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-tracking\/get-created-users-based-on-creator\/[^/]+$/ ),
    module: "AuditLogs",
    action: "view",
    description: "Users created by a creator (paged via query)",
  },
  {
    id: "tracking:recent-feed",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-tracking\/recent$/ ),
    module: "AuditLogs",
    action: "view",
    description: "Recent activity feed",
  },

  // =========================================================================
  // FILE TRANSFER (/api-file-transfer)
  // Mapped to TenantManagement because it includes upload/create/view
  // =========================================================================

  {
    id: "file-transfer:tenant-mobile-upload",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-file-transfer\/get-tenant-mobile-file-upload\/[^/]+$/ ),
    module: "TenantManagement",
    action: "upload",
    description: "Receive file uploads from tenant mobile app by token",
  },
  {
    id: "file-transfer:get-by-tenant-reason",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-file-transfer\/get-reason-file-uploads-by-tenant-username\/[^/]+$/ ),
    module: "TenantManagement",
    action: "view",
    description: "Get file uploads grouped by reason for a tenant username",
  },
  {
    id: "file-transfer:convert-to-pdf",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-file-transfer\/convert-to-pdf$/ ),
    module: "TenantManagement",
    action: "create",
    description: "Convert uploaded file(s) to PDF",
  },

  // =========================================================================
  // LEASE MANAGEMENT (/api-lease)
  // =========================================================================

  {
    id: "lease:register",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-lease\/register\/[^/]+$/ ),
    module: "LeaseManagement",
    action: "create",
    description: "Register a new lease for a property",
  },
  {
    id: "lease:update-agreement",
    method: "PUT",
    pattern: GuardRoutesMapSource.p( /^\/api-lease\/update-lease-agreement\/[^/]+$/ ),
    module: "LeaseManagement",
    action: "renew",
    description: "Update / renew lease agreement by leaseID",
  },
  {
    id: "lease:preview-agreement",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-lease\/preview-lease-agreement\/[^/]+$/ ),
    module: "LeaseManagement",
    action: "view",
    description: "Preview lease agreement by leaseID",
  },
  {
    id: "lease:agreement-pdf",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-lease\/lease-agreement-pdf\/[^/]+\/[^/]+\/[^/]+$/ ),
    module: "LeaseManagement",
    action: "view",
    description: "Generate/download lease agreement PDF",
  },
  {
    id: "lease:view-agreement",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-lease\/lease-agreement\/[^/]+$/ ),
    module: "LeaseManagement",
    action: "view",
    description: "View a single lease agreement by leaseID",
  },
  {
    id: "lease:list-by-user",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-lease\/lease-agreements\/[^/]+$/ ),
    module: "LeaseManagement",
    action: "view",
    description: "List lease agreements for a given username",
  },
  {
    id: "lease:update-status",
    method: "PUT",
    pattern: GuardRoutesMapSource.p( /^\/api-lease\/lease-status-updated\/[^/]+$/ ),
    module: "LeaseManagement",
    action: "update",
    description: "Update lease status",
  },
  {
    id: "lease:list-all",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-lease\/all-leases$/ ),
    module: "LeaseManagement",
    action: "view",
    description: "List all leases (filters via query)",
  },
  {
    id: "lease:count-all",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-lease\/get-lease-count$/ ),
    module: "LeaseManagement",
    action: "view",
    description: "Get total lease count (filters via query)",
  },
  {
    id: "lease:properties-without-lease",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-lease\/get-properties-that-does-not-have-lease$/ ),
    module: "PropertyManagement",
    action: "view",
    description: "Get properties that do not have any lease",
  },
  {
    id: "lease:properties-without-lease-count",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-lease\/get-all-properties-count-without-leases$/ ),
    module: "PropertyManagement",
    action: "view",
    description: "Get count of properties without leases",
  },
  {
    id: "lease:get-tenant-by-username",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-lease\/get-tenant-by-username\/[^/]+$/ ),
    module: "UserManagement",
    action: "view",
    description: "Get tenant basic data by username (used by lease module)",
  },

  // =========================================================================
  // PAYMENTS (/api-payments)
  // =========================================================================

  {
    id: "payments:dashboard-summary",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-payments\/dashboard\/summary$/ ),
    module: "PaymentBilling",
    action: "view",
    description: "Payments dashboard summary",
  },

  // =========================================================================
  // PLACES / MAPS (/api-places)
  // Mapped to PropertyManagement because Places isn't in AccessOptions
  // =========================================================================

  {
    id: "places:autocomplete",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-places\/autocomplete$/ ),
    module: "PropertyManagement",
    action: "view",
    description: "Places autocomplete",
  },

  // =========================================================================
  // PROPERTY MANAGEMENT (/api-property)
  // =========================================================================

  {
    id: "property:create",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-property\/insert-property\/[^/]+$/ ),
    module: "PropertyManagement",
    action: "create",
    description: "Create/insert new property by ID",
  },
  {
    id: "property:list-paginated",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-property\/get-all-properties-with-pagination\/\d+\/\d+\/?$/ ),
    module: "PropertyManagement",
    action: "view",
    description: "List properties with pagination",
  },
  {
    id: "property:get-by-id",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-property\/get-single-property-by-id\/[^/]+$/ ),
    module: "PropertyManagement",
    action: "view",
    description: "Get single property by ID",
  },
  {
    id: "property:get-section-by-id",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-property\/get-single-property-section-by-id\/[^/]+$/ ),
    module: "PropertyManagement",
    action: "view",
    description: "Get specific section of a property by ID",
  },
  {
    id: "property:delete",
    method: "DELETE",
    pattern: GuardRoutesMapSource.p( /^\/api-property\/delete-property\/[^/]+\/[^/]+$/ ),
    module: "PropertyManagement",
    action: "delete",
    description: "Delete property by ID and track deleting user",
  },
  {
    id: "property:update",
    method: "PUT",
    pattern: GuardRoutesMapSource.p( /^\/api-property\/update-property\/[^/]+$/ ),
    module: "PropertyManagement",
    action: "update",
    description: "Update property by ID",
  },
  {
    id: "property:list-all",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-property\/get-all-properties\/?$/ ),
    module: "PropertyManagement",
    action: "view",
    description: "List all properties",
  },
  {
    id: "property:count-all",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-property\/get-all-properties-count\/?$/ ),
    module: "PropertyManagement",
    action: "view",
    description: "Get total property count",
  },

  // =========================================================================
  // TEAM MANAGEMENT — TEAMS (/api-team-management)
  // =========================================================================

  {
    id: "team:create",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/create$/ ),
    module: "TeamManagement.Teams",
    action: "create",
    description: "Create a team",
  },
  {
    id: "team:get-team-by-name",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/teamName\/[^/]+$/ ),
    module: "TeamManagement.Teams",
    action: "view",
    description: "Get team by team name",
  },
  {
    id: "team:list-all",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/all$/ ),
    module: "TeamManagement.Teams",
    action: "view",
    description: "List all teams",
  },
  {
    id: "team:get-team-by-id",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/[^/]+$/ ),
    module: "TeamManagement.Teams",
    action: "view",
    description: "Get team details by teamCode",
  },
  {
    id: "team:update",
    method: "PATCH",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/update\/[^/]+$/ ),
    module: "TeamManagement.Teams",
    action: "update",
    description: "Update team by teamCode",
  },
  {
    id: "team:delete",
    method: "DELETE",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/delete\/[^/]+$/ ),
    module: "TeamManagement.Teams",
    action: "delete",
    description: "Delete team by teamCode",
  },
  {
    id: "team:upload-logo",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/upload\/logo\/[^/]+$/ ),
    module: "TeamManagement.Teams",
    action: "upload",
    description: "Upload team logo",
  },

  // Stats
  {
    id: "team:stats-teams-total",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/stats\/teams-total$/ ),
    module: "TeamManagement.Teams",
    action: "monitor",
    description: "Get total number of teams",
  },
  {
    id: "team:stats-teams-total-by-domain",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/stats\/teams-total\/domain\/[^/]+$/ ),
    module: "TeamManagement.Teams",
    action: "monitor",
    description: "Get total number of teams for a domain",
  },

  // Users analytics (team module)
  {
    id: "team:users-no-team",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/users\/no-team$/ ),
    module: "TeamManagement.Teams",
    action: "view",
    description: "List users without any team",
  },
  {
    id: "team:users-no-team-count",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/users\/no-team\/count$/ ),
    module: "TeamManagement.Teams",
    action: "view",
    description: "Count users without any team",
  },
  {
    id: "team:users-in-teams",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/users\/in-teams$/ ),
    module: "TeamManagement.Teams",
    action: "view",
    description: "List users who are in teams",
  },
  {
    id: "team:users-in-teams-count",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/users\/in-teams\/count$/ ),
    module: "TeamManagement.Teams",
    action: "view",
    description: "Count users who are in teams",
  },
  {
    id: "team:users-no-team-domain",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/users\/no-team\/domain\/[^/]+$/ ),
    module: "TeamManagement.Teams",
    action: "view",
    description: "List users without team in a domain",
  },
  {
    id: "team:users-no-team-domain-count",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/users\/no-team\/domain\/[^/]+\/count$/ ),
    module: "TeamManagement.Teams",
    action: "view",
    description: "Count users without team in a domain",
  },
  {
    id: "team:users-in-teams-domain",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/users\/in-teams\/domain\/[^/]+$/ ),
    module: "TeamManagement.Teams",
    action: "view",
    description: "List users in teams for a domain",
  },
  {
    id: "team:users-in-teams-domain-count",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/users\/in-teams\/domain\/[^/]+\/count$/ ),
    module: "TeamManagement.Teams",
    action: "view",
    description: "Count users in teams for a domain",
  },
  {
    id: "team:users-with-team",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/users\/all\/?$/ ),
    module: "TeamManagement.Teams",
    action: "view",
    description: "List all users with team membership (paged via query)",
  },

  // =========================================================================
  // TEAM TASK MANAGEMENT (mounted at /api-team-management/task)
  // → WorkItems permissions
  // =========================================================================

  {
    id: "team-task:assign-task",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/task\/assign-task\/[^/]+$/ ),
    module: "TeamManagement.WorkItems",
    action: "assign",
    description: "Assign task to a team",
  },
  {
    id: "team-task:attach-evidence",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/task\/evidence\/attach\/[^/]+\/[^/]+$/ ),
    module: "TeamManagement.WorkItems",
    action: "uploadEvidence",
    description: "Attach evidence meta to a team task",
  },
  {
    id: "team-task:upload-evidence",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/task\/upload\/evidence\/[^/]+\/[^/]+$/ ),
    module: "TeamManagement.WorkItems",
    action: "uploadEvidence",
    description: "Upload evidence files for a team task",
  },
  {
    id: "team-task:get-tasks",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/task\/get-tasks\/[^/]+\/?$/ ),
    module: "TeamManagement.WorkItems",
    action: "view",
    description: "Get all tasks for a team",
  },
  {
    id: "team-task:upload-comment",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/task\/upload\/comment\/[^/]+\/[^/]+$/ ),
    module: "TeamManagement.WorkItems",
    action: "uploadEvidence",
    description: "Upload comment attachments for a team task",
  },
  {
    id: "team-task:add-comment",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/task\/comment\/add\/[^/]+\/[^/]+$/ ),
    module: "TeamManagement.WorkItems",
    action: "update",
    description: "Add a comment to a team task",
  },

  // =========================================================================
  // WORK EVENTS (/api-work-event)
  // → WorkEvents permissions
  // =========================================================================

  {
    id: "work-event:list-all",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-work-event\/all\/?$/ ),
    module: "TeamManagement.WorkEvents",
    action: "view",
    description: "List all work events (filters via query)",
  },
  {
    id: "work-event:list-by-workitem",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-work-event\/by-workitem\/[^/]+$/ ),
    module: "TeamManagement.WorkEvents",
    action: "view",
    description: "List work events for a work item",
  },
  {
    id: "work-event:list-by-team",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-work-event\/by-team\/[^/]+$/ ),
    module: "TeamManagement.WorkEvents",
    action: "view",
    description: "List work events for a team",
  },
  {
    id: "work-event:stats-by-workitem",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-work-event\/stats\/workitem\/[^/]+$/ ),
    module: "TeamManagement.WorkEvents",
    action: "monitor",
    description: "Aggregated event stats for a work item",
  },

  // =========================================================================
  // TENANT MANAGEMENT (/api-tenant) — tenants only
  // =========================================================================

  {
    id: "tenant:create",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-tenant\/insertTenant$/ ),
    module: "TenantManagement",
    action: "create",
    description: "Create/insert tenant",
  },
  {
    id: "tenant:list-all",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-tenant\/get-all-tenants$/ ),
    module: "TenantManagement",
    action: "view",
    description: "List all tenants",
  },
  {
    id: "tenant:count-all",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-tenant\/get-all-tenants-count$/ ),
    module: "TenantManagement",
    action: "view",
    description: "Get total tenant count",
  },
  {
    id: "tenant:list-all-paginated",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-tenant\/get-all-tenants-with-pagination$/ ),
    module: "TenantManagement",
    action: "view",
    description: "List tenants with pagination (via query)",
  },
  {
    id: "tenant:list-none-tenants-paginated",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-tenant\/get-all-none-tenants-with-pagination$/ ),
    module: "TenantManagement",
    action: "view",
    description: "List users with no tenant mapping",
  },
  {
    id: "tenant:count-none-tenants",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-tenant\/get-all-none-tenants-count$/ ),
    module: "TenantManagement",
    action: "view",
    description: "Count users with no tenant mapping",
  },
  {
    id: "tenant:delete",
    method: "DELETE",
    pattern: GuardRoutesMapSource.p( /^\/api-tenant\/delete-tenant\/[^/]+\/[^/]+$/ ),
    module: "TenantManagement",
    action: "delete",
    description: "Delete tenant by username",
  },

  // =========================================================================
  // COMPLAINTS MANAGEMENT (/api-tenant/... complaints endpoints)
  // =========================================================================

  {
    id: "complaint:create",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-tenant\/create-complaint$/ ),
    module: "ComplaintsManagement",
    action: "create",
    description: "Create complaint",
  },
  {
    id: "complaint:get-by-id",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-tenant\/complaint\/[^/]+$/ ),
    module: "ComplaintsManagement",
    action: "view",
    description: "Get complaint by id",
  },
  {
    id: "complaint:list-by-tenant",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-tenant\/complaints\/tenant\/[^/]+$/ ),
    module: "ComplaintsManagement",
    action: "view",
    description: "List complaints for a tenant",
  },
  {
    id: "complaint:count-by-tenant",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-tenant\/complaints-count\/tenant\/[^/]+$/ ),
    module: "ComplaintsManagement",
    action: "view",
    description: "Count complaints for a tenant",
  },
  {
    id: "complaint:list-all",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-tenant\/complaints\/all$/ ),
    module: "ComplaintsManagement",
    action: "view",
    description: "List all complaints",
  },
  {
    id: "complaint:count-all",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-tenant\/complaints-count\/all$/ ),
    module: "ComplaintsManagement",
    action: "view",
    description: "Count all complaints",
  },
  {
    id: "complaint:list-by-section",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-tenant\/complaints-by-section\/all\/[^/]+$/ ),
    module: "ComplaintsManagement",
    action: "view",
    description: "Complaints by section",
  },
  {
    id: "complaint:post-comments",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-tenant\/complaints\/post-comments$/ ),
    module: "ComplaintsManagement",
    action: "update",
    description: "Add/update complaint comments",
  },
  {
    id: "complaint:list-comments-by-code",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-tenant\/complaints\/[^/]+\/comments$/ ),
    module: "ComplaintsManagement",
    action: "view",
    description: "Get comments for complaint by complaint code",
  },
  {
    id: "complaint:list-by-status",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-tenant\/complaints\/all\/status\/[^/]+$/ ),
    module: "ComplaintsManagement",
    action: "view",
    description: "Complaints filtered by status",
  },
  {
    id: "complaint:count-by-status",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-tenant\/complaints\/all\/count\/status\/[^/]+$/ ),
    module: "ComplaintsManagement",
    action: "view",
    description: "Complaint count by status",
  },

  // =========================================================================
  // KPI MONITORING (/api-kpis)
  // =========================================================================

  {
    id: "kpi:deal-fact",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-kpis\/facts\/deals$/ ),
    module: "KpiMonitoring",
    action: "create",
    description: "Submit deal fact",
  },
  {
    id: "kpi:satisfaction-fact",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-kpis\/facts\/satisfaction$/ ),
    module: "KpiMonitoring",
    action: "create",
    description: "Submit satisfaction fact",
  },
  {
    id: "kpi:maintenance-event",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-kpis\/facts\/maintenance\/events$/ ),
    module: "KpiMonitoring",
    action: "create",
    description: "Submit maintenance event",
  },
  {
    id: "kpi:team-task-fact",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-kpis\/facts\/team\/tasks$/ ),
    module: "KpiMonitoring",
    action: "create",
    description: "Submit team task fact",
  },
  {
    id: "kpi:team-task-evidence",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-kpis\/facts\/team\/task-evidence$/ ),
    module: "KpiMonitoring",
    action: "create",
    description: "Submit team task evidence",
  },
  {
    id: "kpi:team-task-event",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-kpis\/facts\/team\/task-events$/ ),
    module: "KpiMonitoring",
    action: "create",
    description: "Submit team task event",
  },
  {
    id: "kpi:realtime-health",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-kpis\/realtime\/health$/ ),
    module: "KpiMonitoring",
    action: "view",
    description: "Realtime KPI health",
  },
  {
    id: "kpi:member-profile",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/kpi\/member-profile$/ ),
    module: "KpiMonitoring",
    action: "view",
    description: "KPI member profile",
  },

  // =========================================================================
  // TEAM KPI (mounted at /api-team-management/kpi)
  // =========================================================================

  {
    id: "team-kpi:task-completion-rate",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/kpi\/task-completion-rate$/ ),
    module: "KpiMonitoring",
    action: "view",
    description: "KPI snapshot: task completion rate",
  },
  {
    id: "team-kpi:task-completion-rate-by-team",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/kpi\/task-completion-rate\/by-team$/ ),
    module: "KpiMonitoring",
    action: "view",
    description: "KPI snapshot: completion rate by team",
  },
  {
    id: "team-kpi:customer-satisfaction",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/kpi\/customer-satisfaction$/ ),
    module: "KpiMonitoring",
    action: "view",
    description: "KPI snapshot: customer satisfaction",
  },
  {
    id: "team-kpi:top-overdue-holders",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-team-management\/kpi\/top-overdue-holders$/ ),
    module: "KpiMonitoring",
    action: "view",
    description: "KPI snapshot: top overdue holders",
  },

  // =========================================================================
  // WORK ITEMS (/api-work-item)
  // =========================================================================

  {
    id: "work-item:create",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-work-item\/create\/?$/ ),
    module: "TeamManagement.WorkItems",
    action: "create",
    description: "Create work item",
  },
  {
    id: "work-item:list-all",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-work-item\/all\/?$/ ),
    module: "TeamManagement.WorkItems",
    action: "view",
    description: "List all work items",
  },
  {
    id: "work-item:get-by-id",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-work-item\/[^/]+$/ ),
    module: "TeamManagement.WorkItems",
    action: "view",
    description: "Get work item by id",
  },
  {
    id: "work-item:update",
    method: "PATCH",
    pattern: GuardRoutesMapSource.p( /^\/api-work-item\/update\/[^/]+$/ ),
    module: "TeamManagement.WorkItems",
    action: "update",
    description: "Update work item",
  },
  {
    id: "work-item:update-status",
    method: "PATCH",
    pattern: GuardRoutesMapSource.p( /^\/api-work-item\/status\/[^/]+$/ ),
    module: "TeamManagement.WorkItems",
    action: "changeStatus",
    description: "Update work item status",
  },
  {
    id: "work-item:update-priority",
    method: "PATCH",
    pattern: GuardRoutesMapSource.p( /^\/api-work-item\/priority\/[^/]+$/ ),
    module: "TeamManagement.WorkItems",
    action: "prioritize",
    description: "Update work item priority",
  },
  {
    id: "work-item:update-value",
    method: "PATCH",
    pattern: GuardRoutesMapSource.p( /^\/api-work-item\/value\/[^/]+$/ ),
    module: "TeamManagement.WorkItems",
    action: "update",
    description: "Update work item value",
  },
  {
    id: "work-item:move",
    method: "PATCH",
    pattern: GuardRoutesMapSource.p( /^\/api-work-item\/move\/[^/]+$/ ),
    module: "TeamManagement.WorkItems",
    action: "update",
    description: "Move work item (board column change)",
  },
  {
    id: "work-item:add-evidence",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-work-item\/[^/]+\/evidence\/?$/ ),
    module: "TeamManagement.WorkItems",
    action: "uploadEvidence",
    description: "Attach evidence meta to a work item",
  },
  {
    id: "work-item:get-events",
    method: "GET",
    pattern: GuardRoutesMapSource.p( /^\/api-work-item\/[^/]+\/events\/?$/ ),
    module: "TeamManagement.WorkItems",
    action: "view",
    description: "Get events for a work item",
  },

  // =========================================================================
  // COMMENTS ENGINE (PROTECTED WRITE) - mounted: /api-comments
  // =========================================================================

  {
    id: "comments:add",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-comments\/add\/[^/]+$/ ),
    module: "CommentEngine",
    action: "create",
    description: "Add a comment",
  },
  {
    id: "comments:edit",
    method: "PATCH",
    pattern: GuardRoutesMapSource.p( /^\/api-comments\/edit\/[^/]+\/[^/]+$/ ),
    module: "CommentEngine",
    action: "updateOwn",
    description: "Edit own comment (enforced in router/service)",
  },
  {
    id: "comments:delete",
    method: "DELETE",
    pattern: GuardRoutesMapSource.p( /^\/api-comments\/delete\/[^/]+\/[^/]+$/ ),
    module: "CommentEngine",
    action: "deleteOwn",
    description: "Delete own comment (enforced in router/service)",
  },
  {
    id: "comments:upload",
    method: "POST",
    pattern: GuardRoutesMapSource.p( /^\/api-comments\/upload\/.+$/ ),
    module: "CommentEngine",
    action: "upload",
    description: "Upload comment attachments",
  },
  {
    id: "comments:pin",
    method: "PATCH",
    pattern: GuardRoutesMapSource.p(
      /^\/api-comments\/pin\/[^/]+$/
    ),
    module: "CommentEngine",
    action: "pin",
    description: "Pin a comment to highlight important information.",
  },

  {
    id: "comments:unpin",
    method: "PATCH",
    pattern: GuardRoutesMapSource.p(
      /^\/api-comments\/unpin\/[^/]+$/
    ),
    module: "CommentEngine",
    action: "unpin",
    description: "Remove pin from a pinned comment.",
  },

  {
    id: "comments:pin-toggle",
    method: "PATCH",
    pattern: GuardRoutesMapSource.p(
      /^\/api-comments\/pin-toggle\/[^/]+$/
    ),
    module: "CommentEngine",
    action: "pinToggle",
    description: "Toggle pin state of a comment (UI shortcut action).",
  },
];


/**
 * Make this file a module so the `declare global` block is applied correctly
 * under moduleResolution: "NodeNext".
 */
export {};
