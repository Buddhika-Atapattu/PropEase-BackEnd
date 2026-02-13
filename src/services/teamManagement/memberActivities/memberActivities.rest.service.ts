// Path: src/services/teamManagement/memberActivities/memberActivities.rest.service.ts
// ============================================================================
// MemberActivities REST Service (Domain Engine) — 100% CLASS-BASED
// ----------------------------------------------------------------------------
// ✅ PURPOSE
// - Implements MemberActivity engine (CRUD + evidence + blockers)
// - Uses MemberActivityModel (heavy calendar/timeline collection)
// - After DB writes: emits WS events via MemberActivitiesWsService (best-effort)
// ----------------------------------------------------------------------------
// ✅ IMPORTANT RULES (your architecture)
// - REST is source of truth for writes
// - WS emits are optional and must never break REST
// - No any
// - exactOptionalPropertyTypes safe: omit optionals (never set undefined)
// ============================================================================

import { Types } from "mongoose";

import { MemberActivityModel } from "../../../models/teamManagement/memberActivities/memberActivity.model";

import type {
    MemberActivityDto,
    MemberActivityEvidence,
    MemberActivityBlocker,
    MemberActivityStatus,
    MemberActivityType,
} from "../../../types/teamManagement/memberActivities/memberActivities.types";

import { MemberActivitiesWsService, type MemberActivityWsContext } from "./memberActivities.ws.service";

// ----------------------------------------------------------------------------
// Filters / Paging / Inputs
// ----------------------------------------------------------------------------

export interface MemberActivityListFilters {
    teamId: string;
    workItemId?: string;
    userId?: string;

    type?: MemberActivityType;
    status?: MemberActivityStatus;

    startFrom?: string; // ISO
    startTo?: string;   // ISO
    q?: string;         // title search (regex)
}

export interface MemberActivityListPaging {
    page: number;   // 1-based
    limit: number;  // 1..200
}

export interface MemberActivityListResult {
    items: MemberActivityDto[];
    other: { total: number; };
}

export interface MemberActivityCreateInput {
    workItemId: string;
    teamId: string;
    userId: string;

    createdByUserId: string;

    requestId?: string;
    source?: "rest" | "ws" | "system";

    type: MemberActivityType;

    title: string;
    notes?: string;

    startAt: string; // ISO
    endAt: string;   // ISO
    allDay: boolean;
    timezone?: string;

    status: MemberActivityStatus;

    progressBefore?: number;
    progressAfter?: number;

    milestoneId?: string;
}

export interface MemberActivityUpdateInput {
    // Editable event fields
    type?: MemberActivityType;

    title?: string;
    notes?: string;

    startAt?: string; // ISO
    endAt?: string;   // ISO
    allDay?: boolean;
    timezone?: string;

    status?: MemberActivityStatus;

    progressBefore?: number;
    progressAfter?: number;

    milestoneId?: string;

    // Audit
    updatedByUserId: string; // used for access checks (captain/admin scenarios)
}

export interface MemberActivityAppendEvidenceInput {
    evidence: MemberActivityEvidence[]; // already mapped by controller (FileUploader packet -> DTO packet)
    updatedByUserId: string;
}

export interface MemberActivityRemoveEvidenceInput {
    // remove by relPath (stable) or by url (fallback)
    relPath?: string;
    url?: string;
    updatedByUserId: string;
}

export interface MemberActivityReplaceEvidenceInput {
    // replace entire evidence array
    evidence: MemberActivityEvidence[];
    updatedByUserId: string;
}

export interface MemberActivityAppendBlockerInput {
    blocker: MemberActivityBlocker;
    updatedByUserId: string;
}

export interface MemberActivityUpdateBlockerInput {
    // We identify blocker by title+reportedAt in this phase (simple)
    // Industrial-grade later: give blocker an explicit blockerId.
    title: string;
    reportedAtIso: string;

    patch: {
        title?: string;
        details?: string;
        severity?: "low" | "medium" | "high";
        resolvedAtIso?: string;
    };

    updatedByUserId: string;
}

