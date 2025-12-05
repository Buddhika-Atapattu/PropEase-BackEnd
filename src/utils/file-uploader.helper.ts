// Path: src/utils/file-uploader.helper.ts

// ─────────────────────────────────────────────────────────────────────────────
// External dependencies
// ─────────────────────────────────────────────────────────────────────────────

import dotenv from "dotenv";
import { Request } from "express";
import fs from "fs";
import fse from "fs-extra";
import multer, { StorageEngine } from "multer";
import path from "path";
import sharp from "sharp";

import { FileMetaBase } from "../types/api-message";

dotenv.config();

/**
 * FileUploader
 * ------------
 * Centralised, stateless helper for all **file lifecycle** operations:
 *
 *   - Upload into `/public/uploads`
 *   - Soft-delete (move) into `/public/recyclebin`
 *   - Restore from `/public/recyclebin` back to `/public/uploads`
 *   - Permanently delete from `/public/recyclebin`
 *   - Convert image assets into WebP format
 *
 * Architectural principle:
 *   - This class is **pure infrastructure / domain**. It does **not** know HTTP.
 *   - No `res: Response` and no `ApiResponseBuilder` used directly here.
 *   - Controllers call these methods and decide how to build API responses.
 */
export default class FileUploader {

    // ─────────────────────────────────────────────
    // Root paths (filesystem)
    // ─────────────────────────────────────────────

    /**
     * Absolute path to `/public`.
     * Example: `/.../propease-backend/public`
     */
    private static readonly PUBLIC_ROOT: string = path.resolve(
        __dirname,
        "..",
        "..",
        "public"
    );

    /**
     * Absolute path to `/public/uploads`.
     * All active (non-deleted) files must live under this tree.
     */
    private static readonly UPLOAD_ROOT: string = path.join(
        FileUploader.PUBLIC_ROOT,
        "uploads"
    );

    /**
     * Absolute path to `/public/recyclebin`.
     * Soft-deleted files are moved here, namespaced by category and reference id.
     */
    private static readonly RECYCLEBIN_ROOT: string = path.join(
        FileUploader.PUBLIC_ROOT,
        "recyclebin"
    );

    /**
     * URL prefix for serving uploads via Express static middleware, e.g.:
     *   app.use('/uploads', express.static(path.join(__dirname, '..', '..', 'public', 'uploads')));
     *
     * Not used directly in this helper (file system only), but useful if
     * callers want to map `storedName` → public URL.
     */
    private static readonly UPLOAD_URL_PREFIX: string = "/uploads";

    // ─────────────────────────────────────────────
    // PUBLIC API – UPLOAD
    // ─────────────────────────────────────────────

    /**
     * Generic multi-file upload handler (service-style).
     *
     * This method:
     *   1. Validates and sanitises the logical `subPath` under `/uploads`.
     *   2. Ensures the target directory exists.
     *   3. Runs Multer with `diskStorage` to write uploaded files to that directory.
     *   4. Returns a strictly typed `FileMetaBase[]` describing the stored files.
     *
     * IMPORTANT:
     *   - No HTTP response is sent here.
     *   - Controllers should `await` this method and then call `ApiResponseBuilder`
     *     (or any other response builder) themselves.
     *
     * @param subPath    Logical path under `/uploads`, e.g. "complaints/123/docs".
     * @param fieldName  Multer field name, e.g. "files", "attachments".
     * @param req        Express request (Multer reads `req` body + file stream).
     *
     * @returns          Array of `FileMetaBase` describing each stored file.
     *
     * Usage from controller (example):
     *
     *   const files = await FileUploader.handleUpload(
     *     `complaints/${complaintId}/documents`,
     *     "attachments",
     *     req
     *   );
     *   ApiResponseBuilder.ok(res, "files", files, "Files uploaded successfully");
     */
    public static async handleUpload(
        subPath: string,
        fieldName: string,
        req: Request
    ): Promise<FileMetaBase[]> {
        // 1) Sanitise and validate subPath
        const safeSubPath: string = FileUploader.sanitizeSubPath( subPath );

        if ( !safeSubPath.trim() ) {
            throw new Error( "Uploading path is required!" );
        }

        // 2) Resolve target directory under /public/uploads with guardrails
        const targetDir: string = FileUploader.buildSafeChildDir(
            FileUploader.UPLOAD_ROOT,
            safeSubPath
        );

        await FileUploader.ensureDirectory( targetDir );

        // 3) Configure Multer storage: write into `targetDir` with a slugified, timestamped filename
        const storage: StorageEngine = multer.diskStorage( {
            destination: ( _req, _file, cb ) => {
                cb( null, targetDir );
            },
            filename: ( _req, file, cb ) => {
                const ext: string = path.extname( file.originalname );
                const base: string = path.basename( file.originalname, ext );
                const timestamp: number = Date.now();
                const safeBase: string = FileUploader.slugify( base );
                const storedName: string = `${ safeBase }_${ timestamp }${ ext.toLowerCase() }`;
                cb( null, storedName );
            },
        } );

        const upload = multer( {
            storage,
            limits: {
                fileSize: 20 * 1024 * 1024, // 20MB per file
                files: 20,                  // Maximum number of files per request
            },
        } ).array( fieldName );

        // 4) Wrap Multer callback-style API into a Promise so controllers can `await` this method.
        const files: Express.Multer.File[] = await new Promise(
            ( resolve, reject ): void => {
                // Multer signature is (req, res, cb). We don't use `res` here; it's a dummy.
                upload( req, {} as any, ( err: unknown ): void => {
                    if ( err ) {
                        const message: string =
                            err instanceof Error ? err.message : "Unknown upload error";
                        reject( new Error( `File upload failed: ${ message }` ) );
                        return;
                    }

                    const uploadedFiles: Express.Multer.File[] = ( req.files ??
                        [] ) as Express.Multer.File[];

                    resolve( uploadedFiles );
                } );
            }
        );

        // 5) Map Multer files into FileMetaBase structures
        const payload: FileMetaBase[] = files.map(
            ( file: Express.Multer.File ): FileMetaBase => {
                return {
                    originalName: file.originalname,
                    storedName: file.filename,
                    extension: path.extname( file.filename ).replace( ".", "" ),
                    mimeType: file.mimetype,
                    sizeBytes: file.size,
                };
            }
        );

        return payload;
    }

