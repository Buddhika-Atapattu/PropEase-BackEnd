import type { KpiScope, RealtimeTopic } from '../types/realtime.types';

/**
 * Topic naming is a contract.
 *
 * Think SQL index / Mongo compound key:
 * - stable, predictable
 * - supports prefix matching (future)
 *
 * Example:
 *  kpi.team.123.projection.summary
 *  kpi.branch.45.alert.sla
 */
export class RealtimeTopicBuilder {
  public buildKpiTopic(scope: KpiScope, scopeId: string, category: string, name: string): RealtimeTopic {
    // Teaching note:
    // A topic is like "namespace.path.to.thing".
    // Avoid slashes to keep it consistent across transports.
    const safeScopeId: string = this.sanitize(scopeId);
    const safeCategory: string = this.sanitize(category);
    const safeName: string = this.sanitize(name);

    return `kpi.${scope}.${safeScopeId}.${safeCategory}.${safeName}`;
  }

  public buildOrgTopic(category: string, name: string): RealtimeTopic {
    return this.buildKpiTopic('organisation', 'org', category, name);
  }

  private sanitize(raw: string): string {
    // Keep alphanumeric, dash, underscore, dot; replace others with '-'
    // This prevents topic injection / weird client parsing edge cases.
    return raw.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  }
}
