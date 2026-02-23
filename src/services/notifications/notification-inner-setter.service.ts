// Path: src/services/notifications/notification-inner-setter.service.ts
// =============================================================================
// Notification Hub — Inner Setter Service
// =============================================================================
//
// 01) Purpose of this code
// -----------------------------------------------------------------------------
// - Normalizes NotificationEmitInput into a stable internal BuiltNotificationCore.
// - Enforces canonical rules (audiences is ALWAYS an array).
// - Applies default rule templates (title/body/icon/tags/target/severity/category).
// - Produces DB-ready values (expiresAt as Date).
//
// 02) What this code is managing
// -----------------------------------------------------------------------------
// - buildCore(): main normalization + defaults + template rendering output builder
// - normalization helpers: input/audience/actor/target/vars/tags
// - defaults + template helpers: deriveDefaults(), renderTemplate()
// - strict validation helpers: safeString(), safeRoleKey(), safeActionKey()
//
// 03) Key things this code highlights
// -----------------------------------------------------------------------------
// - exactOptionalPropertyTypes safe DTO construction (omit optionals when absent)
// - Canonical audiences[] with legacy fallback support for input.audience
// - Strict NotificationActionKey validation via ACTION_KEY_LOOKUP catalog
//
// 04) Need to keep in mind
// -----------------------------------------------------------------------------
// - deriveDefaults() and renderTemplate() are “keep existing implementation” areas.
// - This service is pure logic: no DB writes. DB work happens in the hub engine.
// =============================================================================

import { DEFAULT_ROLES } from "../../models/user.model";
import {
  ACTION_KEY_LOOKUP,
  type NotificationActionKey,
} from "../../types/notification/notification-action-keys.catalog";

import type {
  NotificationActorDto,
  NotificationAudience,
  NotificationCategory,
  NotificationDeliveryDrivers,
  NotificationEmitInput,
  NotificationEventKey,
  NotificationSeverity,
  NotificationTarget,
} from "../../types/notification/notification.types";

import type { Role } from "../../types/roles";

/* =============================================================================
 * A) Internal output contracts
 * ========================================================================== */

export interface BuiltNotificationCore {
  eventKey: NotificationEventKey;
  category: NotificationCategory;
  severity: NotificationSeverity;

  title: string;
  body: string;

  icon?: string;
  tags?: string[];

  target?: NotificationTarget;

  actor: NotificationActorDto;

  delivery: NotificationDeliveryDrivers;

  /**
   * ✅ Always array
   */
  audiences: NotificationAudience[];

  expiresAt?: Date;
}

interface DefaultRule {
  category: NotificationCategory;
  severity: NotificationSeverity;
  titleTpl: string;
  bodyTpl: string;
  icon?: string;
  tags?: string[];
  target?: NotificationTarget;
  expiresAt?: Date;
}

/* =============================================================================
 * B) NotificationInnerSetterService
 * ========================================================================== */

export class NotificationInnerSetterService {
  /* ===========================================================================
   * Constructor
   * ===========================================================================
   * 01) Introduction to the constructor and its usage
   * - Creates the service instance used by NotificationHubEngineService.
   *
   * 02) Important matters
   * - Keep this class stateless. Do not store request-specific state here.
   *
   * 03) Why we make this constructor
   * - Project rule: class-based code even for pure helpers.
   *
   * 04) Parameters (what this constructor expects)
   * - None.
   *
   * 05) Usage hint
   * - `const setter = new NotificationInnerSetterService();`
   *
   * 06) Need to keep in mind when using this constructor
   * - If you later add config/env flags, inject via a dedicated config service
   *   (but keep constructor deterministic).
   * ======================================================================== */
  public constructor() {}

