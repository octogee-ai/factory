export interface ReleaseConvergenceBaseline {
  configuredDefaultGatewayId: string;
  predecessorPodUids: string[];
  capturedAt: number;
}

export interface ReleaseConvergenceGateway {
  gatewayId: string;
  desiredStatus: string;
  gatewayClass: string;
  desiredRelease: number;
  liveRelease: number | null;
  desiredImageTag: string | null;
}

export interface ReleaseConvergenceRolloutOperation {
  id: string;
  gatewayId: string;
  imageTag: string;
  status: string;
  error: string | null;
}

export interface ReleaseConvergenceRuntime {
  gatewayId: string;
  release: number;
  lifecycle: string;
  heartbeatStatus: string;
  heartbeatVersion: string | null;
  mountedCustomers: string[];
}

export interface ReleaseConvergenceDeployment {
  name: string;
  replicas: number;
  updatedReplicas: number;
  readyReplicas: number;
  availableReplicas: number;
}

export interface ReleaseConvergencePod {
  uid: string;
  name: string;
  phase: string;
  ready: boolean;
  images: Record<string, string>;
}

export interface ReleaseConvergenceReplicaSet {
  name: string;
  current: boolean;
  desiredReplicas: number;
  replicas: number;
}

export interface ReleaseConvergenceSnapshot {
  expectedImageTag: string;
  configuredDefaultGatewayId: string;
  gateways: ReleaseConvergenceGateway[];
  rolloutOperations: ReleaseConvergenceRolloutOperation[];
  defaultRuntime: ReleaseConvergenceRuntime | null;
  defaultAssignments: string[];
  defaultAssignmentsServing: boolean;
  deployment: ReleaseConvergenceDeployment | null;
  pods: ReleaseConvergencePod[];
  replicaSets: ReleaseConvergenceReplicaSet[];
}

