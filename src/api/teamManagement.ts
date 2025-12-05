// Path: src/api/teamManagement.ts

import dotenv from "dotenv";
import express, { Request, Response, Router } from "express";
import { Types } from "mongoose";

import { PaginationMeta, FileMetaBase } from "../types/api-message";
import { ApiResponseBuilder } from "../utils/api-combiner.builder";
import {
    ITeamManagement,
    TeamManagementModel,
    TaskEvidence,
    AssignedTask,
    TeamDomain
} from "../models/teamManagement.model";
import FileUploader from "../utils/file-uploader.helper";
import { UserModel, IUser } from "../models/user.model";

dotenv.config();

/**
 * TeamManagement
 * ---------------
 * Class-based router encapsulating:
 *
 *   - Team CRUD (create, update, delete, get all, get all team total, get by ID)
 *   - Task assignment and evidence metadata attachment
 *   - Thin upload endpoints for:
 *       • Team logo
 *       • Task evidence files
 *
 * Architectural rules:
 *   - JSON routes only deal with JSON payloads (no Multer here).
 *   - File uploads are handled only via `/upload/*` endpoints, which:
 *       1) Call `FileUploader.handleUpload(...)`.
 *       2) Return `FileMetaBase[]` to FE.
 *   - FE is responsible for:
 *       1) Calling upload endpoint (FormData, field: "files").
 *       2) Receiving `FileMetaBase[]`.
 *       3) Building `TaskEvidence` JSON (with storageKey/url/fileMeta).
 *       4) Sending that JSON to `/create`, `/update`, or `/evidence/attach`.
 */
export default class TeamManagement {

    /**
     * Base public URL root (relative) for team uploads.
     * FileUploader writes under `/public/uploads`, so FE URLs are typically:
     *   `${API_BASE}/uploads/team-management/...`
     *
     * We use this constant purely as a convention reference for FE.
     */
    private readonly PUBLIC_UPLOAD_URL_ROOT: string = "uploads/team-management";

    private router: express.Router;

    // ─────────────────────────────────────────────
    // Helpers – domain validation
    // ─────────────────────────────────────────────

    /**
     * Runtime validator for TeamDomain values.
     * Ensures we never count on arbitrary strings.
     */
    private readonly ALLOWED_TEAM_DOMAINS: TeamDomain[] = [
        "sales",
        "development",
        "support",
        "operations",
        "marketing",
        "finance",
        "other",
    ];

    private isValidTeamDomain( domain: string ): domain is TeamDomain {
        return this.ALLOWED_TEAM_DOMAINS.includes( domain as TeamDomain );
    }

    public constructor () {
        this.router = express.Router();

        // Core team operations (JSON only – no file upload here)
        this.registerCreateTeam();               // POST   /create
        this.registerGetAllTeams();              // GET    /all
        this.registerGetTeamById();              // GET    /:teamId
        this.registerUpdateTeam();               // PATCH  /update/:teamId
        this.registerAssignTask();               // POST   /assign-task/:teamId
        this.registerAttachEvidenceMeta();       // POST   /evidence/attach/:teamId/:taskId
        this.registerDeleteTeam();               // DELETE /delete/:teamId

        // Thin wrappers around FileUploader – file upload only
        this.registerUploadTeamLogo();           // POST   /upload/logo/:teamId
        this.registerUploadTaskEvidence();       // POST   /upload/evidence/:teamId/:taskId

        // Stats / analytics routes (totals)
        this.registerGetAllTeamTotals();          // GET /stats/teams-total
        this.registerGetTeamTotalByDomain();      // GET /stats/teams-total/domain/:domain

        // User membership analytics (global)
        this.registerUsersWithoutAnyTeam();           // GET    /users/no-team
        this.registerUsersWithoutAnyTeamCount();      // GET    /users/no-team/count
        this.registerUsersInAnyTeam();                // GET    /users/in-teams
        this.registerUsersInAnyTeamCount();           // GET    /users/in-teams/count

        // User membership analytics (domain-specific)
        this.registerUsersWithoutTeamByDomain();      // GET    /users/no-team/domain/:domain
        this.registerUsersWithoutTeamByDomainCount(); // GET    /users/no-team/domain/:domain/count
        this.registerUsersInTeamByDomain();           // GET    /users/in-teams/domain/:domain
        this.registerUsersInTeamByDomainCount();      // GET    /users/in-teams/domain/:domain/count


    }

    public get route(): Router {
        return this.router;
    }

    // ─────────────────────────────────────────────
    // Helpers (IDs, Users, Evidence mapping)
    // ─────────────────────────────────────────────

    /**
     * Generates a human and machine-friendly team identity:
     *   PROPEASE-TEAM-YYYYMMDD-HHMMSS-sss-RANDOM-CHECKSUM
     */
    private generateTeamIdentity(): string {
        const PREFIX = "PROPEASE-TEAM";
        const now = new Date();

        const year = now.getFullYear();
        const month = String( now.getMonth() + 1 ).padStart( 2, "0" );
        const day = String( now.getDate() ).padStart( 2, "0" );
        const hours = String( now.getHours() ).padStart( 2, "0" );
        const minutes = String( now.getMinutes() ).padStart( 2, "0" );
        const seconds = String( now.getSeconds() ).padStart( 2, "0" );
        const millis = String( now.getMilliseconds() ).padStart( 3, "0" );

        const dateBlock = `${ year }${ month }${ day }`;
        const timeBlock = `${ hours }${ minutes }${ seconds }-${ millis }`;

        const SAFE_CHARS = "ABCDEFGHJKLMNPQRTUVWXYZ2346789";
        const entropyLength = 6;

        const entropy = Array.from( { length: entropyLength } )
            .map(
                () =>
                    SAFE_CHARS[ Math.floor( Math.random() * SAFE_CHARS.length ) ]
            )
            .join( "" );

        const seed = `${ dateBlock }${ timeBlock }${ entropy }`;
        let hash = 0;
        for ( let i = 0; i < seed.length; i++ ) {
            hash = ( hash * 31 + seed.charCodeAt( i ) ) % 9973;
        }

        const c1 = SAFE_CHARS[ hash % SAFE_CHARS.length ];
        const c2 = SAFE_CHARS[ ( hash >> 3 ) % SAFE_CHARS.length ];

        const checksum = `${ c1 }${ c2 }`;
        return `${ PREFIX }-${ dateBlock }-${ timeBlock }-${ entropy }-${ checksum }`;
    }

