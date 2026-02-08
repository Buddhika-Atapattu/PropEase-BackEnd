// Path: src/bootstrap/routes.bootstrap.ts

import type {
  ErrorRequestHandler,
  Express,
  NextFunction,
  Request,
  RequestHandler,
  Response
} from 'express';
import express from 'express';
import path from 'path';
import { NODE_ENV } from '../configs/env.config';

import type Database from '../configs/database';
import { apiGuard } from '../guard/api-router.guard';
import Guards from '../guard/fullAccess.guard';
import type { TypedNamespace } from '../socket/socket-types.type';

import type { AuthController } from '../controller/auth.controller';
import type { MfaController } from '../controller/mfa.controller';
import type NotificationController from '../controller/notification.controller';
import type ReportController from '../controller/report.controller';

import FileTransfer from '../api/fileTransfer';
import Lease from '../api/lease';
import Payments from '../api/payment';
import { PlacesController } from '../api/PlacesController';
import Property from '../api/property';
import TeamKpiRouter from '../api/teamManagement/teamKpi';
import TeamManagement from '../api/teamManagement/teamManagement';
import TeamTaskManagement from '../api/teamManagement/teamTask';
import WorkEventApi from '../api/teamManagement/workEvents';
import WorkItemApi from '../api/teamManagement/workItem';
import Tenant from '../api/tenant';
import Tracking from '../api/tracking';
import UploadsRoutes from '../api/uploads';
import UserRoute from '../api/user';
import Validator from '../api/validator';
import { CommentsEngineRouter } from '../api/shared/comments/comments-engine.router';



const isProd: boolean = NODE_ENV === 'production';
const APP_TAG: string = 'PropEase';

interface RoutesBootstrapDeps {
  app: Express;
  db: Database;
  io: TypedNamespace;
  notification: NotificationController;
  reportController: ReportController;
  authController: AuthController;
  mfaController: MfaController;
  loginRateLimiter: RequestHandler;
  uploadsRoutes: UploadsRoutes;
  user: UserRoute;
  tracking: Tracking;
  property: Property;
  placesController: PlacesController;
  tenant: Tenant;
  fileTransfer: FileTransfer;
  lease: Lease;
  validator: Validator;
  payments: Payments;
  teamManagement: TeamManagement;
  teamTaskRouter: TeamTaskManagement;
  teamKpiRouter: TeamKpiRouter;
  workItemRouter: WorkItemApi;
  workEventRouter: WorkEventApi;
  commentsEngineRouter: CommentsEngineRouter;
}

