// Path: src/api/teamManagement/teamManagement.ts
// ============================================================================
// Team Management Router (class-based)
// ----------------------------------------------------------------------------
// Responsibilities:
//   - Team CRUD (create, update, delete, get all, get totals, get by ID)
//   - Task assignment + evidence metadata attachment
//   - File uploads (team logo, task evidence) via FileUploader helper
//   - User vs Team analytics (who is in teams / not in teams, by domain/global)
//   - All users with team/domain mapping (for FE selectors, dashboards)
//
// Design notes:
//   - This router stays JSON-focused; file uploads are delegated to
//     FileUploader which writes under /public/uploads.
//   - FE workflow for files:
//       1) Call /upload/* → get FileMetaBase[].
//       2) FE builds TaskEvidence JSON from FileMetaBase.
//       3) FE sends that JSON in /create, /update, /evidence/attach.
//
//   - Team membership constraint (from model hook):
//       • A user can be member of at most 2 active teams at once.
//       • Enforced in TeamManagementModel pre('save').
// ============================================================================

import express, { Request, Response, Router } from "express";
import { FilterQuery, PipelineStage, Types } from "mongoose";

import {
    Address,
    AssignedTask,
    GeoLocation,
    ITeamManagement,
    TaskEvidence,
    TeamDomain,
    TeamManagementModel,
    TeamMember,
    ISODateString,
    TEAM_ROLES,
    RoleInTeam,
} from "../../models/teamManagement/teamManagement.model";
import { User, USER_MODEL_PROJECTION, UserModel } from "../../models/user.model";
import { FileMetaBase, PaginationMeta } from "../../types/api-message";
import { ApiResponseBuilder } from "../../utils/api-combiner.builder";
import FileUploader from "../../utils/file-uploader.helper";
import NotificationService from "../../services/notification.service";

// ---------------------------------------------------------------------------
// Shape for aggregated "user + team" view
// ---------------------------------------------------------------------------
interface AllUserWithTeams extends User {
    domain?: TeamDomain;
    teamName?: ITeamManagement[ "teamName" ];
    roleInTeam?: "member" | "lead" | "supervisor" | "observer" | null;
    teamReason?: string | null;
    teamJoinedAt?: ISODateString | null;
    teams: {
        domain?: TeamDomain;
        teamName?: ITeamManagement[ "teamName" ];
    }[];
}

// ============================================================================
// Router class
// ============================================================================
export default class TeamManagement {
    /**
     * Base public URL root (relative) for team uploads.
     * Files are stored under /public/uploads, so typical URL is:
     *   `${API_BASE}/${PUBLIC_UPLOAD_URL_ROOT}/...`
     */
    private readonly PUBLIC_UPLOAD_URL_ROOT: string = "uploads/team-management";

    private readonly router: Router;

    // Allowed team domains – used for validation
    private readonly ALLOWED_TEAM_DOMAINS: TeamDomain[] = [
        "sales",
        "development",
        "support",
        "operations",
        "marketing",
        "finance",
        "other",
    ];

    // ─────────────────────────────────────────────
    // Ctor & route registration
    // ─────────────────────────────────────────────

    public constructor () {
        this.router = express.Router();

        // Core team operations
        this.registerCreateTeam(); // POST   /create
        this.getTeamByTeamName();  // GET    /teamName/:teamName
        this.registerGetAllTeams(); // GET   /all
        this.registerGetTeamById(); // GET   /:teamId
        this.registerUpdateTeam();  // PATCH /update/:teamId
        this.registerDeleteTeam();  // DELETE /delete/:teamId

        // Thin wrappers around FileUploader – file upload only
        this.registerUploadTeamLogo(); // POST /upload/logo/:teamId

        // Stats / analytics routes (totals)
        this.registerGetAllTeamTotals();     // GET /stats/teams-total
        this.registerGetTeamTotalByDomain(); // GET /stats/teams-total/domain/:domain

        // User membership analytics (global)
        this.registerUsersWithoutAnyTeam();      // GET /users/no-team
        this.registerUsersWithoutAnyTeamCount(); // GET /users/no-team/count
        this.registerUsersInAnyTeam();           // GET /users/in-teams
        this.registerUsersInAnyTeamCount();      // GET /users/in-teams/count

        // User membership analytics (domain-specific)
        this.registerUsersWithoutTeamByDomain();      // GET /users/no-team/domain/:domain
        this.registerUsersWithoutTeamByDomainCount(); // GET /users/no-team/domain/:domain/count
        this.registerUsersInTeamByDomain();           // GET /users/in-teams/domain/:domain
        this.registerUsersInTeamByDomainCount();      // GET /users/in-teams/domain/:domain/count

        // All users + team/domain mapping
        this.registerGetAllUsersWithTeams(); // GET /users/all?index=&limit=&search=
    }

    public get route(): Router {
        return this.router;
    }

    // ========================================================================
    // Generic helpers
    // ========================================================================

    /**
     * Runtime validator for TeamDomain values.
     */
    private isValidTeamDomain( domain: string ): domain is TeamDomain {
        return this.ALLOWED_TEAM_DOMAINS.includes( domain as TeamDomain );
    }

    /**
     * Parse pagination query parameters into safe values.
     *  - index: page index (0-based)
     *  - limit: page size
     */
    private parsePagination(
        req: Request,
        fallbackLimit: number = 10,
    ): { index: number; limit: number; skip: number; } {
        const indexRaw = req.query.index;
        const limitRaw = req.query.limit;

        const indexNum = Number( indexRaw );
        const limitNum = Number( limitRaw );

        const index: number =
            Number.isFinite( indexNum ) && indexNum >= 0 ? indexNum : 0;

        const limit: number =
            Number.isFinite( limitNum ) && limitNum > 0 ? limitNum : fallbackLimit;

        const skip: number = index * limit;
        return { index, limit, skip };
    }

    /**
     * Parse boolean query parameter (`?isActive=true/false/1/0`).
     * Returns:
     *  - true / false if recognized
     *  - undefined if not provided or invalid → caller decides default.
     */
    private parseBooleanQuery( value: unknown ): boolean | undefined {
        if ( typeof value === "boolean" ) {
            return value;
        }

        if ( typeof value === "string" ) {
            const normalized = value.trim().toLowerCase();
            if ( normalized === "true" || normalized === "1" ) return true;
            if ( normalized === "false" || normalized === "0" ) return false;
        }

        return undefined;
    }

    private safeJsonParse<T>( value: unknown ): T | undefined {
        if ( typeof value !== "string" || !value.trim() ) return undefined;
        try {
            return JSON.parse( value ) as T;
        } catch {
            return undefined;
        }
    }

    // ========================================================================
    // Helpers – IDs, members, tasks, evidence
    // ========================================================================

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
                    SAFE_CHARS[ Math.floor( Math.random() * SAFE_CHARS.length ) ],
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

    /**
     * Generates a unique-ish AssignedTask ID.
     * Example: TASK-MB7Z2A-3X9Q2L
     */
    private buildAssignedTaskId(): string {
        const now = Date.now().toString( 36 ).toUpperCase();
        const rand = Math.random().toString( 36 ).slice( 2, 8 ).toUpperCase();
        return `TASK-${ now }-${ rand }`;
    }

    /**
     * Legacy helper: turn an array of bodies into pure ObjectId[].
     * Still used for AssignedTask.assignedMembers.
     */
    private extractUserIdsFromArray( input: unknown ): Types.ObjectId[] {
        if ( !Array.isArray( input ) ) return [];
        return ( input as unknown[] )
            .map( ( u: unknown ) => {
                const anyU = u as { _id?: unknown; id?: unknown; userId?: unknown; };
                const id = anyU?._id ?? anyU?.id ?? anyU?.userId;
                if ( !id ) return undefined;
                try {
                    return new Types.ObjectId( String( id ) );
                } catch {
                    return undefined;
                }
            } )
            .filter( ( x ): x is Types.ObjectId => x instanceof Types.ObjectId );
    }

