export interface ChannelMemberResolver {
  getMembers: (channelId: string) => Promise<ReadonlySet<string>>;
  invalidate: (channelId: string) => void;
}

interface Entry {
  members: ReadonlySet<string>;
  at: number;
}

export function createChannelMemberResolver(deps: {
  fetchMembers: (channelId: string) => Promise<Set<string>>;
  ttlMs?: number;
  now?: () => number;
  /**
   * Called when a membership fetch fails (incl. the >5000 overflow
   * throw). The resolver still fails closed (empty set, uncached); this
   * is the seam proxy.ts uses to count + rate-limit-log the
   * degradation so a revoked MM_ADMIN_PAT / MM outage isn't silent.
   */
  onError?: (channelId: string, err: unknown) => void;
}): ChannelMemberResolver {
  const ttlMs = deps.ttlMs ?? 60_000;
  const now = deps.now ?? Date.now;
  const cache = new Map<string, Entry>();
  const inflight = new Map<string, Promise<Set<string>>>();

  return {
    async getMembers(channelId) {
      const cached = cache.get(channelId);
      if (cached && now() - cached.at < ttlMs) {
        return cached.members;
      }
      const pending = inflight.get(channelId);
      if (pending) {
        return pending;
      }
      const p = (async () => {
        try {
          const members = await deps.fetchMembers(channelId);
          cache.set(channelId, { members, at: now() });
          return members;
        } catch (err) {
          // Fail-closed: an unresolvable membership delivers to nobody
          // (the leak we're closing). Not cached, so the next tick
          // retries. Surface it so the degradation is diagnosable.
          deps.onError?.(channelId, err);
          return new Set<string>();
        } finally {
          inflight.delete(channelId);
        }
      })();
      inflight.set(channelId, p);
      return p;
    },
    invalidate(channelId) {
      cache.delete(channelId);
    },
  };
}