    private extractUserIdsFromArray( input: unknown ): Types.ObjectId[] {
        if ( !Array.isArray( input ) ) return [];
        return ( input as any[] )
            .map( ( u: any ) => {
                const id = u?._id ?? u?.id ?? u?.userId;
                if ( !id ) return undefined;
                try {
                    return new Types.ObjectId( id );
                } catch {
                    return undefined;
                }
            } )
            .filter( ( x ): x is Types.ObjectId => x instanceof Types.ObjectId );
    }

    private extractUserId( input: unknown ): Types.ObjectId | undefined {
        if ( !input || typeof input !== "object" ) return undefined;
        const anyU = input as any;
        const id = anyU._id ?? anyU.id ?? anyU.userId;
        if ( !id ) return undefined;
        try {
            return new Types.ObjectId( id );
        } catch {
            return undefined;
        }
    }

    private safeJsonParse<T>( value: unknown ): T | undefined {
        if ( typeof value !== "string" || !value.trim() ) return undefined;
        try {
            return JSON.parse( value ) as T;
        } catch {
            return undefined;
        }
    }

    // ─────────────────────────────────────────────
    // Helpers – user membership vs teams
    // ─────────────────────────────────────────────

    /**
     * Collects distinct user IDs that belong to any team, optionally
     * restricted by TeamDomain.
     *
     * - Includes both members[] and captain.
     * - Returns a de-duplicated array of ObjectId.
     */
    private async collectTeamUserIdsByDomain(
        domain?: TeamDomain
    ): Promise<Types.ObjectId[]> {
        const matchStage: Record<string, unknown> = {};

        if ( domain ) {
            matchStage[ "domain" ] = domain;
        }

        const pipeline: any[] = [];

        if ( domain ) {
            pipeline.push( { $match: matchStage } );
        }

        pipeline.push(
            {
                $project: {
                    allUserIds: {
                        $setUnion: [
                            "$members",
                            { $cond: [ { $ifNull: [ "$captain", null ] }, [ "$captain" ], [] ] },
                        ],
                    },
                },
            },
            { $unwind: "$allUserIds" },
            {
                $group: {
                    _id: "$allUserIds",
                },
            }
        );

        const rows: Array<{ _id: Types.ObjectId; }> =
            await TeamManagementModel.aggregate( pipeline ).exec();

        return rows.map( r => r._id );
    }


    /**
     * Build a TaskEvidence from FileMetaBase and extra metadata sent by FE.
     *
     * Expected FE flow:
     *   1) FE calls upload endpoint (logo or evidence) → gets `FileMetaBase[]`.
     *   2) FE constructs an object like:
     *        {
     *          name: string;
     *          storageKey: "uploads/....",   // relative to /public
     *          url: "/uploads/....",        // public URL
     *          uploadedById: string;
     *          uploadedByName: string;
     *          uploadedAt: ISO string;
     *          fileMeta: FileMetaBase;
     *        }
     *   3) FE sends this JSON as `teamLogo` or as an entry inside `evidences` array.
     */
    private buildEvidenceFromMeta( meta: any ): TaskEvidence {
        const fileMeta = meta?.fileMeta as FileMetaBase | undefined;

        const storageKey: string = meta?.storageKey ?? "";
        const url: string = meta?.url ?? storageKey;

        const evidence: TaskEvidence = {
            name: meta?.name ?? fileMeta?.originalName ?? "evidence",
            storageKey,
            url,
            uploadedById: meta?.uploadedById,
            uploadedByName: meta?.uploadedByName,
            uploadedAt: meta?.uploadedAt ?? new Date().toISOString(),
            file: fileMeta
                ? {
                    originalName: fileMeta.originalName,
                    storedName: fileMeta.storedName,
                    extension: fileMeta.extension,
                    mimeType: fileMeta.mimeType,
                    sizeBytes: fileMeta.sizeBytes,
                }
                : undefined,
        } as TaskEvidence;

        return evidence;
    }

    // ─────────────────────────────────────────────
    // POST /create  (JSON only)
    // ─────────────────────────────────────────────

    /**
     * Create a new team.
     *
     * FE expected flow for logo (if used):
     *   1) Upload logo via `POST /team-management/upload/logo/:teamId?` is NOT used here
     *      because teamId is generated server-side.
     *   2) For creation, typical pattern:
     *        - FE creates team without logo first,
     *        - then uploads logo and updates team with PATCH /update/:teamId.
     *
     * Request body (high level):
     *   {
     *     teamName: string;
     *     domain: string;
     *     description?: string;
     *     isActive?: boolean;
     *     members?: UserRef[];
     *     captain?: UserRef;
     *     assignTasks?: AssignedTaskDraft[];
     *     teamLogo?: EvidenceMetaJSON;  // optional, see buildEvidenceFromMeta
     *   }
     */
    private registerCreateTeam(): void {
        this.route.post(
            "/create",
            async ( req: Request, res: Response ): Promise<void> => {
                try {
                    const body = req.body;

                    const nowIso = new Date().toISOString();
                    const teamId = this.generateTeamIdentity();

                    const teamName: string = ( body.teamName ?? "" ).trim();
                    const domain: string = ( body.domain ?? "" ).trim();
                    const description: string = ( body.description ?? "" ).trim();
                    const isActive: boolean =
                        body.isActive === false || body.isActive === "false"
                            ? false
                            : true;

                    if ( !teamName || !domain ) {
                        ApiResponseBuilder.validationError(
                            res,
                            "Team name and domain are required for team creation"
                        );
                        return;
                    }

                    const rawMembers = body.members;
                    const rawCaptain = body.captain;
                    const rawTasks = body.assignTasks;
                    const rawTeamLogo = body.teamLogo; // evidence-like JSON

                    const memberIds = this.extractUserIdsFromArray( rawMembers );
                    const captainId = this.extractUserId( rawCaptain );


                    if ( !captainId ) {
                        ApiResponseBuilder.validationError(
                            res,
                            "Team captain is required"
                        );
                        return;
                    }

                    const assignTasks: AssignedTask[] = Array.isArray( rawTasks )
                        ? rawTasks.map( ( t: any ) => {
                            const assignedMembers = this.extractUserIdsFromArray(
                                t.assignedMembers
                            );
                            const assignedCaptain = this.extractUserId(
                                t.assignedTaskCaptain
                            );

                            const task: AssignedTask = {
                                id: t.id,
                                name: t.name,
                                description: t.description ?? "",
                                location: t.location,
                                address: t.address,
                                assignedMembers,
                                assignedTaskCaptain: assignedCaptain as any,
                                status: t.status ?? "draft",
                                priority: t.priority ?? "medium",
                                plannedStartAt: t.plannedStartAt ?? "",
                                plannedEndAt: t.plannedEndAt ?? "",
                                completedAt: t.completedAt ?? "",
                                evidence: ( t.evidence ?? [] ) as TaskEvidence[],
                                notes: t.notes ?? "",
                            } as AssignedTask;

                            return task;
                        } )
                        : [];

                    // Optional logo as TaskEvidence JSON (FE must build it from upload response)
                    let teamLogo: TaskEvidence | undefined;
                    if ( rawTeamLogo ) {
                        teamLogo = this.buildEvidenceFromMeta( rawTeamLogo );
                    }

                    const doc: ITeamManagement = await TeamManagementModel.create( {
                        id: teamId,
                        teamName,
                        domain,
                        description,
                        members: memberIds,
                        captain: captainId,
                        memberTotal: memberIds.length,
                        assignTasks,
                        teamLogo,
                        createdAt: nowIso,
                        updatedAt: nowIso,
                        isActive,
                    } );

                    ApiResponseBuilder.ok(
                        res,
                        "team",
                        doc,
                        "Team created successfully"
                    );
                } catch ( error ) {
                    console.error(
                        "[Unexpected error occurred during team creation]:\n",
                        error
                    );
                    ApiResponseBuilder.internalError( res, error );
                }
            }
        );
    }

