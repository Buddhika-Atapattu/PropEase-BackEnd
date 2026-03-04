// Path: src/services/teamManagemement/milestones/milestone.rest.service.ts
// ============================================================================
// Milestone REST Service (Domain Engine) — 100% CLASS-BASED
// ----------------------------------------------------------------------------
// ✅ PURPOSE
// - Implements Milestone engine (CRUD + evidence + tags)
// - Uses MilestoneModel (plan-layer collection)
// - After DB writes: emits WS events via MilestoneWsService (best-effort)
// ----------------------------------------------------------------------------
// ✅ IMPORTANT RULES (your architecture)
// - REST is source of truth for writes
// - WS emits are optional and must never break REST
// - No any
// - exactOptionalPropertyTypes safe: omit optionals (never set undefined)
// ============================================================================

import { Request } from "express";

import { Types } from "mongoose";

import { MilestoneModel } from "../../../models/teamManagement/milestones/milestone.model";

import type {
    MilestoneDto,
    MilestoneEvidence,
    MilestonePriority,
    MilestoneStatus,
} from "../../../types/teamManagement/milestones/milestone.types";

import { MilestoneWsService, type MilestoneWsContext } from "./milestone.ws.service";
import { type DomainDeletePlan, RecycleBinDomainDeleteService } from '../../../services/recyclebin/recyclebin-domain-delete.service';
import type { FileMetaPacket } from "../../../types/common";
import { FileMetaPacketBuilder } from "../../../utils/files/file-meta-packet.builder";
import type { RecycleRecordResult } from "../../recyclebin/recyclebin-engine.service";

// ----------------------------------------------------------------------------
// Filters / Paging / Inputs
// ----------------------------------------------------------------------------

export interface MilestoneListFilters {
    teamId: string;
    workItemId?: string;
    userId?: string;

    status?: MilestoneStatus;
    priority?: MilestonePriority;

    startFrom?: string; // ISO
    startTo?: string; // ISO
    q?: string; // title search (regex)
}

export interface MilestoneListPaging {
    page: number; // 1-based
    limit: number; // 1..200
}

export interface MilestoneListResult {
    items: MilestoneDto[];
    other: { total: number; };
}

export interface MilestoneCreateInput {
    workItemId: string;
    teamId: string;
    userId: string;

    createdByUserId: string;
    requestId?: string;
    source?: "rest" | "ws" | "system";

    title: string;
    notes?: string;

    startAt: string; // ISO
    endAt: string; // ISO
    allDay: boolean;
    timezone?: string;

    status: MilestoneStatus;
    priority: MilestonePriority;

    progressTarget?: number; // 0..100
    tags?: string[];
}

export interface MilestoneUpdateInput {
    title?: string;
    notes?: string;

    startAt?: string; // ISO
    endAt?: string; // ISO
    allDay?: boolean;
    timezone?: string;

    status?: MilestoneStatus;
    priority?: MilestonePriority;

    progressTarget?: number;
    tags?: string[];

    updatedByUserId: string;
}

export interface MilestoneAppendEvidenceInput {
    evidence: MilestoneEvidence[]; // mapped by controller
    updatedByUserId: string;
}

export interface MilestoneRemoveEvidenceInput {
    relPath?: string;
    url?: string;
    updatedByUserId: string;
}

export interface MilestoneReplaceEvidenceInput {
    evidence: MilestoneEvidence[];
    updatedByUserId: string;
}

export interface MilestoneAppendTagInput {
    tag: string;
    updatedByUserId: string;
}

export interface MilestoneRemoveTagInput {
    tag: string;
    updatedByUserId: string;
}

export interface MilestoneReplaceTagsInput {
    tags: string[];
    updatedByUserId: string;
}

// ----------------------------------------------------------------------------
// Service Error
// ----------------------------------------------------------------------------

export class MilestoneServiceError extends Error {
    public readonly code: string;