export interface MemberActivityResolveBlockerInput {
    title: string;
    reportedAtIso: string;
    resolvedAtIso?: string;
    updatedByUserId: string;
}

export interface MemberActivityRemoveBlockerInput {
    title: string;
    reportedAtIso: string;
    updatedByUserId: string;
}

// ----------------------------------------------------------------------------
// Service Error
// ----------------------------------------------------------------------------

export class MemberActivitiesServiceError extends Error {
    public readonly code: string;

    public constructor ( code: string, message: string ) {
        super( message );
        this.code = code;
    }
}

// ----------------------------------------------------------------------------
// MemberActivitiesRestService
// ----------------------------------------------------------------------------

export class MemberActivitiesRestService {
    private readonly ws: MemberActivitiesWsService;

    public constructor () {
        this.ws = MemberActivitiesWsService.GetInstance();
    }

    // =========================================================================
    // GET
    // =========================================================================

    public async getById( activityId: string ): Promise<MemberActivityDto> {
        const _id = this.toObjectId( activityId );

        const doc = await MemberActivityModel.findById( _id ).lean().exec();
        if ( !doc ) throw new MemberActivitiesServiceError( "ACTIVITY_NOT_FOUND", "MemberActivity not found." );

        return doc as MemberActivityDto;
    }

    public async list( filters: MemberActivityListFilters, paging: MemberActivityListPaging ): Promise<MemberActivityListResult> {
        const query = this.buildListQuery( filters );

        const page = this.normalizePage( paging.page );
        const limit = this.normalizeLimit( paging.limit );
        const skip = ( page - 1 ) * limit;

        const [ items, total ] = await Promise.all( [
            MemberActivityModel.find( query ).sort( { startAt: 1, endAt: 1 } ).skip( skip ).limit( limit ).lean().exec(),
            MemberActivityModel.countDocuments( query ).exec(),
        ] );

        return {
            items: items as MemberActivityDto[],
            other: { total },
        };
    }

    public async count( filters: MemberActivityListFilters ): Promise<number> {
        const query = this.buildListQuery( filters );
        return MemberActivityModel.countDocuments( query ).exec();
    }

    // =========================================================================
    // CREATE / UPDATE / DELETE
    // =========================================================================

    public async create( ctx: MemberActivityWsContext, input: MemberActivityCreateInput ): Promise<MemberActivityDto> {
        // Basic date validity (schema hook also checks, but we validate early)
        const startAt = this.toDate( input.startAt );
        const endAt = this.toDate( input.endAt );
        if ( endAt.getTime() < startAt.getTime() ) {
            throw new MemberActivitiesServiceError( "INVALID_TIME_RANGE", "endAt must be >= startAt." );
        }

        const doc = await MemberActivityModel.create( {
            workItemId: this.toObjectId( input.workItemId ),
            teamId: this.toObjectId( input.teamId ),
            userId: this.toObjectId( input.userId ),

            createdByUserId: this.toObjectId( input.createdByUserId ),

            ...( input.requestId ? { requestId: input.requestId } : {} ),
            ...( input.source ? { source: input.source } : {} ),

            type: input.type,

            title: input.title,
            ...( input.notes ? { notes: input.notes } : {} ),

            startAt,
            endAt,
            allDay: input.allDay,
            ...( input.timezone ? { timezone: input.timezone } : {} ),

            status: input.status,

            ...( typeof input.progressBefore === "number" ? { progressBefore: this.normalizeProgress( input.progressBefore ) } : {} ),
            ...( typeof input.progressAfter === "number" ? { progressAfter: this.normalizeProgress( input.progressAfter ) } : {} ),

            ...( input.milestoneId ? { milestoneId: input.milestoneId } : {} ),
        } );

        const dto = doc.toObject() as MemberActivityDto;

        const teamCode = ctx.teamCode;
        if ( !teamCode ) {
            // no WS emit, but REST is fine
            return dto;
        }

        // WS emit (best-effort)
        this.ws.emitActivityCreated(
            this.buildEmitCtx( ctx, {
                teamCode,
                workItemId: input.workItemId,
                activityId: doc._id.toString(),
                memberUserIds: [ input.userId ],
            } ),
            dto
        );

        return dto;
    }

