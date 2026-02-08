// Path: src/models/teamManagement/teamManagement.model.ts
// =============================================================================
// TeamManagement Model (Mongoose) — UPDATED to Universal Comment System
// -----------------------------------------------------------------------------
// =============================================================================

import { Schema, Types, model, type Document, type Model } from "mongoose";

import type { User } from "../user.model";

// ─────────────────────────────────────────────
// Shared types (stable contracts)
// ─────────────────────────────────────────────

export type ISODateString = string;

export const TEAM_DOMAINS = [
    "sales",
    "development",
    "support",
    "operations",
    "marketing",
    "finance",
    "other",
] as const;

export type TeamDomain = ( typeof TEAM_DOMAINS )[ number ];

export const TASK_STATUSES = [
    "draft",
    "pending",
    "in_progress",
    "blocked",
    "completed",
    "cancelled",
    "completed_pending_confirmation",
] as const;

export type TaskStatus = ( typeof TASK_STATUSES )[ number ];

export const TASK_PRIORITIES = [ "low", "medium", "high", "critical" ] as const;
export type TaskPriority = ( typeof TASK_PRIORITIES )[ number ];

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
// Completion confirmation (align to FE)
// ─────────────────────────────────────────────

export type CompletionSignerRole = "customer" | "supervisor";

export type CompletionConfirmationStatus =
    | "not_required"
    | "pending"
    | "rejected"
    | "confirmed";

export interface TaskCompletionSignature {
    role: CompletionSignerRole;

    signerUserId?: Types.ObjectId;
    signerUsername?: string;
    signerName?: string;

    signatureFile?: FileMetaBase;
    signatureUrl?: string;
    signatureStorageKey?: string;

    signedAt?: ISODateString;
}

export interface TaskCompletionConfirmation {
    status: CompletionConfirmationStatus;

    requiredRoles?: CompletionSignerRole[];
    signatures?: TaskCompletionSignature[];

    confirmedAt?: ISODateString;
    confirmedByUserId?: Types.ObjectId;
    confirmedByUsername?: string;

    rejectedAt?: ISODateString;
    rejectedByUserId?: Types.ObjectId;
    rejectedByUsername?: string;

    rejectReason?: string;
}

// ─────────────────────────────────────────────
// KPI-ready operational metadata (task level)
// ─────────────────────────────────────────────

export type WorkSource = "ui" | "system" | "automation" | "import";

export interface TaskAuditMeta {
    source?: WorkSource;

    requestId?: string;
    deviceId?: string;

    createdByUserId?: Types.ObjectId;
    createdByUsername?: string;

    lastUpdatedByUserId?: Types.ObjectId;
    lastUpdatedByUsername?: string;
}

export interface TaskSlaPolicy {
    dueAt?: ISODateString;

    breachAt?: ISODateString;

    severity?: "low" | "medium" | "high" | "critical";
}

export interface TaskBlockedWindow {
    from: ISODateString;

    to?: ISODateString | null;

    reason?: string | null;

    setByUserId?: Types.ObjectId;
    setByUsername?: string;
}

export interface TaskAssigneeHistoryEntry {
    userId: Types.ObjectId;
    username: string;

    from: ISODateString;
    to?: ISODateString | null;

    changedByUserId?: Types.ObjectId;
    changedByUsername?: string;

    reason?: string | null;
}

export interface TaskRuntimeMetrics {
    effortPoints?: number;
    complexity?: number;

    estimatedMinutes?: number;
    actualMinutes?: number;

    reopenedCount?: number;
    rejectedCount?: number;

    customerSatisfactionScore?: number;
    supervisorQualityScore?: number;
}

export interface TaskTiming {
    createdAt?: ISODateString | null;
    updatedAt?: ISODateString | null;

    firstResponseAt?: ISODateString | null;
    startedAt?: ISODateString | null;

    lastBlockedAt?: ISODateString | null;

    completedAt?: ISODateString | null;
    confirmedAt?: ISODateString | null;

