// Path: src/services/comments/comment-engine.service.ts
// ============================================================================
// CommentEngineService (Standalone / Decoupled) — REST + WS BRIDGE (CANONICAL)
// ----------------------------------------------------------------------------
// WHAT THIS FILE DOES (Single Source of Truth):
//  ✅ Validates & normalizes CommentTargetDto using CommentTargetRuntimeRegistry
//  ✅ Validates audience using CommentAudienceValues
//  ✅ CRUD + advanced pagination on MongoDB using Mongoose
//  ✅ Pin/Unpin/Toggle Pin (schema-aligned: pinned + pinnedAtIso + pinnedByUserId)
//  ✅ Optional local-file cleanup on delete (safe roots only)
//  ✅ WebSocket Bridge (INSIDE ENGINE):
//       After successful writes, engine broadcasts through CommentsWsRegistry.
//       This keeps Router/Controller clean and avoids confusion.
//
// WHY BRIDGE INSIDE ENGINE:
//  - REST and WS must stay separated in code responsibility,
//    but they must stay unified in behavior.
//  - Router/Controller should not remember “which event to emit”.
//  - The engine knows what changed, so it emits the right WS event.
// ============================================================================

import type { Request } from "express";
import type { FilterQuery, Model, PipelineStage, UpdateQuery } from "mongoose";
import { Types } from "mongoose";

import {
  type CommentAttachmentDto,
  type CommentAuthorDto,
  type CommentAudience,
  type CommentDto,
  type CommentLoadFilters,
  type CommentLoadRequest,
  type CommentLoadResponse,
  type CommentSortOrder,
  type CommentTargetDto,
  type CommentSection,
  CommentAudienceValues,
} from "../../types/comment.types";

import { CommentTargetRuntimeRegistry } from "../../api/shared/comments/comment-target-runtime.registry";
import { ApiGuardExport } from "../../guard/api-router.guard";

import fs from "fs/promises";
import path from "path";

import { CommentSectionKeyValues } from "../../source/comments.source";
import { CommentsWsRegistry } from "../../socket/comments/comments-ws.registry";

// ============================================================================
// Engine model typing
// ----------------------------------------------------------------------------
// Your schema stores `scopePairs` for fast scope filtering.
// We keep it optional and lean-safe.
// ============================================================================

export interface ScopePair {
  k: string;
  v: string;
}

export interface CommentEntity extends CommentDto {
  scopePairs?: ScopePair[] | null;
}

export interface CommentEngineOptions {
  cleanupLocalFilesOnDelete?: boolean;
  allowedLocalRoots?: string[];
}

type CommentIdLike = string | Types.ObjectId;

// ============================================================================
// Service
// ============================================================================

export class CommentEngineService {
  private static readonly DEFAULT_LIMIT = 20;
  private static readonly MAX_LIMIT = 200;
  private static readonly MAX_OFFSET = 10_000_000;

  private readonly opts: Required<CommentEngineOptions>;

  /**
   * Canonical list of sections from source registry.
   * (Keep it aligned with comments.source.ts)
   */
  private static readonly COMMENT_SECTIONS: ReadonlyArray<string> =
    CommentSectionKeyValues;

  private readonly targetRegistry: CommentTargetRuntimeRegistry;

  public constructor(
    private readonly commentModel: Model<CommentEntity>,
    opts?: CommentEngineOptions
  ) {
    this.opts = {
      cleanupLocalFilesOnDelete: opts?.cleanupLocalFilesOnDelete ?? false,
      allowedLocalRoots: opts?.allowedLocalRoots ?? ["uploads/", "public/"],
    };

    this.targetRegistry = new CommentTargetRuntimeRegistry();
  }

  // ===========================================================================
  // 0) WS BRIDGE HELPERS (kept private to avoid leaking WS into controllers)
  // ===========================================================================

  /**
   * NOTE:
   * - Engine does NOT require WS to exist.
   * - If socket bootstrap hasn't set the gateway yet, this becomes a no-op.
   */
  private wsCreated(target: CommentTargetDto, comment: CommentDto): void {
    try {
      const gw = CommentsWsRegistry.getGateway();
      if (!gw) return;
      gw.broadcastCreated(target, comment);
    } catch {
      // Never fail the main operation due to WS broadcast failure.
    }
  }

