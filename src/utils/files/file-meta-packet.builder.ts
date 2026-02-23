// Path: src/utils/files/file-meta-packet.builder.ts
// =============================================================================
// FileMetaPacketBuilder (Infrastructure Helper)
// -----------------------------------------------------------------------------
// RULES (PropEase)
// - Caller may pass roots as: "public/...", "uploads/...", "/recyclebin/..."
// - All methods MUST: normalize -> validate -> then do FS operations
// - Canonical internal form: "uploads/..." OR "recyclebin/..." (NO leading "/")
// - All abs paths MUST resolve under "<cwd>/public"
// - exactOptionalPropertyTypes-safe: NEVER pass { req: undefined }
// - 100% class-based
// =============================================================================

import type { Request } from "express";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";

import type { FileMetaPacket, ISODateString } from "../../types/common";

export class FileMetaPacketBuilder {
  // ===========================================================================
  // 01) Normalizers / Validators (Public path guard merged here)
  // ===========================================================================

  /** Validate single segment (no slashes). */
  public static isSafeSegment(seg: string): boolean {
    const s = String(seg ?? "").trim();
    return /^[a-zA-Z0-9._-]+$/.test(s);
  }

  /**
   * Convert any input path into stable POSIX-like RELATIVE format:
   * - "\" -> "/"
   * - trims whitespace
   * - strips leading "/" so it cannot be absolute
   */
  public static toPosixRel(input: string): string {
    const s = String(input ?? "").replace(/\\/g, "/").trim();
    return s.replace(/^\/+/, "");
  }

