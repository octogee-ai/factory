import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { TEST_CONTEXT, TEST_NAMESPACE } from "./gateway-load-test.js";

const execute = promisify(execFile);
type Pod = {
  metadata: { name: string; uid: string; deletionTimestamp?: string; labels?: Record<string, string> };
  spec: { nodeName: string; containers: { name: string; resources?: { limits?: Record<string, string>; requests?: Record<string, string> }; image: string }[] };
  status: { containerStatuses?: { name: string; ready: boolean; restartCount: number }[] };
};

function assertReadyPod(pod: Pod): void {
  if (pod.metadata.deletionTimestamp || pod.metadata.labels?.tier !== "m"
    || pod.status.containerStatuses?.length !== pod.spec.containers.length || pod.status.containerStatuses.some((c) => !c.ready)) {
    throw new Error("Require a Ready Medium gateway with every container Ready");
  }
}

export function stableMediumPod(pods: Pod[]): Pod {
  if (pods.length !== 1) throw new Error("Require exactly one pod: wait for surge/old-pod retirement before load testing");
  const pod = pods[0];
  assertReadyPod(pod);
  const main = pod.spec.containers.find((c) => c.name === "gateway");
  if (!main?.resources) throw new Error("Missing gateway resources");
  for (const values of [main.resources.requests ?? {}, main.resources.limits ?? {}]) {
    if (!["2", "2000m"].includes(values.cpu) || values.memory !== "8Gi") throw new Error("Medium must request and limit 2CPU/8GiB");
  }
  return pod;
}

interface SampleBaseline { uid: string; restarts: number; oom: number }

function resourceViolations(current: SampleBaseline, memoryRatio: number, baseline?: SampleBaseline): string[] {
  const violations: string[] = [];
  if (baseline) {
    if (baseline.uid !== current.uid) violations.push("pod-replaced");
    if (current.restarts > baseline.restarts) violations.push("container-restart");
    if (current.oom > baseline.oom) violations.push("oom-kill");
  }
  if (memoryRatio >= 0.9) violations.push("memory-above-90-percent");
  return violations;
}

export function parseCgroup(text: string): Record<string, Record<string, number>> {
  const result: Record<string, Record<string, number>> = {};
  let section = "";
  for (const line of text.trim().split("\n")) {
    if (line.startsWith("FILE ")) { section = line.slice(5); result[section] = {}; continue; }
    if (!section) throw new Error("Invalid cgroup sample");
    const parts = line.trim().split(/\s+/);
    if (parts.length === 1) result[section].value = Number(parts[0]);
    else if (parts.length === 2) result[section][parts[0]] = Number(parts[1]);
    else for (const field of parts.slice(1)) {
      const [key, raw] = field.split("=");
      if (raw !== undefined) result[section][`${parts[0]}.${key}`] = Number(raw);
    }
  }
  for (const field of ["memory.current", "memory.events", "memory.stat", "cpu.stat"]) {
    if (!result[field] || Object.values(result[field]).some((v) => !Number.isFinite(v))) throw new Error(`Missing or invalid ${field}`);
  }
  if (![result["memory.current"].value, result["cpu.stat"].usage_usec,
    result["cpu.stat"].nr_periods, result["cpu.stat"].nr_throttled, result["memory.events"].oom_kill,
  ].every(Number.isFinite)) throw new Error("Incomplete cgroup counters");
  return result;
}

export function createLoadSampler(gatewayId: string) {
  let baseline: SampleBaseline | undefined;
  let prior: { at: number; cpu: Record<string, number> } | undefined;
  const kubectl = async (...args: string[]) => {
    const { stdout } = await execute("kubectl", ["--context", TEST_CONTEXT, "--request-timeout=15s", "-n", TEST_NAMESPACE, ...args],
      { timeout: 25_000, maxBuffer: 2 * 1024 * 1024 });
    return stdout;
  };
  return async () => {
    const pods = JSON.parse(await kubectl("get", "pods", "-l", `gateway-id=${gatewayId}`, "-o", "json"));
    const pod = stableMediumPod(pods.items);
    const raw = await kubectl("exec", pod.metadata.name, "-c", "gateway", "--", "sh", "-c",
      'set -e; for f in cpu.stat cpu.pressure memory.current memory.stat memory.events memory.pressure io.pressure io.stat; do echo "FILE $f"; cat "/sys/fs/cgroup/$f"; done');
    const groups = parseCgroup(raw);
    const nodeMetrics = JSON.parse(await kubectl("get", "--raw", `/apis/metrics.k8s.io/v1beta1/nodes/${pod.spec.nodeName}`));
    if (typeof nodeMetrics.usage?.cpu !== "string" || typeof nodeMetrics.usage?.memory !== "string") {
      throw new Error("Missing node usage metrics");
    }
    const filesystem = await kubectl("exec", pod.metadata.name, "-c", "gateway", "--", "sh", "-c", 'set -e; df -Pk "${OPENCLAW_DIR:-/home/node/.openclaw}"; df -Pi "${OPENCLAW_DIR:-/home/node/.openclaw}"');
    const at = Date.now();
    const cpu = groups["cpu.stat"];
    const chargedBytes = groups["memory.current"].value;
    const workingSetBytes = Math.max(0, chargedBytes - (groups["memory.stat"].inactive_file ?? 0));
    const memoryRatio = workingSetBytes / (8 * 1024 ** 3);
    const restarts = pod.status.containerStatuses!.reduce((n, c) => n + c.restartCount, 0);
    const oom = groups["memory.events"].oom_kill ?? 0;
    const elapsed = prior ? (at - prior.at) / 1_000 : 0;
    const periods = prior ? cpu.nr_periods - prior.cpu.nr_periods : 0;
    const cpuCores = prior && elapsed > 0 ? (cpu.usage_usec - prior.cpu.usage_usec) / 1e6 / elapsed : null;
    const throttledPeriodRatio = prior && periods > 0 ? (cpu.nr_throttled - prior.cpu.nr_throttled) / periods : null;
    const violations = resourceViolations({ uid: pod.metadata.uid, restarts, oom }, memoryRatio, baseline);
    baseline ??= { uid: pod.metadata.uid, restarts, oom };
    prior = { at, cpu };
    return { at: new Date(at).toISOString(), pod: pod.metadata.name, uid: pod.metadata.uid,
      node: pod.spec.nodeName, image: pod.spec.containers.find((c) => c.name === "gateway")!.image,
      memoryRatio, workingSetBytes, chargedBytes, cpuCores, throttledPeriodRatio, restarts, cgroup: groups,
      nodeUsage: nodeMetrics.usage, nodeMetricTimestamp: nodeMetrics.timestamp, filesystem, violations };
  };
}