    public async updateById(
        ctx: MemberActivityWsContext,
        activityId: string,
        input: MemberActivityUpdateInput
    ): Promise<MemberActivityDto> {
        const _id = this.toObjectId( activityId );

        const updateDoc = this.buildUpdateDoc( input );

        const updated = await MemberActivityModel.findByIdAndUpdate( _id, updateDoc, { new: true } ).lean().exec();
        if ( !updated ) throw new MemberActivitiesServiceError( "ACTIVITY_NOT_FOUND", "MemberActivity not found." );

        const dto = updated as MemberActivityDto;

        const teamCode = ctx.teamCode;
        if ( !teamCode ) return dto;

        // Prefer ctx.workItemId; if absent, extract from DB dto (safe)
        const workItemId = ctx.workItemId ?? this.extractWorkItemIdFromDto( dto );

        this.ws.emitActivityUpdated(
            this.buildEmitCtx( ctx, {
                teamCode,
                workItemId,
                activityId,
                ...( ctx.memberUserIds && ctx.memberUserIds.length > 0 ? { memberUserIds: ctx.memberUserIds } : {} ),
            } ),
            dto
        );

        return dto;
    }


    public async deleteById( ctx: MemberActivityWsContext, activityId: string ): Promise<void> {
        const _id = this.toObjectId( activityId );

        const existing = await MemberActivityModel.findById( _id ).lean().exec();
        if ( !existing ) throw new MemberActivitiesServiceError( "ACTIVITY_NOT_FOUND", "MemberActivity not found." );

        await MemberActivityModel.deleteOne( { _id } ).exec();

        // Extract ids from existing (DB object)
        const workItemId = this.extractWorkItemIdFromDto( existing as MemberActivityDto );
        const teamId = this.extractTeamIdFromDto( existing as MemberActivityDto );
        const userId = this.extractUserIdFromDto( existing as MemberActivityDto ); // add method below

        // Only emit if we have a teamCode (room routing)
        if ( !ctx.teamCode ) return;

        this.ws.emitActivityDeleted(
            this.buildEmitCtx( ctx, {
                teamCode: ctx.teamCode,
                workItemId,
                activityId,
                memberUserIds: [ userId ],
            } ),
            activityId
        );
    }


    // =========================================================================
    // Evidence operations
    // =========================================================================

    public async appendEvidence( ctx: MemberActivityWsContext, activityId: string, input: MemberActivityAppendEvidenceInput ): Promise<MemberActivityDto> {
        this.assertNonEmptyArray( input.evidence, "evidence" );

        const _id = this.toObjectId( activityId );

        const updated = await MemberActivityModel.findByIdAndUpdate(
            _id,
            {
                $push: { evidence: { $each: input.evidence } },
                $set: { updatedAt: new Date() },
            },
            { new: true }
        ).lean().exec();

        if ( !updated ) throw new MemberActivitiesServiceError( "ACTIVITY_NOT_FOUND", "MemberActivity not found." );

        const dto = updated as MemberActivityDto;

        this.ws.emitEvidenceAppended(
            this.buildEmitCtx( ctx, { activityId } ),
            activityId,
            dto
        );

        return dto;
    }

    public async removeEvidence( ctx: MemberActivityWsContext, activityId: string, input: MemberActivityRemoveEvidenceInput ): Promise<MemberActivityDto> {
        if ( !input.relPath && !input.url ) {
            throw new MemberActivitiesServiceError( "VALIDATION_ERROR", "relPath or url is required." );
        }

        const _id = this.toObjectId( activityId );

        const pull: Record<string, unknown> = {};
        if ( input.relPath ) pull.relPath = input.relPath;
        if ( input.url ) pull.url = input.url;

        const updated = await MemberActivityModel.findByIdAndUpdate(
            _id,
            { $pull: { evidence: pull }, $set: { updatedAt: new Date() } },
            { new: true }
        ).lean().exec();

        if ( !updated ) throw new MemberActivitiesServiceError( "ACTIVITY_NOT_FOUND", "MemberActivity not found." );

        const dto = updated as MemberActivityDto;

        this.ws.emitEvidenceRemoved(
            this.buildEmitCtx( ctx, { activityId } ),
            activityId,
            dto
        );

        return dto;
    }

