// Path: src/services/recyclebin/audits/recyclebin.audit-file.service.ts
// =============================================================================
// RecycleBin — Monthly Audit Log Writer (JSONL + size cap with part files)
// -----------------------------------------------------------------------------
// PURPOSE:
// - Write recycle bin security/audit events to local disk (append-only).
// - File plan: one month = one logical log stream, split into "part" files by size.
//   Example:
//     public/audit/recyclebin/2026-02.part-0001.jsonl
//     public/audit/recyclebin/2026-02.part-0002.jsonl
//
// WHY JSONL?
// - Append-only (enterprise safe)
// - One record per line (stream-friendly)
// - Easy to tail newest records for UI
//
// IMPORTANT PROJECT RULES:
// - No constructor parameters
// - TypeScript strict, no `any`
// - Do not log secrets/tokens
// - Relative paths must be under "public/..." (Electron-safe)
//
// NOTE:
// - This service only WRITES audit logs.
// - Reading for UI is handled by recyclebin.audit-query.service.ts
// =============================================================================

import path from "path";
import fs from "fs";
import fsp from "fs/promises";

import type { AuthUser } from "../../../types/common";

export type RecycleBinAuditAction =
    | "rb.view"
    | "rb.list"
    | "rb.count"
    | "rb.view_snapshot"
    | "rb.view_files"
    | "rb.soft_delete_recorded"
    | "rb.restore"
    | "rb.purge"
    | "rb.policy_change"
    | "rb.denied"
    | "rb.error";

export interface RecycleBinAuditTarget {
    entryId?: string;
    sourceKey?: string;
    refId?: string;
    label?: string;
}

export interface RecycleBinAuditContext {
    requestId?: string;
    ip?: string;
    userAgent?: string;
    origin?: string;
}

export interface RecycleBinAuditResult {
    ok: boolean;
    message?: string;
    error?: string;
}

export interface RecycleBinAuditRecord {
    ts: string; // ISO timestamp
    action: RecycleBinAuditAction;
    actor: AuthUser;

    target?: RecycleBinAuditTarget;
    ctx?: RecycleBinAuditContext;

    result: RecycleBinAuditResult;
}

export class RecycleBinAuditFileService {
    // PropEase-safe: under public/
    private static readonly BASE_DIR_REL = "public/audit/recyclebin";

    // Default: 50MB per part file
    private static readonly MAX_PART_BYTES = 50 * 1024 * 1024;

    public constructor () {}

    /**
     * Append an audit record to the current month part file.
     * - Auto-creates directories
     * - Auto-rolls to next part when size cap reached
     */
    public async append( record: RecycleBinAuditRecord ): Promise<void> {
        const safe = this.sanitizeRecord( record );

        const baseDirAbs = this.absFromRel( RecycleBinAuditFileService.BASE_DIR_REL );
        await this.ensureDir( baseDirAbs );

        const monthKey = this.monthKey( new Date() );
        const fileAbs = await this.resolveWritablePartFileAbs( baseDirAbs, monthKey );

        const line = JSON.stringify( safe ) + "\n";
        await fsp.appendFile( fileAbs, line, { encoding: "utf-8" } );

        // eslint-disable-next-line no-console
        console.log( `[Info:] RecycleBinAuditFileService: appended ${ safe.action }\n` );
    }

    /* =============================================================================
     * A) File resolution (month plan + parts)
     * ========================================================================== */

    public buildMonthPartFilename( monthKey: string, partNo: number ): string {
        const part = String( partNo ).padStart( 4, "0" );
        return `${ monthKey }.part-${ part }.jsonl`;
    }

    private async resolveWritablePartFileAbs(
        baseDirAbs: string,
        monthKey: string
    ): Promise<string> {
        const parts = await this.listMonthPartsAbs( baseDirAbs, monthKey );

        // If no parts exist yet -> first part
        if ( parts.length === 0 ) {
            return path.join( baseDirAbs, this.buildMonthPartFilename( monthKey, 1 ) );
        }

        // TS-safe: .at(-1) returns string | undefined, so we guard
        const lastAbs = parts.at( -1 );
        if ( !lastAbs ) {
            // Should never happen because parts.length > 0, but keeps TS & runtime safe
            return path.join( baseDirAbs, this.buildMonthPartFilename( monthKey, 1 ) );
        }

        const stat = await fsp.stat( lastAbs ).catch( () => null );

        if ( !stat ) {
            // If stat fails (file deleted between readdir and stat), keep writing to lastAbs
            return lastAbs;
        }

        if ( stat.size < RecycleBinAuditFileService.MAX_PART_BYTES ) {
            return lastAbs;
        }

        const nextNo = parts.length + 1;
        return path.join( baseDirAbs, this.buildMonthPartFilename( monthKey, nextNo ) );
    }


