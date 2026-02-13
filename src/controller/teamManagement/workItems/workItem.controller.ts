// Path: src/controller/teamManagement/workItems/workItem.controller.ts
// ============================================================================
// WorkItemController (REST + FileUploader helper) — 100% CLASS-BASED
// ----------------------------------------------------------------------------
// ✅ PURPOSE
// - Exposes REST endpoints for WorkItem domain (CRUD + atomic ops + activity)
// - Uses your SECURITY-CRITICAL FileUploader helper for uploads
// - Upload fields supported: files / attachments / evidence
//
// ✅ Upload flow (TEMP -> FINAL)
// 1) uploadMiddleware uploads to TEMP:
//      uploads/teamManagement/workItems/__tmp/<token>/<field>/<storedName>
// 2) create/update does DB write FIRST (REST source of truth)
// 3) controller moves TEMP -> FINAL:
//      uploads/teamManagement/workItems/<teamId>/<workItemId>/<field>/<storedName>
// 4) controller rebuilds FileMetaPacket[] with updated relativePath/publicUrl
// 5) controller patches WorkItemModel by appending meta arrays (best-effort)
//    ✅ uploads must NEVER break REST response
//
// ✅ IMPORTANT PROJECT RULES
// - Constructor MUST NOT accept parameters
// - Class-only (no exported helper functions)
// - exactOptionalPropertyTypes safe: omit optional props, never set to undefined
// - ApiResponseBuilder uses ok/error (and your existing internalError/validationError)
// - ApiGuardExport.GetAuthUser(req) is async and MUST be awaited
// ============================================================================

import type { Request, Response, NextFunction, RequestHandler } from "express";
import { Types } from "mongoose";

import FileUploader, { type UploadResultPacket } from "../../../utils/file-uploader.helper";
import type { FileMetaPacket, PaginationMeta } from "../../../types/api-message";

import { ApiResponseBuilder } from "../../../utils/api-combiner.builder";
import { ApiGuardExport } from "../../../guard/api-router.guard";

import { WorkItemModel } from "../../../models/teamManagement/workItems/workItem.model";

import {
    WorkItemRestService,
    WorkItemServiceError,
    type WorkItemListFilters,
    type WorkItemListPaging,
    type WorkItemCreateInput,
    type WorkItemUpdateInput,
    type WorkItemAppendActivityInput,
} from "../../../services/teamManagement/workItem/work-item.rest.service";

import type { WorkItemWsContext } from "../../../services/teamManagement/workItem/work-item.ws.service";

import type { WorkItemStatus, WorkItemPriority } from "../../../types/teamManagement/workItem/workItem.types";
import type { AuthUser } from "../../../types/common";

type UploadField = "files" | "attachments" | "evidence";

interface UploadContextBag {
    token: string;
    packet: UploadResultPacket;
}

export type AuthUserNormalized = Omit<AuthUser, "userId"> & { userId: string; };

export class WorkItemController {
    private static _instance: WorkItemController | null = null;

    public static GetInstance(): WorkItemController {
        if ( !WorkItemController._instance ) {
            WorkItemController._instance = new WorkItemController();
        }
        return WorkItemController._instance;
    }

    private readonly service: WorkItemRestService;

    // ----------------------------
    // Upload constraints
    // ----------------------------
    private readonly MAX_FILE_SIZE_MB = 25;
    private readonly MAX_FILES_TOTAL = 60;

    private readonly FIELD_MAX: Readonly<Record<UploadField, number>> = {
        files: 25,
        attachments: 25,
        evidence: 25,
    };

    private readonly ALLOWED_MIME: ReadonlySet<string> = new Set<string>( [
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
    ] );

    private constructor () {
        this.service = new WorkItemRestService();

        // Bind (router-friendly)
        this.uploadMiddleware = this.uploadMiddleware.bind( this );

        this.getById = this.getById.bind( this );
        this.list = this.list.bind( this );
        this.count = this.count.bind( this );

        this.create = this.create.bind( this );
        this.updateById = this.updateById.bind( this );
        this.deleteById = this.deleteById.bind( this );

        this.setStatus = this.setStatus.bind( this );
        this.setPriority = this.setPriority.bind( this );
        this.setDueAt = this.setDueAt.bind( this );
        this.setAssignedMembers = this.setAssignedMembers.bind( this );

        this.appendActivity = this.appendActivity.bind( this );
    }

