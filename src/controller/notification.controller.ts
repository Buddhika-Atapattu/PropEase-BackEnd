// src/controller/notification.controller.ts
// ─────────────────────────────────────────────────────────────────────────────
// NotificationController (Improved)
// - Uses ApiResponseBuilder consistently (no raw res.status().json())
// - Adds strict validation helpers (exactOptionalPropertyTypes-safe)
// - Unifies parsing of "notification" envelope for JSON + FormData
// - Centralizes permission checks (admin/operator/manager)
// - Centralizes socket emissions + domain-action notifications
//
// IMPORTANT:
// - Always follow your project rule: `res.status(...).json(...); return;`
// - Never pass undefined for optional props: use conditional spreads.
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type RequestHandler, type Request, type Response } from "express";
import path from "path";
import fs from "fs";
import fsp from "fs/promises";

import NotificationService, {
  type RestoreByCategoryInput,
  type NotificationAudienceDTO,
} from "../services/notification.service";

import { SocketConnectionHandler } from "../socket/socket-connection.handler";

import { Role, type AudienceMode } from "../types/roles";
import type { TitleCategory } from "../models/notifications/notification.model";
import { ApiResponseBuilder } from "../utils/api-combiner.builder";

type AuthedReq = Express.Request & { user: { username: string; role: Role } };

// Payload shapes coming from UI (notification envelope)
type RestoreNotificationPayload = {
  _id?: string;
  category?: string;
  refId?: string;
  snapshot?: Record<string, any>;
  metadata?: {
    refId?: string;
    data?: Record<string, any>;
    filePath?: string;
  };
};

type PermanentDeletePayload = {
  _id?: string;
  category?: string;
  refId?: string;
  metadata?: {
    refId?: string;
    data?: Record<string, any>;
  };
};

const BACKUP_ROOT = (() => {
  const env = (process.env.RESTORE_ROOT || "").trim();
  return env ? path.resolve(env) : path.join(process.cwd(), "backups");
})();

export default class NotificationController {
  public readonly router = Router();

