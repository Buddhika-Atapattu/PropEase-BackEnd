// Path: src/models/teamManagement/teamManagement.model.ts
import { Schema, model, type Document, type Model, Types } from "mongoose";
import type { User } from "../user.model"; // keep as type-only import if it's only used for typing

// ─────────────────────────────────────────────
// Shared types
// ─────────────────────────────────────────────

export type ISODateString = string;

export type TeamDomain =
    | "sales"
    | "development"
    | "support"
    | "operations"
    | "marketing"
    | "finance"
    | "other";

export type TaskStatus =
    | "draft"
    | "pending"
    | "in_progress"
    | "blocked"
    | "completed"
    | "cancelled";

export type TaskPriority = "low" | "medium" | "high" | "critical";

// ─────────────────────────────────────────────
// Location & address & FileMetaBase
// ─────────────────────────────────────────────

export interface GeoLocation {
    lat: number;
    lng: number;
    embeddedUrl: string;
}

export interface Address {
    houseNumber?: string;
    street?: string;
    city: string;
    provinceOrState?: string;
    country: string;
}

export interface FileMetaBase {
    originalName: string;
    storedName: string;
    extension: string;
    mimeType: string;
    sizeBytes: number;
}

// ─────────────────────────────────────────────
// Evidence model
// ─────────────────────────────────────────────

export interface TaskEvidence {
    name: string;
    file?: FileMetaBase;
    url?: string;
    storageKey?: string;

    uploadedById?: Types.ObjectId;
    uploadedByName?: User[ "username" ];
    uploadedAt?: ISODateString;
}

// ─────────────────────────────────────────────
// Task assignment
// ─────────────────────────────────────────────

export interface AssignedTask {
    id: string;
    name: string;
    description: string;

    location?: GeoLocation;
    address?: Address;

    assignedMembers?: Types.ObjectId[];
    assignedTaskCaptain?: Types.ObjectId;

    status?: TaskStatus;
    priority?: TaskPriority;

    plannedStartAt?: ISODateString;
    plannedEndAt?: ISODateString;
    completedAt?: ISODateString;

    evidence?: TaskEvidence[];
    notes?: string;
}

// ─────────────────────────────────────────────
// Team management root model
// ─────────────────────────────────────────────

export type OrgUnitType = "team" | "department" | "squad" | "board";

export const TEAM_ROLES = [
    "captain",
    "member",
    "lead",
    "supervisor",
    "observer",
    "mechanic",
    "carpenter",
    "electrician",
    "plumber",
    "technician",
    "welder",
    "driver",
    "cleaner",
    "security",
    "gardener",
    "painter",
    "mason",
    "helper",
] as const;

export type RoleInTeam = ( typeof TEAM_ROLES )[ number ];

export type UserTeams = {
    team: TeamManagementBase[ 'teamName' ];
    domain: TeamDomain;
}

export interface TeamMember {
    id: Types.ObjectId;
    username: User[ "username" ];
    user?: User | null;
    teams?: UserTeams[] | null;
    roleInTeam?: RoleInTeam | null;
    reason?: string | null;
    joinedAt?: ISODateString | null;
}

/**
 * ✅ Pure-data interface (NO Mongoose Document)
 * Use this for:
 *  - API response typing
 *  - aggregation output typing
 *  - frontend contracts
 */
export interface TeamManagementBase {
    teamCode: string;
    teamName: string;
    orgType?: OrgUnitType;
    domain: TeamDomain;
    description: string;
    members: TeamMember[];
    captain: TeamMember;
    memberTotal: number;
    assignTasks: AssignedTask[];
    teamLogo?: TaskEvidence;
    createdAt: ISODateString;
    updatedAt: ISODateString;
    isActive?: boolean;
}

/**
 * ✅ Mongoose Document type (DB-layer only)
 * Use this for:
 *  - model methods
 *  - save/update hooks
 *  - persistence logic
 */
export interface ITeamManagement extends TeamManagementBase, Document {}

/**
 * ✅ DTO type (plain JSON) for aggregation results
 * aggregate() returns this style (not Document)
 */
export type TeamManagementDto = TeamManagementBase;

const MAX_ACTIVE_TEAMS_PER_USER: number = 5;

// ─────────────────────────────────────────────
// Model builder class
// ─────────────────────────────────────────────

