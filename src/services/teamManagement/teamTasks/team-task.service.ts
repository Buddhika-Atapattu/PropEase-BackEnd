// Path: src/services/teamManagement/team-task.service.ts
// =============================================================================
// TeamTaskService — rebuilt to match TeamTaskModel + team-tasks.type.ts
// =============================================================================
// ✅ Class-based service (PropEase rule)
// ✅ DeadlinePolicy aware (filters/sorts use "deadlinePolicy.dueAt")
// ✅ Lean typing (NO mongoose Document typing in DTO mappers)
// ✅ DTO mappers do NOT assign undefined to optionals (safe for strict TS)
// ✅ Pagination normalized (page/limit/skip) + legacy pageIndex tolerated
// ✅ RecycleBin delete uses JSON-safe snapshot + scanned file packets
// ✅ WS emits are DTO-first and ctx is resolved with usernames when needed
// =============================================================================

import type { Request } from "express";
import { Types, type FilterQuery, type PipelineStage, type ClientSession } from "mongoose";

import type { AuthUser, FileMetaPacket, ISODateString } from "../../../types/common";

import { TEAM_DOMAINS, type TeamDomain } from "../../../types/teamManagement/teamMain/teamManagement.types";

import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  type TaskDeadlinePolicy,
  type TaskUrgencyLevel,
  type TaskPriority,
  type TaskStatus,
  type TaskTiming,
  type TaskRuntimeMetrics,
  type TaskEvidence,
  type TaskAuditMeta,
  type TaskBlockedWindow,
  type TaskCompletionConfirmation,
  type TeamTaskLoadMode,
  type TeamTaskSortInput,
  type TeamTaskFilterInput,
  type PaginationInput,
  type ListResult,
  type TeamTaskDto,
  type CreateTeamTaskInput,
  type UpdateTeamTaskInput,
  type LeanTeamTask,
  type LeanUserLite,
  type TaskUserLiteDto,
  type TaskUsersResult,
  type TeamTaskKeyValuesMetaDto,
} from "../../../types/teamManagement/teamTasks/team-tasks.type";

import { TeamTaskModel } from "../../../models/teamManagement/teamTasks/teamTask.model";
import { UserModel, type User } from "../../../models/user.model";

import { TeamTaskSocketService, type TeamTaskWsContext } from "./team-task.socket.service";

import {
  RecycleBinDomainDeleteService,
  type DomainDeletePlan,
} from "../../../services/recyclebin/recyclebin-domain-delete.service";

import { FileMetaPacketBuilder } from "../../../utils/files/file-meta-packet.builder";
import { ApiGuardExport } from "../../../guard/api-router.guard";
import type { RecycleRecordResult } from "../../recyclebin/recyclebin-engine.service";

// ----------------------------------------------------------------------------
// Local lean shapes used by service
// ----------------------------------------------------------------------------
type LeanRow = LeanTeamTask;

type AdvancedRow = LeanTeamTask & {
  assignedMember?: string[];
  captainUsername?: string;
};

type LabelsGroupRow = { _id: string; };

type UserModelKeyFields = keyof User;

export class TeamTaskService {
  /**
   * Why this exists
   * - Centralized domain delete handler to ensure recyclebin snapshot + file move + transaction discipline.
   * - Keeps service methods lean and consistent across modules.
   */
  private readonly recycleBinDomainDeleteService: RecycleBinDomainDeleteService =
    new RecycleBinDomainDeleteService();

  /**
   * Why this exists
   * - DTO-first WS emits for task create/update/delete/bulk refresh.
   * - Avoids leaking DB entities or mongoose types into realtime layer.
   */
  private readonly socket: TeamTaskSocketService = new TeamTaskSocketService();

  /**
   * Allowed urgency strings (kept as const to avoid TS enum runtime cost).
   * IMPORTANT: must align with TaskUrgencyLevel union in team-tasks.type.ts
   */
  private static readonly URGENCY_VALUES = [ "low", "medium", "high", "critical" ] as const;

  public constructor () {}