    cancelledAt?: ISODateString | null;
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

    timing?: TaskTiming;

    sla?: TaskSlaPolicy;
    metrics?: TaskRuntimeMetrics;

    blockedWindows?: TaskBlockedWindow[];
    assigneeHistory?: TaskAssigneeHistoryEntry[];

    completionConfirmation?: TaskCompletionConfirmation;

    evidence?: TaskEvidence[];

    notes?: string;

    labels?: string[];

    audit?: TaskAuditMeta;
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
    teamName: TeamManagementBase[ "teamName" ];
    domain: TeamDomain;
};

export interface TeamMember {
    id: Types.ObjectId;
    username: User[ "username" ];

    user?: User | null;
    teams?: UserTeams[] | null;

    roleInTeam?: RoleInTeam | null;
    reason?: string | null;
    joinedAt?: ISODateString | null;

    domain?: TeamDomain | null;
    teamName?: TeamManagementBase[ "teamName" ] | null;
    teamReason?: string | null;
}

export interface TeamAuditMeta {
    createdByUserId?: Types.ObjectId;
    createdByUsername?: string;

    lastUpdatedByUserId?: Types.ObjectId;
    lastUpdatedByUsername?: string;

    lastActivityAt?: ISODateString;
}

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

    audit?: TeamAuditMeta;
}

export interface ITeamManagement extends TeamManagementBase, Document {}

export type TeamManagementDto = TeamManagementBase;

const MAX_ACTIVE_TEAMS_PER_USER: number = 5;

// ─────────────────────────────────────────────
// Model builder class (class-based only)
// ─────────────────────────────────────────────

class TeamModelBuilder {
    private readonly geoLocationSchema: Schema<GeoLocation>;

    private readonly addressSchema: Schema<Address>;

    private readonly fileMetaBaseSchema: Schema<FileMetaBase>;

    private readonly taskEvidenceSchema: Schema<TaskEvidence>;

    private readonly taskCompletionSignatureSchema: Schema<TaskCompletionSignature>;

    private readonly taskCompletionConfirmationSchema: Schema<TaskCompletionConfirmation>;

    private readonly taskAuditMetaSchema: Schema<TaskAuditMeta>;

    private readonly taskSlaPolicySchema: Schema<TaskSlaPolicy>;

    private readonly taskBlockedWindowSchema: Schema<TaskBlockedWindow>;

    private readonly taskAssigneeHistoryEntrySchema: Schema<TaskAssigneeHistoryEntry>;

    private readonly taskRuntimeMetricsSchema: Schema<TaskRuntimeMetrics>;

    private readonly taskTimingSchema: Schema<TaskTiming>;

    private readonly assignedTaskSchema: Schema<AssignedTask>;

    private readonly teamMemberSchema: Schema<TeamMember>;

    private readonly teamAuditMetaSchema: Schema<TeamAuditMeta>;

    public constructor () {
        this.geoLocationSchema = this.buildGeoLocationModelSchema();

        this.addressSchema = this.buildAddressModelSchema();

        this.fileMetaBaseSchema = this.buildFileMetaBaseSchema();

        this.taskEvidenceSchema = this.buildTaskEvidenceSchema();

        this.taskCompletionSignatureSchema = this.buildTaskCompletionSignatureSchema();

        this.taskCompletionConfirmationSchema = this.buildTaskCompletionConfirmationSchema();

        this.taskAuditMetaSchema = this.buildTaskAuditMetaSchema();

        this.taskSlaPolicySchema = this.buildTaskSlaPolicySchema();

        this.taskBlockedWindowSchema = this.buildTaskBlockedWindowSchema();

        this.taskAssigneeHistoryEntrySchema = this.buildTaskAssigneeHistoryEntrySchema();

        this.taskRuntimeMetricsSchema = this.buildTaskRuntimeMetricsSchema();

        this.taskTimingSchema = this.buildTaskTimingSchema();

        this.assignedTaskSchema = this.buildAssignedTaskSchema();

        this.teamMemberSchema = this.buildTeamMemberSchema();

        this.teamAuditMetaSchema = this.buildTeamAuditMetaSchema();
    }