  private wsUpdated(params: {
    target: CommentTargetDto;
    id: string;
    patch?: Record<string, unknown>;
    updatedComment?: CommentDto;
  }): void {
    try {
      const gw = CommentsWsRegistry.getGateway();
      if (!gw) return;
      gw.broadcastUpdated(params);
    } catch {
      // silent
    }
  }

  private wsDeleted(target: CommentTargetDto, id: string): void {
    try {
      const gw = CommentsWsRegistry.getGateway();
      if (!gw) return;
      gw.broadcastDeleted(target, id);
    } catch {
      // silent
    }
  }

  private wsPinned(params: {
    target: CommentTargetDto;
    id: string;
    pinnedAtIso: string;
    pinnedByUserId: string;
  }): void {
    try {
      const gw = CommentsWsRegistry.getGateway();
      if (!gw) return;
      gw.broadcastPinned(params);
    } catch {
      // silent
    }
  }

  private wsUnpinned(target: CommentTargetDto, id: string): void {
    try {
      const gw = CommentsWsRegistry.getGateway();
      if (!gw) return;
      gw.broadcastUnpinned(target, id);
    } catch {
      // silent
    }
  }

  // ===========================================================================
  // 1) AUTHOR RESOLUTION (from Request)
  // ===========================================================================

  /**
   * Author resolution strategy:
   * 1) Prefer `req.user` (fast path; many systems attach user to req)
   * 2) Fallback to ApiGuardExport.GetLoggedUser(req) (your canonical guard)
   */
  public async resolveAuthorFromRequest(
    req: Request
  ): Promise<CommentAuthorDto | null> {
    const g = req as unknown as {
      user?: {
        userId?: unknown;
        username?: unknown;
        name?: unknown;
        image?: unknown;
        role?: unknown;
      };
    };

    const directId = String(g?.user?.userId ?? g?.user?.username ?? "").trim();
    if (directId) {
      const roleRaw = String(g?.user?.role ?? "user").trim().toLowerCase();
      const role = this.validateAudience(roleRaw) ?? ("user" as CommentAudience);

      return {
        authorId: directId,
        username: String(g.user?.username ?? 'Unknown').trim(),
        name: String(g?.user?.name ?? g?.user?.username ?? "Unknown").trim(),
        image:
          g?.user?.image === null
            ? null
            : typeof g?.user?.image === "string"
              ? g.user.image
              : null,
        role,
      };
    }

    const user = await ApiGuardExport.GetLoggedUser(req);
    if (!user) return null;

    const u = user as unknown as {
      _id?: Types.ObjectId;
      username?: string;
      name?: string;
      image?: string | null;
      role?: string | null;
    };

    const authorId = String(u._id ?? u.username ?? "").trim();
    if (!authorId) return null;

    const roleRaw = String(u.role ?? "user").trim().toLowerCase();
    const role = this.validateAudience(roleRaw) ?? ("user" as CommentAudience);

    return {
      authorId,
      username: String(u.username ?? "Unknown").trim(),
      name: String(u.name ?? u.username ?? "Unknown").trim(),
      image: u.image ?? null,
      role,
    };
  }

  // ===========================================================================
  // 2) CREATE (Add Comment)  ✅ + WS broadcast inside engine
  // ===========================================================================

