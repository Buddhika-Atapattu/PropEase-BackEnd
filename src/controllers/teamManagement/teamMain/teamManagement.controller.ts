// Path: src/controller/teamManagement/teamMain/teamManagement.controller.ts
// ============================================================================
// TeamManagementController — Team Management (MAIN) REST Controller
// ----------------------------------------------------------------------------
// PURPOSE
// - Controller layer for Team Management MAIN (teams CRUD + list + stats + users analytics).
// - Uses ApiResponseBuilder for consistent JSON responses.
// - Emits WS events via TeamManagementWsService after successful mutations.
// - Keeps router thin: router should only map routes -> controller methods.
//
// IMPORTANT PROJECT RULES (your rules)
// - 100% class-based (no standalone functions).
// - Use: res.status(...).json(...); return;   (Promise<void> friendly)
// - Avoid passing `undefined` to optional props (exactOptionalPropertyTypes-safe).
// - Console logs must have flags and end with '\n'.
// - ApiGuardExport.GetAuthUser(req) is async and MUST be awaited.
// ============================================================================

import type { Request, Response } from "express";
import path from "path";
import { Types } from "mongoose";

import { ApiResponseBuilder } from "../../../utils/api-combiner.builder";
import FileUploader, { type UploadResultPacket } from "../../../utils/files/file-uploader.helper";

import type { AuthUser } from "../../../types/common";
import type { NotificationActorDto, NotificationAudience, NotificationCategory } from "../../../types/notification/notification.types";


import { FileMetaPacketBuilder } from "../../../utils/files/file-meta-packet.builder";

import { RecycleBinDomainDeleteService, type DomainDeletePlan } from "../../../services/recyclebin/recyclebin-domain-delete.service";
import { NotificationHubEngineService } from "../../../services/notifications/notification-hub-engine.service";

import { ApiGuardExport } from "../../../guard/api-router.guard";

import type {
  TeamDomain,
  TeamMember,
  TeamManagementDto,
} from "../../../types/teamManagement/teamMain/teamManagement.types";

import { FileMetaPacket, type PaginationMeta } from "../../../types/common";

import { TeamManagementModel } from "../../../models/teamManagement/teamMain/teamManagement.model";
import { UserModel, USER_MODEL_PROJECTION } from "../../../models/user.model";
import type { User } from "../../../models/user.model";

import { TeamManagementRestService } from "../../../services/teamManagement/teamMain/teamManagement.rest.service";
import { TeamManagementWsService, type TeamWsContext } from "../../../services/teamManagement/teamMain/teamManagement.ws.service";

// ---------------------------------------------------------------------------
// Shape for aggregated "user + team" view (same as old router)
// ---------------------------------------------------------------------------
interface AllUserWithTeams extends User {
  domain?: TeamDomain;
  teamName?: string;
  roleInTeam?: "member" | "lead" | "supervisor" | "observer" | null;
  teamReason?: string | null;
  teamJoinedAt?: string | null;
  teams: {
    domain?: TeamDomain;
    teamName?: string;
  }[];
}

export class TeamManagementController {

  // ---------------------------------------------------------------------------
  // Integrations
  // ---------------------------------------------------------------------------
  private readonly notificationHub: NotificationHubEngineService = new NotificationHubEngineService();
  private readonly deleteSvc: RecycleBinDomainDeleteService = new RecycleBinDomainDeleteService();

  // ---------------------------------------------------------------------------
  // Upload policy (requested)
  // ---------------------------------------------------------------------------
  private readonly MAX_FILES_TOTAL = 20;
  private readonly MAX_FILE_SIZE_MB = 20;
  private readonly MAX_IMAGES_PER_PROPERTY = 20; // constrained by MAX_FILES_TOTAL anyway
  private readonly MAX_DOCS_PER_PROPERTY = 20;   // constrained by MAX_FILES_TOTAL anyway
  /**
   * Public upload URL root (relative).
   * NOTE: your project uses top-level public/ folder outside src/,
   * so we build URLs as: `${root}/${PUBLIC_UPLOAD_URL_ROOT}/...`
   */
  private readonly PUBLIC_UPLOAD_URL_ROOT: string = "uploads/team-management";

  private readonly rest: TeamManagementRestService;
  private readonly ws: TeamManagementWsService;

  public constructor () {
    this.rest = new TeamManagementRestService();
    this.ws = new TeamManagementWsService();
  }

  // ========================================================================
  // 1) Core helpers (requestId + actor WS context)
  // ========================================================================

  private getRequestId( req: Request ): string {
    const anyReq = req as unknown as { requestId?: unknown; };
    const fromReq = typeof anyReq.requestId === "string" ? anyReq.requestId : "";
    const fromHeader = typeof req.headers[ "x-request-id" ] === "string" ? req.headers[ "x-request-id" ] : "";
    return fromReq || fromHeader || `req_${ Date.now().toString( 36 ) }`;
  }

  private async buildWsContext( req: Request ): Promise<TeamWsContext> {
    const requestId = this.getRequestId( req );

    // ✅ IMPORTANT: async
    const authUser = await ApiGuardExport.GetAuthUser( req );

    // username is required by your AuthUser type
    const username: string = String( authUser?.username ?? "" ).trim();
    if ( !username ) {
      // If this happens, it means guard is misconfigured or req is not authenticated.
      // We keep it deterministic for debugging.
      console.error( "[Error:] [TeamManagementController] buildWsContext missing username.\n" );
    }

    // role is required by your AuthUser type
    const role: string = String( authUser?.role ?? "" );

    // exactOptionalPropertyTypes-safe: omit if empty
    const userIdCandidate: string = String( authUser?.sub ?? "" ).trim();
    const teamCodesCandidate = Array.isArray( authUser?.teamCodes ) ? authUser.teamCodes : undefined;
    const branchIdCandidate: string = String( authUser?.branchId ?? "" ).trim();

    const actorBase: TeamWsContext[ "actor" ] = { username, role };

    const actorWithId = userIdCandidate
      ? { ...actorBase, userId: userIdCandidate }
      : actorBase;

    const actorWithTeams = teamCodesCandidate && teamCodesCandidate.length > 0
      ? { ...actorWithId, teamCodes: teamCodesCandidate }
      : actorWithId;

    const actorFinal = branchIdCandidate
      ? { ...actorWithTeams, branchId: branchIdCandidate }
      : actorWithTeams;

    return { requestId, actor: actorFinal };
  }

