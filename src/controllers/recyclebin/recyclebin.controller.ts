// Path: src/controllers/recyclebin/recyclebin.controller.ts
// =============================================================================
// RecycleBinController (Phase 3.1)
// -----------------------------------------------------------------------------
// PURPOSE:
// - Expose RecycleBinEngineService through REST endpoints for the UI
// - Enforce request validation + safe pagination
// - Use ApiGuardExport.GetAuthUser(req) (await) to capture actor identity
// - Use ApiResponseBuilder.ok/error only (your project rule)
// - Write audit records for VIEW/LIST/COUNT/SNAPSHOT/RESTORE/PURGE actions
//
// IMPORTANT RULES (your rules):
// - 100% class-based (no free functions)
// - No constructor parameters
// - exactOptionalPropertyTypes-safe (omit optionals, never pass undefined)
// =============================================================================

import type { Request, Response, NextFunction, RequestHandler } from "express";

import { ApiResponseBuilder } from "../../utils/api-combiner.builder";
import { ApiGuardExport } from "../../guard/api-router.guard";

import type { AuthUser } from "../../types/common";

import {
    RecycleBinEngineService,
    type PageQuery,
    type RecycleListFilters,
} from "../../services/recyclebin/recyclebin-engine.service";

import {
    RecycleBinAuditWriterService,
} from "../../services/recyclebin/audits/recyclebin-audit-writer.service";

