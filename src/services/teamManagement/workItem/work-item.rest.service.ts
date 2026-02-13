// Path: src/services/teamManagement/workItem/work-item.rest.service.ts
// ============================================================================
// WorkItem REST Service (Domain Engine) — 100% CLASS-BASED
// ----------------------------------------------------------------------------
// ✅ PURPOSE
// - Implements the WorkItem engine (CRUD + atomic ops + activity stream)
// - Uses WorkItemModel (thin snapshot) + MemberActivityModel (heavy calendar log)
// - After successful DB writes: emits WS events via WorkItemWsService (best-effort)
// ----------------------------------------------------------------------------
// ✅ IMPORTANT DESIGN RULES (your architecture)
// - REST is the source of truth for writes
// - WS emits are optional (must never break REST)
// - 1 WorkItem -> many MemberActivities
// - Multiple members per WorkItem; activities are owned by a member (userId)
// ----------------------------------------------------------------------------
// ✅ TYPES / STRICTNESS
// - No any
// - exactOptionalPropertyTypes safe: we never assign optional props as undefined
// - Class-only (no exported helper functions)
// ============================================================================

import { Types } from "mongoose";

import { WorkItemModel } from "../../../models/teamManagement/workItems/workItem.model";
import { MemberActivityModel } from "../../../models/teamManagement/memberActivities/memberActivity.model";

import type { WorkItemDto } from "../../../types/teamManagement/workItem/workItem.types";
import type { MemberActivityDto } from "../../../types/teamManagement/memberActivities/memberActivities.types";

import type { WorkItemStatus, WorkItemPriority, DeadlinePolicy } from "../../../types/teamManagement/workItem/workItem.types";

import { WorkItemWsService, type WorkItemWsContext } from "./work-item.ws.service";

// ----------------------------------------------------------------------------
// Inputs (keep these minimal and stable)
// ----------------------------------------------------------------------------

export interface WorkItemListFilters {
    teamId: string;
    assignedToUserId?: string;
    status?: WorkItemStatus;
    priority?: WorkItemPriority;
    dueFrom?: string; // ISO
    dueTo?: string;   // ISO
    q?: string;       // text search (workItemCode / title snapshot if you add later)
}

export interface WorkItemListPaging {
    page: number;     // 1-based
    limit: number;    // 1..200
}

export interface WorkItemListResult {
    items: WorkItemDto[];
    other: { total: number; };
}

export interface WorkItemCreateInput {
    workItemCode: string;
    teamId: string;

    taskId?: string;

    assignedByUserId: string;
    assignedToUserIds: string[];

    assignedAt: string; // ISO
    expectedCompleteAt: string; // ISO

    expectedStartAt?: string; // ISO

    deadlinePolicy: DeadlinePolicy;
    graceMinutes?: number;

    statusCurrent: WorkItemStatus;
    priority: WorkItemPriority;
    progressCurrent: number; // 0..100

    createdByUserId: string;
}

export interface WorkItemUpdateInput {
    expectedStartAt?: string; // ISO
    expectedCompleteAt?: string; // ISO
    deadlinePolicy?: DeadlinePolicy;
    graceMinutes?: number;

    statusCurrent?: WorkItemStatus;
    priority?: WorkItemPriority;
    progressCurrent?: number;

    completedAt?: string; // ISO
    completedByUserId?: string;

    updatedByUserId: string;
}

export interface WorkItemAppendActivityInput {
    // calendar-style event
    userId: string; // owner member

    type: string; // keep as string because your MEMBER_ACTIVITY_TYPE is in the types file
    title: string;
    notes?: string;

    startAt: string; // ISO
    endAt: string;   // ISO
    allDay: boolean;
    timezone?: string;

    status: string; // MEMBER_ACTIVITY_STATUS union in your types

    progressBefore?: number;
    progressAfter?: number;

    milestoneId?: string;
}

// ----------------------------------------------------------------------------
// Service Error (typed enough for controller to map to ApiResponseBuilder.error)
// ----------------------------------------------------------------------------
export class WorkItemServiceError extends Error {
    public readonly code: string;

    public constructor ( code: string, message: string ) {
        super( message );
        this.code = code;
    }
}

// ----------------------------------------------------------------------------
// WorkItemRestService
// ----------------------------------------------------------------------------
export class WorkItemRestService {
    private readonly ws: WorkItemWsService;