class TeamModelBuilder {
    private readonly geoLocationSchema: Schema<GeoLocation>;
    private readonly addressSchema: Schema<Address>;
    private readonly fileMetaBaseSchema: Schema<FileMetaBase>;
    private readonly taskEvidenceSchema: Schema<TaskEvidence>;
    private readonly assignedTaskSchema: Schema<AssignedTask>;
    private readonly teamMemberSchema: Schema<TeamMember>;

    public constructor () {
        this.geoLocationSchema = this.buildGeoLocationModelSchema();
        this.addressSchema = this.buildAddressModelSchema();
        this.fileMetaBaseSchema = this.buildFileMetaBaseSchema();
        this.taskEvidenceSchema = this.buildTaskEvidenceSchema();
        this.assignedTaskSchema = this.buildAssignedTaskSchema();
        this.teamMemberSchema = this.buildTeamMemberSchema();
    }

    // ─────────────────────────────────────────────
    // Subdocument schemas
    // ─────────────────────────────────────────────

    private buildGeoLocationModelSchema(): Schema<GeoLocation> {
        return new Schema<GeoLocation>(
            {
                lat: { type: Number, required: true, default: 0 },
                lng: { type: Number, required: true, default: 0 },
                embeddedUrl: { type: String, required: true, default: "" },
            },
            { _id: false, timestamps: false }
        );
    }

    private buildAddressModelSchema(): Schema<Address> {
        return new Schema<Address>(
            {
                houseNumber: { type: String, required: false, default: "" },
                street: { type: String, required: false, default: "" },
                city: { type: String, required: true, default: "" },
                provinceOrState: { type: String, required: false, default: "" },
                country: { type: String, required: true, default: "" },
            },
            { _id: false, timestamps: false }
        );
    }

    private buildFileMetaBaseSchema(): Schema<FileMetaBase> {
        return new Schema<FileMetaBase>(
            {
                originalName: { type: String, required: true },
                storedName: { type: String, required: true },
                extension: { type: String, required: true, default: "" },
                mimeType: { type: String, required: true, default: "" },
                sizeBytes: { type: Number, required: true, default: 0 },
            },
            { _id: false, timestamps: false }
        );
    }

    private buildTaskEvidenceSchema(): Schema<TaskEvidence> {
        return new Schema<TaskEvidence>(
            {
                name: { type: String, required: true, default: "" },
                file: { type: this.fileMetaBaseSchema, required: false },
                url: { type: String, required: false, default: "" },
                storageKey: { type: String, required: false, default: "" },
                uploadedById: { type: Schema.Types.ObjectId, ref: "User", required: false },
                uploadedByName: { type: String, required: false, default: "" },
                uploadedAt: { type: String, required: false, default: () => new Date().toISOString() },
            },
            { _id: false, timestamps: false }
        );
    }

    private buildAssignedTaskSchema(): Schema<AssignedTask> {
        return new Schema<AssignedTask>(
            {
                id: { type: String, required: true },
                name: { type: String, required: true },
                description: { type: String, required: true, default: "" },

                location: { type: this.geoLocationSchema, required: false },
                address: { type: this.addressSchema, required: false },

                assignedMembers: [ { type: Schema.Types.ObjectId, ref: "User", required: false } ],
                assignedTaskCaptain: { type: Schema.Types.ObjectId, ref: "User", required: false },

                status: {
                    type: String,
                    enum: [ "draft", "pending", "in_progress", "blocked", "completed", "cancelled" ],
                    required: false,
                    default: "draft",
                },

                priority: {
                    type: String,
                    enum: [ "low", "medium", "high", "critical" ],
                    required: false,
                    default: "medium",
                },

                plannedStartAt: { type: String, required: false, default: "" },
                plannedEndAt: { type: String, required: false, default: "" },
                completedAt: { type: String, required: false, default: "" },

                evidence: { type: [ this.taskEvidenceSchema ], required: false, default: [] },
                notes: { type: String, required: false, default: "" },
            },
            { _id: false, timestamps: false }
        );
    }

    private buildTeamMemberSchema(): Schema<TeamMember> {
        return new Schema<TeamMember>(
            {
                id: { type: Schema.Types.ObjectId, required: true, ref: "User", index: true },

                username: { type: String, required: true, trim: true, index: true },

                // roleInTeam: optional at API level, but if missing we default it.
                // required:false prevents validation pain when you build members incrementally.
                roleInTeam: {
                    type: String,
                    enum: [ ...TEAM_ROLES ],
                    required: false,
                    default: null,
                },

                reason: { type: String, required: false, default: null },

                joinedAt: { type: String, required: false, default: () => new Date().toISOString() },
            },
            { _id: false, timestamps: false }
        );
    }

