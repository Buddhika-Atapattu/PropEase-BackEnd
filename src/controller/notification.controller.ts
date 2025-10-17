// src/controller/notification.controller.ts

// ─────────────────────────────────────────────────────────────────────────────
// Imports
// ─────────────────────────────────────────────────────────────────────────────
import {Router, type RequestHandler} from 'express';              // Express router + types
import path from 'path';                                            // Node core: file path utils (safe joins, etc.)
import fs from 'fs';                                                // Node core: sync fs (only for quick checks)
import fsp from 'fs/promises';                                      // Node core: promise-based fs (readFile, stat, etc.)

import NotificationService, {RestoreByCategoryInput} from '../services/notification.service';  // Service with list/create/restore/delete
import SocketServer from '../socket/socket';                         // Socket.IO wrapper (emit to rooms)
import {Role} from '../types/roles';                               // Your role type

// IMPORTANT: Use the same type that the model/service use
import type {TitleCategory} from '../models/notifications/notification.model';


// ─────────────────────────────────────────────────────────────────────────────
// Types for requests (runtime-only "shape hints")
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Auth-augmented request (runtime cast only).
 * Your auth middleware should inject `req.user = { username, role }`.
 */
type AuthedReq = Express.Request & {user: {username: string; role: Role}};

/**
 * What the FE can send in the /restore (and /permanent-delete) endpoint.
 * - `category`: free-form from FE (we’ll normalize to TitleCategory)
 * - `refId`: preferred when doing DB "soft-undelete"
 * - `snapshot`: optional JSON with the record (used when re-inserting)
 * - `metadata`: optional extra info (e.g., who deleted, why, filePath, etc.)
 */
type RestoreNotificationPayload = {
  _id?: string;                                // Optional notification id (not required for restore itself)
  category: string;                            // FE may send "tenant" → we'll normalize to "Tenant"
  refId?: string;                              // Target DB record id
  snapshot?: Record<string, any>;              // Optional JSON payload with data to re-insert
  metadata?: Record<string, any>;              // Extra info (we also look for "filePath" here)
};

/**
 * Same shape for permanent delete (category + refId are the minimum).
 */
type PermanentDeletePayload = {
  _id?: string;
  category: string;
  refId?: string;                              // Hard delete always requires refId
  metadata?: Record<string, any>;
};


// ─────────────────────────────────────────────────────────────────────────────
// Local disk (snapshot) reading helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Base folder for on-disk snapshots/backups.
 * - You can configure via env var RESTORE_ROOT (recommended in prod).
 * - Falls back to "<project root>/backups" if not set.
 */
const BACKUP_ROOT = (() => {
  const env = (process.env.RESTORE_ROOT || '').trim();
  return env ? path.resolve(env) : path.join(process.cwd(), 'backups');
})();

/**
 * Join paths securely so a malicious "../../.." cannot escape BACKUP_ROOT.
 * - Returns an absolute path inside BACKUP_ROOT or throws an Error.
 */
function safeJoin(baseDir: string, ...parts: string[]): string {
  // Build an absolute candidate path
  const target = path.resolve(baseDir, ...parts);
  // Ensure target path is inside baseDir (prevents path traversal attacks)
  if(!target.startsWith(path.resolve(baseDir) + path.sep) && target !== path.resolve(baseDir)) {
    throw new Error('Unsafe path detected (path traversal blocked).');
  }
  return target;
}

/**
 * Try to read a JSON snapshot safely from disk.
 * - `relPath` should be relative to BACKUP_ROOT (e.g., "tenants/abc.json").
 * - Validates file exists, prevents traversal, parses JSON.
 * - Returns `undefined` if the file can’t be found/read/parsed.
 */
async function tryReadJsonSnapshot(relPath?: string): Promise<Record<string, any> | undefined> {
  try {
    // No path provided → nothing to read
    if(!relPath || typeof relPath !== 'string' || !relPath.trim()) return undefined;

    // Join safely so user cannot escape BACKUP_ROOT
    const absolute = safeJoin(BACKUP_ROOT, relPath.trim());

    // Quick existence check (fs.existsSync is ok; could also use fsp.stat)
    if(!fs.existsSync(absolute)) return undefined;

    // Read the file as text
    const data = await fsp.readFile(absolute, 'utf8');

    // Parse JSON carefully
    const parsed = JSON.parse(data);

    // Ensure result is an object (we only accept objects for snapshots)
    return typeof parsed === 'object' && parsed ? (parsed as Record<string, any>) : undefined;
  } catch {
    // Any failure → treat as "no snapshot available"
    return undefined;
  }
}

