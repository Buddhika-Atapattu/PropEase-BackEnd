// src/middleware/authMiddleware.ts
import {Request, Response, NextFunction, RequestHandler} from 'express';
import jwt from 'jsonwebtoken';
import {Role} from '../types/roles';

declare global {
    namespace Express {
        interface UserPayload {username: string; role: Role}
        interface Request {user?: UserPayload}
    }
}

export type AuthOptions = {
    jwtSecret: string;
    allowCookieAuth?: boolean;
    logger?: (line: string) => void;
    /** If provided, restrict this instance to these roles; default [] means "no restriction" */
    allowedRoles?: ReadonlyArray<Role>;
};

export default class AuthMiddleware {
    private readonly secret: string;
    private readonly allowCookie: boolean;
    private readonly log: (line: string) => void;
    /** Always a defined array (possibly empty) to satisfy exactOptionalPropertyTypes */
    private readonly allowedRoles: ReadonlyArray<Role>;

    constructor (opts: AuthOptions) {
        this.secret = opts.jwtSecret;
        this.allowCookie = opts.allowCookieAuth ?? true;
        this.log = opts.logger ?? console.log;
        // Normalize to a non-optional, immutable array
        this.allowedRoles = Object.freeze([...(opts.allowedRoles ?? [])]);
    }

    /** Shared helper: end response with a code/message and keep RequestHandler return type as void */
    private deny(res: Response, code: number, message: string): void {
        res.status(code).json({message});
    }

    /** Extract bearer/cookie token (no side effects) */
    private extractToken(req: Request): string | undefined {
        const header = req.headers.authorization || '';
        const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
        const cookieToken = this.allowCookie ? (req as any).cookies?.token : undefined;
        return bearer || cookieToken;
    }

    /** Verify JWT safely; returns payload or undefined (and logs reason) */
    private verifyToken(token: string, reqId: string): {username: string; role: Role} | undefined {
        try {
            return jwt.verify(token, this.secret) as {username: string; role: Role};
        } catch(e: any) {
            this.log(`[${reqId}] AUTH invalid token: ${e?.name || 'Error'} – ${e?.message || ''}`);
            return undefined;
        }
    }

    /** Use this for normal protected routes (keeps RequestHandler signature) */
    public handler: RequestHandler = (req: Request, res: Response, next: NextFunction): void => {
        if(req.method === 'OPTIONS') {next(); return;} // never block preflight

        const id = (req as any).reqId || '-';
        const token = this.extractToken(req);

        if(!token) {
            this.log(`[${id}] AUTH miss: no token (bearer/cookie). url=${req.originalUrl}`);
            this.deny(res, 401, 'Unauthorized');
            return;
        }

        const payload = this.verifyToken(token, id);
        if(!payload) {
            this.deny(res, 401, 'Unauthorized');
            return;
        }

        req.user = {username: payload.username, role: payload.role};

        // If roles are configured (non-empty), enforce
        if(this.allowedRoles.length && !this.allowedRoles.includes(payload.role)) {
            this.log(
                `[${id}] AUTH forbidden: user=${payload.username} role=${payload.role} disallowed for ${req.originalUrl}`
            );
            this.deny(res, 403, 'Forbidden');
            return;
        }

        this.log(`[${id}] AUTH ok user=${payload.username} role=${payload.role}`);
        next();
    };

    /**
     * Route-specific role filter:
     *   app.use('/admin', auth.roles(['admin']), adminRouter)
     */
    public roles(roles: ReadonlyArray<Role>): RequestHandler {
        // Normalize once to avoid undefined and satisfy exactOptionalPropertyTypes
        const allowed = Object.freeze([...(roles ?? [])]);

        return (req: Request, res: Response, next: NextFunction): void => {
            if(req.method === 'OPTIONS') {next(); return;}

            const id = (req as any).reqId || '-';
            const token = this.extractToken(req);

            if(!token) {
                this.log(`[${id}] AUTH miss: no token (bearer/cookie). url=${req.originalUrl}`);
                this.deny(res, 401, 'Unauthorized');
                return;
            }

            const payload = this.verifyToken(token, id);
            if(!payload) {
                this.deny(res, 401, 'Unauthorized');
                return;
            }

            req.user = {username: payload.username, role: payload.role};

            if(allowed.length && !allowed.includes(payload.role)) {
                this.log(
                    `[${id}] AUTH forbidden: user=${payload.username} role=${payload.role} disallowed for ${req.originalUrl}`
                );
                this.deny(res, 403, 'Forbidden');
                return;
            }

            this.log(`[${id}] AUTH ok user=${payload.username} role=${payload.role}`);
            next();
        };
    }
}
