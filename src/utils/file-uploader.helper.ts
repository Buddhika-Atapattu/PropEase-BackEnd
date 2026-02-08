// Path: src/utils/file-uploader.helper.ts
/* ============================================================================
 * 🔴🔴🔴 CRITICAL WARNING (DO NOT MODIFY WITHOUT SYSTEM REVIEW) 🔴🔴🔴
 * ----------------------------------------------------------------------------
 * This file is a SECURITY + CONTRACT CRITICAL infrastructure component.
 *
 * What this file guarantees (invariants):
 *  1) Path Traversal Protection
 *     - No caller can write/move/read outside:  /public
 *     - Uploads are always under:              /public/uploads
 *     - Soft deletes are always under:         /public/recyclebin
 *
 *  2) Universal Upload Result Packet
 *     - Every upload operation returns the SAME shape (UploadResultPacket)
 *     - Supports single-field and multi-field uploads
 *     - byField always includes declared keys (empty arrays included)
 *
 *  3) Double-Run Protection (IMPORTANT)
 *     - If route already ran multer middleware, we DO NOT run multer again
 *     - Prevents multipart stream corruption:
 *         - "Unexpected end of form"
 *         - duplicate file writes
 *         - inconsistent req.body / req.files
 *
 *  4) Recycle Bin Tree Mirror (NEW DESIGN)
 *     - When moving to recycle bin, we preserve the SAME public-relative path
 *       under recyclebin/<category>/<refId>/...
 *
 *       Example:
 *         uploads/comments/Complaints/X/attachments/CMT-123/01.jpg
 *       becomes:
 *         recyclebin/comments/CMT-123/uploads/comments/Complaints/X/attachments/CMT-123/01.jpg
 *
 *     This makes RESTORE trivial and future-proof.
 *
 * Any change here can break:
 * - Upload security (writing outside /public/uploads)
 * - Comments engine attachments (URLs/relative paths)
 * - Property / Tenant / Lease document uploads
 * - Recyclebin restore/delete invariants
 * ========================================================================== */

import type { Request } from "express";
import fs from "fs";
import fse from "fs-extra";
import multer, { type StorageEngine } from "multer";
import path from "path";
import sharp from "sharp";

import type { FileMetaPacket } from "../types/api-message";

/* ========================================================================== *
 * UNIVERSAL UPLOAD RESULT CONTRACT
 * ========================================================================== */

export interface UploadResultPacket {
  /**
   * Base directory (relative under /public) that groups this upload.
   * Example:
   *   "uploads/comments/Teams/PROPEASE-TEAM-001"
   */
  baseRelativeDir: string;

  /**
   * Absolute base public URL to the folder.
   * Example:
   *   "http://localhost:3000/uploads/comments/Teams/PROPEASE-TEAM-001"
   */
  basePublicUrl: string;

  totalFiles: number;
  totalBytes: number;

  /**
   * Always returned by fieldname.
   * Example:
   *   {
   *     attachments: FileMetaPacket[],
   *     documents: FileMetaPacket[]
   *   }
   *
   * IMPORTANT:
   * - Multi-field handler seeds ALL declared keys
   * - Even if empty, each declared key exists: []
   */
  byField: Record<string, FileMetaPacket[]>;
}

/* ========================================================================== *
 * FILE SYSTEM CRUD RESULT CONTRACTS
 * ========================================================================== */

export interface FsMoveResult {
  moved: string[];   // public-relative unix paths (e.g. "recyclebin/..", "uploads/..")
  skipped: string[]; // inputs that were ignored due to validation/safety/missing
}

export interface FsCopyResult {
  copied: string[];
  skipped: string[];
}

export interface FsDeleteResult {
  deleted: string[];
  skipped: string[];
}

/* ========================================================================== *
 * FILE UPLOADER (UNIVERSAL / MODULE-AGNOSTIC)
 * ========================================================================== */

type MoveKind = "file" | "dir";

/**
 * Move input type for recycle-bin operations.
 *
 * Why this exists:
 * - Most callers pass strings (simple)
 * - Advanced callers can pass `{ path, kind }` to avoid fs.stat() calls
 */
type MoveItem =
  | string
  | {
      /**
       * Public-relative path.
       * ✅ Recommended: "uploads/...."
       * ⚠️ Allowed: absolute path inside PUBLIC_ROOT (will be converted)
       */
      path: string;

      /**
       * Optional hint to skip filesystem stat.
       * If omitted, we detect using fs.statSync(absPath).
       */
      kind?: MoveKind;
    };

export default class FileUploader {
  // ─────────────────────────────────────────────
  // Root paths (filesystem)
  // ─────────────────────────────────────────────

  /**
   * Absolute path to `/public`.
   * Example:
   *   D:\project\PropEase\back-end\src\public
   */
  private static readonly PUBLIC_ROOT: string = path.resolve(__dirname, "..", "..", "public");

  /**
   * Absolute path to `/public/uploads`.
   * All active (non-deleted) files must live under this tree.
   */
  private static readonly UPLOAD_ROOT: string = path.join(FileUploader.PUBLIC_ROOT, "uploads");

  /**
   * Absolute path to `/public/recyclebin`.
   * Soft-deleted files are moved here.
   */
  private static readonly RECYCLEBIN_ROOT: string = path.join(FileUploader.PUBLIC_ROOT, "recyclebin");

  /**
   * Public URL prefix used by Express static middleware.
   * Example:
   *   app.use('/uploads', express.static(.../public/uploads))
   */
  private static readonly UPLOAD_URL_PREFIX: string = "/uploads";

  // ─────────────────────────────────────────────
  // PUBLIC API – MULTER BUILDERS
  // ─────────────────────────────────────────────