  /**
   * Normalize any caller-provided "root" or "path" into CANONICAL publicRel:
   *   "uploads/..." OR "recyclebin/..."
   *
   * Accepts:
   * - "public/uploads/.."
   * - "uploads/.."
   * - "public/recyclebin/.."
   * - "recyclebin/.."
   * - "/uploads/.." or "/recyclebin/.."
   *
   * Returns "" if invalid.
   */
  public static normalizeToPublicRel(input: string): string {
    const raw = this.toPosixRel(input);
    if (!raw) return "";

    // Remove leading "./"
    const noDot = raw.replace(/^\.\//, "");

    // Strip a mistaken "public/" prefix (caller may send it)
    const withoutPublic = noDot.toLowerCase().startsWith("public/")
      ? noDot.slice("public/".length)
      : noDot;

    const lc = withoutPublic.toLowerCase();

    // Must be rooted under uploads/ or recyclebin/
    const isUploadsRoot = lc === "uploads" || lc.startsWith("uploads/");
    const isRecycleRoot = lc === "recyclebin" || lc.startsWith("recyclebin/");

    if (!isUploadsRoot && !isRecycleRoot) return "";

    // Disallow traversal or null bytes
    if (withoutPublic.includes("..") || withoutPublic.includes("\0")) return "";

    // Segment-level hard checks (defense-in-depth)
    const parts = withoutPublic.split("/").filter(Boolean);
    for (const p of parts) {
      if (p === "." || p === "..") return "";
    }

    // Canonical: no trailing slash normalization needed, but keep stable
    return withoutPublic.replace(/\/+$/, "");
  }

  /**
   * Assert that input path is a valid public-rooted path.
   * Throws with a clear message.
   */
  public static assertPublicRel(input: string, label: string): void {
    const rel = this.normalizeToPublicRel(input);
    if (!rel) {
      throw new Error(
        `Invalid ${label}: must be under "uploads/" or "recyclebin/". Got: ${this.toPosixRel(input)}`
      );
    }
  }

  /**
   * Convert canonical publicRel (uploads/... | recyclebin/...) to absolute disk path:
   *   <cwd>/public/<publicRel>
   *
   * Also defends that the resolved path remains inside "<cwd>/public".
   */
  public static absFromPublicRel(input: string): string {
    const publicRel = this.normalizeToPublicRel(input);
    this.assertPublicRel(publicRel, "publicRel");

    const publicRoot = path.resolve(process.cwd(), "public");
    const abs = path.resolve(publicRoot, publicRel);

    // Ensure abs stays under publicRoot
    const rootWithSep = publicRoot.endsWith(path.sep) ? publicRoot : publicRoot + path.sep;
    const absWithSep = abs.endsWith(path.sep) ? abs : abs + path.sep;

    if (!absWithSep.startsWith(rootWithSep)) {
      throw new Error(`Invalid publicRel: resolved outside public root: ${publicRel}`);
    }

    return abs;
  }

  /**
   * Check existence under public root.
   * - kind: "file" | "dir" | "any"
   */
  public static existsInPublic(options: {
    pathLike: string;
    kind?: "file" | "dir" | "any";
  }): { exists: boolean; publicRel: string; absDiskPath: string } {
    const publicRel = this.normalizeToPublicRel(options.pathLike);
    this.assertPublicRel(publicRel, "pathLike");

    const absDiskPath = this.absFromPublicRel(publicRel);
    if (!fs.existsSync(absDiskPath)) {
      return { exists: false, publicRel, absDiskPath };
    }

    const kind = options.kind ?? "any";
    if (kind === "any") return { exists: true, publicRel, absDiskPath };

    const st = fs.statSync(absDiskPath);
    if (kind === "file") return { exists: st.isFile(), publicRel, absDiskPath };
    return { exists: st.isDirectory(), publicRel, absDiskPath };
  }

  /**
   * Build a URL PATH for a canonical publicRel.
   * Default mapping assumes Express serves /public folder as "/" (recommended).
   *
   * If your server serves it as "/public", change to:
   *   return `/public/${publicRel}`;
   */
  public static buildPublicUrlPath(input: string): string {
    const publicRel = this.normalizeToPublicRel(input);
    this.assertPublicRel(publicRel, "publicRel");
    return `/${publicRel}`;
  }

  // ===========================================================================
  // 02) Origin builder (proxy-safe absolute URL builder)
  // ===========================================================================

  public static buildOriginFromReq(req: Request): string {
    const xfp = this.firstCsvToken(this.getHeader(req, "x-forwarded-proto"));
    const protocol = xfp ? xfp : req.protocol;

    const xfh = this.firstCsvToken(this.getHeader(req, "x-forwarded-host"));
    const host = xfh ? xfh : (req.get("host") ?? "").trim();

    if (!host) throw new Error("Unable to determine request host.");
    return `${protocol}://${host}`;
  }

  private static getHeader(req: Request, name: string): string {
    const v = req.headers[name.toLowerCase()];
    if (typeof v === "string") return v;
    if (Array.isArray(v) && typeof v[0] === "string") return v[0];
    return "";
  }

  private static firstCsvToken(raw: string): string {
    const token = String(raw ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)[0];
    return token ?? "";
  }

  // ===========================================================================
  // 03) MIME guessing (extension -> mimeType)
  // ===========================================================================

  public static guessMimeType(extNoDot: string): string {
    const ext = String(extNoDot ?? "").toLowerCase().replace(".", "");

    if (ext === "webp") return "image/webp";
    if (ext === "png") return "image/png";
    if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
    if (ext === "pdf") return "application/pdf";

    if (ext === "docx") {
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    }
    if (ext === "xlsx") {
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    }

    return "application/octet-stream";
  }

  private static safeExtensionFromName(name: string): string {
    const ext = path.extname(name || "").replace(/^\./, "").trim();
    return ext || "bin";
  }

  // ===========================================================================
  // 04) Build ONE packet (existing file under public/)
  // ===========================================================================

  /**
   * Build a FileMetaPacket if the file exists.
   *
   * @param options.pathLike
   * - Accepts: "public/uploads/..", "uploads/..", "/recyclebin/..", "recyclebin/.."
   */
  public static async buildIfExists(options: {
    pathLike: string;
    bucket: string;
    originalName?: string;
    req?: Request;
  }): Promise<FileMetaPacket | null> {
    const publicRel = this.normalizeToPublicRel(options.pathLike);
    if (!publicRel) return null;

    const abs = this.absFromPublicRel(publicRel);
    if (!fs.existsSync(abs)) return null;

    const st = await fsp.stat(abs).catch(() => null);
    if (!st || !st.isFile()) return null;

    const storedName = path.basename(abs);
    const originalName = String(options.originalName ?? "").trim() || storedName;

    const ext = path.extname(originalName).replace(".", "").toLowerCase();
    const mimeType = this.guessMimeType(ext);

    const urlPath = this.buildPublicUrlPath(publicRel);
    const publicUrl = options.req
      ? `${this.buildOriginFromReq(options.req)}${urlPath}`
      : urlPath;

    const bucket = String(options.bucket ?? "").trim() || "file";

    const packet: FileMetaPacket = {
      originalName,
      storedName,

      extension: ext || "bin",
      mimeType,
      sizeBytes: st.size,

      // ✅ canonical stored path (NO "public/")
      relativePath: publicRel,
      publicUrl,
      absDiskPath: abs,

      fieldName: bucket,
      uploadedAtIso: st.mtime.toISOString() as ISODateString,
    };

    return packet;
  }

  // ===========================================================================
  // 04B) Build ONE packet from an existing public relative path (STRICT)
  // ===========================================================================

  /**
   * Strict builder: throws if invalid or not found.
   * Accepts: "public/..", "uploads/..", "/recyclebin/.."
   */
  public static async fromExistingPublicRelativePath(
    pathLike: string,
    input?: {
      fieldName?: string;
      originalName?: string;
      storedName?: string;
      mimeType?: string;
      extension?: string;
      publicUrl?: string;
      encoding?: string;
      checksumSha256?: string;
      uploadedAtIso?: ISODateString;
      req?: Request; // optional for absolute publicUrl (omit if undefined)
    }
  ): Promise<FileMetaPacket> {
    const publicRel = this.normalizeToPublicRel(pathLike);
    if (!publicRel) {
      throw new Error(`Invalid public path: ${String(pathLike)}`);
    }

    const absDiskPath = this.absFromPublicRel(publicRel);

    const st = await fsp.stat(absDiskPath).catch(() => null);
    if (!st || !st.isFile()) {
      throw new Error(`Not a file: ${publicRel}`);
    }

    const storedName =
      input?.storedName && input.storedName.trim()
        ? input.storedName.trim()
        : path.basename(absDiskPath);

    const originalName =
      input?.originalName && input.originalName.trim()
        ? input.originalName.trim()
        : storedName;

    const extension =
      input?.extension && input.extension.trim()
        ? input.extension.trim().replace(/^\./, "")
        : this.safeExtensionFromName(storedName);

    const mimeType =
      input?.mimeType && input.mimeType.trim()
        ? input.mimeType.trim()
        : this.guessMimeType(extension);

    // Build publicUrl:
    // - if input.publicUrl given -> use it
    // - else if req given -> absolute URL
    // - else -> relative URL path
    const urlPath = this.buildPublicUrlPath(publicRel);
    const publicUrl =
      input?.publicUrl && input.publicUrl.trim()
        ? input.publicUrl.trim()
        : input?.req
          ? `${this.buildOriginFromReq(input.req)}${urlPath}`
          : urlPath;

    const uploadedAtIso: ISODateString = input?.uploadedAtIso
      ? input.uploadedAtIso
      : (new Date().toISOString() as ISODateString);

    const fieldName =
      input?.fieldName && input.fieldName.trim() ? input.fieldName.trim() : "file";

    const pkt: FileMetaPacket = {
      originalName,
      storedName,

      extension,
      mimeType,
      sizeBytes: st.size,

      relativePath: publicRel,
      publicUrl,
      absDiskPath,

      fieldName,
      uploadedAtIso,

      ...(input?.encoding ? { encoding: input.encoding } : {}),
      ...(input?.checksumSha256 ? { checksumSha256: input.checksumSha256 } : {}),
    };

    return pkt;
  }

  // ===========================================================================
  // 05) Scan a directory (NON-recursive)
  // ===========================================================================

  /**
   * Scan a directory under public root and return packets for files directly inside it.
   *
   * @param options.dirPathLike
   * - Accepts: "public/uploads/..", "uploads/..", "/recyclebin/..", "recyclebin/.."
   */
  public static async scanDir(options: {
    dirPathLike: string;
    bucket: string;
    req?: Request;
    ignoreNames?: string[];
  }): Promise<FileMetaPacket[]> {
    const dirRel = this.normalizeToPublicRel(options.dirPathLike);
    if (!dirRel) return [];

    const exists = this.existsInPublic({ pathLike: dirRel, kind: "dir" });
    if (!exists.exists) return [];

    const ignore = new Set(
      (options.ignoreNames ?? []).map((s) => String(s).trim()).filter(Boolean)
    );

    const items = await fsp.readdir(exists.absDiskPath).catch(() => []);
    const out: FileMetaPacket[] = [];

    for (const name of items) {
      if (!name) continue;
      if (ignore.has(name)) continue;

      const abs = path.join(exists.absDiskPath, name);
      const st = await fsp.stat(abs).catch(() => null);
      if (!st || !st.isFile()) continue;

      const relFile = this.toPosixRel(path.posix.join(dirRel, name));

      const pkt = await this.buildIfExists({
        pathLike: relFile,
        bucket: options.bucket,
        originalName: name,
        ...(options.req ? { req: options.req } : {}),
      });

      if (pkt) out.push(pkt);
    }

    return out;
  }

  // ===========================================================================
  // 06) Scan a directory tree (RECURSIVE)
  // ===========================================================================

  /**
   * Scan a directory tree under public root recursively and return packets for all files.
   *
   * @param options.rootPathLike
   * - Accepts: "public/uploads/..", "uploads/..", "/recyclebin/..", "recyclebin/.."
   */
  public static async scanTree(options: {
    rootPathLike: string;
    bucket: string;
    req?: Request;
    maxFiles?: number;
    ignoreDirNames?: string[];
    ignoreFileNames?: string[];
  }): Promise<FileMetaPacket[]> {
    const rootRel = this.normalizeToPublicRel(options.rootPathLike);
    if (!rootRel) return [];

    const exists = this.existsInPublic({ pathLike: rootRel, kind: "dir" });
    if (!exists.exists) return [];

    const maxFiles = typeof options.maxFiles === "number" ? options.maxFiles : 20_000;

    const ignoreDirs = new Set(
      (options.ignoreDirNames ?? []).map((s) => String(s).trim()).filter(Boolean)
    );
    const ignoreFiles = new Set(
      (options.ignoreFileNames ?? []).map((s) => String(s).trim()).filter(Boolean)
    );

    const out: FileMetaPacket[] = [];

    await this.walkFiles({
      absDir: exists.absDiskPath,
      relDir: rootRel,
      ignoreDirs,
      ignoreFiles,
      onFile: async (relFile) => {
        if (out.length >= maxFiles) return;

        const name = path.posix.basename(relFile);

        const pkt = await this.buildIfExists({
          pathLike: relFile,
          bucket: options.bucket,
          originalName: name,
          ...(options.req ? { req: options.req } : {}),
        });

        if (pkt) out.push(pkt);
      },
    });

    return out;
  }

  private static async walkFiles(args: {
    absDir: string;
    relDir: string; // canonical publicRel dir
    ignoreDirs: Set<string>;
    ignoreFiles: Set<string>;
    onFile: (relFile: string) => Promise<void>;
  }): Promise<void> {
    const items = await fsp.readdir(args.absDir).catch(() => []);

    for (const name of items) {
      if (!name) continue;

      const abs = path.join(args.absDir, name);
      const st = await fsp.stat(abs).catch(() => null);
      if (!st) continue;

      const rel = this.toPosixRel(path.posix.join(args.relDir, name));

      if (st.isDirectory()) {
        if (args.ignoreDirs.has(name)) continue;

        await this.walkFiles({
          absDir: abs,
          relDir: rel,
          ignoreDirs: args.ignoreDirs,
          ignoreFiles: args.ignoreFiles,
          onFile: args.onFile,
        });

        continue;
      }

      if (st.isFile()) {
        if (args.ignoreFiles.has(name)) continue;
        await args.onFile(rel);
      }
    }
  }

  // ===========================================================================
  // 07) Convenience: Collect under root
  // ===========================================================================

  /**
   * Collect ALL files under a root.
   *
   * @param options.rootPathLike
   * - Accepts: "public/uploads/..", "uploads/..", "/recyclebin/..", "recyclebin/.."
   */
  public static async collectUnderRoot(options: {
    rootPathLike: string;
    req?: Request;
    bucket?: string;
    maxFiles?: number;
  }): Promise<FileMetaPacket[]> {
    const bucket = String(options.bucket ?? "").trim() || "root";

    return this.scanTree({
      rootPathLike: options.rootPathLike,
      bucket,
      ...(options.req ? { req: options.req } : {}),
      ...(typeof options.maxFiles === "number" ? { maxFiles: options.maxFiles } : {}),
    });
  }

  // ===========================================================================
  // 08) Extra convenience: Filter existing paths
  // ===========================================================================

  /** Return only existing items in public (useful before move/delete). */
  public static filterExisting(options: {
    paths: string[];
    kind?: "file" | "dir" | "any";
  }): Array<{ publicRel: string; absDiskPath: string }> {
    const kind = options.kind ?? "any";
    const out: Array<{ publicRel: string; absDiskPath: string }> = [];

    for (const p of options.paths) {
      const rel = this.normalizeToPublicRel(p);
      if (!rel) continue;

      const checked = this.existsInPublic({ pathLike: rel, kind });
      if (checked.exists) out.push({ publicRel: checked.publicRel, absDiskPath: checked.absDiskPath });
    }

    return out;
  }
}