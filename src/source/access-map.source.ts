// Path: src/source/access-map.source.ts
// =============================================================================
// PropEase Access Matrix (SINGLE SOURCE OF TRUTH)
// -----------------------------------------------------------------------------
// ✅ Backend + Frontend shared (NO mongoose types)
// ✅ Hierarchical modules supported (e.g., TeamManagement.WorkItems)
// ✅ Short UI labels + rich descriptions
// ✅ Material icons for every module + action
// =============================================================================

/* ========================================================================== *
 * ACCESS MAP TYPES
 * ========================================================================== */

export interface AccessActionOption {
  id: string;               // machine key used in guard + DB
  label: string;            // SHORT UI label
  description?: string;     // longer explanation shown in UI tooltip/details
  icon?: string;            // Angular Material icon name (mat-icon)
}

export interface AccessModuleOption {
  module: string;           // machine key used in guard routes map
  label: string;            // SHORT UI label
  actions: ReadonlyArray<AccessActionOption>;
  description?: string;     // longer module explanation
  icon?: string;            // module icon (mat-icon)
}

/* ========================================================================== *
 * CANONICAL ACCESS MATRIX
 * ========================================================================== */

export const ACCESS_OPTIONS = [
  // ──────────────────────────────────────────────────────────────────────────
  // USERS
  // ──────────────────────────────────────────────────────────────────────────
  {
    module: "UserManagement",
    label: "Users",
    icon: "manage_accounts",
    description:
      "Identity and staff account management: create users, manage roles, and secure access.",
    actions: [
      { id: "view", label: "View", icon: "visibility", description: "Read user profiles and account metadata." },
      { id: "create", label: "Create", icon: "person_add", description: "Create new user accounts." },
      { id: "update", label: "Update", icon: "edit", description: "Update user profile details." },
      { id: "delete", label: "Delete", icon: "person_remove", description: "Delete user accounts (restricted)." },
      { id: "activate", label: "Activate", icon: "toggle_on", description: "Activate/deactivate user accounts." },
      { id: "resetPassword", label: "Reset PW", icon: "lock_reset", description: "Force reset password." },
      { id: "assignRole", label: "Roles", icon: "admin_panel_settings", description: "Assign roles & permissions (high-risk)." },
      { id: "export", label: "Export", icon: "file_download", description: "Export user lists for audits." },
      { id: "impersonate", label: "Impersonate", icon: "supervisor_account", description: "Support-only impersonation (audited)." },
    ] as const,
  },

  // ──────────────────────────────────────────────────────────────────────────
  // PROPERTIES
  // ──────────────────────────────────────────────────────────────────────────
  {
    module: "PropertyManagement",
    label: "Properties",
    icon: "apartment",
    description:
      "Property inventory: listings, units, amenities, documents, and assignments.",
    actions: [
      { id: "view", label: "View", icon: "visibility", description: "View properties and metadata." },
      { id: "create", label: "Create", icon: "add_business", description: "Create new properties/units." },
      { id: "update", label: "Update", icon: "edit", description: "Update property details." },
      { id: "delete", label: "Delete", icon: "delete", description: "Delete property records (restricted)." },
      { id: "assign", label: "Assign", icon: "how_to_reg", description: "Assign agent/owner/manager." },
      { id: "upload", label: "Upload", icon: "upload_file", description: "Upload property documents." },
      { id: "publish", label: "Publish", icon: "campaign", description: "Publish/unpublish listings." },
      { id: "configure", label: "Config", icon: "tune", description: "Manage amenities/status/rules." },
      { id: "export", label: "Export", icon: "file_download", description: "Export property reports." },
    ] as const,
  },

  // ──────────────────────────────────────────────────────────────────────────
  // TENANTS
  // ──────────────────────────────────────────────────────────────────────────
  {
    module: "TenantManagement",
    label: "Tenants",
    icon: "groups",
    description:
      "Tenant registry: onboarding, profiles, assignments, and communications.",
    actions: [
      { id: "view", label: "View", icon: "visibility", description: "View tenant profiles." },
      { id: "create", label: "Create", icon: "person_add", description: "Create tenant records." },
      { id: "update", label: "Update", icon: "edit", description: "Update tenant records." },
      { id: "delete", label: "Delete", icon: "delete", description: "Delete tenant records (restricted)." },
      { id: "assign", label: "Assign", icon: "domain_add", description: "Assign tenants to units." },
      { id: "upload", label: "Upload", icon: "upload_file", description: "Upload tenant documents." },
      { id: "sendNotification", label: "Notify", icon: "notifications_active", description: "Send tenant notifications." },
      { id: "export", label: "Export", icon: "file_download", description: "Export tenant lists/reports." },
    ] as const,
  },

  // ──────────────────────────────────────────────────────────────────────────
  // LEASES
  // ──────────────────────────────────────────────────────────────────────────
  {
    module: "LeaseManagement",
    label: "Leases",
    icon: "description",
    description:
      "Lease lifecycle: create, renew, terminate, approve, and manage documents.",
    actions: [
      { id: "view", label: "View", icon: "visibility", description: "View leases and terms." },
      { id: "create", label: "Create", icon: "note_add", description: "Create lease agreements." },
      { id: "update", label: "Update", icon: "edit", description: "Update leases (controlled)." },
      { id: "terminate", label: "Terminate", icon: "cancel", description: "Terminate leases." },
      { id: "renew", label: "Renew", icon: "autorenew", description: "Renew/extend leases." },
      { id: "upload", label: "Upload", icon: "upload_file", description: "Upload lease documents." },
      { id: "approve", label: "Approve", icon: "verified", description: "Approve lease activation/changes (audited)." },
      { id: "export", label: "Export", icon: "file_download", description: "Export lease reports." },
    ] as const,
  },

  // ──────────────────────────────────────────────────────────────────────────
  // COMPLAINTS
  // ──────────────────────────────────────────────────────────────────────────
  {
    module: "ComplaintsManagement",
    label: "Complaints",
    icon: "report_problem",
    description:
      "Complaints and service requests: intake, assign, resolve, and report.",
    actions: [
      { id: "view", label: "View", icon: "visibility", description: "View complaints and history." },
      { id: "create", label: "Create", icon: "add_comment", description: "Create complaints/requests." },
      { id: "update", label: "Update", icon: "edit", description: "Update complaint details/status." },
      { id: "delete", label: "Delete", icon: "delete", description: "Delete complaints (restricted)." },
      { id: "assign", label: "Assign", icon: "assignment_ind", description: "Assign complaint to team/tech." },
      { id: "close", label: "Close", icon: "task_alt", description: "Close complaint after resolution." },
      { id: "reopen", label: "Reopen", icon: "restart_alt", description: "Reopen complaint if needed." },
      { id: "export", label: "Export", icon: "file_download", description: "Export complaints SLA reports." },
    ] as const,
  },

  // ──────────────────────────────────────────────────────────────────────────
  // PAYMENTS
  // ──────────────────────────────────────────────────────────────────────────
  {
    module: "PaymentBilling",
    label: "Payments",
    icon: "payments",
    description:
      "Billing and payments: invoices, collections, approvals, refunds, exports.",
    actions: [
      { id: "view", label: "View", icon: "visibility", description: "View invoices, balances, payment history." },
      { id: "create", label: "Invoice", icon: "receipt_long", description: "Create invoices/billing statements." },
      { id: "update", label: "Update", icon: "edit", description: "Update invoice details (controlled)." },
      { id: "delete", label: "Delete", icon: "delete", description: "Delete invoices (restricted)." },
      { id: "recordPayment", label: "Record", icon: "point_of_sale", description: "Record manual payments." },
      { id: "refund", label: "Refund", icon: "currency_exchange", description: "Issue refunds (audited)." },
      { id: "reverse", label: "Reverse", icon: "undo", description: "Reverse posted transactions (audited)." },
      { id: "approve", label: "Approve", icon: "verified", description: "Approve payouts/settlements (high-risk)." },
      { id: "export", label: "Export", icon: "file_download", description: "Export payment/arrears reports." },
      { id: "configure", label: "Config", icon: "tune", description: "Configure fees, taxes, payment rules." },
    ] as const,
  },

  // ──────────────────────────────────────────────────────────────────────────
  // TEAM MANAGEMENT — TEAMS
  // ──────────────────────────────────────────────────────────────────────────
  {
    module: "TeamManagement.Teams",
    label: "Teams",
    icon: "groups_3",
    description:
      "Team governance: teams, membership, captain/lead, and team controls.",
    actions: [
      { id: "view", label: "View", icon: "visibility", description: "View teams and members." },
      { id: "create", label: "Create", icon: "group_add", description: "Create teams." },
      { id: "update", label: "Update", icon: "edit", description: "Update team settings." },
      { id: "delete", label: "Delete", icon: "delete", description: "Delete teams (restricted)." },
      { id: "assignMembers", label: "Members", icon: "how_to_reg", description: "Add/remove members; manage roles." },
      { id: "assignCaptain", label: "Captain", icon: "military_tech", description: "Assign/replace captain/lead." },
      { id: "upload", label: "Upload", icon: "upload_file", description: "Upload team documents." },
      { id: "generate", label: "Reports", icon: "summarize", description: "Generate team reports." },
      { id: "lock", label: "Lock", icon: "lock", description: "Lock team access." },
      { id: "unlock", label: "Unlock", icon: "lock_open", description: "Unlock team access." },
      { id: "export", label: "Export", icon: "file_download", description: "Export team reports." },
      { id: "monitor", label: "Monitor", icon: "monitor_heart", description: "Monitor team dashboard performance." },
    ] as const,
  },

  // ──────────────────────────────────────────────────────────────────────────
  // TEAM MANAGEMENT — WORK ITEMS
  // ──────────────────────────────────────────────────────────────────────────
  {
    module: "TeamManagement.WorkItems",
    label: "Work Items",
    icon: "assignment",
    description:
      "Task execution: create, assign, status/priority, evidence, approvals.",
    actions: [
      { id: "view", label: "View", icon: "visibility", description: "View work items (scope enforced)." },
      { id: "create", label: "Create", icon: "add_task", description: "Create tasks under a team." },
      { id: "update", label: "Update", icon: "edit", description: "Update task fields and schedules." },
      { id: "delete", label: "Delete", icon: "delete", description: "Delete tasks (restricted)." },
      { id: "assign", label: "Assign", icon: "assignment_ind", description: "Assign/reassign tasks." },
      { id: "changeStatus", label: "Status", icon: "published_with_changes", description: "Change status with workflow rules." },
      { id: "prioritize", label: "Priority", icon: "priority_high", description: "Set priority." },
      { id: "uploadEvidence", label: "Evidence", icon: "attach_file", description: "Upload task evidence/attachments." },
      { id: "requestApproval", label: "Request", icon: "mark_email_read", description: "Request completion approval." },
      { id: "approveCompletion", label: "Approve", icon: "verified", description: "Approve completion (audited)." },
      { id: "rejectCompletion", label: "Reject", icon: "block", description: "Reject completion with reasons." },
      { id: "reopen", label: "Reopen", icon: "restart_alt", description: "Reopen task after verification failure." },
      { id: "monitor", label: "Monitor", icon: "monitor_heart", description: "Monitor progress, delays, throughput." },
      { id: "export", label: "Export", icon: "file_download", description: "Export task performance reports." },
    ] as const,
  },

  // ──────────────────────────────────────────────────────────────────────────
  // TEAM MANAGEMENT — WORK EVENTS
  // ──────────────────────────────────────────────────────────────────────────
  {
    module: "TeamManagement.WorkEvents",
    label: "Work Events",
    icon: "event_note",
    description:
      "Operations events: incidents, site logs, meetings, safety events.",
    actions: [
      { id: "view", label: "View", icon: "visibility", description: "View events (scope enforced)." },
      { id: "create", label: "Create", icon: "event_available", description: "Create event records." },
      { id: "update", label: "Update", icon: "edit", description: "Update event details." },
      { id: "delete", label: "Delete", icon: "delete", description: "Delete events (restricted)." },
      { id: "assign", label: "Assign", icon: "assignment_ind", description: "Assign owners/responders." },
      { id: "acknowledge", label: "Ack", icon: "done_all", description: "Acknowledge responsibility." },
      { id: "resolve", label: "Resolve", icon: "task_alt", description: "Resolve/close after validation." },
      { id: "reopen", label: "Reopen", icon: "restart_alt", description: "Reopen if unresolved." },
      { id: "uploadEvidence", label: "Evidence", icon: "attach_file", description: "Upload event evidence." },
      { id: "monitor", label: "Monitor", icon: "monitor_heart", description: "Monitor patterns/escalations." },
      { id: "export", label: "Export", icon: "file_download", description: "Export event logs." },
    ] as const,
  },

  // ──────────────────────────────────────────────────────────────────────────
  // COMMENT ENGINE
  // ──────────────────────────────────────────────────────────────────────────
  {
    module: "CommentEngine",
    label: "Comments",
    icon: "comment",
    description:
      "Universal comments: cross-module notes, attachments, moderation.",
    actions: [
      { id: "view", label: "View", icon: "visibility", description: "View comments by audience and scope." },
      { id: "create", label: "Create", icon: "add_comment", description: "Create new comments/replies." },
      { id: "updateOwn", label: "Edit Own", icon: "edit_note", description: "Edit own comments only." },
      { id: "deleteOwn", label: "Del Own", icon: "delete_forever", description: "Delete own comments only." },
      { id: "moderate", label: "Mod", icon: "gavel", description: "Moderate all comments (audited)." },
      { id: "upload", label: "Upload", icon: "attach_file", description: "Upload comment attachments." },
      {
        id: "pin",
        label: "Pin",
        icon: "push_pin",
        description: "Pin comments to highlight important information.",
      },
      {
        id: "unpin",
        label: "Unpin",
        icon: "push_pin",
        description: "Remove pin from pinned comments.",
      },
      {
        id: "pinToggle",
        label: "Pin Toggle",
        icon: "push_pin",
        description:
          "Toggle pin state (used by UI quick actions).",
      },
    ] as const,
  },

  // ──────────────────────────────────────────────────────────────────────────
  // KPI MONITORING
  // ──────────────────────────────────────────────────────────────────────────
  {
    module: "KpiMonitoring",
    label: "KPIs",
    icon: "insights",
    description:
      "KPI dashboards, ingestion, rebuilds, exports, and alert rules.",
    actions: [
      { id: "view", label: "View", icon: "dashboard", description: "View KPI dashboards and metrics." },
      { id: "create", label: "Ingest", icon: "input", description: "Submit KPI facts (ingest pipeline)." },
      { id: "update", label: "Rebuild", icon: "autorenew", description: "Recompute KPI projections." },
      { id: "export", label: "Export", icon: "file_download", description: "Export KPI snapshots/trends." },
      { id: "configure", label: "Config", icon: "tune", description: "Configure KPI thresholds and alerts." },
    ] as const,
  },

  // ──────────────────────────────────────────────────────────────────────────
  // AUDIT LOGS
  // ──────────────────────────────────────────────────────────────────────────
  {
    module: "AuditLogs",
    label: "Audit",
    icon: "policy",
    description:
      "Audit logs: view/search/export and monitor suspicious activity.",
    actions: [
      { id: "view", label: "View", icon: "visibility", description: "View audit logs (auth, changes, approvals)." },
      { id: "filter", label: "Filter", icon: "filter_alt", description: "Filter/search logs." },
      { id: "export", label: "Export", icon: "file_download", description: "Export logs for compliance." },
      { id: "monitor", label: "Monitor", icon: "shield", description: "Monitor suspicious patterns." },
    ] as const,
  },

  // ──────────────────────────────────────────────────────────────────────────
  // SYSTEM SETTINGS
  // ──────────────────────────────────────────────────────────────────────────
  {
    module: "SystemSettings",
    label: "Settings",
    icon: "settings",
    description:
      "System configuration: roles, integrations, backups, preferences.",
    actions: [
      { id: "configure", label: "Config", icon: "tune", description: "Configure system preferences." },
      { id: "manageRoles", label: "Roles", icon: "admin_panel_settings", description: "Manage roles & permissions (high-risk)." },
      { id: "manageIntegrations", label: "Integrations", icon: "hub", description: "Manage external integrations." },
      { id: "backupRestore", label: "Backup", icon: "backup", description: "Backup/restore system (high-risk)." },
    ] as const,
  },

  // ──────────────────────────────────────────────────────────────────────────
  // ✅ ACCESS CONTROL (NEW — as requested)
  // ──────────────────────────────────────────────────────────────────────────
  {
    module: "AccessControl",
    label: "Access",
    icon: "security",
    description:
      "Permission administration: grant/revoke user access, set restrictions, control sessions. " +
      "This module is REQUIRED to allow a user to change another user's permissions.",
    actions: [
      {
        id: "grantAccess",
        label: "Grant",
        icon: "key",
        description: "Grant permissions to another user (high-risk, audited).",
      },
      {
        id: "revokeAccess",
        label: "Revoke",
        icon: "vpn_key_off",
        description: "Revoke permissions from another user (high-risk, audited).",
      },
      {
        id: "setRestrictions",
        label: "Restrict",
        icon: "do_not_disturb_on",
        description:
          "Apply restrictions such as read-only, module lock, or time-based limits.",
      },
      {
        id: "controlSessions",
        label: "Sessions",
        icon: "phonelink_lock",
        description:
          "Terminate / force re-login / manage active sessions for security incidents.",
      },
      {
        id: "auditChanges",
        label: "Audit",
        icon: "fact_check",
        description:
          "View access-change history (who changed what, when, from where).",
      },
    ] as const,
  },


  // ──────────────────────────────────────────────────────────────────────────
  // NOTIFICATION CENTER
  // ──────────────────────────────────────────────────────────────────────────
  {
    module: "NotificationCenter",
    label: "Notifications",
    icon: "notifications",
    description:
      "System and user notifications: alerts, events, system messages, and recycle bin.",

    actions: [
      {
        id: "view",
        label: "View",
        icon: "visibility",
        description: "View notifications and notification dashboards.",
      },

      {
        id: "markRead",
        label: "Mark Read",
        icon: "done_all",
        description: "Mark notifications as read or unread.",
      },

      {
        id: "delete",
        label: "Delete",
        icon: "delete",
        description: "Delete notifications (soft-delete to recycle bin).",
      },

      {
        id: "restore",
        label: "Restore",
        icon: "restore",
        description: "Restore deleted notifications from recycle bin.",
      },

      {
        id: "clear",
        label: "Clear All",
        icon: "clear_all",
        description: "Bulk clear notifications (user scope).",
      },

      {
        id: "broadcast",
        label: "Broadcast",
        icon: "campaign",
        description: "Send system-wide or role-based notifications.",
      },

      {
        id: "configure",
        label: "Configure",
        icon: "tune",
        description: "Configure notification channels and preferences.",
      },
    ] as const,
  },
] as const satisfies ReadonlyArray<AccessModuleOption>;

/* ========================================================================== *
 * DERIVED STRICT KEYS
 * ========================================================================== */

export type AccessModuleKey = ( typeof ACCESS_OPTIONS )[ number ][ "module" ];
export type AccessActionKey = ( typeof ACCESS_OPTIONS )[ number ][ "actions" ][ number ][ "id" ];
