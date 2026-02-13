// Path: src/source/guard-routes-map.source.ts
// ============================================================================
// Guard Routes Map Source (API Guard Source of Truth) — UPDATED FOR NEW ACCESS MAP
// ----------------------------------------------------------------------------
// ✅ This file MUST align with src/source/access-map.source.ts (PINNED)
// ✅ Every GuardRouteDefinition.module/action MUST be valid AccessModuleKey/AccessActionKey
// ✅ Regex patterns are query-safe (match "/path" and "/path?x=y" if req.originalUrl is used)
// ✅ Includes NEW routers you listed: Comments, Member Activities, Milestones, TeamTasks changes, WorkItems
//
// IMPORTANT RBAC MAPPING RULES (because Access Map now has max 6 actions/module):
// - When legacy had many actions, we map them to the closest allowed action id.
// - For Comment pin/unpin/pin-toggle → all map to "CommentEngine" action "pin" (single permission).
// - For legacy "create/update/delete" where module only has "manage" → map to "manage".
// ============================================================================

import type { Request } from "express";
import type { PermissionEntry } from "../models/user.model";
import type { Role } from "../types/roles";

import type {
  AccessActionKey,
  AccessModuleKey,
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
   *  - Written to match req.originalUrl safely (allows "?query").
   *  - If apiGuard uses req.path, these still match correctly.
   */
  pattern: RegExp;

  /** Permission module (must exist in AccessModuleKey) */
  module: AccessModuleKey;

  /** Permission action (must exist in AccessActionKey) */
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

export type GuardedRequest = Request & { user?: GuardedUser };

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
// Class wrapper (keeps logic centralized + consistent pattern building)
// ─────────────────────────────────────────────────────────────────────────────
class GuardRoutesMapSource {
  public static withOptionalQuery(base: RegExp): RegExp {
    const src = base.source;
    if (src.includes("\\?")) return base;

    const rebuilt = src.endsWith("$")
      ? src.slice(0, -1) + "(?:\\?.*)?$"
      : src + "(?:\\?.*)?$";

    return new RegExp(rebuilt);
  }

  public static p(rx: RegExp): RegExp {
    return GuardRoutesMapSource.withOptionalQuery(rx);
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
  // AUTH & MFA
  // =========================================================================
  {
    method: "POST",
    pattern: GuardRoutesMapSource.p(/^\/api\/auth\/login$/),
    reason: "AuthController login",
  },
  {
    method: "POST",
    pattern: GuardRoutesMapSource.p(/^\/api\/auth\/logout$/),
    reason: "AuthController logout",
  },
  {
    method: "POST",
    pattern: GuardRoutesMapSource.p(/^\/api\/auth\/regenerate-challenge$/),
    reason: "Regenerate login challenge",
  },
  {
    method: "POST",
    pattern: GuardRoutesMapSource.p(/^\/api\/auth\/ws-token\/rotate\/[^/]+$/),
    reason: "Rotate WS token during auth flow",
  },

  // MFA
  { method: "POST", pattern: GuardRoutesMapSource.p(/^\/api\/mfa\/initiate$/), reason: "MFA initiate" },
  { method: "POST", pattern: GuardRoutesMapSource.p(/^\/api\/mfa\/confirm$/), reason: "MFA confirm" },
  { method: "POST", pattern: GuardRoutesMapSource.p(/^\/api\/mfa\/activate$/), reason: "MFA activate" },
  { method: "POST", pattern: GuardRoutesMapSource.p(/^\/api\/mfa\/initial-verify$/), reason: "MFA initial verify" },
  { method: "POST", pattern: GuardRoutesMapSource.p(/^\/api\/mfa\/user-verify$/), reason: "MFA user verify" },
  { method: "GET", pattern: GuardRoutesMapSource.p(/^\/api\/mfa\/status\/[^/]+$/), reason: "MFA status" },
  { method: "POST", pattern: GuardRoutesMapSource.p(/^\/api\/mfa\/deactive\/[^/]+$/), reason: "MFA deactive" },

  // =========================================================================
  // SHARED LOGIN ENTRYPOINT (mounted under /api-user)
  // =========================================================================
  {
    method: "POST",
    pattern: GuardRoutesMapSource.p(/^\/api-user\/verify-user$/),
    reason: "Shared login entry route (UserRoute.verify-user)",
  },

  // =========================================================================
  // VALIDATOR (mounted as /api-validator)
  // =========================================================================
  {
    method: "GET",
    pattern: GuardRoutesMapSource.p(/^\/api-validator\/email-validator\/.+$/),
    reason: "Public email validation",
  },

  // =========================================================================
  // SECURITY INCIDENT REPORTING
  // =========================================================================
  {
    method: "POST",
    pattern: GuardRoutesMapSource.p(/^\/api-report\/security$/),
    reason: "Security incident reporting from FE",
  },

  // =========================================================================
  // COMMENTS ENGINE (Public READ endpoints)
  // Mounted: /api-comments
  // NEW ROUTES INCLUDED:
  //   GET /load
  //   GET /load-advanced
  //   GET /count-advanced
  //   GET /count-load
  //   GET /get/:id
  // =========================================================================
  { method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-comments\/load$/), reason: "Public read: load" },
  { method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-comments\/load-advanced$/), reason: "Public read: load-advanced" },
  { method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-comments\/count-advanced$/), reason: "Public read: count-advanced" },
  { method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-comments\/count-load$/), reason: "Public read: count-load" },
  { method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-comments\/get\/[^/]+$/), reason: "Public read: get by id" },
];