    public constructor () {
        // WS service is safe (lazy handler inside), so it won't break REST
        this.ws = WorkItemWsService.GetInstance();
    }

    // =========================================================================
    // GET
    // =========================================================================

    public async getById( workItemId: string ): Promise<WorkItemDto> {
        const _id = this.toObjectId( workItemId );

        const doc = await WorkItemModel.findById( _id ).lean().exec();
        if ( !doc ) throw new WorkItemServiceError( "WORK_ITEM_NOT_FOUND", "WorkItem not found." );

        return this.toWorkItemDto( doc );
    }

    public async list( filters: WorkItemListFilters, paging: WorkItemListPaging ): Promise<WorkItemListResult> {
        const query = this.buildListQuery( filters );

        const page = this.normalizePage( paging.page );
        const limit = this.normalizeLimit( paging.limit );
        const skip = ( page - 1 ) * limit;

        const [ items, total ] = await Promise.all( [
            WorkItemModel.find( query ).sort( { updatedAt: -1 } ).skip( skip ).limit( limit ).lean().exec(),
            WorkItemModel.countDocuments( query ).exec(),
        ] );

        return {
            items: items.map( ( d ) => this.toWorkItemDto( d ) ),
            other: { total },
        };
    }

    public async count( filters: WorkItemListFilters ): Promise<number> {
        const query = this.buildListQuery( filters );
        return WorkItemModel.countDocuments( query ).exec();
    }

    // =========================================================================
    // CREATE / UPDATE / DELETE
    // =========================================================================

    public async create( ctx: WorkItemWsContext, input: WorkItemCreateInput ): Promise<WorkItemDto> {
        this.assertNonEmptyArray( input.assignedToUserIds, "assignedToUserIds" );

        const doc = await WorkItemModel.create( {
            workItemCode: input.workItemCode,
            teamId: this.toObjectId( input.teamId ),

            ...( input.taskId ? { taskId: this.toObjectId( input.taskId ) } : {} ),

            assignedByUserId: this.toObjectId( input.assignedByUserId ),
            assignedToUserIds: input.assignedToUserIds.map( ( id ) => this.toObjectId( id ) ),
            assignedAt: this.toDate( input.assignedAt ),

            ...( input.expectedStartAt ? { expectedStartAt: this.toDate( input.expectedStartAt ) } : {} ),
            expectedCompleteAt: this.toDate( input.expectedCompleteAt ),

            deadlinePolicy: input.deadlinePolicy,
            ...( typeof input.graceMinutes === "number" ? { graceMinutes: input.graceMinutes } : {} ),

            statusCurrent: input.statusCurrent,
            priority: input.priority,
            progressCurrent: this.normalizeProgress( input.progressCurrent ),

            createdByUserId: this.toObjectId( input.createdByUserId ),
        } );

        const dto = this.toWorkItemDto( doc.toObject() );

        const teamCode = ctx.teamCode;
        if ( !teamCode ) {
            // no WS emit, but REST is fine
            return dto;
        }
        // Emit created
        this.ws.emitWorkItemCreated(
            this.buildEmitCtx( ctx, {
                teamCode,
                workItemId: this.extractIdFromDto( dto ),
                memberUserIds: input.assignedToUserIds,
            } ),
            dto
        );

        return dto;
    }

    public async updateById( ctx: WorkItemWsContext, workItemId: string, input: WorkItemUpdateInput ): Promise<WorkItemDto> {
        const _id = this.toObjectId( workItemId );

        const updateDoc = this.buildWorkItemUpdateDoc( input );

        const updated = await WorkItemModel.findByIdAndUpdate( _id, updateDoc, { new: true } ).lean().exec();
        if ( !updated ) throw new WorkItemServiceError( "WORK_ITEM_NOT_FOUND", "WorkItem not found." );

        const dto = this.toWorkItemDto( updated );

        // Emit updated (use member ids from DB if your DTO contains them; otherwise emit team room only)
        const memberIds = this.extractAssignedMemberIds( updated );

        this.ws.emitWorkItemUpdated(
            this.buildEmitCtx( ctx, {
                workItemId: workItemId,
                memberUserIds: memberIds,
            } ),
            dto
        );

        return dto;
    }

