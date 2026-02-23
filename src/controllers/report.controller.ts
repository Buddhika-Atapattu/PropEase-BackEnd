// src/controller/report.controller.ts
// ─────────────────────────────────────────────────────────────────────────────
// ReportController
// - Central entry point for security/system incident reports.
// - Typical use cases:
//     * Logout failures on frontend (token not cleared, suspicious state).
//     * Suspicious requests / CSRF-like behaviour detected by client.
//     * Other security anomalies you want to track + email to admin.
//
// Features:
//   - Writes each incident as one JSON line in a local log file.
//   - Sends a concise email to the system admin (SMTP via Nodemailer).
//   - Captures IP, token (hashed), username, timestamp, path, method, UA.
//   - Location: hook is present; you can later integrate IP geolocation.
//
// IMPORTANT:
//   - This endpoint should NOT expose sensitive details in the response.
//   - The *log file* is your internal artefact for forensic review.
// ─────────────────────────────────────────────────────────────────────────────

import express, {
    type Request,
    type Response,
    type Router,
} from 'express';
import fs from 'fs';
import fse from 'fs-extra';
import path from 'path';
import crypto from 'crypto';
import nodemailer, { type Transporter } from 'nodemailer';
import { ApiResponseBuilder } from "../utils/api-combiner.builder";

const APP_TAG = 'PropEase';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type IncidentSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface SecurityIncidentPayload {
    type: string;                       // e.g. "logout-failure", "auth-anomaly"
    severity?: IncidentSeverity;        // default: "medium"
    message?: string;                   // short human-readable summary
    details?: Record<string, unknown>;  // any extra structured data (optional)
    username?: string;                  // optional override if auth is missing
}

export interface SecurityIncidentLogEntry {
    id: string;
    time: string;                       // ISO string
    type: string;
    severity: IncidentSeverity;

    username: string | null;
    ip: string | null;
    tokenHash: string | null;           // SHA-256 of token (not raw token)
    location: {
        city: string | null;
        country: string | null;
    } | null;

    path: string;
    method: string;
    userAgent: string | null;

    message: string | null;
    details: Record<string, unknown> | null;
}

// Options to configure log paths + email identity from app.ts
export interface ReportControllerOptions {
    logDir: string;               // directory to store incident log file
    logFileName?: string;         // default: "security-incidents.log"
    appTag?: string;              // default: "PropEase"
}

// ─────────────────────────────────────────────────────────────────────────────
// Controller
// ─────────────────────────────────────────────────────────────────────────────

export default class ReportController {
    public readonly router: Router = express.Router();

    private readonly logDir: string;
    private readonly logFilePath: string;
    private readonly appTag: string;

    // SMTP transporter – constructed once, reused
    private readonly transporter: Transporter;

    constructor ( options: ReportControllerOptions ) {
        this.logDir = options.logDir;
        this.appTag = options.appTag ?? APP_TAG;
        this.logFilePath = path.join(
            this.logDir,
            options.logFileName ?? 'security-incidents.log',
        );

        this.ensureLogDirExists();
        this.transporter = this.buildTransporter();

        this.registerRoutes();
    }

    // ───────────────────────────────────────────────────────────────────────────
    // Route registration
    // ───────────────────────────────────────────────────────────────────────────

    private registerRoutes(): void {
        // POST /api-report/security
        // Body: SecurityIncidentPayload
        this.router.post(
            '/security',
            async ( req: Request, res: Response ): Promise<void> => {
                await this.handleSecurityIncident( req, res );
            },
        );
    }

    // ───────────────────────────────────────────────────────────────────────────
    // Core handler
    // ───────────────────────────────────────────────────────────────────────────

