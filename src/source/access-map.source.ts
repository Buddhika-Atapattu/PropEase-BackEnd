// Path: src/source/access-map.source.ts
// =============================================================================
// PropEase Access Matrix (SINGLE SOURCE OF TRUTH) — ENTERPRISE FULL SCALE
// -----------------------------------------------------------------------------
// ✅ Backend + Frontend shared (NO mongoose types)
// ✅ Hierarchical modules supported (e.g., TeamManagement.WorkItems)
// ✅ Max 6 actions per module (UI-friendly)
// ✅ Action id + label <= 30 chars (UI-safe)
// ✅ Business-grade coverage: Org/Branch/Employee/HR, Finance, Compliance, SecOps,
//    DataGov, Backups, Integrations, Audits, Monitoring
// =============================================================================

/* ========================================================================== *
 * ACCESS MAP TYPES
 * ========================================================================== */

export interface AccessActionOption {
  id: string;               // machine key used in guard + DB
  label: string;            // SHORT UI label (<= 30 chars)
  description?: string;     // longer explanation shown in UI tooltip/details
  icon?: string;            // Angular Material icon name (mat-icon)
}

export interface AccessModuleOption {
  module: string;           // machine key used in guard routes map
  label: string;            // SHORT UI label
  actions: ReadonlyArray<AccessActionOption>; // MAX 6 actions per module
  description?: string;     // longer module explanation
  icon?: string;            // module icon (mat-icon)
}

/* ========================================================================== *
 * CANONICAL ACCESS MATRIX (ENTERPRISE)
 * ========================================================================== */

