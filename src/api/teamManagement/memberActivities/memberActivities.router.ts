// Path: src/api/teamManagement/memberActivities/memberActivities.router.ts
// ============================================================================
// MemberActivities Router (class-based) — mounts MemberActivitiesController
// ----------------------------------------------------------------------------
// ✅ PURPOSE
// - Pure routing layer (no business logic)
// - Ensures uploadMiddleware runs BEFORE evidence endpoints (TEMP -> FINAL flow)
// - Keeps stable, explicit routes for GuardRoutesMapSource and FE integration
//
// ✅ IMPORTANT
// - Constructor MUST NOT accept parameters
// - Class-based only
// - Evidence routes MUST mount UploadMiddleware first
// ============================================================================

import express, { type Router } from "express";
import { MemberActivitiesControllerExport } from "../../../controller/teamManagement/memberActivities/memberActivities.controller";

export default class MemberActivitiesRouter {
  private readonly router: Router;

  public constructor() {
    this.router = express.Router();

    // ------------------------------------------------------------------------
    // READ (static routes before "/:activityId")
    // ------------------------------------------------------------------------
    this.router.get("/list", MemberActivitiesControllerExport.List);
    this.router.get("/count", MemberActivitiesControllerExport.Count);
    this.router.get("/:activityId", MemberActivitiesControllerExport.GetById);

    // ------------------------------------------------------------------------
    // CREATE / UPDATE / DELETE
    // ------------------------------------------------------------------------
    this.router.post("/create", MemberActivitiesControllerExport.Create);
    this.router.patch("/:activityId", MemberActivitiesControllerExport.UpdateById);
    this.router.delete("/:activityId", MemberActivitiesControllerExport.DeleteById);

    // ------------------------------------------------------------------------
    // EVIDENCE (TEMP -> FINAL)
    // - uploadMiddleware must run BEFORE append/replace (needs req upload bag)
    // - removeEvidence does not require uploads
    // ------------------------------------------------------------------------
    this.router.post(
      "/:activityId/evidence/append",
      MemberActivitiesControllerExport.UploadMiddleware,
      MemberActivitiesControllerExport.AppendEvidence
    );

    this.router.patch(
      "/:activityId/evidence/replace",
      MemberActivitiesControllerExport.UploadMiddleware,
      MemberActivitiesControllerExport.ReplaceEvidence
    );

    this.router.patch(
      "/:activityId/evidence/remove",
      MemberActivitiesControllerExport.RemoveEvidence
    );

    // ------------------------------------------------------------------------
    // BLOCKERS
    // ------------------------------------------------------------------------
    this.router.post("/:activityId/blockers/append", MemberActivitiesControllerExport.AppendBlocker);
    this.router.patch("/:activityId/blockers/update", MemberActivitiesControllerExport.UpdateBlocker);
    this.router.patch("/:activityId/blockers/resolve", MemberActivitiesControllerExport.ResolveBlocker);
    this.router.patch("/:activityId/blockers/remove", MemberActivitiesControllerExport.RemoveBlocker);
  }

  public get route(): Router {
    return this.router;
  }
}