    private async handleSecurityIncident(
        req: Request,
        res: Response,
    ): Promise<void> {
        try {
            const payload = ( req.body ?? {} ) as Partial<SecurityIncidentPayload>;

            if ( !payload.type || typeof payload.type !== 'string' ) {
                ApiResponseBuilder.validationError( res, 'Invalid incident type' );
                return;
            }

            const incident: SecurityIncidentLogEntry =
                await this.buildIncidentFromRequest( req, payload );

            // 1) Append to local log file
            await this.appendIncidentLog( incident );

            // 2) Email to system admin (soft-fail: errors logged, not propagated)
            await this.sendIncidentEmail( incident ).catch( ( err ) => {
                // We log this, but we don't fail the API because logging already succeeded.
                console.error( '[ReportController] Failed to send incident email:', err );
                ApiResponseBuilder.fail( res, '[ReportController] Failed to send incident email' );
            } );

            // 3) Respond with a generic success (no sensitive details)
            ApiResponseBuilder.ok(
                res,
                'other',
                {
                    id: incident.id,
                    type: incident.type,
                    time: incident.time,
                },
                'Incident recorded'
            );
            return;
        } catch ( error ) {
            console.error( '[ReportController.handleSecurityIncident]', error );
            ApiResponseBuilder.internalError( res, error );
            return;
        }
    }

    // ───────────────────────────────────────────────────────────────────────────
    // Log file handling
    // ───────────────────────────────────────────────────────────────────────────

    private ensureLogDirExists(): void {
        try {
            fse.ensureDirSync( this.logDir );
        } catch ( error ) {
            console.error(
                `[${ this.appTag }] Failed to ensure log directory:`,
                this.logDir,
                error,
            );
        }
    }

    private async appendIncidentLog(
        incident: SecurityIncidentLogEntry,
    ): Promise<void> {
        const line = JSON.stringify( incident );
        return new Promise<void>( ( resolve, reject ) => {
            fs.appendFile( this.logFilePath, line + '\n', ( err ) => {
                if ( err ) {
                    console.error(
                        `[${ this.appTag }] Failed to append incident log:`,
                        err,
                    );
                    reject( err );
                    return;
                }
                resolve();
            } );
        } );
    }

    // ───────────────────────────────────────────────────────────────────────────
    // Email sending
    // ───────────────────────────────────────────────────────────────────────────

    private buildTransporter(): Transporter {
        const host = ( process.env.SMTP_HOST || '' ).trim();
        const port = Number( process.env.SMTP_PORT || 587 );
        const user = ( process.env.SMTP_USER || '' ).trim();
        const pass = ( process.env.SMTP_PASS || '' ).trim();

        if ( !host || !user || !pass ) {
            console.warn(
                `[${ this.appTag }] SMTP configuration is incomplete – incident emails will likely fail.`,
            );
        }

        return nodemailer.createTransport( {
            host,
            port,
            secure: port === 465, // common pattern: 465 = SMTPS
            auth: {
                user,
                pass,
            },
        } );
    }

    private async sendIncidentEmail(
        incident: SecurityIncidentLogEntry,
    ): Promise<void> {
        const adminEmail =
            ( process.env.SECURITY_ADMIN_EMAIL || '' ).trim() ||
            ( process.env.SUPPORT_EMAIL || '' ).trim() ||
            ( process.env.SMTP_USER || '' ).trim();

        if ( !adminEmail ) {
            console.warn(
                `[${ this.appTag }] SECURITY_ADMIN_EMAIL / SUPPORT_EMAIL not set – cannot send incident email.`,
            );
            return;
        }

        const subject = `[${ this.appTag }] Security incident: ${ incident.type } (${ incident.severity })`;

        const lines: string[] = [
            `Security incident recorded at ${ incident.time }`,
            '',
            `Type     : ${ incident.type }`,
            `Severity : ${ incident.severity }`,
            '',
            `Username : ${ incident.username ?? '-' }`,
            `IP       : ${ incident.ip ?? '-' }`,
            `Token    : ${ incident.tokenHash ?? '-' } (hash)`,
            `Path     : ${ incident.method } ${ incident.path }`,
            `UserAgent: ${ incident.userAgent ?? '-' }`,
        ];

        if ( incident.location ) {
            lines.push(
                `Location : ${ incident.location.city ?? '-' }, ${ incident.location.country ?? '-' }`,
            );
        }

        if ( incident.message ) {
            lines.push( '', `Message  : ${ incident.message }` );
        }

        if ( incident.details && Object.keys( incident.details ).length > 0 ) {
            lines.push( '', 'Details  :', JSON.stringify( incident.details, null, 2 ) );
        }

        const textBody = lines.join( '\n' );

        await this.transporter.sendMail( {
            from: `"${ this.appTag } Security" <${ process.env.SMTP_USER }>`,
            to: adminEmail,
            subject,
            text: textBody,
        } );
    }

