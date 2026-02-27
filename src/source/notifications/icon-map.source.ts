// Path: src/source/notifications/icon-map.source.ts
// =============================================================================
// NotificationIconMapSource (Material Icons mapping by actionKey)
// =============================================================================
// 01. Introduction
// - Central, typed icon resolver for notifications.
// - Converts a NotificationActionKey into a Material icon name (string).
// - Designed to be used by Notification UI components (menus, lists, dialogs).
//
// 02. Important matters
// - Uses ONLY Material icon names (MatIcon).
// - Provides:
//    A) explicit per-action mapping (stable, predictable)
//    B) rule-based fallback by module prefix (future-proof)
// - Never returns undefined: always returns a safe default icon.
//
// 03. Why we make this class
// - Keeps UI consistent across the entire system.
// - Prevents scattering icon logic across multiple components.
// - Makes it easy to revise icon language centrally (UI freeze friendly).
//
// 04. Usage hint
// - In component: `icon = NotificationIconMapSource.getIcon(actionKey)`
// - In template: `<mat-icon>{{ icon }}</mat-icon>`
//
// 05. Keep in mind
// - If you add new action keys, add them here OR they’ll use fallback rules.
// - Material icon names are case-sensitive and must exist in the icon font set.
// =============================================================================

export class NotificationIconMapSource {
   /**
    * Resolve the Material icon name for a notification action key.
    *
    * @param actionKey
    * - Expected: one of your NOTIFICATION_ACTION_KEYS values (e.g. "lease:agreement.created")
    * - Usage: drives UI icon selection for notification items
    *
    * @returns Material icon name string (e.g. "description", "warning", "task_alt")
    */
   public static getIcon( actionKey: string ): string {
      const key = this.safeStr( actionKey );
      if ( !key ) return this.DEFAULT_ICON;

      // 1) Explicit mapping wins (most accurate)
      const exact = this.EXACT[ key ];
      if ( exact ) return exact;

      // 2) Module-level fallback (future-proof)
      return this.fallbackByPrefix( key );
   }

   // =============================================================================
   // Defaults
   // =============================================================================

   private static readonly DEFAULT_ICON = "notifications";

   // =============================================================================
   // Exact mappings (stable UI language)
   // =============================================================================