    public constructor ( code: string, message: string ) {
        super( message );
        this.code = code;
    }
}

// ----------------------------------------------------------------------------
// MilestoneRestService
// ----------------------------------------------------------------------------

export class MilestoneRestService {
    private readonly ws: MilestoneWsService;
    private readonly deleteSvc = new RecycleBinDomainDeleteService();

    public constructor () {
        // WS is best-effort (lazy handler inside), so it won't break REST.
        this.ws = MilestoneWsService.GetInstance();
    }

    // =========================================================================
    // GET
    // =========================================================================

    public async getById( milestoneId: string ): Promise<MilestoneDto> {
        const _id = this.toObjectId( milestoneId );

        const doc = await MilestoneModel.findById( _id ).lean().exec();
        if ( !doc ) throw new MilestoneServiceError( "MILESTONE_NOT_FOUND", "Milestone not found." );

        return doc as MilestoneDto;
    }

    public async list( filters: MilestoneListFilters, paging: MilestoneListPaging ): Promise<MilestoneListResult> {
        const query = this.buildListQuery( filters );

        const page = this.normalizePage( paging.page );
        const limit = this.normalizeLimit( paging.limit );
        const skip = ( page - 1 ) * limit;

        const [ items, total ] = await Promise.all( [
            MilestoneModel.find( query ).sort( { startAt: 1, endAt: 1 } ).skip( skip ).limit( limit ).lean().exec(),
            MilestoneModel.countDocuments( query ).exec(),
        ] );

        return {
            items: items as MilestoneDto[],
            other: { total },
        };
    }

    public async count( filters: MilestoneListFilters ): Promise<number> {
        const query = this.buildListQuery( filters );
        return MilestoneModel.countDocuments( query ).exec();
    }

    // =========================================================================
    // CREATE / UPDATE / DELETE
    // =========================================================================

    public async create( ctx: MilestoneWsContext, input: MilestoneCreateInput ): Promise<MilestoneDto> {
        const startAt = this.toDate( input.startAt );
        const endAt = this.toDate( input.endAt );

        if ( endAt.getTime() < startAt.getTime() ) {
            throw new MilestoneServiceError( "INVALID_TIME_RANGE", "endAt must be >= startAt." );
        }

        const doc = await MilestoneModel.create( {
            workItemId: this.toObjectId( input.workItemId ),
            teamId: this.toObjectId( input.teamId ),
            userId: this.toObjectId( input.userId ),

            createdByUserId: this.toObjectId( input.createdByUserId ),
            ...( input.requestId ? { requestId: input.requestId } : {} ),
            ...( input.source ? { source: input.source } : {} ),

            title: input.title,
            ...( input.notes ? { notes: input.notes } : {} ),

            startAt,
            endAt,
            allDay: input.allDay,
            ...( input.timezone ? { timezone: input.timezone } : {} ),

            status: input.status,
            priority: input.priority,

            ...( typeof input.progressTarget === "number" ? { progressTarget: this.normalizeProgress( input.progressTarget ) } : {} ),
            ...( input.tags && input.tags.length > 0 ? { tags: this.uniqueTags( input.tags ) } : {} ),
        } );

        const dto = doc.toObject() as MilestoneDto;

        // WS emits (best-effort)
        this.ws.emitMilestoneCreated(
            this.buildEmitCtx( ctx, {
                ...( ctx.teamCode ? { teamCode: ctx.teamCode } : {} ),
                workItemId: input.workItemId,
                milestoneId: doc._id.toString(),
                memberUserIds: [ input.userId ],
            } ),
            dto
        );

        return dto;
    }

