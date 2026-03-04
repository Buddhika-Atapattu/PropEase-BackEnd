// Path: src/services/recyclebin/recyclebin-engine.service.ts
// =============================================================================
// RecycleBinEngineService — RECORD + LIST + SNAPSHOT + REAL RESTORE + PURGE
// -----------------------------------------------------------------------------
// What this engine solves (your requirements):
// ✅ 01) Fix path mapping (preserve folders)
//     uploads/users/<u>/images/x.webp
//       -> recyclebin/users/<u>/images/x.webp
//
// ✅ 02) Record DB collection name (non-breaking)
//     - Stored in: entry.extra.recycle.collectionName
//     - Also written to meta.json under meta.recycle.collectionName
//
// ✅ 03) REAL RESTORE (DB + Files)
//     - Restores snapshot document into recorded collection
//     - Moves files back: recyclebin/... -> uploads/...
//     - Marks entry status = restored
//
// ✅ 04) Universal + exactOptionalPropertyTypes-safe
//     - Never pass session: undefined
//     - Optional result fields are omitted unless they have a real value
//
// ✅ 05) Fix your bug:
//     - restoreDocKey must be "property" (NOT "propertie")
//     - status must not remain "restore_in_progress" after success/failure
//
// Notes
// - This engine does NOT decide RBAC; controller must guard restore/purge strictly.
// - This engine is universal: it never hard-locks to "properties/users" special cases.
//   Instead it uses a universal rule: restoreDocKey defaults to ORIGINAL sourceKey (singular).
// =============================================================================

import path from "path";
import fs from "fs";
import fsp from "fs/promises";
import { Request } from "express";

import { Types, type ClientSession } from "mongoose";

import {
    RecycleBinEntryModel,
    type RecycleBinEntryEntity,
    type RecycleBinStatus,
} from "../../models/recyclebin/recyclebin-entry.model";

import type { AuthUser } from "../../types/common";
import type { FileMetaPacket } from "../../types/common";
import type {
    RecycleBinEntryDto,
    RecycleBinEntryLean,
} from "../../types/recyclebin/recyclebin.types";

import { RecycleBinAuditWriterService } from "./audits/recyclebin-audit-writer.service";

// =============================================================================
// A) Engine Inputs / Outputs (service-level contracts)
// =============================================================================

export type RecycleSourceKey = string;

export interface RecycleRecordInput {
    sourceKey: RecycleSourceKey;
    refId: string;

    label: string;
    description?: string;

    deletedBy: AuthUser;

    tags?: string[];
    module?: string;
    entity?: string;

    /**
     * extra is already in your contract and schema.
     * We store recycle-specific metadata in:
     *   extra.recycle = { collectionName, restoreDocKey, folderKey, sourceKeyOriginal }
     */
    extra?: Record<string, unknown>;

    snapshotData: Record<string, unknown>;
    files: FileMetaPacket[];

    /** Optional but RECOMMENDED (caller knows the exact collection). */
    collectionName?: string;

    /** Optional hint: where the restore doc lives inside snapshotData (e.g. "user"). */
    restoreDocKey?: string;
}

export interface RecycleRecordResult {
    entryId: string;
    sourceKey: string;
    refId: string;
    status: RecycleBinStatus;

    recycleDirRelPath: string;
    snapshotRelPath: string;
    metaRelPath: string;
    filesDirRelPath: string;
}

export interface RecycleListFilters {
    sourceKey?: string;
    search?: string;
    status?: RecycleBinStatus;
    deletedByUsername?: string;

    deletedFromIso?: string;
    deletedToIso?: string;

    tagsAny?: string[];
    module?: string;
    entity?: string;
    includeRestored?: boolean;
}

export interface PageQuery {
    page: number;
    limit: number;
}

export interface RecycleListResult {
    items: RecycleBinEntryDto[];
    other: { total: number; };
}

export interface RecycleCountResult {
    total: number;
}

export interface RecycleReadSnapshotResult {
    entry: RecycleBinEntryDto;
    snapshotData: Record<string, unknown>;
    meta: Record<string, unknown>;
}

export interface RecycleRestorePrepareResult {
    entry: RecycleBinEntryDto;
    snapshotData: Record<string, unknown>;
    files: FileMetaPacket[];
}

/** REAL restore result (DB + Files). */
export interface RecycleRestoreResult {
    entryId: string;
    sourceKey: string;
    refId: string;

    restoredRefId?: string;
    collectionName: string;

    restoredObjectId?: string;

    filesRestored: FileMetaPacket[];
    entry: RecycleBinEntryDto;
}

export interface RecyclePurgeResult {
    purged: boolean;
    entryId: string;
}

// =============================================================================
// B) Engine Service (100% class-based)
// =============================================================================

export class RecycleBinEngineService {
    /** Stored paths remain relative (Electron-safe): "public/..." */
    private readonly RECYCLE_ROOT_REL = "public/recyclebin";
    private readonly UPLOADS_ROOT_REL = "public/uploads";

    private readonly auditWriter: RecycleBinAuditWriterService;

    public constructor () {
        this.auditWriter = new RecycleBinAuditWriterService();
    }

    // ---------------------------------------------------------------------------
    // 1) RECORD
    // ---------------------------------------------------------------------------

