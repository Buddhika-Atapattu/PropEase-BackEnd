// Path: src/controller/teamManagement/memberActivities/memberActivivties.controller.ts
// ============================================================================
// MemberActivitiesController (REST + FileUploader helper) — 100% CLASS-BASED
// ----------------------------------------------------------------------------
// ✅ PURPOSE
// - Exposes REST endpoints for MemberActivity domain (CRUD + evidence + blockers)
// - Uses your SECURITY-CRITICAL FileUploader helper for uploads
// - Upload field supported (for evidence):
//     - evidence
//
// ✅ Upload flow (TEMP -> FINAL)
// 1) uploadMiddleware runs FileUploader.handleMultiFieldUpload() to TEMP:
//      uploads/teamManagement/memberActivities/__tmp/<token>/evidence/<storedName>
// 2) evidence endpoints execute DB write FIRST (REST source of truth)
// 3) controller moves TEMP files into FINAL using FileUploader.movePublicFiles():
//      uploads/teamManagement/memberActivities/<teamId>/<activityId>/evidence/<storedName>
// 4) controller rebuilds MemberActivityEvidence[] with updated relPath/url
// 5) controller calls service.appendEvidence / replaceEvidence with rebuilt DTO
//    ✅ uploads must NEVER break REST response (best-effort)
//
// ✅ IMPORTANT PROJECT RULES (your rules)
// - Constructor MUST NOT accept parameters
// - Class-only (no exported helper functions)
// - exactOptionalPropertyTypes safe: omit optional props, never set to undefined
// - ApiResponseBuilder uses ok/error only
// - ApiGuardExport.GetAuthUser(req) is async and MUST be awaited
// ============================================================================

import type { Request, Response, NextFunction, RequestHandler } from "express";
import { Types } from "mongoose";

import FileUploader, { type UploadResultPacket } from "../../../utils/file-uploader.helper";
import type { FileMetaPacket, PaginationMeta } from "../../../types/api-message";

import { ApiResponseBuilder } from "../../../utils/api-combiner.builder";
import { ApiGuardExport } from "../../../guard/api-router.guard";

import type { AuthUser } from "../../../types/common";

import type {
    MemberActivityDto,
    MemberActivityEvidence,
    MemberActivityBlocker,
    MemberActivityStatus,
    MemberActivityType,
} from "../../../types/teamManagement/memberActivities/memberActivities.types";

import {
    MemberActivitiesRestService,
    MemberActivitiesServiceError,
    type MemberActivityListFilters,
    type MemberActivityListPaging,
    type MemberActivityCreateInput,
    type MemberActivityUpdateInput,
    type MemberActivityAppendEvidenceInput,
    type MemberActivityRemoveEvidenceInput,
    type MemberActivityReplaceEvidenceInput,
    type MemberActivityAppendBlockerInput,
    type MemberActivityUpdateBlockerInput,
    type MemberActivityResolveBlockerInput,
    type MemberActivityRemoveBlockerInput,
} from "../../../services/teamManagement/memberActivities/memberActivities.rest.service";
import type { MemberActivityWsContext } from "../../../services/teamManagement/memberActivities/memberActivities.ws.service";

type UploadField = "evidence";

interface UploadContextBag {
    token: string;
    packet: UploadResultPacket;
}

export type AuthUserNormalized = Omit<AuthUser, "userId"> & { userId: string; };

export class MemberActivitiesController {
    private static _instance: MemberActivitiesController | null = null;

    public static GetInstance(): MemberActivitiesController {
        if ( !MemberActivitiesController._instance ) {
            MemberActivitiesController._instance = new MemberActivitiesController();
        }
        return MemberActivitiesController._instance;
    }

    private readonly service: MemberActivitiesRestService;

    // ----------------------------
    // Upload constraints
    // ----------------------------
    private readonly MAX_FILE_SIZE_MB = 25;
    private readonly MAX_FILES_TOTAL = 60;

    private readonly FIELD_MAX: Readonly<Record<UploadField, number>> = {
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
        this.service = new MemberActivitiesRestService();

        // Bind (router-friendly)
        this.uploadMiddleware = this.uploadMiddleware.bind( this );

        this.getById = this.getById.bind( this );
        this.list = this.list.bind( this );
        this.count = this.count.bind( this );

        this.create = this.create.bind( this );
        this.updateById = this.updateById.bind( this );
        this.deleteById = this.deleteById.bind( this );

        this.appendEvidence = this.appendEvidence.bind( this );
        this.removeEvidence = this.removeEvidence.bind( this );
        this.replaceEvidence = this.replaceEvidence.bind( this );

        this.appendBlocker = this.appendBlocker.bind( this );
        this.updateBlocker = this.updateBlocker.bind( this );
        this.resolveBlocker = this.resolveBlocker.bind( this );
        this.removeBlocker = this.removeBlocker.bind( this );
    }