    // ─────────────────────────────────────────────
    // Root Team schema & model
    // ─────────────────────────────────────────────

    private buildTeamManagementSchema(): Schema<ITeamManagement> {
        const TeamSchema: Schema<ITeamManagement> = new Schema<ITeamManagement>(
            {
                teamCode: { type: String, required: true, unique: true },

                teamName: { type: String, unique: true, required: true, trim: true },

                orgType: {
                    type: String,
                    enum: [ "team", "department", "squad", "board" ],
                    required: false,
                    default: "team",
                },

                domain: {
                    type: String,
                    enum: [ "sales", "development", "support", "operations", "marketing", "finance", "other" ],
                    required: true,
                    default: "other",
                },

                description: { type: String, required: false, default: "" },

                members: { type: [ this.teamMemberSchema ], required: false, default: [] },

                captain: { type: this.teamMemberSchema, required: true },

                memberTotal: { type: Number, required: true, default: 0 },

                assignTasks: { type: [ this.assignedTaskSchema ], required: false, default: [] },

                // ✅ Prefer "undefined" default so "no logo" truly means absent.
                teamLogo: { type: this.taskEvidenceSchema, required: false, default: undefined },

                createdAt: { type: String, required: true, default: () => new Date().toISOString() },
                updatedAt: { type: String, required: true, default: () => new Date().toISOString() },

                isActive: { type: Boolean, required: false, default: true },
            },
            { timestamps: false }
        );

        // Indexes
        TeamSchema.index( { teamName: 1, domain: 1 } );
        TeamSchema.index( { "members.id": 1, isActive: 1 } );

        // Unique index on nested array field (multikey unique).
        // partialFilterExpression uses Mongo keywords:
        // - $exists: field exists
        // - $ne    : not equal (SQL !=)
        TeamSchema.index(
            { "assignTasks.id": 1 },
            {
                unique: true,
                partialFilterExpression: { "assignTasks.id": { $exists: true, $ne: null } },
            }
        );

        // Pre-save hook to enforce "user can be in max N active teams"
        TeamSchema.pre<ITeamManagement>( "save", async function ( next ) {
            try {
                // If this doc isn't new AND members didn't change, skip the expensive checks
                if ( !this.isNew && !this.isModified( "members" ) ) {
                    next();
                    return;
                }

                // Make unique member ids (we compare as strings)
                const uniqueMemberIds: string[] = Array.from(
                    new Set( this.members.map( ( m ) => m.id.toString() ) )
                );

                // ✅ In a document middleware, use this.model(name) (safe access to model)
                const TeamModel: Model<ITeamManagement> = this.model( "TeamManagement" ) as Model<ITeamManagement>;

                for ( const memberId of uniqueMemberIds ) {
                    // Mongo keywords here:
                    // - $ne: not equal (exclude current team)
                    // We count how many OTHER active teams contain this memberId.
                    const count: number = await TeamModel.countDocuments( {
                        "members.id": new Types.ObjectId( memberId ),
                        isActive: true,
                        _id: { $ne: this._id },
                    } ).exec();

                    if ( count >= MAX_ACTIVE_TEAMS_PER_USER ) {
                        next(
                            new Error(
                                `User ${ memberId } already belongs to ${ count } active teams (max allowed is ${ MAX_ACTIVE_TEAMS_PER_USER }).`
                            )
                        );
                        return;
                    }
                }

                next();
                return;
            } catch ( err ) {
                next( err as Error );
                return;
            }
        } );

        return TeamSchema;
    }

    public buildModel(): Model<ITeamManagement> {
        const schema: Schema<ITeamManagement> = this.buildTeamManagementSchema();

        // NOTE: model name is "TeamManagement"
        // collection is "teams"
        return model<ITeamManagement>( "TeamManagement", schema, "teams" );
    }
}

// ─────────────────────────────────────────────
// Exported model instance
// ─────────────────────────────────────────────

const teamModelBuilder: TeamModelBuilder = new TeamModelBuilder();

export const TeamManagementModel: Model<ITeamManagement> = teamModelBuilder.buildModel();