    /**
     * Legacy helper: single ObjectId (for AssignedTask.assignedTaskCaptain).
     */
    private extractUserId( input: unknown ): Types.ObjectId | undefined {
        if ( !input || typeof input !== "object" ) return undefined;
        const anyU = input as { _id?: unknown; id?: unknown; userId?: unknown; };
        const id = anyU._id ?? anyU.id ?? anyU.userId;
        if ( !id ) return undefined;
        try {
            return new Types.ObjectId( String( id ) );
        } catch {
            return undefined;
        }
    }

    /**
     * Normalise and validate a raw role value against TEAM_ROLES.
     *  - Accepts string, trims & lowercases it.
     *  - Returns a RoleInTeam if valid, otherwise undefined.
    **/
    private resolveRoleInTeam( raw: unknown ): RoleInTeam | undefined {
        if ( typeof raw !== "string" ) {
            return undefined;
        }

        const normalised = raw.trim().toLowerCase();
        if ( !normalised ) {
            return undefined;
        }

        // TEAM_ROLES is readonly tuple, so this check is type-safe
        const matched = ( TEAM_ROLES as readonly string[] ).find(
            ( role: string ): boolean => role === normalised,
        );

        if ( !matched ) {
            return undefined;
        }

        return matched as RoleInTeam;
    }

    /**
 * Convert array of generic user-like payloads into TeamMember[].
 *
 * Accepted input shapes per element:
 *   { _id, username }
 *   { id, username }
 *   { userId, username }
 *   { _id, userName }
 *   { _id, name }
 *
 * Optional fields honoured:
 *   - roleInTeam   (validated against TEAM_ROLES)
 *   - reason       (string; trimmed; empty => ignored)
 *   - joinedAt     (ISO string; basic Date.parse validation)
 */
    private extractTeamMembersFromArray( input: unknown ): TeamMember[] {
        if ( !Array.isArray( input ) ) {
            return [];
        }

        const result: TeamMember[] = [];

        for ( const raw of input as unknown[] ) {
            if ( !raw || typeof raw !== "object" ) {
                continue;
            }

            const anyU = raw as {
                _id?: unknown;
                id?: unknown;
                userId?: unknown;
                username?: unknown;
                userName?: unknown;
                name?: unknown;
                roleInTeam?: unknown;
                reason?: unknown;
                joinedAt?: unknown;
            };

            const idSource = anyU._id ?? anyU.id ?? anyU.userId;
            const usernameSource =
                anyU.username ?? anyU.userName ?? anyU.name;

            if ( !idSource || typeof usernameSource !== "string" ) {
                continue;
            }

            const username = usernameSource.trim();
            if ( !username ) {
                continue;
            }

            let oid: Types.ObjectId;
            try {
                oid = new Types.ObjectId( String( idSource ) );
            } catch {
                // invalid ObjectId → skip entry
                continue;
            }

            const member: TeamMember = {
                id: oid,
                username: username as User[ "username" ],
            };

            // roleInTeam (validate against TEAM_ROLES)
            const resolvedRole = this.resolveRoleInTeam( anyU.roleInTeam );
            if ( resolvedRole ) {
                member.roleInTeam = resolvedRole;
            }
            // else: schema default "member" will apply

            // reason (optional)
            if ( typeof anyU.reason === "string" ) {
                const trimmedReason = anyU.reason.trim();
                if ( trimmedReason ) {
                    member.reason = trimmedReason;
                }
            }

            // joinedAt (optional ISODateString)
            if ( typeof anyU.joinedAt === "string" ) {
                const joinedAtRaw = anyU.joinedAt.trim();
                if ( joinedAtRaw && !Number.isNaN( Date.parse( joinedAtRaw ) ) ) {
                    // basic validation only; DB will still accept string
                    member.joinedAt = joinedAtRaw as ISODateString;
                }
            }

            result.push( member );
        }

        return result;
    }


    /**
 * Convert a single user-like payload into TeamMember.
 *
 * Same accepted shapes as extractTeamMembersFromArray.
 */
    private extractTeamMember( input: unknown ): TeamMember | undefined {
        if ( !input || typeof input !== "object" ) {
            return undefined;
        }

        const anyU = input as {
            _id?: unknown;
            id?: unknown;
            userId?: unknown;
            username?: unknown;
            userName?: unknown;
            name?: unknown;
            roleInTeam?: unknown;
            reason?: unknown;
            joinedAt?: unknown;
        };

        const idSource = anyU._id ?? anyU.id ?? anyU.userId;
        const usernameSource =
            anyU.username ?? anyU.userName ?? anyU.name;

        if ( !idSource || typeof usernameSource !== "string" ) {
            return undefined;
        }

        const username = usernameSource.trim();
        if ( !username ) {
            return undefined;
        }

        let oid: Types.ObjectId;
        try {
            oid = new Types.ObjectId( String( idSource ) );
        } catch {
            return undefined;
        }

        const member: TeamMember = {
            id: oid,
            username: username as User[ "username" ],
        };

        // roleInTeam (validate against TEAM_ROLES)
        const resolvedRole = this.resolveRoleInTeam( anyU.roleInTeam );
        if ( resolvedRole ) {
            member.roleInTeam = resolvedRole;
        }

        // reason (optional)
        if ( typeof anyU.reason === "string" ) {
            const trimmedReason = anyU.reason.trim();
            if ( trimmedReason ) {
                member.reason = trimmedReason;
            }
        }

        // joinedAt (optional ISODateString)
        if ( typeof anyU.joinedAt === "string" ) {
            const joinedAtRaw = anyU.joinedAt.trim();
            if ( joinedAtRaw && !Number.isNaN( Date.parse( joinedAtRaw ) ) ) {
                member.joinedAt = joinedAtRaw as ISODateString;
            }
        }

        return member;
    }


    /**
     * Build a TaskEvidence from FileMetaBase and extra metadata sent by FE.
     *
     * Expected FE payload (example):
     *  {
     *    name: string;
     *    storageKey: "uploads/....",
     *    url: "/uploads/....",
     *    uploadedById: string;
     *    uploadedByName: string;
     *    uploadedAt: ISO string;
     *    fileMeta: FileMetaBase;
     *  }
     */
    private buildEvidenceFromMeta( meta: unknown ): TaskEvidence {
        const anyMeta = meta as {
            name?: string;
            storageKey?: string;
            url?: string;
            uploadedById?: Types.ObjectId;
            uploadedByName?: string;
            uploadedAt?: string;
            fileMeta?: FileMetaBase;
        };

        const fileMeta: FileMetaBase | undefined = anyMeta?.fileMeta;

        const storageKey: string = anyMeta?.storageKey ?? "";
        const url: string = anyMeta?.url ?? storageKey;

        // Build minimal object first, then add optional properties conditionally.
        const evidence: TaskEvidence = {
            name: anyMeta?.name ?? fileMeta?.originalName ?? "evidence",
        };

        if ( storageKey ) {
            evidence.storageKey = storageKey;
        }

        if ( url ) {
            evidence.url = url;
        }

        if ( anyMeta?.uploadedById ) {
            evidence.uploadedById = anyMeta.uploadedById;
        }

        if ( anyMeta?.uploadedByName ) {
            evidence.uploadedByName = anyMeta.uploadedByName;
        }

        evidence.uploadedAt =
            anyMeta?.uploadedAt ?? new Date().toISOString();

        if ( fileMeta ) {
            evidence.file = {
                originalName: fileMeta.originalName,
                storedName: fileMeta.storedName,
                extension: fileMeta.extension,
                mimeType: fileMeta.mimeType,
                sizeBytes: fileMeta.sizeBytes,
            };
        }

        return evidence;
    }

