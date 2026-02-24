// Path: src/controller/teamManagement/memberActivities/memberActivivties.controller.ts
// ============================================================================
// MemberActivitiesController (REST + FileUploader helper) — 100% CLASS-BASED
// ----------------------------------------------------------------------------
// FIX SUMMARY (what was wrong)
// - With `exactOptionalPropertyTypes: true`, this is INVALID:
//     { module: string | undefined }
//   because if you include `module`, it must be a real string (not undefined).
//
// - Your previous `buildTarget()` was returning:
//     { category, module, ... }
//   where `category/module` could be undefined at runtime (or typed as union incl. undefined).
//
// - Also: `NotificationTarget.actionKey` is a UNION (NotificationActionKey).
//   So runtime strings MUST be filtered using ACTION_KEY_LOOKUP / NotificationActionKeyFilter.
//
// WHAT THIS FIX DOES
// - `buildTarget()` now *only adds* `category/module` when they are real non-empty strings.
// - `actionKey` is normalized via `NotificationActionKeyFilter.exactOrFallback(...)`
// - No `string | undefined` ever gets assigned to optional props.
// ============================================================================

import type { NextFunction, Request, RequestHandler, Response } from "express";
import { Types } from "mongoose";

import { ApiGuardExport } from "../../../guard/api-router.guard";
import { NotificationHubEngineService } from "../../../services/notifications/notification-hub-engine.service";
import {
  MemberActivitiesRestService,
  MemberActivitiesServiceError,
  type MemberActivityAppendBlockerInput,
  type MemberActivityAppendEvidenceInput,
  type MemberActivityCreateInput,
  type MemberActivityListFilters,
  type MemberActivityListPaging,
  type MemberActivityRemoveBlockerInput,
  type MemberActivityRemoveEvidenceInput,
  type MemberActivityReplaceEvidenceInput,
  type MemberActivityResolveBlockerInput,
  type MemberActivityUpdateBlockerInput,
  type MemberActivityUpdateInput,
} from "../../../services/teamManagement/memberActivities/memberActivities.rest.service";
import type { MemberActivityWsContext } from "../../../services/teamManagement/memberActivities/memberActivities.ws.service";
import type { FileMetaPacket, PaginationMeta } from "../../../types/common";
import type { AuthUser } from "../../../types/common";
import {
  NotificationActionKeyFilter,
  type NotificationActionKey,
} from "../../../types/notification/notification-action-keys.catalog";
import type {
  NotificationActorDto,
  NotificationAudience,
  NotificationCategory,
  NotificationTarget,
} from "../../../types/notification/notification.types";

import type {
  MemberActivityBlocker,
  MemberActivityDto,
  MemberActivityEvidence,
  MemberActivityStatus,
  MemberActivityType,
} from "../../../types/teamManagement/memberActivities/memberActivities.types";
import { ApiResponseBuilder } from "../../../utils/api-combiner.builder";
import FileUploader, { type UploadResultPacket } from "../../../utils/files/file-uploader.helper";


type UploadField = "evidence";

interface UploadContextBag {
  token: string;
  packet: UploadResultPacket;
}

export type AuthUserNormalized = Omit<AuthUser, "userId"> & { userId: string };

type MemberActivityNotificationInput = {
  audiences: NotificationAudience[];
  tags: string[];
  target: NotificationTarget;
  category: NotificationCategory;
  extra?: Record<string, unknown>;
};

export class MemberActivitiesController {
  private static _instance: MemberActivitiesController | null = null;

  public static GetInstance(): MemberActivitiesController {
    if (!MemberActivitiesController._instance) {
      MemberActivitiesController._instance = new MemberActivitiesController();
    }
    return MemberActivitiesController._instance;
  }

  private readonly service: MemberActivitiesRestService;
  private readonly notificationHub: NotificationHubEngineService;

  // ----------------------------
  // Upload constraints
  // ----------------------------
  private readonly MAX_FILE_SIZE_MB = 25;
  private readonly MAX_FILES_TOTAL = 60;

  private readonly FIELD_MAX: Readonly<Record<UploadField, number>> = {
    evidence: 25,
  };

  private readonly ALLOWED_MIME: ReadonlySet<string> = new Set<string>([
    // Images
    "image/jpeg",
    "image/png",
    "image/webp",

    // PDF
    "application/pdf",

    // Text
    "text/plain",

    // Office (optional)
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ]);

  private constructor() {
    this.notificationHub = new NotificationHubEngineService();
    this.service = new MemberActivitiesRestService();

    // Bind (router-friendly)
    this.uploadMiddleware = this.uploadMiddleware.bind(this);

    this.getById = this.getById.bind(this);
    this.list = this.list.bind(this);
    this.count = this.count.bind(this);

    this.create = this.create.bind(this);
    this.updateById = this.updateById.bind(this);
    this.deleteById = this.deleteById.bind(this);

    this.appendEvidence = this.appendEvidence.bind(this);
    this.removeEvidence = this.removeEvidence.bind(this);
    this.replaceEvidence = this.replaceEvidence.bind(this);

    this.appendBlocker = this.appendBlocker.bind(this);
    this.updateBlocker = this.updateBlocker.bind(this);
    this.resolveBlocker = this.resolveBlocker.bind(this);
    this.removeBlocker = this.removeBlocker.bind(this);
  }

  // ===========================================================================
  // Upload middleware (TEMP stage)
  // ===========================================================================
  public async uploadMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const token = this.makeToken();

      // TEMP under uploads root
      // uploads/teamManagement/memberActivities/__tmp/<token>/evidence/<storedName>
      const tempSubPath = `teamManagement/memberActivities/__tmp/${token}`;

      const fields = [{ name: "evidence", maxCount: this.FIELD_MAX.evidence }];

      const packet = await FileUploader.handleMultiFieldUpload(tempSubPath, fields, req, {
        maxFileSizeMb: this.MAX_FILE_SIZE_MB,
        maxFiles: this.MAX_FILES_TOTAL,
        allowedMimeTypesByField: {
          evidence: this.ALLOWED_MIME,
        },
      });