// ─────────────────────────────────────────────────────────────────────────────
// Guarded routes (protected)
// ─────────────────────────────────────────────────────────────────────────────

export const GUARD_ROUTES: ReadonlyArray<GuardRouteDefinition> = [
  // =========================================================================
  // USER MANAGEMENT (/api-user)
  // AccessMap: UserManagement actions = view/create/update/disable/roles/export
  // =========================================================================
  { id: "user:list-all", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-user\/users$/), module: "UserManagement", action: "view", description: "List users" },
  { id: "user:count-all", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-user\/users-count$/), module: "UserManagement", action: "view", description: "Count users" },
  { id: "user:list-paged", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-user\/users-with-pagination\/\d+\/\d+$/), module: "UserManagement", action: "view", description: "List users paginated" },

  { id: "user:create", method: "POST", pattern: GuardRoutesMapSource.p(/^\/api-user\/create-user$/), module: "UserManagement", action: "create", description: "Create user" },
  { id: "user:update", method: "PUT", pattern: GuardRoutesMapSource.p(/^\/api-user\/user-update\/[^/]+$/), module: "UserManagement", action: "update", description: "Update user by username" },

  // Legacy hard delete maps to "disable" in new AccessMap (safer control)
  { id: "user:delete-legacy", method: "DELETE", pattern: GuardRoutesMapSource.p(/^\/api-user\/user-delete\/[^/]+\/[^/]+$/), module: "UserManagement", action: "disable", description: "Legacy delete → treated as disable permission" },

  { id: "user:docs-upload", method: "POST", pattern: GuardRoutesMapSource.p(/^\/api-user\/user-document-upload\/[^/]+$/), module: "UserManagement", action: "update", description: "Upload user documents" },
  { id: "user:docs-list", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-user\/uploads\/[^/]+\/documents$/), module: "UserManagement", action: "view", description: "List user documents" },

  { id: "user:get-by-username", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-user\/user-username\/[^/]+$/), module: "UserManagement", action: "view" },
  { id: "user:get-by-id", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-user\/user-id\/[^/]+$/), module: "UserManagement", action: "view" },
  { id: "user:get-by-email", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-user\/user-email\/[^/]+$/), module: "UserManagement", action: "view" },
  { id: "user:get-by-phone", method: "POST", pattern: GuardRoutesMapSource.p(/^\/api-user\/user-phone$/), module: "UserManagement", action: "view" },

  { id: "user:email-verify", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-user\/emailverifycation\/[^/]+$/), module: "UserManagement", action: "update" },
  { id: "user:token-generate", method: "POST", pattern: GuardRoutesMapSource.p(/^\/api-user\/generate-token$/), module: "UserManagement", action: "update" },
  { id: "user:get-by-token", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-user\/user-token\/[^/]+$/), module: "UserManagement", action: "view" },

  { id: "user:rich-user-data", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-user\/user-data\/[^/]+$/), module: "UserManagement", action: "view" },
  { id: "user:get-section-key", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-user\/user-section-key\/[^/]+\/[^/]+$/), module: "UserManagement", action: "view" },

  // =========================================================================
  // NOTIFICATION CENTER (/api-notification)
  // AccessMap: NotificationCenter actions = view/markRead/delete/restore/broadcast/configure
  // =========================================================================
  { id: "notify:create", method: "POST", pattern: GuardRoutesMapSource.p(/^\/api-notification\/create$/), module: "NotificationCenter", action: "broadcast", description: "Create/send notification" },
  { id: "notify:mark-read-one", method: "POST", pattern: GuardRoutesMapSource.p(/^\/api-notification\/[^/]+\/read$/), module: "NotificationCenter", action: "markRead" },
  { id: "notify:mark-read-many", method: "POST", pattern: GuardRoutesMapSource.p(/^\/api-notification\/read-many$/), module: "NotificationCenter", action: "markRead" },
  { id: "notify:mark-read-all", method: "POST", pattern: GuardRoutesMapSource.p(/^\/api-notification\/read-all$/), module: "NotificationCenter", action: "markRead" },

  { id: "notify:restore", method: "POST", pattern: GuardRoutesMapSource.p(/^\/api-notification\/restore$/), module: "NotificationCenter", action: "restore" },
  { id: "notify:permanent-delete", method: "POST", pattern: GuardRoutesMapSource.p(/^\/api-notification\/permanent-delete$/), module: "NotificationCenter", action: "delete" },

  { id: "notify:list-mine", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-notification\/?$/), module: "NotificationCenter", action: "view" },

  // =========================================================================
  // AUDIT / TRACKING (/api-tracking)
  // AccessMap: AuditLogs actions = view/filter/investigate/alerts/export/retain
  // =========================================================================
  { id: "audit:track-login", method: "POST", pattern: GuardRoutesMapSource.p(/^\/api-tracking\/track-logged-user-login$/), module: "AuditLogs", action: "investigate" },
  { id: "audit:logged-user-count", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-tracking\/get-logged-user-tracking-count\/[^/]+$/), module: "AuditLogs", action: "view" },
  { id: "audit:logged-user-list", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-tracking\/get-logged-user-tracking\/[^/]+$/), module: "AuditLogs", action: "view" },
  { id: "audit:all-users-counts", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-tracking\/get-all-users-login-counts$/), module: "AuditLogs", action: "filter" },
  { id: "audit:file-activity", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-tracking\/user-file-management-activity\/[^/]+\/\d+\/\d+$/), module: "AuditLogs", action: "view" },
  { id: "audit:track-activity", method: "POST", pattern: GuardRoutesMapSource.p(/^\/api-tracking\/track-activity$/), module: "AuditLogs", action: "investigate" },
  { id: "audit:activities-by-user", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-tracking\/activities\/[^/]+\/\d+\/\d+$/), module: "AuditLogs", action: "view" },
  { id: "audit:recent-feed", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-tracking\/recent$/), module: "AuditLogs", action: "view" },

  // =========================================================================
  // FILE TRANSFER (/api-file-transfer)
  // AccessMap does not have FileTransfer module; map to TenantManagement.manage
  // =========================================================================
  { id: "file-transfer:tenant-mobile-upload", method: "POST", pattern: GuardRoutesMapSource.p(/^\/api-file-transfer\/get-tenant-mobile-file-upload\/[^/]+$/), module: "TenantManagement", action: "manage" },
  { id: "file-transfer:get-by-tenant-reason", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-file-transfer\/get-reason-file-uploads-by-tenant-username\/[^/]+$/), module: "TenantManagement", action: "view" },
  { id: "file-transfer:convert-to-pdf", method: "POST", pattern: GuardRoutesMapSource.p(/^\/api-file-transfer\/convert-to-pdf$/), module: "TenantManagement", action: "manage" },

  // =========================================================================
  // LEASE MANAGEMENT (/api-lease)
  // AccessMap: LeaseManagement actions = view/manage/workflow/approve/audit/export
  // =========================================================================
  { id: "lease:register", method: "POST", pattern: GuardRoutesMapSource.p(/^\/api-lease\/register\/[^/]+$/), module: "LeaseManagement", action: "manage" },
  { id: "lease:update-agreement", method: "PUT", pattern: GuardRoutesMapSource.p(/^\/api-lease\/update-lease-agreement\/[^/]+$/), module: "LeaseManagement", action: "workflow" },
  { id: "lease:preview", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-lease\/preview-lease-agreement\/[^/]+$/), module: "LeaseManagement", action: "view" },
  { id: "lease:agreement-pdf", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-lease\/lease-agreement-pdf\/[^/]+\/[^/]+\/[^/]+$/), module: "LeaseManagement", action: "view" },
  { id: "lease:view-one", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-lease\/lease-agreement\/[^/]+$/), module: "LeaseManagement", action: "view" },
  { id: "lease:list-by-user", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-lease\/lease-agreements\/[^/]+$/), module: "LeaseManagement", action: "view" },
  { id: "lease:update-status", method: "PUT", pattern: GuardRoutesMapSource.p(/^\/api-lease\/lease-status-updated\/[^/]+$/), module: "LeaseManagement", action: "workflow" },
  { id: "lease:list-all", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-lease\/all-leases$/), module: "LeaseManagement", action: "view" },
  { id: "lease:count-all", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-lease\/get-lease-count$/), module: "LeaseManagement", action: "view" },

  { id: "lease:props-without-lease", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-lease\/get-properties-that-does-not-have-lease$/), module: "PropertyManagement", action: "view" },
  { id: "lease:props-without-lease-count", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-lease\/get-all-properties-count-without-leases$/), module: "PropertyManagement", action: "view" },

  { id: "lease:get-tenant-by-username", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-lease\/get-tenant-by-username\/[^/]+$/), module: "UserManagement", action: "view" },

  // =========================================================================
  // PAYMENTS (/api-payments)
  // AccessMap: PaymentBilling actions = view/invoice/record/approve/refund/export
  // =========================================================================
  { id: "payments:dashboard-summary", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-payments\/dashboard\/summary$/), module: "PaymentBilling", action: "view" },

  // =========================================================================
  // PLACES (/api-places) → PropertyManagement.view
  // =========================================================================
  { id: "places:autocomplete", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-places\/autocomplete$/), module: "PropertyManagement", action: "view" },

  // =========================================================================
  // PROPERTY MANAGEMENT (/api-property)
  // AccessMap: PropertyManagement actions = view/manage/assign/publish/audit/export
  // =========================================================================
  { id: "property:create-legacy", method: "POST", pattern: GuardRoutesMapSource.p(/^\/api-property\/insert-property\/[^/]+$/), module: "PropertyManagement", action: "manage" },
  { id: "property:list-paged", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-property\/get-all-properties-with-pagination\/\d+\/\d+\/?$/), module: "PropertyManagement", action: "view" },
  { id: "property:get-one", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-property\/get-single-property-by-id\/[^/]+$/), module: "PropertyManagement", action: "view" },
  { id: "property:get-section", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-property\/get-single-property-section-by-id\/[^/]+$/), module: "PropertyManagement", action: "view" },
  { id: "property:delete-legacy", method: "DELETE", pattern: GuardRoutesMapSource.p(/^\/api-property\/delete-property\/[^/]+\/[^/]+$/), module: "PropertyManagement", action: "manage" },
  { id: "property:update-legacy", method: "PUT", pattern: GuardRoutesMapSource.p(/^\/api-property\/update-property\/[^/]+$/), module: "PropertyManagement", action: "manage" },
  { id: "property:list-all", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-property\/get-all-properties\/?$/), module: "PropertyManagement", action: "view" },
  { id: "property:count-all", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-property\/get-all-properties-count\/?$/), module: "PropertyManagement", action: "view" },

  // =========================================================================
  // TEAM MANAGEMENT — TEAMS (/api-team-management)
  // AccessMap: TeamManagement.Teams actions = view/manage/members/captain/monitor/export
  // =========================================================================
  { id: "team:create", method: "POST", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/create$/), module: "TeamManagement.Teams", action: "manage" },
  { id: "team:get-by-name", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/teamName\/[^/]+$/), module: "TeamManagement.Teams", action: "view" },
  { id: "team:list-all", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/all$/), module: "TeamManagement.Teams", action: "view" },

  { id: "team:upload-logo", method: "POST", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/upload\/logo\/[^/]+$/), module: "TeamManagement.Teams", action: "manage" },

  // stats → monitor
  { id: "team:stats-total", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/stats\/teams-total$/), module: "TeamManagement.Teams", action: "monitor" },
  { id: "team:stats-total-domain", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/stats\/teams-total\/domain\/[^/]+$/), module: "TeamManagement.Teams", action: "monitor" },

  // users analytics → view
  { id: "team:users-no-team", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/users\/no-team$/), module: "TeamManagement.Teams", action: "view" },
  { id: "team:users-no-team-count", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/users\/no-team\/count$/), module: "TeamManagement.Teams", action: "view" },
  { id: "team:users-in-teams", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/users\/in-teams$/), module: "TeamManagement.Teams", action: "view" },
  { id: "team:users-in-teams-count", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/users\/in-teams\/count$/), module: "TeamManagement.Teams", action: "view" },

  { id: "team:users-no-team-domain", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/users\/no-team\/domain\/[^/]+$/), module: "TeamManagement.Teams", action: "view" },
  { id: "team:users-no-team-domain-count", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/users\/no-team\/domain\/[^/]+\/count$/), module: "TeamManagement.Teams", action: "view" },
  { id: "team:users-in-teams-domain", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/users\/in-teams\/domain\/[^/]+$/), module: "TeamManagement.Teams", action: "view" },
  { id: "team:users-in-teams-domain-count", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/users\/in-teams\/domain\/[^/]+\/count$/), module: "TeamManagement.Teams", action: "view" },

  { id: "team:users-all", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/users\/all\/?$/), module: "TeamManagement.Teams", action: "view" },

  // update/delete → manage
  { id: "team:update", method: "PATCH", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/update\/[^/]+$/), module: "TeamManagement.Teams", action: "manage" },
  { id: "team:delete", method: "DELETE", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/delete\/[^/]+$/), module: "TeamManagement.Teams", action: "manage" },

  // NOTE: Keep catch-all teamCode LAST
  { id: "team:get-by-code", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/[^/]+$/), module: "TeamManagement.Teams", action: "view" },

  // =========================================================================
  // TEAM TASK (TEAM MANAGEMENT) — mounted: /api-team-management/task
  // AccessMap: TeamManagement.TeamTasks actions = view/create/update/assign/workflow/evidence
  // =========================================================================

  // READ
  { id: "team-task:get", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/task\/get\/[^/]+\/?$/), module: "TeamManagement.TeamTasks", action: "view" },
  { id: "team-task:list", method: "POST", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/task\/list\/?$/), module: "TeamManagement.TeamTasks", action: "view" },
  { id: "team-task:count", method: "POST", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/task\/count\/?$/), module: "TeamManagement.TeamTasks", action: "view" },
  { id: "team-task:key-values", method: "POST", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/task\/key-values\/?$/), module: "TeamManagement.TeamTasks", action: "view" },

  // CRUD
  { id: "team-task:create", method: "POST", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/task\/create\/?$/), module: "TeamManagement.TeamTasks", action: "create" },
  { id: "team-task:update", method: "PATCH", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/task\/update\/[^/]+\/?$/), module: "TeamManagement.TeamTasks", action: "update" },
  { id: "team-task:delete", method: "DELETE", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/task\/delete\/[^/]+\/?$/), module: "TeamManagement.TeamTasks", action: "update" },

  // Evidence remove (DELETE /evidence/:taskMongoId/:evidenceMongoId) → evidence
  { id: "team-task:evidence-delete", method: "DELETE", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/task\/evidence\/[^/]+\/[^/]+\/?$/), module: "TeamManagement.TeamTasks", action: "evidence" },

  // Status / Priority → workflow
  { id: "team-task:status", method: "PATCH", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/task\/status\/[^/]+\/?$/), module: "TeamManagement.TeamTasks", action: "workflow" },
  { id: "team-task:priority", method: "PATCH", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/task\/priority\/[^/]+\/?$/), module: "TeamManagement.TeamTasks", action: "workflow" },

  // Labels → workflow
  { id: "team-task:labels-set", method: "PATCH", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/task\/labels\/set\/[^/]+\/?$/), module: "TeamManagement.TeamTasks", action: "workflow" },
  { id: "team-task:labels-add", method: "PATCH", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/task\/labels\/add\/[^/]+\/?$/), module: "TeamManagement.TeamTasks", action: "workflow" },
  { id: "team-task:labels-remove", method: "PATCH", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/task\/labels\/remove\/[^/]+\/?$/), module: "TeamManagement.TeamTasks", action: "workflow" },

  // Members/Captain → assign
  { id: "team-task:members-set", method: "PATCH", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/task\/members\/set\/[^/]+\/?$/), module: "TeamManagement.TeamTasks", action: "assign" },
  { id: "team-task:members-add", method: "PATCH", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/task\/members\/add\/[^/]+\/?$/), module: "TeamManagement.TeamTasks", action: "assign" },
  { id: "team-task:members-remove", method: "PATCH", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/task\/members\/remove\/[^/]+\/?$/), module: "TeamManagement.TeamTasks", action: "assign" },
  { id: "team-task:captain", method: "PATCH", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/task\/captain\/[^/]+\/?$/), module: "TeamManagement.TeamTasks", action: "assign" },

  // location/address/notes → update
  { id: "team-task:location", method: "PATCH", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/task\/location\/[^/]+\/?$/), module: "TeamManagement.TeamTasks", action: "update" },
  { id: "team-task:address", method: "PATCH", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/task\/address\/[^/]+\/?$/), module: "TeamManagement.TeamTasks", action: "update" },
  { id: "team-task:notes", method: "PATCH", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/task\/notes\/[^/]+\/?$/), module: "TeamManagement.TeamTasks", action: "update" },

  // audit/timing/sla → workflow (because it's governance/time rules)
  { id: "team-task:audit-get", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/task\/audit\/[^/]+\/?$/), module: "TeamManagement.TeamTasks", action: "workflow" },
  { id: "team-task:audit-set", method: "PATCH", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/task\/audit\/set\/[^/]+\/?$/), module: "TeamManagement.TeamTasks", action: "workflow" },
  { id: "team-task:audit-patch", method: "PATCH", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/task\/audit\/patch\/[^/]+\/?$/), module: "TeamManagement.TeamTasks", action: "workflow" },
  { id: "team-task:audit-clear", method: "PATCH", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/task\/audit\/clear\/[^/]+\/?$/), module: "TeamManagement.TeamTasks", action: "workflow" },

  { id: "team-task:timing-get", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/task\/timing\/[^/]+\/?$/), module: "TeamManagement.TeamTasks", action: "workflow" },
  { id: "team-task:timing-set", method: "PATCH", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/task\/timing\/set\/[^/]+\/?$/), module: "TeamManagement.TeamTasks", action: "workflow" },
  { id: "team-task:timing-patch", method: "PATCH", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/task\/timing\/patch\/[^/]+\/?$/), module: "TeamManagement.TeamTasks", action: "workflow" },
  { id: "team-task:timing-clear", method: "PATCH", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/task\/timing\/clear\/[^/]+\/?$/), module: "TeamManagement.TeamTasks", action: "workflow" },

  { id: "team-task:sla", method: "PATCH", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/task\/sla\/[^/]+\/?$/), module: "TeamManagement.TeamTasks", action: "workflow" },

  // users endpoints → view
  { id: "team-task:usernames", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/task\/users\/usernames\/[^/]+\/?$/), module: "TeamManagement.TeamTasks", action: "view" },
  { id: "team-task:users", method: "POST", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/task\/users\/[^/]+\/?$/), module: "TeamManagement.TeamTasks", action: "view" },

  // =========================================================================
  // WORK ITEMS (TEAM MANAGEMENT) — mounted: /api-work-item
  // NEW ROUTES LISTED:
  //   GET /list
  //   GET /count
  //   GET /:workItemId
  //   POST /create
  //   PATCH /:workItemId
  //   DELETE /:workItemId
  //   PATCH /:workItemId/status
  //   PATCH /:workItemId/priority
  //   PATCH /:workItemId/due-at
  //   PATCH /:workItemId/assigned-members
  //   POST /:workItemId/activity
  //
  // AccessMap: TeamManagement.WorkItems actions = view/manage/assign/workflow/approve/export
  // =========================================================================
  { id: "work-item:list", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-work-item\/list\/?$/), module: "TeamManagement.WorkItems", action: "view" },
  { id: "work-item:count", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-work-item\/count\/?$/), module: "TeamManagement.WorkItems", action: "view" },
  { id: "work-item:get", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-work-item\/[^/]+\/?$/), module: "TeamManagement.WorkItems", action: "view" },

  { id: "work-item:create", method: "POST", pattern: GuardRoutesMapSource.p(/^\/api-work-item\/create\/?$/), module: "TeamManagement.WorkItems", action: "manage" },
  { id: "work-item:update", method: "PATCH", pattern: GuardRoutesMapSource.p(/^\/api-work-item\/[^/]+\/?$/), module: "TeamManagement.WorkItems", action: "manage" },
  { id: "work-item:delete", method: "DELETE", pattern: GuardRoutesMapSource.p(/^\/api-work-item\/[^/]+\/?$/), module: "TeamManagement.WorkItems", action: "manage" },

  { id: "work-item:status", method: "PATCH", pattern: GuardRoutesMapSource.p(/^\/api-work-item\/[^/]+\/status\/?$/), module: "TeamManagement.WorkItems", action: "workflow" },
  { id: "work-item:priority", method: "PATCH", pattern: GuardRoutesMapSource.p(/^\/api-work-item\/[^/]+\/priority\/?$/), module: "TeamManagement.WorkItems", action: "workflow" },
  { id: "work-item:due-at", method: "PATCH", pattern: GuardRoutesMapSource.p(/^\/api-work-item\/[^/]+\/due-at\/?$/), module: "TeamManagement.WorkItems", action: "workflow" },

  // assigned-members → assign
  { id: "work-item:assigned-members", method: "PATCH", pattern: GuardRoutesMapSource.p(/^\/api-work-item\/[^/]+\/assigned-members\/?$/), module: "TeamManagement.WorkItems", action: "assign" },

  // activity create under work item → MemberActivities.create
  { id: "work-item:activity", method: "POST", pattern: GuardRoutesMapSource.p(/^\/api-work-item\/[^/]+\/activity\/?$/), module: "TeamManagement.MemberActivities", action: "create" },

  // =========================================================================
  // WORK EVENTS (/api-work-event) — keep existing mappings but align actions
  // AccessMap: TeamManagement.WorkEvents actions = view/manage/assign/workflow/evidence/export
  // =========================================================================
  { id: "work-event:list-all", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-work-event\/all\/?$/), module: "TeamManagement.WorkEvents", action: "view" },
  { id: "work-event:list-by-workitem", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-work-event\/by-workitem\/[^/]+$/), module: "TeamManagement.WorkEvents", action: "view" },
  { id: "work-event:list-by-team", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-work-event\/by-team\/[^/]+$/), module: "TeamManagement.WorkEvents", action: "view" },
  { id: "work-event:stats-by-workitem", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-work-event\/stats\/workitem\/[^/]+$/), module: "TeamManagement.WorkEvents", action: "view" },

  // =========================================================================
  // MEMBER ACTIVITIES (TEAM MANAGEMENT)
  // You listed these routes (assumed mount): /api-team-management/member-activities
  // If your actual mount differs, change only the base prefix in regex.
  //
  // Routes:
  //  GET /list
  //  GET /count
  //  GET /:activityId
  //  POST /create
  //  PATCH /:activityId
  //  DELETE /:activityId
  //  POST  /:activityId/evidence/append
  //  PATCH /:activityId/evidence/replace
  //  PATCH /:activityId/evidence/remove
  //  POST  /:activityId/blockers/append
  //  PATCH /:activityId/blockers/update
  //  PATCH /:activityId/blockers/resolve
  //  PATCH /:activityId/blockers/remove
  //
  // AccessMap: TeamManagement.MemberActivities actions = view/create/update/blockers/evidence/export
  // =========================================================================
  { id: "member-act:list", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/member-activities\/list\/?$/), module: "TeamManagement.MemberActivities", action: "view" },
  { id: "member-act:count", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/member-activities\/count\/?$/), module: "TeamManagement.MemberActivities", action: "view" },
  { id: "member-act:get", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/member-activities\/[^/]+\/?$/), module: "TeamManagement.MemberActivities", action: "view" },

  { id: "member-act:create", method: "POST", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/member-activities\/create\/?$/), module: "TeamManagement.MemberActivities", action: "create" },
  { id: "member-act:update", method: "PATCH", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/member-activities\/[^/]+\/?$/), module: "TeamManagement.MemberActivities", action: "update" },
  { id: "member-act:delete", method: "DELETE", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/member-activities\/[^/]+\/?$/), module: "TeamManagement.MemberActivities", action: "update" },

  // Evidence
  { id: "member-act:evi-append", method: "POST", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/member-activities\/[^/]+\/evidence\/append\/?$/), module: "TeamManagement.MemberActivities", action: "evidence" },
  { id: "member-act:evi-replace", method: "PATCH", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/member-activities\/[^/]+\/evidence\/replace\/?$/), module: "TeamManagement.MemberActivities", action: "evidence" },
  { id: "member-act:evi-remove", method: "PATCH", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/member-activities\/[^/]+\/evidence\/remove\/?$/), module: "TeamManagement.MemberActivities", action: "evidence" },

  // Blockers
  { id: "member-act:blocker-append", method: "POST", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/member-activities\/[^/]+\/blockers\/append\/?$/), module: "TeamManagement.MemberActivities", action: "blockers" },
  { id: "member-act:blocker-update", method: "PATCH", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/member-activities\/[^/]+\/blockers\/update\/?$/), module: "TeamManagement.MemberActivities", action: "blockers" },
  { id: "member-act:blocker-resolve", method: "PATCH", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/member-activities\/[^/]+\/blockers\/resolve\/?$/), module: "TeamManagement.MemberActivities", action: "blockers" },
  { id: "member-act:blocker-remove", method: "PATCH", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/member-activities\/[^/]+\/blockers\/remove\/?$/), module: "TeamManagement.MemberActivities", action: "blockers" },

  // =========================================================================
  // MILESTONES (TEAM MANAGEMENT)
  // You listed these routes (assumed mount): /api-team-management/milestones
  //
  // Routes:
  //  GET /list
  //  GET /count
  //  GET /:id
  //  POST /create
  //  PATCH /:id
  //  DELETE /:id
  //  PATCH /:id/evidence/append
  //  PATCH /:id/evidence/remove
  //  PATCH /:id/evidence/replace
  //  PATCH /:id/tags/append
  //  PATCH /:id/tags/remove
  //  PATCH /:id/tags/replace
  //
  // AccessMap: TeamManagement.Milestones actions = view/create/update/workflow/tags/evidence
  // =========================================================================
  { id: "ms:list", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/milestones\/list\/?$/), module: "TeamManagement.Milestones", action: "view" },
  { id: "ms:count", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/milestones\/count\/?$/), module: "TeamManagement.Milestones", action: "view" },
  { id: "ms:get", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/milestones\/[^/]+\/?$/), module: "TeamManagement.Milestones", action: "view" },

  { id: "ms:create", method: "POST", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/milestones\/create\/?$/), module: "TeamManagement.Milestones", action: "create" },
  { id: "ms:update", method: "PATCH", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/milestones\/[^/]+\/?$/), module: "TeamManagement.Milestones", action: "update" },
  { id: "ms:delete", method: "DELETE", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/milestones\/[^/]+\/?$/), module: "TeamManagement.Milestones", action: "update" },

  // Evidence
  { id: "ms:evi-append", method: "PATCH", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/milestones\/[^/]+\/evidence\/append\/?$/), module: "TeamManagement.Milestones", action: "evidence" },
  { id: "ms:evi-remove", method: "PATCH", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/milestones\/[^/]+\/evidence\/remove\/?$/), module: "TeamManagement.Milestones", action: "evidence" },
  { id: "ms:evi-replace", method: "PATCH", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/milestones\/[^/]+\/evidence\/replace\/?$/), module: "TeamManagement.Milestones", action: "evidence" },

  // Tags
  { id: "ms:tags-append", method: "PATCH", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/milestones\/[^/]+\/tags\/append\/?$/), module: "TeamManagement.Milestones", action: "tags" },
  { id: "ms:tags-remove", method: "PATCH", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/milestones\/[^/]+\/tags\/remove\/?$/), module: "TeamManagement.Milestones", action: "tags" },
  { id: "ms:tags-replace", method: "PATCH", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/milestones\/[^/]+\/tags\/replace\/?$/), module: "TeamManagement.Milestones", action: "tags" },

  // =========================================================================
  // TENANTS (/api-tenant)
  // AccessMap: TenantManagement actions = view/manage/assign/notify/audit/export
  // =========================================================================
  { id: "tenant:create", method: "POST", pattern: GuardRoutesMapSource.p(/^\/api-tenant\/insertTenant$/), module: "TenantManagement", action: "manage" },
  { id: "tenant:list-all", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-tenant\/get-all-tenants$/), module: "TenantManagement", action: "view" },
  { id: "tenant:count-all", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-tenant\/get-all-tenants-count$/), module: "TenantManagement", action: "view" },
  { id: "tenant:list-paged", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-tenant\/get-all-tenants-with-pagination$/), module: "TenantManagement", action: "view" },
  { id: "tenant:list-none", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-tenant\/get-all-none-tenants-with-pagination$/), module: "TenantManagement", action: "view" },
  { id: "tenant:count-none", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-tenant\/get-all-none-tenants-count$/), module: "TenantManagement", action: "view" },
  { id: "tenant:delete", method: "DELETE", pattern: GuardRoutesMapSource.p(/^\/api-tenant\/delete-tenant\/[^/]+\/[^/]+$/), module: "TenantManagement", action: "manage" },

  // =========================================================================
  // COMPLAINTS (mounted under /api-tenant/... in your legacy)
  // AccessMap: ComplaintsManagement actions = view/manage/assign/workflow/audit/export
  // =========================================================================
  { id: "complaint:create", method: "POST", pattern: GuardRoutesMapSource.p(/^\/api-tenant\/create-complaint$/), module: "ComplaintsManagement", action: "manage" },
  { id: "complaint:get", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-tenant\/complaint\/[^/]+$/), module: "ComplaintsManagement", action: "view" },
  { id: "complaint:list-by-tenant", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-tenant\/complaints\/tenant\/[^/]+$/), module: "ComplaintsManagement", action: "view" },
  { id: "complaint:count-by-tenant", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-tenant\/complaints-count\/tenant\/[^/]+$/), module: "ComplaintsManagement", action: "view" },
  { id: "complaint:list-all", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-tenant\/complaints\/all$/), module: "ComplaintsManagement", action: "view" },
  { id: "complaint:count-all", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-tenant\/complaints-count\/all$/), module: "ComplaintsManagement", action: "view" },
  { id: "complaint:by-section", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-tenant\/complaints-by-section\/all\/[^/]+$/), module: "ComplaintsManagement", action: "view" },
  { id: "complaint:post-comments", method: "POST", pattern: GuardRoutesMapSource.p(/^\/api-tenant\/complaints\/post-comments$/), module: "ComplaintsManagement", action: "workflow" },
  { id: "complaint:list-comments", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-tenant\/complaints\/[^/]+\/comments$/), module: "ComplaintsManagement", action: "view" },
  { id: "complaint:by-status", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-tenant\/complaints\/all\/status\/[^/]+$/), module: "ComplaintsManagement", action: "view" },
  { id: "complaint:count-by-status", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-tenant\/complaints\/all\/count\/status\/[^/]+$/), module: "ComplaintsManagement", action: "view" },

  // =========================================================================
  // KPI MONITORING (/api-kpis, /api-team-management/kpi)
  // AccessMap: KpiMonitoring actions = view/ingest/rebuild/configure/alerts/export
  // =========================================================================
  { id: "kpi:deal-fact", method: "POST", pattern: GuardRoutesMapSource.p(/^\/api-kpis\/facts\/deals$/), module: "KpiMonitoring", action: "ingest" },
  { id: "kpi:satisfaction-fact", method: "POST", pattern: GuardRoutesMapSource.p(/^\/api-kpis\/facts\/satisfaction$/), module: "KpiMonitoring", action: "ingest" },
  { id: "kpi:maintenance-event", method: "POST", pattern: GuardRoutesMapSource.p(/^\/api-kpis\/facts\/maintenance\/events$/), module: "KpiMonitoring", action: "ingest" },
  { id: "kpi:team-task-fact", method: "POST", pattern: GuardRoutesMapSource.p(/^\/api-kpis\/facts\/team\/tasks$/), module: "KpiMonitoring", action: "ingest" },
  { id: "kpi:team-task-evidence", method: "POST", pattern: GuardRoutesMapSource.p(/^\/api-kpis\/facts\/team\/task-evidence$/), module: "KpiMonitoring", action: "ingest" },
  { id: "kpi:team-task-event", method: "POST", pattern: GuardRoutesMapSource.p(/^\/api-kpis\/facts\/team\/task-events$/), module: "KpiMonitoring", action: "ingest" },
  { id: "kpi:realtime-health", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-kpis\/realtime\/health$/), module: "KpiMonitoring", action: "view" },

  { id: "team-kpi:member-profile", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/kpi\/member-profile$/), module: "KpiMonitoring", action: "view" },
  { id: "team-kpi:task-completion-rate", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/kpi\/task-completion-rate$/), module: "KpiMonitoring", action: "view" },
  { id: "team-kpi:task-completion-rate-by-team", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/kpi\/task-completion-rate\/by-team$/), module: "KpiMonitoring", action: "view" },
  { id: "team-kpi:customer-satisfaction", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/kpi\/customer-satisfaction$/), module: "KpiMonitoring", action: "view" },
  { id: "team-kpi:top-overdue-holders", method: "GET", pattern: GuardRoutesMapSource.p(/^\/api-team-management\/kpi\/top-overdue-holders$/), module: "KpiMonitoring", action: "view" },

  // =========================================================================
  // COMMENTS ENGINE (PROTECTED WRITE + PIN OPS) — mounted: /api-comments
  // NEW ROUTES:
  //   POST /add
  //   PATCH /edit/:id
  //   DELETE /delete/:id
  //   PATCH /pin/:id
  //   PATCH /unpin/:id
  //   PATCH /pin-toggle/:id
  //
  // AccessMap: CommentEngine actions = view/create/editOwn/delOwn/moderate/pin
  // NOTE: unpin + pin-toggle are mapped to action "pin" (single permission).
  // =========================================================================
  { id: "comments:add", method: "POST", pattern: GuardRoutesMapSource.p(/^\/api-comments\/add\/?$/), module: "CommentEngine", action: "create" },
  { id: "comments:edit", method: "PATCH", pattern: GuardRoutesMapSource.p(/^\/api-comments\/edit\/[^/]+\/?$/), module: "CommentEngine", action: "editOwn" },
  { id: "comments:delete", method: "DELETE", pattern: GuardRoutesMapSource.p(/^\/api-comments\/delete\/[^/]+\/?$/), module: "CommentEngine", action: "delOwn" },

  { id: "comments:pin", method: "PATCH", pattern: GuardRoutesMapSource.p(/^\/api-comments\/pin\/[^/]+\/?$/), module: "CommentEngine", action: "pin" },
  { id: "comments:unpin", method: "PATCH", pattern: GuardRoutesMapSource.p(/^\/api-comments\/unpin\/[^/]+\/?$/), module: "CommentEngine", action: "pin" },
  { id: "comments:pin-toggle", method: "PATCH", pattern: GuardRoutesMapSource.p(/^\/api-comments\/pin-toggle\/[^/]+\/?$/), module: "CommentEngine", action: "pin" },
];

/**
 * Make this file a module so the `declare global` block is applied correctly
 * under moduleResolution: "NodeNext".
 */
export {};
