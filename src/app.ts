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
import helmet, {type HelmetOptions} from 'helmet'; // 7) Security headers
import compression from 'compression';          // 8) Gzip/deflate compression to reduce payload
import cookieParser from 'cookie-parser';       // 9) Parse cookies into req.cookies
import type {ServeStaticOptions} from 'serve-static'; // 10) TS type for static serving options
import rateLimit, {ipKeyGenerator} from 'express-rate-limit'; // 11) Rate limiting (IPv6-safe helper)

// Local modules (DB, routes, services, sockets, middlewares)
import Database from './configs/database';

// API route modules (keep your structure)
import UserRoute from './api/user';
import Tracking from './api/tracking';
import Property from './api/property';
import {PlacesController} from './api/PlacesController';
import Tenant from './api/tenant';
import FileTransfer from './api/fileTransfer';
import Lease from './api/lease';
import Validator from './api/validator';
import NotificationController from './controller/notification.controller';
import NotificationService from './services/notification.service';

// Background/cron-like example
import {AutoDeleteUserService} from './services/auto-delete.service';

// Socket.IO integration
import SocketServer from './socket/socket';
import type {Namespace} from 'socket.io';

// Project middlewares (your implementations)
import LoggerMiddleware from './middleware/logger';
import CorsDebug from './middleware/corsDebug';
import AuthMiddleware from './middleware/authMiddleware';
import Guards from './middleware/guards';

// Deep traffic monitor (your improved class)
import TrafficMonitor from './middleware/trafficMonitor';

// ─────────────────────────────────────────────────────────────────────────────
// Small runtime flags & constants
// ─────────────────────────────────────────────────────────────────────────────
const isProd = process.env.NODE_ENV === 'production'; // True in production
const APP_TAG = 'PropEase';                            // Console/log tag used across app

// Allowed hostnames (mitigate DNS rebinding / Host header attacks)
// Example: ALLOWED_HOSTS=localhost:3000,api.propease.app
const ALLOWED_HOSTS = new Set(
  String(process.env.ALLOWED_HOSTS || 'localhost:3000')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
);

// ─────────────────────────────────────────────────────────────────────────────
// Host header guard
// - Blocks requests whose `Host` header is not on the allowlist.
// - In dev we allow any localhost:* to reduce friction.
// - IMPORTANT: must call `return` after sending a response to avoid
//   "Cannot set headers after they are sent" errors.
// ─────────────────────────────────────────────────────────────────────────────
const hostGuard: RequestHandler = (req, res, next) => {
  const host = String(req.headers.host || '').toLowerCase();
  if(!host) {
    res.status(400).json({status: 'error', message: 'Bad Host header'});
    return;
  }
  if(!isProd && (host.startsWith('localhost:') || host.startsWith('127.0.0.1:'))) {
    next();
    return;
  }
  if(ALLOWED_HOSTS.has(host)) {
    next();
    return;
  }
  res.status(403).json({status: 'error', message: 'Forbidden host'});
  return;
};

