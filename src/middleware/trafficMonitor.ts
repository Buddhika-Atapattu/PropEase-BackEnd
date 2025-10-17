// src/middleware/trafficMonitor.ts
// ─────────────────────────────────────────────────────────────────────────────
// TrafficMonitor
//  - Writes JSONL logs for HTTP and Socket.IO to <logDir>/<kind>-YYYY-MM-DD.log
//  - Emits minimal one-line terminal summaries (prod by default, dev is quiet)
//  - Extracts best-effort client IPs (proxy-aware), with safe typing for TS
//  - Optional route "spy" to see where routes are registered (dev helper)
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'fs';        // node: file I/O for appending JSON lines
import path from 'path';    // node: portable path joins
import net from 'net';      // node: IP validation (IPv4/IPv6)

import type {Express, Request, Response, NextFunction} from 'express';
import type {Namespace, Socket} from 'socket.io';

// ─────────────────────────────────────────────────────────────────────────────
// Public options for the monitor
// ─────────────────────────────────────────────────────────────────────────────
export type TrafficMonitorOptions = {
    /** Base folder where daily log files are written (default: "<cwd>/public/trace") */
    logDir?: string;
    /** Max bytes of request body to capture as a sample in logs (0 disables; default: 1024) */
    maxBodyBytes?: number;
    /** If true, include full headers in logs; otherwise only a safe subset (default: false) */
    logHeaders?: boolean;
    /**
     * Optional console tag prefix for terminal lines (e.g., "PropEase")
     * Default: "TrafficMonitor"
     */
    tag?: string;

    /**
     * Terminal echo control:
     *  - In development:  echoDev (default false)
     *  - In production:   echoProd (default true)
     * You can override these to suit your environment.
     */
    echoDev?: boolean;
    echoProd?: boolean;
};

// ─────────────────────────────────────────────────────────────────────────────
// Main class
// ─────────────────────────────────────────────────────────────────────────────
export default class TrafficMonitor {
    // Resolved settings we’ll use everywhere
    private readonly baseDir: string;     // final logging directory
    private readonly maxBody: number;     // body sampling cap in bytes
    private readonly logHeaders: boolean; // flag to include full headers in logs
    private readonly tag: string;         // console tag
    private readonly echo: boolean;       // final terminal echo decision

    constructor (opts: TrafficMonitorOptions = {}) {
        // Compute environment (we keep it simple & predictable)
        const isProd = process.env.NODE_ENV === 'production';

        // Resolve log dir (default: <cwd>/public/trace)
        this.baseDir = opts.logDir || path.join(process.cwd(), 'public', 'trace');

        // Clamp sampling limit to >= 0; default 1024
        this.maxBody = Math.max(0, opts.maxBodyBytes ?? 1024);

        // Keep headers lean by default
        this.logHeaders = !!opts.logHeaders;

        // Human-friendly console tag
        this.tag = opts.tag || 'TrafficMonitor';

        // Decide whether to echo to terminal:
        //  - dev default: false (quiet)
        //  - prod default: true  (breadcrumbs live)
        const echoDevDefault = false;
        const echoProdDefault = true;
        const echoDev = opts.echoDev ?? echoDevDefault;
        const echoProd = opts.echoProd ?? echoProdDefault;
        this.echo = isProd ? echoProd : echoDev;

        // Ensure the log directory exists (recursive: also create parents)
        fs.mkdirSync(this.baseDir, {recursive: true});
    }

