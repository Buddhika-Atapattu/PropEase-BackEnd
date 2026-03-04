// Path: src/services/teamManagement/workItem/work-item.rest.service.ts
// ============================================================================
// WorkItem REST Service (Domain Engine) — 100% CLASS-BASED (STRICT)
// ----------------------------------------------------------------------------
// ✅ Added in this version
// - Evidence upload using your FileUploader helper (TEMP -> FINAL move assumed inside helper)
// - appendEvidence() / removeEvidence() methods
// - Removed all `any` by introducing LeanWorkItem + evidence row types
// - Fixed the bug: `updatedAt: ()=> ...` (timestamps handle updatedAt; never set it like that)
//
// ✅ Upload root (NO leading slash)
// uploads/team-management/<teamCode>/<taskId>/<workItemId>/evidence
// ============================================================================

import { Types, type ClientSession } from "mongoose";
import { Request } from 'express';

import { WorkItemModel } from "../../../models/teamManagement/workItems/workItem.model";
import { MemberActivityModel } from "../../../models/teamManagement/memberActivities/memberActivity.model";

import type { AuthUser, FileMetaPacket } from "../../../types/common";
import type { WorkItemDto } from "../../../types/teamManagement/workItem/workItem.types";
import type { MemberActivityDto } from "../../../types/teamManagement/memberActivities/memberActivities.types";
import type {
    WorkItemStatus,
    WorkItemPriority,
    DeadlinePolicy,
} from "../../../types/teamManagement/workItem/workItem.types";

import { WorkItemWsService, type WorkItemWsContext } from "./work-item.ws.service";

import {
    RecycleBinDomainDeleteService,
    type DomainDeletePlan,
} from "../../recyclebin/recyclebin-domain-delete.service";

import FileUploader, { type UploadResultPacket } from "../../../utils/files/file-uploader.helper";
import { ApiGuardExport } from "../../../guard/api-router.guard";

// ----------------------------------------------------------------------------
// Inputs (keep these minimal and stable)
// ----------------------------------------------------------------------------

export interface WorkItemListFilters {
    teamId: string;
    assignedToUserId?: string;
    status?: WorkItemStatus;
    priority?: WorkItemPriority;
    dueFrom?: string; // ISO
    dueTo?: string; // ISO
    q?: string;
}

export interface WorkItemListPaging {
    page: number; // 1-based
    limit: number; // 1..200
}

export interface WorkItemListResult {
    items: WorkItemDto[];
    other: { total: number; };
}

export interface WorkItemCreateInput {
    workItemCode: string;
    teamId: string;

    taskId: string;

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
    userId: string;

    type: string;
    title: string;
    notes?: string;

    startAt: string; // ISO
    endAt: string; // ISO
    allDay: boolean;
    timezone?: string;

    status: string;

    progressBefore?: number;
    progressAfter?: number;

    milestoneId?: string;
}

// ----------------------------------------------------------------------------
// Evidence inputs
// ----------------------------------------------------------------------------

export interface WorkItemUploadEvidenceInput {
    /** Used for final folder: uploads/team-management/<teamCode>/<taskId>/<workItemId>/evidence */
    teamCode: string;
    /** Used for final folder */
    taskId: string;

    /** Optional label stored in completionEvidenceSummary; defaults to original filename */
    label?: string;

    /** Actor for audit + updatedByUserId */
    updatedByUserId: string;

    /**
     * Files from controller (multer or your uploader pipeline).
     * Your FileUploader helper should know how to interpret these.
     */
    files: FileMetaPacket[];
}

export interface WorkItemRemoveEvidenceInput {
    updatedByUserId: string;
    relPaths: ReadonlyArray<string>;
}

// ----------------------------------------------------------------------------
// Service Error
// ----------------------------------------------------------------------------
export class WorkItemServiceError extends Error {
    public readonly code: string;

    public constructor ( code: string, message: string ) {
        super( message );
        this.code = code;
    }
}

// ----------------------------------------------------------------------------
// Lean typing (NO any)
// ----------------------------------------------------------------------------

interface LeanEvidenceRow {
    label: string;
    relPath: string;
    url: string;
    mimeType: string;
    originalName: string;
    sizeBytes: number;
    uploadedAt: Date;
}

interface LeanMemberProgressRow {
    userId: Types.ObjectId;
    progress: number;
    status: WorkItemStatus;
    lastActivityAt: Date;
}

