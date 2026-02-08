// Path: src/api/teamManagement/teamTask.ts
// ============================================================================
// Team Task Management Router (class-based)
// ----------------------------------------------------------------------------
// ============================================================================

import express, { Request, Response, Router } from "express";
import { Types } from "mongoose";

import {
  Address,
  AssignedTask,
  GeoLocation,
  ITeamManagement,
  TaskEvidence,
  TeamManagementModel,
  TaskTiming,
  TaskSlaPolicy,
  TaskRuntimeMetrics,
  TaskAuditMeta,
  TaskBlockedWindow,
  TaskAssigneeHistoryEntry,
  TaskCompletionConfirmation,
  TaskCompletionSignature,
  CompletionConfirmationStatus,
  CompletionSignerRole,
  TASK_STATUSES,
  TASK_PRIORITIES,
  type TaskStatus,
  type TaskPriority,
} from "../../models/teamManagement/teamManagement.model";

import { FileMetaPacket } from "../../types/api-message";
import { ApiResponseBuilder } from "../../utils/api-combiner.builder";
import FileUploader, { type UploadResultPacket } from "../../utils/file-uploader.helper";
import { ComplaintModel } from "../../models/complaint.model";

export default class TeamTaskManagement {
  /**
   * Base public URL root (relative) for team uploads.
   * NOTE: keep consistent with TeamManagement router.
   */
  private readonly PUBLIC_UPLOAD_URL_ROOT: string = "uploads/team-management";

  private readonly router: Router;

  public constructor () {
    this.router = express.Router();

    // Task JSON operations
    this.registerAssignTask(); // POST /assign-task/:teamCode
    this.registerAttachEvidenceMeta(); // POST /evidence/attach/:teamCode/:taskId

    // File uploads specific to tasks
    this.registerUploadTaskEvidence(); // POST /upload/evidence/:teamCode/:taskId

    // Get all tasks for a team (helper)
    this.router.get( "/get-tasks/:teamCode", this.getAllTasksForTeam.bind( this ) );
  }

  public get route(): Router {
    return this.router;
  }


  // ========================================================================
  // Generic helpers (task-only)
  // ========================================================================

  private buildAssignedTaskId(): string {
    // Example: TASK-LM5J8K2-8F3A1C
    const now = Date.now().toString( 36 ).toUpperCase();
    const rand = Math.random().toString( 36 ).slice( 2, 8 ).toUpperCase();
    return `TASK-${ now }-${ rand }`;
  }

  /**
   * Turn FE payload `assignedMembers` into ObjectId[]
   * Accepts BOTH:
   *   - string[]                      ["<id1>", "<id2>"]
   *   - object[]                      [{ id }, { _id }, { userId }]
   */
  private extractUserIdsFromArray( input: unknown ): Types.ObjectId[] {
    if ( !Array.isArray( input ) ) return [];

    return ( input as unknown[] )
      .map( ( u: unknown ) => {
        // ✅ Case 1: FE sends plain string IDs
        if ( typeof u === "string" ) {
          const idStr = u.trim();
          if ( !idStr ) return undefined;

          try {
            return new Types.ObjectId( idStr );
          } catch {
            return undefined;
          }
        }

        // ✅ Case 2: FE sends objects
        if ( u && typeof u === "object" ) {
          const anyU = u as { _id?: unknown; id?: unknown; userId?: unknown; };
          const id = anyU?._id ?? anyU?.id ?? anyU?.userId;

          const idStr = String( id ?? "" ).trim();
          if ( !idStr ) return undefined;

          try {
            return new Types.ObjectId( idStr );
          } catch {
            return undefined;
          }
        }

        return undefined;
      } )
      .filter( ( x ): x is Types.ObjectId => x instanceof Types.ObjectId );
  }