  // ──────────────────────────────────────────────────────────────────────────
  // GET ONE
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Load a single task by Mongo _id.
   *
   * Why this method exists
   * - Controller/UI often navigates to a specific task screen by mongo id.
   * - Supports both "minimal" (fast) and "advanced" (enriched) projections.
   *
   * @param taskMongoId
   * - Expected: MongoDB ObjectId as string
   * - Usage: identifies the TeamTask document in TeamTaskModel
   *
   * @param mode
   * - Expected: "minimal" | "advanced"
   * - Usage: controls whether we return enriched fields (captainUsername, assignedMember usernames)
   */
  public async getByMongoId( taskMongoId: string, mode: TeamTaskLoadMode = "minimal" ): Promise<TeamTaskDto | null> {
    if ( mode === "advanced" ) {
      return await this.getByMongoIdAdvanced( taskMongoId );
    }

    const doc = await TeamTaskModel.findById( this.toObjectId( taskMongoId ) ).lean<LeanRow>().exec();
    if ( !doc ) return null;

    return this.toDtoMinimal( doc );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // LIST (minimal / advanced)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * List tasks with filters + pagination + sorting and return DTO list payload.
   *
   * Why this method exists
   * - Single entry point for both minimal and advanced listing.
   * - Keeps controller thin and consistent across multiple list endpoints.
   *
   * @param filters
   * - Expected: TeamTaskFilterInput
   * - Usage: team/domain/status/priority/date ranges/text search/evidence flags
   *
   * @param page
   * - Expected: PaginationInput (page/limit/skip)
   * - Usage: supports both modern and legacy runtime shapes
   *
   * @param sort
   * - Expected: TeamTaskSortInput
   * - Usage: supports special key "dueAt" which maps to deadlinePolicy.dueAt
   *
   * @param mode
   * - Expected: TeamTaskLoadMode
   * - Usage: "advanced" uses aggregation lookups for usernames
   */
  public async list(
    filters: TeamTaskFilterInput,
    page: PaginationInput,
    sort: TeamTaskSortInput,
    mode: TeamTaskLoadMode
  ): Promise<ListResult<TeamTaskDto>> {
    return mode === "advanced"
      ? await this.listAdvanced( filters, page, sort )
      : await this.listMinimal( filters, page, sort );
  }

  /**
   * Minimal list: simple find() + lean() + map.
   *
   * @param filters
   * - Expected: TeamTaskFilterInput
   *
   * @param page
   * - Expected: PaginationInput
   *
   * @param sort
   * - Expected: TeamTaskSortInput
   */
  public async listMinimal(
    filters: TeamTaskFilterInput,
    page: PaginationInput,
    sort: TeamTaskSortInput
  ): Promise<ListResult<TeamTaskDto>> {
    const total = await this.count( filters );
    if ( total <= 0 ) return { items: [], other: { total: 0 } };

    const query = this.buildFindQuery( filters );
    const sortDoc = this.buildFindSort( sort );

    const skip = this.normalizeSkip( page );
    const limit = this.normalizeLimit( page );

    const docs = await TeamTaskModel.find( query )
      .sort( sortDoc )
      .skip( skip )
      .limit( limit )
      .lean<LeanRow[]>()
      .exec();

    const items = Array.isArray( docs ) ? docs.map( ( d ) => this.toDtoMinimal( d ) ) : [];
    return { items, other: { total } };
  }

  /**
   * Advanced list: aggregation pipeline with user lookups and username mapping.
   *
   * @param filters
   * - Expected: TeamTaskFilterInput
   *
   * @param page
   * - Expected: PaginationInput
   *
   * @param sort
   * - Expected: TeamTaskSortInput
   */
  public async listAdvanced(
    filters: TeamTaskFilterInput,
    page: PaginationInput,
    sort: TeamTaskSortInput
  ): Promise<ListResult<TeamTaskDto>> {
    const total = await this.count( filters );
    if ( total <= 0 ) return { items: [], other: { total: 0 } };

    const match = this.buildAggregateMatch( filters );
    const pipeline = this.buildAdvancedPipeline( match, page, sort );

    const rows = await TeamTaskModel.aggregate<AdvancedRow>( pipeline ).exec();
    const safeRows: AdvancedRow[] = Array.isArray( rows ) ? rows : [];

    const items = safeRows.map( ( r ) => this.toDtoAdvanced( r ) );
    return { items, other: { total } };
  }

  /**
   * Convenience method for "all tasks for team" endpoints.
   *
   * Why this method exists
   * - Your controller endpoint only has teamCode + list mode + pagination.
   * - Keeps controller clean and delegates list details to service.
   *
   * @param teamCode
   * - Expected: team code string (ex: "TEAM-001")
   * - Usage: filter tasks by team
   *
   * @param mode
   * - Expected: TeamTaskLoadMode
   * - Usage: "minimal" or "advanced"
   *
   * @param queries
   * - Expected: { page: number; limit: number }
   * - Usage: controller-level pagination extracted from req.query
   */
  public async getAllForTeam(
    teamCode: string,
    mode: TeamTaskLoadMode,
    queries: { page: number; limit: number; }
  ): Promise<TeamTaskDto[]> {
    const filters: TeamTaskFilterInput = { teamCode };
    const page: PaginationInput = { page: queries.page ?? 0, limit: queries.limit ?? 1000 };
    const sort: TeamTaskSortInput = { key: "createdAt", dir: "desc" };

    const result = await this.list( filters, page, sort, mode );
    return result.items;
  }


  /**
   * Get total number of tasks for a specific team.
   *
   * Why this method exists
   * - Frequently used by dashboards (Team Overview, KPI widgets, header counters).
   * - Avoids duplicating filter-building logic in controllers.
   * - Delegates actual counting logic to the centralized `count()` method
   *   to ensure consistent filter behavior across the system.
   *
   * Architectural reasoning
   * - Service layer should own all domain query logic.
   * - Controller should not construct filter objects directly.
   * - Keeps pagination and counter endpoints aligned (single source of truth).
   *
   * @param teamCode
   * - Expected: string (non-empty team identifier, e.g., "TEAM-001")
   * - Usage: Filters tasks belonging only to this team.
   * - Validation Responsibility: Controller should validate non-empty string
   *   before calling this method (service assumes trusted input).
   *
   * @returns Promise<number>
   * - Total count of tasks associated with the given teamCode.
   * - Returns 0 if no tasks exist.
   *
   * Keep in mind
   * - This method performs a database countDocuments() operation.
   * - For very large datasets, ensure appropriate indexing on `teamCode`
   *   in TeamTaskModel for optimal performance.
   * - This method does NOT check team existence. If teamCode is invalid,
   *   it will simply return 0.
   */
  public async getAllTasksCountForTeam( teamCode: string ): Promise<number> {
    const filters: TeamTaskFilterInput = { teamCode };
    return await this.count( filters );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // KEY VALUES (META)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Get meta key-values to populate UI dropdowns/filters.
   *
   * Why this method exists
   * - UI needs canonical domains/statuses/priorities and distinct labels for a team/context.
   * - Avoids FE hardcoding and keeps data-driven filtering consistent.
   *
   * @param filters
   * - Optional narrowing filters for label discovery.
   * - Expected:
   *   - teamCode?: string
   *   - teamMongoId?: string (ObjectId string)
   *   - domain?: TeamDomain
   *   - status?: TaskStatus
   */
  public async getKeyValues( filters?: {
    teamCode?: string;
    teamMongoId?: string;
    domain?: TeamDomain;
    status?: TaskStatus;
  } ): Promise<TeamTaskKeyValuesMetaDto> {
    const base: TeamTaskKeyValuesMetaDto = {
      domains: TEAM_DOMAINS,
      statuses: TASK_STATUSES,
      priorities: TASK_PRIORITIES,
    };

    const match: Record<string, unknown> = {};
    if ( filters?.teamCode ) match.teamCode = filters.teamCode;
    if ( filters?.teamMongoId ) match.teamMongoId = this.toObjectId( filters.teamMongoId );
    if ( filters?.domain ) match.domain = filters.domain;
    if ( filters?.status ) match.status = filters.status;

    const pipeline: PipelineStage[] = [
      { $match: match },
      { $unwind: { path: "$labels", preserveNullAndEmptyArrays: false } },
      { $group: { _id: "$labels" } },
      { $sort: { _id: 1 } },
      { $limit: 200 },
    ];

    const rows = await TeamTaskModel.aggregate<LabelsGroupRow>( pipeline ).exec();

    const distinctLabels: string[] = Array.isArray( rows )
      ? rows.map( ( r ) => ( typeof r._id === "string" ? r._id : "" ) ).filter( Boolean )
      : [];

    return {
      ...base,
      ...( distinctLabels.length > 0 ? { distinctLabels } : {} ),
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // COUNT
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Count tasks matching filters.
   *
   * Why this method exists
   * - Paginator requires total result count.
   * - Keeps list methods consistent and testable.
   *
   * @param filters
   * - Expected: TeamTaskFilterInput
   */
  public async count( filters: TeamTaskFilterInput ): Promise<number> {
    const query = this.buildFindQuery( filters );
    return await TeamTaskModel.countDocuments( query ).exec();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // CRUD
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Create a new TeamTask.
   *
   * Why this method exists
   * - Centralized validation + canonical timestamp anchors.
   * - WS emits "task.created" with DTO-first payload.
   *
   * @param input
   * - Expected: CreateTeamTaskInput
   * - Usage: task creation payload (teamCode, domain, name, etc.)
   *
   * @param ctx
   * - Optional WS context used by socket layer (audience routing + enrichment)
   * - If ctx.assignedMember is missing, service will resolve usernames.
   */
  public async create( input: CreateTeamTaskInput, ctx?: TeamTaskWsContext ): Promise<TeamTaskDto> {
    this.assertDomain( input.domain );
    this.assertStatus( input.status );
    this.assertPriority( input.priority );

    const nowIso: ISODateString = new Date().toISOString();

    const created = await TeamTaskModel.create( {
      id: input.id,

      teamCode: input.teamCode,
      teamMongoId: input.teamMongoId,
      domain: input.domain,

      name: input.name,
      ...( typeof input.description === "string" ? { description: input.description } : {} ),

      ...( input.location ? { location: input.location } : {} ),
      ...( input.address ? { address: input.address } : {} ),

      ...( Array.isArray( input.assignedMembers ) ? { assignedMembers: input.assignedMembers } : {} ),
      ...( input.assignedTaskCaptain ? { assignedTaskCaptain: input.assignedTaskCaptain } : {} ),

      ...( typeof input.plannedStartAt === "string" && input.plannedStartAt.trim()
        ? { plannedStartAt: input.plannedStartAt.trim() }
        : {} ),
      ...( typeof input.plannedEndAt === "string" && input.plannedEndAt.trim()
        ? { plannedEndAt: input.plannedEndAt.trim() }
        : {} ),

      status: input.status ?? "draft",
      priority: input.priority ?? "medium",

      timing: input.timing ? this.cleanTiming( input.timing ) : { createdAt: nowIso, updatedAt: nowIso },

      ...( input.deadlinePolicy ? { deadlinePolicy: this.cleanDeadlinePolicy( input.deadlinePolicy ) } : {} ),
      ...( input.metrics ? { metrics: this.cleanMetrics( input.metrics ) } : {} ),

      ...( Array.isArray( input.evidence ) ? { evidence: input.evidence } : {} ),

      ...( typeof input.notes === "string" && input.notes.trim() ? { notes: input.notes.trim() } : {} ),
      ...( Array.isArray( input.labels ) ? { labels: this.cleanStringArray( input.labels ) } : {} ),

      ...( input.audit ? { audit: this.cleanAudit( input.audit ) } : {} ),

      createdAt: nowIso,
      updatedAt: nowIso,
    } );

    const dto = this.toDtoMinimal( created.toObject() as unknown as LeanRow );

    const ctxWithUsers = await this.withResolvedCtx( dto, ctx );
    this.socket.emitTaskCreated( dto, ctxWithUsers );

    return dto;
  }

  /**
   * Update a task using $set/$unset (never assign undefined).
   *
   * Why this method exists
   * - exact optional handling: optional fields are either set with value or unset.
   * - Avoids mixing "replacement doc" updates (dangerous) with update operators.
   *
   * @param taskMongoId
   * - Expected: Mongo ObjectId string
   * - Usage: identifies the task to update
   *
   * @param input
   * - Expected: UpdateTeamTaskInput
   * - Usage: patch payload. null means "unset", value means "set"
   *
   * @param ctx
   * - Optional TeamTaskWsContext for WS routing; usernames are resolved if missing.
   */
  public async update( taskMongoId: string, input: UpdateTeamTaskInput, ctx?: TeamTaskWsContext ): Promise<TeamTaskDto | null> {
    if ( typeof input.domain !== "undefined" && input.domain !== null ) this.assertDomain( input.domain );
    if ( typeof input.status !== "undefined" && input.status !== null ) this.assertStatus( input.status );
    if ( typeof input.priority !== "undefined" && input.priority !== null ) this.assertPriority( input.priority );

    const $set: Record<string, unknown> = {};
    const $unset: Record<string, 1> = {};

    if ( typeof input.name === "string" ) $set.name = input.name;
    if ( typeof input.description === "string" ) $set.description = input.description;

    if ( input.location === null ) $unset.location = 1;
    else if ( input.location ) $set.location = input.location;

    if ( input.address === null ) $unset.address = 1;
    else if ( input.address ) $set.address = input.address;

    if ( input.assignedMembers === null ) $unset.assignedMembers = 1;
    else if ( Array.isArray( input.assignedMembers ) ) $set.assignedMembers = input.assignedMembers;

    if ( input.assignedTaskCaptain === null ) $unset.assignedTaskCaptain = 1;
    else if ( input.assignedTaskCaptain ) $set.assignedTaskCaptain = input.assignedTaskCaptain;

    if ( input.plannedStartAt === null ) $unset.plannedStartAt = 1;
    else if ( typeof input.plannedStartAt === "string" && input.plannedStartAt.trim() ) {
      $set.plannedStartAt = input.plannedStartAt.trim();
    }

    if ( input.plannedEndAt === null ) $unset.plannedEndAt = 1;
    else if ( typeof input.plannedEndAt === "string" && input.plannedEndAt.trim() ) {
      $set.plannedEndAt = input.plannedEndAt.trim();
    }

    if ( input.status === null ) $unset.status = 1;
    else if ( typeof input.status === "string" ) $set.status = input.status;

    if ( input.priority === null ) $unset.priority = 1;
    else if ( typeof input.priority === "string" ) $set.priority = input.priority;

    if ( input.domain === null ) $unset.domain = 1;
    else if ( typeof input.domain === "string" ) $set.domain = input.domain;

    if ( input.timing === null ) $unset.timing = 1;
    else if ( input.timing ) $set.timing = this.cleanTiming( input.timing );

    if ( input.deadlinePolicy === null ) $unset.deadlinePolicy = 1;
    else if ( input.deadlinePolicy ) $set.deadlinePolicy = this.cleanDeadlinePolicy( input.deadlinePolicy );

    if ( input.metrics === null ) $unset.metrics = 1;
    else if ( input.metrics ) $set.metrics = this.cleanMetrics( input.metrics );

    if ( input.notes === null ) $unset.notes = 1;
    else if ( typeof input.notes === "string" ) $set.notes = input.notes;

    if ( input.labels === null ) $unset.labels = 1;
    else if ( Array.isArray( input.labels ) ) $set.labels = this.cleanStringArray( input.labels );

    if ( input.completionConfirmation === null ) $unset.completionConfirmation = 1;
    else if ( input.completionConfirmation ) $set.completionConfirmation = input.completionConfirmation;

    if ( input.audit === null ) $unset.audit = 1;
    else if ( input.audit ) $set.audit = this.cleanAudit( input.audit );

    $set.updatedAt = new Date().toISOString();

    const updateDoc: Record<string, unknown> = {
      ...( Object.keys( $set ).length > 0 ? { $set } : {} ),
      ...( Object.keys( $unset ).length > 0 ? { $unset } : {} ),
    };

    if ( Object.keys( updateDoc ).length <= 0 ) {
      return await this.getByMongoId( taskMongoId, "minimal" );
    }

    const updated = await TeamTaskModel.findByIdAndUpdate( this.toObjectId( taskMongoId ), updateDoc, { new: true } )
      .lean<LeanRow>()
      .exec();

    if ( !updated ) return null;

    const dto = this.toDtoMinimal( updated );
    const ctxWithUsers = await this.withResolvedCtx( dto, ctx );

    this.socket.emitTaskUpdated( dto, ctxWithUsers );
    return dto;
  }

  /**
   * Delete a task with RecycleBin support.
   *
   * Why this method exists
   * - Soft delete must be durable: snapshot first, move files, then delete DB record.
   * - Ensures restore/purge capability and audit trace.
   *
   * @param taskMongoId
   * - Expected: Mongo ObjectId string
   *
   * @param req
   * - Expected: Express Request
   * - Usage: used to resolve AuthUser and to build absolute public URLs when scanning file packets
   *
   * @param ctx
   * - Optional WS context for routing
   */
  public async delete( taskMongoId: string, req: Request, ctx?: TeamTaskWsContext ): Promise<{
    entry: RecycleRecordResult;
  } | null> {
    const existing = await TeamTaskModel.findById( this.toObjectId( taskMongoId ) ).lean<LeanRow>().exec();
    if ( !existing ) return null;

    const actor: AuthUser | null = await ApiGuardExport.GetAuthUser( req );
    if ( !actor ) {
      throw new Error( "Unauthorized: unable to identify user" );
    }

    // IMPORTANT:
    // - your project stores public assets under top-level "public/"
    // - never use leading "/" for Electron compatibility
    const rootPublicRel = `public/uploads/teamManagement/teamTasks/${ existing.teamCode }/${ String(
      existing._id ?? existing.id
    ) }`;

    const filesScan: FileMetaPacket[] = await FileMetaPacketBuilder.scanTree( {
      rootPathLike: rootPublicRel,
      req,
      bucket: "taskDocs",
    } );

    const deletePlan: DomainDeletePlan<Record<string, unknown>> = {
      sourceKey: "teamTask",
      label: [ "Team Task", existing.name ?? String( existing._id ?? existing.id ) ].join( " - " ),
      refId: String( existing._id ?? existing.id ),
      snapshotData: this.toJsonSafeSnapshot( existing ),
      collectionName: TeamTaskModel.collection.name,
      files: filesScan,
      deleteDbRecord: async ( session?: ClientSession ): Promise<void> => {
        const opts = session ? { session } : {};
        await TeamTaskModel.deleteOne( { _id: this.toObjectId( taskMongoId ) }, { opts } ).exec();
      },
    };

    const deleted = await this.recycleBinDomainDeleteService.deleteWithRecycleBin( actor, deletePlan, req );

    const dto = this.toDtoMinimal( existing );
    const ctxWithUsers = await this.withResolvedCtx( dto, ctx );

    this.socket.emitTaskDeleted( dto, ctxWithUsers );
    return deleted;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Evidence
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Append evidence items to a task.
   *
   * Why this method exists
   * - Evidence uploads are often handled in controller and then appended here.
   * - Uses $push/$each and emits WS updated.
   *
   * @param taskMongoId
   * - Expected: Mongo ObjectId string
   *
   * @param evidenceItems
   * - Expected: TaskEvidence[]
   * - Usage: packets/metadata for uploaded evidence
   *
   * @param ctx
   * - Optional WS context for routing
   */
  public async appendEvidence( taskMongoId: string, evidenceItems: TaskEvidence[], ctx?: TeamTaskWsContext ): Promise<TeamTaskDto | null> {
    const safe = Array.isArray( evidenceItems ) ? evidenceItems : [];
    if ( safe.length <= 0 ) return await this.getByMongoId( taskMongoId, "minimal" );

    const updated = await TeamTaskModel.findByIdAndUpdate(
      this.toObjectId( taskMongoId ),
      { $push: { evidence: { $each: safe } }, $set: { updatedAt: new Date().toISOString() } },
      { new: true }
    )
      .lean<LeanRow>()
      .exec();

    if ( !updated ) return null;

    const dto = this.toDtoMinimal( updated );
    const ctxWithUsers = await this.withResolvedCtx( dto, ctx );

    this.socket.emitTaskUpdated( dto, ctxWithUsers );
    return dto;
  }

  /**
   * Remove evidence by storageKey.
   *
   * Why this method exists
   * - Evidence removal must be predictable and idempotent.
   * - storageKey is the stable identity for a stored file.
   *
   * @param taskMongoId
   * - Expected: Mongo ObjectId string
   *
   * @param storageKey
   * - Expected: string
   * - Usage: evidence.storageKey value to pull
   *
   * @param ctx
   * - Optional WS context for routing
   */
  public async removeEvidenceByStorageKey(
    taskMongoId: string,
    storageKey: string,
    ctx?: TeamTaskWsContext
  ): Promise<TeamTaskDto | null> {
    const key = this.safeStr( storageKey );
    if ( !key ) return await this.getByMongoId( taskMongoId, "minimal" );

    const updated = await TeamTaskModel.findByIdAndUpdate(
      this.toObjectId( taskMongoId ),
      { $pull: { evidence: { storageKey: key } }, $set: { updatedAt: new Date().toISOString() } },
      { new: true }
    )
      .lean<LeanRow>()
      .exec();

    if ( !updated ) return null;

    const dto = this.toDtoMinimal( updated );
    const ctxWithUsers = await this.withResolvedCtx( dto, ctx );

    this.socket.emitTaskUpdated( dto, ctxWithUsers );
    return dto;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Users
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Get assigned members usernames for a task.
   *
   * @param taskMongoId
   * - Expected: Mongo ObjectId string
   * - Usage: load assignedMembers and resolve usernames via UserModel
   */
  public async getAssignedMembers( taskMongoId: string ): Promise<string[]> {
    const task = await TeamTaskModel.findById( this.toObjectId( taskMongoId ) )
      .select( { assignedMembers: 1 } )
      .lean<{ assignedMembers?: Types.ObjectId[]; }>()
      .exec();

    const ids = Array.isArray( task?.assignedMembers ) ? task.assignedMembers : [];
    if ( ids.length <= 0 ) return [];

    return await this.resolveUsernamesByIds( ids );
  }

  /**
   * Backward compatible alias (your original method name had a casing issue).
   * Keep until all controllers/routers are updated.
   *
   * @param taskMongoId
   * - Expected: Mongo ObjectId string
   */
  public async getassignedMembers( taskMongoId: string ): Promise<string[]> {
    return await this.getAssignedMembers( taskMongoId );
  }

  /**
   * Load captain + members as lightweight DTOs for a task.
   *
   * Why this exists
   * - UI needs to show who is responsible (captain) and who is assigned (members).
   * - Supports filtering by userId or username (useful for permission checks / profile views).
   *
   * @param taskMongoId
   * - Expected: Mongo ObjectId string
   *
   * @param filter
   * - Optional: { userId?: string; username?: string }
   * - Usage:
   *   - userId: restrict result to a single user if they are part of this task
   *   - username: restrict result to a username (in addition to id logic)
   */
  public async getTaskUsers(
    taskMongoId: string,
    filter?: { userId?: string; username?: string; }
  ): Promise<TaskUsersResult | null> {
    const task = await TeamTaskModel.findById( this.toObjectId( taskMongoId ) )
      .select( { assignedMembers: 1, assignedTaskCaptain: 1 } )
      .lean<{ assignedMembers?: Types.ObjectId[]; assignedTaskCaptain?: Types.ObjectId; }>()
      .exec();

    if ( !task ) return null;

    const memberIds = Array.isArray( task.assignedMembers ) ? task.assignedMembers : [];
    const captainId = task.assignedTaskCaptain ? task.assignedTaskCaptain : null;

    const idsToLoad: Types.ObjectId[] = captainId ? [ ...memberIds, captainId ] : [ ...memberIds ];
    if ( idsToLoad.length <= 0 ) return { captain: null, members: [], other: { memberTotal: 0 } };

    const query: Record<string, unknown> = { _id: { $in: idsToLoad } };

    const filterUserId = this.safeStr( filter?.userId );
    const filterUsername = this.safeStr( filter?.username );

    if ( filterUserId ) {
      const oid = this.toObjectId( filterUserId );
      const existsInTask = idsToLoad.some( ( x ) => String( x ) === String( oid ) );
      if ( !existsInTask ) return { captain: null, members: [], other: { memberTotal: 0 } };
      query._id = oid;
    }

    if ( filterUsername ) query.username = filterUsername;

    const users = await UserModel.find( query )
      .select( { _id: 1, username: 1, role: 1, email: 1, fullName: 1, phone: 1, imageUrl: 1, isActive: 1 } )
      .lean<LeanUserLite[]>()
      .exec();

    const mapped = Array.isArray( users ) ? users.map( ( u ) => this.toUserLiteDto( u ) ) : [];

    const captain = captainId ? mapped.find( ( x ) => x.userId === String( captainId ) ) ?? null : null;
    const members = mapped.filter( ( x ) => memberIds.some( ( m ) => String( m ) === x.userId ) );

    return { captain, members, other: { memberTotal: members.length } };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Operations expected by TeamTaskController
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Patch only status (thin wrapper over update()).
   *
   * @param taskMongoId - Mongo ObjectId string
   * @param status - TaskStatus
   * @param ctx - optional WS context
   */
  public async setStatus( taskMongoId: string, status: TaskStatus, ctx?: TeamTaskWsContext ): Promise<TeamTaskDto | null> {
    return await this.update( taskMongoId, { status }, ctx );
  }

  /**
   * Patch only priority (thin wrapper over update()).
   *
   * @param taskMongoId - Mongo ObjectId string
   * @param priority - TaskPriority
   * @param ctx - optional WS context
   */
  public async setPriority( taskMongoId: string, priority: TaskPriority, ctx?: TeamTaskWsContext ): Promise<TeamTaskDto | null> {
    return await this.update( taskMongoId, { priority }, ctx );
  }

  /**
   * Replace all labels with given list.
   *
   * @param taskMongoId - Mongo ObjectId string
   * @param labels - string[]
   * @param ctx - optional WS context
   */
  public async setLabels( taskMongoId: string, labels: string[], ctx?: TeamTaskWsContext ): Promise<TeamTaskDto | null> {
    const clean = this.cleanStringArray( labels );
    return await this.update( taskMongoId, { labels: clean }, ctx );
  }

  /**
   * Add labels using $addToSet $each (no duplicates).
   *
   * @param taskMongoId - Mongo ObjectId string
   * @param labels - string[]
   * @param ctx - optional WS context
   */
  public async addLabels( taskMongoId: string, labels: string[], ctx?: TeamTaskWsContext ): Promise<TeamTaskDto | null> {
    const clean = this.cleanStringArray( labels );
    if ( clean.length <= 0 ) return await this.getByMongoId( taskMongoId, "minimal" );

    const updated = await TeamTaskModel.findByIdAndUpdate(
      this.toObjectId( taskMongoId ),
      { $addToSet: { labels: { $each: clean } }, $set: { updatedAt: new Date().toISOString() } },
      { new: true }
    )
      .lean<LeanRow>()
      .exec();

    if ( !updated ) return null;

    const dto = this.toDtoMinimal( updated );
    const ctxWithUsers = await this.withResolvedCtx( dto, ctx );

    this.socket.emitTaskUpdated( dto, ctxWithUsers );
    return dto;
  }

  /**
   * Remove labels using $pull $in.
   *
   * @param taskMongoId - Mongo ObjectId string
   * @param labels - string[]
   * @param ctx - optional WS context
   */
  public async removeLabels( taskMongoId: string, labels: string[], ctx?: TeamTaskWsContext ): Promise<TeamTaskDto | null> {
    const clean = this.cleanStringArray( labels );
    if ( clean.length <= 0 ) return await this.getByMongoId( taskMongoId, "minimal" );

    const updated = await TeamTaskModel.findByIdAndUpdate(
      this.toObjectId( taskMongoId ),
      { $pull: { labels: { $in: clean } }, $set: { updatedAt: new Date().toISOString() } },
      { new: true }
    )
      .lean<LeanRow>()
      .exec();

    if ( !updated ) return null;

    const dto = this.toDtoMinimal( updated );
    const ctxWithUsers = await this.withResolvedCtx( dto, ctx );

    this.socket.emitTaskUpdated( dto, ctxWithUsers );
    return dto;
  }

  /**
   * Replace assignedMembers entirely.
   *
   * @param taskMongoId - Mongo ObjectId string
   * @param memberIds - string[] (user _id values)
   * @param ctx - optional WS context
   */
  public async setAssignedMembers( taskMongoId: string, memberIds: string[], ctx?: TeamTaskWsContext ): Promise<TeamTaskDto | null> {
    const ids = this.cleanStringArray( memberIds );
    const oids = ids.map( ( x ) => this.toObjectId( x ) );

    const updated = await TeamTaskModel.findByIdAndUpdate(
      this.toObjectId( taskMongoId ),
      { $set: { assignedMembers: oids, updatedAt: new Date().toISOString() } },
      { new: true }
    )
      .lean<LeanRow>()
      .exec();

    if ( !updated ) return null;

    const dto = this.toDtoMinimal( updated );
    const ctxWithUsers = await this.withResolvedCtx( dto, ctx );

    this.socket.emitTaskUpdated( dto, ctxWithUsers );
    return dto;
  }

  /**
   * Add assigned members using $addToSet $each.
   *
   * @param taskMongoId - Mongo ObjectId string
   * @param memberIds - string[] (user _id values)
   * @param ctx - optional WS context
   */
  public async addAssignedMembers( taskMongoId: string, memberIds: string[], ctx?: TeamTaskWsContext ): Promise<TeamTaskDto | null> {
    const ids = this.cleanStringArray( memberIds );
    if ( ids.length <= 0 ) return await this.getByMongoId( taskMongoId, "minimal" );

    const oids = ids.map( ( x ) => this.toObjectId( x ) );

    const updated = await TeamTaskModel.findByIdAndUpdate(
      this.toObjectId( taskMongoId ),
      { $addToSet: { assignedMembers: { $each: oids } }, $set: { updatedAt: new Date().toISOString() } },
      { new: true }
    )
      .lean<LeanRow>()
      .exec();

    if ( !updated ) return null;

    const dto = this.toDtoMinimal( updated );
    const ctxWithUsers = await this.withResolvedCtx( dto, ctx );

    this.socket.emitTaskUpdated( dto, ctxWithUsers );
    return dto;
  }

  /**
   * Remove assigned members using $pull $in.
   *
   * @param taskMongoId - Mongo ObjectId string
   * @param memberIds - string[] (user _id values)
   * @param ctx - optional WS context
   */
  public async removeAssignedMembers( taskMongoId: string, memberIds: string[], ctx?: TeamTaskWsContext ): Promise<TeamTaskDto | null> {
    const ids = this.cleanStringArray( memberIds );
    if ( ids.length <= 0 ) return await this.getByMongoId( taskMongoId, "minimal" );

    const oids = ids.map( ( x ) => this.toObjectId( x ) );

    const updated = await TeamTaskModel.findByIdAndUpdate(
      this.toObjectId( taskMongoId ),
      { $pull: { assignedMembers: { $in: oids } }, $set: { updatedAt: new Date().toISOString() } },
      { new: true }
    )
      .lean<LeanRow>()
      .exec();

    if ( !updated ) return null;

    const dto = this.toDtoMinimal( updated );
    const ctxWithUsers = await this.withResolvedCtx( dto, ctx );

    this.socket.emitTaskUpdated( dto, ctxWithUsers );
    return dto;
  }

  /**
   * Set/unset captain.
   *
   * @param taskMongoId - Mongo ObjectId string
   * @param captainUserId - string | null (null means unset)
   * @param ctx - optional WS context
   */
  public async setCaptain( taskMongoId: string, captainUserId: string | null, ctx?: TeamTaskWsContext ): Promise<TeamTaskDto | null> {
    if ( captainUserId === null ) return await this.update( taskMongoId, { assignedTaskCaptain: null }, ctx );
    const oid = this.toObjectId( captainUserId );
    return await this.update( taskMongoId, { assignedTaskCaptain: oid }, ctx );
  }

  /**
   * Set/unset notes.
   *
   * @param taskMongoId - Mongo ObjectId string
   * @param notes - string | null (null means unset)
   * @param ctx - optional WS context
   */
  public async setNotes( taskMongoId: string, notes: string | null, ctx?: TeamTaskWsContext ): Promise<TeamTaskDto | null> {
    return await this.update( taskMongoId, { notes }, ctx );
  }

  /**
   * Fetch a single field (keyof User) as string[] for given user ObjectIds.
   *
   * Why this method exists
   * - Multiple parent flows already know (a) which users and (b) which field is required.
   * - We only want a projection read (least privilege) and return a simple array.
   *
   * @param membersIDs
   * - Expected: Types.ObjectId[]
   * - Usage: list of user _id values (duplicates allowed; will be deduped)
   *
   * @param key
   * - Expected: keyof User
   * - Usage: which user field should be extracted (ex: "email", "username")
   *
   * Keep in mind
   * - Return type is string[] so this is intended for string-like fields.
   * - If the selected field is not a string, it will be ignored (not pushed).
   * - This does NOT guarantee ordering by ids; it returns values found in DB order.
   */
  public async fetchUserFieldAsStringArray( membersIDs: Types.ObjectId[], key: UserModelKeyFields ): Promise<string[]> {
    const normalizedIds = this.normalizeObjectIds( membersIDs );
    if ( normalizedIds.length === 0 ) return [];

    const projection: Record<string, 0 | 1> = { [ String( key ) ]: 1 };

    const rows = await UserModel.find( { _id: { $in: normalizedIds } } )
      .select( projection )
      .lean<Array<Record<string, unknown>>>()
      .exec();

    const out: string[] = [];
    const seen = new Set<string>();

    for ( const r of rows ) {
      const raw = r[ String( key ) ];
      if ( typeof raw !== "string" ) continue;

      const val = raw.trim();
      if ( !val ) continue;

      if ( seen.has( val ) ) continue;
      seen.add( val );

      out.push( val );
    }

    return out;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Advanced aggregate
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Advanced single load using the same advanced pipeline used by list.
   *
   * @param taskMongoId
   * - Expected: Mongo ObjectId string
   */
  private async getByMongoIdAdvanced( taskMongoId: string ): Promise<TeamTaskDto | null> {
    const pipeline = this.buildAdvancedPipeline(
      { _id: this.toObjectId( taskMongoId ) },
      { page: 1, limit: 1 },
      { key: "createdAt", dir: "desc" }
    );

    const rows = await TeamTaskModel.aggregate<AdvancedRow>( pipeline ).exec();
    if ( !Array.isArray( rows ) || rows.length <= 0 ) return null;
    if ( !rows[ 0 ] ) return null;

    return this.toDtoAdvanced( rows[ 0 ] );
  }

  /**
   * Build advanced aggregation pipeline.
   *
   * Mongo keywords used (what/why)
   * - $match: filters documents early (like SQL WHERE)
   * - $sort: ordering (like SQL ORDER BY)
   * - $skip/$limit: pagination (like OFFSET/LIMIT)
   * - $lookup: join-like fetch from other collection (like SQL JOIN)
   * - $addFields: compute new fields without changing stored doc
   * - $map/$let/$arrayElemAt: transform arrays and safely read first element
   * - $project: exclude heavy intermediate arrays from result
   *
   * @param match
   * - Expected: Record<string, unknown>
   * - Usage: aggregation match stage
   *
   * @param page
   * - Expected: PaginationInput
   *
   * @param sort
   * - Expected: TeamTaskSortInput
   */
  private buildAdvancedPipeline( match: Record<string, unknown>, page: PaginationInput, sort: TeamTaskSortInput ): PipelineStage[] {
    const stages: PipelineStage[] = [];

    stages.push( { $match: match } );
    stages.push( { $sort: this.buildAggregateSort( sort ) } );

    const skip = this.normalizeSkip( page );
    const limit = this.normalizeLimit( page );

    stages.push( { $skip: skip } );
    stages.push( { $limit: limit } );

    stages.push( {
      $lookup: {
        from: "users",
        localField: "assignedMembers",
        foreignField: "_id",
        as: "assignedMemberUsers",
      },
    } );

    stages.push( {
      $lookup: {
        from: "users",
        localField: "assignedTaskCaptain",
        foreignField: "_id",
        as: "captainUser",
      },
    } );

    stages.push( {
      $addFields: {
        assignedMember: {
          $map: { input: "$assignedMemberUsers", as: "u", in: "$$u.username" },
        },
        captainUsername: {
          $let: {
            vars: { c: { $arrayElemAt: [ "$captainUser", 0 ] } },
            in: "$$c.username",
          },
        },
      },
    } );

    stages.push( { $project: { assignedMemberUsers: 0, captainUser: 0 } } );

    return stages;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Filters + sorting (deadlinePolicy aware)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Build a find() query for minimal listing.
   *
   * @param filters
   * - Expected: TeamTaskFilterInput
   */
  private buildFindQuery( filters: TeamTaskFilterInput ): FilterQuery<unknown> {
    const q: Record<string, unknown> = {};

    if ( filters.teamCode ) q.teamCode = filters.teamCode;
    if ( filters.teamMongoId ) q.teamMongoId = this.toObjectId( filters.teamMongoId.toString() );

    if ( filters.domain ) q.domain = filters.domain;

    if ( typeof filters.status !== "undefined" ) q.status = filters.status;
    if ( typeof filters.priority !== "undefined" ) q.priority = filters.priority;

    if ( filters.assignedMemberId ) q.assignedMembers = this.toObjectId( filters.assignedMemberId.toString() );
    if ( filters.assignedCaptainId ) q.assignedTaskCaptain = this.toObjectId( filters.assignedCaptainId.toString() );

    if ( filters.label && filters.label.trim() ) q.labels = filters.label.trim();

    // deadlinePolicy.dueAt range filter
    if ( filters.dueFrom || filters.dueTo ) {
      const cond: Record<string, unknown> = {};
      if ( filters.dueFrom ) cond.$gte = filters.dueFrom;
      if ( filters.dueTo ) cond.$lte = filters.dueTo;
      q[ "deadlinePolicy.dueAt" ] = cond;
    }

    if ( filters.createdFrom || filters.createdTo ) {
      const cond: Record<string, unknown> = {};
      if ( filters.createdFrom ) cond.$gte = filters.createdFrom;
      if ( filters.createdTo ) cond.$lte = filters.createdTo;
      q.createdAt = cond;
    }

    if ( filters.updatedFrom || filters.updatedTo ) {
      const cond: Record<string, unknown> = {};
      if ( filters.updatedFrom ) cond.$gte = filters.updatedFrom;
      if ( filters.updatedTo ) cond.$lte = filters.updatedTo;
      q.updatedAt = cond;
    }

    if ( filters.text && filters.text.trim() ) {
      q.$text = { $search: filters.text.trim() };
    }

    if ( filters.hasEvidence === true ) {
      q[ "evidence.0" ] = { $exists: true };
    }

    return q as FilterQuery<unknown>;
  }

  /**
   * Build aggregate match object.
   *
   * @param filters
   * - Expected: TeamTaskFilterInput
   */
  private buildAggregateMatch( filters: TeamTaskFilterInput ): Record<string, unknown> {
    return this.buildFindQuery( filters ) as unknown as Record<string, unknown>;
  }

  /**
   * Build find() sort object.
   *
   * @param sort
   * - Expected: TeamTaskSortInput
   * - Special: "dueAt" maps to deadlinePolicy.dueAt
   */
  private buildFindSort( sort: TeamTaskSortInput ): Record<string, 1 | -1> {
    const dir: 1 | -1 = sort.dir === "asc" ? 1 : -1;

    if ( sort.key === "dueAt" ) return { "deadlinePolicy.dueAt": dir };
    return { [ sort.key ]: dir } as Record<string, 1 | -1>;
  }

  /**
   * Build aggregate sort object.
   *
   * @param sort
   * - Expected: TeamTaskSortInput
   */
  private buildAggregateSort( sort: TeamTaskSortInput ): Record<string, 1 | -1> {
    return this.buildFindSort( sort );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // DTO mapping
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Map lean DB row to minimal DTO.
   *
   * @param doc
   * - Expected: LeanRow (lean TeamTask)
   */
  private toDtoMinimal( doc: LeanRow ): TeamTaskDto {
    const dto: TeamTaskDto = {
      taskMongoId: String( doc._id ),
      id: String( doc.id ),

      teamCode: String( doc.teamCode ),
      teamMongoId: String( doc.teamMongoId ),

      domain: doc.domain as TeamDomain,

      name: typeof doc.name === "string" ? doc.name : "",
      description: typeof doc.description === "string" ? doc.description : "",

      workItemCount: typeof doc.workItemCount === "number" ? doc.workItemCount : 0,

      status: ( doc.status ?? "draft" ) as TaskStatus,
      priority: ( doc.priority ?? "medium" ) as TaskPriority,

      timing: doc.timing ?? {},

      createdAt: String( doc.createdAt ) as ISODateString,
      updatedAt: String( doc.updatedAt ) as ISODateString,
    };

    if ( Array.isArray( doc.assignedMembers ) ) {
      dto.assignedMembers = doc.assignedMembers.map( ( x ) => String( x ) );
    }

    if ( doc.assignedTaskCaptain ) dto.assignedTaskCaptain = String( doc.assignedTaskCaptain );

    if ( doc.location ) dto.location = doc.location;
    if ( doc.address ) dto.address = doc.address;

    const ps = this.safeStr( doc.plannedStartAt );
    const pe = this.safeStr( doc.plannedEndAt );
    if ( ps ) dto.plannedStartAt = ps;
    if ( pe ) dto.plannedEndAt = pe;

    if ( doc.deadlinePolicy ) {
      const clean = this.cleanDeadlinePolicy( doc.deadlinePolicy );
      if ( this.hasAnyDeadlinePolicy( clean ) ) dto.deadlinePolicy = clean;
    }

    if ( doc.metrics && this.hasAnyMetrics( doc.metrics ) ) dto.metrics = doc.metrics;

    if ( Array.isArray( doc.workItemMongoIds ) && doc.workItemMongoIds.length > 0 ) {
      dto.workItemMongoIds = doc.workItemMongoIds.map( ( x ) => String( x ) );
    }

    if ( Array.isArray( doc.blockedWindows ) && doc.blockedWindows.length > 0 ) {
      dto.blockedWindows = doc.blockedWindows as TaskBlockedWindow[];
    }

    if ( Array.isArray( doc.assigneeHistory ) && doc.assigneeHistory.length > 0 ) {
      dto.assigneeHistory = doc.assigneeHistory;
    }

    if ( doc.completionConfirmation ) {
      dto.completionConfirmation = doc.completionConfirmation as TaskCompletionConfirmation;
    }

    if ( Array.isArray( doc.evidence ) && doc.evidence.length > 0 ) dto.evidence = doc.evidence as TaskEvidence[];

    const notes = this.safeStr( doc.notes );
    if ( notes ) dto.notes = notes;

    if ( Array.isArray( doc.labels ) && doc.labels.length > 0 ) {
      dto.labels = doc.labels;
    }

    if ( doc.audit && this.hasAnyAudit( doc.audit ) ) dto.audit = this.cleanAudit( doc.audit );

    return dto;
  }

  /**
   * Map advanced aggregate row to DTO (adds assignedMember usernames + captainUsername).
   *
   * @param row
   * - Expected: AdvancedRow
   */
  private toDtoAdvanced( row: AdvancedRow ): TeamTaskDto {
    const base = this.toDtoMinimal( row );

    const assignedMember = Array.isArray( row.assignedMember )
      ? row.assignedMember.map( ( x ) => ( typeof x === "string" ? x : "" ) ).filter( Boolean )
      : [];

    const captainUsername = typeof row.captainUsername === "string" ? row.captainUsername : "";

    return {
      ...base,
      ...( assignedMember.length > 0 ? { assignedMember } : {} ),
      ...( captainUsername ? { captainUsername } : {} ),
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // WS ctx helper
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Ensure WS ctx has assignedMember usernames.
   *
   * @param dto
   * - Expected: TeamTaskDto
   *
   * @param ctx
   * - Optional TeamTaskWsContext
   */
  private async withResolvedCtx( dto: TeamTaskDto, ctx?: TeamTaskWsContext ): Promise<TeamTaskWsContext | undefined> {
    if ( !ctx ) return undefined;

    // If already present, return as-is
    if ( Array.isArray( ctx.assignedMember ) && ctx.assignedMember.length > 0 ) return ctx;

    // Resolve from dto.assignedMembers (userIds) if possible
    if ( !Array.isArray( dto.assignedMembers ) || dto.assignedMembers.length <= 0 ) return ctx;

    const ids = dto.assignedMembers.map( ( x ) => this.toObjectId( x ) );
    const usernames = await this.resolveUsernamesByIds( ids );

    if ( usernames.length <= 0 ) return ctx;

    return { ...ctx, assignedMember: usernames };
  }

  /**
   * Resolve usernames by user ObjectIds.
   *
   * @param ids
   * - Expected: Types.ObjectId[]
   */
  private async resolveUsernamesByIds( ids: Types.ObjectId[] ): Promise<string[]> {
    if ( !Array.isArray( ids ) || ids.length <= 0 ) return [];

    const rows = await UserModel.find( { _id: { $in: ids } } )
      .select( { username: 1 } )
      .lean<Array<{ _id: Types.ObjectId; username?: string; }>>()
      .exec();

    return Array.isArray( rows )
      ? rows.map( ( r ) => ( typeof r.username === "string" ? r.username : "" ) ).filter( Boolean )
      : [];
  }

  /**
   * Map lean user to TaskUserLiteDto.
   *
   * @param u
   * - Expected: LeanUserLite
   */
  private toUserLiteDto( u: LeanUserLite ): TaskUserLiteDto {
    const dto: TaskUserLiteDto = {
      userId: String( u._id ),
      username: typeof u.username === "string" ? u.username : "",
    };

    if ( typeof u.fullName === "string" && u.fullName.trim() ) dto.fullName = u.fullName.trim();
    if ( typeof u.email === "string" && u.email.trim() ) dto.email = u.email.trim();
    if ( typeof u.phone === "string" && u.phone.trim() ) dto.phone = u.phone.trim();
    if ( typeof u.role === "string" && u.role.trim() ) dto.role = u.role.trim();
    if ( typeof u.imageUrl === "string" && u.imageUrl.trim() ) dto.imageUrl = u.imageUrl.trim();
    if ( typeof u.isActive === "boolean" ) dto.isActive = u.isActive;

    return dto;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Validators
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Validate domain.
   *
   * @param domain
   * - Expected: TeamDomain | undefined
   */
  private assertDomain( domain?: TeamDomain ): void {
    if ( !domain ) return;
    if ( !TEAM_DOMAINS.includes( domain ) ) throw new Error( `Invalid domain: ${ domain }` );
  }

  /**
   * Validate status.
   *
   * @param status
   * - Expected: TaskStatus | undefined
   */
  private assertStatus( status?: TaskStatus ): void {
    if ( !status ) return;
    if ( !TASK_STATUSES.includes( status ) ) throw new Error( `Invalid status: ${ status }` );
  }

  /**
   * Validate priority.
   *
   * @param priority
   * - Expected: TaskPriority | undefined
   */
  private assertPriority( priority?: TaskPriority ): void {
    if ( !priority ) return;
    if ( !TASK_PRIORITIES.includes( priority ) ) throw new Error( `Invalid priority: ${ priority }` );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Cleaners
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Normalize string list (trim + remove empty).
   *
   * @param list
   * - Expected: string[]
   */
  private cleanStringArray( list: string[] ): string[] {
    if ( !Array.isArray( list ) ) return [];
    return list.map( ( x ) => ( typeof x === "string" ? x.trim() : "" ) ).filter( Boolean );
  }

  /**
   * Normalize audit meta (trim ids/usernames).
   *
   * @param audit
   * - Expected: TaskAuditMeta
   */
  private cleanAudit( audit: TaskAuditMeta ): TaskAuditMeta {
    const out: TaskAuditMeta = {};

    if ( audit.source ) out.source = audit.source;

    const req = this.safeStr( audit.requestId );
    const dev = this.safeStr( audit.deviceId );
    if ( req ) out.requestId = req;
    if ( dev ) out.deviceId = dev;

    if ( audit.createdByUserId ) out.createdByUserId = audit.createdByUserId;
    const cbu = this.safeStr( audit.createdByUsername );
    if ( cbu ) out.createdByUsername = cbu;

    if ( audit.lastUpdatedByUserId ) out.lastUpdatedByUserId = audit.lastUpdatedByUserId;
    const lub = this.safeStr( audit.lastUpdatedByUsername );
    if ( lub ) out.lastUpdatedByUsername = lub;

    return out;
  }

  /**
   * Normalize TaskTiming fields to ISO strings or null.
   *
   * @param timing
   * - Expected: TaskTiming
   */
  private cleanTiming( timing: TaskTiming ): TaskTiming {
    const norm = ( v: unknown ): ISODateString | null | undefined => {
      if ( typeof v === "string" ) return v.trim() ? ( v.trim() as ISODateString ) : null;
      if ( v === null ) return null;
      return undefined;
    };

    const out: TaskTiming = {};
    const fields: Array<keyof TaskTiming> = [
      "createdAt",
      "updatedAt",
      "firstResponseAt",
      "startedAt",
      "lastBlockedAt",
      "completedAt",
      "confirmedAt",
      "cancelledAt",
    ];

    for ( const k of fields ) {
      const raw = ( timing as unknown as Record<string, unknown> )[ k as string ];
      const val = norm( raw );

      if ( val === null ) ( out as unknown as Record<string, unknown> )[ k as string ] = null;
      else if ( typeof val === "string" ) ( out as unknown as Record<string, unknown> )[ k as string ] = val;
    }

    return out;
  }

  /**
   * Normalize deadlinePolicy.
   *
   * @param input
   * - Expected: TaskDeadlinePolicy or partial-like input object
   * - Usage: used in create/update and mapper cleanup
   */
  private cleanDeadlinePolicy(
    input: TaskDeadlinePolicy | { dueAt?: unknown; breachAt?: unknown; urgency?: unknown; }
  ): TaskDeadlinePolicy {
    const out: TaskDeadlinePolicy = {};

    const dueAtRaw = ( input as { dueAt?: unknown; } ).dueAt;
    const breachAtRaw = ( input as { breachAt?: unknown; } ).breachAt;

    const dueAt = this.safeStr( dueAtRaw );
    const breachAt = this.safeStr( breachAtRaw );

    if ( typeof dueAtRaw === "string" ) out.dueAt = dueAt ? dueAt : null;
    if ( dueAtRaw === null ) out.dueAt = null;

    if ( typeof breachAtRaw === "string" ) out.breachAt = breachAt ? breachAt : null;
    if ( breachAtRaw === null ) out.breachAt = null;

    const urg = ( input as { urgency?: unknown; } ).urgency;
    if ( this.isUrgency( urg ) ) out.urgency = urg;
    if ( urg === null ) out.urgency = null;

    return out;
  }

  /**
   * Normalize runtime metrics (NaN -> 0).
   *
   * @param metrics
   * - Expected: TaskRuntimeMetrics
   */
  private cleanMetrics( metrics: TaskRuntimeMetrics ): TaskRuntimeMetrics {
    const out: TaskRuntimeMetrics = { ...metrics };

    for ( const k of Object.keys( out ) ) {
      const v = ( out as unknown as Record<string, unknown> )[ k ];
      if ( typeof v === "number" && Number.isNaN( v ) ) ( out as unknown as Record<string, unknown> )[ k ] = 0;
    }

    return out;
  }

  /**
   * Type guard for urgency values.
   *
   * @param v
   * - Expected: unknown
   */
  private isUrgency( v: unknown ): v is TaskUrgencyLevel {
    return typeof v === "string" && ( TeamTaskService.URGENCY_VALUES as readonly string[] ).includes( v );
  }

  /**
   * Check if deadlinePolicy has any meaningful keys.
   *
   * @param p - TaskDeadlinePolicy
   */
  private hasAnyDeadlinePolicy( p: TaskDeadlinePolicy ): boolean {
    return typeof p.dueAt !== "undefined" || typeof p.breachAt !== "undefined" || typeof p.urgency !== "undefined";
  }

  /**
   * Check if metrics has keys.
   *
   * @param m - TaskRuntimeMetrics
   */
  private hasAnyMetrics( m: TaskRuntimeMetrics ): boolean {
    return !!m && Object.keys( m ).length > 0;
  }

  /**
   * Check if audit has keys.
   *
   * @param a - TaskAuditMeta
   */
  private hasAnyAudit( a: TaskAuditMeta ): boolean {
    return !!a && Object.keys( a ).length > 0;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Pagination helpers (supports legacy "pageIndex")
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Normalize limit with safety clamp.
   *
   * @param page
   * - Expected: PaginationInput
   */
  private normalizeLimit( page: PaginationInput ): number {
    const raw = typeof page.limit === "number" ? page.limit : 20;
    const safe = Number.isFinite( raw ) && raw > 0 ? Math.min( raw, 200 ) : 20;
    return safe;
  }

  /**
   * Normalize skip:
   * - Uses page.skip if provided
   * - Supports legacy pageIndex
   * - Otherwise uses 1-based page
   *
   * @param page
   * - Expected: PaginationInput
   */
  private normalizeSkip( page: PaginationInput ): number {
    if ( typeof page.skip === "number" && Number.isFinite( page.skip ) && page.skip >= 0 ) return page.skip;

    const legacyPageIndex = ( page as unknown as { pageIndex?: number; } ).pageIndex;
    if ( typeof legacyPageIndex === "number" && legacyPageIndex >= 0 ) {
      return legacyPageIndex * this.normalizeLimit( page );
    }

    const p = typeof page.page === "number" ? page.page : 1;
    const safePage = Number.isFinite( p ) && p > 0 ? p : 1;

    return ( safePage - 1 ) * this.normalizeLimit( page );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Small helpers
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Safe string normalize.
   *
   * @param v - unknown
   */
  private safeStr( v: unknown ): string {
    return typeof v === "string" ? v.trim() : "";
  }

  /**
   * Convert string to ObjectId (throws if invalid).
   *
   * @param id
   * - Expected: ObjectId string
   */
  private toObjectId( id: string ): Types.ObjectId {
    return new Types.ObjectId( String( id ) );
  }

  /**
   * Normalize ObjectIds by removing duplicates (stable order).
   *
   * @param ids
   * - Expected: Types.ObjectId[]
   */
  private normalizeObjectIds( ids: Types.ObjectId[] ): Types.ObjectId[] {
    const out: Types.ObjectId[] = [];
    const seen = new Set<string>();

    for ( const id of ids ) {
      const key = String( id );
      if ( seen.has( key ) ) continue;
      seen.add( key );
      out.push( id );
    }

    return out;
  }

  /**
   * Convert a lean task into JSON-safe snapshot data for RecycleBin.
   *
   * Why this is needed
   * - RecycleBin snapshotData is intended to be JSON-safe (no ObjectId instances).
   * - This avoids future restore/export issues and keeps snapshots portable.
   *
   * @param doc
   * - Expected: LeanRow
   */
  private toJsonSafeSnapshot( doc: LeanRow ): Record<string, unknown> {
    const raw = doc as unknown as Record<string, unknown>;
    const out: Record<string, unknown> = {};

    for ( const k of Object.keys( raw ) ) {
      const v = raw[ k ];

      if ( v instanceof Types.ObjectId ) {
        out[ k ] = String( v );
        continue;
      }

      if ( Array.isArray( v ) ) {
        out[ k ] = v.map( ( x ) => ( x instanceof Types.ObjectId ? String( x ) : x ) );
        continue;
      }

      // shallow keep for plain JSON-like values
      out[ k ] = v;
    }

    // Ensure snapshot always has stable ids
    out._id = String( ( doc as unknown as { _id?: unknown; } )._id ?? "" );
    out.id = String( ( doc as unknown as { id?: unknown; } ).id ?? "" );

    return out;
  }
}