// ============================================================================
// Path: src/KPIs/automation/kpi-task-deadline.runner.ts
// ============================================================================
// KPI Task Deadline Runner
// ----------------------------------------------------------------------------
// Fixes included:
//  1) exactOptionalPropertyTypes-safe recipient building (omit keys, no undefined)
//  2) Align runner with current task fact schema fields:
//       - createdAtISO as assigned time (fallback)
//       - dueAtISO as expected end time (fallback)
//     (You can later rename to assignedAt/expectedEndAt in schema, but not required now.)
//  3) Remove compile-time access to fields that do not exist in the model type:
//       - assignedAt, expectedEndAt, lastWarningAt, lastWarningLevel
//  4) Anti-spam is done with in-memory cooldown Map (large-scale safe enough for single instance).
//     When you scale horizontally, we’ll replace this with Redis or DB warning-state collection.
// ============================================================================

import { KpiModelAdapter } from '../data/kpi-model.adapter';
import { KpiTaskWarningPolicy, type KpiWarningLevel } from './kpi-task-warning.policy';
import { KpiNotificationDispatcher } from '../notifications/kpi-notification.dispatcher';
import { KpiConsoleEmailSender } from '../notifications/kpi-email.sender';
import { KpiConsoleSmsSender } from '../notifications/kpi-sms.sender';

import type { KpiRecipient, KpiWarningMessage } from '../notifications/kpi-notification.types';

export interface KpiRunnerOptions {
  tickMs: number;
  resendCooldownMs: number;
  localTimeZoneLabel: string;
}

/**
 * Lean row shape we expect from the current TeamTaskFact schema.
 * NOTE:
 *  - Your schema currently exposes createdAtISO, dueAtISO, startedAtISO (based on your error text).
 *  - We DO NOT require assignedAt/expectedEndAt fields at this stage.
 */
interface KpiTaskFactLean {
  _id: unknown;

  taskId: unknown;

  orgId?: unknown;
  branchId?: unknown;
  regionId?: unknown;

  teamId?: unknown;
  memberId?: unknown;

  category?: unknown;
  status?: unknown;
  priority?: unknown;

  // Existing fields seen in your model typings
  createdAtISO?: unknown; // Date
  startedAtISO?: unknown; // Date
  dueAtISO?: unknown;     // Date
}

export class KpiTaskDeadlineRunner {
  private readonly policy: KpiTaskWarningPolicy;
  private readonly notify: KpiNotificationDispatcher;

  private readonly opt: KpiRunnerOptions;
  private timer: NodeJS.Timeout | null;

  /**
   * Anti-spam in-memory cache:
   *   key = `${taskId}|${level}`
   *   value = lastSentMs
   *
   * NOTE:
   *  - Works perfectly for single-node deployment.
   *  - In multi-instance deployments, replace with Redis (shared) or DB warning-state collection.
   */
  private readonly warnCache: Map<string, number>;

  public constructor(options?: Partial<KpiRunnerOptions>) {
    this.policy = new KpiTaskWarningPolicy();
    this.notify = new KpiNotificationDispatcher(new KpiConsoleEmailSender(), new KpiConsoleSmsSender());

    this.opt = {
      tickMs: options?.tickMs ?? 60_000,
      resendCooldownMs: options?.resendCooldownMs ?? 30 * 60_000,
      localTimeZoneLabel: options?.localTimeZoneLabel ?? 'Asia/Colombo',
    };

    this.timer = null;
    this.warnCache = new Map();
  }

  public start(): void {
    if (this.timer) return;

    this.timer = setInterval(() => {
      this.tick().catch((err) => console.log('[Error:] [KPI Runner] tick failed.\n', err));
    }, this.opt.tickMs);

    console.log('[Success:] [KPI Runner] Task deadline runner started.\n');
  }

  public stop(): void {
    if (!this.timer) return;

    clearInterval(this.timer);
    this.timer = null;

    console.log('[Info:] [KPI Runner] Task deadline runner stopped.\n');
  }

  // =========================================================================
  // Core tick
  // =========================================================================
  private async tick(): Promise<void> {
    const Task = KpiModelAdapter.getTeamTaskFactModel();
    const now = new Date();

    // Scan only active tasks
    const activeStatuses = ['pending', 'in_progress', 'reopened'] as const;

    // Scan tasks due within +/- 24 hours window (tunable)
    const scanFrom = new Date(now.getTime() - 24 * 60 * 60_000);
    const scanTo = new Date(now.getTime() + 24 * 60 * 60_000);

    // IMPORTANT:
    // Your schema uses dueAtISO (not expectedEndAt).
    const candidates = (await Task.find(
      {
        status: { $in: activeStatuses },
        dueAtISO: { $gte: scanFrom, $lte: scanTo },
      },
      {
        _id: 1,
        orgId: 1,
        branchId: 1,
        regionId: 1,
        teamId: 1,
        memberId: 1,
        taskId: 1,
        category: 1,
        status: 1,
        priority: 1,
        createdAtISO: 1,
        startedAtISO: 1,
        dueAtISO: 1,
      },
    )
      .lean()
      .exec()) as unknown as KpiTaskFactLean[];

    for (const t of candidates) {
      const assignedAt = this.resolveAssignedAt(t, now);
      const expectedEndAt = this.resolveExpectedEndAt(t);
      if (!expectedEndAt) continue; // cannot compute deadlines without a due time

      const decision = this.policy.decide(now, assignedAt, expectedEndAt);
      if (!decision.level) continue;

      const taskIdStr = this.safeId(t.taskId);
      if (!taskIdStr) continue;

      const shouldSend = this.shouldSendWarning(taskIdStr, decision.level, now);
      if (!shouldSend) continue;

      const recipient = await this.resolveRecipient(t);
      if (!recipient.email && !recipient.phone) {
        // No contacts: still record send to avoid burning CPU every tick
        this.markSent(taskIdStr, decision.level, now);
        continue;
      }

      const msg = this.buildMessage(t, decision.level, decision.elapsedPercent, decision.remainingMs, now);
      await this.notify.notify(recipient, msg);

      this.markSent(taskIdStr, decision.level, now);
    }

    // Optional: small cleanup to avoid infinite Map growth
    this.cleanupCache(now);
  }

