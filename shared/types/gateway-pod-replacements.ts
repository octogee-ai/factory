const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const POD_REPLACEMENT_RECENT_WINDOW_MS = 7 * DAY_MS;
export const POD_REPLACEMENT_WARNING_THRESHOLD_24H = 3;
export const POD_REPLACEMENT_MAX_RETAINED = 64;

// glmGateways/{id}.podReplacements — gateway pod identities that were swapped
// without a corresponding desired-state change. A Spot preemption deletes the
// pod object along with its node, so the ReplicaSet mints a fresh pod and the
// container restart count stays 0; the replaced identity is the only surviving
// evidence once the Kubernetes event has expired.
export interface GatewayPodReplacements {
  recentAt: number[];
  lastAt: number | null;
  lastPodUid: string | null;
  total: number;
}

export interface GatewayPodReplacementSummary {
  count24h: number;
  count7d: number;
  lastAt: number | null;
  lastPodUid: string | null;
  total: number;
  warn: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isEpochMs(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isGatewayPodReplacements(value: unknown): value is GatewayPodReplacements {
  if (!isRecord(value)) return false;
  return (
    Array.isArray(value.recentAt) &&
    value.recentAt.every(isEpochMs) &&
    (value.lastAt === null || isEpochMs(value.lastAt)) &&
    (value.lastPodUid === null || typeof value.lastPodUid === "string") &&
    typeof value.total === "number" &&
    Number.isSafeInteger(value.total) &&
    value.total >= 0
  );
}

// A replacement stamped ahead of `now` cannot be counted against a window that
// ends at `now`; clock skew must not inflate the indicator.
function countWithin(recentAt: readonly number[], now: number, windowMs: number): number {
  return recentAt.filter((at) => at <= now && now - at < windowMs).length;
}

export function summarizeGatewayPodReplacements(
  value: GatewayPodReplacements | null | undefined,
  now: number,
): GatewayPodReplacementSummary {
  if (!value) {
    return { count24h: 0, count7d: 0, lastAt: null, lastPodUid: null, total: 0, warn: false };
  }
  const count24h = countWithin(value.recentAt, now, DAY_MS);
  return {
    count24h,
    count7d: countWithin(value.recentAt, now, POD_REPLACEMENT_RECENT_WINDOW_MS),
    lastAt: value.lastAt,
    lastPodUid: value.lastPodUid,
    total: value.total,
    warn: count24h >= POD_REPLACEMENT_WARNING_THRESHOLD_24H,
  };
}

export function pruneGatewayPodReplacementWindow(
  recentAt: readonly number[],
  now: number,
): number[] {
  return recentAt
    .filter((at) => at <= now && now - at < POD_REPLACEMENT_RECENT_WINDOW_MS)
    .sort((left, right) => left - right)
    .slice(-POD_REPLACEMENT_MAX_RETAINED);
}
