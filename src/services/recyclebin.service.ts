// src/services/recyclebin.service.ts
// ─────────────────────────────────────────────────────────────────────────────
// RecycleBinService
// - Single responsibility: read JSON snapshots + move/delete files under /public
// - Works only "inside" your /public root to avoid path traversal issues
// - Beginner-friendly comments on each method
// ─────────────────────────────────────────────────────────────────────────────

import path from 'path';                     // Build OS-safe paths
import fs from 'fs';                         // For fs.existsSync (sync check is ok here)
import fsp from 'fs/promises';               // Async fs (read/write/move/remove)
import type {TitleCategory} from '../models/notifications/notification.model';

type StrictStringRecord = Record<string, string>;

/** Options to configure folder names under /public */
export interface RecycleBinOptions {
    publicRoot?: string;       // absolute path to /public (default: <cwd>/public)
    recyclebinDir?: string;    // folder name under /public (default: 'recyclebin')
    // Optional map to translate TitleCategory -> subfolder, e.g. 'User' → 'users'
    categoryFolderMap?: Partial<Record<TitleCategory, string>>;
}

/** Result when reading a snapshot JSON file */
export interface ReadSnapshotResult<T = any> {
    ok: boolean;               // whether reading/parsing succeeded
    data?: T;                  // parsed JSON if ok
    dir?: string;              // absolute path to the recyclebin entity folder
    jsonPath?: string;         // absolute path to data.json
    message?: string;          // helpful message when !ok
}

/**
 * RecycleBinService is a class to keep FS concerns separate and testable.
 * It never touches Mongo; it only reads JSON + moves/copies/deletes files.
 */
export default class RecycleBinService {
    // Absolute path to /public (e.g., /home/app/project/public)
    private readonly publicRoot: string;

    // "recyclebin" folder name inside /public (default)
    private readonly recyclebinName: string;

    // TitleCategory → folder name (lowercase plural by default)
    private readonly folderMap: Record<TitleCategory, string>;

    constructor (opts: RecycleBinOptions = {}) {
        // 1) Resolve /public root (default to <cwd>/public)
        this.publicRoot = path.resolve(opts.publicRoot ?? path.join(process.cwd(), 'public'));

        // 2) Name of the recyclebin folder under /public (default: 'recyclebin')
        this.recyclebinName = (opts.recyclebinDir ?? 'recyclebin').trim().replace(/^\/+|\/+$/g, '');

        // 3) Folder mapping for categories (you can tweak to match your actual structure)
        const defaults: Record<TitleCategory, string> = {
            User: 'users',
            Tenant: 'tenants',
            Property: 'properties',
            Lease: 'leases',
            Agent: 'agents',
            Developer: 'developers',
            Maintenance: 'maintenance',
            Complaint: 'complaints',
            Team: 'teams',
            Registration: 'registrations',
            Payment: 'payments',
            System: 'system',
        };
        this.folderMap = {...defaults, ...(opts.categoryFolderMap ?? {})};
    }

    /** Helper: absolute path to /public */
    private pub(...parts: string[]): string {
        return path.resolve(this.publicRoot, ...parts);
    }

    /** Helper: absolute path to /public/recyclebin */
    private bin(...parts: string[]): string {
        return this.pub(this.recyclebinName, ...parts);
    }

    /** Compute the *recyclebin* folder: /public/recyclebin/<folder>/<id> */
    private entityBinDir(category: TitleCategory, refId: string): string {
        const folder = this.folderMap[category] || category.toLowerCase();
        // Use posix join for URL-like structure, then resolve on disk
        const relative = path.posix.join(folder, refId);
        return this.bin(relative);
    }

    /**
     * Safe guard: ensure an absolute path stays inside /public
     * (prevents accidental deletion outside our allowed root).
     */
    private ensureInsidePublic(absPath: string): string {
        const norm = path.resolve(absPath);
        const root = this.publicRoot + path.sep;
        if(norm !== this.publicRoot && !norm.startsWith(root)) {
            throw new Error(`Path escapes public root: ${norm}`);
        }
        return norm;
    }

    // recyclebin.service.ts (only the readSnapshot method)
    // Assumes you already have: import fs from 'fs'; import * as fsp from 'fs/promises'; import path from 'path';
    // and a helper this.entityBinDir(category, refId) that returns '<...>/recyclebin/<categoryPlural>/<refId>'

