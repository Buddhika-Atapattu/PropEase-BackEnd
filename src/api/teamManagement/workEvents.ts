// Path: src/api/teamManagement/workEvents.ts
// ============================================================================
// Work Event API (class-based, read-only)
// ----------------------------------------------------------------------------
// Responsibilities:
//   - Query / filter the WorkEvent timeline.
//   - Typical filters: workItemId, teamId, domain, kind, actor, date range.
//   - Simple stats (counts by kind) per work item.
//   - NO direct creation here – writes must go through WorkEventService.
// ============================================================================

import express, { Request, Response, Router } from "express";
import { FilterQuery } from "mongoose";

import {
  IWorkEvent,
  WorkEventModel,
  WorkEventKind,
} from "../../models/teamManagement/workEvent.model";
import {
  WorkItemPriority,
  WorkItemStatus,
} from "../../models/teamManagement/workItem.model";
import {
  TeamDomain,
} from "../../models/teamManagement/teamManagement.model";

import { ApiResponseBuilder } from "../../utils/api-combiner.builder";

// Optional: narrow what we expose back to FE (avoid leaking internal fields).
// Here we simply reuse IWorkEvent documents as returned by Mongoose.

export default class WorkEventApi {
  private readonly router: Router;

  public constructor() {
    this.router = express.Router();

    // List / filter all events
    this.registerGetAllEvents();             // GET /all

    // Per-work-item timeline
    this.registerGetEventsByWorkItem();      // GET /by-workitem/:workItemId

    // Per-team timeline
    this.registerGetEventsByTeam();          // GET /by-team/:teamId

    // Simple stats per work item
    this.registerGetWorkItemEventStats();    // GET /stats/workitem/:workItemId
  }

