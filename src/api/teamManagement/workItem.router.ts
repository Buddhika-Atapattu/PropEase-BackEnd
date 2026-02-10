// Path: src/api/teamManagement/workItem.router.ts
// ============================================================================
// Work Item API (class-based) — DTO-safe, ApiResponseBuilder-safe (ERROR-FREE)
// ----------------------------------------------------------------------------
// Fixes:
// ✅ Always respond with WorkItemDto / WorkEventDto (never Mongoose Document)
// ✅ Convert ObjectId -> string (teamMongoId and all other id fields)
// ✅ exactOptionalPropertyTypes safe: omit optional props instead of assigning undefined
// ✅ Ensure workItem.value exists before assigning (fixes WorkItemValueMetrics error)
// ✅ Route order fixed: "/all" before "/:id"
// ============================================================================

import express, { Request, Response, Router } from "express";
import type { FilterQuery } from "mongoose";
import { Types } from "mongoose";

import { ApiResponseBuilder } from "../../utils/api-combiner.builder";

import {
    type IWorkItem,
    WorkItemModel,
    type WorkItemPriority,
    type WorkItemStatus,
    type WorkItemKind,
    WORK_ITEM_KINDS,
    type WorkItemDto,
} from "../../models/teamManagement/workItem.model";

import {
    type IWorkEvent,
    WorkEventModel,
    type WorkEventKind,
    type WorkEventDto,
} from "../../models/teamManagement/workEvent.model";

import type { TeamDomain } from "../../models/teamManagement/teamManagement.model";

// ----------------------------------------------------------------------------
// Actor injection type (from your auth middleware)
// ----------------------------------------------------------------------------
interface RequestWithActor extends Request {
    authUser?: {
        _id?: string | Types.ObjectId;
        username?: string;
        role?: string;
    };
}

// Evidence input (metadata-only)
type EvidenceEntryInput = {
    name?: string;
    storageKey?: string;
    url?: string;
    uploadedAt?: string;
};

export default class WorkItemApi {
    private readonly router: Router;

    private readonly ALLOWED_PRIORITIES: readonly WorkItemPriority[] = [
        "low",
        "medium",
        "high",
        "critical",
  ] as const;

    private readonly ALLOWED_DOMAINS: readonly TeamDomain[] = [
        "sales",
        "development",
        "support",
        "operations",
        "marketing",
        "finance",
        "other",
    ] as const;