  private parsePagination( req: Request, fallbackLimit: number = 10 ): { index: number; limit: number; skip: number; } {
    return this.rest.parsePagination( req.query.index, req.query.limit, fallbackLimit );
  }

  private parseBooleanQuery( value: unknown ): boolean | undefined {
    return this.rest.parseBooleanQuery( value );
  }

  private isValidTeamDomain( raw: string ): raw is TeamDomain {
    return this.rest.isValidTeamDomain( raw );
  }

  // ========================================================================
  // 2) POST /create
  // ========================================================================

  public async createTeam( req: Request, res: Response ): Promise<void> {
    try {
      const auth = await ApiGuardExport.GetAuthUser( req );
      if ( !auth ) {
        ApiResponseBuilder.conflict( res, 'Invalid auth user!' );
        return;
      }

      const nowIso: string = new Date().toISOString();
      const root = `${ req.protocol }://${ req.get( "host" ) }`;

      // We generate teamCode here (so multipart upload can go to final folder).
      const teamCode: string = this.rest.generateTeamIdentity();

      let payload: Record<string, unknown> = {};
      let teamLogoEvidence: unknown | undefined;

      const contentType = ( req.headers[ "content-type" ] ?? "" ).toString();
      const isMultipart = contentType.includes( "multipart/form-data" );

      if ( isMultipart ) {
        // Upload first (into final path using generated teamCode)
        const uploadSubPath: string = `team-management/${ teamCode }/logo`;

        let uploadedFiles: UploadResultPacket | null = null;
        try {
          uploadedFiles = await FileUploader.handleUpload( uploadSubPath, "teamLogo", req );
        } catch ( uploadError ) {
          console.error( "[Warning:] [TeamManagementController:createTeam] Logo upload failed.\n", uploadError );
        }

        // Parse "team" JSON payload from multipart field
        const rawTeamField: unknown = ( req.body as unknown as { team?: unknown; } )?.team;
        if ( typeof rawTeamField !== "string" || !rawTeamField.trim() ) {
          ApiResponseBuilder.validationError( res, "Invalid team payload: expected JSON string in 'team' field" );
          return;
        }

        try {
          payload = JSON.parse( rawTeamField ) as Record<string, unknown>;
        } catch ( parseError ) {
          console.error( "[Error:] [TeamManagementController:createTeam] Failed to parse 'team' JSON.\n", parseError );
          ApiResponseBuilder.validationError( res, "Malformed team JSON payload" );
          return;
        }

        // Build evidence DTO from uploaded logo (if present)
        const logoArr = uploadedFiles?.byField?.teamLogo;
        if ( Array.isArray( logoArr ) && logoArr.length > 0 ) {
          const fileMeta: FileMetaPacket | undefined = logoArr[ 0 ];
          if ( !fileMeta ) {
            ApiResponseBuilder.error( res, 404, "File not found!" );
            return;
          }

          const relativePath: string = `${ this.PUBLIC_UPLOAD_URL_ROOT }/${ teamCode }/logo/${ fileMeta.storedName }`;

          // Evidence shape: keep it as "unknown" here because your TaskEvidence type
          // is not included in this snippet, but your model accepts it already.
          teamLogoEvidence = {
            name: fileMeta.originalName,
            storageKey: relativePath,
            url: `${ root }/${ relativePath }`,
            uploadedAt: nowIso,
            fileMeta,
          };
        }
      } else {
        payload = ( req.body ?? {} ) as Record<string, unknown>;
      }

      const teamName = String( payload.teamName ?? "" ).trim();
      const domainRaw = String( payload.domain ?? "" ).trim().toLowerCase();
      const description = String( payload.description ?? "" ).trim();

      const isActiveParsed = this.parseBooleanQuery( payload.isActive );
      const isActive = isActiveParsed !== undefined ? isActiveParsed : true;

      if ( !teamName || !domainRaw ) {
        ApiResponseBuilder.validationError( res, "Team name and domain are required for team creation" );
        return;
      }

      if ( !this.isValidTeamDomain( domainRaw ) ) {
        ApiResponseBuilder.validationError( res, "Invalid domain." );
        return;
      }

      // Members + captain parsing (reuse service helpers)
      const members: TeamMember[] = this.rest.extractTeamMembersFromArray( payload.members );
      const captain: TeamMember | null = this.rest.extractTeamMember( payload.captain );

      if ( !captain ) {
        ApiResponseBuilder.validationError( res, "Team captain is required" );
        return;
      }

      // Build create doc (kept aligned with your old router)
      const createDoc: Record<string, unknown> = {
        teamCode,
        teamName,
        domain: domainRaw as TeamDomain,
        description,
        members,
        captain,
        memberTotal: members.length,
        assignTasks: Array.isArray( payload.assignTasks ) ? payload.assignTasks : [],
        createdAt: nowIso,
        updatedAt: nowIso,
        isActive,
      };

      if ( teamLogoEvidence ) {
        createDoc.teamLogo = teamLogoEvidence;
      } else if ( payload.teamLogo ) {
        // If FE sent an evidence-like object (already normalized)
        createDoc.teamLogo = payload.teamLogo;
      }

      await TeamManagementModel.create( createDoc as never );

      // Return enriched
      const enriched = await this.rest.fetchEnrichedTeamByCode( teamCode );
      const responseTeam = enriched ?? ( createDoc as unknown as TeamManagementDto );



      // ---- WS emit (after REST success) ----
      const ctx = await this.buildWsContext( req );
      await this.ws.emitCreated( ctx, responseTeam );

      // ---- Notification (kept from your old router pattern) ----


      const actor: NotificationActorDto = {
        userId: String( auth.userId ),
        username: String( auth.username ),
        role: auth.role,
        ...( auth.branchId ? { branchId: auth.branchId } : {} ),
        ...( auth.teamCodes && auth.teamCodes.length > 0 ? { teamCodes: auth.teamCodes } : {} ),
      };

      const audiences: NotificationAudience[] = [
        ...this.organiseAudienceForTeamMembers( responseTeam.members ),
        {
          mode: 'Team',
          teamCode: responseTeam.teamCode
        },
        { mode: "Role", roleKey: "admin" },
        { mode: "Role", roleKey: "manager" },
        { mode: "Role", roleKey: "operator" },
      ];


      this.notificationHub.emit( {
        eventKey: 'teamManagement:create',
        actor,
        audiences,
        category: 'Team',
        target: {
          actionKey: 'team:created',
          category: 'TeamManagement',
          module: 'TeamManagement',
          refId: teamCode,
          route: '',
          params: { teamId: teamCode }
        },
      } );

      ApiResponseBuilder.ok( res, "team", responseTeam, "Team created successfully" );
      return;
    } catch ( error ) {
      console.error( "[Error:] [TeamManagementController:createTeam] Unexpected error.\n", error );
      ApiResponseBuilder.internalError( res, error );
      return;
    }
  }

