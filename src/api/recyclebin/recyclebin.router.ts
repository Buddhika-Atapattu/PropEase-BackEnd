// Path: src/api/recyclebin/recyclebin.router.ts
// =============================================================================
// RecycleBin Router (Phase 3.1) — FIXED + ALIGNED
// -----------------------------------------------------------------------------
// FIXES:
// 1) ✅ Correct controller import path (your file lives under src/controllers/...)
// 2) ✅ Removed non-existing endpoint: ctrl.markRestored (engine/controller no longer has it)
// 3) ✅ Added REAL restore endpoint: POST /:entryId/restore
// 4) ✅ Kept safe route ordering (static before params, deeper params before shallow)
// 5) ✅ No constructor params (your rule)
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
    // 01) List / Count
    // -------------------------------------------------------------------------
    this.router.get("/list", this.ctrl.list);
    this.router.get("/count", this.ctrl.count);

    // -------------------------------------------------------------------------
    // 02) Snapshot (specific param route)
    // -------------------------------------------------------------------------
    this.router.get("/:entryId/snapshot", this.ctrl.readSnapshot);
 
    // -------------------------------------------------------------------------
    // 03) Restore flow
    // - prepare: UI confirmation preview
    // - restore : REAL restore (DB + files) => marks restored in engine
    // -------------------------------------------------------------------------
    this.router.post("/:entryId/restore/prepare", this.ctrl.prepareRestore);
    this.router.post( "/:entryId/restore", this.ctrl.restore );

    // -------------------------------------------------------------------------
    // 04) Purge (permanent delete)
    // -------------------------------------------------------------------------
    this.router.delete("/:entryId/purge", this.ctrl.purge);
  }
}

// ✅ Common export style used across PropEase routers
export const RecycleBinRoutes = new RecycleBinRouter().router;