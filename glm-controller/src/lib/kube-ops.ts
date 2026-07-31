export interface KubeOps {
  scaleDeployment(opts: {
    namespace: string;
    name: string;
    replicas: number;
  }): Promise<void>;
  restartOpenClawInPlace(opts: {
    namespace: string;
    name: string;
  }): Promise<void>;
  readDeployedReplicas(opts: {
    namespace: string;
    name: string;
  }): Promise<number | null>;
  readAvailableReplicas(opts: {
    namespace: string;
    name: string;
  }): Promise<number | null>;
  readGatewayPodDiagnostics(opts: {
    namespace: string;
    gatewayId: string;
  }): Promise<GatewayPodDiagnostics>;
  readGatewayPodDiagnosticsBatch(opts: {
    namespace: string;
    gatewayIds: readonly string[];
  }): Promise<Record<string, GatewayPodDiagnostics>>;
  readGatewaySpotCapacity(opts: {
    namespace: string;
    gatewayId: string;
  }): Promise<GatewaySpotCapacityObservation>;
  deletePersistentVolumeClaim(opts: {
    namespace: string;
    name: string;
  }): Promise<void>;
  deleteSecret(opts: {
    namespace: string;
    name: string;
  }): Promise<void>;
  deleteServiceAccount(opts: {
    namespace: string;
    name: string;
  }): Promise<void>;
  deleteService(opts: {
    namespace: string;
    name: string;
  }): Promise<void>;
}

export type GatewayPodDiagnosticsStatus = "ready" | "not-ready" | "missing" | "unknown";

export interface GatewayPodDiagnostic {
  name: string;
  phase: string;
  readyContainers: number;
  totalContainers: number;
  restarts: number;
  reason: string | null;
  nodeName: string | null;
  ageMs: number | null;
}

export interface GatewayPodDiagnostics {
  status: GatewayPodDiagnosticsStatus;
  totalPods: number;
  readyPods: number;
  totalRestarts: number;
  pods: GatewayPodDiagnostic[];
  error?: string;
}

export type GatewayPodCapacityClass = "spot" | "on-demand" | "unknown";

export interface GatewaySpotCapacityPod {
  uid: string;
  name: string;
  phase: string;
  ready: boolean;
  nodeName: string | null;
  capacityClass: GatewayPodCapacityClass;
}

export interface GatewaySpotCapacityObservation {
  status: "ready-spot" | "ready-on-demand" | "not-ready" | "missing" | "unknown";
  totalPods: number;
  readyPods: number;
  readySpotPods: number;
  readyOnDemandPods: number;
  pods: GatewaySpotCapacityPod[];
  error?: string;
}

export interface KubectlSubprocessResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type KubectlSubprocess = (args: string[]) => Promise<KubectlSubprocessResult>;

export interface KubeOpsRunnerDeps {
  runKubectl: KubectlSubprocess;
  log: (msg: string) => void;
  now?: () => number;
}

async function deleteKubeResource(
  deps: KubeOpsRunnerDeps,
  resource: "pvc" | "secret" | "serviceaccount" | "service",
  opts: { namespace: string; name: string },
): Promise<void> {
  const result = await deps.runKubectl([
    "-n",
    opts.namespace,
    "delete",
    `${resource}/${opts.name}`,
    "--ignore-not-found=true",
  ]);
  if (result.code !== 0) {
    throw new Error(
      `kubectl delete ${resource}/${opts.name} ns=${opts.namespace} failed (code=${result.code}): ${
        result.stderr.trim() || result.stdout.trim()
      }`,
    );
  }
  deps.log(`[kube-ops] deleted ${resource}/${opts.name} ns=${opts.namespace}`);
}

const NOT_FOUND_PATTERN = /\(NotFound\)/;