    /**
     * Build an AssignedTask from raw body payload.
     * Used in:
     *   - /create
     *   - /update
     *   - /assign-task/:teamId
     */
    private buildAssignedTaskFromBody( raw: unknown ): AssignedTask {
        const t = raw as {
            id?: string;
            name?: string;
            description?: string;
            location?: unknown;
            address?: unknown;
            assignedMembers?: unknown;
            assignedTaskCaptain?: unknown;
            status?: string;
            priority?: string;
            plannedStartAt?: string;
            plannedEndAt?: string;
            completedAt?: string;
            evidence?: unknown[];
            notes?: string;
        };

        if ( !t.name ) {
            throw new Error( "Task name is required." );
        }

        const assignedMembers = this.extractUserIdsFromArray(
            t.assignedMembers,
        );
        const assignedCaptain = this.extractUserId(
            t.assignedTaskCaptain,
        );

        const idTrimmed =
            typeof t.id === "string" ? t.id.trim() : "";

        // Build minimal required/base shape first
        const task: AssignedTask = {
            id: idTrimmed || this.buildAssignedTaskId(),
            name: t.name,
            description: t.description ?? "",
            status: ( t.status as AssignedTask[ "status" ] ) ?? "draft",
            priority: ( t.priority as AssignedTask[ "priority" ] ) ?? "medium",
            plannedStartAt: t.plannedStartAt ?? "",
            plannedEndAt: t.plannedEndAt ?? "",
            completedAt: t.completedAt ?? "",
            notes: t.notes ?? "",
        };

        // Optional: assignedMembers
        if ( assignedMembers.length > 0 ) {
            task.assignedMembers = assignedMembers;
        }

        // Optional: captain
        if ( assignedCaptain ) {
            task.assignedTaskCaptain = assignedCaptain;
        }

        // Optional: location
        if ( t.location ) {
            task.location = t.location as GeoLocation;
        }

        // Optional: address
        if ( t.address ) {
            task.address = t.address as Address;
        }

        // Optional: evidence
        if ( Array.isArray( t.evidence ) && t.evidence.length > 0 ) {
            task.evidence = t.evidence as TaskEvidence[];
            // if you want to normalise with buildEvidenceFromMeta:
            // task.evidence = t.evidence.map((e) => this.buildEvidenceFromMeta(e));
        }

        return task;
    }

    // ========================================================================
    // Helpers – user membership vs teams
    // ========================================================================

    /**
     * Collect distinct user IDs that belong to any team, optionally
     * restricted by TeamDomain.
     *
     * - Includes both members[].id and captain.id.
     * - Returns a de-duplicated array of ObjectId.
     */
    private async collectTeamUserIdsByDomain(
        domain?: TeamDomain,
    ): Promise<Types.ObjectId[]> {
        const pipeline: PipelineStage[] = [];

        if ( domain ) {
            pipeline.push( {
                $match: { domain },
            } );
        }

        pipeline.push(
            // Extract memberIds[] and captainId
            {
                $project: {
                    memberIds: {
                        $map: {
                            input: "$members",
                            as: "m",
                            in: "$$m.id",
                        },
                    },
                    captainId: "$captain.id",
                },
            },
            // Merge them into a single array
            {
                $project: {
                    allUserIds: {
                        $setUnion: [
                            "$memberIds",
                            {
                                $cond: [
                                    { $ifNull: [ "$captainId", null ] },
                                    [ "$captainId" ],
                                    [],
                                ],
                            },
                        ],
                    },
                },
            },
            { $unwind: "$allUserIds" },
            {
                $group: {
                    _id: "$allUserIds",
                },
            },
        );

        const rows: Array<{ _id: Types.ObjectId; }> =
            await TeamManagementModel.aggregate( pipeline ).exec();

        return rows.map( ( r ) => r._id );
    }

    // ========================================================================
    // POST /create  (JSON or multipart/form-data with team JSON + teamLogo file)
    // ========================================================================
    private registerCreateTeam(): void {
        this.router.post(
            "/create",
            async ( req: Request, res: Response ): Promise<void> => {
                try {
                    // ----------------------------------------------------------------
                    // 0) Prepare request context
                    // ----------------------------------------------------------------
                    const nowIso: string = new Date().toISOString();
                    const teamId: string = this.generateTeamIdentity();
                    const root = `${ req.protocol }://${ req.get( "host" ) }`;

                    // Will hold the logical payload regardless of transport format
                    let payload: any = {};
                    let teamLogoEvidence: TaskEvidence | undefined;

                    // ----------------------------------------------------------------
                    // 1) Detect multipart vs JSON and normalise payload
                    // ----------------------------------------------------------------
                    const isMultipart: boolean =
                        ( req.headers[ "content-type" ] ?? "" )
                            .toString()
                            .includes( "multipart/form-data" );

                    if ( isMultipart ) {
                        // 1.a) Handle file upload first so Multer can parse body+files
                        //      Subpath under /public/uploads: team-management/<teamId>/logo
                        const uploadSubPath: string = `team-management/${ teamId }/logo`;

                        let uploadedFiles: FileMetaBase[] = [];
                        try {
                            uploadedFiles = await FileUploader.handleUpload(
                                uploadSubPath,
                                "teamLogo", // field name from FE FormData.append('teamLogo', file)
                                req,
                            );
                        } catch ( uploadError ) {
                            // Logo is optional; treat upload failure as a validation error only if
                            // you want to enforce the logo. For now we log and continue without logo.
                            console.error(
                                "[TeamManagement:create] Logo upload failed:",
                                uploadError,
                            );
                        }

                        // 1.b) Parse JSON payload from multipart field "team"
                        const rawTeamField: unknown = ( req.body as any )?.team;



                        if ( typeof rawTeamField !== "string" || !rawTeamField.trim() ) {
                            ApiResponseBuilder.validationError(
                                res,
                                "Invalid team payload: expected JSON string in 'team' field",
                            );
                            return;
                        }

                        try {
                            payload = JSON.parse( rawTeamField );
                        } catch ( parseError ) {
                            console.error(
                                "[TeamManagement:create] Failed to parse 'team' JSON:",
                                parseError,
                            );
                            ApiResponseBuilder.validationError(
                                res,
                                "Malformed team JSON payload",
                            );
                            return;
                        }

                        // 1.c) If a file was uploaded, build TaskEvidence from FileMetaBase
                        if ( Array.isArray( uploadedFiles ) && uploadedFiles.length > 0 ) {
                            const fileMeta: FileMetaBase | undefined = uploadedFiles[ 0 ];

                            if ( !fileMeta ) {
                                ApiResponseBuilder.error( res, 404, "File not found!" );
                                return;
                            }

                            const relativePath: string =
                                `${ this.PUBLIC_UPLOAD_URL_ROOT }/${ teamId }/logo/${ fileMeta.storedName }`;

                            const rawLogoMeta: Record<string, unknown> = {
                                name: fileMeta.originalName,
                                storageKey: relativePath, // relative to /public
                                url: `${ root }/${ relativePath }`,
                                category: "team_logo",
                                refId: teamId,
                                fileMeta,
                            };

                            teamLogoEvidence = this.buildEvidenceFromMeta( rawLogoMeta );
                        }
                    } else {
                        // Fallback: legacy JSON-only behaviour
                        payload = req.body;
                    }

                    // ----------------------------------------------------------------
                    // 2) Extract & validate core fields from payload
                    // ----------------------------------------------------------------
                    const teamName: string = String( payload.teamName ?? "" ).trim();
                    const domainRaw: string = String( payload.domain ?? "" ).trim();
                    const description: string = String(
                        payload.description ?? "",
                    ).trim();

                    const isActiveParsed: boolean | undefined = this.parseBooleanQuery(
                        payload.isActive,
                    );
                    const isActive: boolean =
                        isActiveParsed !== undefined ? isActiveParsed : true;

                    if ( !teamName || !domainRaw ) {
                        ApiResponseBuilder.validationError(
                            res,
                            "Team name and domain are required for team creation",
                        );
                        return;
                    }

                    if ( !this.isValidTeamDomain( domainRaw.toLowerCase() ) ) {
                        ApiResponseBuilder.validationError(
                            res,
                            "Invalid domain. Allowed values: sales, development, support, operations, marketing, finance, other.",
                        );
                        return;
                    }

                    const domain: TeamDomain =
                        domainRaw.toLowerCase() as TeamDomain;

                    // ----------------------------------------------------------------
                    // 3) Extract members, captain, tasks, and logo meta (JSON fallback)
                    // ----------------------------------------------------------------
                    const rawMembers: unknown = payload.members;
                    const rawCaptain: unknown = payload.captain;
                    const rawTasks: unknown = payload.assignTasks;
                    const rawTeamLogoFromJson: unknown = payload.teamLogo;

                    // Convert to TeamMember[]
                    const memberRefs: TeamMember[] =
                        this.extractTeamMembersFromArray( rawMembers );

                    const captainRef: TeamMember | undefined =
                        this.extractTeamMember( rawCaptain );

                    if ( !captainRef ) {
                        ApiResponseBuilder.validationError(
                            res,
                            "Team captain is required",
                        );
                        return;
                    }

                    // Build AssignedTask[]
                    const assignTasks: AssignedTask[] = Array.isArray( rawTasks )
                        ? ( rawTasks as unknown[] ).map(
                            ( t: unknown ): AssignedTask =>
                                this.buildAssignedTaskFromBody( t ),
                        )
                        : [];

                    // If no file-based logo evidence was built, we still support
                    // the old JSON-based logo meta (body.teamLogo).
                    if ( !teamLogoEvidence && rawTeamLogoFromJson ) {
                        teamLogoEvidence = this.buildEvidenceFromMeta(
                            rawTeamLogoFromJson,
                        );
                    }

                    // ----------------------------------------------------------------
                    // 4) Build document payload for Mongo (avoid teamLogo: undefined)
                    // ----------------------------------------------------------------
                    const createDocBase: Partial<ITeamManagement> = {
                        id: teamId,
                        teamName,
                        domain,
                        description,
                        members: memberRefs,
                        captain: captainRef,
                        memberTotal: memberRefs.length,
                        assignTasks,
                        createdAt: nowIso,
                        updatedAt: nowIso,
                        isActive,
                    };

                    if ( teamLogoEvidence ) {
                        // Only attach if actually present to keep exactOptionalPropertyTypes happy
                        ( createDocBase as ITeamManagement ).teamLogo =
                            teamLogoEvidence;
                    }

                    const doc: ITeamManagement = await TeamManagementModel.create(
                        createDocBase as ITeamManagement,
                    );

                    ApiResponseBuilder.ok(
                        res,
                        "team",
                        doc,
                        "Team created successfully",
                    );

                    const notificationService = new NotificationService();
                    const io = req.app.get( "io" ) as import( "socket.io" ).Server;
                    await notificationService.createNotification(
                        {
                            title: "New Team",
                            body: `A new team "${ createDocBase.teamName }" has been created.`,
                            type: "create",
                            severity: "info",
                            audience: {
                                mode: "role",
                                roles: [ "admin", "manager", "operator" ],
                            },
                            channels: [ "inapp", "email" ],
                            metadata: {
                                refId: createDocBase.id ?? "",
                                data: { property: createDocBase },
                            },
                        },
                        ( rooms, payload ) =>
                            rooms.forEach( ( r ) =>
                                io.to( r ).emit( "notification.new", payload ),
                            ),
                    );
                    return;
                } catch ( error ) {
                    console.error(
                        "[Unexpected error occurred during team creation]:\n",
                        error,
                    );
                    ApiResponseBuilder.internalError( res, error );
                    return;
                }
            },
        );
    }

