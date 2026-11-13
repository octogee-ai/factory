import { createRestartDriverDeps } from "@octogee/core/gateway-restart-probe";

export interface ForceMigrationPod {
  podName: string;
  podUid: string;
  containerImage: string;
  beforeBootId: string;
  nativeOwner?: { pid: number; ownerId: string; port: number };
}

export interface ForceMigrationReceipt {
  version: 1;
  attemptId: string;
  beforeBootId: string;
  afterBootId: string;
  ready: true;
}

export interface ForceMigrationTransport {
  capture(gatewayId: string): Promise<ForceMigrationPod>;
  dispatch(pod: ForceMigrationPod): Promise<void>;
  observe(pod: ForceMigrationPod, attemptId: string): Promise<ForceMigrationReceipt>;
}

type RestartDeps = Awaited<ReturnType<typeof createRestartDriverDeps>>;

export async function readNativeRestartOwner(): Promise<NonNullable<ForceMigrationPod["nativeOwner"]>> {
  const { readdir, readFile } = await import("node:fs/promises");
  const { pathToFileURL } = await import("node:url");
  const directory = "/usr/local/lib/node_modules/openclaw/dist";
  const candidates = [];
  for (const name of await readdir(directory)) {
    if (!/^gateway-lock-.*\.mjs$/.test(name)) continue;
    const source = await readFile(`${directory}/${name}`, "utf8");
    if (/export\s*\{[^}]*\breadActiveGatewayLockIdentity\b(?!\s+as\s)[^}]*\}/.test(source)) candidates.push(name);
  }
  if (candidates.length !== 1) throw new Error("native gateway lock reader is unavailable or ambiguous");
  const native = await import(pathToFileURL(`${directory}/${candidates[0]}`).href);
  const owner = await native.readActiveGatewayLockIdentity({ requireInspection: true });
  if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.ownerId !== "string" || !owner.ownerId ||
    !Number.isInteger(owner.port) || owner.port <= 0 || owner.port > 65535) throw new Error("native gateway lock owner is unverified");
  return { pid: owner.pid, ownerId: owner.ownerId, port: owner.port };
}

export async function dispatchForcedRestart(deps: RestartDeps, bound: ForceMigrationPod,
  readOwner: () => Promise<NonNullable<ForceMigrationPod["nativeOwner"]>>): Promise<unknown> {
  const connection = await deps.connect();
  try {
    if (connection.bootId !== bound.beforeBootId) throw new Error("gateway boot changed before force dispatch; observe the existing restart");
    const owner = await readOwner();
    if (!bound.nativeOwner || owner.pid !== bound.nativeOwner.pid || owner.ownerId !== bound.nativeOwner.ownerId || owner.port !== bound.nativeOwner.port) {
      throw new Error("native gateway owner changed before force dispatch");
    }
    const response = await connection.request("gateway.restart.request", {
      reason: "octogee.force-migration", target: owner, restartIntent: { force: true, drainBudgetMs: 30000 },
    }) as { ok?: unknown; status?: unknown; pid?: unknown };
    if (response?.ok !== true || response.pid !== owner.pid || !["emitted", "coalesced"].includes(String(response.status))) {
      throw new Error("native forced restart acknowledgement is unconfirmed; observe without restarting");
    }
    return response;
  } finally { connection.close(); }
}

export async function observeForcedRestart(deps: RestartDeps, beforeBootId: string, attemptId: string, timeoutMs = 180000): Promise<ForceMigrationReceipt> {
  const deadline = deps.now() + timeoutMs;
  while (deps.now() < deadline) {
    let connection: Awaited<ReturnType<RestartDeps["connect"]>> | undefined;
    try {
      connection = await deps.connect();
      if (/^[A-Za-z0-9_-]{1,128}$/.test(connection.bootId) && connection.bootId !== beforeBootId && await deps.ready()) {
        await connection.request("health", {});
        if (connection.alive() && deps.now() < deadline) return { version: 1, attemptId, beforeBootId, afterBootId: connection.bootId, ready: true };
      }
    } catch (error) {
      if (deps.now() >= deadline) throw error;
    } finally { connection?.close(); }
    await deps.wait();
  }
  throw new Error("forced restart readiness is unconfirmed; retry the same Fleet operation to observe without restarting");
}

export function forceMigrationProbeSource(): string {
  return `const __name=(target)=>target;const readOwner=${readNativeRestartOwner.toString()};const dispatch=${dispatchForcedRestart.toString()};const observe=${observeForcedRestart.toString()};const deadline=setTimeout(()=>{process.stderr.write('forced restart observation timed out; retry the same Fleet operation to observe without restarting\\n');process.exit(1)},185000);(${createRestartDriverDeps.toString()})().then(async deps=>{const [mode,input]=process.argv.slice(2);switch(mode){case 'dispatch':return dispatch(deps,JSON.parse(input),readOwner);case 'observe':{const {beforeBootId,attemptId}=JSON.parse(input);return observe(deps,beforeBootId,attemptId);}case 'capture':{const connection=await deps.connect();try{return {bootId:connection.bootId,nativeOwner:await readOwner()}}finally{connection.close()}}default:throw new Error('invalid forced restart probe');}}).then(value=>{clearTimeout(deadline);process.stdout.write(JSON.stringify(value)+'\\n')}).catch(error=>{process.stderr.write(String(error.message)+'\\n');process.exit(1)});`;
}

