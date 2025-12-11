// Path: src/models/teamManagement/teamManagement.model.ts
import { Schema, model, type Document, type Model, Types } from 'mongoose';
import { User } from '../user.model';

// ─────────────────────────────────────────────
// Shared types
// ─────────────────────────────────────────────

// ISO date string (e.g. "2025-12-01T10:15:30.000Z")
export type ISODateString = string;

// High-level domain of a team: sales, dev, etc.
export type TeamDomain =
    | 'sales'
    | 'development'
    | 'support'
    | 'operations'
    | 'marketing'
    | 'finance'
    | 'other';

// Simple task status lifecycle
export type TaskStatus =
    | 'draft'
    | 'pending'
    | 'in_progress'
    | 'blocked'
    | 'completed'
    | 'cancelled';

// Optional priority scale for tasks
export type TaskPriority = 'low' | 'medium' | 'high' | 'critical';

// ─────────────────────────────────────────────
// Location & address & FileMetaBase
// ─────────────────────────────────────────────

export interface GeoLocation {
    /** Latitude in decimal degrees */
    lat: number;

    /** Longitude in decimal degrees */
    lng: number;

    /**
     * Embedded map URL (Google Maps / OSM, etc.)
     * Example: "https://www.google.com/maps/embed?pb=..."
     */
    embeddedUrl: string;
}

export interface Address {
    houseNumber?: string;
    street?: string;
    city: string;
    provinceOrState?: string;
    country: string;
}

/**
 * Minimal file metadata used across backend.
 * Pure JSON (no File, no Buffer here).
 */
export interface FileMetaBase {
    /** Original filename sent by client (as uploaded) */
    originalName: string;

    /** Stored filename on disk or in bucket (unique) */
    storedName: string;

    /** File extension without dot, e.g. "pdf", "jpg" */
    extension: string;

    /** MIME type, e.g. "application/pdf", "image/jpeg" */
    mimeType: string;

    /** Size in bytes */
    sizeBytes: number;
}

// ─────────────────────────────────────────────
// Evidence model
// ─────────────────────────────────────────────

/**
 * Evidence attached to a task.
 * Backend stores metadata only (no browser File type).
 */
export interface TaskEvidence {
    /** Original file name or label */
    name: string;

    /** Stored file metadata */
    file?: FileMetaBase;

    /** Public or signed URL pointing to the stored evidence */
    url?: string;

    /** Internal storage key/path in your backend (e.g. S3 key, local path) */
    storageKey?: string;

    /** Who attached this evidence */
    uploadedById?: Types.ObjectId;
    uploadedByName?: User[ 'username' ];

    /** When it was attached */
    uploadedAt?: ISODateString;
}

// ─────────────────────────────────────────────
// Task assignment
// ─────────────────────────────────────────────

export interface AssignedTask {
    /** Unique ID of the task (UUID, Mongo ID, PropEase code, etc.) */
    id: string;

    /** Short, human-readable name */
    name: string;

    /** Longer description / acceptance criteria */
    description: string;

    /** Optional location attached to the task (onsite visit, inspection, etc.) */
    location?: GeoLocation;

    /** Optional physical address (for site visits, meetings, etc.) */
    address?: Address;

    /**
     * Members assigned to this task.
     * Typically a subset of the team members, but can also include cross-team members.
     */
    assignedMembers?: Types.ObjectId[];

    /**
     * The person responsible for coordinating this task.
     * Does not have to be the same as the team captain.
     */
    assignedTaskCaptain?: Types.ObjectId;

    /** Current status in the task lifecycle */
    status?: TaskStatus;

    /** Importance / urgency of the task */
    priority?: TaskPriority;

    /** Planned start date for the task */
    plannedStartAt?: ISODateString;

    /** Planned end / due date */
    plannedEndAt?: ISODateString;

    /** Actual completion date when status becomes "completed" */
    completedAt?: ISODateString;

    /**
     * Evidence associated with this task.
     * For backend we store metadata only.
     */
    evidence?: TaskEvidence[];

    /** Optional free-text notes (internal comments, links, etc.) */
    notes?: string;
}

