// src/app.ts
import 'dotenv/config';
import 'source-map-support/register'; // map JS stacks to TS file:line
import express, {Express, Request, Response, NextFunction} from 'express';
import http from 'http';
import path from 'path';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';

// ─── Your existing modules ────────────────────────────────────────────────────
import Database from './configs/database';

// API routes
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

// Services
import {AutoDeleteUserService} from './services/auto-delete.service';

// Socket.IO (class-based server)
import SocketServer from './socket/socket';
import type {Namespace} from 'socket.io';

// Middlewares (class-based)
import LoggerMiddleware from './middleware/logger';
import CorsDebug from './middleware/corsDebug';
import AuthMiddleware from './middleware/authMiddleware';

// NEW: deep traffic & route monitor
import TrafficMonitor from './middleware/trafficMonitor';

// ─── Internal Error Monitor ───────────────────────────────────────────────────
class InternalErrorMonitor {
  install(): void {
    process.on('uncaughtException', (err: any) => this.printFatal('Uncaught Exception', err));
    process.on('unhandledRejection', (reason: any) => this.printFatal('Unhandled Rejection', reason));
  }
  private printFatal(kind: string, err: any) {
    const stamp = new Date().toISOString();
    console.error(`\n[FATAL ${stamp}] ${kind}`);
    if(err instanceof Error) console.error(this.formatError(err));
    else console.error(String(err));
  }
  private formatError(err: Error): string {
    const header = `${err.name}: ${err.message}`;
    const stack = err.stack || '';
    return [header, ...stack.split('\n').slice(1)].join('\n');
  }
  expressErrorHandler = (err: any, req: Request, res: Response, _next: NextFunction) => {
    const reqId = (req as any).reqId || '-';
    const when = new Date().toISOString();
    console.error(`[${reqId}] [${when}] Unhandled error at ${req.method} ${req.originalUrl}`);
    if(err instanceof Error) console.error(this.formatError(err));
    else console.error(err);
    res.status(500).json({status: 'error', message: 'Internal Server Error'});
  };
}

// ─── The App ─────────────────────────────────────────────────────────────────
export default class App {
  private app: Express = express();
  private httpServer = http.createServer(this.app);

  private logger = new LoggerMiddleware({prefix: 'PropEase', userAgentTokens: 2});
  private corsDebug = new CorsDebug({verbose: false, prefix: 'PropEase'});
  private errorMonitor = new InternalErrorMonitor();

  // NEW: traffic & route monitor
  private monitor = new TrafficMonitor({
    logDir: path.join(process.cwd(), 'public', 'trace'),
    maxBodyBytes: 1024,
    logHeaders: false,
    echo: false, // set true to also echo JSON lines in console
  });

  // Socket.IO
  private socketServer = new SocketServer({
    origins: [
      'http://localhost:4200',
      (process.env.FRONTEND_ORIGIN || '').trim() || undefined,
    ].filter(Boolean) as string[],
    jwtSecret: process.env.JWT_SECRET || 'defaultsecret',
    allowCookieAuth: true,
  });
  private io: Namespace = this.socketServer.attach(this.httpServer);

  // DB
  private db = new Database();

  // Routes / Controllers / Services
  private user = new UserRoute();
  private tracking = new Tracking();
  private property = new Property();
  private placesController = new PlacesController();
  private tenant = new Tenant();
  private fileTransfer = new FileTransfer();
  private lease = new Lease();
  private validator = new Validator();

  private notificationService = new NotificationService();
  private notification = new NotificationController(this.notificationService, this.socketServer);

  private autoDeleteUserService = new AutoDeleteUserService(this.io);

  // CORS options centralised
  private corsOptions: cors.CorsOptions = {
    origin: [
      'http://localhost:4200',
      (process.env.FRONTEND_ORIGIN || '').trim() || undefined,
    ].filter(Boolean) as string[],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Requested-With'],
    optionsSuccessStatus: 204,
  };

  // Auth (class-based)
  private auth = new AuthMiddleware({
    jwtSecret: process.env.JWT_SECRET || 'defaultsecret',
    allowCookieAuth: true,
    logger: (line) => console.log(line),
  });

