// Path: src/api/recyclebin.router.ts
// =============================================================================
// RecycleBin Router (Phase 3.1)
// -----------------------------------------------------------------------------
// PURPOSE:
// - Mount RecycleBinController endpoints
// - Keep route ordering safe (specific routes before param routes)
// - No constructor parameters (project rule)
// =============================================================================

import { Router, type Router as ExpressRouter } from "express";

import { RecycleBinController } from "../../controllers/recyclebin/recyclebin.controller";

export default class RecycleBinRouter {
  public readonly router: ExpressRouter;

  private readonly ctrl: RecycleBinController;

  public constructor() {
    this.router = Router();
    this.ctrl = new RecycleBinController();
    this.buildRoutes();
  }

  private buildRoutes(): void {
    // -------------------------------------------------------------------------
    // List / Count
    // -------------------------------------------------------------------------
    this.router.get("/list", this.ctrl.list);
    this.router.get("/count", this.ctrl.count);

    // -------------------------------------------------------------------------
    // Snapshot
    // -------------------------------------------------------------------------
    this.router.get("/:entryId/snapshot", this.ctrl.readSnapshot);

    // -------------------------------------------------------------------------
    // Restore flow
    // -------------------------------------------------------------------------
    this.router.post("/:entryId/restore/prepare", this.ctrl.prepareRestore);
    this.router.post("/:entryId/restore/mark", this.ctrl.markRestored);

    // -------------------------------------------------------------------------
    // Purge (permanent delete)
    // -------------------------------------------------------------------------
    this.router.delete("/:entryId/purge", this.ctrl.purge);
  }
}

// ✅ Common export style used across PropEase routers
export const RecycleBinRoutes = new RecycleBinRouter().router;
