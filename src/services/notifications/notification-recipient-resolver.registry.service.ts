// Path: src/services/notifications/notification-recipient-resolver.registry.service.ts
// =============================================================================
// NotificationRecipientResolverRegistry (Upgraded + Hardened)
// =============================================================================
//
// 01) Introduction / usage
// - Central registry for recipient resolvers used by NotificationHubEngineService.
// - Keeps hub decoupled from module/domain logic:
//    - Company audience resolver
//    - Role audience resolver
//    - Team audience resolver
//    - User audience resolver
//
// 02) Important matters
// - Resolvers MUST return usernames (string[]) only.
// - Registry guarantees:
//    - safe fallback to { usernames: [] } when resolver is missing
//    - strict sanitization (trim + remove blanks + de-dup)
//    - never throws outward (won't break business transactions)
// - exactOptionalPropertyTypes-safe:
//    - ctx.session remains optional; registry never injects undefined keys.
//
// 03) Why we make this class/methods
// - Hub should not know how to resolve recipients for each audience type.
// - Registry allows bootstraps (NotificationResolversBootstrap) to wire resolvers once at startup.
// - Keeps ISO/IEC 27001 aligned principle: least privilege + clear separation of responsibilities.
//
// 04) Keep in mind
// - Call register*() exactly once at startup (bootstrap).
// - If a resolver throws, registry logs and returns empty to prevent cascade failures.
// - If you want strict "fail fast" behavior, add a "strict" mode later (not now).
// =============================================================================

import type { RecipientResolveContext, RecipientResolution } from "./notification-hub-engine.service";
import type { NotificationAudience } from "../../types/notification/notification.types";

type CompanyResolver = (ctx: RecipientResolveContext) => Promise<RecipientResolution>;
type RoleResolver = (roleKey: string, ctx: RecipientResolveContext) => Promise<RecipientResolution>;
type TeamResolver = (teamCode: string, ctx: RecipientResolveContext) => Promise<RecipientResolution>;
type UserResolver = (username: string, ctx: RecipientResolveContext) => Promise<RecipientResolution>;

export class NotificationRecipientResolverRegistry {
  private constructor() {}

  private static companyResolver: CompanyResolver | null = null;
  private static roleResolver: RoleResolver | null = null;
  private static teamResolver: TeamResolver | null = null;
  private static userResolver: UserResolver | null = null;

  /**
   * Register resolver for Company audience.
   *
   * @param fn
   * - Expected: async (ctx) => ({ usernames: string[] })
   * - Usage: returns all usernames that should receive company-wide notifications.
   *
   * Keep in mind
   * - Register at startup only (bootstrap). Avoid re-registering at runtime.
   */
  public static registerCompany(fn: CompanyResolver): void {
    this.companyResolver = fn;
  }

  /**
   * Register resolver for Role audience.
   *
   * @param fn
   * - Expected: async (roleKey, ctx) => ({ usernames: string[] })
   * - Usage: returns usernames for the given role key.
   */
  public static registerRole(fn: RoleResolver): void {
    this.roleResolver = fn;
  }

  /**
   * Register resolver for Team audience.
   *
   * @param fn
   * - Expected: async (teamCode, ctx) => ({ usernames: string[] })
   * - Usage: returns usernames for members of the given team code.
   */
  public static registerTeam(fn: TeamResolver): void {
    this.teamResolver = fn;
  }

  /**
   * Register resolver for User audience.
   *
   * @param fn
   * - Expected: async (username, ctx) => ({ usernames: string[] })
   * - Usage: returns usernames for a direct user audience (usually 1 username).
   */
  public static registerUser(fn: UserResolver): void {
    this.userResolver = fn;
  }

  /**
   * Resolve a single audience into usernames.
   *
   * @param audience
   * - Expected: NotificationAudience union (Company/Role/Team/User)
   * - Usage: one audience rule from NotificationEmitInput.audiences[]
   *
   * @param ctx
   * - Expected: RecipientResolveContext
   * - Usage: includes optional mongoose session when emit runs in transaction
   *
   * @returns RecipientResolution
   * - Always returns an object with usernames: string[]
   *
   * Keep in mind
   * - This method never throws outward (best-effort to avoid breaking emit()).
   * - Output is always sanitized (trim + remove blanks + de-dup).
   */
  public static async resolve(audience: NotificationAudience, ctx: RecipientResolveContext): Promise<RecipientResolution> {
    try {
      // Defensive: if caller passes wrong shape, fail-safe.
      if (!audience || typeof audience !== "object") {
        return { usernames: [] };
      }

      if (audience.mode === "Company") {
        if (!this.companyResolver) return { usernames: [] };
        const res = await this.companyResolver(ctx);
        return { usernames: this.sanitizeUsernames(res?.usernames) };
      }

      if (audience.mode === "Role") {
        if (!this.roleResolver) return { usernames: [] };
        const roleKey = this.safeString((audience as { roleKey?: unknown }).roleKey);
        if (!roleKey) return { usernames: [] };

        const res = await this.roleResolver(roleKey, ctx);
        return { usernames: this.sanitizeUsernames(res?.usernames) };
      }

      if (audience.mode === "Team") {
        if (!this.teamResolver) return { usernames: [] };
        const teamCode = this.safeString((audience as { teamCode?: unknown }).teamCode);
        if (!teamCode) return { usernames: [] };

        const res = await this.teamResolver(teamCode, ctx);
        return { usernames: this.sanitizeUsernames(res?.usernames) };
      }

      if (audience.mode === "User") {
        if (!this.userResolver) return { usernames: [] };
        const username = this.safeString((audience as { username?: unknown }).username);
        if (!username) return { usernames: [] };

        const res = await this.userResolver(username, ctx);
        return { usernames: this.sanitizeUsernames(res?.usernames) };
      }

      return { usernames: [] };
    } catch (err) {
      // eslint-disable-next-line no-console
      console.log(`[Error:] NotificationRecipientResolverRegistry.resolve failed: ${(err as Error)?.message ?? "unknown"}\n`);
      return { usernames: [] };
    }
  }

  // =============================================================================
  // Internal helpers (class-based, strict-safe)
  // =============================================================================

  /**
   * Sanitize usernames:
   * - trims
   * - removes empty
   * - de-duplicates
   */
  private static sanitizeUsernames(input: unknown): string[] {
    const list = Array.isArray(input) ? input : [];
    const out: string[] = [];
    const seen = new Set<string>();

    for (const v of list) {
      const u = typeof v === "string" ? v.trim() : "";
      if (!u) continue;

      if (seen.has(u)) continue;
      seen.add(u);
      out.push(u);
    }

    return out;
  }

  private static safeString(v: unknown): string {
    if (typeof v === "string") return v.trim();
    if (typeof v === "number") return String(v);
    return "";
  }
}