interface LeanWorkItem {
    _id: Types.ObjectId;

    workItemCode: string;
    teamId: Types.ObjectId;

    taskId?: Types.ObjectId;

    assignedByUserId: Types.ObjectId;
    assignedToUserIds: Types.ObjectId[];
    assignedAt: Date;

    expectedStartAt?: Date;
    expectedCompleteAt: Date;

    deadlinePolicy: DeadlinePolicy;
    graceMinutes?: number;

    statusCurrent: WorkItemStatus;
    priority: WorkItemPriority;
    progressCurrent: number;

    lastActivityAt?: Date;
    completedAt?: Date;
    completedByUserId?: Types.ObjectId;

    memberProgress?: LeanMemberProgressRow[];
    completionEvidenceSummary?: LeanEvidenceRow[];

    createdByUserId: Types.ObjectId;
    updatedByUserId?: Types.ObjectId;

    createdAt: Date;
    updatedAt: Date;
}

// ----------------------------------------------------------------------------
// WorkItemRestService
// ----------------------------------------------------------------------------
export class WorkItemRestService {
    private readonly ws: WorkItemWsService;
    private readonly deleteService: RecycleBinDomainDeleteService;

    public constructor () {
        this.ws = WorkItemWsService.GetInstance();
        this.deleteService = new RecycleBinDomainDeleteService();

    }

    // =========================================================================
    // GET
    // =========================================================================

    public async getById( workItemId: string ): Promise<WorkItemDto> {
        const _id = this.toObjectId( workItemId );

        const doc = await WorkItemModel.findById( _id ).lean<LeanWorkItem>().exec();
        if ( !doc ) throw new WorkItemServiceError( "WORK_ITEM_NOT_FOUND", "WorkItem not found." );

        return this.toWorkItemDto( doc );
    }

