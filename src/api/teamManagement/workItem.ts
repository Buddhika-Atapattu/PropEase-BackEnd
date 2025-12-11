// Path: src/api/teamManagement/workItem.ts
// ============================================================================
// Work Item & Work Event API (class-based)
// ----------------------------------------------------------------------------
// Responsibilities:
//   - CRUD / updates for WorkItem
//   - Business actions (status, priority, value changes, move team/domain)
//   - Evidence/comment operations (only metadata here – files handled elsewhere)
//   - Event logging using WorkEventService (fire-and-forget)
//   - Query WorkEvent timeline for a work item
//
// NOTE:
//   - All logging is best-effort; failures NEVER break the main response.
//   - exactOptionalPropertyTypes-safe object construction.
// ============================================================================

import express, { Request, Response, Router } from "express";
import { FilterQuery, Types } from "mongoose";

import { ApiResponseBuilder } from "../../utils/api-combiner.builder";

import {
    IWorkItem,
    WorkItemModel,
    WorkItemPriority,
    WorkItemStatus,
} from "../../models/teamManagement/workItem.model";
import {
    IWorkEvent,
    WorkEventModel,
    WorkEventKind,
} from "../../models/teamManagement/workEvent.model";
import {
    TeamDomain,
} from "../../models/teamManagement/teamManagement.model";

import { WorkEventService } from "../../services/teamManagement/work-event.service";

// Optional: shape of evidence/comment on WorkItem.
// Adjust to your actual model if needed.
type EvidenceEntry = {
    id?: string;
    name?: string;
    storageKey?: string;
    url?: string;
    addedAt?: string;
};

type CommentEntry = {
    id: string;
    text: string;
    createdBy?: {
        userId?: string;
        username?: string;
    };
    createdAt: string;
};

// ----------------------------------------------------------------------------
// Type for actor injection from auth middleware (if you already have something)
// ----------------------------------------------------------------------------
interface RequestWithActor extends Request {
    authUser?: {
        _id?: string | Types.ObjectId;
        username?: string;
        role?: string;
    };
}

// ============================================================================
// Router class
// ============================================================================
export default class WorkItemApi {
    private readonly router: Router;

    /** Allowed work item statuses, used for validation. */
    private readonly ALLOWED_STATUSES: WorkItemStatus[] = [
        "backlog",
        "open",
        "in_progress",
        "blocked",
        "done",
        "cancelled",
    ];

    /** Allowed work item priorities, used for validation. */
    private readonly ALLOWED_PRIORITIES: WorkItemPriority[] = [
        "low",
        "medium",
        "high",
        "critical",
    ];

    public constructor () {
        this.router = express.Router();

        // Core work item operations
        this.registerCreateWorkItem();          // POST   /create
        this.registerGetWorkItemById();         // GET    /:id
        this.registerGetAllWorkItems();         // GET    /all
        this.registerUpdateWorkItem();          // PATCH  /update/:id

        // Focused actions
        this.registerChangeStatus();            // PATCH  /status/:id
        this.registerChangePriority();          // PATCH  /priority/:id
        this.registerUpdateValue();             // PATCH  /value/:id
        this.registerMoveTeamOrDomain();        // PATCH  /move/:id

        // Evidence & comments
        this.registerAddEvidence();             // POST   /:id/evidence
        this.registerAddComment();              // POST   /:id/comment

        // Events (read-only)
        this.registerGetWorkItemEvents();       // GET    /:id/events
    }

    public get route(): Router {
        return this.router;
    }

    // ========================================================================
    // Generic helpers
    // ========================================================================