    public async updateById( ctx: MilestoneWsContext, milestoneId: string, input: MilestoneUpdateInput ): Promise<MilestoneDto> {
        const _id = this.toObjectId( milestoneId );

        const updateDoc = this.buildUpdateDoc( input );

        const updated = await MilestoneModel.findByIdAndUpdate( _id, updateDoc, { new: true } ).lean().exec();
        if ( !updated ) throw new MilestoneServiceError( "MILESTONE_NOT_FOUND", "Milestone not found." );

        const dto = updated as MilestoneDto;

        // Prefer routing info from ctx, otherwise infer from dto
        const workItemId = ctx.workItemId ?? this.extractWorkItemIdFromDto( dto );
        const teamIdStr = this.extractTeamIdFromDto( dto );
        const userIdStr = this.extractUserIdFromDto( dto );

        this.ws.emitMilestoneUpdated(
            this.buildEmitCtx( ctx, {
                teamCode: ctx.teamCode ?? teamIdStr, // NOTE: if you use teamCode != teamId, controller should pass teamCode.
                workItemId,
                milestoneId,
                memberUserIds: ctx.memberUserIds && ctx.memberUserIds.length > 0 ? ctx.memberUserIds : [ userIdStr ],
            } ),
            dto
        );

        return dto;
    }

    public async deleteById( ctx: MilestoneWsContext, milestoneId: string, req: Request ): Promise<{
        entry: RecycleRecordResult;
    }> {
        const _id = this.toObjectId( milestoneId );

        const existing = await MilestoneModel.findById( _id ).lean<MilestoneDto>().exec();
        if ( !existing ) throw new MilestoneServiceError( "MILESTONE_NOT_FOUND", "Milestone not found." );

        const files = await this.buildRecycleFilesFromMilestoneAsync( existing );

        const plan: DomainDeletePlan<MilestoneDto> = {
            sourceKey: "Milestone",
            refId: String( ( existing as unknown as { _id: unknown; } )._id ),
            label: this.buildRecycleLabel( existing ),
            collectionName: MilestoneModel.collection.name,
            ...( this.buildRecycleDescription( existing ) ? { description: this.buildRecycleDescription( existing ) } : {} ),

            // ✅ FIX: snapshotData expects Record<string, unknown>
            snapshotData: existing as unknown as Record<string, unknown>,

            files,
            deleteDbRecord: async (): Promise<void> => {
                const res = await MilestoneModel.deleteOne( { _id } ).exec();
                if ( !res.deletedCount || res.deletedCount < 1 ) {
                    throw new MilestoneServiceError( "MILESTONE_DELETE_FAILED", "Milestone delete failed." );
                }
            },
        };

        // ✅ Call ONCE (durability-first)
        const deleted = await this.deleteSvc.deleteWithRecycleBin( ctx.actor, plan, req );

        // WS emit (best-effort; must not break REST)
        try {
            const dto = existing;

            const workItemId = ctx.workItemId ?? this.extractWorkItemIdFromDto( dto );
            const teamIdStr = this.extractTeamIdFromDto( dto );
            const userIdStr = this.extractUserIdFromDto( dto );

            this.ws.emitMilestoneDeleted(
                this.buildEmitCtx( ctx, {
                    teamCode: ctx.teamCode ?? teamIdStr,
                    workItemId,
                    milestoneId,
                    memberUserIds:
                        ctx.memberUserIds && ctx.memberUserIds.length > 0
                            ? ctx.memberUserIds
                            : [ userIdStr ],
                } ),
                milestoneId
            );
        } catch ( err: unknown ) {
            const msg = err instanceof Error ? err.message : "Unknown error";
            // eslint-disable-next-line no-console
            console.warn( `[Warning:] [MilestoneRestService] WS emitMilestoneDeleted failed: ${ msg }\n` );
        }

        return deleted;
    }

    // =========================================================================
    // Evidence operations
    // =========================================================================