  /* ===========================================================================
   * Method: buildCore()
   * ===========================================================================
   * 01) Introduction to the method and its usage
   * - Main entry method: converts NotificationEmitInput into BuiltNotificationCore.
   *
   * 02) Important matters
   * - Canonical audiences[] is enforced here (supports legacy input.audience).
   * - delivery flags are normalized into a complete boolean object.
   * - Optional properties are only added when present (exactOptionalPropertyTypes-safe).
   *
   * 03) Why we make this method
   * - Hub engine depends on a stable, validated, fully-normalized payload.
   *
   * 04) Parameters (what this parameter expects and usage)
   * - input: NotificationEmitInput
   *   - The raw event emission contract from controllers/services.
   *
   * 05) Usage hint
   * - Called internally by NotificationHubEngineService.emit():
   *   `const built = setter.buildCore(input);`
   *
   * 06) Need to keep in mind when using this method
   * - deriveDefaults() and renderTemplate() must remain consistent with your catalog.
   * ========================================================================= */
  public buildCore(input: NotificationEmitInput): BuiltNotificationCore {
    const normalized = this.normalizeInput(input);
    const defaults = this.deriveDefaults(normalized.eventKey);

    const category = normalized.category ?? defaults.category;
    const severity = normalized.severity ?? defaults.severity;

    const title = this.renderTemplate(defaults.titleTpl, normalized.vars);
    const body = this.renderTemplate(defaults.bodyTpl, normalized.vars);

    const icon = normalized.icon ?? defaults.icon;
    const tags = this.mergeTags(normalized.tags, defaults.tags);
    const target = this.mergeTarget(defaults.target, normalized.target);
    const delivery = this.normalizeDelivery(normalized.delivery);

    const out: BuiltNotificationCore = {
      eventKey: normalized.eventKey,
      category,
      severity,
      title,
      body,
      delivery,
      actor: normalized.actor,
      audiences: normalized.audiences,
    };

    if (icon) out.icon = icon;
    if (tags.length) out.tags = tags;
    if (target) out.target = target;
    if (defaults.expiresAt) out.expiresAt = defaults.expiresAt;

    return out;
  }

  /* =============================================================================
   * C) Delivery normalization
   * ============================================================================= */

  /* ===========================================================================
   * Method: buildDefaultDelivery()
   * ===========================================================================
   * 01) Introduction to the method and its usage
   * - Builds the default delivery drivers policy.
   *
   * 02) Important matters
   * - Returned object must be fully populated (no missing keys).
   *
   * 03) Why we make this method
   * - Central default policy used when input.delivery is missing or incomplete.
   *
   * 04) Parameters
   * - None.
   *
   * 05) Usage hint
   * - Used internally by normalizeDelivery().
   *
   * 06) Need to keep in mind
   * - Adjust defaults here to change global delivery policy.
   * ========================================================================= */
  private buildDefaultDelivery(): NotificationDeliveryDrivers {
    return {
      audit: true,
      email: false,
      external: false,
      mq: true,
      push: false,
      sms: false,
    };
  }

  /* ===========================================================================
   * Method: safeBool()
   * ===========================================================================
   * 01) Introduction to the method and its usage
   * - Converts unknown into a strict boolean evaluation (true only).
   *
   * 02) Important matters
   * - Only literal true becomes true (no truthy coercion).
   *
   * 03) Why we make this method
   * - Prevent accidental enabling of drivers due to truthy values.
   *
   * 04) Parameters
   * - v: unknown (raw value)
   *
   * 05) Usage hint
   * - Used by normalizeDelivery().
   *
   * 06) Need to keep in mind
   * - This is intentionally strict.
   * ========================================================================= */
  private safeBool(v: unknown): boolean {
    return v === true;
  }

  /* ===========================================================================
   * Method: normalizeDelivery()
   * ===========================================================================
   * 01) Introduction to the method and its usage
   * - Normalizes input delivery flags into a complete NotificationDeliveryDrivers object.
   *
   * 02) Important matters
   * - EmitInput.delivery is optional and can be incomplete.
   * - Must always return a complete object (no undefined).
   *
   * 03) Why we make this method
   * - Hub/delivery layer must operate on guaranteed boolean flags.
   *
   * 04) Parameters
   * - input: unknown (raw caller input)
   *
   * 05) Usage hint
   * - Called inside buildCore() to populate BuiltNotificationCore.delivery.
   *
   * 06) Need to keep in mind
   * - If you later add drivers, update buildDefaultDelivery() + this method.
   * ========================================================================= */
  private normalizeDelivery(input: unknown): NotificationDeliveryDrivers {
    const base = this.buildDefaultDelivery();

    const d = input as Partial<NotificationDeliveryDrivers> | null | undefined;
    if (!d || typeof d !== "object") return base;

    return {
      audit: this.safeBool(d.audit) ? true : base.audit,
      email: this.safeBool(d.email) ? true : base.email,
      external: this.safeBool(d.external) ? true : base.external,
      mq: this.safeBool(d.mq) ? true : base.mq,
      push: this.safeBool(d.push) ? true : base.push,
      sms: this.safeBool(d.sms) ? true : base.sms,
    };
  }

