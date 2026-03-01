// Path: src/controllers/recyclebin/recyclebin.controller.ts
// =============================================================================
// RecycleBinController (Phase 3.1) — FULL + FIXED (exactOptionalPropertyTypes-safe)
// -----------------------------------------------------------------------------
// PURPOSE:
// - Expose RecycleBinEngineService through REST endpoints for the UI
// - Enforce request validation + safe pagination
// - Use ApiGuardExport.GetAuthUser(req) (await) to capture actor identity
// - Use ApiResponseBuilder.ok/error only (your project rule)
//
// IMPORTANT RULES (your rules):
// - 100% class-based (no free functions)
// - No constructor parameters
// - exactOptionalPropertyTypes-safe (omit optionals, never pass undefined)
//
// FIXES INCLUDED (from your reported errors):
// 1) ✅ Audit context mismatch fixed:
//    - Your audit writer methods likely expect (actor, session?) as the 2nd param.
//    - Passing ctx as 2nd param caused: "RecycleBinAuditContext is not assignable to ClientSession".
//    - We therefore DO NOT pass ctx into audit writer methods here.
//      (If you want ctx everywhere, we must align AuditWriter signatures first.)
// 2) ✅ markRestored removed:
//    - Your engine now has REAL restore() which already marks status restored.
//    - So controller no longer calls engine.markRestored().
// =============================================================================

import type { NextFunction, Request, RequestHandler, Response } from "express";

import { ApiGuardExport } from "../../guard/api-router.guard";
import { ApiResponseBuilder } from "../../utils/api-combiner.builder";

// ✅ You asked to use AuthUserNormalized from common types.
import type { AuthUser } from "../../types/common";

import {
    RecycleBinEngineService,
    type PageQuery,
    type RecycleListFilters,
} from "../../services/recyclebin/recyclebin-engine.service";

import { RecycleBinAuditWriterService } from "../../services/recyclebin/audits/recyclebin-audit-writer.service";

// Controller must validate status safely (no casting)
import type { RecycleBinStatus } from "../../models/recyclebin/recyclebin-entry.model";

export class RecycleBinController {
    private readonly engine: RecycleBinEngineService;
    private readonly audit: RecycleBinAuditWriterService;

    public constructor () {
        // No constructor parameters (your rule)
        this.engine = new RecycleBinEngineService();
        this.audit = new RecycleBinAuditWriterService();
    }

    // ===========================================================================
    // 01) LIST
    // GET /list?page=1&limit=20&sourceKey=...&search=...&status=... etc
    // ===========================================================================
    public readonly list: RequestHandler = async (
        req: Request,
        res: Response,
        _next: NextFunction
    ): Promise<void> => {
        try {
            const actor = await this.getActor( req );

            const filters = this.readListFilters( req );
            const page = this.readPageQuery( req );
            filters.includeRestored = false;

            // ✅ Audit (do NOT pass ctx as second param; it may be interpreted as session)
            await this.audit.recordList( actor );

            const result = await this.engine.list( filters, page );

            ApiResponseBuilder.ok(
                res,
                "recycleBinItems",
                result.items,
                "Recycle bin entries loaded",
                { pagination: { total: result.other.total } }
            );
            return;
        } catch ( err: unknown ) {
            ApiResponseBuilder.error(
                res,
                500,
                err instanceof Error ? err.message : "Internal error"
            );
            return;
        }
    };

    // ===========================================================================
    // 02) COUNT
    // GET /count?sourceKey=...&status=... etc
    // ===========================================================================
    public readonly count: RequestHandler = async (
        req: Request,
        res: Response,
        _next: NextFunction
    ): Promise<void> => {
        try {
            const actor = await this.getActor( req );

            const filters = this.readListFilters( req );

            // ✅ Audit
            await this.audit.recordCount( actor );

            const result = await this.engine.count( filters );

            // Keep your API envelope style
            ApiResponseBuilder.ok( res, "other", {}, "Recycle bin entries count loaded", {
                pagination: { total: result.total },
            } );
            return;
        } catch ( err: unknown ) {
            ApiResponseBuilder.error(
                res,
                500,
                err instanceof Error ? err.message : "Internal error"
            );
            return;
        }
    };