  private organiseAudienceForTeamMembers( memberData: TeamManagementDto[ 'members' ] ): NotificationAudience[] {
    if ( !Array.isArray( memberData ) || memberData.length === 0 ) {
      throw new Error( 'Invalid member array!' );
    }

    const audiences: NotificationAudience[] = [];

    memberData.forEach( ( m ) => {
      const data: NotificationAudience = {
        mode: 'User',
        userId: String( m.id ?? m.username ?? '' ).trim()
      };

      audiences.push( data );
    } );

    return audiences;
  }

  // ========================================================================
  // 3) GET /teamName/:teamName  (enriched)
  // ========================================================================

  public async getTeamByTeamName( req: Request<{ teamName: string; }>, res: Response ): Promise<void> {
    try {
      const name = typeof req.params.teamName === "string" ? req.params.teamName.trim() : "";
      if ( !name ) {
        ApiResponseBuilder.validationError( res, "Team name is required!" );
        return;
      }

      const enriched = await this.rest.fetchEnrichedTeamByName( name );
      if ( !enriched ) {
        ApiResponseBuilder.notFound( res, "Team not found under the given name." );
        return;
      }

      ApiResponseBuilder.ok( res, "team", enriched as unknown as never, "Team found successfully!" );
      return;
    } catch ( error ) {
      console.error( "[Error:] [TeamManagementController:getTeamByTeamName] Error.\n", error );
      ApiResponseBuilder.internalError( res, error );
      return;
    }
  }

  // ========================================================================
  // 4) GET /all (advanced pagination + enriched)
  // ========================================================================

  public async listTeams( req: Request, res: Response ): Promise<void> {
    try {
      const { index, limit } = this.parsePagination( req, 10 );

      const search = String( req.query.search ?? "" ).trim();
      const domainRaw = String( req.query.domain ?? "" ).trim();
      const isActiveParam = this.parseBooleanQuery( req.query.isActive );

      const filters: { search?: string; domain?: TeamDomain; isActive?: boolean; } = {};
      if ( search ) filters.search = search;

      if ( domainRaw ) {
        const d = domainRaw.toLowerCase();
        if ( !this.isValidTeamDomain( d ) ) {
          ApiResponseBuilder.validationError( res, "Invalid domain in query." );
          return;
        }
        filters.domain = d as TeamDomain;
      }

      if ( isActiveParam !== undefined ) filters.isActive = isActiveParam;

      const result = await this.rest.listTeams( filters, index, limit );

      ApiResponseBuilder.ok( res, "teams", result.rows, "Teams fetched successfully", {
        pagination: result.pagination,
      } );
      return;
    } catch ( error ) {
      console.error( "[Error:] [TeamManagementController:listTeams] Error.\n", error );
      ApiResponseBuilder.internalError( res, error );
      return;
    }
  }

  // ========================================================================
  // 5) GET /:teamCode (enriched)  (router must register this LAST)
  // ========================================================================

  public async getTeamByCode( req: Request<{ teamCode: string; }>, res: Response ): Promise<void> {
    try {
      const teamCode = String( req.params.teamCode ?? "" ).trim();
      if ( !teamCode ) {
        ApiResponseBuilder.validationError( res, "Team code is required" );
        return;
      }

      const enriched = await this.rest.fetchEnrichedTeamByCode( teamCode );
      if ( !enriched ) {
        ApiResponseBuilder.notFound( res, "Team not found for the provided code" );
        return;
      }

      ApiResponseBuilder.ok( res, "team", enriched as unknown as never, "Team fetched successfully" );
      return;
    } catch ( error ) {
      console.error( "[Error:] [TeamManagementController:getTeamByCode] Error.\n", error );
      ApiResponseBuilder.internalError( res, error );
      return;
    }
  }

  // ========================================================================
  // 6) PATCH /update/:teamCode
  // ========================================================================

