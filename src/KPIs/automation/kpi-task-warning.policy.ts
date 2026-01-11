// ============================================================================
// Path: src/KPIs/automation/kpi-task-warning.policy.ts
// ============================================================================
// Warning Policy
// ----------------------------------------------------------------------------
// Computes warning levels based on elapsed % of task time window.
//   elapsed% = (now - assignedAt) / (expectedEndAt - assignedAt) * 100
//
// Levels:
//   - 75%  => warning
//   - 90%  => danger
//   - overdue => danger
//
// Anti-spam rule:
//   Do not resend same level if it was already sent recently.
// ============================================================================

export type KpiWarningLevel = '75' | '90' | 'overdue' | null;

export interface KpiWarningDecision {
  level: KpiWarningLevel;
  elapsedPercent: number;
  remainingMs: number;
}

export class KpiTaskWarningPolicy {
  public constructor() {}

  public decide(now: Date, assignedAt: Date, expectedEndAt: Date): KpiWarningDecision {
    const start = assignedAt.getTime();
    const end = expectedEndAt.getTime();
    const t = now.getTime();

    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return { level: null, elapsedPercent: 0, remainingMs: 0 };
    }

    const total = end - start;
    const elapsed = Math.max(0, t - start);
    const remaining = Math.max(0, end - t);

    const pct = Math.max(0, Math.min(100, (elapsed / total) * 100));

    if (t > end) return { level: 'overdue', elapsedPercent: 100, remainingMs: 0 };
    if (pct >= 90) return { level: '90', elapsedPercent: pct, remainingMs: remaining };
    if (pct >= 75) return { level: '75', elapsedPercent: pct, remainingMs: remaining };

    return { level: null, elapsedPercent: pct, remainingMs: remaining };
  }
}