    // ─────────────────────────────────────────────
    // GET /all
    // ─────────────────────────────────────────────

    private registerGetAllTeams(): void {
        this.route.get(
            "/all",
            async ( req: Request, res: Response ): Promise<void> => {
                try {
                    const index: number = Number( req.query.index ?? 0 );
                    const limit: number = Number( req.query.limit ?? 10 );
                    const search: string = String( req.query.search ?? "" ).trim();
                    const domain: string = String( req.query.domain ?? "" ).trim();
                    const isActiveRaw = String( req.query.isActive ?? "" ).trim();

                    const filter: Record<string, unknown> = {};

                    if ( search ) {
                        filter[ "teamName" ] = { $regex: search, $options: "i" };
                    }

                    if ( domain ) {
                        filter[ "domain" ] = domain;
                    }

                    if ( isActiveRaw ) {
                        filter[ "isActive" ] = isActiveRaw === "false" ? false : true;
                    }

                    const safeIndex = Number.isFinite( index ) && index >= 0 ? index : 0;
                    const safeLimit =
                        Number.isFinite( limit ) && limit > 0 ? limit : 10;

                    const [ total, rows ] = await Promise.all( [
                        TeamManagementModel.countDocuments( filter ),
                        TeamManagementModel.find( filter )
                            .skip( safeIndex * safeLimit )
                            .limit( safeLimit )
                            .populate( "members" )
                            .populate( "captain" )
                            .lean<ITeamManagement>()
                            .exec() as unknown as ITeamManagement[],
                    ] );

                    const pagination: PaginationMeta = {
                        total,
                        index: safeIndex,
                        limit: safeLimit,
                    };

                    ApiResponseBuilder.ok(
                        res,
                        "teams",
                        rows,
                        "Teams fetched successfully",
                        { pagination }
                    );
                } catch ( error ) {
                    console.error( "[Error while fetching teams]:\n", error );
                    ApiResponseBuilder.internalError( res, error );
                }
            }
        );
    }

    // ─────────────────────────────────────────────
    // GET /:teamId
    // ─────────────────────────────────────────────

    private registerGetTeamById(): void {
        this.route.get(
            "/:teamId",
            async ( req: Request, res: Response ): Promise<void> => {
                try {
                    const teamId = String( req.params.teamId ?? "" ).trim();
                    if ( !teamId ) {
                        ApiResponseBuilder.validationError( res, "Team ID is required" );
                        return;
                    }

                    const team = await TeamManagementModel.findOne( { id: teamId } )
                        .populate( "members" )
                        .populate( "captain" )
                        .exec();

                    if ( !team ) {
                        ApiResponseBuilder.validationError(
                            res,
                            "Team not found for the provided ID"
                        );
                        return;
                    }

                    ApiResponseBuilder.ok(
                        res,
                        "team",
                        team,
                        "Team fetched successfully"
                    );
                } catch ( error ) {
                    console.error( "[Error while fetching team by ID]:\n", error );
                    ApiResponseBuilder.internalError( res, error );
                }
            }
        );
    }

    // ─────────────────────────────────────────────
    // PATCH /update/:teamId  (JSON only)
    // ─────────────────────────────────────────────