import type { RecycleBinAuditContext } from "../../services/recyclebin/audits/recyclebin-audit-file.service";

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
    // 01) LIST (GET /list?page=1&limit=20&sourceKey=...&search=...&status=... etc)
    // ===========================================================================
    public readonly list: RequestHandler = async ( req: Request, res: Response, _next: NextFunction ): Promise<void> => {
        try {
            const actor = await this.getActor( req );

            const filters = this.readListFilters( req );
            const page = this.readPageQuery( req );

            // Audit: list action (no specific entry target)
            await this.audit.recordList( actor, this.buildAuditCtx( req ) );

            const result = await this.engine.list( filters, page );

            ApiResponseBuilder.ok( res, "recycleBinItems", result.items, "Recycle bin entries loaded", { pagination: { total: result.other.total } } );
            return;
        } catch ( err: unknown ) {
            ApiResponseBuilder.error( res, 500, err instanceof Error ? err.message : "Internal error" );
            return;
        }
    };

    // ===========================================================================
    // 02) COUNT (GET /count?sourceKey=...&status=... etc)
    // ===========================================================================
    public readonly count: RequestHandler = async ( req: Request, res: Response, _next: NextFunction ): Promise<void> => {
        try {
            const actor = await this.getActor( req );

            const filters = this.readListFilters( req );

            // Audit: count action
            await this.audit.recordCount( actor, this.buildAuditCtx( req ) );

            const result = await this.engine.count( filters );

            ApiResponseBuilder.ok( res, "other", {}, "Recycle bin entries count loaded", { pagination: { total: result.total } } );
            return;
        } catch ( err: unknown ) {
            ApiResponseBuilder.error( res, 500, err instanceof Error ? err.message : "Internal error" );
            return;
        }
    };

    // ===========================================================================
    // 03) READ SNAPSHOT (GET /:entryId/snapshot)
    // - returns entry + snapshotData + meta
    // ===========================================================================
    public readonly readSnapshot: RequestHandler = async ( req: Request, res: Response, _next: NextFunction ): Promise<void> => {
        try {
            const actor = await this.getActor( req );

            const entryId = this.safeStr( req.params[ "entryId" ] );
            if ( !entryId ) {
                ApiResponseBuilder.error( res, 400, "entryId is required" );
                return;
            }

            const result = await this.engine.readSnapshotByEntryId( entryId );

            // Audit: view_snapshot action with target
            await this.audit.recordViewSnapshot(
                {
                    entryId,
                    sourceKey: result.entry.sourceKey,
                    refId: result.entry.refId,
                    label: result.entry.label,
                },
                actor,
                this.buildAuditCtx( req )
            );

            ApiResponseBuilder.ok( res, "recycleBinItem", result.entry, "Recycle entry snapshot loaded", {
                other: {
                    snapshotData: result.snapshotData,
                    metadata: result.meta,
                }
            } );
            return;
        } catch ( err: unknown ) {
            ApiResponseBuilder.error( res, 500, err instanceof Error ? err.message : "Internal error" );
            return;
        }
    };

    // ===========================================================================
    // 04) PREPARE RESTORE (POST /:entryId/restore/prepare)
    // - returns snapshotData + files manifest
    // ===========================================================================
    public readonly prepareRestore: RequestHandler = async ( req: Request, res: Response, _next: NextFunction ): Promise<void> => {
        try {
            const actor = await this.getActor( req );

            const entryId = this.safeStr( req.params[ "entryId" ] );
            if ( !entryId ) {
                ApiResponseBuilder.error( res, 400, "entryId is required" );
                return;
            }

            const result = await this.engine.prepareRestore( entryId, actor );

            // Engine already audits restore-prepared, but keeping controller-level audits
            // is fine if you want explicit API trail.
            // If you want to avoid duplicates, remove this line.
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
                }
            } );
            return;
        } catch ( err: unknown ) {
            ApiResponseBuilder.error( res, 500, err instanceof Error ? err.message : "Internal error" );
            return;
        }
    };

    // ===========================================================================
    // 05) MARK RESTORED (POST /:entryId/restore/mark)
    // - call after the domain restore succeeded
    // ===========================================================================
    public readonly markRestored: RequestHandler = async ( req: Request, res: Response, _next: NextFunction ): Promise<void> => {
        try {
            const actor = await this.getActor( req );

            const entryId = this.safeStr( req.params[ "entryId" ] );
            if ( !entryId ) {
                ApiResponseBuilder.error( res, 400, "entryId is required" );
                return;
            }

            await this.engine.markRestored( entryId, actor );

            // Engine audits restored as well; controller audit optional.
            await this.audit.recordRestored( { entryId }, actor );

            ApiResponseBuilder.ok( res, "other", { entryId }, "Recycle entry marked as restored" );
            return;
        } catch ( err: unknown ) {
            ApiResponseBuilder.error( res, 500, err instanceof Error ? err.message : "Internal error" );
            return;
        }
    };

    // ===========================================================================
    // 06) PURGE (DELETE /:entryId/purge)
    // - high privilege action (guarded at router/guard-map level)
    // ===========================================================================
    public readonly purge: RequestHandler = async ( req: Request, res: Response, _next: NextFunction ): Promise<void> => {
        try {
            const actor = await this.getActor( req );

            const entryId = this.safeStr( req.params[ "entryId" ] );
            if ( !entryId ) {
                ApiResponseBuilder.error( res, 400, "entryId is required" );
                return;
            }

            const result = await this.engine.purge( entryId, actor );

            // Engine audits purge; controller audit optional.
            await this.audit.recordPurged( { entryId }, actor );

            ApiResponseBuilder.ok( res, "other", {
                entryId: result.entryId,
                purged: result.purged
            }, "Recycle entry purged" );
            return;
        } catch ( err: unknown ) {
            ApiResponseBuilder.error( res, 500, err instanceof Error ? err.message : "Internal error" );
            return;
        }
    };

    // ===========================================================================
    // Internals (validation / parsing / audit ctx)
    // ===========================================================================

    /**
     * ✅ Your ApiGuardExport.GetAuthUser(req) is async, so we MUST await it.
     * This returns your canonical AuthUser (userId, username, role, teamCodes?, branchId?).
     */
    private async getActor( req: Request ): Promise<AuthUser> {
        const actor = await ApiGuardExport.GetAuthUser( req );
        if ( !actor ) {
            // If your guard always populates the actor, this is just a hard safety.
            throw new Error( "Unauthorized: actor missing" );
        }
        return actor;
    }

    /**
     * Build audit context from request (NO secrets).
     * This is safe to store in JSONL for security tracing.
     */
    private buildAuditCtx( req: Request ): RecycleBinAuditContext {
        const ctx: RecycleBinAuditContext = {};

        const requestId = this.safeStr( ( req as unknown as { requestId?: unknown; } ).requestId );
        if ( requestId ) ctx.requestId = requestId;

        // Prefer x-forwarded-for (when behind proxy) otherwise req.ip
        const ipHeader = this.safeStr( req.headers[ "x-forwarded-for" ] );
        const ip = ipHeader ? ipHeader.split( "," )[ 0 ]?.trim() : this.safeStr( req.ip );
        if ( ip ) ctx.ip = ip;

        const userAgent = this.safeStr( req.headers[ "user-agent" ] );
        if ( userAgent ) ctx.userAgent = userAgent;

        const origin = this.safeStr( req.headers[ "origin" ] );
        if ( origin ) ctx.origin = origin;

        return ctx;
    }

    /**
     * Read list filters from query params.
     * exactOptionalPropertyTypes-safe: we ONLY assign fields when present.
     */
    private readListFilters(req: Request): RecycleListFilters {
        const out: RecycleListFilters = {};
      
        const sourceKey = this.safeStr(req.query["sourceKey"]);
        if (sourceKey) out.sourceKey = sourceKey;
      
        const search = this.safeStr(req.query["search"]);
        if (search) out.search = search;
      
        // ✅ status: validate against allowed values (no casting)
        const statusRaw = this.safeStr(req.query["status"]);
        const status = this.parseStatus(statusRaw);
        if (status) out.status = status;
      
        const deletedByUsername = this.safeStr(req.query["deletedByUsername"]);
        if (deletedByUsername) out.deletedByUsername = deletedByUsername;
      
        const deletedFromIso = this.safeStr(req.query["deletedFromIso"]);
        if (deletedFromIso) out.deletedFromIso = deletedFromIso;
      
        const deletedToIso = this.safeStr(req.query["deletedToIso"]);
        if (deletedToIso) out.deletedToIso = deletedToIso;
      
        const tagsAny = this.readCsv(req.query["tagsAny"]);
        if (tagsAny.length > 0) out.tagsAny = tagsAny;
      
        const module = this.safeStr(req.query["module"]);
        if (module) out.module = module;
      
        const entity = this.safeStr(req.query["entity"]);
        if (entity) out.entity = entity;
      
        return out;
      }
      
      /**
       * ✅ Converts query string -> RecycleBinStatus safely.
       * Returns null if invalid / empty.
       */
      private parseStatus(raw: string): RecycleBinStatus | null {
        const s = raw.trim();
        if (!s) return null;
      
        // Keep list EXACTLY matching your model union
        const allowed: readonly RecycleBinStatus[] = [
          "recording",
          "recorded",
          "restore_in_progress",
          "restored",
          "purged",
          "failed",
        ];
      
        // TS-safe membership check (no any)
        for (const v of allowed) {
          if (v === s) return v;
        }
      
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

    private readCsv( v: unknown ): string[] {
        const s = this.safeStr( v );
        if ( !s ) return [];
        return s
            .split( "," )
            .map( ( x ) => x.trim() )
            .filter( ( x ) => x.length > 0 );
    }

    private safeStr( v: unknown ): string {
        if ( typeof v === "string" ) return v.trim();
        if ( Array.isArray( v ) && typeof v[ 0 ] === "string" ) return v[ 0 ].trim(); // Express query can be string[]
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
}