// ─────────────────────────────────────────────
// Team management root model
// ─────────────────────────────────────────────

export type OrgUnitType = 'team' | 'department' | 'squad' | 'board';

/** All supported team roles */
export const TEAM_ROLES = [
    // Core roles
    'captain',
    'member',
    'lead',
    'supervisor',
    'observer',

    // Trade-based / functional roles
    'mechanic',
    'carpenter',
    'electrician',
    'plumber',
    'technician',
    'welder',
    'driver',
    'cleaner',
    'security',
    'gardener',
    'painter',
    'mason',
    'helper',
] as const;

export type RoleInTeam = ( typeof TEAM_ROLES )[ number ];


export interface TeamMember {
    id: Types.ObjectId;
    username: User[ 'username' ];
    roleInTeam?: RoleInTeam;
    reason?: string;          // why this user is in the team
    joinedAt?: ISODateString;          // ✅ when this user joined THIS team
}

export interface ITeamManagement extends Document {
    /** Unique team ID (e.g. PROPEASE-TEAM-...) */
    id: string;

    /** Display name of the team (e.g. "Sales - West Region") */
    teamName: string;

    orgType?: OrgUnitType;             // team | department | squad

    /** What area this team belongs to (sales/dev/support/etc.) */
    domain: TeamDomain;

    /** Simple description of the team's responsibility / scope */
    description: string;

    /** All members currently in the team */
    members: TeamMember[];

    /**
     * Team captain / lead (primary responsible person).
     * This person may or may not be part of `members` array depending on your design.
     */
    captain: TeamMember;

    /** Cached total member count for quick access (should match members.length) */
    memberTotal: number;

    /**
     * All tasks currently associated with this team.
     * You might later page this instead of loading all at once.
     */
    assignTasks: AssignedTask[];

    /** Optional team logo (file for FE, url/storageKey after upload) */
    teamLogo?: TaskEvidence;

    /** When the team record was first created (ISO string) */
    createdAt: ISODateString;

    /** When the team record was last updated (ISO string) */
    updatedAt: ISODateString;

    /** Optional: whether this team is active/disabled in the system */
    isActive?: boolean;
}

const MAX_ACTIVE_TEAMS_PER_USER: number = 5;


// ─────────────────────────────────────────────
// Model builder class
// ─────────────────────────────────────────────

class TeamModelBuilder {
    private readonly now: string = new Date().toISOString();

    private readonly geoLocationSchema: Schema<GeoLocation>;
    private readonly addressSchema: Schema<Address>;
    private readonly fileMetaBaseSchema: Schema<FileMetaBase>;
    private readonly taskEvidenceSchema: Schema<TaskEvidence>;
    private readonly assignedTaskSchema: Schema<AssignedTask>;
    private readonly teamMember: Schema<TeamMember>;

    constructor () {
        this.geoLocationSchema = this.buildGeoLocationModelSchema();
        this.addressSchema = this.buildAddressModelSchema();
        this.fileMetaBaseSchema = this.buildFileMetaBaseSchema();
        this.taskEvidenceSchema = this.buildTaskEvidenceSchema();
        this.assignedTaskSchema = this.buildAssignedTaskSchema();
        this.teamMember = this.buildTeamMemberSchema();
    }

    // ─────────────────────────────────────────────
    // Subdocument schemas
    // ─────────────────────────────────────────────

    private buildGeoLocationModelSchema(): Schema<GeoLocation> {
        const geoLocation: Schema<GeoLocation> = new Schema<GeoLocation>(
            {
                lat: { type: Number, required: true, default: 0 },
                lng: { type: Number, required: true, default: 0 },
                embeddedUrl: { type: String, required: true, default: '' },
            },
            {
                _id: false,
                timestamps: false,
            },
        );
        return geoLocation;
    }

    private buildAddressModelSchema(): Schema<Address> {
        const address: Schema<Address> = new Schema<Address>(
            {
                houseNumber: { type: String, required: false, default: '' },
                street: { type: String, required: false, default: '' },
                city: { type: String, required: true, default: '' },
                provinceOrState: { type: String, required: false, default: '' },
                country: { type: String, required: true, default: '' },
            },
            {
                _id: false,
                timestamps: false,
            },
        );
        return address;
    }