    // ===========================================================================
    // Upload middleware (TEMP stage)
    // ===========================================================================
    public async uploadMiddleware( req: Request, res: Response, next: NextFunction ): Promise<void> {
        try {
            const token = this.makeToken();

            // TEMP subPath under uploads root (FileUploader enforces /public/uploads)
            // Example:
            //   /public/uploads/teamManagement/workItems/__tmp/<token>/files/<storedName>
            const tempSubPath = `teamManagement/workItems/__tmp/${ token }`;

            const fields = [
                { name: "files", maxCount: this.FIELD_MAX.files },
                { name: "attachments", maxCount: this.FIELD_MAX.attachments },
                { name: "evidence", maxCount: this.FIELD_MAX.evidence },
            ];

            const packet = await FileUploader.handleMultiFieldUpload( tempSubPath, fields, req, {
                maxFileSizeMb: this.MAX_FILE_SIZE_MB,
                maxFiles: this.MAX_FILES_TOTAL,
                allowedMimeTypesByField: {
                    files: this.ALLOWED_MIME,
                    attachments: this.ALLOWED_MIME,
                    evidence: this.ALLOWED_MIME,
                },
            } );

            // Store upload info on req for create/update to move into FINAL
            this.setUploadBag( req, { token, packet } );

            next();
            return;
        } catch ( err ) {
            const msg = err instanceof Error ? err.message : "Upload failed.";
            ApiResponseBuilder.internalError( res, msg );
            return;
        }
    }

    // ===========================================================================
    // GET
    // ===========================================================================
    public async getById( req: Request, res: Response ): Promise<void> {
        try {
            const id = String( req.params.workItemId || "" ).trim();
            const dto = await this.service.getById( id );

            ApiResponseBuilder.ok( res, "workItem", dto, `Work item ${ dto._id } fetched successful!` );
            return;
        } catch ( err ) {
            this.sendError( res, req, err );
            return;
        }
    }

    public async list( req: Request, res: Response ): Promise<void> {
        try {
            const filters = this.readListFilters( req );
            const paging = this.readPaging( req );

            const result = await this.service.list( filters, paging );

            const pagination: PaginationMeta = { total: result.other.total };

            ApiResponseBuilder.ok( res, "workItems", result.items, "Data fetch successful!", { pagination } );
            return;
        } catch ( err ) {
            this.sendError( res, req, err );
            return;
        }
    }

    public async count( req: Request, res: Response ): Promise<void> {
        try {
            const filters = this.readListFilters( req );
            const total = await this.service.count( filters );

            const pagination: PaginationMeta = { total };

            // If your FE expects count in pagination, keep it there.
            ApiResponseBuilder.ok( res, "other", {}, "Work Items total count fetched successful!", { pagination } );
            return;
        } catch ( err ) {
            this.sendError( res, req, err );
            return;
        }
    }

    // ===========================================================================
    // CREATE / UPDATE / DELETE (FINAL stage file move happens here)
    // ===========================================================================
    public async create( req: Request, res: Response ): Promise<void> {
        try {
            const authRaw = await ApiGuardExport.GetAuthUser( req );
            if ( !authRaw ) {
                ApiResponseBuilder.error( res, 401, "Unauthorized" );
                return;
            }

            // ✅ Normalize: userId always becomes ObjectId string
            const auth = this.normalizeAuthUser( authRaw );

            // ✅ Build WS ctx with resolved single teamCode (optional)
            const ctx = this.buildWsContext( req, auth );

            // ✅ Now readCreateInput can safely require string userId
            const input = this.readCreateInput( req, auth );

            // 1) DB write first (REST is source of truth)
            const dto = await this.service.create( ctx, input );

            // 2) Move TEMP -> FINAL and patch DB (best-effort)
            const workItemId = this.extractIdFromDto( dto );
            const uploads = await this.finalizeUploads( req, input.teamId, workItemId );

            const payload = {
                dto,
                ...( uploads ? { uploads } : {} ),
            };

            // Keep your response style (ok/error family)
            ApiResponseBuilder.ok( res, "workItem", payload.dto, "Work item created successful!", {
                ...( uploads ? { other: { uploads } } : {} ),
            } );
            return;
        } catch ( err ) {
            this.sendError( res, req, err );
            return;
        }
    }

    public async updateById( req: Request, res: Response ): Promise<void> {
        try {
            const authRaw = await ApiGuardExport.GetAuthUser( req );
            if ( !authRaw ) {
                ApiResponseBuilder.error( res, 401, "Unauthorized" );
                return;
            }

            const auth = this.normalizeAuthUser( authRaw );

            const workItemId = String( req.params.workItemId || "" ).trim();
            if ( !workItemId ) {
                ApiResponseBuilder.error( res, 400, "workItemId is required." );
                return;
            }

            const ctx = this.buildWsContext( req, auth );
            const input = this.readUpdateInput( req, auth );

            // 1) DB update first
            const dto = await this.service.updateById( ctx, workItemId, input );

            // 2) TEMP -> FINAL (best-effort)
            const teamId = this.extractTeamIdFromDto( dto );
            const uploads = await this.finalizeUploads( req, teamId, workItemId );

            ApiResponseBuilder.ok( res, "workItem", dto, "Work item updated successful!", {
                ...( uploads ? { other: { uploads } } : {} ),
            } );
            return;
        } catch ( err ) {
            this.sendError( res, req, err );
            return;
        }
    }