    // ========================================================================
    // GET /teamName/:teamName
    // ========================================================================
    private getTeamByTeamName(): void {
        this.router.get(
            "/teamName/:teamName",
            async (
                req: Request<{ teamName: string; }>,
                res: Response,
            ): Promise<void> => {
                try {
                    const raw = req.params.teamName;
                    const name: string =
                        typeof raw === "string" ? raw.trim() : "";

                    if ( !name ) {
                        ApiResponseBuilder.validationError(
                            res,
                            "Team name is required!",
                        );
                        return;
                    }

                    // Escape regex special chars to prevent regex injection
                    const escaped = name.replace(
                        /[.*+?^${}()|[\]\\]/g,
                        "\\$&",
                    );

                    // Case-insensitive exact match
                    const team: ITeamManagement | null =
                        await TeamManagementModel.findOne( {
                            teamName: {
                                $regex: `^${ escaped }$`,
                                $options: "i",
                            },
                        } ).exec();

                    if ( !team ) {
                        ApiResponseBuilder.notFound(
                            res,
                            "Team not found under the given name.",
                        );
                        return;
                    }

                    ApiResponseBuilder.ok(
                        res,
                        "team",
                        team,
                        "Team found successfully!",
                    );
                    return;
                } catch ( error ) {
                    console.error(
                        "[TeamManagement:getTeamByTeamName Error]:",
                        error,
                    );
                    ApiResponseBuilder.internalError( res, error );
                    return;
                }
            },
        );
    }

    // ========================================================================
    // GET /all
    // ========================================================================

    private registerGetAllTeams(): void {
        this.router.get(
            "/all",
            async ( req: Request, res: Response ): Promise<void> => {
                try {
                    const { index, limit, skip } = this.parsePagination(
                        req,
                        10,
                    );

                    const search: string = String(
                        req.query.search ?? "",
                    ).trim();
                    const domainRaw: string = String(
                        req.query.domain ?? "",
                    ).trim();
                    const isActiveParam = this.parseBooleanQuery(
                        req.query.isActive,
                    );

                    const filter: FilterQuery<ITeamManagement> = {};

                    if ( search ) {
                        filter.teamName = { $regex: search, $options: "i" };
                    }

                    if ( domainRaw ) {
                        const domainLower = domainRaw.toLowerCase();
                        if ( !this.isValidTeamDomain( domainLower ) ) {
                            ApiResponseBuilder.validationError(
                                res,
                                "Invalid domain in query.",
                            );
                            return;
                        }
                        filter.domain = domainLower as TeamDomain;
                    }

                    if ( isActiveParam !== undefined ) {
                        filter.isActive = isActiveParam;
                    }

                    const [ total, rows ] = await Promise.all( [
                        TeamManagementModel.countDocuments( filter ).exec(),
                        TeamManagementModel.find( filter )
                            .skip( skip )
                            .limit( limit )
                            .lean<ITeamManagement>()
                            .exec() as unknown as ITeamManagement[],
                    ] );

                    const pagination: PaginationMeta = {
                        total,
                        index,
                        limit,
                    };

                    ApiResponseBuilder.ok(
                        res,
                        "teams",
                        rows,
                        "Teams fetched successfully",
                        { pagination },
                    );
                    return;
                } catch ( error ) {
                    console.error(
                        "[Error while fetching teams]:\n",
                        error,
                    );
                    ApiResponseBuilder.internalError( res, error );
                    return;
                }
            },
        );
    }

    // ========================================================================
    // GET /:teamId
    // ========================================================================

    private registerGetTeamById(): void {
        this.router.get(
            "/:teamId",
            async ( req: Request, res: Response ): Promise<void> => {
                try {
                    const teamId = String(
                        req.params.teamId ?? "",
                    ).trim();
                    if ( !teamId ) {
                        ApiResponseBuilder.validationError(
                            res,
                            "Team ID is required",
                        );
                        return;
                    }

                    const team = await TeamManagementModel.findOne( {
                        id: teamId,
                    } ).exec();

                    if ( !team ) {
                        ApiResponseBuilder.validationError(
                            res,
                            "Team not found for the provided ID",
                        );
                        return;
                    }

                    ApiResponseBuilder.ok(
                        res,
                        "team",
                        team,
                        "Team fetched successfully",
                    );
                    return;
                } catch ( error ) {
                    console.error(
                        "[Error while fetching team by ID]:\n",
                        error,
                    );
                    ApiResponseBuilder.internalError( res, error );
                    return;
                }
            },
        );
    }

    // ========================================================================
    // PATCH /update/:teamId  (JSON or multipart)
    // ========================================================================