    /**
     * Update team core attributes, members, tasks and optional logo.
     *
     * Logo update FE flow:
     *   1) Upload logo with `/upload/logo/:teamId` → get `FileMetaBase[]`.
     *   2) FE builds `teamLogo` JSON: { storageKey, url, fileMeta, ... }.
     *   3) FE sends PATCH /update/:teamId with that `teamLogo`.
     */
    private registerUpdateTeam(): void {
        this.route.patch(
            "/update/:teamId",
            async ( req: Request, res: Response ): Promise<void> => {
                try {
                    const teamId = String( req.params.teamId ?? "" ).trim();
                    if ( !teamId ) {
                        ApiResponseBuilder.validationError( res, "Team ID is required" );
                        return;
                    }

                    const body = req.body;
                    const update: Partial<ITeamManagement> = {};

                    if ( typeof body.teamName === "string" ) {
                        update.teamName = body.teamName.trim();
                    }

                    if ( typeof body.domain === "string" && body.domain.trim() ) {
                        update.domain = body.domain.trim() as any;
                    }

                    if ( typeof body.description === "string" ) {
                        update.description = body.description.trim();
                    }

                    if ( typeof body.isActive !== "undefined" ) {
                        update.isActive =
                            body.isActive === false || body.isActive === "false"
                                ? false
                                : true;
                    }

                    // Members and captain
                    if ( typeof body.members !== "undefined" ) {
                        const memberIds = this.extractUserIdsFromArray( body.members );
                        update.members = memberIds as any;
                        update.memberTotal = memberIds.length;
                    }

                    if ( typeof body.captain !== "undefined" ) {
                        const captainId = this.extractUserId( body.captain );
                        if ( captainId ) {
                            update.captain = captainId as any;
                        }
                    }

                    // Tasks patch (full replace)
                    if ( Array.isArray( body.assignTasks ) ) {
                        update.assignTasks = body.assignTasks.map( ( t: any ) => {
                            const assignedMembers = this.extractUserIdsFromArray(
                                t.assignedMembers
                            );
                            const assignedCaptain = this.extractUserId(
                                t.assignedTaskCaptain
                            );

                            const task: AssignedTask = {
                                id: t.id,
                                name: t.name,
                                description: t.description ?? "",
                                location: t.location,
                                address: t.address,
                                assignedMembers,
                                assignedTaskCaptain: assignedCaptain as any,
                                status: t.status ?? "draft",
                                priority: t.priority ?? "medium",
                                plannedStartAt: t.plannedStartAt ?? "",
                                plannedEndAt: t.plannedEndAt ?? "",
                                completedAt: t.completedAt ?? "",
                                evidence: ( t.evidence ?? [] ) as TaskEvidence[],
                                notes: t.notes ?? "",
                            } as AssignedTask;

                            return task;
                        } );
                    }

                    // Team logo patch (TaskEvidence JSON)
                    if ( body.teamLogo ) {
                        update.teamLogo = this.buildEvidenceFromMeta( body.teamLogo );
                    }

                    update.updatedAt = new Date().toISOString();

                    const updated = await TeamManagementModel.findOneAndUpdate(
                        { id: teamId },
                        { $set: update },
                        { new: true }
                    )
                        .populate( "members" )
                        .populate( "captain" )
                        .exec();

                    if ( !updated ) {
                        ApiResponseBuilder.validationError(
                            res,
                            "Team not found for update"
                        );
                        return;
                    }

                    ApiResponseBuilder.ok(
                        res,
                        "team",
                        updated,
                        "Team updated successfully"
                    );
                } catch ( error ) {
                    console.error( "[Unexpected error during team update]:\n", error );
                    ApiResponseBuilder.internalError( res, error );
                }
            }
        );
    }

    // ─────────────────────────────────────────────
    // POST /assign-task/:teamId  (JSON)
    // ─────────────────────────────────────────────

    private registerAssignTask(): void {
        this.route.post(
            "/assign-task/:teamId",
            async ( req: Request, res: Response ): Promise<void> => {
                try {
                    const teamId = String( req.params.teamId ?? "" ).trim();
                    if ( !teamId ) {
                        ApiResponseBuilder.validationError( res, "Team ID is required" );
                        return;
                    }

                    const bodyTask = req.body?.task;
                    if ( !bodyTask ) {
                        ApiResponseBuilder.validationError(
                            res,
                            "Task payload is required"
                        );
                        return;
                    }

                    const anyTask = bodyTask as any;

                    if ( !anyTask.name ) {
                        ApiResponseBuilder.validationError(
                            res,
                            "Task name is required"
                        );
                        return;
                    }

                    const taskId: string = anyTask.id || `TASK-${ Date.now() }`;
                    const assignedMembers = this.extractUserIdsFromArray(
                        anyTask.assignedMembers
                    );
                    const assignedCaptain = this.extractUserId(
                        anyTask.assignedTaskCaptain
                    );

                    const newTask: AssignedTask = {
                        id: taskId,
                        name: anyTask.name,
                        description: anyTask.description ?? "",
                        location: anyTask.location,
                        address: anyTask.address,
                        assignedMembers,
                        assignedTaskCaptain: assignedCaptain as any,
                        status: anyTask.status ?? "draft",
                        priority: anyTask.priority ?? "medium",
                        plannedStartAt: anyTask.plannedStartAt ?? "",
                        plannedEndAt: anyTask.plannedEndAt ?? "",
                        completedAt: anyTask.completedAt ?? "",
                        evidence: ( anyTask.evidence ?? [] ) as TaskEvidence[],
                        notes: anyTask.notes ?? "",
                    } as AssignedTask;

                    const updated = await TeamManagementModel.findOneAndUpdate(
                        { id: teamId },
                        {
                            $push: { assignTasks: newTask },
                            $set: { updatedAt: new Date().toISOString() },
                        },
                        { new: true }
                    )
                        .populate( "members" )
                        .populate( "captain" )
                        .exec();

                    if ( !updated ) {
                        ApiResponseBuilder.validationError(
                            res,
                            "Team not found for assign-task"
                        );
                        return;
                    }

                    ApiResponseBuilder.ok(
                        res,
                        "team",
                        updated,
                        "Task assigned successfully"
                    );
                } catch ( error ) {
                    console.error( "[Error during assign-task]:\n", error );
                    ApiResponseBuilder.internalError( res, error );
                }
            }
        );
    }

    // ─────────────────────────────────────────────
    // POST /evidence/attach/:teamId/:taskId  (JSON – metadata only)
    // ─────────────────────────────────────────────

    /**
     * Attach evidence metadata (TaskEvidence) to a given task.
     *
     * FE flow:
     *   1) Call `/upload/evidence/:teamId/:taskId` with FormData → get FileMetaBase[].
     *   2) Build `evidences` JSON array (each item mapped via buildEvidenceFromMeta contract).
     *   3) Call this endpoint with `{ evidences: EvidenceMetaJSON[] }`.
     */
    private registerAttachEvidenceMeta(): void {
        this.route.post(
            "/evidence/attach/:teamId/:taskId",
            async ( req: Request, res: Response ): Promise<void> => {
                try {
                    const teamId = String( req.params.teamId ?? "" ).trim();
                    const taskId = String( req.params.taskId ?? "" ).trim();

                    if ( !teamId || !taskId ) {
                        ApiResponseBuilder.validationError(
                            res,
                            "Team ID and Task ID are required"
                        );
                        return;
                    }

                    const evidencesRaw = req.body?.evidences;
                    if ( !Array.isArray( evidencesRaw ) || evidencesRaw.length === 0 ) {
                        ApiResponseBuilder.validationError(
                            res,
                            "At least one evidence metadata entry is required"
                        );
                        return;
                    }

                    const evidenceDocs: TaskEvidence[] = evidencesRaw.map( ( meta: any ) =>
                        this.buildEvidenceFromMeta( meta )
                    );

                    const updated = await TeamManagementModel.findOneAndUpdate(
                        { id: teamId, "assignTasks.id": taskId },
                        {
                            $push: { "assignTasks.$.evidence": { $each: evidenceDocs } },
                            $set: { updatedAt: new Date().toISOString() },
                        },
                        { new: true }
                    )
                        .populate( "members" )
                        .populate( "captain" )
                        .exec();

                    if ( !updated ) {
                        ApiResponseBuilder.validationError(
                            res,
                            "Team or task not found for evidence attach"
                        );
                        return;
                    }

                    ApiResponseBuilder.ok(
                        res,
                        "team",
                        updated,
                        "Evidence metadata attached successfully"
                    );
                } catch ( error ) {
                    console.error( "[Error during evidence attach]:\n", error );
                    ApiResponseBuilder.internalError( res, error );
                }
            }
        );
    }