    // ===========================================================================
    // Upload middleware (TEMP stage)
    // ===========================================================================
    public async uploadMiddleware( req: Request, res: Response, next: NextFunction ): Promise<void> {
        try {
            const token = this.makeToken();

            // TEMP subPath under uploads root (FileUploader enforces /public/uploads)
            // Example:
            //   /public/uploads/teamManagement/memberActivities/__tmp/<token>/evidence/<storedName>
            const tempSubPath = `teamManagement/memberActivities/__tmp/${ token }`;

            const fields = [ { name: "evidence", maxCount: this.FIELD_MAX.evidence } ];

            const packet = await FileUploader.handleMultiFieldUpload( tempSubPath, fields, req, {
                maxFileSizeMb: this.MAX_FILE_SIZE_MB,
                maxFiles: this.MAX_FILES_TOTAL,
                allowedMimeTypesByField: {
                    evidence: this.ALLOWED_MIME,
                },
            } );

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
            const activityId = String( req.params.activityId || "" ).trim();
            const dto = await this.service.getById( activityId );

            ApiResponseBuilder.ok( res, "memberActivity", dto, `Member activity ${ dto._id } fetched successful!` );
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

            ApiResponseBuilder.ok( res, "memberActivities", result.items, "Data fetch successful!", { pagination } );
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

            ApiResponseBuilder.ok( res, "other", {}, "Member activities total count fetched successful!", { pagination } );
            return;
        } catch ( err ) {
            this.sendError( res, req, err );
            return;
        }
    }

    // ===========================================================================
    // CREATE / UPDATE / DELETE
    // ===========================================================================
    public async create( req: Request, res: Response ): Promise<void> {
        try {
            const authRaw = await ApiGuardExport.GetAuthUser( req );
            if ( !authRaw ) {
                ApiResponseBuilder.validationError( res, "Invalid auth data" );
                return;
            }
            const auth = this.normalizeAuthUser( authRaw );

            const ctx = this.buildWsContext( req, auth );

            const input = this.readCreateInput( req, auth );

            const dto = await this.service.create( ctx, input );

            ApiResponseBuilder.ok( res, "memberActivity", dto, "Member activity created successful!" );
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
                ApiResponseBuilder.validationError( res, "Invalid auth data" );
                return;
            }
            const auth = this.normalizeAuthUser( authRaw );

            const activityId = String( req.params.activityId || "" ).trim();
            const ctx = this.buildWsContext( req, auth );

            const input = this.readUpdateInput( req, auth );

            const dto = await this.service.updateById( ctx, activityId, input );

            ApiResponseBuilder.ok( res, "memberActivity", dto, "Member activity updated successful!" );
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
                ApiResponseBuilder.validationError( res, "Invalid auth data" );
                return;
            }
            const auth = this.normalizeAuthUser( authRaw );

            const activityId = String( req.params.activityId || "" ).trim();
            const ctx = this.buildWsContext( req, auth );

            await this.service.deleteById( ctx, activityId );

