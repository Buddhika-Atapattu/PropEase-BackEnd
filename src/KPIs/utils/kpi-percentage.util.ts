// ============================================================================
// Path: src/KPIs/utils/kpi-percentage.util.ts
// ============================================================================
// KPI Percentage Utility
// ----------------------------------------------------------------------------
// Purpose:
//   - Convert ratios to percent (0..100)
//   - Round for UI stability
//   - Clamp to safe range
//
// IMPORTANT:
//   - Always return 0..100
//   - Avoid NaN/Infinity
// ============================================================================

export class KpiPercentageUtil {
  public constructor() {}

  /**
   * Convert part/whole to percent.
   * Example: (2, 10) => 20
   */
  public toPercent(part: number, whole: number): number {
    if (!Number.isFinite(part) || !Number.isFinite(whole)) return 0;
    if (whole <= 0) return 0;

    const raw = (part / whole) * 100;
    return this.clamp(raw, 0, 100);
  }

  /**
   * Round value to N decimals.
   * Example: round(12.3456, 2) => 12.35
   */
  public round(value: number, decimals: number = 2): number {
    if (!Number.isFinite(value)) return 0;
    const d = Math.max(0, Math.min(decimals, 6)); // keep sane
    const factor = Math.pow(10, d);
    return Math.round(value * factor) / factor;
  }

  /**
   * Clamp to range.
   */
  public clamp(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    if (value < min) return min;
    if (value > max) return max;
    return value;
  }
}