    public async deleteById( req: Request, res: Response ): Promise<void> {
        try {
            const authRaw = await ApiGuardExport.GetAuthUser( req );
            if ( !authRaw ) {
                ApiResponseBuilder.error( res, 401, "Unauthorized" );
                return;
            }

            const auth = this.normalizeAuthUser( authRaw );

            const workItemId = String( req.params.workItemId || "" ).trim();
            if ( !workItemId ) {
                ApiResponseBuilder.error( res, 400, "workItemId is required." );
                return;
            }

            const ctx = this.buildWsContext( req, auth );
            await this.service.deleteById( ctx, workItemId );

            ApiResponseBuilder.ok( res, "other", { deleted: true }, "Work item deleted successful!" );
            return;
        } catch ( err ) {
            this.sendError( res, req, err );
            return;
        }
    }

    // ===========================================================================
    // ATOMIC OPS
    // ===========================================================================
    public async setStatus( req: Request, res: Response ): Promise<void> {
        try {
            const authRaw = await ApiGuardExport.GetAuthUser( req );
            if ( !authRaw ) {
                ApiResponseBuilder.error( res, 401, "Unauthorized" );
                return;
            }
            const auth = this.normalizeAuthUser( authRaw );

            const workItemId = String( req.params.workItemId || "" ).trim();
            const status = String( req.body?.status || "" ).trim() as WorkItemStatus;

            if ( !workItemId ) {
                ApiResponseBuilder.error( res, 400, "workItemId is required." );
                return;
            }
            if ( !status ) {
                ApiResponseBuilder.error( res, 400, "status is required." );
                return;
            }

            const ctx = this.buildWsContext( req, auth );
            const dto = await this.service.setStatus( ctx, workItemId, status, auth.userId );

            ApiResponseBuilder.ok( res, "workItem", dto, "Status updated successful!" );
            return;
        } catch ( err ) {
            this.sendError( res, req, err );
            return;
        }
    }

    public async setPriority( req: Request, res: Response ): Promise<void> {
        try {
            const authRaw = await ApiGuardExport.GetAuthUser( req );
            if ( !authRaw ) {
                ApiResponseBuilder.error( res, 401, "Unauthorized" );
                return;
            }
            const auth = this.normalizeAuthUser( authRaw );

            const workItemId = String( req.params.workItemId || "" ).trim();
            const priority = String( req.body?.priority || "" ).trim() as WorkItemPriority;

            if ( !workItemId ) {
                ApiResponseBuilder.error( res, 400, "workItemId is required." );
                return;
            }
            if ( !priority ) {
                ApiResponseBuilder.error( res, 400, "priority is required." );
                return;
            }

            const ctx = this.buildWsContext( req, auth );
            const dto = await this.service.setPriority( ctx, workItemId, priority, auth.userId );

            ApiResponseBuilder.ok( res, "workItem", dto, "Priority updated successful!" );
            return;
        } catch ( err ) {
            this.sendError( res, req, err );
            return;
        }
    }

    public async setDueAt( req: Request, res: Response ): Promise<void> {
        try {
            const authRaw = await ApiGuardExport.GetAuthUser( req );
            if ( !authRaw ) {
                ApiResponseBuilder.error( res, 401, "Unauthorized" );
                return;
            }
            const auth = this.normalizeAuthUser( authRaw );

            const workItemId = String( req.params.workItemId || "" ).trim();
            const expectedCompleteAt = String( req.body?.expectedCompleteAt || "" ).trim();

            if ( !workItemId ) {
                ApiResponseBuilder.error( res, 400, "workItemId is required." );
                return;
            }
            if ( !expectedCompleteAt ) {
                ApiResponseBuilder.error( res, 400, "expectedCompleteAt is required." );
                return;
            }

            const ctx = this.buildWsContext( req, auth );
            const dto = await this.service.setDueAt( ctx, workItemId, expectedCompleteAt, auth.userId );

            ApiResponseBuilder.ok( res, "workItem", dto, "Due date updated successful!" );
            return;
        } catch ( err ) {
            this.sendError( res, req, err );
            return;
        }
    }

    public async setAssignedMembers( req: Request, res: Response ): Promise<void> {
        try {
            const authRaw = await ApiGuardExport.GetAuthUser( req );
            if ( !authRaw ) {
                ApiResponseBuilder.error( res, 401, "Unauthorized" );
                return;
            }
            const auth = this.normalizeAuthUser( authRaw );

            const workItemId = String( req.params.workItemId || "" ).trim();
            const assignedToUserIds = this.readStringArray( req.body?.assignedToUserIds );

            if ( !workItemId ) {
                ApiResponseBuilder.error( res, 400, "workItemId is required." );
                return;
            }
            if ( assignedToUserIds.length === 0 ) {
                ApiResponseBuilder.error( res, 400, "assignedToUserIds is required." );
                return;
            }

            const ctx = this.buildWsContext( req, auth );
            const dto = await this.service.setAssignedMembers( ctx, workItemId, assignedToUserIds, auth.userId );

            ApiResponseBuilder.ok( res, "workItem", dto, "Assigned members updated successful!" );
            return;
        } catch ( err ) {
            this.sendError( res, req, err );
            return;
        }
    }

