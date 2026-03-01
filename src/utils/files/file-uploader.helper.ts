// Path: src/utils/file-uploader.helper.ts
/* =============================================================================
 * 🔴🔴🔴 CRITICAL WARNING (DO NOT MODIFY WITHOUT SYSTEM REVIEW) 🔴🔴🔴
 * -----------------------------------------------------------------------------
 * SECURITY + CONTRACT CRITICAL infrastructure component.
 *
 * ✅ Invariants guaranteed:
 *  1) Path Traversal Protection
 *     - No caller can write/move/read outside:  /public
 *     - Uploads are always under:              /public/uploads
 *     - Soft deletes are always under:         /public/recyclebin
 *
 *  2) Universal Upload Result Packet
 *     - Every upload operation returns SAME shape (UploadResultPacket)
 *     - Supports single-field and multi-field uploads
 *     - byField always includes declared keys (empty arrays included)
 *
 *  3) Double-Run Protection
 *     - If route already ran multer middleware, we DO NOT run multer again
 *
 *  4) Recycle Bin Tree Mirror (Mirror Tree Design)
 *     - Moving to recyclebin preserves SAME public-relative path
 *       under recyclebin/<category>/<refId>/...
 *
 *  5) Directory-safe metadata arrays
 *     - FS ops accept file OR directory paths
 *     - Returned results include `meta: FileMetaPacket[]` (files-only, flat)
 * ============================================================================= */

import type { Request, Response } from "express";
import fs from "fs";
import fsp from "fs/promises";
import fse from "fs-extra";
import multer, { type StorageEngine } from "multer";
import path from "path";
import sharp from "sharp";

import type { FileMetaPacket } from "../../types/common";
import { PublicPathGuard } from "./public-path.guard";

/* =============================================================================
 * UNIVERSAL UPLOAD RESULT CONTRACT
 * ============================================================================= */

export interface UploadResultPacket {
  /**
   * Base relative directory under PUBLIC (unix style, no leading "/")
   * Example: "uploads/teamManagement/teamTasks/__tmp/<token>"
   */
  baseRelativeDir: string;

  /**
   * Base public URL prefix for UI usage
   * Example: "https://host/uploads/teamManagement/teamTasks/__tmp/<token>"
   */
  basePublicUrl: string;

  /** Total number of uploaded files across all fields */
  totalFiles: number;

  /** Total file bytes across all fields */
  totalBytes: number;

  /**
   * fieldName -> FileMetaPacket[]
   * ✅ ALWAYS includes declared field keys (even if empty arrays)
   */
  byField: Record<string, FileMetaPacket[]>;
}

/* =============================================================================
 * FILE SYSTEM CRUD RESULT CONTRACTS
 * ============================================================================= */

export interface FsMoveResult {
  /** moved items (public-relative unix paths, no leading "/") */
  moved: string[];
  /** skipped items (invalid / missing / not allowed) */
  skipped: string[];
  /** meta packets for FILES ONLY (flat list). Best-effort. */
  meta: FileMetaPacket[];
}

export interface FsCopyResult {
  copied: string[];
  skipped: string[];
  meta: FileMetaPacket[];
}

export interface FsDeleteResult {
  deleted: string[];
  skipped: string[];
  meta: FileMetaPacket[];
}

/* =============================================================================
 * TYPES
 * ============================================================================= */

type MoveKind = "file" | "dir";

type MoveItem =
  | string
  | {
    /**
     * Path can be:
     * - public-relative like "uploads/x/y.png"
     * - OR absolute disk path under /public (will be normalized)
     */
    path: string;

      /**
       * Optional kind hint:
       * - "file" or "dir"
       * - If omitted, kind is detected via fs.stat
       */
    kind?: MoveKind;
  };

/* =============================================================================
 * FILE UPLOADER (UNIVERSAL / MODULE-AGNOSTIC)
 * ============================================================================= */

export default class FileUploader {
  // ===========================================================================
  // 00) ROOT PATHS (filesystem)
  // ===========================================================================

  /** Absolute disk path: <project>/public */
  private static readonly PUBLIC_ROOT: string = path.resolve( process.cwd(), "public" );

  /** Absolute disk path: <project>/public/uploads */
  private static readonly UPLOAD_ROOT: string = path.join( FileUploader.PUBLIC_ROOT, "uploads" );

  /** Absolute disk path: <project>/public/recyclebin */
  private static readonly RECYCLEBIN_ROOT: string = path.join( FileUploader.PUBLIC_ROOT, "recyclebin" );

  // ===========================================================================
  // 01) PUBLIC API – MULTER BUILDERS
  // ===========================================================================

  /**
   * =============================================================================
   * 01) Why this method (with usage)
   * -----------------------------------------------------------------------------
   * Build a multer instance that stores uploads in memory (Buffer).
   * Useful when you want to validate/transform (e.g., Sharp) before saving.
   *
   * 02) Params (what it actually expects)
   * -----------------------------------------------------------------------------
   * - @param allowedMimeTypes: Set of allowed MIME strings.
   *   If empty => allow all.
   * - @param maxFileSizeMb: Per-file max size in MB.
   *
   * 03) Usage hint
   * -----------------------------------------------------------------------------
   * Use in controllers where you want:
   *   - req.file.buffer (single)
   *   - req.files[].buffer (multi)
   *
   * 04) Reasons to use this method
   * -----------------------------------------------------------------------------
   * - Image compression (webp), OCR pre-processing, virus scan, hashing.
   *
   * 05) What need to avoid
   * -----------------------------------------------------------------------------
   * - Very large files => memory pressure.
   *
   * 06) What result method generates
   * -----------------------------------------------------------------------------
   * Returns `multer.Multer` instance ready for route middleware usage.
   * =============================================================================
   */
  public static createMemoryUpload(
    allowedMimeTypes: ReadonlySet<string>,
    maxFileSizeMb: number,
  ): multer.Multer {
    const storage = multer.memoryStorage();

    const fileFilter: multer.Options[ "fileFilter" ] = ( _req, file, cb ): void => {
      if ( !allowedMimeTypes || allowedMimeTypes.size === 0 ) {
        cb( null, true );
        return;
      }

      if ( allowedMimeTypes.has( file.mimetype ) ) {
        cb( null, true );
        return;
      }

      cb( new Error( `File type not allowed: ${ file.mimetype }` ) );
    };

    return multer( {
      storage,
      limits: { fileSize: maxFileSizeMb * 1024 * 1024 },
      fileFilter,
    } );
  }

  /**
   * =============================================================================
   * 01) Why this method (with usage)
   * -----------------------------------------------------------------------------
   * Build a multer instance that stores uploads directly on disk (under /public/uploads).
   * Use when you need direct-to-disk streaming and stable stored files.
   *
   * 02) Params (what it actually expects)
   * -----------------------------------------------------------------------------
   * - @param allowedMimeTypes: allow-list Set; empty => allow all.
   * - @param maxFileSizeMb: per-file max MB.
   * - @param maxFiles: total max files per request.
   * - @param resolveDestination(req): returns:
   *     a) absolute path under /public/uploads, OR
   *     b) a relative subpath under uploads/ (like "users/<id>/avatar")
   *
   * 03) Usage hint
   * -----------------------------------------------------------------------------
   * Typical: createDiskUpload({ resolveDestination: (req) => `users/${id}/avatar` })
   *
   * 04) Reasons to use this method
   * -----------------------------------------------------------------------------
   * - Large uploads (avoid RAM usage)
   * - Universal file attachments storage
   *
   * 05) What need to avoid
   * -----------------------------------------------------------------------------
   * - Never return destinations outside /public/uploads
   * - Never pass "public/uploads/.." or traversal strings (guard rejects)
   *
   * 06) What result method generates
   * -----------------------------------------------------------------------------
   * Returns `multer.Multer` instance for routes.
   * =============================================================================
   */
  public static createDiskUpload( options: {
    allowedMimeTypes: ReadonlySet<string>;
    maxFileSizeMb: number;
    maxFiles: number;
    resolveDestination: ( req: Request ) => Promise<string> | string;
  } ): multer.Multer {
    const storage: StorageEngine = multer.diskStorage( {
      destination: async ( req, _file, cb ): Promise<void> => {
        try {
          const resolved = await options.resolveDestination( req );
          const dest = FileUploader.normalizeAndValidateDiskDestination( resolved );
          await FileUploader.ensureDirectory( dest );
          cb( null, dest );
        } catch ( error: unknown ) {
          cb( error instanceof Error ? error : new Error( String( error ) ), FileUploader.UPLOAD_ROOT );
        }
      },

      filename: ( _req, file, cb ): void => {
        // ✅ Correct: originalname is the only reliable source for extension here
        const ext = path.extname( file.originalname );
        const base = path.basename( file.originalname, ext );
        const storedName = `${ FileUploader.slugify( base ) }_${ Date.now() }${ ext.toLowerCase() }`;
        cb( null, storedName );
      },
    } );

    const fileFilter: multer.Options[ "fileFilter" ] = ( _req, file, cb ): void => {
      if ( !options.allowedMimeTypes || options.allowedMimeTypes.size === 0 ) {
        cb( null, true );
        return;
      }

      if ( options.allowedMimeTypes.has( file.mimetype ) ) {
        cb( null, true );
        return;
      }

      cb( new Error( `File type not allowed: ${ file.mimetype }` ) );
    };

    return multer( {
      storage,
      limits: {
        fileSize: options.maxFileSizeMb * 1024 * 1024,
        files: options.maxFiles,
      },
      fileFilter,
    } );
  }