  public async addComment(input: {
    commentTarget: CommentTargetDto;
    audience: CommentAudience;
    messageHtml: string;
    author: CommentAuthorDto;

    attachments?: CommentAttachmentDto[] | null;
    commentId?: string;
    byAvatarUrl?: string | null;

    // Threading
    parentCommentId?: string | null;
    threadRootId?: string | null;
    depth?: number;
    path?: string | null;
  }): Promise<CommentDto> {
    const nowIso = new Date().toISOString();

    // Canonical target stored in DB
    const storedTarget = this.buildStoredTarget(input.commentTarget);

    const msg = String(input.messageHtml ?? "").trim();
    if (!msg) throw new Error("messageHtml is required.");

    // Author required
    const author = input.author;
    const authorUsername = input.author.username;
    const authorId = String(author?.authorId ?? "").trim();
    const authorName = String(author?.name ?? "").trim();
    if (!authorId) throw new Error("author.authorId is required.");
    if (!authorName) throw new Error("author.name is required.");
    if (!authorUsername) throw new Error("author.username is required.");

    // Generate stable commentId if not provided
    const commentId =
      String(input.commentId ?? "").trim() || this.generateCommentId();

    // Attachments: allow null or array; never store undefined
    const attachments =
      input.attachments === null
        ? null
        : Array.isArray(input.attachments)
          ? input.attachments
          : null;

    // Threading safe defaults
    const parentCommentId =
      typeof input.parentCommentId === "string"
        ? input.parentCommentId.trim() || null
        : input.parentCommentId ?? null;

    const threadRootId =
      typeof input.threadRootId === "string"
        ? input.threadRootId.trim() || null
        : input.threadRootId ?? null;

    const depth =
      Number.isFinite(Number(input.depth))
        ? Math.max(0, Math.floor(Number(input.depth)))
        : 0;

    const pathValue =
      typeof input.path === "string" ? (input.path.trim() || null) : input.path ?? null;

    const doc: CommentEntity = {
      commentTarget: storedTarget,

      commentId,

      byUserId: authorId,
      byName: authorName,
      byUsername: authorUsername,
      byAvatarUrl: input.byAvatarUrl ?? author.image ?? null,

      audience: input.audience,
      messageHtml: msg,

      // Thread fields
      parentCommentId,
      threadRootId,
      depth,
      path: pathValue,

      // Pin fields aligned with schema
      pinned: false,
      pinnedAtIso: null,
      pinnedByUserId: null,

      createdAtIso: nowIso,
      updatedAtIso: nowIso,

      attachments,
      author: author ?? null,

      scopePairs: this.buildScopePairsFromTargetScope(storedTarget.scope ?? null),
    };

    await this.commentModel.create(doc);

    // ✅ WS bridge (created)
    this.wsCreated(storedTarget, doc);

    return doc;
  }

  // ===========================================================================
  // 2.1) FIND ONE (used by controller + router root-only pin check)
  // ===========================================================================

  public async findComment(params: {
    id?: string | Types.ObjectId;
    commentId?: string;
  }): Promise<CommentDto | null> {
    // Priority:
    // - if id exists, use id
    // - else if commentId exists, use commentId
    const idRaw = params.id;
    const commentIdRaw = String(params.commentId ?? "").trim();

    // Build query safely (supports _id or commentId)
    const q =
      typeof idRaw !== "undefined" && idRaw !== null
        ? this.buildFindByIdQuery(idRaw)
        : commentIdRaw
          ? ({ commentId: commentIdRaw } as FilterQuery<CommentEntity>)
          : null;

    if (!q) return null;

    const doc = await this.commentModel.findOne(q).lean<CommentEntity>().exec();
    return doc ? (doc as unknown as CommentDto) : null;
  }

  // ===========================================================================
  // 3) READ (Minimum) — wrappers (kept as-is)
  // ===========================================================================

  public async loadByTarget(params: {
    section: string;
    subSection?: string;
    refId: string;
    module?: string;
    scopeKey?: string;
    scopeValue?: string;

    offset?: number;
    limit?: number;
    sort?: CommentSortOrder;
  }): Promise<CommentLoadResponse> {
    const normalized = this.targetRegistry.normalizeSectionAndSubSection(
      params.section,
      params.subSection
    );

    const filters: CommentLoadFilters = {
      section: normalized.section as unknown as CommentSection,
      refId: this.toTrimmedOrEmpty(params.refId),
    };

    if (normalized.subSection) filters.subSection = normalized.subSection;

    const moduleRaw = this.toTrimmedOrEmpty(params.module);
    if (moduleRaw) filters.module = moduleRaw;

    const scopeKeyRaw = this.toTrimmedOrEmpty(params.scopeKey);
    const scopeValueRaw = this.toTrimmedOrEmpty(params.scopeValue);
    if (scopeKeyRaw && scopeValueRaw) {
      filters.scopeKey = scopeKeyRaw;
      filters.scopeValue = scopeValueRaw;
    }

    const req: CommentLoadRequest = {
      filters,
      pagination: {
        mode: "offset",
        offset: this.toSafeInt(params.offset, 0, CommentEngineService.MAX_OFFSET),
        limit: this.toSafeInt(
          params.limit,
          CommentEngineService.DEFAULT_LIMIT,
          CommentEngineService.MAX_LIMIT
        ),
      },
      sort: params.sort ?? "newest",
    };

    return await this.loadCommentsAdvanced(req);
  }

