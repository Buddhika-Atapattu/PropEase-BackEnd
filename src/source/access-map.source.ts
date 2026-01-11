// Path: src/source/access-map.source.ts

import type { User } from "../models/user.model";

// ─────────────────────────────────────────────────────────────
// Core types for access map
// ─────────────────────────────────────────────────────────────

/**
 * One action inside a module.
 * - `id`  → machine-readable key used in backend (guard, DB).
 * - `label` → human-readable label for UI (role editor, etc.).
 */
export interface AccessActionOption {
  id: string;
  label: string;
}

/**
 * One module entry in the access matrix.
 * - `module` → machine-readable key (must match GUARD_ROUTES.module).
 * - `label`  → human-readable name shown in UI.
 * - `actions` → list of supported actions.
 */
export interface AccessModuleOption {
  module: string;
  label: string;
  actions: ReadonlyArray<AccessActionOption>;
}


// ─────────────────────────────────────────────────────────────
// Derived types (used by guard + models)
// ─────────────────────────────────────────────────────────────

export type AccessModuleKey = ( typeof ACCESS_OPTIONS )[ number ][ "module" ];
export type AccessActionKey =
  ( typeof ACCESS_OPTIONS )[ number ][ "actions" ][ number ][ "id" ];

/**
 * One permission block stored for a user:
 *  - module  → which module (e.g. "UserManagement")
 *  - actions → which actions in that module (e.g. ["view", "create"])
 *
 * This should be reused in user.model.ts for `user.access.permissions`.
 */
export interface PermissionEntry {
  module: AccessModuleKey;
  actions: AccessActionKey[];
}

/**
 * Convenience composite type if you want a richer user object
 * containing resolved access control.
 */
export type UserWithAccess = User & {
  accessControl?: PermissionEntry[];
};


// ─────────────────────────────────────────────────────────────
// Canonical access matrix (SINGLE SOURCE OF TRUTH)
//  - module: used by ApiGuard + routers
//  - label : for UI
//  - actions.id : used by ApiGuard + PermissionEntry
//  - actions.label : for UI
// ─────────────────────────────────────────────────────────────

