// Path: src/bootstrap/routes.bootstrap.ts
// ============================================================================
// RoutesBootstrap (Express Route Wiring) — PropEase
// ----------------------------------------------------------------------------
// ✅ PURPOSE
// - Central place to mount EVERY router/controller with the correct base paths.
// - Ensures `apiGuard` sees the same URL prefixes that GUARD_ROUTES patterns use.
// - Keeps the boot sequence stable and easy to audit.
//
// ✅ KEY RULES (your architecture)
// - All protected APIs must be mounted behind `apiGuard`.
// - “Public endpoints” are STILL mounted behind apiGuard, but apiGuard bypasses
//   them using PUBLIC_ENDPOINTS (so we keep consistent middleware order).
// - Mount order matters when a router has catch-all params (e.g. /:teamCode).
// - Add new routers here the moment you add a new API module.
//
// ✅ FIXES APPLIED (this version)
// - Fixed MilestonesRouter import path to match app-server.core.ts:
//   `millestones.router` (your current file name).
// - 404 handler now uses ApiResponseBuilder.error for consistency.
// - Kept router property usage consistent with your current codebase:
//   - Most routers expose `.route`
//   - Some expose `.router` (e.g., UploadsRoutes, PlacesController, NotificationHubRoute, RecycleBinRouter)
//   - CommentsEngineRouter is mounted via `.route` (as in your project).
// ============================================================================