  // ===========================================================================
  // 02) PUBLIC API – UNIVERSAL UPLOAD (SINGLE FIELD)
  // ===========================================================================

  /**
   * =============================================================================
   * 01) Why this method (with usage)
   * -----------------------------------------------------------------------------
   * Universal single-field uploader that saves to:
   *   public/uploads/<subPath>/<fieldName>/
   * And returns a stable `UploadResultPacket` with meta.
   *
   * 02) Params (what it actually expects)
   * -----------------------------------------------------------------------------
   * - @param subPath:
   *     Relative under uploads (RECOMMENDED):
   *       "users/<username>" or "teamManagement/teamTasks/__tmp/<token>"
   *     Also tolerated:
   *       "uploads/..." or "public/uploads/..." (auto-normalized)
   *     Also tolerated (ONLY if inside public/uploads):
   *       absolute disk path "D:\\...\\public\\uploads\\users\\x"
   * - @param fieldName:
   *     Multer field name ("avatar", "evidence", "attachments", etc.)
   * - @param req:
   *     Express Request (req.files may already contain files if middleware ran upstream)
   * - @param options:
   *     allowedMimeTypes / maxFileSizeMb / maxFiles
   *
   * 03) Usage hint
   * -----------------------------------------------------------------------------
   * In controller:
   *   const out = await FileUploader.handleUpload(`users/${username}`, "avatar", req, {...});
   *
   * 04) Reasons to use this method
   * -----------------------------------------------------------------------------
   * - Contract-stable result packet
   * - Prevents accidental double-multer runs
   * - Enforces storage only inside /public/uploads
   *
   * 05) What need to avoid
   * -----------------------------------------------------------------------------
   * - Do NOT pass recyclebin paths here (this is an uploader under uploads)
   * - Do NOT pass absolute paths outside /public/uploads
   *
   * 06) What result method generates
   * -----------------------------------------------------------------------------
   * UploadResultPacket:
   *   - baseRelativeDir: "uploads/<subPath>"
   *   - byField[fieldName]: FileMetaPacket[]
   *   - totalFiles/totalBytes aggregated
   * =============================================================================
   */
  public static async handleUpload(
    subPath: string,
    fieldName: string,
    req: Request,
    options?: {
      allowedMimeTypes?: ReadonlySet<string>;
      maxFileSizeMb?: number;
      maxFiles?: number;
    },
  ): Promise<UploadResultPacket> {
    // 1) Normalize subPath safely (absolute paths allowed ONLY if inside public/uploads)
    const safeSubPath = FileUploader.normalizeSubPath( subPath );
    if ( !safeSubPath.trim() ) {
      throw new Error( "Uploading path is required!" );
    }

    // 2) Sanitize field name
    const safeField = FileUploader.sanitizeSegmentStrict( fieldName );
    if ( !safeField ) {
      throw new Error( "fieldName is required!" );
    }

    // 3) Build base outputs
    const baseRelativeDir = [ "uploads", safeSubPath ].filter( Boolean ).join( "/" ).replace( /^\/+/, "" );
    const basePublicUrl = `${ FileUploader.buildOriginFromReq( req ) }/${ baseRelativeDir }`;

    // 4) Double-run protection: if req.files already contains this field, just normalize packets
    const already = FileUploader.readExistingFilesForField( req, safeField );
    if ( already.length > 0 ) {
      const packets = already.map( ( f ) =>
        FileUploader.toFilePacket( { req, safeSubPath, fieldName: safeField, file: f } ),
      );

      return FileUploader.buildUploadResult( baseRelativeDir, basePublicUrl, {
        [ safeField ]: packets,
      } );
    }

    // 5) Prepare destination dir: /public/uploads/<safeSubPath>/<safeField>/
    const baseDir = FileUploader.buildSafeChildDir( FileUploader.UPLOAD_ROOT, safeSubPath );
    const fieldDir = FileUploader.buildSafeChildDir( baseDir, safeField );
    await FileUploader.ensureDirectory( fieldDir );

    // 6) Configure multer disk storage
    const storage: StorageEngine = multer.diskStorage( {
      destination: ( _req, _file, cb ) => cb( null, fieldDir ),
      filename: ( _req, file, cb ) => {
        // ✅ FIX: extension must come from originalname
        const ext = path.extname( file.originalname );
        const base = path.basename( file.originalname, ext );
        const storedName = `${ FileUploader.slugify( base ) }_${ Date.now() }${ ext.toLowerCase() }`;
        cb( null, storedName );
      },
    } );

    // 7) File filter
    const fileFilter: multer.Options[ "fileFilter" ] = ( _req, file, cb ): void => {
      const allowed = options?.allowedMimeTypes;

      if ( !allowed || allowed.size === 0 ) {
        cb( null, true );
        return;
      }

      if ( allowed.has( file.mimetype ) ) {
        cb( null, true );
        return;
      }

      cb( new Error( `File type not allowed: ${ file.mimetype }` ) );
    };

    // 8) Run multer
    const upload = multer( {
      storage,
      limits: {
        fileSize: ( options?.maxFileSizeMb ?? 20 ) * 1024 * 1024,
        files: options?.maxFiles ?? 20,
      },
      fileFilter,
    } ).array( safeField );

    // 9) Execute multer (promise wrapper)
    const files: Express.Multer.File[] = await new Promise( ( resolve, reject ) => {
      upload( req, {} as unknown as Response, ( err: unknown ) => {
        if ( err ) {
          const msg = err instanceof Error ? err.message : "Unknown upload error";
          reject( new Error( `File upload failed: ${ msg }` ) );
          return;
        }
        resolve( ( ( req.files ?? [] ) as unknown ) as Express.Multer.File[] );
      } );
    } );

    // 10) Pack meta
    const packets = files.map( ( f ) =>
      FileUploader.toFilePacket( { req, safeSubPath, fieldName: safeField, file: f } ),
    );

    // 11) Return stable packet
    return FileUploader.buildUploadResult( baseRelativeDir, basePublicUrl, {
      [ safeField ]: packets,
    } );
  }

  // ===========================================================================
  // 03) PUBLIC API – UNIVERSAL UPLOAD (MULTI FIELD)
  // ===========================================================================