  /**
   * Memory-based Multer instance builder.
   *
   * When to use:
   * - You need buffer transformations before saving:
   *   - sharp -> webp
   *   - OCR pre-processing
   *
   * Params:
   * - allowedMimeTypes:
   *     If empty => allow all.
   *     Otherwise only allow listed mimetypes.
   * - maxFileSizeMb:
   *     Per-file maximum size.
   */
  public static createMemoryUpload(
    allowedMimeTypes: ReadonlySet<string>,
    maxFileSizeMb: number,
  ): multer.Multer {
    const storage = multer.memoryStorage();

    const fileFilter: multer.Options["fileFilter"] = (_req, file, cb): void => {
      if (!allowedMimeTypes || allowedMimeTypes.size === 0) {
        cb(null, true);
        return;
      }
      if (allowedMimeTypes.has(file.mimetype)) {
        cb(null, true);
        return;
      }
      cb(new Error(`File type not allowed: ${file.mimetype}`));
    };

    return multer({
      storage,
      limits: { fileSize: maxFileSizeMb * 1024 * 1024 },
      fileFilter,
    });
  }

  /**
   * Disk-based Multer instance builder with a destination resolver.
   *
   * IMPORTANT:
   * - resolveDestination can return:
   *   (A) Absolute path (must stay inside /public/uploads)
   *   (B) Relative subPath like "comments/temp" (recommended)
   *
   * Params:
   * - allowedMimeTypes:
   *     Allowed mimetypes for all fields. (If empty => allow all)
   * - maxFileSizeMb:
   *     Per-file max size.
   * - maxFiles:
   *     Total files max.
   * - resolveDestination(req):
   *     Decide where to store files for this request.
   */
  public static createDiskUpload(options: {
    allowedMimeTypes: ReadonlySet<string>;
    maxFileSizeMb: number;
    maxFiles: number;
    resolveDestination: (req: Request) => Promise<string> | string;
  }): multer.Multer {
    const storage: StorageEngine = multer.diskStorage({
      destination: async (req, _file, cb): Promise<void> => {
        try {
          const resolved = await options.resolveDestination(req);
          const dest = FileUploader.normalizeAndValidateDiskDestination(resolved);
          await FileUploader.ensureDirectory(dest);
          cb(null, dest);
        } catch (error: unknown) {
          cb(error instanceof Error ? error : new Error(String(error)), "");
        }
      },
      filename: (_req, file, cb): void => {
        const ext = path.extname(file.originalname);
        const base = path.basename(file.originalname, ext);
        const storedName = `${FileUploader.slugify(base)}_${Date.now()}${ext.toLowerCase()}`;
        cb(null, storedName);
      },
    });

    const fileFilter: multer.Options["fileFilter"] = (_req, file, cb): void => {
      if (!options.allowedMimeTypes || options.allowedMimeTypes.size === 0) {
        cb(null, true);
        return;
      }
      if (options.allowedMimeTypes.has(file.mimetype)) {
        cb(null, true);
        return;
      }
      cb(new Error(`File type not allowed: ${file.mimetype}`));
    };

    return multer({
      storage,
      limits: {
        fileSize: options.maxFileSizeMb * 1024 * 1024,
        files: options.maxFiles,
      },
      fileFilter,
    });
  }

  // ─────────────────────────────────────────────
  // PUBLIC API – UNIVERSAL UPLOAD (SINGLE FIELD)
  // ─────────────────────────────────────────────