import type {
  ErrorRequestHandler,
  Express,
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from "express";
import express from "express";
import path from "path";

import { NODE_ENV } from "../configs/env.config";

import type Database from "../configs/database";
import { apiGuard } from "../guard/api-router.guard";
import Guards from "../guard/fullAccess.guard";
import type { TypedNamespace } from "../socket/socket-types.type";

import { ApiResponseBuilder } from "../utils/api-combiner.builder";

// Controllers (class-based routers)
import type { AuthController } from "../controllers/auth.controller";
import type { MfaController } from "../controllers/mfa.controller";
import type NotificationHubRoute from "../api/notifications/notification-hub.router";
import type ReportController from "../controllers/report.controller";

// Routers (feature APIs)
import FileTransfer from "../api/fileTransfer.router";
import Lease from "../api/lease.router";
import { PlacesController } from "../api/PlacesController.router";
import Property from "../api/property.router";
import Tenant from "../api/tenant.router";
import Tracking from "../api/tracking.router";
import UploadsRoutes from "../api/uploads.router";
import UserRoute from "../api/user.router";
import Validator from "../api/validator.router";
import RecycleBinRouter from "../api/recyclebin/recyclebin.router";
import { PaymentRouter } from "../api/payment/payment.router";

// Team Management
import TeamKpiRouter from "../api/teamManagement/teamKpi.router";
import TeamManagementRouter from "../api/teamManagement/teamMain/teamManagement.router";
import TeamTaskRouter from "../api/teamManagement/teamTasks/teamTask.router";
import WorkEventApi from "../api/teamManagement/workEvents.router";
import WorkItemRouter from "../api/teamManagement/workItems/workItem.router";

// ✅ NEW (missing previously)
import MemberActivitiesRouter from "../api/teamManagement/memberActivities/memberActivities.router";
// IMPORTANT: match your current filename used in app-server.core.ts
import MilestonesRouter from "../api/teamManagement/milestones/millestones.router";

// Shared modules
import { CommentsEngineRouter } from "../api/shared/comments/comments-engine.router";

const isProd: boolean = NODE_ENV === "production";
const APP_TAG: string = "PropEase";

interface RoutesBootstrapDeps {
  app: Express;
  db: Database;
  io: TypedNamespace;

  // Controllers
  notification: NotificationHubRoute;
  reportController: ReportController;
  authController: AuthController;
  mfaController: MfaController;

  // Middlewares
  loginRateLimiter: RequestHandler;

  // Core routers
  uploadsRoutes: UploadsRoutes;
  user: UserRoute;
  tracking: Tracking;
  property: Property;
  placesController: PlacesController;
  tenant: Tenant;
  fileTransfer: FileTransfer;
  lease: Lease;
  validator: Validator;

  // Team routers
  teamManagement: TeamManagementRouter;
  teamTaskRouter: TeamTaskRouter;
  teamKpiRouter: TeamKpiRouter;
  workItemRouter: WorkItemRouter;
  workEventRouter: WorkEventApi;

  // ✅ NEW
  memberActivitiesRouter: MemberActivitiesRouter;
  milestonesRouter: MilestonesRouter;

  // Shared routers
  commentsEngineRouter: CommentsEngineRouter;
  recyclebin: RecycleBinRouter;
  payment: PaymentRouter;
}

export class RoutesBootstrap {
  private readonly app: Express;
  private readonly db: Database;
  private readonly io: TypedNamespace;

  private readonly notification: NotificationHubRoute;
  private readonly reportController: ReportController;
  private readonly authController: AuthController;
  private readonly mfaController: MfaController;
  private readonly loginRateLimiter: RequestHandler;

  private readonly uploadsRoutes: UploadsRoutes;
  private readonly user: UserRoute;
  private readonly tracking: Tracking;
  private readonly property: Property;
  private readonly placesController: PlacesController;
  private readonly tenant: Tenant;
  private readonly fileTransfer: FileTransfer;
  private readonly lease: Lease;
  private readonly validator: Validator;

  private readonly teamManagement: TeamManagementRouter;
  private readonly teamTaskRouter: TeamTaskRouter;
  private readonly teamKpiRouter: TeamKpiRouter;
  private readonly workItemRouter: WorkItemRouter;
  private readonly workEventRouter: WorkEventApi;

  private readonly memberActivitiesRouter: MemberActivitiesRouter;
  private readonly milestonesRouter: MilestonesRouter;

  private readonly commentsEngineRouter: CommentsEngineRouter;
  private readonly recycleBin: RecycleBinRouter;
  private readonly payment: PaymentRouter;

  public constructor ( deps: RoutesBootstrapDeps ) {
    this.app = deps.app;
    this.db = deps.db;
    this.io = deps.io;

    this.notification = deps.notification;
    this.reportController = deps.reportController;
    this.authController = deps.authController;
    this.mfaController = deps.mfaController;
    this.loginRateLimiter = deps.loginRateLimiter;

    this.uploadsRoutes = deps.uploadsRoutes;
    this.user = deps.user;
    this.tracking = deps.tracking;
    this.property = deps.property;
    this.placesController = deps.placesController;
    this.tenant = deps.tenant;
    this.fileTransfer = deps.fileTransfer;
    this.lease = deps.lease;
    this.validator = deps.validator;

    this.teamManagement = deps.teamManagement;
    this.teamTaskRouter = deps.teamTaskRouter;
    this.teamKpiRouter = deps.teamKpiRouter;
    this.workItemRouter = deps.workItemRouter;
    this.workEventRouter = deps.workEventRouter;

    this.memberActivitiesRouter = deps.memberActivitiesRouter;
    this.milestonesRouter = deps.milestonesRouter;

    this.commentsEngineRouter = deps.commentsEngineRouter;
    this.recycleBin = deps.recyclebin;
    this.payment = deps.payment;
  }

  // ===========================================================================
  // Public entry
  // ===========================================================================

  public registerAll(): void {
    this.registerDiagnostics();
    this.registerNotificationRoutes();
    this.registerHealthRoute();
    this.registerAdminsOnlyStatic();

    // Auth + MFA are mounted early because other routes may depend on them.
    this.registerAuthMfaRoutes();

    this.registerReportRoutes();
    this.registerApiRoutes();
    this.registerIndexPage();
  }

  /**
   * Register 404 handler + centralized error handler.
   * IMPORTANT: errorHandler MUST be an ErrorRequestHandler (4 args)
   * so Express recognizes it as an error middleware.
   */
  public registerNotFoundAndErrorHandlers( errorHandler: ErrorRequestHandler ): void {
    this.app.use( ( _req: Request, res: Response ) => {
      ApiResponseBuilder.error( res, 404, "Not Found" );
      return;
    } );

    this.app.use( errorHandler );
  }

  // ===========================================================================
  // Diagnostic endpoints (non-business)
  // ===========================================================================

  private registerDiagnostics(): void {
    this.app.get( "/api/diag", ( req: Request, res: Response ) => {
      const id: string = String( ( req as unknown as { reqId?: unknown; } ).reqId ?? "-" );

      const info = {
        reqId: id,
        method: req.method,
        url: req.originalUrl,
        origin: req.headers.origin || "-",
        hasAuthHeader: !!req.headers.authorization,
        cookieKeys: Object.keys( ( req as unknown as { cookies?: unknown; } ).cookies ?? {} ),
        headers: {
          "access-control-request-method": req.headers[ "access-control-request-method" ],
          "access-control-request-headers": req.headers[ "access-control-request-headers" ],
        },
        time: new Date().toISOString(),
      };

      if ( !isProd ) {
        // eslint-disable-next-line no-console
        console.log( `[${ APP_TAG }] [${ id }] /api/diag`, info );
      }

      res.json( info );
      return;
    } );
  }

  // ===========================================================================
  // Notifications
  // ===========================================================================

  private registerNotificationRoutes(): void {
    // Protected by apiGuard (RBAC mapping is in GUARD_ROUTES)
    this.app.use( "/api-notification", apiGuard, this.notification.router );
  }

  // ===========================================================================
  // Health / Ops
  // ===========================================================================

  private registerHealthRoute(): void {
    // Full-access only: intended for admin diagnostics / server monitoring.
    this.app.get(
      "/api/health",
      Guards.requireFullAccess(),
      async ( _req: Request, res: Response ) => {
        const dbOk: boolean =
          this.db.isConnected() && ( await this.db.ping().catch( () => false ) );

        res.json( {
          status: dbOk ? "ok" : "degraded",
          db: { connected: this.db.isConnected(), ping: dbOk },
          socket: { namespace: this.io.name || "/", connected: true },
          timestamp: Date.now(),
        } );
        return;
      },
    );
  }

  private registerAdminsOnlyStatic(): void {
    // NOTE: your project uses top-level "public/" for Electron compatibility.
    const adminsOnlyDir: string = path.join( process.cwd(), "public", "adminsOnly" );

    this.app.use(
      "/adminsOnly",
      Guards.requireFullAccess(),
      ( _req: Request, res: Response, next: NextFunction ) => {
        // Sensitive content -> no caching
        res.setHeader( "Cache-Control", "private, no-store, no-cache, must-revalidate" );
        res.setHeader( "Pragma", "no-cache" );
        res.setHeader( "Expires", "0" );
        next();
      },
      express.static( adminsOnlyDir, { fallthrough: false } ),
    );
  }

  // ===========================================================================
  // Auth + MFA
  // ===========================================================================

  private registerAuthMfaRoutes(): void {
    /**
     * Why apiGuard is present on /api/auth even though login is "public":
     * - apiGuard will bypass PUBLIC_ENDPOINTS like /api/auth/login
     * - This keeps the middleware order consistent everywhere
     * - And avoids future “forgot to guard mount” mistakes
     */
    this.app.use(
      "/api/auth",
      this.loginRateLimiter,
      apiGuard,
      this.authController.getRouter(),
    );

    this.app.use( "/api/mfa", apiGuard, this.mfaController.getRouter() );
  }

  // ===========================================================================
  // Reports
  // ===========================================================================

  private registerReportRoutes(): void {
    this.app.use( "/api-report", apiGuard, this.reportController.router );
  }

  // ===========================================================================
  // Business APIs (main)
  // ===========================================================================

  private registerApiRoutes(): void {
    // ─────────────────────────────────────────────────────────────────────────
    // Core / shared utilities
    // ─────────────────────────────────────────────────────────────────────────
    this.app.use( "/api-rich-text", apiGuard, this.uploadsRoutes.router );
    this.app.use( "/api-user", apiGuard, this.user.route );
    this.app.use( "/api-tracking", apiGuard, this.tracking.route );
    this.app.use( "/api-validator", apiGuard, this.validator.route );
    this.app.use( "/api-recyclebin", apiGuard, this.recycleBin.router );

    // ─────────────────────────────────────────────────────────────────────────
    // Property + Places
    // ─────────────────────────────────────────────────────────────────────────
    this.app.use( "/api-property", apiGuard, this.property.route );
    this.app.use( "/api-places", apiGuard, this.placesController.router );

    // ─────────────────────────────────────────────────────────────────────────
    // Tenant / Lease / File transfer / Payments
    // ─────────────────────────────────────────────────────────────────────────
    this.app.use( "/api-tenant", apiGuard, this.tenant.route );
    this.app.use( "/api-file-transfer", apiGuard, this.fileTransfer.route );
    this.app.use( "/api-lease", apiGuard, this.lease.route );

    // ─────────────────────────────────────────────────────────────────────────
    // Team Management (IMPORTANT ORDER)
    // ─────────────────────────────────────────────────────────────────────────
    this.app.use( "/api-team-management", apiGuard, this.teamManagement.route );
    this.app.use( "/api-team-management/task", apiGuard, this.teamTaskRouter.route );
    this.app.use( "/api-team-management/kpi", apiGuard, this.teamKpiRouter.route );
    //

    this.app.use(
      "/api-team-management/member-activities",
      apiGuard,
      this.memberActivitiesRouter.route,
    );

    this.app.use(
      "/api-team-management/milestones",
      apiGuard,
      this.milestonesRouter.route,
    );

    this.app.use( "/api-work-item", apiGuard, this.workItemRouter.route );
    this.app.use( "/api-work-event", apiGuard, this.workEventRouter.route );

    // ─────────────────────────────────────────────────────────────────────────
    // Comments Engine
    // ─────────────────────────────────────────────────────────────────────────
    this.app.use( "/api-comments", apiGuard, this.commentsEngineRouter.route );

    // ─────────────────────────────────────────────────────────────────────────
    // Payments
    // ─────────────────────────────────────────────────────────────────────────
    this.app.use( "/api-payments", apiGuard, this.payment.router );
  }

  // ===========================================================================
  // UI index (server-served file)
  // ===========================================================================

  private registerIndexPage(): void {
    this.app.get( "/", ( _req: Request, res: Response ) => {
      res.sendFile( path.join( process.cwd(), "public", "index.html" ), ( err: Error | null ) => {
        if ( err ) {
          // eslint-disable-next-line no-console
          console.error( "[Error:] [RoutesBootstrap] index.html sendFile:\n", err, "\n" );
          res.status( 500 ).send( "Internal Server Error" );
        }
      } );
    } );
  }
}