    // ─────────────────────────────────────────────
    // Base nested schemas
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
                originalName: { type: String, required: true, default: "" },

                storedName: { type: String, required: true, default: "" },

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

    // ─────────────────────────────────────────────
    // Completion confirmation schemas
    // ─────────────────────────────────────────────

    private buildTaskCompletionSignatureSchema(): Schema<TaskCompletionSignature> {
        return new Schema<TaskCompletionSignature>(
            {
                role: { type: String, enum: [ "customer", "supervisor" ], required: true },

                signerUserId: { type: Schema.Types.ObjectId, ref: "User", required: false },

                signerUsername: { type: String, required: false, default: "" },

                signerName: { type: String, required: false, default: "" },

                signatureFile: { type: this.fileMetaBaseSchema, required: false },

                signatureUrl: { type: String, required: false, default: "" },

                signatureStorageKey: { type: String, required: false, default: "" },

                signedAt: { type: String, required: false, default: () => new Date().toISOString() },
            },
            { _id: false, timestamps: false }
        );
    }

    private buildTaskCompletionConfirmationSchema(): Schema<TaskCompletionConfirmation> {
        return new Schema<TaskCompletionConfirmation>(
            {
                status: {
                    type: String,
                    enum: [ "not_required", "pending", "rejected", "confirmed" ],
                    required: true,
                    default: "not_required",
                },

                requiredRoles: { type: [ String ], required: false, default: [] },

                signatures: { type: [ this.taskCompletionSignatureSchema ], required: false, default: [] },

                confirmedAt: { type: String, required: false, default: "" },

                confirmedByUserId: { type: Schema.Types.ObjectId, ref: "User", required: false },

                confirmedByUsername: { type: String, required: false, default: "" },

                rejectedAt: { type: String, required: false, default: "" },

                rejectedByUserId: { type: Schema.Types.ObjectId, ref: "User", required: false },

                rejectedByUsername: { type: String, required: false, default: "" },

                rejectReason: { type: String, required: false, default: "" },
            },
            { _id: false, timestamps: false }
        );
    }

    // ─────────────────────────────────────────────
    // KPI-ready task schemas
    // ─────────────────────────────────────────────

    private buildTaskAuditMetaSchema(): Schema<TaskAuditMeta> {
        return new Schema<TaskAuditMeta>(
            {
                source: {
                    type: String,
                    enum: [ "ui", "system", "automation", "import" ],
                    required: false,
                    default: "ui",
                },

                requestId: { type: String, required: false, default: "" },

                deviceId: { type: String, required: false, default: "" },

                createdByUserId: { type: Schema.Types.ObjectId, ref: "User", required: false },

                createdByUsername: { type: String, required: false, default: "" },

                lastUpdatedByUserId: { type: Schema.Types.ObjectId, ref: "User", required: false },

                lastUpdatedByUsername: { type: String, required: false, default: "" },
            },
            { _id: false, timestamps: false }
        );
    }

    private buildTaskSlaPolicySchema(): Schema<TaskSlaPolicy> {
        return new Schema<TaskSlaPolicy>(
            {
                dueAt: { type: String, required: false, default: "" },

                breachAt: { type: String, required: false, default: "" },

                severity: { type: String, enum: [ "low", "medium", "high", "critical" ], required: false, default: "medium" },
            },
            { _id: false, timestamps: false }
        );
    }

    private buildTaskBlockedWindowSchema(): Schema<TaskBlockedWindow> {
        return new Schema<TaskBlockedWindow>(
            {
                from: { type: String, required: true, default: () => new Date().toISOString() },

                to: { type: String, required: false, default: null },

                reason: { type: String, required: false, default: null },

                setByUserId: { type: Schema.Types.ObjectId, ref: "User", required: false },

                setByUsername: { type: String, required: false, default: "" },
            },
            { _id: false, timestamps: false }
        );
    }

