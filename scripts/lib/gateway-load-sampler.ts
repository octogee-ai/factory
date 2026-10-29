import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { TEST_CONTEXT, TEST_NAMESPACE } from "./gateway-load-test.js";

const execute = promisify(execFile);
type Pod = {
  metadata: { name: string; uid: string; deletionTimestamp?: string; labels?: Record<string, string> };
  spec: { nodeName: string; containers: { name: string; resources?: { limits?: Record<string, string>; requests?: Record<string, string> }; image: string }[] };
  status: { containerStatuses?: { name: string; ready: boolean; restartCount: number }[] };
};

export type Kubectl = (...args: string[]) => Promise<string>;

export function testKubectl(): Kubectl {
  return async (...args) => {
    const { stdout } = await execute("kubectl", ["--context", TEST_CONTEXT, "--request-timeout=15s", "-n", TEST_NAMESPACE, ...args],
      { timeout: 25_000, maxBuffer: 2 * 1024 * 1024 });
    return stdout;
  };
}

function podIsReady(pod: Pod): boolean {
  return !pod.metadata.deletionTimestamp
    && pod.status.containerStatuses?.length === pod.spec.containers.length && pod.status.containerStatuses.every((c) => c.ready);
}

function assertReadyPod(pod: Pod): void {
  if (pod.metadata.labels?.tier !== "m" || !podIsReady(pod)) {
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

const MEMORY_UNITS: Record<string, number> = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, K: 1e3, M: 1e6, G: 1e9, T: 1e12 };

export function memoryLimitBytes(pod: Pod): number {
  const limit = pod.spec.containers.find((c) => c.name === "gateway")?.resources?.limits?.memory;
  const match = typeof limit === "string" ? /^(\d+)([KMGT]i?)?$/.exec(limit) : null;
  if (!match) throw new Error(`Missing or unsupported gateway memory limit ${JSON.stringify(limit)}`);
  return Number(match[1]) * (match[2] ? MEMORY_UNITS[match[2]] : 1);
}

interface PodSampleState { baseline?: SampleBaseline; prior?: { at: number; cpu: Record<string, number> } }

async function samplePod(kubectl: Kubectl, pod: Pod, state: PodSampleState, nodeMetrics: (node: string) => Promise<{ usage: { cpu: string; memory: string }; timestamp: unknown }>) {
  const raw = await kubectl("exec", pod.metadata.name, "-c", "gateway", "--", "sh", "-c",
    'set -e; for f in cpu.stat cpu.pressure memory.current memory.stat memory.events memory.pressure io.pressure io.stat; do echo "FILE $f"; cat "/sys/fs/cgroup/$f"; done');
  const groups = parseCgroup(raw);
  const node = await nodeMetrics(pod.spec.nodeName);
  const filesystem = await kubectl("exec", pod.metadata.name, "-c", "gateway", "--", "sh", "-c", 'set -e; df -Pk "${OPENCLAW_DIR:-/home/node/.openclaw}"; df -Pi "${OPENCLAW_DIR:-/home/node/.openclaw}"');
  const at = Date.now();
  const cpu = groups["cpu.stat"];
  const chargedBytes = groups["memory.current"].value;
  const workingSetBytes = Math.max(0, chargedBytes - (groups["memory.stat"].inactive_file ?? 0));
  const memoryRatio = workingSetBytes / memoryLimitBytes(pod);
  const restarts = pod.status.containerStatuses!.reduce((n, c) => n + c.restartCount, 0);
  const oom = groups["memory.events"].oom_kill ?? 0;
  const prior = state.prior;
  const elapsed = prior ? (at - prior.at) / 1_000 : 0;
  const periods = prior ? cpu.nr_periods - prior.cpu.nr_periods : 0;
  const cpuCores = prior && elapsed > 0 ? (cpu.usage_usec - prior.cpu.usage_usec) / 1e6 / elapsed : null;
  const throttledPeriodRatio = prior && periods > 0 ? (cpu.nr_throttled - prior.cpu.nr_throttled) / periods : null;
  const violations = resourceViolations({ uid: pod.metadata.uid, restarts, oom }, memoryRatio, state.baseline);
  state.baseline ??= { uid: pod.metadata.uid, restarts, oom };
  state.prior = { at, cpu };
  return { at: new Date(at).toISOString(), pod: pod.metadata.name, uid: pod.metadata.uid,
    node: pod.spec.nodeName, image: pod.spec.containers.find((c) => c.name === "gateway")!.image,
    memoryRatio, workingSetBytes, chargedBytes, cpuCores, throttledPeriodRatio, restarts, cgroup: groups,
    nodeUsage: node.usage, nodeMetricTimestamp: node.timestamp, filesystem, violations };
}

function nodeMetricsReader(kubectl: Kubectl) {
  const cache = new Map<string, Promise<{ usage: { cpu: string; memory: string }; timestamp: unknown }>>();
  return (node: string) => {
    let pending = cache.get(node);
    if (!pending) {
      pending = (async () => {
        const metrics = JSON.parse(await kubectl("get", "--raw", `/apis/metrics.k8s.io/v1beta1/nodes/${node}`));
        if (typeof metrics.usage?.cpu !== "string" || typeof metrics.usage?.memory !== "string") throw new Error("Missing node usage metrics");
        return metrics;
      })();
      cache.set(node, pending);
    }
    return pending;
  };
}

export function createLoadSampler(gatewayId: string, kubectl: Kubectl = testKubectl()) {
  const state: PodSampleState = {};
  return async () => {
    const pods = JSON.parse(await kubectl("get", "pods", "-l", `gateway-id=${gatewayId}`, "-o", "json"));
    return samplePod(kubectl, stableMediumPod(pods.items), state, nodeMetricsReader(kubectl));
  };
}

export const SHARED_SLOT_RE = /^shared-\d+$/;

export function sharedSlotPods(pods: Pod[]): { serving: Map<string, Pod>; starting: { slot: string; pod: string }[] } {
  const serving = new Map<string, Pod>();
  const starting: { slot: string; pod: string }[] = [];
  for (const pod of pods) {
    const slot = pod.metadata.labels?.["gateway-id"];
    if (!slot || !SHARED_SLOT_RE.test(slot)) continue;
    if (podIsReady(pod)) serving.set(slot, pod);
    else if (!pod.metadata.deletionTimestamp) starting.push({ slot, pod: pod.metadata.name });
  }
  return { serving: new Map([...serving].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))),
    starting: starting.sort((a, b) => a.slot.localeCompare(b.slot, undefined, { numeric: true })) };
}