/**
 * Normalize a free-form string (e.g., "tenant", "Tenant") to a concrete TitleCategory literal.
 * - Returns undefined for unknown input.
 */
function normalizeCategory(input?: string): TitleCategory | undefined {
  if(!input) return undefined;
  const s = input.trim().toLowerCase();

  // Map common lowercase strings to the exact TitleCategory literals your model uses
  const map: Record<string, TitleCategory> = {
    user: 'User',
    tenant: 'Tenant',
    property: 'Property',
    lease: 'Lease',
    agent: 'Agent',
    developer: 'Developer',
    maintenance: 'Maintenance',
    complaint: 'Complaint',
    team: 'Team',
    registration: 'Registration',
    payment: 'Payment',
    system: 'System',
  };

  return map[s];
}


// ─────────────────────────────────────────────────────────────────────────────
// Controller
// ─────────────────────────────────────────────────────────────────────────────

export default class NotificationController {
  // Instance-wide router we will attach handlers to
  public readonly router = Router();

  constructor (
    private readonly service: NotificationService,  // Service with DB logic
    private readonly sockets: SocketServer          // Socket wrapper for emits
  ) {
    // Register routes here for clarity and single source of truth
    this.router.get('/', this.listMine);                       // GET /api-notification
    this.router.post('/create', this.create);                  // POST /api-notification/create
    this.router.post('/:id/read', this.markRead);              // POST /api-notification/:id/read
    this.router.post('/read-all', this.markAllRead);           // POST /api-notification/read-all

    // Restore and permanent delete entry points (accept JSON or FormData)
    this.router.post('/restore', this.restoreDelete);          // POST /api-notification/restore
    this.router.post('/permanent-delete', this.permanentDelete); // POST /api-notification/permanent-delete
  }

  // ───────────────────────────────────────────────────────────────────────────
  // GET /api-notification?skip=0&limit=50&unread=true&category=tenant
  // List all notifications for the logged-in user, optionally filtering by category.
  // ───────────────────────────────────────────────────────────────────────────
  private listMine: RequestHandler = async (req, res) => {
    try {
      // Auth middleware should inject user details
      const {username, role} = ((req as unknown) as AuthedReq).user;

      // Read query params. All are strings in Express, so coerce as needed.
      const {skip = '0', limit = '50', unread, category} = req.query as any;

      // Normalize category string (free-form) → TitleCategory (exact literal)
      const normalizedCategory = typeof category === 'string' ? normalizeCategory(category) : undefined;

      // Build filters expected by the service
      const filters = {
        skip: Number(skip),                          // page offset in items
        limit: Number(limit),                        // max items to return
        onlyUnread: unread === 'true',               // optional filter
        ...(normalizedCategory ? {category: normalizedCategory} : {}),
      } as const;                                    // "const" so TS preserves literal types

      // Ask service for results (includes per-user state merging)
      const data = await this.service.listForUser(username, role, filters);

      // Return normalized JSON
      res.json({success: true, data});
    } catch(err: any) {
      console.error('Error listing notifications:', err);
      res.status(500).json({success: false, message: err.message});
    }
  };

  // ───────────────────────────────────────────────────────────────────────────
  // POST /api-notification/create
  // Create a new notification (admin/operator/manager only).
  // The service will fan-out per-user state and can emit to Socket.IO rooms.
  // ───────────────────────────────────────────────────────────────────────────
  private create: RequestHandler = async (req, res) => {
    try {
      // Basic RBAC check
      const allowedRoles: ReadonlyArray<Role> = ['admin', 'operator', 'manager'];
      const {role} = ((req as unknown) as AuthedReq).user;
      if(!allowedRoles.includes(role)) {
        res.status(403).json({message: 'Permission denied'});
        return;
      }

      // Create via service; emit to audience rooms on success
      const created = await this.service.createNotification(
        req.body,
        (rooms, payload) => this.sockets.emitToRooms(rooms, 'notification.new', payload)
      );

      res.status(201).json({success: true, data: created});
    } catch(err: any) {
      console.error('Error creating notification:', err);
      res.status(500).json({success: false, message: err.message});
    }
  };