  /**
   * Universal single-field upload handler that ALWAYS returns UploadResultPacket.
   *
   * Storage layout:
   *   /public/uploads/<safeSubPath>/<fieldName>/<storedName>
   *
   * Params:
   * - subPath:
   *     Relative path INSIDE uploads root (no leading slash).
   *     Example: "comments/Teams/PROPEASE-TEAM-001"
   *
   * - fieldName:
   *     Multipart field name. Example: "attachments"
   *
   * - req:
   *     Express request. Used for:
   *       - reading req.files when middleware already ran
   *       - building origin URL for FileMetaPacket.publicUrl
   *
   * - options:
   *     allowedMimeTypes, maxFileSizeMb, maxFiles
   *
   * DOUBLE-RUN PROTECTION:
   * - If the route already ran multer middleware (req.files exists),
   *   we DO NOT run multer again.
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
    const safeSubPath = FileUploader.sanitizeSubPath(subPath);
    if (!safeSubPath.trim()) {
      throw new Error("Uploading path is required!");
    }

    const safeField = FileUploader.sanitizeSegmentStrict(fieldName);
    if (!safeField) {
      throw new Error("fieldName is required!");
    }

    const baseRelativeDir = ["uploads", safeSubPath].filter(Boolean).join("/").replace(/^\/+/, "");
    const basePublicUrl = `${FileUploader.buildOriginFromReq(req)}/${baseRelativeDir}`;

    // (1) If multer already ran, normalize into packets (no re-upload)
    const already = FileUploader.readExistingFilesForField(req, safeField);
    if (already.length > 0) {
      const packets = already.map((f) =>
        FileUploader.toFilePacket({ req, safeSubPath, fieldName: safeField, file: f }),
      );
      return FileUploader.buildUploadResult(baseRelativeDir, basePublicUrl, {
        [safeField]: packets,
      });
    }

    // (2) Run multer ourselves
    const baseDir = FileUploader.buildSafeChildDir(FileUploader.UPLOAD_ROOT, safeSubPath);
    const fieldDir = FileUploader.buildSafeChildDir(baseDir, safeField);

    await FileUploader.ensureDirectory(fieldDir);

    const storage: StorageEngine = multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, fieldDir),
      filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname);
        const base = path.basename(file.originalname, ext);
        const storedName = `${FileUploader.slugify(base)}_${Date.now()}${ext.toLowerCase()}`;
        cb(null, storedName);
      },
    });

    const fileFilter: multer.Options["fileFilter"] = (_req, file, cb): void => {
      const allowed = options?.allowedMimeTypes;
      if (!allowed || allowed.size === 0) {
        cb(null, true);
        return;
      }
      if (allowed.has(file.mimetype)) {
        cb(null, true);
        return;
      }
      cb(new Error(`File type not allowed: ${file.mimetype}`));
    };

    const upload = multer({
      storage,
      limits: {
        fileSize: (options?.maxFileSizeMb ?? 20) * 1024 * 1024,
        files: options?.maxFiles ?? 20,
      },
      fileFilter,
    }).array(safeField);

    const files: Express.Multer.File[] = await new Promise((resolve, reject) => {
      upload(req, {} as any, (err: unknown) => {
        if (err) {
          const msg = err instanceof Error ? err.message : "Unknown upload error";
          reject(new Error(`File upload failed: ${msg}`));
          return;
        }
        resolve(((req.files ?? []) as unknown) as Express.Multer.File[]);
      });
    });

    const packets = files.map((f) =>
      FileUploader.toFilePacket({ req, safeSubPath, fieldName: safeField, file: f }),
    );

    return FileUploader.buildUploadResult(baseRelativeDir, basePublicUrl, {
      [safeField]: packets,
    });
  }

  // ─────────────────────────────────────────────
  // PUBLIC API – UNIVERSAL UPLOAD (MULTI FIELD)
  // ─────────────────────────────────────────────

  /**
   * Universal multi-field upload handler that ALWAYS returns UploadResultPacket.
   *
   * Storage layout:
   *   /public/uploads/<safeSubPath>/<fieldName>/<storedName>
   *
   * Params:
   * - subPath:
   *     Relative path INSIDE uploads root.
   * - fields:
   *     Multer fields descriptor. Example:
   *       [{ name: "attachments", maxCount: 10 }, { name: "documents", maxCount: 5 }]
   * - req:
   *     Express request
   * - options:
   *     allowedMimeTypesByField (optional)
   *     maxFileSizeMb
   *     maxFiles
   *
   * CRITICAL CONTRACT:
   * - output.byField contains ALL declared `fields` keys even if empty
   */
  public static async handleMultiFieldUpload(
    subPath: string,
    fields: Array<{ name: string; maxCount?: number }>,
    req: Request,
    options?: {
      allowedMimeTypesByField?: Record<string, ReadonlySet<string>>;
      maxFileSizeMb?: number;
      maxFiles?: number;
    },
  ): Promise<UploadResultPacket> {
    const safeSubPath = FileUploader.sanitizeSubPath(subPath);
    if (!safeSubPath.trim()) {
      throw new Error("Uploading path is required!");
    }

    const seededByField = FileUploader.seedByFieldKeys(fields);

    const baseRelativeDir = ["uploads", safeSubPath].filter(Boolean).join("/").replace(/^\/+/, "");
    const basePublicUrl = `${FileUploader.buildOriginFromReq(req)}/${baseRelativeDir}`;

    // (1) If middleware already ran, normalize req.files
    const existing = FileUploader.readExistingFilesMulti(req);
    if (Object.keys(existing).length > 0) {
      for (const [rawField, filesArr] of Object.entries(existing)) {
        const field = FileUploader.sanitizeSegmentStrict(rawField);
        if (!field) continue;

        if (!Object.prototype.hasOwnProperty.call(seededByField, field)) {
          seededByField[field] = [];
        }

        const arr = Array.isArray(filesArr) ? filesArr : [];
        seededByField[field] = arr.map((f) =>
          FileUploader.toFilePacket({ req, safeSubPath, fieldName: field, file: f }),
        );
      }

      return FileUploader.buildUploadResult(baseRelativeDir, basePublicUrl, seededByField);
    }

    // (2) Run multer ourselves
    const baseDir = FileUploader.buildSafeChildDir(FileUploader.UPLOAD_ROOT, safeSubPath);
    await FileUploader.ensureDirectory(baseDir);

    const storage: StorageEngine = multer.diskStorage({
      destination: async (_req, file, cb): Promise<void> => {
        try {
          const safeFieldName = FileUploader.sanitizeSegmentStrict(file.fieldname);
          const fieldDir = FileUploader.buildSafeChildDir(baseDir, safeFieldName);
          await FileUploader.ensureDirectory(fieldDir);
          cb(null, fieldDir);
        } catch (error: unknown) {
          cb(error instanceof Error ? error : new Error(String(error)), "");
        }
      },
      filename: (_req, file, cb): void => {
        const ext = path.extname(file.originalname);
        const base = path.basename(file.originalname, ext);
        const storedName = `${FileUploader.slugify(base)}_${Date.now()}${ext.toLowerCase()}`;
        cb(null, storedName);
      },
    });

    const fileFilter: multer.Options["fileFilter"] = (_req, file, cb): void => {
      const byField = options?.allowedMimeTypesByField;

      // If not configured, allow all
      if (!byField || Object.keys(byField).length === 0) {
        cb(null, true);
        return;
      }

      const allow = byField[file.fieldname];
      if (!allow || allow.size === 0) {
        cb(null, true);
        return;
      }

      if (allow.has(file.mimetype)) {
        cb(null, true);
        return;
      }

      cb(new Error(`File type not allowed for field "${file.fieldname}": ${file.mimetype}`));
    };

    const upload = multer({
      storage,
      limits: {
        fileSize: (options?.maxFileSizeMb ?? 20) * 1024 * 1024,
        files: options?.maxFiles ?? 40,
      },
      fileFilter,
    }).fields(fields);

    const filesByField: Record<string, Express.Multer.File[]> = await new Promise(
      (resolve, reject) => {
        upload(req, {} as any, (err: unknown) => {
          if (err) {
            const msg = err instanceof Error ? err.message : "Unknown upload error";
            reject(new Error(`File upload failed: ${msg}`));
            return;
          }
          const uploaded = (req.files as unknown) as Record<string, Express.Multer.File[]> | undefined;
          resolve(uploaded ?? {});
        });
      },
    );

    // Fill seeded arrays (includes empty arrays for missing fields)
    for (const [rawFieldName, filesArr] of Object.entries(filesByField)) {
      const field = FileUploader.sanitizeSegmentStrict(rawFieldName);
      if (!field) continue;

      if (!Object.prototype.hasOwnProperty.call(seededByField, field)) {
        seededByField[field] = [];
      }

      const arr = Array.isArray(filesArr) ? filesArr : [];
      seededByField[field] = arr.map((f) =>
        FileUploader.toFilePacket({ req, safeSubPath, fieldName: field, file: f }),
      );
    }

    return FileUploader.buildUploadResult(baseRelativeDir, basePublicUrl, seededByField);
  }