    public async replaceEvidence( ctx: MemberActivityWsContext, activityId: string, input: MemberActivityReplaceEvidenceInput ): Promise<MemberActivityDto> {
        const _id = this.toObjectId( activityId );

        const updated = await MemberActivityModel.findByIdAndUpdate(
            _id,
            { $set: { evidence: input.evidence, updatedAt: new Date() } },
            { new: true }
        ).lean().exec();

        if ( !updated ) throw new MemberActivitiesServiceError( "ACTIVITY_NOT_FOUND", "MemberActivity not found." );

        const dto = updated as MemberActivityDto;

        this.ws.emitEvidenceReplaced(
            this.buildEmitCtx( ctx, { activityId } ),
            activityId,
            dto
        );

        return dto;
    }

    // =========================================================================
    // Blocker operations
    // =========================================================================

    public async appendBlocker( ctx: MemberActivityWsContext, activityId: string, input: MemberActivityAppendBlockerInput ): Promise<MemberActivityDto> {
        const _id = this.toObjectId( activityId );

        const updated = await MemberActivityModel.findByIdAndUpdate(
            _id,
            { $push: { blockers: input.blocker }, $set: { updatedAt: new Date() } },
            { new: true }
        ).lean().exec();

        if ( !updated ) throw new MemberActivitiesServiceError( "ACTIVITY_NOT_FOUND", "MemberActivity not found." );

        const dto = updated as MemberActivityDto;

        this.ws.emitBlockerAppended(
            this.buildEmitCtx( ctx, { activityId } ),
            activityId,
            dto
        );

        return dto;
    }

    public async updateBlocker( ctx: MemberActivityWsContext, activityId: string, input: MemberActivityUpdateBlockerInput ): Promise<MemberActivityDto> {
        const _id = this.toObjectId( activityId );

        const reportedAt = this.toDate( input.reportedAtIso );

        // We match blocker by title + reportedAt (phase-1 approach)
        const match = { "blockers.title": input.title, "blockers.reportedAt": reportedAt };

        const setDoc: Record<string, unknown> = {};
        if ( input.patch.title ) setDoc[ "blockers.$.title" ] = input.patch.title;
        if ( typeof input.patch.details === "string" ) setDoc[ "blockers.$.details" ] = input.patch.details;
        if ( input.patch.severity ) setDoc[ "blockers.$.severity" ] = input.patch.severity;
        if ( input.patch.resolvedAtIso ) setDoc[ "blockers.$.resolvedAt" ] = this.toDate( input.patch.resolvedAtIso );

        if ( Object.keys( setDoc ).length === 0 ) {
            throw new MemberActivitiesServiceError( "VALIDATION_ERROR", "No blocker patch fields provided." );
        }

        const updated = await MemberActivityModel.findOneAndUpdate(
            { _id, ...match },
            { $set: setDoc, $setOnInsert: {}, $currentDate: { updatedAt: true } },
            { new: true }
        ).lean().exec();

        if ( !updated ) throw new MemberActivitiesServiceError( "BLOCKER_NOT_FOUND", "Blocker not found for update." );

        const dto = updated as MemberActivityDto;

        this.ws.emitBlockerUpdated(
            this.buildEmitCtx( ctx, { activityId } ),
            activityId,
            dto
        );

        return dto;
    }

    public async resolveBlocker( ctx: MemberActivityWsContext, activityId: string, input: MemberActivityResolveBlockerInput ): Promise<MemberActivityDto> {
        const _id = this.toObjectId( activityId );

        const reportedAt = this.toDate( input.reportedAtIso );
        const resolvedAt = input.resolvedAtIso ? this.toDate( input.resolvedAtIso ) : new Date();

        const updated = await MemberActivityModel.findOneAndUpdate(
            { _id, "blockers.title": input.title, "blockers.reportedAt": reportedAt },
            { $set: { "blockers.$.resolvedAt": resolvedAt }, $currentDate: { updatedAt: true } },
            { new: true }
        ).lean().exec();

        if ( !updated ) throw new MemberActivitiesServiceError( "BLOCKER_NOT_FOUND", "Blocker not found for resolve." );

        const dto = updated as MemberActivityDto;

        this.ws.emitBlockerResolved(
            this.buildEmitCtx( ctx, { activityId } ),
            activityId,
            dto
        );

        return dto;
    }