function isNotFound(stderr: string): boolean {
  return NOT_FOUND_PATTERN.test(stderr);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function podUid(pod: Record<string, unknown>): string | null {
  const metadata = isRecord(pod.metadata) ? pod.metadata : {};
  return stringOrNull(metadata.uid);
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function containerWaitingReason(status: Record<string, unknown>): string | null {
  const state = isRecord(status.state) ? status.state : {};
  const waiting = isRecord(state.waiting) ? state.waiting : {};
  const terminated = isRecord(state.terminated) ? state.terminated : {};
  return stringOrNull(waiting.reason) ?? stringOrNull(terminated.reason);
}

function podConditionReason(status: Record<string, unknown>): string | null {
  const conditions = Array.isArray(status.conditions) ? status.conditions : [];
  for (const condition of conditions) {
    if (!isRecord(condition)) continue;
    if (condition.type === "Ready" && condition.status !== "True") {
      return stringOrNull(condition.reason) ?? stringOrNull(condition.message);
    }
  }
  return null;
}

function podReady(status: Record<string, unknown>): boolean {
  const conditions = Array.isArray(status.conditions) ? status.conditions : [];
  return conditions.some((condition) =>
    isRecord(condition) && condition.type === "Ready" && condition.status === "True");
}

function projectPodDiagnostic(pod: Record<string, unknown>, now: number): GatewayPodDiagnostic {
  const metadata = isRecord(pod.metadata) ? pod.metadata : {};
  const spec = isRecord(pod.spec) ? pod.spec : {};
  const status = isRecord(pod.status) ? pod.status : {};
  const containerStatuses = Array.isArray(status.containerStatuses)
    ? status.containerStatuses.filter(isRecord)
    : [];
  const readyContainers = containerStatuses.filter((c) => c.ready === true).length;
  const totalContainers = containerStatuses.length;
  const restarts = containerStatuses.reduce(
    (sum, c) => sum + numberOrZero(c.restartCount),
    0,
  );
  const reason =
    containerStatuses.map(containerWaitingReason).find((v): v is string => v !== null) ??
    stringOrNull(status.reason) ??
    podConditionReason(status);
  const createdAt = stringOrNull(metadata.creationTimestamp);
  const createdMs = createdAt ? Date.parse(createdAt) : NaN;
  return {
    name: stringOrNull(metadata.name) ?? "unknown",
    phase: stringOrNull(status.phase) ?? "Unknown",
    readyContainers,
    totalContainers,
    restarts,
    reason,
    nodeName: stringOrNull(spec.nodeName),
    ageMs: Number.isFinite(createdMs) ? Math.max(0, now - createdMs) : null,
  };
}

function summarizePodDiagnostics(
  stdout: string,
  now: number,
): GatewayPodDiagnostics {
  const parsed = JSON.parse(stdout) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed.items)) {
    throw new Error("kubectl get pods returned invalid JSON shape");
  }
  return summarizePodRecords(parsed.items.filter(isRecord), now);
}

function summarizePodRecords(
  podRecords: readonly Record<string, unknown>[],
  now: number,
): GatewayPodDiagnostics {
  const pods = podRecords.map((pod) => projectPodDiagnostic(pod, now));
  const totalPods = pods.length;
  const readyPods = pods.filter(
    (pod) =>
      pod.phase === "Running" &&
      pod.totalContainers > 0 &&
      pod.readyContainers === pod.totalContainers,
  ).length;
  const totalRestarts = pods.reduce((sum, pod) => sum + pod.restarts, 0);
  let status: GatewayPodDiagnosticsStatus = "not-ready";
  if (totalPods === 0) {
    status = "missing";
  } else if (readyPods === totalPods) {
    status = "ready";
  }
  return {
    status,
    totalPods,
    readyPods,
    totalRestarts,
    pods,
  };
}

function nodeCapacityClass(stdout: string): GatewayPodCapacityClass {
  const parsed = JSON.parse(stdout) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("kubectl get node returned invalid JSON shape");
  }
  const metadata = isRecord(parsed.metadata) ? parsed.metadata : {};
  const labels = isRecord(metadata.labels) ? metadata.labels : {};
  return labels["cloud.google.com/gke-spot"] === "true" ? "spot" : "on-demand";
}

function summarizeGatewaySpotCapacity(
  podsStdout: string,
  nodeClasses: ReadonlyMap<string, GatewayPodCapacityClass>,
): GatewaySpotCapacityObservation {
  const parsed = JSON.parse(podsStdout) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed.items)) {
    throw new Error("kubectl get pods returned invalid JSON shape");
  }
  const pods = parsed.items.filter(isRecord).flatMap((pod) => {
    const metadata = isRecord(pod.metadata) ? pod.metadata : {};
    const spec = isRecord(pod.spec) ? pod.spec : {};
    const status = isRecord(pod.status) ? pod.status : {};
    const uid = podUid(pod);
    if (!uid) return [];
    const nodeName = stringOrNull(spec.nodeName);
    return [{
      uid,
      name: stringOrNull(metadata.name) ?? "unknown",
      phase: stringOrNull(status.phase) ?? "Unknown",
      ready: stringOrNull(status.phase) === "Running" && podReady(status),
      nodeName,
      capacityClass: nodeName ? nodeClasses.get(nodeName) ?? "unknown" : "unknown",
    }];
  });
  const readyPods = pods.filter((pod) => pod.ready).length;
  const readySpotPods = pods.filter(
    (pod) => pod.ready && pod.capacityClass === "spot",
  ).length;
  const readyOnDemandPods = pods.filter(
    (pod) => pod.ready && pod.capacityClass === "on-demand",
  ).length;
  const status = gatewaySpotCapacityStatus({
    totalPods: pods.length,
    readySpotPods,
    readyOnDemandPods,
  });
  return {
    status,
    totalPods: pods.length,
    readyPods,
    readySpotPods,
    readyOnDemandPods,
    pods,
  };
}