      this.setUploadBag(req, { token, packet });
      next();
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Upload failed.";
      ApiResponseBuilder.internalError(res, msg);
      return;
    }
  }

  // ===========================================================================
  // GET (NO NOTIFICATIONS)
  // ===========================================================================
  public async getById(req: Request, res: Response): Promise<void> {
    try {
      const activityId = String(req.params.activityId || "").trim();
      const dto = await this.service.getById(activityId);

      ApiResponseBuilder.ok(res, "memberActivity", dto, `Member activity ${dto._id} fetched successful!`);
      return;
    } catch (err) {
      this.sendError(res, req, err);
      return;
    }
  }

  public async list(req: Request, res: Response): Promise<void> {
    try {
      const filters = this.readListFilters(req);
      const paging = this.readPaging(req);

      const result = await this.service.list(filters, paging);
      const pagination: PaginationMeta = { total: result.other.total };

      ApiResponseBuilder.ok(res, "memberActivities", result.items, "Data fetch successful!", { pagination });
      return;
    } catch (err) {
      this.sendError(res, req, err);
      return;
    }
  }

  public async count(req: Request, res: Response): Promise<void> {
    try {
      const filters = this.readListFilters(req);
      const total = await this.service.count(filters);
      const pagination: PaginationMeta = { total };

      ApiResponseBuilder.ok(res, "other", {}, "Member activities total count fetched successful!", { pagination });
      return;
    } catch (err) {
      this.sendError(res, req, err);
      return;
    }
  }

  // ===========================================================================
  // CREATE / UPDATE / DELETE (NOTIFICATIONS ENABLED)
  // ===========================================================================
  public async create(req: Request, res: Response): Promise<void> {
    try {
      const auth : AuthUser | null= await ApiGuardExport.GetAuthUser(req);
      if (!auth) {
        ApiResponseBuilder.validationError(res, "Invalid auth data");
        return;
      }

      const authNormalised: AuthUserNormalized | null = await ApiGuardExport.GetNormalisedAuthUser(req);

      if (!authNormalised) {
        ApiResponseBuilder.validationError(res, "Invalid auth normalised data");
        return;
      }


      const input = this.readCreateInput(req, authNormalised);
      const ctx = this.buildWsContext(req, auth, {
        activityId: null,
        workItemId: input.workItemId,
        teamId: input.teamId,
      });

      const dto = await this.service.create(ctx, input);

      // ✅ notify (best-effort)
      this.tryEmitMemberActivityNotification(auth, "memberActivity.create", dto, {
        actionKeyRaw: "team:member.activities.added",
        actionKeyFallback: "team:member.activities.added",
        title: "Member activity created",
        message: dto.title,
      
      });

      ApiResponseBuilder.ok(res, "memberActivity", dto, "Member activity created successful!");
      return;
    } catch (err) {
      this.sendError(res, req, err);
      return;
    }
  }

  public async updateById(req: Request, res: Response): Promise<void> {
    try {
      const auth = await ApiGuardExport.GetAuthUser(req);
      if (!auth) {
        ApiResponseBuilder.validationError(res, "Invalid auth data");
        return;
      }
      const authNormalised: AuthUserNormalized | null = await ApiGuardExport.GetNormalisedAuthUser(req);
      if (!authNormalised) {
        ApiResponseBuilder.validationError(res, "Invalid auth data");
        return;
      }

      const activityId = String(req.params.activityId || "").trim();
      const input = this.readUpdateInput(req, authNormalised);

      const ctx = this.buildWsContext(req, auth, { activityId, workItemId: null, teamId: null });
      const dto = await this.service.updateById(ctx, activityId, input);

      // ✅ notify (best-effort)
      this.tryEmitMemberActivityNotification(auth, "memberActivity.update", dto, {
        actionKeyRaw: "team:member.activities.updated",
        actionKeyFallback: "team:member.activities.updated",
        title: "Member activity updated",
        message: dto.title,
      });

      ApiResponseBuilder.ok(res, "memberActivity", dto, "Member activity updated successful!");
      return;
    } catch (err) {
      this.sendError(res, req, err);
      return;
    }
  }

  public async deleteById(req: Request, res: Response): Promise<void> {
    try {
      const auth = await ApiGuardExport.GetAuthUser(req);
      if (!auth) {
        ApiResponseBuilder.validationError(res, "Invalid auth data");
        return;
      }
      const authNormalised: AuthUserNormalized | null = await ApiGuardExport.GetNormalisedAuthUser(req);
      if (!authNormalised) {
        ApiResponseBuilder.validationError(res, "Invalid auth data");
        return;
      }

      const activityId = String(req.params.activityId || "").trim();
      const ctx = this.buildWsContext(req, auth, { activityId, workItemId: null, teamId: null });

      // Read before delete for better notification context (still a mutating endpoint)
      let before: MemberActivityDto | null = null;
      try {
        before = await this.service.getById(activityId);
      } catch {
        before = null;
      }

      await this.service.deleteById(ctx, activityId);

      if (before) {
        this.tryEmitMemberActivityNotification(auth, "memberActivity.delete", before, {
          actionKeyRaw: "team:member.activities.removed",
          actionKeyFallback: "team:member.activities.removed",
          title: "Member activity deleted",
          message: before.title,
        });
      } else {
        // fallback (still union-safe)
        this.tryEmitNotification(auth, "memberActivity.delete", {
          tags: ["teamManagement", "memberActivity", "delete"],
          target: this.buildTarget({
            category: "TeamManagement",
            module: "TeamManagement",
            refId: activityId,
            
            rawActionKey: "team:member.activities.removed",
            fallbackActionKey: "team:member.activities.removed",
            params:{memberActivityId: activityId}
          }),
          category: "Team",
          audiences: this.buildDefaultRoleAudiences(),
          extra: { activityId, title: "Member activity deleted" },
        });
      }

      ApiResponseBuilder.ok(res, "other", { deleted: true }, "Member activity deleted successful!");
      return;
    } catch (err) {
      this.sendError(res, req, err);
      return;
    }
  }

  /* ====================================================================== *
   * NOTIFICATION (audiences ALWAYS array) — best-effort
   * ====================================================================== */
  private tryEmitNotification(author: AuthUser, eventKey: string, input: MemberActivityNotificationInput): void {
    try {
      const actor: NotificationActorDto = {
        userId: String(author.userId),
        username: String(author.username),
        role: author.role,
        ...(author.branchId ? { branchId: author.branchId } : {}),
        ...(author.teamCodes && author.teamCodes.length > 0 ? { teamCodes: author.teamCodes } : {}),
      };

      this.notificationHub.emit({
        eventKey,
        actor,
        audiences: Array.isArray(input.audiences) ? input.audiences : [],
        tags: input.tags,
        target: input.target,
        category: input.category,
        ...(input.extra ? { extra: input.extra } : {}),
      });
    } catch (err: unknown) {
      console.warn("[Warning:] [MemberActivitiesController] notification emit failed.\n", err);
    }
  }

  /**
   * ✅ Domain helper: emit notifications for activity mutations.
   * - Sends to the activity owner + default ops roles.
   * - actionKey is union-safe via NotificationActionKeyFilter.
   * - Never blocks REST success.
   */
  private tryEmitMemberActivityNotification(
    author: AuthUser,
    eventKey: string,
    dto: MemberActivityDto,
    info: {
      actionKeyRaw: string;
      actionKeyFallback: NotificationActionKey;
      title: string;
      message?: string;
    }
  ): void {
    try {
      const activityId = this.readObjectIdString(dto._id);

      const teamId = this.readObjectIdString((dto as unknown as { teamId?: unknown }).teamId ?? "");
      const userId = this.readObjectIdString((dto as unknown as { userId?: unknown }).userId ?? "");

      const audiences = this.buildActivityAudiences(userId);

      const target = this.buildTarget({
        category: "TeamManagement",
        module: "TeamManagement",
        refId: activityId,
        rawActionKey: this.buildNotificationActionKey(info.actionKeyRaw, info.actionKeyFallback),
        fallbackActionKey: info.actionKeyFallback,
        params: {memberActivityId: activityId}
      });

      const input: MemberActivityNotificationInput = {
        tags: ["teamManagement", "memberActivity", eventKey],
        target,
        category: "Team",
        audiences,
        extra: {
          title: info.title,
          ...(info.message ? { message: info.message } : {}),
          activityId,
          teamId,
          userId,
        },
      };

      this.tryEmitNotification(author, eventKey, input);
    } catch (err: unknown) {
      console.warn("[Warning:] [MemberActivitiesController] tryEmitMemberActivityNotification failed.\n", err);
    }
  }

  private buildDefaultRoleAudiences(): NotificationAudience[] {
    return [
      { mode: "Role", roleKey: "admin" },
      { mode: "Role", roleKey: "manager" },
      { mode: "Role", roleKey: "operator" },
    ];
  }

  private buildActivityAudiences(activityOwnerUserId: string): NotificationAudience[] {
    const audiences: NotificationAudience[] = [{ mode: "User", username: activityOwnerUserId }];
    for (const a of this.buildDefaultRoleAudiences()) audiences.push(a);
    return audiences;
  }

  private buildNotificationActionKey(rawKey: string, fallback: NotificationActionKey): NotificationActionKey {
    return NotificationActionKeyFilter.exactOrFallback(rawKey, fallback);
  }

  // ===========================================================================
  // Evidence operations (with upload finalization) — NOTIFICATIONS ENABLED
  // ===========================================================================
  public async appendEvidence(req: Request, res: Response): Promise<void> {
    try {
      const auth = await ApiGuardExport.GetAuthUser(req);
      if (!auth) {
        ApiResponseBuilder.validationError(res, "Invalid auth data");
        return;
      }
      const authNormalised: AuthUserNormalized | null = await ApiGuardExport.GetNormalisedAuthUser(req);
      if (!authNormalised) {
        ApiResponseBuilder.validationError(res, "Invalid auth data");
        return;
      }


      const activityId = String(req.params.activityId || "").trim();
      const ctx = this.buildWsContext(req, auth, { activityId, workItemId: null, teamId: null });

      const finalized = await this.finalizeEvidenceUploads(req, activityId);
      if (!finalized || finalized.evidence.length === 0) {
        ApiResponseBuilder.validationError(res, "No evidence files uploaded.");
        return;
      }

      const input: MemberActivityAppendEvidenceInput = {
        evidence: finalized.evidence,
        updatedByUserId: authNormalised.userId,
      };

      const dto = await this.service.appendEvidence(ctx, activityId, input);

      this.tryEmitMemberActivityNotification(auth, "memberActivity.evidence.append", dto, {
        actionKeyRaw: "team:member.activities.updated",
        actionKeyFallback: "team:member.activities.updated",
        title: "Evidence added to activity",
        message: dto.title,
      });

      ApiResponseBuilder.ok(res, "memberActivity", dto, "Evidence appended successful!", {
        other: { uploads: finalized.uploadPacket },
      });
      return;
    } catch (err) {
      this.sendError(res, req, err);
      return;
    }
  }

  public async removeEvidence(req: Request, res: Response): Promise<void> {
    try {
      const auth = await ApiGuardExport.GetAuthUser(req);
      if (!auth) {
        ApiResponseBuilder.validationError(res, "Invalid auth data");
        return;
      }
      const authNormalised: AuthUserNormalized | null = await ApiGuardExport.GetNormalisedAuthUser(req);
      if (!authNormalised) {
        ApiResponseBuilder.validationError(res, "Invalid auth data");
        return;
      }



      const activityId = String(req.params.activityId || "").trim();
      const ctx = this.buildWsContext(req, auth, { activityId, workItemId: null, teamId: null });

      const relPathRaw = String(req.body?.relPath || "").trim();
      const urlRaw = String(req.body?.url || "").trim();

      const input: MemberActivityRemoveEvidenceInput = {
        ...(relPathRaw ? { relPath: relPathRaw } : {}),
        ...(urlRaw ? { url: urlRaw } : {}),
        updatedByUserId: authNormalised.userId,
      };

      const dto = await this.service.removeEvidence(ctx, activityId, input);

      this.tryEmitMemberActivityNotification(auth, "memberActivity.evidence.remove", dto, {
        actionKeyRaw: "team:member.activities.updated",
        actionKeyFallback: "team:member.activities.updated",
        title: "Evidence removed from activity",
        message: dto.title,
      });

      ApiResponseBuilder.ok(res, "memberActivity", dto, "Evidence removed successful!");
      return;
    } catch (err) {
      this.sendError(res, req, err);
      return;
    }
  }

  public async replaceEvidence(req: Request, res: Response): Promise<void> {
    try {
      const auth = await ApiGuardExport.GetAuthUser(req);
      if (!auth) {
        ApiResponseBuilder.validationError(res, "Invalid auth data");
        return;
      }
      const authNormalised: AuthUserNormalized | null = await ApiGuardExport.GetNormalisedAuthUser(req);
      if (!authNormalised) {
        ApiResponseBuilder.validationError(res, "Invalid auth data");
        return;
      }



      const activityId = String(req.params.activityId || "").trim();
      const ctx = this.buildWsContext(req, auth, { activityId, workItemId: null, teamId: null });

      const finalized = await this.finalizeEvidenceUploads(req, activityId);

      const input: MemberActivityReplaceEvidenceInput = {
        evidence: finalized ? finalized.evidence : [],
        updatedByUserId: authNormalised.userId,
      };

      const dto = await this.service.replaceEvidence(ctx, activityId, input);

      this.tryEmitMemberActivityNotification(auth, "memberActivity.evidence.replace", dto, {
        actionKeyRaw: "team:member.activities.updated",
        actionKeyFallback: "team:member.activities.updated",
        title: "Evidence replaced on activity",
        message: dto.title,
      });

      ApiResponseBuilder.ok(res, "memberActivity", dto, "Evidence replaced successful!", {
        ...(finalized ? { other: { uploads: finalized.uploadPacket } } : {}),
      });
      return;
    } catch (err) {
      this.sendError(res, req, err);
      return;
    }
  }

  // ===========================================================================
  // Blocker operations — NOTIFICATIONS ENABLED
  // ===========================================================================
  public async appendBlocker(req: Request, res: Response): Promise<void> {
    try {
      const auth = await ApiGuardExport.GetAuthUser(req);
      if (!auth) {
        ApiResponseBuilder.validationError(res, "Invalid auth data");
        return;
      }
      const authNormalised: AuthUserNormalized | null = await ApiGuardExport.GetNormalisedAuthUser(req);
      if (!authNormalised) {
        ApiResponseBuilder.validationError(res, "Invalid auth data");
        return;
      }



      const activityId = String(req.params.activityId || "").trim();
      const ctx = this.buildWsContext(req, auth, { activityId, workItemId: null, teamId: null });

      const blocker = this.readBlocker(req.body?.blocker);

      const input: MemberActivityAppendBlockerInput = {
        blocker,
        updatedByUserId: authNormalised.userId,
      };

      const dto = await this.service.appendBlocker(ctx, activityId, input);

      this.tryEmitMemberActivityNotification(auth, "memberActivity.blocker.append", dto, {
        actionKeyRaw: "team:member.activities.updated",
        actionKeyFallback: "team:member.activities.updated",
        title: "Blocker added",
        message: dto.title,
      });

      ApiResponseBuilder.ok(res, "memberActivity", dto, "Blocker appended successful!");
      return;
    } catch (err) {
      this.sendError(res, req, err);
      return;
    }
  }

  public async updateBlocker(req: Request, res: Response): Promise<void> {
    try {
      const auth = await ApiGuardExport.GetAuthUser(req);
      if (!auth) {
        ApiResponseBuilder.validationError(res, "Invalid auth data");
        return;
      }
      const authNormalised: AuthUserNormalized | null = await ApiGuardExport.GetNormalisedAuthUser(req);
      if (!authNormalised) {
        ApiResponseBuilder.validationError(res, "Invalid auth data");
        return;
      }



      const activityId = String(req.params.activityId || "").trim();
      const ctx = this.buildWsContext(req, auth, { activityId, workItemId: null, teamId: null });

      const title = String(req.body?.title || "").trim();
      const reportedAtIso = String(req.body?.reportedAtIso || "").trim();

      if (!title) throw new MemberActivitiesServiceError("VALIDATION_ERROR", "title is required.");
      if (!reportedAtIso) throw new MemberActivitiesServiceError("VALIDATION_ERROR", "reportedAtIso is required.");

      const patch = this.readBlockerPatch(req.body?.patch);

      const input: MemberActivityUpdateBlockerInput = {
        title,
        reportedAtIso,
        patch,
        updatedByUserId: authNormalised.userId,
      };

      const dto = await this.service.updateBlocker(ctx, activityId, input);

      this.tryEmitMemberActivityNotification(auth, "memberActivity.blocker.update", dto, {
        actionKeyRaw: "team:member.activities.updated",
        actionKeyFallback: "team:member.activities.updated",
        title: "Blocker updated",
        message: dto.title,
      });

      ApiResponseBuilder.ok(res, "memberActivity", dto, "Blocker updated successful!");
      return;
    } catch (err) {
      this.sendError(res, req, err);
      return;
    }
  }

  public async resolveBlocker(req: Request, res: Response): Promise<void> {
    try {
      const auth = await ApiGuardExport.GetAuthUser(req);
      if (!auth) {
        ApiResponseBuilder.validationError(res, "Invalid auth data");
        return;
      }
      const authNormalised: AuthUserNormalized | null = await ApiGuardExport.GetNormalisedAuthUser(req);
      if (!authNormalised) {
        ApiResponseBuilder.validationError(res, "Invalid auth data");
        return;
      }



      const activityId = String(req.params.activityId || "").trim();
      const ctx = this.buildWsContext(req, auth, { activityId, workItemId: null, teamId: null });

      const title = String(req.body?.title || "").trim();
      const reportedAtIso = String(req.body?.reportedAtIso || "").trim();
      const resolvedAtIsoRaw = String(req.body?.resolvedAtIso || "").trim();

      if (!title) throw new MemberActivitiesServiceError("VALIDATION_ERROR", "title is required.");
      if (!reportedAtIso) throw new MemberActivitiesServiceError("VALIDATION_ERROR", "reportedAtIso is required.");

      const input: MemberActivityResolveBlockerInput = {
        title,
        reportedAtIso,
        ...(resolvedAtIsoRaw ? { resolvedAtIso: resolvedAtIsoRaw } : {}),
        updatedByUserId: authNormalised.userId,
      };

      const dto = await this.service.resolveBlocker(ctx, activityId, input);

      this.tryEmitMemberActivityNotification(auth, "memberActivity.blocker.resolve", dto, {
        actionKeyRaw: "team:member.activities.updated",
        actionKeyFallback: "team:member.activities.updated",
        title: "Blocker resolved",
        message: dto.title,
      });

      ApiResponseBuilder.ok(res, "memberActivity", dto, "Blocker resolved successful!");
      return;
    } catch (err) {
      this.sendError(res, req, err);
      return;
    }
  }

  public async removeBlocker(req: Request, res: Response): Promise<void> {
    try {
      const auth = await ApiGuardExport.GetAuthUser(req);
      if (!auth) {
        ApiResponseBuilder.validationError(res, "Invalid auth data");
        return;
      }
      const authNormalised: AuthUserNormalized | null = await ApiGuardExport.GetNormalisedAuthUser(req);
      if (!authNormalised) {
        ApiResponseBuilder.validationError(res, "Invalid auth data");
        return;
      }



      const activityId = String(req.params.activityId || "").trim();
      const ctx = this.buildWsContext(req, auth, { activityId, workItemId: null, teamId: null });

      const title = String(req.body?.title || "").trim();
      const reportedAtIso = String(req.body?.reportedAtIso || "").trim();

      if (!title) throw new MemberActivitiesServiceError("VALIDATION_ERROR", "title is required.");
      if (!reportedAtIso) throw new MemberActivitiesServiceError("VALIDATION_ERROR", "reportedAtIso is required.");

      const input: MemberActivityRemoveBlockerInput = {
        title,
        reportedAtIso,
        updatedByUserId: authNormalised.userId,
      };

      const dto = await this.service.removeBlocker(ctx, activityId, input);

      this.tryEmitMemberActivityNotification(auth, "memberActivity.blocker.remove", dto, {
        actionKeyRaw: "team:member.activities.updated",
        actionKeyFallback: "team:member.activities.updated",
        title: "Blocker removed",
        message: dto.title,
      });

      ApiResponseBuilder.ok(res, "memberActivity", dto, "Blocker removed successful!");
      return;
    } catch (err) {
      this.sendError(res, req, err);
      return;
    }
  }

  // ===========================================================================
  // FINALIZE UPLOADS (TEMP -> FINAL) and map to MemberActivityEvidence[]
  // ===========================================================================
  private async finalizeEvidenceUploads(
    req: Request,
    activityId: string
  ): Promise<{ evidence: MemberActivityEvidence[]; uploadPacket: UploadResultPacket } | null> {
    const bag = this.getUploadBag(req);
    if (!bag) return null;

    const packet = bag.packet;
    if (!packet || !packet.byField) return null;

    const originals = this.safeGetByField(packet, "evidence");
    if (originals.length === 0) return null;

    // Need teamId for FINAL path. Load from DB.
    const dto = await this.service.getById(activityId);
    const teamId = this.readObjectIdString((dto as unknown as { teamId?: unknown }).teamId ?? "");

    const finalSubPath = `teamManagement/memberActivities/${teamId}/${activityId}`;
    const destinationDir = `uploads/${finalSubPath}/evidence`;

    const sources = originals.map((p) => this.readRelativePath(p)).filter((x) => x.length > 0);
    if (sources.length === 0) return null;

    let movedRelativePaths: string[] = [];

    try {
      const moveRes = await FileUploader.movePublicFiles({
        sources,
        destinationDir,
        overwrite: true,
      });
      movedRelativePaths = Array.isArray(moveRes.moved) ? moveRes.moved : [];
    } catch (e) {
      console.warn(
        `[Warning:] [MemberActivitiesController] movePublicFiles failed for evidence: ${(e as Error).message}\n`
      );
      return null;
    }

    const rebuiltPackets = this.rebuildPacketsAfterMove(req, originals, movedRelativePaths);
    const evidence = rebuiltPackets.map((p) => this.toEvidenceDto(p));

    const origin = this.buildOrigin(req);
    const baseRelativeDir = `uploads/${finalSubPath}`;
    const basePublicUrl = `${origin}/${baseRelativeDir}`;

    const outPacket: UploadResultPacket = {
      baseRelativeDir,
      basePublicUrl,
      totalFiles: rebuiltPackets.length,
      totalBytes: this.sumBytes({ evidence: rebuiltPackets }),
      byField: { evidence: rebuiltPackets },
    };

    return { evidence, uploadPacket: outPacket };
  }

  private rebuildPacketsAfterMove(req: Request, original: FileMetaPacket[], movedRelativePaths: string[]): FileMetaPacket[] {
    const movedByBase = new Map<string, string>();
    for (const rel of movedRelativePaths) {
      const base = this.basename(rel);
      if (base) movedByBase.set(base, rel);
    }

    const origin = this.buildOrigin(req);
    const rebuilt: FileMetaPacket[] = [];

    for (const p of original) {
      const oldRel = this.readRelativePath(p);
      const base = this.basename(oldRel);
      const movedRel = base ? movedByBase.get(base) : undefined;

      if (!movedRel) continue;

      const next = this.clonePacket(p, {
        relativePath: movedRel,
        publicUrl: `${origin}/${movedRel}`,
      });

      rebuilt.push(next);
    }

    return rebuilt;
  }

  // ===========================================================================
  // Input readers (REST -> Service inputs)
  // ===========================================================================
  private readListFilters(req: Request): MemberActivityListFilters {
    const teamId = String(req.query.teamId || "").trim();
    if (!teamId) throw new MemberActivitiesServiceError("VALIDATION_ERROR", "teamId is required.");

    const workItemIdRaw = String(req.query.workItemId || "").trim();
    const userIdRaw = String(req.query.userId || "").trim();

    const typeRaw = String(req.query.type || "").trim();
    const statusRaw = String(req.query.status || "").trim();

    const startFromRaw = String(req.query.startFrom || "").trim();
    const startToRaw = String(req.query.startTo || "").trim();
    const qRaw = String(req.query.q || "").trim();

    return {
      teamId,
      ...(workItemIdRaw ? { workItemId: workItemIdRaw } : {}),
      ...(userIdRaw ? { userId: userIdRaw } : {}),
      ...(typeRaw ? { type: typeRaw as MemberActivityType } : {}),
      ...(statusRaw ? { status: statusRaw as MemberActivityStatus } : {}),
      ...(startFromRaw ? { startFrom: startFromRaw } : {}),
      ...(startToRaw ? { startTo: startToRaw } : {}),
      ...(qRaw ? { q: qRaw } : {}),
    };
  }

  private readPaging(req: Request): MemberActivityListPaging {
    const page = Number(req.query.page ?? 1);
    const limit = Number(req.query.limit ?? 20);

    return {
      page: Number.isFinite(page) ? Math.floor(page) : 1,
      limit: Number.isFinite(limit) ? Math.floor(limit) : 20,
    };
  }

  private readCreateInput(req: Request, auth: AuthUserNormalized): MemberActivityCreateInput {
    const workItemId = String(req.body?.workItemId || "").trim();
    const teamId = String(req.body?.teamId || "").trim();
    const userId = String(req.body?.userId || "").trim();

    const typeRaw = String(req.body?.type || "").trim();
    const title = String(req.body?.title || "").trim();
    const notesRaw = String(req.body?.notes || "").trim();

    const startAt = String(req.body?.startAt || "").trim();
    const endAt = String(req.body?.endAt || "").trim();
    const allDay = Boolean(req.body?.allDay);
    const timezoneRaw = String(req.body?.timezone || "").trim();

    const statusRaw = String(req.body?.status || "").trim();

    const progressBeforeRaw = req.body?.progressBefore;
    const progressAfterRaw = req.body?.progressAfter;

    const milestoneIdRaw = String(req.body?.milestoneId || "").trim();

    const requestIdRaw = String(req.body?.requestId || "").trim();
    const sourceRaw = String(req.body?.source || "").trim();

    if (!workItemId) throw new MemberActivitiesServiceError("VALIDATION_ERROR", "workItemId is required.");
    if (!teamId) throw new MemberActivitiesServiceError("VALIDATION_ERROR", "teamId is required.");
    if (!userId) throw new MemberActivitiesServiceError("VALIDATION_ERROR", "userId is required.");
    if (!typeRaw) throw new MemberActivitiesServiceError("VALIDATION_ERROR", "type is required.");
    if (!title) throw new MemberActivitiesServiceError("VALIDATION_ERROR", "title is required.");
    if (!startAt) throw new MemberActivitiesServiceError("VALIDATION_ERROR", "startAt is required.");
    if (!endAt) throw new MemberActivitiesServiceError("VALIDATION_ERROR", "endAt is required.");
    if (!statusRaw) throw new MemberActivitiesServiceError("VALIDATION_ERROR", "status is required.");

    const source =
      sourceRaw === "rest" || sourceRaw === "ws" || sourceRaw === "system" ? (sourceRaw as "rest" | "ws" | "system") : null;

    return {
      workItemId,
      teamId,
      userId,

      createdByUserId: auth.userId,

      ...(requestIdRaw ? { requestId: requestIdRaw } : {}),
      ...(source ? { source } : {}),

      type: typeRaw as MemberActivityType,

      title,
      ...(notesRaw ? { notes: notesRaw } : {}),

      startAt,
      endAt,
      allDay,
      ...(timezoneRaw ? { timezone: timezoneRaw } : {}),

      status: statusRaw as MemberActivityStatus,

      ...(typeof progressBeforeRaw === "number" ? { progressBefore: progressBeforeRaw } : {}),
      ...(typeof progressAfterRaw === "number" ? { progressAfter: progressAfterRaw } : {}),

      ...(milestoneIdRaw ? { milestoneId: milestoneIdRaw } : {}),
    };
  }

  private readUpdateInput(req: Request, auth: AuthUserNormalized): MemberActivityUpdateInput {
    const typeRaw = String(req.body?.type || "").trim();
    const titleRaw = req.body?.title;
    const notesRaw = req.body?.notes;

    const startAtRaw = String(req.body?.startAt || "").trim();
    const endAtRaw = String(req.body?.endAt || "").trim();

    const allDayRaw = req.body?.allDay;
    const timezoneRaw = req.body?.timezone;

    const statusRaw = String(req.body?.status || "").trim();

    const progressBeforeRaw = req.body?.progressBefore;
    const progressAfterRaw = req.body?.progressAfter;

    const milestoneIdRaw = req.body?.milestoneId;

    return {
      ...(typeRaw ? { type: typeRaw as MemberActivityType } : {}),
      ...(typeof titleRaw === "string" ? { title: titleRaw } : {}),
      ...(typeof notesRaw === "string" ? { notes: notesRaw } : {}),
      ...(startAtRaw ? { startAt: startAtRaw } : {}),
      ...(endAtRaw ? { endAt: endAtRaw } : {}),
      ...(typeof allDayRaw === "boolean" ? { allDay: allDayRaw } : {}),
      ...(typeof timezoneRaw === "string" ? { timezone: timezoneRaw } : {}),
      ...(statusRaw ? { status: statusRaw as MemberActivityStatus } : {}),
      ...(typeof progressBeforeRaw === "number" ? { progressBefore: progressBeforeRaw } : {}),
      ...(typeof progressAfterRaw === "number" ? { progressAfter: progressAfterRaw } : {}),
      ...(typeof milestoneIdRaw === "string" ? { milestoneId: milestoneIdRaw } : {}),
      updatedByUserId: auth.userId,
    };
  }

  // ===========================================================================
  // Blocker readers
  // ===========================================================================
  private readBlocker(raw: unknown): MemberActivityBlocker {
    if (!raw || typeof raw !== "object") {
      throw new MemberActivitiesServiceError("VALIDATION_ERROR", "blocker is required.");
    }

    const b = raw as {
      title?: unknown;
      details?: unknown;
      severity?: unknown;
      reportedAt?: unknown;
      resolvedAt?: unknown;
    };

    const title = typeof b.title === "string" ? b.title.trim() : "";
    if (!title) throw new MemberActivitiesServiceError("VALIDATION_ERROR", "blocker.title is required.");

    const reportedAt = this.toDateRequired(b.reportedAt, "blocker.reportedAt");
    const severity = this.readSeverity(b.severity);

    const out: MemberActivityBlocker = { title, severity, reportedAt };

    if (typeof b.details === "string") {
      const d = b.details.trim();
      if (d) out.details = d;
    }

    if (b.resolvedAt !== undefined && b.resolvedAt !== null && b.resolvedAt !== "") {
      out.resolvedAt = this.toDateRequired(b.resolvedAt, "blocker.resolvedAt");
    }

    return out;
  }

  private readSeverity(raw: unknown): MemberActivityBlocker["severity"] {
    if (typeof raw !== "string") return "low";
    const v = raw.toLowerCase().trim();
    if (v === "low" || v === "medium" || v === "high") return v;
    return "low";
  }

  private toDateRequired(v: unknown, field: string): Date {
    if (v instanceof Date) {
      if (Number.isNaN(v.getTime())) throw new MemberActivitiesServiceError("INVALID_DATE", `${field} is invalid Date.`);
      return v;
    }

    if (typeof v === "string") {
      const s = v.trim();
      if (!s) throw new MemberActivitiesServiceError("VALIDATION_ERROR", `${field} is required.`);
      const d = new Date(s);
      if (Number.isNaN(d.getTime())) throw new MemberActivitiesServiceError("INVALID_DATE", `${field} is not a valid date string.`);
      return d;
    }

    throw new MemberActivitiesServiceError("VALIDATION_ERROR", `${field} must be a Date or ISO string.`);
  }

  private readBlockerPatch(raw: unknown): MemberActivityUpdateBlockerInput["patch"] {
    if (!raw || typeof raw !== "object") {
      throw new MemberActivitiesServiceError("VALIDATION_ERROR", "patch is required.");
    }

    const p = raw as {
      title?: unknown;
      details?: unknown;
      severity?: unknown;
      resolvedAtIso?: unknown;
    };

    const next: MemberActivityUpdateBlockerInput["patch"] = {};

    if (typeof p.title === "string" && p.title.trim()) next.title = p.title.trim();
    if (typeof p.details === "string") next.details = p.details;
    if (p.severity === "low" || p.severity === "medium" || p.severity === "high") next.severity = p.severity;
    if (typeof p.resolvedAtIso === "string" && p.resolvedAtIso.trim()) next.resolvedAtIso = p.resolvedAtIso.trim();

    return next;
  }

  // ===========================================================================
  // WS Context
  // ===========================================================================
  private buildWsContext(
    req: Request,
    auth: AuthUser,
    ids: { activityId: string | null; workItemId: string | null; teamId: string | null }
  ): MemberActivityWsContext {
    const requestId = this.getRequestId(req) || this.makeToken();

    const actor: AuthUser = {
      userId: auth.userId,
      username: auth.username,
      role: auth.role,
      name: auth.name,
      ...(Array.isArray(auth.teamCodes) && auth.teamCodes.length > 0 ? { teamCodes: auth.teamCodes } : {}),
      ...(typeof auth.branchId === "string" && auth.branchId.length > 0 ? { branchId: auth.branchId } : {}),
    };

    const teamCodeRaw = String(req.body?.teamCode || req.query?.teamCode || "").trim();

    return {
      actor,
      requestId,
      ...(teamCodeRaw ? { teamCode: teamCodeRaw } : {}),
      ...(ids.activityId ? { activityId: ids.activityId } : {}),
      ...(ids.workItemId ? { workItemId: ids.workItemId } : {}),
      ...(ids.teamId ? { teamId: ids.teamId } : {}),
    };
  }

  private getRequestId(req: Request): string | null {
    const anyReq = req as unknown as { requestId?: unknown };
    if (typeof anyReq.requestId === "string" && anyReq.requestId.trim().length > 0) return anyReq.requestId.trim();

    const header = String(req.headers["x-request-id"] || "").trim();
    return header ? header : null;
  }

  // ===========================================================================
  // Error mapper
  // ===========================================================================
  private sendError(res: Response, req: Request, err: unknown): void {
    if (err instanceof MemberActivitiesServiceError) {
      const status =
        err.code === "ACTIVITY_NOT_FOUND"
          ? 404
          : err.code === "INVALID_OBJECT_ID"
            ? 400
            : err.code === "INVALID_DATE"
              ? 400
              : err.code === "INVALID_TIME_RANGE"
                ? 400
                : err.code === "BLOCKER_NOT_FOUND"
                  ? 404
                  : err.code === "VALIDATION_ERROR"
                    ? 400
                    : 400;

      ApiResponseBuilder.error(res, status, err.message);
      return;
    }

    const msg = err instanceof Error ? err.message : "Unknown error";
    ApiResponseBuilder.internalError(res, msg);
  }

  // ===========================================================================
  // Upload bag storage (req-scoped)
  // ===========================================================================
  private setUploadBag(req: Request, bag: UploadContextBag): void {
    (req as unknown as { __memberActivityUploadBag?: UploadContextBag }).__memberActivityUploadBag = bag;
  }

  private getUploadBag(req: Request): UploadContextBag | null {
    const raw = (req as unknown as { __memberActivityUploadBag?: unknown }).__memberActivityUploadBag;
    if (!raw || typeof raw !== "object") return null;

    const maybe = raw as { token?: unknown; packet?: unknown };
    if (typeof maybe.token !== "string") return null;
    if (!maybe.packet || typeof maybe.packet !== "object") return null;

    return raw as UploadContextBag;
  }

  private safeGetByField(packet: UploadResultPacket, field: UploadField): FileMetaPacket[] {
    const byField = packet.byField ?? {};
    const hit = byField[field];
    return Array.isArray(hit) ? hit : [];
  }

  private readRelativePath(p: FileMetaPacket): string {
    const u = p as unknown as { relativePath?: unknown; relPath?: unknown; path?: unknown };
    const rel =
      (typeof u.relativePath === "string" ? u.relativePath : "") ||
      (typeof u.relPath === "string" ? u.relPath : "") ||
      (typeof u.path === "string" ? u.path : "");
    return String(rel || "").replace(/\\/g, "/").trim();
  }

  private clonePacket(p: FileMetaPacket, patch: { relativePath: string; publicUrl: string }): FileMetaPacket {
    const obj = { ...(p as unknown as Record<string, unknown>) };

    obj.relativePath = patch.relativePath;
    obj.publicUrl = patch.publicUrl;

    // Back-compat
    obj.relPath = patch.relativePath;
    obj.url = patch.publicUrl;

    return obj as unknown as FileMetaPacket;
  }

  private basename(rel: string): string {
    const s = String(rel || "").replace(/\\/g, "/");
    const parts = s.split("/").filter(Boolean);
    const b = parts.length > 0 ? parts[parts.length - 1] : "";
    return b ? b.trim() : "";
  }

  private buildOrigin(req: Request): string {
    const host = String(req.get("host") || "").trim();
    const proto = String(req.protocol || "http").trim();
    return `${proto}://${host}`;
  }

  private sumBytes(movedByField: Record<string, FileMetaPacket[]>): number {
    let total = 0;

    for (const arr of Object.values(movedByField)) {
      const list = Array.isArray(arr) ? arr : [];
      for (const p of list) {
        const u = p as unknown as { sizeBytes?: unknown; size?: unknown };
        const n = typeof u.sizeBytes === "number" ? u.sizeBytes : typeof u.size === "number" ? u.size : 0;
        if (Number.isFinite(n) && n > 0) total += Math.floor(n);
      }
    }

    return total;
  }

  // ===========================================================================
  // Evidence DTO mapper (FileMetaPacket -> MemberActivityEvidence)
  // ===========================================================================
  private toEvidenceDto(p: FileMetaPacket): MemberActivityEvidence {
    const u = p as unknown as {
      relPath?: unknown;
      relativePath?: unknown;
      url?: unknown;
      publicUrl?: unknown;
      mimeType?: unknown;
      originalName?: unknown;
      storedName?: unknown;
      sizeBytes?: unknown;
      size?: unknown;
      uploadedAt?: unknown;
      createdAt?: unknown;
      label?: unknown;
    };

    const relPath =
      (typeof u.relPath === "string" ? u.relPath : "") || (typeof u.relativePath === "string" ? u.relativePath : "");
    const url = (typeof u.url === "string" ? u.url : "") || (typeof u.publicUrl === "string" ? u.publicUrl : "");

    if (!relPath || !url) throw new MemberActivitiesServiceError("VALIDATION_ERROR", "Evidence packet missing relPath/url.");

    const mimeType = typeof u.mimeType === "string" && u.mimeType.trim() ? u.mimeType.trim() : "application/octet-stream";
    const originalName = typeof u.originalName === "string" ? u.originalName.trim() : "";
    const storedName = typeof u.storedName === "string" ? u.storedName.trim() : "";
    const sizeBytes = typeof u.sizeBytes === "number" ? u.sizeBytes : typeof u.size === "number" ? u.size : 0;

    const label =
      (typeof u.label === "string" && u.label.trim() ? u.label.trim() : "") || originalName || storedName || "Evidence";

    const uploadedAtRaw =
      (typeof u.uploadedAt === "string" && u.uploadedAt.trim() ? u.uploadedAt.trim() : "") ||
      (typeof u.createdAt === "string" && u.createdAt.trim() ? u.createdAt.trim() : "");

    const uploadedAt = uploadedAtRaw || new Date().toISOString();

    return {
      label,
      relPath,
      url,
      mimeType,
      originalName,
      sizeBytes: Number.isFinite(sizeBytes) && sizeBytes > 0 ? Math.floor(sizeBytes) : 0,
      uploadedAt,
    };
  }

  // ===========================================================================
  // Auth helpers
  // ===========================================================================
  private toIdString(id: Types.ObjectId | string): string {
    if (typeof id === "string") {
      const s = id.trim();
      if (!Types.ObjectId.isValid(s)) throw new Error(`[Error:] [MemberActivitiesController] Invalid userId string: ${s}\n`);
      return s;
    }

    const s = id.toString();
    if (!Types.ObjectId.isValid(s)) throw new Error("[Error:] [MemberActivitiesController] Invalid userId ObjectId\n");
    return s;
  }

  private normalizeAuthUser(auth: AuthUser): AuthUserNormalized {
    return { ...auth, userId: this.toIdString(auth.userId) };
  }

  private readObjectIdString(v: unknown): string {
    if (typeof v === "string") {
      const s = v.trim();
      if (!Types.ObjectId.isValid(s)) throw new MemberActivitiesServiceError("INVALID_OBJECT_ID", `Invalid ObjectId: ${s}`);
      return s;
    }
    if (v instanceof Types.ObjectId) return v.toString();

    if (v && typeof v === "object" && "toString" in v) {
      const s = String((v as { toString: () => string }).toString());
      if (!Types.ObjectId.isValid(s)) throw new MemberActivitiesServiceError("INVALID_OBJECT_ID", `Invalid ObjectId: ${s}`);
      return s;
    }

    throw new MemberActivitiesServiceError("INVALID_OBJECT_ID", "Invalid ObjectId value.");
  }

  private makeToken(): string {
    return `${Date.now()}_${Math.random().toString(16).slice(2)}`.replace(/\./g, "_");
  }

  // ===========================================================================
  // ✅ FIXED: buildTarget() (exactOptionalPropertyTypes-safe)
  // - Only include optional props when they are REAL strings.
  // - actionKey always returns a UNION via NotificationActionKeyFilter.
  // ===========================================================================
  private buildTarget(args: {
    category?: string;
    module?: string;
    refId: string;
    rawActionKey: NotificationActionKey;
    fallbackActionKey: NotificationActionKey;
    params: Record<string, unknown>;
  }): NotificationTarget {
    const actionKey = NotificationActionKeyFilter.exactOrFallback(args.rawActionKey, args.fallbackActionKey);

    const target: NotificationTarget = {
      refId: args.refId,
      actionKey,
      ...(args.params ? { params: args.params } : {}),
    };

    // ✅ IMPORTANT: only set these if we truly have a string
    if (this.isNonEmptyString(args.category)) target.category = args.category.trim();
    if (this.isNonEmptyString(args.module)) target.module = args.module.trim();

    return target;
  }

  private isNonEmptyString(v: unknown): v is string {
    return typeof v === "string" && v.trim().length > 0;
  }
}