  public async countByTarget(params: {
    section: string;
    subSection?: string;
    refId: string;
    module?: string;
    scopeKey?: string;
    scopeValue?: string;
  }): Promise<number> {
    const normalized = this.targetRegistry.normalizeSectionAndSubSection(
      params.section,
      params.subSection
    );

    const filters: CommentLoadFilters = {
      section: normalized.section as unknown as CommentSection,
      refId: this.toTrimmedOrEmpty(params.refId),
    };

    if (normalized.subSection) filters.subSection = normalized.subSection;

    const moduleRaw = this.toTrimmedOrEmpty(params.module);
    if (moduleRaw) filters.module = moduleRaw;

    const scopeKeyRaw = this.toTrimmedOrEmpty(params.scopeKey);
    const scopeValueRaw = this.toTrimmedOrEmpty(params.scopeValue);
    if (scopeKeyRaw && scopeValueRaw) {
      filters.scopeKey = scopeKeyRaw;
      filters.scopeValue = scopeValueRaw;
    }

    return await this.countCommentsAdvanced(filters);
  }

  // ===========================================================================
  // 4) READ (Advanced) — Mongo Aggregation
  // ----------------------------------------------------------------------------
  // Mongo operators explained:
  //  - $match   : like SQL WHERE (filters)
  //  - $sort    : like SQL ORDER BY
  //  - $facet   : run multiple pipelines in parallel (rows + total count)
  //  - $count   : counts documents in a pipeline
  //  - $addFields: adds computed fields (total)
  //  - $project : like SQL SELECT (choose fields)
  // ===========================================================================

  public async loadCommentsAdvanced(req: CommentLoadRequest): Promise<CommentLoadResponse> {
    const filters: CommentLoadFilters = req.filters ?? {};
    const sortOrder: CommentSortOrder = req.sort ?? "newest";

    const limit = this.toSafeInt(
      (req.pagination as { limit?: unknown } | null)?.limit,
      CommentEngineService.DEFAULT_LIMIT,
      CommentEngineService.MAX_LIMIT
    );

    const offset =
      req.pagination.mode === "offset"
        ? this.toSafeInt(
            (req.pagination as { offset?: unknown } | null)?.offset,
            0,
            CommentEngineService.MAX_OFFSET
          )
        : 0;

    const cursor =
      req.pagination.mode === "cursor" &&
      typeof (req.pagination as { cursor?: unknown }).cursor === "string"
        ? String((req.pagination as { cursor?: string }).cursor ?? "").trim()
        : "";

    const match = this.buildMongoMatch(filters, sortOrder, cursor);

    const sortStage =
      sortOrder === "newest"
        ? ({ createdAtIso: -1, commentId: -1 } as Record<string, 1 | -1>)
        : ({ createdAtIso: 1, commentId: 1 } as Record<string, 1 | -1>);

    const rowsPipeline: PipelineStage.FacetPipelineStage[] =
      req.pagination.mode === "offset"
        ? [{ $skip: offset }, { $limit: limit }]
        : [{ $limit: limit + 1 }];

    const metaPipeline: PipelineStage.FacetPipelineStage[] = [{ $count: "total" }];

    const pipeline: PipelineStage[] = [
      { $match: match },
      { $sort: sortStage },
      { $facet: { rows: rowsPipeline, meta: metaPipeline } },
      {
        $addFields: {
          total: { $ifNull: [{ $arrayElemAt: ["$meta.total", 0] }, 0] },
        },
      },
      { $project: { rows: 1, total: 1 } },
    ];

    const agg = await this.commentModel
      .aggregate<{ rows: CommentDto[]; total: number }>(pipeline)
      .exec();

    const extracted = agg?.[0]?.rows ?? [];
    const total = agg?.[0]?.total ?? 0;

    if (req.pagination.mode === "cursor") {
      const hasMore = extracted.length > limit;
      const rows = hasMore ? extracted.slice(0, limit) : extracted;

      const last = rows.length ? rows[rows.length - 1] : null;
      const nextCursor = last ? this.makeCursorFromComment(last) : null;

      return { rows, total, hasMore, ...(nextCursor ? { nextCursor } : { nextCursor: null }) };
    }

    const hasMore = offset + limit < total;
    return { rows: extracted, total, hasMore, nextCursor: null };
  }