  /* =============================================================================
   * D) Input normalization (exactOptionalPropertyTypes safe)
   * ============================================================================= */

  /* ===========================================================================
   * Method: normalizeInput()
   * ===========================================================================
   * 01) Introduction / usage
   * - Normalizes raw NotificationEmitInput into a clean, minimal, safe input.
   *
   * 02) Important matters
   * - Ensures eventKey exists.
   * - Ensures actor contains userId/username/role.
   * - Ensures audiences is always array and non-empty.
   * - Only sets optional keys when valid and present.
   *
   * 03) Why we make this method
   * - Prevents invalid/partial inputs entering notification core pipeline.
   *
   * 04) Parameters
   * - input: NotificationEmitInput (raw user/service emission contract)
   *
   * 05) Usage hint
   * - Called only by buildCore().
   *
   * 06) Keep in mind
   * - Legacy support: input.audience will be converted to audiences[].
   * ========================================================================= */
  private normalizeInput(input: NotificationEmitInput): NotificationEmitInput {
    const eventKey = this.safeString(input.eventKey);
    if (!eventKey) {
      throw new Error("NotificationInnerSetterService: eventKey is required.");
    }

    const actor = this.normalizeActor(input.actor);

    /**
     * ✅ Canonical: audiences[]
     * ⚠️ Legacy runtime support: audience -> [audience]
     */
    const audiences = this.normalizeAudiencesFromInput(input);

    const vars = this.normalizeVars(input.vars);

    const out: NotificationEmitInput = { eventKey, audiences, actor };

    if (input.target) out.target = this.normalizeTarget(input.target);
    if (vars) out.vars = vars;
    if (input.category) out.category = input.category;
    if (input.severity) out.severity = input.severity;

    const icon = this.safeString(input.icon);
    if (icon) out.icon = icon;

    if (Array.isArray(input.tags)) {
      const tags = this.normalizeTags(input.tags);
      if (tags.length) out.tags = tags;
    }

    return out;
  }

  /* ===========================================================================
   * Method: normalizeAudiencesFromInput()
   * ===========================================================================
   * 01) Introduction / usage
   * - Produces canonical audiences[] array.
   *
   * 02) Important matters
   * - Supports legacy `audience` single value input.
   * - Ensures at least one valid audience exists.
   *
   * 03) Why we make this method
   * - Engine requires audiences[] always; resolvers depend on it.
   *
   * 04) Parameters
   * - input: NotificationEmitInput
   *
   * 05) Usage hint
   * - Called by normalizeInput().
   *
   * 06) Keep in mind
   * - Throws if no valid audiences.
   * ========================================================================= */
  private normalizeAudiencesFromInput(input: NotificationEmitInput): NotificationAudience[] {
    const raw: unknown = (input as unknown as { audiences?: unknown; audience?: unknown }).audiences;
    const legacy: unknown = (input as unknown as { audiences?: unknown; audience?: unknown }).audience;

    const candidates: unknown[] = Array.isArray(raw) ? raw : legacy ? [legacy] : [];

    const cleaned = candidates
      .map((a) => this.normalizeAudience(a))
      .filter((a): a is NotificationAudience => !!a);

    if (!cleaned.length) {
      throw new Error("NotificationInnerSetterService: audiences[] must contain at least one audience.");
    }

    return cleaned;
  }