export const ACCESS_OPTIONS = [
  // ──────────────────────────────────────────────────────────────────────────
  // ORGANIZATION / BRANCH / EMPLOYEES (Enterprise Core)
  // ──────────────────────────────────────────────────────────────────────────
  {
    module: "OrganizationManagement",
    label: "Organization",
    icon: "domain",
    description: "Company profile, departments, designations, org policies.",
    actions: [
      { id: "view", label: "View", icon: "visibility", description: "View org setup and policies." },
      { id: "manage", label: "Manage", icon: "edit", description: "Create/update org structures and metadata." },
      { id: "policy", label: "Policies", icon: "policy", description: "Manage policy sets and rules (audited)." },
      { id: "approve", label: "Approve", icon: "verified", description: "Approve high-risk org changes." },
      { id: "audit", label: "Audit", icon: "fact_check", description: "View change history and compliance info." },
      { id: "export", label: "Export", icon: "file_download", description: "Export org reports and structures." },
    ] as const,
  },
  {
    module: "BranchManagement",
    label: "Branches",
    icon: "location_city",
    description: "Branch registry, branch managers, branch-level policy overrides.",
    actions: [
      { id: "view", label: "View", icon: "visibility" },
      { id: "manage", label: "Manage", icon: "edit" },
      { id: "assign", label: "Assign", icon: "how_to_reg", description: "Assign branch manager / members." },
      { id: "policy", label: "Policies", icon: "policy", description: "Branch overrides & rules." },
      { id: "audit", label: "Audit", icon: "fact_check" },
      { id: "export", label: "Export", icon: "file_download" },
    ] as const,
  },
  {
    module: "EmployeeManagement",
    label: "Employees",
    icon: "badge",
    description: "Employee records linked to users: lifecycle, documents, assignments.",
    actions: [
      { id: "view", label: "View", icon: "visibility" },
      { id: "register", label: "Register", icon: "person_add", description: "Register employee (link or create user)." },
      { id: "manage", label: "Manage", icon: "edit", description: "Update employment details and records." },
      { id: "assign", label: "Assign", icon: "how_to_reg", description: "Assign branch/department/supervisor." },
      { id: "audit", label: "Audit", icon: "fact_check", description: "Employee change history (audited)." },
      { id: "export", label: "Export", icon: "file_download" },
    ] as const,
  },

  // ──────────────────────────────────────────────────────────────────────────
  // HR MANAGEMENT (Full Scale - MBO/KPI Ready)
  // ──────────────────────────────────────────────────────────────────────────
  {
    module: "HRManagement",
    label: "HR",
    icon: "people",
    description: "HR operations: cycles, scorecards, reviews, governance.",
    actions: [
      { id: "view", label: "View", icon: "visibility" },
      { id: "manage", label: "Manage", icon: "edit" },
      { id: "scorecards", label: "Scorecards", icon: "insights", description: "MBO/KPI mapping to employees." },
      { id: "reviews", label: "Reviews", icon: "rate_review", description: "Performance reviews workflow." },
      { id: "policy", label: "Policies", icon: "policy", description: "HR policies and rules." },
      { id: "export", label: "Export", icon: "file_download" },
    ] as const,
  },
  {
    module: "HR.Attendance",
    label: "Attendance",
    icon: "schedule",
    description: "Attendance logs, shifts, overtime, exceptions.",
    actions: [
      { id: "view", label: "View", icon: "visibility" },
      { id: "manage", label: "Manage", icon: "edit" },
      { id: "capture", label: "Capture", icon: "qr_code_scanner" },
      { id: "approve", label: "Approve", icon: "verified" },
      { id: "audit", label: "Audit", icon: "fact_check" },
      { id: "export", label: "Export", icon: "file_download" },
    ] as const,
  },
  {
    module: "HR.Leave",
    label: "Leave",
    icon: "beach_access",
    description: "Leave policies, requests, approvals, balances.",
    actions: [
      { id: "view", label: "View", icon: "visibility" },
      { id: "request", label: "Request", icon: "add" },
      { id: "approve", label: "Approve", icon: "verified" },
      { id: "manage", label: "Manage", icon: "edit" },
      { id: "policy", label: "Policies", icon: "policy" },
      { id: "export", label: "Export", icon: "file_download" },
    ] as const,
  },
  {
    module: "HR.Payroll",
    label: "Payroll",
    icon: "request_quote",
    description: "Payroll inputs, runs, approvals, payslips (high-risk).",
    actions: [
      { id: "view", label: "View", icon: "visibility" },
      { id: "inputs", label: "Inputs", icon: "tune" },
      { id: "run", label: "Run", icon: "play_circle" },
      { id: "approve", label: "Approve", icon: "verified" },
      { id: "audit", label: "Audit", icon: "fact_check" },
      { id: "export", label: "Export", icon: "file_download" },
    ] as const,
  },
  {
    module: "HR.Recruitment",
    label: "Recruitment",
    icon: "person_search",
    description: "Vacancies, applicants, interviews, offers.",
    actions: [
      { id: "view", label: "View", icon: "visibility" },
      { id: "manage", label: "Manage", icon: "edit" },
      { id: "pipeline", label: "Pipeline", icon: "schema" },
      { id: "offer", label: "Offer", icon: "assignment_turned_in" },
      { id: "audit", label: "Audit", icon: "fact_check" },
      { id: "export", label: "Export", icon: "file_download" },
    ] as const,
  },
  {
    module: "HR.Training",
    label: "Training",
    icon: "school",
    description: "Training plans, certifications, tracking.",
    actions: [
      { id: "view", label: "View", icon: "visibility" },
      { id: "manage", label: "Manage", icon: "edit" },
      { id: "assign", label: "Assign", icon: "how_to_reg" },
      { id: "certify", label: "Certify", icon: "workspace_premium" },
      { id: "monitor", label: "Monitor", icon: "monitor_heart" },
      { id: "export", label: "Export", icon: "file_download" },
    ] as const,
  },

  // ──────────────────────────────────────────────────────────────────────────
  // USERS / ACCESS CONTROL / SECURITY
  // ──────────────────────────────────────────────────────────────────────────
  {
    module: "UserManagement",
    label: "Users",
    icon: "manage_accounts",
    description: "Identity, accounts, roles, and secure access.",
    actions: [
      { id: "view", label: "View", icon: "visibility" },
      { id: "create", label: "Create", icon: "person_add" },
      { id: "update", label: "Update", icon: "edit" },
      { id: "disable", label: "Disable", icon: "toggle_off", description: "Activate/deactivate accounts." },
      { id: "roles", label: "Roles", icon: "admin_panel_settings" },
      { id: "export", label: "Export", icon: "file_download" },
    ] as const,
  },
  {
    module: "AccessControl",
    label: "Access",
    icon: "security",
    description: "Grant/revoke permissions, restrictions, session controls.",
    actions: [
      { id: "view", label: "View", icon: "visibility" },
      { id: "grant", label: "Grant", icon: "key" },
      { id: "revoke", label: "Revoke", icon: "vpn_key_off" },
      { id: "restrict", label: "Restrict", icon: "do_not_disturb_on" },
      { id: "sessions", label: "Sessions", icon: "phonelink_lock" },
      { id: "audit", label: "Audit", icon: "fact_check" },
    ] as const,
  },
  {
    module: "SecurityOps",
    label: "SecOps",
    icon: "shield",
    description: "Security monitoring, incident response, enforcement.",
    actions: [
      { id: "view", label: "View", icon: "visibility" },
      { id: "monitor", label: "Monitor", icon: "monitor_heart" },
      { id: "enforce", label: "Enforce", icon: "gpp_good", description: "Lockdown / block / force policies." },
      { id: "incidents", label: "Incidents", icon: "report" },
      { id: "audit", label: "Audit", icon: "fact_check" },
      { id: "export", label: "Export", icon: "file_download" },
    ] as const,
  },

  // ──────────────────────────────────────────────────────────────────────────
  // PROPERTY / TENANT / LEASE / COMPLAINTS (Core Real Estate ERP)
  // ──────────────────────────────────────────────────────────────────────────
  {
    module: "PropertyManagement",
    label: "Properties",
    icon: "apartment",
    description: "Property inventory, units, docs, publishing.",
    actions: [
      { id: "view", label: "View", icon: "visibility" },
      { id: "manage", label: "Manage", icon: "edit" },
      { id: "assign", label: "Assign", icon: "how_to_reg" },
      { id: "publish", label: "Publish", icon: "campaign" },
      { id: "audit", label: "Audit", icon: "fact_check" },
      { id: "export", label: "Export", icon: "file_download" },
    ] as const,
  },
  {
    module: "TenantManagement",
    label: "Tenants",
    icon: "groups",
    description: "Tenant onboarding, profile, assignment, documents.",
    actions: [
      { id: "view", label: "View", icon: "visibility" },
      { id: "manage", label: "Manage", icon: "edit" },
      { id: "assign", label: "Assign", icon: "domain_add" },
      { id: "notify", label: "Notify", icon: "notifications_active" },
      { id: "audit", label: "Audit", icon: "fact_check" },
      { id: "export", label: "Export", icon: "file_download" },
    ] as const,
  },
  {
    module: "LeaseManagement",
    label: "Leases",
    icon: "description",
    description: "Lease lifecycle, approvals, renewals, termination.",
    actions: [
      { id: "view", label: "View", icon: "visibility" },
      { id: "manage", label: "Manage", icon: "edit" },
      { id: "workflow", label: "Workflow", icon: "published_with_changes" },
      { id: "approve", label: "Approve", icon: "verified" },
      { id: "audit", label: "Audit", icon: "fact_check" },
      { id: "export", label: "Export", icon: "file_download" },
    ] as const,
  },
  {
    module: "ComplaintsManagement",
    label: "Complaints",
    icon: "report_problem",
    description: "Service requests and complaints: assign, resolve, SLA.",
    actions: [
      { id: "view", label: "View", icon: "visibility" },
      { id: "manage", label: "Manage", icon: "edit" },
      { id: "assign", label: "Assign", icon: "assignment_ind" },
      { id: "workflow", label: "Workflow", icon: "published_with_changes" },
      { id: "audit", label: "Audit", icon: "fact_check" },
      { id: "export", label: "Export", icon: "file_download" },
    ] as const,
  },

  // ──────────────────────────────────────────────────────────────────────────
  // PAYMENTS / FINANCE (Business Perspective)
  // ──────────────────────────────────────────────────────────────────────────
  {
    module: "PaymentBilling",
    label: "Payments",
    icon: "payments",
    description: "Billing, invoices, collections, approvals, refunds.",
    actions: [
      { id: "view", label: "View", icon: "visibility" },
      { id: "invoice", label: "Invoice", icon: "receipt_long" },
      { id: "record", label: "Record", icon: "point_of_sale" },
      { id: "approve", label: "Approve", icon: "verified" },
      { id: "refund", label: "Refund", icon: "currency_exchange" },
      { id: "export", label: "Export", icon: "file_download" },
    ] as const,
  },
  {
    module: "Finance.Accounting",
    label: "Accounting",
    icon: "account_balance",
    description: "GL, journals, period close, controls (audit-ready).",
    actions: [
      { id: "view", label: "View", icon: "visibility" },
      { id: "post", label: "Post", icon: "post_add" },
      { id: "close", label: "Close", icon: "lock" },
      { id: "approve", label: "Approve", icon: "verified" },
      { id: "audit", label: "Audit", icon: "fact_check" },
      { id: "export", label: "Export", icon: "file_download" },
    ] as const,
  },
  {
    module: "Finance.Procurement",
    label: "Procurement",
    icon: "shopping_cart",
    description: "Purchase requests, POs, vendors, approvals.",
    actions: [
      { id: "view", label: "View", icon: "visibility" },
      { id: "request", label: "Request", icon: "add" },
      { id: "manage", label: "Manage", icon: "edit" },
      { id: "approve", label: "Approve", icon: "verified" },
      { id: "vendors", label: "Vendors", icon: "store" },
      { id: "export", label: "Export", icon: "file_download" },
    ] as const,
  },
  {
    module: "Finance.Treasury",
    label: "Treasury",
    icon: "savings",
    description: "Cash flow, bank settlement, approvals, audit logs.",
    actions: [
      { id: "view", label: "View", icon: "visibility" },
      { id: "manage", label: "Manage", icon: "edit" },
      { id: "settle", label: "Settle", icon: "sync_alt" },
      { id: "approve", label: "Approve", icon: "verified" },
      { id: "audit", label: "Audit", icon: "fact_check" },
      { id: "export", label: "Export", icon: "file_download" },
    ] as const,
  },

  // ──────────────────────────────────────────────────────────────────────────
  // TEAM MANAGEMENT (your Team Ops Engine)
  // ──────────────────────────────────────────────────────────────────────────
  {
    module: "TeamManagement.Teams",
    label: "Teams",
    icon: "groups_3",
    description: "Team governance: teams, members, captain, controls.",
    actions: [
      { id: "view", label: "View", icon: "visibility" },
      { id: "manage", label: "Manage", icon: "edit" },
      { id: "members", label: "Members", icon: "how_to_reg" },
      { id: "captain", label: "Captain", icon: "military_tech" },
      { id: "monitor", label: "Monitor", icon: "monitor_heart" },
      { id: "export", label: "Export", icon: "file_download" },
    ] as const,
  },
  {
    module: "TeamManagement.TeamTasks",
    label: "Team Tasks",
    icon: "task",
    description: "Team task lifecycle: assign, status, evidence, flow.",
    actions: [
      { id: "view", label: "View", icon: "visibility" },
      { id: "create", label: "Create", icon: "add_task" },
      { id: "update", label: "Update", icon: "edit" },
      { id: "assign", label: "Assign", icon: "assignment_ind" },
      { id: "workflow", label: "Workflow", icon: "published_with_changes" },
      { id: "evidence", label: "Evidence", icon: "attach_file" },
    ] as const,
  },
  {
    module: "TeamManagement.WorkItems",
    label: "Work Items",
    icon: "assignment",
    description: "Execution tasks: lifecycle, approvals, throughput.",
    actions: [
      { id: "view", label: "View", icon: "visibility" },
      { id: "manage", label: "Manage", icon: "edit" },
      { id: "assign", label: "Assign", icon: "assignment_ind" },
      { id: "workflow", label: "Workflow", icon: "published_with_changes" },
      { id: "approve", label: "Approve", icon: "verified" },
      { id: "export", label: "Export", icon: "file_download" },
    ] as const,
  },
  {
    module: "TeamManagement.WorkEvents",
    label: "Work Events",
    icon: "event_note",
    description: "Incidents, meetings, logs: assign, resolve, evidence.",
    actions: [
      { id: "view", label: "View", icon: "visibility" },
      { id: "manage", label: "Manage", icon: "edit" },
      { id: "assign", label: "Assign", icon: "assignment_ind" },
      { id: "workflow", label: "Workflow", icon: "published_with_changes" },
      { id: "evidence", label: "Evidence", icon: "attach_file" },
      { id: "export", label: "Export", icon: "file_download" },
    ] as const,
  },
  {
    module: "TeamManagement.MemberActivities",
    label: "Member Acts",
    icon: "timeline",
    description: "Member activity timeline: blockers, evidence, logs.",
    actions: [
      { id: "view", label: "View", icon: "visibility" },
      { id: "create", label: "Create", icon: "add" },
      { id: "update", label: "Update", icon: "edit" },
      { id: "blockers", label: "Blockers", icon: "report" },
      { id: "evidence", label: "Evidence", icon: "attach_file" },
      { id: "export", label: "Export", icon: "file_download" },
    ] as const,
  },
  {
    module: "TeamManagement.Milestones",
    label: "Milestones",
    icon: "flag",
    description: "Planning objects: priority, schedule, tags, evidence.",
    actions: [
      { id: "view", label: "View", icon: "visibility" },
      { id: "create", label: "Create", icon: "add" },
      { id: "update", label: "Update", icon: "edit" },
      { id: "workflow", label: "Workflow", icon: "published_with_changes" },
      { id: "tags", label: "Tags", icon: "sell" },
      { id: "evidence", label: "Evidence", icon: "attach_file" },
    ] as const,
  },

  // ──────────────────────────────────────────────────────────────────────────
  // COMMENT ENGINE (cross-module)
  // ──────────────────────────────────────────────────────────────────────────
  {
    module: "CommentEngine",
    label: "Comments",
    icon: "comment",
    description: "Universal comments: cross-module notes & moderation.",
    actions: [
      { id: "view", label: "View", icon: "visibility" },
      { id: "create", label: "Create", icon: "add_comment" },
      { id: "editOwn", label: "Edit Own", icon: "edit_note" },
      { id: "delOwn", label: "Del Own", icon: "delete_forever" },
      { id: "moderate", label: "Moderate", icon: "gavel" },
      { id: "pin", label: "Pin", icon: "push_pin" },
    ] as const,
  },

  // ──────────────────────────────────────────────────────────────────────────
  // KPI / AUDIT / COMPLIANCE / DATA GOVERNANCE / BACKUP
  // ──────────────────────────────────────────────────────────────────────────
  {
    module: "KpiMonitoring",
    label: "KPIs",
    icon: "insights",
    description: "Dashboards, ingestion, rebuilds, thresholds.",
    actions: [
      { id: "view", label: "View", icon: "dashboard" },
      { id: "ingest", label: "Ingest", icon: "input" },
      { id: "rebuild", label: "Rebuild", icon: "autorenew" },
      { id: "configure", label: "Config", icon: "tune" },
      { id: "alerts", label: "Alerts", icon: "notification_important" },
      { id: "export", label: "Export", icon: "file_download" },
    ] as const,
  },
  {
    module: "AuditLogs",
    label: "Audit",
    icon: "policy",
    description: "Audit logs: view/search/export, suspicious activity.",
    actions: [
      { id: "view", label: "View", icon: "visibility" },
      { id: "filter", label: "Filter", icon: "filter_alt" },
      { id: "investigate", label: "Investigate", icon: "manage_search" },
      { id: "alerts", label: "Alerts", icon: "notification_important" },
      { id: "export", label: "Export", icon: "file_download" },
      { id: "retain", label: "Retention", icon: "schedule" },
    ] as const,
  },
  {
    module: "Compliance",
    label: "Compliance",
    icon: "verified_user",
    description: "Controls, evidence, incidents, regulatory reporting.",
    actions: [
      { id: "view", label: "View", icon: "visibility" },
      { id: "controls", label: "Controls", icon: "rule" },
      { id: "evidence", label: "Evidence", icon: "attach_file" },
      { id: "incidents", label: "Incidents", icon: "report" },
      { id: "audit", label: "Audit", icon: "fact_check" },
      { id: "export", label: "Export", icon: "file_download" },
    ] as const,
  },
  {
    module: "DataGovernance",
    label: "Data Gov",
    icon: "database",
    description: "Retention, privacy, export controls, quality rules.",
    actions: [
      { id: "view", label: "View", icon: "visibility" },
      { id: "privacy", label: "Privacy", icon: "privacy_tip" },
      { id: "retain", label: "Retention", icon: "schedule" },
      { id: "quality", label: "Quality", icon: "fact_check" },
      { id: "export", label: "Export", icon: "file_download" },
      { id: "audit", label: "Audit", icon: "policy" },
    ] as const,
  },
  {
    module: "BackupRecovery",
    label: "Backup/DR",
    icon: "backup",
    description: "Backups, restores, DR drills (high-risk).",
    actions: [
      { id: "view", label: "View", icon: "visibility" },
      { id: "backup", label: "Backup", icon: "backup" },
      { id: "restore", label: "Restore", icon: "restore" },
      { id: "drill", label: "DR Drill", icon: "emergency" },
      { id: "audit", label: "Audit", icon: "fact_check" },
      { id: "export", label: "Export", icon: "file_download" },
    ] as const,
  },

  // ──────────────────────────────────────────────────────────────────────────
  // NOTIFICATIONS / SYSTEM SETTINGS / INTEGRATIONS
  // ──────────────────────────────────────────────────────────────────────────
  {
    module: "NotificationCenter",
    label: "Notify",
    icon: "notifications",
    description: "System and user notifications, alerts, broadcasts.",
    actions: [
      { id: "view", label: "View", icon: "visibility" },
      { id: "markRead", label: "Mark Read", icon: "done_all" },
      { id: "delete", label: "Delete", icon: "delete" },
      { id: "restore", label: "Restore", icon: "restore" },
      { id: "broadcast", label: "Broadcast", icon: "campaign" },
      { id: "configure", label: "Config", icon: "tune" },
    ] as const,
  },
  {
    module: "SystemSettings",
    label: "Settings",
    icon: "settings",
    description: "System preferences, roles, backups, security config.",
    actions: [
      { id: "view", label: "View", icon: "visibility" },
      { id: "configure", label: "Config", icon: "tune" },
      { id: "roles", label: "Roles", icon: "admin_panel_settings" },
      { id: "security", label: "Security", icon: "security" },
      { id: "audit", label: "Audit", icon: "fact_check" },
      { id: "export", label: "Export", icon: "file_download" },
    ] as const,
  },
  {
    module: "Integrations",
    label: "Integrations",
    icon: "hub",
    description: "External systems (email/SMS, payments, HR tools).",
    actions: [
      { id: "view", label: "View", icon: "visibility" },
      { id: "configure", label: "Config", icon: "tune" },
      { id: "secrets", label: "Secrets", icon: "key" },
      { id: "sync", label: "Sync", icon: "sync" },
      { id: "monitor", label: "Monitor", icon: "monitor_heart" },
      { id: "audit", label: "Audit", icon: "fact_check" },
    ] as const,
  },
] as const satisfies ReadonlyArray<AccessModuleOption>;

/* ========================================================================== *
 * DERIVED STRICT KEYS
 * ========================================================================== */

export type AccessModuleKey = ( typeof ACCESS_OPTIONS )[ number ][ "module" ];
export type AccessActionKey =
  ( typeof ACCESS_OPTIONS )[ number ][ "actions" ][ number ][ "id" ];