  /**
   * =============================================================================
   * 01) Why this method (with usage)
   * -----------------------------------------------------------------------------
   * Universal multi-field uploader that saves to:
   *   public/uploads/<subPath>/<fieldName>/
   * for each declared field, and returns stable UploadResultPacket.
   *
   * 02) Params (what it actually expects)
   * -----------------------------------------------------------------------------
   * - @param subPath:
   *   Same rules as handleUpload() (relative under uploads preferred).
   * - @param fields:
   *   Multer fields config:
   *     [{ name: "evidence", maxCount: 10 }, { name: "attachments", maxCount: 5 }]
   * - @param req:
   *   Express request
   * - @param options:
   *   allowedMimeTypesByField, maxFileSizeMb (per-file), maxFiles (total)
   *
   * 03) Usage hint
   * -----------------------------------------------------------------------------
   * const out = await FileUploader.handleMultiFieldUpload(
   *   `leases/${leaseId}`,
   *   [{ name: "tenantSignature", maxCount: 1 }, { name: "tenantScanedDocuments", maxCount: 10 }],
   *   req,
   *   { allowedMimeTypesByField: {...} }
   * )
   *
   * 04) Reasons to use this method
   * -----------------------------------------------------------------------------
   * - Upload multiple logical buckets in one request
   * - Output.byField ALWAYS includes declared keys (even if empty)
   *
   * 05) What need to avoid
   * -----------------------------------------------------------------------------
   * - Passing undeclared field names expecting them to appear (they’ll be stored but not “seeded”)
   * - Passing absolute paths outside public/uploads (throws)
   *
   * 06) What result method generates
   * -----------------------------------------------------------------------------
   * UploadResultPacket with:
   * - baseRelativeDir / basePublicUrl
   * - byField per declared field
   * - totals (files/bytes)
   * =============================================================================
   */
  public static async handleMultiFieldUpload(
    subPath: string,
    fields: Array<{ name: string; maxCount?: number; }>,
    req: Request,
    options?: {
      allowedMimeTypesByField?: Record<string, ReadonlySet<string>>;
      maxFileSizeMb?: number;
      maxFiles?: number;
    },
  ): Promise<UploadResultPacket> {
    const safeSubPath = FileUploader.normalizeSubPath( subPath );
    if ( !safeSubPath.trim() ) {
      throw new Error( "Uploading path is required!" );
    }

    // Seed declared keys (empty arrays must exist)
    const seededByField = FileUploader.seedByFieldKeys( fields );

    const baseRelativeDir = [ "uploads", safeSubPath ].filter( Boolean ).join( "/" ).replace( /^\/+/, "" );
    const basePublicUrl = `${ FileUploader.buildOriginFromReq( req ) }/${ baseRelativeDir }`;

    // Double-run protection
    const existing = FileUploader.readExistingFilesMulti( req );
    if ( Object.keys( existing ).length > 0 ) {
      for ( const [ rawField, filesArr ] of Object.entries( existing ) ) {
        const field = FileUploader.sanitizeSegmentStrict( rawField );
        if ( !field ) continue;

        if ( !Object.prototype.hasOwnProperty.call( seededByField, field ) ) {
          seededByField[ field ] = [];
        }

        const arr = Array.isArray( filesArr ) ? filesArr : [];
        seededByField[ field ] = arr.map( ( f ) =>
          FileUploader.toFilePacket( { req, safeSubPath, fieldName: field, file: f } ),
        );
      }

      return FileUploader.buildUploadResult( baseRelativeDir, basePublicUrl, seededByField );
    }

    // Base dir: /public/uploads/<safeSubPath>/
    const baseDir = FileUploader.buildSafeChildDir( FileUploader.UPLOAD_ROOT, safeSubPath );
    await FileUploader.ensureDirectory( baseDir );

    // Storage: each field gets its own folder under baseDir
    const storage: StorageEngine = multer.diskStorage( {
      destination: async ( _req, file, cb ): Promise<void> => {
        try {
          const safeFieldName = FileUploader.sanitizeSegmentStrict( file.fieldname );
          const fieldDir = FileUploader.buildSafeChildDir( baseDir, safeFieldName );
          await FileUploader.ensureDirectory( fieldDir );
          cb( null, fieldDir );
        } catch ( error: unknown ) {
          cb( error instanceof Error ? error : new Error( String( error ) ), baseDir );
        }
      },

      filename: ( _req, file, cb ): void => {
        // ✅ FIX: extension must come from originalname
        const ext = path.extname( file.originalname );
        const base = path.basename( file.originalname, ext );
        const storedName = `${ FileUploader.slugify( base ) }_${ Date.now() }${ ext.toLowerCase() }`;
        cb( null, storedName );
      },
    } );

    // Per-field filter
    const fileFilter: multer.Options[ "fileFilter" ] = ( _req, file, cb ): void => {
      const byField = options?.allowedMimeTypesByField;

      if ( !byField || Object.keys( byField ).length === 0 ) {
        cb( null, true );
        return;
      }

      const allow = byField[ file.fieldname ];

      if ( !allow || allow.size === 0 ) {
        cb( null, true );
        return;
      }

      if ( allow.has( file.mimetype ) ) {
        cb( null, true );
        return;
      }

      cb( new Error( `File type not allowed for field "${ file.fieldname }": ${ file.mimetype }` ) );
    };

    const upload = multer( {
      storage,
      limits: {
        fileSize: ( options?.maxFileSizeMb ?? 20 ) * 1024 * 1024,
        files: options?.maxFiles ?? 40,
      },
      fileFilter,
    } ).fields( fields );

    const filesByField: Record<string, Express.Multer.File[]> = await new Promise( ( resolve, reject ) => {
      upload( req, {} as unknown as Response, ( err: unknown ) => {
        if ( err ) {
          const msg = err instanceof Error ? err.message : "Unknown upload error";
          reject( new Error( `File upload failed: ${ msg }` ) );
          return;
        }

        const uploaded = ( req.files as unknown ) as Record<string, Express.Multer.File[]> | undefined;
        resolve( uploaded ?? {} );
      } );
    } );

    // Fill seeded keys
    for ( const [ rawFieldName, filesArr ] of Object.entries( filesByField ) ) {
      const field = FileUploader.sanitizeSegmentStrict( rawFieldName );
      if ( !field ) continue;

      if ( !Object.prototype.hasOwnProperty.call( seededByField, field ) ) {
        seededByField[ field ] = [];
      }

      const arr = Array.isArray( filesArr ) ? filesArr : [];
      seededByField[ field ] = arr.map( ( f ) =>
        FileUploader.toFilePacket( { req, safeSubPath, fieldName: field, file: f } ),
      );
    }

    return FileUploader.buildUploadResult( baseRelativeDir, basePublicUrl, seededByField );
  }

  // ===========================================================================
  // 04) PUBLIC API – SAVE IMAGE BUFFER (MEMORY -> WEBP)
  // ===========================================================================

  /**
   * =============================================================================
   * 01) Why this method (with usage)
   * -----------------------------------------------------------------------------
   * Convert a Buffer (memory upload) into a single WEBP file on disk under uploads/.
   * Great for profile images, thumbnails, and predictable image format storage.
   *
   * 02) Params (what it actually expects)
   * -----------------------------------------------------------------------------
   * - @param req: Express request (for absolute URL)
   * 
   * - @param subPath: relative under uploads (preferred), tolerated "uploads/.." or "public/uploads/.."
   * 
   * - @param fieldName: destination folder name under subPath ("avatar", "thumbnail", etc.)
   * 
   * - @param originalName: used only to derive base name (semantic)
   * 
   * - @param buffer: image bytes
   * 
   * - @param webpQuality: 1..100 (default 80)
   *
   * 03) Usage hint
   * -----------------------------------------------------------------------------
   * - Use with createMemoryUpload() + controller transforms
   *
   * 04) Reasons to use this method
   * -----------------------------------------------------------------------------
   * - Consistent format
   * - Smaller storage size
   *
   * 05) What need to avoid
   * -----------------------------------------------------------------------------
   * - Passing non-image buffer (Sharp will throw)
   * - Passing absolute paths outside public/uploads (throws)
   *
   * 06) What result method generates
   * -----------------------------------------------------------------------------
   * UploadResultPacket with byField[fieldName] containing one FileMetaPacket
   * =============================================================================
   */
  public static async saveWebPFromMemory( options: {
    req: Request;
    subPath: string;
    fieldName: string;
    originalName: string;
    buffer: Buffer;
    webpQuality?: number;
  } ): Promise<UploadResultPacket> {
    const safeSubPath = FileUploader.normalizeSubPath( options.subPath );
    if ( !safeSubPath.trim() ) throw new Error( "Uploading path is required!" );

    const fieldName = FileUploader.sanitizeSegmentStrict( options.fieldName );
    if ( !fieldName ) throw new Error( "fieldName is required!" );

    const baseRelativeDir = [ "uploads", safeSubPath ].filter( Boolean ).join( "/" ).replace( /^\/+/, "" );
    const basePublicUrl = `${ FileUploader.buildOriginFromReq( options.req ) }/${ baseRelativeDir }`;

    const baseDir = FileUploader.buildSafeChildDir( FileUploader.UPLOAD_ROOT, safeSubPath );
    const fieldDir = FileUploader.buildSafeChildDir( baseDir, fieldName );
    await FileUploader.ensureDirectory( fieldDir );

    const quality = typeof options.webpQuality === "number" ? options.webpQuality : 80;

    const rawBase = path.basename(
      String( options.originalName ?? "image" ),
      path.extname( String( options.originalName ?? "image" ) ),
    );

    const storedName = `${ FileUploader.slugify( rawBase ) }_${ Date.now() }.webp`;
    const absDiskPath = path.join( fieldDir, storedName );

    await sharp( options.buffer ).webp( { quality } ).toFile( absDiskPath );

    const relativePath = [ "uploads", safeSubPath, fieldName, storedName ]
      .filter( Boolean )
      .join( "/" )
      .replace( /^\/+/, "" );

    const publicUrl = `${ FileUploader.buildOriginFromReq( options.req ) }/${ relativePath }`;
    const stat = await fse.stat( absDiskPath );

    const packet: FileMetaPacket = FileUploader.packPacket( {
      originalName: String( options.originalName ?? "" ).trim() || storedName,
      storedName,
      extension: "webp",
      mimeType: "image/webp",
      sizeBytes: stat.size,
      relativePath,
      publicUrl,
      absDiskPath,
      fieldName,
      uploadedAtIso: new Date().toISOString(),
    } );

    return FileUploader.buildUploadResult( baseRelativeDir, basePublicUrl, {
      [ fieldName ]: [ packet ],
    } );
  }

