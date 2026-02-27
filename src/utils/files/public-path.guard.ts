// Path: src/utils/files/public-path.guard.ts
// =============================================================================
// PublicPathGuard (NORMALIZE + STRICT VALIDATE)
// -----------------------------------------------------------------------------
// Accepts parent input forms:
// - "/public/uploads/..", "public/uploads/..", "/uploads/..", "uploads/.."
// - "/public/recyclebin/..", "public/recyclebin/..", "/recyclebin/..", "recyclebin/.."
//
// Guarantees output is canonical:
// - "uploads/..." OR "recyclebin/..." (NO "public/", NO leading "/")
//
// Security hardening:
// - rejects ".", ".." segments and null bytes
// - abs path must stay under "<projectRoot>/public"
// - if exists: realpath must stay under "<projectRoot>/public" (symlink escape defense)
// =============================================================================

import fs from "fs";
import path from "path";

export class PublicPathGuard {
  private constructor () {}

  /**
   * Normalize any input into POSIX-like public-relative path.
   *
   * @param pathLike
   * - Expected: could be "public/uploads/x", "/uploads/x", "\\uploads\\x", etc.
   *
   * @returns
   * - Example: "uploads/x" or "recyclebin/y"
   * - Returns "" if empty
   */
  public static toPosixPublicRel( pathLike: string ): string {
    const raw = typeof pathLike === "string" ? pathLike.trim() : "";
    if (!raw) return "";

    // "\" => "/", remove leading "./" and leading "/" safely
    const posix = raw.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");

    // Strip mistaken "public/" prefix
    if (posix.toLowerCase().startsWith("public/")) {
      return posix.slice("public/".length);
    }

    return posix;
  }

  /**
   * Canonicalize to ONLY:
   * - "uploads/..." OR "recyclebin/..."
   *
   * This is the core invariant your FileUploader helper claims.
   *
   * @param pathLike
   * - Accepts: "/public/uploads/..", "uploads/..", "/recyclebin/..", etc.
   *
   * @returns canonical publicRel or "" if invalid
   */
  public static normalizeStrict( pathLike: string ): string {
    const rel = this.toPosixPublicRel( pathLike );
    if ( !rel ) return "";
    if ( rel.includes( "\0" ) ) return "";

    // Split segments, remove empty, remove "." segments (harmless)
    const parts = rel.split( "/" ).filter( Boolean ).filter( ( p ) => p !== "." );

    if ( parts.length === 0 ) return "";

    const root = String( parts[ 0 ] ?? "" ).toLowerCase();
    if ( root !== "uploads" && root !== "recyclebin" ) {
      return "";
    }

    // Reject traversal segments explicitly
    for (const p of parts) {
      if ( p === ".." ) return "";
    }

    return parts.join( "/" );
  }

  /**
   * Throw if pathLike cannot be normalized into uploads/ or recyclebin/.
   *
   * @param pathLike
   * - any accepted input form
   *
   * @param label
   * - used in error message
   */
  public static assertStrict( pathLike: string, label: string ): void {
    const rel = this.normalizeStrict( pathLike );
    if ( !rel ) {
      throw new Error(
        `Invalid ${ label }: must be under "uploads/" or "recyclebin/". Got: ${ String( pathLike ) }`
      );
    }
  }

  /**
   * Resolve strict publicRel to absolute disk path under "<projectRoot>/public".
   *
   * @param pathLike
   * - any accepted input form
   */
  public static absFromStrict( pathLike: string ): { publicRel: string; absDiskPath: string; } {
    const publicRel = this.normalizeStrict( pathLike );
    this.assertStrict( publicRel, "publicRel" );

    // Public folder is sibling of src => projectRoot/public.
    // Using process.cwd() is OK ONLY if you run node from project root.
    // If that ever changes, swap to a resolver (recommended).
    const publicRoot = path.resolve(process.cwd(), "public");

    const abs = path.resolve( publicRoot, publicRel );

    this.assertUnderBase( publicRoot, abs, "Invalid publicRel: resolved outside public root" );

    // Symlink escape defense (only if exists)
    if ( fs.existsSync( abs ) ) {
      const realRoot = fs.realpathSync( publicRoot );
      const realAbs = fs.realpathSync( abs );
      this.assertUnderBase( realRoot, realAbs, "Invalid publicRel: realpath escaped public root" );
    }

    return { publicRel, absDiskPath: abs };
  }

  /**
   * Existence check for strict publicRel (uploads/recyclebin only).
   */
  public static existsStrict( options: {
    pathLike: string;
    kind?: "file" | "dir" | "any";
  } ): { exists: boolean; publicRel: string; absDiskPath: string; } {
    const kind = options.kind ?? "any";
    const resolved = this.absFromStrict( options.pathLike );

    if ( !fs.existsSync( resolved.absDiskPath ) ) {
      return { exists: false, publicRel: resolved.publicRel, absDiskPath: resolved.absDiskPath };
    }

    if (kind === "any") {
      return { exists: true, publicRel: resolved.publicRel, absDiskPath: resolved.absDiskPath };
    }

    const st = fs.statSync( resolved.absDiskPath );
    if (kind === "file") {
      return { exists: st.isFile(), publicRel: resolved.publicRel, absDiskPath: resolved.absDiskPath };
    }

    return { exists: st.isDirectory(), publicRel: resolved.publicRel, absDiskPath: resolved.absDiskPath };
  }

  /**
   * Filter only existing strict public paths.
   */
  public static filterExistingStrict( options: {
    paths: string[];
    kind?: "file" | "dir" | "any";
  } ): Array<{ publicRel: string; absDiskPath: string; }> {
    const out: Array<{ publicRel: string; absDiskPath: string }> = [];
    const kind = options.kind ?? "any";

    for ( const p of options.paths ?? [] ) {
      const checked = this.existsStrict( { pathLike: p, kind } );
      if ( checked.exists ) out.push( { publicRel: checked.publicRel, absDiskPath: checked.absDiskPath } );
    }

    return out;
  }

  /**
   * Ensure target is under base (path containment).
   */
  private static assertUnderBase( baseAbs: string, targetAbs: string, msg: string ): void {
    const base = path.resolve( baseAbs );
    const target = path.resolve( targetAbs );

    const baseWithSep = base.endsWith( path.sep ) ? base : base + path.sep;
    const targetWithSep = target.endsWith( path.sep ) ? target : target + path.sep;

    if ( target !== base && !targetWithSep.startsWith( baseWithSep ) ) {
      throw new Error( msg );
    }
  }
}