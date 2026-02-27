// Path: src/socket/events/notifications/notification.rpc.events.ts
// =============================================================================
// Notification Hub — WebSocket RPC Events (Request/Response Contracts)
// -----------------------------------------------------------------------------
// PURPOSE
// - Single source of truth for Socket.IO "request → ack response" operations.
// - Frontend uses WS first; if WS fails it falls back to REST.
//
// IMPORTANT
// - Keep payloads DTO-safe (string ids, ISO date strings).
// - exactOptionalPropertyTypes-safe: optional props are OMITTED.
// =============================================================================

import type {
  NotificationInboxItemDto,
  NotificationLoadFilters,
} from "../../../types/notification/notification.types";

export type NotificationScope = "user" | "role" | "company";
export type NotificationPriorityScope = "all" | "prioritized" | "unprioritized";

/**
 * Standard WS ACK envelope (keep it simple + consistent).
 */
export interface WsAck<TData> {
  ok: boolean;
  message?: string;
  data?: TData;
}

/**
 * Inbox list request (scope + priorityScope).
 *
 * @param scope
 * - "user" => notifications directly targeting this user
 * - "role" => notifications targeting user's role
 * - "company" => notifications broadcast to the whole company
 *
 * @param priorityScope
 * - "all" => no priority filter
 * - "prioritized" => warning/error OR tag "priority"
 * - "unprioritized" => NOT prioritized
 */
export interface WsInboxListReq {
  scope: NotificationScope;
  priorityScope: NotificationPriorityScope;

  page: number;
  limit: number;

  filters: NotificationLoadFilters;
}

/**
 * Inbox counts request (counts must match the same filters).
 */
export interface WsInboxCountsReq {
  scope: NotificationScope;
  priorityScope: NotificationPriorityScope;
  filters: NotificationLoadFilters;
}

/**
 * Result payload for list
 */
export interface WsInboxListRes {
  items: NotificationInboxItemDto[];
  other: {
    total: number;
    unread: number;
    prioritized: number;
    unprioritized: number;
  };
}

/**
 * Result payload for counts
 */
export interface WsInboxCountsRes {
  total: number;
  unread: number;
  prioritized: number;
  unprioritized: number;
}

export interface WsMarkReadReq {
  inboxId: string;
}

export interface WsMarkReadRes {
  changed: boolean;
}

export interface WsMarkAllReadReq {}

export interface WsMarkAllReadRes {
  changedCount: number;
}

/**
 * WS RPC event keys
 */
export class NotificationRpcEvents {
  public static readonly INBOX_LIST = "notify:rpc:inbox:list";
  public static readonly INBOX_COUNTS = "notify:rpc:inbox:counts";
  public static readonly MARK_READ = "notify:rpc:mark:read";
  public static readonly MARK_ALL_READ = "notify:rpc:mark:all-read";
  public static readonly ARCHIVE_ONE = "notify:rpc:archive:one";
}