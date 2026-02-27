// Path: src/source/access-map.source.ts
// =============================================================================
// PropEase Access Matrix (SINGLE SOURCE OF TRUTH) — ENTERPRISE FULL SCALE
// -----------------------------------------------------------------------------
// ✅ Backend + Frontend shared (NO mongoose types)
// ✅ Hierarchical modules supported (e.g., TeamManagement.WorkItems)
// ✅ Every module MUST include CRUD (create/view/update/delete)
// ✅ Min 4 actions per module, Max 20 actions per module
// ✅ Action id + label <= 30 chars (UI-safe)
// ✅ Enterprise-grade actions supported (approve, audit, export, policy, etc.)
// =============================================================================

/* ========================================================================== *
 * ACCESS MAP TYPES
 * ========================================================================== */

export interface AccessActionOption {
  id: string; // machine key used in guard + DB
  label: string; // SHORT UI label (<= 30 chars)
  description?: string; // longer explanation shown in UI tooltip/details
  icon?: string; // Angular Material icon name (mat-icon)
}

export interface AccessModuleOption {
  module: string; // machine key used in guard routes map
  label: string; // SHORT UI label
  actions: ReadonlyArray<AccessActionOption>; // MIN 4 / MAX 20 actions per module
  description?: string; // longer module explanation
  icon?: string; // module icon (mat-icon)
}

/* ========================================================================== *
 * CANONICAL ACCESS MATRIX (ENTERPRISE)
 * ========================================================================== */