    // ─────────────────────────────────────────────
    // DELETE /delete/:teamId
    // ─────────────────────────────────────────────

    private registerDeleteTeam(): void {
        this.route.delete(
            "/delete/:teamId",
            async ( req: Request, res: Response ): Promise<void> => {
                try {
                    const teamId = String( req.params.teamId ?? "" ).trim();
                    if ( !teamId ) {
                        ApiResponseBuilder.validationError( res, "Team ID is required" );
                        return;
                    }

                    const softRaw = String( req.query.soft ?? "true" ).toLowerCase();
                    const soft = softRaw !== "false" && softRaw !== "0";

                    if ( soft ) {
                        const updated = await TeamManagementModel.findOneAndUpdate(
                            { id: teamId },
                            {
                                $set: {
                                    isActive: false,
                                    updatedAt: new Date().toISOString(),
                                },
                            },
                            { new: true }
                        )
                            .populate( "members" )
                            .populate( "captain" )
                            .exec();

                        if ( !updated ) {
                            ApiResponseBuilder.validationError(
                                res,
                                "Team not found for soft delete"
                            );
                            return;
                        }

                        ApiResponseBuilder.ok(
                            res,
                            "team",
                            updated,
                            "Team deactivated (soft delete) successfully"
                        );
                        return;
                    }

                    const deleted = await TeamManagementModel.findOneAndDelete( {
                        id: teamId,
                    } ).exec();

                    if ( !deleted ) {
                        ApiResponseBuilder.validationError(
                            res,
                            "Team not found for hard delete"
                        );
                        return;
                    }

                    ApiResponseBuilder.ok(
                        res,
                        "team",
                        deleted,
                        "Team deleted permanently"
                    );
                } catch ( error ) {
                    console.error( "[Error during team delete]:\n", error );
                    ApiResponseBuilder.internalError( res, error );
                }
            }
        );
    }

    // ─────────────────────────────────────────────
    // FILE UPLOAD ROUTES – thin wrappers around FileUploader
    // ─────────────────────────────────────────────

    /**
     * POST /upload/logo/:teamId
     *
     * Purpose:
     *   - Accept one or more logo files (FormData field: "files").
     *   - Store them under:
     *       `/public/uploads/team-management/<teamId>/logo`
     *   - Return `FileMetaBase[]` to FE as `data.files`.
     *
     * FE usage:
     *   1) const form = new FormData();
     *      form.append('files', file);
     *   2) POST → /team-management/upload/logo/:teamId
     *   3) Response:
     *        data.files: FileMetaBase[]
     *   4) Build TaskEvidence JSON using:
     *        - fileMeta: FileMetaBase
     *        - storageKey: `uploads/team-management/${teamId}/logo/${storedName}`
     *        - url: `/uploads/team-management/${teamId}/logo/${storedName}`
     *   5) PATCH /team-management/update/:teamId with `teamLogo`.
     */
    private registerUploadTeamLogo(): void {
        this.route.post(
            "/upload/logo/:teamId",
            async ( req: Request, res: Response ): Promise<void> => {
                try {
                    const teamId = String( req.params.teamId ?? "" ).trim();
                    if ( !teamId ) {
                        ApiResponseBuilder.validationError(
                            res,
                            "Team ID is required for logo upload"
                        );
                        return;
                    }

                    const subPath = `team-management/${ teamId }/logo`;

                    const files: FileMetaBase[] = await FileUploader.handleUpload(
                        subPath,
                        "files",
                        req
                    );

                    if ( !Array.isArray( files ) || files.length === 0 ) {
                        ApiResponseBuilder.validationError(
                            res,
                            "No files were uploaded for team logo"
                        );
                        return;
                    }

                    ApiResponseBuilder.ok(
                        res,
                        "files",
                        files,
                        "Team logo uploaded successfully"
                    );
                } catch ( error ) {
                    console.error( "[Error during team logo upload]:\n", error );
                    ApiResponseBuilder.internalError( res, error );
                }
            }
        );
    }

    /**
     * POST /upload/evidence/:teamId/:taskId
     *
     * Purpose:
     *   - Accept one or more evidence files for a specific task
     *     (FormData field: "files").
     *   - Store them under:
     *       `/public/uploads/team-management/<teamId>/tasks/<taskId>/evidence`
     *   - Return `FileMetaBase[]` to FE as `data.files`.
     *
     * FE usage:
     *   1) const form = new FormData();
     *      files.forEach(f => form.append('files', f));
     *   2) POST → /team-management/upload/evidence/:teamId/:taskId
     *   3) Response:
     *        data.files: FileMetaBase[]
     *   4) Build `evidences: EvidenceMetaJSON[]` with storageKey/url/fileMeta per file.
     *   5) POST /team-management/evidence/attach/:teamId/:taskId with JSON.
     */
    private registerUploadTaskEvidence(): void {
        this.route.post(
            "/upload/evidence/:teamId/:taskId",
            async ( req: Request, res: Response ): Promise<void> => {
                try {
                    const teamId = String( req.params.teamId ?? "" ).trim();
                    const taskId = String( req.params.taskId ?? "" ).trim();

                    if ( !teamId || !taskId ) {
                        ApiResponseBuilder.validationError(
                            res,
                            "Team ID and Task ID are required for evidence upload"
                        );
                        return;
                    }

                    const subPath = `team-management/${ teamId }/tasks/${ taskId }/evidence`;

                    const files: FileMetaBase[] = await FileUploader.handleUpload(
                        subPath,
                        "files",
                        req
                    );

                    if ( !Array.isArray( files ) || files.length === 0 ) {
                        ApiResponseBuilder.validationError(
                            res,
                            "No files were uploaded for task evidence"
                        );
                        return;
                    }

                    ApiResponseBuilder.ok(
                        res,
                        "files",
                        files,
                        "Task evidence uploaded successfully"
                    );
                } catch ( error ) {
                    console.error( "[Error during task evidence upload]:\n", error );
                    ApiResponseBuilder.internalError( res, error );
                }
            }
        );
    }