  public async updateTeam( req: Request<{ teamCode: string; }>, res: Response ): Promise<void> {
    try {
      const auth = await ApiGuardExport.GetAuthUser( req );
      if ( !auth ) {
        ApiResponseBuilder.conflict( res, 'Invalid auth user!' );
        return;
      }
      const teamCode = String( req.params.teamCode ?? "" ).trim();
      if ( !teamCode ) {
        ApiResponseBuilder.validationError( res, "Team code is required" );
        return;
      }

      const nowIso: string = new Date().toISOString();
      const root = `${ req.protocol }://${ req.get( "host" ) }`;

      let payload: Record<string, unknown> = {};
      let teamLogoEvidence: unknown | undefined;

      const contentType = ( req.headers[ "content-type" ] ?? "" ).toString();
      const isMultipart = contentType.includes( "multipart/form-data" );

      if ( isMultipart ) {
        const uploadSubPath: string = `team-management/${ teamCode }/logo`;

        let uploadedFiles: UploadResultPacket | null = null;
        try {
          uploadedFiles = await FileUploader.handleUpload( uploadSubPath, "teamLogo", req );
        } catch ( uploadError ) {
          console.error( "[Warning:] [TeamManagementController:updateTeam] Logo upload failed.\n", uploadError );
        }

        const rawTeamField: unknown = ( req.body as unknown as { team?: unknown; } )?.team;
        if ( typeof rawTeamField === "string" && rawTeamField.trim() ) {
          try {
            payload = JSON.parse( rawTeamField ) as Record<string, unknown>;
          } catch ( parseError ) {
            console.error( "[Error:] [TeamManagementController:updateTeam] Failed to parse 'team' JSON.\n", parseError );
            ApiResponseBuilder.validationError( res, "Malformed team JSON payload" );
            return;
          }
        } else {
          payload = {};
        }

        const logoArr = uploadedFiles?.byField?.teamLogo;
        if ( Array.isArray( logoArr ) && logoArr.length > 0 ) {
          const fileMeta: FileMetaPacket | undefined = logoArr[ 0 ];
          if ( !fileMeta ) {
            ApiResponseBuilder.error( res, 404, "File not found!" );
            return;
          }

          const relativePath: string = `${ this.PUBLIC_UPLOAD_URL_ROOT }/${ teamCode }/logo/${ fileMeta.storedName }`;

          teamLogoEvidence = {
            name: fileMeta.originalName,
            storageKey: relativePath,
            url: `${ root }/${ relativePath }`,
            uploadedAt: nowIso,
            fileMeta,
          };
        }
      } else {
        payload = ( req.body ?? {} ) as Record<string, unknown>;
      }

      const updateDoc: Record<string, unknown> = { updatedAt: nowIso };

      if ( typeof payload.teamName === "string" ) {
        const trimmed = payload.teamName.trim();
        if ( trimmed ) updateDoc.teamName = trimmed;
      }

      if ( typeof payload.domain === "string" && payload.domain.trim() ) {
        const d = payload.domain.trim().toLowerCase();
        if ( !this.isValidTeamDomain( d ) ) {
          ApiResponseBuilder.validationError( res, "Invalid domain." );
          return;
        }
        updateDoc.domain = d as TeamDomain;
      }

      if ( typeof payload.description === "string" ) updateDoc.description = payload.description.trim();

      if ( typeof payload.isActive !== "undefined" ) {
        const parsed = this.parseBooleanQuery( payload.isActive );
        updateDoc.isActive = parsed !== undefined ? parsed : true;
      }

      if ( typeof payload.members !== "undefined" ) {
        const members = this.rest.extractTeamMembersFromArray( payload.members );
        updateDoc.members = members;
        updateDoc.memberTotal = members.length;
      }

      if ( typeof payload.captain !== "undefined" ) {
        const captain = this.rest.extractTeamMember( payload.captain );
        if ( captain ) updateDoc.captain = captain;
      }

      if ( Array.isArray( payload.assignTasks ) ) updateDoc.assignTasks = payload.assignTasks;

      if ( teamLogoEvidence ) updateDoc.teamLogo = teamLogoEvidence;
      else if ( payload.teamLogo ) updateDoc.teamLogo = payload.teamLogo;

      const updated = await TeamManagementModel.findOneAndUpdate(
        { teamCode },
        { $set: updateDoc },
        { new: true }
      ).exec();

      if ( !updated ) {
        ApiResponseBuilder.validationError( res, "Team not found for update" );
        return;
      }

      const enriched = await this.rest.fetchEnrichedTeamByCode( teamCode );
      const responseTeam = enriched ?? ( updated as unknown as TeamManagementDto );

      

      // ---- WS emit (after REST success) ----
      const ctx = await this.buildWsContext( req );
      await this.ws.emitUpdated( ctx, teamCode, responseTeam );

      // ---- Notification ----
      const actor: NotificationActorDto = {
        userId: String( auth.userId ),
        username: String( auth.username ),
        role: auth.role,
        ...( auth.branchId ? { branchId: auth.branchId } : {} ),
        ...( auth.teamCodes && auth.teamCodes.length > 0 ? { teamCodes: auth.teamCodes } : {} ),
      };

      const audiences: NotificationAudience[] = [
        ...this.organiseAudienceForTeamMembers( responseTeam.members ),
        {
          mode: 'Team',
          teamCode: responseTeam.teamCode
        },
        { mode: "Role", roleKey: "admin" },
        { mode: "Role", roleKey: "manager" },
        { mode: "Role", roleKey: "operator" },
      ];


      this.notificationHub.emit( {
        eventKey: 'teamManagement:update',
        actor,
        audiences,
        category: 'Team',
        target: {
          actionKey: 'team:updated',
          category: 'TeamManagement',
          module: 'TeamManagement',
          refId: teamCode,
          route: '',
        },
      } );

      ApiResponseBuilder.ok( res, "team", responseTeam, "Team updated successfully" );
      return;
    } catch ( error ) {
      console.error( "[Error:] [TeamManagementController:updateTeam] Unexpected error.\n", error );
      ApiResponseBuilder.internalError( res, error );
      return;
    }
  }