    public async deleteById( ctx: WorkItemWsContext, workItemId: string ): Promise<void> {
        const _id = this.toObjectId( workItemId );

        // Load first to know team + members for WS emits
        const existing = await WorkItemModel.findById( _id ).lean().exec();
        if ( !existing ) throw new WorkItemServiceError( "WORK_ITEM_NOT_FOUND", "WorkItem not found." );

        const teamCode = ctx.teamCode; // controller should provide; if not, we still delete safely

        await Promise.all( [
            WorkItemModel.deleteOne( { _id } ).exec(),
            MemberActivityModel.deleteMany( { workItemId: _id } ).exec(),
        ] );

        // Emit deleted
        if ( teamCode ) {
            const memberIds = this.extractAssignedMemberIds( existing );
            this.ws.emitWorkItemDeleted(
                this.buildEmitCtx( ctx, { teamCode, workItemId } ),
                workItemId,
                teamCode,
                memberIds.map( ( s ) => this.toObjectId( s ) )
            );
        }
    }

    // =========================================================================
    // ATOMIC OPS (recommended for UI actions)
    // =========================================================================

    public async setStatus( ctx: WorkItemWsContext, workItemId: string, status: WorkItemStatus, updatedByUserId: string ): Promise<WorkItemDto> {
        return this.updateById( ctx, workItemId, { statusCurrent: status, updatedByUserId } );
    }

    public async setPriority( ctx: WorkItemWsContext, workItemId: string, priority: WorkItemPriority, updatedByUserId: string ): Promise<WorkItemDto> {
        return this.updateById( ctx, workItemId, { priority, updatedByUserId } );
    }

    public async setDueAt( ctx: WorkItemWsContext, workItemId: string, expectedCompleteAtIso: string, updatedByUserId: string ): Promise<WorkItemDto> {
        return this.updateById( ctx, workItemId, { expectedCompleteAt: expectedCompleteAtIso, updatedByUserId } );
    }

    public async setAssignedMembers( ctx: WorkItemWsContext, workItemId: string, assignedToUserIds: string[], updatedByUserId: string ): Promise<WorkItemDto> {
        this.assertNonEmptyArray( assignedToUserIds, "assignedToUserIds" );

        const _id = this.toObjectId( workItemId );

        const updated = await WorkItemModel.findByIdAndUpdate(
            _id,
            {
                $set: {
                    assignedToUserIds: assignedToUserIds.map( ( id ) => this.toObjectId( id ) ),
                    updatedByUserId: this.toObjectId( updatedByUserId ),
                },
            },
            { new: true }
        ).lean().exec();

        if ( !updated ) throw new WorkItemServiceError( "WORK_ITEM_NOT_FOUND", "WorkItem not found." );

        const dto = this.toWorkItemDto( updated );

        const teamCode = ctx.teamCode;
        if ( teamCode ) {
            this.ws.emitWorkItemUpdated(
                this.buildEmitCtx( ctx, { teamCode, workItemId, memberUserIds: assignedToUserIds } ),
                dto
            );
        }

        return dto;
    }

    // =========================================================================
    // MEMBER ACTIVITY (calendar-style milestones / targets)
    // =========================================================================

    public async appendActivity(
        ctx: WorkItemWsContext,
        workItemId: string,
        input: WorkItemAppendActivityInput
    ): Promise<MemberActivityDto> {
        const _id = this.toObjectId( workItemId );

        const workItem = await WorkItemModel.findById( _id ).lean().exec();
        if ( !workItem ) throw new WorkItemServiceError( "WORK_ITEM_NOT_FOUND", "WorkItem not found." );

        // Permission: member must be assigned to this work item
        this.assertUserIsAssigned( workItem, input.userId );

        const activityDoc = await MemberActivityModel.create( {
            workItemId: _id,
            teamId: workItem.teamId,
            userId: this.toObjectId( input.userId ),

            createdByUserId: this.toObjectId( input.userId ),
            requestId: ctx.requestId,
            source: "rest",

            type: input.type,

            title: input.title,
            ...( input.notes ? { notes: input.notes } : {} ),

            startAt: this.toDate( input.startAt ),
            endAt: this.toDate( input.endAt ),
            allDay: input.allDay,
            ...( input.timezone ? { timezone: input.timezone } : {} ),

            status: input.status,

            ...( typeof input.progressBefore === "number" ? { progressBefore: this.normalizeProgress( input.progressBefore ) } : {} ),
            ...( typeof input.progressAfter === "number" ? { progressAfter: this.normalizeProgress( input.progressAfter ) } : {} ),

            ...( input.milestoneId ? { milestoneId: input.milestoneId } : {} ),
        } );

        const activityDto = this.toMemberActivityDto( activityDoc.toObject() );

        // Update WorkItem snapshot (cheap cached fields)
        await this.updateSnapshotFromActivity( workItemId, workItem, input );

        // Emit activity appended (notify captain + assigned members)
        if ( ctx.teamCode ) {
            const memberIds = this.extractAssignedMemberIds( workItem );
            this.ws.emitActivityAppended(
                this.buildEmitCtx( ctx, { teamCode: ctx.teamCode, workItemId, memberUserIds: memberIds } ),
                workItemId,
                ctx.teamCode,
                memberIds.map( ( s ) => this.toObjectId( s ) ),
                activityDto
            );
        }

        return activityDto;
    }

