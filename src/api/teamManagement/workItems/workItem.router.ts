// Path: src/api/teamManagement/workItem.router.ts
// ============================================================================
// WorkItem Router (class-based) — mounts WorkItemController endpoints
// ----------------------------------------------------------------------------
// ✅ PURPOSE
// - Pure routing layer (NO business logic here)
// - Ensures uploadMiddleware runs BEFORE create/update (TEMP -> FINAL flow)
// - Keeps route patterns stable for GuardRoutesMapSource and FE integration
//
// ✅ NOTES (your project rules)
// - Constructor MUST NOT accept parameters
// - Class-based only
// - Use WorkItemControllerExport handlers (single source of truth)
// ============================================================================

import express, { type Router } from "express";
import { WorkItemControllerExport } from "../../../controllers/teamManagement/workItems/workItem.controller";

export default class WorkItemRouter {
  private readonly router: Router;

  public constructor() {
    this.router = express.Router();

    // ----------------------------
    // READ
    // ----------------------------
    // Keep "static" routes before "/:workItemId" to avoid collisions.
    this.router.get("/list", WorkItemControllerExport.List);
    this.router.get("/count", WorkItemControllerExport.Count);
    this.router.get("/:workItemId", WorkItemControllerExport.GetById);

    // ----------------------------
    // CREATE (with upload middleware)
    // ----------------------------
    // Upload must run before create so controller can finalize TEMP -> FINAL.
    this.router.post(
      "/create",
      WorkItemControllerExport.UploadMiddleware,
      WorkItemControllerExport.Create
    );

    // ----------------------------
    // UPDATE / DELETE (with upload middleware on update)
    // ----------------------------
    this.router.patch(
      "/:workItemId",
      WorkItemControllerExport.UploadMiddleware,
      WorkItemControllerExport.UpdateById
    );

    this.router.delete("/:workItemId", WorkItemControllerExport.DeleteById);

    // ----------------------------
    // ATOMIC OPS
    // ----------------------------
    this.router.patch("/:workItemId/status", WorkItemControllerExport.SetStatus);
    this.router.patch("/:workItemId/priority", WorkItemControllerExport.SetPriority);
    this.router.patch("/:workItemId/due-at", WorkItemControllerExport.SetDueAt);
    this.router.patch("/:workItemId/assigned-members", WorkItemControllerExport.SetAssignedMembers);

    // ----------------------------
    // MEMBER ACTIVITY
    // ----------------------------
    this.router.post("/:workItemId/activity", WorkItemControllerExport.AppendActivity);
  }

  public get route(): Router {
    return this.router;
  }
}