  // ========================================================================
  // 7) DELETE /delete/:teamCode?soft=true|false
  // ========================================================================

  public async deleteTeam( req: Request<{ teamCode: string; }>, res: Response ): Promise<void> {
    try {
      const auth = await ApiGuardExport.GetAuthUser( req );
      if ( !auth ) {
        ApiResponseBuilder.conflict( res, "Invalid auth user!" );
        return;
      }

      const teamCode = String( req.params.teamCode ?? "" ).trim();
      if ( !teamCode ) {
        ApiResponseBuilder.validationError( res, "Team code is required" );
        return;
      }

      const softParsed = this.parseBooleanQuery( req.query.soft );
      const soft = softParsed !== undefined ? softParsed : true;

      // Read once (used for: audience + ws delete payload + snapshot seed)
      const existing = await TeamManagementModel.findOne( { teamCode } ).lean<TeamManagementDto>().exec();
      if ( !existing ) {
        ApiResponseBuilder.validationError( res, "Team not found for delete" );
        return;
      }

      // ─────────────────────────────────────────────────────────────
      // SOFT DELETE
      // ─────────────────────────────────────────────────────────────
      if ( soft ) {
        const updated = await TeamManagementModel.findOneAndUpdate(
          { teamCode },
          { $set: { isActive: false, updatedAt: new Date().toISOString() } },
          { new: true }
        ).lean<TeamManagementDto>().exec();

        if ( !updated ) {
          ApiResponseBuilder.validationError( res, "Team not found for soft delete" );
          return;
        }

        ApiResponseBuilder.ok( res, "team", updated as unknown as never, "Team deactivated (soft delete) successfully" );

        const ctx = await this.buildWsContext( req );
        await this.ws.emitUpdated( ctx, teamCode, updated );
        return;
      }

      // ─────────────────────────────────────────────────────────────
      // HARD DELETE + RECYCLE BIN
      // ─────────────────────────────────────────────────────────────

      const folderRoot: string = `uploads/team-management/${ teamCode }`;



      const movertoRecycleBi = await FileUploader.moveToRecycleBin( 'teamManagement', teamCode,
        {
          path: folderRoot,
          kind: 'dir'
        }
      );

      const actor: NotificationActorDto = {
        userId: String( auth.userId ),
        username: String( auth.username ),
        role: auth.role,
        ...( auth.branchId ? { branchId: auth.branchId } : {} ),
        ...( auth.teamCodes && auth.teamCodes.length > 0 ? { teamCodes: auth.teamCodes } : {} ),
      };

      // audiences MUST be an array (your rule) ✅
      const audiences: NotificationAudience[] = [
        ...this.organiseAudienceForTeamMembers( existing.members ),
        { mode: "Team", teamCode: existing.teamCode },
        { mode: "Role", roleKey: "admin" },
        { mode: "Role", roleKey: "manager" },
        { mode: "Role", roleKey: "operator" },
      ];

      const snapshotData: Record<string, unknown> = {
        teamData: existing,
        deletedAtIso: new Date().toISOString(),
        deletedBy: {
          username: auth.username,
          role: auth.role,
          ...( auth.branchId ? { branchId: auth.branchId } : {} ),
          ...( auth.teamCodes && auth.teamCodes.length > 0 ? { teamCodes: auth.teamCodes } : {} ),
        },
        restoreHints: {
          teamCode: teamCode,
        },
      };

      // ✅ Proper plan: snapshot-read + real delete (both session-aware)
      const deletePlan: DomainDeletePlan<TeamManagementDto> = {
        refId: teamCode,
        label: 'Team Deletion',
        description: `${ teamCode } has been deleted!`,
        snapshotData,
        files: movertoRecycleBi.meta,
        sourceKey: 'teamManagement',
        tags: [ 'team', 'teamManagement', 'delete', 'deleteTeam' ],
        // (B) actual delete – MUST use session
        deleteDbRecord: async ( session ) => {
          await TeamManagementModel.deleteOne( { teamCode } ).session( session ).exec();
        },

        // (C) optional: public files to capture (depends on your RecycleBin engine design)
        // If your deleteSvc supports it, you should list team logo/evidence folders here.
        // listPublicFilesRel: async () => this.buildTeamPublicFileList(teamCode),
      };

      // ✅ Do the transactional delete + recyclebin write
      const rbResult = await this.deleteSvc.deleteWithRecycleBin( auth, deletePlan );

      // ✅ Emit notification only after success (and await it)
      await this.notificationHub.emit( {
        eventKey: "teamManagement:delete",
        actor,
        audiences,
        category: "Team",
        target: {
          actionKey: 'team:deleted',
          category: 'TeamManagement',
          module: 'TeamManagement',
          refId: teamCode,
          route: '',
        },
        // If your hub supports it, include refId & recyclebin entry id
        ...( rbResult?.entry ? { refId: teamCode, recycleBinEntryId: rbResult.entry } : { refId: teamCode } ),
      } );

      // Response: since DB record is gone, return the snapshot you already had
      

      const ctx = await this.buildWsContext( req );
      await this.ws.emitDeleted(
        ctx,
        teamCode,
        String( ( existing as unknown as { _id?: unknown; } )?._id ?? "" )
      );

      ApiResponseBuilder.ok( res, "team", existing, "Team deleted permanently" );
      return;
    } catch ( error ) {
      console.error( "[Error:] [TeamManagementController:deleteTeam] Error.\n", error );
      ApiResponseBuilder.internalError( res, error );
      return;
    }
  }


  // ========================================================================
  // 8) POST /upload/logo/:teamCode  (file upload only)
  // ========================================================================