    /**
     * Record a deletion into the Recycle Bin (DB index + disk snapshot + moved files).
     *
     * @param input
     * - Required:
     *   - sourceKey: ORIGINAL (singular) logical key (e.g. "property", "user", "lease")
     *   - refId: domain ref id (uuid / business id)
     *   - label: UI label
     *   - deletedBy: AuthUser
     *   - snapshotData: Record<string, unknown> containing your restore doc at snapshotData[sourceKey]
     *   - files: FileMetaPacket[] representing real uploads tree
     *
     * - Optional:
     *   - collectionName: exact Mongo collection name to restore into (strongly recommended)
     *   - restoreDocKey: key inside snapshotData for restore doc (defaults to input.sourceKey)
     *   - extra: extra.recycle is merged (non-breaking)
     *
     * @param session
     * - Optional mongoose session (omit if none)
     */
    public async record( input: RecycleRecordInput, req: Request, session?: ClientSession ): Promise<RecycleRecordResult> {
        this.assertNonEmpty( input.sourceKey, "sourceKey" );
        this.assertNonEmpty( input.refId, "refId" );
        this.assertNonEmpty( input.label, "label" );

        // Folder key is plural for disk structure only.
        const folderKey = this.toPluralFolder( input.sourceKey );

        // public/recyclebin/<folderKey>/<refId>/
        const recycleDirRelPath = this.buildRecycleDirRelPath( folderKey, input.refId );
        const snapshotRelPath = this.joinRel( recycleDirRelPath, "snapshot.json" );
        const metaRelPath = this.joinRel( recycleDirRelPath, "meta.json" );

        // Compatibility: schema has filesDirRelPath; we keep it same as entry root
        const filesDirRelPath = recycleDirRelPath;

        await this.ensureDir( this.abs( recycleDirRelPath ) );
        await this.safeWriteJson( this.abs( snapshotRelPath ), input.snapshotData );

        // Restore hints (non-breaking)
        const collectionName = this.resolveCollectionName( input, folderKey );

        // ✅ CRITICAL FIX (universal):
        // restoreDocKey MUST default to ORIGINAL sourceKey (singular),
        // never derived from folderKey ("properties" -> "propertie" bug).
        const restoreDocKey = this.resolveRestoreDocKey( input );

        const extraMerged = this.mergeExtraRecycleHints( input.extra, {
            collectionName,
            restoreDocKey,
            folderKey,
            sourceKeyOriginal: input.sourceKey.trim(),
        } );

        const metaObj = this.buildMetaObject(
            input,
            {
                recycleDirRelPath,
                snapshotRelPath,
                metaRelPath,
                filesDirRelPath,
            },
            { collectionName, restoreDocKey, folderKey, sourceKeyOriginal: input.sourceKey.trim() }
        );

        await this.safeWriteJson( this.abs( metaRelPath ), metaObj );

        // Move files (preserve tree)
        const movedFiles = await this.moveFilesIntoRecyclePreserveTree(
            input.files,
            folderKey,
            input.refId,
            req,
        );

        const now = new Date();

        const upsertPayload: {
            sourceKey: string;
            refId: string;
            label: string;
            deletedAt: Date;
            deletedBy: AuthUser;

            recycleDirRelPath: string;
            snapshotRelPath: string;
            metaRelPath: string;
            filesDirRelPath: string;

            files: FileMetaPacket[];
            snapshotData: Record<string, unknown>;

            status: RecycleBinStatus;

            description?: string;
            tags?: string[];
            module?: string;
            entity?: string;
            extra?: Record<string, unknown>;
        } = {
            // stored sourceKey is folderKey (plural) for consistent listing paths
            sourceKey: folderKey,
            refId: input.refId,
            label: input.label,
            deletedAt: now,
            deletedBy: input.deletedBy,

            recycleDirRelPath,
            snapshotRelPath,
            metaRelPath,
            filesDirRelPath,

            files: movedFiles,
            snapshotData: input.snapshotData,

            status: "recorded",
        };

        if ( input.description && input.description.trim().length > 0 ) upsertPayload.description = input.description.trim();
        if ( input.tags && input.tags.length > 0 ) upsertPayload.tags = input.tags;
        if ( input.module && input.module.trim().length > 0 ) upsertPayload.module = input.module.trim();
        if ( input.entity && input.entity.trim().length > 0 ) upsertPayload.entity = input.entity.trim();
        if ( extraMerged && Object.keys( extraMerged ).length > 0 ) upsertPayload.extra = extraMerged;

        const entryDoc = await this.upsertEntry( upsertPayload, session );

        await this.auditWriter.recordRecycleCreated(
            {
                entryId: String( entryDoc._id ),
                sourceKey: folderKey,
                refId: input.refId,
                label: input.label,
            },
            input.deletedBy,
            session
        );

        return {
            entryId: String( entryDoc._id ),
            sourceKey: entryDoc.sourceKey,
            refId: entryDoc.refId,
            status: entryDoc.status,

            recycleDirRelPath: entryDoc.recycleDirRelPath,
            snapshotRelPath: entryDoc.snapshotRelPath,
            metaRelPath: entryDoc.metaRelPath,
            filesDirRelPath: entryDoc.filesDirRelPath,
        };
    }

    // ---------------------------------------------------------------------------
    // 2) LIST / COUNT
    // ---------------------------------------------------------------------------

    /**
     * List recycle bin entries with filters + pagination.
     *
     * @param filters Query filters (sourceKey/status/module/entity/search etc.)
     * @param page Page query { page, limit }
     */
    public async list( filters: RecycleListFilters, page: PageQuery ): Promise<RecycleListResult> {
        const query = this.buildMongoFilter( filters );

        // ✅ Default behavior: do NOT send restored items to frontend.
        // - If caller explicitly requests status="restored" → allow.
        // - If caller sets includeRestored=true → allow.
        const includeRestored = filters.includeRestored === true;

        if ( !includeRestored ) {
            // If caller did not explicitly set status filter, exclude restored.
            if ( !filters.status ) {
                query.status = { $ne: "restored" };
            }
            // If caller explicitly asked status="restored", don't override.
        }

        if ( !filters.status ) {
            query.status = { $nin: [ "restored" ] };
        }

        const safeLimit = this.clamp( page.limit, 1, 100 );
        const safePage = this.clamp( page.page, 1, 1_000_000 );
        const skip = ( safePage - 1 ) * safeLimit;

        const [ itemsLean, total ] = await Promise.all( [
            RecycleBinEntryModel.find( query )
                .sort( { deletedAt: -1 } )
                .skip( skip )
                .limit( safeLimit )
                .lean<RecycleBinEntryLean[]>(),
            RecycleBinEntryModel.countDocuments( query ),
        ] );

        return { items: itemsLean.map( ( x ) => this.toDto( x ) ), other: { total } };
    }

    /**
     * Count recycle bin entries for filters.
     *
     * @param filters same filters as list
     */
    public async count( filters: RecycleListFilters ): Promise<RecycleCountResult> {
        const query = this.buildMongoFilter( filters );
        const total = await RecycleBinEntryModel.countDocuments( query );
        return { total };
    }

    // ---------------------------------------------------------------------------
    // 3) READ SNAPSHOT
    // ---------------------------------------------------------------------------

    /**
     * Read snapshot + meta from disk if possible (fallback to DB snapshotData).
     *
     * @param entryId recycle entry id
     */
    public async readSnapshotByEntryId( entryId: string ): Promise<RecycleReadSnapshotResult> {
        this.assertNonEmpty( entryId, "entryId" );

        const entryLean = await RecycleBinEntryModel.findById( entryId ).lean<RecycleBinEntryLean>();
        if ( !entryLean ) throw new Error( "RecycleBin entry not found" );

        const diskSnapshot = await this.tryReadJson( this.abs( entryLean.snapshotRelPath ) );
        const diskMeta = await this.tryReadJson( this.abs( entryLean.metaRelPath ) );

        const snapshotData =
            diskSnapshot && this.isRecord( diskSnapshot )
                ? ( diskSnapshot as Record<string, unknown> )
                : entryLean.snapshotData;

        const meta =
            diskMeta && this.isRecord( diskMeta )
                ? ( diskMeta as Record<string, unknown> )
                : { warning: "meta.json missing" };

        return { entry: this.toDto( entryLean ), snapshotData, meta };
    }