    private buildFileMetaBaseSchema(): Schema<FileMetaBase> {
        const fileMetaBaseSchema: Schema<FileMetaBase> = new Schema<FileMetaBase>(
            {
                originalName: { type: String, required: true },
                storedName: { type: String, required: true },
                extension: { type: String, required: true, default: '' },
                mimeType: { type: String, required: true, default: '' },
                sizeBytes: { type: Number, required: true, default: 0 },
            },
            {
                _id: false,
                timestamps: false,
            },
        );
        return fileMetaBaseSchema;
    }

    private buildTaskEvidenceSchema(): Schema<TaskEvidence> {
        const taskEvidence: Schema<TaskEvidence> = new Schema<TaskEvidence>(
            {
                name: { type: String, required: true, default: '' },
                file: { type: this.fileMetaBaseSchema, required: false },
                url: { type: String, required: false, default: '' },
                storageKey: { type: String, required: false, default: '' },
                uploadedById: {
                    type: Schema.Types.ObjectId,
                    ref: 'User',
                    required: false,
                },
                uploadedByName: { type: String, required: false, default: '' },
                uploadedAt: {
                    type: String,
                    required: false,
                    default: () => new Date().toISOString(),
                },
            },
            {
                _id: false,
                timestamps: false,
            },
        );
        return taskEvidence;
    }

    private buildAssignedTaskSchema(): Schema<AssignedTask> {
        const assignedTask: Schema<AssignedTask> = new Schema<AssignedTask>(
            {
                id: { type: String, required: true }, // your generateTeamIdentity / generateTaskIdentity result
                name: { type: String, required: true },
                description: { type: String, required: true, default: '' },

                location: {
                    type: this.geoLocationSchema,
                    required: false,
                },

                address: {
                    type: this.addressSchema,
                    required: false,
                },

                assignedMembers: [
                    {
                        type: Schema.Types.ObjectId,
                        ref: 'User',
                        required: false,
                    },
                ],

                assignedTaskCaptain: {
                    type: Schema.Types.ObjectId,
                    ref: 'User',
                    required: false,
                },

                status: {
                    type: String,
                    enum: [ 'draft', 'pending', 'in_progress', 'blocked', 'completed', 'cancelled' ],
                    required: false,
                    default: 'draft',
                },

                priority: {
                    type: String,
                    enum: [ 'low', 'medium', 'high', 'critical' ],
                    required: false,
                    default: 'medium',
                },

                plannedStartAt: {
                    type: String,
                    required: false,
                    default: '',
                },

                plannedEndAt: {
                    type: String,
                    required: false,
                    default: '',
                },

                completedAt: {
                    type: String,
                    required: false,
                    default: '',
                },

                evidence: {
                    type: [ this.taskEvidenceSchema ],
                    required: false,
                    default: [],
                },

                notes: {
                    type: String,
                    required: false,
                    default: '',
                },
            },
            {
                _id: false,
                timestamps: false,
            },
        );

        return assignedTask;
    }

    private buildTeamMemberSchema(): Schema<TeamMember> {
        const teamMember: Schema<TeamMember> = new Schema<TeamMember>(
            {
                id: {
                    type: Schema.Types.ObjectId,
                    required: true,
                    ref: 'User',
                    index: true,
                },
                username: {
                    type: String,
                    required: true,
                    trim: true,
                    index: true,
                },
                roleInTeam: {
                    type: String,
                    enum: [
                        'captain',
                        'member',
                        'lead',
                        'supervisor',
                        'observer',

                        // Trade-based roles
                        'mechanic',
                        'carpenter',
                        'electrician',
                        'plumber',
                        'technician',
                        'welder',
                        'driver',
                        'cleaner',
                        'security',
                        'gardener',
                        'painter',
                        'mason',
                        'helper',
                    ],
                    required: true,
                    default: 'member'
                },
                reason: {
                    type: String,
                    required: false,
                    default: '',
                },
                joinedAt: {
                    type: String,
                    required: false,
                    default: () => new Date().toISOString(),
                }

            },
            {
                _id: false,
                timestamps: false,
            },
        );
        return teamMember;
    }