    private registerUpdateTeam(): void {
        this.router.patch(
            "/update/:teamId",
            async ( req: Request, res: Response ): Promise<void> => {
                try {
                    const teamId = String(
                        req.params.teamId ?? "",
                    ).trim();
                    if ( !teamId ) {
                        ApiResponseBuilder.validationError(
                            res,
                            "Team ID is required",
                        );
                        return;
                    }

                    // ----------------------------------------------------------------
                    // 0) Prepare context
                    // ----------------------------------------------------------------
                    const nowIso: string = new Date().toISOString();
                    const root = `${ req.protocol }://${ req.get( "host" ) }`;

                    let payload: any = {};
                    let teamLogoEvidence: TaskEvidence | undefined;

                    // ----------------------------------------------------------------
                    // 1) Detect multipart vs JSON and normalise payload
                    // ----------------------------------------------------------------
                    const isMultipart: boolean =
                        ( req.headers[ "content-type" ] ?? "" )
                            .toString()
                            .includes( "multipart/form-data" );

                    if ( isMultipart ) {
                        // 1.a) Handle logo upload (optional)
                        const uploadSubPath: string = `team-management/${ teamId }/logo`;

                        let uploadedFiles: FileMetaBase[] = [];
                        try {
                            uploadedFiles = await FileUploader.handleUpload(
                                uploadSubPath,
                                "teamLogo", // field name from FE FormData.append('teamLogo', file)
                                req,
                            );
                        } catch ( uploadError ) {
                            // Logo is optional on update – just log and continue
                            console.error(
                                "[TeamManagement:update] Logo upload failed:",
                                uploadError,
                            );
                        }

                        // 1.b) Parse JSON payload from multipart field "team"
                        const rawTeamField: unknown = ( req.body as any )?.team;

                        if (
                            typeof rawTeamField === "string" &&
                            rawTeamField.trim()
                        ) {
                            try {
                                payload = JSON.parse( rawTeamField );
                            } catch ( parseError ) {
                                console.error(
                                    "[TeamManagement:update] Failed to parse 'team' JSON:",
                                    parseError,
                                );
                                ApiResponseBuilder.validationError(
                                    res,
                                    "Malformed team JSON payload",
                                );
                                return;
                            }
                        } else {
                            // On update, empty team JSON is allowed → just no payload fields
                            payload = {};
                        }

                        // 1.c) If a new logo was uploaded, build TaskEvidence from FileMetaBase
                        if ( Array.isArray( uploadedFiles ) && uploadedFiles.length > 0 ) {
                            const fileMeta: FileMetaBase | undefined = uploadedFiles[ 0 ];
                            if ( !fileMeta ) {
                                ApiResponseBuilder.error( res, 404, "File not found!" );
                                return;
                            }

                            const relativePath: string =
                                `${ this.PUBLIC_UPLOAD_URL_ROOT }/${ teamId }/logo/${ fileMeta.storedName }`;

                            const rawLogoMeta: Record<string, unknown> = {
                                name: fileMeta.originalName,
                                storageKey: relativePath,
                                url: `${ root }/${ relativePath }`,
                                category: "team_logo",
                                refId: teamId,
                                fileMeta,
                            };

                            teamLogoEvidence = this.buildEvidenceFromMeta(
                                rawLogoMeta,
                            );
                        }
                    } else {
                        // Legacy JSON-only behaviour
                        payload = req.body;
                    }

                    // ----------------------------------------------------------------
                    // 2) Build partial update object from payload
                    // ----------------------------------------------------------------
                    const update: Partial<ITeamManagement> = {};

                    // teamName (optional)
                    if ( typeof payload.teamName === "string" ) {
                        const trimmed = payload.teamName.trim();
                        if ( trimmed ) {
                            update.teamName = trimmed;
                        }
                    }

                    // domain (optional but validated if present)
                    if (
                        typeof payload.domain === "string" &&
                        payload.domain.trim()
                    ) {
                        const domainLower = payload.domain.trim().toLowerCase();
                        if ( !this.isValidTeamDomain( domainLower ) ) {
                            ApiResponseBuilder.validationError(
                                res,
                                "Invalid domain. Allowed values: sales, development, support, operations, marketing, finance, other.",
                            );
                            return;
                        }
                        update.domain = domainLower as TeamDomain;
                    }

                    // description (optional)
                    if ( typeof payload.description === "string" ) {
                        update.description = payload.description.trim();
                    }

                    // isActive (optional)
                    if ( typeof payload.isActive !== "undefined" ) {
                        const parsed = this.parseBooleanQuery( payload.isActive );
                        update.isActive = parsed !== undefined ? parsed : true;
                    }

                    // Members & memberTotal (optional)
                    if ( typeof payload.members !== "undefined" ) {
                        const memberRefs =
                            this.extractTeamMembersFromArray( payload.members );
                        update.members = memberRefs;
                        update.memberTotal = memberRefs.length;
                    }

                    // Captain (optional)
                    if ( typeof payload.captain !== "undefined" ) {
                        const captainRef = this.extractTeamMember( payload.captain );
                        if ( captainRef ) {
                            update.captain = captainRef;
                        }
                    }

                    // Tasks patch (full replace – optional)
                    if ( Array.isArray( payload.assignTasks ) ) {
                        update.assignTasks = payload.assignTasks.map(
                            ( t: unknown ) => this.buildAssignedTaskFromBody( t ),
                        );
                    }

                    // Team logo patch
                    //  a) if new file uploaded → use teamLogoEvidence
                    //  b) else if body JSON still has logo meta → normalise via buildEvidenceFromMeta
                    if ( teamLogoEvidence ) {
                        ( update as ITeamManagement ).teamLogo = teamLogoEvidence;
                    } else if ( payload.teamLogo ) {
                        update.teamLogo = this.buildEvidenceFromMeta(
                            payload.teamLogo,
                        );
                    }

                    // Always bump updatedAt
                    update.updatedAt = nowIso;

                    // ----------------------------------------------------------------
                    // 3) Persist update
                    // ----------------------------------------------------------------
                    const updated =
                        await TeamManagementModel.findOneAndUpdate(
                            { id: teamId },
                            { $set: update },
                            { new: true },
                        ).exec();

                    if ( !updated ) {
                        ApiResponseBuilder.validationError(
                            res,
                            "Team not found for update",
                        );
                        return;
                    }

                    ApiResponseBuilder.ok(
                        res,
                        "team",
                        updated,
                        "Team updated successfully",
                    );

                    // ----------------------------------------------------------------
                    // 4) Notification (similar style to create, but "update")
                    // ----------------------------------------------------------------
                    const notificationService = new NotificationService();
                    const io = req.app.get( "io" ) as import( "socket.io" ).Server;

                    await notificationService.createNotification(
                        {
                            title: "Update Team",
                            body: `Team "${ updated.teamName }" has been updated.`,
                            type: "update",
                            severity: "info",
                            audience: {
                                mode: "role",
                                roles: [ "admin", "manager", "operator" ],
                            },
                            channels: [ "inapp", "email" ],
                            metadata: {
                                refId: updated.id ?? "",
                                data: { team: updated },
                            },
                        },
                        ( rooms, payload ) =>
                            rooms.forEach( ( r ) =>
                                io.to( r ).emit( "notification.new", payload ),
                            ),
                    );

                    return;
                } catch ( error ) {
                    console.error(
                        "[Unexpected error during team update]:\n",
                        error,
                    );
                    ApiResponseBuilder.internalError( res, error );
                    return;
                }
            },
        );
    }

    // ========================================================================
    // DELETE /delete/:teamId
    // ========================================================================

    private registerDeleteTeam(): void {
        this.router.delete(
            "/delete/:teamId",
            async ( req: Request, res: Response ): Promise<void> => {
                try {
                    const teamId = String(
                        req.params.teamId ?? "",
                    ).trim();
                    if ( !teamId ) {
                        ApiResponseBuilder.validationError(
                            res,
                            "Team ID is required",
                        );
                        return;
                    }

                    const softRaw = req.query.soft;
                    const softParsed = this.parseBooleanQuery( softRaw );
                    const soft: boolean =
                        softParsed !== undefined ? softParsed : true;

                    if ( soft ) {
                        const updated =
                            await TeamManagementModel.findOneAndUpdate(
                                { id: teamId },
                                {
                                    $set: {
                                        isActive: false,
                                        updatedAt: new Date().toISOString(),
                                    },
                                },
                                { new: true },
                            ).exec();

                        if ( !updated ) {
                            ApiResponseBuilder.validationError(
                                res,
                                "Team not found for soft delete",
                            );
                            return;
                        }

                        ApiResponseBuilder.ok(
                            res,
                            "team",
                            updated,
                            "Team deactivated (soft delete) successfully",
                        );
                        return;
                    }

                    const deleted =
                        await TeamManagementModel.findOneAndDelete( {
                            id: teamId,
                        } ).exec();

                    if ( !deleted ) {
                        ApiResponseBuilder.validationError(
                            res,
                            "Team not found for hard delete",
                        );
                        return;
                    }

                    ApiResponseBuilder.ok(
                        res,
                        "team",
                        deleted,
                        "Team deleted permanently",
                    );
                    return;
                } catch ( error ) {
                    console.error(
                        "[Error during team delete]:\n",
                        error,
                    );
                    ApiResponseBuilder.internalError( res, error );
                    return;
                }
            },
        );
    }