export const ACCESS_OPTIONS = [
  // ──────────────────────────────────────────────────────────────────────────
  // DASHBOARD / REPORTS (Ops visibility)
  // ──────────────────────────────────────────────────────────────────────────
  {
    module: "Dashboard",
    label: "Dashboard",
    icon: "dashboard",
    description: "Role-based dashboards, KPI highlights, and operational summaries.",
    actions: [
      { id: "view", label: "View", icon: "visibility" },
      { id: "create", label: "Create", icon: "add" }, // e.g., create widgets/layouts
      { id: "update", label: "Update", icon: "edit" },
      { id: "delete", label: "Delete", icon: "delete" },
      { id: "configure", label: "Config", icon: "tune", description: "Configure dashboard layouts and visibility." },
      { id: "export", label: "Export", icon: "file_download", description: "Export dashboard snapshots/metrics." },
    ] as const,
  },
  {
    module: "Reports",
    label: "Reports",
    icon: "summarize",
    description: "Operational and compliance reports across modules.",
    actions: [
      { id: "view", label: "View", icon: "visibility" },
      { id: "create", label: "Create", icon: "add_chart" },
      { id: "update", label: "Update", icon: "edit" },
      { id: "delete", label: "Delete", icon: "delete" },
      { id: "run", label: "Run", icon: "play_circle", description: "Generate reports on demand." },
      { id: "schedule", label: "Schedule", icon: "schedule", description: "Schedule recurring report generation." },
      { id: "export", label: "Export", icon: "file_download" },
      { id: "share", label: "Share", icon: "share", description: "Share reports to roles/teams/users." },
      { id: "audit", label: "Audit", icon: "fact_check", description: "View report generation history." },
    ] as const,
  },

  // ──────────────────────────────────────────────────────────────────────────
  // ORGANIZATION / BRANCH / EMPLOYEES (Enterprise Core)
  // ──────────────────────────────────────────────────────────────────────────
  {
    module: "OrganizationManagement",
    label: "Organization",
    icon: "domain",
    description: "Company profile, departments, designations, governance policies.",
    actions: [
      { id: "view", label: "View", icon: "visibility" },
      { id: "create", label: "Create", icon: "add_business" },
      { id: "update", label: "Update", icon: "edit" },
      { id: "delete", label: "Delete", icon: "delete" },
      { id: "policy", label: "Policies", icon: "policy", description: "Manage policy sets and rules (audited)." },
      { id: "approve", label: "Approve", icon: "verified", description: "Approve high-risk org changes." },
      { id: "audit", label: "Audit", icon: "fact_check", description: "Review change history and compliance evidence." },
      { id: "export", label: "Export", icon: "file_download" },
      { id: "import", label: "Import", icon: "file_upload", description: "Bulk import org structures (validated)." },
    ] as const,
  },
  {
    module: "BranchManagement",
    label: "Branches",
    icon: "location_city",
    description: "Branch registry, branch managers, branch-level policy overrides.",
    actions: [
      { id: "view", label: "View", icon: "visibility" },
      { id: "create", label: "Create", icon: "add_location_alt" },
      { id: "update", label: "Update", icon: "edit" },
      { id: "delete", label: "Delete", icon: "delete" },
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
      { id: "create", label: "Create", icon: "person_add", description: "Create/register employee profile." },
      { id: "update", label: "Update", icon: "edit" },
      { id: "delete", label: "Delete", icon: "delete" },
      { id: "assign", label: "Assign", icon: "how_to_reg", description: "Assign branch/department/supervisor." },
      { id: "documents", label: "Documents", icon: "folder", description: "Manage employee documents (audited)." },
      { id: "audit", label: "Audit", icon: "fact_check", description: "Employee change history." },
      { id: "export", label: "Export", icon: "file_download" },
      { id: "import", label: "Import", icon: "file_upload" },
    ] as const,
  },

  // ──────────────────────────────────────────────────────────────────────────
  // HR MANAGEMENT (Full Scale)
  // ──────────────────────────────────────────────────────────────────────────
  {
    module: "HRManagement",
    label: "HR",
    icon: "people",
    description: "HR operations: cycles, scorecards, reviews, governance.",
    actions: [
      { id: "view", label: "View", icon: "visibility" },
      { id: "create", label: "Create", icon: "add" }, // e.g., cycles/programs
      { id: "update", label: "Update", icon: "edit" },
      { id: "delete", label: "Delete", icon: "delete" },
      { id: "scorecards", label: "Scorecards", icon: "insights", description: "Manage KPI/MBO scorecards." },
      { id: "reviews", label: "Reviews", icon: "rate_review", description: "Performance review workflows." },
      { id: "policy", label: "Policies", icon: "policy" },
      { id: "approve", label: "Approve", icon: "verified" },
      { id: "audit", label: "Audit", icon: "fact_check" },
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
      { id: "create", label: "Create", icon: "add" }, // manual entries/shift rules
      { id: "update", label: "Update", icon: "edit" },
      { id: "delete", label: "Delete", icon: "delete" },
      { id: "capture", label: "Capture", icon: "qr_code_scanner", description: "Capture attendance entries." },
      { id: "approve", label: "Approve", icon: "verified", description: "Approve exceptions/overtime." },
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
      { id: "create", label: "Create", icon: "add" }, // request
      { id: "update", label: "Update", icon: "edit" }, // edit request/policy
      { id: "delete", label: "Delete", icon: "delete" }, // cancel/remove
      { id: "approve", label: "Approve", icon: "verified" },
      { id: "policy", label: "Policies", icon: "policy" },
      { id: "audit", label: "Audit", icon: "fact_check" },
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
      { id: "create", label: "Create", icon: "add" }, // payroll batches
      { id: "update", label: "Update", icon: "edit" }, // corrections
      { id: "delete", label: "Delete", icon: "delete" }, // remove batch
      { id: "inputs", label: "Inputs", icon: "tune" },
      { id: "run", label: "Run", icon: "play_circle" },
      { id: "approve", label: "Approve", icon: "verified" },
      { id: "payslips", label: "Payslips", icon: "receipt", description: "Generate/view payslips." },
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
      { id: "create", label: "Create", icon: "add" }, // vacancy/applicant
      { id: "update", label: "Update", icon: "edit" },
      { id: "delete", label: "Delete", icon: "delete" },
      { id: "pipeline", label: "Pipeline", icon: "schema" },
      { id: "offer", label: "Offer", icon: "assignment_turned_in" },
      { id: "approve", label: "Approve", icon: "verified" },
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
      { id: "create", label: "Create", icon: "add" }, // plan/course
      { id: "update", label: "Update", icon: "edit" },
      { id: "delete", label: "Delete", icon: "delete" },
      { id: "assign", label: "Assign", icon: "how_to_reg" },
      { id: "certify", label: "Certify", icon: "workspace_premium" },
      { id: "monitor", label: "Monitor", icon: "monitor_heart" },
      { id: "audit", label: "Audit", icon: "fact_check" },
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
    description: "Identity, accounts, roles, lifecycle and secure access.",
    actions: [
      { id: "view", label: "View", icon: "visibility" },
      { id: "create", label: "Create", icon: "person_add" },
      { id: "update", label: "Update", icon: "edit" },
      { id: "delete", label: "Delete", icon: "delete" },
      { id: "disable", label: "Disable", icon: "toggle_off", description: "Activate/deactivate accounts." },
      { id: "reset", label: "Reset", icon: "lock_reset", description: "Reset password / security state." },
      { id: "roles", label: "Roles", icon: "admin_panel_settings" },
      { id: "sessions", label: "Sessions", icon: "phonelink_lock", description: "Inspect/revoke sessions." },
      { id: "audit", label: "Audit", icon: "fact_check" },
      { id: "export", label: "Export", icon: "file_download" },
      { id: "import", label: "Import", icon: "file_upload" },
    ] as const,
  },
  {
    module: "AccessControl",
    label: "Access",
    icon: "security",
    description: "Grant/revoke permissions, restrictions, session controls.",
    actions: [
      { id: "view", label: "View", icon: "visibility" },
      { id: "create", label: "Create", icon: "add" }, // e.g., roles/policies
      { id: "update", label: "Update", icon: "edit" },
      { id: "delete", label: "Delete", icon: "delete" },
      { id: "grant", label: "Grant", icon: "key" },
      { id: "revoke", label: "Revoke", icon: "vpn_key_off" },
      { id: "restrict", label: "Restrict", icon: "do_not_disturb_on" },
      { id: "mfa", label: "MFA", icon: "verified_user", description: "Manage MFA policies and enforcement." },
      { id: "audit", label: "Audit", icon: "fact_check" },
      { id: "export", label: "Export", icon: "file_download" },
    ] as const,
  },
  {
    module: "SecurityOps",
    label: "SecOps",
    icon: "shield",
    description: "Security monitoring, incident response, enforcement.",
    actions: [
      { id: "view", label: "View", icon: "visibility" },
      { id: "create", label: "Create", icon: "add", description: "Create incident cases/runbooks." },
      { id: "update", label: "Update", icon: "edit" },
      { id: "delete", label: "Delete", icon: "delete" },
      { id: "monitor", label: "Monitor", icon: "monitor_heart" },
      { id: "enforce", label: "Enforce", icon: "gpp_good", description: "Lockdown / block / force policies." },
      { id: "incidents", label: "Incidents", icon: "report" },
      { id: "quarantine", label: "Quarantine", icon: "block", description: "Quarantine user/device/session." },
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
    description: "Property inventory, units, documents, publishing and lifecycle.",
    actions: [
      { id: "view", label: "View", icon: "visibility" },
      { id: "create", label: "Create", icon: "add_home" },
      { id: "update", label: "Update", icon: "edit" },
      { id: "delete", label: "Delete", icon: "delete" },
      { id: "assign", label: "Assign", icon: "how_to_reg", description: "Assign agents/owners to properties." },
      { id: "publish", label: "Publish", icon: "campaign" },
      { id: "documents", label: "Documents", icon: "folder" },
      { id: "audit", label: "Audit", icon: "fact_check" },
      { id: "export", label: "Export", icon: "file_download" },
      { id: "import", label: "Import", icon: "file_upload" },
    ] as const,
  },
  {
    module: "TenantManagement",
    label: "Tenants",
    icon: "groups",
    description: "Tenant onboarding, profile, assignment, documents.",
    actions: [
      { id: "view", label: "View", icon: "visibility" },
      { id: "create", label: "Create", icon: "person_add" },
      { id: "update", label: "Update", icon: "edit" },
      { id: "delete", label: "Delete", icon: "delete" },
      { id: "assign", label: "Assign", icon: "domain_add" },
      { id: "documents", label: "Documents", icon: "folder" },
      { id: "notify", label: "Notify", icon: "notifications_active" },
      { id: "audit", label: "Audit", icon: "fact_check" },
      { id: "export", label: "Export", icon: "file_download" },
      { id: "import", label: "Import", icon: "file_upload" },
    ] as const,
  },
  {
    module: "LeaseManagement",
    label: "Leases",
    icon: "description",
    description: "Lease lifecycle, renewals, termination, approvals and documents.",
    actions: [
      { id: "view", label: "View", icon: "visibility" },
      { id: "create", label: "Create", icon: "note_add" },
      { id: "update", label: "Update", icon: "edit" },
      { id: "delete", label: "Delete", icon: "delete" },
      { id: "workflow", label: "Workflow", icon: "published_with_changes" },
      { id: "approve", label: "Approve", icon: "verified" },
      { id: "sign", label: "Sign", icon: "draw", description: "Manage signatures and signing flow." },
      { id: "documents", label: "Documents", icon: "folder" },
      { id: "audit", label: "Audit", icon: "fact_check" },
      { id: "export", label: "Export", icon: "file_download" },
    ] as const,
  },
  {
    module: "ComplaintsManagement",
    label: "Complaints",
    icon: "report_problem",
    description: "Service requests and complaints: assign, resolve, SLA, evidence.",
    actions: [
      { id: "view", label: "View", icon: "visibility" },
      { id: "create", label: "Create", icon: "add" },
      { id: "update", label: "Update", icon: "edit" },
      { id: "delete", label: "Delete", icon: "delete" },
      { id: "assign", label: "Assign", icon: "assignment_ind" },
      { id: "workflow", label: "Workflow", icon: "published_with_changes" },
      { id: "sla", label: "SLA", icon: "timer", description: "Manage SLA targets and escalations." },
      { id: "evidence", label: "Evidence", icon: "attach_file" },
      { id: "audit", label: "Audit", icon: "fact_check" },
      { id: "export", label: "Export", icon: "file_download" },
    ] as const,
  },

  // ──────────────────────────────────────────────────────────────────────────
  // AGENT / OWNER (Real-estate specific ops)
  // ──────────────────────────────────────────────────────────────────────────
  {
    module: "AgentManagement",
    label: "Agents",
    icon: "support_agent",
    description: "Agent profiles, assignments, performance and monthly summaries.",
    actions: [
      { id: "view", label: "View", icon: "visibility" },
      { id: "create", label: "Create", icon: "person_add" },
      { id: "update", label: "Update", icon: "edit" },
      { id: "delete", label: "Delete", icon: "delete" },
      { id: "assign", label: "Assign", icon: "how_to_reg" },
      { id: "kpis", label: "KPIs", icon: "insights" },
      { id: "audit", label: "Audit", icon: "fact_check" },
      { id: "export", label: "Export", icon: "file_download" },
    ] as const,
  },
  {
    module: "OwnerManagement",
    label: "Owners",
    icon: "real_estate_agent",
    description: "Property owners, ownership mapping, payouts and statements.",
    actions: [
      { id: "view", label: "View", icon: "visibility" },
      { id: "create", label: "Create", icon: "person_add" },
      { id: "update", label: "Update", icon: "edit" },
      { id: "delete", label: "Delete", icon: "delete" },
      { id: "assign", label: "Assign", icon: "how_to_reg" },
      { id: "statements", label: "Statements", icon: "receipt_long" },
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
      { id: "create", label: "Create", icon: "add" }, // invoice/charge
      { id: "update", label: "Update", icon: "edit" }, // adjust
      { id: "delete", label: "Delete", icon: "delete" }, // void
      { id: "invoice", label: "Invoice", icon: "receipt_long" },
      { id: "record", label: "Record", icon: "point_of_sale" },
      { id: "approve", label: "Approve", icon: "verified" },
      { id: "refund", label: "Refund", icon: "currency_exchange" },
      { id: "reconcile", label: "Reconcile", icon: "rule", description: "Reconcile payments vs invoices." },
      { id: "audit", label: "Audit", icon: "fact_check" },
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
      { id: "create", label: "Create", icon: "add" }, // journals
      { id: "update", label: "Update", icon: "edit" },
      { id: "delete", label: "Delete", icon: "delete" },
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
      { id: "create", label: "Create", icon: "add" }, // PR/PO/vendor
      { id: "update", label: "Update", icon: "edit" },
      { id: "delete", label: "Delete", icon: "delete" },
      { id: "request", label: "Request", icon: "add_shopping_cart" },
      { id: "approve", label: "Approve", icon: "verified" },
      { id: "vendors", label: "Vendors", icon: "store" },
      { id: "audit", label: "Audit", icon: "fact_check" },
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
      { id: "create", label: "Create", icon: "add" }, // cash/bank item
      { id: "update", label: "Update", icon: "edit" },
      { id: "delete", label: "Delete", icon: "delete" },
      { id: "settle", label: "Settle", icon: "sync_alt" },
      { id: "approve", label: "Approve", icon: "verified" },
      { id: "audit", label: "Audit", icon: "fact_check" },
      { id: "export", label: "Export", icon: "file_download" },
    ] as const,
  },

  // ──────────────────────────────────────────────────────────────────────────
  // TEAM MANAGEMENT (Team Ops Engine)
  // ──────────────────────────────────────────────────────────────────────────
  {
    module: "TeamManagement.Teams",
    label: "Teams",
    icon: "groups_3",
    description: "Team governance: teams, members, captain, controls.",
    actions: [
      { id: "view", label: "View", icon: "visibility" },
      { id: "create", label: "Create", icon: "group_add" },
      { id: "update", label: "Update", icon: "edit" },
      { id: "delete", label: "Delete", icon: "delete" },
      { id: "members", label: "Members", icon: "how_to_reg" },
      { id: "captain", label: "Captain", icon: "military_tech" },
      { id: "monitor", label: "Monitor", icon: "monitor_heart" },
      { id: "audit", label: "Audit", icon: "fact_check" },
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
      { id: "delete", label: "Delete", icon: "delete" },
      { id: "assign", label: "Assign", icon: "assignment_ind" },
      { id: "workflow", label: "Workflow", icon: "published_with_changes" },
      { id: "evidence", label: "Evidence", icon: "attach_file" },
      { id: "audit", label: "Audit", icon: "fact_check" },
      { id: "export", label: "Export", icon: "file_download" },
    ] as const,
  },
  {
    module: "TeamManagement.WorkItems",
    label: "Work Items",
    icon: "assignment",
    description: "Execution work: lifecycle, throughput, approvals, evidence.",
    actions: [
      { id: "view", label: "View", icon: "visibility" },
      { id: "create", label: "Create", icon: "add" },
      { id: "update", label: "Update", icon: "edit" },
      { id: "delete", label: "Delete", icon: "delete" },
      { id: "assign", label: "Assign", icon: "assignment_ind" },
      { id: "workflow", label: "Workflow", icon: "published_with_changes" },
      { id: "approve", label: "Approve", icon: "verified" },
      { id: "evidence", label: "Evidence", icon: "attach_file" },
      { id: "audit", label: "Audit", icon: "fact_check" },
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
      { id: "create", label: "Create", icon: "event_available" },
      { id: "update", label: "Update", icon: "edit" },
      { id: "delete", label: "Delete", icon: "delete" },
      { id: "assign", label: "Assign", icon: "assignment_ind" },
      { id: "workflow", label: "Workflow", icon: "published_with_changes" },
      { id: "evidence", label: "Evidence", icon: "attach_file" },
      { id: "audit", label: "Audit", icon: "fact_check" },
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
      { id: "delete", label: "Delete", icon: "delete" },
      { id: "blockers", label: "Blockers", icon: "report" },
      { id: "evidence", label: "Evidence", icon: "attach_file" },
      { id: "audit", label: "Audit", icon: "fact_check" },
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
      { id: "delete", label: "Delete", icon: "delete" },
      { id: "workflow", label: "Workflow", icon: "published_with_changes" },
      { id: "tags", label: "Tags", icon: "sell" },
      { id: "evidence", label: "Evidence", icon: "attach_file" },
      { id: "audit", label: "Audit", icon: "fact_check" },
      { id: "export", label: "Export", icon: "file_download" },
    ] as const,
  },

  // ──────────────────────────────────────────────────────────────────────────
  // COMMENT ENGINE (cross-module)
  // ──────────────────────────────────────────────────────────────────────────
  {
    module: "CommentEngine",
    label: "Comments",
    icon: "comment",
    description: "Universal comments: cross-module notes, threads, and moderation.",
    actions: [
      { id: "view", label: "View", icon: "visibility" },
      { id: "create", label: "Create", icon: "add_comment" },
      { id: "update", label: "Update", icon: "edit_note", description: "Edit comments (own or scoped)." },
      { id: "delete", label: "Delete", icon: "delete_forever", description: "Delete comments (own or scoped)." },
      { id: "pin", label: "Pin", icon: "push_pin" },
      { id: "moderate", label: "Moderate", icon: "gavel" },
      { id: "export", label: "Export", icon: "file_download" },
      { id: "audit", label: "Audit", icon: "fact_check" },
    ] as const,
  },

  // ──────────────────────────────────────────────────────────────────────────
  // NOTIFICATIONS (system-wide)
  // ──────────────────────────────────────────────────────────────────────────
  {
    module: "NotificationCenter",
    label: "Notify",
    icon: "notifications",
    description: "System and user notifications, alerts, broadcasts.",
    actions: [
      { id: "view", label: "View", icon: "visibility" },
      { id: "create", label: "Create", icon: "add_alert" }, // create/broadcast
      { id: "update", label: "Update", icon: "edit" }, // templates/config
      { id: "delete", label: "Delete", icon: "delete" }, // remove notification items
      { id: "markRead", label: "Mark Read", icon: "done_all" },
      { id: "broadcast", label: "Broadcast", icon: "campaign" },
      { id: "configure", label: "Config", icon: "tune" },
      { id: "audit", label: "Audit", icon: "fact_check" },
      { id: "archive", label: "Archive", icon: "archive" },
      { id: "export", label: "Export", icon: "file_download" },
    ] as const,
  },

  // ──────────────────────────────────────────────────────────────────────────
  // KPI / AUDIT / COMPLIANCE / DATA GOVERNANCE / BACKUP
  // ──────────────────────────────────────────────────────────────────────────
  {
    module: "KpiMonitoring",
    label: "KPIs",
    icon: "insights",
    description: "Dashboards, ingestion, rebuilds, thresholds and alerting.",
    actions: [
      { id: "view", label: "View", icon: "dashboard" },
      { id: "create", label: "Create", icon: "add" }, // KPI definitions
      { id: "update", label: "Update", icon: "edit" },
      { id: "delete", label: "Delete", icon: "delete" },
      { id: "ingest", label: "Ingest", icon: "input" },
      { id: "rebuild", label: "Rebuild", icon: "autorenew" },
      { id: "configure", label: "Config", icon: "tune" },
      { id: "alerts", label: "Alerts", icon: "notification_important" },
      { id: "audit", label: "Audit", icon: "fact_check" },
      { id: "export", label: "Export", icon: "file_download" },
    ] as const,
  },
  {
    module: "AuditLogs",
    label: "Audit",
    icon: "policy",
    description: "Audit logs: view/search/export, suspicious activity investigations.",
    actions: [
      { id: "view", label: "View", icon: "visibility" },
      { id: "create", label: "Create", icon: "add" }, // create rules/views
      { id: "update", label: "Update", icon: "edit" }, // retention/rules
      { id: "delete", label: "Delete", icon: "delete" }, // delete saved views
      { id: "filter", label: "Filter", icon: "filter_alt" },
      { id: "investigate", label: "Investigate", icon: "manage_search" },
      { id: "alerts", label: "Alerts", icon: "notification_important" },
      { id: "retain", label: "Retention", icon: "schedule" },
      { id: "export", label: "Export", icon: "file_download" },
    ] as const,
  },
  {
    module: "Compliance",
    label: "Compliance",
    icon: "verified_user",
    description: "Controls, evidence, incidents, regulatory reporting.",
    actions: [
      { id: "view", label: "View", icon: "visibility" },
      { id: "create", label: "Create", icon: "add" }, // controls/incidents
      { id: "update", label: "Update", icon: "edit" },
      { id: "delete", label: "Delete", icon: "delete" },
      { id: "controls", label: "Controls", icon: "rule" },
      { id: "evidence", label: "Evidence", icon: "attach_file" },
      { id: "incidents", label: "Incidents", icon: "report" },
      { id: "approve", label: "Approve", icon: "verified" },
      { id: "audit", label: "Audit", icon: "fact_check" },
      { id: "export", label: "Export", icon: "file_download" },
    ] as const,
  },
  {
    module: "DataGovernance",
    label: "Data Gov",
    icon: "database",
    description: "Retention, privacy, export controls, data quality rules.",
    actions: [
      { id: "view", label: "View", icon: "visibility" },
      { id: "create", label: "Create", icon: "add" }, // policies/rules
      { id: "update", label: "Update", icon: "edit" },
      { id: "delete", label: "Delete", icon: "delete" },
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
      { id: "create", label: "Create", icon: "add" }, // backup plans
      { id: "update", label: "Update", icon: "edit" },
      { id: "delete", label: "Delete", icon: "delete" },
      { id: "backup", label: "Backup", icon: "backup" },
      { id: "restore", label: "Restore", icon: "restore" },
      { id: "drill", label: "DR Drill", icon: "emergency" },
      { id: "approve", label: "Approve", icon: "verified" },
      { id: "audit", label: "Audit", icon: "fact_check" },
      { id: "export", label: "Export", icon: "file_download" },
    ] as const,
  },

  // ──────────────────────────────────────────────────────────────────────────
  // SYSTEM SETTINGS / INTEGRATIONS
  // ──────────────────────────────────────────────────────────────────────────
  {
    module: "SystemSettings",
    label: "Settings",
    icon: "settings",
    description: "System preferences, global configuration, security policies.",
    actions: [
      { id: "view", label: "View", icon: "visibility" },
      { id: "create", label: "Create", icon: "add" }, // config sets
      { id: "update", label: "Update", icon: "edit" },
      { id: "delete", label: "Delete", icon: "delete" },
      { id: "configure", label: "Config", icon: "tune" },
      { id: "roles", label: "Roles", icon: "admin_panel_settings" },
      { id: "security", label: "Security", icon: "security" },
      { id: "policy", label: "Policies", icon: "policy" },
      { id: "audit", label: "Audit", icon: "fact_check" },
      { id: "export", label: "Export", icon: "file_download" },
    ] as const,
  },
  {
    module: "Integrations",
    label: "Integrations",
    icon: "hub",
    description: "External systems (email/SMS, payments, maps, HR tools).",
    actions: [
      { id: "view", label: "View", icon: "visibility" },
      { id: "create", label: "Create", icon: "add_link" },
      { id: "update", label: "Update", icon: "edit" },
      { id: "delete", label: "Delete", icon: "delete" },
      { id: "configure", label: "Config", icon: "tune" },
      { id: "secrets", label: "Secrets", icon: "key", description: "Manage API keys/secrets (restricted)." },
      { id: "sync", label: "Sync", icon: "sync" },
      { id: "monitor", label: "Monitor", icon: "monitor_heart" },
      { id: "audit", label: "Audit", icon: "fact_check" },
      { id: "export", label: "Export", icon: "file_download" },
    ] as const,
  },

  // ──────────────────────────────────────────────────────────────────────────
  // RECYCLE BIN OPERATIONS (step-up security candidate)
  // ──────────────────────────────────────────────────────────────────────────
  {
    module: "RecycleBin",
    label: "Recycle Bin",
    icon: "delete_sweep",
    description: "Recover deleted items or permanently delete with audit and step-up security.",
    actions: [
      // CRUD baseline (mapped to bin objects)
      { id: "view", label: "View", icon: "visibility" },
      { id: "create", label: "Create", icon: "add", description: "Create policies/retention rules (if enabled)." },
      { id: "update", label: "Update", icon: "edit", description: "Update policies/retention rules (if enabled)." },
      { id: "delete", label: "Delete", icon: "delete", description: "Delete policy entries (if enabled)." },

      // Read-only operations
      { id: "list", label: "List", icon: "list" },
      { id: "count", label: "Count", icon: "tag" },

      // Sensitive reads (snapshot can contain private data)
      { id: "view_snapshot", label: "View Snapshot", icon: "article" },
      { id: "view_files", label: "View Files", icon: "folder_open" },

      // High-privilege mutations
      { id: "restore", label: "Restore", icon: "restore" },
      { id: "purge", label: "Permanent Delete", icon: "delete_forever" },

      // Governance
      { id: "audit", label: "Audit", icon: "fact_check" },
      { id: "policy", label: "Policy", icon: "gavel" },
      { id: "export", label: "Export", icon: "file_download" },
    ] as const,
  },
] as const satisfies ReadonlyArray<AccessModuleOption>;

/* ========================================================================== *
 * DERIVED STRICT KEYS
 * ========================================================================== */

export type AccessModuleKey = ( typeof ACCESS_OPTIONS )[ number ][ "module" ];
export type AccessActionKey = ( typeof ACCESS_OPTIONS )[ number ][ "actions" ][ number ][ "id" ];