  public async countCommentsAdvanced(filters: CommentLoadFilters = {}): Promise<number> {
    const match = this.buildMongoMatch(filters, "newest", "");
    return await this.commentModel.countDocuments(match).exec();
  }

  // ===========================================================================
  // 5) UPDATE (Edit Comment)  ✅ + WS broadcast inside engine
  // ----------------------------------------------------------------------------
  // Router/controller expects boolean.
  // But for WS we need target + id.
  // So we use findOneAndUpdate to retrieve updated doc (only when changed).
  // ===========================================================================

  public async editComment(params: {
    id: CommentIdLike;
    patch: Partial<Pick<CommentDto, "messageHtml" | "audience" | "attachments">>;
  }): Promise<boolean> {
    const set: Record<string, unknown> = {};

    if (typeof params.patch.messageHtml === "string") {
      const html = params.patch.messageHtml.trim();
      if (!html) throw new Error("messageHtml cannot be empty.");
      set.messageHtml = html;
    }

    if (typeof params.patch.audience === "string") {
      const aud = String(params.patch.audience ?? "").trim().toLowerCase();
      const valid = this.validateAudience(aud);
      if (!valid) throw new Error("Invalid audience.");
      set.audience = valid;
    }

    if (typeof params.patch.attachments !== "undefined") {
      if (params.patch.attachments === null) set.attachments = null;
      else if (Array.isArray(params.patch.attachments)) set.attachments = params.patch.attachments;
      else throw new Error("attachments must be an array or null.");
    }

    if (Object.keys(set).length === 0) return false;

    const nowIso = new Date().toISOString();
    set.updatedAtIso = nowIso;

    const q = this.buildFindByIdQuery(params.id);

    // ✅ We return updated doc for WS event
    const updated = await this.commentModel
      .findOneAndUpdate(q, { $set: set } as UpdateQuery<CommentEntity>, { new: true })
      .lean<CommentEntity>()
      .exec();

    if (!updated) return false;

    // ✅ WS bridge (updated)
    this.wsUpdated({
      target: updated.commentTarget,
      id: updated.commentId,
      patch: set,
      updatedComment: updated as unknown as CommentDto,
    });

    return true;
  }

  // ===========================================================================
  // 6) DELETE (Delete Comment) ✅ + WS broadcast inside engine
  // ----------------------------------------------------------------------------
  // Router/controller expects boolean.
  // For WS we must know the target before deletion -> fetch doc first.
  // ===========================================================================

  public async deleteComment(params: {
    id: CommentIdLike;
    cleanupLocalFiles?: boolean;
  }): Promise<boolean> {
    const doCleanup = params.cleanupLocalFiles ?? this.opts.cleanupLocalFilesOnDelete;
    const q = this.buildFindByIdQuery(params.id);

    // We fetch doc for:
    // 1) WS broadcast (needs target)
    // 2) optional cleanup (needs attachments)
    const doc = await this.commentModel.findOne(q).lean<CommentEntity>().exec();
    if (!doc) return false;

    const deleted = await this.commentModel.deleteOne(q).exec();
    const deletedCount = Number((deleted as unknown as { deletedCount?: unknown }).deletedCount ?? 0);
    const ok = deletedCount > 0;

    if (!ok) return false;

    // ✅ cleanup after delete
    if (doCleanup) {
      await this.cleanupLocalAttachments(doc.attachments ?? null);
    }

    // ✅ WS bridge (deleted)
    this.wsDeleted(doc.commentTarget, doc.commentId);

    return true;
  }

  // ===========================================================================
  // 7) PIN / UNPIN / TOGGLE  ✅ + WS broadcast inside engine
  // ===========================================================================