  // ───────────────────────────────────────────────────────────────────────────
  // POST /api-notification/:id/read
  // Mark one notification as read for the current user.
  // ───────────────────────────────────────────────────────────────────────────
  private markRead: RequestHandler = async (req, res) => {
    try {
      const {username} = ((req as unknown) as AuthedReq).user;
      const {id} = req.params;

      // Validate id
      if(typeof id !== 'string' || !id.trim()) {
        res.status(400).json({success: false, message: 'Invalid notification ID'});
        return;
      }

      await this.service.markRead(username, id);
      res.json({success: true});
    } catch(err: any) {
      console.error('Error marking notification as read:', err);
      res.status(500).json({success: false, message: err.message});
    }
  };

  // ───────────────────────────────────────────────────────────────────────────
  // POST /api-notification/read-all
  // Mark ALL notifications as read for the current user (bulk).
  // ───────────────────────────────────────────────────────────────────────────
  private markAllRead: RequestHandler = async (_req, res) => {
    try {
      const {username} = ((_req as unknown) as AuthedReq).user;
      await this.service.markAllRead(username);
      res.json({success: true});
    } catch(err: any) {
      console.error('Error marking all notifications as read:', err);
      res.status(500).json({success: false, message: err.message});
    }
  };

  // ───────────────────────────────────────────────────────────────────────────
  // POST /api-notification/restore
  //
  // Restore a deleted domain record using either:
  //   - refId (preferred if you soft-delete in DB), OR
  //   - a snapshot object provided in the request, OR
  //   - a snapshot path on disk (metadata.filePath) → reads BACKUP_ROOT/<filePath>
  //
  // Accepts JSON or FormData (field name "notification").
  //
  // Security notes:
  //   - We normalize category to TitleCategory (strict set).
  //   - We prevent path traversal on snapshot reads via safeJoin().
  //   - Only admin/operator/manager roles are allowed.
  // ───────────────────────────────────────────────────────────────────────────
  private restoreDelete: RequestHandler = async (req, res) => {
    try {
      // (1) Extract payload from JSON or FormData
      //     If Content-Type is multipart/form-data, ensure Multer `.none()` is used where routes are registered.
      const raw =
        typeof (req.body as any)?.notification === 'string'
          ? (req.body as any).notification
          : (req.body as any)?.notification
            ? JSON.stringify((req.body as any).notification)
            : undefined;

      // (2) Support plain JSON body as well (no wrapper)
      const fallbackJsonBody =
        raw == null && req.is('application/json') ? JSON.stringify(req.body) : undefined;

      const toParse = raw ?? fallbackJsonBody;
      if(!toParse) {
        res.status(400).json({
          success: false,
          message:
            'Missing notification payload. Send JSON { notification: {...} } or FormData field "notification".',
        });
        return;
      }

      // (3) Parse JSON safely
      let parsed: RestoreNotificationPayload | undefined;
      try {
        parsed = JSON.parse(toParse) as RestoreNotificationPayload;
      } catch {
        res.status(400).json({success: false, message: 'Invalid JSON in "notification"'});
        return;
      }

      // (4) Normalize & validate category
      const category = normalizeCategory(parsed?.category);
      if(!category) {
        res.status(400).json({success: false, message: 'Missing/invalid "category"'});
        return;
      }

      // (5) Prefer refId; if missing, try snapshot; if not provided, try reading from disk
      const refId = typeof parsed?.refId === 'string' ? parsed!.refId!.trim() : undefined;
      let snapshot = parsed?.snapshot && typeof parsed.snapshot === 'object' ? parsed.snapshot : undefined;
      const metadata = parsed?.metadata ?? {};

      // Optional: allow FE to pass a relative file path for snapshot on disk (e.g., "tenants/123.json")
      // - We’ll read it ONLY if the request didn’t include a snapshot object.
      // - Prevent path traversal using `safeJoin`.
      if(!snapshot) {
        const filePath = typeof metadata?.filePath === 'string' ? metadata.filePath.trim() : '';
        if(filePath) {
          snapshot = await tryReadJsonSnapshot(filePath);
        }
      }

      // Must have at least refId or snapshot to proceed
      if(!refId && !snapshot) {
        res.status(400).json({success: false, message: 'Provide "refId" or a valid "snapshot" (or metadata.filePath).'});
        return;
      }

      // (6) Authorization policy (adjust as needed)
      const {role, username} = ((req as unknown) as AuthedReq).user;
      const mayRestore = role === 'admin' || role === 'operator' || role === 'manager';
      if(!mayRestore) {
        res.status(403).json({success: false, message: 'Permission denied'});
        return;
      }

      // (7) Build input for service, omitting undefined optional fields (works with exactOptionalPropertyTypes)
      const restoreInput: RestoreByCategoryInput = {
        category,                    // TitleCategory
        metadata,                    // pass-thru metadata (may include filePath, etc.)
        requestedBy: username,       // actor performing the restore
        ...(refId ? {refId} : {}),
        ...(snapshot ? {snapshot} : {}),
      } as const;

      // (8) Call service to perform the actual DB operation
      const result = await this.service.restoreByCategory(restoreInput);

      // (9) Emit socket update so connected clients can reflect changes in real-time
      if(result?.ok) {
        this.sockets.emitToRooms(
          result.rooms || [],
          'notification.restore',
          {category, refId, by: username}
        );

        this.filterRestoreData(restoreInput);
      }

      // (10) Respond with outcome
      res.status(200).json({
        success: !!result?.ok,
        message: result?.message || (result?.ok ? 'Restored' : 'Restore failed'),
        category,
        refId,
        restored: result?.restored ?? undefined,
      });
    } catch(err: any) {
      console.error('Error restoring by category:', err);
      res.status(500).json({success: false, message: err?.message || 'Restore error'});
    }
  };