  // =========================================================================
  // Anti-spam / cooldown (in-memory)
  // =========================================================================
  private shouldSendWarning(taskId: string, level: Exclude<KpiWarningLevel, null>, now: Date): boolean {
    const key = `${taskId}|${level}`;
    const last = this.warnCache.get(key);
    if (!last) return true;

    const diff = now.getTime() - last;
    return diff >= this.opt.resendCooldownMs;
  }

  private markSent(taskId: string, level: Exclude<KpiWarningLevel, null>, now: Date): void {
    const key = `${taskId}|${level}`;
    this.warnCache.set(key, now.getTime());
  }

  private cleanupCache(now: Date): void {
    // Remove entries older than 2x cooldown to keep memory stable.
    const cutoff = now.getTime() - (this.opt.resendCooldownMs * 2);

    for (const [key, ts] of this.warnCache.entries()) {
      if (ts < cutoff) this.warnCache.delete(key);
    }
  }

  // =========================================================================
  // Recipient resolution (exactOptionalPropertyTypes safe)
  // =========================================================================
  private async resolveRecipient(task: KpiTaskFactLean): Promise<KpiRecipient> {
    const recipient: KpiRecipient = {
      displayName: 'Assigned Member/Team',
    };

    const teamId = this.safeId(task.teamId);
    const memberId = this.safeId(task.memberId);

    // IMPORTANT:
    // With exactOptionalPropertyTypes, you must OMIT optional keys.
    if (teamId) recipient.teamId = teamId;
    if (memberId) recipient.memberId = memberId;

    // TODO: integrate with your User/Team directory to resolve:
    //   recipient.email = ...
    //   recipient.phone = ...

    return recipient;
  }

  // =========================================================================
  // Message builder
  // =========================================================================
  private buildMessage(
    task: KpiTaskFactLean,
    level: Exclude<KpiWarningLevel, null>,
    elapsedPercent: number,
    remainingMs: number,
    now: Date,
  ): KpiWarningMessage {
    const taskId = this.safeId(task.taskId) ?? 'unknown';
    const status = typeof task.status === 'string' ? task.status : 'unknown';
    const category = typeof task.category === 'string' ? task.category : 'other';

    const remainingMin = Math.ceil(remainingMs / 60_000);

    let severity: 'info' | 'warning' | 'danger' = 'warning';
    let title = 'Task Deadline Warning';

    if (level === '90') {
      severity = 'danger';
      title = 'URGENT: Task Nearing Deadline';
    }
    if (level === 'overdue') {
      severity = 'danger';
      title = 'OVERDUE: Task Deadline Missed';
    }

    const body =
      `TaskId: ${taskId}\n` +
      `Category: ${category}\n` +
      `Status: ${status}\n` +
      `Elapsed: ${elapsedPercent.toFixed(2)}%\n` +
      (level === 'overdue' ? `Remaining: 0 minutes (OVERDUE)\n` : `Remaining: ~${remainingMin} minutes\n`) +
      `TimeZone: ${this.opt.localTimeZoneLabel}\n` +
      `GeneratedAt: ${now.toISOString()}\n`;

    return {
      title,
      body,
      occurredAtISO: now.toISOString(),
      severity,
    };
  }

  // =========================================================================
  // Time resolvers (use your existing schema fields)
  // =========================================================================

  /**
   * assignedAt:
   *  - prefer startedAtISO if exists (actual start)
   *  - else use createdAtISO (assignment/creation time)
   *  - else fallback to now (should not happen if schema is correct)
   */
  private resolveAssignedAt(task: KpiTaskFactLean, now: Date): Date {
    const started = this.toDateOrNull(task.startedAtISO);
    if (started) return started;

    const created = this.toDateOrNull(task.createdAtISO);
    if (created) return created;

    return now;
  }

  /**
   * expectedEndAt:
   *  - use dueAtISO
   */
  private resolveExpectedEndAt(task: KpiTaskFactLean): Date | null {
    return this.toDateOrNull(task.dueAtISO);
  }

  private toDateOrNull(v: unknown): Date | null {
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v;

    if (typeof v === 'string' || typeof v === 'number') {
      const d = new Date(v);
      return isNaN(d.getTime()) ? null : d;
    }

    return null;
  }

  private safeId(v: unknown): string | null {
    if (v === null || v === undefined) return null;

    // ObjectId from Mongoose can be object with toString()
    try {
      const s = String(v);
      return s.trim() ? s : null;
    } catch {
      return null;
    }
  }
}