    public async appendEvidence( ctx: MilestoneWsContext, milestoneId: string, input: MilestoneAppendEvidenceInput ): Promise<MilestoneDto> {
        this.assertNonEmptyArray( input.evidence, "evidence" );

        const _id = this.toObjectId( milestoneId );

        const updated = await MilestoneModel.findByIdAndUpdate(
            _id,
            {
                $push: { evidence: { $each: input.evidence } },
                $currentDate: { updatedAt: true },
            },
            { new: true }
        )
            .lean()
            .exec();

        if ( !updated ) throw new MilestoneServiceError( "MILESTONE_NOT_FOUND", "Milestone not found." );

        const dto = updated as MilestoneDto;

        this.ws.emitEvidenceAppended(
            this.buildEmitCtx( ctx, {
                milestoneId,
                workItemId: ctx.workItemId ?? this.extractWorkItemIdFromDto( dto ),
                teamCode: ctx.teamCode ?? this.extractTeamIdFromDto( dto ),
                memberUserIds: this.pickMemberUserIds( ctx, dto ),
            } ),
            milestoneId,
            dto
        );

        return dto;
    }

    public async removeEvidence( ctx: MilestoneWsContext, milestoneId: string, input: MilestoneRemoveEvidenceInput ): Promise<MilestoneDto> {
        if ( !input.relPath && !input.url ) {
            throw new MilestoneServiceError( "VALIDATION_ERROR", "relPath or url is required." );
        }

        const _id = this.toObjectId( milestoneId );

        const pull: Record<string, unknown> = {};
        if ( input.relPath ) pull.relPath = input.relPath;
        if ( input.url ) pull.url = input.url;

        const updated = await MilestoneModel.findByIdAndUpdate(
            _id,
            {
                $pull: { evidence: pull },
                $currentDate: { updatedAt: true },
            },
            { new: true }
        )
            .lean()
            .exec();

        if ( !updated ) throw new MilestoneServiceError( "MILESTONE_NOT_FOUND", "Milestone not found." );

        const dto = updated as MilestoneDto;

        this.ws.emitEvidenceRemoved(
            this.buildEmitCtx( ctx, {
                milestoneId,
                workItemId: ctx.workItemId ?? this.extractWorkItemIdFromDto( dto ),
                teamCode: ctx.teamCode ?? this.extractTeamIdFromDto( dto ),
                memberUserIds: this.pickMemberUserIds( ctx, dto ),
            } ),
            milestoneId,
            dto
        );

        return dto;
    }

    public async replaceEvidence( ctx: MilestoneWsContext, milestoneId: string, input: MilestoneReplaceEvidenceInput ): Promise<MilestoneDto> {
        const _id = this.toObjectId( milestoneId );

        const updated = await MilestoneModel.findByIdAndUpdate(
            _id,
            {
                $set: { evidence: input.evidence },
                $currentDate: { updatedAt: true },
            },
            { new: true }
        )
            .lean()
            .exec();

        if ( !updated ) throw new MilestoneServiceError( "MILESTONE_NOT_FOUND", "Milestone not found." );

        const dto = updated as MilestoneDto;

        this.ws.emitEvidenceReplaced(
            this.buildEmitCtx( ctx, {
                milestoneId,
                workItemId: ctx.workItemId ?? this.extractWorkItemIdFromDto( dto ),
                teamCode: ctx.teamCode ?? this.extractTeamIdFromDto( dto ),
                memberUserIds: this.pickMemberUserIds( ctx, dto ),
            } ),
            milestoneId,
            dto
        );

        return dto;
    }

    // =========================================================================
    // Tags operations
    // =========================================================================