  // ─────────────────────────────────────────────
  // PUBLIC API – SAVE IMAGE BUFFER (MEMORY -> WEBP)
  // ─────────────────────────────────────────────

  /**
   * Save an in-memory image buffer as WebP under:
   *   /public/uploads/<subPath>/<fieldName>/<storedName>.webp
   *
   * Use when:
   * - You uploaded in memory (multer.memoryStorage)
   * - You want standardized WebP output for UI performance
   *
   * Params:
   * - req:
   *     Used to build publicUrl
   * - subPath:
   *     Relative path inside uploads (NO "uploads/" prefix)
   * - fieldName:
   *     folder name under subPath (e.g. "logo", "photo", "attachments")
   * - originalName:
   *     used to generate a friendly stored name
   * - buffer:
   *     image bytes
   * - webpQuality:
   *     sharp quality (default 80)
   */
  public static async saveSingleWebPFromMemory(options: {
    req: Request;
    subPath: string;
    fieldName: string;
    originalName: string;
    buffer: Buffer;
    webpQuality?: number;
  }): Promise<UploadResultPacket> {
    const safeSubPath = FileUploader.sanitizeSubPath(options.subPath);
    if (!safeSubPath.trim()) throw new Error("Uploading path is required!");

    const fieldName = FileUploader.sanitizeSegmentStrict(options.fieldName);
    if (!fieldName) throw new Error("fieldName is required!");

    const baseRelativeDir = ["uploads", safeSubPath].filter(Boolean).join("/").replace(/^\/+/, "");
    const basePublicUrl = `${FileUploader.buildOriginFromReq(options.req)}/${baseRelativeDir}`;

    const baseDir = FileUploader.buildSafeChildDir(FileUploader.UPLOAD_ROOT, safeSubPath);
    const fieldDir = FileUploader.buildSafeChildDir(baseDir, fieldName);
    await FileUploader.ensureDirectory(fieldDir);

    const quality = typeof options.webpQuality === "number" ? options.webpQuality : 80;

    const rawBase = path.basename(
      String(options.originalName ?? "image"),
      path.extname(String(options.originalName ?? "image")),
    );

    const storedName = `${FileUploader.slugify(rawBase)}_${Date.now()}.webp`;
    const absDiskPath = path.join(fieldDir, storedName);

    await sharp(options.buffer).webp({ quality }).toFile(absDiskPath);

    const relativePath = ["uploads", safeSubPath, fieldName, storedName]
      .filter(Boolean)
      .join("/")
      .replace(/^\/+/, "");

    const publicUrl = `${FileUploader.buildOriginFromReq(options.req)}/${relativePath}`;
    const stat = await fse.stat(absDiskPath);

    const packet: FileMetaPacket = FileUploader.packPacket({
      originalName: String(options.originalName ?? "").trim() || storedName,
      storedName,
      extension: "webp",
      mimeType: "image/webp",
      sizeBytes: stat.size,
      relativePath,
      publicUrl,
      absDiskPath,
      fieldName,
      uploadedAtIso: new Date().toISOString(),
    });

    return FileUploader.buildUploadResult(baseRelativeDir, basePublicUrl, {
      [fieldName]: [packet],
    });
  }

  // ─────────────────────────────────────────────
  // PUBLIC API – SAFE LOCAL FILESYSTEM CRUD
  // ─────────────────────────────────────────────

  /**
   * Write / overwrite a file under /public/uploads/<relativeUnderUploads>.
   *
   * Params:
   * - relativeUnderUploads:
   *     MUST be public-relative and MUST start with "uploads/"
   *     Example:
   *       "uploads/comments/Teams/X/attachments/a.png"
   *
   * - data:
   *     Buffer or string
   *
   * Returns:
   * - relativePath:
   *     public-relative path stored (unix)
   */
  public static async writeFileToUploads(options: {
    relativeUnderUploads: string;
    data: Buffer | string;
    encoding?: BufferEncoding;
  }): Promise<{ relativePath: string }> {
    const safeRel = FileUploader.sanitizePublicRelativePath(options.relativeUnderUploads);

    if (!safeRel.startsWith("uploads/")) {
      throw new Error('writeFileToUploads requires a path under "uploads/".');
    }

    const abs = FileUploader.buildSafeChildPath(FileUploader.PUBLIC_ROOT, safeRel);
    await FileUploader.ensureDirectory(path.dirname(abs));

    if (typeof options.data === "string") {
      await fs.promises.writeFile(abs, options.data, options.encoding ?? "utf8");
    } else {
      await fs.promises.writeFile(abs, options.data);
    }

    return { relativePath: safeRel };
  }

  /**
   * Read a file from /public/uploads or /public/recyclebin safely.
   *
   * Params:
   * - relativePathUnderPublic:
   *     public-relative file path
   *     MUST start with "uploads/" OR "recyclebin/"
   */
  public static async readPublicFile(relativePathUnderPublic: string): Promise<Buffer> {
    const safeRel = FileUploader.sanitizePublicRelativePath(relativePathUnderPublic);

    if (!safeRel.startsWith("uploads/") && !safeRel.startsWith("recyclebin/")) {
      throw new Error('readPublicFile only allows "uploads/" or "recyclebin/".');
    }

    const abs = FileUploader.buildSafeChildPath(FileUploader.PUBLIC_ROOT, safeRel);
    return fs.promises.readFile(abs);
  }

