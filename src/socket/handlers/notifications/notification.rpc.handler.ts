// Path: src/socket/handlers/notifications/notification.rpc.handler.ts
// =============================================================================
// Notification WS RPC Handler (ACK-based) — FIXED + ALIGNED (io/namespace)
// =============================================================================

import type { TypedNamespace, TypedSocket } from "../../socket-types.type";
import type { AuthUser } from "../../../types/common";
import type { Role } from "../../../types/roles";

import { NotificationRestService } from "../../../services/notifications/notification.rest.service";

import {
  NOTIFICATION_AUDIENCE_MODE_VALUES,
  NOTIFICATION_CATEGORY_VALUES,
  NOTIFICATION_SEVERITY_VALUES,
  type NotificationCategory,
  type NotificationLoadFilters,
  type NotificationLoadRequest,
  type NotificationSeverity,
} from "../../../types/notification/notification.types";

import {
  NotificationRpcEvents,
  type WsAck,
  type WsInboxListReq,
  type WsInboxListRes,
  type WsInboxCountsReq,
  type WsInboxCountsRes,
  type WsMarkReadReq,
  type WsMarkReadRes,
  type WsMarkAllReadReq,
  type WsMarkAllReadRes,
  type NotificationScope,
  type NotificationPriorityScope,
} from "../../events/notifications/notification.rpc.events";

import { DEFAULT_ROLES } from "../../../models/user.model";
import { MongoIdUtil } from "../../../utils/mongo-id.util";

// Keeping local types is fine.
type WsArchiveOneReq = { inboxId: string };
type WsArchiveOneRes = { changed: boolean };

export class NotificationRpcHandler {
  private readonly rest: NotificationRestService;

  // ✅ Hardening: prevent duplicate attach
  private bound = false;

  public constructor() {
    this.rest = new NotificationRestService();
  }

  public bind(io: TypedNamespace): void {
    if (this.bound) {
      // eslint-disable-next-line no-console
      console.warn("[Warning:] [NotificationRpcHandler] bind() already attached. Skipping.\n");
      return;
    }
    this.bound = true;

    io.on("connection", (socket: TypedSocket) => {
      this.bindInboxList(socket);
      this.bindInboxCounts(socket);
      this.bindMarkRead(socket);
      this.bindMarkAllRead(socket);
      this.bindArchiveOne(socket);
    });

    // eslint-disable-next-line no-console
    console.log("[Info:] [NotificationRpcHandler] bind() attached to namespace.\n");
  }

  // =============================================================================
  // A) Event binders
  // =============================================================================

  private bindInboxList(socket: TypedSocket): void {
    socket.on(
      NotificationRpcEvents.INBOX_LIST,
      async (req: unknown, ack?: (res: WsAck<WsInboxListRes>) => void): Promise<void> => {
        const safeAck = this.safeAck(ack);

        try {
          const { userId, username, roleKey } = this.readAuth(socket);
          const body = this.safeInboxListReq(req);

          const request: NotificationLoadRequest = {
            username,
            page: body.page,
            limit: body.limit,
            filters: body.filters,
          };

          const data = await this.rest.loadInboxByScope({
            userId,
            username,
            roleKey,
            scope: body.scope,
            priorityScope: body.priorityScope,
            request,
          });

          safeAck({ ok: true, data: { items: data.items, other: data.other } });
          return;
        } catch (e: unknown) {
          safeAck({ ok: false, message: this.errMsg(e, "Failed to load inbox") });
          return;
        }
      }
    );
  }

  private bindInboxCounts(socket: TypedSocket): void {
    socket.on(
      NotificationRpcEvents.INBOX_COUNTS,
      async (req: unknown, ack?: (res: WsAck<WsInboxCountsRes>) => void): Promise<void> => {
        const safeAck = this.safeAck(ack);

        try {
          const { userId, username, roleKey } = this.readAuth(socket);
          const body = this.safeInboxCountsReq(req);

          // fallback: compute counts via `other` from loadInboxByScope
          const request: NotificationLoadRequest = {
            username,
            page: 1,
            limit: 1,
            filters: body.filters,
          };

          const data = await this.rest.loadInboxByScope({
            userId,
            username,
            roleKey,
            scope: body.scope,
            priorityScope: body.priorityScope,
            request,
          });

          safeAck({
            ok: true,
            data: {
              total: data.other.total,
              unread: data.other.unread,
              prioritized: data.other.prioritized,
              unprioritized: data.other.unprioritized,
            },
          });
          return;
        } catch (e: unknown) {
          safeAck({ ok: false, message: this.errMsg(e, "Failed to count inbox") });
          return;
        }
      }
    );
  }

