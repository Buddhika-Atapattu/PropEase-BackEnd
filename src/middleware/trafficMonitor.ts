// src/middleware/trafficMonitor.ts
import fs from 'fs';
import path from 'path';
import type {Express, Request, Response, NextFunction} from 'express';
import type {Namespace, Socket} from 'socket.io';

export type TrafficMonitorOptions = {
    logDir?: string;
    maxBodyBytes?: number;
    logHeaders?: boolean;
    echo?: boolean;
};

export default class TrafficMonitor {
    private readonly baseDir: string;
    private readonly maxBody: number;
    private readonly logHeaders: boolean;
    private readonly echo: boolean;

    constructor (opts: TrafficMonitorOptions = {}) {
        this.baseDir = opts.logDir || path.join(process.cwd(), 'public', 'trace');
        this.maxBody = Math.max(0, opts.maxBodyBytes ?? 1024);
        this.logHeaders = !!opts.logHeaders;
        this.echo = opts.echo ?? true;

        fs.mkdirSync(this.baseDir, {recursive: true});
    }

    /** Install HTTP request/response logger */
    installHttp(app: Express) {
        // Attach reqId if not set
        app.use((req, _res, next) => {
            if(!(req as any).reqId) (req as any).reqId = this.makeReqId();
            next();
        });

        app.use((req: Request, res: Response, next: NextFunction) => {
            const startedAt = Date.now();
            const reqId = (req as any).reqId as string;

            // Capture a small, safe sample of request body
            let reqBodySample: any = undefined;
            try {
                if((req as any).rawBody) {
                    reqBodySample = this.sliceBody((req as any).rawBody);
                } else if(req.body && typeof req.body === 'object') {
                    const str = JSON.stringify(req.body);
                    reqBodySample = this.sliceBody(Buffer.from(str));
                }
            } catch {/* ignore */}

            const onFinish = () => {
                res.removeListener('close', onFinish);
                res.removeListener('finish', onFinish);

                const durationMs = Date.now() - startedAt;
                const routePath = (req.route?.path || (req as any).routePath || null);
                const baseUrl = (req.baseUrl || null);

                const status = res.statusCode;
                const headers = this.logHeaders ? res.getHeaders() : undefined;
                const contentLength = Number(res.getHeader('content-length') || 0) || undefined;

                const line = {
                    t: new Date().toISOString(),
                    type: 'http',
                    reqId,
                    method: req.method,
                    url: req.originalUrl,
                    baseUrl,
                    route: routePath,
                    status,
                    durationMs,
                    ip: (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || '',
                    req: {
                        headers: this.logHeaders ? req.headers : {
                            origin: req.headers.origin,
                            referer: req.headers.referer,
                            'user-agent': req.headers['user-agent'],
                            host: req.headers.host,
                        },
                        bodySample: reqBodySample,
                    },
                    res: {
                        headers,
                        contentLength,
                    },
                };

                this.writeLine(this.fileFor('http'), line);
            };

            res.on('finish', onFinish);
            res.on('close', onFinish);
            next();
        });
    }

    /**
     * Spy on route registrations to find broken patterns and where they were registered.
     * We patch Express' app/router methods and log {method, path, file:line:col}.
     */
    spyOnRoutes(expressModule: any) {
        const methods = ['use', 'get', 'post', 'put', 'patch', 'delete', 'options', 'all'] as const;

        const patch = (obj: any, label: 'app' | 'router') => {
            const self = this; // capture class context

            for(const m of methods) {
                const orig = obj[m];
                if(typeof orig !== 'function') continue;

                // NOTE: 'this' inside this function is the Express app/router. We don't use it to call class methods.
                obj[m] = function(this: any, firstArg: any, ...rest: any[]) {
                    try {
                        if(typeof firstArg === 'string') {
                            const where = getCallerFrame();
                            const line = {
                                t: new Date().toISOString(),
                                type: 'route',
                                layer: label,
                                method: m,
                                path: firstArg,
                                where,
                            };

                            // If the first handler is a function, stash the path for later http logs
                            if(rest.length > 0 && typeof rest[0] === 'function') {
                                (rest[0] as any).routePath = firstArg;
                            }

                            self.writeLine(self.fileFor('routes'), line);
                        }
                    } catch {
                        // best effort logging only
                    }
                    return orig.apply(this, [firstArg, ...rest]);
                };
            }
        };

        // Patch the application prototype
        const AppProto = (expressModule.application || (expressModule as any).application || (expressModule as any));
        patch(AppProto, 'app');

        // Patch the Router prototype
        const RouterProto = (expressModule.Router && (expressModule.Router as any).prototype);
        if(RouterProto) patch(RouterProto, 'router');
    }

    /** Attach Socket.IO event logging */
    installSocket(io: Namespace) {
        io.on('connection', (socket: Socket) => {
            const reqId = (socket.handshake as any).reqId || this.makeReqId();
            const auth = (socket.data && (socket.data as any).authUser) || {};
            this.writeLine(this.fileFor('socket'), {
                t: new Date().toISOString(),
                type: 'socket-connect',
                reqId,
                id: socket.id,
                user: {username: auth.username, role: auth.role},
                ip: socket.handshake.address,
                ua: socket.handshake.headers['user-agent'],
            });

            const origOnevent = (socket as any).onevent;
            (socket as any).onevent = (packet: any) => {
                try {
                    const [eventName, payload] = Array.isArray(packet.data) ? [packet.data[0], packet.data[1]] : [undefined, undefined];
                    const size = safeSize(payload);
                    this.writeLine(this.fileFor('socket'), {
                        t: new Date().toISOString(),
                        type: 'socket-event-in',
                        id: socket.id,
                        user: {username: auth.username, role: auth.role},
                        event: eventName,
                        payloadSize: size,
                    });
                } catch {/* ignore */}
                return origOnevent.call(socket, packet);
            };

            socket.on('disconnect', (reason) => {
                this.writeLine(this.fileFor('socket'), {
                    t: new Date().toISOString(),
                    type: 'socket-disconnect',
                    id: socket.id,
                    reason,
                });
            });
        });
    }

    // ─────────────────────────── Internals ───────────────────────────

    private fileFor(kind: 'http' | 'socket' | 'routes'): string {
        const d = new Date();
        const y = d.getFullYear();
        const m = `${d.getMonth() + 1}`.padStart(2, '0');
        const day = `${d.getDate()}`.padStart(2, '0');
        return path.join(this.baseDir, `${kind}-${y}-${m}-${day}.log`);
    }

    private writeLine(file: string, obj: unknown) {
        const line = JSON.stringify(obj);
        try {
            fs.appendFileSync(file, line + '\n', 'utf8');
            if(this.echo) console.log(line);
        } catch(e) {
            console.error('[TrafficMonitor] write failed:', e);
        }
    }

    private sliceBody(buf: Buffer) {
        if(!this.maxBody) return undefined;
        if(buf.length <= this.maxBody) return buf.toString('utf8');
        return buf.subarray(0, this.maxBody).toString('utf8') + `…(+${buf.length - this.maxBody}B)`;
    }

    private makeReqId() {
        return Math.random().toString(36).slice(2, 10);
    }
}

/** Compute payload “size” without throwing on circulars. */
function safeSize(payload: unknown): number | undefined {
    try {
        if(payload == null) return 0;
        if(typeof payload === 'string') return Buffer.byteLength(payload);
        return Buffer.byteLength(JSON.stringify(payload));
    } catch {
        return undefined;
    }
}

/** Pull first stack frame that points into /src and return "file:line:col". */
function getCallerFrame(): string | undefined {
    const err = new Error();
    const s = String(err.stack || '');
    const lines = s.split('\n').map(l => l.trim());
    // skip the first few frames (this helper + wrapper)
    for(const ln of lines.slice(3)) {
        // (C:\path\src\file.ts:123:45)
        const m = ln.match(/\((.*src[\\/].*?):(\d+):(\d+)\)/);
        if(m) return `${m[1]}:${m[2]}:${m[3]}`;
        // or: at /path/src/file.ts:line:col
        const m2 = ln.match(/\s(?:at|@)\s+(.*src[\\/].*?):(\d+):(\d+)/i);
        if(m2) return `${m2[1]}:${m2[2]}:${m2[3]}`;
    }
    return undefined;
}