    public async appendTag( ctx: MilestoneWsContext, milestoneId: string, input: MilestoneAppendTagInput ): Promise<MilestoneDto> {
        const tag = input.tag.trim();
        if ( tag.length === 0 ) throw new MilestoneServiceError( "VALIDATION_ERROR", "tag is required." );

        const _id = this.toObjectId( milestoneId );

        const updated = await MilestoneModel.findByIdAndUpdate(
            _id,
            {
                $addToSet: { tags: tag },
                $currentDate: { updatedAt: true },
            },
            { new: true }
        )
            .lean()
            .exec();

        if ( !updated ) throw new MilestoneServiceError( "MILESTONE_NOT_FOUND", "Milestone not found." );

        const dto = updated as MilestoneDto;

        this.ws.emitTagAppended(
            this.buildEmitCtx( ctx, {
                milestoneId,
                workItemId: ctx.workItemId ?? this.extractWorkItemIdFromDto( dto ),
                teamCode: ctx.teamCode ?? this.extractTeamIdFromDto( dto ),
                memberUserIds: this.pickMemberUserIds( ctx, dto ),
            } ),
            milestoneId,
            dto
        );

        return dto;
    }

    public async removeTag( ctx: MilestoneWsContext, milestoneId: string, input: MilestoneRemoveTagInput ): Promise<MilestoneDto> {
        const tag = input.tag.trim();
        if ( tag.length === 0 ) throw new MilestoneServiceError( "VALIDATION_ERROR", "tag is required." );

        const _id = this.toObjectId( milestoneId );

        const updated = await MilestoneModel.findByIdAndUpdate(
            _id,
            {
                $pull: { tags: tag },
                $currentDate: { updatedAt: true },
            },
            { new: true }
        )
            .lean()
            .exec();

        if ( !updated ) throw new MilestoneServiceError( "MILESTONE_NOT_FOUND", "Milestone not found." );

        const dto = updated as MilestoneDto;

        this.ws.emitTagRemoved(
            this.buildEmitCtx( ctx, {
                milestoneId,
                workItemId: ctx.workItemId ?? this.extractWorkItemIdFromDto( dto ),
                teamCode: ctx.teamCode ?? this.extractTeamIdFromDto( dto ),
                memberUserIds: this.pickMemberUserIds( ctx, dto ),
            } ),
            milestoneId,
            dto
        );

        return dto;
    }

    public async replaceTags( ctx: MilestoneWsContext, milestoneId: string, input: MilestoneReplaceTagsInput ): Promise<MilestoneDto> {
        const _id = this.toObjectId( milestoneId );

        const tags = input.tags && input.tags.length > 0 ? this.uniqueTags( input.tags ) : [];

        const updated = await MilestoneModel.findByIdAndUpdate(
            _id,
            {
                $set: { tags },
                $currentDate: { updatedAt: true },
            },
            { new: true }
        )
            .lean()
            .exec();

        if ( !updated ) throw new MilestoneServiceError( "MILESTONE_NOT_FOUND", "Milestone not found." );

        const dto = updated as MilestoneDto;

        this.ws.emitTagsReplaced(
            this.buildEmitCtx( ctx, {
                milestoneId,
                workItemId: ctx.workItemId ?? this.extractWorkItemIdFromDto( dto ),
                teamCode: ctx.teamCode ?? this.extractTeamIdFromDto( dto ),
                memberUserIds: this.pickMemberUserIds( ctx, dto ),
            } ),
            milestoneId,
            dto
        );

        return dto;
    }

    // =========================================================================
    // Private helpers (class methods only)
    // =========================================================================

    private buildListQuery( filters: MilestoneListFilters ): Record<string, unknown> {
        const q: Record<string, unknown> = {
            teamId: this.toObjectId( filters.teamId ),
        };

        if ( filters.workItemId ) q.workItemId = this.toObjectId( filters.workItemId );
        if ( filters.userId ) q.userId = this.toObjectId( filters.userId );

        if ( filters.status ) q.status = filters.status;
        if ( filters.priority ) q.priority = filters.priority;

        if ( filters.startFrom || filters.startTo ) {
            const range: Record<string, unknown> = {};
            if ( filters.startFrom ) range.$gte = this.toDate( filters.startFrom );
            if ( filters.startTo ) range.$lte = this.toDate( filters.startTo );
            q.startAt = range;
        }

        if ( filters.q && filters.q.trim().length > 0 ) {
            q.title = { $regex: this.escapeRegex( filters.q.trim() ), $options: "i" };
        }

        return q;
    }

