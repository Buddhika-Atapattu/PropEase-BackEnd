// ============================================================================
// Path: src/KPIs/shared/kpi.guard.ts
// ============================================================================

import type { KpiScope, KpiTarget } from "./kpi.types";

/* ============================================================================
 * KPI Scope Guard (Role/Job-Role Driven)
 * ----------------------------------------------------------------------------
 * INTRODUCTION
 * - Central helper to enforce KPI scope based on:
 *   1) System role (e.g. executive/cto/etc.)
 *   2) Optional team job-role (captain/admin/member) when relevant
 *
 * IMPORTANT MATTERS
 * - This guard does NOT know your domain models.
 * - A module engine calls this guard with its own policy.
 *
 * WHY WE MAKE THIS CLASS
 * - KPI scope must NOT be freely controlled by the frontend.
 * - Prevents a user asking for org/team-wide KPIs without permission.
 *
 * KEEP IN MIND
 * - targetId meaning is module-specific:
 *   - member scope: often actor.userId
 *   - team scope: teamCode / teamMongoId
 *   - org scope: orgId
 * ========================================================================== */

/**
 * Minimal actor contract required for KPI authorization.
 *
 * Notes:
 * - Compatible with your existing AuthUser shape:
 *   userId, username, role, teamCodes...
 */
export interface KpiActor {
  userId: string;
  username: string;
  role: string;

  // Optional membership metadata (module may supply)
  teamCodes?: string[];
}

/**
 * Optional team job-role context for fine-grained team KPI access.
 *
 * Example:
 * - captain -> can access team scope within that team
 * - member  -> member scope only
 */
export type TeamJobRole = "captain" | "admin" | "member";

/**
 * KPI Guard Policy
 *
 * - Each module can define which system roles are privileged.
 * - Team job-role handling can be enabled/disabled.
 */
export interface KpiGuardPolicy {
  privilegedSystemRoles: ReadonlyArray<string>;

  // If provided, guard can decide if team scope is allowed based on job role.
  teamScopeAllowedJobRoles?: ReadonlyArray<TeamJobRole>;
}

export class KpiScopeGuard {
  /**
   * Resolve and enforce KPI target based on actor + policy.
   *
   * @param options.actor
   * - Expected: authenticated actor
   *
   * @param options.policy
   * - Expected: module-defined policy for privileged roles
   *
   * @param options.requestedScope
   * - Optional requested scope ("member"|"team"|"org")
   * - If omitted, we default to safest: "member"
   *
   * @param options.requestedTargetId
   * - Optional targetId requested by FE
   * - Guard will override this for member scope unless actor is privileged
   *
   * @param options.teamContext
   * - Optional team job-role context for enforcing team scope
   *
   * @throws Error when request is not allowed
   */
  public resolveAndAssertTarget(options: {
    actor: KpiActor;
    policy: KpiGuardPolicy;

    requestedScope?: KpiScope;
    requestedTargetId?: string;

    teamContext?: {
      teamCode: string;
      jobRole: TeamJobRole;
    };
  }): KpiTarget {
    const requestedScope: KpiScope = options.requestedScope ?? "member";

    // 1) Privileged system roles can access anything (still validated logically).
    const isPrivileged = this.isPrivilegedRole(options.actor.role, options.policy);

    // 2) Org scope requires privileged system role (by default).
    if (requestedScope === "org") {
      if (!isPrivileged) {
        throw new Error("KPI org scope is not permitted for this actor");
      }

      const orgTargetId = (options.requestedTargetId ?? "").trim();
      if (!orgTargetId) {
        throw new Error("KPI org scope requires targetId (orgId)");
      }

      return { scope: "org", targetId: orgTargetId };
    }

    // 3) Team scope: allowed if privileged OR allowed job-role context is present.
    if (requestedScope === "team") {
      if (isPrivileged) {
        const teamTargetId = (options.requestedTargetId ?? "").trim();
        if (!teamTargetId) {
          throw new Error("KPI team scope requires targetId (teamCode/teamId)");
        }
        return { scope: "team", targetId: teamTargetId };
      }

      // Non-privileged user: must pass teamContext + satisfy policy.
      if (!options.teamContext) {
        throw new Error("KPI team scope requires teamContext for non-privileged actors");
      }

      if (!this.isTeamScopeAllowedByJobRole(options.teamContext.jobRole, options.policy)) {
        throw new Error("KPI team scope is not permitted for this team job-role");
      }

      // Enforce the team targetId to the provided teamContext teamCode
      // to prevent requesting other teams.
      return { scope: "team", targetId: options.teamContext.teamCode };
    }

    // 4) Member scope: safest default
    // Non-privileged: force member KPI to self (userId).
    if (!isPrivileged) {
      return { scope: "member", targetId: options.actor.userId };
    }

    // Privileged can request member KPIs for any targetId, but must provide it.
    const memberTargetId = (options.requestedTargetId ?? "").trim();
    if (!memberTargetId) {
      // Privileged but no member targetId: default to self (safe + predictable).
      return { scope: "member", targetId: options.actor.userId };
    }

    return { scope: "member", targetId: memberTargetId };
  }

  // --------------------------------------------------------------------------
  // Internal helpers (kept class-based, no free functions)
  // --------------------------------------------------------------------------

  private isPrivilegedRole(role: string, policy: KpiGuardPolicy): boolean {
    const normalized = role.trim().toLowerCase();
    for (const r of policy.privilegedSystemRoles) {
      if (normalized === r.trim().toLowerCase()) return true;
    }
    return false;
  }

  private isTeamScopeAllowedByJobRole(jobRole: TeamJobRole, policy: KpiGuardPolicy): boolean {
    const allowed = policy.teamScopeAllowedJobRoles;
    if (!allowed || allowed.length === 0) return false;

    for (const r of allowed) {
      if (r === jobRole) return true;
    }
    return false;
  }
}