    async readSnapshot<T = any>(category: TitleCategory, refId: string): Promise<ReadSnapshotResult<T>> {
        try {
            // 1) Where this refId would normally live
            const exactDir = this.entityBinDir(category, refId); // e.g. .../recyclebin/properties/<refId>
            const categoryDir = path.dirname(exactDir);          // e.g. .../recyclebin/properties
            const baseName = path.basename(exactDir);            // refId (no timestamp)

            // 2) List sibling dirs that match <refId> or <refId>_<timestamp>
            //    We filter to directories that contain a data.json file.
            const dirents = await fsp.readdir(categoryDir, {withFileTypes: true}).catch(() => []);
            const candidates: Array<{dir: string; json: string; tsScore: number; mtimeMs: number}> = [];

            const tsRegex = new RegExp(`^${baseName.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}(?:_(\\d+))?$`); // escape refId safely

            for(const d of dirents) {
                if(!d.isDirectory()) continue;
                const m = d.name.match(tsRegex);
                if(!m) continue;

                const candidateDir = path.join(categoryDir, d.name);
                const json = path.join(candidateDir, 'data.json');
                if(!fs.existsSync(json)) continue;

                // Timestamp score: prefer highest numeric suffix; if absent, treat as 0.
                const tsScore = m[1] ? Number(m[1]) : 0;

                // Fallback tie-breaker: most recent data.json mtime
                let mtimeMs = 0;
                try {
                    const st = await fsp.stat(json);
                    mtimeMs = st.mtimeMs || 0;
                } catch {
                    // ignore stat errors; leave mtimeMs = 0
                }

                candidates.push({dir: candidateDir, json, tsScore, mtimeMs});
            }

            // 3) No matching folders at all?
            if(candidates.length === 0) {
                const jsonPath = path.join(exactDir, 'data.json'); // what we would have used
                return {ok: false, message: 'data.json not found in recyclebin (no matching folders)', dir: exactDir, jsonPath};
            }

            // 4) Pick the most recent:
            //    - primarily by highest tsScore
            //    - if equal, by latest mtimeMs
            candidates.sort((a, b) => {
                if(a.tsScore !== b.tsScore) return b.tsScore - a.tsScore;
                return b.mtimeMs - a.mtimeMs;
            });

            const chosen = candidates[0]!;

            // 5) Read + parse JSON
            const raw = await fsp.readFile(chosen.json, 'utf8');
            const data = JSON.parse(raw) as T;

            return {ok: true, data, dir: chosen.dir, jsonPath: chosen.json};
        } catch(e: any) {
            // Final defensive catch
            const dir = this.entityBinDir(category, refId);
            const jsonPath = path.join(dir, 'data.json');
            return {ok: false, message: e?.message || 'Failed to read/parse data.json', dir, jsonPath};
        }
    }


    /**
     * Move the entire folder out of recyclebin back to a destination under /public.
     * Example:
     *   from:  /public/recyclebin/properties/123
     *   to:    /public/uploads/properties/123
     *
     * If `to` already exists, we merge/overwrite files (rename may fail across devices → fallback copy).
     */
    async restoreFolder(category: TitleCategory, refId: string, destRelative: string): Promise<void> {
        // 1) Compute absolute paths
        const fromDir = this.entityBinDir(category, refId);
        const toDir = this.pub(destRelative);

        // 2) Ensure both paths are inside /public
        this.ensureInsidePublic(fromDir);
        this.ensureInsidePublic(toDir);

        // 3) If source doesn't exist, nothing to move (maybe media never existed)
        if(!fs.existsSync(fromDir)) return;

        // 4) Make sure destination parent exists
        await fsp.mkdir(path.dirname(toDir), {recursive: true});

        // 5) Try a simple rename first (fast)
        try {
            await fsp.rename(fromDir, toDir);
            return;
        } catch(e: any) {
            // 6) Cross-device fallback: copy tree then remove source
            if(e?.code !== 'EXDEV') throw e;
            await this.copyRecursive(fromDir, toDir);
            await this.removeRecursive(fromDir);
        }
    }

    /** Completely remove `/public/recyclebin/<cat>/<id>` (permanent delete) */
    async purge(category: TitleCategory, refId: string): Promise<void> {
        const dir = this.entityBinDir(category, refId);
        this.ensureInsidePublic(dir);
        await this.removeRecursive(dir);
    }

    /** Recursively copy file/dir trees (used in cross-device rename fallback) */
    private async copyRecursive(src: string, dest: string): Promise<void> {
        const stat = await fsp.stat(src);
        if(stat.isDirectory()) {
            await fsp.mkdir(dest, {recursive: true});
            const entries = await fsp.readdir(src);
            for(const name of entries) {
                await this.copyRecursive(path.join(src, name), path.join(dest, name));
            }
        } else {
            await fsp.mkdir(path.dirname(dest), {recursive: true});
            await fsp.copyFile(src, dest);
        }
    }

    /** Recursively remove a file/dir tree (idempotent) */
    private async removeRecursive(target: string): Promise<void> {
        await fsp.rm(target, {recursive: true, force: true});
    }
}
