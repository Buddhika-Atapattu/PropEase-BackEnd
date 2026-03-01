// Path: src/utils/files/file-meta-packet.builder.ts
// =============================================================================
// FileMetaPacketBuilder (Infrastructure Helper) — FIXED + LOCKED TO /public
// -----------------------------------------------------------------------------
// ✅ What this helper is for
// - Build FileMetaPacket DTOs from real files under your PUBLIC ROOT.
// - Scan directories (single dir) or scan directory trees (recursive).
// - Return UploadResultPacket so FE/BE always gets ONE stable envelope.
//
// ✅ Hard rules enforced (PropEase)
// - Caller may pass: "public/...", "uploads/...", "/recyclebin/...", "recyclebin/..."
// - Canonical internal form is ALWAYS:
//     "uploads/..." OR "recyclebin/..."   (NO leading "/")
// - Absolute paths MUST stay inside:
//     <cwd>/public
// - Supports BOTH roots:
//     <cwd>/public/uploads
//     <cwd>/public/recyclebin
// - exactOptionalPropertyTypes-safe:
//     NEVER pass { req: undefined } or attach optional props with undefined.
// - If a method returns empty → MUST warn (as you requested).
//
// NOTE
// - This file does NOT delete/move/copy. It only builds packets and scans.
// =============================================================================

import type { Request } from "express";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";

import type { FileMetaPacket, ISODateString } from "../../types/common";
import type { UploadResultPacket } from "./file-uploader.helper";

type PublicRootKind = "uploads" | "recyclebin";
type ExistsKind = "file" | "dir" | "any";

export class FileMetaPacketBuilder {
  // ===========================================================================
  // 00) Constants / Roots
  // ===========================================================================

  /** @private @readonly */
  private static readonly PUBLIC_ROOT_ABS: string = path.resolve( process.cwd(), "public" );

  /** @private @readonly */
  private static readonly ALLOWED_ROOTS: ReadonlyArray<PublicRootKind> = [ "uploads", "recyclebin" ] as const;

  // ===========================================================================
  // 01) Warning helper (required by you)
  // ===========================================================================

  /**
   * Why this method exists
   * - You requested: when a method returns empty/null, log a warning (best-effort).
   *
   * @param where - Method name or context label (e.g. "scanDirPacket")
   * @param details - Extra info (paths, counts, reason)
   *
   * Usage hint
   * - Called internally whenever return value is empty.
   *
   * Reasons to use this method
   * - Helps detect wrong paths, wrong mount points, missing files early.
   *
   * What to avoid
   * - Do NOT throw from here; keep it non-fatal.
   *
   * What result this method generates
   * - Writes a console warning line (no functional side effects).
   */
  private static warnEmpty( where: string, details: string ): void {
    // eslint-disable-next-line no-console
    console.warn( `[Warning:] [FileMetaPacketBuilder] ${ where } returned empty.\n${ details }\n` );
  }

  // ===========================================================================
  // 02) Segment + Path Normalizers (LOCKED to public/)
  // ===========================================================================

  /**
   * Why this method exists
   * - Defense-in-depth: validate a SINGLE segment (no slashes).
   *
   * @param seg - One segment only (e.g. "teamTasks", "file.webp", "LEASE-001")
   *
   * Usage hint
   * - Use for names, not full paths.
   *
   * Reasons to use this method
   * - Prevent traversal payloads and weird separators in segments.
   *
   * What to avoid
   * - Do NOT pass "a/b" here; it is unsafe by definition.
   *
   * What result this method generates
   * - boolean: true if safe.
   */
  public static isSafeSegment(seg: string): boolean {
    const s = String(seg ?? "").trim();
    return /^[a-zA-Z0-9._-]+$/.test(s);
  }

