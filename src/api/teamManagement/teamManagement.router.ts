// Path: src/api/teamManagement/teamManagement.router.ts
// ============================================================================
// Team Management Router (class-based) — FIXED
// ----------------------------------------------------------------------------
// ============================================================================

import express, { Request, Response, Router } from "express";
import type { FilterQuery, PipelineStage } from "mongoose";
import { Types } from "mongoose";

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
    type TeamManagementDto,
    type TaskTiming,
    type TaskAuditMeta,
    type TaskSlaPolicy,
    type TaskRuntimeMetrics,
    type TaskCompletionConfirmation,
} from "../../models/teamManagement/teamManagement.model";

import {
    User,
    USER_MODEL_PROJECTION,
    UserModel,
} from "../../models/user.model";

import { FileMetaPacket, PaginationMeta } from "../../types/api-message";
import { ApiResponseBuilder } from "../../utils/api-combiner.builder";
import FileUploader, { type UploadResultPacket } from "../../utils/file-uploader.helper";
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
        this.registerRoutes();
    }

    public get route(): Router {
        return this.router;
    }

    private registerRoutes(): void {
        // ─────────────────────────────────────────────
        // IMPORTANT: register "fixed-prefix" routes first
        // ─────────────────────────────────────────────

        // Core team operations (fixed paths first)
        this.registerCreateTeam();     // POST   /create
        this.getTeamByTeamName();      // GET    /teamName/:teamName
        this.registerGetAllTeams();    // GET    /all

        // File upload only
        this.registerUploadTeamLogo(); // POST   /upload/logo/:teamCode

        // Totals
        this.registerGetAllTeamTotals();      // GET /stats/teams-total
        this.registerGetTeamTotalByDomain();  // GET /stats/teams-total/domain/:domain

        // User membership analytics (global)
        this.registerUsersWithoutAnyTeam();       // GET /users/no-team
        this.registerUsersWithoutAnyTeamCount();  // GET /users/no-team/count
        this.registerUsersInAnyTeam();            // GET /users/in-teams
        this.registerUsersInAnyTeamCount();       // GET /users/in-teams/count

        // User membership analytics (domain-specific)
        this.registerUsersWithoutTeamByDomain();       // GET /users/no-team/domain/:domain
        this.registerUsersWithoutTeamByDomainCount();  // GET /users/no-team/domain/:domain/count
        this.registerUsersInTeamByDomain();            // GET /users/in-teams/domain/:domain
        this.registerUsersInTeamByDomainCount();       // GET /users/in-teams/domain/:domain/count

        // All users + team/domain mapping
        this.registerGetAllUsersWithTeams(); // GET /users/all?index=&limit=&search=

        // Mutations
        this.registerUpdateTeam(); // PATCH /update/:teamCode
        this.registerDeleteTeam(); // DELETE /delete/:teamCode

        // ─────────────────────────────────────────────
        // ✅ CATCH-ALL MUST BE LAST (prevents route hijacking)
        // ─────────────────────────────────────────────
        this.registerGetTeamByCode(); // GET /:teamCode
    }
    // ========================================================================
    // 1) Generic helpers (centralised)
    // ========================================================================

    private isValidTeamDomain( domain: string ): domain is TeamDomain {
        return this.ALLOWED_TEAM_DOMAINS.includes( domain as TeamDomain );
    }

    private parsePagination(
        req: Request,
        fallbackLimit: number = 10
    ): { index: number; limit: number; skip: number; } {
        const indexNum = Number( req.query.index );
        const limitNum = Number( req.query.limit );

        const index: number = Number.isFinite( indexNum ) && indexNum >= 0 ? indexNum : 0;
        const limit: number = Number.isFinite( limitNum ) && limitNum > 0 ? limitNum : fallbackLimit;

        return { index, limit, skip: index * limit };
    }

    private parseBooleanQuery( value: unknown ): boolean | undefined {
        if ( typeof value === "boolean" ) return value;
        if ( typeof value === "string" ) {
            const n = value.trim().toLowerCase();
            if ( n === "true" || n === "1" ) return true;
            if ( n === "false" || n === "0" ) return false;
        }
        return undefined;
    }

    // ========================================================================
    // 2) Core ID + parsing helpers (centralised)
    // ========================================================================

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
        const entropy = Array.from( { length: 6 } )
            .map( () => SAFE_CHARS[ Math.floor( Math.random() * SAFE_CHARS.length ) ] )
            .join( "" );

        const seed = `${ dateBlock }${ timeBlock }${ entropy }`;
        let hash = 0;
        for ( let i = 0; i < seed.length; i++ ) {
            hash = ( hash * 31 + seed.charCodeAt( i ) ) % 9973;
        }

        const c1 = SAFE_CHARS[ hash % SAFE_CHARS.length ];
        const c2 = SAFE_CHARS[ ( hash >> 3 ) % SAFE_CHARS.length ];

        return `${ PREFIX }-${ dateBlock }-${ timeBlock }-${ entropy }-${ c1 }${ c2 }`;
    }

    private buildAssignedTaskId(): string {
        const now = Date.now().toString( 36 ).toUpperCase();
        const rand = Math.random().toString( 36 ).slice( 2, 8 ).toUpperCase();
        return `TASK-${ now }-${ rand }`;
    }

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

    private resolveRoleInTeam( raw: unknown ): RoleInTeam | undefined {
        if ( typeof raw !== "string" ) return undefined;
        const r = raw.trim().toLowerCase();
        if ( !r ) return undefined;

        const matched = ( TEAM_ROLES as readonly string[] ).find( ( x ) => x === r );
        return matched ? ( matched as RoleInTeam ) : undefined;
    }

    private extractTeamMembersFromArray( input: unknown ): TeamMember[] {
        if ( !Array.isArray( input ) ) return [];

        const result: TeamMember[] = [];
        for ( const raw of input as unknown[] ) {
            if ( !raw || typeof raw !== "object" ) continue;

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
            const usernameSource = anyU.username ?? anyU.userName ?? anyU.name;

            if ( !idSource || typeof usernameSource !== "string" ) continue;

            const username = usernameSource.trim();
            if ( !username ) continue;

            let oid: Types.ObjectId;
            try {
                oid = new Types.ObjectId( String( idSource ) );
            } catch {
                continue;
            }

            const member: TeamMember = {
                id: oid,
                username: username as User[ "username" ],
            };

            const role = this.resolveRoleInTeam( anyU.roleInTeam );
            if ( role ) member.roleInTeam = role;

            if ( typeof anyU.reason === "string" ) {
                const rr = anyU.reason.trim();
                if ( rr ) member.reason = rr;
            }

            if ( typeof anyU.joinedAt === "string" ) {
                const ja = anyU.joinedAt.trim();
                if ( ja && !Number.isNaN( Date.parse( ja ) ) ) {
                    member.joinedAt = ja as ISODateString;
                }
            }

            result.push( member );
        }

        return result;
    }

    private extractTeamMember( input: unknown ): TeamMember | undefined {
        if ( !input || typeof input !== "object" ) return undefined;

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
        const usernameSource = anyU.username ?? anyU.userName ?? anyU.name;

        if ( !idSource || typeof usernameSource !== "string" ) return undefined;

        const username = usernameSource.trim();
        if ( !username ) return undefined;

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

        const role = this.resolveRoleInTeam( anyU.roleInTeam );
        if ( role ) member.roleInTeam = role;

        if ( typeof anyU.reason === "string" ) {
            const rr = anyU.reason.trim();
            if ( rr ) member.reason = rr;
        }

        if ( typeof anyU.joinedAt === "string" ) {
            const ja = anyU.joinedAt.trim();
            if ( ja && !Number.isNaN( Date.parse( ja ) ) ) {
                member.joinedAt = ja as ISODateString;
            }
        }

        return member;
    }

    private buildEvidenceFromMeta( meta: unknown ): TaskEvidence {
        const anyMeta = meta as {
            name?: string;
            storageKey?: string;
            url?: string;
            uploadedById?: Types.ObjectId;
            uploadedByName?: string;
            uploadedAt?: string;
            fileMeta?: FileMetaPacket;
        };

        const fileMeta: FileMetaPacket | undefined = anyMeta?.fileMeta;
        const storageKey: string = anyMeta?.storageKey ?? "";
        const url: string = anyMeta?.url ?? storageKey;

        const evidence: TaskEvidence = {
            name: anyMeta?.name ?? fileMeta?.originalName ?? "evidence",
            uploadedAt: anyMeta?.uploadedAt ?? new Date().toISOString(),
        };

        if ( storageKey ) evidence.storageKey = storageKey;
        if ( url ) evidence.url = url;
        if ( anyMeta?.uploadedById ) evidence.uploadedById = anyMeta.uploadedById;
        if ( anyMeta?.uploadedByName ) evidence.uploadedByName = anyMeta.uploadedByName;

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

            timing?: Partial<TaskTiming> | null;
            sla?: Partial<TaskSlaPolicy> | null;
            metrics?: Partial<TaskRuntimeMetrics> | null;

            blockedWindows?: unknown;
            assigneeHistory?: unknown;

            completionConfirmation?: unknown;

            evidence?: unknown[];
            notes?: string;

            labels?: unknown;

            audit?: Partial<TaskAuditMeta> | null;
        };

        const nowIso: string = new Date().toISOString();

        const name: string = String( t.name ?? "" ).trim();
        if ( !name ) throw new Error( "Task name is required." );

        const assignedMembers: Types.ObjectId[] = this.extractUserIdsFromArray( t.assignedMembers );
        const assignedCaptain: Types.ObjectId | undefined = this.extractUserId( t.assignedTaskCaptain );

        const idTrimmed: string = typeof t.id === "string" ? t.id.trim() : "";

        // ✅ timing normalization (this is your canonical created/updated)
        const incomingTiming: Partial<TaskTiming> =
            t.timing && typeof t.timing === "object" ? t.timing : {};

        const timing: TaskTiming = {
            ...incomingTiming,
            createdAt: incomingTiming.createdAt ?? nowIso,
            updatedAt: nowIso, // always refresh on write
        };

        // ✅ status-driven anchors (router side, to avoid relying only on pre-save)
        const statusLower = String( t.status ?? "draft" ).trim().toLowerCase();

        if ( statusLower === "in_progress" && !timing.startedAt ) timing.startedAt = nowIso;
        if ( statusLower === "blocked" ) timing.lastBlockedAt = nowIso;

        if (
            ( statusLower === "completed" || statusLower === "completed_pending_confirmation" ) &&
            !timing.completedAt
        ) {
            timing.completedAt = nowIso;
        }

        if ( statusLower === "cancelled" && !timing.cancelledAt ) timing.cancelledAt = nowIso;

        const task: AssignedTask = {
            id: idTrimmed || this.buildAssignedTaskId(),

            name,
            description: String( t.description ?? "" ).trim(),

            status: ( t.status as AssignedTask[ "status" ] ) ?? "draft",
            priority: ( t.priority as AssignedTask[ "priority" ] ) ?? "medium",

            plannedStartAt: typeof t.plannedStartAt === "string" ? t.plannedStartAt : "",
            plannedEndAt: typeof t.plannedEndAt === "string" ? t.plannedEndAt : "",

            timing, // ✅ canonical anchors

            notes: String( t.notes ?? "" ).trim(),

            // Keep as arrays (KPI-safe defaults)
            blockedWindows: Array.isArray( t.blockedWindows ) ? ( t.blockedWindows as any ) : [],
            assigneeHistory: Array.isArray( t.assigneeHistory ) ? ( t.assigneeHistory as any ) : [],
            labels: Array.isArray( t.labels ) ? ( t.labels as string[] ) : [],
            evidence: Array.isArray( t.evidence ) ? ( t.evidence as TaskEvidence[] ) : [],
        };

        if ( assignedMembers.length > 0 ) task.assignedMembers = assignedMembers;
        if ( assignedCaptain ) task.assignedTaskCaptain = assignedCaptain;

        if ( t.location ) task.location = t.location as GeoLocation;
        if ( t.address ) task.address = t.address as Address;

        // Optional KPI blocks (keep only if provided)
        if ( t.sla && typeof t.sla === "object" ) task.sla = t.sla as TaskSlaPolicy;
        if ( t.metrics && typeof t.metrics === "object" ) task.metrics = t.metrics as TaskRuntimeMetrics;
        if ( t.audit && typeof t.audit === "object" ) task.audit = t.audit as TaskAuditMeta;
        if ( t.completionConfirmation && typeof t.completionConfirmation === "object" ) {
            task.completionConfirmation = t.completionConfirmation as TaskCompletionConfirmation;
        }

        return task;
    }

    // ========================================================================
    // 3) Centralised USER SAFE projection for lookups
    // ========================================================================

    private getUserSafeProjectionForLookup(): typeof USER_MODEL_PROJECTION {
        return USER_MODEL_PROJECTION;
    }

    // ========================================================================
    // 4) Centralised TEAM -> USER enrichment pipeline stages
    // ========================================================================

    private buildTeamUserEnrichmentStages(): PipelineStage.FacetPipelineStage[] {
        const usersCollection: string = UserModel.collection.name;
        const teamsCollection: string = TeamManagementModel.collection.name;

        const safeUserProject: Record<string, unknown> = this.getUserSafeProjectionForLookup();

        const stages: PipelineStage.FacetPipelineStage[] = [
            {
                $addFields: {
                    memberIds: { $map: { input: "$members", as: "m", in: "$$m.id" } },
                    memberUsernames: { $map: { input: "$members", as: "m", in: "$$m.username" } },

                    captainId: "$captain.id",
                    captainUsername: "$captain.username",

                    allUserIds: {
                        $setUnion: [
                            { $map: { input: "$members", as: "m", in: "$$m.id" } },
                            { $cond: [ { $ifNull: [ "$captain.id", null ] }, [ "$captain.id" ], [] ] },
                        ],
                    },
                },
            },

            {
                $lookup: {
                    from: usersCollection,
                    let: {
                        ids: {
                            $setUnion: [
                                "$memberIds",
                                { $cond: [ { $ifNull: [ "$captain.id", null ] }, [ "$captain.id" ], [] ] },
                            ],
                        },
                        usernames: {
                            $setUnion: [
                                "$memberUsernames",
                                { $cond: [ { $ifNull: [ "$captain.username", null ] }, [ "$captain.username" ], [] ] },
                            ],
                        },
                    },
                    pipeline: [
                        {
                            $match: {
                                $expr: {
                                    $or: [
                                        { $in: [ "$_id", "$$ids" ] },
                                        { $in: [ "$username", "$$usernames" ] },
                                    ],
                                },
                            },
                        },
                        { $project: safeUserProject },
                    ],
                    as: "allUsersResolved",
                },
            },

            {
                $lookup: {
                    from: teamsCollection,
                    let: { allIds: "$allUserIds" },
                    pipeline: [
                        {
                            $match: {
                                $expr: {
                                    $or: [
                                        { $in: [ "$captain.id", "$$allIds" ] },
                                        {
                                            $gt: [
                                                {
                                                    $size: {
                                                        $filter: {
                                                            input: "$members",
                                                            as: "m",
                                                            cond: { $in: [ "$$m.id", "$$allIds" ] },
                                                        },
                                                    },
                                                },
                                                0,
                                            ],
                                        },
                                    ],
                                },
                            },
                        },
                        {
                            $project: {
                                _id: 0,
                                teamName: 1,
                                domain: 1,
                                captain: {
                                    id: "$captain.id",
                                    joinedAt: "$captain.joinedAt",
                                    roleInTeam: "$captain.roleInTeam",
                                    reason: "$captain.reason",
                                },
                                members: {
                                    $map: {
                                        input: "$members",
                                        as: "m",
                                        in: {
                                            id: "$$m.id",
                                            joinedAt: "$$m.joinedAt",
                                            roleInTeam: "$$m.roleInTeam",
                                            reason: "$$m.reason",
                                        },
                                    },
                                },
                            },
                        },
                    ],
                    as: "allTeamsForPeople",
                },
            },

            {
                $addFields: {
                    members: {
                        $map: {
                            input: "$members",
                            as: "m",
                            in: {
                                $let: {
                                    vars: {
                                        userCandidates: {
                                            $filter: {
                                                input: "$allUsersResolved",
                                                as: "u",
                                                cond: {
                                                    $or: [
                                                        { $eq: [ "$$u._id", "$$m.id" ] },
                                                        { $eq: [ "$$u.username", "$$m.username" ] },
                                                    ],
                                                },
                                            },
                                        },

                                        memberTeamDocs: {
                                            $filter: {
                                                input: "$allTeamsForPeople",
                                                as: "t",
                                                cond: {
                                                    $or: [
                                                        { $eq: [ "$$t.captain.id", "$$m.id" ] },
                                                        {
                                                            $gt: [
                                                                {
                                                                    $size: {
                                                                        $filter: {
                                                                            input: "$$t.members",
                                                                            as: "tm",
                                                                            cond: { $eq: [ "$$tm.id", "$$m.id" ] },
                                                                        },
                                                                    },
                                                                },
                                                                0,
                                                            ],
                                                        },
                                                    ],
                                                },
                                            },
                                        },

                                        memberMemberships: {
                                            $map: {
                                                input: {
                                                    $filter: {
                                                        input: "$allTeamsForPeople",
                                                        as: "t",
                                                        cond: {
                                                            $or: [
                                                                { $eq: [ "$$t.captain.id", "$$m.id" ] },
                                                                {
                                                                    $gt: [
                                                                        {
                                                                            $size: {
                                                                                $filter: {
                                                                                    input: "$$t.members",
                                                                                    as: "tm",
                                                                                    cond: { $eq: [ "$$tm.id", "$$m.id" ] },
                                                                                },
                                                                            },
                                                                        },
                                                                        0,
                                                                    ],
                                                                },
                                                            ],
                                                        },
                                                    },
                                                },
                                                as: "tt",
                                                in: {
                                                    teamName: "$$tt.teamName",
                                                    domain: "$$tt.domain",
                                                    joinedAt: {
                                                        $cond: [
                                                            { $eq: [ "$$tt.captain.id", "$$m.id" ] },
                                                            "$$tt.captain.joinedAt",
                                                            {
                                                                $first: {
                                                                    $map: {
                                                                        input: {
                                                                            $filter: {
                                                                                input: "$$tt.members",
                                                                                as: "mm",
                                                                                cond: { $eq: [ "$$mm.id", "$$m.id" ] },
                                                                            },
                                                                        },
                                                                        as: "x",
                                                                        in: "$$x.joinedAt",
                                                                    },
                                                                },
                                                            },
                                                        ],
                                                    },
                                                    roleInTeam: {
                                                        $cond: [
                                                            { $eq: [ "$$tt.captain.id", "$$m.id" ] },
                                                            "$$tt.captain.roleInTeam",
                                                            {
                                                                $first: {
                                                                    $map: {
                                                                        input: {
                                                                            $filter: {
                                                                                input: "$$tt.members",
                                                                                as: "mm",
                                                                                cond: { $eq: [ "$$mm.id", "$$m.id" ] },
                                                                            },
                                                                        },
                                                                        as: "x",
                                                                        in: "$$x.roleInTeam",
                                                                    },
                                                                },
                                                            },
                                                        ],
                                                    },
                                                    reason: {
                                                        $cond: [
                                                            { $eq: [ "$$tt.captain.id", "$$m.id" ] },
                                                            "$$tt.captain.reason",
                                                            {
                                                                $first: {
                                                                    $map: {
                                                                        input: {
                                                                            $filter: {
                                                                                input: "$$tt.members",
                                                                                as: "mm",
                                                                                cond: { $eq: [ "$$mm.id", "$$m.id" ] },
                                                                            },
                                                                        },
                                                                        as: "x",
                                                                        in: "$$x.reason",
                                                                    },
                                                                },
                                                            },
                                                        ],
                                                    },
                                                },
                                            },
                                        },
                                    },

                                    in: {
                                        $let: {
                                            vars: {
                                                resolvedUser: {
                                                    $let: {
                                                        vars: {
                                                            ranked: {
                                                                $map: {
                                                                    input: "$$userCandidates",
                                                                    as: "cu",
                                                                    in: {
                                                                        doc: "$$cu",
                                                                        rank: {
                                                                            $cond: [
                                                                                { $eq: [ "$$cu._id", "$$m.id" ] },
                                                                                0,
                                                                                1,
                                                                            ],
                                                                        },
                                                                    },
                                                                },
                                                            },
                                                        },
                                                        in: {
                                                            $ifNull: [
                                                                {
                                                                    $first: {
                                                                        $map: {
                                                                            input: {
                                                                                $sortArray: {
                                                                                    input: "$$ranked",
                                                                                    sortBy: { rank: 1 },
                                                                                },
                                                                            },
                                                                            as: "rr",
                                                                            in: "$$rr.doc",
                                                                        },
                                                                    },
                                                                },
                                                                null,
                                                            ],
                                                        },
                                                    },
                                                },

                                                memberLatest: {
                                                    $reduce: {
                                                        input: "$$memberMemberships",
                                                        initialValue: null,
                                                        in: {
                                                            $cond: [
                                                                { $eq: [ "$$value", null ] },
                                                                "$$this",
                                                                {
                                                                    $cond: [
                                                                        { $gt: [ "$$this.joinedAt", "$$value.joinedAt" ] },
                                                                        "$$this",
                                                                        "$$value",
                                                                    ],
                                                                },
                                                            ],
                                                        },
                                                    },
                                                },
                                            },

                                            in: {
                                                id: { $toString: "$$m.id" },
                                                username: "$$m.username",

                                                user: { $ifNull: [ "$$resolvedUser", null ] },

                                                teams: {
                                                    $map: {
                                                        input: "$$memberTeamDocs",
                                                        as: "t",
                                                        in: { teamName: "$$t.teamName", domain: "$$t.domain" },
                                                    },
                                                },

                                                domain: { $ifNull: [ "$$memberLatest.domain", null ] },
                                                teamName: { $ifNull: [ "$$memberLatest.teamName", null ] },
                                                teamReason: { $ifNull: [ "$$memberLatest.teamName", null ] },

                                                roleInTeam: "$$memberLatest.roleInTeam",
                                                reason: { $ifNull: [ "$$memberLatest.reason", null ] },
                                                joinedAt: { $ifNull: [ "$$memberLatest.joinedAt", null ] },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },

                    captain: {
                        $let: {
                            vars: {
                                captainCandidates: {
                                    $filter: {
                                        input: "$allUsersResolved",
                                        as: "u",
                                        cond: {
                                            $or: [
                                                { $eq: [ "$$u._id", "$captain.id" ] },
                                                { $eq: [ "$$u.username", "$captain.username" ] },
                                            ],
                                        },
                                    },
                                },

                                captainTeamDocs: {
                                    $filter: {
                                        input: "$allTeamsForPeople",
                                        as: "t",
                                        cond: {
                                            $or: [
                                                { $eq: [ "$$t.captain.id", "$captain.id" ] },
                                                {
                                                    $gt: [
                                                        {
                                                            $size: {
                                                                $filter: {
                                                                    input: "$$t.members",
                                                                    as: "tm",
                                                                    cond: { $eq: [ "$$tm.id", "$captain.id" ] },
                                                                },
                                                            },
                                                        },
                                                        0,
                                                    ],
                                                },
                                            ],
                                        },
                                    },
                                },

                                captainMemberships: {
                                    $map: {
                                        input: {
                                            $filter: {
                                                input: "$allTeamsForPeople",
                                                as: "t",
                                                cond: {
                                                    $or: [
                                                        { $eq: [ "$$t.captain.id", "$captain.id" ] },
                                                        {
                                                            $gt: [
                                                                {
                                                                    $size: {
                                                                        $filter: {
                                                                            input: "$$t.members",
                                                                            as: "tm",
                                                                            cond: { $eq: [ "$$tm.id", "$captain.id" ] },
                                                                        },
                                                                    },
                                                                },
                                                                0,
                                                            ],
                                                        },
                                                    ],
                                                },
                                            },
                                        },
                                        as: "tt",
                                        in: {
                                            teamName: "$$tt.teamName",
                                            domain: "$$tt.domain",
                                            joinedAt: {
                                                $cond: [
                                                    { $eq: [ "$$tt.captain.id", "$captain.id" ] },
                                                    "$$tt.captain.joinedAt",
                                                    {
                                                        $first: {
                                                            $map: {
                                                                input: {
                                                                    $filter: {
                                                                        input: "$$tt.members",
                                                                        as: "mm",
                                                                        cond: { $eq: [ "$$mm.id", "$captain.id" ] },
                                                                    },
                                                                },
                                                                as: "x",
                                                                in: "$$x.joinedAt",
                                                            },
                                                        },
                                                    },
                                                ],
                                            },
                                            roleInTeam: {
                                                $cond: [
                                                    { $eq: [ "$$tt.captain.id", "$captain.id" ] },
                                                    "$$tt.captain.roleInTeam",
                                                    {
                                                        $first: {
                                                            $map: {
                                                                input: {
                                                                    $filter: {
                                                                        input: "$$tt.members",
                                                                        as: "mm",
                                                                        cond: { $eq: [ "$$mm.id", "$captain.id" ] },
                                                                    },
                                                                },
                                                                as: "x",
                                                                in: "$$x.roleInTeam",
                                                            },
                                                        },
                                                    },
                                                ],
                                            },
                                            reason: {
                                                $cond: [
                                                    { $eq: [ "$$tt.captain.id", "$captain.id" ] },
                                                    "$$tt.captain.reason",
                                                    {
                                                        $first: {
                                                            $map: {
                                                                input: {
                                                                    $filter: {
                                                                        input: "$$tt.members",
                                                                        as: "mm",
                                                                        cond: { $eq: [ "$$mm.id", "$captain.id" ] },
                                                                    },
                                                                },
                                                                as: "x",
                                                                in: "$$x.reason",
                                                            },
                                                        },
                                                    },
                                                ],
                                            },
                                        },
                                    },
                                },
                            },

                            in: {
                                $let: {
                                    vars: {
                                        resolvedCaptainUser: {
                                            $let: {
                                                vars: {
                                                    ranked: {
                                                        $map: {
                                                            input: "$$captainCandidates",
                                                            as: "cu",
                                                            in: {
                                                                doc: "$$cu",
                                                                rank: {
                                                                    $cond: [
                                                                        { $eq: [ "$$cu._id", "$captain.id" ] },
                                                                        0,
                                                                        1,
                                                                    ],
                                                                },
                                                            },
                                                        },
                                                    },
                                                },
                                                in: {
                                                    $ifNull: [
                                                        {
                                                            $first: {
                                                                $map: {
                                                                    input: {
                                                                        $sortArray: {
                                                                            input: "$$ranked",
                                                                            sortBy: { rank: 1 },
                                                                        },
                                                                    },
                                                                    as: "rr",
                                                                    in: "$$rr.doc",
                                                                },
                                                            },
                                                        },
                                                        null,
                                                    ],
                                                },
                                            },
                                        },

                                        captainLatest: {
                                            $reduce: {
                                                input: "$$captainMemberships",
                                                initialValue: null,
                                                in: {
                                                    $cond: [
                                                        { $eq: [ "$$value", null ] },
                                                        "$$this",
                                                        {
                                                            $cond: [
                                                                { $gt: [ "$$this.joinedAt", "$$value.joinedAt" ] },
                                                                "$$this",
                                                                "$$value",
                                                            ],
                                                        },
                                                    ],
                                                },
                                            },
                                        },
                                    },

                                    in: {
                                        id: { $toString: "$captain.id" },
                                        username: "$captain.username",

                                        user: { $ifNull: [ "$$resolvedCaptainUser", null ] },

                                        teams: {
                                            $map: {
                                                input: "$$captainTeamDocs",
                                                as: "t",
                                                in: { teamName: "$$t.teamName", domain: "$$t.domain" },
                                            },
                                        },

                                        domain: { $ifNull: [ "$$captainLatest.domain", null ] },
                                        teamName: { $ifNull: [ "$$captainLatest.teamName", null ] },
                                        teamReason: { $ifNull: [ "$$captainLatest.teamName", null ] },

                                        roleInTeam: "$$captainLatest.roleInTeam",
                                        reason: { $ifNull: [ "$$captainLatest.reason", null ] },
                                        joinedAt: { $ifNull: [ "$$captainLatest.joinedAt", null ] },
                                    },
                                },
                            },
                        },
                    },
                },
            },

            {
                $project: {
                    memberIds: 0,
                    memberUsernames: 0,
                    captainId: 0,
                    captainUsername: 0,
                    allUserIds: 0,
                    allUsersResolved: 0,
                    allTeamsForPeople: 0,
                },
            },
        ];

        return stages;
    }

    // ========================================================================
    // 4.1) Enrichment fetch helpers (used by create/update/teamName)
    // ========================================================================

    private async fetchEnrichedTeamByCode( teamCode: string ): Promise<TeamManagementDto | null> {
        const pipeline: PipelineStage[] = [
            { $match: { teamCode } },
            ...this.buildTeamUserEnrichmentStages(),
            { $limit: 1 },
        ];

        const rows: TeamManagementDto[] = await TeamManagementModel.aggregate<TeamManagementDto>( pipeline ).exec();
        return rows.length > 0 && rows[ 0 ] ? rows[ 0 ] : null;
    }

    private async fetchEnrichedTeamByName( teamName: string ): Promise<TeamManagementDto | null> {
        const escaped = teamName.replace( /[.*+?^${}()|[\]\\]/g, "\\$&" );

        const pipeline: PipelineStage[] = [
            {
                $match: {
                    teamName: { $regex: `^${ escaped }$`, $options: "i" },
                },
            },
            ...this.buildTeamUserEnrichmentStages(),
            { $limit: 1 },
        ];

        const rows: TeamManagementDto[] = await TeamManagementModel.aggregate<TeamManagementDto>( pipeline ).exec();
        return rows.length > 0 && rows[ 0 ] ? rows[ 0 ] : null;
    }

    // ========================================================================
    // 5) Helper – user membership vs teams
    // ========================================================================

    private async collectTeamUserIdsByDomain( domain?: TeamDomain ): Promise<Types.ObjectId[]> {
        const pipeline: PipelineStage[] = [];

        if ( domain ) pipeline.push( { $match: { domain } } );

        pipeline.push(
            {
                $project: {
                    memberIds: { $map: { input: "$members", as: "m", in: "$$m.id" } },
                    captainId: "$captain.id",
                },
            },
            {
                $project: {
                    allUserIds: {
                        $setUnion: [
                            "$memberIds",
                            {
                                $cond: [ { $ifNull: [ "$captainId", null ] }, [ "$captainId" ], [] ],
                            },
                        ],
                    },
                },
            },
            { $unwind: "$allUserIds" },
            { $group: { _id: "$allUserIds" } }
        );

        const rows: Array<{ _id: Types.ObjectId; }> = await TeamManagementModel.aggregate( pipeline ).exec();
        return rows.map( ( r ) => r._id );
    }

    // ========================================================================
    // POST /create
    // ========================================================================

    private registerCreateTeam(): void {
        this.router.post( "/create", async ( req: Request, res: Response ): Promise<void> => {
            try {
                const nowIso: string = new Date().toISOString();
                const teamCode: string = this.generateTeamIdentity();
                const root = `${ req.protocol }://${ req.get( "host" ) }`;

                let payload: any = {};
                let teamLogoEvidence: TaskEvidence | undefined;

                const isMultipart: boolean =
                    ( req.headers[ "content-type" ] ?? "" ).toString().includes( "multipart/form-data" );

                if ( isMultipart ) {
                    const uploadSubPath: string = `team-management/${ teamCode }/logo`;

                    let uploadedFiles: UploadResultPacket | null = null
                    try {
                        uploadedFiles = await FileUploader.handleUpload( uploadSubPath, "teamLogo", req );
                    } catch ( uploadError ) {
                        console.error( "[Warning:] [TeamManagement:create] Logo upload failed.\n", uploadError );
                    }

                    const rawTeamField: unknown = ( req.body as any )?.team;
                    if ( typeof rawTeamField !== "string" || !rawTeamField.trim() ) {
                        ApiResponseBuilder.validationError(
                            res,
                            "Invalid team payload: expected JSON string in 'team' field"
                        );
                        return;
                    }

                    try {
                        payload = JSON.parse( rawTeamField );
                    } catch ( parseError ) {
                        console.error( "[Error:] [TeamManagement:create] Failed to parse 'team' JSON.\n", parseError );
                        ApiResponseBuilder.validationError( res, "Malformed team JSON payload" );
                        return;
                    }

                    if ( Array.isArray( uploadedFiles?.byField.teamLogo ) && uploadedFiles?.byField.teamLogo.length > 0 ) {
                        const fileMeta: FileMetaPacket | undefined = uploadedFiles?.byField.teamLogo[ 0 ];
                        if ( !fileMeta ) {
                            ApiResponseBuilder.error( res, 404, "File not found!" );
                            return;
                        }

                        const relativePath: string = `${ this.PUBLIC_UPLOAD_URL_ROOT }/${ teamCode }/logo/${ fileMeta.storedName }`;

                        teamLogoEvidence = this.buildEvidenceFromMeta( {
                            name: fileMeta.originalName,
                            storageKey: relativePath,
                            url: `${ root }/${ relativePath }`,
                            fileMeta,
                        } );
                    }
                } else {
                    payload = req.body;
                }

                const teamName: string = String( payload.teamName ?? "" ).trim();
                const domainRaw: string = String( payload.domain ?? "" ).trim();
                const description: string = String( payload.description ?? "" ).trim();

                const isActiveParsed: boolean | undefined = this.parseBooleanQuery( payload.isActive );
                const isActive: boolean = isActiveParsed !== undefined ? isActiveParsed : true;

                if ( !teamName || !domainRaw ) {
                    ApiResponseBuilder.validationError( res, "Team name and domain are required for team creation" );
                    return;
                }

                const domainLower = domainRaw.toLowerCase();
                if ( !this.isValidTeamDomain( domainLower ) ) {
                    ApiResponseBuilder.validationError( res, "Invalid domain." );
                    return;
                }

                const domain: TeamDomain = domainLower as TeamDomain;

                const memberRefs: TeamMember[] = this.extractTeamMembersFromArray( payload.members );
                const captainRef: TeamMember | undefined = this.extractTeamMember( payload.captain );

                if ( !captainRef ) {
                    ApiResponseBuilder.validationError( res, "Team captain is required" );
                    return;
                }

                const assignTasks: AssignedTask[] = Array.isArray( payload.assignTasks )
                    ? ( payload.assignTasks as unknown[] ).map( ( t: unknown ) => this.buildAssignedTaskFromBody( t ) )
                    : [];

                if ( !teamLogoEvidence && payload.teamLogo ) {
                    teamLogoEvidence = this.buildEvidenceFromMeta( payload.teamLogo );
                }

                const createDocBase: Partial<ITeamManagement> = {
                    teamCode,
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
                    ( createDocBase as ITeamManagement ).teamLogo = teamLogoEvidence;
                }

                await TeamManagementModel.create( createDocBase as ITeamManagement );

                // ✅ return enriched immediately
                const enriched = await this.fetchEnrichedTeamByCode( teamCode );
                if ( !enriched ) {
                    ApiResponseBuilder.ok( res, "team", createDocBase as unknown as ITeamManagement, "Team created successfully" );
                    return;
                }

                ApiResponseBuilder.ok( res, "team", enriched as unknown as ITeamManagement, "Team created successfully" );

                // Notification (same as yours)
                const notificationService = new NotificationService();
                const io = req.app.get( "io" ) as import( "socket.io" ).Server;

                await notificationService.createNotification(
                    {
                        title: "New Team",
                        body: `A new team "${ createDocBase.teamName }" has been created.`,
                        type: "create",
                        severity: "info",
                        audience: { mode: "role", roles: [ "admin", "manager", "operator" ] },
                        channels: [ "inapp", "email" ],
                        metadata: { refId: createDocBase.teamCode ?? "", data: { team: createDocBase } },
                    },
                    ( rooms, payload2 ) => rooms.forEach( ( r ) => io.to( r ).emit( "notification.new", payload2 ) )
                );

                return;
            } catch ( error ) {
                console.error( "[Error:] [TeamManagement] Unexpected error during team creation.\n", error );
                ApiResponseBuilder.internalError( res, error );
                return;
            }
        } );
    }

    // ========================================================================
    // GET /teamName/:teamName  (✅ NOW ENRICHED)
    // ========================================================================

    private getTeamByTeamName(): void {
        this.router.get(
            "/teamName/:teamName",
            async ( req: Request<{ teamName: string; }>, res: Response ): Promise<void> => {
                try {
                    const name: string = typeof req.params.teamName === "string" ? req.params.teamName.trim() : "";
                    if ( !name ) {
                        ApiResponseBuilder.validationError( res, "Team name is required!" );
                        return;
                    }

                    const enriched = await this.fetchEnrichedTeamByName( name );
                    if ( !enriched ) {
                        ApiResponseBuilder.notFound( res, "Team not found under the given name." );
                        return;
                    }

                    ApiResponseBuilder.ok( res, "team", enriched as unknown as ITeamManagement, "Team found successfully!" );
                    return;
                } catch ( error ) {
                    console.error( "[Error:] [TeamManagement] getTeamByTeamName error.\n", error );
                    ApiResponseBuilder.internalError( res, error );
                    return;
                }
            }
        );
    }

    // ========================================================================
    // GET /all  (enriched)
    // ========================================================================

    private registerGetAllTeams(): void {
        this.router.get( "/all", async ( req: Request, res: Response ): Promise<void> => {
            try {
                const { index, limit, skip } = this.parsePagination( req, 10 );

                const search: string = String( req.query.search ?? "" ).trim();
                const domainRaw: string = String( req.query.domain ?? "" ).trim();
                const isActiveParam = this.parseBooleanQuery( req.query.isActive );

                const match: FilterQuery<ITeamManagement> = {};

                if ( search ) match.teamName = { $regex: search, $options: "i" };

                if ( domainRaw ) {
                    const domainLower = domainRaw.toLowerCase();
                    if ( !this.isValidTeamDomain( domainLower ) ) {
                        ApiResponseBuilder.validationError( res, "Invalid domain in query." );
                        return;
                    }
                    match.domain = domainLower as TeamDomain;
                }

                if ( isActiveParam !== undefined ) match.isActive = isActiveParam;

                const pipeline: PipelineStage[] = this.buildGetAllTeamsPipeline( match, skip, limit );

                const aggResult: Array<{ meta: Array<{ total: number; }>; rows: TeamManagementDto[]; }> =
                    await TeamManagementModel.aggregate( pipeline ).exec();

                const metaTotal: number = aggResult?.[ 0 ]?.meta?.[ 0 ]?.total ?? 0;
                const rows: TeamManagementDto[] = aggResult?.[ 0 ]?.rows ?? [];

                const pagination: PaginationMeta = { total: metaTotal, index, limit };

                ApiResponseBuilder.ok( res, "teams", rows as unknown as ITeamManagement[], "Teams fetched successfully", {
                    pagination,
                } );
                return;
            } catch ( error ) {
                console.error( "[Error:] [TeamManagement] Failed to fetch teams via aggregation.\n", error );
                ApiResponseBuilder.internalError( res, error );
                return;
            }
        } );
    }

    private buildGetAllTeamsPipeline(
        match: FilterQuery<ITeamManagement>,
        skip: number,
        limit: number
    ): PipelineStage[] {
        return [
            { $match: match },
            { $sort: { createdAt: -1 } },
            {
                $facet: {
                    meta: [ { $count: "total" } ],
                    rows: [ { $skip: skip }, { $limit: limit }, ...this.buildTeamUserEnrichmentStages() ],
                },
            },
            {
                $addFields: {
                    meta: {
                        $cond: [ { $gt: [ { $size: "$meta" }, 0 ] }, "$meta", [ { total: 0 } ] ],
                    },
                },
            },
        ];
    }

    // ========================================================================
    // GET /:teamCode  (enriched)  ✅ Registered LAST in constructor
    // ========================================================================

    private registerGetTeamByCode(): void {
        this.router.get( "/:teamCode", async ( req: Request, res: Response ): Promise<void> => {
            try {
                const teamCode: string = String( req.params.teamCode ?? "" ).trim();
                if ( !teamCode ) {
                    ApiResponseBuilder.validationError( res, "Team code is required" );
                    return;
                }

                const enriched = await this.fetchEnrichedTeamByCode( teamCode );
                if ( !enriched ) {
                    ApiResponseBuilder.notFound( res, "Team not found for the provided code" );
                    return;
                }

                ApiResponseBuilder.ok( res, "team", enriched as unknown as ITeamManagement, "Team fetched successfully" );
                return;
            } catch ( error ) {
                console.error( "[Error:] [TeamManagement] Error while fetching team by code.\n", error );
                ApiResponseBuilder.internalError( res, error );
                return;
            }
        } );
    }

    // ========================================================================
    // PATCH /update/:teamCode
    // ========================================================================

    private registerUpdateTeam(): void {
        this.router.patch( "/update/:teamCode", async ( req: Request, res: Response ): Promise<void> => {
            try {
                const teamCode: string = String( req.params.teamCode ?? "" ).trim();
                if ( !teamCode ) {
                    ApiResponseBuilder.validationError( res, "Team code is required" );
                    return;
                }

                const nowIso: string = new Date().toISOString();
                const root = `${ req.protocol }://${ req.get( "host" ) }`;

                let payload: any = {};
                let teamLogoEvidence: TaskEvidence | undefined;

                const isMultipart: boolean =
                    ( req.headers[ "content-type" ] ?? "" ).toString().includes( "multipart/form-data" );

                if ( isMultipart ) {
                    const uploadSubPath: string = `team-management/${ teamCode }/logo`;

                    let uploadedFiles: UploadResultPacket | null = null;
                    try {
                        uploadedFiles = await FileUploader.handleUpload( uploadSubPath, "teamLogo", req );
                    } catch ( uploadError ) {
                        console.error( "[Warning:] [TeamManagement:update] Logo upload failed.\n", uploadError );
                    }

                    const rawTeamField: unknown = ( req.body as any )?.team;
                    if ( typeof rawTeamField === "string" && rawTeamField.trim() ) {
                        try {
                            payload = JSON.parse( rawTeamField );
                        } catch ( parseError ) {
                            console.error( "[Error:] [TeamManagement:update] Failed to parse 'team' JSON.\n", parseError );
                            ApiResponseBuilder.validationError( res, "Malformed team JSON payload" );
                            return;
                        }
                    } else {
                        payload = {};
                    }

                    if ( Array.isArray( uploadedFiles?.byField.teamLogo ) && uploadedFiles?.byField.teamLogo.length > 0 ) {
                        const fileMeta: FileMetaPacket | undefined = uploadedFiles?.byField.teamLogo[ 0 ];
                        if ( !fileMeta ) {
                            ApiResponseBuilder.error( res, 404, "File not found!" );
                            return;
                        }

                        const relativePath: string = `${ this.PUBLIC_UPLOAD_URL_ROOT }/${ teamCode }/logo/${ fileMeta.storedName }`;

                        teamLogoEvidence = this.buildEvidenceFromMeta( {
                            name: fileMeta.originalName,
                            storageKey: relativePath,
                            url: `${ root }/${ relativePath }`,
                            fileMeta,
                        } );
                    }
                } else {
                    payload = req.body;
                }

                const update: Partial<ITeamManagement> = {};

                if ( typeof payload.teamName === "string" ) {
                    const trimmed = payload.teamName.trim();
                    if ( trimmed ) update.teamName = trimmed;
                }

                if ( typeof payload.domain === "string" && payload.domain.trim() ) {
                    const domainLower = payload.domain.trim().toLowerCase();
                    if ( !this.isValidTeamDomain( domainLower ) ) {
                        ApiResponseBuilder.validationError( res, "Invalid domain." );
                        return;
                    }
                    update.domain = domainLower as TeamDomain;
                }

                if ( typeof payload.description === "string" ) {
                    update.description = payload.description.trim();
                }

                if ( typeof payload.isActive !== "undefined" ) {
                    const parsed = this.parseBooleanQuery( payload.isActive );
                    update.isActive = parsed !== undefined ? parsed : true;
                }

                if ( typeof payload.members !== "undefined" ) {
                    const memberRefs = this.extractTeamMembersFromArray( payload.members );
                    update.members = memberRefs;
                    update.memberTotal = memberRefs.length;
                }

                if ( typeof payload.captain !== "undefined" ) {
                    const captainRef = this.extractTeamMember( payload.captain );
                    if ( captainRef ) update.captain = captainRef;
                }

                if ( Array.isArray( payload.assignTasks ) ) {
                    update.assignTasks = payload.assignTasks.map( ( t: unknown ) => this.buildAssignedTaskFromBody( t ) );
                }

                if ( teamLogoEvidence ) {
                    ( update as ITeamManagement ).teamLogo = teamLogoEvidence;
                } else if ( payload.teamLogo ) {
                    update.teamLogo = this.buildEvidenceFromMeta( payload.teamLogo );
                }

                update.updatedAt = nowIso;

                const updated: ITeamManagement | null = await TeamManagementModel.findOneAndUpdate(
                    { teamCode },
                    { $set: update },
                    { new: true }
                ).exec();

                if ( !updated ) {
                    ApiResponseBuilder.validationError( res, "Team not found for update" );
                    return;
                }

                // ✅ return enriched immediately
                const enriched = await this.fetchEnrichedTeamByCode( teamCode );
                ApiResponseBuilder.ok(
                    res,
                    "team",
                    ( enriched ?? ( updated as unknown ) ) as ITeamManagement,
                    "Team updated successfully"
                );

                const notificationService = new NotificationService();
                const io = req.app.get( "io" ) as import( "socket.io" ).Server;

                await notificationService.createNotification(
                    {
                        title: "Update Team",
                        body: `Team "${ updated.teamName }" has been updated.`,
                        type: "update",
                        severity: "info",
                        audience: { mode: "role", roles: [ "admin", "manager", "operator" ] },
                        channels: [ "inapp", "email" ],
                        metadata: { refId: updated.teamCode ?? "", data: { team: updated } },
                    },
                    ( rooms, payload2 ) => rooms.forEach( ( r ) => io.to( r ).emit( "notification.new", payload2 ) )
                );

                return;
            } catch ( error ) {
                console.error( "[Error:] [TeamManagement] Unexpected error during team update.\n", error );
                ApiResponseBuilder.internalError( res, error );
                return;
            }
        } );
    }

    // ========================================================================
    // DELETE /delete/:teamCode
    // ========================================================================

    private registerDeleteTeam(): void {
        this.router.delete( "/delete/:teamCode", async ( req: Request, res: Response ): Promise<void> => {
            try {
                const teamCode: string = String( req.params.teamCode ?? "" ).trim();
                if ( !teamCode ) {
                    ApiResponseBuilder.validationError( res, "Team code is required" );
                    return;
                }

                const softParsed = this.parseBooleanQuery( req.query.soft );
                const soft: boolean = softParsed !== undefined ? softParsed : true;

                if ( soft ) {
                    const updated = await TeamManagementModel.findOneAndUpdate(
                        { teamCode },
                        { $set: { isActive: false, updatedAt: new Date().toISOString() } },
                        { new: true }
                    ).exec();

                    if ( !updated ) {
                        ApiResponseBuilder.validationError( res, "Team not found for soft delete" );
                        return;
                    }

                    ApiResponseBuilder.ok( res, "team", updated, "Team deactivated (soft delete) successfully" );
                    return;
                }

                const deleted = await TeamManagementModel.findOneAndDelete( { teamCode } ).exec();
                if ( !deleted ) {
                    ApiResponseBuilder.validationError( res, "Team not found for hard delete" );
                    return;
                }

                ApiResponseBuilder.ok( res, "team", deleted, "Team deleted permanently" );
                return;
            } catch ( error ) {
                console.error( "[Error:] [TeamManagement] Error during team delete.\n", error );
                ApiResponseBuilder.internalError( res, error );
                return;
            }
        } );
    }

    // ========================================================================
    // FILE UPLOAD ROUTES
    // ========================================================================

    private registerUploadTeamLogo(): void {
        this.router.post( "/upload/logo/:teamCode", async ( req: Request, res: Response ): Promise<void> => {
            try {
                const teamCode: string = String( req.params.teamCode ?? "" ).trim();
                if ( !teamCode ) {
                    ApiResponseBuilder.validationError( res, "Team code is required for logo upload" );
                    return;
                }

                const subPath = `team-management/${ teamCode }/logo`;

                const files: UploadResultPacket = await FileUploader.handleUpload( subPath, "teamLogo", req );

                if ( !Array.isArray( files.byField.teamLogo ) || files.byField.teamLogo.length === 0 ) {
                    ApiResponseBuilder.validationError( res, "No files were uploaded for team logo" );
                    return;
                }

                ApiResponseBuilder.ok( res, "files", files.byField.teamLogo, "Team logo uploaded successfully" );
                return;
            } catch ( error ) {
                console.error( "[Error:] [TeamManagement] Error during team logo upload.\n", error );
                ApiResponseBuilder.internalError( res, error );
                return;
            }
        } );
    }

    // ========================================================================
    // STATS ROUTES
    // ========================================================================

    private registerGetAllTeamTotals(): void {
        this.router.get( "/stats/teams-total", async ( _req: Request, res: Response ): Promise<void> => {
            try {
                const [ totalTeams, totalActive, totalInactive ] = await Promise.all( [
                    TeamManagementModel.countDocuments( {} ).exec(),
                    TeamManagementModel.countDocuments( { isActive: true } ).exec(),
                    TeamManagementModel.countDocuments( { isActive: false } ).exec(),
                ] );

                const domainTotals: Record<TeamDomain, number> = {} as Record<TeamDomain, number>;
                for ( const domain of this.ALLOWED_TEAM_DOMAINS ) {
                    // eslint-disable-next-line no-await-in-loop
                    const countForDomain: number = await TeamManagementModel.countDocuments( { domain } ).exec();
                    domainTotals[ domain ] = countForDomain;
                }

                ApiResponseBuilder.ok(
                    res,
                    "other",
                    { totalTeams, totalActive, totalInactive, domainTotals },
                    "Team totals fetched successfully"
                );
                return;
            } catch ( error ) {
                console.error( "[Error:] [TeamManagement] Error while fetching team totals.\n", error );
                ApiResponseBuilder.internalError( res, error );
                return;
            }
        } );
    }

    private registerGetTeamTotalByDomain(): void {
        this.router.get( "/stats/teams-total/domain/:domain", async ( req: Request, res: Response ): Promise<void> => {
            try {
                const rawDomain: string = String( req.params.domain ?? "" ).trim().toLowerCase();
                if ( !rawDomain || !this.isValidTeamDomain( rawDomain ) ) {
                    ApiResponseBuilder.validationError( res, "Invalid domain." );
                    return;
                }

                const domain: TeamDomain = rawDomain as TeamDomain;
                const activeQueryRaw = this.parseBooleanQuery( req.query.active );

                let totalTeams: number;
                let totalActive: number;
                let totalInactive: number;

                if ( activeQueryRaw !== undefined ) {
                    totalTeams = await TeamManagementModel.countDocuments( { domain, isActive: activeQueryRaw } ).exec();
                    [ totalActive, totalInactive ] = await Promise.all( [
                        TeamManagementModel.countDocuments( { domain, isActive: true } ).exec(),
                        TeamManagementModel.countDocuments( { domain, isActive: false } ).exec(),
                    ] );
                } else {
                    [ totalTeams, totalActive, totalInactive ] = await Promise.all( [
                        TeamManagementModel.countDocuments( { domain } ).exec(),
                        TeamManagementModel.countDocuments( { domain, isActive: true } ).exec(),
                        TeamManagementModel.countDocuments( { domain, isActive: false } ).exec(),
                    ] );
                }

                ApiResponseBuilder.ok(
                    res,
                    "other",
                    { domain, totalTeams, totalActive, totalInactive },
                    "Team domain totals fetched successfully"
                );
                return;
            } catch ( error ) {
                console.error( "[Error:] [TeamManagement] Error while fetching team domain totals.\n", error );
                ApiResponseBuilder.internalError( res, error );
                return;
            }
        } );
    }

    // ========================================================================
    // USER MEMBERSHIP (GLOBAL + DOMAIN) — ✅ count responses made consistent
    // ========================================================================

    private registerUsersWithoutAnyTeam(): void {
        this.router.get( "/users/no-team", async ( req: Request, res: Response ): Promise<void> => {
            try {
                const { index, limit, skip } = this.parsePagination( req, 10 );
                const teamUserIds: Types.ObjectId[] = await this.collectTeamUserIdsByDomain();

                const filter: FilterQuery<User> = {};
                if ( teamUserIds.length > 0 ) filter._id = { $nin: teamUserIds };

                const [ total, users ] = await Promise.all( [
                    UserModel.countDocuments( filter ).exec(),
                    UserModel.find( filter, USER_MODEL_PROJECTION ).skip( skip ).limit( limit ).lean<User>().exec() as unknown as User[],
                ] );

                ApiResponseBuilder.ok( res, "users", users, "Users without any team fetched successfully", {
                    pagination: { total, index, limit },
                } );
                return;
            } catch ( error ) {
                console.error( "[Error:] [TeamManagement] Error while fetching users without team.\n", error );
                ApiResponseBuilder.internalError( res, error );
                return;
            }
        } );
    }

    private registerUsersWithoutAnyTeamCount(): void {
        this.router.get( "/users/no-team/count", async ( _req: Request, res: Response ): Promise<void> => {
            try {
                const teamUserIds: Types.ObjectId[] = await this.collectTeamUserIdsByDomain();
                const filter: FilterQuery<User> = {};
                if ( teamUserIds.length > 0 ) filter._id = { $nin: teamUserIds };

                const total: number = await UserModel.countDocuments( filter ).exec();

                ApiResponseBuilder.ok( res, "other", { total }, "Total users without any team fetched successfully", {
                    pagination: { total },
                } );
                return;
            } catch ( error ) {
                console.error( "[Error:] [TeamManagement] Error while counting users without team.\n", error );
                ApiResponseBuilder.internalError( res, error );
                return;
            }
        } );
    }

    private registerUsersInAnyTeam(): void {
        this.router.get( "/users/in-teams", async ( req: Request, res: Response ): Promise<void> => {
            try {
                const { index, limit, skip } = this.parsePagination( req, 10 );
                const teamUserIds: Types.ObjectId[] = await this.collectTeamUserIdsByDomain();

                if ( teamUserIds.length === 0 ) {
                    ApiResponseBuilder.ok( res, "users", [] as User[], "No users found in any team", {
                        pagination: { total: 0, index, limit },
                    } );
                    return;
                }

                const filter: FilterQuery<User> = { _id: { $in: teamUserIds } };

                const [ total, users ] = await Promise.all( [
                    UserModel.countDocuments( filter ).exec(),
                    UserModel.find( filter, USER_MODEL_PROJECTION ).skip( skip ).limit( limit ).lean<User>().exec() as unknown as User[],
                ] );

                ApiResponseBuilder.ok( res, "users", users, "Users in teams fetched successfully", {
                    pagination: { total, index, limit },
                } );
                return;
            } catch ( error ) {
                console.error( "[Error:] [TeamManagement] Error while fetching users in teams.\n", error );
                ApiResponseBuilder.internalError( res, error );
                return;
            }
        } );
    }

    private registerUsersInAnyTeamCount(): void {
        this.router.get( "/users/in-teams/count", async ( _req: Request, res: Response ): Promise<void> => {
            try {
                const teamUserIds: Types.ObjectId[] = await this.collectTeamUserIdsByDomain();
                const total: number = teamUserIds.length === 0
                    ? 0
                    : await UserModel.countDocuments( { _id: { $in: teamUserIds } } ).exec();

                ApiResponseBuilder.ok( res, "other", { total }, "Total users in teams fetched successfully", {
                    pagination: { total },
                } );
                return;
            } catch ( error ) {
                console.error( "[Error:] [TeamManagement] Error while counting users in teams.\n", error );
                ApiResponseBuilder.internalError( res, error );
                return;
            }
        } );
    }

    private registerUsersWithoutTeamByDomain(): void {
        this.router.get( "/users/no-team/domain/:domain", async ( req: Request, res: Response ): Promise<void> => {
            try {
                const rawDomain: string = String( req.params.domain ?? "" ).trim().toLowerCase();
                if ( !rawDomain || !this.isValidTeamDomain( rawDomain ) ) {
                    ApiResponseBuilder.validationError( res, "Invalid domain." );
                    return;
                }

                const domain = rawDomain as TeamDomain;
                const { index, limit, skip } = this.parsePagination( req, 10 );

                const teamUserIds: Types.ObjectId[] = await this.collectTeamUserIdsByDomain( domain );

                const filter: FilterQuery<User> = {};
                if ( teamUserIds.length > 0 ) filter._id = { $nin: teamUserIds };

                const [ total, users ] = await Promise.all( [
                    UserModel.countDocuments( filter ).exec(),
                    UserModel.find( filter, USER_MODEL_PROJECTION ).skip( skip ).limit( limit ).lean<User>().exec() as unknown as User[],
                ] );

                ApiResponseBuilder.ok( res, "users", users, "Users without any team for the domain fetched successfully", {
                    pagination: { total, index, limit },
                    other: { domain },
                } );
                return;
            } catch ( error ) {
                console.error( "[Error:] [TeamManagement] Error while fetching domain users without team.\n", error );
                ApiResponseBuilder.internalError( res, error );
                return;
            }
        } );
    }

    private registerUsersWithoutTeamByDomainCount(): void {
        this.router.get( "/users/no-team/domain/:domain/count", async ( req: Request, res: Response ): Promise<void> => {
            try {
                const rawDomain: string = String( req.params.domain ?? "" ).trim().toLowerCase();
                if ( !rawDomain || !this.isValidTeamDomain( rawDomain ) ) {
                    ApiResponseBuilder.validationError( res, "Invalid domain." );
                    return;
                }

                const domain = rawDomain as TeamDomain;
                const teamUserIds: Types.ObjectId[] = await this.collectTeamUserIdsByDomain( domain );

                const filter: FilterQuery<User> = {};
                if ( teamUserIds.length > 0 ) filter._id = { $nin: teamUserIds };

                const total: number = await UserModel.countDocuments( filter ).exec();

                ApiResponseBuilder.ok( res, "other", { domain, total }, "Total users without team for domain fetched successfully", {
                    pagination: { total },
                } );
                return;
            } catch ( error ) {
                console.error( "[Error:] [TeamManagement] Error while counting domain users without team.\n", error );
                ApiResponseBuilder.internalError( res, error );
                return;
            }
        } );
    }

    private registerUsersInTeamByDomain(): void {
        this.router.get( "/users/in-teams/domain/:domain", async ( req: Request, res: Response ): Promise<void> => {
            try {
                const rawDomain: string = String( req.params.domain ?? "" ).trim().toLowerCase();
                if ( !rawDomain || !this.isValidTeamDomain( rawDomain ) ) {
                    ApiResponseBuilder.validationError( res, "Invalid domain." );
                    return;
                }

                const domain = rawDomain as TeamDomain;
                const { index, limit, skip } = this.parsePagination( req, 10 );

                const teamUserIds: Types.ObjectId[] = await this.collectTeamUserIdsByDomain( domain );

                if ( teamUserIds.length === 0 ) {
                    ApiResponseBuilder.ok( res, "users", [] as User[], "No users found in teams for given domain", {
                        pagination: { total: 0, index, limit },
                        other: { domain },
                    } );
                    return;
                }

                const filter: FilterQuery<User> = { _id: { $in: teamUserIds } };

                const [ total, users ] = await Promise.all( [
                    UserModel.countDocuments( filter ).exec(),
                    UserModel.find( filter, USER_MODEL_PROJECTION ).skip( skip ).limit( limit ).lean<User>().exec() as unknown as User[],
                ] );

                ApiResponseBuilder.ok( res, "users", users, "Users in teams for domain fetched successfully", {
                    pagination: { total, index, limit },
                    other: { domain },
                } );
                return;
            } catch ( error ) {
                console.error( "[Error:] [TeamManagement] Error while fetching domain users in teams.\n", error );
                ApiResponseBuilder.internalError( res, error );
                return;
            }
        } );
    }

    private registerUsersInTeamByDomainCount(): void {
        this.router.get( "/users/in-teams/domain/:domain/count", async ( req: Request, res: Response ): Promise<void> => {
            try {
                const rawDomain: string = String( req.params.domain ?? "" ).trim().toLowerCase();
                if ( !rawDomain || !this.isValidTeamDomain( rawDomain ) ) {
                    ApiResponseBuilder.validationError( res, "Invalid domain." );
                    return;
                }

                const domain = rawDomain as TeamDomain;
                const teamUserIds: Types.ObjectId[] = await this.collectTeamUserIdsByDomain( domain );

                const total: number = teamUserIds.length === 0
                    ? 0
                    : await UserModel.countDocuments( { _id: { $in: teamUserIds } } ).exec();

                ApiResponseBuilder.ok( res, "other", { domain, total }, "Total users in teams for domain fetched successfully", {
                    pagination: { total },
                } );
                return;
            } catch ( error ) {
                console.error( "[Error:] [TeamManagement] Error while counting domain users in teams.\n", error );
                ApiResponseBuilder.internalError( res, error );
                return;
            }
        } );
    }

    // ========================================================================
    // GET /users/all?index=&limit=&search=
    // ========================================================================

    private registerGetAllUsersWithTeams(): void {
        this.router.get( "/users/all", async ( req: Request, res: Response ): Promise<void> => {
            try {
                const { index, limit, skip } = this.parsePagination( req, 10 );

                const rawSearch = req.query.search;
                const search: string | undefined =
                    typeof rawSearch === "string" && rawSearch.trim() ? rawSearch.trim() : undefined;

                const teamFilter: FilterQuery<ITeamManagement> = {};
                const userFilter: FilterQuery<User> = {};

                if ( search ) {
                    const rx = new RegExp( search, "i" );
                    teamFilter.$or = [ { teamName: rx }, { domain: rx }, { teamCode: rx } ];
                    userFilter.$or = [ { name: rx }, { username: rx }, { email: rx } ];
                }

                const pipeline: PipelineStage[] = [
                    { $match: userFilter },

                    {
                        $lookup: {
                            from: TeamManagementModel.collection.name,
                            let: { userId: "$_id", username: "$username" },
                            pipeline: [
                                {
                                    $match: {
                                        ...( Array.isArray( teamFilter.$or ) && teamFilter.$or.length > 0 ? { $or: teamFilter.$or } : {} ),
                                        $expr: {
                                            $gt: [
                                                {
                                                    $size: {
                                                        $filter: {
                                                            input: "$members",
                                                            as: "m",
                                                            cond: {
                                                                $or: [
                                                                    { $eq: [ "$$m.id", "$$userId" ] },
                                                                    { $eq: [ "$$m.username", "$$username" ] },
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
                                { $project: { _id: 0, teamName: 1, domain: 1 } },
                            ],
                            as: "teams",
                        },
                    },

                    { $addFields: { teams: { $ifNull: [ "$teams", [] ] } } },

                    {
                        $lookup: {
                            from: TeamManagementModel.collection.name,
                            let: { userId: "$_id", username: "$username" },
                            pipeline: [
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
                                                                    { $eq: [ "$$m.id", "$$userId" ] },
                                                                    { $eq: [ "$$m.username", "$$username" ] },
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
                                    $addFields: {
                                        membershipForUser: {
                                            $filter: {
                                                input: "$members",
                                                as: "m",
                                                cond: {
                                                    $or: [
                                                        { $eq: [ "$$m.id", "$$userId" ] },
                                                        { $eq: [ "$$m.username", "$$username" ] },
                                                    ],
                                                },
                                            },
                                        },
                                    },
                                },
                                { $unwind: "$membershipForUser" },
                                { $sort: { "membershipForUser.joinedAt": -1 } },
                                { $limit: 1 },
                                {
                                    $project: {
                                        _id: 0,
                                        teamName: 1,
                                        domain: 1,
                                        roleInTeam: "$membershipForUser.roleInTeam",
                                        teamReason: "$membershipForUser.reason",
                                        teamJoinedAt: "$membershipForUser.joinedAt",
                                    },
                                },
                            ],
                            as: "latestTeam",
                        },
                    },

                    {
                        $addFields: {
                            domain: { $ifNull: [ { $arrayElemAt: [ "$latestTeam.domain", 0 ] }, null ] },
                            teamName: { $ifNull: [ { $arrayElemAt: [ "$latestTeam.teamName", 0 ] }, null ] },
                            roleInTeam: { $ifNull: [ { $arrayElemAt: [ "$latestTeam.roleInTeam", 0 ] }, null ] },
                            teamReason: { $ifNull: [ { $arrayElemAt: [ "$latestTeam.teamReason", 0 ] }, null ] },
                            teamJoinedAt: { $ifNull: [ { $arrayElemAt: [ "$latestTeam.teamJoinedAt", 0 ] }, null ] },
                        },
                    },

                    { $project: { password: 0, latestTeam: 0 } },

                    { $sort: { createdAt: -1 } },
                    { $skip: skip },
                    { $limit: limit },

                    { $project: USER_MODEL_PROJECTION },
                ];

                const [ users, totalCount ] = await Promise.all( [
                    UserModel.aggregate<AllUserWithTeams>( pipeline ).exec(),
                    UserModel.countDocuments( userFilter ).exec(),
                ] );

                ApiResponseBuilder.ok( res, "other", { users }, "Users with latest team/domain loaded successfully.", {
                    pagination: {
                        index,
                        limit,
                        total: totalCount,
                        hasMore: index * limit + users.length < totalCount,
                    },
                } );
                return;
            } catch ( error ) {
                console.error( "[Error:] [TeamManagement] Error while getting users with teams.\n", error );
                ApiResponseBuilder.internalError( res, error );
                return;
            }
        } );
    }
}
