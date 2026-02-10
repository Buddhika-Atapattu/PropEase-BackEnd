// Path: src/controllers/teamManagement/teamTask.controller.ts
// ============================================================================
// TeamTaskController (100% class-based, 1:1 with TeamTaskService public API)
// ----------------------------------------------------------------------------
// ✅ PURPOSE
// - Exposes REST endpoints for TeamTask domain (CRUD + operations)
// - Handles multipart uploads safely (TEMP -> FINAL) and persists evidence
// - Builds WS context (actor + requestId + usernames) and passes into service
//
// ✅ IMPORTANT PROJECT RULES (your rules)
// - Constructor MUST NOT accept parameters
// - buildService() is implemented INSIDE controller (not in service)
// - Router must mount ctrl.uploadMiddleware BEFORE ctrl.create/ctrl.update
// - ApiResponseBuilder uses ok/error only
//
// ✅ Upload flow
// 1) uploadMiddleware saves to TEMP: teamManagement/teamTasks/__tmp/<token>/<field>/file
// 2) create/update computes FINAL: teamManagement/teamTasks/<teamCode>/<taskId>/<field>/file
// 3) move temp -> final
// 4) remap FileMetaPacket paths/urls to FINAL
// 5) persist TaskEvidence[] via TeamTaskService.appendEvidence(...)
// ============================================================================

import type { Request, Response, NextFunction, RequestHandler } from "express";
import path from "path";

import FileUploader, { type UploadResultPacket } from "../../../utils/file-uploader.helper";
import { ApiResponseBuilder } from "../../../utils/api-combiner.builder";

import { ApiGuardExport } from "../../../guard/api-router.guard";
import type { AuthUser } from "../../../socket/socket-types.type";

import type { FileMetaPacket } from "../../../types/api-message";
import type {
    TaskEvidence,
    GeoLocation,
    Address,
    TaskAuditMeta,
    TaskTiming,
    TaskSlaPolicy,
} from "../../../models/teamManagement/teamManagement.model";

import { TeamTaskService } from "../../../services/teamManagement/teamTasks/team-task.service";
import type {
    CreateTeamTaskInput,
    UpdateTeamTaskInput,
    TeamTaskDto,
    TeamTaskLoadMode,
    TeamTaskFilterInput,
    PaginationInput,
    TeamTaskSortInput,
} from "../../../types/teamManagement/teamTasks/team-tasks.type";

import { TeamTaskSocketService, type TeamTaskWsContext } from "../../../services/teamManagement/teamTasks/team-task.socket.service";
import { SocketConnectionHandler } from "../../../socket/socket-connection.handler";

import {
    TASK_PRIORITIES,
    TASK_STATUSES,
    TEAM_DOMAINS,
    type TaskPriority,
    type TaskStatus,
    type TeamDomain,
} from "../../../models/teamManagement/teamManagement.model";

export class TeamTaskController {
    // ──────────────────────────────────────────────────────────────────────────
    // Upload settings (INSTANCE fields)
    // ──────────────────────────────────────────────────────────────────────────

    private readonly UPLOAD_FIELDS: ReadonlyArray<{ name: string; maxCount?: number; }> = [
        { name: "evidence", maxCount: 30 },
        { name: "attachments", maxCount: 30 },
        { name: "files", maxCount: 30 },
    ];

    private readonly MAX_FILE_MB: number = 25;
    private readonly MAX_FILES_TOTAL: number = 60;

    private readonly ALLOWED_MIME: ReadonlySet<string> = new Set<string>( [
        "image/jpeg",
        "image/png",
        "image/webp",
        "application/pdf",
        "text/plain",
        "application/zip",
    ] );

    /**
     * TEMP root subPath (IMPORTANT)
     * - This is a subPath inside public/uploads.
     * - DO NOT prefix with "uploads/" here.
     */
    private readonly TEMP_ROOT_SUBPATH: string = "teamManagement/teamTasks/__tmp";

    private readonly service: TeamTaskService =  new TeamTaskService();