    // ---------------------------------------------------------------------------
    // 4) RESTORE PREPARE
    // ---------------------------------------------------------------------------

    /**
     * Prepare restore (UI preview/confirm step).
     *
     * @param entryId entry id
     * @param restoredBy actor
     * @param session optional session
     */
    public async prepareRestore( entryId: string, restoredBy: AuthUser, req: Request, session?: ClientSession ): Promise<RecycleRestorePrepareResult> {
        this.assertNonEmpty( entryId, "entryId" );

        const entryLean = await RecycleBinEntryModel.findById( entryId ).lean<RecycleBinEntryLean>();
        if ( !entryLean ) throw new Error( "RecycleBin entry not found" );

        // ✅ Restrict restoring already restored entries (universal)
        if ( entryLean.status === "restored" ) {
            throw new Error( "This recycle entry is already restored." );
        }

        await this.updateStatus( entryLean._id, "restore_in_progress", restoredBy, req, session );

        const diskSnapshot = await this.tryReadJson( this.abs( entryLean.snapshotRelPath ) );
        const snapshotData =
            diskSnapshot && this.isRecord( diskSnapshot )
                ? ( diskSnapshot as Record<string, unknown> )
                : entryLean.snapshotData;

        await this.auditWriter.recordRestorePrepared(
            {
                entryId: String( entryLean._id ),
                sourceKey: entryLean.sourceKey,
                refId: entryLean.refId,
            },
            restoredBy,
            session
        );

        return { entry: this.toDto( entryLean ), snapshotData, files: entryLean.files };
    }

    // ---------------------------------------------------------------------------
    // 5) REAL RESTORE
    // ---------------------------------------------------------------------------

    /**
 * Restore a recyclebin entry back into its original MongoDB collection + move files back to uploads.
 *
 * 01) Introduction
 * - Universal restore entry point for the Recycle Bin engine.
 * - Restores DB document(s) by reading the snapshot content, then restores files.
 *
 * 02) Important matters (ISO/IEC 27001 / 27002)
 * - MUST NOT trust snapshot data blindly: collection name must be resolved from controlled metadata
 *   (entry.extra.recycle.collectionName / meta.json hints) and MUST be validated/allowed.
 * - MUST avoid leaving an entry stuck in "restore_in_progress" (revert on failure).
 * - MUST restore DB first, then files, then mark status "restored".
 *
 * 03) Why we make this method
 * - Provides a single, universal restore flow that works across modules, regardless of snapshot shape.
 *
 * @param options.entryId
 * - Expected: Mongo _id of recyclebin entry (string)
 *
 * @param options.restoredBy
 * - Expected: Auth user performing the restore (RBAC / audit)
 *
 * @param options.req
 * - Expected: Express Request (used to build public URLs and for audit metadata)
 *
 * @param options.session
 * - Optional: Mongoose session for transactional behavior (if your app uses sessions)
 *
 * @param options.restoreMode
 * - Optional: "insert" | "upsert"
 * - Default: "insert"
 * - "insert": fails if _id already exists
 * - "upsert": replaces/creates when _id exists (based on your restoreIntoCollection implementation)
 */
    public async restore( options: {
        entryId: string;
        restoredBy: AuthUser;
        req: Request;
        session?: ClientSession;
        restoreMode?: "insert" | "upsert";
    } ): Promise<RecycleRestoreResult> {
        this.assertNonEmpty( options.entryId, "entryId" );

        const entryDoc = await RecycleBinEntryModel
            .findById( options.entryId )
            .lean<RecycleBinEntryLean>();

        if ( !entryDoc ) throw new Error( "RecycleBin entry not found" );

        // ✅ Restrict restoring data that is already restored
        if ( entryDoc.status === "restored" ) {
            throw new Error( "This recycle entry is already restored." );
        }

        await this.updateStatus(
            entryDoc._id,
            "restore_in_progress",
            options.restoredBy,
            options.req,
            options.session
        );

        try {
            // ------------------------------------------------------------
            // 1) Load snapshot (disk preferred, DB fallback)
            // ------------------------------------------------------------
            const diskSnapshot = await this.tryReadJson( this.abs( entryDoc.snapshotRelPath ) );
            const snapshotData =
                diskSnapshot && this.isRecord( diskSnapshot )
                    ? ( diskSnapshot as Record<string, unknown> )
                    : entryDoc.snapshotData;

            // ------------------------------------------------------------
            // 2) Load meta (disk preferred, empty fallback)
            // ------------------------------------------------------------
            const metaDisk = await this.tryReadJson( this.abs( entryDoc.metaRelPath ) );
            const metaObj =
                metaDisk && this.isRecord( metaDisk )
                    ? ( metaDisk as Record<string, unknown> )
                    : {};

            // ------------------------------------------------------------
            // 3) Resolve controlled restore hints (collectionName is the anchor)
            //    - We keep resolveRestoreHints because it is your central place
            //      that reads entry.extra.recycle.collectionName etc.
            //    - We DO NOT restrict restore to restoreDocKey only.
            // ------------------------------------------------------------
            const { collectionName, restoreDocKey } = this.resolveRestoreHints( entryDoc, metaObj );

            // OPTIONAL BUT RECOMMENDED:
            // Validate collectionName is allowed to be restored (prevents abuse).
            // If you already do this inside restoreIntoCollection(), you can omit this call here.
            this.assertCollectionAllowedForRestore( collectionName );

            // ------------------------------------------------------------
            // 4) Universal snapshot picking (NO sourceKey coupling)
            //
            // Supported snapshot shapes:
            // A) sections[] format:
            //    { sections: [ { collection: "payment_transactions", docs: [...] }, ... ] }
            //
            // B) keyed-by-collection:
            //    { "payment_transactions": { ...doc } } OR { "payment_transactions": [ ...docs ] }
            //
            // C) legacy restoreDocKey wrapper:
            //    { transactions: { ...doc } } OR { transactions: [ ...docs ] }  (if restoreDocKey exists)
            //
            // D) raw-doc snapshot:
            //    { _id: ..., ... }  (transaction currently matches this)
            // ------------------------------------------------------------
            const restoreDocsRaw = this.pickRestoreDocumentsUniversal( {
                snapshotData,
                collectionName,
                restoreDocKey,
            } );

            if ( restoreDocsRaw.length === 0 ) {
                throw new Error(
                    `Restore document(s) not found in snapshotData for collection="${ collectionName }"`
                );
            }

            // Normalize + restore all docs (array-safe)
            const restoredIds: string[] = [];

            for ( const docRaw of restoreDocsRaw ) {
                const restoreDoc = this.normalizeRestoreDocument( docRaw );

                const restoreArgs: {
                    collectionName: string;
                    doc: Record<string, unknown>;
                    mode: "insert" | "upsert";
                    session?: ClientSession;
                } = {
                    collectionName,
                    doc: restoreDoc,
                    mode: options.restoreMode ?? "insert",
                };

                if ( options.session ) restoreArgs.session = options.session;

                const restoredObjectId = await this.restoreIntoCollection( restoreArgs );

                if ( restoredObjectId ) restoredIds.push( restoredObjectId );
            }

            // ------------------------------------------------------------
            // 5) Restore files back to uploads
            // ------------------------------------------------------------
            const filesRestored = await this.restoreFilesBackToUploads( entryDoc.files, options.req );

            // ------------------------------------------------------------
            // 6) Mark restored ONLY after DB + files succeed
            // ------------------------------------------------------------
            await this.updateStatus(
                entryDoc._id,
                "restored",
                options.restoredBy,
                options.req,
                options.session
            );

            await this.auditWriter.recordRestored(
                {
                    entryId: String( entryDoc._id ),
                    sourceKey: entryDoc.sourceKey,
                    refId: entryDoc.refId,
                },
                options.restoredBy,
                options.session
            );

            const updatedEntry = await RecycleBinEntryModel
                .findById( options.entryId )
                .lean<RecycleBinEntryLean>();

            if ( !updatedEntry ) throw new Error( "RecycleBin entry not found after restore" );

            const out: RecycleRestoreResult = {
                entryId: String( updatedEntry._id ),
                sourceKey: updatedEntry.sourceKey,
                refId: updatedEntry.refId,
                collectionName,
                filesRestored,
                entry: this.toDto( updatedEntry ),
                ...( restoredIds.length === 1 && restoredIds[ 0 ]
                    ? { restoredObjectId: restoredIds[ 0 ] }
                    : {} ),
            };

            // Keep the existing contract: expose a SINGLE id when exactly one doc was restored.
            if ( restoredIds.length === 1 ) {
                const restoredId = restoredIds[ 0 ];
                if ( restoredId ) {
                    out.restoredObjectId = restoredId;
                }
            }

            return out;
        } catch ( err: unknown ) {
            // ✅ Never leave stuck in restore_in_progress.
            // If restore fails, revert back to recorded so user can retry.
            await this.updateStatus(
                entryDoc._id,
                "recorded",
                options.restoredBy,
                options.req,
                options.session
            );

            throw err instanceof Error ? err : new Error( "Restore failed" );
        }
    }