function gatewaySpotCapacityStatus(input: {
  totalPods: number;
  readySpotPods: number;
  readyOnDemandPods: number;
}): GatewaySpotCapacityObservation["status"] {
  if (input.totalPods === 0) return "missing";
  if (input.readySpotPods > 0) return "ready-spot";
  if (input.readyOnDemandPods > 0) return "ready-on-demand";
  return "not-ready";
}

function gatewayPodNodeNames(stdout: string): string[] {
  const parsed = JSON.parse(stdout) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed.items)) {
    throw new Error("kubectl get pods returned invalid JSON shape");
  }
  return [...new Set(parsed.items.filter(isRecord).flatMap((pod) => {
    const spec = isRecord(pod.spec) ? pod.spec : {};
    const nodeName = stringOrNull(spec.nodeName);
    return nodeName ? [nodeName] : [];
  }))];
}

function gatewayIdForPod(pod: Record<string, unknown>): string | null {
  const metadata = isRecord(pod.metadata) ? pod.metadata : {};
  const labels = isRecord(metadata.labels) ? metadata.labels : {};
  return stringOrNull(labels["gateway-instance"]);
}

function summarizeGatewayPodDiagnosticsBatch(
  stdout: string,
  gatewayIds: readonly string[],
  now: number,
): Record<string, GatewayPodDiagnostics> {
  const parsed = JSON.parse(stdout) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed.items)) {
    throw new Error("kubectl get pods returned invalid JSON shape");
  }
  const requested = new Set(gatewayIds);
  const podsByGatewayId = new Map<string, Record<string, unknown>[]>();
  for (const pod of parsed.items.filter(isRecord)) {
    const gatewayId = gatewayIdForPod(pod);
    if (!gatewayId || !requested.has(gatewayId)) continue;
    const pods = podsByGatewayId.get(gatewayId) ?? [];
    pods.push(pod);
    podsByGatewayId.set(gatewayId, pods);
  }
  return Object.fromEntries(
    gatewayIds.map((gatewayId) => [
      gatewayId,
      summarizePodRecords(podsByGatewayId.get(gatewayId) ?? [], now),
    ]),
  );
}

function unknownPodDiagnostics(error?: string): GatewayPodDiagnostics {
  return {
    status: "unknown",
    totalPods: 0,
    readyPods: 0,
    totalRestarts: 0,
    pods: [],
    ...(error ? { error } : {}),
  };
}

async function readGatewaySpotCapacity(
  deps: KubeOpsRunnerDeps,
  input: { namespace: string; gatewayId: string },
): Promise<GatewaySpotCapacityObservation> {
  const pods = await deps.runKubectl([
    "-n",
    input.namespace,
    "get",
    "pods",
    "-l",
    `app=octogee-gateway,gateway-instance=${input.gatewayId}`,
    "-o",
    "json",
  ]);
  if (pods.code !== 0) {
    if (isNotFound(pods.stderr)) {
      return {
        status: "unknown",
        totalPods: 0,
        readyPods: 0,
        readySpotPods: 0,
        readyOnDemandPods: 0,
        pods: [],
        error: "pods not found",
      };
    }
    throw new Error(
      `kubectl get pods gateway-instance=${input.gatewayId} ns=${input.namespace} failed (code=${pods.code}): ${
        pods.stderr.trim() || pods.stdout.trim()
      }`,
    );
  }
  const nodeNames = gatewayPodNodeNames(pods.stdout);
  const observations = await Promise.all(nodeNames.map(async (nodeName) => {
    const node = await deps.runKubectl(["get", "node", nodeName, "-o", "json"]);
    if (node.code !== 0) {
      if (isNotFound(node.stderr)) return [nodeName, "unknown"] as const;
      throw new Error(
        `kubectl get node ${nodeName} failed (code=${node.code}): ${
          node.stderr.trim() || node.stdout.trim()
        }`,
      );
    }
    return [nodeName, nodeCapacityClass(node.stdout)] as const;
  }));
  return summarizeGatewaySpotCapacity(pods.stdout, new Map(observations));
}

