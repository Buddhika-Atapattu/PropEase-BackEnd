// Path: src/services/teamManagement/team-task.service.ts
// =============================================================================
// TeamTaskService — rebuilt to match TeamTaskModel + team-tasks.type.ts
// =============================================================================
// Key alignment fixes:
// - `deadlinePolicy` replaces `sla`
// - dueAt filters/sort use "deadlinePolicy.dueAt"
// - DTO mapper treats schema empty-string defaults as "absent" (omit)
// - Lean typing uses LeanTeamTask (plain object), NOT mongoose Document
// - exactOptionalPropertyTypes safe: never assign undefined to optionals
// =============================================================================

import { Types, type FilterQuery, type PipelineStage } from "mongoose";

import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  TEAM_DOMAINS,
  type Address,
  type GeoLocation,
  type ISODateString,
  type TaskAuditMeta,
  type TaskBlockedWindow,
  type TaskCompletionConfirmation,
  type TaskPriority,
  type TaskRuntimeMetrics,
  type TaskStatus,
  type TaskTiming,
  type TeamDomain,
} from "../../../models/teamManagement/teamManagement.model";

import { TeamTaskModel } from "../../../models/teamManagement/teamTasks/teamTask.model";
import type { TaskDeadlinePolicy, TaskEvidence, TaskUrgencyLevel } from "../../../models/teamManagement/teamTasks/teamTask.model";

import { TeamTaskSocketService, type TeamTaskWsContext } from "./team-task.socket.service";
import { UserModel } from "../../../models/user.model";

import type {
  CreateTeamTaskInput,
  LeanTeamTask,
  LeanUserLite,
  ListResult,
  PaginationInput,
  TaskUserLiteDto,
  TaskUsersResult,
  TeamTaskDto,
  TeamTaskFilterInput,
  TeamTaskKeyValues,
  TeamTaskLoadMode,
  TeamTaskSortInput,
  UpdateTeamTaskInput,
} from "../../../types/teamManagement/teamTasks/team-tasks.type";

type LeanRow = LeanTeamTask;
type AdvancedRow = LeanTeamTask & {
  assignedMemberUsernames?: string[];
  captainUsername?: string;
};

export class TeamTaskService {
  private readonly socket: TeamTaskSocketService = new TeamTaskSocketService();

  private static readonly URGENCY_VALUES = [ "low", "medium", "high", "critical" ] as const;

  public constructor () {}

  // ──────────────────────────────────────────────────────────────────────────
  // GET ONE
  // ──────────────────────────────────────────────────────────────────────────