    // ===========================================================================
    // MEMBER ACTIVITY
    // ===========================================================================
    public async appendActivity( req: Request, res: Response ): Promise<void> {
        try {
            const authRaw = await ApiGuardExport.GetAuthUser( req );
            if ( !authRaw ) {
                ApiResponseBuilder.error( res, 401, "Unauthorized" );
                return;
            }
            const auth = this.normalizeAuthUser( authRaw );

            const workItemId = String( req.params.workItemId || "" ).trim();
            if ( !workItemId ) {
                ApiResponseBuilder.error( res, 400, "workItemId is required." );
                return;
            }

            const input = this.readAppendActivityInput( req );
            const ctx = this.buildWsContext( req, auth );

            const activity = await this.service.appendActivity( ctx, workItemId, input );

            ApiResponseBuilder.ok( res, "memberActivity", activity, "Activity appended successful!" );
            return;
        } catch ( err ) {
            this.sendError( res, req, err );
            return;
        }
    }

    // ===========================================================================
    // FINALIZE UPLOADS (TEMP -> FINAL) + patch WorkItemModel
    // ===========================================================================
    private async finalizeUploads( req: Request, teamId: string, workItemId: string ): Promise<UploadResultPacket | null> {
        const bag = this.getUploadBag( req );
        if ( !bag ) return null;

        const packet = bag.packet;
        if ( !packet || !packet.byField ) return null;

        const hasAny =
            packet.totalFiles > 0 ||
            this.fieldHasFiles( packet, "files" ) ||
            this.fieldHasFiles( packet, "attachments" ) ||
            this.fieldHasFiles( packet, "evidence" );

        if ( !hasAny ) return null;

        // FINAL base subPath
        // uploads/teamManagement/workItems/<teamId>/<workItemId>/<field>/<storedName>
        const finalSubPath = `teamManagement/workItems/${ teamId }/${ workItemId }`;

        const movedByField: Record<string, FileMetaPacket[]> = {
            files: [],
            attachments: [],
            evidence: [],
        };

        for ( const field of [ "files", "attachments", "evidence" ] as UploadField[] ) {
            const arr = this.safeGetByField( packet, field );
            if ( arr.length === 0 ) continue;

            // Each packet.relativePath should be "uploads/<tempSubPath>/<field>/<storedName>"
            const sources = arr
                .map( ( p ) => this.readRelativePath( p ) )
                .filter( ( x ) => x.length > 0 );

            if ( sources.length === 0 ) continue;

            const destinationDir = `uploads/${ finalSubPath }/${ field }`;

            try {
                const moveRes = await FileUploader.movePublicFiles( {
                    sources,
                    destinationDir,
                    overwrite: true,
                } );

                const rebuilt = this.rebuildPacketsAfterMove( req, arr, moveRes.moved );
                movedByField[ field ] = rebuilt;
            } catch ( e ) {
                console.warn(
                    `[Warning:] [WorkItemController] movePublicFiles failed for ${ field }: ${ ( e as Error ).message }\n`
                );
            }
        }

        // Patch WorkItemModel with newly moved meta packets (append, not replace)
        try {
            const $push: Record<string, unknown> = {};

            if ( movedByField.files && movedByField.files.length > 0 ) $push.files = { $each: movedByField.files };
            if ( movedByField.attachments && movedByField.attachments.length > 0 ) $push.attachments = { $each: movedByField.attachments };
            if ( movedByField.evidence && movedByField.evidence.length > 0 ) $push.evidence = { $each: movedByField.evidence };

            if ( Object.keys( $push ).length > 0 ) {
                await WorkItemModel.updateOne( { _id: this.toObjectId( workItemId ) }, { $push } ).exec();
            }
        } catch ( e ) {
            console.warn( `[Warning:] [WorkItemController] WorkItem upload meta patch failed: ${ ( e as Error ).message }\n` );
        }

        // Build FINAL-shaped UploadResultPacket (contract-compatible)
        const origin = this.buildOrigin( req );
        const baseRelativeDir = `uploads/${ finalSubPath }`;
        const basePublicUrl = `${ origin }/${ baseRelativeDir }`;
        const totalFiles: number = ( movedByField.files ? movedByField.files.length : 0 ) +
            ( movedByField.attachments ? movedByField.attachments.length : 0 ) +
            ( movedByField.evidence ? movedByField.evidence.length : 0 );

        const out: UploadResultPacket = {
            baseRelativeDir,
            basePublicUrl,
            totalFiles,
            totalBytes: this.sumBytes( movedByField ),
            byField: {
                files: movedByField.files ?? [],
                attachments: movedByField.attachments ?? [],
                evidence: movedByField.evidence ?? [],
            },
        };

        return out;
    }