    private buildTaskAssigneeHistoryEntrySchema(): Schema<TaskAssigneeHistoryEntry> {
        return new Schema<TaskAssigneeHistoryEntry>(
            {
                userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },

                username: { type: String, required: true, trim: true, index: true },

                from: { type: String, required: true, default: () => new Date().toISOString() },

                to: { type: String, required: false, default: null },

                changedByUserId: { type: Schema.Types.ObjectId, ref: "User", required: false },

                changedByUsername: { type: String, required: false, default: "" },

                reason: { type: String, required: false, default: null },
            },
            { _id: false, timestamps: false }
        );
    }

    private buildTaskRuntimeMetricsSchema(): Schema<TaskRuntimeMetrics> {
        return new Schema<TaskRuntimeMetrics>(
            {
                effortPoints: { type: Number, required: false, default: 0 },

                complexity: { type: Number, required: false, default: 1 },

                estimatedMinutes: { type: Number, required: false, default: 0 },

                actualMinutes: { type: Number, required: false, default: 0 },

                reopenedCount: { type: Number, required: false, default: 0 },

                rejectedCount: { type: Number, required: false, default: 0 },

                customerSatisfactionScore: { type: Number, required: false, default: 0 },

                supervisorQualityScore: { type: Number, required: false, default: 0 },
            },
            { _id: false, timestamps: false }
        );
    }

    private buildTaskTimingSchema(): Schema<TaskTiming> {
        return new Schema<TaskTiming>(
            {
                createdAt: { type: String, required: false, default: null },

                updatedAt: { type: String, required: false, default: null },

                firstResponseAt: { type: String, required: false, default: null },

                startedAt: { type: String, required: false, default: null },

                lastBlockedAt: { type: String, required: false, default: null },

                completedAt: { type: String, required: false, default: null },

                confirmedAt: { type: String, required: false, default: null },

                cancelledAt: { type: String, required: false, default: null },
            },
            { _id: false, timestamps: false }
        );
    }

    // ─────────────────────────────────────────────
    // AssignedTask schema (KPI-ready) — UPDATED
    // ─────────────────────────────────────────────

    private buildAssignedTaskSchema(): Schema<AssignedTask> {
        return new Schema<AssignedTask>(
            {
                id: { type: String, required: true, trim: true },

                name: { type: String, required: true, trim: true },

                description: { type: String, required: true, default: "" },

                location: { type: this.geoLocationSchema, required: false },

                address: { type: this.addressSchema, required: false },

                assignedMembers: [ { type: Schema.Types.ObjectId, ref: "User", required: false } ],

                assignedTaskCaptain: { type: Schema.Types.ObjectId, ref: "User", required: false },

                status: { type: String, enum: [ ...TASK_STATUSES ], required: false, default: "draft" },

                priority: { type: String, enum: [ ...TASK_PRIORITIES ], required: false, default: "medium" },

                plannedStartAt: { type: String, required: false, default: "" },

                plannedEndAt: { type: String, required: false, default: "" },

                timing: { type: this.taskTimingSchema, required: false, default: undefined },

                sla: { type: this.taskSlaPolicySchema, required: false, default: undefined },

                metrics: { type: this.taskRuntimeMetricsSchema, required: false, default: undefined },

                blockedWindows: { type: [ this.taskBlockedWindowSchema ], required: false, default: [] },

                assigneeHistory: { type: [ this.taskAssigneeHistoryEntrySchema ], required: false, default: [] },

                completionConfirmation: { type: this.taskCompletionConfirmationSchema, required: false, default: undefined },

                evidence: { type: [ this.taskEvidenceSchema ], required: false, default: [] },

                notes: { type: String, required: false, default: "" },

                labels: { type: [ String ], required: false, default: [] },

                audit: { type: this.taskAuditMetaSchema, required: false, default: undefined },
            },
            { _id: false, timestamps: false }
        );
    }

    // ─────────────────────────────────────────────
    // TeamMember schema
    // ─────────────────────────────────────────────

    private buildTeamMemberSchema(): Schema<TeamMember> {
        return new Schema<TeamMember>(
            {
                id: { type: Schema.Types.ObjectId, required: true, ref: "User", index: true },

                username: { type: String, required: true, trim: true, index: true },

                roleInTeam: { type: String, enum: [ ...TEAM_ROLES ], required: false, default: null },

                reason: { type: String, required: false, default: null },

                joinedAt: { type: String, required: false, default: () => new Date().toISOString() },

                domain: { type: String, required: false, default: null },

                teamName: { type: String, required: false, default: null },

                teamReason: { type: String, required: false, default: null },
            },
            { _id: false, timestamps: false }
        );
    }

    private buildTeamAuditMetaSchema(): Schema<TeamAuditMeta> {
        return new Schema<TeamAuditMeta>(
            {
                createdByUserId: { type: Schema.Types.ObjectId, ref: "User", required: false },

                createdByUsername: { type: String, required: false, default: "" },

                lastUpdatedByUserId: { type: Schema.Types.ObjectId, ref: "User", required: false },

                lastUpdatedByUsername: { type: String, required: false, default: "" },

                lastActivityAt: { type: String, required: false, default: "" },
            },
            { _id: false, timestamps: false }
        );
    }

    // ─────────────────────────────────────────────
    // Root TeamManagement schema
    // ─────────────────────────────────────────────

    private buildTeamManagementSchema(): Schema<ITeamManagement> {
        const TeamSchema: Schema<ITeamManagement> = new Schema<ITeamManagement>(
            {
                teamCode: { type: String, required: true, unique: true, trim: true, index: true },

                teamName: { type: String, unique: true, required: true, trim: true, index: true },

                orgType: { type: String, enum: [ "team", "department", "squad", "board" ], required: false, default: "team" },

                domain: { type: String, enum: [ ...TEAM_DOMAINS ], required: true, default: "other", index: true },

                description: { type: String, required: false, default: "" },

                members: { type: [ this.teamMemberSchema ], required: false, default: [] },

                captain: { type: this.teamMemberSchema, required: true },

                memberTotal: { type: Number, required: true, default: 0 },

                assignTasks: { type: [ this.assignedTaskSchema ], required: false, default: [] },

                teamLogo: { type: this.taskEvidenceSchema, required: false, default: undefined },

                createdAt: { type: String, required: true, default: () => new Date().toISOString(), index: true },

                updatedAt: { type: String, required: true, default: () => new Date().toISOString(), index: true },

                isActive: { type: Boolean, required: false, default: true, index: true },

                audit: { type: this.teamAuditMetaSchema, required: false, default: undefined },
            },
            { timestamps: false }
        );

        // Helpful indexes
        TeamSchema.index( { teamName: 1, domain: 1 } );

        TeamSchema.index( { "members.id": 1, isActive: 1 } );

        // Task id uniqueness across collection (keep your existing behavior)
        TeamSchema.index(
            { "assignTasks.id": 1 },
            {
                unique: true,
                partialFilterExpression: { "assignTasks.id": { $exists: true, $ne: null } },
            }
        );

        // KPI query helpers (embedded tasks)
        TeamSchema.index( { "assignTasks.status": 1, domain: 1 } );

        TeamSchema.index( { "assignTasks.priority": 1, domain: 1 } );

        TeamSchema.index( { "assignTasks.assignedTaskCaptain": 1 } );

        TeamSchema.index( { "assignTasks.assignedMembers": 1 } );

        // ─────────────────────────────────────────────
        // Validation: captain must exist in members
        // ─────────────────────────────────────────────
        TeamSchema.pre<ITeamManagement>( "validate", function ( next ) {
            try {
                const captainId: string = String( this.captain?.id ?? "" );

                if ( !captainId ) {
                    next( new Error( "Team captain is required." ) );
                    return;
                }

                const hasCaptainInMembers: boolean = Array.isArray( this.members )
                    ? this.members.some( ( m ) => String( m.id ) === captainId )
                    : false;

                if ( !hasCaptainInMembers ) {
                    const captainMember: TeamMember = {
                        id: this.captain.id,
                        username: this.captain.username,

                        roleInTeam: this.captain.roleInTeam ?? "captain",

                        reason: this.captain.reason ?? null,

                        joinedAt: this.captain.joinedAt ?? new Date().toISOString(),

                        domain: this.domain,

                        teamName: this.teamName,

                        teamReason: this.captain.teamReason ?? null,
                    };

                    this.members = Array.isArray( this.members ) ? this.members : [];

                    this.members.push( captainMember );
                }

                next();
                return;
            } catch ( err ) {
                next( err as Error );
                return;
            }
        } );

        // ─────────────────────────────────────────────
        // Save hook: maintain updatedAt, memberTotal, task timing defaults
        // ─────────────────────────────────────────────
        TeamSchema.pre<ITeamManagement>( "save", function ( next ) {
            try {
                const now: string = new Date().toISOString();

                this.updatedAt = now;

                this.memberTotal = Array.isArray( this.members ) ? this.members.length : 0;

                if ( !this.audit ) this.audit = {};

                this.audit.lastActivityAt = now;

                if ( Array.isArray( this.assignTasks ) ) {
                    for ( const t of this.assignTasks ) {
                        if ( !t.timing ) t.timing = {};

                        if ( !t.timing.createdAt ) t.timing.createdAt = now;

                        t.timing.updatedAt = now;

                        if ( t.status === "in_progress" && !t.timing.startedAt ) {
                            t.timing.startedAt = now;
                        }

                        if ( t.status === "blocked" ) {
                            t.timing.lastBlockedAt = now;
                        }

                        if (
                            ( t.status === "completed" || t.status === "completed_pending_confirmation" ) &&
                            !t.timing.completedAt
                        ) {
                            t.timing.completedAt = now;
                        }

                        if ( t.status === "cancelled" && !t.timing.cancelledAt ) {
                            t.timing.cancelledAt = now;
                        }

                        if ( !t.metrics ) t.metrics = {};

                        if ( typeof t.metrics.reopenedCount !== "number" ) t.metrics.reopenedCount = 0;

                        if ( typeof t.metrics.rejectedCount !== "number" ) t.metrics.rejectedCount = 0;

                        if ( !Array.isArray( t.labels ) ) t.labels = [];

                        if ( !Array.isArray( t.blockedWindows ) ) t.blockedWindows = [];

                        if ( !Array.isArray( t.assigneeHistory ) ) t.assigneeHistory = [];

                        if ( !Array.isArray( t.evidence ) ) t.evidence = [];
                    }
                }

                next();
                return;
            } catch ( err ) {
                next( err as Error );
                return;
            }
        } );

        // ─────────────────────────────────────────────
        // Active team membership limiter (your original policy)
        // ─────────────────────────────────────────────
        TeamSchema.pre<ITeamManagement>( "save", async function ( next ) {
            try {
              if ( !this.isNew && !this.isModified( "members" ) ) {
                  next();
                  return;
              }

              const uniqueMemberIds: string[] = Array.from(
              new Set( ( this.members ?? [] ).map( ( m ) => m.id.toString() ) )
          );

              const TeamModel: Model<ITeamManagement> = this.model( "TeamManagement" ) as Model<ITeamManagement>;

              for ( const memberId of uniqueMemberIds ) {
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

        return model<ITeamManagement>( "TeamManagement", schema, "teams" );
    }
}

const teamModelBuilder: TeamModelBuilder = new TeamModelBuilder();

export const TeamManagementModel: Model<ITeamManagement> = teamModelBuilder.buildModel();
