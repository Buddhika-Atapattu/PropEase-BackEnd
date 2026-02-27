// Path: src/core/app-server.core.ts
// ─────────────────────────────────────────────────────────────────────────────
// Core HTTP + Socket.IO server for PropEase
// - Orchestrates bootstraps (HTTP security, sockets, routes)
// - Keeps heavy logic out of src/app.ts
//
// ✅ FIX (Part A)
// - NotificationResolversBootstrap.init() MUST run AFTER DB connect succeeds.
// - Removed init() call from constructor and moved it into boot() right after
//   `await this.db.connect()`.
// ─────────────────────────────────────────────────────────────────────────────

import "source-map-support/register";

import http from "http";
import path from "path";

import express, {
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";

import cors from "cors";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";

import {
  ALLOWED_HOSTS,
  APP_PORT,
  FRONTEND_ORIGIN,
  NODE_ENV,
} from "../configs/env.config";

import Database from "../configs/database";

// ─────────────────────────────────────────────────────────────────────────────
// API Routers (core modules)
// ─────────────────────────────────────────────────────────────────────────────
import UserRoute from "../api/user.router";
import Tracking from "../api/tracking.router";
import Property from "../api/property.router";
import { PlacesController } from "../api/PlacesController.router";
import Tenant from "../api/tenant.router";
import FileTransfer from "../api/fileTransfer.router";
import Lease from "../api/lease.router";
import Validator from "../api/validator.router";
import UploadsRoutes from "../api/uploads.router";
import { PaymentRouter } from "../api/payment/payment.router";

// ─────────────────────────────────────────────────────────────────────────────
// Team Management Routers
// ─────────────────────────────────────────────────────────────────────────────
import TeamManagementRouter from "../api/teamManagement/teamMain/teamManagement.router";
import TeamTaskRouter from "../api/teamManagement/teamTasks/teamTask.router";
import TeamKpiRouter from "../api/teamManagement/teamKpi.router";
import WorkItemRouter from "../api/teamManagement/workItems/workItem.router";
import WorkEventApi from "../api/teamManagement/workEvents.router";

// ✅ NEW: Member Activities + Milestones
import MemberActivitiesRouter from "../api/teamManagement/memberActivities/memberActivities.router";
import MilestonesRouter from "../api/teamManagement/milestones/millestones.router";

// ─────────────────────────────────────────────────────────────────────────────
// Shared modules
// ─────────────────────────────────────────────────────────────────────────────
import { CommentsEngineRouter } from "../api/shared/comments/comments-engine.router";

// ─────────────────────────────────────────────────────────────────────────────
// Controllers / Services (socket dependent modules)
// ─────────────────────────────────────────────────────────────────────────────
import NotificationHubRoute from "../api/notifications/notification-hub.router";
import ReportController from "../controllers/report.controller";
import { AuthController } from "../controllers/auth.controller";
import { MfaController } from "../controllers/mfa.controller";

// ─────────────────────────────────────────────────────────────────────────────
// Observability / middlewares
// ─────────────────────────────────────────────────────────────────────────────
import LoggerMiddleware from "../middleware/logger";
import CorsDebug from "../middleware/corsDebug";
import TrafficMonitor from "../middleware/trafficMonitor";
import { ApiResponseBuilder } from "../utils/api-combiner.builder";

// ─────────────────────────────────────────────────────────────────────────────
// Bootstraps
// ─────────────────────────────────────────────────────────────────────────────
import { HttpSecurityBootstrap } from "../bootstrap/http-security.bootstrap";
import { SocketBootstrap } from "../bootstrap/socket.bootstrap";
import { RoutesBootstrap } from "../bootstrap/routes.bootstrap";

// ✅ Part A: Notification recipient resolver wiring (BOOTSTRAP)
import { NotificationResolversBootstrap } from "../bootstrap/notifications/notification-resolvers.bootstrap";

// ─────────────────────────────────────────────────────────────────────────────
// Error + host guard
// ─────────────────────────────────────────────────────────────────────────────
import { InternalErrorMonitor } from "../services/internal-error-monitor.service";
import { HostGuardMiddleware } from "../middleware/host-guard.middleware";

import RecycleBinRouter from "../api/recyclebin/recyclebin.router";

// Socket types (for typing only)
import type SocketServer from "./socket-server";
import type { TypedNamespace } from "../socket/socket-types.type";
import type { SocketConnectionHandler } from "../socket/socket-connection.handler";

// Background jobs (optional)
import { AutoDeleteUserService } from "../services/auto-delete.service";
import { NotificationDeliveryBootstrap } from "../bootstrap/notifications/notification-delivery.bootstrap";

// ─────────────────────────────────────────────────────────────────────────────
// Dev test runner (optional, for internal smoke testing without HTTP endpoints)
// ─────────────────────────────────────────────────────────────────────────────
// Note: This is NOT meant for production use. It runs directly in Node and is
// intended for internal testing of KPI logic without going through HTTP layer.
// DO NOT commit this in production branches.
// ─────────────────────────────────────────────────────────────────────────────
import { DevKpiRunner } from "../dev/kpi-dev-runner";
import { GuardTokenService } from "../services/guard-token.service";


const isProd: boolean = NODE_ENV === "production";
const APP_TAG: string = "PropEase";

/**
 * Host allowlist:
 * - Used by HostGuardMiddleware to protect against Host header attacks in prod.
 * - Allow multiple hosts via comma-separated list.
 */
const ALLOWED_HOST: Set<string> = new Set(
  String( ALLOWED_HOSTS || "localhost:3000" )
    .split( "," )
    .map( ( s: string ) => s.trim().toLowerCase() )
    .filter( Boolean ),
);

export class AppServer {
  // Core servers
  private readonly app: Express;
  private readonly httpServer: http.Server;

  // Observability / monitoring
  private readonly logger: LoggerMiddleware;
  private readonly corsDebug: CorsDebug;
  private readonly monitor: TrafficMonitor;
  private readonly errorMonitor: InternalErrorMonitor;

  // Database
  private readonly db: Database;

  // CORS + rate limiting
  private readonly corsOptions: cors.CorsOptions;
  private readonly rateLimiter: RequestHandler;
  private readonly loginRateLimiter: RequestHandler;

  // Routers
  private readonly user: UserRoute;
  private readonly tracking: Tracking;
  private readonly property: Property;
  private readonly placesController: PlacesController;
  private readonly tenant: Tenant;
  private readonly fileTransfer: FileTransfer;
  private readonly lease: Lease;
  private readonly validator: Validator;
  private readonly uploadsRoutes: UploadsRoutes;
  private readonly recycleBin: RecycleBinRouter;
  private readonly payment: PaymentRouter;

  // Team routers
  private readonly teamManagement: TeamManagementRouter;
  private readonly teamTaskRouter: TeamTaskRouter;
  private readonly teamKpiRouter: TeamKpiRouter;
  private readonly workItemRouter: WorkItemRouter;
  private readonly workEventRouter: WorkEventApi;

  // ✅ NEW routers
  private readonly memberActivitiesRouter: MemberActivitiesRouter;
  private readonly milestonesRouter: MilestonesRouter;

  // Shared routers
  private readonly commentsEngineRouter: CommentsEngineRouter;

  // Notifications / reports / auth / MFA
  private readonly notificationRouter: NotificationHubRoute;
  private readonly reportController: ReportController;
  private readonly authController: AuthController;
  private readonly mfaController: MfaController;


  // Background jobs (optional)
  private autoDeleteUserService: AutoDeleteUserService | null = null;

  // Socket runtime (set during boot)
  private socketServer: SocketServer | null = null;
  private io: TypedNamespace | null = null;
  private socketConnectionHandler: SocketConnectionHandler | null = null;

  // DB readiness guard (blocks traffic if DB drops)
  private readonly databaseReadyGuard: RequestHandler;

  private isShuttingDown: boolean = false;

  // Services

  public constructor () {
    this.app = express();
    this.httpServer = http.createServer( this.app );

    // ─────────────────────────────────────────────────────────────────────────
    // Observability setup
    // ─────────────────────────────────────────────────────────────────────────
    this.logger = new LoggerMiddleware( {
      prefix: APP_TAG,
      userAgentTokens: 2,
    } );

    this.corsDebug = new CorsDebug( {
      verbose: false,
      prefix: APP_TAG,
    } );

    this.monitor = new TrafficMonitor( {
      logDir: path.join( process.cwd(), "public", "trace" ),
      maxBodyBytes: isProd ? 256 : 1024,
      logHeaders: false,
      tag: APP_TAG,
      echoDev: false,
      echoProd: true,
    } );

    this.errorMonitor = new InternalErrorMonitor( APP_TAG );

    // ─────────────────────────────────────────────────────────────────────────
    // Database (DO NOT init notification resolvers here)
    // ─────────────────────────────────────────────────────────────────────────
    this.db = new Database();

    // ─────────────────────────────────────────────────────────────────────────
    // CORS
    // ─────────────────────────────────────────────────────────────────────────
    this.corsOptions = {
      origin: ( origin, cb ) => {
        const allowList: Set<string> = new Set<string>(
          [ "http://localhost:4200", ( FRONTEND_ORIGIN || "" ).trim() ].filter( Boolean ),
        );

        // If origin is missing (same-origin / curl / server-to-server), allow.
        if ( !origin || allowList.has( origin ) ) {
          cb( null, true );
          return;
        }

        cb( new Error( "CORS: origin not allowed" ) );
      },
      credentials: true,
      methods: [ "GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS" ],
      allowedHeaders: [
        "Authorization",
        "Content-Type",
        "X-Requested-With",
        "X-Guard-Token",
        "X-Session-Token",
        "X-Mfa-Verification",
        "X-Forwarded-For",
        "X-Device-ID",
      ],
      optionsSuccessStatus: 204,
    };


    //Launch dev KPI runner (optional, for internal smoke testing without HTTP endpoints)
    if ( !isProd ) {
      void DevKpiRunner.run().catch( ( err: unknown ) => {
        console.error( "[Error:] [DevKpiRunner] Unexpected error:\n", err, "\n" );
      } );
    }



    /**
     * trust proxy:
     * - Required when you are behind reverse proxy (nginx, cloudflare, etc.)
     * - Makes req.ip / secure cookies behave correctly.
     */
    this.app.set( "trust proxy", true );

    // ─────────────────────────────────────────────────────────────────────────
    // Global rate limiter
    // ─────────────────────────────────────────────────────────────────────────
    this.rateLimiter = rateLimit( {
      windowMs: isProd ? 60_000 : 30_000,
      max: isProd ? 200 : 500,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: ( req: Request, _res: Response ): string => {
        // local dev shortcut: keep stable key so you don't get blocked
        if ( req.ip === "::1" || req.ip === "127.0.0.1" ) return "internal";
        return ipKeyGenerator( req.ip || "", 64 );
      },
      skip: ( req: Request ): boolean => req.path === "/api/health",
    } );

    // ─────────────────────────────────────────────────────────────────────────
    // Login rate limiter (auth endpoints)
    // ─────────────────────────────────────────────────────────────────────────
    this.loginRateLimiter = rateLimit( {
      windowMs: 15 * 60_000,
      max: 20,
      standardHeaders: true,
      legacyHeaders: false,
      message: {
        status: "error",
        message: "Too many login attempts. Please try again later.",
      },
    } );

    // ─────────────────────────────────────────────────────────────────────────
    // Routers instantiation (no sockets required here)
    // ─────────────────────────────────────────────────────────────────────────
    this.user = new UserRoute();
    this.tracking = new Tracking();
    this.property = new Property();
    this.placesController = new PlacesController();
    this.tenant = new Tenant();
    this.fileTransfer = new FileTransfer();
    this.lease = new Lease();
    this.validator = new Validator();
    this.uploadsRoutes = new UploadsRoutes();
    this.payment = new PaymentRouter();

    this.teamManagement = new TeamManagementRouter();
    this.teamTaskRouter = new TeamTaskRouter();
    this.teamKpiRouter = new TeamKpiRouter();
    this.workItemRouter = new WorkItemRouter();
    this.workEventRouter = new WorkEventApi();

    // ✅ NEW
    this.memberActivitiesRouter = new MemberActivitiesRouter();
    this.milestonesRouter = new MilestonesRouter();

    this.commentsEngineRouter = new CommentsEngineRouter();

    this.notificationRouter = new NotificationHubRoute();
    this.recycleBin = new RecycleBinRouter();

    // ─────────────────────────────────────────────────────────────────────────
    // Controllers/services
    // ─────────────────────────────────────────────────────────────────────────
    this.reportController = new ReportController( {
      logDir: path.join( process.cwd(), "public", "trace", "security" ),
      appTag: APP_TAG,
    } );

    this.authController = new AuthController();
    this.mfaController = new MfaController();

    // ─────────────────────────────────────────────────────────────────────────
    // DB readiness guard
    // ─────────────────────────────────────────────────────────────────────────
    this.databaseReadyGuard = ( _req: Request, res: Response, next: NextFunction ) => {
      if ( !this.db.isConnected() ) {
        ApiResponseBuilder.error( res, 403, "Database is not ready yet!" );
        return;
      }
      next();
      return;
    };

    // Install fatal hooks early (uncaughtException / unhandledRejection)
    this.errorMonitor.install();

    // Kick async boot
    void this.boot().catch( ( err: unknown ) => {
      // eslint-disable-next-line no-console
      console.error( "[Error:] [AppServer] Fatal boot error:\n", err, "\n" );
      process.exit( 1 );
    } );


  }

  // ───────────────────────────────────────────────────────────────────────────
  // Boot pipeline (ORDER MATTERS)
  // ───────────────────────────────────────────────────────────────────────────
  private async boot(): Promise<void> {
    // 1) DB connect
    await this.db.connect();


    // ✅ Part A: wire notification recipient resolvers AFTER DB is ready
    NotificationResolversBootstrap.init();

    // 2) Optional DB handshake (change streams support, etc.)
    const hello = await this.db.handshake( "prop-ease-api" );

    // 3) HTTP security / infra
    const hostGuard = new HostGuardMiddleware( ALLOWED_HOST, isProd, APP_TAG );

    const httpBootstrap = new HttpSecurityBootstrap(
      this.app,
      this.logger,
      this.corsDebug,
      this.monitor,
      this.rateLimiter,
      this.corsOptions,
      hostGuard,
    );

    httpBootstrap.configureCoreSecurity();
    httpBootstrap.configureParsersAndViews();
    httpBootstrap.configureStaticAndDenyList();

    // 4) Socket bootstrap (must happen before controllers needing handler)
    const socketBootstrap = new SocketBootstrap( this.httpServer, this.monitor );
    const {
      socketServer,
      io,
      socketAuthHelper,
      guardTokenService,
      wsTokenRegistryRedis,
      socketConnectionHandler,
    } = await socketBootstrap.init();

    this.socketServer = socketServer;
    this.io = io;
    this.socketConnectionHandler = socketConnectionHandler;



    NotificationDeliveryBootstrap.init();

    // Background jobs may rely on io
    this.autoDeleteUserService = new AutoDeleteUserService( this.io );

    // 6) Attach socket references to Express app locals (optional but useful)
    this.attachSocketToApp();

    // 7) Gate requests on DB readiness
    this.app.use( this.databaseReadyGuard );

    // 8) Route bootstrap (ALL mounts must be here)
    const routesBootstrap = new RoutesBootstrap( {
      app: this.app,
      db: this.db,
      io: this.io,

      notification: this.notificationRouter,
      reportController: this.reportController,
      authController: this.authController,
      mfaController: this.mfaController,
      loginRateLimiter: this.loginRateLimiter,

      uploadsRoutes: this.uploadsRoutes,
      user: this.user,
      tracking: this.tracking,
      property: this.property,
      placesController: this.placesController,
      tenant: this.tenant,
      fileTransfer: this.fileTransfer,
      lease: this.lease,
      validator: this.validator,
      payment: this.payment,

      teamManagement: this.teamManagement,
      teamTaskRouter: this.teamTaskRouter,
      teamKpiRouter: this.teamKpiRouter,
      workItemRouter: this.workItemRouter,
      workEventRouter: this.workEventRouter,

      // ✅ NEW wiring
      memberActivitiesRouter: this.memberActivitiesRouter,
      milestonesRouter: this.milestonesRouter,

      commentsEngineRouter: this.commentsEngineRouter,
      recyclebin: this.recycleBin,
    } );

    routesBootstrap.registerAll();
    routesBootstrap.registerNotFoundAndErrorHandlers(
      this.errorMonitor.getExpressErrorHandler(),
    );

    // 9) DB change streams → notifications (only when DB supports it)
    if ( hello.changeStreams ) {
      if ( !isProd ) {
        // eslint-disable-next-line no-console
        console.log( "[Info:] [Notifications] Change streams enabled.\n" );
      }
    } else if ( !isProd ) {
      // eslint-disable-next-line no-console
      console.log(
        "[Warning:] [Notifications] Change streams unavailable — running without watchers.\n",
      );
    }

    // 10) Background jobs (optional)
    // this.autoDeleteUserService.start();

    // Keep references “used” so TS/linters don’t complain.
    void socketAuthHelper;
    void guardTokenService;
    void wsTokenRegistryRedis;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Attach Socket.IO into Express app locals
  // ───────────────────────────────────────────────────────────────────────────
  private attachSocketToApp(): void {
    this.app.set( "io", this.io );
    this.app.set( "socketServer", this.socketServer );
    this.app.set( "socketConnectionHandler", this.socketConnectionHandler );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Start server + graceful shutdown
  // ───────────────────────────────────────────────────────────────────────────
  public listen( port?: number ): void {
    const resolvedPort: number = Number( port ?? APP_PORT ?? 3000 );

    this.httpServer.listen( resolvedPort, "0.0.0.0", () => {
      // eslint-disable-next-line no-console
      console.log(
        `[Server:]🚀 ${ APP_TAG } API on http://localhost:${ resolvedPort } (Socket.IO ready)\n`,
      );
    } );

    const shutdown = async ( signal: "SIGINT" | "SIGTERM" ): Promise<void> => {
      if ( this.isShuttingDown ) return;
      this.isShuttingDown = true;

      console.log( `[Server:] ${ signal } received — shutting down…\n` );

      // Mark shutdown state for other components
      this.app.set( "isShuttingDown", true );

      // 1) Disconnect sockets FIRST (stops guardTimer/wsTokenTimer races)
      try {
        if ( this.io ) {
          this.io.disconnectSockets( true );
          console.log( "[Info:] [AppServer] All sockets disconnected.\n" );
        }
      } catch ( e: unknown ) {
        console.warn( "[Warning:] [AppServer] Socket shutdown failed:\n", e, "\n" );
      }

      // 2) Stop accepting new HTTP connections
      try {
        this.httpServer.close();
        console.log( "[Info:] [AppServer] HTTP server closing.\n" );
      } catch ( e: unknown ) {
        console.warn( "[Warning:] [AppServer] HTTP close failed:\n", e, "\n" );
      }

      // 3) Close DB LAST
      try {
        await this.db.close();
      } catch ( error: unknown ) {
        console.error( "[Error:] [AppServer] DB close failed:\n", error, "\n" );
      } finally {
        setTimeout( () => process.exit( 0 ), 800 ).unref();
      }
    };

    process.on( "SIGINT", () => void shutdown( "SIGINT" ) );
    process.on( "SIGTERM", () => void shutdown( "SIGTERM" ) );
  }


}