  // ===========================================================================
  // 05) PUBLIC API – META (FILES ONLY)
  // ===========================================================================

  /**
   * =============================================================================
   * 01) Why this method (with usage)
   * -----------------------------------------------------------------------------
   * Read FileMetaPacket[] for file OR directory inputs under public/.
   * If a directory is passed, it recursively scans and returns FILE packets only.
   *
   * 02) Params (what it actually expects)
   * -----------------------------------------------------------------------------
   * - @param items:
   *   - "uploads/..." or "recyclebin/..." (public-relative)
   *   - OR absolute disk path under /public
   *   - OR MoveItem with optional kind hint
   * - @param req (optional): to generate absolute publicUrl
   * - @param onlyUploads (default true): restrict scanning to uploads/
   * - @param allowRecyclebin (default false): allow recyclebin/
   *
   * 03) Usage hint
   * -----------------------------------------------------------------------------
   * - Use after copy/move to compute meta for UI lists.
   *
   * 04) Reasons to use this method
   * -----------------------------------------------------------------------------
   * - Windows-like "Recycle Bin list" needs meta from folders too.
   *
   * 05) What need to avoid
   * -----------------------------------------------------------------------------
   * - Passing paths outside public (guard will sanitize/skip)
   *
   * 06) What result method generates
   * -----------------------------------------------------------------------------
   * FileMetaPacket[] (files-only), flattened.
   * =============================================================================
   */
  public static async readPublicMetaArray( options: {
    items: MoveItem | MoveItem[];
    req?: Request;
    onlyUploads?: boolean;
    allowRecyclebin?: boolean;
  } ): Promise<FileMetaPacket[]> {
    const list: MoveItem[] = Array.isArray( options.items ) ? options.items : [ options.items ];

    const onlyUploads = options.onlyUploads !== undefined ? options.onlyUploads : true;
    const allowRecyclebin = options.allowRecyclebin === true;

    const out: FileMetaPacket[] = [];

    for ( const it of list ) {
      const rawPath = typeof it === "string" ? it : it.path;
      const hintedKind: MoveKind | null = typeof it === "string" ? null : it.kind ?? null;

      const trimmed = String( rawPath ?? "" ).trim();
      if ( !trimmed ) continue;

      const relCandidate = FileUploader.toPublicRelativeIfAbs( trimmed );
      const rel = FileUploader.sanitizePublicRelativePath( relCandidate );

      if ( !rel ) continue;

      const isUploads = rel.startsWith( "uploads/" );
      const isRecycle = rel.startsWith( "recyclebin/" );

      if ( onlyUploads && !isUploads ) continue;
      if ( !allowRecyclebin && isRecycle ) continue;
      if ( !isUploads && !isRecycle ) continue;

      const abs = FileUploader.buildSafeChildPath( FileUploader.PUBLIC_ROOT, rel );
      if ( !fs.existsSync( abs ) ) continue;

      const kind = hintedKind ?? FileUploader.detectKind( abs );
      if ( !kind ) continue;

      if ( kind === "file" ) {
        const pkt = await FileUploader.buildMetaPacketFromAbs( {
          absPath: abs,
          relPath: rel,
          ...( options.req ? { req: options.req } : {} ),
        } );
        out.push( pkt );
        continue;
      }

      const scanned = await FileUploader.scanDirFilesRecursive( {
        absDir: abs,
        relDir: rel,
        ...( options.req ? { req: options.req } : {} ),
        onlyUploads,
        allowRecyclebin,
      } );

      out.push( ...scanned );
    }

    return out;
  }

  // ===========================================================================
  // 06) PUBLIC API – SAFE FILE READ
  // ===========================================================================

  /**
   * =============================================================================
   * 01) Why this method (with usage)
   * -----------------------------------------------------------------------------
   * Read a file under public/ (uploads or recyclebin only) as a Buffer.
   * Used for "download", "serve inline", or processing pipelines.
   *
   * 02) Params (what it actually expects)
   * -----------------------------------------------------------------------------
   * - @param relativePathUnderPublic:
   *   "uploads/..." OR "recyclebin/..."
   *
   * 03) Usage hint
   * -----------------------------------------------------------------------------
   * - Use in controllers to stream file to response.
   *
   * 04) Reasons to use this method
   * -----------------------------------------------------------------------------
   * - Enforces strict root boundaries (security)
   *
   * 05) What need to avoid
   * -----------------------------------------------------------------------------
   * - Passing "public/uploads/..." (this helper expects under-public relative)
   *   If you do pass it, PublicPathGuard should normalize; if it doesn’t in your guard,
   *   pass correct "uploads/..".
   *
   * 06) What result method generates
   * -----------------------------------------------------------------------------
   * Buffer of file contents.
   * =============================================================================
   */
  public static async readPublicFile( relativePathUnderPublic: string ): Promise<Buffer> {
    const safeRel = FileUploader.sanitizePublicRelativePath( relativePathUnderPublic );

    if ( !safeRel.startsWith( "uploads/" ) && !safeRel.startsWith( "recyclebin/" ) ) {
      throw new Error( 'readPublicFile only allows "uploads/" or "recyclebin/".' );
    }

    const abs = FileUploader.buildSafeChildPath( FileUploader.PUBLIC_ROOT, safeRel );
    return fsp.readFile( abs );
  }

  // ===========================================================================
  // 07) PUBLIC API – COPY (FILES OR DIRECTORIES) + META ARRAY
  // ===========================================================================

  /**
   * =============================================================================
   * 01) Why this method (with usage)
   * -----------------------------------------------------------------------------
   * Copy files or directories under public/ into a destination directory
   * under uploads/ or recyclebin/.
   *
   * 02) Params (what it actually expects)
   * -----------------------------------------------------------------------------
   * - @param sources:
   *   - "uploads/..." OR "recyclebin/..." OR absolute under /public
   * - @param destinationDir:
   *   - "uploads/..." OR "recyclebin/..."
   * - @param overwrite:
   *   - default false
   * - req:
   *   - optional; to generate absolute URLs in meta
   *
   * 03) Usage hint
   * -----------------------------------------------------------------------------
   * - Copy attachments from temp folder to final folder (without removing source)
   *
   * 04) Reasons to use this method
   * -----------------------------------------------------------------------------
   * - Safe copy while keeping strict root boundaries
   * - Produces meta for UI
   *
   * 05) What need to avoid
   * -----------------------------------------------------------------------------
   * - Passing destination outside uploads/ or recyclebin/ (throws)
   *
   * 06) What result method generates
   * -----------------------------------------------------------------------------
   * FsCopyResult { copied[], skipped[], meta[] }
   * =============================================================================
   */
  public static async copyPublicFiles( options: {
    sources: string | string[];
    destinationDir: string;
    overwrite?: boolean;
    req?: Request;
  } ): Promise<FsCopyResult> {
    const overwrite = options.overwrite === true;
    const sources = Array.isArray( options.sources ) ? options.sources : [ options.sources ];

    const dstDirRel = FileUploader.sanitizePublicRelativePath( options.destinationDir );
    if ( !dstDirRel.startsWith( "uploads/" ) && !dstDirRel.startsWith( "recyclebin/" ) ) {
      throw new Error( 'copyPublicFiles destination must be under "uploads/" or "recyclebin/".' );
    }

    const dstDirAbs = FileUploader.buildSafeChildPath( FileUploader.PUBLIC_ROOT, dstDirRel );
    await FileUploader.ensureDirectory( dstDirAbs );

    const copied: string[] = [];
    const skipped: string[] = [];
    const meta: FileMetaPacket[] = [];

    for ( const srcRelRaw of sources ?? [] ) {
      try {
        const srcCandidate = FileUploader.toPublicRelativeIfAbs( String( srcRelRaw ?? "" ) );
        const srcRel = FileUploader.sanitizePublicRelativePath( srcCandidate );

        if ( !srcRel.startsWith( "uploads/" ) && !srcRel.startsWith( "recyclebin/" ) ) {
          skipped.push( String( srcRelRaw ?? "" ) );
          continue;
        }

        const srcAbs = FileUploader.buildSafeChildPath( FileUploader.PUBLIC_ROOT, srcRel );
        if ( !fs.existsSync( srcAbs ) ) {
          skipped.push( srcRel );
          continue;
        }

        const kind = FileUploader.detectKind( srcAbs );
        if ( !kind ) {
          skipped.push( srcRel );
          continue;
        }

        if ( kind === "file" ) {
          const fileName = path.basename( srcAbs );
          const dstAbs = path.join( dstDirAbs, fileName );

          await fse.copy( srcAbs, dstAbs, { overwrite } );

          const finalRel = path.relative( FileUploader.PUBLIC_ROOT, dstAbs ).replace( /\\/g, "/" );
          copied.push( finalRel );

          meta.push(
            await FileUploader.buildMetaPacketFromAbs( {
              absPath: dstAbs,
              relPath: finalRel,
              ...( options.req ? { req: options.req } : {} ),
            } ),
          );

          continue;
        }

        const dirName = path.basename( srcAbs );
        const dstAbsDir = path.join( dstDirAbs, dirName );

        await fse.copy( srcAbs, dstAbsDir, { overwrite } );

        const finalRelDir = path.relative( FileUploader.PUBLIC_ROOT, dstAbsDir ).replace( /\\/g, "/" );
        copied.push( finalRelDir );

        const scanned = await FileUploader.readPublicMetaArray( {
          items: [ { path: finalRelDir, kind: "dir" } ],
          ...( options.req ? { req: options.req } : {} ),
          onlyUploads: false,
          allowRecyclebin: true,
        } );

        meta.push( ...scanned );
      } catch ( err: unknown ) {
        // eslint-disable-next-line no-console
        console.warn( `[Warning:] [FileUploader] copyPublicFiles failed.\n${ String( err ) }\n` );
        skipped.push( String( srcRelRaw ?? "" ) );
      }
    }

    return { copied, skipped, meta };
  }