export type SharedPoolSample = Awaited<ReturnType<ReturnType<typeof createSharedPoolSampler>>>;

export function createSharedPoolSampler(kubectl: Kubectl = testKubectl()) {
  const states = new Map<string, PodSampleState>();
  return async () => {
    const pods: Pod[] = JSON.parse(await kubectl("get", "pods", "-l", "app=octogee-gateway", "-o", "json")).items;
    const { serving, starting } = sharedSlotPods(pods);
    const present = new Set([...serving.keys(), ...starting.map((s) => s.slot)]);
    for (const slot of [...states.keys()]) if (!present.has(slot)) states.delete(slot);
    const nodeMetrics = nodeMetricsReader(kubectl);
    const slots = await Promise.all([...serving].map(async ([slot, pod]) => {
      let state = states.get(slot);
      if (!state) { state = {}; states.set(slot, state); }
      return { slot, ...(await samplePod(kubectl, pod, state, nodeMetrics)) };
    }));
    return {
      at: new Date().toISOString(), slots, starting,
      violations: slots.flatMap((s) => s.violations.map((v) => `${s.slot}:${v}`)),
    };
  };
}

export function slotObservation(sample: SharedPoolSample): { at: string; serving: string[]; starting: string[] } {
  return { at: sample.at, serving: sample.slots.map((s) => s.slot), starting: sample.starting.map((s) => s.slot) };
}
