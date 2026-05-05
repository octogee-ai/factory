import type {
  GatewayDesiredState,
  HelmInstanceValue,
  HelmInstancesMap,
} from "../../shared/types/glm.js";

export type ReconcileChange =
  | { kind: "create"; instanceName: string; to: HelmInstanceValue }
  | { kind: "update"; instanceName: string; from: HelmInstanceValue; to: HelmInstanceValue }
  | { kind: "drift"; instanceName: string; current: HelmInstanceValue };

/**
 * The fleet-wide gateway image tag — drives sidecars (chat-proxy,
 * workspace-api) so the whole gateway pod rolls together per #846.
 *
 * Picks the `default` instance's imageTag if present (the canonical primary).
 * Falls back to the first non-retired instance's imageTag for canary-only or
 * smoke-only fleets. Returns undefined when nothing is running — the chart
 * default (`gateway.imageTag: latest` from values.yaml) then takes over,
 * which is the fresh-cluster bootstrap path.
 */
export function deriveFleetImageTag(
  desired: GatewayDesiredState[],
): string | undefined {
  const live = desired.filter((d) => d.desiredStatus !== "retired");
  if (live.length === 0) return undefined;
  const primary = live.find((d) => d.instanceName === "default") ?? live[0];
  return primary.imageTag;
}

export function buildInstancesMap(
  desired: GatewayDesiredState[],
): HelmInstancesMap {
  const out: HelmInstancesMap = {};
  for (const d of desired) {
    if (d.desiredStatus === "retired") continue;
    out[d.instanceName] = {
      enabled: true,
      image: { repository: d.imageRepository, tag: d.imageTag },
      gatewayId: d.gatewayId,
    };
  }
  return out;
}

/**
 * The instances map to pass to `helm upgrade`. Starts from the currently-
 * deployed (`actual`) map so any instance running in helm is preserved by
 * default — the controller never auto-deletes for "drift" reasons.
 *
 * Non-retired desired docs override matching entries.
 *
 * `retired` docs are removed from the target map only when no customers
 * are mounted on that gateway. Retired-with-customers stays in the map
 * (drained: pod up, no new placements) until migration completes; only
 * when `mountedByGatewayId.get(gatewayId)` is empty does helm uninstall
 * the deployment.
 */
export function buildHelmTargetMap(
  desired: GatewayDesiredState[],
  actual: HelmInstancesMap,
  mountedByGatewayId: Map<string, readonly string[]> = new Map(),
): HelmInstancesMap {
  const out: HelmInstancesMap = { ...actual };
  for (const d of desired) {
    if (d.desiredStatus === "retired") {
      const mounted = mountedByGatewayId.get(d.gatewayId);
      // No heartbeat doc → gateway never published, no customers exist,
      // safe to remove (this is the stranded-crash-loop canary case).
      // Heartbeat exists with zero customers → safe to remove.
      // Heartbeat exists with customers → preserve (drain wait); the
      // retire-gateway operation handler refuses this case before we
      // ever get here, so reaching it would be operator-set drift.
      if (mounted === undefined || mounted.length === 0) {
        delete out[d.instanceName];
      }
      continue;
    }
    out[d.instanceName] = {
      enabled: true,
      image: { repository: d.imageRepository, tag: d.imageTag },
      gatewayId: d.gatewayId,
    };
  }
  return out;
}

export function diffInstancesMap(
  actual: HelmInstancesMap,
  desired: HelmInstancesMap,
): ReconcileChange[] {
  const changes: ReconcileChange[] = [];
  const allNames = new Set([
    ...Object.keys(actual),
    ...Object.keys(desired),
  ]);
  const actualEntries = new Map(Object.entries(actual));
  const desiredEntries = new Map(Object.entries(desired));
  for (const name of allNames) {
    const a = actualEntries.get(name);
    const d = desiredEntries.get(name);
    if (!a && d) {
      changes.push({ kind: "create", instanceName: name, to: d });
    } else if (a && !d) {
      changes.push({ kind: "drift", instanceName: name, current: a });
    } else if (a && d && !instanceEqual(a, d)) {
      changes.push({ kind: "update", instanceName: name, from: a, to: d });
    }
  }
  return changes;
}

function instanceEqual(a: HelmInstanceValue, b: HelmInstanceValue): boolean {
  return (
    a.enabled === b.enabled &&
    a.image.repository === b.image.repository &&
    a.image.tag === b.image.tag &&
    a.gatewayId === b.gatewayId
  );
}