  public async pinComment(input: {
    id: CommentIdLike;
    actorUserId: string;
  }): Promise<{ updated: CommentDto | null; changed: boolean }> {
    const actorUserId = String(input.actorUserId ?? "").trim();
    if (!actorUserId) throw new Error("actorUserId is required.");

    const q = this.buildFindByIdQuery(input.id);
    const nowIso = new Date().toISOString();

    const updated = await this.commentModel
      .findOneAndUpdate(
        { ...q, pinned: { $ne: true } } as FilterQuery<CommentEntity>,
        {
          $set: {
            pinned: true,
            pinnedAtIso: nowIso,
            pinnedByUserId: actorUserId,
            updatedAtIso: nowIso,
          },
        } as UpdateQuery<CommentEntity>,
        { new: true }
      )
      .lean<CommentEntity>()
      .exec();

    // If already pinned, we still return current doc (changed=false)
    if (!updated) {
      const existing = await this.commentModel.findOne(q).lean<CommentEntity>().exec();
      if (!existing) return { updated: null, changed: false };
      return { updated: existing as unknown as CommentDto, changed: false };
    }

    // ✅ WS bridge (pinned)
    this.wsPinned({
      target: updated.commentTarget,
      id: updated.commentId,
      pinnedAtIso: String(updated.pinnedAtIso ?? "").trim(),
      pinnedByUserId: String(updated.pinnedByUserId ?? "").trim(),
    });

    return { updated: updated as unknown as CommentDto, changed: true };
  }

  public async unpinComment(input: {
    id: CommentIdLike;
    actorUserId: string;
  }): Promise<{ updated: CommentDto | null; changed: boolean }> {
    const actorUserId = String(input.actorUserId ?? "").trim();
    if (!actorUserId) throw new Error("actorUserId is required.");

    const q = this.buildFindByIdQuery(input.id);
    const nowIso = new Date().toISOString();

    const updated = await this.commentModel
      .findOneAndUpdate(
        { ...q, pinned: true } as FilterQuery<CommentEntity>,
        {
          $set: {
            pinned: false,
            pinnedAtIso: null,
            pinnedByUserId: null,
            updatedAtIso: nowIso,
          },
        } as UpdateQuery<CommentEntity>,
        { new: true }
      )
      .lean<CommentEntity>()
      .exec();

    if (!updated) {
      const existing = await this.commentModel.findOne(q).lean<CommentEntity>().exec();
      if (!existing) return { updated: null, changed: false };
      return { updated: existing as unknown as CommentDto, changed: false };
    }

    // ✅ WS bridge (unpinned)
    this.wsUnpinned(updated.commentTarget, updated.commentId);

    return { updated: updated as unknown as CommentDto, changed: true };
  }

  public async togglePinComment(input: {
    id: CommentIdLike;
    actorUserId: string;
  }): Promise<{ updated: CommentDto | null; changed: boolean; isPinned: boolean }> {
    const actorUserId = String(input.actorUserId ?? "").trim();
    if (!actorUserId) throw new Error("actorUserId is required.");

    const q = this.buildFindByIdQuery(input.id);
    const existing = await this.commentModel.findOne(q).lean<CommentEntity>().exec();
    if (!existing) return { updated: null, changed: false, isPinned: false };

    const isPinned = Boolean((existing as unknown as { pinned?: unknown }).pinned);

    if (isPinned) {
      const res = await this.unpinComment({ id: input.id, actorUserId });
      return { updated: res.updated, changed: res.changed, isPinned: false };
    }

    const res = await this.pinComment({ id: input.id, actorUserId });
    return { updated: res.updated, changed: res.changed, isPinned: true };
  }

  // ===========================================================================
  // Audience validator
  // ===========================================================================

  public validateAudience(text: unknown): CommentAudience | null {
    if (!text || typeof text !== "string") return null;

    const safeText = text.toLowerCase().trim();
    if ((CommentAudienceValues as readonly string[]).includes(safeText)) {
      return safeText as CommentAudience;
    }

    return null;
  }

  // ===========================================================================
  // Internals
  // ===========================================================================

  private buildFindByIdQuery(id: CommentIdLike): FilterQuery<CommentEntity> {
    if (id instanceof Types.ObjectId) {
      return { _id: id } as FilterQuery<CommentEntity>;
    }

    const raw = String(id ?? "").trim();
    if (!raw) {
      return { commentId: "__missing__" } as FilterQuery<CommentEntity>;
    }

    // Allow either:
    // - commentId = "<string>"
    // - _id = ObjectId("<string>") if valid
    if (Types.ObjectId.isValid(raw)) {
      const oid = new Types.ObjectId(raw);
      return { $or: [{ commentId: raw }, { _id: oid }] } as FilterQuery<CommentEntity>;
    }

    return { commentId: raw } as FilterQuery<CommentEntity>;
  }