  public async uploadTeamLogo( req: Request<{ teamCode: string; }>, res: Response ): Promise<void> {
    try {
      const teamCode = String( req.params.teamCode ?? "" ).trim();
      if ( !teamCode ) {
        ApiResponseBuilder.validationError( res, "Team code is required for logo upload" );
        return;
      }

      const subPath = `team-management/${ teamCode }/logo`;
      const files: UploadResultPacket = await FileUploader.handleUpload( subPath, "teamLogo", req );

      if ( !Array.isArray( files.byField.teamLogo ) || files.byField.teamLogo.length === 0 ) {
        ApiResponseBuilder.validationError( res, "No files were uploaded for team logo" );
        return;
      }

      ApiResponseBuilder.ok( res, "files", files.byField.teamLogo as unknown as never, "Team logo uploaded successfully" );
      return;
    } catch ( error ) {
      console.error( "[Error:] [TeamManagementController:uploadTeamLogo] Error.\n", error );
      ApiResponseBuilder.internalError( res, error );
      return;
    }
  }

  // ========================================================================
  // 9) GET /stats/teams-total
  // ========================================================================

  public async getAllTeamTotals( _req: Request, res: Response ): Promise<void> {
    try {
      const totals = await this.rest.getAllTeamTotals();

      ApiResponseBuilder.ok( res, "other", totals as unknown as never, "Team totals fetched successfully" );
      return;
    } catch ( error ) {
      console.error( "[Error:] [TeamManagementController:getAllTeamTotals] Error.\n", error );
      ApiResponseBuilder.internalError( res, error );
      return;
    }
  }

  // ========================================================================
  // 10) GET /stats/teams-total/domain/:domain?active=true|false
  // ========================================================================

  public async getTeamTotalByDomain( req: Request<{ domain: string; }>, res: Response ): Promise<void> {
    try {
      const rawDomain = String( req.params.domain ?? "" ).trim().toLowerCase();
      if ( !rawDomain || !this.isValidTeamDomain( rawDomain ) ) {
        ApiResponseBuilder.validationError( res, "Invalid domain." );
        return;
      }

      const active = this.parseBooleanQuery( req.query.active );
      const domain = rawDomain as TeamDomain;

      const result = await this.rest.getTeamTotalByDomain( domain, active );

      ApiResponseBuilder.ok( res, "other", result as unknown as never, "Team domain totals fetched successfully" );
      return;
    } catch ( error ) {
      console.error( "[Error:] [TeamManagementController:getTeamTotalByDomain] Error.\n", error );
      ApiResponseBuilder.internalError( res, error );
      return;
    }
  }

  // ========================================================================
  // 11) USER MEMBERSHIP ANALYTICS
  // - These are kept in controller because they are mostly aggregation-only reads.
  // - You can move them to RestService later if you want.
  // ========================================================================

  private async collectTeamUserIdsByDomain( domain?: TeamDomain ): Promise<Types.ObjectId[]> {
    const pipeline: import( "mongoose" ).PipelineStage[] = [];

    if ( domain ) pipeline.push( { $match: { domain } } );

    pipeline.push(
      {
        $project: {
          memberIds: { $map: { input: "$members", as: "m", in: "$$m.id" } },
          captainId: "$captain.id",
        },
      },
      {
        $project: {
          allUserIds: {
            $setUnion: [
              "$memberIds",
              { $cond: [ { $ifNull: [ "$captainId", null ] }, [ "$captainId" ], [] ] },
            ],
          },
        },
      },
      { $unwind: "$allUserIds" },
      { $group: { _id: "$allUserIds" } }
    );

    // ✅ Correct: each row is { _id: ObjectId }
    const rows = await TeamManagementModel
      .aggregate<{ _id: Types.ObjectId; }>( pipeline )
      .exec();

    return rows.map( ( r ) => r._id );
  }


  public async usersWithoutAnyTeam( req: Request, res: Response ): Promise<void> {
    try {
      const { index, limit, skip } = this.parsePagination( req, 10 );
      const teamUserIds = await this.collectTeamUserIdsByDomain();

      const filter: import( "mongoose" ).FilterQuery<User> = {};
      if ( teamUserIds.length > 0 ) filter._id = { $nin: teamUserIds };

      const [ total, users ] = await Promise.all( [
        UserModel.countDocuments( filter ).exec(),
        UserModel.find( filter, USER_MODEL_PROJECTION ).skip( skip ).limit( limit ).lean<User>().exec() as unknown as User[],
      ] );

      ApiResponseBuilder.ok( res, "users", users as unknown as never, "Users without any team fetched successfully", {
        pagination: { total, index, limit },
      } );
      return;
    } catch ( error ) {
      console.error( "[Error:] [TeamManagementController:usersWithoutAnyTeam] Error.\n", error );
      ApiResponseBuilder.internalError( res, error );
      return;
    }
  }

  public async usersWithoutAnyTeamCount( _req: Request, res: Response ): Promise<void> {
    try {
      const teamUserIds = await this.collectTeamUserIdsByDomain();

      const filter: import( "mongoose" ).FilterQuery<User> = {};
      if ( teamUserIds.length > 0 ) filter._id = { $nin: teamUserIds };

      const total = await UserModel.countDocuments( filter ).exec();

      ApiResponseBuilder.ok( res, "other", { total } as unknown as never, "Total users without any team fetched successfully", {
        pagination: { total },
      } );
      return;
    } catch ( error ) {
      console.error( "[Error:] [TeamManagementController:usersWithoutAnyTeamCount] Error.\n", error );
      ApiResponseBuilder.internalError( res, error );
      return;
    }
  }