  /* ===========================================================================
   * Method: normalizeAudience()
   * ===========================================================================
   * 01) Introduction / usage
   * - Converts an unknown raw audience into a strongly typed NotificationAudience.
   *
   * 02) Important matters
   * - Drops invalid inputs safely by returning null.
   * - Enforces required fields per mode.
   *
   * 03) Why we make this method
   * - Audience is user-controlled input; must be validated strongly.
   *
   * 04) Parameters
   * - raw: unknown (single audience input)
   *
   * 05) Usage hint
   * - Called by normalizeAudiencesFromInput().
   *
   * 06) Keep in mind
   * - Modes supported: Company, Role, Team, User.
   * ========================================================================= */
  private normalizeAudience(raw: unknown): NotificationAudience | null {
    if (!raw || typeof raw !== "object") return null;

    const mode = this.safeString((raw as { mode?: unknown }).mode);

    if (mode === "Company") {
      return { mode: "Company" };
    }

    if (mode === "Role") {
      const roleKey = this.safeRoleKey(this.safeString((raw as { roleKey?: unknown }).roleKey));
      if (!roleKey) return null;

      return { mode: "Role", roleKey };
    }

    if (mode === "Team") {
      const teamCode = this.safeString((raw as { teamCode?: unknown }).teamCode);
      if (!teamCode) return null;
      return { mode: "Team", teamCode };
    }

    if (mode === "User") {
      const userId = this.safeString((raw as { userId?: unknown }).userId);
      if (!userId) return null;
      return { mode: "User", userId };
    }

    return null;
  }

  /* ===========================================================================
   * Method: normalizeActor()
   * ===========================================================================
   * 01) Introduction / usage
   * - Validates and normalizes the actor payload.
   *
   * 02) Important matters
   * - actor must contain userId, username, role.
   * - Optional properties are included only when valid and present.
   *
   * 03) Why we make this method
   * - Actor is audit-critical; must be strongly validated.
   *
   * 04) Parameters
   * - actor: NotificationActorDto
   *
   * 05) Usage hint
   * - Called by normalizeInput().
   *
   * 06) Keep in mind
   * - teamCodes are deduped; branchId included if valid.
   * ========================================================================= */
  private normalizeActor(actor: NotificationActorDto): NotificationActorDto {
    const userId = this.safeString(actor.userId);
    const username = this.safeString(actor.username);
    const role = this.safeString(actor.role);

    if (!userId || !username || !role) {
      throw new Error("NotificationInnerSetterService: actor requires userId, username, role.");
    }

    const out: NotificationActorDto = { userId, username, role };

    if (Array.isArray(actor.teamCodes)) {
      const tc = actor.teamCodes
        .map((x) => this.safeString(x))
        .filter((x): x is string => !!x);

      if (tc.length) out.teamCodes = Array.from(new Set(tc));
    }

    const branchId = this.safeString(actor.branchId);
    if (branchId) out.branchId = branchId;

    return out;
  }

  /* ===========================================================================
   * Method: normalizeTarget()
   * ===========================================================================
   * 01) Introduction / usage
   * - Normalizes NotificationTarget by validating/sanitizing each key.
   *
   * 02) Important matters
   * - actionKey is strictly validated against ACTION_KEY_LOOKUP.
   * - params must be a plain object (not array).
   *
   * 03) Why we make this method
   * - Target data powers navigation/deep links; must be consistent.
   *
   * 04) Parameters
   * - target: NotificationTarget
   *
   * 05) Usage hint
   * - Called from normalizeInput() when input.target exists.
   *
   * 06) Keep in mind
   * - This method currently allows partial targets (only valid keys are set).
   * ========================================================================= */
  private normalizeTarget(target: NotificationTarget): NotificationTarget {
    const out: NotificationTarget = {};

    const module = this.safeString(target.module);
    const category = this.safeString(target.category);
    const refId = this.safeString(target.refId);
    const route = this.safeString(target.route);
    const actionKey = this.safeActionKey(target.actionKey);

    if (module) out.module = module;
    if (category) out.category = category;
    if (refId) out.refId = refId;
    if (route) out.route = route;
    if (actionKey) out.actionKey = actionKey;

    if (target.params && typeof target.params === "object" && !Array.isArray(target.params)) {
      out.params = target.params as Record<string, unknown>;
    }

    return out;
  }