    // ───────────────────────────────────────────────────────────────────────────
    // HTTP request/response logging
    // Attach this early in your Express app middleware chain.
    // ───────────────────────────────────────────────────────────────────────────
    installHttp(app: Express) {
        // If your app sits behind a proxy (NGINX/Cloudflare/Heroku/etc.), set:
        //   app.set('trust proxy', true)
        // …in your server bootstrap so that req.ip honors X-Forwarded-For.

        // 1) Ensure a correlation id on every request (re-used downstream)
        app.use((req, _res, next) => {
            if(!(req as any).reqId) (req as any).reqId = this.makeReqId();
            next();
        });

        // 2) Main logger
        app.use((req: Request, res: Response, next: NextFunction) => {
            const startedAt = Date.now();                 // record start for duration calc
            const reqId = (req as any).reqId as string;   // correlation id

            // Capture a small, safe sample of the request body for diagnostics
            // (We intentionally keep this tiny to avoid logging sensitive data in full.)
            let reqBodySample: string | undefined;
            try {
                // If a previous middleware stored a raw Buffer, use it
                const raw = (req as any).rawBody;
                if(raw instanceof Buffer) {
                    reqBodySample = this.sliceBody(raw);
                }
                // Else if JSON parser created an object, serialize a tiny sample
                else if(req.body && typeof req.body === 'object') {
                    reqBodySample = this.sliceBody(Buffer.from(JSON.stringify(req.body)));
                }
            } catch {
                // Ignore sampling errors (e.g., circular JSON)
            }

            // We log once when response ends (finish/close). One handler covers both.
            const onFinish = () => {
                res.removeListener('close', onFinish);      // avoid double-firing
                res.removeListener('finish', onFinish);

                const durationMs = Date.now() - startedAt;  // end-to-end timing
                const routePath = (req.route?.path || (req as any).routePath || null);
                const baseUrl = (req.baseUrl || null);
                const status = res.statusCode;
                const headers = this.logHeaders ? res.getHeaders() : undefined;
                const contentLength = numberOrUndefined(res.getHeader('content-length'));
                const ip = getClientIp(req);                // best-effort client IP (proxy-aware)

                // Compose the JSON object we’ll persist
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
                    ip,
                    req: {
                        headers: this.logHeaders
                            ? req.headers
                            : {
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

                // Append to daily JSONL file
                this.writeLine(this.fileFor('http'), line);

                // Minimal terminal breadcrumb (prod by default; dev off by default)
                if(this.echo) {
                    // Example:
                    // [PropEase] [abc12345] HTTP 200 GET /api/foo 18ms 203.94.12.10 512B
                    const clen = contentLength != null ? ` ${contentLength}B` : '';
                    console.log(
                        `[${this.tag}] [${reqId}] HTTP ${status} ${req.method} ${req.originalUrl} ${durationMs}ms ${ip}${clen}`
                    );
                }
            };

            // Hook our handler to both 'finish' and 'close'
            res.on('finish', onFinish);
            res.on('close', onFinish);

            next(); // hand over to subsequent handlers/routes
        });
    }

    // ───────────────────────────────────────────────────────────────────────────
    // Route registration spy (optional dev tool)
    // Wraps Express app/router methods to record where a route was declared.
    // ───────────────────────────────────────────────────────────────────────────
    spyOnRoutes(expressModule: any) {
        const methods = ['use', 'get', 'post', 'put', 'patch', 'delete', 'options', 'all'] as const;

        const patch = (obj: any, label: 'app' | 'router') => {
            const self = this; // capture class context for closures
            for(const m of methods) {
                const orig = obj[m];
                if(typeof orig !== 'function') continue;

                obj[m] = function(this: any, firstArg: any, ...rest: any[]) {
                    try {
                        if(typeof firstArg === 'string') {
                            const where = getCallerFrame(); // best-effort "file:line:col"
                            const line = {
                                t: new Date().toISOString(),
                                type: 'route',
                                layer: label,
                                method: m,
                                path: firstArg,
                                where,
                            };

                            // Stash the pattern onto the first handler so HTTP logs can reference it
                            if(rest.length > 0 && typeof rest[0] === 'function') {
                                (rest[0] as any).routePath = firstArg;
                            }

                            self.writeLine(self.fileFor('routes'), line);
                            if(self.echo) {
                                // Example:
                                // [PropEase] [route] APP GET /api/users @ /path/src/routes/users.ts:42:15
                                console.log(
                                    `[${self.tag}] [route] ${label.toUpperCase()} ${m.toUpperCase()} ${firstArg}${where ? ` @ ${where}` : ''}`
                                );
                            }
                        }
                    } catch {
                        // Never break routing if logging fails
                    }
                    return orig.apply(this, [firstArg, ...rest]); // call original Express method
                };
            }
        };

        // Patch both app and router prototypes
        const AppProto = (expressModule.application || (expressModule as any).application || (expressModule as any));
        patch(AppProto, 'app');

        const RouterProto = (expressModule.Router && (expressModule.Router as any).prototype);
        if(RouterProto) patch(RouterProto, 'router');
    }

    // ───────────────────────────────────────────────────────────────────────────
    // Socket.IO logging (connect + IN + OUT + disconnect)
    // Install on your Namespace (e.g., io.of('/')) after constructing Socket.IO.
    // ───────────────────────────────────────────────────────────────────────────
    installSocket(io: Namespace) {
        io.on('connection', (socket: Socket) => {
            // Correlation id reused if upstream put one in handshake; else generate one
            const reqId: string =
                (socket.handshake as any)?.reqId ||
                this.makeReqId();

            // If your auth middleware adds data to socket.data, surface minimal fields
            const auth = (socket.data && (socket.data as any).authUser) || {};

            // SAFELY read "x-forwarded-for" (string | string[] | undefined) and fallback to handshake.address
            const xffHeader = socket.handshake?.headers?.['x-forwarded-for'];
            const xffFirst =
                Array.isArray(xffHeader)
                    ? xffHeader[0]
                    : (typeof xffHeader === 'string' ? xffHeader.split(',')[0] : undefined);

            const rawIp = (xffFirst?.trim()) || socket.handshake?.address || '';
            const ip = normalizeIp(rawIp); // strip ::ffff: if needed and validate

            // Persist connect event
            this.writeLine(this.fileFor('socket'), {
                t: new Date().toISOString(),
                type: 'socket-connect',
                reqId,
                id: socket.id,
                user: {username: (auth as any).username, role: (auth as any).role},
                ip,
                ua: headerFirst(socket.handshake?.headers, 'user-agent') ?? '',
            });

            // Minimal terminal breadcrumb
            if(this.echo) {
                // [PropEase] [abc12345] SOCKET CONNECT id=XYZ ip=203.94.12.10
                console.log(`[${this.tag}] [${reqId}] SOCKET CONNECT id=${socket.id} ip=${ip}`);
            }

            // Wrap low-level onevent to observe incoming messages
            const origOnevent = (socket as any).onevent;
            (socket as any).onevent = (packet: any) => {
                try {
                    const [eventName, payload] = Array.isArray(packet.data)
                        ? [packet.data[0], packet.data[1]]
                        : [undefined, undefined];
                    const size = safeSize(payload);

                    this.writeLine(this.fileFor('socket'), {
                        t: new Date().toISOString(),
                        type: 'socket-event-in',
                        id: socket.id,
                        user: {username: (auth as any).username, role: (auth as any).role},
                        event: eventName,
                        payloadSize: size,
                    });

                    if(this.echo && eventName) {
                        // [PropEase] [abc12345] SOCKET IN  id=XYZ event=chat:send size=178B
                        console.log(`[${this.tag}] [${reqId}] SOCKET IN  id=${socket.id} event=${eventName} size=${size ?? 0}B`);
                    }
                } catch {
                    // Never break event flow if logging fails
                }
                return origOnevent.call(socket, packet); // forward to original handler
            };

            // Wrap emit to observe outgoing messages
            const origEmit = socket.emit.bind(socket);
            socket.emit = (event: string, ...args: any[]) => {
                try {
                    const size = safeSize(args?.[0]);
                    this.writeLine(this.fileFor('socket'), {
                        t: new Date().toISOString(),
                        type: 'socket-event-out',
                        id: socket.id,
                        event,
                        payloadSize: size,
                    });
                    if(this.echo && event) {
                        // [PropEase] [abc12345] SOCKET OUT id=XYZ event=chat:delivered size=32B
                        console.log(`[${this.tag}] [${reqId}] SOCKET OUT id=${socket.id} event=${event} size=${size ?? 0}B`);
                    }
                } catch {
                    // Keep socket emit resilient
                }
                return origEmit(event, ...args);
            };

            // Log disconnection
            socket.on('disconnect', (reason) => {
                this.writeLine(this.fileFor('socket'), {
                    t: new Date().toISOString(),
                    type: 'socket-disconnect',
                    id: socket.id,
                    reason,
                });
                if(this.echo) {
                    // [PropEase] [abc12345] SOCKET DISC id=XYZ reason=client namespace disconnect
                    // console.log(`[${this.tag}] [${reqId}] SOCKET DISC id=${socket.id} reason=${reason}`);
                }
            });
        });
    }

    // ───────────────────────────────────────────────────────────────────────────
    // Internals (private helpers)
    // ───────────────────────────────────────────────────────────────────────────

    /** Build per-day file path for a given kind of log */
    private fileFor(kind: 'http' | 'socket' | 'routes'): string {
        const d = new Date();
        const y = d.getFullYear();
        const m = `${d.getMonth() + 1}`.padStart(2, '0');
        const day = `${d.getDate()}`.padStart(2, '0');
        return path.join(this.baseDir, `${kind}-${y}-${m}-${day}.log`);
    }

    /** Append a single JSON line (JSONL) to a file; failures do not crash the app */
    private writeLine(file: string, obj: unknown) {
        const line = JSON.stringify(obj);
        try {
            fs.appendFileSync(file, line + '\n', 'utf8');
            // If you want full JSON echo, uncomment (noisy):
            // if (this.echo) console.log(`[${this.tag}] ${line}`);
        } catch(e) {
            // Observability must be non-fatal; print once and continue
            console.error('🚫 [TrafficMonitor] write failed:', e, '\n');
        }
    }

    /** Return a bounded UTF-8 string from a Buffer; indicates truncation with suffix */
    private sliceBody(buf: Buffer) {
        if(!this.maxBody) return undefined;                // disabled
        if(buf.length <= this.maxBody) return buf.toString('utf8');
        return buf.subarray(0, this.maxBody).toString('utf8') + `…(+${buf.length - this.maxBody}B)`;
    }

    /** Generate a short base36 id (8 chars) for request/socket correlation */
    private makeReqId() {
        return Math.random().toString(36).slice(2, 10);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// File-local utility functions (no exports)
// ─────────────────────────────────────────────────────────────────────────────

/** Resolve client IP for HTTP in a proxy-aware and type-safe manner */
function getClientIp(req: Request): string {
    // 1) Prefer leftmost X-Forwarded-For (original client)
    const xff = req.headers['x-forwarded-for'];
    const first =
        Array.isArray(xff)
            ? xff[0]
            : (typeof xff === 'string' ? xff.split(',')[0] : undefined);
    if(first) return normalizeIp(first.trim());

    // 2) If trust proxy is set, Express derives req.ip from XFF
    if(req.ip) return normalizeIp(req.ip);

    // 3) Fallback to raw socket address
    if(req.socket?.remoteAddress) return normalizeIp(req.socket.remoteAddress);

    return '';
}

/** Normalize IPv6 v4-mapped addresses like "::ffff:127.0.0.1" to "127.0.0.1" */
function normalizeIp(ip: string | undefined): string {
    if(!ip) return '';
    if(ip.startsWith('::ffff:')) ip = ip.slice(7);
    return net.isIP(ip) ? ip : ip; // if invalid, just return original string
}

/** Compute approximate byte size of a payload; never throws on circulars */
function safeSize(payload: unknown): number | undefined {
    try {
        if(payload == null) return 0;
        if(typeof payload === 'string') return Buffer.byteLength(payload, 'utf8');
        return Buffer.byteLength(JSON.stringify(payload), 'utf8');
    } catch {
        return undefined;
    }
}

/** Return "file:line:col" of the first stack frame under /src for route spy */
function getCallerFrame(): string | undefined {
    const err = new Error();
    const s = String(err.stack || '');
    const lines = s.split('\n').map(l => l.trim());
    for(const ln of lines.slice(3)) {
        // Match "(.../src/file.ts:line:col)"
        const m = ln.match(/\((.*src[\\/].*?):(\d+):(\d+)\)/);
        if(m) return `${m[1]}:${m[2]}:${m[3]}`;
        // Or "at .../src/file.ts:line:col"
        const m2 = ln.match(/\s(?:at|@)\s+(.*src[\\/].*?):(\d+):(\d+)/i);
        if(m2) return `${m2[1]}:${m2[2]}:${m2[3]}`;
    }
    return undefined;
}

/** Convert a header value to a finite number when possible; else undefined */
function numberOrUndefined(v: unknown): number | undefined {
    if(typeof v === 'number' && Number.isFinite(v)) return v;
    if(typeof v === 'string') {
        const n = Number(v);
        return Number.isFinite(n) ? n : undefined;
    }
    return undefined;
}

/** Safely read the first string value of a header that may be string|string[]|undefined */
function headerFirst(
    headers: Partial<Record<string, string | string[]>> | undefined,
    key: string
): string | undefined {
    const v = headers?.[key];
    if(Array.isArray(v)) return v[0];
    if(typeof v === 'string') return v;
    return undefined;
}