  // ===========================================================================
  // 08) PUBLIC API – MOVE (FILES OR DIRECTORIES) + META ARRAY
  // ===========================================================================

  /**
   * =============================================================================
   * 01) Why this method (with usage)
   * -----------------------------------------------------------------------------
   * Move files or directories under public/ into a destination directory
   * under uploads/ or recyclebin/.
   *
   * 02) Params (what it actually expects)
   * -----------------------------------------------------------------------------
   * - @param sources: "uploads/..." OR "recyclebin/..." OR absolute under /public
   * - @param destinationDir: "uploads/..." OR "recyclebin/..."
   * - @param overwrite: default false
   * - @param req: optional for absolute URLs
   *
   * 03) Usage hint
   * -----------------------------------------------------------------------------
   * - Use to finalize temp uploads into final folders
   * - Use to reorganize attachments inside uploads/
   *
   * 04) Reasons to use this method
   * -----------------------------------------------------------------------------
   * - Strict boundary enforcement
   * - Produces meta for UI
   *
   * 05) What need to avoid
   * -----------------------------------------------------------------------------
   * - Passing destination outside uploads/recyclebin (throws)
   *
   * 06) What result method generates
   * -----------------------------------------------------------------------------
   * FsMoveResult { moved[], skipped[], meta[] }
   * =============================================================================
   */
  public static async movePublicFiles( options: {
    sources: string | string[];
    destinationDir: string;
    overwrite?: boolean;
    req?: Request;
  } ): Promise<FsMoveResult> {
    const overwrite = options.overwrite === true;
    const sources = Array.isArray( options.sources ) ? options.sources : [ options.sources ];

    const dstDirRel = FileUploader.sanitizePublicRelativePath( options.destinationDir );
    if ( !dstDirRel.startsWith( "uploads/" ) && !dstDirRel.startsWith( "recyclebin/" ) ) {
      throw new Error( 'movePublicFiles destination must be under "uploads/" or "recyclebin/".' );
    }

    const dstDirAbs = FileUploader.buildSafeChildPath( FileUploader.PUBLIC_ROOT, dstDirRel );
    await FileUploader.ensureDirectory( dstDirAbs );

    const moved: string[] = [];
    const skipped: string[] = [];
    const meta: FileMetaPacket[] = [];

    for ( const srcRelRaw of sources ?? [] ) {
      try {
        const srcCandidate = FileUploader.toPublicRelativeIfAbs( String( srcRelRaw ?? "" ) );
        const srcRel = FileUploader.sanitizePublicRelativePath( srcCandidate );

        if ( !srcRel.startsWith( "uploads/" ) && !srcRel.startsWith( "recyclebin/" ) ) {
          skipped.push( String( srcRelRaw ?? "" ) );
          continue;
        }

        const srcAbs = FileUploader.buildSafeChildPath( FileUploader.PUBLIC_ROOT, srcRel );
        if ( !fs.existsSync( srcAbs ) ) {
          skipped.push( srcRel );
          continue;
        }

        const kind = FileUploader.detectKind( srcAbs );
        if ( !kind ) {
          skipped.push( srcRel );
          continue;
        }

        if ( kind === "file" ) {
          const fileName = path.basename( srcAbs );
          const dstAbs = path.join( dstDirAbs, fileName );

          await fse.move( srcAbs, dstAbs, { overwrite } );

          const finalRel = path.relative( FileUploader.PUBLIC_ROOT, dstAbs ).replace( /\\/g, "/" );
          moved.push( finalRel );

          meta.push(
            await FileUploader.buildMetaPacketFromAbs( {
              absPath: dstAbs,
              relPath: finalRel,
              ...( options.req ? { req: options.req } : {} ),
            } ),
          );

          continue;
        }

        const dirName = path.basename( srcAbs );
        const dstAbsDir = path.join( dstDirAbs, dirName );

        await fse.move( srcAbs, dstAbsDir, { overwrite } );

        const finalRelDir = path.relative( FileUploader.PUBLIC_ROOT, dstAbsDir ).replace( /\\/g, "/" );
        moved.push( finalRelDir );

        const scanned = await FileUploader.readPublicMetaArray( {
          items: [ { path: finalRelDir, kind: "dir" } ],
          ...( options.req ? { req: options.req } : {} ),
          onlyUploads: false,
          allowRecyclebin: true,
        } );

        meta.push( ...scanned );
      } catch ( err: unknown ) {
        // eslint-disable-next-line no-console
        console.warn( `[Warning:] [FileUploader] movePublicFiles failed.\n${ String( err ) }\n` );
        skipped.push( String( srcRelRaw ?? "" ) );
      }
    }

    return { moved, skipped, meta };
  }

  // ===========================================================================
  // 09) PUBLIC API – RECYCLE BIN (MIRROR TREE DESIGN) + META ARRAY
  // ===========================================================================

