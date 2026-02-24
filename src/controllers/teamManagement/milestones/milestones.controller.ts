// Path: src/controller/teamManagement/milestones/milestones.controller.ts
// ============================================================================
// MilestonesController (REST) — 100% CLASS-BASED (matches MilestoneRestService 1:1)
// ----------------------------------------------------------------------------
// ✅ FIXES APPLIED (ApiResponseBuilder alignment)
// - Uses ApiResponseBuilder.ok(...) with your working signature
// - Uses ApiResponseBuilder.error(...) only (no validationError helper)
// - Keeps response keys consistent: 'milestone' / 'milestones' / 'other'
// - Keeps path inside meta.other.path (your pattern)
// - Pagination uses meta.pagination.total (your pattern)
// ----------------------------------------------------------------------------
// ✅ IMPORTANT (your rules)
// - Constructor MUST NOT accept parameters
// - ApiGuardExport.GetAuthUser(req) is async -> MUST await
// - exactOptionalPropertyTypes safe: omit optionals (never assign undefined)
// ============================================================================

import type { Request, Response, RequestHandler } from "express";

import { ApiResponseBuilder } from "../../../utils/api-combiner.builder";
import { ApiGuardExport } from "../../../guard/api-router.guard";

import type {
  MilestoneEvidence,
  MilestonePriority,
  MilestoneStatus,
} from "../../../types/teamManagement/milestones/milestone.types";

import {
  MilestoneRestService,
  MilestoneServiceError,
  type MilestoneListFilters,
  type MilestoneListPaging,
  type MilestoneCreateInput,
  type MilestoneUpdateInput,
  type MilestoneAppendEvidenceInput,
  type MilestoneRemoveEvidenceInput,
  type MilestoneReplaceEvidenceInput,
  type MilestoneAppendTagInput,
  type MilestoneRemoveTagInput,
  type MilestoneReplaceTagsInput,
} from "../../../services/teamManagement/milestones/milestone.rest.service";

import type { MilestoneWsContext } from "../../../services/teamManagement/milestones/milestone.ws.service";
import type { AuthUser, AuthUserNormalized } from "../../../types/common";
import { NotificationHubEngineService } from '../../../services/notifications/notification-hub-engine.service';



// ============================================================================
// Controller
// ============================================================================

export class MilestonesController {
  private readonly service: MilestoneRestService;
  private readonly notificationHub: NotificationHubEngineService;
  //Recyclebin


  public constructor () {
    this.service = new MilestoneRestService();
    this.notificationHub = new NotificationHubEngineService();
  }

  // =========================================================================
  // GET
  // =========================================================================

  public readonly getById: RequestHandler = async ( req: Request, res: Response ) => {
    try {
      await this.mustAuth( req );

      const milestoneId = String( req.params?.id || "" ).trim();
      if ( !milestoneId ) {
        ApiResponseBuilder.validationError( res, "Invalid milestone ID!" );
        return;
      }

      const dto = await this.service.getById( milestoneId );

      ApiResponseBuilder.ok( res, "milestone", dto, "Data fetched successful", {
        other: { path: req.path },
      } );
      return;
    } catch ( err ) {
      this.handleErr( res, req, err );
      return;
    }
  };

  public readonly list: RequestHandler = async ( req: Request, res: Response ) => {
    try {
      await this.mustAuth( req );

      const filters = this.readListFilters( req );
      const paging = this.readPaging( req );

      const out = await this.service.list( filters, paging );

      ApiResponseBuilder.ok( res, "milestones", out.items, "Data fetched successful!", {
        other: { path: req.path },
        pagination: { total: out.other.total },
      } );
      return;
    } catch ( err ) {
      this.handleErr( res, req, err );
      return;
    }
  };

  public readonly count: RequestHandler = async ( req: Request, res: Response ) => {
    try {
      await this.mustAuth( req );

      const filters = this.readListFilters( req );
      const total = await this.service.count( filters );

      ApiResponseBuilder.ok( res, "other", { path: req.path }, "Data count fetched successful!", {
        pagination: { total },
      } );

      return;
    } catch ( err ) {
      this.handleErr( res, req, err );
      return;
    }
  };

  // =========================================================================
  // CREATE / UPDATE / DELETE
  // =========================================================================