  // ───────────────────────────────────────────────────────────────────────────
  // POST /api-notification/permanent-delete
  //
  // Permanent (hard) delete a domain record by category + refId.
  // Accepts JSON or FormData (field name "notification"), similar to restore.
  // Security: same RBAC; no snapshot reading here—refId is required.
  // ───────────────────────────────────────────────────────────────────────────
  private permanentDelete: RequestHandler = async (req, res) => {
    try {
      // Same extraction approach to support both JSON and multipart
      const raw =
        typeof (req.body as any)?.notification === 'string'
          ? (req.body as any).notification
          : (req.body as any)?.notification
            ? JSON.stringify((req.body as any).notification)
            : undefined;

      const fallbackJsonBody =
        raw == null && req.is('application/json') ? JSON.stringify(req.body) : undefined;

      const toParse = raw ?? fallbackJsonBody;
      if(!toParse) {
        res.status(400).json({
          success: false,
          message:
            'Missing notification payload. Send JSON { notification: {...} } or FormData field "notification".',
        });
        return;
      }

      // Parse safely
      let parsed: PermanentDeletePayload | undefined;
      try {
        parsed = JSON.parse(toParse) as PermanentDeletePayload;
      } catch {
        res.status(400).json({success: false, message: 'Invalid JSON in "notification"'});
        return;
      }

      // Normalize & validate
      const category = normalizeCategory(parsed?.category);
      if(!category) {
        res.status(400).json({success: false, message: 'Missing/invalid "category"'});
        return;
      }

      const refId = typeof parsed?.refId === 'string' ? parsed!.refId!.trim() : '';
      if(!refId) {
        res.status(400).json({success: false, message: 'Missing "refId" for permanent delete'});
        return;
      }

      const metadata = parsed?.metadata ?? {};

      // RBAC
      const {role, username} = ((req as unknown) as AuthedReq).user;
      const mayDelete = role === 'admin' || role === 'operator' || role === 'manager';
      if(!mayDelete) {
        res.status(403).json({success: false, message: 'Permission denied'});
        return;
      }

      // Service call (no undefined issues here; refId is a definite string)
      const result = await this.service.permanentDeleteByCategory({
        category,
        refId,
        metadata,
        requestedBy: username,
      });

      // Socket emit for live updates
      if(result?.ok) {
        this.sockets.emitToRooms(
          result.rooms || [],
          'notification.permanent_delete',
          {category, refId, by: username}
        );
      }

      // Response
      res.json({
        success: !!result?.ok,
        message: result?.message || (result?.ok ? 'Permanently deleted' : 'Permanent delete failed'),
        category,
        refId,
      });
    } catch(err: any) {
      console.error('Error in permanent delete:', err);
      res.status(500).json({success: false, message: err?.message || 'Permanent delete error'});
    }
  };

  // ───────────────────────────────────────────────────────────────────────────
  // Restore data into database
  // ───────────────────────────────────────────────────────────────────────────

  private filterRestoreData(data: RestoreByCategoryInput) {
    console.log("Restore data into database: ", data)
  }
}