  /**
   * Copy file(s) inside /public (uploads <-> recyclebin).
   *
   * Params:
   * - sources:
   *     public-relative paths. Each must start with "uploads/" or "recyclebin/"
   * - destinationDir:
   *     public-relative directory under "uploads/" or "recyclebin/"
   * - overwrite:
   *     default false
   */
  public static async copyPublicFiles(options: {
    sources: string[];
    destinationDir: string;
    overwrite?: boolean;
  }): Promise<FsCopyResult> {
    const overwrite = options.overwrite === true;

    const dstDirRel = FileUploader.sanitizePublicRelativePath(options.destinationDir);
    if (!dstDirRel.startsWith("uploads/") && !dstDirRel.startsWith("recyclebin/")) {
      throw new Error('copyPublicFiles destination must be under "uploads/" or "recyclebin/".');
    }

    const dstDirAbs = FileUploader.buildSafeChildPath(FileUploader.PUBLIC_ROOT, dstDirRel);
    await FileUploader.ensureDirectory(dstDirAbs);

    const copied: string[] = [];
    const skipped: string[] = [];

    for (const srcRelRaw of options.sources ?? []) {
      const srcRel = FileUploader.sanitizePublicRelativePath(srcRelRaw);

      if (!srcRel.startsWith("uploads/") && !srcRel.startsWith("recyclebin/")) {
        skipped.push(srcRelRaw);
        continue;
      }

      const srcAbs = FileUploader.buildSafeChildPath(FileUploader.PUBLIC_ROOT, srcRel);
      if (!fs.existsSync(srcAbs)) {
        skipped.push(srcRel);
        continue;
      }

      const fileName = path.basename(srcAbs);
      const dstAbs = path.join(dstDirAbs, fileName);

      await fse.copy(srcAbs, dstAbs, { overwrite });

      copied.push(path.relative(FileUploader.PUBLIC_ROOT, dstAbs).replace(/\\/g, "/"));
    }

    return { copied, skipped };
  }

  /**
   * Move file(s) inside /public (uploads <-> recyclebin).
   *
   * Params:
   * - sources:
   *     public-relative paths. Each must start with "uploads/" or "recyclebin/"
   * - destinationDir:
   *     public-relative directory under "uploads/" or "recyclebin/"
   * - overwrite:
   *     default false
   */
  public static async movePublicFiles(options: {
    sources: string[];
    destinationDir: string;
    overwrite?: boolean;
  }): Promise<FsMoveResult> {
    const overwrite = options.overwrite === true;

    const dstDirRel = FileUploader.sanitizePublicRelativePath(options.destinationDir);
    if (!dstDirRel.startsWith("uploads/") && !dstDirRel.startsWith("recyclebin/")) {
      throw new Error('movePublicFiles destination must be under "uploads/" or "recyclebin/".');
    }

    const dstDirAbs = FileUploader.buildSafeChildPath(FileUploader.PUBLIC_ROOT, dstDirRel);
    await FileUploader.ensureDirectory(dstDirAbs);

    const moved: string[] = [];
    const skipped: string[] = [];

    for (const srcRelRaw of options.sources ?? []) {
      const srcRel = FileUploader.sanitizePublicRelativePath(srcRelRaw);

      if (!srcRel.startsWith("uploads/") && !srcRel.startsWith("recyclebin/")) {
        skipped.push(srcRelRaw);
        continue;
      }

      const srcAbs = FileUploader.buildSafeChildPath(FileUploader.PUBLIC_ROOT, srcRel);
      if (!fs.existsSync(srcAbs)) {
        skipped.push(srcRel);
        continue;
      }

      const fileName = path.basename(srcAbs);
      const dstAbs = path.join(dstDirAbs, fileName);

      await fse.move(srcAbs, dstAbs, { overwrite });

      moved.push(path.relative(FileUploader.PUBLIC_ROOT, dstAbs).replace(/\\/g, "/"));
    }

    return { moved, skipped };
  }

  // ─────────────────────────────────────────────
  // PUBLIC API – RECYCLE BIN (MIRROR TREE DESIGN)
  // ─────────────────────────────────────────────

  /**
   * Soft-delete by moving from uploads/ -> recyclebin/<category>/<refId>/...
   *
   * ⭐ NEW DESIGN:
   * - Caller passes file(s) or folder(s) paths (public-relative).
   * - We preserve the SAME relative path under recyclebin bucket.
   *
   * Why this is better:
   * - Parent code stays simple:
   *     "move this folder" OR "move these files"
   * - Restore is trivial (mirror tree back)
   * - Works for ANY module (comments, properties, leases, etc.)
   *
   * Params:
   * - category:
   *     Logical bucket name for recycle bin grouping.
   *     Example: "comments", "properties", "leases"
   *     (Sanitized strictly)
   *
   * - refId:
   *     Reference id for the entity being deleted.
   *     Example: comment.commentId, property.propertyId
   *
   * - items:
   *     Accepts:
   *       - single string
   *       - string[]
   *       - MoveItem[]
   *
   *     Each input path should usually be:
   *       "uploads/...."
   *
   *     If an absolute path is passed accidentally:
   *       "D:\...\public\uploads\..."
   *     we convert it to public-relative if inside PUBLIC_ROOT.
   *
   * Safety rules:
   * - Only moves paths that (after normalization) start with "uploads/"
   * - All targets go under recyclebin/<category>/<refId>/
   * - No traversal outside /public is possible
   */
  public static async moveToRecycleBin(
    category: string,
    refId: string,
    items: MoveItem | MoveItem[],
  ): Promise<FsMoveResult> {
    const safeCategory = FileUploader.sanitizeSegmentStrict(category);
    const safeRefId = FileUploader.sanitizeSegmentStrict(refId);

    if (!safeCategory || !safeRefId) {
      throw new Error("Category and reference ID are required for recycle bin operations");
    }

    const list: MoveItem[] = Array.isArray(items) ? items : [items];

    // recyclebin/<category>/<refId>/
    const recycleBaseRel = FileUploader.sanitizePublicRelativePath(
      path.posix.join("recyclebin", safeCategory, safeRefId),
    );

    const recycleBaseAbs = FileUploader.buildSafeChildPath(FileUploader.PUBLIC_ROOT, recycleBaseRel);
    await FileUploader.ensureDirectory(recycleBaseAbs);

    const moved: string[] = [];
    const skipped: string[] = [];

    for (const it of list) {
      try {
        const rawPath = typeof it === "string" ? it : it.path;
        const hintedKind: MoveKind | null = typeof it === "string" ? null : (it.kind ?? null);

        const trimmed = String(rawPath ?? "").trim();
        if (!trimmed) {
          skipped.push(String(rawPath ?? ""));
          continue;
        }

        // (1) Convert abs -> public-relative if needed
        const relCandidate = FileUploader.toPublicRelativeIfAbs(trimmed);

        // (2) Sanitize to prevent traversal and normalize slashes
        const rel = FileUploader.sanitizePublicRelativePath(relCandidate);

        // (3) Only allow moving from uploads namespace
        if (!rel.startsWith("uploads/")) {
          skipped.push(trimmed);
          continue;
        }

        // (4) Build absolute source safely
        const absSource = FileUploader.buildSafeChildPath(FileUploader.PUBLIC_ROOT, rel);

        if (!fs.existsSync(absSource)) {
          skipped.push(rel);
          continue;
        }

        // (5) Determine whether source is file or directory (system mechanism)
        const kind = hintedKind ?? FileUploader.detectKind(absSource);
        if (!kind) {
          skipped.push(rel);
          continue;
        }

        // (6) Target = recycle base + SAME relative path (mirror tree)
        const absTarget = path.join(recycleBaseAbs, rel);

        // Ensure parent exists
        await FileUploader.ensureDirectory(path.dirname(absTarget));

        // Collision protection: if target exists, suffix
        const finalAbsTarget = fs.existsSync(absTarget)
          ? FileUploader.withCollisionSuffix(absTarget)
          : absTarget;

        await fse.move(absSource, finalAbsTarget, { overwrite: true });

        moved.push(path.relative(FileUploader.PUBLIC_ROOT, finalAbsTarget).replace(/\\/g, "/"));
      } catch (err: unknown) {
        console.warn("[Warning:] [FileUploader] moveToRecycleBin failed.\n", err, "\n");
        skipped.push(typeof it === "string" ? it : it.path);
      }
    }

    return { moved, skipped };
  }