    private rebuildPacketsAfterMove( req: Request, original: FileMetaPacket[], movedRelativePaths: string[] ): FileMetaPacket[] {
        const movedByBase = new Map<string, string>();
        for ( const rel of movedRelativePaths ) {
            const base = this.basename( rel );
            if ( base ) movedByBase.set( base, rel );
        }

        const origin = this.buildOrigin( req );

        const rebuilt: FileMetaPacket[] = [];

        for ( const p of original ) {
            const oldRel = this.readRelativePath( p );
            const base = this.basename( oldRel );
            const movedRel = base ? movedByBase.get( base ) : undefined;

            if ( !movedRel ) continue;

            const next = this.clonePacket( p, {
                relativePath: movedRel,
                publicUrl: `${ origin }/${ movedRel }`,
            } );

            rebuilt.push( next );
        }

        return rebuilt;
    }

    // ===========================================================================
    // Input readers (REST -> Service inputs)
    // ===========================================================================
    private readListFilters( req: Request ): WorkItemListFilters {
        const teamId = String( req.query.teamId || "" ).trim();
        if ( !teamId ) throw new WorkItemServiceError( "VALIDATION_ERROR", "teamId is required." );

        const assignedToUserIdRaw = String( req.query.assignedToUserId || "" ).trim();
        const statusRaw = String( req.query.status || "" ).trim();
        const priorityRaw = String( req.query.priority || "" ).trim();
        const dueFromRaw = String( req.query.dueFrom || "" ).trim();
        const dueToRaw = String( req.query.dueTo || "" ).trim();
        const qRaw = String( req.query.q || "" ).trim();

        const filters: WorkItemListFilters = {
            teamId,
            ...( assignedToUserIdRaw ? { assignedToUserId: assignedToUserIdRaw } : {} ),
            ...( statusRaw ? { status: statusRaw as WorkItemStatus } : {} ),
            ...( priorityRaw ? { priority: priorityRaw as WorkItemPriority } : {} ),
            ...( dueFromRaw ? { dueFrom: dueFromRaw } : {} ),
            ...( dueToRaw ? { dueTo: dueToRaw } : {} ),
            ...( qRaw ? { q: qRaw } : {} ),
        };

        return filters;
    }

    private readPaging( req: Request ): WorkItemListPaging {
        const page = Number( req.query.page ?? 1 );
        const limit = Number( req.query.limit ?? 20 );

        return {
            page: Number.isFinite( page ) ? page : 1,
            limit: Number.isFinite( limit ) ? limit : 20,
        };
    }

    private readCreateInput( req: Request, auth: AuthUserNormalized ): WorkItemCreateInput {
        const workItemCode = String( req.body?.workItemCode || "" ).trim();
        const teamId = String( req.body?.teamId || "" ).trim();

        const assignedByUserId = String( req.body?.assignedByUserId || "" ).trim();
        const assignedToUserIds = this.readStringArray( req.body?.assignedToUserIds );

        const assignedAt = String( req.body?.assignedAt || "" ).trim();
        const expectedCompleteAt = String( req.body?.expectedCompleteAt || "" ).trim();

        const deadlinePolicy = String( req.body?.deadlinePolicy || "" ).trim();
        const statusCurrent = String( req.body?.statusCurrent || "" ).trim() as WorkItemStatus;
        const priority = String( req.body?.priority || "" ).trim() as WorkItemPriority;

        const progressCurrent = Number( req.body?.progressCurrent ?? 0 );

        const taskIdRaw = String( req.body?.taskId || "" ).trim();
        const expectedStartAtRaw = String( req.body?.expectedStartAt || "" ).trim();
        const graceMinutesRaw = req.body?.graceMinutes;

        if ( !workItemCode ) throw new WorkItemServiceError( "VALIDATION_ERROR", "workItemCode is required." );
        if ( !teamId ) throw new WorkItemServiceError( "VALIDATION_ERROR", "teamId is required." );
        if ( !assignedByUserId ) throw new WorkItemServiceError( "VALIDATION_ERROR", "assignedByUserId is required." );
        if ( !assignedAt ) throw new WorkItemServiceError( "VALIDATION_ERROR", "assignedAt is required." );
        if ( !expectedCompleteAt ) throw new WorkItemServiceError( "VALIDATION_ERROR", "expectedCompleteAt is required." );
        if ( !deadlinePolicy ) throw new WorkItemServiceError( "VALIDATION_ERROR", "deadlinePolicy is required." );

        const input: WorkItemCreateInput = {
            workItemCode,
            teamId,

            ...( taskIdRaw ? { taskId: taskIdRaw } : {} ),

            assignedByUserId,
            assignedToUserIds,

            assignedAt,
            expectedCompleteAt,

            ...( expectedStartAtRaw ? { expectedStartAt: expectedStartAtRaw } : {} ),

            deadlinePolicy: deadlinePolicy as WorkItemCreateInput[ "deadlinePolicy" ],
            ...( typeof graceMinutesRaw === "number" ? { graceMinutes: graceMinutesRaw } : {} ),

            statusCurrent,
            priority,
            progressCurrent,

            createdByUserId: auth.userId,
        };

        return input;
    }