// ─────────────────────────────────────────────────────────────────────────────
// Central error monitor: captures fatal events + provides Express error handler
// ─────────────────────────────────────────────────────────────────────────────
class InternalErrorMonitor {
  // Subscribe to process-level fatal events ASAP
  install(): void {
    process.on('uncaughtException', (err: any) => this.printFatal('Uncaught Exception', err));
    process.on('unhandledRejection', (reason: any) => this.printFatal('Unhandled Rejection', reason));
  }
  // One-liner summary with a timestamp
  private printFatal(kind: string, err: any) {
    const stamp = new Date().toISOString();
    console.error(`\n[FATAL ${stamp}] ${kind}`);
    if(err instanceof Error) console.error(this.formatError(err));
    else console.error(String(err));
  }
  // Keep error format compact and readable
  private formatError(err: Error): string {
    const header = `${err.name}: ${err.message}`;
    const stack = err.stack || '';
    return [header, ...stack.split('\n').slice(1)].join('\n');
  }
  // Express error handler (must be registered last)
  expressErrorHandler: ErrorRequestHandler = (err: any, req: Request, res: Response, _next: NextFunction) => {
    const reqId = (req as any).reqId || '-';
    const when = new Date().toISOString();
    console.error(`[${APP_TAG}] [${reqId}] [${when}] Unhandled error at ${req.method} ${req.originalUrl}`);
    if(err instanceof Error) console.error(this.formatError(err));
    else console.error(err);
    res.status(500).json({status: 'error', message: 'Internal Server Error'});
    return;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// App class (acts as server.ts)
// ─────────────────────────────────────────────────────────────────────────────
export default class App {
  // Core servers
  private app: Express = express();                 // Express app
  private httpServer = http.createServer(this.app); // HTTP server for Express + Socket.IO

  // Observability (your logger + deep monitor)
  private logger = new LoggerMiddleware({
    prefix: APP_TAG,
    userAgentTokens: 2,
  });
  private corsDebug = new CorsDebug({
    verbose: false,                                  // flip to true to diagnose CORS
    prefix: APP_TAG,
  });
  private errorMonitor = new InternalErrorMonitor();

  // Deep traffic monitor (writes JSONL logs; dev is quiet, prod echoes briefly)
  private monitor = new TrafficMonitor({
    logDir: path.join(process.cwd(), 'public', 'trace'),
    maxBodyBytes: isProd ? 256 : 1024,
    logHeaders: false,
    tag: APP_TAG,
    echoDev: false,
    echoProd: true,
  });

  // Socket.IO setup (origins controlled + JWT secret)
  private socketServer = new SocketServer({
    origins: [
      'http://localhost:4200',
      (process.env.FRONTEND_ORIGIN || '').trim() || undefined,
    ].filter(Boolean) as string[],
    jwtSecret: (process.env.JWT_SECRET || 'defaultsecret').trim(),
    allowCookieAuth: true,
  });
  private io: Namespace = this.socketServer.attach(this.httpServer);

  // Database
  private db = new Database();

  // Route modules
  private user = new UserRoute();
  private tracking = new Tracking();
  private property = new Property();
  private placesController = new PlacesController();
  private tenant = new Tenant();
  private fileTransfer = new FileTransfer();
  private lease = new Lease();
  private validator = new Validator();

  // Notifications (service + controller)
  private notificationService = new NotificationService();
  private notification = new NotificationController(this.notificationService, this.socketServer);

  // Background-job example (auto delete users)
  private autoDeleteUserService = new AutoDeleteUserService(this.io);

  // CORS policy (allowlist driven)
  private corsOptions: cors.CorsOptions = {
    origin: (origin, cb) => {
      // Build allowlist fresh each request (reflect latest env)
      const allowList = new Set<string>(
        ['http://localhost:4200', (process.env.FRONTEND_ORIGIN || '').trim()].filter(Boolean)
      );
      // No Origin header means same-origin (curl/server-to-server) → allow
      if(!origin || allowList.has(origin)) return cb(null, true);
      // Block unknown origins (don’t leak details)
      return cb(new Error('CORS: origin not allowed'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Requested-With'],
    optionsSuccessStatus: 204,
  };

  // Auth (JWT/cookie). Quiet in dev; short breadcrumbs in prod.
  private auth = new AuthMiddleware({
    jwtSecret: (process.env.JWT_SECRET || 'defaultsecret').trim(),
    allowCookieAuth: true,
    logger: (line) => {if(isProd) console.log(line);},
  });

  // DB readiness guard (returns 503 until connected)
  private databaseReadyGuard: RequestHandler = (_req, res, next) => {
    if(!this.db.isConnected()) {
      res.status(503).json({status: 'error', message: 'DB not ready'});
      return;
    }
    next();
    return;
  };

  // Global rate limiter (IPv6-safe; modest defaults; skip health)
  private rateLimiter = rateLimit({
    windowMs: isProd ? 60_000 : 30_000,  // 1m prod / 30s dev
    max: isProd ? 200 : 500,             // typical small API; tune as needed
    standardHeaders: true,               // send RateLimit-* headers
    legacyHeaders: false,                // drop old X-RateLimit-* headers

    // ✅ Type-correct, IPv6-aware generator (fixes prior validation error)
    keyGenerator: (req: Request, _res: Response): string => {
      if(req.ip === '::1' || req.ip === '127.0.0.1') return 'internal'; // local dev
      return ipKeyGenerator(req.ip || '', 64); // normalize IPv6 by /64, safe for proxies with trust proxy
    },

    skip: (req) => req.path === '/api/health', // never rate-limit health checks
  });

  constructor () {
    // Install process-level fatal error hooks early (before any awaits)
    this.errorMonitor.install();

    // Kick off async boot (connect DB, mount middlewares, routes…)
    this.boot().catch((err) => {
      console.error('Fatal boot error:', err);
      process.exit(1);
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Boot pipeline (order matters!)
  // ───────────────────────────────────────────────────────────────────────────
  private async boot(): Promise<void> {
    // 1) Connect to DB (fail fast if cannot connect)
    await this.db.connect();

    // 2) Optional DB handshake (e.g., change streams support)
    const hello = await this.db.handshake('prop-ease-api');

    // 3) Harden Express defaults
    this.app.disable('x-powered-by');  // Hide Express fingerprint
    this.app.set('trust proxy', 1);    // Needed behind proxy/LB to make req.ip accurate

    // 4) Earliest security gates
    this.app.use(hostGuard);                   // Enforce allowed Host headers
    this.app.use(this.logger.attachRequestId); // Attach reqId for all further logs

    // 5) CORS (plus dev preflight logger)
    if(!isProd) this.app.use(this.corsDebug.preflightLogger);
    this.app.use(cors(this.corsOptions));
    this.app.options(/.*/, cors(this.corsOptions));

    // 6) Helmet (security headers, CSP tuned per env)
    const FRONT = (process.env.FRONTEND_ORIGIN || '').trim();
    const helmetOptions: HelmetOptions = isProd
      ? {
        crossOriginEmbedderPolicy: false,
        crossOriginResourcePolicy: {policy: 'cross-origin'},
        contentSecurityPolicy: {
          useDefaults: true,
          directives: {
            "default-src": ["'self'"],
            "script-src": ["'self'"],
            "style-src": ["'self'", "'unsafe-inline'"], // allow inline styles (e.g., Material CDN)
            "img-src": ["'self'", "data:", "blob:"],
            "font-src": ["'self'", "data:"],
            "connect-src": ["'self'", ...(FRONT ? [FRONT] : []), "wss:", "https:"], // APIs + websockets
            "frame-ancestors": ["'none'"],
            "object-src": ["'none'"],
            "upgrade-insecure-requests": [],
          },
        },
      }
      : {
        crossOriginEmbedderPolicy: false,
        crossOriginResourcePolicy: {policy: 'cross-origin'},
        contentSecurityPolicy: false, // dev: keep CSP off (HMR/devtools/etc.)
      };
    this.app.use(helmet(helmetOptions));

    // 7) Compression (after headers)
    this.app.use(compression());

    // 8) Cookie parsing (for auth fallback/preferences)
    this.app.use(cookieParser());

    // 9) Global rate limit (simple abuse control)
    this.app.use(this.rateLimiter);

    // 10) Request logger (compact + safe)
    this.app.use(this.logger.requestLogger);

    // 11) Deep HTTP monitor + optional dev route spy
    this.monitor.installHttp(this.app);
    if(!isProd) this.monitor.spyOnRoutes(express);

    // 12) Views + body parsers (NO static here)
    this.configureParsersAndViews();

    // 13) Block sensitive public directories BEFORE static is mounted
    this.blockPublicDirs(this.denyListFromEnv());

    // 14) Now mount static files (/public)
    this.servePublicStatic();

    // 15) Make Socket.IO available via req.app for controllers
    this.attachSocketToApp();

    // 16) Socket traffic logs
    this.monitor.installSocket(this.io);

    // 17) Gate everything else on DB readiness
    this.app.use(this.databaseReadyGuard);

    // 18) Register routes (public vs protected)
    this.registerRoutes();

    // 19) Serve landing page at root (optional)
    this.indexPage();

    // 20) 404 + central error handler (must be the last middlewares)
    this.registerNotFoundAndErrorHandlers();

    // 21) Optional DB watchers (change streams)
    if(hello.changeStreams) {
      this.notificationService.watchChanges(this.io);
      if(!isProd) console.log('[notifications] Change streams enabled');
    } else {
      if(!isProd) console.log('[notifications] Change streams unavailable — running without watchers');
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Parsers & view engine (no static here—static comes later)
  // ───────────────────────────────────────────────────────────────────────────
  private configureParsersAndViews(): void {
    // Views (EJS)
    this.app.set('view engine', 'ejs');
    this.app.set('views', path.join(process.cwd(), 'public', 'view'));

    // JSON body parser (strict + size limit)
    this.app.use(express.json({
      limit: isProd ? '1mb' : '10mb',
      strict: true,
      type: ['application/json', 'application/*+json'],
    }));

    // URL-encoded parser for simple HTML forms
    this.app.use(express.urlencoded({
      extended: false,  // simple querystring parser
      limit: isProd ? '1mb' : '10mb',
    }));
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Static files out of /public (must mount AFTER blockPublicDirs)
  // ───────────────────────────────────────────────────────────────────────────
  private servePublicStatic(): void {
    const publicOptions: ServeStaticOptions = isProd
      ? {maxAge: '7d', immutable: true}  // production: let browsers cache
      : {};                                // dev: no cache (easier debugging)
    this.app.use(express.static(path.join(process.cwd(), 'public'), publicOptions));
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Make Socket.IO reachable via req.app for controllers that need it
  // ───────────────────────────────────────────────────────────────────────────
  private attachSocketToApp(): void {
    this.app.set('io', this.io); // access with req.app.get('io')
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Register REST routes (public & protected)
  // ───────────────────────────────────────────────────────────────────────────
  private registerRoutes(): void {
    // Diagnostics endpoint: shows CORS headers and request basics
    this.app.get('/api/diag', (req: Request, res: Response) => {
      const id = (req as any).reqId || '-';
      const info = {
        reqId: id,
        method: req.method,
        url: req.originalUrl,
        origin: req.headers.origin || '-',
        hasAuthHeader: !!req.headers.authorization,
        cookieKeys: Object.keys((req as any).cookies || {}),
        headers: {
          'access-control-request-method': req.headers['access-control-request-method'],
          'access-control-request-headers': req.headers['access-control-request-headers'],
        },
        time: new Date().toISOString(),
      };
      if(!isProd) console.log(`[${APP_TAG}] [${id}] /api/diag`, info); // dev-only noise
      res.json(info);
      return;
    });

    // Public / separately guarded APIs
    this.app.use('/api-user', this.user.route);
    this.app.use('/api-tracking', this.tracking.route);
    this.app.use('/api-property', this.property.route);
    this.app.use('/api-places', this.placesController.router);
    this.app.use('/api-tenant', this.tenant.route);
    this.app.use('/api-file-transfer', this.fileTransfer.route);
    this.app.use('/api-lease', this.lease.route);
    this.app.use('/api-validator', this.validator.route);

    // Notifications (protected)
    this.app.use('/api-notification', this.auth.handler, this.notification.router);

    // Health probe (for uptime monitors/orchestrators)
    this.app.get('/api/health', async (_req: Request, res: Response) => {
      const dbOk = this.db.isConnected() && (await this.db.ping().catch(() => false));
      res.json({
        status: dbOk ? 'ok' : 'degraded',
        db: {connected: this.db.isConnected(), ping: dbOk},
        socket: {namespace: this.io.name || '/', connected: true},
        timestamp: Date.now(),
      });
      return;
    });

    // Admin-only private static area (served from /public/adminsOnly)
    const adminsOnlyDir = path.join(process.cwd(), 'public', 'adminsOnly');
    this.app.use(
      '/adminsOnly',
      this.auth.handler,                 // ensure req.user is set
      Guards.requireRole('admin'),       // only role=admin
      (_req, res, next) => {             // no-cache for sensitive files
        res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        return next();
      },
      express.static(adminsOnlyDir, {fallthrough: false}) // 404 if file not found; no directory listing
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // *Reusable* deny list for public subfolders
  // - Mounts BEFORE express.static so it always wins
  // - Use env: PUBLIC_DENY_DIRS="recyclebin,backups,adminsOnly/private"
  // - This prevents accidental exposure of sensitive folders
  // ───────────────────────────────────────────────────────────────────────────
  private blockPublicDirs(dirs: string[]): void {
    // Normalize into unique, lower-cased, slash-trimmed paths
    const deny = Array.from(
      new Set(
        dirs
          .map(s => String(s || '').trim().replace(/^\/+|\/+$/g, ''))
          .filter(Boolean)
          .map(s => s.toLowerCase())
      )
    );
    if(deny.length === 0) return;

    // Quick filter: first-level segments ("recyclebin", "backups", "adminsonly")
    const topLevels = new Set(deny.map(d => d.split('/')[0]));

    this.app.use((req: Request, res: Response, next: NextFunction) => {
      // req.path has no querystring and begins with "/"
      const p = req.path.toLowerCase().replace(/^\/+/, '');
      const [first] = p.split('/');

      // Fast reject if first segment is not in deny set
      if(!topLevels.has(first)) {
        next();
        return;
      }

      // Check for nested blocks (like "adminsOnly/private")
      const matchesNested = deny.some(d => p === d || p.startsWith(d + '/'));
      if(!matchesNested) {
        next();
        return;
      }

      // Deny with no-cache headers
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
      res.setHeader('Pragma', 'no-cache');
      if(!isProd) console.warn(`[DENY] Attempt to access /${p}`);
      res.status(403).send('Forbidden');
      return;
    });
  }

  // Parse PUBLIC_DENY_DIRS from env; default to "recyclebin"
  private denyListFromEnv(): string[] {
    const raw = (process.env.PUBLIC_DENY_DIRS || 'recyclebin').split(',');
    return raw.map(s => s.trim()).filter(Boolean);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Serve a static landing page at "/"
  // ───────────────────────────────────────────────────────────────────────────
  private indexPage(): void {
    this.app.get('/', (_req: Request, res: Response) => {
      res.sendFile(path.join(process.cwd(), 'public', 'index.html'), (err) => {
        if(err) {
          console.error(err);
          return res.status(500).send('Internal Server Error');
        }
      });
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 404 + centralized error handler (must be the last middlewares)
  // ───────────────────────────────────────────────────────────────────────────
  private registerNotFoundAndErrorHandlers(): void {
    // Not found handler
    this.app.use((_req, res) => {
      res.status(404).json({status: 'error', message: 'Not Found'});
      return;
    });
    // Centralized error handler
    this.app.use(this.errorMonitor.expressErrorHandler);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Start server + graceful shutdown
  // ───────────────────────────────────────────────────────────────────────────
  public listen(port: number): void {
    // Bind on all interfaces (container/k8s friendly)
    this.httpServer.listen(port, '0.0.0.0', () => {
      console.log(`🚀 ${APP_TAG} API on http://localhost:${port}  (Socket.IO ready)`);
    });

    // Graceful shutdown on SIGINT/SIGTERM
    const shutdown = async (signal: 'SIGINT' | 'SIGTERM') => {
      console.log(`\n${signal} received — shutting down…`);
      this.httpServer.close(() => console.log('HTTP server closed.'));
      try {
        await this.db.close();
      } finally {
        // Failsafe exit if something hangs
        setTimeout(() => process.exit(0), 1500).unref();
      }
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap (construct + listen)
// ─────────────────────────────────────────────────────────────────────────────
const server = new App();
server.listen(Number(process.env.PORT) || 3000);