    // ─────────────────────────────────────────────
    // Root Team schema & model
    // ─────────────────────────────────────────────

    private buildTeamManagementSchema(): Schema<ITeamManagement> {
        const TeamSchema: Schema<ITeamManagement> = new Schema<ITeamManagement>(
            {
                id: {
                    type: String,
                    required: true,
                    unique: true,
                },

                teamName: {
                    type: String,
                    unique: true,
                    required: true,
                    trim: true,
                },

                orgType: {
                    type: String,
                    enum: [ 'team', 'department', 'squad', 'board' ],
                    required: false,
                    default: 'team'
                },

                domain: {
                    type: String,
                    enum: [ 'sales', 'development', 'support', 'operations', 'marketing', 'finance', 'other' ],
                    required: true,
                    default: 'other',
                },

                description: {
                    type: String,
                    required: false,
                    default: '',
                },

                members: {
                    type: [ this.teamMember ],
                    required: false,
                    default: [],
                },


                captain: {
                    type: this.teamMember,
                    required: true,
                },


                memberTotal: {
                    type: Number,
                    required: true,
                    default: 0,
                },

                assignTasks: {
                    type: [ this.assignedTaskSchema ],
                    required: false,
                    default: [],
                },

                teamLogo: {
                    type: this.taskEvidenceSchema,
                    required: false,
                    default: {},
                },

                createdAt: {
                    type: String,
                    required: true,
                    default: () => new Date().toISOString(),
                },

                updatedAt: {
                    type: String,
                    required: true,
                    default: () => new Date().toISOString(),
                },

                isActive: {
                    type: Boolean,
                    required: false,
                    default: true,
                },
            },
            {
                // We manage createdAt/updatedAt manually as ISO strings
                timestamps: false,
            },
        );
        // Useful indexes
        TeamSchema.index( { teamName: 1, domain: 1 } );
        TeamSchema.index( { 'members.id': 1, isActive: 1 } );

        // Global uniqueness for AssignedTask.id across ALL teams
        // - Only enforced when assignTasks.id exists and is non-null
        TeamSchema.index(
            { 'assignTasks.id': 1 },
            {
                unique: true,
                partialFilterExpression: {
                    'assignTasks.id': { $exists: true, $ne: null },
                },
            },
        );

        TeamSchema.pre<ITeamManagement>( 'save', async function ( next ) {
            try {
                if ( !this.isNew && !this.isModified( 'members' ) ) {
                    return next();
                }

                const uniqueMemberIds: string[] = Array.from(
                    new Set( this.members.map( ( m ) => m.id.toString() ) ),
                );

                const TeamModel: Model<ITeamManagement> =
                    model<ITeamManagement>( 'TeamManagement' );

                for ( const memberId of uniqueMemberIds ) {
                    const count: number = await TeamModel
                        .countDocuments( {
                            'members.id': new Types.ObjectId( memberId ),
                            isActive: true,
                            _id: { $ne: this._id },
                        } )
                        .exec();

                    if ( count >= MAX_ACTIVE_TEAMS_PER_USER ) {
                        const error = new Error(
                            `User ${ memberId } already belongs to ${ count } active teams (max allowed is ${ MAX_ACTIVE_TEAMS_PER_USER }).`,
                        );
                        return next( error );
                    }
                }

                next();
            } catch ( err ) {
                next( err as Error );
            }
        } );


        return TeamSchema;

    }

    public buildModel(): Model<ITeamManagement> {
        const schema = this.buildTeamManagementSchema();
        const TeamManagementModel: Model<ITeamManagement> = model<ITeamManagement>(
            'TeamManagement',
            schema,
            'teams'
        );
        return TeamManagementModel;
    }
}

// ─────────────────────────────────────────────
// Exported model instance
// ─────────────────────────────────────────────

const teamModelBuilder = new TeamModelBuilder();

export const TeamManagementModel: Model<ITeamManagement> =
    teamModelBuilder.buildModel();