  /**
   * =============================================================================
   * 01) Why this method (with usage)
   * -----------------------------------------------------------------------------
   * Soft-delete: Move uploads/* items into:
   *   recyclebin/<category>/<refId>/<original uploads path...>
   * This preserves the tree (Windows recyclebin behavior).
   *
   * 02) Params (what it actually expects)
   * -----------------------------------------------------------------------------
   * - @param category: safe key like "Lease", "TeamTask", "WorkItem", etc.
   * - @param refId: the deleted object ID string
   * - @param items:
   *   - "uploads/..." or absolute under public pointing to uploads/...
   *   - Can be file OR directory
   * - @param req: optional for absolute URLs in meta
   *
   * 03) Usage hint
   * -----------------------------------------------------------------------------
   * - Provide the exact uploaded paths you stored in DB.
   * - You can pass whole folder paths to recycle everything under it.
   *
   * 04) Reasons to use this method
   * -----------------------------------------------------------------------------
   * - Exact tree preservation
   * - Easy restore
   *
   * 05) What need to avoid
   * -----------------------------------------------------------------------------
   * - Passing recyclebin items here (only uploads can be recycled)
   * - Passing non-uploads paths (skipped)
   *
   * 06) What result method generates
   * -----------------------------------------------------------------------------
   * FsMoveResult { moved[], skipped[], meta[] } where moved paths are inside recyclebin/
   * =============================================================================
   */
  public static async moveToRecycleBin(
    category: string,
    refId: string,
    items: MoveItem | MoveItem[],
    req?: Request,
  ): Promise<FsMoveResult> {
    const safeCategory = FileUploader.sanitizeSegmentStrict( category );
    const safeRefId = FileUploader.sanitizeSegmentStrict( refId );

    if ( !safeCategory || !safeRefId ) {
      throw new Error( "Category and reference ID are required for recycle bin operations" );
    }

    const list: MoveItem[] = Array.isArray( items ) ? items : [ items ];

    const recycleBaseRel = FileUploader.sanitizePublicRelativePath(
      path.posix.join( "recyclebin", safeCategory, safeRefId ),
    );

    const recycleBaseAbs = FileUploader.buildSafeChildPath( FileUploader.PUBLIC_ROOT, recycleBaseRel );
    await FileUploader.ensureDirectory( recycleBaseAbs );

    const moved: string[] = [];
    const skipped: string[] = [];
    const meta: FileMetaPacket[] = [];

    for ( const it of list ) {
      try {
        const rawPath = typeof it === "string" ? it : it.path;
        const hintedKind: MoveKind | null = typeof it === "string" ? null : it.kind ?? null;

        const trimmed = String( rawPath ?? "" ).trim();
        if ( !trimmed ) {
          skipped.push( String( rawPath ?? "" ) );
          continue;
        }

        const relCandidate = FileUploader.toPublicRelativeIfAbs( trimmed );
        const rel = FileUploader.sanitizePublicRelativePath( relCandidate );

        // Only uploads allowed
        if ( !rel.startsWith( "uploads/" ) ) {
          skipped.push( trimmed );
          continue;
        }

        const absSource = FileUploader.buildSafeChildPath( FileUploader.PUBLIC_ROOT, rel );
        if ( !fs.existsSync( absSource ) ) {
          skipped.push( rel );
          continue;
        }

        const kind = hintedKind ?? FileUploader.detectKind( absSource );
        if ( !kind ) {
          skipped.push( rel );
          continue;
        }

        // Mirror tree: recyclebin/<cat>/<refId>/<rel>
        const absTarget = path.join( recycleBaseAbs, rel );
        await FileUploader.ensureDirectory( path.dirname( absTarget ) );

        // Collision safe
        const finalAbsTarget = fs.existsSync( absTarget ) ? FileUploader.withCollisionSuffix( absTarget ) : absTarget;

        await fse.move( absSource, finalAbsTarget, { overwrite: true } );

        const finalRel = path.relative( FileUploader.PUBLIC_ROOT, finalAbsTarget ).replace( /\\/g, "/" );
        moved.push( finalRel );

        if ( kind === "file" ) {
          meta.push(
            await FileUploader.buildMetaPacketFromAbs( {
              absPath: finalAbsTarget,
              relPath: finalRel,
              ...( req ? { req } : {} ),
            } ),
          );
        } else {
          const scanned = await FileUploader.readPublicMetaArray( {
            items: [ { path: finalRel, kind: "dir" } ],
            ...( req ? { req } : {} ),
            onlyUploads: false,
            allowRecyclebin: true,
          } );
          meta.push( ...scanned );
        }
      } catch ( err: unknown ) {
        // eslint-disable-next-line no-console
        console.warn( `[Warning:] [FileUploader] moveToRecycleBin failed.\n${ String( err ) }\n` );
        skipped.push( typeof it === "string" ? it : it.path );
      }
    }

    return { moved, skipped, meta };
  }

  /**
   * =============================================================================
   * 01) Why this method (with usage)
   * -----------------------------------------------------------------------------
   * Restore: move recyclebin/<cat>/<refId>/uploads/... back to uploads/...
   * (mirror reverse).
   *
   * 02) Params (what it actually expects)
   * -----------------------------------------------------------------------------
   * - @param recycleRelativePathsOrDirs:
   *   - "recyclebin/<cat>/<refId>/uploads/..."
   *   - file or dir
   * - @param req: optional (for meta public URLs)
   *
   * 03) Usage hint
   * -----------------------------------------------------------------------------
   * - Store recyclebin paths in DB for each deleted entry, then restore those.
   *
   * 04) Reasons to use this method
   * -----------------------------------------------------------------------------
   * - Mirrors Windows “Restore”
   *
   * 05) What need to avoid
   * -----------------------------------------------------------------------------
   * - Passing non-recyclebin paths (skipped)
   * - Trying to restore into recyclebin again
   *
   * 06) What result method generates
   * -----------------------------------------------------------------------------
   * FsMoveResult { moved[], skipped[], meta[] } moved paths are under uploads/
   * =============================================================================
   */
  public static async restoreFromRecycleBin(
    recycleRelativePathsOrDirs: string | string[],
    req?: Request,
  ): Promise<FsMoveResult> {
    const list = Array.isArray( recycleRelativePathsOrDirs )
      ? recycleRelativePathsOrDirs
      : [ recycleRelativePathsOrDirs ];

    const moved: string[] = [];
    const skipped: string[] = [];
    const meta: FileMetaPacket[] = [];

    for ( const raw of list ) {
      try {
        const rel = FileUploader.sanitizePublicRelativePath( raw );

        if ( !rel.startsWith( "recyclebin/" ) ) {
          skipped.push( raw );
          continue;
        }

        const absSource = FileUploader.buildSafeChildPath( FileUploader.PUBLIC_ROOT, rel );
        if ( !fs.existsSync( absSource ) ) {
          skipped.push( rel );
          continue;
        }

        // Must have: recyclebin/<cat>/<refId>/<rest...>
        const parts = rel.split( "/" ).filter( Boolean );
        if ( parts.length < 4 ) {
          skipped.push( rel );
          continue;
        }

        const rest = parts.slice( 3 ).join( "/" );
        if ( !rest ) {
          skipped.push( rel );
          continue;
        }

        const absTarget = FileUploader.buildSafeChildPath( FileUploader.PUBLIC_ROOT, rest );
        await FileUploader.ensureDirectory( path.dirname( absTarget ) );

        const finalAbsTarget = fs.existsSync( absTarget ) ? FileUploader.withCollisionSuffix( absTarget ) : absTarget;

        await fse.move( absSource, finalAbsTarget, { overwrite: true } );

        const finalRel = path.relative( FileUploader.PUBLIC_ROOT, finalAbsTarget ).replace( /\\/g, "/" );
        moved.push( finalRel );

        const kind = FileUploader.detectKind( finalAbsTarget );
        if ( kind === "file" ) {
          meta.push(
            await FileUploader.buildMetaPacketFromAbs( {
              absPath: finalAbsTarget,
              relPath: finalRel,
              ...( req ? { req } : {} ),
            } ),
          );
        } else if ( kind === "dir" ) {
          const scanned = await FileUploader.readPublicMetaArray( {
            items: [ { path: finalRel, kind: "dir" } ],
            ...( req ? { req } : {} ),
            onlyUploads: true,
            allowRecyclebin: false,
          } );
          meta.push( ...scanned );
        }
      } catch ( err: unknown ) {
        // eslint-disable-next-line no-console
        console.warn( `[Warning:] [FileUploader] restoreFromRecycleBin failed.\n${ String( err ) }\n` );
        skipped.push( raw );
      }
    }

    return { moved, skipped, meta };
  }

  /**
   * =============================================================================
   * 01) Why this method (with usage)
   * -----------------------------------------------------------------------------
   * Permanently delete items from recyclebin.
   * This is the “Empty Recycle Bin” / “Delete permanently” operation.
   *
   * 02) Params (what it actually expects)
   * -----------------------------------------------------------------------------
   * - @param recycleRelativePathsOrDirs:
   *   "recyclebin/<cat>/<refId>/..."
   * - @param req: optional for meta URL building BEFORE deletion
   *
   * 03) Usage hint
   * -----------------------------------------------------------------------------
   * - Always guard this with high-privilege RBAC (purge)
   *
   * 04) Reasons to use this method
   * -----------------------------------------------------------------------------
   * - Permanent cleanup
   *
   * 05) What need to avoid
   * -----------------------------------------------------------------------------
   * - Passing uploads paths (skipped)
   *
   * 06) What result method generates
   * -----------------------------------------------------------------------------
   * FsDeleteResult { deleted[], skipped[], meta[] } meta is best-effort before delete
   * =============================================================================
   */
  public static async deleteFromRecycleBin(
    recycleRelativePathsOrDirs: string | string[],
    req?: Request,
  ): Promise<FsDeleteResult> {
    const list = Array.isArray( recycleRelativePathsOrDirs )
      ? recycleRelativePathsOrDirs
      : [ recycleRelativePathsOrDirs ];

    const deleted: string[] = [];
    const skipped: string[] = [];
    const meta: FileMetaPacket[] = [];

    for ( const raw of list ) {
      try {
        const rel = FileUploader.sanitizePublicRelativePath( raw );

        if ( !rel.startsWith( "recyclebin/" ) ) {
          skipped.push( raw );
          continue;
        }

        const absTarget = FileUploader.buildSafeChildPath( FileUploader.PUBLIC_ROOT, rel );
        if ( !fs.existsSync( absTarget ) ) {
          skipped.push( rel );
          continue;
        }

        const kind = FileUploader.detectKind( absTarget );
        if ( kind === "file" ) {
          meta.push(
            await FileUploader.buildMetaPacketFromAbs( {
              absPath: absTarget,
              relPath: rel,
              ...( req ? { req } : {} ),
            } ),
          );
        } else if ( kind === "dir" ) {
          const scanned = await FileUploader.readPublicMetaArray( {
            items: [ { path: rel, kind: "dir" } ],
            ...( req ? { req } : {} ),
            onlyUploads: false,
            allowRecyclebin: true,
          } );
          meta.push( ...scanned );
        }

        const st = fs.statSync( absTarget );
        if ( st.isDirectory() ) {
          await fse.remove( absTarget );
        } else {
          await fse.unlink( absTarget );
        }

        deleted.push( rel );
      } catch ( err: unknown ) {
        // eslint-disable-next-line no-console
        console.warn( `[Warning:] [FileUploader] deleteFromRecycleBin failed.\n${ String( err ) }\n` );
        skipped.push( raw );
      }
    }

    return { deleted, skipped, meta };
  }

