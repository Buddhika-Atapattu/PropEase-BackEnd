// Path: src/services/recyclebin/recyclebin-engine.service.ts
// =============================================================================
// RecycleBinEngineService (Phase 2) — FIXED
// -----------------------------------------------------------------------------
// KEY FIXES:
// 1) Correct model import -> recyclebin-entry.model.ts
// 2) Correct audit writer import -> audits/recyclebin-audit-writer.service.ts
// 3) Keep audit query import under audits/
// 4) Keep exactOptionalPropertyTypes safe (omit optionals, no `{ session: undefined }`)
// =============================================================================

import path from "path";
import fs from "fs";
import fsp from "fs/promises";

import { Types, type ClientSession } from "mongoose";

import {
    RecycleBinEntryModel,
    type RecycleBinEntryEntity,
    type RecycleBinStatus,
} from "../../models/recyclebin/recyclebin-entry.model";

import type { AuthUser } from "../../types/common";
import type { FileMetaPacket } from "../../types/common";
import type { RecycleBinEntryDto, RecycleBinEntryLean } from '../../types/recyclebin/recyclebin.types';

import { RecycleBinAuditWriterService } from "./audits/recyclebin-audit-writer.service";
import { RecycleBinAuditQueryService } from "./audits/recyclebin-audit-query.service";

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
    extra?: Record<string, unknown>;

    snapshotData: Record<string, unknown>;
    files: FileMetaPacket[];
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

export interface RecyclePurgeResult {
    purged: boolean;
    entryId: string;
}

// =============================================================================
// B) Engine Service (100% class-based)
// =============================================================================

export class RecycleBinEngineService {
    /**
     * Root folder for recycle bin durability files.
     * Stored paths remain relative (Electron-safe): "public/..."
     */
    private readonly RECYCLE_ROOT_REL = "public/recyclebin";

    /**
     * Audit writer facade -> writes JSONL via your audit file service.
     * The engine only calls high-level methods (recorded/restored/purged).
     */
    private readonly auditWriter: RecycleBinAuditWriterService;

    /**
     * Audit query service -> used later by controller/UI endpoints.
     * (Not used heavily inside engine, but kept for completeness.)
     */
    private readonly auditQuery: RecycleBinAuditQueryService;

    public constructor () {
        this.auditWriter = new RecycleBinAuditWriterService();
        this.auditQuery = new RecycleBinAuditQueryService();
    }

    // ---------------------------------------------------------------------------
    // 1) RECORD
    // ---------------------------------------------------------------------------