  public readonly create: RequestHandler = async ( req: Request, res: Response ) => {
    try {
      const auth = await this.mustAuth( req );

      const actor = await ApiGuardExport.GetNormalisedAuthUser( req );

      if ( !actor ) {
        ApiResponseBuilder.conflict( res, 'Invalid authenticated user!' );
        return;
      }

      const ctx = this.buildWsContext( req, auth );

      const authNormalised = await this.mustAuthNormailsed( req );

      const input = this.readCreateInput( req, authNormalised );

      const dto = await this.service.create( ctx, input );

      if ( !dto ) {
        ApiResponseBuilder.error( res, 502, 'Falied to create milestone!' );
        return;
      }

      this.notificationHub.emit( {
        eventKey: 'milestone:created',
        actor,
        audiences: [
          {
            mode: 'User',
            username: actor.userId,
          },
          {
            mode: 'Role',
            roleKey: 'admin'
          },
          {
            mode: 'Role',
            roleKey: 'operator'
          },
          {
            mode: 'Role',
            roleKey: 'manager'
          },
        ],
        category: 'Team',
        target: {
          actionKey: 'team:member.milestone.created',
          params: { milestoneId: dto._id },
          refId: String( dto._id ),
          module: 'Millestone module',
          category: 'Team',
          route: '',
        },
      } );

      ApiResponseBuilder.ok( res, "milestone", dto, "Milestone created successfully!", {
        other: { path: req.path },
      } );
      return;
    } catch ( err ) {
      this.handleErr( res, req, err );
      return;
    }
  };

  public readonly updateById: RequestHandler = async ( req: Request, res: Response ) => {
    try {
      const auth = await this.mustAuth( req );

      const actor = await ApiGuardExport.GetNormalisedAuthUser( req );

      if ( !actor ) {
        ApiResponseBuilder.conflict( res, 'Invalid authenticated user!' );
        return;
      }

      const authNormalised = await this.mustAuthNormailsed( req );

      const milestoneId = String( req.params?.id || "" ).trim();
      if ( !milestoneId ) {
        ApiResponseBuilder.validationError( res, "Milestone id is required." );
        return;
      }

      const ctx = this.buildWsContext( req, auth, {
        milestoneId,
        workItemId: this.readOptionalString( req.body?.workItemId ),
        teamCode: this.readOptionalString( req.body?.teamCode ),
        memberUserIds: this.readOptionalStringArray( req.body?.memberUserIds ),
      } );

      const input = this.readUpdateInput( req, authNormalised );
      const dto = await this.service.updateById( ctx, milestoneId, input );

      this.notificationHub.emit( {
        eventKey: 'milestone:updated',
        actor,
        audiences: [
          {
            mode: 'User',
            username: actor.userId,
          },
          {
            mode: 'Role',
            roleKey: 'admin'
          },
          {
            mode: 'Role',
            roleKey: 'operator'
          },
          {
            mode: 'Role',
            roleKey: 'manager'
          },
        ],
        category: 'Team',
        target: {
          actionKey: 'team:member.milestone.updated',
          params: { milestoneId: dto._id },
          refId: String( dto._id ),
          module: 'Millestone module',
          category: 'Team',
          route: '',
        },
      } );

      ApiResponseBuilder.ok( res, "milestone", dto, "Milestone updated successfully!", {
        other: { path: req.path },
      } );
      return;
    } catch ( err ) {
      this.handleErr( res, req, err );
      return;
    }
  };

  public readonly deleteById: RequestHandler = async ( req: Request, res: Response ) => {
    try {
      const auth = await this.mustAuth( req );

      const milestoneId = String( req.params?.id || "" ).trim();
      if ( !milestoneId ) {
        ApiResponseBuilder.validationError( res, "Milestone id is required." );
        return;
      }



      const ctx = this.buildWsContext( req, auth, {
        milestoneId,
        workItemId: this.readOptionalString( req.query?.workItemId ),
        teamCode: this.readOptionalString( req.query?.teamCode ),
        memberUserIds: this.readOptionalStringArray( req.query?.memberUserIds ),
      } );

      const actor = await ApiGuardExport.GetNormalisedAuthUser( req );

      if ( !actor ) {
        ApiResponseBuilder.conflict( res, 'Invalid authenticated user!' );
        return;
      }



      await this.service.deleteById( ctx, milestoneId );

      this.notificationHub.emit( {
        eventKey: 'milestone:deleted',
        actor,
        audiences: [
          {
            mode: 'User',
            username: actor.userId,
          },
          {
            mode: 'Role',
            roleKey: 'admin'
          },
          {
            mode: 'Role',
            roleKey: 'operator'
          },
          {
            mode: 'Role',
            roleKey: 'manager'
          },
        ],
        target: {
          actionKey: 'team:member.milestone.deleted',
          params: { milestoneId },
          refId: milestoneId,
          module: 'Milestone module',
          category: 'Team',
          route: '',
        },
        
      } );

      ApiResponseBuilder.ok( res, "other", { deleted: true, path: req.path }, "Milestone deleted successfully!", );
      return;
    } catch ( err ) {
      this.handleErr( res, req, err );
      return;
    }
  };

