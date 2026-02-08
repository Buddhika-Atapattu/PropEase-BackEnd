// src/source/notification-policy.source.ts
// ─────────────────────────────────────────────────────────────────────────────
// NotificationPolicySource (Single Source of Truth)
// PURPOSE:
// - Enforce mandatory metadata rules per category + type.
// - Prevent "restore impossible" situations (especially for Comment delete).
// - Provide a single place developers must follow when adding categories/types.
//
// DESIGN:
// - Registry = declarative policies
// - Validator = reusable, can be warn-mode first to avoid breaking system
// ─────────────────────────────────────────────────────────────────────────────

import type {
  TitleCategory,
  DefinedTypes,
} from "../../models/notifications/notification.model";

import type {
  CreateNotificationDTO,
} from "../../services/notification.service";

/** How strict you want to be. Start with "warn", later switch to "throw". */
export type PolicyEnforcementMode = "warn" | "throw";

/** A single requirement: e.g. "metadata.data.snapshot" must exist. */
export interface RequiredPathRule {
  /** Dot-path from root notification object. Example: "metadata.data.__filesRoot" */
  path: string;

  /** Human reason why it is required (developer guidance). */
  reason: string;
}

/** Category+Type policy */
export interface NotificationPolicy {
  category: TitleCategory;

  /**
   * Type can be:
   * - exact ("delete")
   * - wildcard ("*") for all types in that category
   */
  type: DefinedTypes | "*";

  required: ReadonlyArray<RequiredPathRule>;
}

export class NotificationPolicySource {
  // ───────────────────────────────────────────────────────────────────────────
  // 1) Registry (THE SOURCE)
  // ───────────────────────────────────────────────────────────────────────────

  private static readonly POLICIES: ReadonlyArray<NotificationPolicy> = [
    // ───────────────────────────────────────────────────────────────────────
    // COMMENT — the critical one
    // Why:
    // - If you delete Comment DB record, restore will have NO DB snapshot.
    // - Therefore delete notification MUST carry full snapshot + filesRoot.
    // ───────────────────────────────────────────────────────────────────────
    {
      category: "Comment",
      type: "delete",
      required: [
        {
          path: "metadata.refId",
          reason: "Comment delete must include metadata.refId (commentId) for restore/audit linkage.",
        },
        {
          path: "metadata.data.snapshot",
          reason:
            "Comment delete must include full snapshot because restore may have no DB record.",
        },
        {
          path: "metadata.data.__filesRoot",
          reason:
            "Comment delete must include __filesRoot so restored files go back to correct uploads/comments/... tree.",
        },
      ],
    },

    // If you use permanent_delete for comments too, enforce same rule:
    {
      category: "Comment",
      type: "permanent_delete",
      required: [
        {
          path: "metadata.refId",
          reason: "Comment permanent delete must include metadata.refId (commentId).",
        },
        {
          path: "metadata.data.snapshot",
          reason:
            "Comment permanent delete should include snapshot for full audit trail (optional for restore, but required for compliance).",
        },
        {
          path: "metadata.data.__filesRoot",
          reason:
            "Comment permanent delete should include __filesRoot for deterministic cleanup auditing.",
        },
      ],
    },

    // ───────────────────────────────────────────────────────────────────────
    // Generic best-practice rule (optional):
    // For ANY restore event, you usually want metadata.refId at minimum.
    // Keep it warn-mode initially if you fear older code.
    // ───────────────────────────────────────────────────────────────────────
    {
      category: "System",
      type: "restore",
      required: [
        {
          path: "metadata.refId",
          reason: "Restore notifications should include metadata.refId (restored entity id).",
        },
      ],
    },
  ] as const;

  // ───────────────────────────────────────────────────────────────────────────
  // 2) Public API
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Validate notification doc against policy.
   * - mode="warn": console.warn only
   * - mode="throw": throw Error (strict enforcement)
   *
   * This does NOT mutate doc. It only validates.
   */
  public static validateCreateDoc(
    doc: CreateNotificationDTO,
    mode: PolicyEnforcementMode = "warn",
  ): void {
    const category = (doc.target?.kind ?? (doc as unknown as { category?: TitleCategory }).category) as
      | TitleCategory
      | undefined;

    // In your system, category is stored in model hook from title.
    // But "CreateNotificationDTO" may not explicitly contain category.
    // So we infer from target.kind when available.
    if (!category) return;

    const type = doc.type;

    const policies = this.findPolicies(category, type);
    if (policies.length === 0) return;

    const errors: string[] = [];

    for (const p of policies) {
      for (const r of p.required) {
        const ok = this.hasPathValue(doc, r.path);
        if (!ok) {
          errors.push(
            `[PolicyViolation] category="${category}" type="${type}" missing "${r.path}". Reason: ${r.reason}`,
          );
        }
      }
    }

    if (errors.length === 0) return;

    if (mode === "throw") {
      throw new Error(errors.join("\n"));
    }

    // warn-mode (safe for existing code)
    console.warn("[Warning:] [NotificationPolicySource] Policy validation failed.\n");
    errors.forEach((e) => console.warn(e + "\n"));
  }

  /**
   * Developer helper: builds the mandatory comment-delete metadata object.
   * This helps devs follow the rule by construction (not memory).
   */
  public static buildCommentDeleteMetadata(input: {
    commentId: string;
    snapshot: Record<string, unknown>;
    filesRoot: string; // must be "uploads/..."
  }): { refId: string; data: { snapshot: Record<string, unknown>; __filesRoot: string } } {
    const commentId = String(input.commentId ?? "").trim();
    if (!commentId) throw new Error("commentId is required.");

    const filesRoot = String(input.filesRoot ?? "").trim();
    if (!filesRoot.startsWith("uploads/")) {
      throw new Error('filesRoot must start with "uploads/".');
    }

    return {
      refId: commentId,
      data: {
        snapshot: input.snapshot,
        __filesRoot: filesRoot,
      },
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 3) Internal helpers
  // ───────────────────────────────────────────────────────────────────────────

  private static findPolicies(category: TitleCategory, type: DefinedTypes): NotificationPolicy[] {
    // Match exact first, then wildcard
    return this.POLICIES.filter(
      (p) => p.category === category && (p.type === type || p.type === "*"),
    );
  }

  /**
   * Checks that a dot-path exists AND is not empty.
   * Rules:
   * - missing => false
   * - undefined/null => false
   * - "" (empty string) => false
   * - empty object {} => false
   * - empty array [] => false
   */
  private static hasPathValue(obj: unknown, dotPath: string): boolean {
    const parts = dotPath.split(".").map((x) => x.trim()).filter(Boolean);
    if (parts.length === 0) return false;

    let cur: unknown = obj;

    for (const key of parts) {
      if (!cur || typeof cur !== "object") return false;
      const rec = cur as Record<string, unknown>;
      cur = rec[key];
    }

    if (cur === null || typeof cur === "undefined") return false;

    if (typeof cur === "string") return cur.trim().length > 0;

    if (Array.isArray(cur)) return cur.length > 0;

    if (typeof cur === "object") return Object.keys(cur as Record<string, unknown>).length > 0;

    return true;
  }
}
