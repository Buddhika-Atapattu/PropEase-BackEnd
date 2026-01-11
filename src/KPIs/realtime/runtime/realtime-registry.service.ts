import type { RealtimeAudience, RealtimePrincipal } from '../types/realtime.types';

/**
 * Registry tracks "who subscribed to what".
 *
 * Why separate registry?
 * - Transport should be dumb (deliver to audience key)
 * - Registry is where we can apply authorization later (principal -> allowed audiences)
 */
export class RealtimeRegistryService {
  private readonly principalAudiences: Map<string, Set<string>>;

  public constructor() {
    this.principalAudiences = new Map<string, Set<string>>();
  }

  public register(principal: RealtimePrincipal, audience: RealtimeAudience): void {
    const pKey: string = this.principalKey(principal);
    const aKey: string = this.audienceKey(audience);

    let set: Set<string> | undefined = this.principalAudiences.get(pKey);
    if (!set) {
      set = new Set<string>();
      this.principalAudiences.set(pKey, set);
    }
    set.add(aKey);
  }

  public unregister(principal: RealtimePrincipal, audience: RealtimeAudience): void {
    const pKey: string = this.principalKey(principal);
    const aKey: string = this.audienceKey(audience);

    const set: Set<string> | undefined = this.principalAudiences.get(pKey);
    if (!set) return;

    set.delete(aKey);
    if (set.size === 0) this.principalAudiences.delete(pKey);
  }

  public listAudiences(principal: RealtimePrincipal): ReadonlyArray<string> {
    const pKey: string = this.principalKey(principal);
    const set: Set<string> | undefined = this.principalAudiences.get(pKey);
    if (!set) return [];
    return Array.from(set.values());
  }

  private principalKey(principal: RealtimePrincipal): string {
    return `${principal.kind}:${principal.principalId}`;
  }

  private audienceKey(audience: RealtimeAudience): string {
    return `aud.${audience.kind}.${audience.id}`;
  }
}