    // ─────────────────────────────────────────────
    // PUBLIC API – MOVE TO RECYCLE BIN (SOFT DELETE)
    // ─────────────────────────────────────────────

    /**
     * Move one or more files from `/public/uploads` → `/public/recyclebin`.
     *
     * Data model:
     *   - Files are moved into `/public/recyclebin/<category>/<refId>/`.
     *
     * @param category        Logical category, e.g. "complaints", "leases", "teams".
     * @param refId           Domain reference ID, e.g. complaint code, team id, lease id.
     * @param relativePaths   Paths **relative to `/public`**, e.g. "uploads/complaints/123/a.pdf".
     *
     * @returns               `{ moved: string[] }` where each string is a path
     *                         relative to `/public`, e.g. "recyclebin/complaints/123/a.pdf".
     *
     * Usage example in controller:
     *
     *   const result = await FileUploader.moveToRecycleBin(
     *     "complaints",
     *     complaintId,
     *     body.paths
     *   );
     *   ApiResponseBuilder.ok(res, "other", result, "Files moved to recycle bin");
     */
    public static async moveToRecycleBin(
        category: string,
        refId: string,
        relativePaths: string[]
    ): Promise<{ moved: string[]; }> {
        if ( !Array.isArray( relativePaths ) || relativePaths.length === 0 ) {
            throw new Error(
                "At least one file path is required to move to recycle bin"
            );
        }

        const safeCategory: string = FileUploader.sanitizeSegmentStrict( category );
        const safeRefId: string = FileUploader.sanitizeSegmentStrict( refId );

        if ( !safeCategory || !safeRefId ) {
            throw new Error(
                "Category and reference ID are required for recycle bin operations"
            );
        }

        const recycleBase: string = FileUploader.buildSafeChildDir(
            FileUploader.RECYCLEBIN_ROOT,
            path.join( safeCategory, safeRefId )
        );

        await FileUploader.ensureDirectory( recycleBase );

        const moved: string[] = [];

        for ( const rel of relativePaths ) {
            const normalizedRel: string = rel.replace( /\\/g, "/" ).trim();

            // Only allow moves from uploads namespace (defensive guard)
            if ( !normalizedRel.startsWith( "uploads/" ) ) {
                continue;
            }

            const absSource: string = FileUploader.buildSafeChildPath(
                FileUploader.PUBLIC_ROOT,
                normalizedRel
            );

            if ( !fs.existsSync( absSource ) ) {
                continue;
            }

            const fileName: string = path.basename( absSource );
            const absTarget: string = path.join( recycleBase, fileName );

            await fse.move( absSource, absTarget, { overwrite: true } );

            const recycleRelative: string = path
                .relative( FileUploader.PUBLIC_ROOT, absTarget )
                .replace( /\\/g, "/" );

            moved.push( recycleRelative );
        }

        return { moved };
    }

    // ─────────────────────────────────────────────
    // PUBLIC API – RESTORE FROM RECYCLE BIN
    // ─────────────────────────────────────────────