  /**
   * Why this method exists
   * - Normalize any incoming path into POSIX-like relative string.
   * - Removes leading "/" so caller cannot force absolute paths.
   *
   * @param input - Any path-like string (may contain "\" and leading "/")
   *
   * Usage hint
   * - Always call before any other normalization if you accept user paths.
   *
   * Reasons to use this method
   * - Standardizes Windows/Linux path inputs and blocks absolute paths.
   *
   * What to avoid
   * - Do NOT treat this as root validation; it only normalizes formatting.
   *
   * What result this method generates
   * - Relative string (no leading "/"), "\" converted to "/".
   */
  public static toPosixRel(input: string): string {
    const s = String(input ?? "").replace(/\\/g, "/").trim();
    return s.replace(/^\/+/, "");
  }

  /**
   * Why this method exists
   * - Convert ANY caller path into canonical "uploads/..." or "recyclebin/..."
   * - This is the ONLY canonical internal form used across this class.
   *
   * @param input - Path-like input accepted as:
   *   - "public/uploads/.."
   *   - "uploads/.."
   *   - "public/recyclebin/.."
   *   - "recyclebin/.."
   *   - "/uploads/.." or "/recyclebin/.."
   *
   * Usage hint
   * - Use this before building absolute disk paths.
   *
   * Reasons to use this method
   * - Locks all operations to <cwd>/public/uploads and <cwd>/public/recyclebin.
   *
   * What to avoid
   * - Do NOT pass ".." segments or null bytes; this will return "".
   *
   * What result this method generates
   * - Canonical publicRel string OR "" if invalid.
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

    const isUploadsRoot = lc === "uploads" || lc.startsWith("uploads/");
    const isRecycleRoot = lc === "recyclebin" || lc.startsWith("recyclebin/");

    if (!isUploadsRoot && !isRecycleRoot) return "";

    // Disallow traversal or null bytes (fast reject)
    if (withoutPublic.includes("..") || withoutPublic.includes("\0")) return "";

    // Segment-level hard checks
    const parts = withoutPublic.split("/").filter(Boolean);
    for (const p of parts) {
      if (p === "." || p === "..") return "";
      if ( !p.trim() ) return "";
    }

    // Canonical: no trailing slash
    return withoutPublic.replace(/\/+$/, "");
  }

  /**
   * Why this method exists
   * - Hard assertion for correctness and clearer error messages.
   *
   * @param input - Any user path
   * @param label - Used in error message ("dirPathLike", "publicRel", etc.)
   *
   * Usage hint
   * - Call before disk IO when you want strict behavior.
   *
   * Reasons to use this method
   * - Prevent silently scanning outside allowed roots.
   *
   * What to avoid
   * - Do NOT pass empty string; it will throw (by design).
   *
   * What result this method generates
   * - void or throws Error.
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
   * Why this method exists
   * - Convert canonical publicRel to absolute disk path under <cwd>/public safely.
   *
   * @param input - Any path-like input; normalized to canonical before resolving
   *
   * Usage hint
   * - Use for fs.stat/fs.readdir, etc.
   *
   * Reasons to use this method
   * - Prevent path traversal / escape from public root.
   *
   * What to avoid
   * - Do NOT call with raw absolute OS paths; pass public-rooted paths only.
   *
   * What result this method generates
   * - Absolute path guaranteed under <cwd>/public (or throws).
   */
  public static absFromPublicRel(input: string): string {
    const publicRel = this.normalizeToPublicRel(input);
    this.assertPublicRel(publicRel, "publicRel");

    const abs = path.resolve( this.PUBLIC_ROOT_ABS, publicRel );

    // Ensure abs stays under public root
    const rootWithSep = this.PUBLIC_ROOT_ABS.endsWith( path.sep )
      ? this.PUBLIC_ROOT_ABS
      : this.PUBLIC_ROOT_ABS + path.sep;

    const absWithSep = abs.endsWith(path.sep) ? abs : abs + path.sep;

    if (!absWithSep.startsWith(rootWithSep)) {
      throw new Error(`Invalid publicRel: resolved outside public root: ${publicRel}`);
    }

    return abs;
  }