    // ===========================================================================
    // 03) READ SNAPSHOT
    // GET /:entryId/snapshot
    // - returns entry + snapshotData + meta
    // ===========================================================================
    public readonly readSnapshot: RequestHandler = async (
        req: Request,
        res: Response,
        _next: NextFunction
    ): Promise<void> => {
        try {
            const actor = await this.getActor( req );

            const entryId = this.safeStr( req.params[ "entryId" ] );
            if ( !entryId ) {
                ApiResponseBuilder.error( res, 400, "entryId is required" );
                return;
            }

            const result = await this.engine.readSnapshotByEntryId( entryId );

            // ✅ Audit (targeted)
            await this.audit.recordViewSnapshot(
                {
                    entryId,
                    sourceKey: result.entry.sourceKey,
                    refId: result.entry.refId,
                    label: result.entry.label,
                },
                actor
            );

            ApiResponseBuilder.ok( res, "recycleBinItem", result.entry, "Recycle entry snapshot loaded", {
                other: {
                    snapshotData: result.snapshotData,
                    metadata: result.meta,
                },
            } );
            return;
        } catch ( err: unknown ) {
            ApiResponseBuilder.error(
                res,
                500,
                err instanceof Error ? err.message : "Internal error"
            );
            return;
        }
    };

    // ===========================================================================
    // 04) PREPARE RESTORE (UI preview / confirmation)
    // POST /:entryId/restore/prepare
    // - returns snapshotData + files manifest
    // ===========================================================================
    public readonly prepareRestore: RequestHandler = async (
        req: Request,
        res: Response,
        _next: NextFunction
    ): Promise<void> => {
        try {
            const actor = await this.getActor( req );

            const entryId = this.safeStr( req.params[ "entryId" ] );
            if ( !entryId ) {
                ApiResponseBuilder.error( res, 400, "entryId is required" );
                return;
            }

            const result = await this.engine.prepareRestore( entryId, actor );


            // ✅ Audit (targeted)
            await this.audit.recordRestorePrepared(
                {
                    entryId,
                    sourceKey: result.entry.sourceKey,
                    refId: result.entry.refId,
                    label: result.entry.label,
                },
                actor
            );

            ApiResponseBuilder.ok( res, "recycleBinItem", result.entry, "Restore prepared", {
                other: {
                    snapshotData: result.snapshotData,
                    files: result.files,
                },
            } );
            return;
        } catch ( err: unknown ) {
            ApiResponseBuilder.error(
                res,
                500,
                err instanceof Error ? err.message : "Internal error"
            );
            return;
        }
    };

    // ===========================================================================
    // 05) REAL RESTORE (DB + Files)
    // POST /:entryId/restore
    // body: { restoreMode?: "insert" | "upsert" }
    // ===========================================================================
    public readonly restore: RequestHandler = async (
        req: Request,
        res: Response,
        _next: NextFunction
    ): Promise<void> => {
        try {
            const actor = await this.getActor( req );

            const entryId = this.safeStr( req.params[ "entryId" ] );
            if ( !entryId ) {
                ApiResponseBuilder.error( res, 400, "entryId is required" );
                return;
            }

            // Body is unknown -> read safely
            const body = this.readBody( req );

            const restoreModeRaw = this.safeStr( body[ "restoreMode" ] );
            const restoreMode = this.parseRestoreMode( restoreModeRaw );

            // exactOptionalPropertyTypes-safe: only attach restoreMode if present
            const result = await this.engine.restore( {
                entryId,
                restoredBy: actor,
                ...( restoreMode ? { restoreMode } : {} ),
            } );

            // ✅ Audit (targeted)
            await this.audit.recordRestored(
                {
                    entryId: result.entryId,
                    sourceKey: result.sourceKey,
                    refId: result.refId,
                },
                actor
            );

            ApiResponseBuilder.ok(
                res,
                "recycleBinItem",
                result.entry,
                "Recycle entry restored",
                {
                    other: {
                        result
                    }
                }
            );
            return;
        } catch ( err: unknown ) {
            ApiResponseBuilder.error(
                res,
                500,
                err instanceof Error ? err.message : "Internal error"
            );
            return;
        }
    };

    // ===========================================================================
    // 06) PURGE (Permanent Delete)
    // DELETE /:entryId/purge
    // ===========================================================================
    public readonly purge: RequestHandler = async (
        req: Request,
        res: Response,
        _next: NextFunction
    ): Promise<void> => {
        try {
            const actor = await this.getActor( req );

            const entryId = this.safeStr( req.params[ "entryId" ] );
            if ( !entryId ) {
                ApiResponseBuilder.error( res, 400, "entryId is required" );
                return;
            }

            const result = await this.engine.purge( entryId, actor );

            // ✅ Audit
            await this.audit.recordPurged( { entryId: result.entryId }, actor );

            ApiResponseBuilder.ok(
                res,
                "other",
                { entryId: result.entryId, purged: result.purged },
                "Recycle entry purged"
            );
            return;
        } catch ( err: unknown ) {
            ApiResponseBuilder.error(
                res,
                500,
                err instanceof Error ? err.message : "Internal error"
            );
            return;
        }
    };

    // ===========================================================================
    // INTERNALS (Actor + parsing + validation)
    // ===========================================================================