    // ─────────────────────────────────────────────
    // GET /stats/teams-total
    //   → Overall counts and per-domain breakdown
    // ─────────────────────────────────────────────

    /**
     * High-level statistics for all teams:
     *   - totalTeams:      all documents in TeamManagement
     *   - totalActive:     isActive === true
     *   - totalInactive:   isActive === false
     *   - domainTotals:    count per TeamDomain (ignores isActive)
     *
     * Intended for dashboards / admin analytics cards.
     */
    private registerGetAllTeamTotals(): void {
        this.route.get(
            "/stats/teams-total",
            async ( req: Request, res: Response ): Promise<void> => {
                try {
                    // 1) Basic aggregates
                    const [ totalTeams, totalActive, totalInactive ] = await Promise.all( [
                        TeamManagementModel.countDocuments( {} ).exec(),
                        TeamManagementModel.countDocuments( { isActive: true } ).exec(),
                        TeamManagementModel.countDocuments( { isActive: false } ).exec(),
                    ] );

                    // 2) Domain breakdown (simple loop over allowed domains)
                    const domainTotals: Record<TeamDomain, number> = {} as Record<
                        TeamDomain,
                        number
                    >;

                    for ( const domain of this.ALLOWED_TEAM_DOMAINS ) {
                        // Each count is independent; if you want performance,
                        // later we can replace with a single aggregation pipeline.
                        // For now, keep it explicit and clear.
                        // eslint-disable-next-line no-await-in-loop
                        const countForDomain: number = await TeamManagementModel.countDocuments(
                            { domain }
                        ).exec();

                        domainTotals[ domain ] = countForDomain;
                    }

                    ApiResponseBuilder.ok(
                        res,
                        "other",
                        {
                            totalTeams,
                            totalActive,
                            totalInactive,
                            domainTotals,
                        },
                        "Team totals fetched successfully"
                    );
                } catch ( error ) {
                    console.error( "[Error while fetching team totals]:\n", error );
                    ApiResponseBuilder.internalError( res, error );
                }
            }
        );
    }

    // ─────────────────────────────────────────────
    // GET /stats/teams-total/domain/:domain
    //   → Count only teams in one domain
    // ─────────────────────────────────────────────

    /**
     * Domain-specific statistics.
     *
     * Path params:
     *   :domain → one of TeamDomain:
     *              "sales" | "development" | "support" |
     *              "operations" | "marketing" | "finance" | "other"
     *
     * Optional query:
     *   ?active=true|false  (if you want only active or inactive)
     *   - If omitted, we return all + active breakdown in payload.
     */
    private registerGetTeamTotalByDomain(): void {
        this.route.get(
            "/stats/teams-total/domain/:domain",
            async ( req: Request, res: Response ): Promise<void> => {
                try {
                    const rawDomain: string = String( req.params.domain ?? "" ).trim().toLowerCase();

                    if ( !rawDomain || !this.isValidTeamDomain( rawDomain ) ) {
                        ApiResponseBuilder.validationError(
                            res,
                            "Invalid domain. Allowed values: sales, development, support, operations, marketing, finance, other."
                        );
                        return;
                    }

                    const domain: TeamDomain = rawDomain as TeamDomain;

                    // Optional filter: ?active=true|false
                    const activeQueryRaw: string = String( req.query.active ?? "" ).trim().toLowerCase();

                    const hasActiveFilter: boolean =
                        activeQueryRaw === "true" || activeQueryRaw === "false";

                    let totalTeams: number;
                    let totalActive: number;
                    let totalInactive: number;

                    if ( hasActiveFilter ) {
                        const activeValue: boolean = activeQueryRaw === "true";

                        // Only filtered total, rest as derived / secondary info
                        totalTeams = await TeamManagementModel.countDocuments( {
                            domain,
                            isActive: activeValue,
                        } ).exec();

                        // For clarity, we still include active/inactive counts
                        // without filter; this can be useful on FE.
                        [ totalActive, totalInactive ] = await Promise.all( [
                            TeamManagementModel.countDocuments( {
                                domain,
                                isActive: true,
                            } ).exec(),
                            TeamManagementModel.countDocuments( {
                                domain,
                                isActive: false,
                            } ).exec(),
                        ] );
                    } else {
                        // No ?active filter → full breakdown
                        [ totalTeams, totalActive, totalInactive ] = await Promise.all( [
                            TeamManagementModel.countDocuments( { domain } ).exec(),
                            TeamManagementModel.countDocuments( {
                                domain,
                                isActive: true,
                            } ).exec(),
                            TeamManagementModel.countDocuments( {
                                domain,
                                isActive: false,
                            } ).exec(),
                        ] );
                    }

                    ApiResponseBuilder.ok(
                        res,
                        "other",
                        {
                            domain,
                            totalTeams,
                            totalActive,
                            totalInactive,
                        },
                        "Team domain totals fetched successfully"
                    );
                } catch ( error ) {
                    console.error( "[Error while fetching team domain totals]:\n", error );
                    ApiResponseBuilder.internalError( res, error );
                }
            }
        );
    }


    // ─────────────────────────────────────────────
    // GET /users/no-team
    //   → Users not in any team (global, paginated)
    // ─────────────────────────────────────────────