    /**
     * Restore files from `/public/recyclebin` back into `/public/uploads`.
     *
     * For each:
     *   "recyclebin/complaints/123/a.pdf"
     *     → strip "recyclebin/"
     *     → restore into "/public/uploads/complaints/123/a.pdf"
     *
     * @param recycleRelativePaths   Paths relative to `/public`,
     *                               e.g. "recyclebin/complaints/123/a.pdf".
     *
     * @returns                      `{ restored: string[] }` where each entry is
     *                               a path relative to `/public/uploads/...`.
     */
    public static async restoreFromRecycleBin(
        recycleRelativePaths: string[]
    ): Promise<{ restored: string[]; }> {
        if ( !Array.isArray( recycleRelativePaths ) || recycleRelativePaths.length === 0 ) {
            throw new Error(
                "At least one recycle bin path is required to restore"
            );
        }

        const restored: string[] = [];

        for ( const rel of recycleRelativePaths ) {
            const normalized: string = rel.replace( /\\/g, "/" ).trim();

            if ( !normalized.startsWith( "recyclebin/" ) ) {
                continue;
            }

            const absSource: string = FileUploader.buildSafeChildPath(
                FileUploader.PUBLIC_ROOT,
                normalized
            );

            if ( !fs.existsSync( absSource ) ) {
                continue;
            }

            // Strip the "recyclebin/" prefix so that we mirror the tree under uploads
            const withoutPrefix: string = normalized.replace( /^recyclebin\//, "" );
            const absTarget: string = FileUploader.buildSafeChildPath(
                FileUploader.UPLOAD_ROOT,
                withoutPrefix
            );

            const targetDir: string = path.dirname( absTarget );
            await FileUploader.ensureDirectory( targetDir );

            await fse.move( absSource, absTarget, { overwrite: true } );

            const uploadRelative: string = path
                .relative( FileUploader.PUBLIC_ROOT, absTarget )
                .replace( /\\/g, "/" );

            restored.push( uploadRelative );
        }

        return { restored };
    }

    // ─────────────────────────────────────────────
    // PUBLIC API – PERMANENT DELETE FROM RECYCLE BIN
    // ─────────────────────────────────────────────

    /**
     * Permanently delete files or directories from `/public/recyclebin`.
     *
     * @param recycleRelativePathsOrDirs   Paths relative to `/public`,
     *                                     must start with "recyclebin/".
     *
     * @returns                            `{ deleted: string[] }` with relative
     *                                     paths of deleted files/directories.
     *
     * Behaviour:
     *   - Deletes files or directories irreversibly from the recycle bin.
     *   - Intended for admin actions or scheduled cleanup tasks.
     */
    public static async deleteFromRecycleBin(
        recycleRelativePathsOrDirs: string[]
    ): Promise<{ deleted: string[]; }> {
        if (
            !Array.isArray( recycleRelativePathsOrDirs ) ||
            recycleRelativePathsOrDirs.length === 0
        ) {
            throw new Error(
                "At least one recycle bin file or directory path is required to delete"
            );
        }

        const deleted: string[] = [];

        for ( const rel of recycleRelativePathsOrDirs ) {
            const normalized: string = rel.replace( /\\/g, "/" ).trim();

            if ( !normalized.startsWith( "recyclebin/" ) ) {
                continue;
            }

            const absTarget: string = FileUploader.buildSafeChildPath(
                FileUploader.PUBLIC_ROOT,
                normalized
            );

            if ( !fs.existsSync( absTarget ) ) {
                continue;
            }

            const stat = await fse.stat( absTarget );

            if ( stat.isDirectory() ) {
                await fse.remove( absTarget );
            } else {
                await fse.unlink( absTarget );
            }

            deleted.push( normalized );
        }

        return { deleted };
    }

    // ─────────────────────────────────────────────
    // PUBLIC API – IMAGE CONVERSION (WebP)
    // ─────────────────────────────────────────────

    /**
     * Convert any Sharp-supported raster image into modern WebP.
     *
     * This is a pure transformation:
     *   - No HTTP response handling.
     *   - Input and output paths must be fully resolved and validated by callers.
     *   - The original file is not mutated; conversion creates a new artifact.
     *
     * @param absInputPath   Fully resolved absolute path to the input image.
     * @param absOutputDir   Fully resolved absolute directory where WebP should be stored.
     * @param quality        WebP quality (0–100). Default: 80 (good balance).
     *
     * @returns              A `FileMetaBase` describing the converted WebP file.
     */
    public static async convertToWebP(
        absInputPath: string,
        absOutputDir: string,
        quality = 80
    ): Promise<FileMetaBase> {
        try {
            // 1) Validate parameters
            if ( !absInputPath || !absOutputDir ) {
                throw new Error(
                    "Input and output paths are required for WebP conversion."
                );
            }

            // 2) Ensure input exists
            if ( !fs.existsSync( absInputPath ) ) {
                throw new Error( `Input file not found: ${ absInputPath }` );
            }

            // 3) Ensure output directory exists
            await fse.ensureDir( absOutputDir );

            // 4) Build deterministic, slug-safe output file name
            const inputBase: string = path.basename(
                absInputPath,
                path.extname( absInputPath )
            );
            const safeBase: string = FileUploader.slugify( inputBase );
            const storedName: string = `${ safeBase }_${ Date.now() }.webp`;

            const absOutputPath: string = path.join( absOutputDir, storedName );

            // 5) Image transformation pipeline (original → WebP)
            await sharp( absInputPath )
                .webp( { quality } )
                .toFile( absOutputPath );

            // 6) Output file metadata aligned with FileMetaBase
            const stat = await fse.stat( absOutputPath );

            const meta: FileMetaBase = {
                originalName: path.basename( absInputPath ),
                storedName,
                extension: "webp",
                mimeType: "image/webp",
                sizeBytes: stat.size,
            };

            return meta;
        } catch ( error ) {
            const message: string =
                error instanceof Error
                    ? `WebP conversion failed: ${ error.message }`
                    : "Unknown error during WebP conversion";

            // Intentionally rethrow for upstream handling (controller/service decides how to react)
            throw new Error( message );
        }
    }

    // ─────────────────────────────────────────────
    // PRIVATE HELPERS – PATH SAFETY & UTILITIES
    // ─────────────────────────────────────────────

    /**
     * Ensure that a directory exists (mkdir -p semantics).
     * Safe to call repeatedly; `fs-extra.ensureDir` is idempotent.
     */
    private static async ensureDirectory( targetDir: string ): Promise<void> {
        await fse.ensureDir( targetDir );
    }

    /**
     * Strict sanitisation for composite subpaths, e.g. "complaints/123/documents".
     *
     * Steps:
     *   - Normalise slashes to "/".
     *   - Split into segments.
     *   - Remove empty segments and "."/".." occurrences.
     *   - Apply strict per-segment sanitisation.
     */
    private static sanitizeSubPath( subPath: string ): string {
        const normalized: string = subPath.replace( /\\/g, "/" ).trim();

        const parts: string[] = normalized
            .split( "/" )
            .filter( ( part: string ) => part && part !== "." && part !== ".." )
            .map( ( segment: string ) => FileUploader.sanitizeSegmentStrict( segment ) );

        return parts.join( "/" );
    }

    /**
     * Strict sanitisation for a *single* path segment (category, refId, folder names).
     *
     * Allowed characters:
     *   - a–z, A–Z, 0–9, underscore (_), hyphen (-)
     *
     * Anything else is normalised to underscore.
     */
    private static sanitizeSegmentStrict( segment: string ): string {
        const trimmed: string = segment.trim();
        if ( !trimmed ) return "";
        return trimmed.replace( /[^a-zA-Z0-9_-]/g, "_" );
    }

    /**
     * Safe child directory builder.
     *
     * Behaviour:
     *   - Resolves `base + child` using `path.resolve`.
     *   - Ensures the resolved path remains within `base`.
     *   - Rejects traversal attempts by throwing an error.
     */
    private static buildSafeChildDir( base: string, child: string ): string {
        const baseResolved: string = path.resolve( base );
        const target: string = path.resolve( base, child );

        if ( !target.startsWith( baseResolved + path.sep ) && target !== baseResolved ) {
            throw new Error( "Unsafe directory path detected" );
        }

        return target;
    }

    /**
     * Safe child path builder (for files).
     *
     * Same concept as `buildSafeChildDir`, but used for concrete file paths under a base.
     */
    private static buildSafeChildPath( base: string, relative: string ): string {
        const baseResolved: string = path.resolve( base );
        const target: string = path.resolve( base, relative );

        if ( !target.startsWith( baseResolved + path.sep ) && target !== baseResolved ) {
            throw new Error( "Unsafe file path detected" );
        }

        return target;
    }

    /**
     * Slugify filename base (without extension) into a filesystem-friendly token.
     *
     * Rules:
     *   - Lowercase.
     *   - Non [a-z0-9] sequences collapse into "-".
     *   - Leading/trailing "-" removed.
     *   - Fallback to "file" if result is empty.
     */
    private static slugify( input: string ): string {
        const safe: string = input
            .trim()
            .toLowerCase()
            .replace( /[^a-z0-9]+/g, "-" )
            .replace( /^-+|-+$/g, "" );

        return safe || "file";
    }
}