  private bindMarkRead(socket: TypedSocket): void {
    socket.on(
      NotificationRpcEvents.MARK_READ,
      async (req: unknown, ack?: (res: WsAck<WsMarkReadRes>) => void): Promise<void> => {
        const safeAck = this.safeAck(ack);

        try {
          const { userId, username } = this.readAuth(socket);
          const body = this.safeMarkReadReq(req);

          const result = await this.rest.markRead({ userId, username, inboxId: body.inboxId });
          safeAck({ ok: true, data: { changed: result.changed } });
          return;
        } catch (e: unknown) {
          safeAck({ ok: false, message: this.errMsg(e, "Failed to mark read") });
          return;
        }
      }
    );
  }

  private bindMarkAllRead(socket: TypedSocket): void {
    socket.on(
      NotificationRpcEvents.MARK_ALL_READ,
      async (_req: WsMarkAllReadReq, ack?: (res: WsAck<WsMarkAllReadRes>) => void): Promise<void> => {
        const safeAck = this.safeAck(ack);

        try {
          const { userId, username } = this.readAuth(socket);

          const result = await this.rest.markAllRead({ userId, username });
          safeAck({ ok: true, data: { changedCount: result.changedCount } });
          return;
        } catch (e: unknown) {
          safeAck({ ok: false, message: this.errMsg(e, "Failed to mark all read") });
          return;
        }
      }
    );
  }

  private bindArchiveOne(socket: TypedSocket): void {
    socket.on(
      NotificationRpcEvents.ARCHIVE_ONE,
      async (req: unknown, ack?: (res: WsAck<WsArchiveOneRes>) => void): Promise<void> => {
        const safeAck = this.safeAck(ack);

        try {
          const { userId, username } = this.readAuth(socket);
          const body = this.safeArchiveReq(req);

          const result = await this.rest.archiveOne({ userId, username, inboxId: body.inboxId });
          safeAck({ ok: true, data: { changed: result.changed } });
          return;
        } catch (e: unknown) {
          safeAck({ ok: false, message: this.errMsg(e, "Failed to archive") });
          return;
        }
      }
    );
  }

  // =============================================================================
  // B) Auth boundary
  // =============================================================================

  private readAuth(socket: TypedSocket): { userId: string, username: string; roleKey: Role } {
    const auth = socket.data.authUser as AuthUser | undefined;

    const userId: string = MongoIdUtil.toIdString(auth?.userId);
    const username: string = this.safeUsername(auth?.username);
    const roleKey: Role = this.safeRole(auth?.role);


    return { userId, username, roleKey };
  }

  // =============================================================================
  // C) Sanitizers
  // =============================================================================

  private safeAck<T>(ack?: (res: WsAck<T>) => void): (res: WsAck<T>) => void {
    return typeof ack === "function" ? ack : () => undefined;
  }

  private safeUsername(v: unknown): string {
    const s = typeof v === "string" ? v.trim() : "";
    if (!s) throw new Error("NotificationRpcHandler: unauthenticated (username missing).");
    return s;
  }

  private safeRole(v: unknown): Role {
    const s = typeof v === "string" ? v.trim() : "";

    if (!s) {
      throw new Error("NotificationRpcHandler: unauthenticated (role missing).");
    }

    const roleFound = DEFAULT_ROLES.find((r) => r.toLowerCase() === s.toLowerCase());

    if (!roleFound) {
      throw new Error("NotificationRpcHandler: unauthenticated (invalid role).");
    }

    // ✅ If DEFAULT_ROLES is Role[], this is already Role.
    // ✅ If it's string[], we cast only after validation.
    return roleFound as Role;
  }

