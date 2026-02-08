// src/source/notifications/notification-builder.source.ts
// ─────────────────────────────────────────────────────────────────────────────
// NotificationBuilderSource (Single-entry builder for notifications)
// PURPOSE:
// - Prevent developers from forgetting mandatory metadata.
// - Provide a safe, consistent API to build CreateNotificationDTO.
// - Especially for Comment delete (must include snapshot + __filesRoot).
//
// IMPORTANT (exactOptionalPropertyTypes: true):
// - You must NEVER pass `channels: undefined` (or any optional prop as `undefined`)
//   if that property exists on the object literal.
// - So in this builder we:
//   1) At call sites: only spread { channels } if it exists and is non-empty
//   2) In build(): always output `channels` with a safe default ["inapp"]
//
// NOTES:
// - This builder DOES NOT save to DB. It only returns CreateNotificationDTO.
// - NotificationService.createNotification(...) remains the only persistence API.
// - Works with your current NotificationModel (title → category hook).
// ─────────────────────────────────────────────────────────────────────────────

import type {
  Channel as NotificationChannel,
  DefinedTypes,
  Severity as NotificationSeverity,
  Title,
  TitleCategory,
} from "../../models/notifications/notification.model";

import type { Role } from "../../types/roles";

import type {
  CreateNotificationDTO,
  NotificationAudienceDTO,
  NotificationMetadata,
} from "../../services/notification.service";

import { NotificationPolicySource } from "./notification-policy.source";

/* ─────────────────────────────────────────────────────────────────────────────
 * Minimal shape for comment target (don’t bind to heavy DTO types here).
 * This avoids importing comment contracts inside the notification builder.
 * ──────────────────────────────────────────────────────────────────────────── */
export interface CommentTargetLite {
  section: string; // "Complaints" | "Users" | ...
  refId: string; // entity ref id
  subSection?: string; // e.g. "WorkItems" | "Events"
  scope?: Record<string, unknown> | null; // optional extra scoping
}

export class NotificationBuilderSource {
  // ───────────────────────────────────────────────────────────────────────────
  // 1) Audience helpers
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Audience by roles
   * - Example: ["admin","operator","manager"]
   */
  public static audienceRole(roles: Role[]): NotificationAudienceDTO {
    // Always clone arrays so caller mutations can’t affect built payloads.
    return { mode: "role", roles: [...roles] };
  }

  /**
   * Audience by usernames
   * - Example: ["buddhika","cheryl"]
   */
  public static audienceUsernames(usernames: string[]): NotificationAudienceDTO {
    return { mode: "user", usernames: [...usernames] };
  }

  /**
   * Broadcast audience
   * - Everyone eligible in NotificationService rules.
   */
  public static audienceBroadcast(): NotificationAudienceDTO {
    return { mode: "broadcast" };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 2) Comment builders (the important ones)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Comment created notification:
   * - Includes metadata.data.target so UI can deep-link to exact location.
   *
   * NOTE:
   * - channels is OPTIONAL input, but we DO NOT pass `channels: undefined`.
   * - build() always ensures dto.channels exists with default ["inapp"].
   */
  public static commentCreated(input: {
    commentId: string;
    audience: Role[] | NotificationAudienceDTO;
    target: CommentTargetLite;

    createdBy?: string; // username/id (optional audit)
    channels?: NotificationChannel[];
    severity?: NotificationSeverity;

    link?: string; // optional deep link if you already have it
    icon?: string;
    tags?: string[];
  }): CreateNotificationDTO {
    const commentId = this.reqStr(input.commentId, "commentId");
    const target = this.requireTarget(input.target);

    const metadata: NotificationMetadata = {
      refId: commentId,
      data: this.cleanObj({
        target,
        createdBy: input.createdBy,
      }),
    };

    return this.build({
      title: "New Comment",
      body: `New comment created for ${target.section} | ${target.refId}`,
      type: "create",
      audience: this.normalizeAudience(input.audience),

      // Optional props: only include if real value exists.
      ...(input.severity ? { severity: input.severity } : {}),
      ...(input.channels?.length ? { channels: input.channels } : {}),
      ...(input.link ? { link: input.link } : {}),
      ...(input.icon ? { icon: input.icon } : {}),
      ...(input.tags?.length ? { tags: input.tags } : {}),

      metadata,
      target: { kind: "Comment", refId: commentId },
    });
  }