  /**
   * Single ObjectId (AssignedTask.assignedTaskCaptain).
   * Accepts:
   *   - string "<id>"
   *   - object { id | _id | userId }
   */
  private extractUserId( input: unknown ): Types.ObjectId | undefined {
    // ✅ Case 1: string id
    if ( typeof input === "string" ) {
      const idStr = input.trim();
      if ( !idStr ) return undefined;

      try {
        return new Types.ObjectId( idStr );
      } catch {
        return undefined;
      }
    }

    // ✅ Case 2: object with id fields
    if ( !input || typeof input !== "object" ) return undefined;

    const anyU = input as { _id?: unknown; id?: unknown; userId?: unknown; };
    const id = anyU._id ?? anyU.id ?? anyU.userId;

    const idStr = String( id ?? "" ).trim();
    if ( !idStr ) return undefined;

    try {
      return new Types.ObjectId( idStr );
    } catch {
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
      fileMeta?: FileMetaPacket;
    };

    const fileMeta: FileMetaPacket | undefined = anyMeta?.fileMeta;

    const storageKey: string = ( anyMeta?.storageKey ?? "" ).trim();
    const url: string = ( anyMeta?.url ?? storageKey ).trim();

    const evidence: TaskEvidence = {
      name: ( anyMeta?.name ?? fileMeta?.originalName ?? "evidence" ).toString(),
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

  /**
   * Build an AssignedTask from raw body payload.
   */
  private buildAssignedTaskFromBody( raw: unknown ): AssignedTask {
    const t = ( raw ?? {} ) as {
      id?: unknown;
      name?: unknown;
      description?: unknown;

      location?: unknown;
      address?: unknown;

      assignedMembers?: unknown;
      assignedTaskCaptain?: unknown;

      status?: unknown;
      priority?: unknown;

      plannedStartAt?: unknown;
      plannedEndAt?: unknown;

      timing?: unknown; // partial TaskTiming
      sla?: unknown;
      metrics?: unknown;

      blockedWindows?: unknown;
      assigneeHistory?: unknown;

      completionConfirmation?: unknown;

      evidence?: unknown;
      notes?: unknown;

      labels?: unknown;
      audit?: unknown;
    };

    const nowIso: string = new Date().toISOString();

    // ─────────────────────────────────────────────
    // Local helpers
    // ─────────────────────────────────────────────
    const asTrimmedString = ( v: unknown ): string => ( typeof v === "string" ? v.trim() : "" );

    const isPlainObject = ( v: unknown ): v is Record<string, unknown> =>
      !!v && typeof v === "object" && !Array.isArray( v );

    const ensureArray = <T = unknown>( v: unknown ): T[] => ( Array.isArray( v ) ? ( v as T[] ) : [] );

    const normalizeStatus = ( v: unknown ): TaskStatus => {
      const s = asTrimmedString( v ).toLowerCase();
      if ( !s ) return "draft";
      return ( ( ( TASK_STATUSES as readonly string[] ).includes( s ) ? s : "draft" ) as TaskStatus );
    };

    const normalizePriority = ( v: unknown ): TaskPriority => {
      const p = asTrimmedString( v ).toLowerCase();
      if ( !p ) return "medium";
      return ( ( ( TASK_PRIORITIES as readonly string[] ).includes( p ) ? p : "medium" ) as TaskPriority );
    };

    const normalizeTiming = ( v: unknown, statusLower: string ): TaskTiming => {
      const incoming: Partial<TaskTiming> = isPlainObject( v ) ? ( v as Partial<TaskTiming> ) : {};

      // NOTE: exactOptionalPropertyTypes-safe:
      // - we can set nulls (because TaskTiming fields are `... | null`)
      // - we avoid putting `undefined` into any field
      const timing: TaskTiming = {
        ...incoming,
        createdAt: typeof incoming.createdAt === "string" && incoming.createdAt ? incoming.createdAt : nowIso,
        updatedAt: nowIso,

        firstResponseAt:
          typeof incoming.firstResponseAt === "string" ? incoming.firstResponseAt : ( incoming.firstResponseAt ?? null ),
        startedAt: typeof incoming.startedAt === "string" ? incoming.startedAt : ( incoming.startedAt ?? null ),
        lastBlockedAt:
          typeof incoming.lastBlockedAt === "string" ? incoming.lastBlockedAt : ( incoming.lastBlockedAt ?? null ),

        completedAt: typeof incoming.completedAt === "string" ? incoming.completedAt : ( incoming.completedAt ?? null ),
        confirmedAt: typeof incoming.confirmedAt === "string" ? incoming.confirmedAt : ( incoming.confirmedAt ?? null ),
        cancelledAt: typeof incoming.cancelledAt === "string" ? incoming.cancelledAt : ( incoming.cancelledAt ?? null ),
      };

      // Status-driven anchors
      if ( statusLower === "in_progress" && !timing.startedAt ) timing.startedAt = nowIso;
      if ( statusLower === "blocked" ) timing.lastBlockedAt = nowIso;

      if ( ( statusLower === "completed" || statusLower === "completed_pending_confirmation" ) && !timing.completedAt ) {
        timing.completedAt = nowIso;
      }

      if ( statusLower === "cancelled" && !timing.cancelledAt ) timing.cancelledAt = nowIso;

      return timing;
    };

    const normalizeCompletionConfirmation = ( v: unknown ): TaskCompletionConfirmation | undefined => {
      if ( !isPlainObject( v ) ) return undefined;

      const cc = v as Partial<TaskCompletionConfirmation>;

      const statusRaw = asTrimmedString( cc.status );
      const status: CompletionConfirmationStatus = ( statusRaw ? ( statusRaw as CompletionConfirmationStatus ) : "not_required" );

      // Build base with REQUIRED field only.
      // Then conditionally add optional fields ONLY if defined (no `undefined` assigned).
      const out: TaskCompletionConfirmation = { status };

      const requiredRoles = Array.isArray( cc.requiredRoles ) ? ( cc.requiredRoles as CompletionSignerRole[] ) : undefined;
      if ( requiredRoles ) out.requiredRoles = requiredRoles;

      const signatures = Array.isArray( cc.signatures ) ? ( cc.signatures as TaskCompletionSignature[] ) : undefined;
      if ( signatures ) out.signatures = signatures;

      if ( typeof cc.confirmedAt === "string" ) out.confirmedAt = cc.confirmedAt;
      if ( cc.confirmedByUserId ) out.confirmedByUserId = cc.confirmedByUserId;
      if ( typeof cc.confirmedByUsername === "string" ) out.confirmedByUsername = cc.confirmedByUsername;

      if ( typeof cc.rejectedAt === "string" ) out.rejectedAt = cc.rejectedAt;
      if ( cc.rejectedByUserId ) out.rejectedByUserId = cc.rejectedByUserId;
      if ( typeof cc.rejectedByUsername === "string" ) out.rejectedByUsername = cc.rejectedByUsername;
      if ( typeof cc.rejectReason === "string" ) out.rejectReason = cc.rejectReason;

      return out;
    };

    // ─────────────────────────────────────────────
    // Required fields
    // ─────────────────────────────────────────────
    const name: string = asTrimmedString( t.name );
    if ( !name ) throw new Error( "Task name is required." );

    const idTrimmed: string = asTrimmedString( t.id );

    const status: TaskStatus = normalizeStatus( t.status );
    const priority: TaskPriority = normalizePriority( t.priority );
    const statusLower = status.toLowerCase();

    const assignedMembers = this.extractUserIdsFromArray( t.assignedMembers );
    const assignedCaptain = this.extractUserId( t.assignedTaskCaptain );

    const timing: TaskTiming = normalizeTiming( t.timing, statusLower );

    // ─────────────────────────────────────────────
    // Build task
    // ─────────────────────────────────────────────
    const task: AssignedTask = {
      id: idTrimmed || this.buildAssignedTaskId(),
      name,
      description: typeof t.description === "string" ? t.description : "",

      // ✅ no undefined possible now
      status,
      priority,

      plannedStartAt: typeof t.plannedStartAt === "string" ? t.plannedStartAt : "",
      plannedEndAt: typeof t.plannedEndAt === "string" ? t.plannedEndAt : "",

      timing,

      notes: typeof t.notes === "string" ? t.notes : "",

      // Arrays default safely
      blockedWindows: ensureArray<TaskBlockedWindow>( t.blockedWindows ),
      assigneeHistory: ensureArray<TaskAssigneeHistoryEntry>( t.assigneeHistory ),
      labels: ensureArray<string>( t.labels ),

      evidence: ensureArray<TaskEvidence>( t.evidence ),
    };

    if ( assignedMembers.length > 0 ) task.assignedMembers = assignedMembers;
    if ( assignedCaptain ) task.assignedTaskCaptain = assignedCaptain;

    if ( t.location ) task.location = t.location as GeoLocation;
    if ( t.address ) task.address = t.address as Address;

    if ( isPlainObject( t.sla ) ) task.sla = t.sla as TaskSlaPolicy;
    if ( isPlainObject( t.metrics ) ) task.metrics = t.metrics as TaskRuntimeMetrics;
    if ( isPlainObject( t.audit ) ) task.audit = t.audit as TaskAuditMeta;

    const cc = normalizeCompletionConfirmation( t.completionConfirmation );
    if ( cc ) task.completionConfirmation = cc;

    return task;
  }

  // ========================================================================
  // POST /assign-task/:teamCode  (JSON)
  // Body: { task: {...} }   OR just {...} (we support both)
  // ========================================================================

  private registerAssignTask(): void {
    this.router.post( "/assign-task/:teamCode", async ( req: Request, res: Response ): Promise<void> => {
      try {
        const teamCode: string = String( req.params.teamCode ?? "" ).trim();
        if ( !teamCode ) {
          ApiResponseBuilder.validationError( res, "Team code is required" );
          return;
        }

        // Accept either { task: {...} } or direct {...}
        const bodyTask: any = ( req.body as any )?.task ?? req.body;
        if ( !bodyTask ) {
          ApiResponseBuilder.validationError( res, "Task payload is required" );
          return;
        }

        // ✅ complaint code should be read from the task payload (bodyTask)
        const complaintCode: string = String( bodyTask?.compliantId ?? "" ).trim();

        // ✅ If complaintCode exists, update complaint first
        if ( complaintCode ) {
          const updatedComplaint = await ComplaintModel.findOneAndUpdate(
            { code: complaintCode },
            {
              $set: {
                status: "in_progress",
                updatedAt: new Date().toISOString(),
              },
            },
            { new: true }
          ).exec();

          if ( !updatedComplaint ) {
            ApiResponseBuilder.conflict( res, "Failed to update complaint (code not found)" );
            return;
          }
        }

        let newTask: AssignedTask;
        try {
          newTask = this.buildAssignedTaskFromBody( bodyTask );
        } catch ( err ) {
          ApiResponseBuilder.validationError( res, ( err as Error ).message || "Invalid task payload" );
          return;
        }

        const nowIso = new Date().toISOString();

        const updatedTeam: ITeamManagement | null = await TeamManagementModel.findOneAndUpdate(
          { teamCode },
          {
            $push: { assignTasks: newTask },
            $set: {
              updatedAt: nowIso,
              "audit.lastActivityAt": nowIso, // ✅ KPI friendly
            },
          },
          { new: true }
        ).exec();

        if ( !updatedTeam ) {
          ApiResponseBuilder.validationError( res, "Team not found for assign-task" );
          return;
        }

        ApiResponseBuilder.ok( res, "team", updatedTeam, "Task assigned successfully" );
        return;
      } catch ( error ) {
        console.error( "[Error:] [TeamTaskManagement:assign-task] Failed.\n", error );
        ApiResponseBuilder.internalError( res, error );
        return;
      }
    } );
  }

  // ========================================================================
  // POST /evidence/attach/:teamCode/:taskId
  // Body: { evidences: [...] }
  // ========================================================================

  private registerAttachEvidenceMeta(): void {
    this.router.post( "/evidence/attach/:teamCode/:taskId", async ( req: Request, res: Response ): Promise<void> => {
      try {
        const teamCode = String( req.params.teamCode ?? "" ).trim();
        const taskId = String( req.params.taskId ?? "" ).trim();

        if ( !teamCode || !taskId ) {
          ApiResponseBuilder.validationError( res, "Team code and Task ID are required" );
          return;
        }

        const evidencesRaw = ( req.body as any )?.evidences;
        if ( !Array.isArray( evidencesRaw ) || evidencesRaw.length === 0 ) {
          ApiResponseBuilder.validationError( res, "At least one evidence metadata entry is required" );
          return;
        }

        const evidenceDocs: TaskEvidence[] = evidencesRaw.map( ( meta: unknown ) => this.buildEvidenceFromMeta( meta ) );

        const nowIso = new Date().toISOString();

        const updated = await TeamManagementModel.findOneAndUpdate(
          { teamCode, "assignTasks.id": taskId },
          [
            {
              $set: {
                updatedAt: nowIso,
                "audit.lastActivityAt": nowIso,
              },
            },
            {
              $set: {
                assignTasks: {
                  $map: {
                    input: "$assignTasks",
                    as: "t",
                    in: {
                      $cond: [
                        { $eq: [ "$$t.id", taskId ] },
                        {
                          $mergeObjects: [
                            "$$t",
                            {
                              evidence: {
                                $concatArrays: [ { $ifNull: [ "$$t.evidence", [] ] }, evidenceDocs ],
                              },
                              timing: {
                                $mergeObjects: [
                                  { $ifNull: [ "$$t.timing", {} ] },
                                  {
                                    updatedAt: nowIso,
                                    firstResponseAt: { $ifNull: [ "$$t.timing.firstResponseAt", nowIso ] },
                                  },
                                ],
                              },
                            },
                          ],
                        },
                        "$$t",
                      ],
                    },
                  },
                },
              },
            },
          ],
          { new: true }
        ).exec();

        if ( !updated ) {
          ApiResponseBuilder.validationError( res, "Team or task not found for evidence attach" );
          return;
        }

        ApiResponseBuilder.ok( res, "team", updated, "Evidence metadata attached successfully" );
        return;
      } catch ( error ) {
        console.error( "[Error:] [TeamTaskManagement:evidence-attach] Failed.\n", error );
        ApiResponseBuilder.internalError( res, error );
        return;
      }
    } );
  }

  // ========================================================================
  // FILE UPLOAD: POST /upload/evidence/:teamCode/:taskId
  // Field name: "files"
  // ========================================================================

  private registerUploadTaskEvidence(): void {
    this.router.post( "/upload/evidence/:teamCode/:taskId", async ( req: Request, res: Response ): Promise<void> => {
      try {
        const teamCode = String( req.params.teamCode ?? "" ).trim();
        const taskId = String( req.params.taskId ?? "" ).trim();

        if ( !teamCode || !taskId ) {
          ApiResponseBuilder.validationError( res, "Team code and Task ID are required for evidence upload" );
          return;
        }

        const subPath = `team-management/${ teamCode }/tasks/${ taskId }/evidence`;
        const files: UploadResultPacket = await FileUploader.handleUpload( subPath, "files", req );

        if ( !Array.isArray( files.byField.files ) || files.byField.files.length === 0 ) {
          ApiResponseBuilder.validationError( res, "No files were uploaded for task evidence" );
          return;
        }

        // Optional: return also the public URLs (consistent with other router)
        const root = `${ req.protocol }://${ req.get( "host" ) }`;
        const filesWithUrls = files.byField.files.map( ( f ) => {
          const relativePath = `${ this.PUBLIC_UPLOAD_URL_ROOT }/${ teamCode }/tasks/${ taskId }/evidence/${ f.storedName }`;
          return {
            ...f,
            url: `${ root }/${ relativePath }`,
            storageKey: relativePath,
          };
        } );

        ApiResponseBuilder.ok( res, "files", filesWithUrls as any, "Task evidence uploaded successfully" );
        return;
      } catch ( error ) {
        console.error( "[Error:] [TeamTaskManagement:upload-evidence] Failed.\n", error );
        ApiResponseBuilder.internalError( res, error );
        return;
      }
    } );
  }




  // ========================================================================
  // GET /get-tasks/:teamCode
  // ========================================================================

  private async getAllTasksForTeam( req: Request, res: Response ): Promise<void> {
    try {
      const teamCode = String( req.params.teamCode ?? "" ).trim();
      if ( !teamCode ) {
        ApiResponseBuilder.validationError( res, "Team code is required to get tasks" );
        return;
      }

      const team: ITeamManagement | null = await TeamManagementModel.findOne( { teamCode } ).exec();

      if ( !team ) {
        ApiResponseBuilder.validationError( res, "Team not found for getAllTasksForTeam" );
        return;
      }

      const tasks = team.assignTasks || [];

      ApiResponseBuilder.ok( res, "other", { tasks }, "Tasks retrieved successfully" );
      return;
    } catch ( error ) {
      console.error( "[Error:] [TeamTaskManagement:get-tasks] Failed.\n", error );
      ApiResponseBuilder.internalError( res, error );
      return;
    }
  }
}
