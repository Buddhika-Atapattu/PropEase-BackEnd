// ============================================================================
// Path: src/KPIs/utils/kpi-time-window.util.ts
// ============================================================================
// KPI Time Window Utility
// ----------------------------------------------------------------------------
// Purpose:
//   - Convert window presets into concrete ISO date ranges
//   - Provide bucket stepping (day/week/month/quarter)
//   - Keep timezone as a string (we don't do heavy TZ math here)
//
// NOTE:
//   - Server DB queries use Date objects.
//   - Higher layers can use ISO strings and convert using this utility.
// ============================================================================

import type { KpiGranularity, KpiTimeWindow, KpiWindowPreset } from '../shared/kpi-core.types';

export interface KpiIsoWindow {
  fromISO: string;
  toISO: string;
}

export class KpiTimeWindowUtil {
  public constructor() {}

  /**
   * Build an ISO window from preset.
   * - "custom" uses the given fromISO/toISO as-is
   */
  public buildIsoWindow(input: KpiTimeWindow): KpiIsoWindow {
    if (input.preset === 'custom') {
      return { fromISO: input.fromISO, toISO: input.toISO };
    }

    const now = new Date();
    const to = now;
    const from = new Date(now);

    if (input.preset === '7d') from.setDate(from.getDate() - 7);
    if (input.preset === '30d') from.setDate(from.getDate() - 30);
    if (input.preset === '90d') from.setDate(from.getDate() - 90);

    if (input.preset === 'ytd') {
      from.setMonth(0, 1);
      from.setHours(0, 0, 0, 0);
    }

    return { fromISO: from.toISOString(), toISO: to.toISOString() };
  }

  /**
   * Convert ISO window to DB window (Date objects).
   */
  public toDbWindow(iso: KpiIsoWindow): { from: Date; to: Date } {
    return {
      from: new Date(iso.fromISO),
      to: new Date(iso.toISO),
    };
  }

  /**
   * Get next bucket date for grouping.
   * (Useful later for series mode when we implement bucketing.)
   */
  public step(date: Date, granularity: KpiGranularity): Date {
    const d = new Date(date);

    if (granularity === 'day') d.setDate(d.getDate() + 1);
    if (granularity === 'week') d.setDate(d.getDate() + 7);

    if (granularity === 'month') {
      d.setMonth(d.getMonth() + 1);
    }

    if (granularity === 'quarter') {
      d.setMonth(d.getMonth() + 3);
    }

    return d;
  }

  /**
   * Normalize date to bucket boundary (rough, timezone-agnostic).
   * - day => 00:00:00
   * - week => Sunday 00:00:00 (simple rule)
   */
  public normalize(date: Date, granularity: KpiGranularity): Date {
    const d = new Date(date);
    d.setMilliseconds(0);
    d.setSeconds(0);
    d.setMinutes(0);
    d.setHours(0);

    if (granularity === 'week') {
      const day = d.getDay(); // 0..6 (Sun..Sat)
      d.setDate(d.getDate() - day);
    }

    if (granularity === 'month') {
      d.setDate(1);
    }

    if (granularity === 'quarter') {
      const m = d.getMonth(); // 0..11
      const qStart = m - (m % 3);
      d.setMonth(qStart, 1);
    }

    return d;
  }
}
