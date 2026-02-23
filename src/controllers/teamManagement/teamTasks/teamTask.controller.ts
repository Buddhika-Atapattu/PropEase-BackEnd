// Path: src/controllers/teamManagement/teamTask.controller.ts
// ============================================================================
// TeamTaskController — aligned with:
// - src/services/teamManagement/team-task.service.ts
// - src/services/teamManagement/team-task.socket.service.ts
// - src/types/teamManagement/teamTasks/team-tasks.type.ts
//
// NOTE (exactOptionalPropertyTypes-safe):
// - Never assign `undefined` into DTO/update payloads.
// - For PATCH merge helpers, we DROP keys with `undefined` (but keep `null`).
// ============================================================================

import type { Request, Response, NextFunction, RequestHandler } from "express";
import path from "path";
import { Types } from "mongoose";

import FileUploader, { type UploadResultPacket } from "../../../utils/files/file-uploader.helper";
import { ApiResponseBuilder } from "../../../utils/api-combiner.builder";

import { ApiGuardExport } from "../../../guard/api-router.guard";
import type { AuthUser } from "../../../types/common";

import type { FileMetaPacket } from "../../../types/common";
import type { Address, GeoLocation } from "../../../types/common";

import type {
    TaskEvidence,
    TaskAuditMeta,
    TaskTiming,
    TaskRuntimeMetrics,
    TaskCompletionConfirmation,
    TaskDeadlinePolicy,
    TaskPriority,
    TaskStatus,
    TeamTaskDto,
    TeamTaskFilterInput,
    TeamTaskLoadMode,
    TeamTaskSortInput,
    TeamTaskSortKey,
    SortDirection,
    PaginationInput,
    CreateTeamTaskInput,
    UpdateTeamTaskInput,

} from "../../../types/teamManagement/teamTasks/team-tasks.type";

import {
    TASK_PRIORITIES,
    TASK_STATUSES,
}
    from '../../../types/teamManagement/teamTasks/team-tasks.type';

import { TEAM_DOMAINS, TeamDomain, type TeamManagementDto } from "../../../types/teamManagement/teamMain/teamManagement.types";

import { TeamTaskService } from "../../../services/teamManagement/teamTasks/team-task.service";
import type { TeamTaskWsContext } from "../../../services/teamManagement/teamTasks/team-task.socket.service";

import { RecycleBinDomainDeleteService, type DomainDeletePlan } from "../../../services/recyclebin/recyclebin-domain-delete.service";
import { NotificationHubEngineService } from "../../../services/notifications/notification-hub-engine.service";
import type { NotificationAudience } from "../../../types/notification/notification.types";

export class TeamTaskController {
    // ---------------------------------------------------------------------------
    // Integrations
    // ---------------------------------------------------------------------------
    private readonly notificationHub: NotificationHubEngineService = new NotificationHubEngineService();
    private readonly deleteSvc: RecycleBinDomainDeleteService = new RecycleBinDomainDeleteService();

    // ──────────────────────────────────────────────────────────────────────────
    // Upload settings
    // ──────────────────────────────────────────────────────────────────────────

    private readonly UPLOAD_FIELDS: ReadonlyArray<{ name: string; maxCount?: number; }> = [
        { name: "evidence", maxCount: 30 },
        { name: "attachments", maxCount: 30 },
        { name: "files", maxCount: 30 },
    ];

    private readonly MAX_FILE_MB = 25;
    private readonly MAX_FILES_TOTAL = 60;

    private readonly ALLOWED_MIME: ReadonlySet<string> = new Set<string>( [
        "image/jpeg",
        "image/png",
        "image/webp",
        "application/pdf",
        "text/plain",
        "application/zip",
    ] );

    // TEMP root inside public/uploads (do not prefix with "uploads/")
    private readonly TEMP_ROOT_SUBPATH = "teamManagement/teamTasks/__tmp";

    private readonly service: TeamTaskService = new TeamTaskService();

    public constructor () {}

    // ──────────────────────────────────────────────────────────────────────────
    // Small helpers
    // ──────────────────────────────────────────────────────────────────────────

    private async organiseAudienceForTeamMembers( memberData: Types.ObjectId[] ): Promise<NotificationAudience[]> {
        if ( !Array.isArray( memberData ) || memberData.length === 0 ) {
            throw new Error( 'Invalid member array!' );
        }

        const teamMembersUsernames = await this.service.fetchUserFieldAsStringArray( memberData, 'username' );

        const audiences: NotificationAudience[] = [];

        teamMembersUsernames.forEach( ( m ) => {
            const data: NotificationAudience = {
                mode: 'User',
                userId: String( m ).trim()
            };

            audiences.push( data );
        } );

        return audiences;
    }

    private safeStr( v: unknown ): string {
        return typeof v === "string" ? v.trim() : "";
    }

    private toNum( v: unknown, fallback: number ): number {
        const n = Number( v );
        return Number.isFinite( n ) ? n : fallback;
    }

    private isNullToken( v: unknown ): boolean {
        if ( v === null ) return true;
        if ( typeof v !== "string" ) return false;
        const s = v.trim().toLowerCase();
        return s === "null" || s === "undefined";
    }

    private tryObjectId( id: unknown ): Types.ObjectId | null {
        const s = this.safeStr( id );
        if ( !s ) return null;
        if ( !Types.ObjectId.isValid( s ) ) return null;
        return new Types.ObjectId( s );
    }

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

