// Path: src/source/notifications/text-template.source.ts
// =============================================================================
// NotificationTextTemplateSource (Backend Title/Body builder by eventKey)
// =============================================================================
// 01. Introduction
// - Central backend builder for NotificationCoreDto.title and .body.
// - Converts eventKey + context (actor/target/vars) into human readable text.
//
// 02. Important matters
// - Contract-driven: NotificationCoreDto requires title/body => backend MUST set.
// - exactOptionalPropertyTypes-safe: never assign undefined into dto fields.
// - Template tokens are replaced safely; missing tokens become "" not "undefined".
//
// 03. Why we make this class
// - Guarantees contract consistency for ALL clients (web/electron/mobile/email).
// - Prevents UI from implementing business language.
// - Makes it easy to revise message language centrally.
//
// 04. Usage hint
// - const { title, body } = NotificationTextTemplateSource.build(input);
// - hub engine assigns title/body when missing.
//
// 05. Keep in mind
// - If you add new event keys, add templates here (fallback covers unknown keys).
// =============================================================================

import type {
  NotificationEmitInput,
  NotificationTextContext,
  NotificationTextPacket,
} from "./text-template.types";

export class NotificationTextTemplateSource {
  /**
   * Build title/body for a notification based on eventKey and context.
   *
   * @param input
   * - Expected: NotificationEmitInput (eventKey + actor + optional target/vars)
   * - Usage: Hub calls this during normalization to fill title/body.
   */
  public static build(input: NotificationEmitInput): NotificationTextPacket {
    const key = this.s(input.eventKey);
    if (!key) return { title: "Notification", body: "You have a new notification." };

    const ctx: NotificationTextContext = this.toContext(input);

    const titleTpl = this.EXACT_TITLE[key];
    const bodyTpl = this.EXACT_BODY[key];

    const title = titleTpl ? this.render(titleTpl, ctx) : this.fallbackTitle(key, ctx);
    const body = bodyTpl ? this.render(bodyTpl, ctx) : this.fallbackBody(key, ctx);

    return { title, body };
  }

  // =============================================================================
  // Exact templates
  // =============================================================================

  private static readonly EXACT_TITLE: Record<string, string> = {
    "user:account.created": "User account created",
    "user:account.updated": "User account updated",
    "user:account.deleted": "User account deleted",
    "user:account.activated": "User account activated",
    "user:account.deactivated": "User account deactivated",
    "user:account.password.reset": "Password reset requested",
    "user:account.password.changed": "Password changed",
    "user:account.locked": "User account locked",
    "user:account.unlocked": "User account unlocked",
    "user:account.role.changed": "User role changed",
    "user:profile.updated": "Profile updated",
    "user:login.success": "Login successful",
    "user:login.failed": "Login failed",
    "user:mfa.enabled": "MFA enabled",
    "user:mfa.disabled": "MFA disabled",
    "user:account.auto_delete.failed": "Auto delete failed",
    "user:account.auto_delete.executed": "Auto delete executed",

    "lease:agreement.created": "Lease agreement created",
    "lease:agreement.renewed": "Lease agreement renewed",
    "lease:agreement.terminated": "Lease agreement terminated",
    "lease:agreement.downloaded": "Lease agreement downloaded",
    "lease:agreement.viewed": "Lease agreement viewed",
    "lease:signature.completed": "Signatures completed",

    "payment:invoice.generated": "Invoice generated",
    "payment:invoice.sent": "Invoice sent",
    "payment:invoice.paid": "Invoice paid",
    "payment:transaction.failed": "Transaction failed",
    "payment:refund.completed": "Refund completed",

    // add remaining keys same pattern…
  };