  /**
   * Restore from recycle bin back to original public location.
   *
   * Mirror logic:
   * - For each input:
   *     recyclebin/<category>/<refId>/<REL>
   *   we strip:
   *     recyclebin/<category>/<refId>/
   *   and move to:
   *     <REL>
   *
   * This works because moveToRecycleBin preserved the original tree.
   *
   * Params:
   * - recycleRelativePathsOrDirs:
   *     public-relative paths starting with "recyclebin/"
   *
   * Returns:
   * - moved:
   *     final public-relative path after restore (usually under uploads/)
   */
  public static async restoreFromRecycleBin(
    recycleRelativePathsOrDirs: string | string[],
  ): Promise<FsMoveResult> {
    const list = Array.isArray(recycleRelativePathsOrDirs)
      ? recycleRelativePathsOrDirs
      : [recycleRelativePathsOrDirs];

    const moved: string[] = [];
    const skipped: string[] = [];

    for (const raw of list) {
      try {
        const rel = FileUploader.sanitizePublicRelativePath(raw);

        if (!rel.startsWith("recyclebin/")) {
          skipped.push(raw);
          continue;
        }

        const absSource = FileUploader.buildSafeChildPath(FileUploader.PUBLIC_ROOT, rel);
        if (!fs.existsSync(absSource)) {
          skipped.push(rel);
          continue;
        }

        // We want to remove: recyclebin/<category>/<refId>/
        // Split by "/" and drop first 3 segments:
        //   [ "recyclebin", "<category>", "<refId>", ...rest ]
        const parts = rel.split("/").filter(Boolean);
        if (parts.length < 4) {
          skipped.push(rel);
          continue;
        }

        const rest = parts.slice(3).join("/"); // original tree starting from "uploads/..."
        if (!rest) {
          skipped.push(rel);
          continue;
        }

        const absTarget = FileUploader.buildSafeChildPath(FileUploader.PUBLIC_ROOT, rest);
        await FileUploader.ensureDirectory(path.dirname(absTarget));

        const finalAbsTarget = fs.existsSync(absTarget)
          ? FileUploader.withCollisionSuffix(absTarget)
          : absTarget;

        await fse.move(absSource, finalAbsTarget, { overwrite: true });

        moved.push(path.relative(FileUploader.PUBLIC_ROOT, finalAbsTarget).replace(/\\/g, "/"));
      } catch (err: unknown) {
        console.warn("[Warning:] [FileUploader] restoreFromRecycleBin failed.\n", err, "\n");
        skipped.push(raw);
      }
    }

    return { moved, skipped };
  }

  /**
   * Permanently delete from recyclebin (hard delete).
   *
   * Params:
   * - recycleRelativePathsOrDirs:
   *     public-relative paths starting with "recyclebin/"
   *
   * Return:
   * - deleted:
   *     which items were removed
   */
  public static async deleteFromRecycleBin(
    recycleRelativePathsOrDirs: string | string[],
  ): Promise<FsDeleteResult> {
    const list = Array.isArray(recycleRelativePathsOrDirs)
      ? recycleRelativePathsOrDirs
      : [recycleRelativePathsOrDirs];

    const deleted: string[] = [];
    const skipped: string[] = [];

    for (const raw of list) {
      try {
        const rel = FileUploader.sanitizePublicRelativePath(raw);

        if (!rel.startsWith("recyclebin/")) {
          skipped.push(raw);
          continue;
        }

        const absTarget = FileUploader.buildSafeChildPath(FileUploader.PUBLIC_ROOT, rel);
        if (!fs.existsSync(absTarget)) {
          skipped.push(rel);
          continue;
        }

        const st = fs.statSync(absTarget);
        if (st.isDirectory()) {
          await fse.remove(absTarget);
        } else {
          await fse.unlink(absTarget);
        }

        deleted.push(rel);
      } catch (err: unknown) {
        console.warn("[Warning:] [FileUploader] deleteFromRecycleBin failed.\n", err, "\n");
        skipped.push(raw);
      }
    }

    return { deleted, skipped };
  }

