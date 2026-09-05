import { isGatewayVmRuntimeBundle, type GatewayVmRuntimeBundle, type GatewayVmRuntimeResponse } from "@octogee/shared/types/glm";
import { brokerFailure, brokerPost } from "./broker.js";
import {
  createContainer,
  inspectContainer,
  pullImage,
  removeContainer,
  startContainer,
  waitContainer,
  setContainerPaused,
  type DockerEngine,
} from "./docker-engine.js";
import {
  HOME_CHECKPOINT_INTERVAL_MS,
  checkpointHome,
  homeScope,
  restoreHome,
  type HomeFs,
  type HomeShell,
} from "./home-checkpoint.js";
import type { MetadataClient } from "./metadata.js";
import type { DesktopControl } from "./desktop-control.js";
import {
  CA_FILE,
  containerName,
  TOKEN_FILE,
  imagesToPull,
  planBundle,
  runningVersion,
  volumeHostPath,
  type DockerContainerSpec,
} from "./plan.js";

export const TOKEN_REFRESH_MS = 20 * 60_000;
export const RUNTIME_UID = 1000;
export const RUNTIME_GID = 1000;

export interface AgentFs {
  mkdir(path: string): Promise<void>;
  writeFile(path: string, content: string, mode: number): Promise<void>;
  chown(path: string, uid: number, gid: number): Promise<void>;
}

export interface VmAgentDeps {
  gatewayId: string;
  apiUrl: string;
  stateRoot: string;
  engine: DockerEngine;
  metadata: MetadataClient;
  fetchImpl: typeof fetch;
  fs: AgentFs;
  home: { shell: HomeShell; fs: HomeFs; desktop: DesktopControl };
  now: () => number;
  log: (msg: string) => void;
}

export interface VmAgentState {
  tokensWrittenAt: number | null;
  appliedVersion: string | null;
  homeCheckpointCheckedAt: number | null;
}

export const initialAgentState = (): VmAgentState => ({ tokensWrittenAt: null, appliedVersion: null, homeCheckpointCheckedAt: null });

export type HomeCheckpointSignal = GatewayVmRuntimeResponse["homeCheckpoint"];

export type BundleFetch =
  | { kind: "bundle"; bundle: GatewayVmRuntimeBundle; homeCheckpoint: HomeCheckpointSignal }
  | { kind: "not-rendered" };

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export async function fetchRuntimeBundle(deps: VmAgentDeps): Promise<BundleFetch> {
  const res = await brokerPost(deps, "vm-runtime", {});
  if (res.status === 404) return { kind: "not-rendered" };
  if (!res.ok) throw await brokerFailure("vm-runtime", res);
  const body = (await res.json()) as Partial<GatewayVmRuntimeResponse>;
  if (!isGatewayVmRuntimeBundle(body.bundle) || body.bundle.gatewayId !== deps.gatewayId) {
    throw new Error("vm-runtime: response is not this gateway's runtime bundle");
  }
  return {
    kind: "bundle",
    bundle: body.bundle,
    homeCheckpoint: {
      requestedAt: numberOrNull(body.homeCheckpoint?.requestedAt),
      completedAt: numberOrNull(body.homeCheckpoint?.completedAt),
    },
  };
}

async function writeReadable(deps: VmAgentDeps, dir: string, file: string, content: string): Promise<void> {
  await deps.fs.mkdir(dir);
  await deps.fs.writeFile(`${dir}/${file}`, content, 0o644);
}

export async function writeTokens(deps: VmAgentDeps, bundle: GatewayVmRuntimeBundle): Promise<void> {
  let accessToken: string | null = null;
  for (const volume of bundle.volumes) {
    const dir = volumeHostPath(deps.stateRoot, volume);
    if (volume.kind === "identityToken") {
      await writeReadable(deps, dir, TOKEN_FILE, await deps.metadata.identityToken(volume.audience));
    } else if (volume.kind === "kubernetesApi") {
      accessToken ??= await deps.metadata.accessToken();
      await writeReadable(deps, dir, TOKEN_FILE, accessToken);
      await writeReadable(deps, dir, CA_FILE, bundle.kubernetes.caCert);
    }
  }
}