    // ✅ MUST NOT accept params (your rule)
    public constructor () {
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Service builder (controller-owned composition)
    // ──────────────────────────────────────────────────────────────────────────


    // ──────────────────────────────────────────────────────────────────────────
    // Small helpers (safe parsing)
    // ──────────────────────────────────────────────────────────────────────────

    private safeStr( v: unknown ): string {
        return typeof v === "string" ? v.trim() : "";
    }

    private toNum( v: unknown, fallback: number ): number {
        const n = Number( v );
        return Number.isFinite( n ) ? n : fallback;
    }

    /**
     * Parse array values sent as:
     * - actual array
     * - JSON string: '["a","b"]'
     * - CSV string: "a,b"
     */
    private parseJsonArray( v: unknown ): string[] | null {
        if ( Array.isArray( v ) ) return v.map( ( x ) => this.safeStr( x ) ).filter( Boolean );
        if ( typeof v !== "string" ) return null;

        const raw = v.trim();
        if ( !raw ) return [];

        if ( raw.startsWith( "[" ) && raw.endsWith( "]" ) ) {
            try {
                const parsed = JSON.parse( raw ) as unknown;
                if ( Array.isArray( parsed ) ) return parsed.map( ( x ) => this.safeStr( x ) ).filter( Boolean );
                return [];
            } catch {
                return [];
            }
        }

        return raw
            .split( "," )
            .map( ( x ) => x.trim() )
            .filter( Boolean );
    }

    /**
     * Parse object values sent as:
     * - actual object
     * - JSON string: '{"x":1}'
     */
    private parseJsonObj<T>( v: unknown ): T | null {
        if ( !v ) return null;
        if ( typeof v === "object" ) return v as T;
        if ( typeof v !== "string" ) return null;

        const raw = v.trim();
        if ( !raw ) return null;

        try {
            const parsed = JSON.parse( raw ) as unknown;
            if ( parsed && typeof parsed === "object" ) return parsed as T;
            return null;
        } catch {
            return null;
        }
    }

    private getRequestId( req: Request ): string {
        const v = req.headers[ "x-request-id" ];
        return typeof v === "string" ? v.trim() : "";
    }

    private async getAuthUser( req: Request ): Promise<AuthUser | null> {
        const u = await ApiGuardExport.GetAuthUser( req );
        return u ?? null;
    }

    /**
     * Builds base URL for public URLs (supports reverse proxies).
     */
    private buildOrigin( req: Request ): string {
        const xfProtoRaw = this.safeStr( req.headers[ "x-forwarded-proto" ] );
        const xfHostRaw = this.safeStr( req.headers[ "x-forwarded-host" ] );

        const proto =
            xfProtoRaw
                .split( "," )
                .map( ( x ) => x.trim() )
                .filter( Boolean )[ 0 ] ?? req.protocol;

        const host =
            xfHostRaw
                .split( "," )
                .map( ( x ) => x.trim() )
                .filter( Boolean )[ 0 ] ?? this.safeStr( req.get( "host" ) );

        return host ? `${ proto }://${ host }` : `${ proto }://localhost`;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Temp path store on req (so middleware and handler agree)
    // ──────────────────────────────────────────────────────────────────────────

    private setTempSubPath( req: Request, subPath: string ): void {
        ( req as unknown as { __teamTaskTempSubPath?: string; } ).__teamTaskTempSubPath = subPath;
    }

    private getTempSubPath( req: Request ): string {
        return this.safeStr( ( req as unknown as { __teamTaskTempSubPath?: string; } ).__teamTaskTempSubPath );
    }

    private buildTempSubPath( req: Request ): string {
        const reqId = this.getRequestId( req );
        const stamp = `${ Date.now() }_${ Math.floor( Math.random() * 1e9 ) }`;
        const token = reqId ? `${ reqId }_${ stamp }` : stamp;
        return `${ this.TEMP_ROOT_SUBPATH }/${ token }`;
    }

    private buildFinalSubPath( teamCode: string, taskId: string ): string {
        return `teamManagement/teamTasks/${ teamCode }/${ taskId }`;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Upload packet remap (TEMP -> FINAL)
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Remaps a FileMetaPacket to FINAL location + public URL.
     *
     * IMPORTANT:
     * - relativePath must be "uploads/..." (public folder base)
     * - absDiskPath must target ".../public/uploads/..."
     */
    private remapPacketToFinal(
        req: Request,
        pkt: FileMetaPacket,
        finalSubPath: string,
        fieldName: string,
        origin: string
    ): FileMetaPacket {
        const storedName = this.safeStr( ( pkt as unknown as { storedName?: unknown; } ).storedName );
        const originalName = this.safeStr( ( pkt as unknown as { originalName?: unknown; } ).originalName ) || storedName;

        const extension = this.safeStr( ( pkt as unknown as { extension?: unknown; } ).extension );
        const mimeType = this.safeStr( ( pkt as unknown as { mimeType?: unknown; } ).mimeType );

        const sizeBytesNum = Number( ( pkt as unknown as { sizeBytes?: unknown; } ).sizeBytes );
        const sizeBytes = Number.isFinite( sizeBytesNum ) && sizeBytesNum >= 0 ? Math.floor( sizeBytesNum ) : 0;

        const relativePath = `uploads/${ finalSubPath }/${ fieldName }/${ storedName }`.replace( /\\/g, "/" );
        const publicUrl = `${ origin }/${ relativePath }`;

        // controllers/teamManagement -> controllers -> src -> public/uploads/...
        const absDiskPath = path.resolve( __dirname, "..", "..", "public", relativePath );

        const uploadedAtIso =
            this.safeStr( ( pkt as unknown as { uploadedAtIso?: unknown; } ).uploadedAtIso ) || new Date().toISOString();

        const out: FileMetaPacket = {
            originalName,
            storedName,
            extension,
            mimeType,
            sizeBytes,
            relativePath,
            publicUrl,
            absDiskPath,
            fieldName,
            uploadedAtIso,
        } as unknown as FileMetaPacket;

        // exactOptionalPropertyTypes-safe optional
        const enc = this.safeStr( ( pkt as unknown as { encoding?: unknown; } ).encoding );
        if ( enc ) ( out as unknown as { encoding: string; } ).encoding = enc;

        return out;
    }

    /**
     * Moves temp files to FINAL and returns a new upload packet mapped to FINAL.
     */
    private async moveTempUploadsToFinal(
        req: Request,
        tempUpload: UploadResultPacket,
        finalSubPath: string
    ): Promise<UploadResultPacket> {
        // 1) Move disk files (field by field)
        for ( const [ field, packets ] of Object.entries( tempUpload.byField ?? {} ) ) {
            const safeField = this.safeStr( field );
            if ( !safeField ) continue;

            const sources = ( Array.isArray( packets ) ? packets : [] )
                .map( ( p ) => this.safeStr( ( p as unknown as { relativePath?: unknown; } ).relativePath ) )
                .filter( Boolean );

            if ( sources.length <= 0 ) continue;

            await FileUploader.movePublicFiles( {
                sources,
                destinationDir: `uploads/${ finalSubPath }/${ safeField }`,
                overwrite: true,
            } );
        }

        // 2) Remap metadata
        const origin = this.buildOrigin( req );
        const baseRelativeDir = `uploads/${ finalSubPath }`;
        const basePublicUrl = `${ origin }/${ baseRelativeDir }`;

        const byField: Record<string, FileMetaPacket[]> = {};

        for ( const [ field, packets ] of Object.entries( tempUpload.byField ?? {} ) ) {
            const safeField = this.safeStr( field );
            if ( !safeField ) continue;

            const arr = Array.isArray( packets ) ? packets : [];
            byField[ safeField ] = arr.map( ( pkt ) => this.remapPacketToFinal( req, pkt, finalSubPath, safeField, origin ) );
        }

        // Ensure all known fields exist (frontend expects consistent keys)
        for ( const f of this.UPLOAD_FIELDS ) {
            const key = this.safeStr( f.name );
            if ( key && !Object.prototype.hasOwnProperty.call( byField, key ) ) byField[ key ] = [];
        }

        // 3) Recompute totals
        let totalFiles = 0;
        let totalBytes = 0;

        for ( const files of Object.values( byField ) ) {
            const a = Array.isArray( files ) ? files : [];
            totalFiles += a.length;

            for ( const x of a ) {
                const n = Number( ( x as unknown as { sizeBytes?: unknown; } ).sizeBytes );
                if ( Number.isFinite( n ) && n >= 0 ) totalBytes += Math.floor( n );
            }
        }

        return { baseRelativeDir, basePublicUrl, totalFiles, totalBytes, byField };
    }

    /**
     * Converts uploaded files into TaskEvidence[] entries.
     */
    private mapUploadToEvidence( upload: UploadResultPacket ): TaskEvidence[] {
        const evidenceFiles = Array.isArray( upload.byField[ "evidence" ] ) ? upload.byField[ "evidence" ] : [];
        const attachments = Array.isArray( upload.byField[ "attachments" ] ) ? upload.byField[ "attachments" ] : [];
        const files = Array.isArray( upload.byField[ "files" ] ) ? upload.byField[ "files" ] : [];

        const all = [ ...evidenceFiles, ...attachments, ...files ];
        if ( all.length <= 0 ) return [];

        const nowIso = new Date().toISOString();

        return all.map( ( pkt ) => {
            const out = {
                name: "file",
                uploadedAt: nowIso,
                file: pkt,
            };
            return out as unknown as TaskEvidence;
        } );
    }

    // ──────────────────────────────────────────────────────────────────────────
    // WS context builder
    // ──────────────────────────────────────────────────────────────────────────

    private async buildWsContext( req: Request, dto?: TeamTaskDto ): Promise<TeamTaskWsContext> {
        const systemUser = await this.getAuthUser( req );

        // If guard fails or route is public (shouldn't happen), still emit safe actor
        const actor: AuthUser =
            systemUser ??
            ( {
                role: "user",
                username: "Unknown",
            } as AuthUser );

        return {
            actor,
            requestId: this.getRequestId( req ),
            assignedMemberUsernames: Array.isArray( dto?.assignedMemberUsernames ) ? dto!.assignedMemberUsernames : [],
        };
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Enum guards (prevent invalid strings)
    // ──────────────────────────────────────────────────────────────────────────

    private isTaskStatus( v: unknown ): v is TaskStatus {
        return typeof v === "string" && ( TASK_STATUSES as readonly string[] ).includes( v );
    }

    private isTaskPriority( v: unknown ): v is TaskPriority {
        return typeof v === "string" && ( TASK_PRIORITIES as readonly string[] ).includes( v );
    }

    private isTeamDomain( v: unknown ): v is TeamDomain {
        return typeof v === "string" && ( TEAM_DOMAINS as readonly string[] ).includes( v );
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Upload middleware (INSTANCE) — MUST be mounted before create/update
    // ──────────────────────────────────────────────────────────────────────────

    public readonly uploadMiddleware: RequestHandler = ( req: Request, res: Response, next: NextFunction ): void => {
        const tempSubPath = this.buildTempSubPath( req );
        this.setTempSubPath( req, tempSubPath );

        const upload = FileUploader.createDiskUpload( {
            allowedMimeTypes: this.ALLOWED_MIME,
            maxFileSizeMb: this.MAX_FILE_MB,
            maxFiles: this.MAX_FILES_TOTAL,
            resolveDestination: async (): Promise<string> => tempSubPath,
        } );

        upload.fields( this.UPLOAD_FIELDS as Array<{ name: string; maxCount?: number; }> )( req, res as any, ( err: unknown ) => {
            if ( err ) {
                console.error( "[Error:] [TeamTaskController] uploadMiddleware failed.\n", err, "\n" );
                ApiResponseBuilder.error( res, 400, err instanceof Error ? err.message : "Upload failed" );
                return;
            }
            next();
        } );
    };

    // ──────────────────────────────────────────────────────────────────────────
    // GET ONE
    // ──────────────────────────────────────────────────────────────────────────

    public readonly getByMongoId: RequestHandler = async ( req: Request, res: Response ): Promise<void> => {
        try {
            const taskMongoId = this.safeStr( req.params[ "taskMongoId" ] );
            const mode = ( this.safeStr( req.query[ "mode" ] ) as TeamTaskLoadMode ) || "minimal";

            if ( !taskMongoId ) {
                ApiResponseBuilder.error( res, 400, "taskMongoId is required" );
                return;
            }

            const dto = await this.service.getByMongoId( taskMongoId, mode );
            if ( !dto ) {
                ApiResponseBuilder.error( res, 404, "TeamTask not found" );
                return;
            }

            ApiResponseBuilder.ok( res, "teamTask", dto, "TeamTask loaded" );
            return;
        } catch ( err: unknown ) {
            ApiResponseBuilder.error( res, 500, err instanceof Error ? err.message : "Internal error" );
            return;
        }
    };

    // ──────────────────────────────────────────────────────────────────────────
    // LIST (minimal/advanced)
    // ──────────────────────────────────────────────────────────────────────────

    public readonly list: RequestHandler = async ( req: Request, res: Response ): Promise<void> => {
        try {
            const body = ( req.body as Record<string, unknown> ) ?? {};

            const mode = ( this.safeStr( body[ "mode" ] ) as TeamTaskLoadMode ) || "minimal";
            const filters = body[ "filters" ] as TeamTaskFilterInput ?? {};

            const pageRaw = ( body[ "page" ] ?? {} ) as Record<string, unknown>;
            const page: PaginationInput = {
                limit: this.toNum( pageRaw[ "limit" ], 10 ),
                pageIndex: this.toNum( pageRaw[ "pageIndex" ], 0 ),
            };

            const sortRaw = ( body[ "sort" ] ?? {} ) as Record<string, unknown>;
            const sort: TeamTaskSortInput = {
                sortBy: ( this.safeStr( sortRaw[ "sortBy" ] ) as TeamTaskSortInput[ "sortBy" ] ) || "createdAt",
                sortDir: ( this.safeStr( sortRaw[ "sortDir" ] ) as TeamTaskSortInput[ "sortDir" ] ) || "desc",
            };

            const out = await this.service.list( filters, page, sort, mode );

            ApiResponseBuilder.ok( res, "teamTasks", out.items, "TeamTasks loaded", {
                pagination: { total: out.other.total },
            } );
            return;
        } catch ( err: unknown ) {
            ApiResponseBuilder.error( res, 500, err instanceof Error ? err.message : "Internal error" );
            return;
        }
    };

    // ──────────────────────────────────────────────────────────────────────────
    // COUNT
    // ──────────────────────────────────────────────────────────────────────────

    public readonly count: RequestHandler = async ( req: Request, res: Response ): Promise<void> => {
        try {
            const body = ( req.body as Record<string, unknown> ) ?? {};
            const filters = ( body[ "filters" ] as TeamTaskFilterInput ) ?? {};

            const total = await this.service.count( filters );

            ApiResponseBuilder.ok( res, "other", { total }, "TeamTasks counted", {
                pagination: { total },
            } );
            return;
        } catch ( err: unknown ) {
            ApiResponseBuilder.error( res, 500, err instanceof Error ? err.message : "Internal error" );
            return;
        }
    };

    // ──────────────────────────────────────────────────────────────────────────
    // KEY VALUES
    // ──────────────────────────────────────────────────────────────────────────

    public readonly keyValues: RequestHandler = async ( req: Request, res: Response ): Promise<void> => {
        try {
            const body = ( req.body as Record<string, unknown> ) ?? {};

            const domainRaw = body[ "domain" ];
            const statusRaw = body[ "status" ];

            const filters = {
                ...( this.safeStr( body[ "teamCode" ] ) ? { teamCode: this.safeStr( body[ "teamCode" ] ) } : {} ),
                ...( this.safeStr( body[ "teamMongoId" ] ) ? { teamMongoId: this.safeStr( body[ "teamMongoId" ] ) } : {} ),
                ...( this.isTeamDomain( domainRaw ) ? { domain: domainRaw } : {} ),
                ...( this.isTaskStatus( statusRaw ) ? { status: statusRaw } : {} ),
            };

            const kv = await this.service.getKeyValues( filters );
            ApiResponseBuilder.ok( res, "other", { teamTaskKeyValue: kv }, "Key values loaded" );
            return;
        } catch ( err: unknown ) {
            ApiResponseBuilder.error( res, 500, err instanceof Error ? err.message : "Internal error" );
            return;
        }
    };

    // ──────────────────────────────────────────────────────────────────────────
    // CREATE (multipart) — uploadMiddleware MUST run before this
    // ──────────────────────────────────────────────────────────────────────────

    public readonly create: RequestHandler = async ( req: Request, res: Response ): Promise<void> => {
        try {
            const body = ( req.body as Record<string, unknown> ) ?? {};

            // 1) Parse complex fields
            const assignedMembersParsed = this.parseJsonArray( body[ "assignedMembers" ] );
            const labelsParsed = this.parseJsonArray( body[ "labels" ] );

            const locationParsed = this.parseJsonObj<GeoLocation>( body[ "location" ] );
            const addressParsed = this.parseJsonObj<Address>( body[ "address" ] );
            const timingParsed = this.parseJsonObj<TaskTiming>( body[ "timing" ] );
            const slaParsed = this.parseJsonObj<TaskSlaPolicy>( body[ "sla" ] );
            const auditParsed = this.parseJsonObj<TaskAuditMeta>( body[ "audit" ] );

            // 2) Validate enums early (avoid passing invalid strings to service)
            const domainStr = this.safeStr( body[ "domain" ] );
            if ( domainStr && !this.isTeamDomain( domainStr ) ) {
                ApiResponseBuilder.error( res, 400, "Invalid domain" );
                return;
            }

            const statusStr = this.safeStr( body[ "status" ] );
            if ( statusStr && !this.isTaskStatus( statusStr ) ) {
                ApiResponseBuilder.error( res, 400, "Invalid status" );
                return;
            }

            const priorityStr = this.safeStr( body[ "priority" ] );
            if ( priorityStr && !this.isTaskPriority( priorityStr ) ) {
                ApiResponseBuilder.error( res, 400, "Invalid priority" );
                return;
            }

            // 3) Build input (omit optionals unless present)
            const input: CreateTeamTaskInput = {
                id: this.safeStr( body[ "id" ] ),
                teamCode: this.safeStr( body[ "teamCode" ] ),
                teamMongoId: this.safeStr( body[ "teamMongoId" ] ),
                domain: domainStr as TeamDomain,
                name: this.safeStr( body[ "name" ] ),

                ...( this.safeStr( body[ "description" ] ) ? { description: this.safeStr( body[ "description" ] ) } : {} ),
                ...( locationParsed ? { location: locationParsed } : {} ),
                ...( addressParsed ? { address: addressParsed } : {} ),
                ...( assignedMembersParsed ? { assignedMembers: assignedMembersParsed } : {} ),
                ...( this.safeStr( body[ "assignedTaskCaptain" ] ) ? { assignedTaskCaptain: this.safeStr( body[ "assignedTaskCaptain" ] ) } : {} ),
                ...( statusStr ? { status: statusStr as TaskStatus } : {} ),
                ...( priorityStr ? { priority: priorityStr as TaskPriority } : {} ),
                ...( this.safeStr( body[ "plannedStartAt" ] ) ? { plannedStartAt: this.safeStr( body[ "plannedStartAt" ] ) } : {} ),
                ...( this.safeStr( body[ "plannedEndAt" ] ) ? { plannedEndAt: this.safeStr( body[ "plannedEndAt" ] ) } : {} ),
                ...( timingParsed ? { timing: timingParsed } : {} ),
                ...( slaParsed ? { sla: slaParsed } : {} ),
                ...( this.safeStr( body[ "notes" ] ) ? { notes: this.safeStr( body[ "notes" ] ) } : {} ),
                ...( labelsParsed ? { labels: labelsParsed } : {} ),
                ...( auditParsed ? { audit: auditParsed } : {} ),
            };

            // Required field check
            if ( !input.id || !input.teamCode || !input.teamMongoId || !input.domain || !input.name ) {
                ApiResponseBuilder.error( res, 400, "Missing required fields: id, teamCode, teamMongoId, domain, name" );
                return;
            }

            // 4) Create DB record (service emits WS Created)
            const wsCtx = await this.buildWsContext( req );
            const createdDto = await this.service.create( input, wsCtx );

            // 5) Process temp upload packet and move to final
            const tempSubPath = this.getTempSubPath( req );

            const tempPacket = await FileUploader.handleMultiFieldUpload(
                tempSubPath,
                this.UPLOAD_FIELDS as Array<{ name: string; maxCount?: number; }>,
                req,
                {
                    allowedMimeTypesByField: {
                        evidence: this.ALLOWED_MIME,
                        attachments: this.ALLOWED_MIME,
                        files: this.ALLOWED_MIME,
                    },
                    maxFileSizeMb: this.MAX_FILE_MB,
                    maxFiles: this.MAX_FILES_TOTAL,
                }
            );

            const finalSubPath = this.buildFinalSubPath( createdDto.teamCode, createdDto.id );
            const finalPacket = await this.moveTempUploadsToFinal( req, tempPacket, finalSubPath );

            // 6) Convert upload -> evidence and persist evidence
            // appendEvidence triggers WS Updated (because task changed)
            const evidenceItems = this.mapUploadToEvidence( finalPacket );

            let finalDto: TeamTaskDto = createdDto;

            if ( evidenceItems.length > 0 ) {
                const ctxWithUsers = await this.buildWsContext( req, createdDto );
                const patched = await this.service.appendEvidence( createdDto.mongoId, evidenceItems, ctxWithUsers );
                if ( patched ) finalDto = patched;
            }

            ApiResponseBuilder.ok( res, "teamTask", finalDto, "TeamTask created", {
                other: { task: finalDto, uploads: finalPacket },
            } );
            return;
        } catch ( err: unknown ) {
            ApiResponseBuilder.error( res, 500, err instanceof Error ? err.message : "Internal error" );
            return;
        }
    };

    // ──────────────────────────────────────────────────────────────────────────
    // UPDATE (multipart) — uploadMiddleware MUST run before this
    // ──────────────────────────────────────────────────────────────────────────

    public readonly update: RequestHandler = async ( req: Request, res: Response ): Promise<void> => {
        try {
            const taskMongoId = this.safeStr( req.params[ "taskMongoId" ] );
            if ( !taskMongoId ) {
                ApiResponseBuilder.error( res, 400, "taskMongoId is required" );
                return;
            }

            const body = ( req.body as Record<string, unknown> ) ?? {};

            const assignedMembersParsed = this.parseJsonArray( body[ "assignedMembers" ] );
            const labelsParsed = this.parseJsonArray( body[ "labels" ] );

            const locationParsed = this.parseJsonObj<GeoLocation>( body[ "location" ] );
            const addressParsed = this.parseJsonObj<Address>( body[ "address" ] );
            const timingParsed = this.parseJsonObj<TaskTiming>( body[ "timing" ] );
            const slaParsed = this.parseJsonObj<TaskSlaPolicy>( body[ "sla" ] );
            const auditParsed = this.parseJsonObj<TaskAuditMeta>( body[ "audit" ] );

            // Validate enums early
            const domainStr = this.safeStr( body[ "domain" ] );
            if ( domainStr && !this.isTeamDomain( domainStr ) ) {
                ApiResponseBuilder.error( res, 400, "Invalid domain" );
                return;
            }

            const statusStr = this.safeStr( body[ "status" ] );
            if ( statusStr && !this.isTaskStatus( statusStr ) ) {
                ApiResponseBuilder.error( res, 400, "Invalid status" );
                return;
            }

            const priorityStr = this.safeStr( body[ "priority" ] );
            if ( priorityStr && !this.isTaskPriority( priorityStr ) ) {
                ApiResponseBuilder.error( res, 400, "Invalid priority" );
                return;
            }

            // Build UpdateTeamTaskInput (supports explicit clear using "null")
            const input: UpdateTeamTaskInput = {
                ...( typeof body[ "name" ] === "string" ? { name: this.safeStr( body[ "name" ] ) } : {} ),
                ...( typeof body[ "description" ] === "string" ? { description: this.safeStr( body[ "description" ] ) } : {} ),

                ...( typeof body[ "location" ] === "string" && this.safeStr( body[ "location" ] ) === "null"
                    ? { location: null }
                    : locationParsed
                        ? { location: locationParsed }
                        : {} ),

                ...( typeof body[ "address" ] === "string" && this.safeStr( body[ "address" ] ) === "null"
                    ? { address: null }
                    : addressParsed
                        ? { address: addressParsed }
                        : {} ),

                ...( assignedMembersParsed ? { assignedMembers: assignedMembersParsed } : {} ),

                ...( typeof body[ "assignedTaskCaptain" ] === "string" && this.safeStr( body[ "assignedTaskCaptain" ] ) === "null"
                    ? { assignedTaskCaptain: null }
                    : this.safeStr( body[ "assignedTaskCaptain" ] )
                        ? { assignedTaskCaptain: this.safeStr( body[ "assignedTaskCaptain" ] ) }
                        : {} ),

                ...( statusStr ? { status: statusStr as TaskStatus } : {} ),
                ...( priorityStr ? { priority: priorityStr as TaskPriority } : {} ),
                ...( domainStr ? { domain: domainStr as TeamDomain } : {} ),

                ...( typeof body[ "plannedStartAt" ] === "string" && this.safeStr( body[ "plannedStartAt" ] ) === "null"
                    ? { plannedStartAt: null }
                    : this.safeStr( body[ "plannedStartAt" ] )
                        ? { plannedStartAt: this.safeStr( body[ "plannedStartAt" ] ) }
                        : {} ),

                ...( typeof body[ "plannedEndAt" ] === "string" && this.safeStr( body[ "plannedEndAt" ] ) === "null"
                    ? { plannedEndAt: null }
                    : this.safeStr( body[ "plannedEndAt" ] )
                        ? { plannedEndAt: this.safeStr( body[ "plannedEndAt" ] ) }
                        : {} ),

                ...( typeof body[ "timing" ] === "string" && this.safeStr( body[ "timing" ] ) === "null"
                    ? { timing: null }
                    : timingParsed
                        ? { timing: timingParsed }
                        : {} ),

                ...( typeof body[ "sla" ] === "string" && this.safeStr( body[ "sla" ] ) === "null"
                    ? { sla: null }
                    : slaParsed
                        ? { sla: slaParsed }
                        : {} ),

                ...( typeof body[ "notes" ] === "string" && this.safeStr( body[ "notes" ] ) === "null"
                    ? { notes: null }
                    : typeof body[ "notes" ] === "string"
                        ? { notes: this.safeStr( body[ "notes" ] ) }
                        : {} ),

                ...( labelsParsed ? { labels: labelsParsed } : {} ),

                ...( typeof body[ "audit" ] === "string" && this.safeStr( body[ "audit" ] ) === "null"
                    ? { audit: null }
                    : auditParsed
                        ? { audit: auditParsed }
                        : {} ),
            };

            // Update DB record (service emits WS Updated)
            const wsCtx = await this.buildWsContext( req );
            const updatedDto = await this.service.update( taskMongoId, input, wsCtx );

            if ( !updatedDto ) {
                ApiResponseBuilder.error( res, 404, "TeamTask not found" );
                return;
            }

            // Upload processing (TEMP -> FINAL)
            const tempSubPath = this.getTempSubPath( req );

            const tempPacket = await FileUploader.handleMultiFieldUpload(
                tempSubPath,
                this.UPLOAD_FIELDS as Array<{ name: string; maxCount?: number; }>,
                req,
                {
                    allowedMimeTypesByField: {
                        evidence: this.ALLOWED_MIME,
                        attachments: this.ALLOWED_MIME,
                        files: this.ALLOWED_MIME,
                    },
                    maxFileSizeMb: this.MAX_FILE_MB,
                    maxFiles: this.MAX_FILES_TOTAL,
                }
            );

            const finalSubPath = this.buildFinalSubPath( updatedDto.teamCode, updatedDto.id );
            const finalPacket = await this.moveTempUploadsToFinal( req, tempPacket, finalSubPath );

            const evidenceItems = this.mapUploadToEvidence( finalPacket );

            let finalDto: TeamTaskDto = updatedDto;

            if ( evidenceItems.length > 0 ) {
                const ctxWithUsers = await this.buildWsContext( req, updatedDto );
                const patched = await this.service.appendEvidence( updatedDto.mongoId, evidenceItems, ctxWithUsers );
                if ( patched ) finalDto = patched;
            }

            ApiResponseBuilder.ok( res, "teamTask", finalDto, "TeamTask updated", {
                other: { task: finalDto, uploads: finalPacket },
            } );
            return;
        } catch ( err: unknown ) {
            ApiResponseBuilder.error( res, 500, err instanceof Error ? err.message : "Internal error" );
            return;
        }
    };

    // ──────────────────────────────────────────────────────────────────────────
    // DELETE
    // ──────────────────────────────────────────────────────────────────────────

    public readonly remove: RequestHandler = async ( req: Request, res: Response ): Promise<void> => {
        try {
            const taskMongoId = this.safeStr( req.params[ "taskMongoId" ] );
            if ( !taskMongoId ) {
                ApiResponseBuilder.error( res, 400, "taskMongoId is required" );
                return;
            }

            const wsCtx = await this.buildWsContext( req );

            const ok = await this.service.delete( taskMongoId, wsCtx );
            if ( !ok ) {
                ApiResponseBuilder.error( res, 404, "TeamTask not found" );
                return;
            }

            ApiResponseBuilder.ok( res, "other", { deleted: true }, "TeamTask deleted" );
            return;
        } catch ( err: unknown ) {
            ApiResponseBuilder.error( res, 500, err instanceof Error ? err.message : "Internal error" );
            return;
        }
    };

    // ──────────────────────────────────────────────────────────────────────────
    // Evidence
    // ──────────────────────────────────────────────────────────────────────────

    public readonly removeEvidenceById: RequestHandler = async ( req: Request, res: Response ): Promise<void> => {
        try {
            const taskMongoId = this.safeStr( req.params[ "taskMongoId" ] );
            const evidenceMongoId = this.safeStr( req.params[ "evidenceMongoId" ] );

            if ( !taskMongoId || !evidenceMongoId ) {
                ApiResponseBuilder.error( res, 400, "taskMongoId and evidenceMongoId are required" );
                return;
            }

            const wsCtx = await this.buildWsContext( req );

            const dto = await this.service.removeEvidenceByStorageKey( taskMongoId, evidenceMongoId, wsCtx );
            if ( !dto ) {
                ApiResponseBuilder.error( res, 404, "TeamTask not found (or evidence not found)" );
                return;
            }

            ApiResponseBuilder.ok( res, "teamTask", dto, "Evidence removed" );
            return;
        } catch ( err: unknown ) {
            ApiResponseBuilder.error( res, 500, err instanceof Error ? err.message : "Internal error" );
            return;
        }
    };

    // ──────────────────────────────────────────────────────────────────────────
    // Status / Priority
    // ──────────────────────────────────────────────────────────────────────────

    public readonly setStatus: RequestHandler = async ( req: Request, res: Response ): Promise<void> => {
        try {
            const taskMongoId = this.safeStr( req.params[ "taskMongoId" ] );
            const statusRaw = ( req.body as Record<string, unknown> )?.[ "status" ];

            if ( !taskMongoId ) {
                ApiResponseBuilder.error( res, 400, "taskMongoId is required" );
                return;
            }
            if ( !this.isTaskStatus( statusRaw ) ) {
                ApiResponseBuilder.error( res, 400, "Invalid status" );
                return;
            }

            const wsCtx = await this.buildWsContext( req );

            const dto = await this.service.setStatus( taskMongoId, statusRaw, wsCtx );
            if ( !dto ) {
                ApiResponseBuilder.error( res, 404, "TeamTask not found" );
                return;
            }

            ApiResponseBuilder.ok( res, "teamTask", dto, "Status updated" );
            return;
        } catch ( err: unknown ) {
            ApiResponseBuilder.error( res, 500, err instanceof Error ? err.message : "Internal error" );
            return;
        }
    };

    public readonly setPriority: RequestHandler = async ( req: Request, res: Response ): Promise<void> => {
        try {
            const taskMongoId = this.safeStr( req.params[ "taskMongoId" ] );
            const priorityRaw = ( req.body as Record<string, unknown> )?.[ "priority" ];

            if ( !taskMongoId ) {
                ApiResponseBuilder.error( res, 400, "taskMongoId is required" );
                return;
            }
            if ( !this.isTaskPriority( priorityRaw ) ) {
                ApiResponseBuilder.error( res, 400, "Invalid priority" );
                return;
            }

            const wsCtx = await this.buildWsContext( req );

            const dto = await this.service.setPriority( taskMongoId, priorityRaw, wsCtx );
            if ( !dto ) {
                ApiResponseBuilder.error( res, 404, "TeamTask not found" );
                return;
            }

            ApiResponseBuilder.ok( res, "teamTask", dto, "Priority updated" );
            return;
        } catch ( err: unknown ) {
            ApiResponseBuilder.error( res, 500, err instanceof Error ? err.message : "Internal error" );
            return;
        }
    };

    // ──────────────────────────────────────────────────────────────────────────
    // Labels (set/add/remove)
    // ──────────────────────────────────────────────────────────────────────────

    public readonly setLabels: RequestHandler = async ( req: Request, res: Response ): Promise<void> => {
        try {
            const taskMongoId = this.safeStr( req.params[ "taskMongoId" ] );
            const labels = this.parseJsonArray( ( req.body as Record<string, unknown> )?.[ "labels" ] ) ?? [];

            if ( !taskMongoId ) {
                ApiResponseBuilder.error( res, 400, "taskMongoId is required" );
                return;
            }

            const wsCtx = await this.buildWsContext( req );

            const dto = await this.service.setLabels( taskMongoId, labels, wsCtx );
            if ( !dto ) {
                ApiResponseBuilder.error( res, 404, "TeamTask not found" );
                return;
            }

            ApiResponseBuilder.ok( res, "teamTask", dto, "Labels set" );
            return;
        } catch ( err: unknown ) {
            ApiResponseBuilder.error( res, 500, err instanceof Error ? err.message : "Internal error" );
            return;
        }
    };

    public readonly addLabels: RequestHandler = async ( req: Request, res: Response ): Promise<void> => {
        try {
            const taskMongoId = this.safeStr( req.params[ "taskMongoId" ] );
            const labels = this.parseJsonArray( ( req.body as Record<string, unknown> )?.[ "labels" ] ) ?? [];

            if ( !taskMongoId ) {
                ApiResponseBuilder.error( res, 400, "taskMongoId is required" );
                return;
            }

            const wsCtx = await this.buildWsContext( req );

            const dto = await this.service.addLabels( taskMongoId, labels, wsCtx );
            if ( !dto ) {
                ApiResponseBuilder.error( res, 404, "TeamTask not found" );
                return;
            }

            ApiResponseBuilder.ok( res, "teamTask", dto, "Labels added" );
            return;
        } catch ( err: unknown ) {
            ApiResponseBuilder.error( res, 500, err instanceof Error ? err.message : "Internal error" );
            return;
        }
    };

    public readonly removeLabels: RequestHandler = async ( req: Request, res: Response ): Promise<void> => {
        try {
            const taskMongoId = this.safeStr( req.params[ "taskMongoId" ] );
            const labels = this.parseJsonArray( ( req.body as Record<string, unknown> )?.[ "labels" ] ) ?? [];

            if ( !taskMongoId ) {
                ApiResponseBuilder.error( res, 400, "taskMongoId is required" );
                return;
            }

            const wsCtx = await this.buildWsContext( req );

            const dto = await this.service.removeLabels( taskMongoId, labels, wsCtx );
            if ( !dto ) {
                ApiResponseBuilder.error( res, 404, "TeamTask not found" );
                return;
            }

            ApiResponseBuilder.ok( res, "teamTask", dto, "Labels removed" );
            return;
        } catch ( err: unknown ) {
            ApiResponseBuilder.error( res, 500, err instanceof Error ? err.message : "Internal error" );
            return;
        }
    };

    // ──────────────────────────────────────────────────────────────────────────
    // Assigned members + captain
    // ──────────────────────────────────────────────────────────────────────────

    public readonly setAssignedMembers: RequestHandler = async ( req: Request, res: Response ): Promise<void> => {
        try {
            const taskMongoId = this.safeStr( req.params[ "taskMongoId" ] );
            const ids = this.parseJsonArray( ( req.body as Record<string, unknown> )?.[ "memberIds" ] ) ?? [];

            if ( !taskMongoId ) {
                ApiResponseBuilder.error( res, 400, "taskMongoId is required" );
                return;
            }

            const wsCtx = await this.buildWsContext( req );

            const dto = await this.service.setAssignedMembers( taskMongoId, ids, wsCtx );
            if ( !dto ) {
                ApiResponseBuilder.error( res, 404, "TeamTask not found" );
                return;
            }

            ApiResponseBuilder.ok( res, "teamTask", dto, "Assigned members set" );
            return;
        } catch ( err: unknown ) {
            ApiResponseBuilder.error( res, 500, err instanceof Error ? err.message : "Internal error" );
            return;
        }
    };

    public readonly addAssignedMembers: RequestHandler = async ( req: Request, res: Response ): Promise<void> => {
        try {
            const taskMongoId = this.safeStr( req.params[ "taskMongoId" ] );
            const ids = this.parseJsonArray( ( req.body as Record<string, unknown> )?.[ "memberIds" ] ) ?? [];

            if ( !taskMongoId ) {
                ApiResponseBuilder.error( res, 400, "taskMongoId is required" );
                return;
            }

            const wsCtx = await this.buildWsContext( req );

            const dto = await this.service.addAssignedMembers( taskMongoId, ids, wsCtx );
            if ( !dto ) {
                ApiResponseBuilder.error( res, 404, "TeamTask not found" );
                return;
            }

            ApiResponseBuilder.ok( res, "teamTask", dto, "Assigned members added" );
            return;
        } catch ( err: unknown ) {
            ApiResponseBuilder.error( res, 500, err instanceof Error ? err.message : "Internal error" );
            return;
        }
    };

    public readonly removeAssignedMembers: RequestHandler = async ( req: Request, res: Response ): Promise<void> => {
        try {
            const taskMongoId = this.safeStr( req.params[ "taskMongoId" ] );
            const ids = this.parseJsonArray( ( req.body as Record<string, unknown> )?.[ "memberIds" ] ) ?? [];

            if ( !taskMongoId ) {
                ApiResponseBuilder.error( res, 400, "taskMongoId is required" );
                return;
            }

            const wsCtx = await this.buildWsContext( req );

            const dto = await this.service.removeAssignedMembers( taskMongoId, ids, wsCtx );
            if ( !dto ) {
                ApiResponseBuilder.error( res, 404, "TeamTask not found" );
                return;
            }

            ApiResponseBuilder.ok( res, "teamTask", dto, "Assigned members removed" );
            return;
        } catch ( err: unknown ) {
            ApiResponseBuilder.error( res, 500, err instanceof Error ? err.message : "Internal error" );
            return;
        }
    };

    public readonly setCaptain: RequestHandler = async ( req: Request, res: Response ): Promise<void> => {
        try {
            const taskMongoId = this.safeStr( req.params[ "taskMongoId" ] );
            const capRaw = ( req.body as Record<string, unknown> )?.[ "captainUserId" ];

            if ( !taskMongoId ) {
                ApiResponseBuilder.error( res, 400, "taskMongoId is required" );
                return;
            }

            // accept "null" to clear
            const captainUserId =
                typeof capRaw === "string" && this.safeStr( capRaw ) === "null" ? null : this.safeStr( capRaw ) || null;

            const wsCtx = await this.buildWsContext( req );

            const dto = await this.service.setCaptain( taskMongoId, captainUserId, wsCtx );
            if ( !dto ) {
                ApiResponseBuilder.error( res, 404, "TeamTask not found" );
                return;
            }

            ApiResponseBuilder.ok( res, "teamTask", dto, "Captain updated" );
            return;
        } catch ( err: unknown ) {
            ApiResponseBuilder.error( res, 500, err instanceof Error ? err.message : "Internal error" );
            return;
        }
    };

    // ──────────────────────────────────────────────────────────────────────────
    // Location / Address / Notes
    // ──────────────────────────────────────────────────────────────────────────

    public readonly setLocation: RequestHandler = async ( req: Request, res: Response ): Promise<void> => {
        try {
            const taskMongoId = this.safeStr( req.params[ "taskMongoId" ] );
            const locRaw = ( req.body as Record<string, unknown> )?.[ "location" ];

            if ( !taskMongoId ) {
                ApiResponseBuilder.error( res, 400, "taskMongoId is required" );
                return;
            }

            const location =
                typeof locRaw === "string" && this.safeStr( locRaw ) === "null" ? null : this.parseJsonObj<GeoLocation>( locRaw );

            const wsCtx = await this.buildWsContext( req );

            const dto = await this.service.setLocation( taskMongoId, location ?? null, wsCtx );
            if ( !dto ) {
                ApiResponseBuilder.error( res, 404, "TeamTask not found" );
                return;
            }

            ApiResponseBuilder.ok( res, "teamTask", dto, "Location updated" );
            return;
        } catch ( err: unknown ) {
            ApiResponseBuilder.error( res, 500, err instanceof Error ? err.message : "Internal error" );
            return;
        }
    };

    public readonly setAddress: RequestHandler = async ( req: Request, res: Response ): Promise<void> => {
        try {
            const taskMongoId = this.safeStr( req.params[ "taskMongoId" ] );
            const addrRaw = ( req.body as Record<string, unknown> )?.[ "address" ];

            if ( !taskMongoId ) {
                ApiResponseBuilder.error( res, 400, "taskMongoId is required" );
                return;
            }

            const address = typeof addrRaw === "string" && this.safeStr( addrRaw ) === "null" ? null : this.parseJsonObj<Address>( addrRaw );

            const wsCtx = await this.buildWsContext( req );

            const dto = await this.service.setAddress( taskMongoId, address ?? null, wsCtx );
            if ( !dto ) {
                ApiResponseBuilder.error( res, 404, "TeamTask not found" );
                return;
            }

            ApiResponseBuilder.ok( res, "teamTask", dto, "Address updated" );
            return;
        } catch ( err: unknown ) {
            ApiResponseBuilder.error( res, 500, err instanceof Error ? err.message : "Internal error" );
            return;
        }
    };

    public readonly setNotes: RequestHandler = async ( req: Request, res: Response ): Promise<void> => {
        try {
            const taskMongoId = this.safeStr( req.params[ "taskMongoId" ] );
            const notesRaw = ( req.body as Record<string, unknown> )?.[ "notes" ];

            if ( !taskMongoId ) {
                ApiResponseBuilder.error( res, 400, "taskMongoId is required" );
                return;
            }

            const notes =
                typeof notesRaw === "string" && this.safeStr( notesRaw ) === "null"
                    ? null
                    : typeof notesRaw === "string"
                        ? this.safeStr( notesRaw )
                        : null;

            const wsCtx = await this.buildWsContext( req );

            const dto = await this.service.setNotes( taskMongoId, notes, wsCtx );
            if ( !dto ) {
                ApiResponseBuilder.error( res, 404, "TeamTask not found" );
                return;
            }

            ApiResponseBuilder.ok( res, "teamTask", dto, "Notes updated" );
            return;
        } catch ( err: unknown ) {
            ApiResponseBuilder.error( res, 500, err instanceof Error ? err.message : "Internal error" );
            return;
        }
    };

    // ──────────────────────────────────────────────────────────────────────────
    // Audit CRUD (get/set/patch/clear)
    // ──────────────────────────────────────────────────────────────────────────

    public readonly getAudit: RequestHandler = async ( req: Request, res: Response ): Promise<void> => {
        try {
            const taskMongoId = this.safeStr( req.params[ "taskMongoId" ] );
            if ( !taskMongoId ) {
                ApiResponseBuilder.error( res, 400, "taskMongoId is required" );
                return;
            }

            const audit = await this.service.getAudit( taskMongoId );
            if ( audit === null ) {
                ApiResponseBuilder.error( res, 404, "TeamTask not found" );
                return;
            }

            ApiResponseBuilder.ok( res, "other", { audit }, "Audit loaded" );
            return;
        } catch ( err: unknown ) {
            ApiResponseBuilder.error( res, 500, err instanceof Error ? err.message : "Internal error" );
            return;
        }
    };

    public readonly setAudit: RequestHandler = async ( req: Request, res: Response ): Promise<void> => {
        try {
            const taskMongoId = this.safeStr( req.params[ "taskMongoId" ] );
            if ( !taskMongoId ) {
                ApiResponseBuilder.error( res, 400, "taskMongoId is required" );
                return;
            }

            const auditRaw = ( req.body as Record<string, unknown> )?.[ "audit" ];
            const audit = typeof auditRaw === "string" && this.safeStr( auditRaw ) === "null" ? null : this.parseJsonObj<TaskAuditMeta>( auditRaw );

            const wsCtx = await this.buildWsContext( req );

            const dto = await this.service.setAudit( taskMongoId, audit ?? null, wsCtx );
            if ( !dto ) {
                ApiResponseBuilder.error( res, 404, "TeamTask not found" );
                return;
            }

            ApiResponseBuilder.ok( res, "teamTask", dto, "Audit updated" );
            return;
        } catch ( err: unknown ) {
            ApiResponseBuilder.error( res, 500, err instanceof Error ? err.message : "Internal error" );
            return;
        }
    };

    public readonly patchAudit: RequestHandler = async ( req: Request, res: Response ): Promise<void> => {
        try {
            const taskMongoId = this.safeStr( req.params[ "taskMongoId" ] );
            if ( !taskMongoId ) {
                ApiResponseBuilder.error( res, 400, "taskMongoId is required" );
                return;
            }

            const patch = this.parseJsonObj<TaskAuditMeta>( ( req.body as Record<string, unknown> )?.[ "patch" ] );
            if ( !patch ) {
                ApiResponseBuilder.error( res, 400, "patch is required" );
                return;
            }

            const wsCtx = await this.buildWsContext( req );

            const dto = await this.service.patchAudit( taskMongoId, patch, wsCtx );
            if ( !dto ) {
                ApiResponseBuilder.error( res, 404, "TeamTask not found" );
                return;
            }

            ApiResponseBuilder.ok( res, "teamTask", dto, "Audit patched" );
            return;
        } catch ( err: unknown ) {
            ApiResponseBuilder.error( res, 500, err instanceof Error ? err.message : "Internal error" );
            return;
        }
    };

    public readonly clearAudit: RequestHandler = async ( req: Request, res: Response ): Promise<void> => {
        try {
            const taskMongoId = this.safeStr( req.params[ "taskMongoId" ] );
            if ( !taskMongoId ) {
                ApiResponseBuilder.error( res, 400, "taskMongoId is required" );
                return;
            }

            const wsCtx = await this.buildWsContext( req );

            const dto = await this.service.clearAudit( taskMongoId, wsCtx );
            if ( !dto ) {
                ApiResponseBuilder.error( res, 404, "TeamTask not found" );
                return;
            }

            ApiResponseBuilder.ok( res, "teamTask", dto, "Audit cleared" );
            return;
        } catch ( err: unknown ) {
            ApiResponseBuilder.error( res, 500, err instanceof Error ? err.message : "Internal error" );
            return;
        }
    };

    // ──────────────────────────────────────────────────────────────────────────
    // Timing CRUD (get/set/patch/clear)
    // ──────────────────────────────────────────────────────────────────────────

    public readonly getTiming: RequestHandler = async ( req: Request, res: Response ): Promise<void> => {
        try {
            const taskMongoId = this.safeStr( req.params[ "taskMongoId" ] );
            if ( !taskMongoId ) {
                ApiResponseBuilder.error( res, 400, "taskMongoId is required" );
                return;
            }

            const timing = await this.service.getTiming( taskMongoId );
            if ( timing === null ) {
                ApiResponseBuilder.error( res, 404, "TeamTask not found" );
                return;
            }

            ApiResponseBuilder.ok( res, "other", { timing }, "Timing loaded" );
            return;
        } catch ( err: unknown ) {
            ApiResponseBuilder.error( res, 500, err instanceof Error ? err.message : "Internal error" );
            return;
        }
    };

    public readonly setTiming: RequestHandler = async ( req: Request, res: Response ): Promise<void> => {
        try {
            const taskMongoId = this.safeStr( req.params[ "taskMongoId" ] );
            if ( !taskMongoId ) {
                ApiResponseBuilder.error( res, 400, "taskMongoId is required" );
                return;
            }

            const timingRaw = ( req.body as Record<string, unknown> )?.[ "timing" ];
            const timing = typeof timingRaw === "string" && this.safeStr( timingRaw ) === "null" ? null : this.parseJsonObj<TaskTiming>( timingRaw );

            const wsCtx = await this.buildWsContext( req );

            const dto = await this.service.setTiming( taskMongoId, timing ?? null, wsCtx );
            if ( !dto ) {
                ApiResponseBuilder.error( res, 404, "TeamTask not found" );
                return;
            }

            ApiResponseBuilder.ok( res, "teamTask", dto, "Timing updated" );
            return;
        } catch ( err: unknown ) {
            ApiResponseBuilder.error( res, 500, err instanceof Error ? err.message : "Internal error" );
            return;
        }
    };

    public readonly patchTiming: RequestHandler = async ( req: Request, res: Response ): Promise<void> => {
        try {
            const taskMongoId = this.safeStr( req.params[ "taskMongoId" ] );
            if ( !taskMongoId ) {
                ApiResponseBuilder.error( res, 400, "taskMongoId is required" );
                return;
            }

            const patch = this.parseJsonObj<TaskTiming>( ( req.body as Record<string, unknown> )?.[ "patch" ] );
            if ( !patch ) {
                ApiResponseBuilder.error( res, 400, "patch is required" );
                return;
            }

            const wsCtx = await this.buildWsContext( req );

            const dto = await this.service.patchTiming( taskMongoId, patch, wsCtx );
            if ( !dto ) {
                ApiResponseBuilder.error( res, 404, "TeamTask not found" );
                return;
            }

            ApiResponseBuilder.ok( res, "teamTask", dto, "Timing patched" );
            return;
        } catch ( err: unknown ) {
            ApiResponseBuilder.error( res, 500, err instanceof Error ? err.message : "Internal error" );
            return;
        }
    };

    public readonly clearTiming: RequestHandler = async ( req: Request, res: Response ): Promise<void> => {
        try {
            const taskMongoId = this.safeStr( req.params[ "taskMongoId" ] );
            if ( !taskMongoId ) {
                ApiResponseBuilder.error( res, 400, "taskMongoId is required" );
                return;
            }

            const wsCtx = await this.buildWsContext( req );

            const dto = await this.service.clearTiming( taskMongoId, wsCtx );
            if ( !dto ) {
                ApiResponseBuilder.error( res, 404, "TeamTask not found" );
                return;
            }

            ApiResponseBuilder.ok( res, "teamTask", dto, "Timing cleared" );
            return;
        } catch ( err: unknown ) {
            ApiResponseBuilder.error( res, 500, err instanceof Error ? err.message : "Internal error" );
            return;
        }
    };

    // ──────────────────────────────────────────────────────────────────────────
    // SLA set
    // ──────────────────────────────────────────────────────────────────────────

    public readonly setSla: RequestHandler = async ( req: Request, res: Response ): Promise<void> => {
        try {
            const taskMongoId = this.safeStr( req.params[ "taskMongoId" ] );
            if ( !taskMongoId ) {
                ApiResponseBuilder.error( res, 400, "taskMongoId is required" );
                return;
            }

            const slaRaw = ( req.body as Record<string, unknown> )?.[ "sla" ];
            const sla = typeof slaRaw === "string" && this.safeStr( slaRaw ) === "null" ? null : this.parseJsonObj<TaskSlaPolicy>( slaRaw );

            const wsCtx = await this.buildWsContext( req );

            const dto = await this.service.setSla( taskMongoId, sla ?? null, wsCtx );
            if ( !dto ) {
                ApiResponseBuilder.error( res, 404, "TeamTask not found" );
                return;
            }

            ApiResponseBuilder.ok( res, "teamTask", dto, "SLA updated" );
            return;
        } catch ( err: unknown ) {
            ApiResponseBuilder.error( res, 500, err instanceof Error ? err.message : "Internal error" );
            return;
        }
    };

    // ──────────────────────────────────────────────────────────────────────────
    // Task Users
    // ──────────────────────────────────────────────────────────────────────────

    public readonly getAssignedMemberUsernames: RequestHandler = async ( req: Request, res: Response ): Promise<void> => {
        try {
            const taskMongoId = this.safeStr( req.params[ "taskMongoId" ] );
            if ( !taskMongoId ) {
                ApiResponseBuilder.error( res, 400, "taskMongoId is required" );
                return;
            }

            const usernames = await this.service.getAssignedMemberUsernames( taskMongoId );
            ApiResponseBuilder.ok( res, "other", { usernames }, "Assigned member usernames loaded" );
            return;
        } catch ( err: unknown ) {
            ApiResponseBuilder.error( res, 500, err instanceof Error ? err.message : "Internal error" );
            return;
        }
    };

    public readonly getTaskUsers: RequestHandler = async ( req: Request, res: Response ): Promise<void> => {
        try {
            const taskMongoId = this.safeStr( req.params[ "taskMongoId" ] );
            if ( !taskMongoId ) {
                ApiResponseBuilder.error( res, 400, "taskMongoId is required" );
                return;
            }

            const body = ( req.body as Record<string, unknown> ) ?? {};
            const filter = {
                ...( this.safeStr( body[ "userId" ] ) ? { userId: this.safeStr( body[ "userId" ] ) } : {} ),
                ...( this.safeStr( body[ "username" ] ) ? { username: this.safeStr( body[ "username" ] ) } : {} ),
            };

            const result = await this.service.getTaskUsers( taskMongoId, filter );
            if ( !result ) {
                ApiResponseBuilder.error( res, 404, "TeamTask not found" );
                return;
            }

            ApiResponseBuilder.ok( res, "other", { taskTeam: result }, "Task users loaded" );
            return;
        } catch ( err: unknown ) {
            ApiResponseBuilder.error( res, 500, err instanceof Error ? err.message : "Internal error" );
            return;
        }
    };
}
