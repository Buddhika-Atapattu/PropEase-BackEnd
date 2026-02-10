// Path: src/core/app-server.core.ts
// ─────────────────────────────────────────────────────────────────────────────
// Core HTTP + Socket.IO server for PropEase
// - Orchestrates bootstraps (HTTP security, sockets, routes)
// - Keeps heavy logic out of src/app.ts
// ─────────────────────────────────────────────────────────────────────────────

import 'source-map-support/register';

import http from 'http';
import path from 'path';

import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
  type RequestHandler
} from 'express';

import cors from 'cors';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

import {
  ALLOWED_HOSTS,
  APP_PORT,
  NODE_ENV,
  FRONTEND_ORIGIN
} from '../configs/env.config';

import Database from '../configs/database';

// Route modules
import UserRoute from '../api/user.router';
import Tracking from '../api/tracking.router';
import Property from '../api/property.router';
import { PlacesController } from '../api/PlacesController.router';
import Tenant from '../api/tenant.router';
import FileTransfer from '../api/fileTransfer.router';
import Lease from '../api/lease.router';
import Validator from '../api/validator.router';
import Payments from '../api/payment.router';
import UploadsRoutes from '../api/uploads.router';
import TeamManagement from '../api/teamManagement/teamManagement.router';
import TeamTaskManagement from '../api/teamManagement/teamTask.router';
import TeamKpiRouter from '../api/teamManagement/teamKpi.router';
import WorkItemApi from '../api/teamManagement/workItem.router';
import WorkEventApi from '../api/teamManagement/workEvents.router';
import { CommentsEngineRouter } from "../api/shared/comments/comments-engine.router";


// Notifications, reports, auth, MFA
import NotificationController from '../controller/notification.controller';
import NotificationService from '../services/notification.service';
import ReportController from '../controller/report.controller';
import { AuthController } from '../controller/auth.controller';
import { MfaController } from '../controller/mfa.controller';

// Observability / middlewares
import LoggerMiddleware from '../middleware/logger';
import CorsDebug from '../middleware/corsDebug';
import TrafficMonitor from '../middleware/trafficMonitor';
import Guards from '../guard/fullAccess.guard';
import { ApiResponseBuilder } from '../utils/api-combiner.builder';

// Bootstraps
import { HttpSecurityBootstrap } from '../bootstrap/http-security.bootstrap';
import { SocketBootstrap } from '../bootstrap/socket.bootstrap';
import { RoutesBootstrap } from '../bootstrap/routes.bootstrap';

// Error + host guard
import { InternalErrorMonitor } from '../services/internal-error-monitor.service';
import { HostGuardMiddleware } from '../middleware/host-guard.middleware';

// Socket types (for app.set typing, not for bootstrap itself)
import type SocketServer from './socket-server';
import type { TypedNamespace } from '../socket/socket-types.type';
import type { SocketConnectionHandler } from '../socket/socket-connection.handler';

// Background job example
import { AutoDeleteUserService } from '../services/auto-delete.service';

const isProd: boolean = NODE_ENV === 'production';
const APP_TAG: string = 'PropEase';

const ALLOWED_HOST: Set<string> = new Set(
  String(ALLOWED_HOSTS || 'localhost:3000')
    .split(',')
    .map((s: string) => s.trim().toLowerCase())
    .filter(Boolean)
);

export class AppServer {
  // Core servers
  private readonly app: Express;
  private readonly httpServer: http.Server;

  // Observability
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

  // Route modules
  private readonly user: UserRoute;
  private readonly tracking: Tracking;
  private readonly property: Property;
  private readonly placesController: PlacesController;
  private readonly tenant: Tenant;
  private readonly fileTransfer: FileTransfer;
  private readonly lease: Lease;
  private readonly validator: Validator;
  private readonly payments: Payments;
  private readonly uploadsRoutes: UploadsRoutes;
  private readonly teamManagement: TeamManagement;
  private readonly teamTaskRouter: TeamTaskManagement;
  private readonly teamKpiRouter: TeamKpiRouter;
  private readonly workItemRouter: WorkItemApi;
  private readonly workEventRouter: WorkEventApi;
  private readonly commentsEngineRouter: CommentsEngineRouter;


  // Notifications / reports / auth / mfa
  private readonly notificationService: NotificationService;
  private notification!: NotificationController;
  private readonly reportController: ReportController;
  private readonly authController: AuthController;
  private readonly mfaController: MfaController;