    public async list( filters: WorkItemListFilters, paging: WorkItemListPaging ): Promise<WorkItemListResult> {
        const query = this.buildListQuery( filters );

        const page = this.normalizePage( paging.page );
        const limit = this.normalizeLimit( paging.limit );
        const skip = ( page - 1 ) * limit;

        const [ items, total ] = await Promise.all( [
            WorkItemModel.find( query ).sort( { updatedAt: -1 } ).skip( skip ).limit( limit ).lean<LeanWorkItem[]>().exec(),
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

        const dto = this.toWorkItemDto( doc.toObject() as unknown as LeanWorkItem );

        if ( ctx.teamCode ) {
            this.ws.emitWorkItemCreated(
                this.buildEmitCtx( ctx, {
                    teamCode: ctx.teamCode,
                    workItemId: doc._id.toString(),
                    memberUserIds: input.assignedToUserIds,
                } ),
                dto
            );
        }

        return dto;
    }

    public async updateById( ctx: WorkItemWsContext, workItemId: string, input: WorkItemUpdateInput ): Promise<WorkItemDto> {
        const _id = this.toObjectId( workItemId );
        const updateDoc = this.buildWorkItemUpdateDoc( input );

        const updated = await WorkItemModel.findByIdAndUpdate( _id, updateDoc, { new: true } ).lean<LeanWorkItem>().exec();
        if ( !updated ) throw new WorkItemServiceError( "WORK_ITEM_NOT_FOUND", "WorkItem not found." );

        const dto = this.toWorkItemDto( updated );

        if ( ctx.teamCode ) {
            const memberIds = this.extractAssignedMemberIds( updated );
            this.ws.emitWorkItemUpdated(
                this.buildEmitCtx( ctx, { teamCode: ctx.teamCode, workItemId, memberUserIds: memberIds } ),
                dto
            );
        }

        return dto;
    }

    public async deleteById(
        ctx: WorkItemWsContext,
        workItemId: string,
        actor: AuthUser,
        req: Request,
    ): Promise<void> {
        const _id = this.toObjectId( workItemId );

        const existing = await WorkItemModel.findById( _id ).lean<LeanWorkItem>().exec();
        if ( !existing ) {
            throw new WorkItemServiceError( "WORK_ITEM_NOT_FOUND", "WorkItem not found." );
        }

        // Snapshot of the work item (DTO)
        const snapshot = this.toWorkItemDto( existing );

        // Load activities as LEAN DB docs (NOT DTO) because we need _id reliably
        type LeanMemberActivity = { _id: unknown; workItemId?: unknown; } & Record<string, unknown>;
        const activities = await MemberActivityModel.find( { workItemId: _id } )
            .lean<LeanMemberActivity[]>()
            .exec();

        // 1) RecycleBin delete each activity (unique refId per activity) — awaited deterministically
        for ( const activity of activities ) {
            try {
                const activityIdRaw = ( activity as { _id?: unknown; } )._id;
                const activityId = String( activityIdRaw ?? "" ).trim();
                if ( !activityId ) {
                    // If this happens, better to fail loud (restore integrity depends on IDs)
                    throw new Error( "[Error:] [WorkItemService.deleteById:] member activity _id missing\n" );
                }

                const activityPlan: DomainDeletePlan<MemberActivityDto> = {
                    sourceKey: "memberActivity",
                    refId: activityId, // ✅ unique per activity (restore-safe)
                    label: `Member Activity (WorkItem: ${ existing.workItemCode })`,
                    description: "Member activity deleted (cascade from work item)",
                    snapshotData: { activity }, // ✅ snapshot the activity itself
                    files: [],
                    collectionName: MemberActivityModel.collection.name, // ✅ correct collection
                    module: "Team Management",
                    entity: "MemberActivity",
                    tags: [ "memberActivity", "cascade", "workItem" ],

                    deleteDbRecord: async ( session?: ClientSession ): Promise<void> => {
                        const opts = session ? { session } : undefined;
                        await MemberActivityModel.deleteOne( { _id: this.toObjectId( activityId ) }, opts ).exec();
                    },
                };

                await this.deleteService.deleteWithRecycleBin( actor, activityPlan, req );
            } catch ( err: unknown ) {
                console.error( "[Error:] [WorkItemService.deleteById:] memberActivity recycle delete failed.\n", err, "\n" );
                // Choose: either continue deleting others or stop. Stopping keeps behavior strict.
                throw err;
            }
        }

        // 2) RecycleBin delete the work item itself
        const workItemPlan: DomainDeletePlan<WorkItemDto> = {
            sourceKey: "workItem",
            refId: workItemId,
            label: `WorkItem: ${ existing.workItemCode }`,
            description: "Work item deleted",
            snapshotData: { workItem: snapshot }, // ✅ snapshot the workItem
            files: [],
            collectionName: WorkItemModel.collection.name,
            module: "Team Management",
            entity: "WorkItem",
            tags: [ "workItem" ],

            deleteDbRecord: async ( session?: ClientSession ): Promise<void> => {
                const opts = session ? { session } : undefined;

                // ✅ Only delete work item here.
                // Activities already deleted above (and recorded to recyclebin individually).
                await WorkItemModel.deleteOne( { _id }, opts ).exec();
            },
        };

        await this.deleteService.deleteWithRecycleBin( actor, workItemPlan, req );

        // 3) WS emit
        if ( ctx.teamCode ) {
            const memberIds = this.extractAssignedMemberIds( existing );

            this.ws.emitWorkItemDeleted(
              this.buildEmitCtx( ctx, { teamCode: ctx.teamCode, workItemId } ),
              workItemId,
              ctx.teamCode,
              memberIds.map( ( s ) => this.toObjectId( s ) )
          );
        }
    }

    // =========================================================================
    // EVIDENCE (UPLOAD + DB PATCH)
    // =========================================================================
    /**
     * Upload evidence files to:
     * uploads/team-management/<teamCode>/<taskId>/<workItemId>/evidence
     * then append metadata rows into completionEvidenceSummary.
     *
     * IMPORTANT:
     * - This uploader reads files from `req` (multer runs inside it).
     * - So `input.files` is NOT required for the upload itself.
     *   You can keep the validation if you want, but it must validate req carries files.
     *
     * @param ctx WebSocket context (teamCode recommended for emits)
     * @param workItemId WorkItem Mongo id
     * @param input Evidence upload input (teamCode/taskId/label/updatedByUserId)
     * @param req Express request (contains multipart files)
     */
    public async uploadEvidence(
        ctx: WorkItemWsContext,
        workItemId: string,
        input: WorkItemUploadEvidenceInput,
    ): Promise<WorkItemDto> {
        // -------------------------------------------------------------------------
        // 0) Basic validations
        // -------------------------------------------------------------------------
        if ( !input.teamCode?.trim() ) {
            throw new WorkItemServiceError( "VALIDATION_ERROR", "teamCode is required." );
        }
        if ( !input.taskId?.trim() ) {
            throw new WorkItemServiceError( "VALIDATION_ERROR", "taskId is required." );
        }
        if ( !input.updatedByUserId?.trim() ) {
            throw new WorkItemServiceError( "VALIDATION_ERROR", "updatedByUserId is required." );
        }
        if ( input.files.length === 0 ) {
            throw new WorkItemServiceError( "VALIDATION_ERROR", "files are required." );
        }

        const _id = this.toObjectId( workItemId );

        const existing = await WorkItemModel.findById( _id ).lean<LeanWorkItem>().exec();
        if ( !existing ) {
            throw new WorkItemServiceError( "WORK_ITEM_NOT_FOUND", "WorkItem not found." );
        }

        // If WorkItem has taskId, ensure it matches input.taskId (folder safety)
        if ( existing.taskId && existing.taskId.toString() !== input.taskId ) {
            throw new WorkItemServiceError( "TASK_MISMATCH", "WorkItem does not belong to the provided taskId." );
        }

        // -------------------------------------------------------------------------
        // 2) Build evidence rows (exactOptionalPropertyTypes-safe)
        // -------------------------------------------------------------------------
        const now = new Date();
        const label = this.safeStr( input.label );

        const newRows: LeanEvidenceRow[] = input.files.map( ( p ) => ( {
            label: label || this.safeStr( p.originalName ) || "Evidence",
            relPath: this.safeStr( p.relativePath ),
            url: this.safeStr( p.publicUrl ),
            mimeType: this.safeStr( p.mimeType ) || "application/octet-stream",
            originalName: this.safeStr( p.originalName ) || "file",
            sizeBytes: this.safeNumber( p.sizeBytes ),
            uploadedAt: now,
        } ) );

        // Dedup by relPath
        const existingRel = new Set(
            Array.isArray( existing.completionEvidenceSummary )
                ? existing.completionEvidenceSummary.map( ( e ) => e.relPath )
                : []
        );

        const safeRows = newRows.filter( ( r ) => r.relPath && r.url && !existingRel.has( r.relPath ) );
        if ( safeRows.length === 0 ) {
            return this.toWorkItemDto( existing );
        }

        // -------------------------------------------------------------------------
        // 3) Patch DB (append evidence summary)
        // -------------------------------------------------------------------------
        const updated = await WorkItemModel.findByIdAndUpdate(
            _id,
            {
                $set: {
                    updatedByUserId: this.toObjectId( input.updatedByUserId ),
                },
                $push: {
                    completionEvidenceSummary: { $each: safeRows },
                },
            },
            { new: true }
        )
            .lean<LeanWorkItem>()
            .exec();

        if ( !updated ) throw new WorkItemServiceError( "WORK_ITEM_NOT_FOUND", "WorkItem not found." );

        const dto = this.toWorkItemDto( updated );

        // -------------------------------------------------------------------------
        // 4) WS emit (best-effort)
        // -------------------------------------------------------------------------
        if ( ctx.teamCode ) {
            const memberIds = this.extractAssignedMemberIds( updated );
            this.ws.emitWorkItemUpdated(
                this.buildEmitCtx( ctx, { teamCode: ctx.teamCode, workItemId, memberUserIds: memberIds } ),
                dto
            );
        }

        return dto;
    }

    /**
     * Extract evidence packets from UploadResultPacket in a strict, field-safe way.
     * - Your uploader guarantees output.byField has ALL declared keys.
     */
    private extractEvidencePackets( result: UploadResultPacket, fieldName: string ): FileMetaPacket[] {
        const byFieldUnknown: unknown = ( result as unknown as { byField?: unknown; } ).byField;
        if ( !byFieldUnknown || typeof byFieldUnknown !== "object" ) return [];

        const byField = byFieldUnknown as Record<string, unknown>;
        const fieldPacketsUnknown = byField[ fieldName ];

        if ( !Array.isArray( fieldPacketsUnknown ) ) return [];

        return fieldPacketsUnknown.filter( ( x ): x is FileMetaPacket => {
            if ( !x || typeof x !== "object" ) return false;
            const o = x as Record<string, unknown>;
            return typeof o[ "relPath" ] === "string" && typeof o[ "url" ] === "string";
        } );
    }
    /**
     * Remove evidence rows by relPath (DB only).
     * If you want physical file delete/move, do it in controller using relPath.
     *
     * @param ctx WebSocket context
     * @param workItemId WorkItem id
     * @param input Removal input (updatedByUserId + relPaths)
     */
    public async removeEvidence(
        ctx: WorkItemWsContext,
        workItemId: string,
        input: WorkItemRemoveEvidenceInput
    ): Promise<WorkItemDto> {
        this.assertNonEmptyArray( input.relPaths, "relPaths" );

        const _id = this.toObjectId( workItemId );

        const updated = await WorkItemModel.findByIdAndUpdate(
            _id,
            {
                $set: { updatedByUserId: this.toObjectId( input.updatedByUserId ) },
                $pull: { completionEvidenceSummary: { relPath: { $in: [ ...input.relPaths ] } } },
            },
            { new: true }
        )
            .lean<LeanWorkItem>()
            .exec();

        if ( !updated ) throw new WorkItemServiceError( "WORK_ITEM_NOT_FOUND", "WorkItem not found." );

        const dto = this.toWorkItemDto( updated );

        if ( ctx.teamCode ) {
            const memberIds = this.extractAssignedMemberIds( updated );
            this.ws.emitWorkItemUpdated(
                this.buildEmitCtx( ctx, { teamCode: ctx.teamCode, workItemId, memberUserIds: memberIds } ),
                dto
            );
        }

        return dto;
    }

    // =========================================================================
    // ATOMIC OPS
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
        )
            .lean<LeanWorkItem>()
            .exec();

        if ( !updated ) throw new WorkItemServiceError( "WORK_ITEM_NOT_FOUND", "WorkItem not found." );

        const dto = this.toWorkItemDto( updated );

        if ( ctx.teamCode ) {
            this.ws.emitWorkItemUpdated(
                this.buildEmitCtx( ctx, { teamCode: ctx.teamCode, workItemId, memberUserIds: assignedToUserIds } ),
                dto
            );
        }

        return dto;
    }