  // ─────────────────────────────────────────────
  // PRIVATE HELPERS – PATH SAFETY & UTILITIES
  // ─────────────────────────────────────────────

  /**
   * Normalize + validate a Multer disk destination.
   *
   * Allowed inputs:
   * - Relative: "comments/temp"  => anchored under /public/uploads
   * - Absolute: "D:\...\public\uploads\comments\temp" (must stay inside UPLOAD_ROOT)
   */
  private static normalizeAndValidateDiskDestination(destination: string): string {
    const raw = String(destination ?? "").trim();
    if (!raw) throw new Error("Upload destination is empty.");

    // Recommended: relative
    if (!path.isAbsolute(raw)) {
      const safeSubPath = FileUploader.sanitizeSubPath(raw);
      return FileUploader.buildSafeChildDir(FileUploader.UPLOAD_ROOT, safeSubPath);
    }

    // Absolute must be inside UPLOAD_ROOT
    const abs = path.resolve(raw);
    const base = path.resolve(FileUploader.UPLOAD_ROOT);

    if (abs !== base && !abs.startsWith(base + path.sep)) {
      throw new Error("Unsafe upload destination detected.");
    }

    return abs;
  }

  private static async ensureDirectory(targetDir: string): Promise<void> {
    await fse.ensureDir(targetDir);
  }

  /**
   * Sanitize a sub-path that will be anchored under uploads root.
   *
   * Example:
   *   "comments/Teams/..//X" => "comments/Teams/X"
   */
  private static sanitizeSubPath(subPath: string): string {
    const normalized = String(subPath ?? "").replace(/\\/g, "/").trim();

    const parts = normalized
      .split("/")
      .filter((p) => p && p !== "." && p !== "..")
      .map((seg) => FileUploader.sanitizeSegmentStrict(seg))
      .filter(Boolean);

    return parts.join("/");
  }

  /**
   * Sanitize a public-relative path under /public.
   *
   * IMPORTANT:
   * - This does NOT enforce "uploads/" or "recyclebin/" prefix.
   *   Caller method must enforce allowed namespaces.
   */
  private static sanitizePublicRelativePath(relative: string): string {
    const normalized = String(relative ?? "").replace(/\\/g, "/").trim();
    const noLead = normalized.replace(/^\/+/, "");

    const parts = noLead
      .split("/")
      .filter((p) => p && p !== "." && p !== "..")
      .map((seg) => FileUploader.sanitizeSegmentLoose(seg))
      .filter(Boolean);

    return parts.join("/");
  }

