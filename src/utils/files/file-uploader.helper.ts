// Path: src/utils/file-uploader.helper.ts
/* ============================================================================
 * 🔴🔴🔴 CRITICAL WARNING (DO NOT MODIFY WITHOUT SYSTEM REVIEW) 🔴🔴🔴
 * ----------------------------------------------------------------------------
 * SECURITY + CONTRACT CRITICAL infrastructure component.
 *
 * Invariants guaranteed:
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
 *  5) Directory-safe metadata arrays (NEW)
 *     - FS ops accept file OR directory paths
 *     - Returned results include `meta: FileMetaPacket[]` (files-only, flat)
 * ========================================================================== */

import type { Request, Response } from "express";
import fs from "fs";
import fsp from "fs/promises";
import fse from "fs-extra";
import multer, { type StorageEngine } from "multer";
import path from "path";
import sharp from "sharp";

import type { FileMetaPacket } from "../../types/common";
import { PublicPathGuard } from "./public-path.guard";

/* ========================================================================== *
 * UNIVERSAL UPLOAD RESULT CONTRACT
 * ========================================================================== */

/**
 * UploadResultPacket
 * - Returned by ALL upload helpers (single-field and multi-field)
 * - Stable contract for controllers/services
 */
export interface UploadResultPacket {
  /** base relative directory under PUBLIC (unix style, no leading "/")
   *  Example: "uploads/teamManagement/teamTasks/__tmp/<token>"
   */
  baseRelativeDir: string;

  /** base public URL prefix for UI usage
   *  Example: "https://host/uploads/teamManagement/teamTasks/__tmp/<token>"
   */
  basePublicUrl: string;

  /** Total number of uploaded files across all fields */
  totalFiles: number;

  /** Total file bytes across all fields */
  totalBytes: number;

  /** fieldName -> FileMetaPacket[]
   * - ALWAYS includes declared field keys (even if empty arrays)
   */
  byField: Record<string, FileMetaPacket[]>;
}

/* ========================================================================== *
 * FILE SYSTEM CRUD RESULT CONTRACTS
 * (Backwards compatible + adds `meta` arrays)
 * ========================================================================== */

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

/* ========================================================================== *
 * FILE UPLOADER (UNIVERSAL / MODULE-AGNOSTIC)
 * ========================================================================== */

type MoveKind = "file" | "dir";

type MoveItem =
  | string
  | {
    /** path can be:
     * - public-relative like "uploads/x/y.png"
     * - OR absolute disk path under /public (will be normalized)
     */
    path: string;

    /** optional kind hint:
     * - "file" or "dir"
     * - if omitted, kind is detected via fs.stat
     */
    kind?: MoveKind;
  };

export default class FileUploader {
  // ===========================================================================
  // 00) ROOT PATHS (filesystem)
  // ===========================================================================

  private static readonly PUBLIC_ROOT: string = path.resolve( process.cwd(), "public" );
  private static readonly UPLOAD_ROOT: string = path.join( FileUploader.PUBLIC_ROOT, "uploads" );
  private static readonly RECYCLEBIN_ROOT: string = path.join( FileUploader.PUBLIC_ROOT, "recyclebin" );

  // ===========================================================================
  // 01) PUBLIC API – MULTER BUILDERS
  // ===========================================================================