  /**
   * Comment updated notification.
   */
  public static commentUpdated(input: {
    commentId: string;
    audience: Role[] | NotificationAudienceDTO;
    target: CommentTargetLite;

    updatedBy?: string;
    channels?: NotificationChannel[];
    severity?: NotificationSeverity;

    link?: string;
    icon?: string;
    tags?: string[];
  }): CreateNotificationDTO {
    const commentId = this.reqStr(input.commentId, "commentId");
    const target = this.requireTarget(input.target);

    const metadata: NotificationMetadata = {
      refId: commentId,
      data: this.cleanObj({
        target,
        updatedBy: input.updatedBy,
      }),
    };

    return this.build({
      title: "Update Comment",
      body: `Comment updated | ${commentId}`,
      type: "update",
      audience: this.normalizeAudience(input.audience),

      ...(input.severity ? { severity: input.severity } : {}),
      ...(input.channels?.length ? { channels: input.channels } : {}),
      ...(input.link ? { link: input.link } : {}),
      ...(input.icon ? { icon: input.icon } : {}),
      ...(input.tags?.length ? { tags: input.tags } : {}),

      metadata,
      target: { kind: "Comment", refId: commentId },
    });
  }

  /**
   * ✅ Comment deleted notification (SOFT delete that removes DB record):
   * MUST include:
   * - metadata.data.snapshot (full snapshot)
   * - metadata.data.__filesRoot (uploads/... root)
   *
   * This is the rule that makes restore possible without DB record.
   */
  public static commentDeleted(input: {
    commentId: string;
    audience: Role[] | NotificationAudienceDTO;
    target: CommentTargetLite;

    /** The full comment snapshot (lean object or toObject()) */
    snapshot: Record<string, unknown>;

    /** Public-relative uploads root: must start with "uploads/" */
    filesRoot: string;

    deletedBy?: string;
    channels?: NotificationChannel[];
    severity?: NotificationSeverity;

    link?: string;
    icon?: string;
    tags?: string[];
  }): CreateNotificationDTO {
    const commentId = this.reqStr(input.commentId, "commentId");
    const target = this.requireTarget(input.target);

    // Prefer snapshot.commentTarget if it exists (authoritative),
    // otherwise use the lite target from caller.
    const snapTarget =
      (input.snapshot as Record<string, unknown> | null)?.commentTarget ?? target;

    // Policy helper guarantees required fields exist for comment delete.
    const policyMeta = NotificationPolicySource.buildCommentDeleteMetadata({
      commentId,
      snapshot: this.cleanObj({
        ...input.snapshot,
        commentTarget: snapTarget,
      }) as Record<string, unknown>,
      filesRoot: this.reqUploadsRoot(input.filesRoot),
    });

    // Merge policy metadata with extra audit info (without breaking required keys).
    const mergedMeta: NotificationMetadata = {
      refId: policyMeta.refId,
      data: this.cleanObj({
        ...(policyMeta.data ?? {}),
        target,
        deletedBy: input.deletedBy,
      }),
    };

    return this.build({
      title: "Delete Comment",
      body: `Comment deleted | ${commentId}`,
      type: "delete",
      audience: this.normalizeAudience(input.audience),

      ...(input.severity ? { severity: input.severity } : {}),
      ...(input.channels?.length ? { channels: input.channels } : {}),
      ...(input.link ? { link: input.link } : {}),
      ...(input.icon ? { icon: input.icon } : {}),
      ...(input.tags?.length ? { tags: input.tags } : {}),

      metadata: mergedMeta,
      target: { kind: "Comment", refId: commentId },
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 3) Generic domain action builders (restore / permanent_delete)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Generic restore notification.
   * - Title must match your NotificationCatalog.TITLE_VALUES conventions:
   *   "Restore <Category>"
   */
  public static domainRestored(input: {
    category: TitleCategory;
    refId: string;
    requestedBy: string;

    audience?: Role[] | NotificationAudienceDTO;
    channels?: NotificationChannel[];
    severity?: NotificationSeverity;

    snapshot?: Record<string, unknown>;

    link?: string;
    icon?: string;
    tags?: string[];
  }): CreateNotificationDTO {
    const category = input.category;
    const refId = this.reqStr(input.refId, "refId");

    // Title pattern is part of your DB hook mapping Title -> Category/Type.
    const title = `Restore ${category}` as Title;

    const metadata: NotificationMetadata = {
      refId,
      data: this.cleanObj({
        category,
        requestedBy: input.requestedBy,
        snapshot: input.snapshot,
      }),
    };

    return this.build({
      title,
      body: `${category} restored | ${refId} | by ${input.requestedBy}`,
      type: "restore",

      // If no audience given, default to admins/operators/managers (your policy).
      audience: input.audience
        ? this.normalizeAudience(input.audience)
        : this.audienceRole(["admin", "operator", "manager"]),

      ...(input.severity ? { severity: input.severity } : {}),
      ...(input.channels?.length ? { channels: input.channels } : {}),
      ...(input.link ? { link: input.link } : {}),
      ...(input.icon ? { icon: input.icon } : {}),
      ...(input.tags?.length ? { tags: input.tags } : {}),

      metadata,
      target: { kind: category, refId },
    });
  }

  /**
   * Generic permanent delete notification.
   * - Title must match: "Permanent Delete <Category>"
   */
  public static domainPermanentDeleted(input: {
    category: TitleCategory;
    refId: string;
    requestedBy: string;

    audience?: Role[] | NotificationAudienceDTO;
    channels?: NotificationChannel[];
    severity?: NotificationSeverity;

    link?: string;
    icon?: string;
    tags?: string[];
  }): CreateNotificationDTO {
    const category = input.category;
    const refId = this.reqStr(input.refId, "refId");

    const title = `Permanent Delete ${category}` as Title;

    const metadata: NotificationMetadata = {
      refId,
      data: this.cleanObj({
        category,
        requestedBy: input.requestedBy,
      }),
    };

    return this.build({
      title,
      body: `${category} permanently deleted | ${refId} | by ${input.requestedBy}`,
      type: "permanent_delete",

      audience: input.audience
        ? this.normalizeAudience(input.audience)
        : this.audienceRole(["admin", "operator", "manager"]),

      ...(input.severity ? { severity: input.severity } : {}),
      ...(input.channels?.length ? { channels: input.channels } : {}),
      ...(input.link ? { link: input.link } : {}),
      ...(input.icon ? { icon: input.icon } : {}),
      ...(input.tags?.length ? { tags: input.tags } : {}),

      metadata,
      target: { kind: category, refId },
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 4) Core build
  // ───────────────────────────────────────────────────────────────────────────
  /**
   * Core build method:
   * - Produces CreateNotificationDTO.
   * - Guarantees dto.channels is ALWAYS present (default ["inapp"]).
   * - Omits optional fields instead of setting them to undefined
   *   (exactOptionalPropertyTypes safe).
   */
  private static build(input: {
    title: Title | string;
    body: string;
    type: DefinedTypes;
    audience: NotificationAudienceDTO;

    severity?: NotificationSeverity;
    channels?: NotificationChannel[];

    metadata?: NotificationMetadata;
    link?: string;
    icon?: string;
    tags?: string[];
    source?: string;

    target?: { kind?: TitleCategory; refId?: string };
  }): CreateNotificationDTO {
    // Always produce a stable channels array, so downstream code can rely on it.
    // If caller provided channels (non-empty), use it; otherwise default to ["inapp"].
    const channelsFinal: NotificationChannel[] =
      Array.isArray(input.channels) && input.channels.length > 0
        ? [...input.channels]
        : (["inapp"] as NotificationChannel[]);

    // Build the DTO while OMITTING optional props that are not present.
    // This keeps it safe under exactOptionalPropertyTypes.
    const dto: CreateNotificationDTO = {
      title: input.title,
      body: input.body,
      type: input.type,
      audience: input.audience,

      // Channels is required by your NotificationService signature expectations.
      // So we always include it here with default.
      channels: channelsFinal,

      ...(input.severity ? { severity: input.severity } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
      ...(input.icon ? { icon: input.icon } : {}),
      ...(input.tags?.length ? { tags: input.tags } : {}),
      ...(input.link ? { link: input.link } : {}),
      ...(input.source ? { source: input.source } : {}),
      ...(input.target ? { target: this.cleanObj(input.target) } : {}),
    };

    // Policy validation:
    // - "warn" mode keeps backward compatibility (does not block execution).
    // - You can later enforce (throw) inside NotificationService.createNotification(...)
    //   if you want to hard-stop invalid notification creation.
    try {
      NotificationPolicySource.validateCreateDoc(dto, "warn");
    } catch {
      // ignore here; enforce centrally later if desired
    }

    return dto;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 5) Safety helpers (validation + cleaning)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Normalize audience input:
   * - If roles[] provided, convert to { mode:"role", roles:[...] }
   * - If object provided, sanitize arrays and ensure mode is consistent.
   *
   * WHY:
   * - Avoid leaking undefined arrays into DTO
   * - Avoid runtime crashes in NotificationService roomsForAudience()
   */
  private static normalizeAudience(
    aud: Role[] | NotificationAudienceDTO,
  ): NotificationAudienceDTO {
    if (Array.isArray(aud)) {
      return { mode: "role", roles: [...aud] };
    }

    // Normalize based on mode.
    if (aud.mode === "role") {
      return {
        mode: "role",
        roles: Array.isArray(aud.roles) ? [...aud.roles] : [],
      };
    }

    if (aud.mode === "user") {
      return {
        mode: "user",
        usernames: Array.isArray(aud.usernames) ? [...aud.usernames] : [],
      };
    }

    // broadcast
    return { mode: "broadcast" };
  }

  /**
   * Ensure target has required keys and return a normalized target.
   */
  private static requireTarget(t: CommentTargetLite): CommentTargetLite {
    const section = this.reqStr(t?.section, "target.section");
    const refId = this.reqStr(t?.refId, "target.refId");

    // Build output with optional fields only if provided.
    return {
      section,
      refId,
      ...(t.subSection ? { subSection: String(t.subSection).trim() } : {}),
      ...(t.scope ? { scope: t.scope } : {}),
    };
  }

  /**
   * Required string helper (throws if missing/empty).
   */
  private static reqStr(v: unknown, field: string): string {
    const s = typeof v === "string" ? v.trim() : "";
    if (!s) throw new Error(`${field} is required.`);
    return s;
  }

  /**
   * Validate uploads root for restore logic.
   * MUST be public-relative and start with "uploads/".
   */
  private static reqUploadsRoot(v: unknown): string {
    const s = this.reqStr(v, "filesRoot");
    if (!s.startsWith("uploads/")) {
      throw new Error('filesRoot must start with "uploads/".');
    }
    return s;
  }

  /**
   * Remove:
   * - undefined
   * - null
   * - empty string
   * - empty array
   * - empty object
   *
   * WHY:
   * - exactOptionalPropertyTypes safety (omit optional props)
   * - keep metadata small/clean for sockets and DB
   */
  private static cleanObj<T extends Record<string, unknown>>(obj: T): T {
    const out: Record<string, unknown> = {};

    for (const [k, v] of Object.entries(obj ?? {})) {
      if (v === null || typeof v === "undefined") continue;
      if (typeof v === "string" && v.trim().length === 0) continue;
      if (Array.isArray(v) && v.length === 0) continue;

      // For plain objects: drop empty objects
      if (typeof v === "object" && !Array.isArray(v)) {
        if (Object.keys(v as Record<string, unknown>).length === 0) continue;
      }

      out[k] = v;
    }

    return out as T;
  }
}