    private buildUpdateDoc( input: MilestoneUpdateInput ): Record<string, unknown> {
        const $set: Record<string, unknown> = {
            updatedByUserId: this.toObjectId( input.updatedByUserId ),
        };

        if ( typeof input.title === "string" ) $set.title = input.title;
        if ( typeof input.notes === "string" ) $set.notes = input.notes;

        if ( input.startAt ) $set.startAt = this.toDate( input.startAt );
        if ( input.endAt ) $set.endAt = this.toDate( input.endAt );

        if ( typeof input.allDay === "boolean" ) $set.allDay = input.allDay;
        if ( typeof input.timezone === "string" ) $set.timezone = input.timezone;

        if ( input.status ) $set.status = input.status;
        if ( input.priority ) $set.priority = input.priority;

        if ( typeof input.progressTarget === "number" ) $set.progressTarget = this.normalizeProgress( input.progressTarget );

        if ( input.tags ) $set.tags = input.tags.length > 0 ? this.uniqueTags( input.tags ) : [];

        return { $set, $currentDate: { updatedAt: true } };
    }

    private pickMemberUserIds( ctx: MilestoneWsContext, dto: MilestoneDto ): string[] {
        if ( ctx.memberUserIds && ctx.memberUserIds.length > 0 ) return ctx.memberUserIds;
        return [ this.extractUserIdFromDto( dto ) ];
    }

    private buildEmitCtx(
        ctx: MilestoneWsContext,
        patch: {
            teamCode?: string;
            workItemId?: string;
            milestoneId?: string;
            memberUserIds?: string[];
        }
    ): MilestoneWsContext {
        // exactOptionalPropertyTypes safe: include optionals only when present & non-empty
        return {
            actor: ctx.actor,
            requestId: ctx.requestId,
            ...( patch.teamCode ? { teamCode: patch.teamCode } : ctx.teamCode ? { teamCode: ctx.teamCode } : {} ),
            ...( patch.workItemId ? { workItemId: patch.workItemId } : ctx.workItemId ? { workItemId: ctx.workItemId } : {} ),
            ...( patch.milestoneId ? { milestoneId: patch.milestoneId } : ctx.milestoneId ? { milestoneId: ctx.milestoneId } : {} ),
            ...( patch.memberUserIds && patch.memberUserIds.length > 0
                ? { memberUserIds: patch.memberUserIds }
                : ctx.memberUserIds && ctx.memberUserIds.length > 0
                    ? { memberUserIds: ctx.memberUserIds }
                    : {} ),
        };
    }

    // ----------------------------------------------------------------------------
    // ID extractors (robust against ObjectId/string/objectId-like)
    // ----------------------------------------------------------------------------

    private extractTeamIdFromDto( dto: MilestoneDto ): string {
        const rawUnknown: unknown = ( dto as unknown as { teamId?: unknown; } ).teamId;

        if ( typeof rawUnknown === "string" ) {
            if ( !Types.ObjectId.isValid( rawUnknown ) ) throw new MilestoneServiceError( "INVALID_DTO_ID", "MilestoneDto.teamId invalid." );
            return rawUnknown;
        }

        if ( rawUnknown instanceof Types.ObjectId ) {
            const asString = rawUnknown.toString();
            if ( !Types.ObjectId.isValid( asString ) ) throw new MilestoneServiceError( "INVALID_DTO_ID", "MilestoneDto.teamId invalid." );
            return asString;
        }

        if ( rawUnknown && typeof rawUnknown === "object" && "toString" in rawUnknown ) {
            const asString = String( ( rawUnknown as { toString: () => string; } ).toString() );
            if ( !Types.ObjectId.isValid( asString ) ) throw new MilestoneServiceError( "INVALID_DTO_ID", "MilestoneDto.teamId invalid." );
            return asString;
        }

        throw new MilestoneServiceError( "DTO_MISSING_ID", "MilestoneDto.teamId missing." );
    }