export function createKubeSubprocessRunner(deps: KubeOpsRunnerDeps): KubeOps {
  return {
    async scaleDeployment({ namespace, name, replicas }) {
      if (!Number.isInteger(replicas) || replicas < 0) {
        throw new Error(
          `scaleDeployment: replicas must be a non-negative integer (got ${replicas})`,
        );
      }
      const args = [
        "-n",
        namespace,
        "scale",
        `deploy/${name}`,
        `--replicas=${replicas}`,
      ];
      const result = await deps.runKubectl(args);
      if (result.code !== 0) {
        if (isNotFound(result.stderr)) {
          deps.log(
            `[kube-ops] scale deploy/${name} ns=${namespace} — deployment not found, no-op (idempotent)`,
          );
          return;
        }
        throw new Error(
          `kubectl scale deploy/${name} ns=${namespace} failed (code=${result.code}): ${
            result.stderr.trim() || result.stdout.trim()
          }`,
        );
      }
      deps.log(
        `[kube-ops] scaled deploy/${name} ns=${namespace} → replicas=${replicas}`,
      );
    },

    async restartOpenClawInPlace({ namespace, name }) {
      // In-process OpenClaw restart via the gateway's own RPC — NOT a pod
      // reroll. `openclaw gateway restart --safe` asks the running gateway to
      // restart itself (self-authorizing over the local RPC); in a container
      // (no systemd/launchd) OpenClaw does an in-process restart, so the pod
      // stays up and restartCount is unchanged. `--skip-deferral` bypasses the
      // active-work idle-drain wait so an operator click restarts promptly.
      // `-c gateway` targets the container that holds the openclaw CLI +
      // process (not gateway-edge). Requires the gateway to be reachable —
      // an unreachable/crash-looping pod needs a true reroll, which the
      // operator drives separately.
      const args = [
        "-n",
        namespace,
        "exec",
        `deploy/${name}`,
        "-c",
        "gateway",
        "--",
        "openclaw",
        "gateway",
        "restart",
        "--safe",
        "--skip-deferral",
      ];
      const result = await deps.runKubectl(args);
      if (result.code !== 0) {
        throw new Error(
          `openclaw gateway restart (in-place) deploy/${name} ns=${namespace} failed (code=${result.code}): ${
            result.stderr.trim() || result.stdout.trim()
          }`,
        );
      }
      deps.log(
        `[kube-ops] in-process OpenClaw restart deploy/${name} ns=${namespace}`,
      );
    },

    async readDeployedReplicas({ namespace, name }) {
      const args = [
        "-n",
        namespace,
        "get",
        `deploy/${name}`,
        "-o",
        "jsonpath={.spec.replicas}",
      ];
      const result = await deps.runKubectl(args);
      if (result.code !== 0) {
        if (isNotFound(result.stderr)) return null;
        throw new Error(
          `kubectl get deploy/${name} ns=${namespace} failed (code=${result.code}): ${
            result.stderr.trim() || result.stdout.trim()
          }`,
        );
      }
      const raw = result.stdout.trim();
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0) {
        throw new Error(
          `kubectl get deploy/${name} ns=${namespace}: unparseable replicas '${raw}'`,
        );
      }
      return n;
    },

    async readAvailableReplicas({ namespace, name }) {
      const args = [
        "-n",
        namespace,
        "get",
        `deploy/${name}`,
        "-o",
        "jsonpath={.status.availableReplicas}",
      ];
      const result = await deps.runKubectl(args);
      if (result.code !== 0) {
        if (isNotFound(result.stderr)) return null;
        throw new Error(
          `kubectl get deploy/${name} ns=${namespace} failed (code=${result.code}): ${
            result.stderr.trim() || result.stdout.trim()
          }`,
        );
      }
      const raw = result.stdout.trim();
      if (raw === "") return 0;
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0) {
        throw new Error(
          `kubectl get deploy/${name} ns=${namespace}: unparseable availableReplicas '${raw}'`,
        );
      }
      return n;
    },

    async readGatewayPodDiagnostics({ namespace, gatewayId }) {
      const args = [
        "-n",
        namespace,
        "get",
        "pods",
        "-l",
        `gateway-instance=${gatewayId}`,
        "-o",
        "json",
      ];
      const result = await deps.runKubectl(args);
      if (result.code !== 0) {
        if (isNotFound(result.stderr)) return unknownPodDiagnostics("pods not found");
        throw new Error(
          `kubectl get pods gateway-instance=${gatewayId} ns=${namespace} failed (code=${result.code}): ${
            result.stderr.trim() || result.stdout.trim()
          }`,
        );
      }
      return summarizePodDiagnostics(result.stdout, deps.now?.() ?? Date.now());
    },

    async readGatewayPodDiagnosticsBatch({ namespace, gatewayIds }) {
      const args = [
        "-n",
        namespace,
        "get",
        "pods",
        "-l",
        "app=octogee-gateway",
        "-o",
        "json",
      ];
      const result = await deps.runKubectl(args);
      if (result.code !== 0) {
        if (isNotFound(result.stderr)) {
          return Object.fromEntries(
            gatewayIds.map((gatewayId) => [
              gatewayId,
              unknownPodDiagnostics("pods not found"),
            ]),
          );
        }
        throw new Error(
          `kubectl get gateway pods ns=${namespace} failed (code=${result.code}): ${
            result.stderr.trim() || result.stdout.trim()
          }`,
        );
      }
      return summarizeGatewayPodDiagnosticsBatch(
        result.stdout,
        gatewayIds,
        deps.now?.() ?? Date.now(),
      );
    },

    readGatewaySpotCapacity: (input) => readGatewaySpotCapacity(deps, input),

    async deletePersistentVolumeClaim({ namespace, name }) {
      await deleteKubeResource(deps, "pvc", { namespace, name });
    },

    async deleteSecret({ namespace, name }) {
      await deleteKubeResource(deps, "secret", { namespace, name });
    },

    async deleteServiceAccount({ namespace, name }) {
      await deleteKubeResource(deps, "serviceaccount", { namespace, name });
    },

    async deleteService({ namespace, name }) {
      await deleteKubeResource(deps, "service", { namespace, name });
    },
  };
}

