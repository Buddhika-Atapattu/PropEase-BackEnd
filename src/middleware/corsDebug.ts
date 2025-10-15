// src/middleware/corsDebug.ts
import { Request, Response, NextFunction, RequestHandler } from 'express';

export type CorsDebugOptions = {
  /** Include request headers dump (safe subset) */
  verbose?: boolean;
  /** Optional prefix for lines */
  prefix?: string;
};

export default class CorsDebug {
  private readonly verbose: boolean;
  private readonly prefix: string;

  constructor(options?: CorsDebugOptions) {
    this.verbose = !!options?.verbose;
    this.prefix = options?.prefix ? `[${options.prefix}] ` : '';
  }

  /** Logs every CORS preflight so you can see what the browser asked for */
  preflightLogger: RequestHandler = (req: Request, _res: Response, next: NextFunction) => {
    if (req.method !== 'OPTIONS') return next();

    const id = (req as any).reqId || '-';
    const origin = req.headers.origin || '-';
    const reqMethod = req.headers['access-control-request-method'];
    const reqHeaders = req.headers['access-control-request-headers'];

    let line = `${this.prefix}[${id}] [CORS] Preflight OPTIONS ${req.originalUrl} from ${origin}; `;
    line += `requestMethod=${reqMethod}; requestHeaders=${reqHeaders}`;
    console.log(line);

    if (this.verbose) {
      // Print a safe subset of headers for debugging
      console.log(`${this.prefix}[${id}] [CORS] headers:`, {
        origin: req.headers.origin,
        'access-control-request-method': req.headers['access-control-request-method'],
        'access-control-request-headers': req.headers['access-control-request-headers'],
      });
    }

    next();
  };
}