    // ========================================================================
    // FILE UPLOAD ROUTES
    // ========================================================================

    private registerUploadTeamLogo(): void {
        this.router.post(
            "/upload/logo/:teamId",
            async ( req: Request, res: Response ): Promise<void> => {
                try {
                    const teamId = String(
                        req.params.teamId ?? "",
                    ).trim();
                    if ( !teamId ) {
                        ApiResponseBuilder.validationError(
                            res,
                            "Team ID is required for logo upload",
                        );
                        return;
                    }

                    const subPath = `team-management/${ teamId }/logo`;

                    const files: FileMetaBase[] =
                        await FileUploader.handleUpload(
                            subPath,
                            "teamLogo", // keep same field name as create/update
                            req,
                        );

                    if ( !Array.isArray( files ) || files.length === 0 ) {
                        ApiResponseBuilder.validationError(
                            res,
                            "No files were uploaded for team logo",
                        );
                        return;
                    }

                    ApiResponseBuilder.ok(
                        res,
                        "files",
                        files,
                        "Team logo uploaded successfully",
                    );
                    return;
                } catch ( error ) {
                    console.error(
                        "[Error during team logo upload]:\n",
                        error,
                    );
                    ApiResponseBuilder.internalError( res, error );
                    return;
                }
            },
        );
    }

    // ========================================================================
    // STATS ROUTES
    // ========================================================================

    private registerGetAllTeamTotals(): void {
        this.router.get(
            "/stats/teams-total",
            async ( _req: Request, res: Response ): Promise<void> => {
                try {
                    const [ totalTeams, totalActive, totalInactive ] =
                        await Promise.all( [
                            TeamManagementModel.countDocuments( {} ).exec(),
                            TeamManagementModel.countDocuments( {
                                isActive: true,
                            } ).exec(),
                            TeamManagementModel.countDocuments( {
                                isActive: false,
                            } ).exec(),
                        ] );

                    const domainTotals: Record<TeamDomain, number> =
                        {} as Record<TeamDomain, number>;

                    for ( const domain of this.ALLOWED_TEAM_DOMAINS ) {
                        // eslint-disable-next-line no-await-in-loop
                        const countForDomain: number =
                            await TeamManagementModel.countDocuments( {
                                domain,
                            } ).exec();

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
                        "Team totals fetched successfully",
                    );
                    return;
                } catch ( error ) {
                    console.error(
                        "[Error while fetching team totals]:\n",
                        error,
                    );
                    ApiResponseBuilder.internalError( res, error );
                    return;
                }
            },
        );
    }