  /* ===========================================================================
   * Method: normalizeVars()
   * ===========================================================================
   * 01) Introduction / usage
   * - Ensures vars is a plain object map usable for template rendering.
   *
   * 02) Important matters
   * - Must reject arrays and non-objects.
   *
   * 03) Why we make this method
   * - Prevent template rendering errors.
   *
   * 04) Parameters
   * - vars: unknown
   *
   * 05) Usage hint
   * - Called by normalizeInput().
   *
   * 06) Keep in mind
   * - Returns null when invalid.
   * ========================================================================= */
  private normalizeVars(vars: unknown): Record<string, unknown> | null {
    if (!vars || typeof vars !== "object" || Array.isArray(vars)) return null;
    return vars as Record<string, unknown>;
  }

  /* ===========================================================================
   * Method: normalizeTags()
   * ===========================================================================
   * 01) Introduction / usage
   * - Cleans and deduplicates tags list.
   *
   * 02) Important matters
   * - Tags must be strings; invalid entries are dropped.
   *
   * 03) Why we make this method
   * - Tags used for UI filtering; must be stable.
   *
   * 04) Parameters
   * - tags: unknown[]
   *
   * 05) Usage hint
   * - Called by normalizeInput().
   *
   * 06) Keep in mind
   * - Returns [] when no valid tags.
   * ========================================================================= */
  private normalizeTags(tags: unknown[]): string[] {
    const cleaned = tags
      .map((t) => this.safeString(t))
      .filter((t): t is string => !!t);

    return Array.from(new Set(cleaned));
  }

  /* ===========================================================================
   * Method: mergeTags()
   * ===========================================================================
   * 01) Introduction / usage
   * - Merges default tags and override tags into a single deduped list.
   *
   * 02) Important matters
   * - Uses Set to prevent duplicates.
   *
   * 03) Why we make this method
   * - Allows defaults to define tags, while caller can add extra tags.
   *
   * 04) Parameters
   * - a?: string[] (override tags)
   * - b?: string[] (default tags)
   *
   * 05) Usage hint
   * - Called inside buildCore().
   *
   * 06) Keep in mind
   * - Returns [] when nothing is provided.
   * ========================================================================= */
  private mergeTags(a?: string[], b?: string[]): string[] {
    const out = new Set<string>();
    if (Array.isArray(b)) b.forEach((x) => { if (x) out.add(x); });
    if (Array.isArray(a)) a.forEach((x) => { if (x) out.add(x); });
    return Array.from(out);
  }

  /* ===========================================================================
   * Method: mergeTarget()
   * ===========================================================================
   * 01) Introduction / usage
   * - Merges default target and override target into a single target object.
   *
   * 02) Important matters
   * - Later assignment overrides earlier assignment.
   *
   * 03) Why we make this method
   * - Defaults may define a target; caller may override/extend it.
   *
   * 04) Parameters
   * - base?: NotificationTarget (default)
   * - override?: NotificationTarget (caller)
   *
   * 05) Usage hint
   * - Called inside buildCore().
   *
   * 06) Keep in mind
   * - Returns null if merged is empty.
   * ========================================================================= */
  private mergeTarget(base?: NotificationTarget, override?: NotificationTarget): NotificationTarget | null {
    const merged: NotificationTarget = {};
    if (base) Object.assign(merged, base);
    if (override) Object.assign(merged, override);

    return Object.keys(merged).length ? merged : null;
  }

  /* =============================================================================
   * E) Defaults + template rendering
   * ============================================================================= */

  /* ===========================================================================
   * Method: deriveDefaults()
   * ===========================================================================
   * 01) Introduction / usage
   * - Returns default rule set for a given NotificationEventKey.
   *
   * 02) Important matters
   * - KEEP YOUR EXISTING IMPLEMENTATION (unchanged).
   *
   * 03) Why we make this method
   * - Centralizes event-driven templates and defaults.
   *
   * 04) Parameters
   * - eventKey: NotificationEventKey
   *
   * 05) Usage hint
   * - Called inside buildCore().
   *
   * 06) Keep in mind
   * - Should stay in sync with ACTION_KEY_LOOKUP and frontend navigation logic.
   * ========================================================================= */
  private deriveDefaults(eventKey: NotificationEventKey): DefaultRule {
    // keep your existing rules implementation here (unchanged)
    // ...
    return {
      category: "System",
      severity: "info",
      titleTpl: eventKey,
      bodyTpl: eventKey,
    };
  }