export async function ensureVolumes(deps: VmAgentDeps, bundle: GatewayVmRuntimeBundle): Promise<void> {
  for (const volume of bundle.volumes) {
    if (volume.kind !== "emptyDir") continue;
    const dir = volumeHostPath(deps.stateRoot, volume);
    await deps.fs.mkdir(dir);
    await deps.fs.chown(dir, RUNTIME_UID, RUNTIME_GID);
  }
  if (bundle.containers.some((container) => container.name === "gateway")) {
    const documents = `${deps.stateRoot}/desktop-home/Documents`;
    await deps.fs.mkdir(documents);
    await deps.fs.chown(documents, RUNTIME_UID, RUNTIME_GID);
  }
}

async function replaceContainer(engine: DockerEngine, spec: DockerContainerSpec): Promise<void> {
  await removeContainer(engine, spec.name);
  await createContainer(engine, spec.name, spec.config);
  await startContainer(engine, spec.name);
}

async function resumeWriters(deps: VmAgentDeps, names: string[]): Promise<void> {
  const results = await Promise.allSettled([
    ...names.map((name) => setContainerPaused(deps.engine, name, false)),
    deps.home.desktop.run("thaw"),
  ]);
  const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  if (errors.length) throw new AggregateError(errors, `home snapshot resume failed: ${errors.map(String).join("; ")}`);
}