  /**
   * Converts user input target into DB-stored canonical target.
   * Also ensures we never store undefined optional keys.
   */
  private buildStoredTarget(t: CommentTargetDto): CommentTargetDto {
    const rawSection = (t as { section?: unknown }).section;
    const rawSubSection = (t as { subSection?: unknown }).subSection;
    const rawRefId = (t as { refId?: unknown }).refId;

    // validate section/subSection/refId rules via registry
    const validated = this.targetRegistry.validateTargetOrThrow({
      section: rawSection,
      subSection: rawSubSection,
      refId: rawRefId,
    });

    const moduleRaw = this.toTrimmedOrEmpty((t as { module?: unknown }).module);
    const modelNameRaw = this.toTrimmedOrEmpty((t as { modelName?: unknown }).modelName);

    const scope =
      (t as { scope?: unknown }).scope && typeof (t as { scope?: unknown }).scope === "object"
        ? (((t as { scope?: Record<string, unknown> }).scope) ?? null)
        : null;

    // If modelName provided, enforce it matches the resolved target source
    if (modelNameRaw) {
      this.targetRegistry.resolveModelNameOrThrow(validated.source, modelNameRaw);
    }

    const out: Record<string, unknown> = {
      section: validated.section,
      refId: validated.refId,
      scope,
    };

    if (validated.subSection) out.subSection = validated.subSection;
    if (moduleRaw) out.module = moduleRaw;
    if (modelNameRaw) out.modelName = modelNameRaw;

    return out as CommentTargetDto;
  }

  /**
   * Build Mongo filter (used for countDocuments OR for $match in aggregation).
   */
  private buildMongoMatch(
    filters: CommentLoadFilters,
    sort: CommentSortOrder,
    cursor: string
  ): FilterQuery<CommentEntity> {
    const match: Record<string, unknown> = {};

    const section = this.toTrimmedOrEmpty(filters.section);
    const subSection = this.toTrimmedOrEmpty(filters.subSection);
    const refId = this.toTrimmedOrEmpty(filters.refId);
    const module = this.toTrimmedOrEmpty(filters.module);

    if (section) match["commentTarget.section"] = section;
    if (subSection) match["commentTarget.subSection"] = subSection;
    if (refId) match["commentTarget.refId"] = refId;
    if (module) match["commentTarget.module"] = module;

    // Scope pair match (fast indexable structure)
    const scopeKey = this.toTrimmedOrEmpty(filters.scopeKey);
    const scopeValue = this.toTrimmedOrEmpty(filters.scopeValue);
    if (scopeKey && scopeValue) {
      match["scopePairs"] = { $elemMatch: { k: scopeKey, v: scopeValue } };
    }

    const byUserId = this.toTrimmedOrEmpty(filters.byUserId);
    if (byUserId) match["byUserId"] = byUserId;

    const aud = this.toTrimmedOrEmpty(filters.audience);
    if (aud) match["audience"] = aud;

    if (filters.topLevelOnly === true) {
      // top-level comment => no parent
      match["parentCommentId"] = { $in: [null, ""] };
    }

    if (filters.pinnedOnly === true) {
      match["pinned"] = true;
    }

    const fromIso = this.toTrimmedOrEmpty(filters.fromIso);
    const toIso = this.toTrimmedOrEmpty(filters.toIso);
    if (fromIso || toIso) {
      const range: Record<string, unknown> = {};
      if (fromIso) range["$gte"] = fromIso;
      if (toIso) range["$lte"] = toIso;
      match["createdAtIso"] = range;
    }

    // Cursor pagination: filter “after/before” depending on sort direction
    const cur = this.toTrimmedOrEmpty(cursor);
    if (cur) {
      const parsed = this.parseCursor(cur);

      if (parsed.createdAtIso && parsed.commentId) {
        const cursorOr =
          sort === "newest"
            ? [
                { createdAtIso: { $lt: parsed.createdAtIso } },
                { createdAtIso: parsed.createdAtIso, commentId: { $lt: parsed.commentId } },
              ]
            : [
                { createdAtIso: { $gt: parsed.createdAtIso } },
                { createdAtIso: parsed.createdAtIso, commentId: { $gt: parsed.commentId } },
              ];

        match["$or"] = cursorOr;
      }
    }

    // Text search across fields (regex)
    const q = this.toTrimmedOrEmpty(filters.q);
    if (q) {
      const rx = new RegExp(this.escapeRegex(q), "i");
      const searchOr = [{ byName: rx }, { messageHtml: rx }, { "attachments.name": rx }];

      // If we already have $or from cursor, combine with $and
      const existingOr = match["$or"];
      if (Array.isArray(existingOr) && existingOr.length > 0) {
        delete match["$or"];
        match["$and"] = [{ $or: existingOr }, { $or: searchOr }];
      } else {
        match["$or"] = searchOr;
      }
    }

    return match as unknown as FilterQuery<CommentEntity>;
  }