  private safeInboxListReq(v: unknown): WsInboxListReq {
    const raw = this.asObj(v);

    const scope = this.safeScope(raw["scope"]);
    const priorityScope = this.safePriorityScope(raw["priorityScope"]);

    const page = this.safePage(raw["page"]);
    const limit = this.safeLimit(raw["limit"]);

    const filters = this.safeFilters(raw["filters"]);

    return { scope, priorityScope, page, limit, filters };
  }

  private safeInboxCountsReq(v: unknown): WsInboxCountsReq {
    const raw = this.asObj(v);

    const scope = this.safeScope(raw["scope"]);
    const priorityScope = this.safePriorityScope(raw["priorityScope"]);
    const filters = this.safeFilters(raw["filters"]);

    return { scope, priorityScope, filters };
  }

  private safeMarkReadReq(v: unknown): WsMarkReadReq {
    const raw = this.asObj(v);
    const inboxId = typeof raw["inboxId"] === "string" ? raw["inboxId"].trim() : "";
    if (!inboxId) throw new Error("NotificationRpcHandler: inboxId is required.");
    return { inboxId };
  }

  private safeArchiveReq(v: unknown): WsArchiveOneReq {
    return this.safeMarkReadReq(v);
  }

  private safeScope(v: unknown): NotificationScope {
    return v === "user" || v === "role" || v === "company" ? v : "user";
  }

  private safePriorityScope(v: unknown): NotificationPriorityScope {
    return v === "all" || v === "prioritized" || v === "unprioritized" ? v : "all";
  }

  private safeFilters(v: unknown): NotificationLoadFilters {
    const raw = this.asObj(v);

    const out: NotificationLoadFilters = {};

    const categoryRaw = typeof raw["category"] === "string" ? raw["category"].trim() : "";
    const category = this.tryCategory(categoryRaw);
    if (category) out.category = category;

    const severityRaw = typeof raw["severity"] === "string" ? raw["severity"].trim() : "";
    const severity = this.trySeverity(severityRaw);
    if (severity) out.severity = severity;

    const modeRaw = typeof raw["mode"] === "string" ? raw["mode"].trim() : "";
    const mode = this.tryMode(modeRaw);
    if (mode) out.mode = mode;

    const search = typeof raw["search"] === "string" ? raw["search"].trim() : "";
    if (search) out.search = search;

    const from = typeof raw["from"] === "string" ? raw["from"].trim() : "";
    if (from) out.from = from;

    const to = typeof raw["to"] === "string" ? raw["to"].trim() : "";
    if (to) out.to = to;

    if (typeof raw["unreadOnly"] === "boolean") out.unreadOnly = raw["unreadOnly"];
    if (typeof raw["includeDeleted"] === "boolean") out.includeDeleted = raw["includeDeleted"];
    if (typeof raw["includeArchived"] === "boolean") out.includeArchived = raw["includeArchived"];

    return out;
  }

  // permissive: invalid values are ignored (undefined)
  private tryMode(v: unknown): NotificationLoadFilters["mode"] | undefined {
    const t = typeof v === "string" ? v.trim() : "";
    if (!t) return undefined;

    return NOTIFICATION_AUDIENCE_MODE_VALUES.find((m) => m.toLowerCase() === t.toLowerCase());
  }

  private trySeverity(v: unknown): NotificationSeverity | undefined {
    const t = typeof v === "string" ? v.trim() : "";
    if (!t) return undefined;

    return NOTIFICATION_SEVERITY_VALUES.find((s) => s.toLowerCase() === t.toLowerCase());
  }

  private tryCategory(v: unknown): NotificationCategory | undefined {
    const t = typeof v === "string" ? v.trim() : "";
    if (!t) return undefined;

    return NOTIFICATION_CATEGORY_VALUES.find((c) => c.toLowerCase() === t.toLowerCase());
  }

  private safePage(v: unknown): number {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 1) return 1;
    return Math.floor(n);
  }

  private safeLimit(v: unknown): number {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 1) return 10;
    return Math.min(Math.floor(n), 100);
  }

  private asObj(v: unknown): Record<string, unknown> {
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  }

  private errMsg(e: unknown, fallback: string): string {
    return e instanceof Error ? e.message : fallback;
  }
}