  constructor () {
    this.errorMonitor.install();
    this.boot().catch((err) => {
      console.error('Fatal boot error:', err);
      process.exit(1);
    });
  }

  /** Full boot sequence */
  private async boot(): Promise<void> {
    // 1) DB
    await this.db.connect();

    // 2) Handshake
    const hello = await this.db.handshake('prop-ease-api');

    // 3) Core middlewares (ORDER MATTERS)
    this.app.use(this.logger.attachRequestId);        // reqId first
    this.app.use(this.corsDebug.preflightLogger);     // preflight logs
    this.app.use(cors(this.corsOptions));
    this.app.options('*', cors(this.corsOptions));    // ensure 204 preflight
    this.app.use(helmet());
    this.app.use(compression());
    this.app.use(cookieParser());
    this.app.use(this.logger.requestLogger);          // access log

    // 3.5) Install HTTP traffic monitor EARLY (logs all requests/responses)
    this.monitor.installHttp(this.app);

    // 3.6) Spy on route registrations BEFORE you register routes
    this.monitor.spyOnRoutes(express);

    // 4) App config
    this.configureApp();

    // 5) Attach socket namespace to express
    this.attachSocketToApp();

    // 5.5) Tap Socket.IO events
    this.monitor.installSocket(this.io);

    // 6) Routes
    this.registerRoutes();

    // 7) Index page
    this.indexPage();

    // 8) Errors
    this.registerNotFoundAndErrorHandlers();

    // 9) Watchers
    if(hello.changeStreams) {
      this.notificationService.watchChanges(this.io);
      console.log('[notifications] Change streams enabled');
    } else {
      console.log('[notifications] Change streams unavailable — running without watchers');
    }
  }

  private configureApp(): void {
    // this.app.set('trust proxy', 1);
    this.app.set('view engine', 'ejs');
    this.app.set('views', path.join(process.cwd(), 'public', 'view'));
    this.app.use(express.json({limit: '10mb'}));
    this.app.use(express.urlencoded({extended: true}));
    this.app.use(express.static(path.join(process.cwd(), 'public')));
  }

  private attachSocketToApp(): void {
    this.app.set('io', this.io);
  }

  private registerRoutes(): void {
    // Diagnostics — shows what the server actually sees
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
      console.log(`[${id}] /api/diag`, info);
      res.json(info);
    });

    // Public or separately-protected routes
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

    // Health check
    this.app.get('/api/health', async (_req: Request, res: Response) => {
      const dbOk = this.db.isConnected() && (await this.db.ping().catch(() => false));
      const summary = {
        status: dbOk ? 'ok' : 'degraded',
        db: {connected: this.db.isConnected(), ping: dbOk},
        socket: {namespace: this.io.name || '/', connected: true},
        timestamp: Date.now(),
      };
      res.json(summary);
    });
  }

  private indexPage(): void {
    this.app.get('/', (_req: Request, res: Response) => {
      res.sendFile(path.join(process.cwd(), 'public', 'index.html'), (err) => {
        if(err) {
          console.error(err);
          res.status(500).send('Internal Server Error');
        }
      });
    });
  }

  private registerNotFoundAndErrorHandlers(): void {
    // 404
    this.app.use((_req, res) => {
      res.status(404).json({status: 'error', message: 'Not Found'});
    });

    // Last-resort error handler
    this.app.use(this.errorMonitor.expressErrorHandler);
  }

  public listen(port: number): void {
    this.httpServer.listen(port, '0.0.0.0', () => {
      console.log(`🚀 Server running on http://localhost:${port} (Socket.IO + handshake ready)`);
    });

    const shutdown = async (signal: 'SIGINT' | 'SIGTERM') => {
      console.log(`\n${signal} received — shutting down…`);
      this.httpServer.close(() => console.log('HTTP server closed.'));
      try {await this.db.close();} finally {
        setTimeout(() => process.exit(0), 1500).unref();
      }
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  }
}

// Bootstrap
const server = new App();
server.listen(Number(process.env.PORT) || 3000);