    private parseJsonObj<T>( v: unknown ): T | null {
        if ( !v ) return null;
        if ( typeof v === "object" ) return v as T;
        if ( typeof v !== "string" ) return null;

        const raw = v.trim();
        if ( !raw ) return null;

        try {
            const parsed = JSON.parse( raw ) as unknown;
            return parsed && typeof parsed === "object" ? ( parsed as T ) : null;
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

    // Drop keys whose value is `undefined` (exactOptionalPropertyTypes-safe).
    private dropUndefined( obj: Record<string, unknown> ): Record<string, unknown> {
        const out: Record<string, unknown> = {};
        for ( const [ k, v ] of Object.entries( obj ) ) {
            if ( typeof v === "undefined" ) continue;
            out[ k ] = v;
        }
        return out;
    }

    // ✅ FIX: Do NOT require index signature. TaskAuditMeta does not extend Record<string, unknown>.
    private patchObj<T extends object>( base: T, patch: Partial<T> ): T {
        // We still need to protect against `undefined` overwriting:
        const cleanPatch = this.dropUndefined( patch as unknown as Record<string, unknown> ) as Partial<T>;
        return { ...( base as object ), ...( cleanPatch as object ) } as T;
    }

    private ensurePatchRecord( v: unknown ): Record<string, unknown> {
        // Accept JSON string, object, or fallback {}
        const parsed = this.parseJsonObj<Record<string, unknown>>( v );
        if ( parsed && typeof parsed === "object" ) return parsed;

        if ( typeof v === "object" && v ) {
            // If caller passed object directly
            return v as Record<string, unknown>;
        }

        return {};
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Temp path store on req
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

        // ✅ Top-level public/ (outside src/)
        const absDiskPath = path.resolve( process.cwd(), "public", relativePath );

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

        const enc = this.safeStr( ( pkt as unknown as { encoding?: unknown; } ).encoding );
        if ( enc ) ( out as unknown as { encoding: string; } ).encoding = enc;

        return out;
    }

    private async moveTempUploadsToFinal(
        req: Request,
        tempUpload: UploadResultPacket,
        finalSubPath: string
    ): Promise<UploadResultPacket> {
        // 1) Move disk files
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

        // Ensure keys exist
        for ( const f of this.UPLOAD_FIELDS ) {
            const key = this.safeStr( f.name );
            if ( key && !Object.prototype.hasOwnProperty.call( byField, key ) ) byField[ key ] = [];
        }

        // 3) Totals
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
    // WS context
    // ──────────────────────────────────────────────────────────────────────────

    private async buildWsContext( req: Request, dto?: TeamTaskDto ): Promise<TeamTaskWsContext> {
        const systemUser = await this.getAuthUser( req );

        const actor: AuthUser =
            systemUser ??
            ( {
                role: "user",
                username: "Unknown",
            } as AuthUser );

        return {
            actor,
            requestId: this.getRequestId( req ),
            assignedMember: Array.isArray( dto?.assignedMembers ) ? dto!.assignedMembers : [],
        };
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Enum guards
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

    private isSortKey( v: unknown ): v is TeamTaskSortKey {
        return (
            typeof v === "string" &&
            ( [ "createdAt", "updatedAt", "name", "status", "priority", "dueAt", "workItemCount" ] as const ).includes(
                v as TeamTaskSortKey
            )
        );
    }

    private isSortDir( v: unknown ): v is SortDirection {
        return typeof v === "string" && ( [ "asc", "desc" ] as const ).includes( v as SortDirection );
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Upload middleware (router mounts before create/update)
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
    // LIST
    // ──────────────────────────────────────────────────────────────────────────

    public readonly list: RequestHandler = async ( req: Request, res: Response ): Promise<void> => {
        try {
            const body = ( req.body as Record<string, unknown> ) ?? {};

            const mode = ( this.safeStr( body[ "mode" ] ) as TeamTaskLoadMode ) || "minimal";
            const filters = ( ( body[ "filters" ] as TeamTaskFilterInput ) ?? {} ) satisfies TeamTaskFilterInput;

            const pageRaw = ( body[ "page" ] ?? {} ) as Record<string, unknown>;
            const page: PaginationInput & { pageIndex?: number; } = {
                limit: this.toNum( pageRaw[ "limit" ], 20 ),
                page: this.toNum( pageRaw[ "page" ], 1 ),
            };

            // Legacy support: pageIndex (0-based)
            if ( typeof pageRaw[ "pageIndex" ] !== "undefined" ) page.pageIndex = this.toNum( pageRaw[ "pageIndex" ], 0 );

            const sortRaw = ( body[ "sort" ] ?? {} ) as Record<string, unknown>;
            const keyRaw = sortRaw[ "key" ];
            const dirRaw = sortRaw[ "dir" ];

            const sort: TeamTaskSortInput = {
                key: this.isSortKey( keyRaw ) ? keyRaw : "createdAt",
                dir: this.isSortDir( dirRaw ) ? dirRaw : "desc",
            };

            const out = await this.service.list( filters, page, sort, mode );

            ApiResponseBuilder.ok( res, "teamTasks", out.items, "TeamTasks loaded", { other: out.other } );
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
            const filters = ( ( body[ "filters" ] as TeamTaskFilterInput ) ?? {} ) satisfies TeamTaskFilterInput;

            const total = await this.service.count( filters );
            ApiResponseBuilder.ok( res, "other", { total }, "TeamTasks counted" );
            return;
        } catch ( err: unknown ) {
            ApiResponseBuilder.error( res, 500, err instanceof Error ? err.message : "Internal error" );
            return;
        }
    };

    // ──────────────────────────────────────────────────────────────────────────
    // KEY VALUES META
    // ──────────────────────────────────────────────────────────────────────────

    public readonly keyValues: RequestHandler = async ( req: Request, res: Response ): Promise<void> => {
        try {
            const body = ( req.body as Record<string, unknown> ) ?? {};

            const domainRaw = body[ "domain" ];
            const statusRaw = body[ "status" ];
            const teamCode = this.safeStr( body[ "teamCode" ] );
            const teamMongoIdStr = this.safeStr( body[ "teamMongoId" ] );

            const kv = await this.service.getKeyValues( {
                ...( teamCode ? { teamCode } : {} ),
                ...( teamMongoIdStr ? { teamMongoId: teamMongoIdStr } : {} ),
                ...( this.isTeamDomain( domainRaw ) ? { domain: domainRaw } : {} ),
                ...( this.isTaskStatus( statusRaw ) ? { status: statusRaw } : {} ),
            } );

            ApiResponseBuilder.ok( res, "other", { teamTaskKeyValuesMeta: kv }, "Key values loaded" );
            return;
        } catch ( err: unknown ) {
            ApiResponseBuilder.error( res, 500, err instanceof Error ? err.message : "Internal error" );
            return;
        }
    };

    // ──────────────────────────────────────────────────────────────────────────
    // CREATE (multipart)
    // ──────────────────────────────────────────────────────────────────────────

    public readonly create: RequestHandler = async ( req: Request, res: Response ): Promise<void> => {
        try {
            const body = ( req.body as Record<string, unknown> ) ?? {};
            const nowIso = new Date().toISOString();

            // Parse arrays / objects
            const assignedMembersParsed = this.parseJsonArray( body[ "assignedMembers" ] );
            const labelsParsed = this.parseJsonArray( body[ "labels" ] );

            const locationParsed = this.parseJsonObj<GeoLocation>( body[ "location" ] );
            const addressParsed = this.parseJsonObj<Address>( body[ "address" ] );
            const timingParsed = this.parseJsonObj<TaskTiming>( body[ "timing" ] );
            const deadlinePolicyParsed =
                this.parseJsonObj<TaskDeadlinePolicy>( body[ "deadlinePolicy" ] ) ?? this.parseJsonObj<TaskDeadlinePolicy>( body[ "sla" ] );
            const metricsParsed = this.parseJsonObj<TaskRuntimeMetrics>( body[ "metrics" ] );
            const completionParsed = this.parseJsonObj<TaskCompletionConfirmation>( body[ "completionConfirmation" ] );
            const auditParsed = this.parseJsonObj<TaskAuditMeta>( body[ "audit" ] );

            // Enums
            const domainStr = this.safeStr( body[ "domain" ] );
            if ( !domainStr || !this.isTeamDomain( domainStr ) ) {
                ApiResponseBuilder.error( res, 400, "Invalid or missing domain" );
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

            // Required base fields
            const id = this.safeStr( body[ "id" ] );
            const teamCode = this.safeStr( body[ "teamCode" ] );
            const teamMongoId = this.tryObjectId( body[ "teamMongoId" ] );
            const name = this.safeStr( body[ "name" ] );
            const description = this.safeStr( body[ "description" ] ); // service supports string (stored if string)

            if ( !id || !teamCode || !teamMongoId || !name ) {
                ApiResponseBuilder.error( res, 400, "Missing required fields: id, teamCode, teamMongoId, name" );
                return;
            }

            // assignedMembers -> ObjectId[]
            const memberOids: Types.ObjectId[] =
                Array.isArray( assignedMembersParsed ) && assignedMembersParsed.length > 0
                    ? assignedMembersParsed.map( ( s ) => this.tryObjectId( s ) ).filter( ( x ): x is Types.ObjectId => Boolean( x ) )
                    : [];



            const captainOid = this.tryObjectId( body[ "assignedTaskCaptain" ] );

            const input: CreateTeamTaskInput = {
                id,
                teamCode,
                teamMongoId,
                domain: domainStr as TeamDomain,

                name,
                description,

                // model wants it
                workItemCount: 0,


                // keep consistent anchors
                createdAt: nowIso,
                updatedAt: nowIso,

                timing: timingParsed ?? {},

                status: ( statusStr ? ( statusStr as TaskStatus ) : "draft" ) as TaskStatus,
                priority: ( priorityStr ? ( priorityStr as TaskPriority ) : "medium" ) as TaskPriority,

                ...( locationParsed ? { location: locationParsed } : {} ),
                ...( addressParsed ? { address: addressParsed } : {} ),
                ...( memberOids.length > 0 ? { assignedMembers: memberOids } : {} ),
                ...( captainOid ? { assignedTaskCaptain: captainOid } : {} ),
                ...( this.safeStr( body[ "plannedStartAt" ] ) ? { plannedStartAt: this.safeStr( body[ "plannedStartAt" ] ) } : {} ),
                ...( this.safeStr( body[ "plannedEndAt" ] ) ? { plannedEndAt: this.safeStr( body[ "plannedEndAt" ] ) } : {} ),
                ...( deadlinePolicyParsed ? { deadlinePolicy: deadlinePolicyParsed } : {} ),
                ...( metricsParsed ? { metrics: metricsParsed } : {} ),
                ...( completionParsed ? { completionConfirmation: completionParsed } : {} ),
                ...( this.safeStr( body[ "notes" ] ) ? { notes: this.safeStr( body[ "notes" ] ) } : {} ),
                ...( labelsParsed && labelsParsed.length > 0 ? { labels: labelsParsed } : {} ),
                ...( auditParsed ? { audit: auditParsed } : {} ),
            };

            // 1) Create record (service emits WS Created)
            const wsCtx = await this.buildWsContext( req );
            const createdDto = await this.service.create( input, wsCtx );

            // 2) Handle uploads (TEMP -> FINAL)
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

            // 3) upload -> evidence -> appendEvidence (service emits WS Updated)
            const evidenceItems = this.mapUploadToEvidence( finalPacket );

            let finalDto: TeamTaskDto = createdDto;

            if ( evidenceItems.length > 0 ) {
                const ctxWithUsers = await this.buildWsContext( req, createdDto );
                const patched = await this.service.appendEvidence( createdDto.taskMongoId, evidenceItems, ctxWithUsers );
                if ( patched ) finalDto = patched;
            }

            const actor = await ApiGuardExport.GetNormalisedAuthUser( req );
            if ( !actor ) {
                ApiResponseBuilder.error( res, 401, "Unauthorized: unable to identify user" );
                return;
            }

            const audiencesMembers = await this.organiseAudienceForTeamMembers( memberOids );

            this.notificationHub.emit( {
                eventKey: 'team:task.created',
                actor,
                audiences: [
                    ...audiencesMembers,
                    {
                        mode: 'Role',
                        roleKey: 'admin',
                    },
                    {
                        mode: 'Role',
                        roleKey: 'operator',
                    },
                    {
                        mode: 'Role',
                        roleKey: 'manager',
                    },
                ],
                target: {
                    actionKey: 'team:task.created',
                    category: 'teamTask',
                    module: 'teamManagement',
                    params: {
                        teamCode: createdDto.teamCode,
                        taskId: createdDto.id ?? createdDto.taskMongoId,
                    },
                    refId: createdDto.id ?? createdDto.taskMongoId,
                },
                category: 'Team',
            } );

            ApiResponseBuilder.ok( res, "teamTask", finalDto, "TeamTask created", {
                other: { uploads: finalPacket },
            } );
            return;
        } catch ( err: unknown ) {
            ApiResponseBuilder.error( res, 500, err instanceof Error ? err.message : "Internal error" );
            return;
        }
    };

    // ──────────────────────────────────────────────────────────────────────────
    // UPDATE (multipart)
    // ──────────────────────────────────────────────────────────────────────────

    public readonly update: RequestHandler = async ( req: Request, res: Response ): Promise<void> => {
        try {
            const taskMongoId = this.safeStr( req.params[ "taskMongoId" ] );
            if ( !taskMongoId ) {
                ApiResponseBuilder.error( res, 400, "taskMongoId is required" );
                return;
            }

            const body = ( req.body as Record<string, unknown> ) ?? {};

            // Parse objects
            const locationParsed = this.parseJsonObj<GeoLocation>( body[ "location" ] );
            const addressParsed = this.parseJsonObj<Address>( body[ "address" ] );
            const timingParsed = this.parseJsonObj<TaskTiming>( body[ "timing" ] );
            const deadlinePolicyParsed =
                this.parseJsonObj<TaskDeadlinePolicy>( body[ "deadlinePolicy" ] ) ?? this.parseJsonObj<TaskDeadlinePolicy>( body[ "sla" ] );
            const metricsParsed = this.parseJsonObj<TaskRuntimeMetrics>( body[ "metrics" ] );
            const completionParsed = this.parseJsonObj<TaskCompletionConfirmation>( body[ "completionConfirmation" ] );
            const auditParsed = this.parseJsonObj<TaskAuditMeta>( body[ "audit" ] );

            // Parse arrays
            const assignedMembersParsed = this.parseJsonArray( body[ "assignedMembers" ] );
            const labelsParsed = this.parseJsonArray( body[ "labels" ] );

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

            // Build UpdateTeamTaskInput (mutate to avoid union explosions)
            const input: UpdateTeamTaskInput = {};

            if ( typeof body[ "name" ] === "string" ) input.name = this.safeStr( body[ "name" ] );
            if ( typeof body[ "description" ] === "string" ) input.description = this.safeStr( body[ "description" ] );

            // location/address null-or-object
            if ( this.isNullToken( body[ "location" ] ) ) input.location = null;
            else if ( locationParsed ) input.location = locationParsed;

            if ( this.isNullToken( body[ "address" ] ) ) input.address = null;
            else if ( addressParsed ) input.address = addressParsed;

            // assignedMembers: null OR ObjectId[]
            if ( typeof body[ "assignedMembers" ] !== "undefined" ) {
                if ( this.isNullToken( body[ "assignedMembers" ] ) ) {
                    input.assignedMembers = null;
                } else if ( Array.isArray( assignedMembersParsed ) ) {
                    const oids = assignedMembersParsed.map( ( s ) => this.tryObjectId( s ) ).filter( ( x ): x is Types.ObjectId => Boolean( x ) );
                    input.assignedMembers = oids;
                }
            }

            // captain: null OR ObjectId
            if ( typeof body[ "assignedTaskCaptain" ] !== "undefined" ) {
                if ( this.isNullToken( body[ "assignedTaskCaptain" ] ) ) {
                    input.assignedTaskCaptain = null;
                } else {
                    const cap = this.tryObjectId( body[ "assignedTaskCaptain" ] );
                    if ( cap ) input.assignedTaskCaptain = cap;
                }
            }

            // plannedStartAt / plannedEndAt: null OR string
            if ( typeof body[ "plannedStartAt" ] !== "undefined" ) {
                input.plannedStartAt = this.isNullToken( body[ "plannedStartAt" ] ) ? null : this.safeStr( body[ "plannedStartAt" ] ) || null;
            }
            if ( typeof body[ "plannedEndAt" ] !== "undefined" ) {
                input.plannedEndAt = this.isNullToken( body[ "plannedEndAt" ] ) ? null : this.safeStr( body[ "plannedEndAt" ] ) || null;
            }

            // timing: null OR object
            if ( typeof body[ "timing" ] !== "undefined" && Object.prototype.hasOwnProperty.call( body, "timing" ) ) {
                if ( this.isNullToken( body[ "timing" ] ) ) input.timing = null;
                else if ( timingParsed ) input.timing = timingParsed;
            }

            // deadlinePolicy (supports legacy sla too)
            if ( typeof body[ "deadlinePolicy" ] !== "undefined" || typeof body[ "sla" ] !== "undefined" ) {
                if ( this.isNullToken( body[ "deadlinePolicy" ] ) || this.isNullToken( body[ "sla" ] ) ) input.deadlinePolicy = null;
                else if ( deadlinePolicyParsed ) input.deadlinePolicy = deadlinePolicyParsed;
            }

            // metrics: null OR object
            if ( typeof body[ "metrics" ] !== "undefined" ) {
                if ( this.isNullToken( body[ "metrics" ] ) ) input.metrics = null;
                else if ( metricsParsed ) input.metrics = metricsParsed;
            }

            // completionConfirmation: null OR object
            if ( typeof body[ "completionConfirmation" ] !== "undefined" ) {
                if ( this.isNullToken( body[ "completionConfirmation" ] ) ) input.completionConfirmation = null;
                else if ( completionParsed ) input.completionConfirmation = completionParsed;
            }

            // notes: null OR string
            if ( typeof body[ "notes" ] !== "undefined" ) {
                if ( this.isNullToken( body[ "notes" ] ) ) input.notes = null;
                else if ( typeof body[ "notes" ] === "string" ) input.notes = this.safeStr( body[ "notes" ] );
            }

            // labels: null OR string[]
            if ( typeof body[ "labels" ] !== "undefined" ) {
                if ( this.isNullToken( body[ "labels" ] ) ) input.labels = null;
                else if ( Array.isArray( labelsParsed ) ) input.labels = labelsParsed;
            }

            // audit: null OR object
            if ( typeof body[ "audit" ] !== "undefined" ) {
                if ( this.isNullToken( body[ "audit" ] ) ) input.audit = null;
                else if ( auditParsed ) input.audit = auditParsed;
            }

            if ( statusStr ) input.status = statusStr as TaskStatus;
            if ( priorityStr ) input.priority = priorityStr as TaskPriority;
            if ( domainStr ) input.domain = domainStr as TeamDomain;

            // 1) Update record (service emits WS Updated)
            const wsCtx = await this.buildWsContext( req );
            const updatedDto = await this.service.update( taskMongoId, input, wsCtx );

            if ( !updatedDto ) {
                ApiResponseBuilder.error( res, 404, "TeamTask not found" );
                return;
            }

            // 2) Upload processing (TEMP -> FINAL)
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
                const patched = await this.service.appendEvidence( updatedDto.taskMongoId, evidenceItems, ctxWithUsers );
                if ( patched ) finalDto = patched;
            }


            const memberOids: Types.ObjectId[] =
                Array.isArray( assignedMembersParsed ) && assignedMembersParsed.length > 0
                    ? assignedMembersParsed.map( ( s ) => this.tryObjectId( s ) ).filter( ( x ): x is Types.ObjectId => Boolean( x ) )
                    : [];


            const actor = await ApiGuardExport.GetNormalisedAuthUser( req );
            if ( !actor ) {
                ApiResponseBuilder.error( res, 401, "Unauthorized: unable to identify user" );
                return;
            }

            const audiencesMembers = await this.organiseAudienceForTeamMembers( memberOids );

            this.notificationHub.emit( {
                eventKey: 'team:task.updated',
                actor,
                audiences: [
                    ...audiencesMembers,
                    {
                        mode: 'Role',
                        roleKey: 'admin',
                    },
                    {
                        mode: 'Role',
                        roleKey: 'operator',
                    },
                    {
                        mode: 'Role',
                        roleKey: 'manager',
                    },
                ],
                target: {
                    actionKey: 'team:task.updated',
                    category: 'teamTask',
                    module: 'teamManagement',
                    params: {
                        teamCode: updatedDto.teamCode,
                        taskId: updatedDto.id ?? updatedDto.taskMongoId,
                    },
                    refId: updatedDto.id ?? updatedDto.taskMongoId,
                },
                category: 'Team',
            } );

            ApiResponseBuilder.ok( res, "teamTask", finalDto, "TeamTask updated", {
                other: { uploads: finalPacket },
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
            const actor = await ApiGuardExport.GetNormalisedAuthUser(req);
            if(!actor) {
                ApiResponseBuilder.error( res, 401, "Unauthorized: unable to identify user" );
                return;
            }
            const taskMongoId = this.safeStr( req.params[ "taskMongoId" ] );
            if ( !taskMongoId ) {
                ApiResponseBuilder.error( res, 400, "taskMongoId is required" );
                return;
            }

            const existing = await this.service.getByMongoId( taskMongoId, "minimal" );
            if ( !existing ) {
                ApiResponseBuilder.error( res, 404, "TeamTask not found" );
                return;
            }
            const wsCtx = await this.buildWsContext( req );
            const ok = await this.service.delete( taskMongoId, req, wsCtx );

            this.notificationHub.emit({
                eventKey: 'team:task.deleted',
                actor,
                audiences:[
                    {
                        mode: 'Role',
                        roleKey: 'admin',
                    },
                    {
                        mode:"Team",
                        teamCode: this.safeStr(existing.teamCode),
                    },
                    {
                        mode: 'Role',
                        roleKey: 'admin',
                    },
                    {
                        mode: 'Role',
                        roleKey: 'operator',
                    },
                    {
                        mode: 'Role',
                        roleKey: 'manager',
                    },
                ],
                target:{
                    actionKey: 'team:task.deleted',
                    category: 'teamTask',
                    module: 'teamManagement',
                    params: {
                        teamCode: this.safeStr(existing.teamCode), 
                        taskId: this.safeStr(existing.id ?? existing.taskMongoId),
                    },
                    refId: this.safeStr(existing.id ?? existing.taskMongoId),
                }
            })

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
    // Evidence remove (by storageKey)
    // ──────────────────────────────────────────────────────────────────────────

    public readonly removeEvidenceByStorageKey: RequestHandler = async ( req: Request, res: Response ): Promise<void> => {
        try {
            const taskMongoId = this.safeStr( req.params[ "taskMongoId" ] );
            const storageKey = this.safeStr( req.params[ "evidenceMongoId" ] ); // router param kept, treated as storageKey

            if ( !taskMongoId || !storageKey ) {
                ApiResponseBuilder.error( res, 400, "taskMongoId and storageKey are required" );
                return;
            }

            const wsCtx = await this.buildWsContext( req );
            const dto = await this.service.removeEvidenceByStorageKey( taskMongoId, storageKey, wsCtx );

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
    // Labels (missing methods)
    // ──────────────────────────────────────────────────────────────────────────

    public readonly setLabels: RequestHandler = async ( req: Request, res: Response ): Promise<void> => {
        try {
            const taskMongoId = this.safeStr( req.params[ "taskMongoId" ] );
            const labelsRaw = ( req.body as Record<string, unknown> )?.[ "labels" ];

            if ( !taskMongoId ) {
                ApiResponseBuilder.error( res, 400, "taskMongoId is required" );
                return;
            }

            const labels = this.parseJsonArray( labelsRaw ) ?? [];
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
            const labelsRaw = ( req.body as Record<string, unknown> )?.[ "labels" ];

            if ( !taskMongoId ) {
                ApiResponseBuilder.error( res, 400, "taskMongoId is required" );
                return;
            }

            const labels = this.parseJsonArray( labelsRaw ) ?? [];
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
            const labelsRaw = ( req.body as Record<string, unknown> )?.[ "labels" ];

            if ( !taskMongoId ) {
                ApiResponseBuilder.error( res, 400, "taskMongoId is required" );
                return;
            }

            const labels = this.parseJsonArray( labelsRaw ) ?? [];
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
    // Assigned members + captain (missing methods)
    // ──────────────────────────────────────────────────────────────────────────

    public readonly setAssignedMembers: RequestHandler = async ( req: Request, res: Response ): Promise<void> => {
        try {
            const taskMongoId = this.safeStr( req.params[ "taskMongoId" ] );
            const memberIdsRaw = ( req.body as Record<string, unknown> )?.[ "memberIds" ];

            if ( !taskMongoId ) {
                ApiResponseBuilder.error( res, 400, "taskMongoId is required" );
                return;
            }

            const memberIds = this.parseJsonArray( memberIdsRaw ) ?? [];
            const wsCtx = await this.buildWsContext( req );
            const dto = await this.service.setAssignedMembers( taskMongoId, memberIds, wsCtx );

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
            const memberIdsRaw = ( req.body as Record<string, unknown> )?.[ "memberIds" ];

            if ( !taskMongoId ) {
                ApiResponseBuilder.error( res, 400, "taskMongoId is required" );
                return;
            }

            const memberIds = this.parseJsonArray( memberIdsRaw ) ?? [];
            const wsCtx = await this.buildWsContext( req );
            const dto = await this.service.addAssignedMembers( taskMongoId, memberIds, wsCtx );

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
            const memberIdsRaw = ( req.body as Record<string, unknown> )?.[ "memberIds" ];

            if ( !taskMongoId ) {
                ApiResponseBuilder.error( res, 400, "taskMongoId is required" );
                return;
            }

            const memberIds = this.parseJsonArray( memberIdsRaw ) ?? [];
            const wsCtx = await this.buildWsContext( req );
            const dto = await this.service.removeAssignedMembers( taskMongoId, memberIds, wsCtx );

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
            const captainRaw = ( req.body as Record<string, unknown> )?.[ "captainUserId" ];

            if ( !taskMongoId ) {
                ApiResponseBuilder.error( res, 400, "taskMongoId is required" );
                return;
            }

            const captainUserId = this.isNullToken( captainRaw ) ? null : this.safeStr( captainRaw ) || null;

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
    // Location / Address / Notes (missing methods)
    // ──────────────────────────────────────────────────────────────────────────

    public readonly setLocation: RequestHandler = async ( req: Request, res: Response ): Promise<void> => {
        try {
            const taskMongoId = this.safeStr( req.params[ "taskMongoId" ] );
            const locationRaw = ( req.body as Record<string, unknown> )?.[ "location" ];

            if ( !taskMongoId ) {
                ApiResponseBuilder.error( res, 400, "taskMongoId is required" );
                return;
            }

            const wsCtx = await this.buildWsContext( req );

            // null token clears, otherwise parse object
            const input: UpdateTeamTaskInput = {};
            if ( this.isNullToken( locationRaw ) ) input.location = null;
            else {
                const parsed = this.parseJsonObj<GeoLocation>( locationRaw );
                if ( !parsed ) {
                    ApiResponseBuilder.error( res, 400, "Invalid location payload" );
                    return;
                }
                input.location = parsed;
            }

            const dto = await this.service.update( taskMongoId, input, wsCtx );
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
            const addressRaw = ( req.body as Record<string, unknown> )?.[ "address" ];

            if ( !taskMongoId ) {
                ApiResponseBuilder.error( res, 400, "taskMongoId is required" );
                return;
            }

            const wsCtx = await this.buildWsContext( req );

            const input: UpdateTeamTaskInput = {};
            if ( this.isNullToken( addressRaw ) ) input.address = null;
            else {
                const parsed = this.parseJsonObj<Address>( addressRaw );
                if ( !parsed ) {
                    ApiResponseBuilder.error( res, 400, "Invalid address payload" );
                    return;
                }
                input.address = parsed;
            }

            const dto = await this.service.update( taskMongoId, input, wsCtx );
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

            const notes = this.isNullToken( notesRaw ) ? null : this.safeStr( notesRaw ) || null;

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
    // Audit CRUD (missing methods)
    // ──────────────────────────────────────────────────────────────────────────

    public readonly getAudit: RequestHandler = async ( req: Request, res: Response ): Promise<void> => {
        try {
            const taskMongoId = this.safeStr( req.params[ "taskMongoId" ] );
            if ( !taskMongoId ) {
                ApiResponseBuilder.error( res, 400, "taskMongoId is required" );
                return;
            }

            const dto = await this.service.getByMongoId( taskMongoId, "minimal" );
            if ( !dto ) {
                ApiResponseBuilder.error( res, 404, "TeamTask not found" );
                return;
            }

            ApiResponseBuilder.ok( res, "other", { audit: dto.audit ?? null }, "Audit loaded" );
            return;
        } catch ( err: unknown ) {
            ApiResponseBuilder.error( res, 500, err instanceof Error ? err.message : "Internal error" );
            return;
        }
    };

    public readonly setAudit: RequestHandler = async ( req: Request, res: Response ): Promise<void> => {
        try {
            const taskMongoId = this.safeStr( req.params[ "taskMongoId" ] );
            const auditRaw = ( req.body as Record<string, unknown> )?.[ "audit" ];

            if ( !taskMongoId ) {
                ApiResponseBuilder.error( res, 400, "taskMongoId is required" );
                return;
            }

            const wsCtx = await this.buildWsContext( req );

            const input: UpdateTeamTaskInput = {};
            if ( this.isNullToken( auditRaw ) ) input.audit = null;
            else {
                const parsed = this.parseJsonObj<TaskAuditMeta>( auditRaw );
                if ( !parsed ) {
                    ApiResponseBuilder.error( res, 400, "Invalid audit payload" );
                    return;
                }
                input.audit = parsed;
            }

            const updated = await this.service.update( taskMongoId, input, wsCtx );
            if ( !updated ) {
                ApiResponseBuilder.error( res, 404, "TeamTask not found" );
                return;
            }

            ApiResponseBuilder.ok( res, "teamTask", updated, "Audit set" );
            return;
        } catch ( err: unknown ) {
            ApiResponseBuilder.error( res, 500, err instanceof Error ? err.message : "Internal error" );
            return;
        }
    };

    public readonly patchAudit: RequestHandler = async ( req: Request, res: Response ): Promise<void> => {
        try {
            const taskMongoId = this.safeStr( req.params[ "taskMongoId" ] );
            const patchRaw = ( req.body as Record<string, unknown> )?.[ "patch" ];

            if ( !taskMongoId ) {
                ApiResponseBuilder.error( res, 400, "taskMongoId is required" );
                return;
            }

            const dto = await this.service.getByMongoId( taskMongoId, "minimal" );
            if ( !dto ) {
                ApiResponseBuilder.error( res, 404, "TeamTask not found" );
                return;
            }

            const baseAudit: TaskAuditMeta = dto.audit ?? {};
            const patchRecord = this.ensurePatchRecord( patchRaw );

            // ✅ FIX: patchObj does not require Record constraint anymore
            const merged = this.patchObj<TaskAuditMeta>( baseAudit, patchRecord as unknown as Partial<TaskAuditMeta> );

            const wsCtx = await this.buildWsContext( req, dto );
            const updated = await this.service.update( taskMongoId, { audit: merged }, wsCtx );

            if ( !updated ) {
                ApiResponseBuilder.error( res, 404, "TeamTask not found" );
                return;
            }

            ApiResponseBuilder.ok( res, "teamTask", updated, "Audit patched" );
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
            const updated = await this.service.update( taskMongoId, { audit: null }, wsCtx );

            if ( !updated ) {
                ApiResponseBuilder.error( res, 404, "TeamTask not found" );
                return;
            }

            ApiResponseBuilder.ok( res, "teamTask", updated, "Audit cleared" );
            return;
        } catch ( err: unknown ) {
            ApiResponseBuilder.error( res, 500, err instanceof Error ? err.message : "Internal error" );
            return;
        }
    };

    // ──────────────────────────────────────────────────────────────────────────
    // Timing CRUD (missing methods)
    // ──────────────────────────────────────────────────────────────────────────

    public readonly getTiming: RequestHandler = async ( req: Request, res: Response ): Promise<void> => {
        try {
            const taskMongoId = this.safeStr( req.params[ "taskMongoId" ] );
            if ( !taskMongoId ) {
                ApiResponseBuilder.error( res, 400, "taskMongoId is required" );
                return;
            }

            const dto = await this.service.getByMongoId( taskMongoId, "minimal" );
            if ( !dto ) {
                ApiResponseBuilder.error( res, 404, "TeamTask not found" );
                return;
            }

            ApiResponseBuilder.ok( res, "other", { timing: dto.timing ?? null }, "Timing loaded" );
            return;
        } catch ( err: unknown ) {
            ApiResponseBuilder.error( res, 500, err instanceof Error ? err.message : "Internal error" );
            return;
        }
    };

    public readonly setTiming: RequestHandler = async ( req: Request, res: Response ): Promise<void> => {
        try {
            const taskMongoId = this.safeStr( req.params[ "taskMongoId" ] );
            const timingRaw = ( req.body as Record<string, unknown> )?.[ "timing" ];

            if ( !taskMongoId ) {
                ApiResponseBuilder.error( res, 400, "taskMongoId is required" );
                return;
            }

            const wsCtx = await this.buildWsContext( req );

            const input: UpdateTeamTaskInput = {};
            if ( this.isNullToken( timingRaw ) ) input.timing = null;
            else {
                const parsed = this.parseJsonObj<TaskTiming>( timingRaw );
                if ( !parsed ) {
                    ApiResponseBuilder.error( res, 400, "Invalid timing payload" );
                    return;
                }
                input.timing = parsed;
            }

            const updated = await this.service.update( taskMongoId, input, wsCtx );
            if ( !updated ) {
                ApiResponseBuilder.error( res, 404, "TeamTask not found" );
                return;
            }

            ApiResponseBuilder.ok( res, "teamTask", updated, "Timing set" );
            return;
        } catch ( err: unknown ) {
            ApiResponseBuilder.error( res, 500, err instanceof Error ? err.message : "Internal error" );
            return;
        }
    };

    public readonly patchTiming: RequestHandler = async ( req: Request, res: Response ): Promise<void> => {
        try {
            const taskMongoId = this.safeStr( req.params[ "taskMongoId" ] );
            const patchRaw = ( req.body as Record<string, unknown> )?.[ "patch" ];

            if ( !taskMongoId ) {
                ApiResponseBuilder.error( res, 400, "taskMongoId is required" );
                return;
            }

            const dto = await this.service.getByMongoId( taskMongoId, "minimal" );
            if ( !dto ) {
                ApiResponseBuilder.error( res, 404, "TeamTask not found" );
                return;
            }

            const baseTiming: TaskTiming = dto.timing ?? {};
            const patchRecord = this.ensurePatchRecord( patchRaw );

            const merged = this.patchObj<TaskTiming>( baseTiming, patchRecord as unknown as Partial<TaskTiming> );

            const wsCtx = await this.buildWsContext( req, dto );
            const updated = await this.service.update( taskMongoId, { timing: merged }, wsCtx );

            if ( !updated ) {
                ApiResponseBuilder.error( res, 404, "TeamTask not found" );
                return;
            }

            ApiResponseBuilder.ok( res, "teamTask", updated, "Timing patched" );
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
            const updated = await this.service.update( taskMongoId, { timing: null }, wsCtx );

            if ( !updated ) {
                ApiResponseBuilder.error( res, 404, "TeamTask not found" );
                return;
            }

            ApiResponseBuilder.ok( res, "teamTask", updated, "Timing cleared" );
            return;
        } catch ( err: unknown ) {
            ApiResponseBuilder.error( res, 500, err instanceof Error ? err.message : "Internal error" );
            return;
        }
    };

    // ──────────────────────────────────────────────────────────────────────────
    // SLA (legacy name) -> deadlinePolicy (missing method)
    // ──────────────────────────────────────────────────────────────────────────

    public readonly setSla: RequestHandler = async ( req: Request, res: Response ): Promise<void> => {
        try {
            const taskMongoId = this.safeStr( req.params[ "taskMongoId" ] );
            const slaRaw = ( req.body as Record<string, unknown> )?.[ "sla" ];

            if ( !taskMongoId ) {
                ApiResponseBuilder.error( res, 400, "taskMongoId is required" );
                return;
            }

            const wsCtx = await this.buildWsContext( req );

            // compat shim: "sla" means deadlinePolicy in model/service
            const input: UpdateTeamTaskInput = {};

            if ( this.isNullToken( slaRaw ) ) {
                input.deadlinePolicy = null;
            } else {
                const parsed = this.parseJsonObj<TaskDeadlinePolicy>( slaRaw );
                if ( !parsed ) {
                    ApiResponseBuilder.error( res, 400, "Invalid sla payload" );
                    return;
                }
                input.deadlinePolicy = parsed;
            }

            const updated = await this.service.update( taskMongoId, input, wsCtx );
            if ( !updated ) {
                ApiResponseBuilder.error( res, 404, "TeamTask not found" );
                return;
            }

            ApiResponseBuilder.ok( res, "teamTask", updated, "SLA updated (deadlinePolicy)" );
            return;
        } catch ( err: unknown ) {
            ApiResponseBuilder.error( res, 500, err instanceof Error ? err.message : "Internal error" );
            return;
        }
    };

    // ──────────────────────────────────────────────────────────────────────────
    // Users (existing + router alias)
    // ──────────────────────────────────────────────────────────────────────────

    public readonly getAssignedMemberUsernames: RequestHandler = async (
        req: Request,
        res: Response,
        _next: NextFunction
    ): Promise<void> => {
        try {
            const taskMongoId = this.safeStr( req.params[ "taskMongoId" ] );
            if ( !taskMongoId ) {
                ApiResponseBuilder.error( res, 400, "taskMongoId is required" );
                return;
            }

            // ✅ service method (from your service code): getassignedMember (singular)
            const usernames = await this.service.getassignedMembers( taskMongoId );

            ApiResponseBuilder.ok( res, "other", { usernames }, "Assigned member usernames loaded" );
            return;
        } catch ( err: unknown ) {
            ApiResponseBuilder.error( res, 500, err instanceof Error ? err.message : "Internal error" );
            return;
        }
    };

    // ✅ Router wants: this.ctrl.getAssignedMembers
    // ✅ No wrapper, no missing 'next', no extra call stack
    public readonly getAssignedMembers: RequestHandler = this.getAssignedMemberUsernames;

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

            ApiResponseBuilder.ok( res, "other", { taskUsers: result }, "Task users loaded" );
            return;
        } catch ( err: unknown ) {
            ApiResponseBuilder.error( res, 500, err instanceof Error ? err.message : "Internal error" );
            return;
        }
    };
}