  public constructor(
    private readonly service: NotificationService,
    private readonly sockets: SocketConnectionHandler,
  ) {
    // IMPORTANT: keep routes stable
    this.router.get("/", this.listMine);
    this.router.post("/create", this.create);
    this.router.post("/:id/read", this.markRead);
    this.router.post("/read-many", this.markManyRead);
    this.router.post("/read-all", this.markAllRead);
    this.router.post("/restore", this.restoreDelete);
    this.router.post("/permanent-delete", this.permanentDelete);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Small validation helpers
  // ───────────────────────────────────────────────────────────────────────────

  private getAuthedUser( req: Request ): { username: string; role: Role; } {
    const user = ( req as unknown as AuthedReq ).user;
    if ( !user?.username || !user?.role ) {
      throw new Error( "Authenticated user context missing (req.user)." );
    }
    return user;
  }

  private requireRole(
    res: Response,
    role: Role,
    allowed: ReadonlyArray<Role>,
    context: string,
  ): boolean {
    if ( !allowed.includes( role ) ) {
      ApiResponseBuilder.error( res, 403, `[${ context }] Permission denied.` );
      return false;
    }
    return true;
  }

  private safeString( v: unknown ): string {
    return typeof v === "string" ? v.trim() : "";
  }

  private safeNumber( v: unknown, fallback: number ): number {
    const n = typeof v === "string" ? Number( v ) : typeof v === "number" ? v : NaN;
    return Number.isFinite( n ) ? n : fallback;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Safe path helpers (used for reading snapshots)
  // ───────────────────────────────────────────────────────────────────────────

  private safeJoin(baseDir: string, ...parts: string[]): string {
    const base = path.resolve(baseDir);
    const target = path.resolve(baseDir, ...parts);
    if (!target.startsWith(base + path.sep) && target !== base) {
      throw new Error("Unsafe path detected (path traversal blocked).");
    }
    return target;
  }

  private async tryReadJsonSnapshot( relPath?: string ): Promise<Record<string, any> | undefined> {
    try {
      const rel = this.safeString( relPath );
      if ( !rel ) return undefined;

      const absolute = this.safeJoin( BACKUP_ROOT, rel );
      if (!fs.existsSync(absolute)) return undefined;

      const data = await fsp.readFile(absolute, "utf8");
      const parsed = JSON.parse(data);
      return typeof parsed === "object" && parsed ? ( parsed as Record<string, any> ) : undefined;
    } catch {
      return undefined;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Notification envelope parser (JSON + FormData compatibility)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * UI sometimes sends:
   * - JSON: { category, refId, ... }
   * - FormData: field "notification" = JSON string
   *
   * This method normalizes both into an object.
   */
  private parseNotificationEnvelope<T extends object>( req: Request ): T {
    const bodyAny = req.body as any;

    // If body.notification exists:
    // - if it's a string => parse JSON
    // - else => use it directly (object) but clone via JSON.stringify/parse to normalize
    const raw =
      typeof bodyAny?.notification === "string"
        ? bodyAny.notification
        : bodyAny?.notification
          ? JSON.stringify( bodyAny.notification )
          : undefined;

    // If not, and content-type is JSON, allow direct body as payload
    const fallback =
      raw == null && req.is( "application/json" ) ? JSON.stringify( bodyAny ) : undefined;

    const toParse = raw ?? fallback;
    if ( !toParse ) {
      throw new Error(
        'Missing notification payload. Send JSON body or FormData field "notification".',
      );
    }

    try {
      const parsed = JSON.parse( toParse ) as T;
      if ( !parsed || typeof parsed !== "object" ) throw new Error( "payload is not an object" );
      return parsed;
    } catch {
      throw new Error( 'Invalid JSON in "notification" payload.' );
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Category normalization
  // ───────────────────────────────────────────────────────────────────────────

  private normalizeCategory(input?: string): TitleCategory | undefined {
    const s = this.safeString( input ).toLowerCase();
    if ( !s ) return undefined;

    const map: Record<string, TitleCategory> = {
      user: "User",
      tenant: "Tenant",
      property: "Property",
      lease: "Lease",
      agent: "Agent",
      developer: "Developer",
      maintenance: "Maintenance",
      complaint: "Complaint",
      team: "Team",
      registration: "Registration",
      payment: "Payment",
      system: "System",
      comment: "Comment",
    };

    return map[s];
  }

  // ───────────────────────────────────────────────────────────────────────────
  // GET /api-notification
  // ───────────────────────────────────────────────────────────────────────────

  private listMine: RequestHandler = async ( req, res ) => {
    try {
      const { username, role } = this.getAuthedUser( req );

      const q = req.query as any;
      const skip = this.safeNumber( q?.skip, 0 );
      const limit = this.safeNumber( q?.limit, 50 );

      const onlyUnread = String( q?.unread ?? "" ).toLowerCase() === "true";
      const normalizedCategory =
        typeof q?.category === "string" ? this.normalizeCategory( q.category ) : undefined;

      const filters = {
        skip,
        limit,
        onlyUnread,
        ...( normalizedCategory ? { category: normalizedCategory } : {} ),
      } as const;

      const data = await this.service.listForUser( username, role, filters );

      ApiResponseBuilder.ok( res, "other", { data }, "[notifications:listMine] Success!" );
      return;
    } catch ( err: unknown ) {
      console.error( "[Error:] [NotificationController] listMine failed.\n", err, "\n" );
      ApiResponseBuilder.internalError(
        res,
        String( ( err as Error )?.message ?? "Failed to list notifications." ),
      );
      return;
    }
  };

  // ───────────────────────────────────────────────────────────────────────────
  // POST /api-notification/create
  // ───────────────────────────────────────────────────────────────────────────

  private create: RequestHandler = async (req, res) => {
    try {
      const { role } = this.getAuthedUser( req );

      const allowed: ReadonlyArray<Role> = ["admin", "operator", "manager"];
      if ( !this.requireRole( res, role, allowed, "notifications:create" ) ) return;

      // Service validates audience + creates the notification.
      const created = await this.service.createNotification(
        req.body,
        ( rooms, payload ) => this.sockets.emitToRooms( rooms, "notification:new", payload ),
      );

      ApiResponseBuilder.ok( res, "other", { created }, "[notifications:create] Created." );
      return;
    } catch ( err: unknown ) {
      console.error( "[Error:] [NotificationController] create failed.\n", err, "\n" );
      ApiResponseBuilder.internalError(
        res,
        String( ( err as Error )?.message ?? "Failed to create notification." ),
      );
      return;
    }
  };

  // ───────────────────────────────────────────────────────────────────────────
  // POST /api-notification/:id/read
  // ───────────────────────────────────────────────────────────────────────────

  private markRead: RequestHandler = async (req, res) => {
    try {
      const { username } = this.getAuthedUser( req );

      const id = this.safeString( req.params?.id );
      if ( !id ) {
        ApiResponseBuilder.validationError( res, "Invalid notification ID." );
        return;
      }

      await this.service.markRead(username, id);

      ApiResponseBuilder.ok( res, "other", { id }, "[notifications:markRead] Marked read." );
      return;
    } catch ( err: unknown ) {
      console.error( "[Error:] [NotificationController] markRead failed.\n", err, "\n" );
      ApiResponseBuilder.internalError(
        res,
        String( ( err as Error )?.message ?? "Failed to mark as read." ),
      );
      return;
    }
  };

  // ───────────────────────────────────────────────────────────────────────────
  // POST /api-notification/read-many
  // ───────────────────────────────────────────────────────────────────────────

  private markManyRead: RequestHandler = async (req, res) => {
    try {
      const { username } = this.getAuthedUser( req );

      const ids: string[] = Array.isArray( ( req.body as any )?.ids )
        ? ( req.body as any ).ids.map( ( x: unknown ) => this.safeString( x ) ).filter( Boolean )
        : [];

      if (!ids.length) {
        ApiResponseBuilder.validationError( res, "Missing 'ids' array." );
        return;
      }

      await this.service.markManyRead(username, ids);

      ApiResponseBuilder.ok(
        res,
        "other",
        { count: ids.length },
        "[notifications:markManyRead] Updated.",
      );
      return;
    } catch ( err: unknown ) {
      console.error( "[Error:] [NotificationController] markManyRead failed.\n", err, "\n" );
      ApiResponseBuilder.internalError(
        res,
        String( ( err as Error )?.message ?? "Failed to mark many as read." ),
      );
      return;
    }
  };

  // ───────────────────────────────────────────────────────────────────────────
  // POST /api-notification/read-all
  // ───────────────────────────────────────────────────────────────────────────

  private markAllRead: RequestHandler = async ( req, res ) => {
    try {
      const { username } = this.getAuthedUser( req );

      await this.service.markAllRead(username);

      ApiResponseBuilder.ok( res, "other", { username }, "[notifications:markAllRead] Updated." );
      return;
    } catch ( err: unknown ) {
      console.error( "[Error:] [NotificationController] markAllRead failed.\n", err, "\n" );
      ApiResponseBuilder.internalError(
        res,
        String( ( err as Error )?.message ?? "Failed to mark all as read." ),
      );
      return;
    }
  };

  // ───────────────────────────────────────────────────────────────────────────
  // POST /api-notification/restore
  // ───────────────────────────────────────────────────────────────────────────

  private restoreDelete: RequestHandler = async (req, res) => {
    try {
      const { role, username } = this.getAuthedUser( req );

      const allowed: ReadonlyArray<Role> = [ "admin", "operator", "manager" ];
      if ( !this.requireRole( res, role, allowed, "notifications:restore" ) ) return;

      const parsed = this.parseNotificationEnvelope<RestoreNotificationPayload>( req );

      const category = this.normalizeCategory(parsed?.category);
      if (!category) {
        ApiResponseBuilder.validationError( res, 'Missing/invalid "category".' );
        return;
      }

      const refIdFromTop = this.safeString( parsed?.refId );
      const refIdFromMeta = this.safeString( parsed?.metadata?.refId );
      const refId = refIdFromTop || refIdFromMeta || "";

      let snapshot =
        parsed?.snapshot && typeof parsed.snapshot === "object" ? parsed.snapshot : undefined;

      // Optional: read snapshot from backups if UI provided a filePath
      const explicitFilePath =
        this.safeString( parsed?.metadata?.data?.filePath ) ||
        this.safeString( parsed?.metadata?.filePath );

      if (!snapshot && explicitFilePath) {
        snapshot = await this.tryReadJsonSnapshot(explicitFilePath);
      }

      // You allow restore with either refId or snapshot
      if (!refId && !snapshot) {
        ApiResponseBuilder.validationError(
          res,
          'Provide "refId" (top-level or metadata.refId) or "snapshot" (or metadata.data.filePath).',
        );
        return;
      }

      const restoreInput: RestoreByCategoryInput = {
        category,
        requestedBy: username,
        ...(refId ? { refId } : {}),
        ...(snapshot ? { snapshot } : {}),
        ...(parsed?.metadata ? { metadata: parsed.metadata } : {}),
      };

      const result = await this.service.restoreByCategory(restoreInput);

      if (result?.ok) {
        // Emit a domain event to refresh UIs
        this.sockets.emitToRooms(result.rooms || [], "notification.restore", {
          category,
          refId: refId || "(generated)",
          by: username,
        });

        // ALSO create a dynamic "domain action" notification (optional but consistent)
        const audienceMode: AudienceMode = "role";
        const roles: NotificationAudienceDTO[ "roles" ] = [ "admin", "operator", "manager" ];

        await this.service.notifyDomainAction( {
          action: "restore",
          category,
          refId: refId || String( result?.restored?._id ?? "" ),
          requestedBy: username,
          ...(snapshot ? { snapshot } : {}),
          audience: { mode: audienceMode, roles },
          source: "notification.controller:restore",
        } );
      }

      ApiResponseBuilder.ok(
        res,
        "other",
        {
          ok: !!result?.ok,
          message: result?.message || ( result?.ok ? "Restored" : "Restore failed" ),
          category,
          refId: refId || undefined,
          restored: result?.restored,
        },
        "[notifications:restore] Done.",
      );
      return;
    } catch ( err: unknown ) {
      console.error( "[Error:] [NotificationController] restoreDelete failed.\n", err, "\n" );
      ApiResponseBuilder.internalError(
        res,
        String( ( err as Error )?.message ?? "Failed to restore." ),
      );
      return;
    }
  };

  // ───────────────────────────────────────────────────────────────────────────
  // POST /api-notification/permanent-delete
  // ───────────────────────────────────────────────────────────────────────────

  private permanentDelete: RequestHandler = async (req, res) => {
    try {
      const { role, username } = this.getAuthedUser( req );

      // In your original logic: permanent delete admin-only
      const allowed: ReadonlyArray<Role> = [ "admin" ];
      if ( !this.requireRole( res, role, allowed, "notifications:permanentDelete" ) ) return;

      const parsed = this.parseNotificationEnvelope<PermanentDeletePayload>( req );

      const category = this.normalizeCategory(parsed?.category);
      if (!category) {
        ApiResponseBuilder.validationError( res, 'Missing/invalid "category".' );
        return;
      }

      const refIdFromTop = this.safeString( parsed?.refId );
      const refIdFromMeta = this.safeString( parsed?.metadata?.refId );
      const refId = refIdFromTop || refIdFromMeta;

      if (!refId) {
        ApiResponseBuilder.validationError( res, 'Missing "refId" (top-level or metadata.refId).' );
        return;
      }

      const result = await this.service.permanentDeleteByCategory({
        category,
        refId,
        ...(parsed?.metadata ? { metadata: parsed.metadata } : {}),
        requestedBy: username,
      });

      if (result?.ok) {
        this.sockets.emitToRooms( result.rooms || [], "notification.permanent_delete", {
          category,
          refId,
          by: username,
        } );

        const audienceMode: AudienceMode = "role";
        const roles: NotificationAudienceDTO[ "roles" ] = [ "admin", "operator", "manager" ];

        await this.service.notifyDomainAction( {
          action: "permanent_delete",
          category,
          refId,
          requestedBy: username,
          audience: { mode: audienceMode, roles },
          source: "notification.controller:permanent_delete",
        } );
      }

      ApiResponseBuilder.ok(
        res,
        "other",
        {
          ok: !!result?.ok,
          message:
            result?.message || ( result?.ok ? "Permanently deleted" : "Permanent delete failed" ),
          category,
          refId,
        },
        "[notifications:permanentDelete] Done.",
      );
      return;
    } catch ( err: unknown ) {
      console.error( "[Error:] [NotificationController] permanentDelete failed.\n", err, "\n" );
      ApiResponseBuilder.internalError(
        res,
        String( ( err as Error )?.message ?? "Failed to permanently delete." ),
      );
      return;
    }
  };
}
