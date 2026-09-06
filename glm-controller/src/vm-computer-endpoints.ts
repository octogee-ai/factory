import { gatewayVmPodName, resolveGatewayRuntime, type GatewayVmState } from "@octogee/shared/types/glm";
import type { SurgePod, SurgePodSnapshot } from "./surge-customer-handoff.js";

export type ComputerEndpoint = Omit<SurgePod, "ready">;

export type ComputerReadinessProbe = (endpoint: ComputerEndpoint, gatewayId: string) => Promise<boolean>;

export function computerEndpointFromVm(gatewayId: string, vm: Partial<GatewayVmState> | null | undefined): ComputerEndpoint | null {
  if (
    !vm ||
    vm.status !== "RUNNING" ||
    typeof vm.instanceId !== "string" || vm.instanceId.length === 0 ||
    typeof vm.instanceName !== "string" ||
    typeof vm.internalIp !== "string" || vm.internalIp.length === 0
  ) {
    return null;
  }
  return { uid: gatewayVmPodName(gatewayId, vm.instanceId), name: vm.instanceName, podIP: vm.internalIp, terminating: false };
}

export async function listComputerEndpoints(
  vm: Partial<GatewayVmState> | null | undefined,
  gatewayId: string,
  readComputerReady: ComputerReadinessProbe,
): Promise<SurgePodSnapshot> {
  const observedPodUids = typeof vm?.instanceId === "string" && vm.instanceId.length > 0 ? [gatewayVmPodName(gatewayId, vm.instanceId)] : [];
  const endpoint = computerEndpointFromVm(gatewayId, vm);
  if (!endpoint) return { pods: [], observedPodUids };
  const ready = await readComputerReady(endpoint, gatewayId);
  return { pods: [{ ...endpoint, ready }], observedPodUids };
}

export function createSurgeEndpointLister(input: {
  readRuntimeDoc: (gatewayId: string) => Promise<unknown>;
  listPods: (gatewayId: string) => Promise<SurgePodSnapshot>;
  readComputerReady: ComputerReadinessProbe;
}): (gatewayId: string) => Promise<SurgePodSnapshot> {
  return async (gatewayId) => {
    const doc = (await input.readRuntimeDoc(gatewayId)) as { runtime?: unknown; vm?: Partial<GatewayVmState> | null } | undefined;
    if (resolveGatewayRuntime(doc?.runtime) !== "gce-vm") return input.listPods(gatewayId);
    return listComputerEndpoints(doc?.vm, gatewayId, input.readComputerReady);
  };
}

export function createComputerReadinessProbe(opts: {
  port: string | number;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  log: (message: string) => void;
}): ComputerReadinessProbe {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const lastOutcome = new Map<string, string>();
  const report = (endpoint: ComputerEndpoint, outcome: string, message: string): void => {
    if (lastOutcome.get(endpoint.uid) === outcome) return;
    lastOutcome.set(endpoint.uid, outcome);
    opts.log(message);
  };
  return async (endpoint, gatewayId) => {
    const host = endpoint.podIP.includes(":") ? `[${endpoint.podIP}]` : endpoint.podIP;
    try {
      const response = await fetchImpl(`http://${host}:${opts.port}/surge-ready`, {
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
      const verdict = response.ok ? "passing" : `failing (HTTP ${response.status})`;
      report(endpoint, `http:${response.ok}`, `[surge-handoff] ${gatewayId}: readiness probe of ${endpoint.name} is ${verdict}`);
      return response.ok;
    } catch (error) {
      report(endpoint, "unreachable", `[surge-handoff] ${gatewayId}: readiness probe of ${endpoint.name} failed — ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };
}
