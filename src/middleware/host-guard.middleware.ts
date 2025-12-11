// Path: src/middleware/host-guard.middleware.ts

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { ApiResponseBuilder } from '../utils/api-combiner.builder';

export class HostGuardMiddleware {
  private readonly allowedHosts: Set<string>;
  private readonly isProd: boolean;
  private readonly appTag: string;

  public constructor(allowedHosts: Set<string>, isProd: boolean, appTag: string) {
    this.allowedHosts = allowedHosts;
    this.isProd = isProd;
    this.appTag = appTag;
  }

  public getMiddleware(): RequestHandler {
    const middleware: RequestHandler = (
      req: Request,
      res: Response,
      next: NextFunction
    ) => {
      const host: string = String(req.headers.host ?? '').toLowerCase();

      if (!host) {
        ApiResponseBuilder.badRequest(res, 'Bad Host header');
        return;
      }

      // Dev: allow localhost / 127.0.0.1 on any port to reduce friction
      if (
        !this.isProd &&
        (host.startsWith('localhost:') || host.startsWith('127.0.0.1:'))
      ) {
        next();
        return;
      }

      if (this.allowedHosts.has(host)) {
        next();
        return;
      }

      // eslint-disable-next-line no-console
      console.warn(`[Warning:][${this.appTag}] Forbidden host: ${host}`,'\n');
      ApiResponseBuilder.error(res, 403, 'Forbidden host');
      return;
    };

    return middleware;
  }
}