export class RoutesBootstrap {
  private readonly app: Express;
  private readonly db: Database;
  private readonly io: TypedNamespace;
  private readonly notification: NotificationController;
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
  private readonly payments: Payments;
  private readonly teamManagement: TeamManagement;
  private readonly teamTaskRouter: TeamTaskManagement;
  private readonly teamKpiRouter: TeamKpiRouter;
  private readonly workItemRouter: WorkItemApi;
  private readonly workEventRouter: WorkEventApi;
  private readonly commentsEngineRouter: CommentsEngineRouter;


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
    this.payments = deps.payments;
    this.teamManagement = deps.teamManagement;
    this.teamTaskRouter = deps.teamTaskRouter;
    this.teamKpiRouter = deps.teamKpiRouter;
    this.workItemRouter = deps.workItemRouter;
    this.workEventRouter = deps.workEventRouter;
    this.commentsEngineRouter = deps.commentsEngineRouter;
  }

  public registerAll(): void {
    this.registerDiagnostics();
    this.registerNotificationRoutes();
    this.registerHealthRoute();
    this.registerAdminsOnlyStatic();
    this.registerAuthMfaRoutes();
    this.registerReportRoutes();
    this.registerApiRoutes();
    this.registerIndexPage();
  }

  /**
   * Register 404 handler + centralized error handler.
   * errorHandler MUST be an ErrorRequestHandler (4 args).
   */
  public registerNotFoundAndErrorHandlers( errorHandler: ErrorRequestHandler ): void {
    this.app.use( ( _req: Request, res: Response ) => {
      res.status( 404 ).json( { status: 'error', message: 'Not Found' } );
      return;
    } );

    this.app.use( errorHandler );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Individual route groups
  // ───────────────────────────────────────────────────────────────────────────

  private registerDiagnostics(): void {
    this.app.get( '/api/diag', ( req: Request, res: Response ) => {
      const id: string = ( req as any ).reqId || '-';
      const info = {
        reqId: id,
        method: req.method,
        url: req.originalUrl,
        origin: req.headers.origin || '-',
        hasAuthHeader: !!req.headers.authorization,
        cookieKeys: Object.keys( ( req as any ).cookies || {} ),
        headers: {
          'access-control-request-method':
            req.headers[ 'access-control-request-method' ],
          'access-control-request-headers':
            req.headers[ 'access-control-request-headers' ]
        },
        time: new Date().toISOString()
      };
      if ( !isProd ) {
        // eslint-disable-next-line no-console
        console.log( `[${ APP_TAG }] [${ id }] /api/diag`, info );
      }
      res.json( info );
      return;
    } );
  }

  private registerNotificationRoutes(): void {
    this.app.use( '/api-notification', apiGuard, this.notification.router );
  }

  private registerHealthRoute(): void {
    this.app.get(
      '/api/health',
      Guards.requireFullAccess(),
      async ( _req: Request, res: Response ) => {
        const dbOk: boolean =
          this.db.isConnected() &&
          ( await this.db.ping().catch( () => false ) );

        res.json( {
          status: dbOk ? 'ok' : 'degraded',
          db: { connected: this.db.isConnected(), ping: dbOk },
          socket: { namespace: this.io.name || '/', connected: true },
          timestamp: Date.now()
        } );
        return;
      }
    );
  }

  private registerAdminsOnlyStatic(): void {
    const adminsOnlyDir: string = path.join(
      process.cwd(),
      'public',
      'adminsOnly'
    );

    this.app.use(
      '/adminsOnly',
      Guards.requireFullAccess(),
      ( _req: Request, res: Response, next: NextFunction ) => {
        res.setHeader(
          'Cache-Control',
          'private, no-store, no-cache, must-revalidate'
        );
        res.setHeader( 'Pragma', 'no-cache' );
        res.setHeader( 'Expires', '0' );
        next();
      },
      express.static( adminsOnlyDir, { fallthrough: false } )
    );
  }

  private registerAuthMfaRoutes(): void {
    this.app.use(
      '/api/auth',
      this.loginRateLimiter,
      apiGuard,
      this.authController.getRouter()
    );
    this.app.use( '/api/mfa', apiGuard, this.mfaController.getRouter() );
  }

  private registerReportRoutes(): void {
    this.app.use( '/api-report', apiGuard, this.reportController.router );
  }

  private registerApiRoutes(): void {
    this.app.use( '/api-rich-text', apiGuard, this.uploadsRoutes.router );
    this.app.use( '/api-user', apiGuard, this.user.route );
    this.app.use( '/api-tracking', apiGuard, this.tracking.route );
    this.app.use( '/api-property', apiGuard, this.property.route );
    this.app.use( '/api-places', apiGuard, this.placesController.router );
    this.app.use( '/api-tenant', apiGuard, this.tenant.route );
    this.app.use( '/api-file-transfer', apiGuard, this.fileTransfer.route );
    this.app.use( '/api-lease', apiGuard, this.lease.route );
    this.app.use( '/api-validator', apiGuard, this.validator.route );
    this.app.use( '/api-payments', apiGuard, this.payments.route );
    this.app.use( '/api-team-management', apiGuard, this.teamManagement.route );
    this.app.use( '/api-team-management/task', apiGuard, this.teamTaskRouter.route );
    this.app.use( '/api-team-management/kpi', apiGuard, this.teamKpiRouter.route );
    this.app.use( '/api-work-item', apiGuard, this.workItemRouter.route );
    this.app.use( '/api-work-event', apiGuard, this.workEventRouter.route );
    this.app.use( '/api-comments', apiGuard, this.commentsEngineRouter.route );

  }

  private registerIndexPage(): void {
    this.app.get( '/', ( _req: Request, res: Response ) => {
      res.sendFile(
        path.join( process.cwd(), 'public', 'index.html' ),
        ( err: Error | null ) => {
          if ( err ) {
            // eslint-disable-next-line no-console
            console.error( err );
            res.status( 500 ).send( 'Internal Server Error' );
          }
        }
      );
    } );
  }
}
