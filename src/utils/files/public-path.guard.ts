// Path: src.utils/files/public-path.guard.ts
import fs from "fs";
import path from "path";

export class PublicPathGuard {
  /**
   * Normalize a path to "public-relative POSIX".
   *
   * @param publicRel
   * - Expected: "uploads/leases/LEASE-001/file.pdf"
   * - NOT expected: "public/uploads/..." (do not include "public/")
   * - NOT expected: "/uploads/..." (no leading slash)
   */
  public static toPosixPublicRel(publicRel: string): string {
    const raw = typeof publicRel === "string" ? publicRel.trim() : "";
    if (!raw) return "";

    // Convert Windows "\" to "/" and strip leading "./" and "/" safely
    const posix = raw.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");

    // Strip a mistaken "public/" prefix (common mistake)
    if (posix.toLowerCase().startsWith("public/")) {
      return posix.slice("public/".length);
    }

    return posix;
  }

  /**
   * Validate that a public-relative path is safe (no traversal).
   *
   * Why we need this
   * - Prevent "../" attacks and any attempt to resolve outside the public root.
   *
   * @param publicRel
   * - Expected: "uploads/..."
   */
  public static assertPublicRel(publicRel: string, label: string): void {
    const rel = this.toPosixPublicRel(publicRel);
    if (!rel) {
      throw new Error(`Invalid ${label}: empty`);
    }

    // Hard reject traversal tokens in any segment
    const parts = rel.split("/").filter(Boolean);
    for (const p of parts) {
      if (p === "." || p === "..") {
        throw new Error(`Invalid ${label}: path traversal detected`);
      }
    }

    // Also reject null bytes
    if (rel.includes("\0")) {
      throw new Error(`Invalid ${label}: null byte`);
    }
  }

  /**
   * Resolve a public-relative path to an absolute disk path under "<cwd>/public".
   *
   * @param publicRel
   * - Expected: "uploads/..."
   */
  public static absFromPublicRel(publicRel: string): string {
    const rel = this.toPosixPublicRel(publicRel);
    this.assertPublicRel(rel, "publicRel");

    // Build absolute root: <projectRoot>/public
    const publicRoot = path.resolve(process.cwd(), "public");
    const abs = path.resolve(publicRoot, rel);

    // Ensure abs is still under public root (defense-in-depth)
    const publicRootWithSep = publicRoot.endsWith(path.sep) ? publicRoot : publicRoot + path.sep;
    const absWithSep = abs.endsWith(path.sep) ? abs : abs + path.sep;

    if (!absWithSep.startsWith(publicRootWithSep)) {
      throw new Error("Invalid publicRel: resolved outside public root");
    }

    return abs;
  }

  /**
   * Check whether a public-relative path exists under public/.
   *
   * @param options.publicRel
   * - Expected: "uploads/..."
   *
   * @param options.kind
   * - Optional: "file" | "dir" | "any"
   * - Default: "any"
   */
  public static existsInPublic(options: {
    publicRel: string;
    kind?: "file" | "dir" | "any";
  }): { exists: boolean; publicRel: string; absDiskPath: string } {
    const publicRel = this.toPosixPublicRel(options.publicRel);
    const absDiskPath = this.absFromPublicRel(publicRel);

    const kind = options.kind ?? "any";

    if (!fs.existsSync(absDiskPath)) {
      return { exists: false, publicRel, absDiskPath };
    }

    if (kind === "any") {
      return { exists: true, publicRel, absDiskPath };
    }

    const st = fs.statSync(absDiskPath);
    if (kind === "file") {
      return { exists: st.isFile(), publicRel, absDiskPath };
    }
    return { exists: st.isDirectory(), publicRel, absDiskPath };
  }

  /**
   * Filter only existing public-relative paths.
   *
   * @param options.paths
   * - Expected: array of "uploads/..." paths
   *
   * @param options.kind
   * - Optional: "file" | "dir" | "any"
   */
  public static filterExisting(options: {
    paths: string[];
    kind?: "file" | "dir" | "any";
  }): Array<{ publicRel: string; absDiskPath: string }> {
    const kind = options.kind ?? "any";
    const out: Array<{ publicRel: string; absDiskPath: string }> = [];

    for (const p of options.paths) {
      const checked = this.existsInPublic({ publicRel: p, kind });
      if (checked.exists) {
        out.push({ publicRel: checked.publicRel, absDiskPath: checked.absDiskPath });
      }
    }

    return out;
  }
}