  public async usersInAnyTeam( req: Request, res: Response ): Promise<void> {
    try {
      const { index, limit, skip } = this.parsePagination( req, 10 );
      const teamUserIds = await this.collectTeamUserIdsByDomain();

      if ( teamUserIds.length === 0 ) {
        ApiResponseBuilder.ok( res, "users", [] as unknown as never, "No users found in any team", {
          pagination: { total: 0, index, limit },
        } );
        return;
      }

      const filter: import( "mongoose" ).FilterQuery<User> = { _id: { $in: teamUserIds } };

      const [ total, users ] = await Promise.all( [
        UserModel.countDocuments( filter ).exec(),
        UserModel.find( filter, USER_MODEL_PROJECTION ).skip( skip ).limit( limit ).lean<User>().exec() as unknown as User[],
      ] );

      ApiResponseBuilder.ok( res, "users", users as unknown as never, "Users in teams fetched successfully", {
        pagination: { total, index, limit },
      } );
      return;
    } catch ( error ) {
      console.error( "[Error:] [TeamManagementController:usersInAnyTeam] Error.\n", error );
      ApiResponseBuilder.internalError( res, error );
      return;
    }
  }

  public async usersInAnyTeamCount( _req: Request, res: Response ): Promise<void> {
    try {
      const teamUserIds = await this.collectTeamUserIdsByDomain();
      const total = teamUserIds.length === 0
        ? 0
        : await UserModel.countDocuments( { _id: { $in: teamUserIds } } ).exec();

      ApiResponseBuilder.ok( res, "other", { total } as unknown as never, "Total users in teams fetched successfully", {
        pagination: { total },
      } );
      return;
    } catch ( error ) {
      console.error( "[Error:] [TeamManagementController:usersInAnyTeamCount] Error.\n", error );
      ApiResponseBuilder.internalError( res, error );
      return;
    }
  }

  public async usersWithoutTeamByDomain( req: Request<{ domain: string; }>, res: Response ): Promise<void> {
    try {
      const rawDomain = String( req.params.domain ?? "" ).trim().toLowerCase();
      if ( !rawDomain || !this.isValidTeamDomain( rawDomain ) ) {
        ApiResponseBuilder.validationError( res, "Invalid domain." );
        return;
      }

      const domain = rawDomain as TeamDomain;
      const { index, limit, skip } = this.parsePagination( req, 10 );

      const teamUserIds = await this.collectTeamUserIdsByDomain( domain );

      const filter: import( "mongoose" ).FilterQuery<User> = {};
      if ( teamUserIds.length > 0 ) filter._id = { $nin: teamUserIds };

      const [ total, users ] = await Promise.all( [
        UserModel.countDocuments( filter ).exec(),
        UserModel.find( filter, USER_MODEL_PROJECTION ).skip( skip ).limit( limit ).lean<User>().exec() as unknown as User[],
      ] );

      ApiResponseBuilder.ok( res, "users", users as unknown as never, "Users without any team for the domain fetched successfully", {
        pagination: { total, index, limit },
        other: { domain },
      } );
      return;
    } catch ( error ) {
      console.error( "[Error:] [TeamManagementController:usersWithoutTeamByDomain] Error.\n", error );
      ApiResponseBuilder.internalError( res, error );
      return;
    }
  }

  public async usersWithoutTeamByDomainCount( req: Request<{ domain: string; }>, res: Response ): Promise<void> {
    try {
      const rawDomain = String( req.params.domain ?? "" ).trim().toLowerCase();
      if ( !rawDomain || !this.isValidTeamDomain( rawDomain ) ) {
        ApiResponseBuilder.validationError( res, "Invalid domain." );
        return;
      }

      const domain = rawDomain as TeamDomain;
      const teamUserIds = await this.collectTeamUserIdsByDomain( domain );

      const filter: import( "mongoose" ).FilterQuery<User> = {};
      if ( teamUserIds.length > 0 ) filter._id = { $nin: teamUserIds };

      const total = await UserModel.countDocuments( filter ).exec();

      ApiResponseBuilder.ok( res, "other", { domain, total } as unknown as never, "Total users without team for domain fetched successfully", {
        pagination: { total },
      } );
      return;
    } catch ( error ) {
      console.error( "[Error:] [TeamManagementController:usersWithoutTeamByDomainCount] Error.\n", error );
      ApiResponseBuilder.internalError( res, error );
      return;
    }
  }

  public async usersInTeamByDomain( req: Request<{ domain: string; }>, res: Response ): Promise<void> {
    try {
      const rawDomain = String( req.params.domain ?? "" ).trim().toLowerCase();
      if ( !rawDomain || !this.isValidTeamDomain( rawDomain ) ) {
        ApiResponseBuilder.validationError( res, "Invalid domain." );
        return;
      }

      const domain = rawDomain as TeamDomain;
      const { index, limit, skip } = this.parsePagination( req, 10 );

      const teamUserIds = await this.collectTeamUserIdsByDomain( domain );

      if ( teamUserIds.length === 0 ) {
        ApiResponseBuilder.ok( res, "users", [] as unknown as never, "No users found in teams for given domain", {
          pagination: { total: 0, index, limit },
          other: { domain },
        } );
        return;
      }

      const filter: import( "mongoose" ).FilterQuery<User> = { _id: { $in: teamUserIds } };

      const [ total, users ] = await Promise.all( [
        UserModel.countDocuments( filter ).exec(),
        UserModel.find( filter, USER_MODEL_PROJECTION ).skip( skip ).limit( limit ).lean<User>().exec() as unknown as User[],
      ] );

      ApiResponseBuilder.ok( res, "users", users as unknown as never, "Users in teams for domain fetched successfully", {
        pagination: { total, index, limit },
        other: { domain },
      } );
      return;
    } catch ( error ) {
      console.error( "[Error:] [TeamManagementController:usersInTeamByDomain] Error.\n", error );
      ApiResponseBuilder.internalError( res, error );
      return;
    }
  }

