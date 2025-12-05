// src/app.ts
// ─────────────────────────────────────────────────────────────────────────────
// App bootstrap (acts as server.ts)
// - Secure-by-default: Host guard, Helmet, rate limiting, CORS
// - Clear boot order so "deny /public subfolders" is always enforced
// - Study-friendly comments on (almost) every line
// - Future-proof hooks for notifications, sockets, background jobs
// ─────────────────────────────────────────────────────────────────────────────

import 'dotenv/config';                         // 1) Load environment variables from .env
import 'source-map-support/register';           // 2) Map stack traces back to TS lines for better debugging

import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
  type RequestHandler,
  type ErrorRequestHandler,
} from 'express';                               // 3) Express (web framework) and helpful types

import http from 'http';                        // 4) Create a Node HTTP server for Express + Socket.IO
import path from 'path';                        // 5) Build OS-safe paths
import cors from 'cors';                        // 6) Cross-Origin Resource Sharing controls
import helmet, { type HelmetOptions } from 'helmet'; // 7) Security headers
import compression from 'compression';          // 8) Gzip/deflate compression to reduce payload
import cookieParser from 'cookie-parser';       // 9) Parse cookies into req.cookies
import type { ServeStaticOptions } from 'serve-static'; // 10) TS type for static serving options
import rateLimit, { ipKeyGenerator } from 'express-rate-limit'; // 11) Rate limiting (IPv6-safe helper)

// Local modules (DB, routes, services, sockets, middlewares)
import Database from './configs/database';

// API route modules (keep your structure)
import UserRoute from './api/user';
import Tracking from './api/tracking';
import Property from './api/property';
import { PlacesController } from './api/PlacesController';
import Tenant from './api/tenant';
import FileTransfer from './api/fileTransfer';
import Lease from './api/lease';
import Validator from './api/validator';
import NotificationController from './controller/notification.controller';
import NotificationService from './services/notification.service';
import Payments from './api/payment';
import UploadsRoutes from './api/uploads';
import TeamManagement from './api/teamManagement';

// Background/cron-like example
import { AutoDeleteUserService } from './services/auto-delete.service';

// Socket.IO integration
import SocketServer from './socket/socket';
import type { Namespace } from 'socket.io';

// Project middlewares (your implementations)
import LoggerMiddleware from './middleware/logger';
import CorsDebug from './middleware/corsDebug';
import ReportController from './controller/report.controller';
import { AuthController } from './controller/auth.controller';
import { MfaController } from './controller/mfa.controller';

// Deep traffic monitor (your improved class)
import TrafficMonitor from './middleware/trafficMonitor';
import { apiGuard } from './guard/api-router.guard';
import Guards from './guard/fullAccess.guard';
import { ApiResponseBuilder } from './utils/api-combiner.builder';

// ─────────────────────────────────────────────────────────────────────────────
// Small runtime flags & constants
// ─────────────────────────────────────────────────────────────────────────────
const isProd = process.env.NODE_ENV === 'production'; // True in production
const APP_TAG = 'PropEase';                            // Console/log tag used across app

// Allowed hostnames (mitigate DNS rebinding / Host header attacks)
// Example: ALLOWED_HOSTS=localhost:3000,api.propease.app
const ALLOWED_HOSTS = new Set(
  String( process.env.ALLOWED_HOSTS || 'localhost:3000' )
    .split( ',' )
    .map( ( s ) => s.trim().toLowerCase() )
    .filter( Boolean )
);

// ─────────────────────────────────────────────────────────────────────────────
// Host header guard
// ─────────────────────────────────────────────────────────────────────────────
const hostGuard: RequestHandler = ( req, res, next ) => {
  const host = String( req.headers.host || '' ).toLowerCase();

  if ( !host ) {
    ApiResponseBuilder.badRequest( res, 'Bad Host header' );
    return;
  }

  // In dev: allow any localhost:* / 127.0.0.1:* to reduce friction
  if (
    !isProd &&
    ( host.startsWith( 'localhost:' ) || host.startsWith( '127.0.0.1:' ) )
  ) {
    next();
    return;
  }

  if ( ALLOWED_HOSTS.has( host ) ) {
    next();
    return;
  }

  ApiResponseBuilder.error( res, 403, 'Forbidden host' );
  return;
};

