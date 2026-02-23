// ============================================================================
// Path: src/KPIs/shared/kpi.registry.ts
// ============================================================================

import type { KpiDefinition } from "./kpi.types";

/* ============================================================================
 * KpiRegistry
 * ----------------------------------------------------------------------------
 * INTRODUCTION
 * - Minimal registry that maps KPI key -> KPI definition.
 * - Each module owns its registry instance inside its module engine.
 *
 * IMPORTANT MATTERS
 * - Keeps compute() lookups strict and predictable.
 * - Prevents duplicate KPI key collisions inside a module.
 *
 * WHY WE MAKE THIS CLASS
 * - Module-wise KPI engines stay clean: they register keys once and compute by key.
 *
 * USAGE HINT
 * - In a module engine constructor:
 *   const registry = new KpiRegistry();
 *   registry.register({...});
 *   const def = registry.get("some.key");
 * ========================================================================== */

export class KpiRegistry {
  private readonly map: Map<string, KpiDefinition<unknown>>;

  public constructor() {
    this.map = new Map<string, KpiDefinition<unknown>>();
  }

  /**
   * Register a KPI definition.
   *
   * @param def.key
   * - Expected: unique key within the module (e.g. "tm.teamTask.completionRate")
   *
   * @throws Error when the key is already registered
   */
  public register<TValue>(def: KpiDefinition<TValue>): void {
    if (this.map.has(def.key)) {
      throw new Error(`KPI key already registered: ${def.key}`);
    }
    this.map.set(def.key, def as unknown as KpiDefinition<unknown>);
  }

  /**
   * Get KPI definition by key.
   *
   * @param key
   * - Expected: registered KPI key
   *
   * @returns definition or null
   */
  public get<TValue>(key: string): KpiDefinition<TValue> | null {
    const def = this.map.get(key);
    if (!def) return null;
    return def as unknown as KpiDefinition<TValue>;
  }

  /**
   * List all registered keys (useful for diagnostics).
   */
  public listKeys(): string[] {
    return Array.from(this.map.keys());
  }
}