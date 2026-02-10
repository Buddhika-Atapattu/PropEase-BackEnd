// Path: src/api/teamManagement/teamTask.router.ts
// ============================================================================
// TeamTaskRouter (class-based)
// ----------------------------------------------------------------------------
// ✅ Wires TeamTaskController endpoints (thin router)
// ✅ Ensures uploadMiddleware runs BEFORE create/update
// ✅ Keeps route naming consistent (get/list/count + CRUD + interactive ops)
// ----------------------------------------------------------------------------
// Mount example (routes.bootstrap.ts):
//   app.use("/api-team-management/task", new TeamTaskRouter().route);
// ============================================================================

import express, { type Router } from "express";
import { TeamTaskController } from "../../controller/teamManagement/teamTasks/teamTask.controller";

export default class TeamTaskRouter {
  private readonly router: Router;
  private readonly ctrl: TeamTaskController;

  public constructor () {
    this.router = express.Router();
    this.ctrl = new TeamTaskController();

    this.registerRoutes();
  }

  public get route(): Router {
    return this.router;
  }

  // ==========================================================================
  // Route map
  // ==========================================================================

  private registerRoutes(): void {
  // ------------------------------------------------------------------------
  // READ
  // ------------------------------------------------------------------------

    // GET /get/:taskMongoId?mode=minimal|advanced
    this.router.get( "/get/:taskMongoId", this.ctrl.getByMongoId );

    // POST /list   body: { mode, filters, page, sort }
    this.router.post( "/list", this.ctrl.list );

    // POST /count  body: { filters }
    this.router.post( "/count", this.ctrl.count );

    // POST /key-values body: { teamCode?, teamMongoId?, domain?, status? }
    this.router.post( "/key-values", this.ctrl.keyValues );

    // ------------------------------------------------------------------------
    // WRITE (multipart supported)
    // ------------------------------------------------------------------------

    // POST /create  (multipart)
    // IMPORTANT: uploadMiddleware MUST run before create
    this.router.post( "/create", this.ctrl.uploadMiddleware, this.ctrl.create );

    // PATCH /update/:taskMongoId  (multipart)
    // IMPORTANT: uploadMiddleware MUST run before update
    this.router.patch( "/update/:taskMongoId", this.ctrl.uploadMiddleware, this.ctrl.update );

    // DELETE /delete/:taskMongoId
    this.router.delete( "/delete/:taskMongoId", this.ctrl.remove );

    // ------------------------------------------------------------------------
    // Evidence
    // ------------------------------------------------------------------------

    // DELETE /evidence/:taskMongoId/:evidenceMongoId
    // NOTE:
    // - Your evidence schema is `_id:false`, so `evidenceMongoId` cannot be a real subdoc ObjectId.
    // - Treat this param as a "storageKey" (recommended) OR change evidence schema to `_id:true`.
    this.router.delete( "/evidence/:taskMongoId/:evidenceMongoId", this.ctrl.removeEvidenceById );

    // ------------------------------------------------------------------------
    // Status / Priority
    // ------------------------------------------------------------------------

    // PATCH /status/:taskMongoId  body: { status }
    this.router.patch( "/status/:taskMongoId", this.ctrl.setStatus );

    // PATCH /priority/:taskMongoId body: { priority }
    this.router.patch( "/priority/:taskMongoId", this.ctrl.setPriority );

    // ------------------------------------------------------------------------
    // Labels
    // ------------------------------------------------------------------------

    // PATCH /labels/set/:taskMongoId    body: { labels }
    this.router.patch( "/labels/set/:taskMongoId", this.ctrl.setLabels );

    // PATCH /labels/add/:taskMongoId    body: { labels }
    this.router.patch( "/labels/add/:taskMongoId", this.ctrl.addLabels );

    // PATCH /labels/remove/:taskMongoId body: { labels }
    this.router.patch( "/labels/remove/:taskMongoId", this.ctrl.removeLabels );

    // ------------------------------------------------------------------------
    // Assigned members + captain
    // ------------------------------------------------------------------------

    // PATCH /members/set/:taskMongoId    body: { memberIds }
    this.router.patch( "/members/set/:taskMongoId", this.ctrl.setAssignedMembers );

    // PATCH /members/add/:taskMongoId    body: { memberIds }
    this.router.patch( "/members/add/:taskMongoId", this.ctrl.addAssignedMembers );

    // PATCH /members/remove/:taskMongoId body: { memberIds }
    this.router.patch( "/members/remove/:taskMongoId", this.ctrl.removeAssignedMembers );

    // PATCH /captain/:taskMongoId body: { captainUserId }  (accepts "null" to clear)
    this.router.patch( "/captain/:taskMongoId", this.ctrl.setCaptain );

    // ------------------------------------------------------------------------
    // Location / Address / Notes
    // ------------------------------------------------------------------------

    // PATCH /location/:taskMongoId body: { location } (object or "null")
    this.router.patch( "/location/:taskMongoId", this.ctrl.setLocation );

    // PATCH /address/:taskMongoId body: { address } (object or "null")
    this.router.patch( "/address/:taskMongoId", this.ctrl.setAddress );

    // PATCH /notes/:taskMongoId body: { notes } (string or "null")
    this.router.patch( "/notes/:taskMongoId", this.ctrl.setNotes );

    // ------------------------------------------------------------------------
    // Audit CRUD
    // ------------------------------------------------------------------------

    // GET /audit/:taskMongoId
    this.router.get( "/audit/:taskMongoId", this.ctrl.getAudit );

    // PATCH /audit/set/:taskMongoId   body: { audit } (object or "null")
    this.router.patch( "/audit/set/:taskMongoId", this.ctrl.setAudit );

    // PATCH /audit/patch/:taskMongoId body: { patch }
    this.router.patch( "/audit/patch/:taskMongoId", this.ctrl.patchAudit );

    // PATCH /audit/clear/:taskMongoId
    this.router.patch( "/audit/clear/:taskMongoId", this.ctrl.clearAudit );

    // ------------------------------------------------------------------------
    // Timing CRUD
    // ------------------------------------------------------------------------

    // GET /timing/:taskMongoId
    this.router.get( "/timing/:taskMongoId", this.ctrl.getTiming );

    // PATCH /timing/set/:taskMongoId   body: { timing } (object or "null")
    this.router.patch( "/timing/set/:taskMongoId", this.ctrl.setTiming );

    // PATCH /timing/patch/:taskMongoId body: { patch }
    this.router.patch( "/timing/patch/:taskMongoId", this.ctrl.patchTiming );

    // PATCH /timing/clear/:taskMongoId
    this.router.patch( "/timing/clear/:taskMongoId", this.ctrl.clearTiming );

    // ------------------------------------------------------------------------
    // SLA (legacy name) -> deadlinePolicy
    // ------------------------------------------------------------------------

    // PATCH /sla/:taskMongoId body: { sla } (object or "null")
    // NOTE: service maps this to deadlinePolicy (compat shim).
    this.router.patch( "/sla/:taskMongoId", this.ctrl.setSla );

    // ------------------------------------------------------------------------
    // Task Users
    // ------------------------------------------------------------------------

    // GET /users/usernames/:taskMongoId
    this.router.get( "/users/usernames/:taskMongoId", this.ctrl.getAssignedMemberUsernames );

    // POST /users/:taskMongoId body: { userId?, username? }
    this.router.post( "/users/:taskMongoId", this.ctrl.getTaskUsers );
  }
}
