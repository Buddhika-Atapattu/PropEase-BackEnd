// Path: src/api/teamManagement/teamTask.ts
// ============================================================================
// Team Task Management Router (class-based)
// ----------------------------------------------------------------------------
// Responsibilities (task-level only):
//   - Assign a new task to a team
//   - Attach evidence metadata to a task
//   - Upload evidence files for a specific task
//
// Notes:
//   - Uses the same TeamManagementModel.assignTasks[] structure
//   - Uses the same TaskEvidence / AssignedTask interfaces
//   - Pure JSON for logical operations; FileUploader for binary uploads
// ============================================================================

import express, { Request, Response, Router } from "express";
import { Types } from "mongoose";

import {
    Address,
    AssignedTask,
    GeoLocation,
    ITeamManagement,
    TaskEvidence,
} from "../../models/teamManagement/teamManagement.model";
import { FileMetaBase } from "../../types/api-message";
import { ApiResponseBuilder } from "../../utils/api-combiner.builder";
import FileUploader from "../../utils/file-uploader.helper";
import { TeamManagementModel } from "../../models/teamManagement/teamManagement.model";

export default class TeamTaskManagement {
    private readonly router: Router;

    public constructor () {
        this.router = express.Router();

        // Task JSON operations
        this.registerAssignTask();          // POST /assign-task/:teamId
        this.registerAttachEvidenceMeta();  // POST /evidence/attach/:teamId/:taskId

        // File uploads specific to tasks
        this.registerUploadTaskEvidence();  // POST /upload/evidence/:teamId/:taskId
    }

    public get route(): Router {
        return this.router;
    }

    // ========================================================================
    // Generic helpers (task-only)
    // ========================================================================