            ApiResponseBuilder.ok( res, "other", { deleted: true }, "Member activity deleted successful!" );
            return;
        } catch ( err ) {
            this.sendError( res, req, err );
            return;
        }
    }

    // ===========================================================================
    // Evidence operations (with upload finalization)
    // ===========================================================================
    public async appendEvidence( req: Request, res: Response ): Promise<void> {
        try {
            const authRaw = await ApiGuardExport.GetAuthUser( req );
            if ( !authRaw ) {
                ApiResponseBuilder.validationError( res, "Invalid auth data" );
                return;
            }
            const auth = this.normalizeAuthUser( authRaw );

            const activityId = String( req.params.activityId || "" ).trim();
            const ctx = this.buildWsContext( req, auth );

            // 1) Move TEMP -> FINAL, build MemberActivityEvidence[]
            const finalized = await this.finalizeEvidenceUploads( req, activityId );

            if ( !finalized || finalized.evidence.length === 0 ) {
                // Controller-level validation: service expects non-empty for append
                ApiResponseBuilder.validationError( res, "No evidence files uploaded." );
                return;
            }

            const input: MemberActivityAppendEvidenceInput = {
                evidence: finalized.evidence,
                updatedByUserId: auth.userId,
            };

            // 2) DB update (source of truth)
            const dto = await this.service.appendEvidence( ctx, activityId, input );

            ApiResponseBuilder.ok( res, "memberActivity", dto, "Evidence appended successful!", {
                other: { uploads: finalized.uploadPacket },
            } );
            return;
        } catch ( err ) {
            this.sendError( res, req, err );
            return;
        }
    }

    public async removeEvidence( req: Request, res: Response ): Promise<void> {
        try {
            const authRaw = await ApiGuardExport.GetAuthUser( req );
            if ( !authRaw ) {
                ApiResponseBuilder.validationError( res, "Invalid auth data" );
                return;
            }
            const auth = this.normalizeAuthUser( authRaw );

            const activityId = String( req.params.activityId || "" ).trim();
            const ctx = this.buildWsContext( req, auth );

            const relPathRaw = String( req.body?.relPath || "" ).trim();
            const urlRaw = String( req.body?.url || "" ).trim();

            const input: MemberActivityRemoveEvidenceInput = {
                ...( relPathRaw ? { relPath: relPathRaw } : {} ),
                ...( urlRaw ? { url: urlRaw } : {} ),
                updatedByUserId: auth.userId,
            };

            const dto = await this.service.removeEvidence( ctx, activityId, input );

            ApiResponseBuilder.ok( res, "memberActivity", dto, "Evidence removed successful!" );
            return;
        } catch ( err ) {
            this.sendError( res, req, err );
            return;
        }
    }

    public async replaceEvidence( req: Request, res: Response ): Promise<void> {
        try {
            const authRaw = await ApiGuardExport.GetAuthUser( req );
            if ( !authRaw ) {
                ApiResponseBuilder.validationError( res, "Invalid auth data" );
                return;
            }
            const auth = this.normalizeAuthUser( authRaw );

            const activityId = String( req.params.activityId || "" ).trim();
            const ctx = this.buildWsContext( req, auth );

            // 1) Move TEMP -> FINAL, build MemberActivityEvidence[]
            const finalized = await this.finalizeEvidenceUploads( req, activityId );

            // For replace, empty evidence is allowed (means "set []") if you want.
            // Your service does not validate non-empty for replace, so we can pass [] safely.
            const input: MemberActivityReplaceEvidenceInput = {
                evidence: finalized ? finalized.evidence : [],
                updatedByUserId: auth.userId,
            };

            const dto = await this.service.replaceEvidence( ctx, activityId, input );

            ApiResponseBuilder.ok( res, "memberActivity", dto, "Evidence replaced successful!", {
                ...( finalized ? { other: { uploads: finalized.uploadPacket } } : {} ),
            } );
            return;
        } catch ( err ) {
            this.sendError( res, req, err );
            return;
        }
    }

    // ===========================================================================
    // Blocker operations
    // ===========================================================================
    public async appendBlocker( req: Request, res: Response ): Promise<void> {
        try {
            const authRaw = await ApiGuardExport.GetAuthUser( req );
            if ( !authRaw ) {
                ApiResponseBuilder.validationError( res, "Invalid auth data" );
                return;
            }
            const auth = this.normalizeAuthUser( authRaw );

            const activityId = String( req.params.activityId || "" ).trim();
            const ctx = this.buildWsContext( req, auth );

            const blocker = this.readBlocker( req.body?.blocker );

            const input: MemberActivityAppendBlockerInput = {
                blocker,
                updatedByUserId: auth.userId,
            };

            const dto = await this.service.appendBlocker( ctx, activityId, input );

            ApiResponseBuilder.ok( res, "memberActivity", dto, "Blocker appended successful!" );
            return;
        } catch ( err ) {
            this.sendError( res, req, err );
            return;
        }
    }

    public async updateBlocker( req: Request, res: Response ): Promise<void> {
        try {
            const authRaw = await ApiGuardExport.GetAuthUser( req );
            if ( !authRaw ) {
                ApiResponseBuilder.validationError( res, "Invalid auth data" );
                return;
            }
            const auth = this.normalizeAuthUser( authRaw );

            const activityId = String( req.params.activityId || "" ).trim();
            const ctx = this.buildWsContext( req, auth );

            const title = String( req.body?.title || "" ).trim();
            const reportedAtIso = String( req.body?.reportedAtIso || "" ).trim();

            if ( !title ) throw new MemberActivitiesServiceError( "VALIDATION_ERROR", "title is required." );
            if ( !reportedAtIso ) throw new MemberActivitiesServiceError( "VALIDATION_ERROR", "reportedAtIso is required." );

            const patch = this.readBlockerPatch( req.body?.patch );

            const input: MemberActivityUpdateBlockerInput = {
                title,
                reportedAtIso,
                patch,
                updatedByUserId: auth.userId,
            };

            const dto = await this.service.updateBlocker( ctx, activityId, input );

            ApiResponseBuilder.ok( res, "memberActivity", dto, "Blocker updated successful!" );
            return;
        } catch ( err ) {
            this.sendError( res, req, err );
            return;
        }
    }

    public async resolveBlocker( req: Request, res: Response ): Promise<void> {
        try {
            const authRaw = await ApiGuardExport.GetAuthUser( req );
            if ( !authRaw ) {
                ApiResponseBuilder.validationError( res, "Invalid auth data" );
                return;
            }
            const auth = this.normalizeAuthUser( authRaw );

            const activityId = String( req.params.activityId || "" ).trim();
            const ctx = this.buildWsContext( req, auth );

            const title = String( req.body?.title || "" ).trim();
            const reportedAtIso = String( req.body?.reportedAtIso || "" ).trim();
            const resolvedAtIsoRaw = String( req.body?.resolvedAtIso || "" ).trim();

            if ( !title ) throw new MemberActivitiesServiceError( "VALIDATION_ERROR", "title is required." );
            if ( !reportedAtIso ) throw new MemberActivitiesServiceError( "VALIDATION_ERROR", "reportedAtIso is required." );

            const input: MemberActivityResolveBlockerInput = {
                title,
                reportedAtIso,
                ...( resolvedAtIsoRaw ? { resolvedAtIso: resolvedAtIsoRaw } : {} ),
                updatedByUserId: auth.userId,
            };

            const dto = await this.service.resolveBlocker( ctx, activityId, input );

            ApiResponseBuilder.ok( res, "memberActivity", dto, "Blocker resolved successful!" );
            return;
        } catch ( err ) {
            this.sendError( res, req, err );
            return;
        }
    }

    public async removeBlocker( req: Request, res: Response ): Promise<void> {
        try {
            const authRaw = await ApiGuardExport.GetAuthUser( req );
            if ( !authRaw ) {
                ApiResponseBuilder.validationError( res, "Invalid auth data" );
                return;
            }
            const auth = this.normalizeAuthUser( authRaw );

            const activityId = String( req.params.activityId || "" ).trim();
            const ctx = this.buildWsContext( req, auth );

            const title = String( req.body?.title || "" ).trim();
            const reportedAtIso = String( req.body?.reportedAtIso || "" ).trim();

            if ( !title ) throw new MemberActivitiesServiceError( "VALIDATION_ERROR", "title is required." );
            if ( !reportedAtIso ) throw new MemberActivitiesServiceError( "VALIDATION_ERROR", "reportedAtIso is required." );

            const input: MemberActivityRemoveBlockerInput = {
                title,
                reportedAtIso,
                updatedByUserId: auth.userId,
            };

            const dto = await this.service.removeBlocker( ctx, activityId, input );

            ApiResponseBuilder.ok( res, "memberActivity", dto, "Blocker removed successful!" );
            return;
        } catch ( err ) {
            this.sendError( res, req, err );
            return;
        }
    }

    // ===========================================================================
    // FINALIZE UPLOADS (TEMP -> FINAL) and map to MemberActivityEvidence[]
    // ===========================================================================
    private async finalizeEvidenceUploads(
        req: Request,
        activityId: string
    ): Promise<{ evidence: MemberActivityEvidence[]; uploadPacket: UploadResultPacket; } | null> {
        const bag = this.getUploadBag( req );
        if ( !bag ) return null;

        const packet = bag.packet;
        if ( !packet || !packet.byField ) return null;

        const originals = this.safeGetByField( packet, "evidence" );
        if ( originals.length === 0 ) return null;

        // We need teamId for FINAL path.
        // In your service, teamId is always present in the activity doc, so we load it from DB.
        // NOTE: controller is REST layer; read-only fetch is safe.
        const dto = await this.service.getById( activityId );
        const teamId = this.readObjectIdString( dto.teamId );

        const finalSubPath = `teamManagement/memberActivities/${ teamId }/${ activityId }`;
        const destinationDir = `uploads/${ finalSubPath }/evidence`;

        const sources = originals
            .map( ( p ) => this.readRelativePath( p ) )
            .filter( ( x ) => x.length > 0 );

        if ( sources.length === 0 ) return null;

        let movedRelativePaths: string[] = [];

        try {
            const moveRes = await FileUploader.movePublicFiles( {
                sources,
                destinationDir,
                overwrite: true,
            } );
            movedRelativePaths = Array.isArray( moveRes.moved ) ? moveRes.moved : [];
        } catch ( e ) {
            // Best-effort only. Do not block REST success.
            console.warn(
                `[Warning:] [MemberActivitiesController] movePublicFiles failed for evidence: ${ ( e as Error ).message }\n`
            );
            return null;
        }

        const rebuiltPackets = this.rebuildPacketsAfterMove( req, originals, movedRelativePaths );

        // Map FileMetaPacket -> MemberActivityEvidence (shape: relPath/url + meta)
        // Your service expects MemberActivityEvidence[] "already mapped by controller"
        const evidence = rebuiltPackets.map( ( p ) => this.toEvidenceDto( p ) );

        // Return FINAL-shaped UploadResultPacket (same contract, new baseRelativeDir)
        const origin = this.buildOrigin( req );
        const baseRelativeDir = `uploads/${ finalSubPath }`;
        const basePublicUrl = `${ origin }/${ baseRelativeDir }`;

        const outPacket: UploadResultPacket = {
            baseRelativeDir,
            basePublicUrl,
            totalFiles: rebuiltPackets.length,
            totalBytes: this.sumBytes( { evidence: rebuiltPackets } ),
            byField: {
                evidence: rebuiltPackets,
            },
        };

        return { evidence, uploadPacket: outPacket };
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
    private readListFilters( req: Request ): MemberActivityListFilters {
        const teamId = String( req.query.teamId || "" ).trim();
        if ( !teamId ) throw new MemberActivitiesServiceError( "VALIDATION_ERROR", "teamId is required." );

        const workItemIdRaw = String( req.query.workItemId || "" ).trim();
        const userIdRaw = String( req.query.userId || "" ).trim();

        const typeRaw = String( req.query.type || "" ).trim();
        const statusRaw = String( req.query.status || "" ).trim();

        const startFromRaw = String( req.query.startFrom || "" ).trim();
        const startToRaw = String( req.query.startTo || "" ).trim();
        const qRaw = String( req.query.q || "" ).trim();

        const filters: MemberActivityListFilters = {
            teamId,
            ...( workItemIdRaw ? { workItemId: workItemIdRaw } : {} ),
            ...( userIdRaw ? { userId: userIdRaw } : {} ),
            ...( typeRaw ? { type: typeRaw as MemberActivityType } : {} ),
            ...( statusRaw ? { status: statusRaw as MemberActivityStatus } : {} ),
            ...( startFromRaw ? { startFrom: startFromRaw } : {} ),
            ...( startToRaw ? { startTo: startToRaw } : {} ),
            ...( qRaw ? { q: qRaw } : {} ),
        };

        return filters;
    }

    private readPaging( req: Request ): MemberActivityListPaging {
        const page = Number( req.query.page ?? 1 );
        const limit = Number( req.query.limit ?? 20 );

        return {
            page: Number.isFinite( page ) ? Math.floor( page ) : 1,
            limit: Number.isFinite( limit ) ? Math.floor( limit ) : 20,
        };
    }

    private readCreateInput( req: Request, auth: AuthUserNormalized ): MemberActivityCreateInput {
        const workItemId = String( req.body?.workItemId || "" ).trim();
        const teamId = String( req.body?.teamId || "" ).trim();
        const userId = String( req.body?.userId || "" ).trim();

        const typeRaw = String( req.body?.type || "" ).trim();
        const title = String( req.body?.title || "" ).trim();
        const notesRaw = String( req.body?.notes || "" ).trim();

        const startAt = String( req.body?.startAt || "" ).trim();
        const endAt = String( req.body?.endAt || "" ).trim();
        const allDay = Boolean( req.body?.allDay );
        const timezoneRaw = String( req.body?.timezone || "" ).trim();

        const statusRaw = String( req.body?.status || "" ).trim();

        const progressBeforeRaw = req.body?.progressBefore;
        const progressAfterRaw = req.body?.progressAfter;

        const milestoneIdRaw = String( req.body?.milestoneId || "" ).trim();

        const requestIdRaw = String( req.body?.requestId || "" ).trim();
        const sourceRaw = String( req.body?.source || "" ).trim();

        if ( !workItemId ) throw new MemberActivitiesServiceError( "VALIDATION_ERROR", "workItemId is required." );
        if ( !teamId ) throw new MemberActivitiesServiceError( "VALIDATION_ERROR", "teamId is required." );
        if ( !userId ) throw new MemberActivitiesServiceError( "VALIDATION_ERROR", "userId is required." );

        if ( !typeRaw ) throw new MemberActivitiesServiceError( "VALIDATION_ERROR", "type is required." );
        if ( !title ) throw new MemberActivitiesServiceError( "VALIDATION_ERROR", "title is required." );
        if ( !startAt ) throw new MemberActivitiesServiceError( "VALIDATION_ERROR", "startAt is required." );
        if ( !endAt ) throw new MemberActivitiesServiceError( "VALIDATION_ERROR", "endAt is required." );
        if ( !statusRaw ) throw new MemberActivitiesServiceError( "VALIDATION_ERROR", "status is required." );

        // source is union: "rest" | "ws" | "system"
        const source =
            sourceRaw === "rest" || sourceRaw === "ws" || sourceRaw === "system" ? ( sourceRaw as "rest" | "ws" | "system" ) : null;

        const input: MemberActivityCreateInput = {
            workItemId,
            teamId,
            userId,

            createdByUserId: auth.userId,

            ...( requestIdRaw ? { requestId: requestIdRaw } : {} ),
            ...( source ? { source } : {} ),

            type: typeRaw as MemberActivityType,

            title,
            ...( notesRaw ? { notes: notesRaw } : {} ),

            startAt,
            endAt,
            allDay,
            ...( timezoneRaw ? { timezone: timezoneRaw } : {} ),

            status: statusRaw as MemberActivityStatus,

            ...( typeof progressBeforeRaw === "number" ? { progressBefore: progressBeforeRaw } : {} ),
            ...( typeof progressAfterRaw === "number" ? { progressAfter: progressAfterRaw } : {} ),

            ...( milestoneIdRaw ? { milestoneId: milestoneIdRaw } : {} ),
        };

        return input;
    }

    private readUpdateInput( req: Request, auth: AuthUserNormalized ): MemberActivityUpdateInput {
        const typeRaw = String( req.body?.type || "" ).trim();
        const titleRaw = req.body?.title;
        const notesRaw = req.body?.notes;

        const startAtRaw = String( req.body?.startAt || "" ).trim();
        const endAtRaw = String( req.body?.endAt || "" ).trim();

        const allDayRaw = req.body?.allDay;
        const timezoneRaw = req.body?.timezone;

        const statusRaw = String( req.body?.status || "" ).trim();

        const progressBeforeRaw = req.body?.progressBefore;
        const progressAfterRaw = req.body?.progressAfter;

        const milestoneIdRaw = req.body?.milestoneId;

        // exactOptionalPropertyTypes safe: only include when provided
        const input: MemberActivityUpdateInput = {
            ...( typeRaw ? { type: typeRaw as MemberActivityType } : {} ),

            ...( typeof titleRaw === "string" ? { title: titleRaw } : {} ),
            ...( typeof notesRaw === "string" ? { notes: notesRaw } : {} ),

            ...( startAtRaw ? { startAt: startAtRaw } : {} ),
            ...( endAtRaw ? { endAt: endAtRaw } : {} ),

            ...( typeof allDayRaw === "boolean" ? { allDay: allDayRaw } : {} ),
            ...( typeof timezoneRaw === "string" ? { timezone: timezoneRaw } : {} ),

            ...( statusRaw ? { status: statusRaw as MemberActivityStatus } : {} ),

            ...( typeof progressBeforeRaw === "number" ? { progressBefore: progressBeforeRaw } : {} ),
            ...( typeof progressAfterRaw === "number" ? { progressAfter: progressAfterRaw } : {} ),

            ...( typeof milestoneIdRaw === "string" ? { milestoneId: milestoneIdRaw } : {} ),

            updatedByUserId: auth.userId,
        };

        return input;
    }

    // ===========================================================================
    // Blocker readers (defensive, no any)
    // ===========================================================================
    private readBlocker( raw: unknown ): MemberActivityBlocker {
        if ( !raw || typeof raw !== "object" ) {
            throw new MemberActivitiesServiceError( "VALIDATION_ERROR", "blocker is required." );
        }

        const b = raw as {
            title?: unknown;
            details?: unknown;
            severity?: unknown;
            reportedAt?: unknown;  // ISO string or Date
            resolvedAt?: unknown;  // ISO string or Date
        };

        const title = typeof b.title === "string" ? b.title.trim() : "";
        if ( !title ) {
            throw new MemberActivitiesServiceError( "VALIDATION_ERROR", "blocker.title is required." );
        }

        // reportedAt (required)
        const reportedAt = this.toDateRequired( b.reportedAt, "blocker.reportedAt" );

        // severity (required in your type) -> default "low" if missing/invalid
        const severity = this.readSeverity( b.severity );

        // Build required fields first
        const out: MemberActivityBlocker = {
            title,
            severity,
            reportedAt,
        };

        // Optional details
        if ( typeof b.details === "string" ) {
            const d = b.details.trim();
            if ( d ) out.details = d;
        }

        // Optional resolvedAt
        if ( b.resolvedAt !== undefined && b.resolvedAt !== null && b.resolvedAt !== "" ) {
            out.resolvedAt = this.toDateRequired( b.resolvedAt, "blocker.resolvedAt" );
        }

        return out;
    }

    private readSeverity( raw: unknown ): MemberActivityBlocker[ "severity" ] {
        if ( typeof raw !== "string" ) return "low";

        const v = raw.toLowerCase().trim();
        if ( v === "low" || v === "medium" || v === "high" ) return v;

        return "low";
    }


    private toDateRequired( v: unknown, field: string ): Date {
        // Accept Date
        if ( v instanceof Date ) {
            if ( Number.isNaN( v.getTime() ) ) {
                throw new MemberActivitiesServiceError( "INVALID_DATE", `${ field } is invalid Date.` );
            }
            return v;
        }

        // Accept ISO string
        if ( typeof v === "string" ) {
            const s = v.trim();
            if ( !s ) {
                throw new MemberActivitiesServiceError( "VALIDATION_ERROR", `${ field } is required.` );
            }

            const d = new Date( s );
            if ( Number.isNaN( d.getTime() ) ) {
                throw new MemberActivitiesServiceError( "INVALID_DATE", `${ field } is not a valid date string.` );
            }
            return d;
        }

        throw new MemberActivitiesServiceError( "VALIDATION_ERROR", `${ field } must be a Date or ISO string.` );
    }


    private readBlockerPatch( raw: unknown ): MemberActivityUpdateBlockerInput[ "patch" ] {
        if ( !raw || typeof raw !== "object" ) {
            throw new MemberActivitiesServiceError( "VALIDATION_ERROR", "patch is required." );
        }

        const p = raw as {
            title?: unknown;
            details?: unknown;
            severity?: unknown;
            resolvedAtIso?: unknown;
        };

        const next: MemberActivityUpdateBlockerInput[ "patch" ] = {};

        if ( typeof p.title === "string" && p.title.trim() ) next.title = p.title.trim();
        if ( typeof p.details === "string" ) next.details = p.details;
        if ( p.severity === "low" || p.severity === "medium" || p.severity === "high" ) next.severity = p.severity;
        if ( typeof p.resolvedAtIso === "string" && p.resolvedAtIso.trim() ) next.resolvedAtIso = p.resolvedAtIso.trim();

        // Service will throw if empty patch; keep controller thin
        return next;
    }

    // ===========================================================================
    // WS Context
    // ===========================================================================
    private buildWsContext( req: Request, auth: AuthUser ): MemberActivityWsContext {
        const requestId = this.getRequestId( req ) || this.makeToken();

        const actor: AuthUser = {
            userId: auth.userId,
            username: auth.username,
            role: auth.role,
            ...( Array.isArray( auth.teamCodes ) && auth.teamCodes.length > 0 ? { teamCodes: auth.teamCodes } : {} ),
            ...( typeof auth.branchId === "string" && auth.branchId.length > 0 ? { branchId: auth.branchId } : {} ),
        };

        // NOTE:
        // MemberActivityWsContext in your WS service likely supports:
        //  { actor, requestId, teamCode?, workItemId?, activityId?, memberUserIds? }
        // Controller only reliably knows requestId + actor; teamCode may be in header/body/route elsewhere.
        // If you want WS routing to rooms, pass teamCode explicitly from client (req.body.teamCode) OR
        // map teamId -> teamCode (if you have Team model lookup). For now, we accept optional.
        const teamCodeRaw = String( req.body?.teamCode || req.query?.teamCode || "" ).trim();
        const workItemIdRaw = String( req.body?.workItemId || req.query?.workItemId || "" ).trim();

        const ctx: MemberActivityWsContext = {
            actor,
            requestId,
            ...( teamCodeRaw ? { teamCode: teamCodeRaw } : {} ),
            ...( workItemIdRaw ? { workItemId: workItemIdRaw } : {} ),
        };

        return ctx;
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
        if ( err instanceof MemberActivitiesServiceError ) {
            const status =
                err.code === "ACTIVITY_NOT_FOUND" ? 404 :
                    err.code === "INVALID_OBJECT_ID" ? 400 :
                        err.code === "INVALID_DATE" ? 400 :
                            err.code === "INVALID_TIME_RANGE" ? 400 :
                                err.code === "BLOCKER_NOT_FOUND" ? 404 :
                                    err.code === "VALIDATION_ERROR" ? 400 :
                                        400;

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
        ( req as unknown as { __memberActivityUploadBag?: UploadContextBag; } ).__memberActivityUploadBag = bag;
    }

    private getUploadBag( req: Request ): UploadContextBag | null {
        const raw = ( req as unknown as { __memberActivityUploadBag?: unknown; } ).__memberActivityUploadBag;
        if ( !raw || typeof raw !== "object" ) return null;

        const maybe = raw as { token?: unknown; packet?: unknown; };
        if ( typeof maybe.token !== "string" ) return null;
        if ( !maybe.packet || typeof maybe.packet !== "object" ) return null;

        return raw as UploadContextBag;
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
    // Evidence DTO mapper (FileMetaPacket -> MemberActivityEvidence)
    // ===========================================================================
    private toEvidenceDto( p: FileMetaPacket ): MemberActivityEvidence {
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
            label?: unknown; // if FileUploader ever provides it
        };

        const relPath =
            ( typeof u.relPath === "string" ? u.relPath : "" ) ||
            ( typeof u.relativePath === "string" ? u.relativePath : "" );

        const url =
            ( typeof u.url === "string" ? u.url : "" ) ||
            ( typeof u.publicUrl === "string" ? u.publicUrl : "" );

        if ( !relPath || !url ) {
            throw new MemberActivitiesServiceError(
                "VALIDATION_ERROR",
                "Evidence packet missing relPath/url."
            );
        }


        const mimeType = typeof u.mimeType === "string" && u.mimeType.trim()
            ? u.mimeType.trim()
            : "application/octet-stream";

        const originalName = typeof u.originalName === "string" ? u.originalName.trim() : "";
        const storedName = typeof u.storedName === "string" ? u.storedName.trim() : "";

        const sizeBytes =
            typeof u.sizeBytes === "number"
                ? u.sizeBytes
                : typeof u.size === "number"
                    ? u.size
                    : 0;

        // label is REQUIRED by your type
        // Priority: explicit label -> originalName -> storedName -> fallback
        const label =
            ( typeof u.label === "string" && u.label.trim() ? u.label.trim() : "" ) ||
            originalName ||
            storedName ||
            "Evidence";

        const out: MemberActivityEvidence = {
            label,
            relPath,
            url,
            mimeType,
            originalName,
            sizeBytes,
            uploadedAt: '',
        };

        if ( originalName ) out.originalName = originalName;
        if ( Number.isFinite( sizeBytes ) && sizeBytes > 0 ) out.sizeBytes = Math.floor( sizeBytes );

        const uploadedAt =
            ( typeof u.uploadedAt === "string" && u.uploadedAt.trim() ? u.uploadedAt.trim() : "" ) ||
            ( typeof u.createdAt === "string" && u.createdAt.trim() ? u.createdAt.trim() : "" );

        if ( uploadedAt ) out.uploadedAt = uploadedAt;

        return out;
    }


    // ===========================================================================
    // Auth helpers
    // ===========================================================================
    private toIdString( id: Types.ObjectId | string ): string {
        if ( typeof id === "string" ) {
            const s = id.trim();
            if ( !Types.ObjectId.isValid( s ) ) {
                throw new Error( `[Error:] [MemberActivitiesController] Invalid userId string: ${ s }\n` );
            }
            return s;
        }

        const s = id.toString();
        if ( !Types.ObjectId.isValid( s ) ) {
            throw new Error( `[Error:] [MemberActivitiesController] Invalid userId ObjectId\n` );
        }
        return s;
    }

    private normalizeAuthUser( auth: AuthUser ): AuthUserNormalized {
        return {
            ...auth,
            userId: this.toIdString( auth.userId ),
        };
    }

    private readObjectIdString( v: unknown ): string {
        if ( typeof v === "string" ) {
            const s = v.trim();
            if ( !Types.ObjectId.isValid( s ) ) throw new MemberActivitiesServiceError( "INVALID_OBJECT_ID", `Invalid ObjectId: ${ s }` );
            return s;
        }
        if ( v instanceof Types.ObjectId ) return v.toString();

        if ( v && typeof v === "object" && "toString" in v ) {
            const s = String( ( v as { toString: () => string; } ).toString() );
            if ( !Types.ObjectId.isValid( s ) ) throw new MemberActivitiesServiceError( "INVALID_OBJECT_ID", `Invalid ObjectId: ${ s }` );
            return s;
        }

        throw new MemberActivitiesServiceError( "INVALID_OBJECT_ID", "Invalid ObjectId value." );
    }

    private makeToken(): string {
        return `${ Date.now() }_${ Math.random().toString( 16 ).slice( 2 ) }`.replace( /\./g, "_" );
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