  // =========================================================================
  // Evidence
  // =========================================================================

  public readonly appendEvidence: RequestHandler = async ( req: Request, res: Response ) => {
    try {
      const auth = await this.mustAuth( req );
      const authNormalised = await this.mustAuthNormailsed( req );

      const milestoneId = String( req.params?.id || "" ).trim();
      if ( !milestoneId ) {
        ApiResponseBuilder.validationError( res, "Milestone id is required." );
        return;
      }

      const ctx = this.buildWsContext( req, auth, {
        milestoneId,
        workItemId: this.readOptionalString( req.body?.workItemId ),
        teamCode: this.readOptionalString( req.body?.teamCode ),
        memberUserIds: this.readOptionalStringArray( req.body?.memberUserIds ),
      } );

      const evidence = this.readEvidenceArray( req.body?.evidence );

      const input: MilestoneAppendEvidenceInput = {
        evidence,
        updatedByUserId: authNormalised.userId,
      };

      const dto = await this.service.appendEvidence( ctx, milestoneId, input );

      ApiResponseBuilder.ok( res, "milestone", dto, "Evidence uploaded successfully!", {
        other: { path: req.path },
      } );
      return;
    } catch ( err ) {
      this.handleErr( res, req, err );
      return;
    }
  };

  public readonly removeEvidence: RequestHandler = async ( req: Request, res: Response ) => {
    try {
      const auth = await this.mustAuth( req );
      const authNormalised = await this.mustAuthNormailsed( req );

      const milestoneId = String( req.params?.id || "" ).trim();
      if ( !milestoneId ) {
        ApiResponseBuilder.validationError( res, "Milestone id is required." );
        return;
      }

      const ctx = this.buildWsContext( req, auth, {
        milestoneId,
        workItemId: this.readOptionalString( req.body?.workItemId ),
        teamCode: this.readOptionalString( req.body?.teamCode ),
        memberUserIds: this.readOptionalStringArray( req.body?.memberUserIds ),
      } );

      const relPath = this.readOptionalString( req.body?.relPath );
      const url = this.readOptionalString( req.body?.url );

      const input: MilestoneRemoveEvidenceInput = {
        ...( relPath ? { relPath } : {} ),
        ...( url ? { url } : {} ),
        updatedByUserId: authNormalised.userId,
      };

      const dto = await this.service.removeEvidence( ctx, milestoneId, input );

      ApiResponseBuilder.ok( res, "milestone", dto, "Evidence removed successfully!", {
        other: { path: req.path },
      } );
      return;
    } catch ( err ) {
      this.handleErr( res, req, err );
      return;
    }
  };

  public readonly replaceEvidence: RequestHandler = async ( req: Request, res: Response ) => {
    try {
      const auth = await this.mustAuth( req );
      const authNormalised = await this.mustAuthNormailsed( req );

      const milestoneId = String( req.params?.id || "" ).trim();
      if ( !milestoneId ) {
        ApiResponseBuilder.validationError( res, "Milestone id is required." );
        return;
      }

      const ctx = this.buildWsContext( req, auth, {
        milestoneId,
        workItemId: this.readOptionalString( req.body?.workItemId ),
        teamCode: this.readOptionalString( req.body?.teamCode ),
        memberUserIds: this.readOptionalStringArray( req.body?.memberUserIds ),
      } );

      const evidence = this.readEvidenceArray( req.body?.evidence );

      const input: MilestoneReplaceEvidenceInput = {
        evidence,
        updatedByUserId: authNormalised.userId,
      };

      const dto = await this.service.replaceEvidence( ctx, milestoneId, input );

      ApiResponseBuilder.ok( res, "milestone", dto, "Evidence replaced successfully!", {
        other: { path: req.path },
      } );
      return;
    } catch ( err ) {
      this.handleErr( res, req, err );
      return;
    }
  };