  private buildScopePairsFromTargetScope(scope: CommentTargetDto["scope"]): ScopePair[] | null {
    if (!scope || typeof scope !== "object") return null;

    const out: ScopePair[] = [];
    const obj = scope as Record<string, unknown>;

    for (const k of Object.keys(obj)) {
      const key = String(k ?? "").trim();
      if (!key) continue;

      const raw = obj[key];

      let v = "";
      if (raw === null || typeof raw === "undefined") v = "";
      else if (typeof raw === "string") v = raw.trim();
      else if (typeof raw === "number" || typeof raw === "boolean" || typeof raw === "bigint")
        v = String(raw);
      else {
        try {
          v = JSON.stringify(raw);
        } catch {
          v = String(raw);
        }
      }

      if (!v) continue;
      out.push({ k: key, v });
    }

    return out.length ? out : null;
  }

  private async cleanupLocalAttachments(attachments: CommentAttachmentDto[] | null): Promise<void> {
    if (!attachments || !Array.isArray(attachments) || attachments.length === 0) return;

    for (const a of attachments) {
      try {
        const source = String((a as { source?: unknown })?.source ?? "unknown").trim().toLowerCase();
        if (source !== "local") continue;

        const url = String(a?.url ?? "").trim();
        if (!url) continue;

        // Skip remote urls
        if (url.includes("://")) continue;

        // If absolute path, do not delete (avoid dangerous deletion)
        if (path.isAbsolute(url)) continue;

        const rel = url.replace(/^\/+/, "").trim();
        if (!rel) continue;

        // Allow deletion only within safe roots
        const allowed = this.opts.allowedLocalRoots.some((root) => rel.startsWith(root));
        if (!allowed) continue;

        const abs = path.join(process.cwd(), rel);
        await fs.unlink(abs).catch(() => null);
      } catch (err: unknown) {
        // eslint-disable-next-line no-console
        console.warn("[Warning:] [CommentEngineService] cleanupLocalAttachments failed.\n", err, "\n");
      }
    }
  }

  private generateCommentId(): string {
    return `CMT-${Date.now()}-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
  }

  private toSafeInt(val: unknown, fallback: number, max: number): number {
    const n = Number(val);
    if (!Number.isFinite(n)) return fallback;

    const x = Math.floor(n);
    if (x < 0) return 0;
    if (x > max) return max;

    return x;
  }

  private toTrimmedOrEmpty(val: unknown): string {
    return typeof val === "string" ? val.trim() : "";
  }

  private escapeRegex(input: string): string {
    return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  private makeCursorFromComment(c: CommentDto): string {
    const createdAtIso = String(c.createdAtIso ?? "").trim();
    const commentId = String(c.commentId ?? "").trim();
    return `${createdAtIso}__${commentId}`;
  }

  private parseCursor(cursor: string): { createdAtIso: string | null; commentId: string | null } {
    const raw = String(cursor ?? "").trim();
    if (!raw.includes("__")) return { createdAtIso: null, commentId: null };

    const parts = raw.split("__");
    if (parts.length !== 2) return { createdAtIso: null, commentId: null };

    const createdAtIso = String(parts[0] ?? "").trim();
    const commentId = String(parts[1] ?? "").trim();

    if (!createdAtIso || !commentId) return { createdAtIso: null, commentId: null };
    return { createdAtIso, commentId };
  }
}