    // =========================================================================
    // Snapshot updater (WorkItem cached fields)
    // =========================================================================

    private async updateSnapshotFromActivity( workItemId: string, workItemLean: unknown, activity: WorkItemAppendActivityInput ): Promise<void> {
        // Minimal snapshot update:
        // - lastActivityAt always updates
        // - progressCurrent updates if progressAfter provided
        // - statusCurrent can be auto-set if activity.status suggests done (optional)
        //
        // NOTE: For industrial-grade, you can compute per-member progress + overall.
        // Here we keep it stable and safe.

        const now = new Date();

        const setDoc: Record<string, unknown> = {
            lastActivityAt: now,
        };

        if ( typeof activity.progressAfter === "number" ) {
            setDoc.progressCurrent = this.normalizeProgress( activity.progressAfter );
        }

        await WorkItemModel.updateOne( { _id: this.toObjectId( workItemId ) }, { $set: setDoc } ).exec();
    }

    // =========================================================================
    // Query builders / validators / DTO mappers (private class methods)
    // =========================================================================

    private buildListQuery( filters: WorkItemListFilters ): Record<string, unknown> {
        const q: Record<string, unknown> = {
            teamId: this.toObjectId( filters.teamId ),
        };

        if ( filters.assignedToUserId ) {
            q.assignedToUserIds = this.toObjectId( filters.assignedToUserId );
        }

        if ( filters.status ) q.statusCurrent = filters.status;
        if ( filters.priority ) q.priority = filters.priority;

        if ( filters.dueFrom || filters.dueTo ) {
            const range: Record<string, unknown> = {};
            if ( filters.dueFrom ) range.$gte = this.toDate( filters.dueFrom );
            if ( filters.dueTo ) range.$lte = this.toDate( filters.dueTo );
            q.expectedCompleteAt = range;
        }

        // Optional text search (only if you add indexes / field later)
        if ( filters.q && filters.q.trim().length > 0 ) {
            // workItemCode prefix match (safe)
            q.workItemCode = { $regex: this.escapeRegex( filters.q.trim() ), $options: "i" };
        }

        return q;
    }

    private buildWorkItemUpdateDoc( input: WorkItemUpdateInput ): Record<string, unknown> {
        const $set: Record<string, unknown> = {
            updatedByUserId: this.toObjectId( input.updatedByUserId ),
            updatedAt: ()=> new Date().toISOString(),
        };

        if ( input.expectedStartAt ) $set.expectedStartAt = this.toDate( input.expectedStartAt );
        if ( input.expectedCompleteAt ) $set.expectedCompleteAt = this.toDate( input.expectedCompleteAt );

        if ( input.deadlinePolicy ) $set.deadlinePolicy = input.deadlinePolicy;
        if ( typeof input.graceMinutes === "number" ) $set.graceMinutes = input.graceMinutes;

        if ( input.statusCurrent ) $set.statusCurrent = input.statusCurrent;
        if ( input.priority ) $set.priority = input.priority;

        if ( typeof input.progressCurrent === "number" ) $set.progressCurrent = this.normalizeProgress( input.progressCurrent );

        if ( input.completedAt ) $set.completedAt = this.toDate( input.completedAt );
        if ( input.completedByUserId ) $set.completedByUserId = this.toObjectId( input.completedByUserId );



        return { $set };
    }