    private registerUsersWithoutAnyTeam(): void {
        this.route.get(
            "/users/no-team",
            async ( req: Request, res: Response ): Promise<void> => {
                try {
                    const index: number = Number( req.query.index ?? 0 );
                    const limit: number = Number( req.query.limit ?? 10 );

                    const safeIndex = Number.isFinite( index ) && index >= 0 ? index : 0;
                    const safeLimit = Number.isFinite( limit ) && limit > 0 ? limit : 10;

                    // 1) Collect all user IDs that are in any team (any domain)
                    const teamUserIds: Types.ObjectId[] =
                        await this.collectTeamUserIdsByDomain();

                    // 2) Build filter: users whose _id is NOT in that list
                    const filter: Record<string, unknown> = {};
                    if ( teamUserIds.length > 0 ) {
                        filter[ "_id" ] = { $nin: teamUserIds };
                    }

                    const [ total, users ] = await Promise.all( [
                        UserModel.countDocuments( filter ).exec(),
                        UserModel.find( filter )
                            .skip( safeIndex * safeLimit )
                            .limit( safeLimit )
                            .lean<IUser>()
                            .exec() as unknown as IUser[],
                    ] );

                    const pagination: PaginationMeta = {
                        total,
                        index: safeIndex,
                        limit: safeLimit,
                    };

                    ApiResponseBuilder.ok(
                        res,
                        "users",
                        users,
                        "Users without any team fetched successfully",
                        { pagination },
                    );
                }
                catch ( error ) {
                    console.error( "[Error while fetching users without team]:\n", error );
                    ApiResponseBuilder.internalError( res, error );
                }
            }
        );
    }

    // ─────────────────────────────────────────────
    // GET /users/no-team/count
    //   → Total count only (users not in any team)
    // ─────────────────────────────────────────────

    private registerUsersWithoutAnyTeamCount(): void {
        this.route.get(
            "/users/no-team/count",
            async ( _req: Request, res: Response ): Promise<void> => {
                try {
                    const teamUserIds: Types.ObjectId[] =
                        await this.collectTeamUserIdsByDomain();

                    const filter: Record<string, unknown> = {};
                    if ( teamUserIds.length > 0 ) {
                        filter[ "_id" ] = { $nin: teamUserIds };
                    }

                    const total: number = await UserModel.countDocuments( filter ).exec();

                    ApiResponseBuilder.ok(
                        res,
                        "other",
                        {},
                        "Total users without any team fetched successfully",
                        { pagination: { total } }
                    );
                }
                catch ( error ) {
                    console.error( "[Error while counting users without team]:\n", error );
                    ApiResponseBuilder.internalError( res, error );
                }
            }
        );
    }

    // ─────────────────────────────────────────────
    // GET /users/in-teams
    //   → Users that belong to at least one team (global, paginated)
    // ─────────────────────────────────────────────

    private registerUsersInAnyTeam(): void {
        this.route.get(
            "/users/in-teams",
            async ( req: Request, res: Response ): Promise<void> => {
                try {
                    const index: number = Number( req.query.index ?? 0 );
                    const limit: number = Number( req.query.limit ?? 10 );

                    const safeIndex = Number.isFinite( index ) && index >= 0 ? index : 0;
                    const safeLimit = Number.isFinite( limit ) && limit > 0 ? limit : 10;

                    const teamUserIds: Types.ObjectId[] =
                        await this.collectTeamUserIdsByDomain();

                    if ( teamUserIds.length === 0 ) {
                        const pagination: PaginationMeta = {
                            total: 0,
                            index: safeIndex,
                            limit: safeLimit,
                        };

                        ApiResponseBuilder.ok(
                            res,
                            "other",
                            { users: [] as IUser[], pagination },
                            "No users found in any team"
                        );
                        return;
                    }

                    const filter: Record<string, unknown> = {
                        _id: { $in: teamUserIds },
                    };

                    const [ total, users ] = await Promise.all( [
                        UserModel.countDocuments( filter ).exec(),
                        UserModel.find( filter )
                            .skip( safeIndex * safeLimit )
                            .limit( safeLimit )
                            .lean<IUser>()
                            .exec() as unknown as IUser[],
                    ] );

                    const pagination: PaginationMeta = {
                        total,
                        index: safeIndex,
                        limit: safeLimit,
                    };

                    ApiResponseBuilder.ok(
                        res,
                        "users",
                        users,
                        "Users in teams fetched successfully",
                        { pagination },
                    );
                }
                catch ( error ) {
                    console.error( "[Error while fetching users in teams]:\n", error );
                    ApiResponseBuilder.internalError( res, error );
                }
            }
        );
    }

    // ─────────────────────────────────────────────
    // GET /users/in-teams/count
    //   → Total count only (users that belong to at least one team)
    // ─────────────────────────────────────────────

    private registerUsersInAnyTeamCount(): void {
        this.route.get(
            "/users/in-teams/count",
            async ( _req: Request, res: Response ): Promise<void> => {
                try {
                    const teamUserIds: Types.ObjectId[] =
                        await this.collectTeamUserIdsByDomain();

                    if ( teamUserIds.length === 0 ) {
                        ApiResponseBuilder.ok(
                            res,
                            "other",
                            { total: 0 },
                            "Total users in teams fetched successfully"
                        );
                        return;
                    }

                    const filter: Record<string, unknown> = {
                        _id: { $in: teamUserIds },
                    };

                    const total: number = await UserModel.countDocuments( filter ).exec();

                    ApiResponseBuilder.ok(
                        res,
                        "other",
                        {},
                        "Total users in teams fetched successfully",
                        { pagination: { total } }
                    );
                }
                catch ( error ) {
                    console.error( "[Error while counting users in teams]:\n", error );
                    ApiResponseBuilder.internalError( res, error );
                }
            }
        );
    }

    // ─────────────────────────────────────────────
    // GET /users/no-team/domain/:domain
    //   → Users not in any team for the given domain
    // ─────────────────────────────────────────────

