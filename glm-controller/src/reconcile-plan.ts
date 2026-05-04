import type {
  GatewayDesiredState,
  HelmInstanceValue,
  HelmInstancesMap,
} from "../../shared/types/glm";

export type ReconcileChange =
  | { kind: "create"; instanceName: string; to: HelmInstanceValue }
  | { kind: "update"; instanceName: string; from: HelmInstanceValue; to: HelmInstanceValue }
  | { kind: "remove"; instanceName: string };

export function buildInstancesMap(
  desired: GatewayDesiredState[],
): HelmInstancesMap {
  const out: HelmInstancesMap = {};
  for (const d of desired) {
    // `retired` removes the instance slot entirely (helm uninstalls).
    // `draining` keeps the pod up so existing customers stay served;
    // the orchestrator separately blocks new placements via a different
    // mechanism (controller-side flag, not the helm chart). Mapping
    // `draining` to enabled=false would tear down the pod and strand
    // mounted customers — exactly the wrong outcome.
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
  for (const name of allNames) {
    const a = actual[name];
    const d = desired[name];
    if (!a && d) {
      changes.push({ kind: "create", instanceName: name, to: d });
    } else if (a && !d) {
      changes.push({ kind: "remove", instanceName: name });
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