    /**
     * ✅ Your ApiGuardExport.GetAuthUser(req) is async -> MUST await.
     * Returns your canonical AuthUserNormalized (userId, username, role, teamCodes?, branchId?).
     */
    private async getActor( req: Request ): Promise<AuthUser> {
        const actor = await ApiGuardExport.GetAuthUser( req );
        if ( !actor ) {
            throw new Error( "Unauthorized: actor missing" );
        }
        return actor;
    }

    /**
     * Read list filters from query params.
     * exactOptionalPropertyTypes-safe: ONLY assign if present.
     */
    private readListFilters( req: Request ): RecycleListFilters {
        const out: RecycleListFilters = {};

        const sourceKey = this.safeStr( req.query[ "sourceKey" ] );
        if ( sourceKey ) out.sourceKey = sourceKey;

        const search = this.safeStr( req.query[ "search" ] );
        if ( search ) out.search = search;

        const statusRaw = this.safeStr( req.query[ "status" ] );
        const status = this.parseStatus( statusRaw );
        if ( status ) out.status = status;

        const deletedByUsername = this.safeStr( req.query[ "deletedByUsername" ] );
        if ( deletedByUsername ) out.deletedByUsername = deletedByUsername;

        const deletedFromIso = this.safeStr( req.query[ "deletedFromIso" ] );
        if ( deletedFromIso ) out.deletedFromIso = deletedFromIso;

        const deletedToIso = this.safeStr( req.query[ "deletedToIso" ] );
        if ( deletedToIso ) out.deletedToIso = deletedToIso;

        const tagsAny = this.readCsv( req.query[ "tagsAny" ] );
        if ( tagsAny.length > 0 ) out.tagsAny = tagsAny;

        const module = this.safeStr( req.query[ "module" ] );
        if ( module ) out.module = module;

        const entity = this.safeStr( req.query[ "entity" ] );
        if ( entity ) out.entity = entity;

        return out;
    }

    /**
     * Validate status string safely against your model union.
     * Returns null if invalid/empty.
     */
    private parseStatus( raw: string ): RecycleBinStatus | null {
        const s = raw.trim();
        if ( !s ) return null;

        const allowed: readonly RecycleBinStatus[] = [
            "recording",
            "recorded",
            "restore_in_progress",
            "restored",
            "purged",
            "failed",
        ];

        for ( const v of allowed ) {
            if ( v === s ) return v;
        }

        return null;
    }

    /**
     * Validate restoreMode safely.
     * - "insert" is default in engine if omitted
     * - "upsert" is allowed (use with caution)
     */
    private parseRestoreMode( raw: string ): "insert" | "upsert" | null {
        const s = raw.trim();
        if ( !s ) return null;
        if ( s === "insert" ) return "insert";
        if ( s === "upsert" ) return "upsert";
        return null;
    }

    /**
     * Read page + limit with clamps.
     * - page is 1-based
     * - limit capped at 100
     */
    private readPageQuery( req: Request ): PageQuery {
        const pageRaw = this.safeStr( req.query[ "page" ] );
        const limitRaw = this.safeStr( req.query[ "limit" ] );

        const page = this.safeInt( pageRaw, 1 );
        const limit = this.safeInt( limitRaw, 20 );

        return {
            page: this.clamp( page, 1, 1_000_000 ),
            limit: this.clamp( limit, 1, 100 ),
        };
    }

    /**
     * Query param CSV reader.
     * Example: tagsAny=a,b,c
     */
    private readCsv( v: unknown ): string[] {
        const s = this.safeStr( v );
        if ( !s ) return [];
        return s
            .split( "," )
            .map( ( x ) => x.trim() )
            .filter( ( x ) => x.length > 0 );
    }

    /**
     * Safe body reader (no assumptions about shape).
     * exactOptionalPropertyTypes-safe: returns a plain object always.
     */
    private readBody( req: Request ): Record<string, unknown> {
        const b = ( req as unknown as { body?: unknown; } ).body;
        return this.isRecord( b ) ? b : {};
    }

    /**
     * Safe string extractor for:
     * - req.query can be string|string[]
     * - headers can be string|string[]
     */
    private safeStr( v: unknown ): string {
        if ( typeof v === "string" ) return v.trim();
        if ( Array.isArray( v ) && typeof v[ 0 ] === "string" ) return v[ 0 ].trim();
        if ( typeof v === "number" ) return String( v );
        return "";
    }

    private safeInt( v: string, fallback: number ): number {
        const n = Number( v );
        if ( !Number.isFinite( n ) ) return fallback;
        return Math.floor( n );
    }

    private clamp( n: number, min: number, max: number ): number {
        return Math.max( min, Math.min( max, n ) );
    }

    private isRecord( v: unknown ): v is Record<string, unknown> {
        return typeof v === "object" && v !== null && !Array.isArray( v );
    }
}