  /**
   * Create a multer instance using memory storage (buffers only).
   *
   * @param allowedMimeTypes
   * - Expected: Set of allowed MIME strings (e.g. "image/png", "application/pdf")
   * - If empty set => allow all types
   *
   * @param maxFileSizeMb
   * - Expected: maximum file size in megabytes per file
   */
  public static createMemoryUpload(
    allowedMimeTypes: ReadonlySet<string>,
    maxFileSizeMb: number,
  ): multer.Multer {
    const storage = multer.memoryStorage();

    const fileFilter: multer.Options[ "fileFilter" ] = ( _req, file, cb ): void => {
      // If no restrictions => allow all
      if ( !allowedMimeTypes || allowedMimeTypes.size === 0 ) {
        cb( null, true );
        return;
      }

      // Allow only configured MIME types
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
   * Create a multer instance using disk storage.
   *
   * @param options.allowedMimeTypes
   * - Expected: Set of allowed MIME strings (empty => allow all)
   *
   * @param options.maxFileSizeMb
   * - Expected: maximum file size in MB per file
   *
   * @param options.maxFiles
   * - Expected: maximum number of files per request (multer "files" limit)
   *
   * @param options.resolveDestination
   * - Expected: function that returns disk destination directory path
   * - Can return:
   *   - absolute path (must be under /public/uploads)
   *   - OR relative subpath (will be converted under /public/uploads)
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
          // Resolve destination from caller
          const resolved = await options.resolveDestination( req );

          // Normalize + validate to stay under UPLOAD_ROOT
          const dest = FileUploader.normalizeAndValidateDiskDestination( resolved );

          // Ensure directory exists
          await FileUploader.ensureDirectory( dest );

          cb( null, dest );
        } catch ( error: unknown ) {
          cb( error instanceof Error ? error : new Error( String( error ) ), "" );
        }
      },

      filename: ( _req, file, cb ): void => {
        // Create a safe stored filename (slug + timestamp + extension)
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
   * Universal single-field uploader.
   *
   * @param subPath
   * - Expected: relative path under "uploads/"
   * - Example: "teamManagement/teamTasks/__tmp/<token>"
   * - MUST NOT contain ".."
   *
   * @param fieldName
   * - Expected: multer fieldname ("evidence", "attachments", "avatar"...)
   *
   * @param req
   * - Expected: Express Request (holds req.files after multer runs)
   *
   * @param options.allowedMimeTypes
   * - Optional: Set of allowed MIME types for this field (empty => allow all)
   *
   * @param options.maxFileSizeMb
   * - Optional: per-file max size in MB (default 20)
   *
   * @param options.maxFiles
   * - Optional: max files for this field (default 20)
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
    // 1) Sanitize the relative sub path (path traversal safety)
    const safeSubPath = FileUploader.sanitizeSubPath( subPath );
    if ( !safeSubPath.trim() ) {
      throw new Error( "Uploading path is required!" );
    }

    // 2) Sanitize field name (keeps folder-safe and stable)
    const safeField = FileUploader.sanitizeSegmentStrict( fieldName );
    if ( !safeField ) {
      throw new Error( "fieldName is required!" );
    }

    // 3) Build base outputs (these are contract-stable strings)
    const baseRelativeDir = [ "uploads", safeSubPath ].filter( Boolean ).join( "/" ).replace( /^\/+/, "" );
    const basePublicUrl = `${ FileUploader.buildOriginFromReq( req ) }/${ baseRelativeDir }`;

    // 4) Double-run protection:
    //    If middleware already ran multer, DO NOT upload again.
    const already = FileUploader.readExistingFilesForField( req, safeField );
    if ( already.length > 0 ) {
      const packets = already.map( ( f ) =>
        FileUploader.toFilePacket( { req, safeSubPath, fieldName: safeField, file: f } ),
      );

      return FileUploader.buildUploadResult( baseRelativeDir, basePublicUrl, {
        [ safeField ]: packets,
      } );
    }

    // 5) Prepare safe disk destination:
    //    /public/uploads/<safeSubPath>/<safeField>/
    const baseDir = FileUploader.buildSafeChildDir( FileUploader.UPLOAD_ROOT, safeSubPath );
    const fieldDir = FileUploader.buildSafeChildDir( baseDir, safeField );

    await FileUploader.ensureDirectory( fieldDir );

    // 6) Configure multer disk storage for this upload
    const storage: StorageEngine = multer.diskStorage( {
      destination: ( _req, _file, cb ) => cb( null, fieldDir ),
      filename: ( _req, file, cb ) => {
        const ext = path.extname( file.originalname );
        const base = path.basename( file.originalname, ext );
        const storedName = `${ FileUploader.slugify( base ) }_${ Date.now() }${ ext.toLowerCase() }`;
        cb( null, storedName );
      },
    } );

    // 7) Configure file filter
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

    // 8) Run multer (array means allow multiple files for same field)
    const upload = multer( {
      storage,
      limits: {
        fileSize: ( options?.maxFileSizeMb ?? 20 ) * 1024 * 1024,
        files: options?.maxFiles ?? 20,
      },
      fileFilter,
    } ).array( safeField );

    // 9) Execute multer using a Promise wrapper
    const files: Express.Multer.File[] = await new Promise( ( resolve, reject ) => {
      // Multer expects (req, res, next). We provide a dummy typed Response.
      upload( req, {} as unknown as Response, ( err: unknown ) => {
        if ( err ) {
          const msg = err instanceof Error ? err.message : "Unknown upload error";
          reject( new Error( `File upload failed: ${ msg }` ) );
          return;
        }

        // multer populates req.files
        resolve( ( ( req.files ?? [] ) as unknown ) as Express.Multer.File[] );
      } );
    } );

    // 10) Normalize to FileMetaPacket[]
    const packets = files.map( ( f ) =>
      FileUploader.toFilePacket( { req, safeSubPath, fieldName: safeField, file: f } ),
    );

    // 11) Build stable UploadResultPacket
    return FileUploader.buildUploadResult( baseRelativeDir, basePublicUrl, {
      [ safeField ]: packets,
    } );
  }