    public async removeBlocker( ctx: MemberActivityWsContext, activityId: string, input: MemberActivityRemoveBlockerInput ): Promise<MemberActivityDto> {
        const _id = this.toObjectId( activityId );

        const reportedAt = this.toDate( input.reportedAtIso );

        const updated = await MemberActivityModel.findByIdAndUpdate(
            _id,
            { $pull: { blockers: { title: input.title, reportedAt } }, $currentDate: { updatedAt: true } },
            { new: true }
        ).lean().exec();

        if ( !updated ) throw new MemberActivitiesServiceError( "ACTIVITY_NOT_FOUND", "MemberActivity not found." );

        const dto = updated as MemberActivityDto;

        this.ws.emitBlockerRemoved(
            this.buildEmitCtx( ctx, { activityId } ),
            activityId,
            dto
        );

        return dto;
    }

    // =========================================================================
    // Private helpers (class methods only)
    // =========================================================================

    private extractUserIdFromDto( dto: MemberActivityDto ): string {
        const rawUnknown: unknown = ( dto as unknown as { userId?: unknown; } ).userId;

        if ( typeof rawUnknown === "string" ) {
            if ( !Types.ObjectId.isValid( rawUnknown ) ) {
                throw new MemberActivitiesServiceError( "INVALID_DTO_ID", "MemberActivityDto.userId is not a valid ObjectId string." );
            }
            return rawUnknown;
        }

        if ( rawUnknown instanceof Types.ObjectId ) {
            const asString = rawUnknown.toString();
            if ( !Types.ObjectId.isValid( asString ) ) {
                throw new MemberActivitiesServiceError( "INVALID_DTO_ID", "MemberActivityDto.userId ObjectId is invalid." );
            }
            return asString;
        }

        if ( rawUnknown && typeof rawUnknown === "object" && "toString" in rawUnknown ) {
            const asString = String( ( rawUnknown as { toString: () => string; } ).toString() );
            if ( !Types.ObjectId.isValid( asString ) ) {
                throw new MemberActivitiesServiceError( "INVALID_DTO_ID", "MemberActivityDto.userId object is not a valid ObjectId." );
            }
            return asString;
        }

        throw new MemberActivitiesServiceError( "DTO_MISSING_USER_ID", "MemberActivityDto does not contain a valid userId." );
    }


    private sanitizePatch( patch: {
        teamCode?: string;
        workItemId?: string;
        activityId?: string;
        memberUserIds?: string[];
    } ): {
        teamCode?: string;
        workItemId?: string;
        activityId?: string;
        memberUserIds?: string[];
    } {
        const next: {
            teamCode?: string;
            workItemId?: string;
            activityId?: string;
            memberUserIds?: string[];
        } = {};

        if ( typeof patch.teamCode === "string" && patch.teamCode.length > 0 ) next.teamCode = patch.teamCode;
        if ( typeof patch.workItemId === "string" && patch.workItemId.length > 0 ) next.workItemId = patch.workItemId;
        if ( typeof patch.activityId === "string" && patch.activityId.length > 0 ) next.activityId = patch.activityId;
        if ( Array.isArray( patch.memberUserIds ) && patch.memberUserIds.length > 0 ) next.memberUserIds = patch.memberUserIds;

        return next;
    }