// ─────────────────────────────────────────────────────────────────────────────
// Central error monitor: captures fatal events + provides Express error handler
// ─────────────────────────────────────────────────────────────────────────────
class InternalErrorMonitor {
  public install(): void {
    process.on( 'uncaughtException', ( err: any ) =>
      this.printFatal( 'Uncaught Exception', err )
    );
    process.on( 'unhandledRejection', ( reason: any ) =>
      this.printFatal( 'Unhandled Rejection', reason )
    );
  }

  private printFatal( kind: string, err: any ): void {
    const stamp = new Date().toISOString();
    console.error( `\n[FATAL ${ stamp }] ${ kind }` );
    if ( err instanceof Error ) console.error( this.formatError( err ) );
    else console.error( String( err ) );
  }

  private formatError( err: Error ): string {
    const header = `${ err.name }: ${ err.message }`;
    const stack = err.stack || '';
    return [ header, ...stack.split( '\n' ).slice( 1 ) ].join( '\n' );
  }

  public expressErrorHandler: ErrorRequestHandler = (
    err: any,
    req: Request,
    res: Response,
    _next: NextFunction
  ) => {
    const reqId = ( req as any ).reqId || '-';
    const when = new Date().toISOString();
    console.error(
      `[${ APP_TAG }] [${ reqId }] [${ when }] Unhandled error at ${ req.method } ${ req.originalUrl }`
    );
    if ( err instanceof Error ) console.error( this.formatError( err ) );
    else console.error( err );
    res.status( 500 ).json( { status: 'error', message: 'Internal Server Error' } );
    return;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// App class (acts as server.ts)
// ─────────────────────────────────────────────────────────────────────────────
export default class App {
  // Core servers
  private app: Express = express();
  private httpServer = http.createServer( this.app );

  // Observability (your logger + deep monitor)
  private logger = new LoggerMiddleware( {
    prefix: APP_TAG,
    userAgentTokens: 2,
  } );

  private corsDebug = new CorsDebug( {
    verbose: false,
    prefix: APP_TAG,
  } );

  private errorMonitor = new InternalErrorMonitor();

  // Deep traffic monitor (writes JSONL logs; dev is quiet, prod echoes briefly)
  private monitor = new TrafficMonitor( {
    logDir: path.join( process.cwd(), 'public', 'trace' ),
    maxBodyBytes: isProd ? 256 : 1024,
    logHeaders: false,
    tag: APP_TAG,
    echoDev: false,
    echoProd: true,
  } );

  // Socket.IO setup (origins controlled + JWT secret)
  private socketServer = new SocketServer( {
    origins: [
      'http://localhost:4200',
      ( process.env.FRONTEND_ORIGIN || '' ).trim() || undefined,
    ].filter( Boolean ) as string[],
    jwtSecret: ( process.env.JWT_SECRET || 'defaultsecret' ).trim(),
    allowCookieAuth: true,
  } );

  private io: Namespace = this.socketServer.attach( this.httpServer );

  // Database
  private db = new Database();

  // Route modules
  private readonly user: UserRoute = new UserRoute();
  private readonly tracking: Tracking = new Tracking();
  private readonly property: Property = new Property();
  private readonly placesController: PlacesController = new PlacesController();
  private readonly tenant: Tenant = new Tenant();
  private readonly fileTransfer: FileTransfer = new FileTransfer();
  private readonly lease: Lease = new Lease();
  private readonly validator: Validator = new Validator();
  private readonly payments: Payments = new Payments();
  private readonly uploadsRoutes: UploadsRoutes = new UploadsRoutes();
  private readonly teamManagement: TeamManagement = new TeamManagement();

  // Notifications (service + controller)
  private notificationService = new NotificationService();
  private notification = new NotificationController(
    this.notificationService,
    this.socketServer
  );

  // Background-job example (auto delete users)
  private autoDeleteUserService = new AutoDeleteUserService( this.io );

  // CORS policy (allowlist driven)
  private corsOptions: cors.CorsOptions = {
    origin: ( origin, cb ) => {
      const allowList = new Set<string>(
        [
          'http://localhost:4200',
          ( process.env.FRONTEND_ORIGIN || '' ).trim(),
        ].filter( Boolean )
      );
      if ( !origin || allowList.has( origin ) ) return cb( null, true );
      return cb( new Error( 'CORS: origin not allowed' ) );

    },
    credentials: true,
    methods: [ 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS' ],

    // IMPORTANT: allow your custom auth headers
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'X-Requested-With',
      'x-guard-token',
      'x-session-token',
      'x-forwarded-for',
    ],

    optionsSuccessStatus: 204,
  };


  // DB readiness guard (returns 503 until connected)
  private databaseReadyGuard: RequestHandler = ( _req, res, next ) => {
    if ( !this.db.isConnected() ) {
      res.status( 503 ).json( { status: 'error', message: 'DB not ready' } );
      return;
    }
    next();
    return;
  };

  // Global rate limiter
  private rateLimiter = rateLimit( {
    windowMs: isProd ? 60_000 : 30_000,
    max: isProd ? 200 : 500,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: ( req: Request, _res: Response ): string => {
      if ( req.ip === '::1' || req.ip === '127.0.0.1' ) return 'internal';
      return ipKeyGenerator( req.ip || '', 64 );
    },
    skip: ( req ) => req.path === '/api/health',
  } );

  // Report / security incident controller
  private readonly reportController: ReportController = new ReportController( {
    logDir: path.join( process.cwd(), 'public', 'trace', 'security' ),
    appTag: APP_TAG,
  } );

  // Auth / MFA controllers
  private readonly authController: AuthController = new AuthController();
  private readonly mfaController: MfaController = new MfaController();

  public constructor () {
    // Install process-level fatal error hooks early
    this.errorMonitor.install();

    // Kick off async boot (connect DB, mount middlewares, routes…)
    this.boot().catch( ( err ) => {
      console.error( 'Fatal boot error:', err );
      process.exit( 1 );
    } );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Boot pipeline (order matters!)
  // ───────────────────────────────────────────────────────────────────────────
  private async boot(): Promise<void> {
    // 1) Connect to DB (fail fast if cannot connect)
    await this.db.connect();

    // 2) Optional DB handshake (e.g., change streams support)
    const hello = await this.db.handshake( 'prop-ease-api' );

    // 3) Harden Express defaults
    this.app.disable( 'x-powered-by' );
    this.app.set( 'trust proxy', 1 );

    // 4) Earliest security gates
    this.app.use( hostGuard );
    this.app.use( this.logger.attachRequestId );

    // 5) CORS (plus dev preflight logger)
    if ( !isProd ) this.app.use( this.corsDebug.preflightLogger );
    this.app.use( cors( this.corsOptions ) );
    this.app.options( /.*/, cors( this.corsOptions ) );

    // 6) Helmet (security headers, CSP tuned per env)
    const FRONT = ( process.env.FRONTEND_ORIGIN || '' ).trim();
    const helmetOptions: HelmetOptions = isProd
      ? {
        crossOriginEmbedderPolicy: false,
        crossOriginResourcePolicy: { policy: 'cross-origin' },
        contentSecurityPolicy: {
          useDefaults: true,
          directives: {
            'default-src': [ "'self'" ],
            'script-src': [ "'self'" ],
            'style-src': [ "'self'", "'unsafe-inline'" ],
            'img-src': [ "'self'", 'data:', 'blob:' ],
            'font-src': [ "'self'", 'data:' ],
            'connect-src': [
              "'self'",
              ...( FRONT ? [ FRONT ] : [] ),
              'wss:',
              'https:',
            ],
            'frame-ancestors': [ "'none'" ],
            'object-src': [ "'none'" ],
            'upgrade-insecure-requests': [],
          },
        },
      }
      : {
        crossOriginEmbedderPolicy: false,
        crossOriginResourcePolicy: { policy: 'cross-origin' },
        contentSecurityPolicy: false,
      };
    this.app.use( helmet( helmetOptions ) );

    // 7) Compression
    this.app.use( compression() );

    // 8) Cookie parsing
    this.app.use( cookieParser() );

    // 9) Global rate limit
    this.app.use( this.rateLimiter );

    // 10) Request logger
    this.app.use( this.logger.requestLogger );

    // 11) Deep HTTP monitor + optional dev route spy
    this.monitor.installHttp( this.app );
    if ( !isProd ) this.monitor.spyOnRoutes( express );

    // 12) Views + body parsers
    this.configureParsersAndViews();

    // 13) Block sensitive public directories BEFORE static is mounted
    this.blockPublicDirs( this.denyListFromEnv() );

    // 14) Static from /public
    this.servePublicStatic();

    // 15) Attach Socket.IO on app
    this.attachSocketToApp();

    // 16) Socket traffic logs
    this.monitor.installSocket( this.io );

    // 17) Gate everything else on DB readiness
    this.app.use( this.databaseReadyGuard );

    // 18) Register routes (public vs protected)
    this.registerRoutes();

    // 19) Serve landing page at root (optional)
    this.indexPage();

    // 20) 404 + central error handler (must be the last middlewares)
    this.registerNotFoundAndErrorHandlers();

    // 21) Optional DB watchers (change streams)
    if ( hello.changeStreams ) {
      this.notificationService.watchChanges( this.io );
      if ( !isProd ) console.log( '[notifications] Change streams enabled' );
    } else {
      if ( !isProd )
        console.log(
          '[notifications] Change streams unavailable — running without watchers'
        );
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Parsers & view engine
  // ───────────────────────────────────────────────────────────────────────────
  private configureParsersAndViews(): void {
    this.app.set( 'view engine', 'ejs' );
    this.app.set( 'views', path.join( process.cwd(), 'public', 'view' ) );

    this.app.use(
      express.json( {
        limit: isProd ? '1mb' : '10mb',
        strict: true,
        type: [ 'application/json', 'application/*+json' ],
      } )
    );

    this.app.use(
      express.urlencoded( {
        extended: false,
        limit: isProd ? '1mb' : '10mb',
      } )
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Static files out of /public
  // ───────────────────────────────────────────────────────────────────────────
  private servePublicStatic(): void {
    const publicOptions: ServeStaticOptions = isProd
      ? { maxAge: '7d', immutable: true }
      : {};
    this.app.use(
      express.static( path.join( process.cwd(), 'public' ), publicOptions )
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Make Socket.IO reachable via req.app for controllers that need it
  // ───────────────────────────────────────────────────────────────────────────
  private attachSocketToApp(): void {
    this.app.set( 'io', this.io );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Register REST routes (public & protected)
  // ───────────────────────────────────────────────────────────────────────────
  private registerRoutes(): void {
    // Diagnostics endpoint
    this.app.get( '/api/diag', ( req: Request, res: Response ) => {
      const id = ( req as any ).reqId || '-';
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
            req.headers[ 'access-control-request-headers' ],
        },
        time: new Date().toISOString(),
      };
      if ( !isProd ) console.log( `[${ APP_TAG }] [${ id }] /api/diag`, info );
      res.json( info );
      return;
    } );

    // Notifications (protected by existing auth)
    this.app.use(
      '/api-notification',
      apiGuard,
      this.notification.router
    );

    // Health probe
    this.app.get( '/api/health', Guards.requireFullAccess(), async ( _req: Request, res: Response ) => {
      const dbOk =
        this.db.isConnected() &&
        ( await this.db.ping().catch( () => false ) );
      res.json( {
        status: dbOk ? 'ok' : 'degraded',
        db: { connected: this.db.isConnected(), ping: dbOk },
        socket: { namespace: this.io.name || '/', connected: true },
        timestamp: Date.now(),
      } );
      return;
    } );

    // Admin-only private static area
    const adminsOnlyDir = path.join( process.cwd(), 'public', 'adminsOnly' );
    this.app.use(
      '/adminsOnly',
      Guards.requireFullAccess(),
      ( _req, res, next ) => {
        res.setHeader(
          'Cache-Control',
          'private, no-store, no-cache, must-revalidate'
        );
        res.setHeader( 'Pragma', 'no-cache' );
        res.setHeader( 'Expires', '0' );
        return next();
      },
      express.static( adminsOnlyDir, { fallthrough: false } )
    );

    // Auth / MFA (login, logout, QR activation, etc.)
    this.app.use( '/api/auth', apiGuard, this.authController.getRouter() );
    this.app.use( '/api/mfa', apiGuard, this.mfaController.getRouter() );

    // Report / security incidents (intentionally without auth)
    this.app.use( '/api-report', apiGuard, this.reportController.router );

    // Public / separately guarded APIs (Guard already mounted globally)
    this.app.use( '/api', apiGuard, this.uploadsRoutes.router );
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
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Deny-list for /public subfolders
  // ───────────────────────────────────────────────────────────────────────────
  private blockPublicDirs( dirs: string[] ): void {
    const deny = Array.from(
      new Set(
        dirs
          .map( ( s ) =>
            String( s || '' ).trim().replace( /^\/+|\/+$/g, '' )
          )
          .filter( Boolean )
          .map( ( s ) => s.toLowerCase() )
      )
    );
    if ( deny.length === 0 ) return;

    const topLevels = new Set( deny.map( ( d ) => d.split( '/' )[ 0 ] ) );

    this.app.use( ( req: Request, res: Response, next: NextFunction ) => {
      const p = req.path.toLowerCase().replace( /^\/+/, '' );
      const [ first ] = p.split( '/' );

      if ( !topLevels.has( first ) ) {
        next();
        return;
      }

      const matchesNested = deny.some(
        ( d ) => p === d || p.startsWith( d + '/' )
      );
      if ( !matchesNested ) {
        next();
        return;
      }

      res.setHeader(
        'Cache-Control',
        'no-store, no-cache, must-revalidate, private'
      );
      res.setHeader( 'Pragma', 'no-cache' );
      if ( !isProd ) console.warn( `[DENY] Attempt to access /${ p }` );
      res.status( 403 ).send( 'Forbidden' );
      return;
    } );
  }

  private denyListFromEnv(): string[] {
    const raw = ( process.env.PUBLIC_DENY_DIRS || 'recyclebin' ).split( ',' );
    return raw.map( ( s ) => s.trim() ).filter( Boolean );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Serve a static landing page at "/"
  // ───────────────────────────────────────────────────────────────────────────
  private indexPage(): void {
    this.app.get( '/', ( _req: Request, res: Response ) => {
      res.sendFile(
        path.join( process.cwd(), 'public', 'index.html' ),
        ( err ) => {
          if ( err ) {
            console.error( err );
            return res.status( 500 ).send( 'Internal Server Error' );
          }
        }
      );
    } );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 404 + centralized error handler (must be the last middlewares)
  // ───────────────────────────────────────────────────────────────────────────
  private registerNotFoundAndErrorHandlers(): void {
    this.app.use( ( _req, res ) => {
      res.status( 404 ).json( { status: 'error', message: 'Not Found' } );
      return;
    } );
    this.app.use( this.errorMonitor.expressErrorHandler );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Start server + graceful shutdown
  // ───────────────────────────────────────────────────────────────────────────
  public listen( port: number ): void {
    this.httpServer.listen( port, '0.0.0.0', () => {
      console.log(
        `🚀 ${ APP_TAG } API on http://localhost:${ port }  (Socket.IO ready)`
      );
    } );

    const shutdown = async ( signal: 'SIGINT' | 'SIGTERM' ) => {
      console.log( `\n${ signal } received — shutting down…` );
      this.httpServer.close( () => console.log( 'HTTP server closed.' ) );
      try {
        await this.db.close();
      } finally {
        setTimeout( () => process.exit( 0 ), 1500 ).unref();
      }
    };
    process.on( 'SIGINT', () => shutdown( 'SIGINT' ) );
    process.on( 'SIGTERM', () => shutdown( 'SIGTERM' ) );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap (construct + listen)
// ─────────────────────────────────────────────────────────────────────────────
const server = new App();
server.listen( Number( process.env.PORT ) || 3000 );
