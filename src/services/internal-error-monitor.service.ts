// Path: src/services/internal-error-monitor.service.ts

import {
  type ErrorRequestHandler,
  type NextFunction,
  type Request,
  type Response
} from 'express';
import { ApiResponseBuilder } from '../utils/api-combiner.builder';

export class InternalErrorMonitor {
  private readonly appTag: string;

  public constructor(appTag: string) {
    this.appTag = appTag;
  }

  public install(): void {
    process.on('uncaughtException', (err: unknown) =>
      this.printFatal('Uncaught Exception', err)
    );
    process.on('unhandledRejection', (reason: unknown) =>
      this.printFatal('Unhandled Rejection', reason)
    );
  }

  private printFatal(kind: string, err: unknown): void {
    const stamp: string = new Date().toISOString();
    // You can later upgrade this to a proper logger
    // eslint-disable-next-line no-console
    console.error(`\n[FATAL ${stamp}] ${kind}`);
    if (err instanceof Error) {
      // eslint-disable-next-line no-console
      console.error(this.formatError(err));
    } else {
      // eslint-disable-next-line no-console
      console.error(String(err));
    }
  }

  private formatError(err: Error): string {
    const header: string = `${err.name}: ${err.message}`;
    const stack: string = err.stack ?? '';
    return [header, ...stack.split('\n').slice(1)].join('\n');
  }

  public getExpressErrorHandler(): ErrorRequestHandler {
    const handler: ErrorRequestHandler = (
      err: unknown,
      req: Request,
      res: Response,
      _next: NextFunction
    ) => {
      const reqId: string = (req as any).reqId || '-';
      const when: string = new Date().toISOString();

      // eslint-disable-next-line no-console
      console.error(
        `[${this.appTag}] [${reqId}] [${when}] Unhandled error at ${req.method} ${req.originalUrl}`
      );

      if (err instanceof Error) {
        // eslint-disable-next-line no-console
        console.error(this.formatError(err));
      } else {
        // eslint-disable-next-line no-console
        console.error(err);
      }

      ApiResponseBuilder.internalError(res, err);
      return;
    };

    return handler;
  }
}