    private assertUserIsAssigned( workItemLean: unknown, userId: string ): void {
        const wi = workItemLean as { assignedToUserIds?: Types.ObjectId[]; };

        const uid = this.toObjectId( userId ).toString();
        const assigned = Array.isArray( wi.assignedToUserIds ) ? wi.assignedToUserIds.map( ( x ) => x.toString() ) : [];

        if ( !assigned.includes( uid ) ) {
            throw new WorkItemServiceError( "NOT_ASSIGNED", "User is not assigned to this WorkItem." );
        }
    }

    private extractAssignedMemberIds( workItemLean: unknown ): string[] {
        const wi = workItemLean as { assignedToUserIds?: Types.ObjectId[]; };
        const assigned = Array.isArray( wi.assignedToUserIds ) ? wi.assignedToUserIds.map( ( x ) => x.toString() ) : [];
        return assigned;
    }

    private buildEmitCtx( ctx: WorkItemWsContext, patch: { teamCode?: string; workItemId?: string; memberUserIds?: string[]; } ): WorkItemWsContext {
        // exactOptionalPropertyTypes safe: only include optionals when present
        const next: WorkItemWsContext = {
            actor: ctx.actor,
            requestId: ctx.requestId,
            ...( patch.teamCode ? { teamCode: patch.teamCode } : {} ),
            ...( patch.workItemId ? { workItemId: patch.workItemId } : {} ),
            ...( patch.memberUserIds && patch.memberUserIds.length > 0 ? { memberUserIds: patch.memberUserIds } : {} ),
        };
        return next;
    }

    private extractIdFromDto( dto: WorkItemDto ): string {
        const rawUnknown: unknown = ( dto as unknown as { _id?: unknown; id?: unknown; } )._id
            ?? ( dto as unknown as { id?: unknown; } ).id;

        // 1) String id
        if ( typeof rawUnknown === "string" ) {
            if ( !Types.ObjectId.isValid( rawUnknown ) ) {
                throw new WorkItemServiceError(
                    "INVALID_DTO_ID",
                    "WorkItemDto._id/id is not a valid ObjectId string."
                );
            }
            return rawUnknown;
        }

        // 2) Real ObjectId
        if ( rawUnknown instanceof Types.ObjectId ) {
            const asString = rawUnknown.toString();
            if ( !Types.ObjectId.isValid( asString ) ) {
                throw new WorkItemServiceError(
                    "INVALID_DTO_ID",
                    "WorkItemDto._id/id ObjectId is invalid."
                );
            }
            return asString;
        }

        // 3) ObjectId-like (rare, but safe to support)
        if ( rawUnknown && typeof rawUnknown === "object" && "toString" in rawUnknown ) {
            const asString = String( ( rawUnknown as { toString: () => string; } ).toString() );
            if ( !Types.ObjectId.isValid( asString ) ) {
                throw new WorkItemServiceError(
                    "INVALID_DTO_ID",
                    "WorkItemDto._id/id object is not a valid ObjectId."
                );
            }
            return asString;
        }

        // 4) Missing / invalid type
        throw new WorkItemServiceError(
            "DTO_MISSING_ID",
            "WorkItemDto does not contain a valid _id/id."
        );
    }


    private extractTeamIdFromDto( dto: WorkItemDto ): string {
        const rawUnknown: unknown = ( dto as unknown as { teamId?: unknown; } ).teamId;

        if ( typeof rawUnknown === "string" ) {
            if ( !Types.ObjectId.isValid( rawUnknown ) ) {
                throw new Error( `[Error:] [WorkItemRestService] Invalid teamId string in DTO.\n` );
            }
            return rawUnknown;
        }

        if ( rawUnknown instanceof Types.ObjectId ) {
            const asString = rawUnknown.toString();
            if ( !Types.ObjectId.isValid( asString ) ) {
                throw new Error( `[Error:] [WorkItemRestService] Invalid teamId ObjectId in DTO.\n` );
            }
            return asString;
        }

        // Some libs return ObjectId-like objects (rare), so fallback:
        if ( rawUnknown && typeof rawUnknown === "object" && "toString" in rawUnknown ) {
            const asString = String( ( rawUnknown as { toString: () => string; } ).toString() );
            if ( !Types.ObjectId.isValid( asString ) ) {
                throw new Error( `[Error:] [WorkItemRestService] Invalid teamId object in DTO.\n` );
            }
            return asString;
        }

        throw new Error( `[Error:] [WorkItemRestService] teamId missing or invalid type in DTO.\n` );
    }



