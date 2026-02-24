// Path: src/socket/gatewats/notifications/notification.rpc.gateway.ts
// =============================================================================
// Notification Hub — WebSocket RPC Gateway
// -----------------------------------------------------------------------------
// PURPOSE
// - Expose ALL notification operations over WebSocket (WS-first).
// - Uses Socket.IO ACK callbacks for request→response style.
// - REST remains as backup layer, but WS has full coverage.
//
// ASSUMPTIONS
// - Socket auth middleware sets socket.data.auth = { username, role }
// - If your project uses a different location, update readAuth() only.
//
// IMPORTANT
// - We attach to a *Namespace* because your SocketServer.attach() returns Namespace
//   (TypedNamespace). Do NOT require the full Socket.IO Server here.
// =============================================================================

import type { Socket, Namespace } from "socket.io";

import type { Role } from "../../../types/roles";
import type {
  NotificationLoadRequest,
  NotificationLoadFilters,
} from "../../../types/notification/notification.types";

import {
  NotificationRpcEvents,
  type WsAck,
  type WsInboxCountsReq,
  type WsInboxCountsRes,
  type WsInboxListReq,
  type WsInboxListRes,
  type WsMarkAllReadRes,
  type WsMarkReadReq,
  type WsMarkReadRes,
  type NotificationScope,
  type NotificationPriorityScope,
} from "../../events/notifications/notification.rpc.events";

import { NotificationQueryService } from "../../../services/notifications/notification.query.service";
import { NotificationHubEngineService } from "../../../services/notifications/notification-hub-engine.service";
import { NotificationSocketService } from "../../../services/notifications/notification.socket.service";

interface SocketAuthShape {
  username: string;
  role: Role;
}

/**
 * Gateway is class-based and attachable from socket bootstrap:
 *
 *   const ioNs: TypedNamespace = await socketServer.attach(httpServer);
 *   new NotificationRpcGateway().attach(ioNs);
 */
export class NotificationRpcGateway {
  private readonly query: NotificationQueryService;
  private readonly hub: NotificationHubEngineService;
  private readonly wsEmit: NotificationSocketService;

  public constructor() {
    this.query = new NotificationQueryService();
    this.hub = new NotificationHubEngineService();
    this.wsEmit = new NotificationSocketService();
  }

  /**
   * Attach all RPC listeners to the Socket.IO namespace returned by SocketServer.attach().
   *
   * @param ioNs
   * - Expected: Socket.IO Namespace (your bootstrap returns TypedNamespace)
   * - Why Namespace: TypedNamespace is NOT a SocketIOServer, so it cannot satisfy Server typing.
   */
  public attach(ioNs: Namespace): void {
    ioNs.on("connection", (socket: Socket) => {
      this.bindInboxList(socket);
      this.bindInboxCounts(socket);
      this.bindMarkRead(socket);
      this.bindMarkAllRead(socket);
    });
  }

  /* ======================================================================= */
  /* 1) LIST                                                                  */
  /* ======================================================================= */

  private bindInboxList(socket: Socket): void {
    socket.on(
      NotificationRpcEvents.INBOX_LIST,
      async (req: WsInboxListReq, ack: (res: WsAck<WsInboxListRes>) => void) => {
        try {
          const auth = this.readAuth(socket);
          const safeReq = this.safeListReq(req);

          const loadReq: NotificationLoadRequest = {
            username: auth.username,
            page: safeReq.page,
            limit: safeReq.limit,
            filters: safeReq.filters,
          };

          const payload = await this.query.loadInboxForUserByScope(
            auth.username,
            auth.role,
            safeReq.scope,
            safeReq.priorityScope,
            loadReq,
            undefined
          );

          ack({ ok: true, data: payload });
        } catch (err: unknown) {
          ack({ ok: false, message: this.errMsg(err) });
        }
      }
    );
  }

  /* ======================================================================= */
  /* 2) COUNTS                                                                */
  /* ======================================================================= */

  private bindInboxCounts(socket: Socket): void {
    socket.on(
      NotificationRpcEvents.INBOX_COUNTS,
      async (req: WsInboxCountsReq, ack: (res: WsAck<WsInboxCountsRes>) => void) => {
        try {
          const auth = this.readAuth(socket);
          const safeReq = this.safeCountsReq(req);

          // ✅ Counts must respect the same filters used in list requests
          const counts = await this.query.countInboxForUserWithScopes(
            auth.username,
            auth.role,
            safeReq.filters,
            undefined
          );

          ack({ ok: true, data: counts });
        } catch (err: unknown) {
          ack({ ok: false, message: this.errMsg(err) });
        }
      }
    );
  }