  // Background jobs
  private autoDeleteUserService!: AutoDeleteUserService;

  // Socket runtime (set during boot via SocketBootstrap)
  private socketServer!: SocketServer;
  private io!: TypedNamespace;
  private socketConnectionHandler!: SocketConnectionHandler;

  // DB readiness guard
  private readonly databaseReadyGuard: RequestHandler;

  public constructor() {
    this.app = express();
    this.httpServer = http.createServer(this.app);

    // Observability
    this.logger = new LoggerMiddleware({
      prefix: APP_TAG,
      userAgentTokens: 2
    });

    this.corsDebug = new CorsDebug({
      verbose: false,
      prefix: APP_TAG
    });

    this.monitor = new TrafficMonitor({
      logDir: path.join(process.cwd(), 'public', 'trace'),
      maxBodyBytes: isProd ? 256 : 1024,
      logHeaders: false,
      tag: APP_TAG,
      echoDev: false,
      echoProd: true
    });

    this.errorMonitor = new InternalErrorMonitor(APP_TAG);

    // Database
    this.db = new Database();

    // CORS options
    this.corsOptions = {
      origin: (origin, cb) => {
        const allowList: Set<string> = new Set<string>(
          [
            'http://localhost:4200',
            (FRONTEND_ORIGIN || '').trim()
          ].filter(Boolean)
        );

        if (!origin || allowList.has(origin)) {
          cb(null, true);
          return;
        }

        cb(new Error('CORS: origin not allowed'));
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: [
        'Authorization',
        'Content-Type',
        'X-Requested-With',
        'X-Guard-Token',
        'X-Session-Token',
        'X-Mfa-Verification',
        'X-Forwarded-For',
        'X-Device-ID'
      ],
      optionsSuccessStatus: 204
    };

    this.app.set("trust proxy", true);

    // Global rate limiter
    this.rateLimiter = rateLimit({
      windowMs: isProd ? 60_000 : 30_000,
      max: isProd ? 200 : 500,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: (req: Request, _res: Response): string => {
        if (req.ip === '::1' || req.ip === '127.0.0.1') {
          return 'internal';
        }
        return ipKeyGenerator(req.ip || '', 64);
      },
      skip: (req: Request): boolean => req.path === '/api/health'
    });

    // Auth/login rate limiter
    this.loginRateLimiter = rateLimit({
      windowMs: 15 * 60_000,
      max: 20,
      standardHeaders: true,
      legacyHeaders: false,
      message: {
        status: 'error',
        message: 'Too many login attempts. Please try again later.'
      }
    });

    // Route modules
    this.user = new UserRoute();
    this.tracking = new Tracking();
    this.property = new Property();
    this.placesController = new PlacesController();
    this.tenant = new Tenant();
    this.fileTransfer = new FileTransfer();
    this.lease = new Lease();
    this.validator = new Validator();
    this.payments = new Payments();
    this.uploadsRoutes = new UploadsRoutes();
    this.teamManagement = new TeamManagement();
    this.teamTaskRouter = new TeamTaskManagement();
    this.teamKpiRouter = new TeamKpiRouter();
    this.workItemRouter = new WorkItemApi();
    this.workEventRouter = new WorkEventApi();
    this.commentsEngineRouter = new CommentsEngineRouter();


    // Notification / report / auth / MFA
    this.notificationService = new NotificationService();
    this.reportController = new ReportController({
      logDir: path.join(process.cwd(), 'public', 'trace', 'security'),
      appTag: APP_TAG
    });
    this.authController = new AuthController();
    this.mfaController = new MfaController();

    // DB readiness guard
    this.databaseReadyGuard = (_req: Request, res: Response, next: NextFunction) => {
      if (!this.db.isConnected()) {
        ApiResponseBuilder.error(res, 403, 'Database is not ready yet!');
        return;
      }
      next();
      return;
    };

    // Install process-level fatal error hooks early
    this.errorMonitor.install();

    // Kick async boot
    void this.boot().catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error('Fatal boot error:', err);
      process.exit(1);
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Boot pipeline (order matters)
  // ───────────────────────────────────────────────────────────────────────────

  private async boot(): Promise<void> {
    // 1) DB connect
    await this.db.connect();

    // 2) Optional DB handshake (change streams support, etc.)
    const hello = await this.db.handshake('prop-ease-api');

    // 3) HTTP security / infra
    const hostGuard = new HostGuardMiddleware(ALLOWED_HOST, isProd, APP_TAG);

    const httpBootstrap = new HttpSecurityBootstrap(
      this.app,
      this.logger,
      this.corsDebug,
      this.monitor,
      this.rateLimiter,
      this.corsOptions,
      hostGuard
    );

    httpBootstrap.configureCoreSecurity();
    httpBootstrap.configureParsersAndViews();
    httpBootstrap.configureStaticAndDenyList();

    // 4) Socket bootstrap (IO, handlers, monitor)
    const socketBootstrap = new SocketBootstrap(this.httpServer, this.monitor);
    const {
      socketServer,
      io,
      socketAuthHelper,
      guardTokenService,
      wsTokenRegistryRedis,
      socketConnectionHandler
    } = await socketBootstrap.init();

    this.socketServer = socketServer;
    this.io = io;
    this.socketConnectionHandler = socketConnectionHandler;

    // 5) Build components that depend on IO / socket connection handler
    this.notification = new NotificationController(
      this.notificationService,
      this.socketConnectionHandler
    );
    this.autoDeleteUserService = new AutoDeleteUserService(this.io);

    // 6) Attach socket references to app for controllers that might need it
    this.attachSocketToApp();

    // 7) Gate everything else on DB readiness
    this.app.use(this.databaseReadyGuard);

    // 8) Route bootstrap (REST, index page, 404 + error handler)
    const routesBootstrap = new RoutesBootstrap({
      app: this.app,
      db: this.db,
      io: this.io,
      notification: this.notification,
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
      payments: this.payments,
      teamManagement: this.teamManagement,
      teamTaskRouter: this.teamTaskRouter,
      teamKpiRouter: this.teamKpiRouter,
      workEventRouter: this.workEventRouter,
      workItemRouter: this.workItemRouter,
      commentsEngineRouter: this.commentsEngineRouter,
    });

    routesBootstrap.registerAll();
    routesBootstrap.registerNotFoundAndErrorHandlers(
      this.errorMonitor.getExpressErrorHandler()
    );

    // 9) DB change streams → notifications
    if (hello.changeStreams) {
      this.notificationService.watchChanges(this.io);
      if (!isProd) {
        // eslint-disable-next-line no-console
        console.log('[Notifications:] Change streams enabled', '\n');
      }
    } else if (!isProd) {
      // eslint-disable-next-line no-console
      console.log(
        '[Notifications:] Change streams unavailable — running without watchers', '\n'
      );
    }

    // 10) Background jobs (optional)
    // this.autoDeleteUserService.start();

    // We currently do *not* use socketAuthHelper / guardTokenService / wsTokenRegistryRedis here,
    // but SocketBootstrap wires them into the connection handler and they are
    // available for future features if needed.
    void socketAuthHelper;
    void guardTokenService;
    void wsTokenRegistryRedis;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Attach Socket.IO into Express app locals
  // ───────────────────────────────────────────────────────────────────────────

  private attachSocketToApp(): void {
    this.app.set('io', this.io);
    this.app.set('socketServer', this.socketServer);
    this.app.set('socketConnectionHandler', this.socketConnectionHandler);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Start server + graceful shutdown
  // ───────────────────────────────────────────────────────────────────────────

  public listen(port?: number): void {
    const resolvedPort: number = Number(port ?? APP_PORT ?? 3000);

    this.httpServer.listen(resolvedPort, '0.0.0.0', () => {
      // eslint-disable-next-line no-console
      console.log(
        `[Server:]🚀 ${APP_TAG} API on http://localhost:${resolvedPort}  (Socket.IO ready)`, '\n'
      );
    });

    const shutdown = async (signal: 'SIGINT' | 'SIGTERM'): Promise<void> => {
      // eslint-disable-next-line no-console
      console.log('[Server:]',`${signal} received — shutting down…`, '\n');

      this.httpServer.close(() => {
        // eslint-disable-next-line no-console
        console.log('HTTP server closed.');
      });

      try {
        await this.db.close();
      } finally {
        // Give a bit of time for logs / connections to flush
        setTimeout(() => process.exit(0), 1500).unref();
      }
    };

    process.on('SIGINT', () => {
      void shutdown('SIGINT');
    });
    process.on('SIGTERM', () => {
      void shutdown('SIGTERM');
    });
  }
}