  public async usersInTeamByDomainCount( req: Request<{ domain: string; }>, res: Response ): Promise<void> {
    try {
      const rawDomain = String( req.params.domain ?? "" ).trim().toLowerCase();
      if ( !rawDomain || !this.isValidTeamDomain( rawDomain ) ) {
        ApiResponseBuilder.validationError( res, "Invalid domain." );
        return;
      }

      const domain = rawDomain as TeamDomain;
      const teamUserIds = await this.collectTeamUserIdsByDomain( domain );

      const total = teamUserIds.length === 0
        ? 0
        : await UserModel.countDocuments( { _id: { $in: teamUserIds } } ).exec();

      ApiResponseBuilder.ok( res, "other", { domain, total } as unknown as never, "Total users in teams for domain fetched successfully", {
        pagination: { total },
      } );
      return;
    } catch ( error ) {
      console.error( "[Error:] [TeamManagementController:usersInTeamByDomainCount] Error.\n", error );
      ApiResponseBuilder.internalError( res, error );
      return;
    }
  }

  // ========================================================================
  // 12) GET /users/all?index=&limit=&search=
  // ========================================================================

  public async getAllUsersWithTeams( req: Request, res: Response ): Promise<void> {
    try {
      const { index, limit, skip } = this.parsePagination( req, 10 );

      const rawSearch = req.query.search;
      const search = typeof rawSearch === "string" && rawSearch.trim() ? rawSearch.trim() : undefined;

      const teamFilter: import( "mongoose" ).FilterQuery<unknown> = {};
      const userFilter: import( "mongoose" ).FilterQuery<User> = {};

      if ( search ) {
        const rx = new RegExp( search, "i" );
        teamFilter.$or = [ { teamName: rx }, { domain: rx }, { teamCode: rx } ];
        userFilter.$or = [ { name: rx }, { username: rx }, { email: rx } ];
      }

      const pipeline: import( "mongoose" ).PipelineStage[] = [
        { $match: userFilter },

        {
          $lookup: {
            from: TeamManagementModel.collection.name,
            let: { userId: "$_id", username: "$username" },
            pipeline: [
              {
                $match: {
                  ...( Array.isArray( ( teamFilter as any ).$or ) && ( teamFilter as any ).$or.length > 0 ? { $or: ( teamFilter as any ).$or } : {} ),
                  $expr: {
                    $gt: [
                      {
                        $size: {
                          $filter: {
                            input: "$members",
                            as: "m",
                            cond: {
                              $or: [
                                { $eq: [ "$$m.id", "$$userId" ] },
                                { $eq: [ "$$m.username", "$$username" ] },
                              ],
                            },
                          },
                        },
                      },
                      0,
                    ],
                  },
                },
              },
              { $project: { _id: 0, teamName: 1, domain: 1 } },
            ],
            as: "teams",
          },
        },

        { $addFields: { teams: { $ifNull: [ "$teams", [] ] } } },

        {
          $lookup: {
            from: TeamManagementModel.collection.name,
            let: { userId: "$_id", username: "$username" },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $gt: [
                      {
                        $size: {
                          $filter: {
                            input: "$members",
                            as: "m",
                            cond: {
                              $or: [
                                { $eq: [ "$$m.id", "$$userId" ] },
                                { $eq: [ "$$m.username", "$$username" ] },
                              ],
                            },
                          },
                        },
                      },
                      0,
                    ],
                  },
                },
              },
              {
                $addFields: {
                  membershipForUser: {
                    $filter: {
                      input: "$members",
                      as: "m",
                      cond: {
                        $or: [
                          { $eq: [ "$$m.id", "$$userId" ] },
                          { $eq: [ "$$m.username", "$$username" ] },
                        ],
                      },
                    },
                  },
                },
              },
              { $unwind: "$membershipForUser" },
              { $sort: { "membershipForUser.joinedAt": -1 } },
              { $limit: 1 },
              {
                $project: {
                  _id: 0,
                  teamName: 1,
                  domain: 1,
                  roleInTeam: "$membershipForUser.roleInTeam",
                  teamReason: "$membershipForUser.reason",
                  teamJoinedAt: "$membershipForUser.joinedAt",
                },
              },
            ],
            as: "latestTeam",
          },
        },

        {
          $addFields: {
            domain: { $ifNull: [ { $arrayElemAt: [ "$latestTeam.domain", 0 ] }, null ] },
            teamName: { $ifNull: [ { $arrayElemAt: [ "$latestTeam.teamName", 0 ] }, null ] },
            roleInTeam: { $ifNull: [ { $arrayElemAt: [ "$latestTeam.roleInTeam", 0 ] }, null ] },
            teamReason: { $ifNull: [ { $arrayElemAt: [ "$latestTeam.teamReason", 0 ] }, null ] },
            teamJoinedAt: { $ifNull: [ { $arrayElemAt: [ "$latestTeam.teamJoinedAt", 0 ] }, null ] },
          },
        },

        { $project: { password: 0, latestTeam: 0 } },

        { $sort: { createdAt: -1 } },
        { $skip: skip },
        { $limit: limit },

        { $project: USER_MODEL_PROJECTION },
      ];

      const [ users, totalCount ] = await Promise.all( [
        UserModel.aggregate<AllUserWithTeams>( pipeline ).exec(),
        UserModel.countDocuments( userFilter ).exec(),
      ] );

      const hasMore = index * limit + users.length < totalCount;

      ApiResponseBuilder.ok( res, "other", { users } as unknown as never, "Users with latest team/domain loaded successfully.", {
        pagination: { index, limit, total: totalCount, hasMore },
      } );
      return;
    } catch ( error ) {
      console.error( "[Error:] [TeamManagementController:getAllUsersWithTeams] Error.\n", error );
      ApiResponseBuilder.internalError( res, error );
      return;
    }
  }
}