  public async getByMongoId( taskMongoId: string, mode: TeamTaskLoadMode = "minimal" ): Promise<TeamTaskDto | null> {
    if ( mode === "advanced" ) return await this.getByMongoIdAdvanced( taskMongoId );

    const doc = await TeamTaskModel.findById( this.toObjectId( taskMongoId ) )
      .lean<LeanRow>()
      .exec();

    if ( !doc ) return null;
    return this.toDtoMinimal( doc );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // LIST (minimal / advanced)
  // ──────────────────────────────────────────────────────────────────────────

  public async listMinimal( filters: TeamTaskFilterInput, page: PaginationInput, sort: TeamTaskSortInput ): Promise<ListResult<TeamTaskDto>> {
    const total = await this.count( filters );
    if ( total <= 0 ) return { items: [], other: { total: 0 } };

    const query = this.buildFindQuery( filters );
    const sortDoc = this.buildFindSort( sort );

    const docs = await TeamTaskModel.find( query )
      .sort( sortDoc )
      .skip( page.pageIndex * page.limit )
      .limit( page.limit )
      .lean<LeanRow[]>()
      .exec();

    const items = Array.isArray( docs ) ? docs.map( ( d ) => this.toDtoMinimal( d ) ) : [];
    return { items, other: { total } };
  }

  public async listAdvanced( filters: TeamTaskFilterInput, page: PaginationInput, sort: TeamTaskSortInput ): Promise<ListResult<TeamTaskDto>> {
    const total = await this.count( filters );
    if ( total <= 0 ) return { items: [], other: { total: 0 } };

    const match = this.buildAggregateMatch( filters );
    const pipeline = this.buildAdvancedPipeline( match, page, sort );

    const rows = await TeamTaskModel.aggregate( pipeline ).exec();
    const safeRows: AdvancedRow[] = Array.isArray( rows ) ? ( rows as AdvancedRow[] ) : [];

    const items = safeRows.map( ( r ) => this.toDtoAdvanced( r ) );
    return { items, other: { total } };
  }

  public async list( filters: TeamTaskFilterInput, page: PaginationInput, sort: TeamTaskSortInput, mode: TeamTaskLoadMode ): Promise<ListResult<TeamTaskDto>> {
    return mode === "advanced"
      ? await this.listAdvanced( filters, page, sort )
      : await this.listMinimal( filters, page, sort );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // KEY VALUES
  // ──────────────────────────────────────────────────────────────────────────

  public async getKeyValues( filters?: { teamCode?: string; teamMongoId?: string; domain?: TeamDomain; status?: TaskStatus; } ): Promise<TeamTaskKeyValues> {
    const base: TeamTaskKeyValues = {
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

    const rows = await TeamTaskModel.aggregate( pipeline ).exec();
    const distinctLabels =
      Array.isArray( rows )
        ? rows
          .map( ( r ) => {
            const v = ( r as { _id?: unknown; } )._id;
            return typeof v === "string" ? v : "";
          } )
          .filter( Boolean )
        : [];

    return {
      ...base,
      ...( distinctLabels.length > 0 ? { distinctLabels } : {} ),
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // COUNT
  // ──────────────────────────────────────────────────────────────────────────

  public async count( filters: TeamTaskFilterInput ): Promise<number> {
    const query = this.buildFindQuery( filters );
    return await TeamTaskModel.countDocuments( query ).exec();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // CRUD
  // ──────────────────────────────────────────────────────────────────────────

  public async create( input: CreateTeamTaskInput, ctx?: TeamTaskWsContext ): Promise<TeamTaskDto> {
    this.assertDomain( input.domain );
    this.assertStatus( input.status );
    this.assertPriority( input.priority );

    const nowIso = new Date().toISOString();

    const created = await TeamTaskModel.create( {
      id: input.id,

      teamCode: input.teamCode,
      teamMongoId: this.toObjectId( input.teamMongoId ),

      domain: input.domain,

      name: input.name,
      description: input.description ?? "",

      ...( input.location ? { location: input.location } : {} ),
      ...( input.address ? { address: input.address } : {} ),

      ...( Array.isArray( input.assignedMembers ) ? { assignedMembers: input.assignedMembers.map( ( x ) => this.toObjectId( x ) ) } : {} ),
      ...( typeof input.assignedTaskCaptain === "string" && input.assignedTaskCaptain.trim()
        ? { assignedTaskCaptain: this.toObjectId( input.assignedTaskCaptain.trim() ) }
        : {} ),

      ...( Array.isArray( input.workItemMongoIds )
        ? { workItemMongoIds: input.workItemMongoIds.map( ( x ) => this.toObjectId( String( x ) ) ) }
        : {} ),
      workItemCount: typeof input.workItemCount === "number" ? input.workItemCount : 0,

      status: input.status ?? "draft",
      priority: input.priority ?? "medium",

      ...( typeof input.plannedStartAt === "string" && input.plannedStartAt.trim() ? { plannedStartAt: input.plannedStartAt.trim() } : {} ),
      ...( typeof input.plannedEndAt === "string" && input.plannedEndAt.trim() ? { plannedEndAt: input.plannedEndAt.trim() } : {} ),

      timing: input.timing ? this.cleanTiming( input.timing ) : { createdAt: nowIso, updatedAt: nowIso },

      ...( input.deadlinePolicy ? { deadlinePolicy: this.cleanDeadlinePolicy( input.deadlinePolicy ) } : {} ),

      ...( input.metrics ? { metrics: this.cleanMetrics( input.metrics ) } : {} ),

      ...( Array.isArray( input.blockedWindows ) ? { blockedWindows: input.blockedWindows } : {} ),
      ...( input.completionConfirmation ? { completionConfirmation: input.completionConfirmation } : {} ),

      ...( Array.isArray( input.evidence ) ? { evidence: input.evidence } : {} ),

      ...( typeof input.notes === "string" && input.notes.trim() ? { notes: input.notes } : {} ),
      labels: Array.isArray( input.labels ) ? this.cleanStringArray( input.labels ) : [],

      ...( input.audit ? { audit: this.cleanAudit( input.audit ) } : {} ),

      createdAt: nowIso,
      updatedAt: nowIso,
    } );

    const dto = this.toDtoMinimal( created.toObject() as unknown as LeanRow );

    // Optional: populate ctx.assignedMemberUsernames for user:<username> emits
    const ctxWithUsers = await this.withResolvedCtx( dto, ctx );

    this.socket.emitTaskCreated( dto, ctxWithUsers );
    return dto;
  }

  public async update( taskMongoId: string, input: UpdateTeamTaskInput, ctx?: TeamTaskWsContext ): Promise<TeamTaskDto | null> {
    this.assertDomain( input.domain );
    this.assertStatus( input.status );
    this.assertPriority( input.priority );

    const $set: Record<string, unknown> = {};
    const $unset: Record<string, 1> = {};

    if ( typeof input.name === "string" ) $set.name = input.name;
    if ( typeof input.description === "string" ) $set.description = input.description;

    if ( input.location === null ) $unset.location = 1;
    else if ( input.location ) $set.location = input.location;

    if ( input.address === null ) $unset.address = 1;
    else if ( input.address ) $set.address = input.address;

    if ( input.assignedMembers === null ) $unset.assignedMembers = 1;
    else if ( Array.isArray( input.assignedMembers ) ) {
      $set.assignedMembers = input.assignedMembers.map( ( x ) => this.toObjectId( String( x ) ) );
    }

    if ( input.assignedTaskCaptain === null ) $unset.assignedTaskCaptain = 1;
    else if ( typeof input.assignedTaskCaptain === "string" && input.assignedTaskCaptain.trim() ) {
      $set.assignedTaskCaptain = this.toObjectId( input.assignedTaskCaptain.trim() );
    }

    if ( input.workItemMongoIds === null ) $unset.workItemMongoIds = 1;
    else if ( Array.isArray( input.workItemMongoIds ) ) {
      $set.workItemMongoIds = input.workItemMongoIds.map( ( x ) => this.toObjectId( String( x ) ) );
      // keep cache count in sync if caller provides ids
      $set.workItemCount = input.workItemMongoIds.length;
    }

    if ( input.workItemCount === null ) $unset.workItemCount = 1;
    else if ( typeof input.workItemCount === "number" ) $set.workItemCount = input.workItemCount;

    if ( typeof input.status === "string" ) $set.status = input.status;
    if ( typeof input.priority === "string" ) $set.priority = input.priority;
    if ( typeof input.domain === "string" ) $set.domain = input.domain;

    if ( input.plannedStartAt === null ) $unset.plannedStartAt = 1;
    else if ( typeof input.plannedStartAt === "string" && input.plannedStartAt.trim() ) $set.plannedStartAt = input.plannedStartAt.trim();

    if ( input.plannedEndAt === null ) $unset.plannedEndAt = 1;
    else if ( typeof input.plannedEndAt === "string" && input.plannedEndAt.trim() ) $set.plannedEndAt = input.plannedEndAt.trim();

    if ( input.timing === null ) $unset.timing = 1;
    else if ( input.timing ) $set.timing = this.cleanTiming( input.timing );

    if ( input.deadlinePolicy === null ) $unset.deadlinePolicy = 1;
    else if ( input.deadlinePolicy ) $set.deadlinePolicy = this.cleanDeadlinePolicy( input.deadlinePolicy );

    if ( input.metrics === null ) $unset.metrics = 1;
    else if ( input.metrics ) $set.metrics = this.cleanMetrics( input.metrics );

    if ( input.blockedWindows === null ) $unset.blockedWindows = 1;
    else if ( Array.isArray( input.blockedWindows ) ) $set.blockedWindows = input.blockedWindows;

    if ( input.completionConfirmation === null ) $unset.completionConfirmation = 1;
    else if ( input.completionConfirmation ) $set.completionConfirmation = input.completionConfirmation;

    if ( input.notes === null ) $unset.notes = 1;
    else if ( typeof input.notes === "string" ) $set.notes = input.notes;

    if ( input.labels === null ) $unset.labels = 1;
    else if ( Array.isArray( input.labels ) ) $set.labels = this.cleanStringArray( input.labels );

    if ( input.audit === null ) $unset.audit = 1;
    else if ( input.audit ) $set.audit = this.cleanAudit( input.audit );

    $set.updatedAt = new Date().toISOString();

    const updateDoc: Record<string, unknown> = {
      ...( Object.keys( $set ).length > 0 ? { $set } : {} ),
      ...( Object.keys( $unset ).length > 0 ? { $unset } : {} ),
    };

    if ( Object.keys( updateDoc ).length <= 0 ) return await this.getByMongoId( taskMongoId, "minimal" );

    const updated = await TeamTaskModel.findByIdAndUpdate( this.toObjectId( taskMongoId ), updateDoc, { new: true } )
      .lean<LeanRow>()
      .exec();

    if ( !updated ) return null;

    const dto = this.toDtoMinimal( updated );

    // Optional: populate ctx.assignedMemberUsernames for user:<username> emits
    const ctxWithUsers = await this.withResolvedCtx( dto, ctx );

    this.socket.emitTaskUpdated( dto, ctxWithUsers );
    return dto;
  }

  public async delete( taskMongoId: string, ctx?: TeamTaskWsContext ): Promise<boolean> {
    const existing = await TeamTaskModel.findById( this.toObjectId( taskMongoId ) ).lean<LeanRow>().exec();
    if ( !existing ) return false;

    await TeamTaskModel.deleteOne( { _id: this.toObjectId( taskMongoId ) } ).exec();

    const dto = this.toDtoMinimal( existing );
    const ctxWithUsers = await this.withResolvedCtx( dto, ctx );

    this.socket.emitTaskDeleted( dto, ctxWithUsers );
    return true;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Evidence (model stores evidence as subdocs, but schema uses _id:false.
  // So remove by "index" or by "storageKey/url/name" — NOT by mongoId.
  // If you want mongo-id removal, change evidenceSchema to {_id:true}.
  // ──────────────────────────────────────────────────────────────────────────

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

  // ✅ Removal by storageKey (best unique key for files)
  public async removeEvidenceByStorageKey( taskMongoId: string, storageKey: string, ctx?: TeamTaskWsContext ): Promise<TeamTaskDto | null> {
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
  // Users (same pattern, but now DTO/service aligned)
  // ──────────────────────────────────────────────────────────────────────────

  public async getAssignedMemberUsernames( taskMongoId: string ): Promise<string[]> {
    const task = await TeamTaskModel.findById( this.toObjectId( taskMongoId ) )
      .select( { assignedMembers: 1 } )
      .lean<{ assignedMembers?: Types.ObjectId[]; }>()
      .exec();

    const ids = Array.isArray( task?.assignedMembers ) ? task.assignedMembers : [];
    if ( ids.length <= 0 ) return [];

    return await this.resolveUsernamesByIds( ids );
  }

  public async getTaskUsers( taskMongoId: string, filter?: { userId?: string; username?: string; } ): Promise<TaskUsersResult | null> {
    const task = await TeamTaskModel.findById( this.toObjectId( taskMongoId ) )
      .select( { assignedMembers: 1, assignedTaskCaptain: 1 } )
      .lean<{ assignedMembers?: Types.ObjectId[]; assignedTaskCaptain?: Types.ObjectId; }>()
      .exec();

    if ( !task ) return null;

    const memberIds = Array.isArray( task.assignedMembers ) ? task.assignedMembers : [];
    const captainId = task.assignedTaskCaptain ? task.assignedTaskCaptain : null;

    const idsToLoad: Types.ObjectId[] = captainId ? [ ...memberIds, captainId ] : [ ...memberIds ];
    if ( idsToLoad.length <= 0 ) return { members: [], captain: null };

    const query: Record<string, unknown> = { _id: { $in: idsToLoad } };

    const filterUserId = this.safeStr( filter?.userId );
    const filterUsername = this.safeStr( filter?.username );

    if ( filterUserId ) {
      const oid = this.toObjectId( filterUserId );
      const existsInTask = idsToLoad.some( ( x ) => String( x ) === String( oid ) );
      if ( !existsInTask ) return { members: [], captain: null };
      query._id = oid;
    }

    if ( filterUsername ) query.username = filterUsername;

    const users = await UserModel.find( query )
      .select( { _id: 1, username: 1, role: 1, email: 1 } )
      .lean<LeanUserLite[]>()
      .exec();

    const mapped = users.map( ( u ) => this.toUserLiteDto( u ) );

    const captain = captainId ? mapped.find( ( x ) => x.mongoId === String( captainId ) ) ?? null : null;
    const members = mapped.filter( ( x ) => memberIds.some( ( m ) => String( m ) === x.mongoId ) );

    return { members, captain };
  }


  // ──────────────────────────────────────────────────────────────────────────
  // Operations expected by TeamTaskController (TS2339 fix set)
  // ──────────────────────────────────────────────────────────────────────────

  public async setStatus(
    taskMongoId: string,
    status: TaskStatus,
    ctx?: TeamTaskWsContext
  ): Promise<TeamTaskDto | null> {
    // Reuse the central update() so WS emit rules stay consistent
    return await this.update( taskMongoId, { status }, ctx );
  }

  public async setPriority(
    taskMongoId: string,
    priority: TaskPriority,
    ctx?: TeamTaskWsContext
  ): Promise<TeamTaskDto | null> {
    return await this.update( taskMongoId, { priority }, ctx );
  }

  public async setLabels(
    taskMongoId: string,
    labels: string[],
    ctx?: TeamTaskWsContext
  ): Promise<TeamTaskDto | null> {
    // "set" means replace the full array
    const clean = this.cleanStringArray( labels );
    return await this.update( taskMongoId, { labels: clean }, ctx );
  }

  public async addLabels(
    taskMongoId: string,
    labels: string[],
    ctx?: TeamTaskWsContext
  ): Promise<TeamTaskDto | null> {
    const clean = this.cleanStringArray( labels );
    if ( clean.length <= 0 ) return await this.getByMongoId( taskMongoId, "minimal" );

    const updated = await TeamTaskModel.findByIdAndUpdate(
      this.toObjectId( taskMongoId ),
      {
        $addToSet: { labels: { $each: clean } },
        $set: { updatedAt: new Date().toISOString() },
      },
      { new: true }
    )
      .lean<LeanRow>()
      .exec();

    if ( !updated ) return null;

    const dto = this.toDtoMinimal( updated );
    const ctxWithUsers = await this.withResolvedCtx( dto, ctx );
    await Promise.resolve( this.socket.emitTaskUpdated( dto, ctxWithUsers ) );
    return dto;
  }

  public async removeLabels(
    taskMongoId: string,
    labels: string[],
    ctx?: TeamTaskWsContext
  ): Promise<TeamTaskDto | null> {
    const clean = this.cleanStringArray( labels );
    if ( clean.length <= 0 ) return await this.getByMongoId( taskMongoId, "minimal" );

    const updated = await TeamTaskModel.findByIdAndUpdate(
      this.toObjectId( taskMongoId ),
      {
        $pull: { labels: { $in: clean } },
        $set: { updatedAt: new Date().toISOString() },
      },
      { new: true }
    )
      .lean<LeanRow>()
      .exec();

    if ( !updated ) return null;

    const dto = this.toDtoMinimal( updated );
    const ctxWithUsers = await this.withResolvedCtx( dto, ctx );
    await Promise.resolve( this.socket.emitTaskUpdated( dto, ctxWithUsers ) );
    return dto;
  }

  public async setAssignedMembers(
    taskMongoId: string,
    memberIds: string[],
    ctx?: TeamTaskWsContext
  ): Promise<TeamTaskDto | null> {
    // Replace whole assignedMembers array
    const ids = this.cleanStringArray( memberIds );
    const oids = ids.map( ( x ) => this.toObjectId( x ) );

    const updated = await TeamTaskModel.findByIdAndUpdate(
      this.toObjectId( taskMongoId ),
      {
        $set: {
          assignedMembers: oids,
          updatedAt: new Date().toISOString(),
        },
      },
      { new: true }
    )
      .lean<LeanRow>()
      .exec();

    if ( !updated ) return null;

    const dto = this.toDtoMinimal( updated );
    const ctxWithUsers = await this.withResolvedCtx( dto, ctx );
    await Promise.resolve( this.socket.emitTaskUpdated( dto, ctxWithUsers ) );
    return dto;
  }

  public async addAssignedMembers(
    taskMongoId: string,
    memberIds: string[],
    ctx?: TeamTaskWsContext
  ): Promise<TeamTaskDto | null> {
    const ids = this.cleanStringArray( memberIds );
    if ( ids.length <= 0 ) return await this.getByMongoId( taskMongoId, "minimal" );

    const oids = ids.map( ( x ) => this.toObjectId( x ) );

    const updated = await TeamTaskModel.findByIdAndUpdate(
      this.toObjectId( taskMongoId ),
      {
        $addToSet: { assignedMembers: { $each: oids } },
        $set: { updatedAt: new Date().toISOString() },
      },
      { new: true }
    )
      .lean<LeanRow>()
      .exec();

    if ( !updated ) return null;

    const dto = this.toDtoMinimal( updated );
    const ctxWithUsers = await this.withResolvedCtx( dto, ctx );
    await Promise.resolve( this.socket.emitTaskUpdated( dto, ctxWithUsers ) );
    return dto;
  }

  public async removeAssignedMembers(
    taskMongoId: string,
    memberIds: string[],
    ctx?: TeamTaskWsContext
  ): Promise<TeamTaskDto | null> {
    const ids = this.cleanStringArray( memberIds );
    if ( ids.length <= 0 ) return await this.getByMongoId( taskMongoId, "minimal" );

    const oids = ids.map( ( x ) => this.toObjectId( x ) );

    const updated = await TeamTaskModel.findByIdAndUpdate(
      this.toObjectId( taskMongoId ),
      {
        $pull: { assignedMembers: { $in: oids } },
        $set: { updatedAt: new Date().toISOString() },
      },
      { new: true }
    )
      .lean<LeanRow>()
      .exec();

    if ( !updated ) return null;

    const dto = this.toDtoMinimal( updated );
    const ctxWithUsers = await this.withResolvedCtx( dto, ctx );
    await Promise.resolve( this.socket.emitTaskUpdated( dto, ctxWithUsers ) );
    return dto;
  }

  public async setCaptain(
    taskMongoId: string,
    captainUserId: string | null,
    ctx?: TeamTaskWsContext
  ): Promise<TeamTaskDto | null> {
    // null clears it (controller supports that)
    return await this.update( taskMongoId, { assignedTaskCaptain: captainUserId }, ctx );
  }

  public async setLocation(
    taskMongoId: string,
    location: GeoLocation | null,
    ctx?: TeamTaskWsContext
  ): Promise<TeamTaskDto | null> {
    return await this.update( taskMongoId, { location }, ctx );
  }

  public async setAddress(
    taskMongoId: string,
    address: Address | null,
    ctx?: TeamTaskWsContext
  ): Promise<TeamTaskDto | null> {
    return await this.update( taskMongoId, { address }, ctx );
  }

  public async setNotes(
    taskMongoId: string,
    notes: string | null,
    ctx?: TeamTaskWsContext
  ): Promise<TeamTaskDto | null> {
    return await this.update( taskMongoId, { notes }, ctx );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Audit CRUD
  // ──────────────────────────────────────────────────────────────────────────

  public async getAudit( taskMongoId: string ): Promise<TaskAuditMeta | null> {
    const row = await TeamTaskModel.findById( this.toObjectId( taskMongoId ) )
      .select( { audit: 1 } )
      .lean<{ audit?: TaskAuditMeta; }>()
      .exec();

    if ( !row ) return null;
    return row.audit ?? null;
  }

  public async setAudit(
    taskMongoId: string,
    audit: TaskAuditMeta | null,
    ctx?: TeamTaskWsContext
  ): Promise<TeamTaskDto | null> {
    // Clean only if present (keeps exactOptionalPropertyTypes safe)
    const clean = audit ? this.cleanAudit( audit ) : null;
    return await this.update( taskMongoId, { audit: clean }, ctx );
  }

  public async patchAudit(
    taskMongoId: string,
    patch: TaskAuditMeta,
    ctx?: TeamTaskWsContext
  ): Promise<TeamTaskDto | null> {
    const current = await this.getAudit( taskMongoId );

    // If task not found -> null
    if ( current === null ) {
      const exists = await TeamTaskModel.exists( { _id: this.toObjectId( taskMongoId ) } );
      if ( !exists ) return null;

      // Audit missing but task exists -> set audit = patch
      return await this.setAudit( taskMongoId, patch, ctx );
    }

    // Merge shallowly (audit is a flat object in your contract style)
    const merged: TaskAuditMeta = { ...current, ...patch };
    return await this.setAudit( taskMongoId, merged, ctx );
  }

  public async clearAudit(
    taskMongoId: string,
    ctx?: TeamTaskWsContext
  ): Promise<TeamTaskDto | null> {
    return await this.update( taskMongoId, { audit: null }, ctx );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Timing CRUD
  // ──────────────────────────────────────────────────────────────────────────

  public async getTiming( taskMongoId: string ): Promise<TaskTiming | null> {
    const row = await TeamTaskModel.findById( this.toObjectId( taskMongoId ) )
      .select( { timing: 1 } )
      .lean<{ timing?: TaskTiming; }>()
      .exec();

    if ( !row ) return null;
    return row.timing ?? null;
  }

  public async setTiming(
    taskMongoId: string,
    timing: TaskTiming | null,
    ctx?: TeamTaskWsContext
  ): Promise<TeamTaskDto | null> {
    const clean = timing ? this.cleanTiming( timing ) : null;
    return await this.update( taskMongoId, { timing: clean }, ctx );
  }

  public async patchTiming(
    taskMongoId: string,
    patch: TaskTiming,
    ctx?: TeamTaskWsContext
  ): Promise<TeamTaskDto | null> {
    const current = await this.getTiming( taskMongoId );

    if ( current === null ) {
      const exists = await TeamTaskModel.exists( { _id: this.toObjectId( taskMongoId ) } );
      if ( !exists ) return null;

      // timing missing but task exists
      return await this.setTiming( taskMongoId, patch, ctx );
    }

    const merged: TaskTiming = { ...current, ...patch };
    return await this.setTiming( taskMongoId, merged, ctx );
  }

  public async clearTiming(
    taskMongoId: string,
    ctx?: TeamTaskWsContext
  ): Promise<TeamTaskDto | null> {
    return await this.update( taskMongoId, { timing: null }, ctx );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // SLA (COMPAT) — your system moved to deadlinePolicy
  // ──────────────────────────────────────────────────────────────────────────

  public async setSla(
    taskMongoId: string,
    policy: TaskDeadlinePolicy | null,
    ctx?: TeamTaskWsContext
  ): Promise<TeamTaskDto | null> {
    // Old method name kept for controller compatibility
    const clean = policy ? this.cleanDeadlinePolicy( policy ) : null;
    return await this.update( taskMongoId, { deadlinePolicy: clean }, ctx );
  }


  // ──────────────────────────────────────────────────────────────────────────
  // Advanced aggregate (enrich usernames)
  // ──────────────────────────────────────────────────────────────────────────

  private async getByMongoIdAdvanced( taskMongoId: string ): Promise<TeamTaskDto | null> {
    const pipeline = this.buildAdvancedPipeline(
      { _id: this.toObjectId( taskMongoId ) },
      { limit: 1, pageIndex: 0 },
      { sortBy: "createdAt", sortDir: "desc" }
    );

    const rows = await TeamTaskModel.aggregate( pipeline ).exec();
    if ( !Array.isArray( rows ) || rows.length <= 0 ) return null;

    return this.toDtoAdvanced( rows[ 0 ] as AdvancedRow );
  }

  private buildAdvancedPipeline( match: Record<string, unknown>, page: PaginationInput, sort: TeamTaskSortInput ): PipelineStage[] {
    const stages: PipelineStage[] = [];

    stages.push( { $match: match } );
    stages.push( { $sort: this.buildAggregateSort( sort ) } );
    stages.push( { $skip: page.pageIndex * page.limit } );
    stages.push( { $limit: page.limit } );

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
        assignedMemberUsernames: { $map: { input: "$assignedMemberUsers", as: "u", in: "$$u.username" } },
        captainUsername: { $let: { vars: { c: { $arrayElemAt: [ "$captainUser", 0 ] } }, in: "$$c.username" } },
      },
    } );

    stages.push( { $project: { assignedMemberUsers: 0, captainUser: 0 } } );

    return stages;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Filters + sorting (deadlinePolicy aware)
  // ──────────────────────────────────────────────────────────────────────────

  private buildFindQuery( filters: TeamTaskFilterInput ): FilterQuery<unknown> {
    const q: Record<string, unknown> = {};

    if ( filters.teamCode ) q.teamCode = filters.teamCode;
    if ( filters.teamMongoId ) q.teamMongoId = this.toObjectId( filters.teamMongoId );

    if ( filters.domain ) q.domain = filters.domain;
    if ( filters.status ) q.status = filters.status;
    if ( filters.priority ) q.priority = filters.priority;

    if ( filters.assignedMemberId ) q.assignedMembers = this.toObjectId( filters.assignedMemberId );
    if ( filters.captainUserId ) q.assignedTaskCaptain = this.toObjectId( filters.captainUserId );

    if ( filters.country ) q[ "address.country" ] = filters.country;
    if ( filters.city ) q[ "address.city" ] = filters.city;

    // ✅ deadlinePolicy dueAt range
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

    if ( filters.label && filters.label.trim() ) q.labels = filters.label.trim();

    if ( filters.q && filters.q.trim() ) q.$text = { $search: filters.q.trim() };

    return q as FilterQuery<unknown>;
  }

  private buildAggregateMatch( filters: TeamTaskFilterInput ): Record<string, unknown> {
    return this.buildFindQuery( filters ) as unknown as Record<string, unknown>;
  }

  private buildFindSort( sort: TeamTaskSortInput ): Record<string, 1 | -1> {
    const dir: 1 | -1 = sort.sortDir === "asc" ? 1 : -1;
    if ( sort.sortBy === "dueAt" ) return { "deadlinePolicy.dueAt": dir };
    return { [ sort.sortBy ]: dir } as Record<string, 1 | -1>;
  }

  private buildAggregateSort( sort: TeamTaskSortInput ): Record<string, 1 | -1> {
    return this.buildFindSort( sort );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // DTO mapping (model-aware)
  // ──────────────────────────────────────────────────────────────────────────

  private toDtoMinimal( doc: LeanRow ): TeamTaskDto {
    const dto: TeamTaskDto = {
      mongoId: String( doc._id ),

      id: String( doc.id ),

      teamCode: String( doc.teamCode ),
      teamMongoId: String( doc.teamMongoId ),

      domain: doc.domain as TeamDomain,

      name: typeof doc.name === "string" ? doc.name : "",
      description: typeof doc.description === "string" ? doc.description : "",

      assignedMembers: Array.isArray( doc.assignedMembers ) ? doc.assignedMembers.map( ( x ) => String( x ) ) : [],
      status: ( doc.status ?? "draft" ) as TaskStatus,
      priority: ( doc.priority ?? "medium" ) as TaskPriority,

      workItemCount: typeof doc.workItemCount === "number" ? doc.workItemCount : 0,

      timing: doc.timing ?? {},

      labels: Array.isArray( doc.labels ) ? doc.labels : [],

      createdAt: String( doc.createdAt ) as ISODateString,
      updatedAt: String( doc.updatedAt ) as ISODateString,
    };

    if ( doc.assignedTaskCaptain ) dto.assignedTaskCaptain = String( doc.assignedTaskCaptain );

    if ( doc.location ) dto.location = doc.location as GeoLocation;
    if ( doc.address ) dto.address = doc.address as Address;

    const ps = this.safeStr( doc.plannedStartAt );
    const pe = this.safeStr( doc.plannedEndAt );
    if ( ps ) dto.plannedStartAt = ps as ISODateString;
    if ( pe ) dto.plannedEndAt = pe as ISODateString;

    if ( doc.deadlinePolicy ) {
      const clean = this.cleanDeadlinePolicy( doc.deadlinePolicy );
      // Only attach if it has at least one meaningful key
      if ( this.hasAnyDeadlinePolicy( clean ) ) dto.deadlinePolicy = clean;
    }

    if ( doc.metrics && this.hasAnyMetrics( doc.metrics ) ) dto.metrics = doc.metrics as TaskRuntimeMetrics;

    if ( Array.isArray( doc.workItemMongoIds ) && doc.workItemMongoIds.length > 0 ) {
      dto.workItemMongoIds = doc.workItemMongoIds.map( ( x ) => String( x ) );
    }

    if ( Array.isArray( doc.blockedWindows ) && doc.blockedWindows.length > 0 ) {
      dto.blockedWindows = doc.blockedWindows as TaskBlockedWindow[];
    }

    if ( doc.completionConfirmation ) dto.completionConfirmation = doc.completionConfirmation as TaskCompletionConfirmation;

    if ( Array.isArray( doc.evidence ) && doc.evidence.length > 0 ) dto.evidence = doc.evidence as TaskEvidence[];

    const notes = this.safeStr( doc.notes );
    if ( notes ) dto.notes = notes;

    if ( doc.audit && this.hasAnyAudit( doc.audit ) ) dto.audit = this.cleanAudit( doc.audit );

    return dto;
  }

  private toDtoAdvanced( row: AdvancedRow ): TeamTaskDto {
    const base = this.toDtoMinimal( row );

    const assignedMemberUsernames = Array.isArray( row.assignedMemberUsernames )
      ? row.assignedMemberUsernames.map( ( x ) => ( typeof x === "string" ? x : "" ) ).filter( Boolean )
      : [];

    const captainUsername = typeof row.captainUsername === "string" ? row.captainUsername : "";

    return {
      ...base,
      ...( assignedMemberUsernames.length > 0 ? { assignedMemberUsernames } : {} ),
      ...( captainUsername ? { captainUsername } : {} ),
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // WS ctx helper (optional usernames for user:<username> emits)
  // ──────────────────────────────────────────────────────────────────────────

  private async withResolvedCtx( dto: TeamTaskDto, ctx?: TeamTaskWsContext ): Promise<TeamTaskWsContext | undefined> {
    if ( !ctx ) return undefined;

    // If caller already provided, keep it.
    if ( Array.isArray( ctx.assignedMemberUsernames ) && ctx.assignedMemberUsernames.length > 0 ) return ctx;

    // Resolve usernames from dto.assignedMembers (no extra DB fetch of task)
    if ( !Array.isArray( dto.assignedMembers ) || dto.assignedMembers.length <= 0 ) return ctx;

    const ids = dto.assignedMembers.map( ( x ) => this.toObjectId( x ) );
    const usernames = await this.resolveUsernamesByIds( ids );

    if ( usernames.length <= 0 ) return ctx;

    return {
      ...ctx,
      assignedMemberUsernames: usernames,
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // User helpers
  // ──────────────────────────────────────────────────────────────────────────

  private async resolveUsernamesByIds( ids: Types.ObjectId[] ): Promise<string[]> {
    if ( !Array.isArray( ids ) || ids.length <= 0 ) return [];

    const rows = await UserModel.find( { _id: { $in: ids } } )
      .select( { username: 1 } )
      .lean<Array<{ _id: Types.ObjectId; username?: string; }>>()
      .exec();

    return rows.map( ( r ) => ( typeof r.username === "string" ? r.username : "" ) ).filter( Boolean );
  }

  private toUserLiteDto( u: { _id: Types.ObjectId; username?: string; role?: string; email?: string; } ): TaskUserLiteDto {
    const dto: TaskUserLiteDto = {
      mongoId: String( u._id ),
      username: typeof u.username === "string" ? u.username : "",
    };

    if ( typeof u.role === "string" && u.role.trim() ) dto.role = u.role.trim();
    if ( typeof u.email === "string" && u.email.trim() ) dto.email = u.email.trim();

    return dto;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Validators
  // ──────────────────────────────────────────────────────────────────────────

  private assertDomain( domain?: TeamDomain ): void {
    if ( !domain ) return;
    if ( !TEAM_DOMAINS.includes( domain ) ) throw new Error( `Invalid domain: ${ domain }` );
  }

  private assertStatus( status?: TaskStatus ): void {
    if ( !status ) return;
    if ( !TASK_STATUSES.includes( status ) ) throw new Error( `Invalid status: ${ status }` );
  }

  private assertPriority( priority?: TaskPriority ): void {
    if ( !priority ) return;
    if ( !TASK_PRIORITIES.includes( priority ) ) throw new Error( `Invalid priority: ${ priority }` );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Cleaners (deadlinePolicy-aware)
  // ──────────────────────────────────────────────────────────────────────────

  private cleanStringArray( list: string[] ): string[] {
    if ( !Array.isArray( list ) ) return [];
    return list.map( ( x ) => ( typeof x === "string" ? x.trim() : "" ) ).filter( Boolean );
  }

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

  private cleanTiming( timing: TaskTiming ): TaskTiming {
    // Model uses nulls; normalize empty strings to null for correct querying.
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

  private cleanDeadlinePolicy( input: TaskDeadlinePolicy | { dueAt?: unknown; breachAt?: unknown; urgency?: unknown; } ): TaskDeadlinePolicy {
    const out: TaskDeadlinePolicy = {};

    const dueAt = this.safeStr( ( input as { dueAt?: unknown; } ).dueAt );
    const breachAt = this.safeStr( ( input as { breachAt?: unknown; } ).breachAt );

    // Policy allows null too (schema default is null)
    if ( typeof ( input as { dueAt?: unknown; } ).dueAt === "string" ) out.dueAt = dueAt ? dueAt : null;
    if ( ( input as { dueAt?: unknown; } ).dueAt === null ) out.dueAt = null;

    if ( typeof ( input as { breachAt?: unknown; } ).breachAt === "string" ) out.breachAt = breachAt ? breachAt : null;
    if ( ( input as { breachAt?: unknown; } ).breachAt === null ) out.breachAt = null;

    const urg = ( input as { urgency?: unknown; } ).urgency;
    if ( this.isUrgency( urg ) ) out.urgency = urg;
    if ( urg === null ) out.urgency = null;

    return out;
  }

  private cleanMetrics( metrics: TaskRuntimeMetrics ): TaskRuntimeMetrics {
    // Keep as-is, but normalize invalid numbers
    const out: TaskRuntimeMetrics = { ...metrics };

    // Common numeric guards (avoid NaN sneaking in)
    for ( const k of Object.keys( out ) ) {
      const v = ( out as unknown as Record<string, unknown> )[ k ];
      if ( typeof v === "number" && Number.isNaN( v ) ) ( out as unknown as Record<string, unknown> )[ k ] = 0;
    }

    return out;
  }

  private isUrgency( v: unknown ): v is TaskUrgencyLevel {
    return typeof v === "string" && ( TeamTaskService.URGENCY_VALUES as readonly string[] ).includes( v );
  }

  private hasAnyDeadlinePolicy( p: TaskDeadlinePolicy ): boolean {
    return typeof p.dueAt !== "undefined" || typeof p.breachAt !== "undefined" || typeof p.urgency !== "undefined";
  }

  private hasAnyMetrics( m: TaskRuntimeMetrics ): boolean {
    return Object.keys( m ).length > 0;
  }

  private hasAnyAudit( a: TaskAuditMeta ): boolean {
    return Object.keys( a ).length > 0;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Small helpers
  // ──────────────────────────────────────────────────────────────────────────

  private safeStr( v: unknown ): string {
    return typeof v === "string" ? v.trim() : "";
  }

  private toObjectId( id: string ): Types.ObjectId {
    return new Types.ObjectId( String( id ) );
  }
}
