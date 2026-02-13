// Path: src/api/teamManagement/workEvents.router.ts
// ============================================================================
// Work Event API (class-based) — DTO-safe, ApiResponseBuilder-safe (ERROR-FREE)
// ----------------------------------------------------------------------------
// Fixes:
// ✅ Always respond with WorkEventDto[] (never Mongoose Document[])
// ✅ Convert ObjectId-like fields to string inside DTO mapper
// ✅ createdAt range uses ISO strings (safe when createdAt stored as ISO string)
// ✅ Allow-lists are local string lists (no TS union mismatch explosions)
// ============================================================================

import express, { Request, Response, Router } from "express";
import type { FilterQuery, PipelineStage } from "mongoose";
import { Types } from "mongoose";

import { ApiResponseBuilder } from "../../utils/api-combiner.builder";

import {
  type IWorkEvent,
  WorkEventModel,
  type WorkEventKind,
  type WorkEventDto,
} from "../../models/teamManagement/workEvent.model";

import type {
  WorkItemPriority,
  WorkItemStatus,
} from "../../types/teamManagement/workItem/workItem.types";

import type { TeamDomain } from "../../types/teamManagement/teamMain/teamManagement.types";

export default class WorkEventApi {
  private readonly router: Router;

  // ✅ Keep allowlists local (router-only, no model edits)
  private readonly ALLOWED_DOMAINS: readonly string[] = [
    "sales",
    "development",
    "support",
    "operations",
    "marketing",
    "finance",
    "other",
  ] as const;

  // Keep as STRING allowlist to avoid union mismatch compile errors.
  // If your model exposes a WORK_EVENT_KINDS constant, use that instead.
  private readonly ALLOWED_KINDS: readonly string[] = [
    "created",
    "updated",
    "status_changed",
    "priority_changed",
    "comment_added",
    "assigned",
    "unassigned",
    "attachment_added",
    "attachment_removed",
  ] as const;

  private readonly ALLOWED_STATUSES: readonly string[] = [
    "draft",
    "pending",
    "in_progress",
    "blocked",
    "completed",
    "cancelled",
    "backlog",
    "open",
    "done",
  ] as const;

  private readonly ALLOWED_PRIORITIES: readonly string[] = [
    "low",
    "medium",
    "high",
    "critical",
  ] as const;

  public constructor() {
    this.router = express.Router();

    // NOTE: register exact routes first; no "/:id" type route exists here, so OK.
    this.registerGetAllEvents(); // GET /all
    this.registerGetEventsByWorkItem(); // GET /by-workitem/:workItemId
    this.registerGetEventsByTeam(); // GET /by-team/:teamCode
    this.registerGetWorkItemEventStats(); // GET /stats/workitem/:workItemId
  }

  public get route(): Router {
    return this.router;
  }

  // ==========================================================================
  // DTO Mapping (Fixes ApiResponseBuilder typing errors)
  // ==========================================================================

  private toIdString( input: unknown ): string | undefined {
    if ( !input ) return undefined;

    if ( typeof input === "string" ) {
      const t = input.trim();
      return t ? t : undefined;
    }

    if ( input instanceof Types.ObjectId ) return input.toHexString();

    if ( typeof ( input as { toString?: unknown; } )?.toString === "function" ) {
      const s = String( input );
      return s ? s : undefined;
    }

    return undefined;
  }

