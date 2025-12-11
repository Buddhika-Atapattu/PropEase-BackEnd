// Path: src/utils/file-uploader.helper.ts

// ─────────────────────────────────────────────────────────────────────────────
// External dependencies
// ─────────────────────────────────────────────────────────────────────────────

import { Request } from "express";
import fs from "fs";
import fse from "fs-extra";
import multer, { StorageEngine } from "multer";
import path from "path";
import sharp from "sharp";

import { FileMetaBase } from "../types/api-message";


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
 *   - Memory/disk Multer builders for routes (profile images, docs, etc.)
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
    // PUBLIC API – MULTER BUILDERS (CENTRALISED)
    // ─────────────────────────────────────────────

    /**
     * Build a memory-based Multer instance.
     *
     * Typical usage:
     *   const upload = FileUploader.createMemoryUpload(allowedTypes, 20);
     *   router.post('/route', upload.fields([...]), handler);
     *
     * Intended for:
     *   - Small images (profile pictures, avatars) that you want to convert
     *     to WebP or process with Sharp before writing to disk.
     */
    public static createMemoryUpload(
        allowedMimeTypes: ReadonlySet<string>,
        maxFileSizeMb: number
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
            limits: {
                fileSize: maxFileSizeMb * 1024 * 1024,
            },
            fileFilter,
        } );
    }

    /**
     * Build a disk-based Multer instance with a dynamic destination resolver.
     *
     * Used for general document uploads where you want Multer to write files
     * directly to disk under `/public/uploads/...`.
     */
    public static createDiskUpload( options: {
        allowedMimeTypes: ReadonlySet<string>;
        maxFileSizeMb: number;
        maxFiles: number;
        resolveDestination: ( req: Request ) => Promise<string> | string;
    } ): multer.Multer {
        const storage: StorageEngine = multer.diskStorage( {
            destination: async ( req, _file, cb ) => {
                try {
                    const dest: string = await options.resolveDestination( req );
                    cb( null, dest );
                } catch ( error: unknown ) {
                    cb(
                        error instanceof Error
                            ? error
                            : new Error( String( error ) ),
                        ""
                    );
                }
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

    /**
     * Save a single image from an in-memory upload (Multer memory storage)
     * as WebP under a specific entity folder:
     *
     *   /<baseUploadPath>/<entityFolder>/<filename>
     *
     * The controller is responsible for providing:
     *   - baseUploadPath: absolute path, e.g. "/.../public/uploads/users"
     *   - basePublicUrl : full URL prefix, e.g. "http://host/uploads/users"
     *   - entityFolder  : path-safe segment, e.g. "buddhika"
     *   - filename      : "image.webp"
     */
    public static async saveSingleImageFromMemory( options: {
        baseUploadPath: string;
        basePublicUrl: string;
        entityFolder: string;
        filename: string;
        buffer: Buffer;
        webpQuality?: number;
    } ): Promise<{ publicUrl: string; diskPath: string; }> {
        const quality: number =
            typeof options.webpQuality === "number" ? options.webpQuality : 80;

        const safeFolder: string = FileUploader.sanitizeSegmentStrict(
            options.entityFolder
        );

        const targetDir: string = FileUploader.buildSafeChildDir(
            options.baseUploadPath,
            safeFolder
        );

        await FileUploader.ensureDirectory( targetDir );

        const diskPath: string = path.join( targetDir, options.filename );

        await sharp( options.buffer )
            .webp( { quality } )
            .toFile( diskPath );

        const baseUrlTrimmed: string = options.basePublicUrl.replace( /\/+$/, "" );
        const publicUrl: string = [
            baseUrlTrimmed,
            encodeURIComponent( safeFolder ),
            options.filename,
        ].join( "/" );

        return { publicUrl, diskPath };
    }

    // ─────────────────────────────────────────────
    // PUBLIC API – GENERIC MULTI-FILE UPLOAD (SERVICE STYLE)
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

    public static async convertToWebP(
        absInputPath: string,
        absOutputDir: string,
        quality = 80
    ): Promise<FileMetaBase> {
        try {
            if ( !absInputPath || !absOutputDir ) {
                throw new Error(
                    "Input and output paths are required for WebP conversion."
                );
            }

            if ( !fs.existsSync( absInputPath ) ) {
                throw new Error( `Input file not found: ${ absInputPath }` );
            }

            await fse.ensureDir( absOutputDir );

            const inputBase: string = path.basename(
                absInputPath,
                path.extname( absInputPath )
            );
            const safeBase: string = FileUploader.slugify( inputBase );
            const storedName: string = `${ safeBase }_${ Date.now() }.webp`;

            const absOutputPath: string = path.join( absOutputDir, storedName );

            await sharp( absInputPath )
                .webp( { quality } )
                .toFile( absOutputPath );

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

            throw new Error( message );
        }
    }

    // Path: src/utils/file-uploader.helper.ts

    /**
     * Generic multi-field upload handler for multipart/form-data routes.
     *
     * - Writes under: /public/uploads/<subPath>/<fieldName>/
     * - Supports multiple Multer fields in a single request (e.g. images + documents).
     * - Enforces optional per-field MIME type allow-lists.
     *
     * Example usage (Property router):
     *   const uploaded = await FileUploader.handleMultiFieldUpload(
     *     `properties/${propertyID}`,
     *     [
     *       { name: 'images', maxCount: 30 },
     *       { name: 'documents', maxCount: 20 },
     *     ],
     *     req,
     *     {
     *       allowedMimeTypesByField: {
     *         images: new Set([...]),
     *         documents: new Set([...]),
     *       },
     *       maxFileSizeMb: 25,
     *       maxFiles: 40,
     *     }
     *   );
     *
     *   const images = uploaded.images ?? [];
     *   const docs   = uploaded.documents ?? [];
     */
    public static async handleMultiFieldUpload(
        subPath: string,
        fields: Array<{ name: string; maxCount?: number; }>,
        req: Request,
        options?: {
            allowedMimeTypesByField?: Record<string, ReadonlySet<string>>;
            maxFileSizeMb?: number;
            maxFiles?: number;
        }
    ): Promise<Record<string, Express.Multer.File[]>> {
        // 1) Sanitise and normalise subPath
        const safeSubPath: string = FileUploader.sanitizeSubPath( subPath );

        if ( !safeSubPath.trim() ) {
            throw new Error( "Uploading path is required!" );
        }

        // 2) Base directory for this logical bucket
        const baseDir: string = FileUploader.buildSafeChildDir(
            FileUploader.UPLOAD_ROOT,
            safeSubPath
        );

        await FileUploader.ensureDirectory( baseDir );

        // 3) Storage: /uploads/<subPath>/<fieldName>/
        const storage: StorageEngine = multer.diskStorage( {
            destination: async ( _req, file, cb ): Promise<void> => {
                try {
                    const fieldName: string = file.fieldname;
                    const targetDir: string = FileUploader.buildSafeChildDir(
                        baseDir,
                        fieldName
                    );
                    await FileUploader.ensureDirectory( targetDir );
                    cb( null, targetDir );
                } catch ( error: unknown ) {
                    cb(
                        error instanceof Error
                            ? error
                            : new Error( String( error ) ),
                        ""
                    );
                }
            },
            filename: ( _req, file, cb ): void => {
                const ext: string = path.extname( file.originalname );
                const base: string = path.basename( file.originalname, ext );
                const timestamp: number = Date.now();
                const safeBase: string = FileUploader.slugify( base );
                const storedName: string = `${ safeBase }_${ timestamp }${ ext.toLowerCase() }`;
                cb( null, storedName );
            },
        } );

        // 4) Optional per-field MIME allow-list
        const fileFilter: multer.Options[ "fileFilter" ] = (
            _req,
            file,
            cb
        ): void => {
            const byField: Record<string, ReadonlySet<string>> | undefined =
                options?.allowedMimeTypesByField;

            if ( !byField || Object.keys( byField ).length === 0 ) {
                cb( null, true );
                return;
            }

            const allowedForField: ReadonlySet<string> | undefined =
                byField[ file.fieldname ];

            if ( !allowedForField || allowedForField.size === 0 ) {
                // No explicit list for this field ⇒ allow all for this field
                cb( null, true );
                return;
            }

            if ( allowedForField.has( file.mimetype ) ) {
                cb( null, true );
                return;
            }

            cb(
                new Error(
                    `File type not allowed for field "${ file.fieldname }": ${ file.mimetype }`
                )
            );
        };

        const upload = multer( {
            storage,
            limits: {
                fileSize: ( options?.maxFileSizeMb ?? 20 ) * 1024 * 1024,
                files: options?.maxFiles ?? 40,
            },
            fileFilter,
        } ).fields( fields );

        // 5) Wrap callback-style API in a Promise
        const filesByField: Record<string, Express.Multer.File[]> =
            await new Promise(
                ( resolve, reject ): void => {
                    upload( req, {} as any, ( err: unknown ): void => {
                        if ( err ) {
                            const message: string =
                                err instanceof Error
                                    ? err.message
                                    : "Unknown upload error";
                            reject( new Error( `File upload failed: ${ message }` ) );
                            return;
                        }

                        // Multer sets req.files as Record<string, Express.Multer.File[]>
                        const uploaded:
                            | Record<string, Express.Multer.File[]>
                            | undefined = req.files as
                            | Record<string, Express.Multer.File[]>
                            | undefined;

                        resolve( uploaded ?? {} );
                    } );
                }
            );

        return filesByField;
    }


    // ─────────────────────────────────────────────
    // PRIVATE HELPERS – PATH SAFETY & UTILITIES
    // ─────────────────────────────────────────────

    private static async ensureDirectory( targetDir: string ): Promise<void> {
        await fse.ensureDir( targetDir );
    }

    private static sanitizeSubPath( subPath: string ): string {
        const normalized: string = subPath.replace( /\\/g, "/" ).trim();

        const parts: string[] = normalized
            .split( "/" )
            .filter( ( part: string ) => part && part !== "." && part !== ".." )
            .map( ( segment: string ) => FileUploader.sanitizeSegmentStrict( segment ) );

        return parts.join( "/" );
    }

    private static sanitizeSegmentStrict( segment: string ): string {
        const trimmed: string = segment.trim();
        if ( !trimmed ) return "";
        return trimmed.replace( /[^a-zA-Z0-9_-]/g, "_" );
    }

    private static buildSafeChildDir( base: string, child: string ): string {
        const baseResolved: string = path.resolve( base );
        const target: string = path.resolve( base, child );

        if ( !target.startsWith( baseResolved + path.sep ) && target !== baseResolved ) {
            throw new Error( "Unsafe directory path detected" );
        }

        return target;
    }

    private static buildSafeChildPath( base: string, relative: string ): string {
        const baseResolved: string = path.resolve( base );
        const target: string = path.resolve( base, relative );

        if ( !target.startsWith( baseResolved + path.sep ) && target !== baseResolved ) {
            throw new Error( "Unsafe file path detected" );
        }

        return target;
    }

    private static slugify( input: string ): string {
        const safe: string = input
            .trim()
            .toLowerCase()
            .replace( /[^a-z0-9]+/g, "-" )
            .replace( /^-+|-+$/g, "" );

        return safe || "file";
    }
}