  public get route(): Router {
    return this.router;
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  private parsePagination(
    req: Request,
    fallbackLimit: number = 20,
  ): { index: number; limit: number; skip: number } {
    const indexRaw = req.query.index;
    const limitRaw = req.query.limit;

    const indexNum = Number(indexRaw);
    const limitNum = Number(limitRaw);

    const index: number =
      Number.isFinite(indexNum) && indexNum >= 0 ? indexNum : 0;

    const limit: number =
      Number.isFinite(limitNum) && limitNum > 0 ? limitNum : fallbackLimit;

    const skip: number = index * limit;

    return { index, limit, skip };
  }

  /**
   * Parse from/to query params into an ISO string range for createdAt.
   */
  private parseCreatedAtRange(req: Request): Record<string, string> | undefined {
    const fromRaw = req.query.from;
    const toRaw = req.query.to;

    const range: Record<string, string> = {};

    if (typeof fromRaw === "string" && fromRaw.trim()) {
      const d = new Date(fromRaw);
      if (!Number.isNaN(d.getTime())) {
        range.$gte = d.toISOString();
      }
    }

    if (typeof toRaw === "string" && toRaw.trim()) {
      const d = new Date(toRaw);
      if (!Number.isNaN(d.getTime())) {
        range.$lte = d.toISOString();
      }
    }

    return Object.keys(range).length > 0 ? range : undefined;
  }

  // ==========================================================================
  // GET /all
  //   ?index=&limit=&workItemId=&teamId=&domain=&kind=&actor=&status=&priority=&from=&to=
  // ==========================================================================

  private registerGetAllEvents(): void {
    this.router.get(
      "/all",
      async (req: Request, res: Response): Promise<void> => {
        try {
          const { index, limit, skip } = this.parsePagination(
            req,
            20,
          );

          const filter: FilterQuery<IWorkEvent> = {};

          // workItemId filter (string, matches what WorkEventService stores)
          if (typeof req.query.workItemId === "string" && req.query.workItemId.trim()) {
            filter.workItemId = req.query.workItemId.trim();
          }

          // teamId filter (string)
          if (typeof req.query.teamId === "string" && req.query.teamId.trim()) {
            filter.teamId = req.query.teamId.trim();
          }

          // domain filter
          if (typeof req.query.domain === "string" && req.query.domain.trim()) {
            filter.domain = req.query.domain.trim() as TeamDomain;
          }

          // kind filter
          if (typeof req.query.kind === "string" && req.query.kind.trim()) {
            filter.kind = req.query.kind.trim() as WorkEventKind;
          }

          // actorUsername filter (partial match)
          if (
            typeof req.query.actor === "string" &&
            req.query.actor.trim()
          ) {
            const rx = new RegExp(req.query.actor.trim(), "i");
            filter.actorUsername = { $regex: rx };
          }

          // status-related filters (for status_changed events)
          if (typeof req.query.toStatus === "string" && req.query.toStatus.trim()) {
            filter.toStatus = req.query.toStatus.trim() as WorkItemStatus;
          }
          if (typeof req.query.fromStatus === "string" && req.query.fromStatus.trim()) {
            filter.fromStatus = req.query.fromStatus.trim() as WorkItemStatus;
          }

          // priority-related filters (for priority_changed events)
          if (typeof req.query.toPriority === "string" && req.query.toPriority.trim()) {
            filter.toPriority = req.query.toPriority.trim() as WorkItemPriority;
          }
          if (typeof req.query.fromPriority === "string" && req.query.fromPriority.trim()) {
            filter.fromPriority = req.query.fromPriority.trim() as WorkItemPriority;
          }

          // createdAt date range
          const createdAtRange = this.parseCreatedAtRange(req);
          if (createdAtRange) {
            filter.createdAt = createdAtRange as any;
          }

          const [total, rows] = await Promise.all([
            WorkEventModel.countDocuments(filter).exec(),
            WorkEventModel.find(filter)
              .sort({ createdAt: -1 })
              .skip(skip)
              .limit(limit)
              .exec(),
          ]);

          const pagination = {
            index,
            limit,
            total,
          };

          ApiResponseBuilder.ok(
            res,
            "events",
            rows,
            "Work events fetched successfully.",
            { pagination },
          );
          return;
        } catch (error) {
          console.error("[WorkEventApi] Error while fetching events /all:\n", error);
          ApiResponseBuilder.internalError(res, error);
          return;
        }
      },
    );
  }

  // ==========================================================================
  // GET /by-workitem/:workItemId
  //   ?index=&limit=&kind=&from=&to=
  // ==========================================================================

  private registerGetEventsByWorkItem(): void {
    this.router.get(
      "/by-workitem/:workItemId",
      async (req: Request, res: Response): Promise<void> => {
        try {
          const workItemId = String(req.params.workItemId ?? "").trim();
          if (!workItemId) {
            ApiResponseBuilder.validationError(
              res,
              "workItemId path param is required.",
            );
            return;
          }

          const { index, limit, skip } = this.parsePagination(
            req,
            20,
          );

          const filter: FilterQuery<IWorkEvent> = {
            workItemId,
          };

          if (typeof req.query.kind === "string" && req.query.kind.trim()) {
            filter.kind = req.query.kind.trim() as WorkEventKind;
          }

          const createdAtRange = this.parseCreatedAtRange(req);
          if (createdAtRange) {
            filter.createdAt = createdAtRange as any;
          }

          const [total, rows] = await Promise.all([
            WorkEventModel.countDocuments(filter).exec(),
            WorkEventModel.find(filter)
              .sort({ createdAt: -1 })
              .skip(skip)
              .limit(limit)
              .exec(),
          ]);

          const pagination = {
            index,
            limit,
            total,
          };

          ApiResponseBuilder.ok(
            res,
            "events",
            rows,
            "Work events for work item fetched successfully.",
            { pagination, other: { workItemId } },
          );
          return;
        } catch (error) {
          console.error("[WorkEventApi] Error while fetching events by work item:\n", error);
          ApiResponseBuilder.internalError(res, error);
          return;
        }
      },
    );
  }

  // ==========================================================================
  // GET /by-team/:teamId
  //   ?index=&limit=&domain=&kind=&from=&to=
  // ==========================================================================

  private registerGetEventsByTeam(): void {
    this.router.get(
      "/by-team/:teamId",
      async (req: Request, res: Response): Promise<void> => {
        try {
          const teamId = String(req.params.teamId ?? "").trim();
          if (!teamId) {
            ApiResponseBuilder.validationError(
              res,
              "teamId path param is required.",
            );
            return;
          }

          const { index, limit, skip } = this.parsePagination(
            req,
            20,
          );

          const filter: FilterQuery<IWorkEvent> = {
            teamId,
          };

          if (typeof req.query.domain === "string" && req.query.domain.trim()) {
            filter.domain = req.query.domain.trim() as TeamDomain;
          }

          if (typeof req.query.kind === "string" && req.query.kind.trim()) {
            filter.kind = req.query.kind.trim() as WorkEventKind;
          }

          const createdAtRange = this.parseCreatedAtRange(req);
          if (createdAtRange) {
            filter.createdAt = createdAtRange as any;
          }

          const [total, rows] = await Promise.all([
            WorkEventModel.countDocuments(filter).exec(),
            WorkEventModel.find(filter)
              .sort({ createdAt: -1 })
              .skip(skip)
              .limit(limit)
              .exec(),
          ]);

          const pagination = {
            index,
            limit,
            total,
          };

          ApiResponseBuilder.ok(
            res,
            "events",
            rows,
            "Work events for team fetched successfully.",
            { pagination, other: { teamId } },
          );
          return;
        } catch (error) {
          console.error("[WorkEventApi] Error while fetching events by team:\n", error);
          ApiResponseBuilder.internalError(res, error);
          return;
        }
      },
    );
  }

  // ==========================================================================
  // GET /stats/workitem/:workItemId
  //   → Simple counts by event kind for a work item
  // ==========================================================================

  private registerGetWorkItemEventStats(): void {
    this.router.get(
      "/stats/workitem/:workItemId",
      async (req: Request, res: Response): Promise<void> => {
        try {
          const workItemId = String(req.params.workItemId ?? "").trim();
          if (!workItemId) {
            ApiResponseBuilder.validationError(
              res,
              "workItemId path param is required.",
            );
            return;
          }

          const match: FilterQuery<IWorkEvent> = { workItemId };

          const pipeline = [
            { $match: match },
            {
              $group: {
                _id: "$kind",
                count: { $sum: 1 },
              },
            },
          ];

          const rows: Array<{ _id: WorkEventKind; count: number }> =
            await WorkEventModel.aggregate(pipeline).exec();

          const byKind: Record<WorkEventKind, number> = {} as Record<
            WorkEventKind,
            number
          >;

          for (const row of rows) {
            byKind[row._id] = row.count;
          }

          ApiResponseBuilder.ok(
            res,
            "other",
            { workItemId, byKind },
            "Work event stats by kind fetched successfully.",
          );
          return;
        } catch (error) {
          console.error("[WorkEventApi] Error while fetching work item event stats:\n", error);
          ApiResponseBuilder.internalError(res, error);
          return;
        }
      },
    );
  }
}
