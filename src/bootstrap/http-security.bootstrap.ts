// Path: src/bootstrap/http-security.bootstrap.ts

import path from 'path';
import type {
  Express,
  Request,
  Response,
  NextFunction,
  RequestHandler
} from 'express';
import express from 'express';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import type { ServeStaticOptions } from 'serve-static';
import helmet, { type HelmetOptions } from 'helmet';
import cors from 'cors';

import LoggerMiddleware from '../middleware/logger';
import CorsDebug from '../middleware/corsDebug';
import TrafficMonitor from '../middleware/trafficMonitor';
import { HostGuardMiddleware } from '../middleware/host-guard.middleware';
import { PUBLIC_DENY_DIRS, FRONTEND_ORIGIN, NODE_ENV } from '../configs/env.config';

const isProd: boolean = NODE_ENV === 'production';

export class HttpSecurityBootstrap {
  private readonly app: Express;
  private readonly logger: LoggerMiddleware;
  private readonly corsDebug: CorsDebug;
  private readonly monitor: TrafficMonitor;
  private readonly rateLimiter: RequestHandler;
  private readonly corsOptions: cors.CorsOptions;
  private readonly hostGuardMiddleware: HostGuardMiddleware;

  public constructor(
    app: Express,
    logger: LoggerMiddleware,
    corsDebug: CorsDebug,
    monitor: TrafficMonitor,
    rateLimiter: RequestHandler,
    corsOptions: cors.CorsOptions,
    hostGuardMiddleware: HostGuardMiddleware
  ) {
    this.app = app;
    this.logger = logger;
    this.corsDebug = corsDebug;
    this.monitor = monitor;
    this.rateLimiter = rateLimiter;
    this.corsOptions = corsOptions;
    this.hostGuardMiddleware = hostGuardMiddleware;
  }

  /**
   * Configure core security + logging + monitoring in correct order.
   */
  public configureCoreSecurity(): void {
    // Harden Express defaults
    this.app.disable('x-powered-by');
    this.app.set('trust proxy', 1);

    // Earliest: host guard + request ID
    this.app.use(this.hostGuardMiddleware.getMiddleware());
    this.app.use(this.logger.attachRequestId);

    // CORS + dev preflight logging
    if (!isProd) {
      this.app.use(this.corsDebug.preflightLogger);
    }
    this.app.use(cors(this.corsOptions));
    this.app.options(/.*/, cors(this.corsOptions));

    // Helmet
    const FRONT: string = (FRONTEND_ORIGIN || '').trim();
    const helmetOptions: HelmetOptions = isProd
      ? {
          crossOriginEmbedderPolicy: false,
          crossOriginResourcePolicy: { policy: 'cross-origin' },
          contentSecurityPolicy: {
            useDefaults: true,
            directives: {
              'default-src': ["'self'"],
              'script-src': ["'self'"],
              'style-src': ["'self'", "'unsafe-inline'"],
              'img-src': ["'self'", 'data:', 'blob:'],
              'font-src': ["'self'", 'data:'],
              'connect-src': [
                "'self'",
                ...(FRONT ? [FRONT] : []),
                'wss:',
                'https:'
              ],
              'frame-ancestors': ["'none'"],
              'object-src': ["'none'"],
              'upgrade-insecure-requests': []
            }
          }
        }
      : {
          crossOriginEmbedderPolicy: false,
          crossOriginResourcePolicy: { policy: 'cross-origin' },
          contentSecurityPolicy: false
        };

    this.app.use(helmet(helmetOptions));

    // Compression
    this.app.use(compression());

    // Cookie parsing
    this.app.use(cookieParser());

    // Global rate limit
    this.app.use(this.rateLimiter);

    // Request logging
    this.app.use(this.logger.requestLogger);

    // Deep HTTP monitor
    this.monitor.installHttp(this.app);
    if (!isProd) {
      this.monitor.spyOnRoutes(express);
    }
  }

  /**
   * Configure view engine + JSON/urlencoded parsers.
   */
  public configureParsersAndViews(): void {
    this.app.set('view engine', 'ejs');
    this.app.set('views', path.join(process.cwd(), 'public', 'view'));

    this.app.use(
      express.json({
        limit: isProd ? '1mb' : '10mb',
        strict: true,
        type: ['application/json', 'application/*+json']
      })
    );

    this.app.use(
      express.urlencoded({
        extended: false,
        limit: isProd ? '1mb' : '10mb'
      })
    );
  }

  /**
   * Deny sensitive /public subfolders and mount /public static.
   */
  public configureStaticAndDenyList(): void {
    this.blockPublicDirs(this.denyListFromEnv());
    this.servePublicStatic();
  }

  private servePublicStatic(): void {
    const publicOptions: ServeStaticOptions = isProd
      ? { maxAge: '7d', immutable: true }
      : {};
    this.app.use(
      express.static(path.join(process.cwd(), 'public'), publicOptions)
    );
  }

  private blockPublicDirs(dirs: string[]): void {
    const deny: string[] = Array.from(
      new Set(
        dirs
          .map((s: string) =>
            String(s || '')
              .trim()
              .replace(/^\/+|\/+$/g, '')
          )
          .filter(Boolean)
          .map((s: string) => s.toLowerCase())
      )
    );

    if (deny.length === 0) {
      return;
    }

    const topLevels: Set<string> = new Set(
      deny
        .map((d: string) => d.split('/')[0])
        .filter((segment): segment is string => Boolean(segment))
    );

    this.app.use((req: Request, res: Response, next: NextFunction) => {
      const p: string = req.path.toLowerCase().replace(/^\/+/, '');
      const first: string = p.split('/')[0] || '';

      if (!topLevels.has(first)) {
        next();
        return;
      }

      const matchesNested: boolean = deny.some(
        (d: string) => p === d || p.startsWith(d + '/')
      );

      if (!matchesNested) {
        next();
        return;
      }

      res.setHeader(
        'Cache-Control',
        'no-store, no-cache, must-revalidate, private'
      );
      res.setHeader('Pragma', 'no-cache');
      if (!isProd) {
        // eslint-disable-next-line no-console
        console.warn(`[DENY] Attempt to access /${p}`);
      }
      res.status(403).send('Forbidden');
      return;
    });
  }

  private denyListFromEnv(): string[] {
    const raw: string[] = String(PUBLIC_DENY_DIRS).split(',');
    return raw.map((s: string) => s.trim()).filter(Boolean);
  }
}