    private extractWorkItemIdFromDto( dto: MilestoneDto ): string {
        const rawUnknown: unknown = ( dto as unknown as { workItemId?: unknown; } ).workItemId;

        if ( typeof rawUnknown === "string" ) {
            if ( !Types.ObjectId.isValid( rawUnknown ) ) throw new MilestoneServiceError( "INVALID_DTO_ID", "MilestoneDto.workItemId invalid." );
            return rawUnknown;
        }

        if ( rawUnknown instanceof Types.ObjectId ) {
            const asString = rawUnknown.toString();
            if ( !Types.ObjectId.isValid( asString ) ) throw new MilestoneServiceError( "INVALID_DTO_ID", "MilestoneDto.workItemId invalid." );
            return asString;
        }

        if ( rawUnknown && typeof rawUnknown === "object" && "toString" in rawUnknown ) {
            const asString = String( ( rawUnknown as { toString: () => string; } ).toString() );
            if ( !Types.ObjectId.isValid( asString ) ) throw new MilestoneServiceError( "INVALID_DTO_ID", "MilestoneDto.workItemId invalid." );
            return asString;
        }

        throw new MilestoneServiceError( "DTO_MISSING_ID", "MilestoneDto.workItemId missing." );
    }

    private extractUserIdFromDto( dto: MilestoneDto ): string {
        const rawUnknown: unknown = ( dto as unknown as { userId?: unknown; } ).userId;

        if ( typeof rawUnknown === "string" ) {
            if ( !Types.ObjectId.isValid( rawUnknown ) ) throw new MilestoneServiceError( "INVALID_DTO_ID", "MilestoneDto.userId invalid." );
            return rawUnknown;
        }

        if ( rawUnknown instanceof Types.ObjectId ) {
            const asString = rawUnknown.toString();
            if ( !Types.ObjectId.isValid( asString ) ) throw new MilestoneServiceError( "INVALID_DTO_ID", "MilestoneDto.userId invalid." );
            return asString;
        }

        if ( rawUnknown && typeof rawUnknown === "object" && "toString" in rawUnknown ) {
            const asString = String( ( rawUnknown as { toString: () => string; } ).toString() );
            if ( !Types.ObjectId.isValid( asString ) ) throw new MilestoneServiceError( "INVALID_DTO_ID", "MilestoneDto.userId invalid." );
            return asString;
        }

        throw new MilestoneServiceError( "DTO_MISSING_ID", "MilestoneDto.userId missing." );
    }

    // ----------------------------------------------------------------------------
    // Core utilities
    // ----------------------------------------------------------------------------

    private toObjectId( id: string ): Types.ObjectId {
        if ( !Types.ObjectId.isValid( id ) ) throw new MilestoneServiceError( "INVALID_OBJECT_ID", `Invalid ObjectId: ${ id }` );
        return new Types.ObjectId( id );
    }

    private toDate( iso: string ): Date {
        const d = new Date( iso );
        if ( Number.isNaN( d.getTime() ) ) throw new MilestoneServiceError( "INVALID_DATE", `Invalid date: ${ iso }` );
        return d;
    }

    private normalizePage( page: number ): number {
        if ( !Number.isFinite( page ) || page < 1 ) return 1;
        return Math.floor( page );
    }

    private normalizeLimit( limit: number ): number {
        if ( !Number.isFinite( limit ) || limit < 1 ) return 20;
        if ( limit > 200 ) return 200;
        return Math.floor( limit );
    }

    private normalizeProgress( p: number ): number {
        if ( !Number.isFinite( p ) ) return 0;
        if ( p < 0 ) return 0;
        if ( p > 100 ) return 100;
        return Math.round( p );
    }