    private readUpdateInput(req: Request, auth: AuthUserNormalized): WorkItemUpdateInput {
        const expectedStartAtRaw = String(req.body?.expectedStartAt || "").trim();
        const expectedCompleteAtRaw = String(req.body?.expectedCompleteAt || "").trim();
      
        const deadlinePolicyRaw = String(req.body?.deadlinePolicy || "").trim();
        const graceMinutesRaw = req.body?.graceMinutes;
      
        const statusCurrentRaw = String(req.body?.statusCurrent || "").trim();
        const priorityRaw = String(req.body?.priority || "").trim();
      
        const progressCurrentRaw = req.body?.progressCurrent;
        const completedAtRaw = String(req.body?.completedAt || "").trim();
        const completedByUserIdRaw = String(req.body?.completedByUserId || "").trim();
      
        // ✅ validate deadlinePolicy (no "as WorkItemUpdateInput['deadlinePolicy']")
        const deadlinePolicy =
          deadlinePolicyRaw === "soft" || deadlinePolicyRaw === "hard"
            ? (deadlinePolicyRaw as WorkItemUpdateInput["deadlinePolicy"] extends infer T
                ? Exclude<T, undefined>
                : never)
            : null;
      
        const input: WorkItemUpdateInput = {
          ...(expectedStartAtRaw ? { expectedStartAt: expectedStartAtRaw } : {}),
          ...(expectedCompleteAtRaw ? { expectedCompleteAt: expectedCompleteAtRaw } : {}),
      
          ...(deadlinePolicy ? { deadlinePolicy } : {}),
          ...(typeof graceMinutesRaw === "number" ? { graceMinutes: graceMinutesRaw } : {}),
      
          ...(statusCurrentRaw ? { statusCurrent: statusCurrentRaw as WorkItemStatus } : {}),
          ...(priorityRaw ? { priority: priorityRaw as WorkItemPriority } : {}),
      
          ...(typeof progressCurrentRaw === "number" ? { progressCurrent: progressCurrentRaw } : {}),
      
          ...(completedAtRaw ? { completedAt: completedAtRaw } : {}),
          ...(completedByUserIdRaw ? { completedByUserId: completedByUserIdRaw } : {}),
      
          updatedByUserId: auth.userId,
        };
      
        return input;
      }
      

    private readAppendActivityInput( req: Request ): WorkItemAppendActivityInput {
        const userId = String( req.body?.userId || "" ).trim();

        const type = String( req.body?.type || "" ).trim();
        const title = String( req.body?.title || "" ).trim();
        const notesRaw = String( req.body?.notes || "" ).trim();

        const startAt = String( req.body?.startAt || "" ).trim();
        const endAt = String( req.body?.endAt || "" ).trim();
        const allDay = Boolean( req.body?.allDay );

        const timezoneRaw = String( req.body?.timezone || "" ).trim();
        const status = String( req.body?.status || "" ).trim();

        const progressBeforeRaw = req.body?.progressBefore;
        const progressAfterRaw = req.body?.progressAfter;

        const milestoneIdRaw = String( req.body?.milestoneId || "" ).trim();

        if ( !userId ) throw new WorkItemServiceError( "VALIDATION_ERROR", "userId is required." );
        if ( !type ) throw new WorkItemServiceError( "VALIDATION_ERROR", "type is required." );
        if ( !title ) throw new WorkItemServiceError( "VALIDATION_ERROR", "title is required." );
        if ( !startAt ) throw new WorkItemServiceError( "VALIDATION_ERROR", "startAt is required." );
        if ( !endAt ) throw new WorkItemServiceError( "VALIDATION_ERROR", "endAt is required." );
        if ( !status ) throw new WorkItemServiceError( "VALIDATION_ERROR", "status is required." );

        const input: WorkItemAppendActivityInput = {
            userId,
            type,
            title,
            ...( notesRaw ? { notes: notesRaw } : {} ),
            startAt,
            endAt,
            allDay,
            ...( timezoneRaw ? { timezone: timezoneRaw } : {} ),
            status,
            ...( typeof progressBeforeRaw === "number" ? { progressBefore: progressBeforeRaw } : {} ),
            ...( typeof progressAfterRaw === "number" ? { progressAfter: progressAfterRaw } : {} ),
            ...( milestoneIdRaw ? { milestoneId: milestoneIdRaw } : {} ),
        };

        return input;
    }

    private readStringArray( raw: unknown ): string[] {
        if ( Array.isArray( raw ) ) {
            return raw.map( ( x ) => String( x ).trim() ).filter( ( x ) => x.length > 0 );
        }

        if ( typeof raw === "string" ) {
            const s = raw.trim();
            if ( !s ) return [];
            if ( s.includes( "," ) ) {
                return s.split( "," ).map( ( x ) => x.trim() ).filter( ( x ) => x.length > 0 );
            }
            return [ s ];
        }

        return [];
    }

    // ===========================================================================
    // WS Context (teamCodes -> single teamCode)
    // ===========================================================================
    private buildWsContext( req: Request, auth: AuthUserNormalized ): WorkItemWsContext {
        const requestId = this.getRequestId( req ) || this.makeToken();
        const teamCode = this.resolveTeamCode( req, auth );

        return {
            actor: auth, // ✅ required username/role present (fixes exactOptionalPropertyTypes error)
            requestId,
            ...( teamCode ? { teamCode } : {} ),
        };
    }

