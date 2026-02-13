// Path: src/api/teamManagement/milestones/milestones.router.ts
// ============================================================================
// Milestones Router (class-based) — mounts MilestonesController 1:1
// ----------------------------------------------------------------------------
// ✅ PURPOSE
// - Routing only (no business logic)
// - Keeps route ordering stable (static routes before "/:id")
// - Matches controller method names and response keys
//
// ✅ IMPORTANT (your rules)
// - Constructor MUST NOT accept parameters
// - Class-only (no exported helper functions)
// ============================================================================

import express, { type Router } from "express";
import { MilestonesController } from "../../../controller/teamManagement/milestones/milestones.controller";

export default class MilestonesRouter {
  private readonly router: Router;
  private readonly ctrl: MilestonesController;

  public constructor() {
    this.router = express.Router();
    this.ctrl = new MilestonesController();

    // ------------------------------------------------------------------------
    // READ (static routes before "/:id")
    // ------------------------------------------------------------------------
    this.router.get("/list", this.ctrl.list);
    this.router.get("/count", this.ctrl.count);
    this.router.get("/:id", this.ctrl.getById);

    // ------------------------------------------------------------------------
    // CREATE / UPDATE / DELETE
    // ------------------------------------------------------------------------
    this.router.post("/create", this.ctrl.create);
    this.router.patch("/:id", this.ctrl.updateById);
    this.router.delete("/:id", this.ctrl.deleteById);

    // ------------------------------------------------------------------------
    // EVIDENCE (pure JSON evidence array — no uploads in this controller)
    // ------------------------------------------------------------------------
    this.router.patch("/:id/evidence/append", this.ctrl.appendEvidence);
    this.router.patch("/:id/evidence/remove", this.ctrl.removeEvidence);
    this.router.patch("/:id/evidence/replace", this.ctrl.replaceEvidence);

    // ------------------------------------------------------------------------
    // TAGS
    // ------------------------------------------------------------------------
    this.router.patch("/:id/tags/append", this.ctrl.appendTag);
    this.router.patch("/:id/tags/remove", this.ctrl.removeTag);
    this.router.patch("/:id/tags/replace", this.ctrl.replaceTags);
  }

  public get route(): Router {
    return this.router;
  }
}