  /**
   * Strict sanitizer for:
   * - ids
   * - field names
   * - category buckets
   */
  private static sanitizeSegmentStrict(segment: string): string {
    const trimmed = String(segment ?? "").trim();
    if (!trimmed) return "";
    return trimmed.replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  /**
   * Loose sanitizer for filenames / path parts.
   * - Allows dots, etc.
   * - Removes slashes to prevent nesting injection.
   */
  private static sanitizeSegmentLoose(segment: string): string {
    const trimmed = String(segment ?? "").trim();
    if (!trimmed) return "";
    return trimmed.replace(/[\/\\]/g, "_");
  }

  /**
   * Safe directory join:
   * Ensures resolved target stays inside base.
   */
  private static buildSafeChildDir(base: string, child: string): string {
    const baseResolved = path.resolve(base);
    const target = path.resolve(base, child);

    if (!target.startsWith(baseResolved + path.sep) && target !== baseResolved) {
      throw new Error("Unsafe directory path detected");
    }

    return target;
  }

  /**
   * Safe file join:
   * Ensures resolved target stays inside base.
   */
  private static buildSafeChildPath(base: string, relative: string): string {
    const baseResolved = path.resolve(base);
    const target = path.resolve(base, relative);

    if (!target.startsWith(baseResolved + path.sep) && target !== baseResolved) {
      throw new Error("Unsafe file path detected");
    }

    return target;
  }

  /**
   * Slugify a filename base.
   * Used for stored disk filenames.
   */
  private static slugify(input: string): string {
    const safe = String(input ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");

    return safe || "file";
  }

  private static getFirstHeaderValue(req: Request, name: string): string {
    const v = req.headers[name.toLowerCase()];
    if (typeof v === "string") return v;
    if (Array.isArray(v) && typeof v[0] === "string") return v[0];
    return "";
  }

  private static firstCsvToken(raw: string): string {
    const token = String(raw ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .at(0);

    return token ?? "";
  }

  /**
   * Build request origin:
   * - supports reverse proxy headers (x-forwarded-proto/host)
   */
  private static buildOriginFromReq(req: Request): string {
    const protoRaw = FileUploader.getFirstHeaderValue(req, "x-forwarded-proto");
    const forwardedProto = FileUploader.firstCsvToken(protoRaw);
    const protocol = forwardedProto ? forwardedProto : req.protocol;

    const hostRaw = FileUploader.getFirstHeaderValue(req, "x-forwarded-host");
    const forwardedHost = FileUploader.firstCsvToken(hostRaw);

    const hostFallback = (req.get("host") ?? "").trim();
    const hostHeader = forwardedHost ? forwardedHost : hostFallback;

    if (!hostHeader) {
      throw new Error("Unable to determine request host.");
    }

    return `${protocol}://${hostHeader}`;
  }

  /**
   * Convert Multer file -> FileMetaPacket (unified contract).
   *
   * IMPORTANT:
   * - relativePath is stored as public-relative path (no leading slash)
   * - publicUrl is built using request origin
   * - absDiskPath is internal (do NOT store in DB; store relativePath)
   */
  private static toFilePacket(args: {
    req: Request;
    safeSubPath: string;
    fieldName: string;
    file: Express.Multer.File;
  }): FileMetaPacket {
    const { req, safeSubPath, fieldName, file } = args;

    const storedName = String(file.filename ?? "").trim();
    const originalName = String(file.originalname ?? "").trim() || storedName;

    const extension = path.extname(storedName).replace(".", "");
    const mimeType = String(file.mimetype ?? "application/octet-stream").trim();

    const sizeBytesNum = Number(file.size);
    const sizeBytes =
      Number.isFinite(sizeBytesNum) && sizeBytesNum >= 0 ? Math.floor(sizeBytesNum) : 0;

    const safeField = FileUploader.sanitizeSegmentStrict(fieldName);

    // uploads/<safeSubPath>/<safeField>/<storedName>
    const relativePath = ["uploads", safeSubPath, safeField, storedName]
      .filter(Boolean)
      .join("/")
      .replace(/^\/+/, "");

    const origin = FileUploader.buildOriginFromReq(req);
    const publicUrl = `${origin}/${relativePath}`;

    const absDiskPath = path.resolve(FileUploader.PUBLIC_ROOT, relativePath);

    const uploadedAtIso = new Date().toISOString();

    const out = FileUploader.packPacket({
      originalName,
      storedName,
      extension,
      mimeType,
      sizeBytes,
      relativePath,
      publicUrl,
      absDiskPath,
      fieldName: safeField,
      uploadedAtIso,
    });

    const encoding = typeof file.encoding === "string" ? file.encoding.trim() : "";
    if (encoding) {
      (out as unknown as { encoding: string }).encoding = encoding;
    }

    return out;
  }

  /**
   * Centralized upload result builder.
   * Calculates totals correctly.
   */
  private static buildUploadResult(
    baseRelativeDir: string,
    basePublicUrl: string,
    byField: Record<string, FileMetaPacket[]>,
  ): UploadResultPacket {
    let totalFiles = 0;
    let totalBytes = 0;

    for (const files of Object.values(byField)) {
      const arr = Array.isArray(files) ? files : [];
      totalFiles += arr.length;

      for (const f of arr) {
        const n = Number((f as unknown as { sizeBytes?: unknown }).sizeBytes);
        if (Number.isFinite(n) && n >= 0) totalBytes += Math.floor(n);
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
   * Seed declared multi-field keys with empty arrays.
   * This ensures consumers can do:
   *   result.byField["attachments"].length
   * without checking undefined.
   */
  private static seedByFieldKeys(fields: Array<{ name: string }>): Record<string, FileMetaPacket[]> {
    const out: Record<string, FileMetaPacket[]> = {};
    for (const f of fields) {
      const name = FileUploader.sanitizeSegmentStrict(f?.name ?? "");
      if (!name) continue;
      out[name] = [];
    }
    return out;
  }

  /**
   * Double-run protection helper:
   * Reads existing req.files for single field safely.
   */
  private static readExistingFilesForField(req: Request, fieldName: string): Express.Multer.File[] {
    const filesAny = (req.files as unknown) as
      | Express.Multer.File[]
      | Record<string, Express.Multer.File[]>
      | undefined;

    if (!filesAny) return [];

    // array() shape
    if (Array.isArray(filesAny)) {
      return filesAny.filter((f) => String(f.fieldname ?? "") === fieldName);
    }

    // fields() shape
    const hit = filesAny[fieldName];
    return Array.isArray(hit) ? hit : [];
  }

  /**
   * Double-run protection helper:
   * Reads multi-field req.files safely.
   */
  private static readExistingFilesMulti(req: Request): Record<string, Express.Multer.File[]> {
    const filesAny = (req.files as unknown) as
      | Express.Multer.File[]
      | Record<string, Express.Multer.File[]>
      | undefined;

    if (!filesAny) return {};

    // If someone used array() middleware, convert into a map
    if (Array.isArray(filesAny)) {
      const out: Record<string, Express.Multer.File[]> = {};
      for (const f of filesAny) {
        const key = FileUploader.sanitizeSegmentStrict(f.fieldname ?? "");
        if (!key) continue;
        if (!out[key]) out[key] = [];
        out[key].push(f);
      }
      return out;
    }

    return filesAny;
  }

  /**
   * Pack into FileMetaPacket without assuming optional fields exist in your interface.
   * Keeps compatibility stable across FE/BE shared contract versions.
   */
  private static packPacket(base: {
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
  }): FileMetaPacket {
    return base as unknown as FileMetaPacket;
  }

  /**
   * Detect whether a filesystem path is file or directory.
   * Returns null if unknown/special type.
   */
  private static detectKind(absSource: string): MoveKind | null {
    try {
      const st = fs.statSync(absSource);
      if (st.isDirectory()) return "dir";
      if (st.isFile()) return "file";
      return null;
    } catch {
      return null;
    }
  }

  /**
   * If a target already exists, suffix with timestamp to avoid collisions.
   * Works for both file and directory paths.
   */
  private static withCollisionSuffix(absTarget: string): string {
    const stamp = Date.now();
    const ext = path.extname(absTarget);

    if (ext) {
      const base = absTarget.slice(0, -ext.length);
      return `${base}__${stamp}${ext}`;
    }

    return `${absTarget}__${stamp}`;
  }

  /**
   * Converts absolute path -> public-relative if (and only if) it is inside PUBLIC_ROOT.
   *
   * Example:
   *  abs: D:\...\public\uploads\comments\a\b
   *  rel: uploads/comments/a/b
   *
   * If abs is outside PUBLIC_ROOT:
   *  returns "__outside_public_root__" (will be rejected by caller guards)
   */
  private static toPublicRelativeIfAbs(relOrAbs: string): string {
    const raw = String(relOrAbs ?? "").trim();
    if (!raw) return "";

    if (path.isAbsolute(raw)) {
      const publicRootAbs = path.resolve(FileUploader.PUBLIC_ROOT);
      const abs = path.resolve(raw);

      const rel = path.relative(publicRootAbs, abs).replace(/\\/g, "/");
      if (rel.startsWith("..")) return "__outside_public_root__";

      return rel.replace(/^\/+/, "");
    }

    return raw.replace(/^\/+/, "");
  }
}