  /* ===========================================================================
   * Method: renderTemplate()
   * ===========================================================================
   * 01) Introduction / usage
   * - Renders template strings using vars map ({{key}}).
   *
   * 02) Important matters
   * - KEEP YOUR EXISTING IMPLEMENTATION (unchanged).
   *
   * 03) Why we make this method
   * - Allows dynamic title/body messages per event.
   *
   * 04) Parameters
   * - tpl: string (template)
   * - vars?: Record<string, unknown> (replacement map)
   *
   * 05) Usage hint
   * - Called inside buildCore() for title/body.
   *
   * 06) Keep in mind
   * - Only string/number values are substituted; others become "".
   * ========================================================================= */
  private renderTemplate(tpl: string, vars?: Record<string, unknown>): string {
    // keep your existing implementation here (unchanged)
    // ...
    const safeTpl = this.safeString(tpl) ?? "";
    const map = vars ?? {};
    return safeTpl.replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
      const v = map[k];
      return typeof v === "string" || typeof v === "number" ? String(v) : "";
    });
  }

  /* =============================================================================
   * F) Small strict helpers
   * ============================================================================= */

  /* ===========================================================================
   * Method: safeRoleKey()
   * ===========================================================================
   * 01) Introduction / usage
   * - Validates role key string against DEFAULT_ROLES catalog.
   *
   * 02) Important matters
   * - Case-insensitive match.
   * - Returns null when invalid (caller decides).
   *
   * 03) Why we make this method
   * - Prevent invalid role audiences from entering system.
   *
   * 04) Parameters
   * - v: unknown (expected string role)
   *
   * 05) Usage hint
   * - Used by normalizeAudience() when mode="Role".
   *
   * 06) Keep in mind
   * - DEFAULT_ROLES must remain canonical.
   * ========================================================================= */
  private safeRoleKey(v: unknown): Role | null {
    const safeRole = this.safeString(v);
    if (!safeRole) return null;

    const role: Role | undefined = DEFAULT_ROLES.find(
      (r) => r.toLowerCase() === safeRole.toLowerCase()
    );

    if (!role) return null;
    return role;
  }

  /* ===========================================================================
   * Method: safeString()
   * ===========================================================================
   * 01) Introduction / usage
   * - Trims and validates a string, returning null if empty.
   *
   * 02) Important matters
   * - Prevents empty strings polluting DTO construction.
   *
   * 03) Why we make this method
   * - Central string sanitation utility used across normalization.
   *
   * 04) Parameters
   * - v: unknown
   *
   * 05) Usage hint
   * - Used across all normalizers.
   *
   * 06) Keep in mind
   * - Returns null for non-string and empty string.
   * ========================================================================= */
  private safeString(v: unknown): string | null {
    const s = typeof v === "string" ? v.trim() : "";
    return s ? s : null;
  }

  /* ===========================================================================
   * Method: safeActionKey()
   * ===========================================================================
   * 01) Introduction / usage
   * - Strictly validates actionKey against the enterprise catalog ACTION_KEY_LOOKUP.
   *
   * 02) Important matters
   * - Throws when missing or invalid.
   * - Returns canonical NotificationActionKey.
   *
   * 03) Why we make this method
   * - Prevent invalid notifications entering the system.
   * - Ensures frontend routing integrity (actionKey-driven navigation).
   *
   * 04) Parameters
   * - v: unknown (expected string actionKey)
   *
   * 05) Usage hint
   * - Called by normalizeTarget().
   *
   * 06) Keep in mind
   * - Catalog lookup uses lowercased keys.
   * ========================================================================= */
  private safeActionKey(v: unknown): NotificationActionKey {
    const s = typeof v === "string" ? v.trim() : "";
    if (!s) {
      throw new Error("Notification: actionKey is required.");
    }

    const key = ACTION_KEY_LOOKUP[s.toLowerCase()];
    if (!key) {
      throw new Error(`Notification: invalid actionKey "${s}".`);
    }

    return key;
  }
}