import {
  EMPTY_GATEWAY_POD_REPLACEMENTS,
  POD_REPLACEMENT_MAX_RETAINED,
  pruneGatewayPodReplacementWindow,
  type GatewayPodPlacement,
  type GatewayPodReplacements,
} from "@octogee/shared/types/gateway-pod-replacements";

import type { PlacementPolicyPodDiagnostics } from "./placement-policy-reconciler.js";

// The desired-state fingerprint a pod generation belongs to. Pod churn that
// straddles two different tokens is explained by the desired-state change
// (a release roll, a pause, a drain, a retire) and is not counted as unplanned.
export function gatewayPlanToken(root: {
  desiredRelease: number;
  liveRelease: number | null;
  desiredStatus: string;
}): string {
  return `${root.desiredRelease}:${root.liveRelease ?? "none"}:${root.desiredStatus}`;
}

// `null` means "this tick observed nothing trustworthy" — a kubectl failure or a
// pod record without an identity. Attributing a replacement to an unreadable
// window would invent churn out of a transient API error, so the caller must
// leave the tracked placements untouched instead.
export function observedPodPlacements(
  diagnostics: PlacementPolicyPodDiagnostics | undefined,
): GatewayPodPlacement[] | null {
  if (!diagnostics || diagnostics.error) return null;
  if (diagnostics.status === "unknown") return null;
  const pods = diagnostics.pods;
  if (!pods) return diagnostics.totalPods === 0 ? [] : null;
  const byUid = new Map<string, GatewayPodPlacement>();
  for (const pod of pods) {
    if (typeof pod.uid !== "string" || pod.uid.length === 0) return null;
    byUid.set(pod.uid, {
      uid: pod.uid,
      nodeName: pod.nodeName ?? null,
      instanceId: pod.instanceId ?? null,
      nodePool: pod.nodePool ?? null,
    });
  }
  return [...byUid.values()].sort((left, right) => left.uid.localeCompare(right.uid));
}

export interface PodReplacementTransition {
  replacements: GatewayPodReplacements;
  placements: GatewayPodPlacement[];
  planToken: string;
  vacated: GatewayPodPlacement[];
}

// Counted on the pod DISAPPEARING, not on its successor appearing. Two reasons:
// the vacated pod carries the node identity that joins to the preemption record
// and that identity is gone once the successor is observed; and a gateway whose
// pod is never rescheduled (Spot capacity exhausted) is exactly the case an
// appearance-triggered counter would report as zero churn while the gateway is
// down.
export function nextPodReplacementTransition(input: {
  previousPlacements: readonly GatewayPodPlacement[] | null;
  previousPlanToken: string | null;
  previous: GatewayPodReplacements | null;
  observedPlacements: readonly GatewayPodPlacement[] | null;
  planToken: string;
  now: number;
}): PodReplacementTransition | null {
  const { observedPlacements: observed, planToken, now } = input;
  if (observed === null) return null;

  const placements = [...observed];
  const previous = input.previous ?? EMPTY_GATEWAY_POD_REPLACEMENTS;
  const retained = pruneGatewayPodReplacementWindow(previous.recentAt, now);
  const tracked = input.previousPlacements;
  const observedUids = new Set(placements.map((pod) => pod.uid));

  const vacated = tracked === null || input.previousPlanToken !== planToken
    ? []
    : tracked.filter((pod) => !observedUids.has(pod.uid));

  if (vacated.length === 0) {
    return {
      replacements: { ...previous, recentAt: retained },
      placements,
      planToken,
      vacated,
    };
  }

  const last = vacated[vacated.length - 1]!;
  return {
    replacements: {
      recentAt: [...retained, ...vacated.map(() => now)].slice(-POD_REPLACEMENT_MAX_RETAINED),
      lastAt: now,
      lastVacatedPodUid: last.uid,
      lastVacatedNodeName: last.nodeName,
      lastVacatedInstanceId: last.instanceId,
      lastVacatedNodePool: last.nodePool,
      total: previous.total + vacated.length,
    },
    placements,
    planToken,
    vacated,
  };
}
