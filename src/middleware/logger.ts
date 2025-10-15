// src/middleware/logger.ts
import {Request, Response, NextFunction, RequestHandler} from 'express';
import {randomUUID} from 'crypto';

export type LoggerOptions = {
    /** Truncate user-agent to first N tokens for brevity */
    userAgentTokens?: number;
    /** Prefix all log lines (e.g., service name) */
    prefix?: string;
};

export default class LoggerMiddleware {
    private readonly userAgentTokens: number;
    private readonly prefix: string;

    constructor (options?: LoggerOptions) {
        this.userAgentTokens = options?.userAgentTokens ?? 2;
        this.prefix = options?.prefix ? `[${options.prefix}] ` : '';
    }

    /** Attaches a correlation ID to every request (req.reqId) */
    attachRequestId: RequestHandler = (req: Request, _res: Response, next: NextFunction) => {
        (req as any).reqId = (req.headers['x-request-id'] as string) || randomUUID();
        next();
    };

    /** One-line access log with timing + result status */
    requestLogger: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
        const start = process.hrtime.bigint();
        const id = (req as any).reqId;
        const origin = req.headers.origin || '-';
        const ua = (req.headers['user-agent'] || '')
            .split(' ')
            .slice(0, this.userAgentTokens)
            .join(' ');
        const method = req.method;
        const path = req.originalUrl;

        // Let other middlewares/handlers run, then log on finish
        res.on('finish', () => {
            const durMs = Number((process.hrtime.bigint() - start) / BigInt(1_000_000));
            const status = res.statusCode;
            console.log(`${this.prefix}[${id}] ${method} ${path} ←${origin} ua=${ua} → ${status} (${durMs}ms)`);
        });

        next();
    };

    /** Helper to format an error line with reqId (used by error handlers) */
    static formatErrorLine(err: unknown, req?: Request): string {
        const id = req ? (req as any).reqId : undefined;
        const head = id ? `[${id}]` : '[∅]';
        if(err instanceof Error) {
            return `${head} ${err.name}: ${err.message}`;
        }
        return `${head} ${String(err)}`;
    }
}
