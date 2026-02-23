// ============================================================================
// Path: src/KPIs/shared/kpi.window.ts
// ============================================================================

import type { KpiWindow } from "./kpi.types";

/* ============================================================================
 * KpiWindowParser
 * ----------------------------------------------------------------------------
 * INTRODUCTION
 * - Strict parser for KPI time windows (from/to).
 * - Avoids silent Date parsing pitfalls and invalid ranges.
 *
 * IMPORTANT MATTERS
 * - Accepts ISO date strings.
 * - Rejects invalid dates and from > to.
 *
 * WHY WE MAKE THIS CLASS
 * - KPI correctness depends heavily on clean time windows.
 * - Prevents accidental huge scans in Mongo due to invalid from/to.
 *
 * KEEP IN MIND
 * - Your router/controller should call this before running aggregation.
 * ========================================================================== */

export class KpiWindowParser {
  /**
   * Parse and validate a KPI window.
   *
   * @param options.fromISO
   * - Expected: ISO string, e.g. "2026-02-01T00:00:00.000Z"
   *
   * @param options.toISO
   * - Expected: ISO string, e.g. "2026-02-23T23:59:59.999Z"
   *
   * @param options.maxRangeDays
   * - Optional safety limit to prevent accidental huge queries
   * - Default: 366 days
   *
   * @throws Error when invalid
   */
  public parse(options: {
    fromISO: string;
    toISO: string;
    maxRangeDays?: number;
  }): KpiWindow {
    const fromRaw = options.fromISO.trim();
    const toRaw = options.toISO.trim();

    if (!fromRaw || !toRaw) {
      throw new Error("KPI window requires fromISO and toISO");
    }

    const from = this.parseIsoDateStrict(fromRaw, "fromISO");
    const to = this.parseIsoDateStrict(toRaw, "toISO");

    if (from.getTime() > to.getTime()) {
      throw new Error("KPI window invalid: fromISO is after toISO");
    }

    const maxDays = options.maxRangeDays ?? 366;
    const rangeDays = this.diffDays(from, to);
    if (rangeDays > maxDays) {
      throw new Error(`KPI window exceeds max range: ${rangeDays} days (max ${maxDays})`);
    }

    return { from, to };
  }

  // --------------------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------------------

  private parseIsoDateStrict(value: string, label: string): Date {
    // ISO parsing is strict enough for our use if we validate NaN.
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) {
      throw new Error(`Invalid ISO date for ${label}: ${value}`);
    }
    return d;
  }

  private diffDays(from: Date, to: Date): number {
    const ms = to.getTime() - from.getTime();
    const dayMs = 24 * 60 * 60 * 1000;
    return Math.floor(ms / dayMs);
  }
}