  // =========================================================================
  // Tags
  // =========================================================================

  public readonly appendTag: RequestHandler = async ( req: Request, res: Response ) => {
    try {
      const auth = await this.mustAuth( req );
      const authNormalised = await this.mustAuthNormailsed( req );

      const milestoneId = String( req.params?.id || "" ).trim();
      if ( !milestoneId ) {
        ApiResponseBuilder.validationError( res, "Milestone id is required." );
        return;
      }

      const ctx = this.buildWsContext( req, auth, {
        milestoneId,
        workItemId: this.readOptionalString( req.body?.workItemId ),
        teamCode: this.readOptionalString( req.body?.teamCode ),
        memberUserIds: this.readOptionalStringArray( req.body?.memberUserIds ),
      } );

      const tag = this.readRequiredString( req.body?.tag, "tag" );

      const input: MilestoneAppendTagInput = {
        tag,
        updatedByUserId: authNormalised.userId,
      };

      const dto = await this.service.appendTag( ctx, milestoneId, input );

      ApiResponseBuilder.ok( res, "milestone", dto, "Tag appended successfully!", {
        other: { path: req.path },
      } );
      return;
    } catch ( err ) {
      this.handleErr( res, req, err );
      return;
    }
  };

  public readonly removeTag: RequestHandler = async ( req: Request, res: Response ) => {
    try {
      const auth = await this.mustAuth( req );
      const authNormalised = await this.mustAuthNormailsed( req );

      const milestoneId = String( req.params?.id || "" ).trim();
      if ( !milestoneId ) {
        ApiResponseBuilder.validationError( res, "Milestone id is required." );
        return;
      }

      const ctx = this.buildWsContext( req, auth, {
        milestoneId,
        workItemId: this.readOptionalString( req.body?.workItemId ),
        teamCode: this.readOptionalString( req.body?.teamCode ),
        memberUserIds: this.readOptionalStringArray( req.body?.memberUserIds ),
      } );

      const tag = this.readRequiredString( req.body?.tag, "tag" );

      const input: MilestoneRemoveTagInput = {
        tag,
        updatedByUserId: authNormalised.userId,
      };

      const dto = await this.service.removeTag( ctx, milestoneId, input );

      ApiResponseBuilder.ok( res, "milestone", dto, "Tag removed successfully!", {
        other: { path: req.path },
      } );
      return;
    } catch ( err ) {
      this.handleErr( res, req, err );
      return;
    }
  };

  public readonly replaceTags: RequestHandler = async ( req: Request, res: Response ) => {
    try {
      const auth = await this.mustAuth( req );
      const authNormalised = await this.mustAuthNormailsed( req );

      const milestoneId = String( req.params?.id || "" ).trim();
      if ( !milestoneId ) {
        ApiResponseBuilder.validationError( res, "Milestone id is required." );
        return;
      }

      const ctx = this.buildWsContext( req, auth, {
        milestoneId,
        workItemId: this.readOptionalString( req.body?.workItemId ),
        teamCode: this.readOptionalString( req.body?.teamCode ),
        memberUserIds: this.readOptionalStringArray( req.body?.memberUserIds ),
      } );

      const tags = this.readTagsArray( req.body?.tags );

      const input: MilestoneReplaceTagsInput = {
        tags,
        updatedByUserId: authNormalised.userId,
      };

      const dto = await this.service.replaceTags( ctx, milestoneId, input );

      ApiResponseBuilder.ok( res, "milestone", dto, "Tags replaced successfully!", {
        other: { path: req.path },
      } );
      return;
    } catch ( err ) {
      this.handleErr( res, req, err );
      return;
    }
  };

  // =========================================================================
  // Readers (filters / paging / inputs) — exactOptionalPropertyTypes safe
  // =========================================================================