    // =========================================================================
    // MEMBER ACTIVITY
    // =========================================================================

    public async appendActivity( ctx: WorkItemWsContext, workItemId: string, input: WorkItemAppendActivityInput ): Promise<MemberActivityDto> {
        const _id = this.toObjectId( workItemId );

        const workItem = await WorkItemModel.findById( _id ).lean<LeanWorkItem>().exec();
        if ( !workItem ) throw new WorkItemServiceError( "WORK_ITEM_NOT_FOUND", "WorkItem not found." );

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

        const activityDto = this.toMemberActivityDto( activityDoc.toObject() as unknown );

        await this.updateSnapshotFromActivity( workItemId, input );

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
    // Snapshot updater
    // =========================================================================

    private async updateSnapshotFromActivity( workItemId: string, activity: WorkItemAppendActivityInput ): Promise<void> {
        const setDoc: Record<string, unknown> = {
            lastActivityAt: new Date(),
        };

        if ( typeof activity.progressAfter === "number" ) {
            setDoc.progressCurrent = this.normalizeProgress( activity.progressAfter );
        }

        await WorkItemModel.updateOne( { _id: this.toObjectId( workItemId ) }, { $set: setDoc } ).exec();
    }

    // =========================================================================
    // Query builders / validators
    // =========================================================================

    private buildListQuery( filters: WorkItemListFilters ): Record<string, unknown> {
        const q: Record<string, unknown> = { teamId: this.toObjectId( filters.teamId ) };

        if ( filters.assignedToUserId ) q.assignedToUserIds = this.toObjectId( filters.assignedToUserId );
        if ( filters.status ) q.statusCurrent = filters.status;
        if ( filters.priority ) q.priority = filters.priority;

        if ( filters.dueFrom || filters.dueTo ) {
            const range: Record<string, unknown> = {};
            if ( filters.dueFrom ) range.$gte = this.toDate( filters.dueFrom );
            if ( filters.dueTo ) range.$lte = this.toDate( filters.dueTo );
            q.expectedCompleteAt = range;
        }

        if ( filters.q && filters.q.trim().length > 0 ) {
            q.workItemCode = { $regex: this.escapeRegex( filters.q.trim() ), $options: "i" };
        }

        return q;
    }

    private buildWorkItemUpdateDoc( input: WorkItemUpdateInput ): Record<string, unknown> {
        // ✅ do NOT set updatedAt manually (timestamps true => mongoose does it)
        const $set: Record<string, unknown> = {
            updatedByUserId: this.toObjectId( input.updatedByUserId ),
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

    private assertUserIsAssigned( workItemLean: LeanWorkItem, userId: string ): void {
        const uid = this.toObjectId( userId ).toString();
        const assigned = Array.isArray( workItemLean.assignedToUserIds ) ? workItemLean.assignedToUserIds.map( ( x ) => x.toString() ) : [];
        if ( !assigned.includes( uid ) ) throw new WorkItemServiceError( "NOT_ASSIGNED", "User is not assigned to this WorkItem." );
    }

    private extractAssignedMemberIds( workItemLean: LeanWorkItem ): string[] {
        return Array.isArray( workItemLean.assignedToUserIds ) ? workItemLean.assignedToUserIds.map( ( x ) => x.toString() ) : [];
    }

    private buildEmitCtx( ctx: WorkItemWsContext, patch: { teamCode?: string; workItemId?: string; memberUserIds?: string[]; } ): WorkItemWsContext {
        return {
            actor: ctx.actor,
            requestId: ctx.requestId,
            ...( patch.teamCode ? { teamCode: patch.teamCode } : {} ),
            ...( patch.workItemId ? { workItemId: patch.workItemId } : {} ),
            ...( patch.memberUserIds && patch.memberUserIds.length > 0 ? { memberUserIds: patch.memberUserIds } : {} ),
        };
    }

    // =========================================================================
    // FileUploader result normalization (STRICT + tolerant)
    // =========================================================================

    /**
     * Converts FileUploader output into FileMetaPacket[].
     * This keeps the service stable even if FileUploader returns:
     * - { packets: FileMetaPacket[] }
     * - { files: FileMetaPacket[] }
     * - FileMetaPacket[]
     * - { meta: { packets: FileMetaPacket[] } }
     */
    private extractFilePackets( result: unknown ): FileMetaPacket[] {
        const asArr = ( v: unknown ): FileMetaPacket[] => {
            if ( !Array.isArray( v ) ) return [];
            return v.filter( this.isFileMetaPacket.bind( this ) );
        };

        if ( Array.isArray( result ) ) return asArr( result );

        if ( result && typeof result === "object" ) {
            const r = result as Record<string, unknown>;

            const packets1 = asArr( r[ "packets" ] );
            if ( packets1.length ) return packets1;

            const packets2 = asArr( r[ "files" ] );
            if ( packets2.length ) return packets2;

            const meta = r[ "meta" ];
            if ( meta && typeof meta === "object" ) {
                const m = meta as Record<string, unknown>;
                const packets3 = asArr( m[ "packets" ] );
                if ( packets3.length ) return packets3;
                const packets4 = asArr( m[ "files" ] );
                if ( packets4.length ) return packets4;
            }
        }

        return [];
    }

    private isFileMetaPacket( v: unknown ): v is FileMetaPacket {
        if ( !v || typeof v !== "object" ) return false;
        const o = v as Record<string, unknown>;
        return typeof o[ "relPath" ] === "string" && typeof o[ "url" ] === "string";
    }

    // =========================================================================
    // Small safe helpers
    // =========================================================================

    private safeStr( v: unknown ): string {
        return typeof v === "string" ? v.trim() : "";
    }

    private safeNumber( v: unknown ): number {
        return typeof v === "number" && Number.isFinite( v ) ? v : 0;
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

    // =========================================================================
    // DTO Mapper (NO any)
    // =========================================================================

    private toWorkItemDto( lean: LeanWorkItem ): WorkItemDto {
        return {
            _id: lean._id.toString(),
            workItemCode: lean.workItemCode,
            teamId: lean.teamId.toString(),

            ...( lean.taskId ? { taskId: lean.taskId.toString() } : {} ),

            assignedByUserId: lean.assignedByUserId.toString(),
            assignedToUserIds: Array.isArray( lean.assignedToUserIds ) ? lean.assignedToUserIds.map( ( x ) => x.toString() ) : [],

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
                    memberProgress: lean.memberProgress.map( ( mp ) => ( {
                        userId: mp.userId.toString(),
                        progress: mp.progress,
                        status: mp.status,
                        lastActivityAt: new Date( mp.lastActivityAt ).toISOString(),
                    } ) ),
                }
                : {} ),

            ...( Array.isArray( lean.completionEvidenceSummary ) && lean.completionEvidenceSummary.length > 0
                ? {
                    completionEvidenceSummary: lean.completionEvidenceSummary.map( ( ev ) => ( {
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