    /**
     * Universal snapshot resolver (collection-driven, not sourceKey-driven).
     *
     * Supports:
     * - sections[] format
     * - keyed-by-collection format
     * - legacy restoreDocKey wrapper
     * - raw-doc snapshot fallback
     */
    private pickRestoreDocumentsUniversal( options: {
        snapshotData: Record<string, unknown> | unknown;
        collectionName: string;
        restoreDocKey: string;
    } ): Array<Record<string, unknown>> {
        const snap = options.snapshotData;

        // -------------------------
        // A) sections[] format
        // -------------------------
        if ( this.isRecord( snap ) ) {
            const sectionsUnknown = ( snap as Record<string, unknown> )[ "sections" ];
            if ( Array.isArray( sectionsUnknown ) ) {
                for ( const sec of sectionsUnknown ) {
                    if ( !this.isRecord( sec ) ) continue;

                    const collection = sec[ "collection" ];
                    const docs = sec[ "docs" ];

                    if ( typeof collection === "string" && collection === options.collectionName ) {
                        if ( Array.isArray( docs ) ) {
                            return docs.filter( ( d ) => this.isRecord( d ) ) as Array<Record<string, unknown>>;
                        }
                        if ( this.isRecord( docs ) ) return [ docs as Record<string, unknown> ];
                    }
                }
            }

            // -------------------------
            // B) keyed-by-collection format
            // -------------------------
            const byCollection = ( snap as Record<string, unknown> )[ options.collectionName ];
            if ( Array.isArray( byCollection ) ) {
                return byCollection.filter( ( d ) => this.isRecord( d ) ) as Array<Record<string, unknown>>;
            }
            if ( this.isRecord( byCollection ) ) return [ byCollection as Record<string, unknown> ];

            // -------------------------
            // C) legacy restoreDocKey wrapper (keep compatibility)
            // -------------------------
            const byKey = ( snap as Record<string, unknown> )[ options.restoreDocKey ];
            if ( Array.isArray( byKey ) ) {
                return byKey.filter( ( d ) => this.isRecord( d ) ) as Array<Record<string, unknown>>;
            }
            if ( this.isRecord( byKey ) ) return [ byKey as Record<string, unknown> ];

            // -------------------------
            // D) raw-doc snapshot fallback
            //   - if snapshot itself is a doc-like object, restore it directly
            // -------------------------
            if ( this.looksLikeMongoDocument( snap as Record<string, unknown> ) ) {
                return [ snap as Record<string, unknown> ];
            }
        }

        return [];
    }

    /**
     * Heuristic: checks if an object "looks like" a MongoDB document snapshot.
     * Keeps restore universal even when snapshotData is stored as the raw doc.
     */
    private looksLikeMongoDocument( obj: Record<string, unknown> ): boolean {
        // Common invariants across your domain docs:
        // - _id exists (string/ObjectId/extended-json)
        // - or createdAt/updatedAt
        if ( Object.prototype.hasOwnProperty.call( obj, "_id" ) ) return true;
        if ( Object.prototype.hasOwnProperty.call( obj, "createdAt" ) ) return true;
        if ( Object.prototype.hasOwnProperty.call( obj, "updatedAt" ) ) return true;
        return false;
    }

    /**
     * Security guard: validate collection name is allowed for restore.
     * (Implement your allow-list internally. If you already validate inside restoreIntoCollection, keep one source of truth.)
     */
    private assertCollectionAllowedForRestore( collectionName: string ): void {
        this.assertNonEmpty( collectionName, "collectionName" );
    }

    // ---------------------------------------------------------------------------
    // 6) PURGE
    // ---------------------------------------------------------------------------

    /**
     * Permanently delete recycle entry folder and mark DB row as purged.
     *
     * @param entryId entry id
     * @param purgedBy actor
     * @param session optional session
     */
    public async purge( entryId: string, purgedBy: AuthUser, req: Request, session?: ClientSession ): Promise<RecyclePurgeResult> {
        this.assertNonEmpty( entryId, "entryId" );

        const entryLean = await RecycleBinEntryModel.findById( entryId ).lean<RecycleBinEntryLean>();
        if ( !entryLean ) throw new Error( "RecycleBin entry not found" );

        await this.updateStatus( entryLean._id, "purged", purgedBy, req, session );
        await this.safeRmDir( this.abs( entryLean.recycleDirRelPath ) );

        await this.auditWriter.recordPurged(
            {
                entryId: String( entryLean._id ),
                sourceKey: entryLean.sourceKey,
                refId: entryLean.refId,
            },
            purgedBy,
            session
        );

        return { purged: true, entryId: String( entryLean._id ) };
    }