   // NOTE: keep as Record<string,string> to avoid TS friction when keys evolve.
   // Your runtime keys are strings; compile-time union is enforced elsewhere.
   private static readonly EXACT: Record<string, string> = {
      /* =============================================================================
         USER MANAGEMENT
      ============================================================================= */
      "user:account.created": "person_add",
      "user:account.updated": "manage_accounts",
      "user:account.deleted": "person_remove",
      "user:account.activated": "toggle_on",
      "user:account.deactivated": "toggle_off",
      "user:account.password.reset": "lock_reset",
      "user:account.password.changed": "password",
      "user:account.locked": "lock",
      "user:account.unlocked": "lock_open",
      "user:account.role.changed": "admin_panel_settings",
      "user:account.auto_delete.failed": "error",
      "user:account.auto_delete.executed": "auto_delete",
      "user:profile.updated": "badge",
      "user:login.success": "login",
      "user:login.failed": "report",
      "user:mfa.enabled": "verified_user",
      "user:mfa.disabled": "gpp_bad",

      /* =============================================================================
         PROPERTY MANAGEMENT
      ============================================================================= */
      "property:listing.created": "home_app_logo",
      "property:listing.updated": "in_home_mode",
      "property:listing.deleted": "home_work",
      "property:inspection.scheduled": "event",
      "property:inspection.completed": "task_alt",
      "property:maintenance.reported": "build",
      "property:maintenance.resolved": "handyman",

      /* =============================================================================
         TENANT MANAGEMENT
      ============================================================================= */
      "tenant:account.created": "person_add_alt",
      "tenant:account.updated": "person",
      "tenant:account.deleted": "person_off",
      "tenant:complaint.created": "report_problem",
      "tenant:complaint.resolved": "check_circle",
      "tenant:rent.overdue": "schedule",

      /* =============================================================================
         LEASE MANAGEMENT
      ============================================================================= */
      "lease:agreement.created": "description",
      "lease:agreement.renewed": "autorenew",
      "lease:agreement.terminated": "do_not_disturb_on",
      "lease:agreement.downloaded": "download",
      "lease:agreement.viewed": "visibility",
      "lease:signature.completed": "draw",

      /* =============================================================================
         PAYMENT
      ============================================================================= */
      "payment:invoice.generated": "receipt_long",
      "payment:invoice.sent": "send",
      "payment:invoice.paid": "paid",
      "payment:transaction.failed": "error",
      "payment:refund.completed": "undo",

      /* =============================================================================
         TEAM MANAGEMENT
      ============================================================================= */
      "team:created": "groups",
      "team:updated": "group",
      "team:deleted": "group_off",

      "team:member.added": "group_add",
      "team:member.removed": "group_remove",
      // Keep the key EXACT as your action list ("updatd" typo) to ensure icon resolves.
      "team:member.updatd": "manage_accounts",

      // Member Activities (base)
      "team:member.activities.added": "playlist_add",
      "team:member.activities.removed": "playlist_remove",
      "team:member.activities.updated": "playlist_play",

      // Member Activities — Evidence
      "team:member.activities.evidence.added": "attach_file",
      "team:member.activities.evidence.updated": "drive_file_rename_outline",
      "team:member.activities.evidence.removed": "link_off",

      // Member Activities — Blockers
      "team:member.activities.blocker.appended": "block",
      "team:member.activities.blocker.updated": "edit",
      "team:member.activities.blocker.resolved": "check_circle",
      "team:member.activities.blocker.removed": "do_not_disturb_off",

      // Milestones
      "team:member.milestone.created": "flag",
      "team:member.milestone.updated": "outlined_flag",
      "team:member.milestone.deleted": "flag_circle",
      "team:member.milestone.completed": "task_alt",
      "team:member.milestone.reopened": "restart_alt",
      "team:member.milestone.overdue": "alarm",
      "team:member.milestone.deadline.changed": "event_busy",
      "team:member.milestone.assigned": "assignment_ind",
      "team:member.milestone.unassigned": "assignment_late",

      // Tasks
      "team:task.created": "task",
      "team:task.updated": "edit_note",
      "team:task.deleted": "delete",
      "team:task.assigned": "assignment",
      "team:task.completed": "task_alt",
      "team:task.overdue": "event_busy",

      // Work Items
      "team:work-item.created": "checklist",
      "team:work-item.updated": "rule",
      "team:work-item.deleted": "remove_done",

      // KPI
      "team:kpi.threshold.breached": "trending_down",

      /* =============================================================================
         COMMENT ENGINE
      ============================================================================= */
      "comment:added": "comment",
      "comment:edited": "edit",
      "comment:deleted": "delete_outline",
      "comment:mentioned": "alternate_email",

      /* =============================================================================
         SYSTEM
      ============================================================================= */
      "system:maintenance.scheduled": "engineering",
      "system:update.available": "system_update",
      "system:security.alert": "security",
      "system:backup.completed": "cloud_done",
      "system:auto.deleted": "auto_delete",

      /* =============================================================================
         NOTIFICATION SYSTEM
      ============================================================================= */
      "notification:delivered": "mark_email_read",
      "notification:failed": "mark_email_unread",
      "notification:archived": "archive",
   };

   // =============================================================================
   // Prefix fallback rules (covers future keys without breaking UI)
   // =============================================================================

   /**
    * Decide icon by actionKey prefix (module) if not in exact mapping.
    *
    * @param actionKey
    * - Expected: normalized action key, non-empty
    */
   private static fallbackByPrefix( actionKey: string ): string {
      if ( actionKey.startsWith( "user:" ) ) return "person";
      if ( actionKey.startsWith( "property:" ) ) return "home";
      if ( actionKey.startsWith( "tenant:" ) ) return "groups";
      if ( actionKey.startsWith( "lease:" ) ) return "description";
      if ( actionKey.startsWith( "payment:" ) ) return "payments";
      if ( actionKey.startsWith( "team:" ) ) return "groups";
      if ( actionKey.startsWith( "comment:" ) ) return "comment";
      if ( actionKey.startsWith( "system:" ) ) return "settings";
      if ( actionKey.startsWith( "notification:" ) ) return "notifications_active";
      return this.DEFAULT_ICON;
   }

   // =============================================================================
   // Small safe helpers
   // =============================================================================

   /**
    * Normalize a string input safely.
    *
    * @param v
    * - Expected: unknown input that might be a string
    * - Usage: ensures stable key lookup behavior without throwing
    */
   private static safeStr( v: unknown ): string {
      return typeof v === "string" ? v.trim() : "";
   }
}