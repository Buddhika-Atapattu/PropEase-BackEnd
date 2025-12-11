// src/controller/notification.controller.ts
// ─────────────────────────────────────────────────────────────────────────────
// Notification Controller (Express + TypeScript)
// - Lists + creates notifications
// - Marks read (one, many, all)
// - Restores and permanently deletes domain records by category+refId
// - Emits domain events over sockets
// - Creates dynamic notifications (title/body computed in the service) for
//   restore and permanent delete actions.
// - Aligns to exactOptionalPropertyTypes by conditionally spreading optionals.
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type RequestHandler } from "express";
import path from "path";
import fs from "fs";
import fsp from "fs/promises";

import NotificationService, {
  type RestoreByCategoryInput,
  type NotificationAudienceDTO,
} from "../services/notification.service";

// 👇 use the connection handler, not SocketServer
import { SocketConnectionHandler } from "../socket/socket-connection.handler";

import { Role, type AudienceMode } from "../types/roles";
import type { TitleCategory } from "../models/notifications/notification.model";

type AuthedReq = Express.Request & { user: { username: string; role: Role } };

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
    this.router.get("/", this.listMine);
    this.router.post("/create", this.create);
    this.router.post("/:id/read", this.markRead);
    this.router.post("/read-many", this.markManyRead);
    this.router.post("/read-all", this.markAllRead);
    this.router.post("/restore", this.restoreDelete);
    this.router.post("/permanent-delete", this.permanentDelete);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Helpers
  // ───────────────────────────────────────────────────────────────────────────

  private safeJoin(baseDir: string, ...parts: string[]): string {
    const base = path.resolve(baseDir);
    const target = path.resolve(baseDir, ...parts);
    if (!target.startsWith(base + path.sep) && target !== base) {
      throw new Error("Unsafe path detected (path traversal blocked).");
    }
    return target;
  }

  private async tryReadJsonSnapshot(
    relPath?: string,
  ): Promise<Record<string, any> | undefined> {
    try {
      if (!relPath || typeof relPath !== "string" || !relPath.trim()) {
        return undefined;
      }
      const absolute = this.safeJoin(BACKUP_ROOT, relPath.trim());
      if (!fs.existsSync(absolute)) return undefined;
      const data = await fsp.readFile(absolute, "utf8");
      const parsed = JSON.parse(data);
      return typeof parsed === "object" && parsed
        ? (parsed as Record<string, any>)
        : undefined;
    } catch {
      return undefined;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // GET /api-notification
  // ───────────────────────────────────────────────────────────────────────────

  private listMine: RequestHandler = async (req, res) => {
    try {
      const { username, role } = (req as unknown as AuthedReq).user;
      const { skip = "0", limit = "50", unread, category } = req.query as any;

      const normalizedCategory =
        typeof category === "string"
          ? this.normalizeCategory(category)
          : undefined;

      const filters = {
        skip: Number(skip),
        limit: Number(limit),
        onlyUnread: unread === "true",
        ...(normalizedCategory ? { category: normalizedCategory } : {}),
      } as const;

      const data = await this.service.listForUser(username, role, filters);
      res.status(200).json({ success: true, data });
    } catch (err: any) {
      console.error("[notifications:listMine] error:", err);
      res
        .status(500)
        .json({ success: false, message: err?.message || "List error" });
    }
  };

  private normalizeCategory(input?: string): TitleCategory | undefined {
    if (!input) return undefined;
    const s = input.trim().toLowerCase();
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
    };
    return map[s];
  }

  private defaultRecycleSnapshotPath(
    category: TitleCategory,
    refId: string,
  ): string {
    const root = "recyclebin";
    switch (category) {
      case "Property":
        return `${root}/properties/${encodeURIComponent(refId)}/data.json`;
      case "Tenant":
        return `${root}/tenants/${encodeURIComponent(refId)}/data.json`;
      case "User":
        return `${root}/users/${encodeURIComponent(refId)}/data.json`;
      default:
        return `${root}/${category.toLowerCase()}/${encodeURIComponent(
          refId,
        )}/data.json`;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // POST /api-notification/create
  // ───────────────────────────────────────────────────────────────────────────

  private create: RequestHandler = async (req, res) => {
    try {
      const allowed: ReadonlyArray<Role> = ["admin", "operator", "manager"];
      const { role } = (req as unknown as AuthedReq).user;
      if (!allowed.includes(role)) {
        res.status(403).json({ message: "Permission denied" });
        return;
      }

      const created = await this.service.createNotification(
        req.body,
        (rooms, payload) =>
          // 👇 now uses connection handler, and event name is `notification:new`
          this.sockets.emitToRooms(rooms, "notification:new", payload),
      );

      res.status(201).json({ success: true, data: created });
    } catch (err: any) {
      console.error("[notifications:create] error:", err);
      res
        .status(500)
        .json({ success: false, message: err?.message || "Create error" });
    }
  };

  // ───────────────────────────────────────────────────────────────────────────
  // POST /api-notification/:id/read
  // ───────────────────────────────────────────────────────────────────────────

  private markRead: RequestHandler = async (req, res) => {
    try {
      const { username } = (req as unknown as AuthedReq).user;
      const { id } = req.params;
      if (typeof id !== "string" || !id.trim()) {
        res
          .status(400)
          .json({ success: false, message: "Invalid notification ID" });
        return;
      }
      await this.service.markRead(username, id);
      res.status(200).json({ success: true });
    } catch (err: any) {
      console.error("[notifications:markRead] error:", err);
      res
        .status(500)
        .json({ success: false, message: err?.message || "Mark read error" });
    }
  };

  // ───────────────────────────────────────────────────────────────────────────
  // POST /api-notification/read-many
  // ───────────────────────────────────────────────────────────────────────────

  private markManyRead: RequestHandler = async (req, res) => {
    try {
      const { username } = (req as unknown as AuthedReq).user;
      const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
      if (!ids.length) {
        res
          .status(400)
          .json({ success: false, message: "Missing 'ids' array" });
        return;
      }
      await this.service.markManyRead(username, ids);
      res.status(200).json({ success: true });
    } catch (err: any) {
      console.error("[notifications:markManyRead] error:", err);
      res.status(500).json({
        success: false,
        message: err?.message || "Bulk mark read error",
      });
    }
  };

  // ───────────────────────────────────────────────────────────────────────────
  // POST /api-notification/read-all
  // ───────────────────────────────────────────────────────────────────────────

  private markAllRead: RequestHandler = async (_req, res) => {
    try {
      const { username } = (_req as unknown as AuthedReq).user;
      await this.service.markAllRead(username);
      res.status(200).json({ success: true });
    } catch (err: any) {
      console.error("[notifications:markAllRead] error:", err);
      res.status(500).json({
        success: false,
        message: err?.message || "Mark all read error",
      });
    }
  };

  // ───────────────────────────────────────────────────────────────────────────
  // POST /api-notification/restore
  // (unchanged logic – only uses sockets.emitToRooms same as above)
  // ───────────────────────────────────────────────────────────────────────────
  private restoreDelete: RequestHandler = async (req, res) => {
    try {
      const envelope =
        typeof (req.body as any)?.notification === "string"
          ? (req.body as any).notification
          : (req.body as any)?.notification
            ? JSON.stringify((req.body as any).notification)
            : undefined;

      const fallback =
        envelope == null && req.is("application/json")
          ? JSON.stringify(req.body)
          : undefined;

      const toParse = envelope ?? fallback;
      if (!toParse) {
        res.status(400).json({
          success: false,
          message:
            'Missing notification payload. Send JSON { notification: {...} } or FormData field "notification".',
        });
        return;
      }

      let parsed!: RestoreNotificationPayload;
      try {
        parsed = JSON.parse(toParse) as RestoreNotificationPayload;
      } catch {
        res
          .status(400)
          .json({ success: false, message: 'Invalid JSON in "notification"' });
        return;
      }

      const category = this.normalizeCategory(parsed?.category);
      if (!category) {
        res
          .status(400)
          .json({ success: false, message: 'Missing/invalid "category"' });
        return;
      }

      const refId =
        typeof parsed?.refId === "string" && parsed.refId.trim()
          ? parsed.refId.trim()
          : typeof parsed?.metadata?.refId === "string" &&
              parsed.metadata.refId.trim()
            ? parsed.metadata.refId.trim()
            : undefined;

      let snapshot =
        parsed?.snapshot && typeof parsed.snapshot === "object"
          ? parsed.snapshot
          : undefined;

      const explicitFilePath =
        typeof parsed?.metadata?.data?.filePath === "string" &&
            parsed.metadata.data.filePath.trim()
          ? parsed.metadata.data.filePath.trim()
          : typeof parsed?.metadata?.filePath === "string" &&
              parsed.metadata.filePath.trim()
            ? parsed.metadata.filePath.trim()
            : "";

      if (!snapshot && explicitFilePath) {
        snapshot = await this.tryReadJsonSnapshot(explicitFilePath);
      }

      if (!refId && !snapshot) {
        res.status(400).json({
          success: false,
          message:
            'Provide "refId" (top-level or metadata.refId) or a valid "snapshot" (or metadata.data.filePath).',
        });
        return;
      }

      const { role, username } = (req as unknown as AuthedReq).user;
      if (!(role === "admin" || role === "operator" || role === "manager")) {
        res.status(403).json({ success: false, message: "Permission denied" });
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
        this.sockets.emitToRooms(result.rooms || [], "notification.restore", {
          category,
          refId,
          by: username,
        });

        const audienceMode: AudienceMode = "role";
        const roles: NotificationAudienceDTO["roles"] = [
          "admin",
          "operator",
          "manager",
        ];

        const notifyArgs = {
          action: "restore" as const,
          category,
          refId: refId!,
          requestedBy: username,
          ...(snapshot ? { snapshot } : {}),
          audience: { mode: audienceMode, roles },
          source: "notification.controller:restore",
        };

        await this.service.notifyDomainAction(notifyArgs);
      }

      res.status(200).json({
        success: !!result?.ok,
        message:
          result?.message || (result?.ok ? "Restored" : "Restore failed"),
        category,
        refId,
        restored: result?.restored ?? undefined,
      });
    } catch (err: any) {
      console.error("[notifications:restore] error:", err);
      res
        .status(500)
        .json({ success: false, message: err?.message || "Restore error" });
    }
  };

  // ───────────────────────────────────────────────────────────────────────────
  // POST /api-notification/permanent-delete
  // (same pattern; still uses sockets.emitToRooms)
  // ───────────────────────────────────────────────────────────────────────────
  private permanentDelete: RequestHandler = async (req, res) => {
    try {
      const envelope =
        typeof (req.body as any)?.notification === "string"
          ? (req.body as any).notification
          : (req.body as any)?.notification
            ? JSON.stringify((req.body as any).notification)
            : undefined;

      const fallback =
        envelope == null && req.is("application/json")
          ? JSON.stringify(req.body)
          : undefined;

      const toParse = envelope ?? fallback;
      if (!toParse) {
        res.status(400).json({
          success: false,
          message:
            'Missing notification payload. Send JSON { notification: {...} } or FormData field "notification".',
        });
        return;
      }

      let parsed!: PermanentDeletePayload;
      try {
        parsed = JSON.parse(toParse) as PermanentDeletePayload;
      } catch {
        res
          .status(400)
          .json({ success: false, message: 'Invalid JSON in "notification"' });
        return;
      }

      const category = this.normalizeCategory(parsed?.category);
      if (!category) {
        res
          .status(400)
          .json({ success: false, message: 'Missing/invalid "category"' });
        return;
      }

      const refId =
        typeof parsed?.refId === "string" && parsed.refId.trim()
          ? parsed.refId.trim()
          : typeof parsed?.metadata?.refId === "string" &&
              parsed.metadata.refId.trim()
            ? parsed.metadata.refId.trim()
            : "";

      if (!refId) {
        res.status(400).json({
          success: false,
          message: 'Missing "refId" (top-level or metadata.refId).',
        });
        return;
      }

      const { role, username } = (req as unknown as AuthedReq).user;
      if (!(role === "admin")) {
        res.status(403).json({ success: false, message: "Permission denied" });
        return;
      }

      const result = await this.service.permanentDeleteByCategory({
        category,
        refId,
        ...(parsed?.metadata ? { metadata: parsed.metadata } : {}),
        requestedBy: username,
      });

      if (result?.ok) {
        this.sockets.emitToRooms(
          result.rooms || [],
          "notification.permanent_delete",
          {
            category,
            refId,
            by: username,
          },
        );

        const audienceMode: AudienceMode = "role";
        const roles: NotificationAudienceDTO["roles"] = [
          "admin",
          "operator",
          "manager",
        ];

        const notifyArgs = {
          action: "permanent_delete" as const,
          category,
          refId,
          requestedBy: username,
          audience: { mode: audienceMode, roles },
          source: "notification.controller:permanent_delete",
        };

        await this.service.notifyDomainAction(notifyArgs);
      }

      res.status(200).json({
        success: !!result?.ok,
        message:
          result?.message ||
          (result?.ok ? "Permanently deleted" : "Permanent delete failed"),
        category,
        refId,
      });
    } catch (err: any) {
      console.error("[notifications:permanentDelete] error:", err);
      res.status(500).json({
        success: false,
        message: err?.message || "Permanent delete error",
      });
    }
  };
}