  // ===========================================================================
  // 10) PRIVATE HELPERS – META BUILDERS (FILES ONLY)
  // ===========================================================================

  private static async scanDirFilesRecursive( args: {
    absDir: string;
    relDir: string;
    req?: Request;
    onlyUploads: boolean;
    allowRecyclebin: boolean;
  } ): Promise<FileMetaPacket[]> {
    const out: FileMetaPacket[] = [];
    const entries = await fsp.readdir( args.absDir, { withFileTypes: true } ).catch( () => [] );

    for ( const ent of entries ) {
      const childRel = path.posix.join( args.relDir, ent.name );
      const childAbs = path.join( args.absDir, ent.name );

      const isUploads = childRel.startsWith( "uploads/" );
      const isRecycle = childRel.startsWith( "recyclebin/" );

      if ( args.onlyUploads && !isUploads ) continue;
      if ( !args.allowRecyclebin && isRecycle ) continue;
      if ( !isUploads && !isRecycle ) continue;

      if ( ent.isDirectory() ) {
        const deeper = await FileUploader.scanDirFilesRecursive( {
          absDir: childAbs,
          relDir: childRel,
          ...( args.req ? { req: args.req } : {} ),
          onlyUploads: args.onlyUploads,
          allowRecyclebin: args.allowRecyclebin,
        } );
        out.push( ...deeper );
        continue;
      }

      if ( ent.isFile() ) {
        out.push(
          await FileUploader.buildMetaPacketFromAbs( {
            absPath: childAbs,
            relPath: childRel,
            ...( args.req ? { req: args.req } : {} ),
          } ),
        );
      }
    }

    return out;
  }

  private static async buildMetaPacketFromAbs( args: {
    absPath: string;
    relPath: string;
    req?: Request;
  } ): Promise<FileMetaPacket> {
    const st = await fsp.stat( args.absPath );

    const storedName = path.posix.basename( args.relPath );
    const originalName = storedName;

    const extension = path.posix.extname( storedName ).replace( ".", "" );
    const mimeType = FileUploader.guessMimeTypeFromName( storedName );

    const relativePath = String( args.relPath ?? "" ).replace( /\\/g, "/" ).replace( /^\/+/, "" );

    const origin = args.req ? FileUploader.buildOriginFromReq( args.req ) : "";
    const publicUrl = origin ? `${ origin }/${ relativePath }` : `/${ relativePath }`;

    return FileUploader.packPacket( {
      originalName,
      storedName,
      extension: extension || "bin",
      mimeType,
      sizeBytes: st.isFile() ? st.size : 0,
      relativePath,
      publicUrl,
      absDiskPath: args.absPath,
      fieldName: "files",
      uploadedAtIso: st.mtime instanceof Date ? st.mtime.toISOString() : new Date().toISOString(),
    } );
  }

  // ===========================================================================
  // 11) PRIVATE HELPERS – PATH SAFETY & UTILITIES
  // ===========================================================================

  private static normalizeAndValidateDiskDestination( destination: string ): string {
    const raw = String( destination ?? "" ).trim();
    if ( !raw ) throw new Error( "Upload destination is empty." );

    if ( !path.isAbsolute( raw ) ) {
      const safeSubPath = FileUploader.normalizeSubPath( raw );
      return FileUploader.buildSafeChildDir( FileUploader.UPLOAD_ROOT, safeSubPath );
    }

    const abs = path.resolve( raw );
    const base = path.resolve( FileUploader.UPLOAD_ROOT );

    if ( abs !== base && !abs.startsWith( base + path.sep ) ) {
      throw new Error( "Unsafe upload destination detected." );
    }

    return abs;
  }

  private static async ensureDirectory( targetDir: string ): Promise<void> {
    await fse.ensureDir( targetDir );
  }

  private static sanitizeSubPath( subPath: string ): string {
    const normalized = String( subPath ?? "" ).replace( /\\/g, "/" ).trim();

    const parts = normalized
      .split( "/" )
      .filter( ( p ) => p && p !== "." && p !== ".." )
      .map( ( seg ) => FileUploader.sanitizeSegmentStrict( seg ) )
      .filter( Boolean );

    return parts.join( "/" );
  }

  private static sanitizePublicRelativePath( pathLike: string ): string {
    const rel = PublicPathGuard.normalizeStrict( pathLike );
    if ( !rel ) return "";
    return rel;
  }

  private static sanitizeSegmentStrict( segment: string ): string {
    const trimmed = String( segment ?? "" ).trim();
    if ( !trimmed ) return "";
    return trimmed.replace( /[^a-zA-Z0-9_-]/g, "_" );
  }

  private static buildSafeChildDir( base: string, child: string ): string {
    const baseResolved = path.resolve( base );
    const target = path.resolve( base, child );

    if ( !target.startsWith( baseResolved + path.sep ) && target !== baseResolved ) {
      throw new Error( "Unsafe directory path detected" );
    }

    return target;
  }

  private static buildSafeChildPath( base: string, relative: string ): string {
    const baseResolved = path.resolve( base );
    const target = path.resolve( base, relative );

    if ( !target.startsWith( baseResolved + path.sep ) && target !== baseResolved ) {
      throw new Error( "Unsafe file path detected" );
    }

    return target;
  }

  private static slugify( input: string ): string {
    const safe = String( input ?? "" )
      .trim()
      .toLowerCase()
      .replace( /[^a-z0-9]+/g, "-" )
      .replace( /^-+|-+$/g, "" );

    return safe || "file";
  }

  private static getFirstHeaderValue( req: Request, name: string ): string {
    const v = req.headers[ name.toLowerCase() ];
    if ( typeof v === "string" ) return v;
    if ( Array.isArray( v ) && typeof v[ 0 ] === "string" ) return v[ 0 ];
    return "";
  }

  private static firstCsvToken( raw: string ): string {
    const token = String( raw ?? "" )
      .split( "," )
      .map( ( s ) => s.trim() )
      .filter( Boolean )
      .at( 0 );

    return token ?? "";
  }

  private static buildOriginFromReq( req: Request ): string {
    const protoRaw = FileUploader.getFirstHeaderValue( req, "x-forwarded-proto" );
    const forwardedProto = FileUploader.firstCsvToken( protoRaw );
    const protocol = forwardedProto ? forwardedProto : req.protocol;

    const hostRaw = FileUploader.getFirstHeaderValue( req, "x-forwarded-host" );
    const forwardedHost = FileUploader.firstCsvToken( hostRaw );

    const hostFallback = ( req.get( "host" ) ?? "" ).trim();
    const hostHeader = forwardedHost ? forwardedHost : hostFallback;

    if ( !hostHeader ) {
      throw new Error( "Unable to determine request host." );
    }

    return `${ protocol }://${ hostHeader }`;
  }