    private readonly ALLOWED_STATUSES: readonly WorkItemStatus[] = [
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

    public constructor () {
        this.router = express.Router();

      this.registerCreateWorkItem(); // POST /create

      // IMPORTANT: "/all" must be before "/:id"
      this.registerGetAllWorkItems(); // GET /all
      this.registerGetWorkItemById(); // GET /:id

      this.registerUpdateWorkItem(); // PATCH /update/:id

      this.registerChangeStatus(); // PATCH /status/:id
      this.registerChangePriority(); // PATCH /priority/:id
      this.registerUpdateValue(); // PATCH /value/:id
      this.registerMoveTeamOrDomain(); // PATCH /move/:id

      this.registerAddEvidence(); // POST /:id/evidence
      this.registerGetWorkItemEvents(); // GET /:id/events
  }

    public get route(): Router {
        return this.router;
    }

    // ========================================================================
    // Core DTO Mapping (THIS is what fixes ApiResponseBuilder overload errors)
    // ========================================================================

    /**
     * Convert unknown id-like values into string (ObjectId => hex string).
     * - Returns undefined if not convertible, and caller should OMIT prop.
     */
    private toIdString( input: unknown ): string | undefined {
        if ( !input ) return undefined;

        if ( typeof input === "string" ) {
            const t = input.trim();
            return t ? t : undefined;
        }

        if ( input instanceof Types.ObjectId ) return input.toHexString();

        // Mongoose document populated _id sometimes comes as object with toString
        if ( typeof ( input as { toString?: unknown; } )?.toString === "function" ) {
            const s = String( input );
            return s ? s : undefined;
        }

        return undefined;
    }

    /**
     * exactOptionalPropertyTypes-safe setter:
     * - Only add property if value is not undefined (and optionally not empty).
     */
    private setIfDefined<T extends Record<string, unknown>, K extends keyof T>(
        target: T,
        key: K,
        value: T[ K ] | undefined
    ): void {
        if ( typeof value === "undefined" ) return;
        target[ key ] = value;
    }

    /**
     * WorkItem Document/Plain => WorkItemDto (ObjectIds -> strings).
     * NOTE: We intentionally OMIT undefined optionals.
     */
    private toWorkItemDto( doc: IWorkItem ): WorkItemDto {
        // Start with required base fields that must exist in your model/DTO.
        const dto: Record<string, unknown> = {
            id: String( ( doc as any ).id ?? "" ).trim(),
            teamId: String( ( doc as any ).teamId ?? "" ).trim(),
            domain: ( doc as any ).domain,
            kind: ( doc as any ).kind,
            status: ( doc as any ).status,
            priority: ( doc as any ).priority,
            title: String( ( doc as any ).title ?? "" ),
            description: String( ( doc as any ).description ?? "" ),
            createdById: this.toIdString( ( doc as any ).createdById ) ?? "",
            createdByUsername: String( ( doc as any ).createdByUsername ?? "" ),
            timing: {
                createdAt: String( ( doc as any ).timing?.createdAt ?? "" ),
                updatedAt: String( ( doc as any ).timing?.updatedAt ?? "" ),
            },
            audit: {
                source: String( ( doc as any ).audit?.source ?? "ui" ),
                requestId: String( ( doc as any ).audit?.requestId ?? "" ),
                deviceId: String( ( doc as any ).audit?.deviceId ?? "" ),
                createdById: this.toIdString( ( doc as any ).audit?.createdById ) ?? "",
                createdByUsername: String( ( doc as any ).audit?.createdByUsername ?? "" ),
            },
            value: {
                expectedValue: Number( ( doc as any ).value?.expectedValue ?? 0 ),
                actualValue: Number( ( doc as any ).value?.actualValue ?? 0 ),
                commissionAmount: Number( ( doc as any ).value?.commissionAmount ?? 0 ),
            },
            assignedMembers: Array.isArray( ( doc as any ).assignedMembers )
                ? ( doc as any ).assignedMembers
                    .map( ( x: unknown ) => this.toIdString( x ) )
                    .filter( ( x: string | undefined ): x is string => typeof x === "string" && !!x )
                : [],
        };

        // teamMongoId (DTO expects string)
        this.setIfDefined( dto, "teamMongoId" as any, this.toIdString( ( doc as any ).teamMongoId ) );

        // captainUserId (optional)
        this.setIfDefined( dto, "captainUserId" as any, this.toIdString( ( doc as any ).captainUserId ) );

        // plannedStartAt / plannedEndAt (nullable allowed if DTO uses null; otherwise omit if empty)
        if ( typeof ( doc as any ).plannedStartAt === "string" ) {
            const v = String( ( doc as any ).plannedStartAt ).trim();
            ( dto as any ).plannedStartAt = v ? v : null;
        } else if ( ( doc as any ).plannedStartAt === null ) {
            ( dto as any ).plannedStartAt = null;
        }

        if ( typeof ( doc as any ).plannedEndAt === "string" ) {
            const v = String( ( doc as any ).plannedEndAt ).trim();
            ( dto as any ).plannedEndAt = v ? v : null;
        } else if ( ( doc as any ).plannedEndAt === null ) {
            ( dto as any ).plannedEndAt = null;
        }

        // audit lastUpdated (optional)
        const lastUpdatedById = this.toIdString( ( doc as any ).audit?.lastUpdatedById );
        const lastUpdatedByUsernameRaw = ( doc as any ).audit?.lastUpdatedByUsername;
        const lastUpdatedByUsername =
            typeof lastUpdatedByUsernameRaw === "string" && lastUpdatedByUsernameRaw.trim()
                ? lastUpdatedByUsernameRaw.trim()
                : undefined;

        if ( lastUpdatedById ) ( dto as any ).audit.lastUpdatedById = lastUpdatedById;
        if ( lastUpdatedByUsername ) ( dto as any ).audit.lastUpdatedByUsername = lastUpdatedByUsername;

        // evidence (optional array)
        if ( Array.isArray( ( doc as any ).evidence ) ) {
            const mappedEvidence = ( doc as any ).evidence
                .map( ( e: any ) => {
                    const ev: Record<string, unknown> = {
                        name: typeof e?.name === "string" ? e.name : "evidence",
                        uploadedAt: typeof e?.uploadedAt === "string" ? e.uploadedAt : "",
                    };

                    const storageKey = typeof e?.storageKey === "string" && e.storageKey.trim() ? e.storageKey.trim() : undefined;
                    const url = typeof e?.url === "string" && e.url.trim() ? e.url.trim() : undefined;
                    const uploadedById = this.toIdString( e?.uploadedById );
                    const uploadedByName =
                        typeof e?.uploadedByName === "string" && e.uploadedByName.trim()
                            ? e.uploadedByName.trim()
                            : undefined;

                    if ( storageKey ) ev.storageKey = storageKey;
                    if ( url ) ev.url = url;
                    if ( uploadedById ) ev.uploadedById = uploadedById;
                    if ( uploadedByName ) ev.uploadedByName = uploadedByName;

                    return ev;
                } );

            ( dto as any ).evidence = mappedEvidence;
        }

        return dto as unknown as WorkItemDto;
    }

    /**
     * WorkEvent Document/Plain => WorkEventDto (id conversions if needed).
     * If your WorkEventDto already uses strings for ids, convert here.
     */
    private toWorkEventDto( doc: IWorkEvent ): WorkEventDto {
        const dto: Record<string, unknown> = { ...( doc as any ) };

        // Common conversions (only if those keys exist in your schema/DTO):
        const workItemId = this.toIdString( ( doc as any ).workItemId );
        if ( workItemId ) dto.workItemId = workItemId;

        const teamMongoId = this.toIdString( ( doc as any ).teamMongoId );
        if ( teamMongoId ) dto.teamMongoId = teamMongoId;

        const actorId = this.toIdString( ( doc as any ).actorId );
        if ( actorId ) dto.actorId = actorId;

        return dto as unknown as WorkEventDto;
    }

    // ========================================================================
    // Helpers
    // ========================================================================

    private parsePagination(
        req: Request,
      fallbackLimit: number = 10
  ): { index: number; limit: number; skip: number; } {
      const indexNum = Number( req.query.index );
      const limitNum = Number( req.query.limit );

      const index: number =
        Number.isFinite( indexNum ) && indexNum >= 0 ? indexNum : 0;

      const limit: number =
        Number.isFinite( limitNum ) && limitNum > 0 ? limitNum : fallbackLimit;

      return { index, limit, skip: index * limit };
  }

    private buildPaginationMeta(
        index: number,
        limit: number,
        total: number,
        rowsLen: number
    ): { index: number; limit: number; total: number; hasMore: boolean; } {
        return {
            index,
            limit,
            total,
            hasMore: index * limit + rowsLen < total,
        };
    }

    private parseString( value: unknown ): string | undefined {
        if ( typeof value !== "string" ) return undefined;
        const t = value.trim();
        return t ? t : undefined;
    }

    private parseBooleanQuery( value: unknown ): boolean | undefined {
        if ( typeof value === "boolean" ) return value;
        if ( typeof value === "string" ) {
            const v = value.trim().toLowerCase();
          if ( v === "true" || v === "1" ) return true;
          if ( v === "false" || v === "0" ) return false;
      }
      return undefined;
  }

    private parseObjectId( input: unknown ): Types.ObjectId | undefined {
        if ( !input ) return undefined;
        if ( input instanceof Types.ObjectId ) return input;

        try {
          return new Types.ObjectId( String( input ) );
      } catch {
          return undefined;
      }
  }

    private escapeRegExp( input: string ): string {
        return input.replace( /[.*+?^${}()|[\]\\]/g, "\\$&" );
    }

    private isValidDomain( raw: unknown ): raw is TeamDomain {
        if ( typeof raw !== "string" ) return false;
        return ( this.ALLOWED_DOMAINS as readonly string[] ).includes(
            raw.trim().toLowerCase()
        );
    }

    private isValidStatus( raw: unknown ): raw is WorkItemStatus {
        if ( typeof raw !== "string" ) return false;
        const v = raw.trim().toLowerCase();
        return ( this.ALLOWED_STATUSES as readonly string[] ).includes( v );
    }

    private isValidPriority( raw: unknown ): raw is WorkItemPriority {
        if ( typeof raw !== "string" ) return false;
        const v = raw.trim().toLowerCase();
        return ( this.ALLOWED_PRIORITIES as readonly string[] ).includes( v );
    }

    private isValidKind( raw: unknown ): raw is WorkItemKind {
        if ( typeof raw !== "string" ) return false;
        const v = raw.trim();
        return ( WORK_ITEM_KINDS as readonly string[] ).includes( v );
    }

    private getRequestId( req: Request ): string {
        const r = req as unknown as { requestId?: unknown; };
        return typeof r.requestId === "string" ? r.requestId : "";
    }

    private buildActorFromRequest( req: RequestWithActor ): {
        userId?: Types.ObjectId | string | null;
        username?: string | null;
        role?: string | null;
    } {
        const authUser = req.authUser;

      const bodyActor = ( req.body?.actor ?? {} ) as {
          userId?: string;
          username?: string;
          role?: string;
      };

      const userId = authUser?._id ?? bodyActor.userId ?? null;
      const username = authUser?.username ?? bodyActor.username ?? null;
      const role = authUser?.role ?? bodyActor.role ?? null;

      return { userId, username, role };
  }

    private async loadWorkItemOrFail(
        req: RequestWithActor,
      res: Response
  ): Promise<{ workItem: IWorkItem; } | undefined> {
      const idParam = String( req.params.id ?? "" ).trim();

      if ( !idParam ) {
          ApiResponseBuilder.validationError( res, "Work item ID is required." );
          return;
      }

      const workItem = await WorkItemModel.findById( idParam ).exec();

      if ( !workItem ) {
          ApiResponseBuilder.validationError(
              res,
          "Work item not found for the given ID."
      );
        return;
    }

      return { workItem: workItem as unknown as IWorkItem };
  }

    private parseTimingCreatedAtIsoRange(
        req: Request
    ): Record<string, string> | undefined {
        const from = this.parseString( req.query.from );
        const to = this.parseString( req.query.to );

      const range: Record<string, string> = {};

      if ( from ) {
          const d = new Date( from );
          if ( !Number.isNaN( d.getTime() ) ) range.$gte = d.toISOString();
      }

      if ( to ) {
          const d = new Date( to );
          if ( !Number.isNaN( d.getTime() ) ) range.$lte = d.toISOString();
      }

      return Object.keys( range ).length ? range : undefined;
  }

    // ========================================================================
    // POST /create
    // ========================================================================

    private registerCreateWorkItem(): void {
        this.router.post(
            "/create",
        async ( req: RequestWithActor, res: Response ): Promise<void> => {
            try {
                const body = req.body ?? {};

            const title: string = String( body.title ?? "" ).trim();
            const description: string = String( body.description ?? "" ).trim();

            if ( !title ) {
                ApiResponseBuilder.validationError( res, "Work item title is required." );
                return;
            }

            const statusRaw: string = ( this.parseString( body.status ) ?? "draft" )
                .trim()
                .toLowerCase();

            const priorityRaw: string = ( this.parseString( body.priority ) ?? "medium" )
                .trim()
                .toLowerCase();

            const kindRaw: string =
                typeof body.kind === "string" ? body.kind.trim() : "other";

            if ( !this.isValidStatus( statusRaw ) ) {
                ApiResponseBuilder.validationError(
                    res,
                `Invalid status. Allowed: ${ this.ALLOWED_STATUSES.join( ", " ) }`
            );
              return;
          }

            if ( !this.isValidPriority( priorityRaw ) ) {
                ApiResponseBuilder.validationError(
                    res,
                    `Invalid priority. Allowed: ${ this.ALLOWED_PRIORITIES.join( ", " ) }`
                );
                return;
            }

            if ( kindRaw && !this.isValidKind( kindRaw ) ) {
                ApiResponseBuilder.validationError(
                    res,
                    `Invalid kind. Allowed: ${ WORK_ITEM_KINDS.join( ", " ) }`
                );
                return;
            }

            const teamId: string = String( body.teamId ?? "" ).trim();
            const teamMongoId: Types.ObjectId | undefined = this.parseObjectId( body.teamMongoId );

            const domainRaw: string =
                typeof body.domain === "string" ? body.domain.trim().toLowerCase() : "";

            if ( !teamId || !teamMongoId || !domainRaw ) {
                ApiResponseBuilder.validationError(
                    res,
                "teamId (teamCode), teamMongoId and domain are required for work item creation."
            );
              return;
          }

            if ( !this.isValidDomain( domainRaw ) ) {
                ApiResponseBuilder.validationError( res, "Invalid domain." );
                return;
            }

            const actor = this.buildActorFromRequest( req );
            const createdById: Types.ObjectId | undefined = this.parseObjectId( actor.userId );
            const createdByUsername: string =
                typeof actor.username === "string" ? actor.username.trim() : "";

            if ( !createdById || !createdByUsername ) {
                ApiResponseBuilder.validationError(
                    res,
                    "createdById/createdByUsername are required (actor missing)."
                );
                return;
            }

            const assignedMembers: Types.ObjectId[] = Array.isArray( body.assignedMembers )
                ? ( body.assignedMembers as unknown[] )
                    .map( ( x: unknown ) => this.parseObjectId( x ) )
                    .filter( ( x: Types.ObjectId | undefined ): x is Types.ObjectId => !!x )
                : [];

            const captainUserId: Types.ObjectId | undefined = this.parseObjectId( body.captainUserId );

            const expectedValue: number = typeof body.expectedValue === "number" ? body.expectedValue : 0;
            const actualValue: number = typeof body.actualValue === "number" ? body.actualValue : 0;
            const commissionAmount: number =
              typeof body.commissionAmount === "number" ? body.commissionAmount : 0;

            const nowIso: string = new Date().toISOString();
            const requestIdHeader: string = this.getRequestId( req );
            const deviceIdHeader: string =
                typeof req.headers[ "x-device-id" ] === "string"
                    ? String( req.headers[ "x-device-id" ] )
                    : "";

            const createPayload: Partial<IWorkItem> = {
              id:
                  typeof body.id === "string" && body.id.trim()
                      ? body.id.trim()
                      : `WORK-${ Date.now() }`,

              teamId,
              teamMongoId,
              domain: domainRaw as TeamDomain,

              kind: ( kindRaw || "other" ) as WorkItemKind,
              status: statusRaw as WorkItemStatus,
              priority: priorityRaw as WorkItemPriority,

              createdById,
              createdByUsername,

              assignedMembers,
              ...( captainUserId ? { captainUserId } : {} ),

              title,
              description,

              ...( typeof body.plannedStartAt === "string"
                  ? { plannedStartAt: body.plannedStartAt.trim() || null }
                  : {} ),
              ...( typeof body.plannedEndAt === "string"
                  ? { plannedEndAt: body.plannedEndAt.trim() || null }
                  : {} ),

              timing: { createdAt: nowIso, updatedAt: nowIso },

              audit: {
                  source: "ui",
                  requestId: requestIdHeader,
                  deviceId: deviceIdHeader,
                  createdById,
                  createdByUsername,
              },

              value: {
                  expectedValue,
                  actualValue,
                  commissionAmount,
              },
          };

            const doc = ( await WorkItemModel.create( createPayload ) ) as unknown as IWorkItem;

            // ✅ convert to DTO before responding (fixes overload + ObjectId issues)
            const dto = this.toWorkItemDto( doc );

            ApiResponseBuilder.ok( res, "workItem", dto, "Work item created successfully." );
            return;
        } catch ( error ) {
            console.error( "[Error:] [WorkItemApi:/create] Failed.\n", error );
            ApiResponseBuilder.internalError( res, error );
            return;
        }
        }
    );
  }

    // ========================================================================
    // GET /:id
    // ========================================================================

    private registerGetWorkItemById(): void {
        this.router.get(
            "/:id",
        async ( req: Request, res: Response ): Promise<void> => {
            try {
            const id = String( req.params.id ?? "" ).trim();
            if ( !id ) {
                ApiResponseBuilder.validationError( res, "Work item ID is required." );
                return;
            }

            const item = ( await WorkItemModel.findById( id ).exec() ) as unknown as IWorkItem;
            if ( !item ) {
                ApiResponseBuilder.validationError( res, "Work item not found." );
                return;
            }

            const dto = this.toWorkItemDto( item );

            ApiResponseBuilder.ok( res, "workItem", dto, "Work item fetched successfully." );
            return;
        } catch ( error ) {
            console.error( "[Error:] [WorkItemApi:/:id] Failed.\n", error );
            ApiResponseBuilder.internalError( res, error );
            return;
        }
        }
    );
  }

    // ========================================================================
    // GET /all
    // ========================================================================

    private registerGetAllWorkItems(): void {
        this.router.get(
            "/all",
        async ( req: Request, res: Response ): Promise<void> => {
            try {
            const { index, limit, skip } = this.parsePagination( req, 10 );

            const search = this.parseString( req.query.search );
            const statusRaw = this.parseString( req.query.status );
            const priorityRaw = this.parseString( req.query.priority );
            const teamId = this.parseString( req.query.teamId );
            const domainRaw = this.parseString( req.query.domain );
            const isActive = this.parseBooleanQuery( req.query.isActive );

            const filter: FilterQuery<IWorkItem> = {};

            if ( search ) {
                filter.title = { $regex: new RegExp( this.escapeRegExp( search ), "i" ) };
            }

            if ( statusRaw && this.isValidStatus( statusRaw ) ) {
                filter.status = statusRaw.trim().toLowerCase() as WorkItemStatus;
            }

            if ( priorityRaw && this.isValidPriority( priorityRaw ) ) {
                filter.priority = priorityRaw.trim().toLowerCase() as WorkItemPriority;
          }

            if ( teamId ) filter.teamId = teamId;

            if ( domainRaw ) {
                const d = domainRaw.trim().toLowerCase();
                if ( this.isValidDomain( d ) ) filter.domain = d as TeamDomain;
            }

            if ( typeof isActive !== "undefined" ) {
                ( filter as unknown as Record<string, unknown> ).isActive = isActive;
            }

            const createdAtRange = this.parseTimingCreatedAtIsoRange( req );
            if ( createdAtRange ) {
                ( filter as unknown as Record<string, unknown> )[ "timing.createdAt" ] = createdAtRange;
            }

            const [ total, rows ] = await Promise.all( [
                WorkItemModel.countDocuments( filter ).exec(),
                WorkItemModel.find( filter )
                    .sort( { "timing.createdAt": -1 } )
                    .skip( skip )
                    .limit( limit )
                    .exec(),
          ] );

            const dtos: WorkItemDto[] = ( rows as unknown as IWorkItem[] ).map( ( r ) => this.toWorkItemDto( r ) );

            ApiResponseBuilder.ok( res, "workItems", dtos, "Work items fetched successfully.", {
                pagination: this.buildPaginationMeta( index, limit, total, dtos.length ),
            } );
            return;
        } catch ( error ) {
            console.error( "[Error:] [WorkItemApi:/all] Failed.\n", error );
            ApiResponseBuilder.internalError( res, error );
            return;
        }
        }
    );
  }

    // ========================================================================
    // PATCH /update/:id
    // ========================================================================

    private registerUpdateWorkItem(): void {
        this.router.patch(
            "/update/:id",
        async ( req: RequestWithActor, res: Response ): Promise<void> => {
            try {
            const loaded = await this.loadWorkItemOrFail( req, res );
            if ( !loaded ) return;

            const { workItem } = loaded;
            const body = req.body ?? {};

            if ( typeof body.title === "string" ) {
                const t = body.title.trim();
                if ( t ) ( workItem as any ).title = t;
            }

            if ( typeof body.description === "string" ) {
                ( workItem as any ).description = body.description.trim();
            }

            if ( typeof body.status === "string" && this.isValidStatus( body.status ) ) {
                ( workItem as any ).status = body.status.trim().toLowerCase();
            }

            if ( typeof body.priority === "string" && this.isValidPriority( body.priority ) ) {
                ( workItem as any ).priority = body.priority.trim().toLowerCase();
            }

            if ( typeof body.kind === "string" && this.isValidKind( body.kind ) ) {
                ( workItem as any ).kind = body.kind.trim();
          }

            if ( typeof body.plannedStartAt === "string" ) {
                const v = body.plannedStartAt.trim();
                ( workItem as any ).plannedStartAt = v ? v : null;
            }

            if ( typeof body.plannedEndAt === "string" ) {
                const v = body.plannedEndAt.trim();
                ( workItem as any ).plannedEndAt = v ? v : null;
          }

            if ( Array.isArray( body.assignedMembers ) ) {
                ( workItem as any ).assignedMembers = ( body.assignedMembers as unknown[] )
                    .map( ( x: unknown ) => this.parseObjectId( x ) )
                    .filter( ( x: Types.ObjectId | undefined ): x is Types.ObjectId => !!x );
            }

            if ( typeof body.captainUserId !== "undefined" ) {
                const nextCaptain = this.parseObjectId( body.captainUserId );
                if ( nextCaptain ) ( workItem as any ).captainUserId = nextCaptain;
            }

            // ✅ FIX #04: ensure value exists before assigning (exactOptionalPropertyTypes safe)
            if ( !( workItem as any ).value ) {
                ( workItem as any ).value = { expectedValue: 0, actualValue: 0, commissionAmount: 0 };
            }

            let valueTouched = false;

            if ( typeof body.expectedValue === "number" ) {
                ( workItem as any ).value.expectedValue = body.expectedValue;
                valueTouched = true;
            }
            if ( typeof body.actualValue === "number" ) {
                ( workItem as any ).value.actualValue = body.actualValue;
                valueTouched = true;
            }
            if ( typeof body.commissionAmount === "number" ) {
                ( workItem as any ).value.commissionAmount = body.commissionAmount;
                valueTouched = true;
            }

            // audit last updated
            const actor = this.buildActorFromRequest( req );
            const updatedById = this.parseObjectId( actor.userId );
            const updatedByUsername =
                typeof actor.username === "string" ? actor.username.trim() : "";

            if ( !( workItem as any ).audit ) {
                // Should not happen if schema requires it, but TS safety.
                ( workItem as any ).audit = {
                    source: "ui",
                    requestId: "",
                    deviceId: "",
                    createdById: ( workItem as any ).createdById,
                    createdByUsername: ( workItem as any ).createdByUsername,
                };
            }

            if ( updatedById ) ( workItem as any ).audit.lastUpdatedById = updatedById;
            if ( updatedByUsername ) ( workItem as any ).audit.lastUpdatedByUsername = updatedByUsername;

            if ( !( workItem as any ).timing ) {
                const nowIso = new Date().toISOString();
                ( workItem as any ).timing = { createdAt: nowIso, updatedAt: nowIso };
            }

            ( workItem as any ).timing.updatedAt = new Date().toISOString();

            const saved = ( await ( workItem as any ).save() ) as unknown as IWorkItem;
            const dto = this.toWorkItemDto( saved );

            ApiResponseBuilder.ok( res, "workItem", dto, "Work item updated successfully." );
            return;
        } catch ( error ) {
            console.error( "[Error:] [WorkItemApi:/update/:id] Failed.\n", error );
            ApiResponseBuilder.internalError( res, error );
            return;
        }
        }
    );
  }

    // ========================================================================
    // PATCH /status/:id
    // ========================================================================

    private registerChangeStatus(): void {
        this.router.patch(
            "/status/:id",
        async ( req: RequestWithActor, res: Response ): Promise<void> => {
            try {
            const loaded = await this.loadWorkItemOrFail( req, res );
            if ( !loaded ) return;

            const { workItem } = loaded;

            const statusRaw = this.parseString( req.body?.status );
            if ( !statusRaw || !this.isValidStatus( statusRaw ) ) {
                ApiResponseBuilder.validationError(
                    res,
                `Invalid status. Allowed: ${ this.ALLOWED_STATUSES.join( ", " ) }`
            );
              return;
          }

            const toStatus = statusRaw.trim().toLowerCase() as WorkItemStatus;

            if ( ( workItem as any ).status === toStatus ) {
                ApiResponseBuilder.ok( res, "workItem", this.toWorkItemDto( workItem ), "Status is already set." );
                return;
            }

            ( workItem as any ).status = toStatus;

            if ( !( workItem as any ).timing ) {
                const nowIso = new Date().toISOString();
                ( workItem as any ).timing = { createdAt: nowIso, updatedAt: nowIso };
            }
            ( workItem as any ).timing.updatedAt = new Date().toISOString();

            const saved = ( await ( workItem as any ).save() ) as unknown as IWorkItem;
            const dto = this.toWorkItemDto( saved );

            ApiResponseBuilder.ok( res, "workItem", dto, "Work item status updated successfully." );
            return;
        } catch ( error ) {
            console.error( "[Error:] [WorkItemApi:/status/:id] Failed.\n", error );
            ApiResponseBuilder.internalError( res, error );
            return;
        }
        }
    );
  }

    // ========================================================================
    // PATCH /priority/:id
    // ========================================================================

    private registerChangePriority(): void {
        this.router.patch(
            "/priority/:id",
        async ( req: RequestWithActor, res: Response ): Promise<void> => {
            try {
            const loaded = await this.loadWorkItemOrFail( req, res );
            if ( !loaded ) return;

            const { workItem } = loaded;

            const priorityRaw = this.parseString( req.body?.priority );
            if ( !priorityRaw || !this.isValidPriority( priorityRaw ) ) {
                ApiResponseBuilder.validationError(
                    res,
                `Invalid priority. Allowed: ${ this.ALLOWED_PRIORITIES.join( ", " ) }`
            );
              return;
          }

            const toPriority = priorityRaw.trim().toLowerCase() as WorkItemPriority;

            if ( ( workItem as any ).priority === toPriority ) {
                ApiResponseBuilder.ok( res, "workItem", this.toWorkItemDto( workItem ), "Priority is already set." );
                return;
            }

            ( workItem as any ).priority = toPriority;

            if ( !( workItem as any ).timing ) {
                const nowIso = new Date().toISOString();
                ( workItem as any ).timing = { createdAt: nowIso, updatedAt: nowIso };
            }
            ( workItem as any ).timing.updatedAt = new Date().toISOString();

            const saved = ( await ( workItem as any ).save() ) as unknown as IWorkItem;
            const dto = this.toWorkItemDto( saved );

            ApiResponseBuilder.ok( res, "workItem", dto, "Work item priority updated successfully." );
            return;
        } catch ( error ) {
            console.error( "[Error:] [WorkItemApi:/priority/:id] Failed.\n", error );
            ApiResponseBuilder.internalError( res, error );
            return;
        }
        }
    );
  }

    // ========================================================================
    // PATCH /value/:id
    // ========================================================================

    private registerUpdateValue(): void {
        this.router.patch(
            "/value/:id",
        async ( req: RequestWithActor, res: Response ): Promise<void> => {
            try {
            const loaded = await this.loadWorkItemOrFail( req, res );
            if ( !loaded ) return;

            const { workItem } = loaded;
            const body = req.body ?? {};

            // ✅ FIX #04 again: value MUST exist
            if ( !( workItem as any ).value ) {
                ( workItem as any ).value = { expectedValue: 0, actualValue: 0, commissionAmount: 0 };
            }

            let changed = false;

            if ( typeof body.expectedValue === "number" ) {
                ( workItem as any ).value.expectedValue = body.expectedValue;
                changed = true;
            }

            if ( typeof body.actualValue === "number" ) {
                ( workItem as any ).value.actualValue = body.actualValue;
                changed = true;
            }

            if ( typeof body.commissionAmount === "number" ) {
                ( workItem as any ).value.commissionAmount = body.commissionAmount;
                changed = true;
            }

            if ( !changed ) {
                ApiResponseBuilder.validationError( res, "No value fields provided to update." );
                return;
            }

            if ( !( workItem as any ).timing ) {
                const nowIso = new Date().toISOString();
                ( workItem as any ).timing = { createdAt: nowIso, updatedAt: nowIso };
            }
            ( workItem as any ).timing.updatedAt = new Date().toISOString();

            const saved = ( await ( workItem as any ).save() ) as unknown as IWorkItem;
            const dto = this.toWorkItemDto( saved );

            ApiResponseBuilder.ok( res, "workItem", dto, "Work item value updated successfully." );
            return;
        } catch ( error ) {
            console.error( "[Error:] [WorkItemApi:/value/:id] Failed.\n", error );
            ApiResponseBuilder.internalError( res, error );
            return;
        }
        }
    );
  }

    // ========================================================================
    // PATCH /move/:id
    // ========================================================================

    private registerMoveTeamOrDomain(): void {
        this.router.patch(
            "/move/:id",
        async ( req: RequestWithActor, res: Response ): Promise<void> => {
            try {
            const loaded = await this.loadWorkItemOrFail( req, res );
            if ( !loaded ) return;

            const { workItem } = loaded;
            const body = req.body ?? {};

            let changed = false;

            if ( typeof body.teamId === "string" && body.teamId.trim() ) {
                const nextTeamId = body.teamId.trim();
                if ( ( workItem as any ).teamId !== nextTeamId ) {
                    ( workItem as any ).teamId = nextTeamId;
                    changed = true;
                }
            }

            if ( typeof body.teamMongoId !== "undefined" ) {
                const nextMongoId = this.parseObjectId( body.teamMongoId );
                if ( !nextMongoId ) {
                    ApiResponseBuilder.validationError( res, "Invalid teamMongoId." );
                    return;
                }

              if ( !( workItem as any ).teamMongoId?.equals( nextMongoId ) ) {
                  ( workItem as any ).teamMongoId = nextMongoId;
                  changed = true;
              }
          }

            if ( typeof body.domain === "string" && body.domain.trim() ) {
                const nextDomain = body.domain.trim().toLowerCase();
                if ( !this.isValidDomain( nextDomain ) ) {
                    ApiResponseBuilder.validationError( res, "Invalid domain." );
                    return;
                }

              if ( String( ( workItem as any ).domain ).toLowerCase() !== nextDomain ) {
                  ( workItem as any ).domain = nextDomain;
                  changed = true;
              }
          }

            if ( !changed ) {
                ApiResponseBuilder.validationError( res, "No team/domain changes detected." );
                return;
            }

            if ( !( workItem as any ).timing ) {
              const nowIso = new Date().toISOString();
              ( workItem as any ).timing = { createdAt: nowIso, updatedAt: nowIso };
          }
            ( workItem as any ).timing.updatedAt = new Date().toISOString();

            const saved = ( await ( workItem as any ).save() ) as unknown as IWorkItem;
            const dto = this.toWorkItemDto( saved );

            ApiResponseBuilder.ok( res, "workItem", dto, "Work item team/domain updated successfully." );
            return;
        } catch ( error ) {
            console.error( "[Error:] [WorkItemApi:/move/:id] Failed.\n", error );
            ApiResponseBuilder.internalError( res, error );
            return;
        }
        }
    );
  }

    // ========================================================================
    // POST /:id/evidence
    // ========================================================================

    private registerAddEvidence(): void {
        this.router.post(
        "/:id/evidence",
        async ( req: RequestWithActor, res: Response ): Promise<void> => {
            try {
            const loaded = await this.loadWorkItemOrFail( req, res );
            if ( !loaded ) return;

            const { workItem } = loaded;

            const evidences = req.body?.evidences as EvidenceEntryInput[] | undefined;
            if ( !Array.isArray( evidences ) || evidences.length === 0 ) {
                ApiResponseBuilder.validationError( res, "At least one evidence entry is required." );
                return;
            }

            const actor = this.buildActorFromRequest( req );
            const uploadedById = this.parseObjectId( actor.userId );
            const uploadedByName =
                typeof actor.username === "string" ? actor.username.trim() : "";

            const nowIso = new Date().toISOString();

            const normalized = evidences.map( ( e ) => {
                const name =
                    typeof e?.name === "string" && e.name.trim() ? e.name.trim() : "evidence";

                const item: Record<string, unknown> = {
                    name,
                    uploadedAt:
                        typeof e?.uploadedAt === "string" && e.uploadedAt.trim()
                            ? e.uploadedAt.trim()
                            : nowIso,
                };

              if ( typeof e?.storageKey === "string" && e.storageKey.trim() ) item.storageKey = e.storageKey.trim();
              if ( typeof e?.url === "string" && e.url.trim() ) item.url = e.url.trim();

              if ( uploadedById ) item.uploadedById = uploadedById;
              if ( uploadedByName ) item.uploadedByName = uploadedByName;

              return item;
          } );

            if ( !Array.isArray( ( workItem as any ).evidence ) ) {
                ( workItem as any ).evidence = [];
            }

            ( workItem as any ).evidence.push( ...normalized );

            if ( !( workItem as any ).timing ) {
                ( workItem as any ).timing = { createdAt: nowIso, updatedAt: nowIso };
            }
            ( workItem as any ).timing.updatedAt = nowIso;

            const saved = ( await ( workItem as any ).save() ) as unknown as IWorkItem;
            const dto = this.toWorkItemDto( saved );

            ApiResponseBuilder.ok( res, "workItem", dto, "Evidence added to work item successfully." );
            return;
        } catch ( error ) {
            console.error( "[Error:] [WorkItemApi:/:id/evidence] Failed.\n", error );
            ApiResponseBuilder.internalError( res, error );
            return;
        }
        }
    );
  }

    // ========================================================================
    // GET /:id/events (READ-ONLY)
    // ========================================================================

    private registerGetWorkItemEvents(): void {
        this.router.get(
            "/:id/events",
        async ( req: Request, res: Response ): Promise<void> => {
            try {
            const id = String( req.params.id ?? "" ).trim();
            if ( !id ) {
                ApiResponseBuilder.validationError( res, "Work item ID is required." );
                return;
            }

            const { index, limit, skip } = this.parsePagination( req, 20 );
            const kind = this.parseString( req.query.kind );

            const filter: FilterQuery<IWorkEvent> = { workItemId: id };
            if ( kind ) filter.kind = kind as WorkEventKind;

            const fromToRange: Record<string, string> = {};
            const from = this.parseString( req.query.from );
            const to = this.parseString( req.query.to );

            if ( from ) {
                const d = new Date( from );
                if ( !Number.isNaN( d.getTime() ) ) fromToRange.$gte = d.toISOString();
            }
            if ( to ) {
                const d = new Date( to );
                if ( !Number.isNaN( d.getTime() ) ) fromToRange.$lte = d.toISOString();
          }
            if ( Object.keys( fromToRange ).length ) {
                ( filter as unknown as Record<string, unknown> ).createdAt = fromToRange;
            }

            const [ total, rows ] = await Promise.all( [
                WorkEventModel.countDocuments( filter ).exec(),
                WorkEventModel.find( filter )
                    .sort( { createdAt: -1 } )
                    .skip( skip )
                    .limit( limit )
                    .exec(),
          ] );

            const dtos: WorkEventDto[] = ( rows as unknown as IWorkEvent[] ).map( ( r ) => this.toWorkEventDto( r ) );

            ApiResponseBuilder.ok( res, "events", dtos, "Work item events fetched successfully.", {
                pagination: this.buildPaginationMeta( index, limit, total, dtos.length ),
            } );
            return;
        } catch ( error ) {
            console.error( "[Error:] [WorkItemApi:/:id/events] Failed.\n", error );
            ApiResponseBuilder.internalError( res, error );
            return;
        }
        }
    );
  }
}