  // ===========================================================================
  // 03) PUBLIC API – UNIVERSAL UPLOAD (MULTI FIELD)
  // ===========================================================================

  /**
   * Universal multi-field uploader.
   *
   * @param subPath
   * - Expected: relative path under "uploads/"
   * - Example: "teamManagement/teamTasks/__tmp/<token>"
   *
   * @param fields
   * - Expected: multer fields config array
   * - Example: [{ name: "evidence", maxCount: 10 }, { name: "attachments", maxCount: 5 }]
   * - IMPORTANT: output.byField will ALWAYS contain ALL declared keys (even empty arrays)
   *
   * @param req
   * - Expected: Express Request
   *
   * @param options.allowedMimeTypesByField
   * - Optional: per-field MIME type allow-lists:
   *   { evidence: new Set([...]), attachments: new Set([...]) }
   *
   * @param options.maxFileSizeMb
   * - Optional: max size per file in MB (default 20)
   *
   * @param options.maxFiles
   * - Optional: max total files across all fields (default 40)
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
    // 1) Sanitize the relative sub path
    const safeSubPath = FileUploader.sanitizeSubPath( subPath );
    if ( !safeSubPath.trim() ) {
      throw new Error( "Uploading path is required!" );
    }

    // 2) Seed byField with declared keys (even if no uploads happen)
    const seededByField = FileUploader.seedByFieldKeys( fields );

    // 3) Build base outputs
    const baseRelativeDir = [ "uploads", safeSubPath ].filter( Boolean ).join( "/" ).replace( /^\/+/, "" );
    const basePublicUrl = `${ FileUploader.buildOriginFromReq( req ) }/${ baseRelativeDir }`;

    // 4) Double-run protection:
    //    If middleware already ran multer, normalize req.files and return.
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

    // 5) Prepare safe base directory:
    //    /public/uploads/<safeSubPath>/
    const baseDir = FileUploader.buildSafeChildDir( FileUploader.UPLOAD_ROOT, safeSubPath );
    await FileUploader.ensureDirectory( baseDir );

    // 6) Configure multer disk storage:
    //    each field gets its own folder under baseDir
    const storage: StorageEngine = multer.diskStorage( {
      destination: async ( _req, file, cb ): Promise<void> => {
        try {
          const safeFieldName = FileUploader.sanitizeSegmentStrict( file.fieldname );
          const fieldDir = FileUploader.buildSafeChildDir( baseDir, safeFieldName );
          await FileUploader.ensureDirectory( fieldDir );
          cb( null, fieldDir );
        } catch ( error: unknown ) {
          cb( error instanceof Error ? error : new Error( String( error ) ), "" );
        }
      },

      filename: ( _req, file, cb ): void => {
        const ext = path.extname( file.originalname );
        const base = path.basename( file.originalname, ext );
        const storedName = `${ FileUploader.slugify( base ) }_${ Date.now() }${ ext.toLowerCase() }`;
        cb( null, storedName );
      },
    } );

    // 7) Configure per-field mime filter
    const fileFilter: multer.Options[ "fileFilter" ] = ( _req, file, cb ): void => {
      const byField = options?.allowedMimeTypesByField;

      // No field-specific rules => allow all
      if ( !byField || Object.keys( byField ).length === 0 ) {
        cb( null, true );
        return;
      }

      const allow = byField[ file.fieldname ];

      // Field missing allow-list => allow all
      if ( !allow || allow.size === 0 ) {
        cb( null, true );
        return;
      }

      // Allow only listed types
      if ( allow.has( file.mimetype ) ) {
        cb( null, true );
        return;
      }

      cb( new Error( `File type not allowed for field "${ file.fieldname }": ${ file.mimetype }` ) );
    };

    // 8) Run multer
    const upload = multer( {
      storage,
      limits: {
        fileSize: ( options?.maxFileSizeMb ?? 20 ) * 1024 * 1024,
        files: options?.maxFiles ?? 40,
      },
      fileFilter,
    } ).fields( fields );

    // 9) Execute multer using a Promise wrapper
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

    // 10) Fill seeded arrays (includes empty arrays for missing fields)
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

    // 11) Build stable UploadResultPacket
    return FileUploader.buildUploadResult( baseRelativeDir, basePublicUrl, seededByField );
  }

  // ===========================================================================
  // 04) PUBLIC API – SAVE IMAGE BUFFER (MEMORY -> WEBP)
  // ===========================================================================

  /**
   * Convert an in-memory buffer into a single .webp file saved under uploads/<subPath>/<fieldName>/.
   *
   * @param options.req
   * - Expected: Express Request (for absolute public URL)
   *
   * @param options.subPath
   * - Expected: relative path under "uploads/"
   * - Example: "users/profilePhotos/<userId>"
   *
   * @param options.fieldName
   * - Expected: destination folder name (logical bucket)
   * - Example: "avatar"
   *
   * @param options.originalName
   * - Expected: original name for semantic naming
   * - Example: "myPhoto.png"
   *
   * @param options.buffer
   * - Expected: raw image buffer
   *
   * @param options.webpQuality
   * - Optional: 1..100 (default 80)
   */
  public static async saveSingleWebPFromMemory( options: {
    req: Request;
    subPath: string;
    fieldName: string;
    originalName: string;
    buffer: Buffer;
    webpQuality?: number;
  } ): Promise<UploadResultPacket> {
    const safeSubPath = FileUploader.sanitizeSubPath( options.subPath );
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
   * Read FileMetaPacket[] for file OR directory inputs under public/.
   *
   * @param options.items
   * - Expected:
   *   - string path OR MoveItem OR array
   *   - Allowed forms:
   *     - "uploads/..." or "recyclebin/..." (public-relative)
   *     - absolute disk path under /public
   *
   * @param options.req
   * - Optional: Express Request for absolute publicUrl
   *
   * @param options.onlyUploads
   * - Optional: if true, only "uploads/" items will be scanned (default true)
   *
   * @param options.allowRecyclebin
   * - Optional: if true, recyclebin paths are allowed (default false)
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
      const hintedKind: MoveKind | null = typeof it === "string" ? null : ( it.kind ?? null );

      const trimmed = String( rawPath ?? "" ).trim();
      if ( !trimmed ) continue;

      // Convert absolute path to public-relative (if needed)
      const relCandidate = FileUploader.toPublicRelativeIfAbs( trimmed );

      // Normalize to public-relative (WITHOUT "public/"; everything is under PUBLIC_ROOT here)
      const rel = FileUploader.sanitizePublicRelativePath( relCandidate );

      if ( !rel ) continue;

      const isUploads = rel.startsWith( "uploads/" );
      const isRecycle = rel.startsWith( "recyclebin/" );

      if ( onlyUploads && !isUploads ) continue;
      if ( !allowRecyclebin && isRecycle ) continue;
      if ( !isUploads && !isRecycle ) continue;

      // Build absolute path safely under /public
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

      // Directory => scan recursively and flatten file packets
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
   * Read a file under public/ (uploads or recyclebin only).
   *
   * @param relativePathUnderPublic
   * - Expected: "uploads/..." OR "recyclebin/..."
   * - NOT expected: "public/uploads/..." (this class uses PUBLIC_ROOT as base)
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
   * Copy files or directories under public/ into a destination directory.
   *
   * @param options.sources
   * - Expected:
   *   - "uploads/..." OR "recyclebin/..." OR absolute under /public
   *   - OR array of those
   *
   * @param options.destinationDir
   * - Expected:
   *   - target directory under "uploads/" or "recyclebin/"
   *   - Example: "uploads/teamManagement/teamTasks/<teamCode>/<taskId>/evidence"
   *
   * @param options.overwrite
   * - Optional: overwrite existing files (default false)
   *
   * @param options.req
   * - Optional: Express Request for absolute publicUrl
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

        // File => copy into destination dir
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

        // Dir => copy dir into destination dir preserving its directory name
        const dirName = path.basename( srcAbs );
        const dstAbsDir = path.join( dstDirAbs, dirName );

        await fse.copy( srcAbs, dstAbsDir, { overwrite } );

        const finalRelDir = path.relative( FileUploader.PUBLIC_ROOT, dstAbsDir ).replace( /\\/g, "/" );
        copied.push( finalRelDir );

        // Directory meta => scan files under destination directory
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
   * Move files or directories under public/ into a destination directory.
   *
   * @param options.sources
   * - Expected:
   *   - "uploads/..." OR "recyclebin/..." OR absolute under /public
   *
   * @param options.destinationDir
   * - Expected:
   *   - target directory under "uploads/" or "recyclebin/"
   *
   * @param options.overwrite
   * - Optional: overwrite existing (default false)
   *
   * @param options.req
   * - Optional: Express Request for absolute publicUrl
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

        // File => move into destination dir
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

        // Dir => move dir into destination dir preserving its directory name
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
   * Move uploads/* items into recyclebin/<category>/<refId>/uploads/* (mirror tree).
   *
   * @param category
   * - Expected: safe category key like "Milestone" or "Lease" or "TeamTask"
   * - Used to namespace recycle bin entries
   *
   * @param refId
   * - Expected: safe identifier for the deleted object (string id)
   *
   * @param items
   * - Expected: file or dir paths under uploads/
   * - Accepts MoveItem or MoveItem[]
   *
   * @param req
   * - Optional: Express Request for absolute publicUrl
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
        const hintedKind: MoveKind | null = typeof it === "string" ? null : ( it.kind ?? null );

        const trimmed = String( rawPath ?? "" ).trim();
        if ( !trimmed ) {
          skipped.push( String( rawPath ?? "" ) );
          continue;
        }

        // Normalize absolute -> public-relative
        const relCandidate = FileUploader.toPublicRelativeIfAbs( trimmed );
        const rel = FileUploader.sanitizePublicRelativePath( relCandidate );

        // Only uploads are allowed to be recycled
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

        // Mirror tree target:
        //   recyclebin/<cat>/<refId>/<rel>
        const absTarget = path.join( recycleBaseAbs, rel );
        await FileUploader.ensureDirectory( path.dirname( absTarget ) );

        // Collision safe
        const finalAbsTarget = fs.existsSync( absTarget )
          ? FileUploader.withCollisionSuffix( absTarget )
          : absTarget;

        await fse.move( absSource, finalAbsTarget, { overwrite: true } );

        const finalRel = path.relative( FileUploader.PUBLIC_ROOT, finalAbsTarget ).replace( /\\/g, "/" );
        moved.push( finalRel );

        // Build meta packets (files only)
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
   * Restore recyclebin/<cat>/<refId>/uploads/... back to uploads/... (mirror reverse).
   *
   * @param recycleRelativePathsOrDirs
   * - Expected: recyclebin paths:
   *   - "recyclebin/<cat>/<refId>/uploads/..."
   * - Accepts string or string[]
   *
   * @param req
   * - Optional: Express Request for absolute publicUrl
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

        // Restore destination is the "rest" path under PUBLIC_ROOT
        const absTarget = FileUploader.buildSafeChildPath( FileUploader.PUBLIC_ROOT, rest );
        await FileUploader.ensureDirectory( path.dirname( absTarget ) );

        const finalAbsTarget = fs.existsSync( absTarget )
          ? FileUploader.withCollisionSuffix( absTarget )
          : absTarget;

        await fse.move( absSource, finalAbsTarget, { overwrite: true } );

        const finalRel = path.relative( FileUploader.PUBLIC_ROOT, finalAbsTarget ).replace( /\\/g, "/" );
        moved.push( finalRel );

        // Meta packets for moved content
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
   * Permanently delete items from recyclebin.
   *
   * @param recycleRelativePathsOrDirs
   * - Expected: "recyclebin/<cat>/<refId>/..."
   * - Accepts string or string[]
   *
   * @param req
   * - Optional: Express Request for absolute publicUrl (for meta before delete)
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

        // Best-effort meta BEFORE delete
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

        // Delete
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

  /**
   * Recursively scan a directory and return FILE packets only (flat).
   *
   * @param args.absDir
   * - Expected: absolute directory path under PUBLIC_ROOT
   *
   * @param args.relDir
   * - Expected: public-relative directory path (uploads/... or recyclebin/...)
   *
   * @param args.req
   * - Optional: Express Request for absolute publicUrl
   *
   * @param args.onlyUploads
   * - Expected: if true, only include uploads/ paths
   *
   * @param args.allowRecyclebin
   * - Expected: if true, include recyclebin/ paths
   */
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

  /**
   * Build a FileMetaPacket from a known absolute path and its public-relative path.
   *
   * @param args.absPath
   * - Expected: absolute path under PUBLIC_ROOT
   *
   * @param args.relPath
   * - Expected: public-relative path WITHOUT "public/"
   * - Example: "uploads/tenant/X/file.pdf"
   *
   * @param args.req
   * - Optional: Express Request for absolute publicUrl
   */
  private static async buildMetaPacketFromAbs( args: {
    absPath: string;
    relPath: string;
    req?: Request;
  } ): Promise<FileMetaPacket> {
    const st = await fsp.stat( args.absPath );

    // Stored name is always last path segment
    const storedName = path.posix.basename( args.relPath );

    // In generic scans, we don't know the true originalName; use storedName
    const originalName = storedName;

    // Derive extension and guess MIME type
    const extension = path.posix.extname( storedName ).replace( ".", "" );
    const mimeType = FileUploader.guessMimeTypeFromName( storedName );

    // Normalize rel path into unix-like style
    const relativePath = String( args.relPath ?? "" ).replace( /\\/g, "/" ).replace( /^\/+/, "" );

    // Build public url
    const origin = args.req ? FileUploader.buildOriginFromReq( args.req ) : "";
    const publicUrl = origin ? `${ origin }/${ relativePath }` : `/${ relativePath }`;

    // fieldName is not reliably derivable here; keep stable placeholder
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

  /**
   * Normalize + validate a disk destination path for createDiskUpload().
   *
   * @param destination
   * - Expected:
   *   - Absolute path under UPLOAD_ROOT
   *   - OR subPath relative to uploads/
   */
  private static normalizeAndValidateDiskDestination( destination: string ): string {
    const raw = String( destination ?? "" ).trim();
    if ( !raw ) throw new Error( "Upload destination is empty." );

    // If caller gave a relative path => treat as uploads/<subPath>
    if ( !path.isAbsolute( raw ) ) {
      const safeSubPath = FileUploader.sanitizeSubPath( raw );
      return FileUploader.buildSafeChildDir( FileUploader.UPLOAD_ROOT, safeSubPath );
    }

    // Absolute path must be under UPLOAD_ROOT
    const abs = path.resolve( raw );
    const base = path.resolve( FileUploader.UPLOAD_ROOT );

    if ( abs !== base && !abs.startsWith( base + path.sep ) ) {
      throw new Error( "Unsafe upload destination detected." );
    }

    return abs;
  }

  /**
   * Ensure directory exists (mkdirp).
   *
   * @param targetDir
   * - Expected: absolute directory path
   */
  private static async ensureDirectory( targetDir: string ): Promise<void> {
    await fse.ensureDir( targetDir );
  }

  /**
   * Sanitize a subPath used under uploads/.
   *
   * @param subPath
   * - Expected: "teamManagement/teamTasks/__tmp/<token>" (any slashes ok)
   *
   * Output guarantees:
   * - no ".."
   * - only safe segments
   * - unix slashes
   */
  private static sanitizeSubPath( subPath: string ): string {
    const normalized = String( subPath ?? "" ).replace( /\\/g, "/" ).trim();

    const parts = normalized
      .split( "/" )
      .filter( ( p ) => p && p !== "." && p !== ".." )
      .map( ( seg ) => FileUploader.sanitizeSegmentStrict( seg ) )
      .filter( Boolean );

    return parts.join( "/" );
  }

  /**
   * Sanitize a path RELATIVE to PUBLIC_ROOT.
   *
   * @param relative
   * - Expected: "uploads/..." or "recyclebin/..."
   * - Also accepts leading "/" which will be removed
   */
  private static sanitizePublicRelativePath( pathLike: string ): string {
    const rel = PublicPathGuard.normalizeStrict( pathLike );
    if ( !rel ) return ""; // keep old behavior (caller often skips on empty)
    return rel;
  }

  /**
   * Strict segment sanitizer (folder-safe).
   *
   * @param segment
   * - Expected: "evidence" or "LEASE-001"
   * - Output: safe string containing only [a-zA-Z0-9_-]
   */
  private static sanitizeSegmentStrict( segment: string ): string {
    const trimmed = String( segment ?? "" ).trim();
    if ( !trimmed ) return "";
    return trimmed.replace( /[^a-zA-Z0-9_-]/g, "_" );
  }

  /**
   * Loose segment sanitizer for public-relative paths.
   * - Prevent slashes, but allow dots for filenames.
   *
   * @param segment
   * - Expected: a single segment like "file.pdf"
   */
  private static sanitizeSegmentLoose( segment: string ): string {
    const trimmed = String( segment ?? "" ).trim();
    if ( !trimmed ) return "";
    return trimmed.replace( /[\/\\]/g, "_" );
  }

  /**
   * Build safe child directory under a base directory.
   *
   * @param base
   * - Expected: absolute base path (e.g. UPLOAD_ROOT)
   *
   * @param child
   * - Expected: relative path (already sanitized)
   *
   * @returns absolute directory path that is guaranteed to be under base
   */
  private static buildSafeChildDir( base: string, child: string ): string {
    const baseResolved = path.resolve( base );
    const target = path.resolve( base, child );

    if ( !target.startsWith( baseResolved + path.sep ) && target !== baseResolved ) {
      throw new Error( "Unsafe directory path detected" );
    }

    return target;
  }

  /**
   * Build safe child path under a base directory.
   *
   * @param base
   * - Expected: absolute base path (e.g. PUBLIC_ROOT)
   *
   * @param relative
   * - Expected: public-relative path like "uploads/..."
   */
  private static buildSafeChildPath( base: string, relative: string ): string {
    const baseResolved = path.resolve( base );
    const target = path.resolve( base, relative );

    if ( !target.startsWith( baseResolved + path.sep ) && target !== baseResolved ) {
      throw new Error( "Unsafe file path detected" );
    }

    return target;
  }

  /**
   * Slugify a filename base to safe URL/FS friendly format.
   *
   * @param input
   * - Expected: original file name without extension
   */
  private static slugify( input: string ): string {
    const safe = String( input ?? "" )
      .trim()
      .toLowerCase()
      .replace( /[^a-z0-9]+/g, "-" )
      .replace( /^-+|-+$/g, "" );

    return safe || "file";
  }

  /**
   * Read a header safely from req.headers.
   *
   * @param req
   * - Expected: Express Request
   *
   * @param name
   * - Expected: header name (case-insensitive)
   */
  private static getFirstHeaderValue( req: Request, name: string ): string {
    const v = req.headers[ name.toLowerCase() ];
    if ( typeof v === "string" ) return v;
    if ( Array.isArray( v ) && typeof v[ 0 ] === "string" ) return v[ 0 ];
    return "";
  }

  /**
   * Parse first token from comma-separated header values.
   *
   * @param raw
   * - Expected: "https, http" or "example.com, proxy.local"
   */
  private static firstCsvToken( raw: string ): string {
    const token = String( raw ?? "" )
      .split( "," )
      .map( ( s ) => s.trim() )
      .filter( Boolean )
      .at( 0 );

    return token ?? "";
  }

  /**
   * Build origin from request (proxy-safe).
   *
   * @param req
   * - Expected: Express Request
   * - Uses x-forwarded-host + x-forwarded-proto when present
   */
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

  /**
   * Convert a multer file into FileMetaPacket (PropEase contract).
   *
   * @param args.req
   * - Expected: Express Request (for origin)
   *
   * @param args.safeSubPath
   * - Expected: already sanitized sub path under uploads/
   *
   * @param args.fieldName
   * - Expected: sanitized field name (folder-safe)
   *
   * @param args.file
   * - Expected: Express.Multer.File returned by multer
   */
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

    // IMPORTANT:
    // - exactOptionalPropertyTypes safe: we add optional fields only if present
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

    const encoding = typeof file.encoding === "string" ? file.encoding.trim() : "";
    if ( encoding ) {
      ( basePacket as unknown as { encoding: string; } ).encoding = encoding;
    }

    return basePacket;
  }

  /**
   * Build stable UploadResultPacket while computing totals.
   *
   * @param baseRelativeDir
   * - Expected: "uploads/<subPath>"
   *
   * @param basePublicUrl
   * - Expected: "https://host/uploads/<subPath>"
   *
   * @param byField
   * - Expected: fieldName -> packets
   */
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

  /**
   * Seed byField with declared keys, each mapped to empty array.
   *
   * @param fields
   * - Expected: [{ name: "evidence" }, { name: "attachments" }]
   */
  private static seedByFieldKeys( fields: Array<{ name: string; }> ): Record<string, FileMetaPacket[]> {
    const out: Record<string, FileMetaPacket[]> = {};

    for ( const f of fields ) {
      const name = FileUploader.sanitizeSegmentStrict( f?.name ?? "" );
      if ( !name ) continue;
      out[ name ] = [];
    }

    return out;
  }

  /**
   * Read existing files for a single field when multer already executed upstream.
   *
   * @param req
   * - Expected: Express Request containing req.files
   *
   * @param fieldName
   * - Expected: sanitized field name
   */
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

  /**
   * Read existing files for multi-field when multer already executed upstream.
   *
   * @param req
   * - Expected: Express Request containing req.files
   *
   * @returns fieldName -> files[]
   */
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

  /**
   * Pack packet base into FileMetaPacket (contract type).
   *
   * @param base
   * - Expected: full object that matches FileMetaPacket required props
   */
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

  /**
   * Determine whether path is a file or a directory.
   *
   * @param absSource
   * - Expected: absolute path
   *
   * @returns "file" | "dir" | null
   */
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

  /**
   * Add a collision suffix to an absolute target path.
   *
   * @param absTarget
   * - Expected: absolute path that already exists
   *
   * @returns a new absolute path that does not collide (best-effort)
   */
  private static withCollisionSuffix( absTarget: string ): string {
    const stamp = Date.now();
    const ext = path.extname( absTarget );

    if ( ext ) {
      const base = absTarget.slice( 0, -ext.length );
      return `${ base }__${ stamp }${ ext }`;
    }

    return `${ absTarget }__${ stamp }`;
  }

  /**
   * Convert absolute disk path under PUBLIC_ROOT into public-relative path.
   * If input is already relative, returns cleaned relative.
   *
   * @param relOrAbs
   * - Expected:
   *   - absolute path under PUBLIC_ROOT
   *   - OR public-relative path like "uploads/..."
   */
  private static toPublicRelativeIfAbs( relOrAbs: string ): string {
    const raw = String( relOrAbs ?? "" ).trim();
    if ( !raw ) return "";

    if ( path.isAbsolute( raw ) ) {
      const publicRootAbs = path.resolve( FileUploader.PUBLIC_ROOT );
      const abs = path.resolve( raw );

      const rel = path.relative( publicRootAbs, abs ).replace( /\\/g, "/" );

      // If outside public root => mark as unsafe (caller will sanitize and skip)
      if ( rel.startsWith( ".." ) ) return "__outside_public_root__";

      return rel.replace( /^\/+/, "" );
    }

    return PublicPathGuard.normalizeStrict( raw );
  }

  /**
   * Guess MIME type based on file name extension.
   *
   * @param fileName
   * - Expected: "file.png" or "document.pdf"
   */
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
}