  /**
   * Convert WorkEvent doc/plain to WorkEventDto safely (ObjectId -> string).
   * We DO NOT force a full schema knowledge here — we map the common id fields.
   */
  private toWorkEventDto( doc: IWorkEvent ): WorkEventDto {
    const raw: Record<string, unknown> = { ...( doc as unknown as Record<string, unknown> ) };

    // Common id conversions (only apply if those keys exist on your schema/DTO)
    const workItemId = this.toIdString( ( doc as any ).workItemId );
    if ( workItemId ) raw.workItemId = workItemId;

    const teamMongoId = this.toIdString( ( doc as any ).teamMongoId );
    if ( teamMongoId ) raw.teamMongoId = teamMongoId;

    const actorId = this.toIdString( ( doc as any ).actorId );
    if ( actorId ) raw.actorId = actorId;

    const actorUserId = this.toIdString( ( doc as any ).actorUserId );
    if ( actorUserId ) raw.actorUserId = actorUserId;

    // If doc has mongo _id and DTO expects string id, you can map it too (optional)
    const mongoId = this.toIdString( ( doc as any )._id );
    if ( mongoId && typeof ( raw as any ).mongoId === "undefined" ) {
      // only set if your DTO supports it; otherwise it will be ignored at runtime
      ( raw as any ).mongoId = mongoId;
    }

    return raw as unknown as WorkEventDto;
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  private parsePagination(
    req: Request,
    fallbackLimit: number = 20
  ): { index: number; limit: number; skip: number } {
    const indexNum = Number( req.query.index );
    const limitNum = Number( req.query.limit );

    const index: number = Number.isFinite( indexNum ) && indexNum >= 0 ? indexNum : 0;
    const limit: number = Number.isFinite( limitNum ) && limitNum > 0 ? limitNum : fallbackLimit;

    return { index, limit, skip: index * limit };
  }

  private parseStringQuery( value: unknown ): string | undefined {
    if ( typeof value !== "string" ) return undefined;
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }

  private escapeRegExp( input: string ): string {
    return input.replace( /[.*+?^${}()|[\]\\]/g, "\\$&" );
  }

  private parseEnumQuery<T extends string>(
    raw: unknown,
    allow: readonly string[]
  ): T | undefined {
    const v = this.parseStringQuery( raw );
    if ( !v ) return undefined;
    return allow.includes( v ) ? ( v as T ) : undefined;
  }

  /**
   * Parse from/to into createdAt ISO string range.
   * ✅ Works when createdAt stored as ISO string (recommended in your current module).
   */
  private parseCreatedAtIsoRange( req: Request ): Record<string, string> | undefined {
    const fromStr = this.parseStringQuery( req.query.from );
    const toStr = this.parseStringQuery( req.query.to );

    const range: Record<string, string> = {};

    if ( fromStr ) {
      const d = new Date( fromStr );
      if ( !Number.isNaN( d.getTime() ) ) range.$gte = d.toISOString();
    }

    if ( toStr ) {
      const d = new Date( toStr );
      if ( !Number.isNaN( d.getTime() ) ) range.$lte = d.toISOString();
    }

    return Object.keys( range ).length ? range : undefined;
  }

  private buildPaginationMeta( index: number, limit: number, total: number, rowsLen: number ) {
    return {
      index,
      limit,
      total,
      hasMore: index * limit + rowsLen < total,
    };
  }

  // ==========================================================================
  // GET /all
  //   ?index=&limit=&workItemId=&teamId=&domain=&kind=&actor=&fromStatus=&toStatus=&fromPriority=&toPriority=&from=&to=
  // ==========================================================================

  private registerGetAllEvents(): void {
    this.router.get( "/all", async ( req: Request, res: Response ): Promise<void> => {
      try {
        const { index, limit, skip } = this.parsePagination( req, 20 );

        const filter: FilterQuery<IWorkEvent> = {};

        const workItemId = this.parseStringQuery( req.query.workItemId );
        if ( workItemId ) ( filter as any ).workItemId = workItemId;

        // NOTE: query param is `teamId` because WorkEvent stores it as teamId string (teamCode)
        const teamId = this.parseStringQuery( req.query.teamId );
        if ( teamId ) ( filter as any ).teamId = teamId;

        const domain = this.parseEnumQuery<TeamDomain>( req.query.domain, this.ALLOWED_DOMAINS );
        if ( domain ) ( filter as any ).domain = domain;

        const kind = this.parseEnumQuery<WorkEventKind>( req.query.kind, this.ALLOWED_KINDS );
        if ( kind ) ( filter as any ).kind = kind;

        const actor = this.parseStringQuery( req.query.actor );
        if ( actor ) {
          const rx = new RegExp( this.escapeRegExp( actor ), "i" );
          ( filter as any ).actorUsername = { $regex: rx };
        }

        const fromStatus = this.parseEnumQuery<WorkItemStatus>( req.query.fromStatus, this.ALLOWED_STATUSES );
        if ( fromStatus ) ( filter as any ).fromStatus = fromStatus;

        const toStatus = this.parseEnumQuery<WorkItemStatus>( req.query.toStatus, this.ALLOWED_STATUSES );
        if ( toStatus ) ( filter as any ).toStatus = toStatus;

        const fromPriority = this.parseEnumQuery<WorkItemPriority>( req.query.fromPriority, this.ALLOWED_PRIORITIES );
        if ( fromPriority ) ( filter as any ).fromPriority = fromPriority;

        const toPriority = this.parseEnumQuery<WorkItemPriority>( req.query.toPriority, this.ALLOWED_PRIORITIES );
        if ( toPriority ) ( filter as any ).toPriority = toPriority;

        const createdAtRange = this.parseCreatedAtIsoRange( req );
        if ( createdAtRange ) ( filter as any ).createdAt = createdAtRange;

        const [ total, rows ] = await Promise.all( [
          WorkEventModel.countDocuments( filter ).exec(),
          WorkEventModel.find( filter )
            .sort( { createdAt: -1 } )
            .skip( skip )
            .limit( limit )
            .exec(),
        ] );

        // ✅ DTO map (fixes ApiResponseBuilder overload errors)
        const events: WorkEventDto[] = ( rows as unknown as IWorkEvent[] ).map( ( e ) => this.toWorkEventDto( e ) );

        ApiResponseBuilder.ok(
          res,
          "events",
          events,
          "Work events fetched successfully.",
          { pagination: this.buildPaginationMeta( index, limit, total, events.length ) }
        );
        return;
      } catch ( error ) {
        console.error( "[Error:] [WorkEventApi:/all] Failed.\n", error );
        ApiResponseBuilder.internalError( res, error );
        return;
      }
    } );
  }

  // ==========================================================================
  // GET /by-workitem/:workItemId
  //   ?index=&limit=&kind=&from=&to=
  // ==========================================================================

  private registerGetEventsByWorkItem(): void {
    this.router.get( "/by-workitem/:workItemId", async ( req: Request, res: Response ): Promise<void> => {
      try {
        const workItemId = String( req.params.workItemId ?? "" ).trim();
        if ( !workItemId ) {
          ApiResponseBuilder.validationError( res, "workItemId path param is required." );
          return;
        }

        const { index, limit, skip } = this.parsePagination( req, 20 );
        const filter: FilterQuery<IWorkEvent> = { workItemId } as any;

        const kind = this.parseEnumQuery<WorkEventKind>( req.query.kind, this.ALLOWED_KINDS );
        if ( kind ) ( filter as any ).kind = kind;

        const createdAtRange = this.parseCreatedAtIsoRange( req );
        if ( createdAtRange ) ( filter as any ).createdAt = createdAtRange;

        const [ total, rows ] = await Promise.all( [
          WorkEventModel.countDocuments( filter ).exec(),
          WorkEventModel.find( filter )
            .sort( { createdAt: -1 } )
            .skip( skip )
            .limit( limit )
            .exec(),
        ] );

        const events: WorkEventDto[] = ( rows as unknown as IWorkEvent[] ).map( ( e ) => this.toWorkEventDto( e ) );

        ApiResponseBuilder.ok(
          res,
          "events",
          events,
          "Work events for work item fetched successfully.",
          {
            pagination: this.buildPaginationMeta( index, limit, total, events.length ),
            other: { workItemId },
          }
        );
        return;
      } catch ( error ) {
        console.error( "[Error:] [WorkEventApi:/by-workitem] Failed.\n", error );
        ApiResponseBuilder.internalError( res, error );
        return;
      }
    } );
  }

  // ==========================================================================
  // GET /by-team/:teamCode
  //   ?index=&limit=&domain=&kind=&from=&to=
  // ==========================================================================

  private registerGetEventsByTeam(): void {
    this.router.get( "/by-team/:teamCode", async ( req: Request, res: Response ): Promise<void> => {
      try {
        const teamCode = String( req.params.teamCode ?? "" ).trim();
        if ( !teamCode ) {
          ApiResponseBuilder.validationError( res, "teamCode path param is required." );
          return;
        }

        const { index, limit, skip } = this.parsePagination( req, 20 );
        const filter: FilterQuery<IWorkEvent> = { teamId: teamCode } as any;

        const domain = this.parseEnumQuery<TeamDomain>( req.query.domain, this.ALLOWED_DOMAINS );
        if ( domain ) ( filter as any ).domain = domain;

        const kind = this.parseEnumQuery<WorkEventKind>( req.query.kind, this.ALLOWED_KINDS );
        if ( kind ) ( filter as any ).kind = kind;

        const createdAtRange = this.parseCreatedAtIsoRange( req );
        if ( createdAtRange ) ( filter as any ).createdAt = createdAtRange;

        const [ total, rows ] = await Promise.all( [
          WorkEventModel.countDocuments( filter ).exec(),
          WorkEventModel.find( filter )
            .sort( { createdAt: -1 } )
            .skip( skip )
            .limit( limit )
            .exec(),
        ] );

        const events: WorkEventDto[] = ( rows as unknown as IWorkEvent[] ).map( ( e ) => this.toWorkEventDto( e ) );

        ApiResponseBuilder.ok(
          res,
          "events",
          events,
          "Work events for team fetched successfully.",
          {
            pagination: this.buildPaginationMeta( index, limit, total, events.length ),
            other: { teamCode },
          }
        );
        return;
      } catch ( error ) {
        console.error( "[Error:] [WorkEventApi:/by-team] Failed.\n", error );
        ApiResponseBuilder.internalError( res, error );
        return;
      }
    } );
  }

  // ==========================================================================
  // GET /stats/workitem/:workItemId
  //   → Simple counts by event kind for a work item
  // ==========================================================================

  private registerGetWorkItemEventStats(): void {
    this.router.get( "/stats/workitem/:workItemId", async ( req: Request, res: Response ): Promise<void> => {
      try {
        const workItemId = String( req.params.workItemId ?? "" ).trim();
        if ( !workItemId ) {
          ApiResponseBuilder.validationError( res, "workItemId path param is required." );
          return;
        }

        const match: FilterQuery<IWorkEvent> = { workItemId } as any;

        const pipeline: PipelineStage[] = [
          { $match: match as any },
          { $group: { _id: "$kind", count: { $sum: 1 } } },
        ];

        const rows: Array<{ _id: WorkEventKind; count: number; }> =
          await WorkEventModel.aggregate( pipeline ).exec();

        const byKind: Record<string, number> = {};
        for ( const row of rows ) {
          byKind[ String( row._id ) ] = row.count;
        }

        ApiResponseBuilder.ok(
          res,
          "other",
          { workItemId, byKind },
          "Work event stats by kind fetched successfully."
        );
        return;
      } catch ( error ) {
        console.error( "[Error:] [WorkEventApi:/stats/workitem] Failed.\n", error );
        ApiResponseBuilder.internalError( res, error );
        return;
      }
    } );
  }
}