    private toObjectId( id: string ): Types.ObjectId {
        if ( !Types.ObjectId.isValid( id ) ) throw new WorkItemServiceError( "INVALID_OBJECT_ID", `Invalid ObjectId: ${ id }` );
        return new Types.ObjectId( id );
    }

    private toDate( iso: string ): Date {
        const d = new Date( iso );
        if ( Number.isNaN( d.getTime() ) ) throw new WorkItemServiceError( "INVALID_DATE", `Invalid date: ${ iso }` );
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
            throw new WorkItemServiceError( "VALIDATION_ERROR", `${ field } must contain at least one item.` );
        }
    }

    private escapeRegex( input: string ): string {
        return input.replace( /[.*+?^${}()|[\]\\]/g, "\\$&" );
    }

    // -------------------------
    // DTO Mappers (minimal)
    // -------------------------

    private toWorkItemDto( lean: any ): WorkItemDto {
        // NOTE: If you refuse `any`, define a LeanWorkItem interface.
        const id = lean._id?.toString?.() ? lean._id.toString() : String( lean._id );

        return {
            _id: id,
            workItemCode: lean.workItemCode,
            teamId: lean.teamId.toString(),

            ...( lean.taskId ? { taskId: lean.taskId.toString() } : {} ),

            assignedByUserId: lean.assignedByUserId.toString(),
            assignedToUserIds: Array.isArray( lean.assignedToUserIds )
                ? lean.assignedToUserIds.map( ( x: Types.ObjectId ) => x.toString() )
                : [],

            assignedAt: new Date( lean.assignedAt ).toISOString(),
            ...( lean.expectedStartAt ? { expectedStartAt: new Date( lean.expectedStartAt ).toISOString() } : {} ),
            expectedCompleteAt: new Date( lean.expectedCompleteAt ).toISOString(),

            deadlinePolicy: lean.deadlinePolicy,
            ...( typeof lean.graceMinutes === "number" ? { graceMinutes: lean.graceMinutes } : {} ),

            statusCurrent: lean.statusCurrent,
            priority: lean.priority,
            progressCurrent: lean.progressCurrent,

            ...( lean.lastActivityAt ? { lastActivityAt: new Date( lean.lastActivityAt ).toISOString() } : {} ),
            ...( lean.completedAt ? { completedAt: new Date( lean.completedAt ).toISOString() } : {} ),
            ...( lean.completedByUserId ? { completedByUserId: lean.completedByUserId.toString() } : {} ),

            ...( Array.isArray( lean.memberProgress ) && lean.memberProgress.length > 0
                ? {
                    memberProgress: lean.memberProgress.map( ( mp: any ) => ( {
                        userId: mp.userId.toString(),
                        progress: mp.progress,
                        status: mp.status,
                        lastActivityAt: new Date( mp.lastActivityAt ).toISOString(),
                    } ) ),
                }
                : {} ),

            ...( Array.isArray( lean.completionEvidenceSummary ) && lean.completionEvidenceSummary.length > 0
                ? {
                    completionEvidenceSummary: lean.completionEvidenceSummary.map( ( ev: any ) => ( {
                        label: ev.label,
                        relPath: ev.relPath,
                        url: ev.url,
                        mimeType: ev.mimeType,
                        originalName: ev.originalName,
                        sizeBytes: ev.sizeBytes,
                        uploadedAt: new Date( ev.uploadedAt ).toISOString(),
                    } ) ),
                }
                : {} ),

            createdByUserId: lean.createdByUserId.toString(),
            ...( lean.updatedByUserId ? { updatedByUserId: lean.updatedByUserId.toString() } : {} ),

            createdAt: new Date( lean.createdAt ).toISOString(),
            updatedAt: new Date( lean.updatedAt ).toISOString(),
        };
    }


    private toMemberActivityDto( lean: unknown ): MemberActivityDto {
        return lean as MemberActivityDto;
    }
}