  private readListFilters( req: Request ): MilestoneListFilters {
    const teamId = this.readRequiredString( req.query?.teamId, "teamId" );

    const workItemId = this.readOptionalString( req.query?.workItemId );
    const userId = this.readOptionalString( req.query?.userId );

    const statusRaw = this.readOptionalString( req.query?.status );
    const priorityRaw = this.readOptionalString( req.query?.priority );

    const startFrom = this.readOptionalString( req.query?.startFrom );
    const startTo = this.readOptionalString( req.query?.startTo );
    const q = this.readOptionalString( req.query?.q );

    return {
      teamId,
      ...( workItemId ? { workItemId } : {} ),
      ...( userId ? { userId } : {} ),
      ...( statusRaw ? { status: statusRaw as MilestoneStatus } : {} ),
      ...( priorityRaw ? { priority: priorityRaw as MilestonePriority } : {} ),
      ...( startFrom ? { startFrom } : {} ),
      ...( startTo ? { startTo } : {} ),
      ...( q ? { q } : {} ),
    };
  }

  private readPaging( req: Request ): MilestoneListPaging {
    const pageRaw = this.readOptionalString( req.query?.page );
    const limitRaw = this.readOptionalString( req.query?.limit );

    const pageNum = pageRaw ? Number( pageRaw ) : 1;
    const limitNum = limitRaw ? Number( limitRaw ) : 20;

    return {
      page: Number.isFinite( pageNum ) && pageNum >= 1 ? Math.floor( pageNum ) : 1,
      limit: Number.isFinite( limitNum ) && limitNum >= 1 ? Math.floor( limitNum ) : 20,
    };
  }

  private readCreateInput( req: Request, auth: AuthUserNormalized ): MilestoneCreateInput {
    const workItemId = this.readRequiredString( req.body?.workItemId, "workItemId" );
    const teamId = this.readRequiredString( req.body?.teamId, "teamId" );
    const userId = this.readRequiredString( req.body?.userId, "userId" );

    const title = this.readRequiredString( req.body?.title, "title" );
    const notes = this.readOptionalString( req.body?.notes );

    const startAt = this.readRequiredString( req.body?.startAt, "startAt" );
    const endAt = this.readRequiredString( req.body?.endAt, "endAt" );

    const allDay = this.readRequiredBoolean( req.body?.allDay, "allDay" );
    const timezone = this.readOptionalString( req.body?.timezone );

    const status = this.readRequiredString( req.body?.status, "status" ) as MilestoneStatus;
    const priority = this.readRequiredString( req.body?.priority, "priority" ) as MilestonePriority;

    const progressTargetRaw = req.body?.progressTarget;
    const progressTarget =
      typeof progressTargetRaw === "number" && Number.isFinite( progressTargetRaw ) ? progressTargetRaw : null;

    const tags = this.readOptionalTagsArray( req.body?.tags );

    const requestId = this.readOptionalString( req.body?.requestId ) ?? this.getRequestId( req );
    const source = this.readOptionalString( req.body?.source ) as "rest" | "ws" | "system" | null;

    return {
      workItemId,
      teamId,
      userId,

      createdByUserId: auth.userId,

      ...( requestId ? { requestId } : {} ),
      ...( source ? { source } : {} ),

      title,
      ...( notes ? { notes } : {} ),

      startAt,
      endAt,
      allDay,
      ...( timezone ? { timezone } : {} ),

      status,
      priority,

      ...( progressTarget !== null ? { progressTarget } : {} ),
      ...( tags && tags.length > 0 ? { tags } : {} ),
    };
  }

  private readUpdateInput( req: Request, auth: AuthUserNormalized ): MilestoneUpdateInput {
    const title = this.readOptionalString( req.body?.title );
    const notes = this.readOptionalString( req.body?.notes );

    const startAt = this.readOptionalString( req.body?.startAt );
    const endAt = this.readOptionalString( req.body?.endAt );

    const allDayRaw = req.body?.allDay;
    const allDay = typeof allDayRaw === "boolean" ? allDayRaw : null;

    const timezone = this.readOptionalString( req.body?.timezone );

    const statusRaw = this.readOptionalString( req.body?.status );
    const priorityRaw = this.readOptionalString( req.body?.priority );

    const progressTargetRaw = req.body?.progressTarget;
    const progressTarget =
      typeof progressTargetRaw === "number" && Number.isFinite( progressTargetRaw ) ? progressTargetRaw : null;

    const tags = req.body?.tags !== undefined ? this.readTagsArray( req.body?.tags ) : null;

    return {
      ...( title !== null ? { title } : {} ),
      ...( notes !== null ? { notes } : {} ),
      ...( startAt ? { startAt } : {} ),
      ...( endAt ? { endAt } : {} ),
      ...( allDay !== null ? { allDay } : {} ),
      ...( timezone ? { timezone } : {} ),
      ...( statusRaw ? { status: statusRaw as MilestoneStatus } : {} ),
      ...( priorityRaw ? { priority: priorityRaw as MilestonePriority } : {} ),
      ...( progressTarget !== null ? { progressTarget } : {} ),
      ...( tags !== null ? { tags } : {} ),

      updatedByUserId: auth.userId,
    };
  }

