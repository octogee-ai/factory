const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const POD_REPLACEMENT_RECENT_WINDOW_MS = 7 * DAY_MS;
export const POD_REPLACEMENT_WARNING_THRESHOLD_24H = 3;
export const POD_REPLACEMENT_MAX_RETAINED = 64;

export const GATEWAY_POD_REPLACEMENT_SCHEMA = "octogee.gateway-pod-replacement.v1" as const;

// The GCE identity of a gateway pod's node, captured while the node still
// exists. A Spot preemption destroys the instance, so this can never be
// recovered afterwards — recording it at observation time is what makes a
// replacement joinable to the octogee_spot_preemptions log metric by
// instance_id.
export interface GatewayPodPlacement {
  uid: string;
  nodeName: string | null;
  instanceId: string | null;
  nodePool: string | null;
}

// glmGateways/{id}.podReplacements — gateway pods that vanished without a
// matching desired-state change. A Spot preemption deletes the pod object along
// with its node, so the container restart count stays 0 and the Kubernetes event
// expires within the hour; the vacated identity is the only surviving evidence.
export interface GatewayPodReplacements {
  recentAt: number[];
  lastAt: number | null;
  lastVacatedPodUid: string | null;
  lastVacatedNodeName: string | null;
  lastVacatedInstanceId: string | null;
  lastVacatedNodePool: string | null;
  total: number;
}

export interface GatewayPodReplacementSummary {
  count24h: number;
  count7d: number;
  lastAt: number | null;
  lastVacatedPodUid: string | null;
  lastVacatedNodeName: string | null;
  lastVacatedInstanceId: string | null;
  lastVacatedNodePool: string | null;
  total: number;
  warn: boolean;
}

export const EMPTY_GATEWAY_POD_REPLACEMENTS: GatewayPodReplacements = {
  recentAt: [],
  lastAt: null,
  lastVacatedPodUid: null,
  lastVacatedNodeName: null,
  lastVacatedInstanceId: null,
  lastVacatedNodePool: null,
  total: 0,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isEpochMs(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

export function isGatewayPodReplacements(value: unknown): value is GatewayPodReplacements {
  if (!isRecord(value)) return false;
  return (
    Array.isArray(value.recentAt) &&
    value.recentAt.every(isEpochMs) &&
    (value.lastAt === null || isEpochMs(value.lastAt)) &&
    isNullableString(value.lastVacatedPodUid) &&
    isNullableString(value.lastVacatedNodeName) &&
    isNullableString(value.lastVacatedInstanceId) &&
    isNullableString(value.lastVacatedNodePool) &&
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
    return {
      count24h: 0,
      count7d: 0,
      lastAt: null,
      lastVacatedPodUid: null,
      lastVacatedNodeName: null,
      lastVacatedInstanceId: null,
      lastVacatedNodePool: null,
      total: 0,
      warn: false,
    };
  }
  const count24h = countWithin(value.recentAt, now, DAY_MS);
  return {
    count24h,
    count7d: countWithin(value.recentAt, now, POD_REPLACEMENT_RECENT_WINDOW_MS),
    lastAt: value.lastAt,
    lastVacatedPodUid: value.lastVacatedPodUid,
    lastVacatedNodeName: value.lastVacatedNodeName,
    lastVacatedInstanceId: value.lastVacatedInstanceId,
    lastVacatedNodePool: value.lastVacatedNodePool,
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