export const ACCESS_OPTIONS = [
  // ─────────────── User Management ───────────────
  {
    module: "UserManagement",
    label: "User Management",
    actions: [
      { id: "view", label: "View users" },
      { id: "create", label: "Create users" },
      { id: "update", label: "Update users" },
      { id: "delete", label: "Delete users" },
      { id: "activate", label: "Activate / deactivate users" },
      { id: "resetPassword", label: "Reset passwords" },
      { id: "assignRole", label: "Assign roles & access" },
    ] as const,
  },

  // ─────────────── Property Management ───────────────
  {
    module: "PropertyManagement",
    label: "Property Management",
    actions: [
      { id: "view", label: "View properties" },
      { id: "create", label: "Create properties" },
      { id: "update", label: "Update properties" },
      { id: "delete", label: "Delete properties" },
      { id: "assign", label: "Assign agent / owner" },
      { id: "upload", label: "Upload property documents" },
      { id: "configure", label: "Manage amenities & status" },
    ] as const,
  },

  // ─────────────── Tenant Management ───────────────
  {
    module: "TenantManagement",
    label: "Tenant Management",
    actions: [
      { id: "view", label: "View tenants / leases / complaints" },
      { id: "create", label: "Create tenants / leases / complaints" },
      { id: "update", label: "Update tenants / leases / complaints" },
      { id: "delete", label: "Remove tenants / complaints" },
      { id: "assign", label: "Assign tenant to units" },
      { id: "upload", label: "Upload lease & payment documents" },
      { id: "sendNotification", label: "Send notifications / reminders" },
      { id: "recordPayment", label: "Record manual payments" },
      { id: "viewHistory", label: "View lease & payment history" },
      { id: "terminate", label: "Terminate leases" },
      { id: "renew", label: "Renew / extend leases" },
    ] as const,
  },

  // ─────────────── Team Management ───────────────
  {
    module: "TeamManagement",
    label: "Team Management",
    actions: [
      { id: "view", label: "View teams" },
      { id: "create", label: "Create teams" },
      { id: "update", label: "Update teams" },
      { id: "delete", label: "Delete teams" },
      { id: "assign", label: "Assign / reassign members & tasks" },
      { id: "upload", label: "View / upload team documents" },
      { id: "monitor", label: "Monitor performance & activity" },
      { id: "generate", label: "Generate team reports" },
      { id: "lock", label: "Lock access" },
      { id: "unlock", label: "Unlock access" },
    ] as const,
  },

  // ─────────────── Owner Management ───────────────
  {
    module: "OwnerManagement",
    label: "Owner Management",
    actions: [
      { id: "view", label: "View owners" },
      { id: "create", label: "Create owners" },
      { id: "update", label: "Update owners" },
      { id: "delete", label: "Delete owners" },
      { id: "assign", label: "Assign owners to properties" },
      { id: "upload", label: "View / upload owner documents" },
    ] as const,
  },

  // ─────────────── Agent Management ───────────────
  {
    module: "AgentManagement",
    label: "Agent Management",
    actions: [
      { id: "view", label: "View agents" },
      { id: "create", label: "Create agents" },
      { id: "update", label: "Update agents" },
      { id: "delete", label: "Delete agents" },
      { id: "assign", label: "Assign properties to agents" },
      { id: "monitor", label: "Track agent performance" },
    ] as const,
  },

  // ─────────────── Lease Management ───────────────
  {
    module: "LeaseManagement",
    label: "Lease Management",
    actions: [
      { id: "view", label: "View leases" },
      { id: "create", label: "Create leases" },
      { id: "update", label: "Update leases" },
      { id: "terminate", label: "Terminate leases" },
      { id: "renew", label: "Renew / extend leases" },
      { id: "upload", label: "Upload lease documents" },
      { id: "monitor", label: "Track lease expiry" },
    ] as const,
  },

  // ─────────────── Payment & Billing ───────────────
  {
    module: "PaymentBilling",
    label: "Payment & Billing",
    actions: [
      { id: "view", label: "View payments & balances" },
      { id: "recordPayment", label: "Record manual payments" },
      { id: "create", label: "Generate invoices" },
      { id: "update", label: "Update invoices" },
      { id: "delete", label: "Delete invoices" },
      { id: "export", label: "Export payment reports" },
      { id: "configure", label: "Configure payment rates & rules" },
    ] as const,
  },

  // ─────────────── Maintenance Requests ───────────────
  {
    module: "MaintenanceRequests",
    label: "Maintenance Requests",
    actions: [
      { id: "view", label: "View maintenance requests" },
      { id: "create", label: "Create maintenance requests" },
      { id: "update", label: "Update request status" },
      { id: "assign", label: "Assign technicians / teams" },
      { id: "upload", label: "Upload maintenance documents" },
      { id: "close", label: "Close requests" },
      { id: "monitor", label: "Track maintenance progress & costs" },
      { id: "generate", label: "Generate maintenance reports" },
    ] as const,
  },

  // ─────────────── Compliance Management ───────────────
  {
    module: "ComplianceManagement",
    label: "Compliance Management",
    actions: [
      { id: "view", label: "View compliance status" },
      { id: "create", label: "Upload certificates / new records" },
      { id: "update", label: "Update compliance records" },
      { id: "delete", label: "Delete compliance records" },
      { id: "configure", label: "Set compliance reminders" },
      { id: "sendNotification", label: "Notify parties" },
    ] as const,
  },

  // ─────────────── Document Management ───────────────
  {
    module: "DocumentManagement",
    label: "Document Management",
    actions: [
      { id: "upload", label: "Upload documents" },
      { id: "download", label: "Download documents" },
      { id: "delete", label: "Delete documents" },
      { id: "share", label: "Share documents" },
      { id: "configure", label: "Categorise documents" },
      { id: "view", label: "View document metadata" },
    ] as const,
  },

  // ─────────────── Notification Center / Comms ───────────────
  {
    module: "NotificationCenter",
    label: "Communication & Notification",
    actions: [
      { id: "view", label: "View notifications & message logs" },
      { id: "create", label: "Create / send notifications" },
      { id: "sendNotification", label: "Broadcast notifications" },
      { id: "configure", label: "Customise templates & schedules" },
      { id: "restore", label: "Restore via notifications" },
      { id: "permanentDelete", label: "Permanently delete via notifications" },
    ] as const,
  },

  // ─────────────── Report Management ───────────────
  {
    module: "ReportManagement",
    label: "Report Management",
    actions: [
      { id: "view", label: "View reports" },
      { id: "generate", label: "Generate financial / occupancy reports" },
      { id: "export", label: "Export / download reports" },
      { id: "configure", label: "Customise report templates" },
    ] as const,
  },

  // ─────────────── Audit Logs ───────────────
  {
    module: "AuditLogs",
    label: "Audit Logs",
    actions: [
      { id: "view", label: "View logs & activity" },
      { id: "filter", label: "Filter / search logs" },
      { id: "export", label: "Export logs" },
      { id: "monitor", label: "Monitor logins & role changes" },
    ] as const,
  },

  // ─────────────── Tracking & Audit (API tracking module) ───────────────
  {
    module: "TrackingAndAudit",
    label: "Tracking & Audit (System Activity)",
    actions: [
      { id: "view", label: "View tracking data & dashboards" },
      { id: "export", label: "Export tracking data" },
    ] as const,
  },

  // ─────────────── Dashboard & Analytics ───────────────
  {
    module: "DashboardAnalytics",
    label: "Dashboard & Analytics",
    actions: [
      { id: "view", label: "View analytics dashboards" },
      { id: "configure", label: "Customise widgets" },
      { id: "download", label: "Download analytics snapshots" },
      { id: "monitor", label: "View realtime analytics" },
    ] as const,
  },

  // ─────────────── System Settings ───────────────
  {
    module: "SystemSettings",
    label: "System Settings",
    actions: [
      { id: "configure", label: "Configure system preferences" },
      { id: "manageRoles", label: "Manage roles & permissions" },
      { id: "manageIntegrations", label: "Manage external integrations" },
      { id: "backupRestore", label: "Backup & restore system" },
    ] as const,
  },

  // ─────────────── Support & Helpdesk ───────────────
  {
    module: "SupportHelpdesk",
    label: "Support & Helpdesk",
    actions: [
      { id: "view", label: "View support tickets" },
      { id: "update", label: "Respond / update tickets" },
      { id: "assign", label: "Assign support staff" },
      { id: "close", label: "Close tickets" },
      { id: "sendNotification", label: "Send satisfaction surveys" },
    ] as const,
  },

  // ─────────────── Access Control ───────────────
  {
    module: "AccessControl",
    label: "Access Control",
    actions: [
      { id: "grantAccess", label: "Grant access" },
      { id: "revokeAccess", label: "Revoke access" },
      { id: "setRestrictions", label: "Set access restrictions" },
      { id: "controlSessions", label: "Control active sessions" },
    ] as const,
  },
  // ─────────────── File Management ───────────────
  {
    module: "FileManagement",
    label: "File Management",
    actions: [
      { id: "view", label: "View files & upload history" },
      { id: "create", label: "Upload / receive files" },
      { id: "update", label: "Rename / move / tag files" },
      { id: "delete", label: "Delete files" },
      { id: "convert", label: "Convert files (e.g. to PDF)" },
      { id: "download", label: "Download files" },
      { id: "share", label: "Share files or links" },
    ] as const,
  },
  // ─────────────── Places & Maps ───────────────
  {
    module: "PlacesAndMaps",
    label: "Places & Maps",
    actions: [
      { id: "view", label: "View place results & suggestions" },
      { id: "autocomplete", label: "Use autocomplete & lookup APIs" },
      { id: "configure", label: "Configure map / place providers & keys" },
    ] as const,
  },

  // ─────────────── KPI Management ───────────────
  {
    module: "KpiManagement",
    label: "KPI Management",
    actions: [
      { id: "view", label: "View KPI dashboards & health" },
      { id: "create", label: "Submit KPI facts (ingest)" },
      { id: "update", label: "Recompute / rebuild KPI projections" }, // optional (future)
    ] as const,
  },


] as const satisfies ReadonlyArray<AccessModuleOption>;