  // =========================================================================
  // Evidence readers (strict, label-required)
  // =========================================================================

  private readEvidenceArray( raw: unknown ): MilestoneEvidence[] {
    if ( !Array.isArray( raw ) ) {
      throw new MilestoneServiceError( "VALIDATION_ERROR", "evidence must be an array." );
    }

    const out: MilestoneEvidence[] = raw.map( ( x ) => this.readEvidence( x ) );

    if ( out.length === 0 ) {
      throw new MilestoneServiceError( "VALIDATION_ERROR", "evidence must contain at least one item." );
    }

    return out;
  }

  private readEvidence( raw: unknown ): MilestoneEvidence {
    if ( !raw || typeof raw !== "object" ) {
      throw new MilestoneServiceError( "VALIDATION_ERROR", "evidence item is invalid." );
    }

    const e = raw as {
      label?: unknown;
      relPath?: unknown;
      url?: unknown;
      mimeType?: unknown;
      originalName?: unknown;
      storedName?: unknown;
      sizeBytes?: unknown;
      uploadedAt?: unknown; // must become Date
    };

    const label = typeof e.label === "string" ? e.label.trim() : "";
    const relPath = typeof e.relPath === "string" ? e.relPath.trim() : "";
    const url = typeof e.url === "string" ? e.url.trim() : "";
    const mimeType = typeof e.mimeType === "string" ? e.mimeType.trim() : "";
    const originalName = typeof e.originalName === "string" ? e.originalName.trim() : "";

    if ( !label ) throw new MilestoneServiceError( "VALIDATION_ERROR", "evidence.label is required." );
    if ( !relPath ) throw new MilestoneServiceError( "VALIDATION_ERROR", "evidence.relPath is required." );
    if ( !url ) throw new MilestoneServiceError( "VALIDATION_ERROR", "evidence.url is required." );
    if ( !mimeType ) throw new MilestoneServiceError( "VALIDATION_ERROR", "evidence.mimeType is required." );
    if ( !originalName ) throw new MilestoneServiceError( "VALIDATION_ERROR", "evidence.originalName is required." );

    // REQUIRED
    const sizeBytes =
      typeof e.sizeBytes === "number" && Number.isFinite( e.sizeBytes )
        ? e.sizeBytes
        : NaN;

    if ( !Number.isFinite( sizeBytes ) || sizeBytes < 0 ) {
      throw new MilestoneServiceError(
        "VALIDATION_ERROR",
        "evidence.sizeBytes is required and must be a valid number."
      );
    }

    // uploadedAt must be Date
    let uploadedAt: Date;

    if ( e.uploadedAt instanceof Date ) {
      uploadedAt = e.uploadedAt;
    } else if ( typeof e.uploadedAt === "string" ) {
      const d = new Date( e.uploadedAt );
      if ( Number.isNaN( d.getTime() ) ) {
        throw new MilestoneServiceError(
          "VALIDATION_ERROR",
          "evidence.uploadedAt must be a valid ISO date."
        );
      }
      uploadedAt = d;
    } else {
      // If your model requires it, enforce it:
      uploadedAt = new Date(); // or throw validation error
    }

    const storedName =
      typeof e.storedName === "string" ? e.storedName.trim() : "";

    const out: MilestoneEvidence = {
      label,
      relPath,
      url,
      mimeType,
      originalName,
      sizeBytes,
      uploadedAt, // ✅ now Date
      ...( storedName ? { storedName } : {} ),
    };

    return out;
  }




  // =========================================================================
  // Tags readers
  // =========================================================================

  private readOptionalTagsArray( raw: unknown ): string[] | null {
    if ( raw === undefined || raw === null ) return null;
    return this.readTagsArray( raw );
  }