function homeDeps(deps: VmAgentDeps, bundle: GatewayVmRuntimeBundle, holdAfterSnapshot = false) {
  return {
    ...deps, shell: deps.home.shell, fs: deps.home.fs, desktop: deps.home.desktop,
    snapshot: async (work: () => Promise<void>) => {
      const paused: string[] = [];
      const errors: unknown[] = [];
      try {
        await deps.home.desktop.run("freeze");
        for (const container of bundle.containers) {
          const name = containerName(container);
          paused.push(name);
          if (!(await inspectContainer(deps.engine, name))?.State?.Paused) await setContainerPaused(deps.engine, name, true);
        }
        await work();
      } catch (error) {
        errors.push(error);
      }
      if (!holdAfterSnapshot) {
        try { await resumeWriters(deps, paused); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, `home snapshot failed: ${errors.map(String).join("; ")}`);
    },
  };
}

export async function restoreHomeIfEmpty(deps: VmAgentDeps, bundle: GatewayVmRuntimeBundle): Promise<void> {
  const scope = homeScope(deps.stateRoot, bundle);
  if (!scope) return;
  const result = await restoreHome(homeDeps(deps, bundle), scope);
  await deps.home.desktop.run("start");
  if (result.status === "restored") deps.log(`[vm-agent] home restore restored ${result.name} (${result.size} bytes)`);
  else if (result.status === "none") deps.log("[vm-agent] home restore none: no checkpoint for this customer yet");
}

export async function applyBundle(deps: VmAgentDeps, bundle: GatewayVmRuntimeBundle, instanceId: string): Promise<void> {
  const plan = planBundle(bundle, { stateRoot: deps.stateRoot, instanceId });
  const accessToken = await deps.metadata.accessToken();
  for (const image of imagesToPull(bundle)) {
    deps.log(`[vm-agent] pulling ${image}`);
    await pullImage(deps.engine, image, accessToken);
  }
  for (const service of plan.services) await removeContainer(deps.engine, service.name);
  await restoreHomeIfEmpty(deps, bundle);
  if (plan.init) {
    deps.log(`[vm-agent] running init ${plan.init.name}`);
    await replaceContainer(deps.engine, plan.init);
    const code = await waitContainer(deps.engine, plan.init.name);
    if (code !== 0) throw new Error(`init container ${plan.init.name} exited ${code}`);
    await removeContainer(deps.engine, plan.init.name);
  }
  for (const service of plan.services) {
    deps.log(`[vm-agent] starting ${service.name} (${bundle.version})`);
    await replaceContainer(deps.engine, service);
  }
}

export function homeCheckpointDue(state: VmAgentState, signal: HomeCheckpointSignal, now: number): { due: boolean; force: boolean } {
  const force = signal.requestedAt !== null && signal.requestedAt > (signal.completedAt ?? 0);
  const periodic = state.homeCheckpointCheckedAt === null || now - state.homeCheckpointCheckedAt >= HOME_CHECKPOINT_INTERVAL_MS;
  return { due: force || periodic, force };
}

export async function checkpointHomeIfDue(
  deps: VmAgentDeps,
  bundle: GatewayVmRuntimeBundle,
  signal: HomeCheckpointSignal,
  state: VmAgentState,
): Promise<VmAgentState> {
  const scope = homeScope(deps.stateRoot, bundle);
  if (!scope) return state;
  const now = deps.now();
  const { due, force } = homeCheckpointDue(state, signal, now);
  if (!due) return state;
  try {
    const result = await checkpointHome(homeDeps(deps, bundle, force), scope, { force, requestedAt: signal.requestedAt });
    if (result.status === "uploaded") {
      deps.log(`[vm-agent] home checkpoint ${result.name} uploaded (${result.size} bytes${force ? ", requested" : ""}; pruned ${result.pruned ?? "?"})`);
    }
  } catch (err) {
    deps.log(`[vm-agent] home checkpoint failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { ...state, homeCheckpointCheckedAt: now };
}

export async function convergeOnce(deps: VmAgentDeps, state: VmAgentState): Promise<VmAgentState> {
  const fetched = await fetchRuntimeBundle(deps);
  if (fetched.kind === "not-rendered") {
    deps.log("[vm-agent] runtime bundle not rendered yet; waiting");
    return state;
  }
  const { bundle } = fetched;
  const identity = await deps.metadata.instanceIdentity();
  const now = deps.now();
  let next = state;
  if (state.tokensWrittenAt === null || now - state.tokensWrittenAt >= TOKEN_REFRESH_MS) {
    await writeTokens(deps, bundle);
    next = { ...next, tokensWrittenAt: now };
  }
  await ensureVolumes(deps, bundle);
  const running = await Promise.all(bundle.containers.map((c) => inspectContainer(deps.engine, `octogee-${c.name}`)));
  const signal = fetched.homeCheckpoint;
  const finalCheckpointHeld = signal.requestedAt !== null
    && running.every((inspection) => inspection?.State?.Running && inspection.State.Paused);
  if (finalCheckpointHeld) {
    if (signal.completedAt !== null && signal.completedAt >= signal.requestedAt!) return next;
    return checkpointHomeIfDue(deps, bundle, signal, next);
  }
  for (const [index, inspection] of running.entries()) {
    if (inspection?.State?.Paused) await setContainerPaused(deps.engine, containerName(bundle.containers[index]), false);
  }
  await deps.home.desktop.run("thaw");
  const allCurrent = running.every((inspection) => runningVersion(inspection) === bundle.version && inspection?.State?.Running === true);
  if (allCurrent) {
    if (next.appliedVersion !== bundle.version) next = { ...next, appliedVersion: bundle.version };
    return checkpointHomeIfDue(deps, bundle, fetched.homeCheckpoint, next);
  }
  deps.log(`[vm-agent] converging to bundle ${bundle.version} (running: ${running.map((r) => runningVersion(r) ?? "none").join(",")})`);
  await applyBundle(deps, bundle, identity.instanceId);
  return { ...next, appliedVersion: bundle.version };
}

export async function runVmGatewayAgent(deps: VmAgentDeps, opts: { intervalMs: number; sleep: (ms: number) => Promise<void>; stop?: () => boolean }): Promise<void> {
  let state = initialAgentState();
  while (!opts.stop?.()) {
    try {
      state = await convergeOnce(deps, state);
    } catch (err) {
      deps.log(`[vm-agent] converge failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    await opts.sleep(opts.intervalMs);
  }
}