  private static readonly EXACT_BODY: Record<string, string> = {
    "user:account.created": "{actor} created a user account for {username}.",
    "user:account.updated": "{actor} updated the user account {username}.",
    "user:account.deleted": "{actor} deleted the user account {username}.",
    "user:account.role.changed": "{actor} changed the role of {username} to {role}.",

    "user:account.auto_delete.executed": "Auto delete executed for {username}.",
    "user:account.auto_delete.failed": "Auto delete failed for {username}. {reason}",

    "lease:agreement.created": "{actor} created a lease agreement. Ref: {refId}.",
    "lease:agreement.downloaded": "Lease agreement downloaded. Ref: {refId}.",
    "lease:agreement.viewed": "Lease agreement viewed. Ref: {refId}.",

    "payment:invoice.generated": "Invoice generated. Ref: {refId}. Amount: {amount} {currency}.",
    "payment:invoice.paid": "Invoice paid. Ref: {refId}. Amount: {amount} {currency}.",
    "payment:transaction.failed": "A payment transaction failed. Ref: {refId}. {reason}",

    // add remaining keys same pattern…
  };

  // =============================================================================
  // Context extraction
  // =============================================================================

  private static toContext(input: NotificationEmitInput): NotificationTextContext {
    const actor = this.s(input.actor?.username) || "System";

    const vars = input.vars ?? {};
    const username = this.s(vars["username"]) || this.s(input.target?.params?.["username"]);
    const role = this.s(vars["role"]) || this.s(input.target?.params?.["role"]);
    const team = this.s(vars["team"]) || this.s(input.target?.params?.["teamCode"]);
    const refId = this.s(vars["refId"]) || this.s(input.target?.refId);

    const amount = this.s(vars["amount"]) || this.s(input.target?.params?.["amount"]);
    const currency = this.s(vars["currency"]) || this.s(input.target?.params?.["currency"]);

    const reason = this.s(vars["reason"]) || this.s(input.target?.params?.["reason"]);

    return {
      actor,
      username,
      role,
      team,
      refId,
      amount,
      currency,
      reason,
    };
  }

  // =============================================================================
  // Template render
  // =============================================================================

  private static render(tpl: string, ctx: NotificationTextContext): string {
    const map: Record<string, string> = {
      "{actor}": this.s(ctx.actor) || "System",
      "{username}": this.s(ctx.username) || "the user",
      "{role}": this.s(ctx.role) || "a role",
      "{team}": this.s(ctx.team) || "the team",
      "{refId}": this.s(ctx.refId) || "N/A",
      "{amount}": this.s(ctx.amount),
      "{currency}": this.s(ctx.currency),
      "{reason}": this.s(ctx.reason),
    };

    let out = tpl;
    for (const token of Object.keys(map)) {
      out = out.split(token).join(map[token]);
    }

    return this.compact(out);
  }

  // =============================================================================
  // Fallbacks (unknown keys)
  // =============================================================================

  private static fallbackTitle(key: string, ctx: NotificationTextContext): string {
    const readable = this.toTitle(this.humanize(key));
    const ref = this.s(ctx.refId);
    return ref ? `${readable} — Ref: ${ref}` : readable || "Notification";
  }

  private static fallbackBody(key: string, ctx: NotificationTextContext): string {
    const actor = this.s(ctx.actor) || "System";
    const readable = this.humanize(key);
    const ref = this.s(ctx.refId);
    return ref ? `${actor}: ${readable}. (Ref: ${ref})` : `${actor}: ${readable}.`;
  }

  // =============================================================================
  // Helpers
  // =============================================================================

  private static humanize(key: string): string {
    return this.compact(key.replace(":", " ").replace(/\./g, " "));
  }

  private static toTitle(v: string): string {
    const s = this.s(v);
    if (!s) return "";
    return s
      .split(" ")
      .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : ""))
      .join(" ")
      .trim();
  }

  private static compact(v: string): string {
    return v.replace(/\s+/g, " ").replace(" .", ".").trim();
  }

  private static s(v: unknown): string {
    return typeof v === "string" ? v.trim() : "";
  }
}