    private parsePagination(
        req: Request,
        fallbackLimit: number = 10,
    ): { index: number; limit: number; skip: number; } {
        const indexRaw = req.query.index;
        const limitRaw = req.query.limit;

        const indexNum = Number( indexRaw );
        const limitNum = Number( limitRaw );

        const index: number =
            Number.isFinite( indexNum ) && indexNum >= 0 ? indexNum : 0;

        const limit: number =
            Number.isFinite( limitNum ) && limitNum > 0 ? limitNum : fallbackLimit;

        const skip = index * limit;
        return { index, limit, skip };
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

    /**
     * Build actor context from request:
     *  - Prefer req.authUser (if you have auth middleware)
     *  - Fallback to body.actor (if FE sends explicit actor)
     */
    private buildActorFromRequest( req: RequestWithActor ): {
        userId?: Types.ObjectId | string | null;
        username?: string | null;
        role?: string | null;
    } {
        const authUser = req.authUser;
        const bodyActor = ( req.body?.actor ??
            {} ) as { userId?: string; username?: string; role?: string; };

        const userId =
            authUser?._id ?? bodyActor.userId ?? null;
        const username =
            authUser?.username ?? bodyActor.username ?? null;
        const role =
            authUser?.role ?? bodyActor.role ?? null;

        return { userId, username, role };
    }

    /**
     * Helper: ensure we have a WorkItem and a base event context.
     */
    private async loadWorkItemOrFail(
        req: RequestWithActor,
        res: Response,
    ): Promise<{ workItem: IWorkItem; } | undefined> {
        const idParam = String( req.params.id ?? "" ).trim();

        if ( !idParam ) {
            ApiResponseBuilder.validationError(
                res,
                "Work item ID is required.",
            );
            return undefined;
        }

        const workItem = await WorkItemModel.findById(
            idParam,
        ).exec();

        if ( !workItem ) {
            ApiResponseBuilder.validationError(
                res,
                "Work item not found for the given ID.",
            );
            return undefined;
        }

        return { workItem };
    }

    /**
     * Build base event params for WorkEventService from a work item + request.
     *
     * ASSUMPTION: your IWorkItem has these fields:
     *  - teamId: string;
     *  - teamMongoId: Types.ObjectId;
     *  - domain: TeamDomain;
     *
     * Adjust field names here if your model differs.
     */
    private buildBaseEventParams(
        workItem: IWorkItem,
        req: RequestWithActor,
    ): {
        workItem: IWorkItem;
        teamId: string;
        teamMongoId: Types.ObjectId;
        domain: TeamDomain;
        actor?: {
            userId?: Types.ObjectId | string | null;
            username?: string | null;
            role?: string | null;
        };
    } {
        const actor = this.buildActorFromRequest( req );

        // These property names must match your IWorkItem implementation.
        const teamId: string = ( workItem as any ).teamId;
        const teamMongoId: Types.ObjectId = ( workItem as any )
            .teamMongoId as Types.ObjectId;
        const domain: TeamDomain = ( workItem as any )
            .domain as TeamDomain;

        return {
            workItem,
            teamId,
            teamMongoId,
            domain,
            actor,
        };
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
                    const description: string = String(
                        body.description ?? "",
                    ).trim();

                    if ( !title ) {
                        ApiResponseBuilder.validationError(
                            res,
                            "Work item title is required.",
                        );
                        return;
                    }

                    const status: WorkItemStatus =
                        ( body.status as WorkItemStatus ) ?? "backlog";
                    const priority: WorkItemPriority =
                        ( body.priority as WorkItemPriority ) ?? "medium";

                    const teamId: string = String( body.teamId ?? "" ).trim();
                    const teamMongoId = this.parseObjectId( body.teamMongoId );
                    const domain: TeamDomain = body.domain as TeamDomain;

                    if ( !teamId || !teamMongoId || !domain ) {
                        ApiResponseBuilder.validationError(
                            res,
                            "teamId, teamMongoId and domain are required for work item creation.",
                        );
                        return;
                    }

                    const expectedValue: number =
                        typeof body.expectedValue === "number"
                            ? body.expectedValue
                            : 0;
                    const actualValue: number =
                        typeof body.actualValue === "number"
                            ? body.actualValue
                            : 0;
                    const commissionAmount: number =
                        typeof body.commissionAmount === "number"
                            ? body.commissionAmount
                            : 0;

                    const nowIso = new Date().toISOString();

                    const createPayload: Partial<IWorkItem> = {
                        title,
                        description,
                        status,
                        priority,
                        // team context
                        teamId,
                        teamMongoId,
                        domain,
                        // value fields
                        expectedValue,
                        actualValue,
                        commissionAmount,
                        createdAt: nowIso,
                        updatedAt: nowIso,
                    };

                    const doc = await WorkItemModel.create( createPayload );

                    // Fire-and-forget event logging
                    const baseParams = this.buildBaseEventParams(
                        doc,
                        req,
                    );
                    void WorkEventService.logWorkItemCreated( baseParams );

                    ApiResponseBuilder.ok(
                        res,
                        "workItem",
                        doc,
                        "Work item created successfully.",
                    );
                    return;
                } catch ( error ) {
                    console.error(
                        "[WorkItemApi] Error during work item creation:\n",
                        error,
                    );
                    ApiResponseBuilder.internalError( res, error );
                    return;
                }
            },
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
                        ApiResponseBuilder.validationError(
                            res,
                            "Work item ID is required.",
                        );
                        return;
                    }

                    const item = await WorkItemModel.findById( id ).exec();
                    if ( !item ) {
                        ApiResponseBuilder.validationError(
                            res,
                            "Work item not found.",
                        );
                        return;
                    }

                    ApiResponseBuilder.ok(
                        res,
                        "workItem",
                        item,
                        "Work item fetched successfully.",
                    );
                    return;
                } catch ( error ) {
                    console.error(
                        "[WorkItemApi] Error while fetching work item by ID:\n",
                        error,
                    );
                    ApiResponseBuilder.internalError( res, error );
                    return;
                }
            },
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
                    const { index, limit, skip } = this.parsePagination(
                        req,
                        10,
                    );

                    const searchRaw = req.query.search;
                    const search: string | undefined =
                        typeof searchRaw === "string" &&
                            searchRaw.trim().length > 0
                            ? searchRaw.trim()
                            : undefined;

                    const statusRaw = req.query.status;
                    const priorityRaw = req.query.priority;
                    const teamIdRaw = req.query.teamId;
                    const domainRaw = req.query.domain;

                    const filter: FilterQuery<IWorkItem> = {};

                    if ( search ) {
                        filter.title = { $regex: search, $options: "i" };
                    }

                    if ( typeof statusRaw === "string" ) {
                        const status = statusRaw as WorkItemStatus;
                        if ( this.ALLOWED_STATUSES.includes( status ) ) {
                            filter.status = status;
                        }
                    }

                    if ( typeof priorityRaw === "string" ) {
                        const priority = priorityRaw as WorkItemPriority;
                        if ( this.ALLOWED_PRIORITIES.includes( priority ) ) {
                            filter.priority = priority;
                        }
                    }

                    if ( typeof teamIdRaw === "string" && teamIdRaw.trim() ) {
                        filter.teamId = teamIdRaw.trim();
                    }

                    if ( typeof domainRaw === "string" && domainRaw.trim() ) {
                        filter.domain = domainRaw.trim() as TeamDomain;
                    }

                    const [ total, rows ] = await Promise.all( [
                        WorkItemModel.countDocuments( filter ).exec(),
                        WorkItemModel.find( filter )
                            .sort( { createdAt: -1 } )
                            .skip( skip )
                            .limit( limit )
                            .exec(),
                    ] );

                    const pagination = {
                        index,
                        limit,
                        total,
                    };

                    ApiResponseBuilder.ok(
                        res,
                        "workItems",
                        rows,
                        "Work items fetched successfully.",
                        { pagination },
                    );
                    return;
                } catch ( error ) {
                    console.error(
                        "[WorkItemApi] Error while fetching work items:\n",
                        error,
                    );
                    ApiResponseBuilder.internalError( res, error );
                    return;
                }
            },
        );
    }

    // ========================================================================
    // PATCH /update/:id  (generic update)
    //   - Detects changes and logs events:
    //     • status_changed
    //     • priority_changed
    //     • value_updated
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

                    // Capture previous values for event logging
                    const prevStatus: WorkItemStatus | undefined =
                        workItem.status as WorkItemStatus;
                    const prevPriority: WorkItemPriority | undefined =
                        workItem.priority as WorkItemPriority;
                    const prevExpected: number | undefined =
                        ( workItem as any ).expectedValue;
                    const prevActual: number | undefined =
                        ( workItem as any ).actualValue;
                    const prevCommission: number | undefined =
                        ( workItem as any ).commissionAmount;

                    let statusChanged = false;
                    let priorityChanged = false;
                    let valueChanged = false;

                    // We modify the mongoose document directly (safer than Partial<...> object)
                    if ( typeof body.title === "string" ) {
                        workItem.title = body.title.trim() || workItem.title;
                    }

                    if ( typeof body.description === "string" ) {
                        workItem.description =
                            body.description.trim() || workItem.description;
                    }

                    if (
                        typeof body.status === "string" &&
                        this.ALLOWED_STATUSES.includes( body.status as WorkItemStatus )
                    ) {
                        const newStatus = body.status as WorkItemStatus;
                        if ( newStatus !== prevStatus ) {
                            workItem.status = newStatus;
                            statusChanged = true;
                        }
                    }

                    if (
                        typeof body.priority === "string" &&
                        this.ALLOWED_PRIORITIES.includes(
                            body.priority as WorkItemPriority,
                        )
                    ) {
                        const newPriority = body.priority as WorkItemPriority;
                        if ( newPriority !== prevPriority ) {
                            workItem.priority = newPriority;
                            priorityChanged = true;
                        }
                    }

                    if ( typeof body.expectedValue === "number" ) {
                        ( workItem as any ).expectedValue = body.expectedValue;
                        valueChanged = true;
                    }

                    if ( typeof body.actualValue === "number" ) {
                        ( workItem as any ).actualValue = body.actualValue;
                        valueChanged = true;
                    }

                    if ( typeof body.commissionAmount === "number" ) {
                        ( workItem as any ).commissionAmount =
                            body.commissionAmount;
                        valueChanged = true;
                    }

                    workItem.updatedAt = new Date().toISOString();

                    const saved = await workItem.save();

                    // Build base event params once
                    const baseParams = this.buildBaseEventParams(
                        saved,
                        req,
                    );

                    // Fire logging in the background (do not await one by one)
                    if ( statusChanged ) {
                        void WorkEventService.logStatusChange( {
                            ...baseParams,
                            fromStatus: prevStatus,
                            toStatus: saved.status as WorkItemStatus,
                        } );
                    }

                    if ( priorityChanged ) {
                        void WorkEventService.logPriorityChange( {
                            ...baseParams,
                            fromPriority: prevPriority,
                            toPriority: saved.priority as WorkItemPriority,
                        } );
                    }

                    if ( valueChanged ) {
                        void WorkEventService.logValueUpdated( {
                            ...baseParams,
                            previousExpected: prevExpected,
                            previousActual: prevActual,
                        } );
                    }

                    ApiResponseBuilder.ok(
                        res,
                        "workItem",
                        saved,
                        "Work item updated successfully.",
                    );
                    return;
                } catch ( error ) {
                    console.error(
                        "[WorkItemApi] Error during work item update:\n",
                        error,
                    );
                    ApiResponseBuilder.internalError( res, error );
                    return;
                }
            },
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

                    const newStatusRaw = String(
                        req.body?.status ?? "",
                    ).trim() as WorkItemStatus;

                    if ( !this.ALLOWED_STATUSES.includes( newStatusRaw ) ) {
                        ApiResponseBuilder.validationError(
                            res,
                            `Invalid status. Allowed: ${ this.ALLOWED_STATUSES.join(
                                ", ",
                            ) }`,
                        );
                        return;
                    }

                    const fromStatus: WorkItemStatus | undefined =
                        workItem.status as WorkItemStatus;
                    const toStatus: WorkItemStatus = newStatusRaw;

                    if ( fromStatus === toStatus ) {
                        ApiResponseBuilder.ok(
                            res,
                            "workItem",
                            workItem,
                            "Status is already set to requested value.",
                        );
                        return;
                    }

                    workItem.status = toStatus;
                    workItem.updatedAt = new Date().toISOString();

                    const saved = await workItem.save();

                    const baseParams = this.buildBaseEventParams(
                        saved,
                        req,
                    );
                    void WorkEventService.logStatusChange( {
                        ...baseParams,
                        fromStatus,
                        toStatus,
                    } );

                    ApiResponseBuilder.ok(
                        res,
                        "workItem",
                        saved,
                        "Work item status updated successfully.",
                    );
                    return;
                } catch ( error ) {
                    console.error(
                        "[WorkItemApi] Error during status change:\n",
                        error,
                    );
                    ApiResponseBuilder.internalError( res, error );
                    return;
                }
            },
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

                    const newPriorityRaw = String(
                        req.body?.priority ?? "",
                    ).trim() as WorkItemPriority;

                    if (
                        !this.ALLOWED_PRIORITIES.includes( newPriorityRaw )
                    ) {
                        ApiResponseBuilder.validationError(
                            res,
                            `Invalid priority. Allowed: ${ this.ALLOWED_PRIORITIES.join(
                                ", ",
                            ) }`,
                        );
                        return;
                    }

                    const fromPriority: WorkItemPriority | undefined =
                        workItem.priority as WorkItemPriority;
                    const toPriority: WorkItemPriority = newPriorityRaw;

                    if ( fromPriority === toPriority ) {
                        ApiResponseBuilder.ok(
                            res,
                            "workItem",
                            workItem,
                            "Priority is already set to requested value.",
                        );
                        return;
                    }

                    workItem.priority = toPriority;
                    workItem.updatedAt = new Date().toISOString();

                    const saved = await workItem.save();

                    const baseParams = this.buildBaseEventParams(
                        saved,
                        req,
                    );
                    void WorkEventService.logPriorityChange( {
                        ...baseParams,
                        fromPriority,
                        toPriority,
                    } );

                    ApiResponseBuilder.ok(
                        res,
                        "workItem",
                        saved,
                        "Work item priority updated successfully.",
                    );
                    return;
                } catch ( error ) {
                    console.error(
                        "[WorkItemApi] Error during priority change:\n",
                        error,
                    );
                    ApiResponseBuilder.internalError( res, error );
                    return;
                }
            },
        );
    }

    // ========================================================================
    // PATCH /value/:id
    //   - Update expectedValue / actualValue / commissionAmount
    //   - Logs value_updated event
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

                    const prevExpected: number | undefined =
                        ( workItem as any ).expectedValue;
                    const prevActual: number | undefined =
                        ( workItem as any ).actualValue;
                    const prevCommission: number | undefined =
                        ( workItem as any ).commissionAmount;

                    let changed = false;

                    if ( typeof body.expectedValue === "number" ) {
                        ( workItem as any ).expectedValue = body.expectedValue;
                        changed = true;
                    }

                    if ( typeof body.actualValue === "number" ) {
                        ( workItem as any ).actualValue = body.actualValue;
                        changed = true;
                    }

                    if ( typeof body.commissionAmount === "number" ) {
                        ( workItem as any ).commissionAmount =
                            body.commissionAmount;
                        changed = true;
                    }

                    if ( !changed ) {
                        ApiResponseBuilder.validationError(
                            res,
                            "No value fields provided to update.",
                        );
                        return;
                    }

                    workItem.updatedAt = new Date().toISOString();
                    const saved = await workItem.save();

                    const baseParams = this.buildBaseEventParams(
                        saved,
                        req,
                    );
                    void WorkEventService.logValueUpdated( {
                        ...baseParams,
                        previousExpected: prevExpected,
                        previousActual: prevActual,
                    } );

                    ApiResponseBuilder.ok(
                        res,
                        "workItem",
                        saved,
                        "Work item value fields updated successfully.",
                    );
                    return;
                } catch ( error ) {
                    console.error(
                        "[WorkItemApi] Error during value update:\n",
                        error,
                    );
                    ApiResponseBuilder.internalError( res, error );
                    return;
                }
            },
        );
    }

    // ========================================================================
    // PATCH /move/:id
    //   - Change team and/or domain
    //   - Logs team_changed / domain_changed as appropriate
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

                    const prevTeamId: string | undefined = ( workItem as any )
                        .teamId;
                    const prevDomain: TeamDomain | undefined = ( workItem as any )
                        .domain as TeamDomain;

                    let teamChanged = false;
                    let domainChanged = false;

                    if ( typeof body.teamId === "string" && body.teamId.trim() ) {
                        const newTeamId = body.teamId.trim();
                        if ( newTeamId !== prevTeamId ) {
                            ( workItem as any ).teamId = newTeamId;
                            teamChanged = true;
                        }
                    }

                    if ( body.teamMongoId ) {
                        const newTeamMongoId = this.parseObjectId(
                            body.teamMongoId,
                        );
                        if ( newTeamMongoId ) {
                            ( workItem as any ).teamMongoId = newTeamMongoId;
                        }
                    }

                    if ( typeof body.domain === "string" && body.domain.trim() ) {
                        const newDomain = body.domain.trim() as TeamDomain;
                        if ( newDomain !== prevDomain ) {
                            ( workItem as any ).domain = newDomain;
                            domainChanged = true;
                        }
                    }

                    if ( !teamChanged && !domainChanged ) {
                        ApiResponseBuilder.validationError(
                            res,
                            "No team/domain changes detected.",
                        );
                        return;
                    }

                    workItem.updatedAt = new Date().toISOString();
                    const saved = await workItem.save();

                    const baseParams = this.buildBaseEventParams(
                        saved,
                        req,
                    );

                    if ( teamChanged && prevTeamId ) {
                        void WorkEventService.logTeamChanged( {
                            ...baseParams,
                            fromTeamId: prevTeamId,
                            toTeamId: ( saved as any ).teamId,
                        } );
                    }

                    if ( domainChanged && prevDomain ) {
                        void WorkEventService.logDomainChanged( {
                            ...baseParams,
                            fromDomain: prevDomain,
                            toDomain: ( saved as any )
                                .domain as TeamDomain,
                        } );
                    }

                    ApiResponseBuilder.ok(
                        res,
                        "workItem",
                        saved,
                        "Work item team/domain updated successfully.",
                    );
                    return;
                } catch ( error ) {
                    console.error(
                        "[WorkItemApi] Error during work item move:\n",
                        error,
                    );
                    ApiResponseBuilder.internalError( res, error );
                    return;
                }
            },
        );
    }

    // ========================================================================
    // POST /:id/evidence
    //   - Append evidence metadata to work item
    //   - Logs evidence_added with count
    // ========================================================================

    private registerAddEvidence(): void {
        this.router.post(
            "/:id/evidence",
            async ( req: RequestWithActor, res: Response ): Promise<void> => {
                try {
                    const loaded = await this.loadWorkItemOrFail( req, res );
                    if ( !loaded ) return;
                    const { workItem } = loaded;

                    const evidences = req.body?.evidences as EvidenceEntry[] | undefined;

                    if ( !Array.isArray( evidences ) || evidences.length === 0 ) {
                        ApiResponseBuilder.validationError(
                            res,
                            "At least one evidence entry is required.",
                        );
                        return;
                    }

                    const nowIso = new Date().toISOString();

                    const normalized: EvidenceEntry[] = evidences.map( ( e ) => {
                        const entry: EvidenceEntry = {
                            id:
                                e.id ??
                                `EVI-${ Date.now() }-${ Math.random()
                                    .toString( 36 )
                                    .slice( 2, 8 ) }`,
                            name: e.name ?? "evidence",
                            addedAt: e.addedAt ?? nowIso,
                        };

                        // Only assign optional props when they actually exist
                        if ( typeof e.storageKey === "string" && e.storageKey.trim() !== "" ) {
                            entry.storageKey = e.storageKey;
                        }

                        if ( typeof e.url === "string" && e.url.trim() !== "" ) {
                            entry.url = e.url;
                        }

                        return entry;
                    } );


                    if ( !Array.isArray( ( workItem as any ).evidence ) ) {
                        ( workItem as any ).evidence = [];
                    }

                    ( workItem as any ).evidence.push( ...normalized );

                    workItem.updatedAt = nowIso;
                    const saved = await workItem.save();

                    const baseParams = this.buildBaseEventParams(
                        saved,
                        req,
                    );
                    void WorkEventService.logEvidenceAdded( {
                        ...baseParams,
                        evidenceCountAdded: normalized.length,
                    } );

                    ApiResponseBuilder.ok(
                        res,
                        "workItem",
                        saved,
                        "Evidence added to work item successfully.",
                    );
                    return;
                } catch ( error ) {
                    console.error(
                        "[WorkItemApi] Error while adding evidence:\n",
                        error,
                    );
                    ApiResponseBuilder.internalError( res, error );
                    return;
                }
            },
        );
    }

    // ========================================================================
    // POST /:id/comment
    //   - Append comment object to work item
    //   - Logs comment_added with id + preview
    // ========================================================================

    private registerAddComment(): void {
        this.router.post(
            "/:id/comment",
            async ( req: RequestWithActor, res: Response ): Promise<void> => {
                try {
                    const loaded = await this.loadWorkItemOrFail( req, res );
                    if ( !loaded ) return;
                    const { workItem } = loaded;

                    const textRaw = String( req.body?.text ?? "" ).trim();
                    if ( !textRaw ) {
                        ApiResponseBuilder.validationError(
                            res,
                            "Comment text is required.",
                        );
                        return;
                    }

                    const actor = this.buildActorFromRequest( req );
                    const nowIso = new Date().toISOString();

                    const createdBy: CommentEntry[ "createdBy" ] = {};

                    if ( actor.userId ) {
                        // actor.userId can be ObjectId | string | null → normalize to string
                        createdBy.userId = String( actor.userId );
                    }

                    if ( actor.username ) {
                        createdBy.username = actor.username;
                    }

                    const comment: CommentEntry = {
                        id: `CMT-${ Date.now() }-${ Math.random()
                            .toString( 36 )
                            .slice( 2, 8 ) }`,
                        text: textRaw,
                        createdAt: nowIso,
                    };

                    // Only attach createdBy if we actually have something
                    if ( createdBy.userId || createdBy.username ) {
                        comment.createdBy = createdBy;
                    }


                    if ( !Array.isArray( ( workItem as any ).comments ) ) {
                        ( workItem as any ).comments = [];
                    }
                    ( workItem as any ).comments.push( comment );

                    workItem.updatedAt = nowIso;
                    const saved = await workItem.save();

                    const baseParams = this.buildBaseEventParams(
                        saved,
                        req,
                    );

                    const preview =
                        textRaw.length > 80
                            ? `${ textRaw.slice( 0, 77 ) }...`
                            : textRaw;

                    void WorkEventService.logCommentAdded( {
                        ...baseParams,
                        commentId: comment.id,
                        commentPreview: preview,
                    } );

                    ApiResponseBuilder.ok(
                        res,
                        "workItem",
                        saved,
                        "Comment added to work item successfully.",
                    );
                    return;
                } catch ( error ) {
                    console.error(
                        "[WorkItemApi] Error while adding comment:\n",
                        error,
                    );
                    ApiResponseBuilder.internalError( res, error );
                    return;
                }
            },
        );
    }

    // ========================================================================
    // GET /:id/events
    //   - Timeline for a given work item
    //   - Optional filters: kind, fromDate, toDate
    // ========================================================================

    private registerGetWorkItemEvents(): void {
        this.router.get(
            "/:id/events",
            async ( req: Request, res: Response ): Promise<void> => {
                try {
                    const id = String( req.params.id ?? "" ).trim();
                    if ( !id ) {
                        ApiResponseBuilder.validationError(
                            res,
                            "Work item ID is required.",
                        );
                        return;
                    }

                    const { index, limit, skip } = this.parsePagination(
                        req,
                        20,
                    );

                    const kindRaw = req.query.kind;
                    const fromRaw = req.query.from;
                    const toRaw = req.query.to;

                    const filter: FilterQuery<IWorkEvent> = {
                        workItemId: id,
                    };

                    if ( typeof kindRaw === "string" && kindRaw.trim() ) {
                        filter.kind = kindRaw.trim() as WorkEventKind;
                    }

                    if (
                        ( typeof fromRaw === "string" && fromRaw.trim() ) ||
                        ( typeof toRaw === "string" && toRaw.trim() )
                    ) {
                        const createdAtFilter: Record<string, unknown> = {};

                        if ( typeof fromRaw === "string" && fromRaw.trim() ) {
                            const fromDate = new Date( fromRaw );
                            if ( !Number.isNaN( fromDate.getTime() ) ) {
                                createdAtFilter.$gte = fromDate.toISOString();
                            }
                        }

                        if ( typeof toRaw === "string" && toRaw.trim() ) {
                            const toDate = new Date( toRaw );
                            if ( !Number.isNaN( toDate.getTime() ) ) {
                                createdAtFilter.$lte = toDate.toISOString();
                            }
                        }

                        if ( Object.keys( createdAtFilter ).length > 0 ) {
                            filter.createdAt = createdAtFilter as any;
                        }
                    }

                    const [ total, events ] = await Promise.all( [
                        WorkEventModel.countDocuments( filter ).exec(),
                        WorkEventModel.find( filter )
                            .sort( { createdAt: -1 } )
                            .skip( skip )
                            .limit( limit )
                            .exec(),
                    ] );

                    const pagination = {
                        index,
                        limit,
                        total,
                    };

                    ApiResponseBuilder.ok(
                        res,
                        "events",
                        events,
                        "Work item events fetched successfully.",
                        { pagination },
                    );
                    return;
                } catch ( error ) {
                    console.error(
                        "[WorkItemApi] Error while fetching work item events:\n",
                        error,
                    );
                    ApiResponseBuilder.internalError( res, error );
                    return;
                }
            },
        );
    }
}
