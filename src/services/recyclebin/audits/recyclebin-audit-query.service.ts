// Path: src/services/recyclebin/audits/recyclebin.audit-query.service.ts
// =============================================================================
// RecycleBin — Audit Log Reader (Monthly JSONL + parts) for UI
// -----------------------------------------------------------------------------
// PURPOSE:
// - Load audit records from local JSONL monthly log files
// - Apply filters, newest-first ordering, pagination
//
// MONTH PLAN + PARTS:
// - public/audit/recyclebin/YYYY-MM.part-0001.jsonl
// - public/audit/recyclebin/YYYY-MM.part-0002.jsonl
//
// READ STRATEGY (enterprise-lite, newest-first):
// - List month part files (ascending)
// - Process parts in reverse order (newest part first)
// - Tail the last N bytes of each file and parse lines
// - Reverse lines inside each tail buffer to process newest records first
//
// NOTE ABOUT "TOTAL":
// - Computing exact total across entire month requires scanning full files.
// - To keep IO controlled, we return totalApprox = number of matched records scanned.
// - If you need exact totals later, we can add an "exactTotal" mode.
// =============================================================================

import path from "path";
import fs from "fs";
import fsp from "fs/promises";

import type {
    RecycleBinAuditAction,
    RecycleBinAuditRecord,
    RecycleBinAuditTarget,
} from "./recyclebin-audit-file.service";

export interface RecycleBinAuditListFilters {
    search?: string; // search action/actor/target/message/error

    action?: RecycleBinAuditAction;
    actorUsername?: string;

    entryId?: string;
    sourceKey?: string;
    refId?: string;

    from?: string; // ISO
    to?: string;   // ISO
}

export interface RecycleBinAuditListRequest {
    monthKey: string; // "YYYY-MM"
    page: number;     // 1-based
    limit: number;    // 10/20/50/100
    filters: RecycleBinAuditListFilters;
}

export interface RecycleBinAuditListItemDto {
    ts: string;
    action: RecycleBinAuditAction;

    actorUsername: string;
    actorRole: string;

    target?: RecycleBinAuditTarget;

    ok: boolean;
    message?: string;
    error?: string;
}

export interface RecycleBinAuditListResponse {
    items: RecycleBinAuditListItemDto[];
    other: { totalApprox: number; };
}

export class RecycleBinAuditQueryService {
    private static readonly BASE_DIR_REL = "public/audit/recyclebin";

    // How many bytes to read from the end of each part file.
    // If your filter is very strict, increase this value.
    private static readonly TAIL_BYTES = 2 * 1024 * 1024; // 2MB

    public constructor () {}

    public async list( req: RecycleBinAuditListRequest ): Promise<RecycleBinAuditListResponse> {
        const monthKey = this.safeMonthKey( req.monthKey );
        const page = this.safePage( req.page );
        const limit = this.safeLimit( req.limit );
        const filters = req.filters ?? {};

        const start = ( page - 1 ) * limit;
        const end = start + limit;

        const baseDirAbs = this.absFromRel( RecycleBinAuditQueryService.BASE_DIR_REL );
        const partFilesAbs = await this.listMonthPartFilesAbs( baseDirAbs, monthKey );

        // newest-first: last part first
        partFilesAbs.reverse();

        const items: RecycleBinAuditListItemDto[] = [];
        let matchedApprox = 0;

        for ( const fileAbs of partFilesAbs ) {
            const lines = await this.tailLines( fileAbs, RecycleBinAuditQueryService.TAIL_BYTES );

            // newest lines are at the end of the file tail; walk backwards for newest-first
            for ( let i = lines.length - 1; i >= 0; i-- ) {
                const line = lines[ i ];
                if ( !line ) continue; // ✅ TS: line is now string

                const rec = this.safeParseLine( line );
                if ( !rec ) continue;

                if ( !this.matches( rec, filters ) ) continue;

                matchedApprox++;

                if ( matchedApprox > start && matchedApprox <= end ) {
                    items.push( this.toDto( rec ) );
                }

                if ( matchedApprox >= end ) {
                    return { items, other: { totalApprox: matchedApprox } };
                }
            }

        }

        return { items, other: { totalApprox: matchedApprox } };
    }

    /* =============================================================================
     * A) File listing (month parts)
     * ========================================================================== */

    private async listMonthPartFilesAbs( baseDirAbs: string, monthKey: string ): Promise<string[]> {
        const exists = await this.pathExists( baseDirAbs );
        if ( !exists ) return [];

        const files = await fsp.readdir( baseDirAbs ).catch( () => [] );
        const prefix = `${ monthKey }.part-`;

        const matched = files
            .filter( ( f ) => f.startsWith( prefix ) && f.endsWith( ".jsonl" ) )
            .map( ( f ) => path.join( baseDirAbs, f ) );

        matched.sort( ( a, b ) => a.localeCompare( b ) );
        return matched;
    }

    private async pathExists( absPath: string ): Promise<boolean> {
        try {
            await fsp.access( absPath, fs.constants.F_OK );
            return true;
        } catch {
            return false;
        }
    }

    /* =============================================================================
     * B) Tail reading (read last N bytes, split into JSON lines)
     * ========================================================================== */