    // =============================================================================
    // C) DB Helpers
    // =============================================================================

    private async upsertEntry(
        data: {
            sourceKey: string;
            refId: string;

            label: string;
            description?: string;

            deletedAt: Date;
            deletedBy: AuthUser;

            recycleDirRelPath: string;
            snapshotRelPath: string;
            metaRelPath: string;
            filesDirRelPath: string;

            files: FileMetaPacket[];
            snapshotData: Record<string, unknown>;

            tags?: string[];
            module?: string;
            entity?: string;
            extra?: Record<string, unknown>;

            status: RecycleBinStatus;
        },
        session?: ClientSession
    ): Promise<RecycleBinEntryEntity> {
        const updateDoc: Record<string, unknown> = {
            sourceKey: data.sourceKey,
            refId: data.refId,

            label: data.label,
            deletedAt: data.deletedAt,
            deletedBy: data.deletedBy,

            recycleDirRelPath: data.recycleDirRelPath,
            snapshotRelPath: data.snapshotRelPath,
            metaRelPath: data.metaRelPath,
            filesDirRelPath: data.filesDirRelPath,

            files: data.files,
            snapshotData: data.snapshotData,

            status: data.status,
        };

        if ( typeof data.description === "string" && data.description.trim().length > 0 ) updateDoc.description = data.description.trim();
        if ( data.tags && data.tags.length > 0 ) updateDoc.tags = data.tags;
        if ( data.module ) updateDoc.module = data.module;
        if ( data.entity ) updateDoc.entity = data.entity;
        if ( data.extra ) updateDoc.extra = data.extra;

        const options = this.buildMongooseOptions( session, true );

        const doc = await RecycleBinEntryModel.findOneAndUpdate(
            { sourceKey: data.sourceKey, refId: data.refId },
            { $set: updateDoc },
            options
        );

        if ( !doc ) throw new Error( "RecycleBin entry upsert failed" );
        return doc;
    }

    private async updateStatus(
        entryObjectId: Types.ObjectId,
        status: RecycleBinStatus,
        actor: AuthUser,
        req: Request,
        session?: ClientSession,

    ): Promise<void> {
        const now = new Date();

        const setDoc: Record<string, unknown> = { status };

        // ✅ IMPORTANT FIX:
        // restoredAt/restoredBy must only be stamped when status === "restored".
        if ( status === "restored" ) {
            setDoc.restoredAt = now;
            setDoc.restoredBy = actor;
        }

        // Optional: you can add schema fields later (restoreStartedAt, restoreStartedBy)
        // but do not write unknown fields unless your schema supports them.

        if ( status === "purged" ) {
            setDoc.purgedAt = now;
            setDoc.purgedBy = actor;
        }

        await RecycleBinEntryModel.updateOne(
            { _id: entryObjectId },
            { $set: setDoc },
            this.buildMongooseOptions( session )
        );
    }

    private buildMongooseOptions( session?: ClientSession, returnDoc?: boolean ): Record<string, unknown> {
        const opts: Record<string, unknown> = {};
        if ( session ) opts.session = session;

        if ( returnDoc ) {
            opts.new = true;
            opts.upsert = true;
        }

        return opts;
    }

    private toDto( e: RecycleBinEntryLean ): RecycleBinEntryDto {
        const dto: RecycleBinEntryDto = {
            entryId: String( e._id ),
            sourceKey: e.sourceKey,
            refId: e.refId,
            label: e.label,
            deletedAtIso: e.deletedAt.toISOString(),
            deletedBy: e.deletedBy,

            recycleDirRelPath: e.recycleDirRelPath,
            snapshotRelPath: e.snapshotRelPath,
            metaRelPath: e.metaRelPath,
            filesDirRelPath: e.filesDirRelPath,

            files: e.files,
            snapshotData: e.snapshotData,

            status: e.status,
        };

        if ( typeof e.description === "string" && e.description.trim().length > 0 ) dto.description = e.description.trim();
        if ( e.tags && e.tags.length > 0 ) dto.tags = e.tags;
        if ( e.module ) dto.module = e.module;
        if ( e.entity ) dto.entity = e.entity;
        if ( e.extra ) dto.extra = e.extra;

        if ( e.restoredAt ) dto.restoredAtIso = e.restoredAt.toISOString();
        if ( e.restoredBy ) dto.restoredBy = e.restoredBy;

        if ( e.purgedAt ) dto.purgedAtIso = e.purgedAt.toISOString();
        if ( e.purgedBy ) dto.purgedBy = e.purgedBy;

        return dto;
    }

    // =============================================================================
    // D) Disk Helpers (path mapping fixed)
    // =============================================================================

    private abs( relPath: string ): string {
        return path.resolve( relPath );
    }

    private buildRecycleDirRelPath( folderKey: string, refId: string ): string {
        const cleanFolder = this.sanitizeSegment( folderKey );
        const cleanRef = this.sanitizeSegment( refId );
        return this.joinRel( this.RECYCLE_ROOT_REL, cleanFolder, cleanRef );
    }

    private joinRel( ...segments: string[] ): string {
        return path.posix.join( ...segments.map( ( s ) => this.normalizeRelSegment( s ) ) );
    }

    private normalizeRelSegment( seg: string ): string {
        const s = seg.replace( /\\/g, "/" ).replace( /^\/+/, "" ).trim();
        return s.startsWith( "/" ) ? s.slice( 1 ) : s;
    }

    private sanitizeSegment( seg: string ): string {
        return seg.replace( /[^a-zA-Z0-9_\-\.]/g, "_" );
    }

    private async ensureDir( absDir: string ): Promise<void> {
        await fsp.mkdir( absDir, { recursive: true } );
    }

    private async safeWriteJson( absPath: string, obj: unknown ): Promise<void> {
        const json = JSON.stringify( obj, null, 2 );
        await this.ensureDir( path.dirname( absPath ) );
        await fsp.writeFile( absPath, json, { encoding: "utf8" } );
    }

    private async tryReadJson( absPath: string ): Promise<unknown | null> {
        try {
            const buf = await fsp.readFile( absPath, { encoding: "utf8" } );
            return JSON.parse( buf );
        } catch {
            return null;
        }
    }

    private async safeRmDir( absDir: string ): Promise<void> {
        try {
            await fsp.rm( absDir, { recursive: true, force: true } );
        } catch {
            // best-effort
        }
    }

