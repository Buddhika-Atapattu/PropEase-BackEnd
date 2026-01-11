// ============================================================================
// Path: src/KPIs/data/kpi-cache.service.ts
// ============================================================================
// KPI Cache Service (In-Memory TTL)
// ----------------------------------------------------------------------------
// Purpose:
//   KPI queries can be expensive (aggregation pipelines).
//   This cache:
//     - stores results for a short TTL
//     - prevents burst re-computation (especially WS push storms)
//
// IMPORTANT:
//   - This is NOT Redis. It's local memory.
//   - Later you can replace this with Redis by implementing the same interface.
// ============================================================================

export interface KpiCacheEntry<T> {
  value: T;
  expiresAtMs: number;
}

export class KpiCacheService {
  private readonly store: Map<string, KpiCacheEntry<unknown>>;

  public constructor() {
    this.store = new Map();
  }

  public get<T>(key: string): T | null {
    const hit = this.store.get(key);
    if (!hit) return null;

    const now = Date.now();
    if (hit.expiresAtMs <= now) {
      this.store.delete(key);
      return null;
    }

    return hit.value as T;
  }

  public set<T>(key: string, value: T, ttlMs: number): void {
    const safeTtl = Math.max(250, Math.min(ttlMs, 5 * 60_000)); // 250ms..5m
    const entry: KpiCacheEntry<T> = {
      value,
      expiresAtMs: Date.now() + safeTtl,
    };
    this.store.set(key, entry as KpiCacheEntry<unknown>);
  }

  public delete(key: string): void {
    this.store.delete(key);
  }

  public clear(): void {
    this.store.clear();
  }

  /**
   * Utility: stable key builder (no `any`, safe stringify)
   */
  public buildKey(parts: ReadonlyArray<unknown>): string {
    return parts.map((p) => this.safeStringify(p)).join('|');
  }

  private safeStringify(v: unknown): string {
    try {
      if (typeof v === 'string') return v;
      if (typeof v === 'number') return String(v);
      if (typeof v === 'boolean') return v ? '1' : '0';
      if (v === null) return 'null';
      if (v === undefined) return 'undef';
      return JSON.stringify(v);
    } catch {
      return 'unstringifiable';
    }
  }
}
