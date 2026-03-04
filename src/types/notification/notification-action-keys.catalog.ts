
// =============================================================================
// PropEase — Notification Action Keys Catalog
// =============================================================================
// 
// PURPOSE
// - Single source of truth for all notification action keys
// - Used as:
//    • TypeScript union type
//    • Mongoose enum values
//    • Frontend navigation registry base
//
// ENTERPRISE RULE
// - Never remove old keys
// - Add new keys only
// - Keep stable for audit history
// =============================================================================

export const NOTIFICATION_ACTION_KEYS = [

   /* =============================================================================
      USER MANAGEMENT
   ============================================================================= */
   "user:account.created",
   "user:account.updated",
   "user:account.deleted",
   "user:account.activated",
   "user:account.deactivated",
   "user:account.password.reset",
   "user:account.password.changed",
   "user:account.locked",
   "user:account.unlocked",
   "user:account.role.changed",
   "user:account.auto_delete.failed",
   "user:account.auto_delete.executed",
   "user:profile.updated",
   "user:login.success",
   "user:login.failed",
   "user:mfa.enabled",
   "user:mfa.disabled",

   /* =============================================================================
      PROPERTY MANAGEMENT
   ============================================================================= */
   "property:listing.created",
   "property:listing.updated",
   "property:listing.deleted",
   "property:inspection.scheduled",
   "property:inspection.completed",
   "property:maintenance.reported",
   "property:maintenance.resolved",

   /* =============================================================================
      TENANT MANAGEMENT
   ============================================================================= */
   "tenant:account.created",
   "tenant:account.updated",
   "tenant:account.deleted",
   "tenant:complaint.created",
   "tenant:complaint.resolved",
   "tenant:complaint.deleted",
   "tenant:complaint.status-changed",
   "tenant:rent.overdue",

   /* =============================================================================
      LEASE MANAGEMENT
   ============================================================================= */
   "lease:agreement.created",
   "lease:agreement.renewed",
   "lease:agreement.terminated",
   "lease:agreement.downloaded",
   "lease:agreement.viewed",
   "lease:signature.completed",

   /* =============================================================================
      PAYMENT
   ============================================================================= */
   "payment:invoice.generated",
   "payment:invoice.sent",
   "payment:invoice.paid",
   "payment:transaction.failed",
   "payment:refund.completed",
   "payment:bank.account.created",
   "payment:bank.account.updated",
   "payment:bank.account.deleted",
   "payment:bank.created",
   "payment:bank.updated",
   "payment:bank.deleted",
   "payment:transaction.created",
   "payment:transaction.updated",
   "payment:transaction.deleted",
   "payment:transaction.approved",
   "payment:transaction.rejected",
   "payment:transaction.change.payment.status",

   /* =============================================================================
      TEAM MANAGEMENT
   ============================================================================= */
   "team:created",
   "team:updated",
   "team:deleted",

   "team:member.added",
   "team:member.removed",
   "team:member.updatd",

   "team:member.activities.added",
   "team:member.activities.removed",
   "team:member.activities.updated",
   "team:member.activities.evidence.added",
   "team:member.activities.evidence.updated",
   "team:member.activities.evidence.removed",
   "team:member.activities.blocker.appended",
   "team:member.activities.blocker.updated",
   "team:member.activities.blocker.resolved",
   "team:member.activities.blocker.removed",

   "team:member.milestone.created",
   "team:member.milestone.updated",
   "team:member.milestone.deleted",
   "team:member.milestone.completed",
   "team:member.milestone.reopened",
   "team:member.milestone.overdue",
   "team:member.milestone.deadline.changed",
   "team:member.milestone.assigned",
   "team:member.milestone.unassigned",

   "team:task.created",
   "team:task.updated",
   "team:task.deleted",
   "team:task.assigned",
   "team:task.completed",
   "team:task.overdue",

   "team:work-item.created",
   "team:work-item.updated",
   "team:work-item.deleted",

   "team:kpi.threshold.breached",

   /* =============================================================================
      COMMENT ENGINE
   ============================================================================= */
   "comment:added",
   "comment:edited",
   "comment:deleted",
   "comment:mentioned",

   /* =============================================================================
      SYSTEM
   ============================================================================= */
   "system:maintenance.scheduled",
   "system:update.available",
   "system:security.alert",
   "system:backup.completed",
   "system:auto.deleted",

   /* =============================================================================
      NOTIFICATION SYSTEM
   ============================================================================= */
   "notification:delivered",
   "notification:failed",
   "notification:archived",
   "notification:created",
   "notification:updated",
   "notification:deleted",

] as const;

/**
 * =============================================================================
 * Derived Type (auto-generated union)
 * =============================================================================
 */
export type NotificationActionKey =
   typeof NOTIFICATION_ACTION_KEYS[ number ];


export const ACTION_KEY_LOOKUP: Record<string, NotificationActionKey> =
   Object.fromEntries(
      NOTIFICATION_ACTION_KEYS.map( k => [ k.toLowerCase(), k ] )
   );


export class NotificationActionKeyFilter {

   public static extractKey( row: unknown ): NotificationActionKey {
      const s = typeof row === 'string' ? row.trim() : '';
      if ( !s ) throw new Error( 'Invalid target action key value!' );
      const v: NotificationActionKey | undefined = NOTIFICATION_ACTION_KEYS.find( k => k.toLowerCase() === s );
      if ( !v ) throw new Error( 'Invalid action key, cannot find in data set!' );
      return v;
   }
   /**
    * Exact-match, case-insensitive
    * - Returns the canonical union value if found
    * - Else returns null
    */
   public static exactOrNull( raw: string ): NotificationActionKey | null {
      const key = NotificationActionKeyFilter.normalize( raw );
      if ( !key ) return null;

      const hit = ACTION_KEY_LOOKUP[ key ];
      return hit ? hit : null;
   }



   /**
    * Exact-match, case-insensitive + fallback
    * - Always returns a valid NotificationActionKey
    */
   public static exactOrFallback( raw: string, fallback: NotificationActionKey ): NotificationActionKey {
      const hit = NotificationActionKeyFilter.exactOrNull( raw );
      return hit ? hit : fallback;
   }

   /**
    * Type guard (useful for if checks)
    */
   public static isAllowed( raw: string ): raw is NotificationActionKey {
      return NotificationActionKeyFilter.exactOrNull( raw ) !== null;
   }

   private static normalize( raw: string ): string {
      // exact match requires consistent normalization
      const s = String( raw || "" ).trim().toLowerCase();
      return s;
   }
}