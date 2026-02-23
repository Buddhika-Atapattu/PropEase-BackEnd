// ============================================================================
// Path: src/utils/system-actor.factory.ts
// ============================================================================

import type { NotificationActorDto } from "../types/notification/notification.types";

/**
 * SystemActorFactory
 *
 * INTRODUCTION
 * - Provides a canonical "system actor" identity for background jobs.
 *
 * IMPORTANT MATTERS
 * - Background tasks have no HTTP request, so no user actor exists.
 * - We must still provide an auditable identity (service principal).
 *
 * WHY WE MAKE THIS CLASS
 * - Prevents fake actors, avoids null/undefined, keeps audit trails consistent.
 *
 * KEEP IN MIND
 * - Use a unique userId string that never conflicts with Mongo ObjectIds.
 * - Recommended: prefix with "system:".
 */
export class SystemActorFactory {
  /**
   * Build a standard system actor for scheduled/background executions.
   *
   * @param options.source
   * - Expected: short source id (example: "auto-delete-users", "nightly-kpi", "recyclebin-purge")
   *
   * @param options.label
   * - Expected: friendly name (example: "Auto Delete Service")
   *
   * @param options.role
   * - Expected: valid role-like label; keep stable for filtering
   */
  public static build(options: {
    source: string;
    label: string;
    role?: string;
  }): NotificationActorDto {
    const role = typeof options.role === "string" && options.role.trim() ? options.role.trim() : "system";

    return {
      userId: `system:${options.source}`, // ✅ not an ObjectId, but valid contract string
      username: options.label,
      role,
    };
  }
}