    private extractIdFromDto( dto: MemberActivityDto ): string {
        const rawUnknown: unknown = ( dto as unknown as { _id?: unknown; id?: unknown; } )._id
            ?? ( dto as unknown as { id?: unknown; } ).id;

        // 1) String id
        if ( typeof rawUnknown === "string" ) {
            if ( !Types.ObjectId.isValid( rawUnknown ) ) {
                throw new MemberActivitiesServiceError(
                    "INVALID_DTO_ID",
                    "MemberActivityDto._id/id is not a valid ObjectId string."
                );
            }
            return rawUnknown;
        }

        // 2) Real ObjectId
        if ( rawUnknown instanceof Types.ObjectId ) {
            const asString = rawUnknown.toString();
            if ( !Types.ObjectId.isValid( asString ) ) {
                throw new MemberActivitiesServiceError(
                    "INVALID_DTO_ID",
                    "MemberActivityDto._id/id ObjectId is invalid."
                );
            }
            return asString;
        }

        // 3) ObjectId-like (rare, but safe to support)
        if ( rawUnknown && typeof rawUnknown === "object" && "toString" in rawUnknown ) {
            const asString = String( ( rawUnknown as { toString: () => string; } ).toString() );
            if ( !Types.ObjectId.isValid( asString ) ) {
                throw new MemberActivitiesServiceError(
                    "INVALID_DTO_ID",
                    "MemberActivityDto._id/id object is not a valid ObjectId."
                );
            }
            return asString;
        }

        // 4) Missing / invalid type
        throw new MemberActivitiesServiceError(
            "DTO_MISSING_ID",
            "MemberActivityDto does not contain a valid _id/id."
        );
    }

    private extractWorkItemIdFromDto( dto: MemberActivityDto ): string {
        const rawUnknown: unknown = ( dto as unknown as { workItemId?: unknown; } ).workItemId;

        // 1) String id
        if ( typeof rawUnknown === "string" ) {
            if ( !Types.ObjectId.isValid( rawUnknown ) ) {
                throw new MemberActivitiesServiceError(
                    "INVALID_DTO_ID",
                    "MemberActivityDto.workItemId is not a valid ObjectId string."
                );
            }
            return rawUnknown;
        }

        // 2) Real ObjectId
        if ( rawUnknown instanceof Types.ObjectId ) {
            const asString = rawUnknown.toString();
            if ( !Types.ObjectId.isValid( asString ) ) {
                throw new MemberActivitiesServiceError(
                    "INVALID_DTO_ID",
                    "MemberActivityDto.workItemId ObjectId is invalid."
                );
            }
            return asString;
        }

        // 3) ObjectId-like (rare, but safe to support)
        if ( rawUnknown && typeof rawUnknown === "object" && "toString" in rawUnknown ) {
            const asString = String( ( rawUnknown as { toString: () => string; } ).toString() );
            if ( !Types.ObjectId.isValid( asString ) ) {
                throw new MemberActivitiesServiceError(
                    "INVALID_DTO_ID",
                    "MemberActivityDto.workItemId object is not a valid ObjectId."
                );
            }
            return asString;
        }

        // 4) Missing / invalid type
        throw new MemberActivitiesServiceError(
            "DTO_MISSING_ID",
            "MemberActivityDto does not contain a valid workItemId."
        );
    }


    private extractTeamIdFromDto( dto: MemberActivityDto ): string {
        const rawUnknown: unknown = ( dto as unknown as { teamId?: unknown; } ).teamId;

        if ( typeof rawUnknown === "string" ) {
            if ( !Types.ObjectId.isValid( rawUnknown ) ) {
                throw new Error( `[Error:] [MemberActivitiesRestService] Invalid teamId string in DTO.\n` );
            }
            return rawUnknown;
        }

        if ( rawUnknown instanceof Types.ObjectId ) {
            const asString = rawUnknown.toString();
            if ( !Types.ObjectId.isValid( asString ) ) {
                throw new Error( `[Error:] [MemberActivitiesRestService] Invalid teamId ObjectId in DTO.\n` );
            }
            return asString;
        }

        // Some libs return ObjectId-like objects (rare), so fallback:
        if ( rawUnknown && typeof rawUnknown === "object" && "toString" in rawUnknown ) {
            const asString = String( ( rawUnknown as { toString: () => string; } ).toString() );
            if ( !Types.ObjectId.isValid( asString ) ) {
                throw new Error( `[Error:] [MemberActivitiesRestService] Invalid teamId object in DTO.\n` );
            }
            return asString;
        }

        throw new Error( `[Error:] [MemberActivitiesRestService] teamId missing or invalid type in DTO.\n` );
    }


