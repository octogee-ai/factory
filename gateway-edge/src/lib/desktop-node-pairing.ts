import { createRepeatSquelch } from "@octogee/shared/server/repeat-squelch";
import { GATEWAY_DESKTOP_NODE_NAME } from "@octogee/shared/types/glm";

const IPV4_MAPPED_PREFIX = "::ffff:";

function isLocalNodeAddress(address: string): boolean {
  if (address === "") return true;
  const ipv4 = address.startsWith(IPV4_MAPPED_PREFIX) ? address.slice(IPV4_MAPPED_PREFIX.length) : address;
  return ipv4 === "127.0.0.1" || address === "::1";
}
export const DESKTOP_NODE_PAIRING_INTERVAL_MS = 5_000;
export const DESKTOP_NODE_PAIRING_IDLE_INTERVAL_MS = 60_000;
export const DESKTOP_NODE_PAIRING_FAST_CHECKS = 60;

export interface DesktopNodePairingRequest {
  requestId: string;
  displayName: string;
  remoteIp: string;
  commands: string[];
}

export interface DesktopNodePairingDeps {
  invoke(method: string, params: Record<string, unknown>): Promise<unknown>;
  log(message: string, fields?: Record<string, unknown>): void;
  nodeName?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pendingRequest(entry: unknown): DesktopNodePairingRequest {
  const record = asRecord(entry);
  if (!record || typeof record.requestId !== "string" || record.requestId.length === 0) {
    throw new Error("node.pair.list returned a pending request without a requestId");
  }
  const commands = Array.isArray(record.commands)
    ? record.commands.filter((command): command is string => typeof command === "string")
    : [];
  return {
    requestId: record.requestId,
    displayName: typeof record.displayName === "string" ? record.displayName : "",
    remoteIp: typeof record.remoteIp === "string" ? record.remoteIp : "",
    commands,
  };
}

export function desktopNodePairingRequests(
  list: unknown,
  nodeName: string = GATEWAY_DESKTOP_NODE_NAME,
): DesktopNodePairingRequest[] {
  const record = asRecord(list);
  if (!record || !Array.isArray(record.pending)) {
    throw new Error("node.pair.list returned no pending array");
  }
  return record.pending
    .map(pendingRequest)
    .filter((request) => request.displayName === nodeName && isLocalNodeAddress(request.remoteIp));
}

export async function approveDesktopNodePairing(deps: DesktopNodePairingDeps): Promise<string[]> {
  const requests = desktopNodePairingRequests(await deps.invoke("node.pair.list", {}), deps.nodeName);
  for (const request of requests) {
    await deps.invoke("node.pair.approve", { requestId: request.requestId });
    deps.log("desktop node pairing approved", {
      requestId: request.requestId,
      node: request.displayName,
      commands: request.commands,
    });
  }
  return requests.map((request) => request.requestId);
}

export interface DesktopNodePairingLoopOptions extends DesktopNodePairingDeps {
  intervalMs?: number;
  idleIntervalMs?: number;
  schedule?: (tick: () => void, intervalMs: number) => () => void;
}

function scheduleWithTimers(tick: () => void, intervalMs: number): () => void {
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

export function startDesktopNodePairing(options: DesktopNodePairingLoopOptions): () => void {
  const schedule = options.schedule ?? scheduleWithTimers;
  const failures = createRepeatSquelch({ windowMs: 60_000 });
  let inFlight = false;
  let checks = 0;
  let idle = false;
  let cancel = (): void => {};
  const settleIntoIdlePace = (): void => {
    if (idle) return;
    idle = true;
    cancel();
    cancel = schedule(tick, options.idleIntervalMs ?? DESKTOP_NODE_PAIRING_IDLE_INTERVAL_MS);
  };
  const tick = (): void => {
    if (inFlight) return;
    inFlight = true;
    checks += 1;
    approveDesktopNodePairing(options)
      .then((approved) => {
        failures.settle("check");
        if (approved.length > 0) settleIntoIdlePace();
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        const admitted = failures.admit("check", message);
        if (admitted) options.log("desktop node pairing check failed", { error: message, repeatsSuppressed: admitted.suppressed });
      })
      .finally(() => {
        inFlight = false;
        if (checks >= DESKTOP_NODE_PAIRING_FAST_CHECKS) settleIntoIdlePace();
      });
  };
  tick();
  cancel = schedule(tick, options.intervalMs ?? DESKTOP_NODE_PAIRING_INTERVAL_MS);
  return () => cancel();
}