    /**
     * Move files into recyclebin while preserving folder tree:
     * public/uploads/... -> public/recyclebin/...
     */
    private async moveFilesIntoRecyclePreserveTree(
        files: FileMetaPacket[],
        folderKey: string,
        refId: string,
        req: Request,
    ): Promise<FileMetaPacket[]> {
        if ( !files || files.length === 0 ) return [];

        const moved: FileMetaPacket[] = [];

        for ( const file of files ) {
            const srcAbs = file.absDiskPath;

            if ( !srcAbs || !fs.existsSync( srcAbs ) ) {
                moved.push( file );
                continue;
            }

            const mappedRel = this.mapUploadsRelToRecycleRel( file.relativePath, folderKey, refId );
            const destAbs = this.abs( mappedRel );

            await this.ensureDir( path.dirname( destAbs ) );
            await this.safeMoveFile( srcAbs, destAbs );

            moved.push( {
                ...file,
                relativePath: mappedRel,
                absDiskPath: destAbs,
                publicUrl: this.buildPublicUrl( mappedRel, req ),
            } );
        }

        return moved;
    }

    /**
     * Restore files back:
     * public/recyclebin/... -> public/uploads/...
     */
    private async restoreFilesBackToUploads( files: FileMetaPacket[], req: Request ): Promise<FileMetaPacket[]> {
        if ( !files || files.length === 0 ) return [];

        const restored: FileMetaPacket[] = [];

        for ( const file of files ) {
            const srcAbs = file.absDiskPath;

            if ( !srcAbs || !fs.existsSync( srcAbs ) ) {
                restored.push( file );
                continue;
            }

            const mappedRel = this.mapRecycleRelToUploadsRel( file.relativePath );
            const destAbs = this.abs( mappedRel );

            await this.ensureDir( path.dirname( destAbs ) );
            await this.safeMoveFile( srcAbs, destAbs );

            restored.push( {
                ...file,
                relativePath: mappedRel,
                absDiskPath: destAbs,
                publicUrl: this.buildPublicUrl( mappedRel, req ),
            } );
        }

        return restored;
    }

    private async safeMoveFile( srcAbs: string, destAbs: string ): Promise<void> {
        await this.ensureDir( path.dirname( destAbs ) );
        try {
            await fsp.rename( srcAbs, destAbs );
        } catch {
            await fsp.copyFile( srcAbs, destAbs );
            await fsp.unlink( srcAbs );
        }
    }