    public async record( input: RecycleRecordInput, session?: ClientSession ): Promise<RecycleRecordResult> {
        // Validate minimal required fields (fail-fast)
        this.assertNonEmpty( input.sourceKey, "sourceKey" );
        this.assertNonEmpty( input.refId, "refId" );
        this.assertNonEmpty( input.label, "label" );

        // Compute recycle folder plan:
        // public/recyclebin/<sourceKey>/<refId>/{ snapshot.json, meta.json, files/ }
        const recycleDirRelPath = this.buildRecycleDirRelPath( input.sourceKey, input.refId );
        const snapshotRelPath = this.joinRel( recycleDirRelPath, "snapshot.json" );
        const metaRelPath = this.joinRel( recycleDirRelPath, "meta.json" );
        const filesDirRelPath = this.joinRel( recycleDirRelPath, "files" );

        // Ensure directories exist before writing/moving
        await this.ensureDir( this.abs( recycleDirRelPath ) );
        await this.ensureDir( this.abs( filesDirRelPath ) );

        // Write snapshot.json (durability)
        await this.safeWriteJson( this.abs( snapshotRelPath ), input.snapshotData );

        // Write meta.json (durability) — contains small metadata + pointers
        const metaObj = this.buildMetaObject( input, {
            recycleDirRelPath,
            snapshotRelPath,
            metaRelPath,
            filesDirRelPath,
        } );
        await this.safeWriteJson( this.abs( metaRelPath ), metaObj );

        // Move files to recyclebin/files/
        const movedFiles = await this.moveFilesIntoRecycle( filesDirRelPath, input.files );

        // Upsert DB entry (UI index + fast snapshotData)
        const now = new Date();

        // Path: src/services/recyclebin/recyclebin-engine.service.ts
        // inside record(...)

        // Build payload for upsertEntry in an exactOptionalPropertyTypes-safe way.
        // IMPORTANT: Do NOT set optional properties to undefined.
        // We only add them if we have a real value.
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

            // Optional fields (ONLY add when defined)
            description?: string;
            tags?: string[];
            module?: string;
            entity?: string;
            extra?: Record<string, unknown>;
        } = {
            sourceKey: input.sourceKey,
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

        // Conditionally attach optionals (never attach undefined)
        if ( input.description && input.description.trim().length > 0 ) {
            upsertPayload.description = input.description.trim();
        }

        if ( input.tags && input.tags.length > 0 ) {
            upsertPayload.tags = input.tags;
        }

        if ( input.module && input.module.trim().length > 0 ) {
            upsertPayload.module = input.module.trim();
        }

        if ( input.entity && input.entity.trim().length > 0 ) {
            upsertPayload.entity = input.entity.trim();
        }

        if ( input.extra && Object.keys( input.extra ).length > 0 ) {
            upsertPayload.extra = input.extra;
        }

        // Now call upsertEntry with a payload that cannot contain `description: undefined`
        const entryDoc = await this.upsertEntry( upsertPayload, session );


        // Audit hook (writes JSONL record via facade)
        await this.auditWriter.recordRecycleCreated(
            {
                entryId: String( entryDoc._id ),
                sourceKey: input.sourceKey,
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

    public async list( filters: RecycleListFilters, page: PageQuery ): Promise<RecycleListResult> {
        const query = this.buildMongoFilter( filters );

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

        const items = itemsLean.map( ( x ) => this.toDto( x ) );
        return { items, other: { total } };
    }


    public async count( filters: RecycleListFilters ): Promise<RecycleCountResult> {
        const query = this.buildMongoFilter( filters );
        const total = await RecycleBinEntryModel.countDocuments( query );
        return { total };
    }

    // ---------------------------------------------------------------------------
    // 3) READ SNAPSHOT (prefer disk, fallback to DB snapshotData)
    // ---------------------------------------------------------------------------

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

        return {
            entry: this.toDto( entryLean ),
            snapshotData,
            meta,
        };
    }


    // ---------------------------------------------------------------------------
    // 4) RESTORE PREPARE
    // ---------------------------------------------------------------------------

    public async prepareRestore( entryId: string, restoredBy: AuthUser, session?: ClientSession ): Promise<RecycleRestorePrepareResult> {
        this.assertNonEmpty( entryId, "entryId" );

        const entryLean = await RecycleBinEntryModel.findById( entryId ).lean<RecycleBinEntryLean>();
        if ( !entryLean ) throw new Error( "RecycleBin entry not found" );

        await this.updateStatus( entryLean._id, "restore_in_progress", restoredBy, session );

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

        const entry: RecycleBinEntryDto = this.toDto( entryLean );

        return { entry, snapshotData, files: entryLean.files };
    }


    public async markRestored( entryId: string, restoredBy: AuthUser, session?: ClientSession ): Promise<void> {
        this.assertNonEmpty( entryId, "entryId" );

        const entryLean = await RecycleBinEntryModel.findById( entryId ).lean<RecycleBinEntryLean>();
        if ( !entryLean ) throw new Error( "RecycleBin entry not found" );

        await this.updateStatus( entryLean._id, "restored", restoredBy, session );

        await this.auditWriter.recordRestored(
            {
                entryId: String( entryLean._id ),
                sourceKey: entryLean.sourceKey,
                refId: entryLean.refId,
            },
            restoredBy,
            session
        );
    }


    // ---------------------------------------------------------------------------
    // 5) PURGE (Disk + mark DB status)
    // ---------------------------------------------------------------------------

    public async purge( entryId: string, purgedBy: AuthUser, session?: ClientSession ): Promise<RecyclePurgeResult> {
        this.assertNonEmpty( entryId, "entryId" );

        const entryLean = await RecycleBinEntryModel.findById( entryId ).lean<RecycleBinEntryLean>();
        if ( !entryLean ) throw new Error( "RecycleBin entry not found" );

        await this.updateStatus( entryLean._id, "purged", purgedBy, session );

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
    // C) DB Helpers — exactOptionalPropertyTypes safe
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
        // Build the DB update in a JSON-safe way.
        // Important: we only include optional fields if they exist.
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
        session?: ClientSession
    ): Promise<void> {
        const now = new Date();

        // Mongo $set doc — only set fields relevant to the new state.
        const setDoc: Record<string, unknown> = { status };

        if ( status === "restored" || status === "restore_in_progress" ) {
            setDoc.restoredAt = now;
            setDoc.restoredBy = actor;
        }

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

        // exactOptionalPropertyTypes-safe: only attach if session exists
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

        if ( typeof e.description === "string" && e.description.trim().length > 0 ) {
            dto.description = e.description.trim();
        }
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
    // D) Disk Helpers
    // =============================================================================

    private abs( relPath: string ): string {
        // Input is "public/..." -> resolve to absolute path on disk
        return path.resolve( relPath );
    }

    private buildRecycleDirRelPath( sourceKey: string, refId: string ): string {
        // public/recyclebin/<sourceKey>/<refId>
        const cleanSource = this.sanitizeSegment( sourceKey );
        const cleanRef = this.sanitizeSegment( refId );
        return this.joinRel( this.RECYCLE_ROOT_REL, cleanSource, cleanRef );
    }

    private joinRel( ...segments: string[] ): string {
        // Force POSIX to keep stored paths consistent (no backslashes)
        return path.posix.join( ...segments.map( ( s ) => this.normalizeRelSegment( s ) ) );
    }

    private normalizeRelSegment( seg: string ): string {
        // Remove backslashes and leading slashes to keep Electron-safe rel paths
        const s = seg.replace( /\\/g, "/" ).trim();
        return s.startsWith( "/" ) ? s.slice( 1 ) : s;
    }

    private sanitizeSegment( seg: string ): string {
        // Block path traversal by restricting characters
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
            // best-effort: do not throw, because purge should still be recorded
        }
    }

    private async moveFilesIntoRecycle( filesDirRelPath: string, files: FileMetaPacket[] ): Promise<FileMetaPacket[]> {
        if ( !files || files.length === 0 ) return [];

        const targetDirAbs = this.abs( filesDirRelPath );
        await this.ensureDir( targetDirAbs );

        const moved: FileMetaPacket[] = [];

        for ( const file of files ) {
            const srcAbs = file.absDiskPath;

            // If the file is missing, we keep the original packet and continue.
            // This prevents one missing file from breaking the entire recycle operation.
            if ( !srcAbs || !fs.existsSync( srcAbs ) ) {
                moved.push( file );
                continue;
            }

            // Choose a stable filename inside recyclebin:
            // - Prefer storedName (usually unique)
            // - Fallback to originalName if storedName is missing
            const originalRel = ( file.relativePath ?? "" ).replace( /\\/g, "/" );
            const packedRel = this.sanitizeSegment( originalRel.replace( /\//g, "__" ) );

            const baseName =
                file.storedName && file.storedName.trim().length > 0
                    ? this.sanitizeSegment( file.storedName )
                    : this.sanitizeSegment( file.originalName );

            // ensures uniqueness across folders
            const safeName = packedRel.length > 0 ? `${ packedRel }__${ baseName }` : baseName;

            const destAbs = path.join( targetDirAbs, safeName );

            // Move file (rename or copy+unlink fallback)
            await this.safeMoveFile( srcAbs, destAbs );

            // Update packet so it points to recycle location (relative path for Electron)
            const relPath = this.joinRel( filesDirRelPath, safeName );

            const updated: FileMetaPacket = {
                ...file,
                relativePath: relPath,
                absDiskPath: destAbs,
                publicUrl: this.buildPublicUrl( relPath ),
            };

            moved.push( updated );
        }

        return moved;
    }

    private async safeMoveFile( srcAbs: string, destAbs: string ): Promise<void> {
        await this.ensureDir( path.dirname( destAbs ) );

        try {
            await fsp.rename( srcAbs, destAbs );
        } catch {
            // Cross-device rename can fail; copy+delete is the safe fallback
            await fsp.copyFile( srcAbs, destAbs );
            await fsp.unlink( srcAbs );
        }
    }

    private buildPublicUrl( relativePath: string ): string {
        // URL can safely start with "/" (this is not a disk path).
        // If your static hosting serves "public/" at "/public", then "/public/..."
        const normalized = relativePath.replace( /\\/g, "/" );
        if ( normalized.startsWith( "public/" ) ) return "/" + normalized;
        return "/public/" + normalized.replace( /^\/+/, "" );
    }

    private buildMetaObject(
        input: RecycleRecordInput,
        paths: { recycleDirRelPath: string; snapshotRelPath: string; metaRelPath: string; filesDirRelPath: string; }
    ): Record<string, unknown> {
        // meta.json is small, readable, and helps with future restore tooling.
        const meta: Record<string, unknown> = {
            version: 1,
            recordedAtIso: new Date().toISOString(),

            sourceKey: input.sourceKey,
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

            filesCount: Array.isArray( input.files ) ? input.files.length : 0,
        };

        if ( input.description ) meta.description = input.description;
        if ( input.tags && input.tags.length > 0 ) meta.tags = input.tags;
        if ( input.module ) meta.module = input.module;
        if ( input.entity ) meta.entity = input.entity;
        if ( input.extra ) meta.extra = input.extra;

        return meta;
    }

    // =============================================================================
    // E) Mongo Filter Builder
    // =============================================================================

    private buildMongoFilter( filters: RecycleListFilters ): Record<string, unknown> {
        const q: Record<string, unknown> = {};

        if ( filters.sourceKey ) q.sourceKey = filters.sourceKey;
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
    // F) Small Utilities
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
}