    private resolveTeamCode( req: Request, auth: AuthUserNormalized ): string | null {
        // Allow explicit teamCode from request (body/query/header), but validate against auth.teamCodes if present.
        const fromBody = String( ( req.body as unknown as { teamCode?: unknown; } )?.teamCode || "" ).trim();
        const fromQuery = String( ( req.query as unknown as { teamCode?: unknown; } )?.teamCode || "" ).trim();
        const fromHeader = String( req.headers[ "x-team-code" ] || "" ).trim();

        const requested = fromBody || fromQuery || fromHeader;

        const allowed = Array.isArray( auth.teamCodes ) ? auth.teamCodes : [];

        if ( requested ) {
            // If JWT provides teamCodes list, enforce membership.
            if ( allowed.length > 0 && !allowed.includes( requested ) ) {
                throw new WorkItemServiceError( "FORBIDDEN_TEAM", `Forbidden teamCode: ${ requested }` );
            }
            return requested;
        }

        // If only one team, auto pick (convenience)
        if ( allowed.length === 1 ) return allowed[ 0 ] ?? null;

        // Ambiguous/no teamCodes -> allow REST, skip WS emits
        return null;
    }

    private getRequestId( req: Request ): string | null {
        const anyReq = req as unknown as { requestId?: unknown; };
        if ( typeof anyReq.requestId === "string" && anyReq.requestId.trim().length > 0 ) {
            return anyReq.requestId.trim();
        }

        const header = String( req.headers[ "x-request-id" ] || "" ).trim();
        return header ? header : null;
    }

    // ===========================================================================
    // Error mapper
    // ===========================================================================
    private sendError( res: Response, req: Request, err: unknown ): void {
        if ( err instanceof WorkItemServiceError ) {
            const status =
                err.code === "WORK_ITEM_NOT_FOUND"
                    ? 404
                    : err.code === "INVALID_OBJECT_ID"
                        ? 400
                        : err.code === "INVALID_DATE"
                            ? 400
                            : err.code === "VALIDATION_ERROR"
                                ? 400
                                : err.code === "NOT_ASSIGNED"
                                    ? 403
                                    : err.code === "FORBIDDEN_TEAM"
                                        ? 403
                                        : 400;

            ApiResponseBuilder.error( res, status, err.message );
            return;
        }

        const msg = err instanceof Error ? err.message : "Unknown error";
        ApiResponseBuilder.internalError( res, msg );
    }

    // ===========================================================================
    // Upload bag storage (req-scoped)
    // ===========================================================================
    private setUploadBag( req: Request, bag: UploadContextBag ): void {
        ( req as unknown as { __workItemUploadBag?: UploadContextBag; } ).__workItemUploadBag = bag;
    }

    private getUploadBag( req: Request ): UploadContextBag | null {
        const raw = ( req as unknown as { __workItemUploadBag?: unknown; } ).__workItemUploadBag;
        if ( !raw || typeof raw !== "object" ) return null;

        const maybe = raw as { token?: unknown; packet?: unknown; };
        if ( typeof maybe.token !== "string" ) return null;
        if ( !maybe.packet || typeof maybe.packet !== "object" ) return null;

        return raw as UploadContextBag;
    }

    private fieldHasFiles( packet: UploadResultPacket, field: UploadField ): boolean {
        const arr = this.safeGetByField( packet, field );
        return arr.length > 0;
    }

    private safeGetByField( packet: UploadResultPacket, field: UploadField ): FileMetaPacket[] {
        const byField = packet.byField ?? {};
        const hit = byField[ field ];
        return Array.isArray( hit ) ? hit : [];
    }

    private readRelativePath( p: FileMetaPacket ): string {
        const u = p as unknown as { relativePath?: unknown; relPath?: unknown; path?: unknown; };
        const rel =
            ( typeof u.relativePath === "string" ? u.relativePath : "" ) ||
            ( typeof u.relPath === "string" ? u.relPath : "" ) ||
            ( typeof u.path === "string" ? u.path : "" );

        return String( rel || "" ).replace( /\\/g, "/" ).trim();
    }

    private clonePacket( p: FileMetaPacket, patch: { relativePath: string; publicUrl: string; } ): FileMetaPacket {
        const obj = { ...( p as unknown as Record<string, unknown> ) };

        obj.relativePath = patch.relativePath;
        obj.publicUrl = patch.publicUrl;

        // Back-compat
        obj.relPath = patch.relativePath;
        obj.url = patch.publicUrl;

        return obj as unknown as FileMetaPacket;
    }

    private basename( rel: string ): string {
        const s = String( rel || "" ).replace( /\\/g, "/" );
        const parts = s.split( "/" ).filter( Boolean );
        const basename: string | undefined = parts.length > 0 && parts[ parts.length - 1 ] ? parts[ parts.length - 1 ] : '';
        return basename ? basename.trim() : '';
    }