    // ───────────────────────────────────────────────────────────────────────────
    // Helpers: build incident from Request
    // ───────────────────────────────────────────────────────────────────────────

    private async buildIncidentFromRequest(
        req: Request,
        payload: Partial<SecurityIncidentPayload>,
    ): Promise<SecurityIncidentLogEntry> {
        const now = new Date().toISOString();

        // IP: thanks to `app.set('trust proxy', 1)` in app.ts, req.ip is usable.
        const ip: string | null = req.ip ? String( req.ip ) : null;

        // Token: we NEVER log raw token.
        //  - Extract from Authorization header or cookie.
        //  - Hash with SHA-256 so we can correlate events without leaking token.
        const rawToken = this.extractRawToken( req );
        const tokenHash = rawToken ? this.hashToken( rawToken ) : null;

        // Username: prefer authenticated req.user if your AuthMiddleware sets it.
        //  - Fallback: payload.username from frontend.
        const userFromAuth: any = ( req as any ).user;
        const username: string | null =
            ( userFromAuth && typeof userFromAuth.username === 'string'
                ? userFromAuth.username
                : payload.username ) || null;

        const uaHeader = ( req.headers[ 'user-agent' ] || '' ) as string;
        const userAgent = uaHeader ? uaHeader : null;

        const type = String( payload.type || 'unknown' ).trim();
        const severity: IncidentSeverity =
            payload.severity && [ 'low', 'medium', 'high', 'critical' ].includes( payload.severity )
                ? payload.severity
                : 'medium';

        const message: string | null =
            payload.message && payload.message.trim().length > 0
                ? payload.message.trim()
                : null;

        const details: Record<string, unknown> | null =
            payload.details && typeof payload.details === 'object'
                ? ( payload.details as Record<string, unknown> )
                : null;

        const location = await this.enrichLocation( ip );

        const entry: SecurityIncidentLogEntry = {
            id: this.generateId(),
            time: now,
            type,
            severity,
            username,
            ip,
            tokenHash,
            location,
            path: req.originalUrl || req.url || '-',
            method: req.method || 'UNKNOWN',
            userAgent,
            message,
            details,
        };

        return entry;
    }

    private extractRawToken( req: Request ): string | null {
        const authHeader = ( req.headers.authorization || '' ).toString();

        if ( authHeader.toLowerCase().startsWith( 'bearer ' ) ) {
            const token = authHeader.slice( 7 ).trim();
            if ( token ) {
                return token;
            }
        }

        // Optional: if you store JWT in cookies, you can add extraction here:
        const cookies: any = ( req as any ).cookies;
        if ( cookies && typeof cookies.sessionToken === 'string' ) {
            return cookies.sessionToken.trim() || null;
        }

        return null;
    }

    private hashToken( token: string ): string {
        return crypto.createHash( 'sha256' ).update( token ).digest( 'hex' );
    }

    private generateId(): string {
        // Short, URL-safe identifier for the log file / response
        return crypto.randomBytes( 8 ).toString( 'hex' );
    }

    /**
     * Hook for IP → location enrichment.
     * Currently returns null (no external dependencies).
     * In future you can plug in ipstack, MaxMind, etc.
     */
    private async enrichLocation(
        ip: string | null,
    ): Promise<{ city: string | null; country: string | null; } | null> {
        if ( !ip ) {
            return null;
        }

        // TODO: integrate real geolocation here.
        // For now, just return null to avoid external dependencies.
        return null;
    }
}
