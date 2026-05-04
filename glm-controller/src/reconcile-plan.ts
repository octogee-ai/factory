import type {
  GatewayDesiredState,
  HelmInstanceValue,
  HelmInstancesMap,
} from "../../shared/types/glm.js";

export type ReconcileChange =
  | { kind: "create"; instanceName: string; to: HelmInstanceValue }
  | { kind: "update"; instanceName: string; from: HelmInstanceValue; to: HelmInstanceValue }
  | { kind: "drift"; instanceName: string; current: HelmInstanceValue };

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
 * default — the controller never auto-deletes. Non-retired desired-state
 * docs override matching entries; retired docs are left for PR 4's
 * explicit retire flow to handle.
 */
export function buildHelmTargetMap(
  desired: GatewayDesiredState[],
  actual: HelmInstancesMap,
): HelmInstancesMap {
  const out: HelmInstancesMap = { ...actual };
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