interface KubectlResult { code: number; stdout: string; stderr: string }
export interface ForceMigrationTransportOptions {
  namespace: string;
  runKubectl(args: string[], options?: { stdin?: string; timeoutMs?: number }): Promise<KubectlResult>;
}

function restartFailureDiagnostic(result: KubectlResult): string {
  let nativeError = "";
  try {
    const response: unknown = JSON.parse(result.stdout);
    if (response && typeof response === "object" && "ok" in response && response.ok === false &&
      "error" in response && typeof response.error === "string") nativeError = response.error;
  } catch {
    nativeError = result.stdout.trim() ? "native command returned non-JSON output" : "";
  }
  return [nativeError, result.stderr.trim()].filter(Boolean).map(value => value
    .replace(/(authorization)([=:]\s*)[^\r\n]+/gi, "$1$2[redacted]")
    .replace(/(token|password|secret|authorization)([=:]\s*)\S+/gi, "$1$2[redacted]")
    .slice(0, 500)).join("; ");
}

export function createForceMigrationTransport(options: ForceMigrationTransportOptions): ForceMigrationTransport {
  const run = async (args: string[], extra?: { stdin?: string; timeoutMs?: number }): Promise<unknown> => {
    const result = await options.runKubectl(["-n", options.namespace, ...args], extra);
    if (result.code !== 0) {
      throw new Error(`forced restart is unconfirmed (exit ${result.code}): ${restartFailureDiagnostic(result)}; retry the same Fleet operation to observe without restarting`);
    }
    return JSON.parse(result.stdout.trim()) as unknown;
  };
  const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
  const identity = (value: unknown): Omit<ForceMigrationPod, "beforeBootId"> => {
    const pod = record(value);
    const metadata = record(pod.metadata);
    const containers = record(pod.spec).containers;
    const image = record(Array.isArray(containers) ? containers.find(container => record(container).name === "gateway") : undefined).image;
    if (typeof metadata.name !== "string" || !metadata.name || typeof metadata.uid !== "string" || !metadata.uid ||
      metadata.deletionTimestamp || record(pod.status).phase !== "Running" || typeof image !== "string" || !image) {
      throw new Error("forced restart requires the same running gateway pod");
    }
    return { podName: metadata.name, podUid: metadata.uid, containerImage: image };
  };
  const assertSamePod = async (bound: ForceMigrationPod): Promise<void> => {
    const current = identity(await run(["get", "pod", bound.podName, "-o", "json"], { timeoutMs: 15000 }));
    if (current.podUid !== bound.podUid || current.containerImage !== bound.containerImage) throw new Error("forced restart pod identity or image changed; retained storage is unconfirmed");
  };
  const probe = (podName: string, observation?: { beforeBootId: string; attemptId: string }) => run(
    ["exec", podName, "-c", "gateway", "-i", "--", "node", "--input-type=commonjs", "-",
      ...(observation ? ["observe", JSON.stringify(observation)] : ["capture"])],
    { stdin: forceMigrationProbeSource(), timeoutMs: observation ? 195000 : 20000 },
  );
  return {
    capture: async gatewayId => {
      const listed = record(await run(["get", "pods", "-l", `gateway-instance=${gatewayId}`, "-o", "json"], { timeoutMs: 15000 }));
      if (!Array.isArray(listed.items) || listed.items.length !== 1 ||
        record(record(record(listed.items[0]).metadata).labels)["gateway-instance"] !== gatewayId) throw new Error("forced restart requires one exact source gateway pod");
      const pod = identity(listed.items[0]);
      const { bootId, nativeOwner } = record(await probe(pod.podName));
      if (typeof bootId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(bootId)) throw new Error("forced restart boot identity unavailable");
      const owner = record(nativeOwner);
      if (typeof owner.pid !== "number" || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 ||
        typeof owner.ownerId !== "string" || !owner.ownerId || typeof owner.port !== "number" ||
        !Number.isInteger(owner.port) || owner.port <= 0 || owner.port > 65535) throw new Error("native gateway owner is unverified");
      const bound = { ...pod, beforeBootId: bootId, nativeOwner: { pid: owner.pid, ownerId: owner.ownerId, port: owner.port } };
      await assertSamePod(bound);
      return bound;
    },
    dispatch: async bound => {
      await assertSamePod(bound);
      if (!bound.nativeOwner) throw new Error("native force dispatch requires the captured gateway owner");
      const result = record(await run(["exec", bound.podName, "-c", "gateway", "-i", "--", "node", "--input-type=commonjs", "-", "dispatch", JSON.stringify(bound)],
        { stdin: forceMigrationProbeSource(), timeoutMs: 30000 }));
      if (result.ok !== true || result.pid !== bound.nativeOwner.pid || !["emitted", "coalesced"].includes(String(result.status))) throw new Error("native forced restart acknowledgement is unconfirmed; observe without restarting");
    },
    observe: async (bound, attemptId) => {
      await assertSamePod(bound);
      const receipt = await probe(bound.podName, { beforeBootId: bound.beforeBootId, attemptId }) as ForceMigrationReceipt;
      await assertSamePod(bound);
      return receipt;
    },
  };
}