  /* ======================================================================= */
  /* 3) MARK READ                                                             */
  /* ======================================================================= */

  private bindMarkRead(socket: Socket): void {
    socket.on(
      NotificationRpcEvents.MARK_READ,
      async (req: WsMarkReadReq, ack: (res: WsAck<WsMarkReadRes>) => void) => {
        try {
          const auth = this.readAuth(socket);
          const inboxId = this.safeId(req?.inboxId, "inboxId");

          const changed = await this.hub.markRead(auth.username, inboxId, undefined);
          ack({ ok: true, data: { changed } });

          // Re-sync badge counts (WS push)
          const counts = await this.query.countInboxForUser(auth.username, {}, undefined);

          this.wsEmit.emitCountToUser(auth.username, {
            total: counts.total,
            unread: counts.unread,
          });
        } catch (err: unknown) {
          ack({ ok: false, message: this.errMsg(err) });
        }
      }
    );
  }

  /* ======================================================================= */
  /* 4) MARK ALL READ                                                         */
  /* ======================================================================= */

  private bindMarkAllRead(socket: Socket): void {
    socket.on(
      NotificationRpcEvents.MARK_ALL_READ,
      async (_req: object, ack: (res: WsAck<WsMarkAllReadRes>) => void) => {
        try {
          const auth = this.readAuth(socket);

          const changedCount = await this.hub.markAllRead(auth.username, undefined);
          ack({ ok: true, data: { changedCount } });

          // Re-sync badge counts (WS push)
          const counts = await this.query.countInboxForUser(auth.username, {}, undefined);

          this.wsEmit.emitCountToUser(auth.username, {
            total: counts.total,
            unread: counts.unread,
          });
        } catch (err: unknown) {
          ack({ ok: false, message: this.errMsg(err) });
        }
      }
    );
  }

  /* ======================================================================= */
  /* Auth + Sanitizers                                                        */
  /* ======================================================================= */

  /**
   * Read auth identity from socket.data.
   * Your middleware should set:
   *   socket.data.auth = { username, role }
   */
  private readAuth(socket: Socket): SocketAuthShape {
    const raw = (socket.data as unknown as { auth?: unknown }).auth;

    if (!raw || typeof raw !== "object") {
      throw new Error("WS auth missing on socket.data.auth");
    }

    const a = raw as Partial<SocketAuthShape>;

    const username = typeof a.username === "string" ? a.username.trim() : "";
    const role = (a.role ?? "user") as Role;

    if (!username) {
      throw new Error("WS auth username missing");
    }

    return { username, role };
  }

  private safeListReq(req: WsInboxListReq): WsInboxListReq {
    if (!req) throw new Error("list request is required");

    const scope = this.safeScope(req.scope);
    const priorityScope = this.safePriority(req.priorityScope);

    const page = this.safePage(req.page);
    const limit = this.safeLimit(req.limit);

    // filters is required by contract; default to {}
    const filters: NotificationLoadFilters = req.filters ? req.filters : {};

    return { scope, priorityScope, page, limit, filters };
  }

  private safeCountsReq(req: WsInboxCountsReq): WsInboxCountsReq {
    if (!req) throw new Error("counts request is required");

    const scope = this.safeScope(req.scope);
    const priorityScope = this.safePriority(req.priorityScope);

    const filters: NotificationLoadFilters = req.filters ? req.filters : {};

    return { scope, priorityScope, filters };
  }

  private safeScope(v: NotificationScope): NotificationScope {
    if (v === "user" || v === "role" || v === "company") return v;
    return "user";
  }

  private safePriority(v: NotificationPriorityScope): NotificationPriorityScope {
    if (v === "all" || v === "prioritized" || v === "unprioritized") return v;
    return "all";
  }

  private safeId(v: unknown, label: string): string {
    const s = typeof v === "string" ? v.trim() : "";
    if (!s) throw new Error(`${label} is required`);
    return s;
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

  private errMsg(err: unknown): string {
    return err instanceof Error ? err.message : "Unknown error";
  }
}