  /**
   * Why this method exists
   * - Existence check under public root, with optional type check (file/dir).
   *
   * @param options - Existence options
   * @param options.pathLike - Any input accepted by normalizeToPublicRel()
   * @param options.kind - "file" | "dir" | "any" (default "any")
   *
   * Usage hint
   * - Use before scanning or building packets.
   *
   * Reasons to use this method
   * - Avoid unnecessary exceptions and enforce root locks.
   *
   * What to avoid
   * - Avoid calling twice for the same path; reuse the returned result.
   *
   * What result this method generates
   * - { exists, publicRel, absDiskPath }
   */
  public static existsInPublic(options: {
    pathLike: string;
    kind?: ExistsKind;
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

  // ===========================================================================
  // 03) URL builders (your system wants /public/... URLs)
  // ===========================================================================

  /**
   * Why this method exists
   * - Build a URL PATH for a canonical publicRel.
   * - Your requirement: URLs must include "/public/...".
   *
   * @param input - Canonical path "uploads/..." | "recyclebin/..."
   *
   * Usage hint
   * - Use with buildOriginFromReq(req) to create absolute URLs.
   *
   * Reasons to use this method
   * - Ensures FE always loads files via stable public mount.
   *
   * What to avoid
   * - Do NOT return "/uploads/..." here; your UI contract expects "/public/uploads/...".
   *
   * What result this method generates
   * - URL path like: "/public/uploads/x/y.png"
   */
  public static buildPublicUrlPath(input: string): string {
    const publicRel = this.normalizeToPublicRel(input);
    this.assertPublicRel(publicRel, "publicRel");
    return `/public/${ publicRel }`;
  }

  /**
   * Why this method exists
   * - Proxy-safe absolute origin builder (supports x-forwarded-* headers).
   *
   * @param req - Express Request
   *
   * Usage hint
   * - origin + buildPublicUrlPath(publicRel)
   *
   * Reasons to use this method
   * - Works behind reverse proxies/load balancers.
   *
   * What to avoid
   * - Do NOT hardcode localhost in packets.
   *
   * What result this method generates
   * - "https://host" (no trailing slash)
   */
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
  // 04) MIME guessing
  // ===========================================================================

  /**
   * Why this method exists
   * - FileMetaPacket needs mimeType; we infer by extension best-effort.
   *
   * @param extNoDot - Extension like "png" (with or without ".")
   *
   * Usage hint
   * - Used internally when building packet.
   *
   * Reasons to use this method
   * - Avoids extra dependency for infra layer.
   *
   * What to avoid
   * - Do NOT assume it is perfect (best-effort only).
   *
   * What result this method generates
   * - MIME type string
   */
  public static guessMimeType(extNoDot: string): string {
    const ext = String(extNoDot ?? "").toLowerCase().replace(".", "");

    if (ext === "webp") return "image/webp";
    if (ext === "png") return "image/png";
    if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
    if ( ext === "gif" ) return "image/gif";

    if (ext === "pdf") return "application/pdf";
    if ( ext === "txt" ) return "text/plain";
    if ( ext === "json" ) return "application/json";
    if ( ext === "csv" ) return "text/csv";

    if (ext === "docx") {
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    }
    if (ext === "xlsx") {
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    }
    if ( ext === "pptx" ) {
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    }

    return "application/octet-stream";
  }

  private static safeExtensionFromName(name: string): string {
    const ext = path.extname(name || "").replace(/^\./, "").trim();
    return ext || "bin";
  }

  // ===========================================================================
  // 05) Packet builders
  // ===========================================================================

  /**
   * Why this method exists
   * - Build a FileMetaPacket from a file if it exists under public root.
   * - Used by scanDir/scanTree and also by "known file path" flows.
   *
   * @param options - Build options
   * @param options.pathLike - Any accepted path:
   *   - "public/uploads/..", "uploads/..", "/recyclebin/..", "recyclebin/.."
   * @param options.bucket - Logical bucket/fieldName (e.g. "image", "evidence")
   * @param options.originalName - Optional display name; defaults to stored name
   * @param options.req - Optional; if present generates absolute publicUrl
   *
   * Usage hint
   * - Use when you have a specific file path and want its packet.
   *
   * Reasons to use this method
   * - Null-safe: does not throw on missing file (returns null + warns).
   *
   * What to avoid
   * - Do NOT pass a directory path; it returns null for directories.
   *
   * What result this method generates
   * - FileMetaPacket | null
   */
  public static async buildIfExists(options: {
    pathLike: string;
    bucket: string;
    originalName?: string;
    req?: Request;
  }): Promise<FileMetaPacket | null> {
    const publicRel = this.normalizeToPublicRel(options.pathLike);
    if ( !publicRel ) {
      this.warnEmpty( "buildIfExists", `Invalid pathLike: ${ String( options.pathLike ) }` );
      return null;
    }

    const abs = this.absFromPublicRel(publicRel);
    if ( !fs.existsSync( abs ) ) {
      this.warnEmpty( "buildIfExists", `Not found: ${ publicRel }` );
      return null;
    }

    const st = await fsp.stat(abs).catch(() => null);
    if ( !st || !st.isFile() ) {
      this.warnEmpty( "buildIfExists", `Not a file: ${ publicRel }` );
      return null;
    }

    const storedName = path.basename(abs);
    const originalName = String(options.originalName ?? "").trim() || storedName;

    const extension = this.safeExtensionFromName( storedName );
    const mimeType = this.guessMimeType( extension );

    const urlPath = this.buildPublicUrlPath(publicRel);
    const publicUrl = options.req ? `${ this.buildOriginFromReq( options.req ) }${ urlPath }` : urlPath;

    const bucket = String(options.bucket ?? "").trim() || "file";

    const packet: FileMetaPacket = {
      originalName,
      storedName,

      extension,
      mimeType,
      sizeBytes: st.size,

      relativePath: publicRel, // ✅ canonical (NO "public/")
      publicUrl, // ✅ includes "/public/..."
      absDiskPath: abs,

      fieldName: bucket,
      uploadedAtIso: st.mtime.toISOString() as ISODateString,
    };

    return packet;
  }

  /**
   * Why this method exists
   * - Strict variant: throws if invalid, missing, or not a file.
   *
   * @param pathLike - Any accepted path:
   *   - "public/..", "uploads/..", "/recyclebin/..", "recyclebin/.."
   * @param input - Optional overrides (exactOptionalPropertyTypes-safe)
   * @param input.fieldName - Optional field name
   * @param input.originalName - Optional original name
   * @param input.storedName - Optional stored name
   * @param input.mimeType - Optional mimeType
   * @param input.extension - Optional extension (without dot)
   * @param input.publicUrl - Optional publicUrl override
   * @param input.encoding - Optional encoding
   * @param input.checksumSha256 - Optional checksum
   * @param input.uploadedAtIso - Optional uploaded date
   * @param input.req - Optional; used to build absolute publicUrl if publicUrl not provided
   *
   * Usage hint
   * - Use when file must exist (controller/service validation).
   *
   * Reasons to use this method
   * - Strong guarantees: never returns null.
   *
   * What to avoid
   * - Do NOT pass directories.
   *
   * What result this method generates
   * - FileMetaPacket
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
      req?: Request;
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
      input?.originalName && input.originalName.trim() ? input.originalName.trim() : storedName;

    const extension =
      input?.extension && input.extension.trim()
        ? input.extension.trim().replace(/^\./, "")
        : this.safeExtensionFromName(storedName);

    const mimeType =
      input?.mimeType && input.mimeType.trim() ? input.mimeType.trim() : this.guessMimeType( extension );

    const urlPath = this.buildPublicUrlPath(publicRel);

    const publicUrl =
      input?.publicUrl && input.publicUrl.trim()
        ? input.publicUrl.trim()
        : input?.req
          ? `${ this.buildOriginFromReq( input.req ) }${ urlPath }`
          : urlPath;

    const uploadedAtIso: ISODateString = input?.uploadedAtIso
      ? input.uploadedAtIso
      : (new Date().toISOString() as ISODateString);

    const fieldName = input?.fieldName && input.fieldName.trim() ? input.fieldName.trim() : "file";

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
  // 06) UploadResultPacket builder (same envelope as FileUploader)
  // ===========================================================================

  /**
   * Why this method exists
   * - You requested: use UploadResultPacket for safety and consistency.
   * - This converts "byField packets" into one stable envelope.
   *
   * @param options - Build options
   * @param options.basePublicRelDir - Canonical base directory ("uploads/..."|"recyclebin/...")
   * @param options.byField - FieldName -> FileMetaPacket[]
   * @param options.req - Optional request (for absolute basePublicUrl)
   *
   * Usage hint
   * - For scanDirPacket/scanTreePacket: basePublicRelDir is the scanned directory.
   *
   * Reasons to use this method
   * - Keeps FE/BE contract stable across uploads + scans + recyclebin listing.
   *
   * What to avoid
   * - Do NOT pass a file path as basePublicRelDir; it should be a directory base.
   *
   * What result this method generates
   * - UploadResultPacket with totals computed.
   */
  public static buildUploadResultPacket( options: {
    basePublicRelDir: string;
    byField: Record<string, FileMetaPacket[]>;
    req?: Request;
  } ): UploadResultPacket {
    const baseRelCanon = this.normalizeToPublicRel( options.basePublicRelDir );
    if ( !baseRelCanon ) {
      // Build a safe empty packet and warn
      this.warnEmpty(
        "buildUploadResultPacket",
        `Invalid basePublicRelDir: ${ String( options.basePublicRelDir ) }`
      );

      const byField = options.byField ?? { files: [] };

      return this.computeUploadPacket( {
        basePublicRelDir: "uploads",
        byField,
        ...( options.req ? { req: options.req } : {} ),
      } );
    }

    return this.computeUploadPacket( {
      basePublicRelDir: baseRelCanon,
      byField: options.byField ?? {},
      ...( options.req ? { req: options.req } : {} ),
    } );
  }

  /**
   * @private
   * Why this method exists
   * - Internal shared implementation for UploadResultPacket computation.
   *
   * @param options.basePublicRelDir - Canonical base directory
   * @param options.byField - Field map
   * @param options.req - Optional request for absolute URL
   *
   * What result this method generates
   * - UploadResultPacket
   */
  private static computeUploadPacket( options: {
    basePublicRelDir: string;
    byField: Record<string, FileMetaPacket[]>;
    req?: Request;
  } ): UploadResultPacket {
    // As per your expectation: baseRelativeDir must be "/uploads/..." (leading slash)
    const baseRelativeDir = `/${ String( options.basePublicRelDir ?? "" ).replace( /^\/+/, "" ) }`;

    // As per your expectation: basePublicUrl must include "/public/..."
    const basePath = this.buildPublicUrlPath( options.basePublicRelDir );
    const basePublicUrl = options.req ? `${ this.buildOriginFromReq( options.req ) }${ basePath }` : basePath;

    let totalFiles = 0;
    let totalBytes = 0;

    for ( const arr of Object.values( options.byField ?? {} ) ) {
      const list = Array.isArray( arr ) ? arr : [];
      totalFiles += list.length;

      for ( const p of list ) {
        const n = Number( ( p as unknown as { sizeBytes?: unknown; } ).sizeBytes );
        if ( Number.isFinite( n ) && n >= 0 ) totalBytes += Math.floor( n );
      }
    }

    return {
      baseRelativeDir,
      basePublicUrl,
      totalFiles,
      totalBytes,
      byField: options.byField ?? {},
    };
  }

  // ===========================================================================
  // 07) scanDirPacket (single directory, NON-recursive) -> UploadResultPacket
  // ===========================================================================

  /**
   * Why this method exists (your requirement)
   * - scanDirPacket = scan ONE directory only (NON-recursive),
   *   and return UploadResultPacket for safer uniform contract.
   *
   * @param options - Scan options
   * @param options.dirPathLike - Directory path under uploads/ or recyclebin/
   * @param options.bucket - Field/bucket name used as byField key and packet.fieldName
   * @param options.req - Optional request for absolute URLs
   * @param options.ignoreNames - Optional file names to ignore
   *
   * Usage hint
   * - Use for listing a folder like:
   *   "uploads/users/<username>/image" (files directly inside)
   *
   * Reasons to use this method
   * - Fast + predictable (no recursion) + returns stable UploadResultPacket.
   *
   * What to avoid
   * - Do NOT use for deep trees (use scanTreePacket).
   *
   * What result this method generates
   * - UploadResultPacket (byField[bucket] contains file packets).
   * - If empty, logs a warning.
   */
  public static async scanDirPacket( options: {
    dirPathLike: string;
    bucket: string;
    req?: Request;
    ignoreNames?: string[];
  } ): Promise<UploadResultPacket> {
    const bucket = String( options.bucket ?? "" ).trim() || "files";

    const dirRel = this.normalizeToPublicRel(options.dirPathLike);
    if ( !dirRel ) {
      this.warnEmpty( "scanDirPacket", `Invalid dirPathLike: ${ String( options.dirPathLike ) }` );
      return this.buildUploadResultPacket( {
        basePublicRelDir: "uploads",
        byField: { [ bucket ]: [] },
        ...( options.req ? { req: options.req } : {} ),
      } );
    }

    const exists = this.existsInPublic({ pathLike: dirRel, kind: "dir" });
    if ( !exists.exists ) {
      this.warnEmpty( "scanDirPacket", `Directory not found: ${ dirRel }` );
      return this.buildUploadResultPacket( {
        basePublicRelDir: dirRel,
        byField: { [ bucket ]: [] },
        ...( options.req ? { req: options.req } : {} ),
      } );
    }

    const ignore = new Set( ( options.ignoreNames ?? [] ).map( ( s ) => String( s ).trim() ).filter( Boolean ) );

    const dirents = await fsp.readdir( exists.absDiskPath, { withFileTypes: true } ).catch( () => [] );
    const packets: FileMetaPacket[] = [];

    for ( const ent of dirents ) {
      const name = String( ent?.name ?? "" ).trim();
      if (!name) continue;
      if (ignore.has(name)) continue;
      if ( !ent.isFile() ) continue;

      const relFile = this.toPosixRel(path.posix.join(dirRel, name));

      const pkt = await this.buildIfExists({
        pathLike: relFile,
        bucket,
        originalName: name,
        ...(options.req ? { req: options.req } : {}),
      });

      if ( pkt ) packets.push( pkt );
    }

    const result = this.buildUploadResultPacket( {
      basePublicRelDir: dirRel,
      byField: { [ bucket ]: packets },
      ...( options.req ? { req: options.req } : {} ),
    } );

    if ( result.totalFiles === 0 ) {
      this.warnEmpty( "scanDirPacket", `No files in: ${ dirRel }` );
    }

    return result;
  }

  // ===========================================================================
  // 08) scanTreePacket (recursive) -> UploadResultPacket
  // ===========================================================================

  /**
   * Why this method exists (your requirement)
   * - scanTreePacket = recursive scan under a ROOT directory
   *   and return UploadResultPacket (safe uniform contract).
   *
   * @param options - Scan options
   * @param options.rootPathLike - Root directory path under uploads/ or recyclebin/
   * @param options.bucket - Field/bucket name used as byField key and packet.fieldName
   * @param options.req - Optional request for absolute URLs
   * @param options.maxFiles - Optional safety limit (default 20,000)
   * @param options.ignoreDirNames - Optional directory names to skip
   * @param options.ignoreFileNames - Optional file names to skip
   *
   * Usage hint
   * - Best for RecycleBin UI:
   *   "recyclebin/<Category>/<refId>" to list ALL nested files.
   *
   * Reasons to use this method
   * - Deep listing with safety limit, stable return envelope.
   *
   * What to avoid
   * - Avoid huge roots without maxFiles; always keep a cap.
   *
   * What result this method generates
   * - UploadResultPacket (flat file packets in byField[bucket]).
   * - If empty, logs a warning.
   */
  public static async scanTreePacket( options: {
    rootPathLike: string;
    bucket: string;
    req?: Request;
    maxFiles?: number;
    ignoreDirNames?: string[];
    ignoreFileNames?: string[];
  } ): Promise<UploadResultPacket> {
    const bucket = String( options.bucket ?? "" ).trim() || "files";

    const rootRel = this.normalizeToPublicRel(options.rootPathLike);
    if ( !rootRel ) {
      this.warnEmpty( "scanTreePacket", `Invalid rootPathLike: ${ String( options.rootPathLike ) }` );
      return this.buildUploadResultPacket( {
        basePublicRelDir: "uploads",
        byField: { [ bucket ]: [] },
        ...( options.req ? { req: options.req } : {} ),
      } );
    }

    const exists = this.existsInPublic({ pathLike: rootRel, kind: "dir" });
    if ( !exists.exists ) {
      this.warnEmpty( "scanTreePacket", `Root directory not found: ${ rootRel }` );
      return this.buildUploadResultPacket( {
        basePublicRelDir: rootRel,
        byField: { [ bucket ]: [] },
        ...( options.req ? { req: options.req } : {} ),
      } );
    }

    const maxFiles =
      typeof options.maxFiles === "number" && Number.isFinite( options.maxFiles )
        ? Math.max( 1, Math.floor( options.maxFiles ) )
        : 20_000;

    const ignoreDirs = new Set( ( options.ignoreDirNames ?? [] ).map( ( s ) => String( s ).trim() ).filter( Boolean ) );
    const ignoreFiles = new Set( ( options.ignoreFileNames ?? [] ).map( ( s ) => String( s ).trim() ).filter( Boolean ) );

    const packets: FileMetaPacket[] = [];

    await this.walkFiles({
      absDir: exists.absDiskPath,
      relDir: rootRel,
      ignoreDirs,
      ignoreFiles,
      maxFiles,
      onFile: async (relFile) => {
        if ( packets.length >= maxFiles ) return;

        const name = path.posix.basename(relFile);

        const pkt = await this.buildIfExists({
          pathLike: relFile,
          bucket,
          originalName: name,
          ...(options.req ? { req: options.req } : {}),
        });

        if ( pkt ) packets.push( pkt );
      },
    });

    const result = this.buildUploadResultPacket( {
      basePublicRelDir: rootRel,
      byField: { [ bucket ]: packets },
      ...( options.req ? { req: options.req } : {} ),
    } );

    if ( result.totalFiles === 0 ) {
      this.warnEmpty( "scanTreePacket", `No files under root: ${ rootRel }` );
    }

    return result;
  }

  /**
   * Why this method exists
   * - Internal DFS walker used by scanTreePacket.
   *
   * @param args - Walker args
   * @param args.absDir - Absolute directory (already validated under PUBLIC_ROOT_ABS)
   * @param args.relDir - Canonical publicRel directory ("uploads/..." or "recyclebin/...")
   * @param args.ignoreDirs - Directory name ignore set
   * @param args.ignoreFiles - File name ignore set
   * @param args.maxFiles - Safety stop count
   * @param args.onFile - Callback invoked with canonical publicRel for each file
   *
   * Usage hint
   * - Do not call from outside; use scanTreePacket.
   *
   * Reasons to use this method
   * - Centralizes recursion and keeps mapping stable.
   *
   * What to avoid
   * - Do NOT compute absolute paths outside the provided absDir/relDir join.
   *
   * What result this method generates
   * - Calls onFile repeatedly; returns void.
   */
  private static async walkFiles(args: {
    absDir: string;
    relDir: string;
    ignoreDirs: Set<string>;
    ignoreFiles: Set<string>;
    maxFiles: number;
    onFile: (relFile: string) => Promise<void>;
  }): Promise<void> {
    if ( args.maxFiles <= 0 ) return;

    const dirents = await fsp.readdir( args.absDir, { withFileTypes: true } ).catch( () => [] );
    for ( const ent of dirents ) {
      const name = String( ent?.name ?? "" ).trim();
      if (!name) continue;

      const abs = path.join( args.absDir, name );
      const rel = this.toPosixRel(path.posix.join(args.relDir, name));

      if ( ent.isDirectory() ) {
        if (args.ignoreDirs.has(name)) continue;

        await this.walkFiles({
          absDir: abs,
          relDir: rel,
          ignoreDirs: args.ignoreDirs,
          ignoreFiles: args.ignoreFiles,
          maxFiles: args.maxFiles,
          onFile: args.onFile,
        });

        continue;
      }

      if ( ent.isFile() ) {
        if (args.ignoreFiles.has(name)) continue;
        await args.onFile(rel);
      }
    }
  }

  // ===========================================================================
  // 09) Compatibility helpers (optional): Keep array methods if older code uses them
  // ===========================================================================

  /**
   * Why this method exists
   * - Backward compatibility: keep old signature returning FileMetaPacket[].
   *
   * @param options.dirPathLike - Directory path
   * @param options.bucket - Bucket/fieldName
   * @param options.req - Optional request
   * @param options.ignoreNames - Optional ignore list
   *
   * What result this method generates
   * - FileMetaPacket[] (warns if empty).
   */
  public static async scanDir( options: {
    dirPathLike: string;
    bucket: string;
    req?: Request;
    ignoreNames?: string[];
  } ): Promise<FileMetaPacket[]> {
    const pkt = await this.scanDirPacket( options );
    const key = String( options.bucket ?? "" ).trim() || "files";
    const arr = Array.isArray( pkt.byField[ key ] ) ? pkt.byField[ key ] : [];
    if ( arr.length === 0 ) this.warnEmpty( "scanDir", `No files in: ${ String( options.dirPathLike ) }` );
    return arr;
  }

  /**
   * Why this method exists
   * - Backward compatibility: keep old signature returning FileMetaPacket[].
   *
   * @param options.rootPathLike - Root directory path
   * @param options.bucket - Bucket/fieldName
   * @param options.req - Optional request
   * @param options.maxFiles - Optional safety cap
   * @param options.ignoreDirNames - Optional ignore dirs
   * @param options.ignoreFileNames - Optional ignore files
   *
   * What result this method generates
   * - FileMetaPacket[] (warns if empty).
   */
  public static async scanTree( options: {
    rootPathLike: string;
    bucket: string;
    req?: Request;
    maxFiles?: number;
    ignoreDirNames?: string[];
    ignoreFileNames?: string[];
  }): Promise<FileMetaPacket[]> {
    const pkt = await this.scanTreePacket( options );
    const key = String( options.bucket ?? "" ).trim() || "files";
    const arr = Array.isArray( pkt.byField[ key ] ) ? pkt.byField[ key ] : [];
    if ( arr.length === 0 ) this.warnEmpty( "scanTree", `No files under: ${ String( options.rootPathLike ) }` );
    return arr;
  }

  // ===========================================================================
  // 10) Extra convenience: filterExisting (still useful)
  // ===========================================================================

  /**
   * Why this method exists
   * - Filter an array of paths to only those that exist under public root.
   *
   * @param options.paths - List of pathLike inputs (public/uploads, uploads, /recyclebin, etc.)
   * @param options.kind - Optional kind filter
   *
   * Usage hint
   * - Use before move/delete operations (elsewhere) to avoid errors.
   *
   * Reasons to use this method
   * - Prevents attempting FS operations on missing/invalid paths.
   *
   * What to avoid
   * - Do NOT treat this as authorization; it is filesystem safety only.
   *
   * What result this method generates
   * - Array of { publicRel, absDiskPath }. If empty, logs warning.
   */
  public static filterExisting(options: {
    paths: string[];
    kind?: ExistsKind;
  }): Array<{ publicRel: string; absDiskPath: string }> {
    const kind = options.kind ?? "any";
    const out: Array<{ publicRel: string; absDiskPath: string }> = [];

    for ( const p of options.paths ?? [] ) {
      const rel = this.normalizeToPublicRel(p);
      if (!rel) continue;

      const checked = this.existsInPublic({ pathLike: rel, kind });
      if (checked.exists) out.push({ publicRel: checked.publicRel, absDiskPath: checked.absDiskPath });
    }

    if ( out.length === 0 ) {
      this.warnEmpty( "filterExisting", `No existing paths found. kind=${ kind }` );
    }

    return out;
  }
}