    private assertNonEmptyArray( arr: unknown, field: string ): void {
        if ( !Array.isArray( arr ) || arr.length === 0 ) {
            throw new MilestoneServiceError( "VALIDATION_ERROR", `${ field } must contain at least one item.` );
        }
    }

    private escapeRegex( input: string ): string {
        return input.replace( /[.*+?^${}()|[\]\\]/g, "\\$&" );
    }

    private uniqueTags( tags: string[] ): string[] {
        const cleaned = tags.map( ( t ) => t.trim() ).filter( ( t ) => t.length > 0 );
        return Array.from( new Set( cleaned ) );
    }

    private buildRecycleLabel( dto: MilestoneDto ): string {
        const title = this.safeString( ( dto as unknown as { title?: unknown; } ).title );
        if ( title ) return `Milestone: ${ title }`;
        return "Milestone";
    }

    private buildRecycleDescription( dto: MilestoneDto ): string {
        const notes = this.safeString( ( dto as unknown as { notes?: unknown; } ).notes );
        return notes;
    }

    /**
 * Convert milestone evidence into FileMetaPacket[] for recyclebin mirror move.
 *
 * WHY:
 * - RecycleBin engine expects FileMetaPacket[] (full file metadata)
 * - Evidence usually stores only relativePath/publicUrl, so we rebuild packets from disk
 *
 * IMPORTANT (PropEase rule):
 * - relativePath must be under "public/" and must NOT start with "/"
 */
    private async buildRecycleFilesFromMilestoneAsync( dto: MilestoneDto ): Promise<FileMetaPacket[]> {
        const evidenceUnknown: unknown = ( dto as unknown as { evidence?: unknown; } ).evidence;

        if ( !Array.isArray( evidenceUnknown ) || evidenceUnknown.length === 0 ) return [];

        const packets: FileMetaPacket[] = [];

        for ( const ev of evidenceUnknown ) {
            if ( !ev || typeof ev !== "object" ) continue;

            // Support both naming styles:
            // - new style: relativePath/publicUrl
            // - older style: relPath/url
            const relativePath =
                this.safeString( ( ev as Record<string, unknown> )[ "relativePath" ] ) ||
                this.safeString( ( ev as Record<string, unknown> )[ "relPath" ] );

            // If we don't have a public-relative disk path, we can't move it safely.
            if ( !relativePath ) continue;

            // Normalize (PropEase: must be "public/..." with no leading "/")
            const normalized = this.normalizePublicRelativePath( relativePath );
            if ( !normalized ) continue;

            // Build a proper FileMetaPacket by scanning the file on disk.
            // This guarantees required fields: sizeBytes, absDiskPath, mimeType, etc.
            try {
                const pkt = await FileMetaPacketBuilder.fromExistingPublicRelativePath( normalized, {
                    // Optional context: recyclebin may need this; keep stable.
                    fieldName: "evidence",
                } );

                packets.push( pkt );
            } catch ( err: unknown ) {
                const msg = err instanceof Error ? err.message : "Unknown error";
                // eslint-disable-next-line no-console
                console.warn(
                    `[Warning:] [MilestoneRestService] buildRecycleFilesFromMilestoneAsync skipped missing/invalid file: ${ msg }\n`
                );
            }
        }

        return packets;
    }



    /**
     * Enforce PropEase disk path rule:
     * - Must start with "public/"
     * - Must not start with "/"
     */
    private normalizePublicRelativePath( input: string ): string {
        const s = this.safeString( input );

        if ( !s ) return "";

        // Remove leading slash if some caller accidentally stored "/public/..."
        const withoutLeadingSlash = s.startsWith( "/" ) ? s.slice( 1 ) : s;

        // Must be under public/
        if ( !withoutLeadingSlash.startsWith( "public/" ) ) return "";

        return withoutLeadingSlash;
    }

    private safeString( v: unknown ): string {
        if ( typeof v === "string" ) return v.trim();
        if ( typeof v === "number" ) return String( v );
        return "";
    }
}