export function createLoggingKubeOps(log: (msg: string) => void): KubeOps {
  return {
    scaleDeployment: async ({ namespace, name, replicas }) => {
      log(`[kube-ops:stub] scale ns=${namespace} ${name} → ${replicas} — no exec`);
    },
    restartOpenClawInPlace: async ({ namespace, name }) => {
      log(`[kube-ops:stub] in-process OpenClaw restart ns=${namespace} ${name} — no exec`);
    },
    readDeployedReplicas: async ({ namespace, name }) => {
      log(`[kube-ops:stub] readReplicas ns=${namespace} ${name} — returning null`);
      return null;
    },
    readAvailableReplicas: async ({ namespace, name }) => {
      log(`[kube-ops:stub] readAvailableReplicas ns=${namespace} ${name} — returning null`);
      return null;
    },
    readGatewayPodDiagnostics: async ({ namespace, gatewayId }) => {
      log(`[kube-ops:stub] readGatewayPodDiagnostics ns=${namespace} ${gatewayId} — returning unknown`);
      return unknownPodDiagnostics();
    },
    readGatewayPodDiagnosticsBatch: async ({ namespace, gatewayIds }) => {
      log(
        `[kube-ops:stub] readGatewayPodDiagnosticsBatch ns=${namespace} gateways=${gatewayIds.join(",")} — returning unknown`,
      );
      return Object.fromEntries(
        gatewayIds.map((gatewayId) => [gatewayId, unknownPodDiagnostics()]),
      );
    },
    readGatewaySpotCapacity: async ({ namespace, gatewayId }) => {
      log(
        `[kube-ops:stub] readGatewaySpotCapacity ns=${namespace} ${gatewayId} — returning unknown`,
      );
      return {
        status: "unknown",
        totalPods: 0,
        readyPods: 0,
        readySpotPods: 0,
        readyOnDemandPods: 0,
        pods: [],
      };
    },
    deletePersistentVolumeClaim: async ({ namespace, name }) => {
      log(`[kube-ops:stub] delete pvc ns=${namespace} ${name} — no exec`);
    },
    deleteSecret: async ({ namespace, name }) => {
      log(`[kube-ops:stub] delete secret ns=${namespace} ${name} — no exec`);
    },
    deleteServiceAccount: async ({ namespace, name }) => {
      log(`[kube-ops:stub] delete serviceaccount ns=${namespace} ${name} — no exec`);
    },
    deleteService: async ({ namespace, name }) => {
      log(`[kube-ops:stub] delete service ns=${namespace} ${name} — no exec`);
    },
  };
}