    private registerGetTeamTotalByDomain(): void {
        this.router.get(
            "/stats/teams-total/domain/:domain",
            async ( req: Request, res: Response ): Promise<void> => {
                try {
                    const rawDomain: string = String(
                        req.params.domain ?? "",
                    )
                        .trim()
                        .toLowerCase();

                    if ( !rawDomain || !this.isValidTeamDomain( rawDomain ) ) {
                        ApiResponseBuilder.validationError(
                            res,
                            "Invalid domain. Allowed values: sales, development, support, operations, marketing, finance, other.",
                        );
                        return;
                    }

                    const domain: TeamDomain = rawDomain as TeamDomain;

                    const activeQueryRaw = this.parseBooleanQuery(
                        req.query.active,
                    );

                    let totalTeams: number;
                    let totalActive: number;
                    let totalInactive: number;

                    if ( activeQueryRaw !== undefined ) {
                        const activeValue: boolean = activeQueryRaw;

                        totalTeams =
                            await TeamManagementModel.countDocuments( {
                                domain,
                                isActive: activeValue,
                            } ).exec();

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
                        [ totalTeams, totalActive, totalInactive ] =
                            await Promise.all( [
                                TeamManagementModel.countDocuments( {
                                    domain,
                                } ).exec(),
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
                        "Team domain totals fetched successfully",
                    );
                    return;
                } catch ( error ) {
                    console.error(
                        "[Error while fetching team domain totals]:\n",
                        error,
                    );
                    ApiResponseBuilder.internalError( res, error );
                    return;
                }
            },
        );
    }

    // ========================================================================
    // USER MEMBERSHIP (GLOBAL)
    // ========================================================================

    private registerUsersWithoutAnyTeam(): void {
        this.router.get(
            "/users/no-team",
            async ( req: Request, res: Response ): Promise<void> => {
                try {
                    const { index, limit, skip } = this.parsePagination(
                        req,
                        10,
                    );

                    const teamUserIds: Types.ObjectId[] =
                        await this.collectTeamUserIdsByDomain();

                    const filter: FilterQuery<User> = {};
                    if ( teamUserIds.length > 0 ) {
                        filter._id = { $nin: teamUserIds };
                    }



                    const [ total, users ] = await Promise.all( [
                        UserModel.countDocuments( filter ).exec(),
                        UserModel.find( filter, USER_MODEL_PROJECTION )
                            .skip( skip )
                            .limit( limit )
                            .lean<User>()
                            .exec() as unknown as User[],
                    ] );

                    const pagination: PaginationMeta = {
                        total,
                        index,
                        limit,
                    };

                    ApiResponseBuilder.ok(
                        res,
                        "users",
                        users,
                        "Users without any team fetched successfully",
                        { pagination },
                    );
                    return;
                } catch ( error ) {
                    console.error(
                        "[Error while fetching users without team]:\n",
                        error,
                    );
                    ApiResponseBuilder.internalError( res, error );
                    return;
                }
            },
        );
    }

    private registerUsersWithoutAnyTeamCount(): void {
        this.router.get(
            "/users/no-team/count",
            async ( _req: Request, res: Response ): Promise<void> => {
                try {
                    const teamUserIds: Types.ObjectId[] =
                        await this.collectTeamUserIdsByDomain();

                    const filter: FilterQuery<User> = {};
                    if ( teamUserIds.length > 0 ) {
                        filter._id = { $nin: teamUserIds };
                    }

                    const total: number =
                        await UserModel.countDocuments( filter ).exec();

                    ApiResponseBuilder.ok(
                        res,
                        "other",
                        {},
                        "Total users without any team fetched successfully",
                        { pagination: { total } },
                    );
                    return;
                } catch ( error ) {
                    console.error(
                        "[Error while counting users without team]:\n",
                        error,
                    );
                    ApiResponseBuilder.internalError( res, error );
                    return;
                }
            },
        );
    }

    private registerUsersInAnyTeam(): void {
        this.router.get(
            "/users/in-teams",
            async ( req: Request, res: Response ): Promise<void> => {
                try {
                    const { index, limit, skip } = this.parsePagination(
                        req,
                        10,
                    );

                    const teamUserIds: Types.ObjectId[] =
                        await this.collectTeamUserIdsByDomain();

                    if ( teamUserIds.length === 0 ) {
                        const pagination: PaginationMeta = {
                            total: 0,
                            index,
                            limit,
                        };

                        ApiResponseBuilder.ok(
                            res,
                            "other",
                            { users: [] as User[], pagination },
                            "No users found in any team",
                        );
                        return;
                    }

                    const filter: FilterQuery<User> = {
                        _id: { $in: teamUserIds },
                    };


                    const [ total, users ] = await Promise.all( [
                        UserModel.countDocuments( filter ).exec(),
                        UserModel.find( filter, USER_MODEL_PROJECTION )
                            .skip( skip )
                            .limit( limit )
                            .lean<User>()
                            .exec() as unknown as User[],
                    ] );

                    const pagination: PaginationMeta = {
                        total,
                        index,
                        limit,
                    };

                    ApiResponseBuilder.ok(
                        res,
                        "users",
                        users,
                        "Users in teams fetched successfully",
                        { pagination },
                    );
                    return;
                } catch ( error ) {
                    console.error(
                        "[Error while fetching users in teams]:\n",
                        error,
                    );
                    ApiResponseBuilder.internalError( res, error );
                    return;
                }
            },
        );
    }

    private registerUsersInAnyTeamCount(): void {
        this.router.get(
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
                            "Total users in teams fetched successfully",
                        );
                        return;
                    }

                    const filter: FilterQuery<User> = {
                        _id: { $in: teamUserIds },
                    };

                    const total: number =
                        await UserModel.countDocuments( filter ).exec();

                    ApiResponseBuilder.ok(
                        res,
                        "other",
                        {},
                        "Total users in teams fetched successfully",
                        { pagination: { total } },
                    );
                    return;
                } catch ( error ) {
                    console.error(
                        "[Error while counting users in teams]:\n",
                        error,
                    );
                    ApiResponseBuilder.internalError( res, error );
                    return;
                }
            },
        );
    }

    // ========================================================================
    // USER MEMBERSHIP (DOMAIN SPECIFIC)
    // ========================================================================

    private registerUsersWithoutTeamByDomain(): void {
        this.router.get(
            "/users/no-team/domain/:domain",
            async ( req: Request, res: Response ): Promise<void> => {
                try {
                    const rawDomain: string = String(
                        req.params.domain ?? "",
                    )
                        .trim()
                        .toLowerCase();

                    if ( !rawDomain || !this.isValidTeamDomain( rawDomain ) ) {
                        ApiResponseBuilder.validationError(
                            res,
                            "Invalid domain. Allowed values: sales, development, support, operations, marketing, finance, other.",
                        );
                        return;
                    }

                    const domain = rawDomain as TeamDomain;
                    const { index, limit, skip } = this.parsePagination(
                        req,
                        10,
                    );

                    const teamUserIds: Types.ObjectId[] =
                        await this.collectTeamUserIdsByDomain( domain );

                    const filter: FilterQuery<User> = {};
                    if ( teamUserIds.length > 0 ) {
                        filter._id = { $nin: teamUserIds };
                    }



                    const [ total, users ] = await Promise.all( [
                        UserModel.countDocuments( filter, USER_MODEL_PROJECTION ).exec(),
                        UserModel.find( filter )
                            .skip( skip )
                            .limit( limit )
                            .lean<User>()
                            .exec() as unknown as User[],
                    ] );

                    const pagination: PaginationMeta = {
                        total,
                        index,
                        limit,
                    };

                    ApiResponseBuilder.ok(
                        res,
                        "users",
                        users,
                        "Users without any team for the domain fetched successfully",
                        { pagination, other: { domain } },
                    );
                    return;
                } catch ( error ) {
                    console.error(
                        "[Error while fetching domain users without team]:\n",
                        error,
                    );
                    ApiResponseBuilder.internalError( res, error );
                    return;
                }
            },
        );
    }

    private registerUsersWithoutTeamByDomainCount(): void {
        this.router.get(
            "/users/no-team/domain/:domain/count",
            async ( req: Request, res: Response ): Promise<void> => {
                try {
                    const rawDomain: string = String(
                        req.params.domain ?? "",
                    )
                        .trim()
                        .toLowerCase();

                    if ( !rawDomain || !this.isValidTeamDomain( rawDomain ) ) {
                        ApiResponseBuilder.validationError(
                            res,
                            "Invalid domain. Allowed values: sales, development, support, operations, marketing, finance, other.",
                        );
                        return;
                    }

                    const domain = rawDomain as TeamDomain;

                    const teamUserIds: Types.ObjectId[] =
                        await this.collectTeamUserIdsByDomain( domain );

                    const filter: FilterQuery<User> = {};
                    if ( teamUserIds.length > 0 ) {
                        filter._id = { $nin: teamUserIds };
                    }

                    const total: number =
                        await UserModel.countDocuments( filter ).exec();

                    ApiResponseBuilder.ok(
                        res,
                        "other",
                        { domain },
                        "Total users without team for domain fetched successfully",
                        { pagination: { total } },
                    );
                    return;
                } catch ( error ) {
                    console.error(
                        "[Error while counting domain users without team]:\n",
                        error,
                    );
                    ApiResponseBuilder.internalError( res, error );
                    return;
                }
            },
        );
    }

    private registerUsersInTeamByDomain(): void {
        this.router.get(
            "/users/in-teams/domain/:domain",
            async ( req: Request, res: Response ): Promise<void> => {
                try {
                    const rawDomain: string = String(
                        req.params.domain ?? "",
                    )
                        .trim()
                        .toLowerCase();

                    if ( !rawDomain || !this.isValidTeamDomain( rawDomain ) ) {
                        ApiResponseBuilder.validationError(
                            res,
                            "Invalid domain. Allowed values: sales, development, support, operations, marketing, finance, other.",
                        );
                        return;
                    }

                    const domain = rawDomain as TeamDomain;
                    const { index, limit, skip } = this.parsePagination(
                        req,
                        10,
                    );

                    const teamUserIds: Types.ObjectId[] =
                        await this.collectTeamUserIdsByDomain( domain );

                    if ( teamUserIds.length === 0 ) {
                        const pagination: PaginationMeta = {
                            total: 0,
                            index,
                            limit,
                        };

                        ApiResponseBuilder.ok(
                            res,
                            "other",
                            { domain, users: [] as User[], pagination },
                            "No users found in teams for given domain",
                        );
                        return;
                    }

                    const filter: FilterQuery<User> = {
                        _id: { $in: teamUserIds },
                    };

                    const [ total, users ] = await Promise.all( [
                        UserModel.countDocuments( filter ).exec(),
                        UserModel.find( filter, USER_MODEL_PROJECTION )
                            .skip( skip )
                            .limit( limit )
                            .lean<User>()
                            .exec() as unknown as User[],
                    ] );

                    const pagination: PaginationMeta = {
                        total,
                        index,
                        limit,
                    };

                    ApiResponseBuilder.ok(
                        res,
                        "users",
                        users,
                        "Users in teams for domain fetched successfully",
                        { other: { domain }, pagination },
                    );
                    return;
                } catch ( error ) {
                    console.error(
                        "[Error while fetching domain users in teams]:\n",
                        error,
                    );
                    ApiResponseBuilder.internalError( res, error );
                    return;
                }
            },
        );
    }

    private registerUsersInTeamByDomainCount(): void {
        this.router.get(
            "/users/in-teams/domain/:domain/count",
            async ( req: Request, res: Response ): Promise<void> => {
                try {
                    const rawDomain: string = String(
                        req.params.domain ?? "",
                    )
                        .trim()
                        .toLowerCase();

                    if ( !rawDomain || !this.isValidTeamDomain( rawDomain ) ) {
                        ApiResponseBuilder.validationError(
                            res,
                            "Invalid domain. Allowed values: sales, development, support, operations, marketing, finance, other.",
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
                            "Total users in teams for domain fetched successfully",
                        );
                        return;
                    }

                    const filter: FilterQuery<User> = {
                        _id: { $in: teamUserIds },
                    };

                    const total: number =
                        await UserModel.countDocuments( filter ).exec();

                    ApiResponseBuilder.ok(
                        res,
                        "other",
                        { domain },
                        "Total users in teams for domain fetched successfully",
                        { pagination: { total } },
                    );
                    return;
                } catch ( error ) {
                    console.error(
                        "[Error while counting domain users in teams]:\n",
                        error,
                    );
                    ApiResponseBuilder.internalError( res, error );
                    return;
                }
            },
        );
    }

    // ========================================================================
    // GET /users/all?index=&limit=&search=
    //   → All users with their team + domain (if any)
    // ========================================================================

    private registerGetAllUsersWithTeams(): void {
        this.router.get(
            "/users/all",
            async ( req: Request, res: Response ): Promise<void> => {
                try {
                    // 1) Pagination (index = page, limit = page size, skip = offset)
                    const { index, limit, skip } = this.parsePagination( req, 10 );

                    // 2) Optional search term
                    const rawSearch = req.query.search;
                    const search: string | undefined =
                        typeof rawSearch === "string" && rawSearch.trim().length > 0
                            ? rawSearch.trim()
                            : undefined;

                    // 3) Filters for users and teams (for potential future refinement)
                    const teamFilter: FilterQuery<ITeamManagement> = {};
                    const userFilter: FilterQuery<User> = {};

                    if ( search ) {
                        const rx = new RegExp( search, "i" );

                        // Team-side search (teamName / domain / id)
                        teamFilter.$or = [
                            { teamName: rx },
                            { domain: rx },
                            { id: rx },
                        ];

                        // User-side search (name / username / email)
                        userFilter.$or = [
                            { name: rx },
                            { username: rx },
                            { email: rx },
                        ];
                    }

                    // ─────────────────────────────────────────────────────────────
                    // Aggregation pipeline
                    //  - Start from User collection
                    //  - Lookup "all teams" into `teams` (lightweight: name + domain)
                    //  - Lookup "newest membership" into `latestTeam`
                    //  - Flatten latestTeam[0] → domain, teamName, roleInTeam, teamReason, teamJoinedAt
                    //  - Hide internal helpers & password
                    //  - Sort + paginate
                    // ─────────────────────────────────────────────────────────────
                    const pipeline: PipelineStage[] = [
                        // 1) Filter users by userFilter (if any search on user fields)
                        { $match: userFilter },

                        // 2) Lookup ALL teams this user belongs to → `teams`
                        {
                            $lookup: {
                                from: TeamManagementModel.collection.name,
                                let: {
                                    userId: "$_id",
                                    username: "$username",
                                },
                                pipeline: [
                                    {
                                        $match: {
                                            // Optional team-side search (teamFilter) – only applied inside teams
                                            ...( Array.isArray( teamFilter.$or ) &&
                                                teamFilter.$or.length > 0
                                                ? { $or: teamFilter.$or }
                                                : {} ),
                                            $expr: {
                                                $gt: [
                                                    {
                                                        $size: {
                                                            $filter: {
                                                                input: "$members",
                                                                as: "m",
                                                                cond: {
                                                                    $or: [
                                                                        {
                                                                            $eq: [
                                                                                "$$m.id",
                                                                                "$$userId",
                                                                            ],
                                                                        },
                                                                        {
                                                                            $eq: [
                                                                                "$$m.username",
                                                                                "$$username",
                                                                            ],
                                                                        },
                                                                    ],
                                                                },
                                                            },
                                                        },
                                                    },
                                                    0,
                                                ],
                                            },
                                        },
                                    },
                                    {
                                        // Only keep what we need for AllUserWithTeams.teams[]
                                        $project: {
                                            _id: 0,
                                            teamName: 1,
                                            domain: 1,
                                        },
                                    },
                                ],
                                as: "teams",
                            },
                        },

                        // 2.1) Normalise teams → [] if null (defensive)
                        {
                            $addFields: {
                                teams: {
                                    $ifNull: [ "$teams", [] ],
                                },
                            },
                        },

                        // 3) Lookup NEWEST membership → `latestTeam`
                        {
                            $lookup: {
                                from: TeamManagementModel.collection.name,
                                let: {
                                    userId: "$_id",
                                    username: "$username",
                                },
                                pipeline: [
                                    // 3.1) Teams that contain this user (by id or username)
                                    {
                                        $match: {
                                            $expr: {
                                                $gt: [
                                                    {
                                                        $size: {
                                                            $filter: {
                                                                input: "$members",
                                                                as: "m",
                                                                cond: {
                                                                    $or: [
                                                                        {
                                                                            $eq: [
                                                                                "$$m.id",
                                                                                "$$userId",
                                                                            ],
                                                                        },
                                                                        {
                                                                            $eq: [
                                                                                "$$m.username",
                                                                                "$$username",
                                                                            ],
                                                                        },
                                                                    ],
                                                                },
                                                            },
                                                        },
                                                    },
                                                    0,
                                                ],
                                            },
                                        },
                                    },
                                    // 3.2) Extract membershipForUser[] (only this user's member entries)
                                    {
                                        $addFields: {
                                            membershipForUser: {
                                                $filter: {
                                                    input: "$members",
                                                    as: "m",
                                                    cond: {
                                                        $or: [
                                                            {
                                                                $eq: [
                                                                    "$$m.id",
                                                                    "$$userId",
                                                                ],
                                                            },
                                                            {
                                                                $eq: [
                                                                    "$$m.username",
                                                                    "$$username",
                                                                ],
                                                            },
                                                        ],
                                                    },
                                                },
                                            },
                                        },
                                    },
                                    // 3.3) Unwind to sort by joinedAt
                                    { $unwind: "$membershipForUser" },

                                    // 3.4) Newest joinedAt first
                                    // joinedAt is ISODateString, so lexicographic sort still works
                                    { $sort: { "membershipForUser.joinedAt": -1 } },

                                    // 3.5) Only keep the newest membership
                                    { $limit: 1 },

                                    // 3.6) Project fields we care about for top-level DTO
                                    {
                                        $project: {
                                            _id: 0,
                                            teamName: 1,
                                            domain: 1,
                                            roleInTeam:
                                                "$membershipForUser.roleInTeam",
                                            teamReason:
                                                "$membershipForUser.reason",
                                            teamJoinedAt:
                                                "$membershipForUser.joinedAt",
                                        },
                                    },
                                ],
                                as: "latestTeam", // max 1 element
                            },
                        },

                        // 4) Flatten `latestTeam[0]` into top-level fields
                        {
                            $addFields: {
                                // root `domain` is domain of newest team
                                domain: {
                                    $ifNull: [
                                        {
                                            $arrayElemAt: [
                                                "$latestTeam.domain",
                                                0,
                                            ],
                                        },
                                        null,
                                    ],
                                },
                                teamName: {
                                    $ifNull: [
                                        {
                                            $arrayElemAt: [
                                                "$latestTeam.teamName",
                                                0,
                                            ],
                                        },
                                        null, // 🔧 ADDED DEFAULT VALUE
                                    ],
                                },
                                roleInTeam: {
                                    $ifNull: [
                                        {
                                            $arrayElemAt: [
                                                "$latestTeam.roleInTeam",
                                                0,
                                            ],
                                        },
                                        null,
                                    ],
                                },
                                teamReason: {
                                    $ifNull: [
                                        {
                                            $arrayElemAt: [
                                                "$latestTeam.teamReason",
                                                0,
                                            ],
                                        },
                                        null,
                                    ],
                                },
                                teamJoinedAt: {
                                    $ifNull: [
                                        {
                                            $arrayElemAt: [
                                                "$latestTeam.teamJoinedAt",
                                                0,
                                            ],
                                        },
                                        null,
                                    ],
                                },
                            },
                        },

                        // 5) Cleanup – hide password + internal helper `latestTeam`
                        {
                            $project: {
                                password: 0,
                                latestTeam: 0,
                                // NOTE: we KEEP `teams` here because AllUserWithTeams.teams[] needs it
                            },
                        },

                        // 6) Sort & paginate
                        { $sort: { createdAt: -1 } },
                        { $skip: skip },
                        { $limit: limit },
                        {
                            $project: USER_MODEL_PROJECTION,
                        },
                    ];

                    // Run aggregation + total count in parallel
                    const [ users, totalCount ] = await Promise.all( [
                        UserModel.aggregate<AllUserWithTeams>( pipeline ).exec(),
                        UserModel.countDocuments( userFilter ).exec(),
                    ] );

                    const totalPages = Math.ceil( totalCount / limit );
                    const hasMore = index + 1 < totalPages;

                    const pagination = {
                        index,
                        limit,
                        total: totalCount,
                        totalPages,
                        hasMore,
                    };

                    ApiResponseBuilder.ok(
                        res,
                        "other",
                        { users },
                        "Users with latest team/domain loaded successfully.",
                        { pagination },
                    );
                    return;
                } catch ( error ) {
                    console.error(
                        "[Error while getting users with teams]:\n",
                        error,
                    );
                    ApiResponseBuilder.internalError( res, error );
                    return;
                }
            },
        );
    }

}