    private async tailLines( fileAbs: string, maxBytes: number ): Promise<string[]> {
        const stat = await fsp.stat( fileAbs ).catch( () => null );
        if ( !stat || stat.size <= 0 ) return [];

        const start = Math.max( 0, stat.size - maxBytes );
        const len = stat.size - start;

        const fd = await fsp.open( fileAbs, "r" );
        try {
            const buf = Buffer.alloc( len );
            await fd.read( buf, 0, len, start );

            const text = buf.toString( "utf-8" );

            // Split into lines, trim, drop empty
            return text
                .split( "\n" )
                .map( ( x ) => x.trim() )
                .filter( ( x ) => x.length > 0 );
        } finally {
            await fd.close();
        }
    }

    private safeParseLine( line: string ): RecycleBinAuditRecord | null {
        try {
            const obj = JSON.parse( line ) as unknown;
            if ( !obj || typeof obj !== "object" ) return null;

            const r = obj as RecycleBinAuditRecord;

            if ( typeof r.ts !== "string" ) return null;
            if ( typeof r.action !== "string" ) return null;
            if ( !r.actor || typeof r.actor !== "object" ) return null;
            if ( !r.result || typeof r.result !== "object" ) return null;

            return r;
        } catch {
            return null;
        }
    }

    /* =============================================================================
     * C) Filtering
     * ========================================================================== */

    private matches( r: RecycleBinAuditRecord, f: RecycleBinAuditListFilters ): boolean {
        if ( f.action && r.action !== f.action ) return false;

        const actorUsername = this.safeString( ( r.actor as { username?: unknown; } ).username );
        const actorRole = this.safeString( ( r.actor as { role?: unknown; } ).role );

        if ( f.actorUsername ) {
            if ( actorUsername.toLowerCase() !== this.safeString( f.actorUsername ).toLowerCase() ) {
                return false;
            }
        }

        const t = r.target ?? {};

        if ( f.entryId && this.safeString( t.entryId ) !== this.safeString( f.entryId ) ) return false;
        if ( f.sourceKey && this.safeString( t.sourceKey ) !== this.safeString( f.sourceKey ) ) return false;
        if ( f.refId && this.safeString( t.refId ) !== this.safeString( f.refId ) ) return false;

        // ISO range filtering (lexical compare works for ISO)
        const from = this.safeIso( f.from );
        const to = this.safeIso( f.to );

        if ( from || to ) {
            const ts = this.safeIso( r.ts );
            if ( !ts ) return false;

            if ( from && ts < from ) return false;
            if ( to && ts > to ) return false;
        }

        const search = this.safeString( f.search );
        if ( search ) {
            const needle = search.toLowerCase();

            const msg = this.safeString( r.result?.message ).toLowerCase();
            const err = this.safeString( r.result?.error ).toLowerCase();

            const act = this.safeString( r.action ).toLowerCase();

            const label = this.safeString( t.label ).toLowerCase();
            const refId = this.safeString( t.refId ).toLowerCase();
            const sourceKey = this.safeString( t.sourceKey ).toLowerCase();

            const hay = [
                act,
                actorUsername.toLowerCase(),
                actorRole.toLowerCase(),
                label,
                refId,
                sourceKey,
                msg,
                err,
              ].join(" ");

            // simple contains
            if ( !hay.includes( needle ) ) return false;
        }

        return true;
    }

    /* =============================================================================
     * D) Mapping
     * ========================================================================== */

    private toDto( r: RecycleBinAuditRecord ): RecycleBinAuditListItemDto {
        const actorUsername = this.safeString( ( r.actor as { username?: unknown; } ).username );
        const actorRole = this.safeString( ( r.actor as { role?: unknown; } ).role );

        const dto: RecycleBinAuditListItemDto = {
            ts: this.safeIso( r.ts ) || new Date().toISOString(),
            action: r.action,
            actorUsername,
            actorRole,
            ok: !!r.result?.ok,
        };

        if ( r.target && Object.keys( r.target ).length ) dto.target = r.target;

        const msg = this.safeString( r.result?.message );
        if ( msg ) dto.message = msg.length > 2000 ? msg.slice( 0, 2000 ) : msg;

        const err = this.safeString( r.result?.error );
        if ( err ) dto.error = err.length > 4000 ? err.slice( 0, 4000 ) : err;

        return dto;
    }

    /* =============================================================================
     * E) Safety helpers
     * ========================================================================== */

    private absFromRel( rel: string ): string {
        return path.resolve( process.cwd(), rel );
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

    private safeMonthKey( v: unknown ): string {
        const s = this.safeString( v );
        if ( !/^\d{4}-\d{2}$/.test( s ) ) {
            throw new Error( "RecycleBinAuditQueryService: monthKey must be YYYY-MM." );
        }
        return s;
    }

    private safePage( page: number ): number {
        const p = Number( page );
        if ( !Number.isFinite( p ) || p < 1 ) return 1;
        return Math.floor( p );
    }

    private safeLimit( limit: number ): number {
        const n = Number( limit );
        if ( !Number.isFinite( n ) || n < 1 ) return 20;
        return Math.min( Math.floor( n ), 100 );
    }
}