    private buildOrigin( req: Request ): string {
        const host = String( req.get( "host" ) || "" ).trim();
        const proto = String( req.protocol || "http" ).trim();
        return `${ proto }://${ host }`;
    }

    private sumBytes( movedByField: Record<string, FileMetaPacket[]> ): number {
        let total = 0;

        for ( const arr of Object.values( movedByField ) ) {
            const list = Array.isArray( arr ) ? arr : [];
            for ( const p of list ) {
                const u = p as unknown as { sizeBytes?: unknown; size?: unknown; };
                const n = typeof u.sizeBytes === "number" ? u.sizeBytes : typeof u.size === "number" ? u.size : 0;
                if ( Number.isFinite( n ) && n > 0 ) total += Math.floor( n );
            }
        }

        return total;
    }

    // ===========================================================================
    // DTO helpers
    // ===========================================================================
    private extractIdFromDto( dto: unknown ): string {
        const raw = ( dto as { _id?: unknown; id?: unknown; } )._id ?? ( dto as { id?: unknown; } ).id;

        if ( typeof raw === "string" && Types.ObjectId.isValid( raw ) ) return raw;
        if ( raw instanceof Types.ObjectId ) return raw.toString();

        if ( raw && typeof raw === "object" && "toString" in raw ) {
            const s = String( ( raw as { toString: () => string; } ).toString() );
            if ( Types.ObjectId.isValid( s ) ) return s;
        }

        throw new WorkItemServiceError( "DTO_MISSING_ID", "WorkItemDto does not contain a valid _id/id." );
    }

    private extractTeamIdFromDto( dto: unknown ): string {
        const raw = ( dto as { teamId?: unknown; } ).teamId;

        if ( typeof raw === "string" && Types.ObjectId.isValid( raw ) ) return raw;
        if ( raw instanceof Types.ObjectId ) return raw.toString();

        if ( raw && typeof raw === "object" && "toString" in raw ) {
            const s = String( ( raw as { toString: () => string; } ).toString() );
            if ( Types.ObjectId.isValid( s ) ) return s;
        }

        throw new WorkItemServiceError( "DTO_MISSING_TEAM_ID", "WorkItemDto.teamId missing or invalid." );
    }

    private toObjectId( id: string ): Types.ObjectId {
        if ( !Types.ObjectId.isValid( id ) ) {
            throw new WorkItemServiceError( "INVALID_OBJECT_ID", `Invalid ObjectId: ${ id }` );
        }
        return new Types.ObjectId( id );
    }

    private makeToken(): string {
        return `${ Date.now() }_${ Math.random().toString( 16 ).slice( 2 ) }`.replace( /\./g, "_" );
    }

    // ===========================================================================
    // Auth normalization (ObjectId | string -> string)
    // ===========================================================================
    private toIdString( id: Types.ObjectId | string ): string {
        if ( typeof id === "string" ) {
            const s = id.trim();
            if ( !Types.ObjectId.isValid( s ) ) {
                throw new WorkItemServiceError( "INVALID_OBJECT_ID", `Invalid userId string: ${ s }` );
            }
            return s;
        }

        const s = id.toString();
        if ( !Types.ObjectId.isValid( s ) ) {
            throw new WorkItemServiceError( "INVALID_OBJECT_ID", "Invalid userId ObjectId" );
        }
        return s;
    }

    private normalizeAuthUser( auth: AuthUser ): AuthUserNormalized {
        return {
            ...auth,
            userId: this.toIdString( auth.userId ),
        };
    }
}

// ----------------------------------------------------------------------------
// Router-friendly export (same pattern you used elsewhere)
// ----------------------------------------------------------------------------
export class WorkItemControllerExport {
    public static readonly Controller = WorkItemController.GetInstance();

    public static readonly UploadMiddleware: RequestHandler = WorkItemControllerExport.Controller.uploadMiddleware;

    public static readonly GetById: RequestHandler = WorkItemControllerExport.Controller.getById;
    public static readonly List: RequestHandler = WorkItemControllerExport.Controller.list;
    public static readonly Count: RequestHandler = WorkItemControllerExport.Controller.count;

    public static readonly Create: RequestHandler = WorkItemControllerExport.Controller.create;
    public static readonly UpdateById: RequestHandler = WorkItemControllerExport.Controller.updateById;
    public static readonly DeleteById: RequestHandler = WorkItemControllerExport.Controller.deleteById;

    public static readonly SetStatus: RequestHandler = WorkItemControllerExport.Controller.setStatus;
    public static readonly SetPriority: RequestHandler = WorkItemControllerExport.Controller.setPriority;
    public static readonly SetDueAt: RequestHandler = WorkItemControllerExport.Controller.setDueAt;
    public static readonly SetAssignedMembers: RequestHandler = WorkItemControllerExport.Controller.setAssignedMembers;

    public static readonly AppendActivity: RequestHandler = WorkItemControllerExport.Controller.appendActivity;
}