    private async listMonthPartsAbs( baseDirAbs: string, monthKey: string ): Promise<string[]> {
        const files = await fsp.readdir( baseDirAbs ).catch( () => [] );
        const prefix = `${ monthKey }.part-`;

        const matched = files
            .filter( ( f ) => f.startsWith( prefix ) && f.endsWith( ".jsonl" ) )
            .map( ( f ) => path.join( baseDirAbs, f ) );

        matched.sort( ( a, b ) => a.localeCompare( b ) );
        return matched;
    }

    /* =============================================================================
     * B) Record sanitization (avoid secrets + enforce shapes)
     * ========================================================================== */

    private sanitizeRecord( r: RecycleBinAuditRecord ): RecycleBinAuditRecord {
        const ts = this.safeIso( r.ts ) || new Date().toISOString();

        const action = r.action;
        const actor = this.safeActor( r.actor );

        const out: RecycleBinAuditRecord = {
            ts,
            action,
            actor,
            result: this.safeResult( r.result ),
        };

        if ( r.target ) {
            const t = this.safeTarget( r.target );
            if ( Object.keys( t ).length ) out.target = t;
        }

        if ( r.ctx ) {
            const c = this.safeCtx( r.ctx );
            if ( Object.keys( c ).length ) out.ctx = c;
        }

        return out;
    }

    private safeActor( a: AuthUser ): AuthUser {
        if ( !a || typeof a !== "object" ) {
            throw new Error( "RecycleBinAuditFileService: actor is required." );
        }

        const username = this.safeString( ( a as { username?: unknown; } ).username );
        const role = this.safeString( ( a as { role?: unknown; } ).role );
        const userId = ( a as { userId?: unknown; } ).userId;

        if ( !username || !role || !userId ) {
            throw new Error( "RecycleBinAuditFileService: actor must include userId, username, role." );
        }

        return a;
    }

    private safeTarget( t: RecycleBinAuditTarget ): RecycleBinAuditTarget {
        const out: RecycleBinAuditTarget = {};

        const entryId = this.safeString( t.entryId );
        const sourceKey = this.safeString( t.sourceKey );
        const refId = this.safeString( t.refId );
        const label = this.safeString( t.label );

        if ( entryId ) out.entryId = entryId;
        if ( sourceKey ) out.sourceKey = sourceKey;
        if ( refId ) out.refId = refId;
        if ( label ) out.label = label.length > 300 ? label.slice( 0, 300 ) : label;

        return out;
    }

    private safeCtx( c: RecycleBinAuditContext ): RecycleBinAuditContext {
        const out: RecycleBinAuditContext = {};

        const requestId = this.safeString( c.requestId );
        const ip = this.safeString( c.ip );
        const userAgent = this.safeString( c.userAgent );
        const origin = this.safeString( c.origin );

        if ( requestId ) out.requestId = requestId;
        if ( ip ) out.ip = ip;
        if ( userAgent ) out.userAgent = userAgent.length > 500 ? userAgent.slice( 0, 500 ) : userAgent;
        if ( origin ) out.origin = origin.length > 300 ? origin.slice( 0, 300 ) : origin;

        return out;
    }

    private safeResult( r: RecycleBinAuditResult ): RecycleBinAuditResult {
        const ok = !!r?.ok;
        const out: RecycleBinAuditResult = { ok };

        const msg = this.safeString( r?.message );
        if ( msg ) out.message = msg.length > 2000 ? msg.slice( 0, 2000 ) : msg;

        const err = this.safeString( r?.error );
        if ( err ) out.error = err.length > 4000 ? err.slice( 0, 4000 ) : err;

        return out;
    }

    /* =============================================================================
     * C) Path / date / safety helpers
     * ========================================================================== */

    private monthKey( d: Date ): string {
        // YYYY-MM in UTC for consistency
        const y = d.getUTCFullYear();
        const m = String( d.getUTCMonth() + 1 ).padStart( 2, "0" );
        return `${ y }-${ m }`;
    }

    private absFromRel( rel: string ): string {
        return path.resolve( process.cwd(), rel );
    }

    private async ensureDir( absDir: string ): Promise<void> {
        await fsp.mkdir( absDir, { recursive: true } );
    }

    private safeString( v: unknown ): string {
        if ( typeof v === "string" ) return v.trim();
        if ( typeof v === "number" ) return String( v );
        return "";
    }

    private safeIso( v: unknown ): string {
        const s = this.safeString( v );
        if ( !s ) return "";
        if ( !/^\d{4}-\d{2}-\d{2}T/.test( s ) ) return "";
        return s;
    }
}