  private readTagsArray( raw: unknown ): string[] {
    if ( !Array.isArray( raw ) ) {
      throw new MilestoneServiceError( "VALIDATION_ERROR", "tags must be an array." );
    }

    return raw
      .map( ( x ) => ( typeof x === "string" ? x.trim() : "" ) )
      .filter( ( x ) => x.length > 0 );
  }

  // =========================================================================
  // WS Context builder
  // =========================================================================

  private buildWsContext(
    req: Request,
    auth: AuthUser,
    patch?: {
      teamCode?: string | null;
      workItemId?: string | null;
      milestoneId?: string | null;
      memberUserIds?: string[] | null;
    }
  ): MilestoneWsContext {
    const requestId = this.getRequestId( req );

    const base: MilestoneWsContext = {
      actor: {
        userId: auth.userId,
        username: auth.username,
        role: auth.role,
        name: auth.name,
      },
      requestId,
    };

    const teamCode = patch?.teamCode ?? null;
    const workItemId = patch?.workItemId ?? null;
    const milestoneId = patch?.milestoneId ?? null;
    const memberUserIds = patch?.memberUserIds ?? null;

    return {
      ...base,
      ...( teamCode ? { teamCode } : {} ),
      ...( workItemId ? { workItemId } : {} ),
      ...( milestoneId ? { milestoneId } : {} ),
      ...( memberUserIds && memberUserIds.length > 0 ? { memberUserIds } : {} ),
    };
  }

  // =========================================================================
  // Auth / error handling
  // =========================================================================

  private async mustAuthNormailsed( req: Request ): Promise<AuthUserNormalized> {
    const auth = await ApiGuardExport.GetNormalisedAuthUser( req );
    if ( !auth ) {
      throw new MilestoneServiceError( "UNAUTHORIZED", "Unauthorized." );
    }
    return auth as AuthUserNormalized;
  }

  private async mustAuth( req: Request ): Promise<AuthUser> {
    const auth = await ApiGuardExport.GetAuthUser( req );
    if ( !auth ) {
      throw new MilestoneServiceError( "UNAUTHORIZED", "Unauthorized." );
    }
    return auth;
  }

  private handleErr( res: Response, req: Request, err: unknown ): void {
    if ( err instanceof MilestoneServiceError ) {
      ApiResponseBuilder.error( res, Number( err.code ), err.message );
      return;
    }

    if ( err instanceof Error ) {
      ApiResponseBuilder.internalError( res, err.message );
      return;
    }

    ApiResponseBuilder.internalError( res, "Unknown error." );
  }

  // =========================================================================
  // Safe primitive readers
  // =========================================================================

  private getRequestId( req: Request ): string {
    const asAny = req as unknown as { requestId?: unknown; };
    if ( typeof asAny.requestId === "string" && asAny.requestId.trim() ) return asAny.requestId.trim();

    const header = req.headers[ "x-request-id" ];
    if ( typeof header === "string" && header.trim() ) return header.trim();

    return `${ Date.now() }_${ Math.random().toString( 16 ).slice( 2 ) }`;
  }

  private readRequiredString( raw: unknown, field: string ): string {
    const v = typeof raw === "string" ? raw.trim() : "";
    if ( !v ) throw new MilestoneServiceError( "VALIDATION_ERROR", `${ field } is required.` );
    return v;
  }

  private readOptionalString( raw: unknown ): string | null {
    const v = typeof raw === "string" ? raw.trim() : "";
    return v ? v : null;
  }

  private readRequiredBoolean( raw: unknown, field: string ): boolean {
    if ( typeof raw !== "boolean" ) {
      throw new MilestoneServiceError( "VALIDATION_ERROR", `${ field } must be boolean.` );
    }
    return raw;
  }

  private readOptionalStringArray( raw: unknown ): string[] | null {
    if ( raw === undefined || raw === null ) return null;

    if ( Array.isArray( raw ) ) {
      const cleaned = raw
        .map( ( x ) => ( typeof x === "string" ? x.trim() : "" ) )
        .filter( ( x ) => x.length > 0 );
      return cleaned.length > 0 ? cleaned : null;
    }

    if ( typeof raw === "string" ) {
      const cleaned = raw
        .split( "," )
        .map( ( x ) => x.trim() )
        .filter( ( x ) => x.length > 0 );
      return cleaned.length > 0 ? cleaned : null;
    }

    return null;
  }
}