    private registerUsersWithoutTeamByDomain(): void {
        this.route.get(
            "/users/no-team/domain/:domain",
            async ( req: Request, res: Response ): Promise<void> => {
                try {
                    const rawDomain: string = String( req.params.domain ?? "" ).trim().toLowerCase();

                    if ( !rawDomain ) {
                        ApiResponseBuilder.validationError(
                            res,
                            "Domain is required"
                        );
                        return;
                    }

                    const domain = rawDomain as TeamDomain;

                    const index: number = Number( req.query.index ?? 0 );
                    const limit: number = Number( req.query.limit ?? 10 );

                    const safeIndex = Number.isFinite( index ) && index >= 0 ? index : 0;
                    const safeLimit = Number.isFinite( limit ) && limit > 0 ? limit : 10;

                    const teamUserIds: Types.ObjectId[] =
                        await this.collectTeamUserIdsByDomain( domain );

                    const filter: Record<string, unknown> = {};
                    if ( teamUserIds.length > 0 ) {
                        filter[ "_id" ] = { $nin: teamUserIds };
                    }

                    const [ total, users ] = await Promise.all( [
                        UserModel.countDocuments( filter ).exec(),
                        UserModel.find( filter )
                            .skip( safeIndex * safeLimit )
                            .limit( safeLimit )
                            .lean<IUser>()
                            .exec() as unknown as IUser[],
                    ] );

                    const pagination: PaginationMeta = {
                        total,
                        index: safeIndex,
                        limit: safeLimit,
                    };

                    ApiResponseBuilder.ok(
                        res,
                        "users",
                        users,
                        "Users without any team for the domain fetched successfully",
                        { pagination, other: { domain } }
                    );
                }
                catch ( error ) {
                    console.error( "[Error while fetching domain users without team]:\n", error );
                    ApiResponseBuilder.internalError( res, error );
                }
            }
        );
    }

    // ─────────────────────────────────────────────
    // GET /users/no-team/domain/:domain/count
    //   → Total users not in any team for given domain
    // ─────────────────────────────────────────────

    private registerUsersWithoutTeamByDomainCount(): void {
        this.route.get(
            "/users/no-team/domain/:domain/count",
            async ( req: Request, res: Response ): Promise<void> => {
                try {
                    const rawDomain: string = String( req.params.domain ?? "" ).trim().toLowerCase();

                    if ( !rawDomain ) {
                        ApiResponseBuilder.validationError(
                            res,
                            "Domain is required"
                        );
                        return;
                    }

                    const domain = rawDomain as TeamDomain;

                    const teamUserIds: Types.ObjectId[] =
                        await this.collectTeamUserIdsByDomain( domain );

                    const filter: Record<string, unknown> = {};
                    if ( teamUserIds.length > 0 ) {
                        filter[ "_id" ] = { $nin: teamUserIds };
                    }

                    const total: number = await UserModel.countDocuments( filter ).exec();

                    ApiResponseBuilder.ok(
                        res,
                        "other",
                        { domain },
                        "Total users without team for domain fetched successfully",
                        { pagination: { total } }
                    );
                }
                catch ( error ) {
                    console.error( "[Error while counting domain users without team]:\n", error );
                    ApiResponseBuilder.internalError( res, error );
                }
            }
        );
    }

    // ─────────────────────────────────────────────
    // GET /users/in-teams/domain/:domain
    //   → Users that belong to at least one team for the given domain
    // ─────────────────────────────────────────────

    private registerUsersInTeamByDomain(): void {
        this.route.get(
            "/users/in-teams/domain/:domain",
            async ( req: Request, res: Response ): Promise<void> => {
                try {
                    const rawDomain: string = String( req.params.domain ?? "" ).trim().toLowerCase();

                    if ( !rawDomain ) {
                        ApiResponseBuilder.validationError(
                            res,
                            "Domain is required"
                        );
                        return;
                    }

                    const domain = rawDomain as TeamDomain;

                    const index: number = Number( req.query.index ?? 0 );
                    const limit: number = Number( req.query.limit ?? 10 );

                    const safeIndex = Number.isFinite( index ) && index >= 0 ? index : 0;
                    const safeLimit = Number.isFinite( limit ) && limit > 0 ? limit : 10;

                    const teamUserIds: Types.ObjectId[] =
                        await this.collectTeamUserIdsByDomain( domain );

                    if ( teamUserIds.length === 0 ) {
                        const pagination: PaginationMeta = {
                            total: 0,
                            index: safeIndex,
                            limit: safeLimit,
                        };

                        ApiResponseBuilder.ok(
                            res,
                            "other",
                            { domain, users: [] as IUser[], pagination },
                            "No users found in teams for given domain"
                        );
                        return;
                    }

                    const filter: Record<string, unknown> = {
                        _id: { $in: teamUserIds },
                    };

                    const [ total, users ] = await Promise.all( [
                        UserModel.countDocuments( filter ).exec(),
                        UserModel.find( filter )
                            .skip( safeIndex * safeLimit )
                            .limit( safeLimit )
                            .lean<IUser>()
                            .exec() as unknown as IUser[],
                    ] );

                    const pagination: PaginationMeta = {
                        total,
                        index: safeIndex,
                        limit: safeLimit,
                    };

                    ApiResponseBuilder.ok(
                        res,
                        "users",
                        users,
                        "Users in teams for domain fetched successfully",
                        { other: { domain }, pagination }
                    );
                }
                catch ( error ) {
                    console.error( "[Error while fetching domain users in teams]:\n", error );
                    ApiResponseBuilder.internalError( res, error );
                }
            }
        );
    }

    // ─────────────────────────────────────────────
    // GET /users/in-teams/domain/:domain/count
    //   → Total users in at least one team for given domain
    // ─────────────────────────────────────────────

    private registerUsersInTeamByDomainCount(): void {
        this.route.get(
            "/users/in-teams/domain/:domain/count",
            async ( req: Request, res: Response ): Promise<void> => {
                try {
                    const rawDomain: string = String( req.params.domain ?? "" ).trim().toLowerCase();

                    if ( !rawDomain ) {
                        ApiResponseBuilder.validationError(
                            res,
                            "Domain is required"
                        );
                        return;
                    }

                    const domain = rawDomain as TeamDomain;

                    const teamUserIds: Types.ObjectId[] =
                        await this.collectTeamUserIdsByDomain( domain );

                    if ( teamUserIds.length === 0 ) {
                        ApiResponseBuilder.ok(
                            res,
                            "other",
                            { domain, total: 0 },
                            "Total users in teams for domain fetched successfully"
                        );
                        return;
                    }

                    const filter: Record<string, unknown> = {
                        _id: { $in: teamUserIds },
                    };

                    const total: number = await UserModel.countDocuments( filter ).exec();

                    ApiResponseBuilder.ok(
                        res,
                        "other",
                        { domain },
                        "Total users in teams for domain fetched successfully",
                        { pagination: { total } }
                    );
                }
                catch ( error ) {
                    console.error( "[Error while counting domain users in teams]:\n", error );
                    ApiResponseBuilder.internalError( res, error );
                }
            }
        );
    }


}
