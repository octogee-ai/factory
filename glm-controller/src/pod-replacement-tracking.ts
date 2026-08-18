import {
  POD_REPLACEMENT_MAX_RETAINED,
  pruneGatewayPodReplacementWindow,
  type GatewayPodReplacements,
} from "@octogee/shared/types/gateway-pod-replacements";

import type { PlacementPolicyPodDiagnostics } from "./placement-policy-reconciler.js";

export const EMPTY_POD_REPLACEMENTS: GatewayPodReplacements = {
  recentAt: [],
  lastAt: null,
  lastPodUid: null,
  total: 0,
};

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
// leave the tracked identities untouched instead.
export function observedPodUids(
  diagnostics: PlacementPolicyPodDiagnostics | undefined,
): string[] | null {
  if (!diagnostics || diagnostics.error) return null;
  if (diagnostics.status === "unknown") return null;
  const pods = diagnostics.pods;
  if (!pods) return diagnostics.totalPods === 0 ? [] : null;
  const uids: string[] = [];
  for (const pod of pods) {
    if (typeof pod.uid !== "string" || pod.uid.length === 0) return null;
    uids.push(pod.uid);
  }
  return [...new Set(uids)].sort();
}

export interface PodReplacementTransition {
  replacements: GatewayPodReplacements;
  podUids: string[];
  planToken: string;
  replacedCount: number;
}

export function nextPodReplacementTransition(input: {
  previousPodUids: readonly string[] | null;
  previousPlanToken: string | null;
  previous: GatewayPodReplacements | null;
  observedPodUids: readonly string[] | null;
  planToken: string;
  now: number;
}): PodReplacementTransition | null {
  const { observedPodUids: observed, planToken, now } = input;
  if (observed === null) return null;

  const podUids = [...observed];
  const previous = input.previous ?? EMPTY_POD_REPLACEMENTS;
  const retained = pruneGatewayPodReplacementWindow(previous.recentAt, now);
  const unchangedPlan = input.previousPlanToken === planToken;
  const tracked = input.previousPodUids;

  const appeared = tracked === null || !unchangedPlan
    ? []
    : podUids.filter((uid) => !tracked.includes(uid));

  if (appeared.length === 0) {
    return {
      replacements: { ...previous, recentAt: retained },
      podUids,
      planToken,
      replacedCount: 0,
    };
  }

  return {
    replacements: {
      recentAt: [...retained, ...appeared.map(() => now)].slice(-POD_REPLACEMENT_MAX_RETAINED),
      lastAt: now,
      lastPodUid: appeared[appeared.length - 1] ?? previous.lastPodUid,
      total: previous.total + appeared.length,
    },
    podUids,
    planToken,
    replacedCount: appeared.length,
  };
}