  private static toFilePacket( args: {
    req: Request;
    safeSubPath: string;
    fieldName: string;
    file: Express.Multer.File;
  } ): FileMetaPacket {
    const { req, safeSubPath, fieldName, file } = args;

    const storedName = String( file.filename ?? "" ).trim();
    const originalName = String( file.originalname ?? "" ).trim() || storedName;

    const extension = path.extname( storedName ).replace( ".", "" );
    const mimeType = String( file.mimetype ?? "application/octet-stream" ).trim();

    const sizeBytesNum = Number( file.size );
    const sizeBytes = Number.isFinite( sizeBytesNum ) && sizeBytesNum >= 0 ? Math.floor( sizeBytesNum ) : 0;

    const safeField = FileUploader.sanitizeSegmentStrict( fieldName );

    const relativePath = [ "uploads", safeSubPath, safeField, storedName ]
      .filter( Boolean )
      .join( "/" )
      .replace( /^\/+/, "" );

    const origin = FileUploader.buildOriginFromReq( req );
    const publicUrl = `${ origin }/${ relativePath }`;

    const absDiskPath = path.resolve( FileUploader.PUBLIC_ROOT, relativePath );
    const uploadedAtIso = new Date().toISOString();

    const basePacket = FileUploader.packPacket( {
      originalName,
      storedName,
      extension: extension || "bin",
      mimeType,
      sizeBytes,
      relativePath,
      publicUrl,
      absDiskPath,
      fieldName: safeField,
      uploadedAtIso,
    } );

    // exactOptionalPropertyTypes-safe: add only if real
    const encoding = typeof file.encoding === "string" ? file.encoding.trim() : "";
    if ( encoding ) {
      ( basePacket as unknown as { encoding: string; } ).encoding = encoding;
    }

    return basePacket;
  }

  private static buildUploadResult(
    baseRelativeDir: string,
    basePublicUrl: string,
    byField: Record<string, FileMetaPacket[]>,
  ): UploadResultPacket {
    let totalFiles = 0;
    let totalBytes = 0;

    for ( const files of Object.values( byField ) ) {
      const arr = Array.isArray( files ) ? files : [];
      totalFiles += arr.length;

      for ( const f of arr ) {
        const n = Number( ( f as unknown as { sizeBytes?: unknown; } ).sizeBytes );
        if ( Number.isFinite( n ) && n >= 0 ) totalBytes += Math.floor( n );
      }
    }

    return {
      baseRelativeDir,
      basePublicUrl,
      totalFiles,
      totalBytes,
      byField,
    };
  }

  private static seedByFieldKeys( fields: Array<{ name: string; }> ): Record<string, FileMetaPacket[]> {
    const out: Record<string, FileMetaPacket[]> = {};

    for ( const f of fields ) {
      const name = FileUploader.sanitizeSegmentStrict( f?.name ?? "" );
      if ( !name ) continue;
      out[ name ] = [];
    }

    return out;
  }

  private static readExistingFilesForField( req: Request, fieldName: string ): Express.Multer.File[] {
    const filesAny = ( req.files as unknown ) as
      | Express.Multer.File[]
      | Record<string, Express.Multer.File[]>
      | undefined;

    if ( !filesAny ) return [];

    if ( Array.isArray( filesAny ) ) {
      return filesAny.filter( ( f ) => String( f.fieldname ?? "" ) === fieldName );
    }

    const hit = filesAny[ fieldName ];
    return Array.isArray( hit ) ? hit : [];
  }

  private static readExistingFilesMulti( req: Request ): Record<string, Express.Multer.File[]> {
    const filesAny = ( req.files as unknown ) as
      | Express.Multer.File[]
      | Record<string, Express.Multer.File[]>
      | undefined;

    if ( !filesAny ) return {};

    if ( Array.isArray( filesAny ) ) {
      const out: Record<string, Express.Multer.File[]> = {};

      for ( const f of filesAny ) {
        const key = FileUploader.sanitizeSegmentStrict( f.fieldname ?? "" );
        if ( !key ) continue;
        if ( !out[ key ] ) out[ key ] = [];
        out[ key ].push( f );
      }

      return out;
    }

    return filesAny;
  }

  private static packPacket( base: {
    originalName: string;
    storedName: string;
    extension: string;
    mimeType: string;
    sizeBytes: number;
    relativePath: string;
    publicUrl: string;
    absDiskPath: string;
    fieldName: string;
    uploadedAtIso: string;
  } ): FileMetaPacket {
    return base as unknown as FileMetaPacket;
  }

  private static detectKind( absSource: string ): MoveKind | null {
    try {
      const st = fs.statSync( absSource );
      if ( st.isDirectory() ) return "dir";
      if ( st.isFile() ) return "file";
      return null;
    } catch {
      return null;
    }
  }

  private static withCollisionSuffix( absTarget: string ): string {
    const stamp = Date.now();
    const ext = path.extname( absTarget );

    if ( ext ) {
      const base = absTarget.slice( 0, -ext.length );
      return `${ base }__${ stamp }${ ext }`;
    }

    return `${ absTarget }__${ stamp }`;
  }

  private static toPublicRelativeIfAbs( relOrAbs: string ): string {
    const raw = String( relOrAbs ?? "" ).trim();
    if ( !raw ) return "";

    if ( path.isAbsolute( raw ) ) {
      const publicRootAbs = path.resolve( FileUploader.PUBLIC_ROOT );
      const abs = path.resolve( raw );

      const rel = path.relative( publicRootAbs, abs ).replace( /\\/g, "/" );

      // Outside public root => mark unsafe
      if ( rel.startsWith( ".." ) ) return "__outside_public_root__";

      return rel.replace( /^\/+/, "" );
    }

    return PublicPathGuard.normalizeStrict( raw );
  }

  private static guessMimeTypeFromName( fileName: string ): string {
    const ext = path.extname( fileName ).toLowerCase();

    if ( ext === ".png" ) return "image/png";
    if ( ext === ".jpg" || ext === ".jpeg" ) return "image/jpeg";
    if ( ext === ".webp" ) return "image/webp";
    if ( ext === ".gif" ) return "image/gif";

    if ( ext === ".pdf" ) return "application/pdf";
    if ( ext === ".txt" ) return "text/plain";
    if ( ext === ".json" ) return "application/json";
    if ( ext === ".csv" ) return "text/csv";

    if ( ext === ".docx" ) {
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    }
    if ( ext === ".xlsx" ) {
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    }
    if ( ext === ".pptx" ) {
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    }

    return "application/octet-stream";
  }

  /**
   * =============================================================================
   * 01) Why this method (with usage)
   * -----------------------------------------------------------------------------
   * Normalize any "subPath" into a safe relative path UNDER uploads/.
   * ✅ Fixes the bug where absolute windows paths become "uploads/D_/project/..."
   *
   * 02) Params (what it actually expects)
   * -----------------------------------------------------------------------------
   * - input:
   *   - relative under uploads (preferred): "users/<username>"
   *   - OR "uploads/users/<username>"
   *   - OR "public/uploads/users/<username>"
   *   - OR ABSOLUTE under public/uploads:
   *       "D:\\...\\public\\uploads\\users\\<username>"
   *
   * 03) Usage hint
   * -----------------------------------------------------------------------------
   * - Always pass relative form from controllers to keep logs clean.
   *
   * 04) Reasons to use this method
   * -----------------------------------------------------------------------------
   * - Prevents traversal / wrong baseRelativeDir
   * - Guarantees storage stays inside /public/uploads
   *
   * 05) What need to avoid
   * -----------------------------------------------------------------------------
   * - Passing absolute paths outside /public/uploads (throws)
   *
   * 06) What result method generates
   * -----------------------------------------------------------------------------
   * A safe relative path like "users/<username>" (no leading slash)
   * =============================================================================
   */
  private static normalizeSubPath( input: string ): string {
    const raw = String( input ?? "" ).trim();
    if ( !raw ) return "";

    // Absolute path allowed ONLY if inside public/uploads
    if ( path.isAbsolute( raw ) ) {
      const abs = path.resolve( raw );
      const uploadsRoot = path.resolve( FileUploader.UPLOAD_ROOT );

      if ( abs === uploadsRoot || abs.startsWith( uploadsRoot + path.sep ) ) {
        const relUnderUploads = path.relative( uploadsRoot, abs ).replace( /\\/g, "/" );
        return FileUploader.sanitizeSubPath( relUnderUploads );
      }

      throw new Error( "Unsafe subPath: absolute path is not under public/uploads." );
    }

    // Normalize slashes + remove leading "/"
    const norm = raw.replace( /\\/g, "/" ).replace( /^\/+/, "" );

    // strip leading "public/"
    const noPublic = norm.startsWith( "public/" ) ? norm.slice( "public/".length ) : norm;

    // strip leading "uploads/"
    const noUploads = noPublic.startsWith( "uploads/" ) ? noPublic.slice( "uploads/".length ) : noPublic;

    // final sanitize (segments only)
    return FileUploader.sanitizeSubPath( noUploads );
  }
}