    /**
     * Legacy helper: turn an array of bodies into pure ObjectId[].
     * Used for AssignedTask.assignedMembers.
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
                }
                catch {
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
        }
        catch {
            return undefined;
        }
    }

    /**
     * Build a TaskEvidence from FileMetaBase and extra metadata sent by FE.
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
     *
     * NOTE:
     *  - `id` is generated if not provided.
     *  - This matches Option A: global unique IDs for tasks (enforced by index).
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

        const task: AssignedTask = {
            id: t.id || `TASK-${ Date.now() }`,
            name: t.name,
            description: t.description ?? "",
            status: ( t.status as AssignedTask[ "status" ] ) ?? "draft",
            priority: ( t.priority as AssignedTask[ "priority" ] ) ?? "medium",
            plannedStartAt: t.plannedStartAt ?? "",
            plannedEndAt: t.plannedEndAt ?? "",
            completedAt: t.completedAt ?? "",
            notes: t.notes ?? "",
        };

        if ( assignedMembers.length > 0 ) {
            task.assignedMembers = assignedMembers;
        }

        if ( assignedCaptain ) {
            task.assignedTaskCaptain = assignedCaptain;
        }

        if ( t.location ) {
            task.location = t.location as GeoLocation;
        }

        if ( t.address ) {
            task.address = t.address as Address;
        }

        if ( Array.isArray( t.evidence ) && t.evidence.length > 0 ) {
            task.evidence = t.evidence as TaskEvidence[];
            // or: task.evidence = t.evidence.map((e) => this.buildEvidenceFromMeta(e));
        }

        return task;
    }

    // ========================================================================
    // POST /assign-task/:teamId  (JSON)
    // ========================================================================

    private registerAssignTask(): void {
        this.router.post(
            "/assign-task/:teamId",
            async ( req: Request, res: Response ): Promise<void> => {
                try {
                    const teamId = String( req.params.teamId ?? "" ).trim();
                    if ( !teamId ) {
                        ApiResponseBuilder.validationError(
                            res,
                            "Team ID is required",
                        );
                        return;
                    }

                    const bodyTask = req.body?.task;
                    if ( !bodyTask ) {
                        ApiResponseBuilder.validationError(
                            res,
                            "Task payload is required",
                        );
                        return;
                    }

                    let newTask: AssignedTask;
                    try {
                        newTask = this.buildAssignedTaskFromBody( bodyTask );
                    }
                    catch ( err ) {
                        ApiResponseBuilder.validationError(
                            res,
                            ( err as Error ).message || "Invalid task payload",
                        );
                        return;
                    }

                    const updated = await TeamManagementModel.findOneAndUpdate(
                        { id: teamId },
                        {
                            $push: { assignTasks: newTask },
                            $set: { updatedAt: new Date().toISOString() },
                        },
                        { new: true },
                    ).exec();

                    if ( !updated ) {
                        ApiResponseBuilder.validationError(
                            res,
                            "Team not found for assign-task",
                        );
                        return;
                    }

                    ApiResponseBuilder.ok(
                        res,
                        "team",
                        updated,
                        "Task assigned successfully",
                    );
                    return;
                }
                catch ( error ) {
                    console.error( "[Error during assign-task]:\n", error );
                    ApiResponseBuilder.internalError( res, error );
                    return;
                }
            },
        );
    }

    // ========================================================================
    // POST /evidence/attach/:teamId/:taskId
    // ========================================================================

    private registerAttachEvidenceMeta(): void {
        this.router.post(
            "/evidence/attach/:teamId/:taskId",
            async ( req: Request, res: Response ): Promise<void> => {
                try {
                    const teamId = String( req.params.teamId ?? "" ).trim();
                    const taskId = String( req.params.taskId ?? "" ).trim();

                    if ( !teamId || !taskId ) {
                        ApiResponseBuilder.validationError(
                            res,
                            "Team ID and Task ID are required",
                        );
                        return;
                    }

                    const evidencesRaw = req.body?.evidences;
                    if ( !Array.isArray( evidencesRaw ) || evidencesRaw.length === 0 ) {
                        ApiResponseBuilder.validationError(
                            res,
                            "At least one evidence metadata entry is required",
                        );
                        return;
                    }

                    const evidenceDocs: TaskEvidence[] = evidencesRaw.map(
                        ( meta: unknown ) => this.buildEvidenceFromMeta( meta ),
                    );

                    const updated = await TeamManagementModel.findOneAndUpdate(
                        { id: teamId, "assignTasks.id": taskId },
                        {
                            $push: {
                                "assignTasks.$.evidence": { $each: evidenceDocs },
                            },
                            $set: { updatedAt: new Date().toISOString() },
                        },
                        { new: true },
                    ).exec();

                    if ( !updated ) {
                        ApiResponseBuilder.validationError(
                            res,
                            "Team or task not found for evidence attach",
                        );
                        return;
                    }

                    ApiResponseBuilder.ok(
                        res,
                        "team",
                        updated,
                        "Evidence metadata attached successfully",
                    );
                    return;
                }
                catch ( error ) {
                    console.error( "[Error during evidence attach]:\n", error );
                    ApiResponseBuilder.internalError( res, error );
                    return;
                }
            },
        );
    }

    // ========================================================================
    // FILE UPLOAD: POST /upload/evidence/:teamId/:taskId
    // ========================================================================

    private registerUploadTaskEvidence(): void {
        this.router.post(
            "/upload/evidence/:teamId/:taskId",
            async ( req: Request, res: Response ): Promise<void> => {
                try {
                    const teamId = String( req.params.teamId ?? "" ).trim();
                    const taskId = String( req.params.taskId ?? "" ).trim();

                    if ( !teamId || !taskId ) {
                        ApiResponseBuilder.validationError(
                            res,
                            "Team ID and Task ID are required for evidence upload",
                        );
                        return;
                    }

                    const subPath =
                        `team-management/${ teamId }/tasks/${ taskId }/evidence`;

                    const files: FileMetaBase[] =
                        await FileUploader.handleUpload( subPath, "files", req );

                    if ( !Array.isArray( files ) || files.length === 0 ) {
                        ApiResponseBuilder.validationError(
                            res,
                            "No files were uploaded for task evidence",
                        );
                        return;
                    }

                    ApiResponseBuilder.ok(
                        res,
                        "files",
                        files,
                        "Task evidence uploaded successfully",
                    );
                    return;
                }
                catch ( error ) {
                    console.error(
                        "[Error during task evidence upload]:\n",
                        error,
                    );
                    ApiResponseBuilder.internalError( res, error );
                    return;
                }
            },
        );
    }
}