    private buildPublicUrl( relativePath: string, req: Request ): string {

        /**
         * -----------------------------------------------------------
         * 01. Normalize path separators
         * -----------------------------------------------------------
         * Windows paths may contain "\" so convert to "/"
         */
        let normalized = relativePath.replace( /\\/g, "/" );

        /**
         * -----------------------------------------------------------
         * 02. Remove leading slashes
         * -----------------------------------------------------------
         * Ensures predictable path building
         */
        normalized = normalized.replace( /^\/+/, "" );

        /**
         * -----------------------------------------------------------
         * 03. Remove "public/" prefix
         * -----------------------------------------------------------
         * Because Express static serves:
         *
         * app.use("/public", express.static("public"));
         *
         * OR often:
         * app.use(express.static("public"));
         *
         * Your requirement:
         * public/uploads/x.png → uploads/x.png
         */
        normalized = normalized.replace( /^public\//, "" );

        /**
         * -----------------------------------------------------------
         * 04. Resolve host
         * -----------------------------------------------------------
         */
        const host = this.generateHost( req );

        /**
         * -----------------------------------------------------------
         * 05. Build final public URL
         * -----------------------------------------------------------
         */
        return `${ host }/${ normalized }`;
    }

    private generateHost( req: Request ): string {
        /**
         * -----------------------------------------------------------
         * 01. Determine protocol
         * -----------------------------------------------------------
         * - If the system is behind a proxy (Nginx / Cloudflare),
         *   the real protocol is usually in "x-forwarded-proto".
         * - Otherwise fall back to req.protocol.
         */
        const forwardedProto = req.headers[ "x-forwarded-proto" ];
        const protocol =
            typeof forwardedProto === "string"
                ? forwardedProto.split( "," )[ 0 ]
                : req.protocol;

        /**
         * -----------------------------------------------------------
         * 02. Determine host
         * -----------------------------------------------------------
         * - "x-forwarded-host" used when behind proxy
         * - otherwise standard "host" header
         */
        const forwardedHost = req.headers[ "x-forwarded-host" ];
        const host =
            typeof forwardedHost === "string"
                ? forwardedHost.split( "," )[ 0 ]
                : req.get( "host" );

        /**
         * -----------------------------------------------------------
         * 03. Safety fallback
         * -----------------------------------------------------------
         */
        if ( !host ) {
            console.warn( "[Warning:] Host header missing when generating host URL\n" );
            return `${ protocol }://localhost`;
        }

        /**
         * -----------------------------------------------------------
         * 04. Build full host URL
         * -----------------------------------------------------------
         */
        return `${ protocol }://${ host }`;
    }

    /**
     * Map: public/uploads/... -> public/recyclebin/...
     * Fallback: public/recyclebin/<folderKey>/<refId>/__files/<storedName>
     */
    private mapUploadsRelToRecycleRel( originalRel: string, folderKey: string, refId: string ): string {
        const rel = ( originalRel ?? "" ).replace( /\\/g, "/" ).replace( /^\/+/, "" ).trim();

        if ( rel.startsWith( "public/uploads/" ) ) {
            return "public/recyclebin/" + rel.slice( "public/uploads/".length );
        }
        if ( rel.startsWith( "uploads/" ) ) {
            return "public/recyclebin/" + rel.slice( "uploads/".length );
        }

        const safeStored = this.sanitizeSegment( this.pickFileNameFallback( rel ) );
        return this.joinRel( this.RECYCLE_ROOT_REL, folderKey, this.sanitizeSegment( refId ), "__files", safeStored );
    }

    /**
     * Map: public/recyclebin/... -> public/uploads/...
     */
    private mapRecycleRelToUploadsRel( recycleRel: string ): string {
        const rel = ( recycleRel ?? "" ).replace( /\\/g, "/" ).replace( /^\/+/, "" ).trim();

        if ( rel.startsWith( "public/recyclebin/" ) ) {
            return "public/uploads/" + rel.slice( "public/recyclebin/".length );
        }
        if ( rel.startsWith( "recyclebin/" ) ) {
            return "public/uploads/" + rel.slice( "recyclebin/".length );
        }

        return rel;
    }

    private pickFileNameFallback( rel: string ): string {
        const base = rel.split( "/" ).filter( Boolean ).pop();
        return base && base.trim().length > 0 ? base : "file.bin";
    }

    // =============================================================================
    // E) Restore internals (DB restore)
    // =============================================================================

    private resolveRestoreHints(
        entry: RecycleBinEntryLean,
        meta: Record<string, unknown>
    ): { collectionName: string; restoreDocKey: string; } {
        const extra = entry.extra && this.isRecord( entry.extra ) ? ( entry.extra as Record<string, unknown> ) : {};
        const recycle = this.getNestedRecord( extra, "recycle" );
        const metaRecycle = this.getNestedRecord( meta, "recycle" );

        const collectionFromHints =
            this.getString( metaRecycle, "collectionName" ) || this.getString( recycle, "collectionName" );

        const docKeyFromHints =
            this.getString( metaRecycle, "restoreDocKey" ) || this.getString( recycle, "restoreDocKey" );

        const sourceKeyOriginal =
            this.getString( metaRecycle, "sourceKeyOriginal" ) ||
            this.getString( recycle, "sourceKeyOriginal" );

        const collectionName =
            collectionFromHints && collectionFromHints.trim().length > 0
                ? this.normalizePluralY( collectionFromHints.trim() )
                : this.toPluralFolder( entry.sourceKey );

        // ✅ Universal default:
        // - prefer explicitly stored restoreDocKey
        // - else prefer stored sourceKeyOriginal (singular)
        // - else fall back to robust singularization
        const restoreDocKey =
            docKeyFromHints && docKeyFromHints.trim().length > 0
                ? docKeyFromHints.trim()
                : ( sourceKeyOriginal && sourceKeyOriginal.trim().length > 0
                    ? sourceKeyOriginal.trim()
                    : this.toSingularDocKey( entry.sourceKey ) );

        return { collectionName, restoreDocKey };
    }

    private pickRestoreDocument( snapshotData: Record<string, unknown>, restoreDocKey: string ): Record<string, unknown> | null {
        // 1) direct key
        const direct = snapshotData[ restoreDocKey ];
        if ( direct && this.isRecord( direct ) ) return direct;

        // 2) try plural key (rare, but safe)
        const plural = this.toPluralFolder( restoreDocKey );
        const pluralVal = snapshotData[ plural ];
        if ( pluralVal && this.isRecord( pluralVal ) ) return pluralVal;

        // 3) if snapshot has exactly one object field, use it
        const keys = Object.keys( snapshotData );
        const objectKeys = keys.filter( ( k ) => {
            const v = snapshotData[ k ];
            return v && this.isRecord( v );
        } );

        if ( objectKeys.length === 1 ) {
            const onlyKey = objectKeys[ 0 ];
            if ( !onlyKey ) return null;

            const v = snapshotData[ onlyKey ];
            return v && this.isRecord( v ) ? ( v as Record<string, unknown> ) : null;
        }

        return null;
    }

    private normalizeRestoreDocument( doc: Record<string, unknown> ): Record<string, unknown> {
        const out: Record<string, unknown> = { ...doc };

        const id = out[ "_id" ];
        if ( typeof id === "string" && this.isObjectIdHex( id ) ) {
            out[ "_id" ] = new Types.ObjectId( id );
        }

        return out;
    }

    private async restoreIntoCollection( options: {
        collectionName: string;
        doc: Record<string, unknown>;
        session?: ClientSession;
        mode: "insert" | "upsert";
    } ): Promise<string | undefined> {
        const db = RecycleBinEntryModel.db;
        const col = db.collection( options.collectionName );

        const docId = options.doc[ "_id" ];
        const hasId = docId instanceof Types.ObjectId;

        if ( options.mode === "insert" ) {
            // ✅ do NOT call insertOne(doc, undefined)
            const res = options.session
                ? await col.insertOne( options.doc, { session: options.session } )
                : await col.insertOne( options.doc );

            return res.insertedId ? String( res.insertedId ) : undefined;
        }

        if ( !hasId ) {
            throw new Error( "Upsert restoreMode requires snapshot document to contain a valid _id" );
        }

        await col.updateOne(
            { _id: docId },
            { $set: options.doc },
            options.session ? { upsert: true, session: options.session } : { upsert: true }
        );

        return String( docId );
    }

    // =============================================================================
    // F) Meta builder (includes restore hints)
    // =============================================================================

    private buildMetaObject(
        input: RecycleRecordInput,
        paths: { recycleDirRelPath: string; snapshotRelPath: string; metaRelPath: string; filesDirRelPath: string; },
        hints: { collectionName: string; restoreDocKey: string; folderKey: string; sourceKeyOriginal: string; }
    ): Record<string, unknown> {
        const meta: Record<string, unknown> = {
            version: 2,
            recordedAtIso: new Date().toISOString(),

            // stored "sourceKey" in entry is folderKey (plural). keep it consistent in meta too.
            sourceKey: hints.folderKey,
            refId: input.refId,
            label: input.label,

            deletedBy: {
                userId: input.deletedBy.userId,
                username: input.deletedBy.username,
                role: input.deletedBy.role,
                ...( input.deletedBy.teamCodes ? { teamCodes: input.deletedBy.teamCodes } : {} ),
                ...( input.deletedBy.branchId ? { branchId: input.deletedBy.branchId } : {} ),
            },

            disk: {
                recycleDirRelPath: paths.recycleDirRelPath,
                snapshotRelPath: paths.snapshotRelPath,
                metaRelPath: paths.metaRelPath,
                filesDirRelPath: paths.filesDirRelPath,
            },

            recycle: {
                collectionName: hints.collectionName,
                restoreDocKey: hints.restoreDocKey,

                // ✅ store original logical key to help future-proof restore
                sourceKeyOriginal: hints.sourceKeyOriginal,
            },

            filesCount: Array.isArray( input.files ) ? input.files.length : 0,
        };

        if ( input.description ) meta.description = input.description;
        if ( input.tags && input.tags.length > 0 ) meta.tags = input.tags;
        if ( input.module ) meta.module = input.module;
        if ( input.entity ) meta.entity = input.entity;

        if ( input.extra && Object.keys( input.extra ).length > 0 ) meta.extra = input.extra;

        return meta;
    }

    private mergeExtraRecycleHints(
        extra: Record<string, unknown> | undefined,
        hints: { collectionName: string; restoreDocKey: string; folderKey: string; sourceKeyOriginal: string; }
    ): Record<string, unknown> {
        const base: Record<string, unknown> = extra && this.isRecord( extra ) ? { ...( extra as Record<string, unknown> ) } : {};
        const recycleExisting = this.getNestedRecord( base, "recycle" );

        const recycle: Record<string, unknown> = {
            ...( recycleExisting ?? {} ),
            collectionName: hints.collectionName,
            restoreDocKey: hints.restoreDocKey,
            folderKey: hints.folderKey,
            sourceKeyOriginal: hints.sourceKeyOriginal,
        };

        base.recycle = recycle;
        return base;
    }

    private resolveCollectionName( input: RecycleRecordInput, folderKey: string ): string {
        if ( input.collectionName && input.collectionName.trim().length > 0 ) {
            return this.normalizePluralY( input.collectionName.trim() );
        }

        const extra = input.extra && this.isRecord( input.extra ) ? ( input.extra as Record<string, unknown> ) : {};
        const recycle = this.getNestedRecord( extra, "recycle" );
        const fromExtra = this.getString( recycle, "collectionName" );
        if ( fromExtra && fromExtra.trim().length > 0 ) {
            return this.normalizePluralY( fromExtra.trim() );
        }

        return this.normalizePluralY( folderKey );
    }

    /**
     * ✅ Universal restoreDocKey rule:
     * - If caller provides restoreDocKey: use it.
     * - Else if extra.recycle.restoreDocKey exists: use it.
     * - Else default to ORIGINAL sourceKey (singular), not derived from folderKey.
     */
    private resolveRestoreDocKey( input: RecycleRecordInput ): string {
        if ( input.restoreDocKey && input.restoreDocKey.trim().length > 0 ) return input.restoreDocKey.trim();

        const extra = input.extra && this.isRecord( input.extra ) ? ( input.extra as Record<string, unknown> ) : {};
        const recycle = this.getNestedRecord( extra, "recycle" );
        const fromExtra = this.getString( recycle, "restoreDocKey" );
        if ( fromExtra && fromExtra.trim().length > 0 ) return fromExtra.trim();

        // ✅ FIX: DEFAULT IS sourceKey ("property"), never folderKey ("properties")
        return input.sourceKey.trim();
    }

    // =============================================================================
    // G) Mongo Filter Builder
    // =============================================================================

    private buildMongoFilter( filters: RecycleListFilters ): Record<string, unknown> {
        const q: Record<string, unknown> = {};

        if ( filters.sourceKey ) q.sourceKey = this.toPluralFolder( filters.sourceKey );
        if ( filters.status ) q.status = filters.status;
        if ( filters.module ) q.module = filters.module;
        if ( filters.entity ) q.entity = filters.entity;

        if ( filters.deletedByUsername ) q[ "deletedBy.username" ] = filters.deletedByUsername;
        if ( filters.tagsAny && filters.tagsAny.length > 0 ) q.tags = { $in: filters.tagsAny };

        if ( filters.deletedFromIso || filters.deletedToIso ) {
            const range: Record<string, unknown> = {};
            if ( filters.deletedFromIso ) range.$gte = this.toDate( filters.deletedFromIso );
            if ( filters.deletedToIso ) range.$lte = this.toDate( filters.deletedToIso );
            q.deletedAt = range;
        }

        if ( filters.search && filters.search.trim().length > 0 ) {
            const s = filters.search.trim();
            q.$or = [
                { label: { $regex: s, $options: "i" } },
                { refId: { $regex: s, $options: "i" } },
                { "deletedBy.username": { $regex: s, $options: "i" } },
            ];
        }

        return q;
    }

    private toDate( iso: string ): Date {
        const d = new Date( iso );
        if ( Number.isNaN( d.getTime() ) ) throw new Error( "Invalid ISO date: " + iso );
        return d;
    }

    // =============================================================================
    // H) Small Utilities
    // =============================================================================

    private clamp( n: number, min: number, max: number ): number {
        if ( !Number.isFinite( n ) ) return min;
        return Math.max( min, Math.min( max, n ) );
    }

    private assertNonEmpty( val: string, name: string ): void {
        if ( !val || val.trim().length === 0 ) throw new Error( `${ name } is required` );
    }

    private isRecord( v: unknown ): v is Record<string, unknown> {
        return typeof v === "object" && v !== null && !Array.isArray( v );
    }

    private toPluralFolder( sourceKey: string ): string {
        const raw = typeof sourceKey === "string" ? sourceKey.trim() : "";
        if ( !raw ) return "items";

        const s = raw.toLowerCase();

        // already plural-ish
        if ( s.endsWith( "s" ) ) return s;

        // consonant + "y" => "ies"  (property -> properties)
        // vowel + "y" => "ys"       (toy -> toys)
        if ( s.endsWith( "y" ) && s.length >= 2 ) {
            const beforeY = s.charAt( s.length - 2 );
            const isVowel = [ "a", "e", "i", "o", "u" ].includes( beforeY );
            if ( !isVowel ) return `${ s.slice( 0, -1 ) }ies`;
        }

        return `${ s }s`;
    }

    private normalizePluralY( candidate: string ): string {
        const s = typeof candidate === "string" ? candidate.trim() : "";
        if ( !s ) return s;

        // Fix legacy "propertys" but do NOT break "toys"
        if ( s.endsWith( "ys" ) && s.length >= 3 ) {
            const beforeY = s.charAt( s.length - 3 ); // char before 'y'
            const isVowel = [ "a", "e", "i", "o", "u" ].includes( beforeY );
            if ( !isVowel ) return `${ s.slice( 0, -2 ) }ies`; // ...ys -> ...ies
        }

        return s;
    }

    /**
     * Robust-ish universal singularization:
     * - properties -> property
     * - companies  -> company
     * - classes    -> class  (removes "es" in common cases)
     * - users      -> user
     *
     * Note: This is only a fallback now; your primary restoreDocKey is stored explicitly.
     */
    private toSingularDocKey( key: string ): string {
        const s0 = typeof key === "string" ? key.trim().toLowerCase() : "";
        if ( !s0 ) return "item";

        if ( s0.endsWith( "ies" ) && s0.length > 3 ) {
            return `${ s0.slice( 0, -3 ) }y`;
        }

        // common "...es" plurals (classes, boxes, churches, wishes)
        const esEndings = [ "ses", "xes", "zes", "ches", "shes" ];
        for ( const end of esEndings ) {
            if ( s0.endsWith( end ) && s0.length > end.length ) {
                return s0.slice( 0, -2 ); // remove "es"
            }
        }

        if ( s0.endsWith( "s" ) && s0.length > 1 ) return s0.slice( 0, -1 );

        return s0;
    }

    private isObjectIdHex( v: string ): boolean {
        return /^[a-fA-F0-9]{24}$/.test( v );
    }

    private getNestedRecord( obj: Record<string, unknown>, key: string ): Record<string, unknown> | null {
        const v = obj[ key ];
        return v && this.isRecord( v ) ? ( v as Record<string, unknown> ) : null;
    }

    private getString( obj: Record<string, unknown> | null, key: string ): string | null {
        if ( !obj ) return null;
        const v = obj[ key ];
        return typeof v === "string" ? v : null;
    }
}