// ----------------------------------------------------------------------------
// Router-friendly export (same pattern you used elsewhere)
// ----------------------------------------------------------------------------
export class MemberActivitiesControllerExport {
  public static readonly Controller = MemberActivitiesController.GetInstance();

  public static readonly UploadMiddleware: RequestHandler = MemberActivitiesControllerExport.Controller.uploadMiddleware;

  public static readonly GetById: RequestHandler = MemberActivitiesControllerExport.Controller.getById;
  public static readonly List: RequestHandler = MemberActivitiesControllerExport.Controller.list;
  public static readonly Count: RequestHandler = MemberActivitiesControllerExport.Controller.count;

  public static readonly Create: RequestHandler = MemberActivitiesControllerExport.Controller.create;
  public static readonly UpdateById: RequestHandler = MemberActivitiesControllerExport.Controller.updateById;
  public static readonly DeleteById: RequestHandler = MemberActivitiesControllerExport.Controller.deleteById;

  public static readonly AppendEvidence: RequestHandler = MemberActivitiesControllerExport.Controller.appendEvidence;
  public static readonly RemoveEvidence: RequestHandler = MemberActivitiesControllerExport.Controller.removeEvidence;
  public static readonly ReplaceEvidence: RequestHandler = MemberActivitiesControllerExport.Controller.replaceEvidence;

  public static readonly AppendBlocker: RequestHandler = MemberActivitiesControllerExport.Controller.appendBlocker;
  public static readonly UpdateBlocker: RequestHandler = MemberActivitiesControllerExport.Controller.updateBlocker;
  public static readonly ResolveBlocker: RequestHandler = MemberActivitiesControllerExport.Controller.resolveBlocker;
  public static readonly RemoveBlocker: RequestHandler = MemberActivitiesControllerExport.Controller.removeBlocker;
}
