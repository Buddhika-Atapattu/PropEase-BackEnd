// Path: src/models/teamManagement/teamManagement.model.ts
// =============================================================================
// TeamManagement Model (Mongoose) — CLEAN (Tasks removed)
// -----------------------------------------------------------------------------
// ✅ Changes:
// - Removed assignTasks + all embedded task schemas/indexes/save-hooks
// - Separated all contracts into teamManagement.types.ts
// - Model now contains ONLY team/people/logo/audit concerns
// =============================================================================

import { Schema, Types, model, type Document, type Model } from "mongoose";

import {
    TEAM_DOMAINS,
    TEAM_ROLES,
    type FileMetaBase,
    type ISODateString,
    type TeamAuditMeta,
    type TeamLogoMeta,
    type TeamManagementBase,
    type TeamMember
} from "../../../types/teamManagement/teamMain/teamManagement.types";

// ─────────────────────────────────────────────
// Model contracts
// ─────────────────────────────────────────────
export interface ITeamManagement extends Omit<TeamManagementBase, '_id'>, Document {}
const MAX_ACTIVE_TEAMS_PER_USER: number = 5;

// ─────────────────────────────────────────────
// Model builder class (class-based only)
// ─────────────────────────────────────────────
class TeamModelBuilder {
    private readonly fileMetaBaseSchema: Schema<FileMetaBase>;
    private readonly teamLogoSchema: Schema<TeamLogoMeta>;

    private readonly teamMemberSchema: Schema<TeamMember>;
    private readonly teamAuditMetaSchema: Schema<TeamAuditMeta>;

    public constructor () {
        this.fileMetaBaseSchema = this.buildFileMetaBaseSchema();
        this.teamLogoSchema = this.buildTeamLogoSchema();

        this.teamMemberSchema = this.buildTeamMemberSchema();
        this.teamAuditMetaSchema = this.buildTeamAuditMetaSchema();
    }

    // ─────────────────────────────────────────────
    // Nested schemas
    // ─────────────────────────────────────────────

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

    private buildTeamLogoSchema(): Schema<TeamLogoMeta> {
        return new Schema<TeamLogoMeta>(
            {
                name: { type: String, required: true, default: "Team Logo" },

                file: { type: this.fileMetaBaseSchema, required: false },

                url: { type: String, required: false, default: "" },
                storageKey: { type: String, required: false, default: "" },

                uploadedById: { type: Schema.Types.ObjectId, ref: "User", required: false },
                uploadedByUsername: { type: String, required: false, default: "" },

                uploadedAt: { type: String, required: false, default: () => new Date().toISOString() },
            },
            { _id: false, timestamps: false }
        );
    }

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
    // Root schema
    // ─────────────────────────────────────────────

    private buildTeamManagementSchema(): Schema<ITeamManagement> {
        const TeamSchema: Schema<ITeamManagement> = new Schema<ITeamManagement>(
            {
                teamCode: { type: String, required: true, unique: true, trim: true, index: true },

                teamName: { type: String, unique: true, required: true, trim: true, index: true },

                orgType: {
                    type: String,
                    enum: [ "team", "department", "squad", "board" ],
                    required: false,
                    default: "team",
                },

                domain: { type: String, enum: [ ...TEAM_DOMAINS ], required: true, default: "other", index: true },

                description: { type: String, required: false, default: "" },

                members: { type: [ this.teamMemberSchema ], required: false, default: [] },

                captain: { type: this.teamMemberSchema, required: true },

                memberTotal: { type: Number, required: true, default: 0 },

                teamLogo: { type: this.teamLogoSchema, required: false },

                createdAt: { type: String, required: true, default: () => new Date().toISOString(), index: true },

                updatedAt: { type: String, required: true, default: () => new Date().toISOString(), index: true },

                isActive: { type: Boolean, required: false, default: true, index: true },

                audit: { type: this.teamAuditMetaSchema, required: false },
            },
            { timestamps: false }
        );

        // Helpful indexes
        TeamSchema.index( { teamName: 1, domain: 1 } );
        TeamSchema.index( { "members.id": 1, isActive: 1 } );

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
        // Save hook: maintain updatedAt, memberTotal, audit lastActivityAt
        // ─────────────────────────────────────────────
        TeamSchema.pre<ITeamManagement>( "save", function ( next ) {
            try {
                const now: ISODateString = new Date().toISOString();

                this.updatedAt = now;

                this.memberTotal = Array.isArray( this.members ) ? this.members.length : 0;

                if ( !this.audit ) this.audit = {};
                this.audit.lastActivityAt = now;

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

                const TeamModel: Model<ITeamManagement> =
                    this.model( "TeamManagement" ) as Model<ITeamManagement>;

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