export interface ReleaseConvergenceAssessment {
  converged: boolean;
  failures: string[];
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function difference(left: readonly string[], right: readonly string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((value) => !rightSet.has(value));
}

function displayValues(values: readonly string[]): string {
  return values.length === 0 ? "none" : values.join(", ");
}

function imageHasTag(image: string | undefined, expectedImageTag: string): boolean {
  if (!image) return false;
  const withoutDigest = image.split("@", 1)[0] ?? "";
  return withoutDigest.endsWith(`:${expectedImageTag}`);
}

export function imageTagMatchesArtifact(
  artifactTag: string | null | undefined,
  expectedImageTag: string,
): boolean {
  return artifactTag?.split("@", 1)[0] === expectedImageTag.split("@", 1)[0];
}

export function assessReleaseConvergence(
  snapshot: ReleaseConvergenceSnapshot,
  baseline: ReleaseConvergenceBaseline,
): ReleaseConvergenceAssessment {
  const failures: string[] = [];
  assessDefaultPointer(snapshot, baseline, failures);
  const activeGateways = assessFleet(snapshot, failures);
  assessRolloutOperations(snapshot, activeGateways, failures);
  const defaultGateway = assessDefaultGateway(snapshot, activeGateways, failures);
  assessDefaultRuntime(snapshot, defaultGateway, failures);
  assessDefaultDeployment(snapshot, baseline, failures);
  assessReplicaSets(snapshot, failures);
  return { converged: failures.length === 0, failures };
}

function assessDefaultPointer(
  snapshot: ReleaseConvergenceSnapshot,
  baseline: ReleaseConvergenceBaseline,
  failures: string[],
): void {
  if (snapshot.configuredDefaultGatewayId !== baseline.configuredDefaultGatewayId) {
    failures.push(
      `configured default changed during release: ${baseline.configuredDefaultGatewayId} -> ${snapshot.configuredDefaultGatewayId}`,
    );
  }
}

function assessFleet(
  snapshot: ReleaseConvergenceSnapshot,
  failures: string[],
): ReleaseConvergenceGateway[] {
  const activeGateways = snapshot.gateways.filter(
    (gateway) => gateway.desiredStatus !== "retired",
  );
  for (const gateway of activeGateways) {
    if (!imageTagMatchesArtifact(gateway.desiredImageTag, snapshot.expectedImageTag)) {
      failures.push(
        `gateway ${gateway.gatewayId} desired release is not tagged ${snapshot.expectedImageTag}`,
      );
    }
    if (gateway.desiredRelease !== gateway.liveRelease) {
      const liveRelease = gateway.liveRelease ?? "none";
      failures.push(
        `gateway ${gateway.gatewayId} desired/live release drift: ${gateway.desiredRelease}/${liveRelease}`,
      );
    }
  }
  return activeGateways;
}

function assessRolloutOperations(
  snapshot: ReleaseConvergenceSnapshot,
  activeGateways: readonly ReleaseConvergenceGateway[],
  failures: string[],
): void {
  const activeGatewayIds = new Set(activeGateways.map((gateway) => gateway.gatewayId));
  for (const operation of snapshot.rolloutOperations) {
    if (!activeGatewayIds.has(operation.gatewayId)) continue;
    if (!imageTagMatchesArtifact(operation.imageTag, snapshot.expectedImageTag)) continue;
    if (operation.status === "succeeded") continue;
    const suffix = operation.status === "failed" && operation.error
      ? `: ${operation.error}`
      : "";
    const status = operation.status === "failed" ? "failed" : `is ${operation.status}`;
    failures.push(
      `rollout ${operation.id} for ${operation.gatewayId} ${status}${suffix}`,
    );
  }
}

export function hasBlockingRolloutFailure(snapshot: ReleaseConvergenceSnapshot): boolean {
  const activeGatewayIds = new Set(
    snapshot.gateways
      .filter((gateway) => gateway.desiredStatus !== "retired")
      .map((gateway) => gateway.gatewayId),
  );
  return snapshot.rolloutOperations.some((operation) =>
    activeGatewayIds.has(operation.gatewayId) &&
    imageTagMatchesArtifact(operation.imageTag, snapshot.expectedImageTag) &&
    (operation.status === "failed" || operation.status === "rolled-back"));
}

function assessDefaultGateway(
  snapshot: ReleaseConvergenceSnapshot,
  activeGateways: ReleaseConvergenceGateway[],
  failures: string[],
): ReleaseConvergenceGateway | undefined {
  const defaultGateway = activeGateways.find(
    (gateway) => gateway.gatewayId === snapshot.configuredDefaultGatewayId,
  );
  if (!defaultGateway) {
    failures.push(`configured default gateway ${snapshot.configuredDefaultGatewayId} is missing`);
  } else {
    if (defaultGateway.desiredStatus !== "running") {
      failures.push(`configured default gateway is ${defaultGateway.desiredStatus}, not running`);
    }
    if (defaultGateway.gatewayClass !== "shared") {
      failures.push(`configured default gateway class is ${defaultGateway.gatewayClass}, not shared`);
    }
    if (defaultGateway.desiredRelease !== defaultGateway.liveRelease) {
      const liveRelease = defaultGateway.liveRelease ?? "none";
      failures.push(
        `configured default desired/live release drift: ${defaultGateway.desiredRelease}/${liveRelease}`,
      );
    }
  }
  return defaultGateway;
}

function assessDefaultRuntime(
  snapshot: ReleaseConvergenceSnapshot,
  defaultGateway: ReleaseConvergenceGateway | undefined,
  failures: string[],
): void {
  const runtime = snapshot.defaultRuntime;
  if (!snapshot.defaultAssignmentsServing) {
    failures.push("configured default has a non-serving assignment");
  }
  if (!runtime || runtime.gatewayId !== snapshot.configuredDefaultGatewayId) {
    failures.push("configured default runtime observation is missing");
  } else {
    if (defaultGateway && runtime.release !== defaultGateway.desiredRelease) {
      failures.push(
        `configured default runtime release ${runtime.release} is not desired release ${defaultGateway.desiredRelease}`,
      );
    }
    if (runtime.lifecycle !== "serving") {
      failures.push(`configured default runtime lifecycle is ${runtime.lifecycle}, not serving`);
    }
    if (runtime.heartbeatStatus !== "ready") {
      failures.push(`configured default heartbeat is ${runtime.heartbeatStatus}, not ready`);
    }
    if (!imageTagMatchesArtifact(runtime.heartbeatVersion, snapshot.expectedImageTag)) {
      failures.push(
        `configured default heartbeat is not tagged ${snapshot.expectedImageTag}`,
      );
    }

    const assigned = sortedUnique(snapshot.defaultAssignments);
    const mounted = sortedUnique(runtime.mountedCustomers);
    const missing = difference(assigned, mounted);
    const orphan = difference(mounted, assigned);
    if (missing.length > 0 || orphan.length > 0) {
      failures.push(
        `default assignment roster does not equal mounted customers (missing: ${displayValues(missing)}; orphan: ${displayValues(orphan)})`,
      );
    }
  }
}

function deploymentIsSingleReadyReplica(deployment: ReleaseConvergenceDeployment): boolean {
  return deployment.replicas === 1 &&
    deployment.updatedReplicas === 1 &&
    deployment.readyReplicas === 1 &&
    deployment.availableReplicas === 1;
}

function assessDefaultDeployment(
  snapshot: ReleaseConvergenceSnapshot,
  baseline: ReleaseConvergenceBaseline,
  failures: string[],
): void {
  const deployment = snapshot.deployment;
  if (!deployment) {
    failures.push("configured default Deployment is missing");
  } else if (!deploymentIsSingleReadyReplica(deployment)) {
    failures.push(
      "default Deployment does not have exactly one desired, updated, Ready, available replica",
    );
  }

  const readyPods = snapshot.pods.filter(
    (pod) => pod.phase === "Running" && pod.ready,
  );
  if (readyPods.length !== 1) {
    failures.push("default Deployment does not have exactly one Ready current pod");
  }
  for (const pod of snapshot.pods) {
    for (const container of ["gateway", "gateway-edge"] as const) {
      if (!imageHasTag(pod.images[container], snapshot.expectedImageTag)) {
        failures.push(
          `pod ${pod.name} ${container} image is not tagged ${snapshot.expectedImageTag}`,
        );
      }
    }
  }

  const remainingPredecessors = baseline.predecessorPodUids.filter(
    (uid) => snapshot.pods.some((pod) => pod.uid === uid),
  );
  if (remainingPredecessors.length > 0) {
    failures.push(`predecessor pods remain: ${remainingPredecessors.join(", ")}`);
  }
}

function assessReplicaSets(
  snapshot: ReleaseConvergenceSnapshot,
  failures: string[],
): void {
  const currentReplicaSets = snapshot.replicaSets.filter((replicaSet) => replicaSet.current);
  if (currentReplicaSets.length !== 1) {
    failures.push("default Deployment does not have exactly one current ReplicaSet");
  }
  for (const replicaSet of snapshot.replicaSets) {
    if (
      !replicaSet.current &&
      (replicaSet.desiredReplicas !== 0 || replicaSet.replicas !== 0)
    ) {
      failures.push(
        `old ReplicaSet ${replicaSet.name} still has pods (desired=${replicaSet.desiredReplicas}, observed=${replicaSet.replicas})`,
      );
    }
  }
}