    private buildListQuery( filters: MemberActivityListFilters ): Record<string, unknown> {
        const q: Record<string, unknown> = {
            teamId: this.toObjectId( filters.teamId ),
        };

        if ( filters.workItemId ) q.workItemId = this.toObjectId( filters.workItemId );
        if ( filters.userId ) q.userId = this.toObjectId( filters.userId );

        if ( filters.type ) q.type = filters.type;
        if ( filters.status ) q.status = filters.status;

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

    private buildUpdateDoc( input: MemberActivityUpdateInput ): Record<string, unknown> {
        const $set: Record<string, unknown> = {
            updatedAt: new Date(),
        };

        if ( input.type ) $set.type = input.type;

        if ( typeof input.title === "string" ) $set.title = input.title;
        if ( typeof input.notes === "string" ) $set.notes = input.notes;

        if ( input.startAt ) $set.startAt = this.toDate( input.startAt );
        if ( input.endAt ) $set.endAt = this.toDate( input.endAt );

        if ( typeof input.allDay === "boolean" ) $set.allDay = input.allDay;
        if ( typeof input.timezone === "string" ) $set.timezone = input.timezone;

        if ( input.status ) $set.status = input.status;

        if ( typeof input.progressBefore === "number" ) $set.progressBefore = this.normalizeProgress( input.progressBefore );
        if ( typeof input.progressAfter === "number" ) $set.progressAfter = this.normalizeProgress( input.progressAfter );

        if ( typeof input.milestoneId === "string" ) $set.milestoneId = input.milestoneId;

        // NOTE:
        // If you want updatedByUserId stored on the activity doc,
        // add it in your model. Currently your schema doesn’t include updatedByUserId.
        // So we only use it for authorization at controller-level.

        return { $set };
    }

    private buildEmitCtx(
        ctx: MemberActivityWsContext,
        patch: {
            teamCode?: string;
            workItemId?: string;
            activityId?: string;
            memberUserIds?: string[];
        }
    ): MemberActivityWsContext {
        const safePatch = this.sanitizePatch( patch );

        const next: MemberActivityWsContext = {
            actor: ctx.actor,
            requestId: ctx.requestId,

            ...( typeof safePatch.teamCode === "string" ? { teamCode: safePatch.teamCode } : typeof ctx.teamCode === "string" ? { teamCode: ctx.teamCode } : {} ),

            ...( typeof safePatch.workItemId === "string" ? { workItemId: safePatch.workItemId } : typeof ctx.workItemId === "string" ? { workItemId: ctx.workItemId } : {} ),

            ...( typeof safePatch.activityId === "string" ? { activityId: safePatch.activityId } : typeof ctx.activityId === "string" ? { activityId: ctx.activityId } : {} ),

            ...( safePatch.memberUserIds ? { memberUserIds: safePatch.memberUserIds } : ctx.memberUserIds && ctx.memberUserIds.length > 0 ? { memberUserIds: ctx.memberUserIds } : {} ),
        };

        return next;
    }


    private toObjectId( id: string ): Types.ObjectId {
        if ( !Types.ObjectId.isValid( id ) ) {
            throw new MemberActivitiesServiceError( "INVALID_OBJECT_ID", `Invalid ObjectId: ${ id }` );
        }
        return new Types.ObjectId( id );
    }

    private toDate( iso: string ): Date {
        const d = new Date( iso );
        if ( Number.isNaN( d.getTime() ) ) {
            throw new MemberActivitiesServiceError( "INVALID_DATE", `Invalid date: ${ iso }` );
        }
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
            throw new MemberActivitiesServiceError( "VALIDATION_ERROR", `${ field } must contain at least one item.` );
        }
    }

    private escapeRegex( input: string ): string {
        return input.replace( /[.*+?^${}()|[\]\\]/g, "\\$&" );
    }
}
