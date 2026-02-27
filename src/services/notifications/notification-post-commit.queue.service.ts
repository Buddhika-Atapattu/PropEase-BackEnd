// Path: src/services/notifications/notification-post-commit.queue.service.ts
// =============================================================================
// Notification Hub — Post-Commit Queue
// -----------------------------------------------------------------------------
// PURPOSE
// - Prevent WS / delivery race when emit() is called inside a transaction.
// - If session.inTransaction() === true, we queue WS+delivery work
//   and flush ONLY after commit.
//
// NOTES
// - In-memory only (acceptable for Fix B; if process crashes, only WS is missed,
//   but DB state is correct and UI will load on next refresh).
// =============================================================================

import type { ClientSession } from "mongoose";

export type NotificationPostCommitJob = {
  notificationId: string;
  recipientUserIds: string[]; // userId stored as string in user_notifications
  recipientUsernames: string[];
};

export class NotificationPostCommitQueue {
  private constructor() {}

  // session.id is stable in mongoose; use it as key
  private static readonly jobs = new Map<string, NotificationPostCommitJob[]>();

  public static enqueue(session: ClientSession, job: NotificationPostCommitJob): void {
    const key = this.sessionKey(session);
    const list = this.jobs.get(key) ?? [];
    list.push(job);
    this.jobs.set(key, list);
  }

  public static drain(session: ClientSession): NotificationPostCommitJob[] {
    const key = this.sessionKey(session);
    const list = this.jobs.get(key) ?? [];
    this.jobs.delete(key);
    return list;
  }

  public static clear(session: ClientSession): void {
    const key = this.sessionKey(session);
    this.jobs.delete(key);
  }

  private static sessionKey(session: ClientSession): string {
    const raw = (session as unknown as { id?: unknown }).id;
    const id = typeof raw === "string" ? raw.trim() : "";
    // fallback key if id missing (rare)
    return id || `session:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  }
}