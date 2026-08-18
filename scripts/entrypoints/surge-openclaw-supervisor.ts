import { spawn, type ChildProcess, type SpawnOptionsWithoutStdio } from "node:child_process";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import {
  createSurgeOpenClawProcessGate,
  isSurgeOpenClawProcessSupervisorAction,
  surgeOpenClawProcessActionNamesMigration,
  surgeOpenClawProcessSocketPath,
  type SurgeOpenClawProcessGateState,
  type SurgeOpenClawProcessRequest,
  type SurgeOpenClawProcessSupervisorRequest,
} from "../lib/surge-openclaw-process-gate.js";
import { createSurgeReadinessGate } from "../lib/surge-readiness.js";

const DEFAULT_HEALTH_TIMEOUT_MS = 120_000;
const DEFAULT_STOP_GRACE_MS = 30_000;
const ORPHAN_REAP_POLL_MS = 250;
const SURGE_OPENCLAW_PID_FILE = ".surge-openclaw-process.pid";

interface SpawnedOpenClaw {
  kill: (signal?: NodeJS.Signals | number) => boolean;
  once: ChildProcess["once"];
  pid?: number;
}

export interface StartSurgeOpenClawSupervisorOptions {
  openclawDir: string;
  podUid: string;
  log: (message: string) => void;
  socketPath?: string;
  healthTimeoutMs?: number;
  stopGraceMs?: number;
  readinessReleased?: () => Promise<boolean>;
  spawnOpenClaw?: () => SpawnedOpenClaw;
  prepareTarget?: () => Promise<void>;
  probeHealthz?: () => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  createServer?: typeof http.createServer;
  onUnexpectedChildExit?: () => void;
}

export interface StartedSurgeOpenClawSupervisor {
  socketPath: string;
  state: () => Promise<SurgeOpenClawProcessGateState>;
  stop: () => Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 512) {
    throw new Error(`invalid surge OpenClaw process supervisor ${field}`);
  }
  return value;
}

function parseRequest(value: unknown): SurgeOpenClawProcessSupervisorRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid surge OpenClaw process supervisor request");
  }
  const candidate = value as Record<string, unknown>;
  const action = candidate.action;
  if (!isSurgeOpenClawProcessSupervisorAction(action)) {
    throw new Error("invalid surge OpenClaw process supervisor action");
  }
  if (!surgeOpenClawProcessActionNamesMigration(action)) return { action };
  return {
    action,
    migrationId: requireString(candidate.migrationId, "migrationId"),
    slug: requireString(candidate.slug, "slug"),
    targetPodUid: requireString(candidate.targetPodUid, "targetPodUid"),
  };
}

function requestIdentity(
  request: SurgeOpenClawProcessSupervisorRequest,
): SurgeOpenClawProcessRequest {
  if (!surgeOpenClawProcessActionNamesMigration(request.action)) {
    throw new Error("surge OpenClaw process supervisor request has no migration identity");
  }
  return {
    migrationId: request.migrationId!,
    slug: request.slug!,
    targetPodUid: request.targetPodUid!,
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultProbeHealthz(): Promise<boolean> {
  return fetch("http://127.0.0.1:18789/healthz", { signal: AbortSignal.timeout(2_000) })
    .then((response) => response.ok)
    .catch(() => false);
}

const OPENCLAW_BINARY = "/usr/local/bin/openclaw";

// Detached: OpenClaw leads its own process group so a stop can reap the whole
// tree and a supervisor restart can reap an orphaned group by recorded pid.
function defaultSpawnOpenClaw(): SpawnedOpenClaw {
  return spawn(OPENCLAW_BINARY, ["gateway", "run", "--bind", "lan", "--port", "18789"], {
    stdio: "inherit",
    detached: true,
  }) as SpawnedOpenClaw;
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitForSpawn(command: string, args: string[], options: SpawnOptionsWithoutStdio): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited ${code ?? signal ?? "unknown"}`));
    });
  });
}

async function defaultPrepareTarget(): Promise<void> {
  const tsx = process.env.TSX ?? "/octogee/scripts/node_modules/.bin/tsx";
  const policy = process.env.GATEWAY_CLASS_POLICY_PATH ?? "/octogee/infra/gateway/apply-gateway-class-policy.mjs";
  const env = { ...process.env, GATEWAY_CLASS: "builder" };
  await waitForSpawn(tsx, ["/octogee/scripts/entrypoints/pre-boot-config.ts"], { env });
  await waitForSpawn("node", [policy], { env });
  await waitForSpawn(tsx, ["/octogee/scripts/entrypoints/ensure-configured-agent-runtime-dirs.ts"], { env });
}

async function waitForHealth(input: {
  child: () => SpawnedOpenClaw | null;
  probe: () => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
}): Promise<void> {
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    if (await input.probe()) return;
    if (!input.child()) throw new Error("OpenClaw exited before becoming healthy");
    await input.sleep(250);
  }
  throw new Error(`OpenClaw did not become healthy within ${input.timeoutMs}ms`);
}

// A supervisor that died uncleanly leaves its OpenClaw running; that orphan
// would answer the health probe for a fresh child that then dies on
// EADDRINUSE, and a later hold would report success while the orphan keeps
// writing state. Reap the recorded group first; an unknown listener is fatal.
async function reapOrphanedOpenClawGroup(input: {
  probeHealthz: () => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  recordedChildPid: () => Promise<number | null>;
  forgetChildPid: () => Promise<void>;
  stopGraceMs: number;
  log: (message: string) => void;
}): Promise<void> {
  if (!(await input.probeHealthz())) return;
  const pid = await input.recordedChildPid();
  if (pid === null || !processAlive(pid)) {
    throw new Error("OpenClaw already answers on 18789 with no supervised child; refusing to start a second gateway");
  }
  input.log(`[surge-openclaw] reaping orphaned OpenClaw group pid=${pid} before start`);
  signalProcessGroup(pid, "SIGTERM");
  const deadline = Date.now() + input.stopGraceMs;
  while (Date.now() < deadline) {
    if (!processAlive(pid) && !(await input.probeHealthz())) {
      await input.forgetChildPid();
      return;
    }
    await input.sleep(ORPHAN_REAP_POLL_MS);
  }
  signalProcessGroup(pid, "SIGKILL");
  await input.sleep(ORPHAN_REAP_POLL_MS);
  if (await input.probeHealthz()) {
    throw new Error(`orphaned OpenClaw group pid=${pid} survived SIGKILL; refusing to start a second gateway`);
  }
  await input.forgetChildPid();
}

// The recorded pid is what lets a restarted supervisor recognize — and reap —
// an OpenClaw its predecessor spawned.
function childPidFile(pidPath: string): {
  recordChildPid: (pid: number | undefined) => Promise<void>;
  forgetChildPid: () => Promise<void>;
  recordedChildPid: () => Promise<number | null>;
} {
  return {
    recordChildPid: async (pid) => {
      if (pid === undefined) return;
      await fs.writeFile(pidPath, `${pid}\n`, { mode: 0o600 });
    },
    forgetChildPid: () => fs.rm(pidPath, { force: true }),
    recordedChildPid: async () => {
      const raw = await fs.readFile(pidPath, "utf8").catch(() => null);
      const pid = raw === null ? Number.NaN : Number.parseInt(raw.trim(), 10);
      return Number.isInteger(pid) && pid > 1 ? pid : null;
    },
  };
}

function supervisorRequestListener(
  handle: (request: SurgeOpenClawProcessSupervisorRequest) => Promise<SurgeOpenClawProcessGateState>,
  log: (message: string) => void,
): http.RequestListener {
  return (req, res) => {
    if (req.method !== "POST" || req.url !== "/") {
      respondJson(res, 404, { error: "not found" });
      return;
    }
    void readJsonBody(req)
      .then(parseRequest)
      .then(handle)
      .then((state) => respondJson(res, 200, state))
      .catch((error) => {
        log(`[surge-openclaw] supervisor request failed: ${errorMessage(error)}`);
        respondJson(res, 409, { error: errorMessage(error) });
      });
  };
}

async function waitForExit(child: SpawnedOpenClaw): Promise<void> {
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
}

async function waitForExitOrTimeout(
  child: SpawnedOpenClaw,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  return Promise.race([
    waitForExit(child).then(() => true),
    sleep(timeoutMs).then(() => false),
  ]);
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 16_384) req.destroy(new Error("request too large"));
    });
    req.once("error", reject);
    req.once("end", () => {
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid JSON request"));
      }
    });
  });
}

function respondJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export async function startSurgeOpenClawSupervisor(
  opts: StartSurgeOpenClawSupervisorOptions,
): Promise<StartedSurgeOpenClawSupervisor> {
  const gate = createSurgeOpenClawProcessGate(opts.openclawDir);
  const readiness = createSurgeReadinessGate(opts.openclawDir, opts.podUid);
  const socketPath = opts.socketPath ?? surgeOpenClawProcessSocketPath(opts.openclawDir);
  const probeHealthz = opts.probeHealthz ?? defaultProbeHealthz;
  const sleep = opts.sleep ?? defaultSleep;
  const spawnOpenClaw = opts.spawnOpenClaw ?? defaultSpawnOpenClaw;
  const prepareTarget = opts.prepareTarget ?? defaultPrepareTarget;
  const timeoutMs = opts.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const stopGraceMs = opts.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
  const pidPath = path.join(opts.openclawDir, SURGE_OPENCLAW_PID_FILE);
  let child: SpawnedOpenClaw | null = null;
  let stopping = false;
  let starting: Promise<SurgeOpenClawProcessGateState> | null = null;
  let serial = Promise.resolve();

  const { recordChildPid, forgetChildPid, recordedChildPid } = childPidFile(pidPath);

  const reapOrphanedOpenClaw = (): Promise<void> => reapOrphanedOpenClawGroup({
    probeHealthz,
    sleep,
    recordedChildPid,
    forgetChildPid,
    stopGraceMs,
    log: opts.log,
  });

  const runSerial = <T>(work: () => Promise<T>): Promise<T> => {
    const result = serial.then(work, work);
    serial = result.then(() => undefined, () => undefined);
    return result;
  };

  const current = async (): Promise<SurgeOpenClawProcessGateState> => {
    const state = await gate.read();
    if (!state || state.podUid !== opts.podUid) {
      throw new Error("surge OpenClaw process gate disappeared or belongs to another pod");
    }
    return state;
  };

  const stopChild = async (): Promise<void> => {
    const active = child;
    if (!active) return;
    stopping = true;
    try {
      active.kill("SIGTERM");
      if (!(await waitForExitOrTimeout(active, stopGraceMs, sleep))) {
        opts.log(`[surge-openclaw] OpenClaw ignored SIGTERM for ${stopGraceMs}ms; killing its process group`);
        if (active.pid === undefined || !signalProcessGroup(active.pid, "SIGKILL")) active.kill("SIGKILL");
        await waitForExit(active);
      }
      if (child === active) child = null;
      await forgetChildPid();
    } finally {
      stopping = false;
    }
  };

  const startChild = async (prepare: boolean = false): Promise<SurgeOpenClawProcessGateState> => {
    if (starting) return starting;
    const work = (async () => {
      const before = await current();
      if (before.mode !== "permitted") {
        throw new Error("surge OpenClaw process is held");
      }
      if (child) return before;
      await gate.markStarting({ podUid: opts.podUid, migrationId: before.migrationId });
      if (prepare || before.role === "target") await prepareTarget();
      const afterPreparation = await current();
      if (afterPreparation.mode !== "permitted") {
        throw new Error("surge OpenClaw process was held during target preparation");
      }
      await reapOrphanedOpenClaw();
      const spawned = spawnOpenClaw();
      child = spawned;
      await recordChildPid(spawned.pid);
      spawned.once("exit", () => {
        if (child !== spawned) return;
        child = null;
        void forgetChildPid();
        if (!stopping) {
          opts.log("[surge-openclaw] OpenClaw exited outside a supervised stop");
          opts.onUnexpectedChildExit?.();
        }
      });
      spawned.once("error", () => {
        if (child === spawned) child = null;
      });
      await waitForHealth({
        child: () => child,
        probe: probeHealthz,
        sleep,
        timeoutMs,
      });
      return gate.markRunning({ podUid: opts.podUid, migrationId: afterPreparation.migrationId });
    })();
    starting = work;
    try {
      return await work;
    } catch (error) {
      try {
        await stopChild();
        const state = await current();
        if (state.mode === "permitted") {
          await gate.markHeld({ podUid: opts.podUid, migrationId: state.migrationId });
        }
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "OpenClaw start failed and process hold cleanup failed",
        );
      }
      throw error;
    } finally {
      starting = null;
    }
  };

  const hold = async (input: SurgeOpenClawProcessRequest): Promise<SurgeOpenClawProcessGateState> => {
    await gate.hold({ ...input, podUid: opts.podUid });
    await stopChild();
    return gate.markHeld({ podUid: opts.podUid, migrationId: input.migrationId });
  };

  const permit = async (input: SurgeOpenClawProcessRequest): Promise<SurgeOpenClawProcessGateState> => {
    await gate.permitTarget({ ...input, podUid: opts.podUid });
    return startChild();
  };

  const hydrate = async (input: SurgeOpenClawProcessRequest): Promise<SurgeOpenClawProcessGateState> =>
    gate.hydrateTarget({ ...input, podUid: opts.podUid });

  const permitNormal = async (): Promise<SurgeOpenClawProcessGateState> => {
    await gate.permitNormal({ podUid: opts.podUid });
    return startChild(true);
  };

  const holdNormal = async (): Promise<SurgeOpenClawProcessGateState> => {
    await gate.holdNormal({ podUid: opts.podUid });
    await stopChild();
    return gate.markHeld({ podUid: opts.podUid });
  };

  // A resumed source is a completed rollback: the response only reports running
  // after the child is healthy, and settling releases the migration identity so
  // the next handoff may hold this pod again.
  const resume = async (input: SurgeOpenClawProcessRequest): Promise<SurgeOpenClawProcessGateState> => {
    await gate.resumeSource({ ...input, podUid: opts.podUid });
    await startChild();
    return gate.settle({ podUid: opts.podUid });
  };

  const unreserve = (input: SurgeOpenClawProcessRequest): Promise<SurgeOpenClawProcessGateState> =>
    gate.unreserveTarget({ ...input, podUid: opts.podUid });

  const settle = (): Promise<SurgeOpenClawProcessGateState> =>
    gate.settle({ podUid: opts.podUid });

  const readinessReleased = opts.readinessReleased ?? (() => readiness.released());
  const initial = await gate.ensure({
    podUid: opts.podUid,
    readinessReleased: await readinessReleased(),
  });

  await fs.mkdir(opts.openclawDir, { recursive: true });
  await fs.rm(socketPath, { force: true });
  const createServer = opts.createServer ?? http.createServer;
  const dispatch = (
    request: SurgeOpenClawProcessSupervisorRequest,
  ): Promise<SurgeOpenClawProcessGateState> => {
    if (request.action === "status") return current();
    if (request.action === "hold-normal") return holdNormal();
    if (request.action === "permit-normal") return permitNormal();
    if (request.action === "settle") return settle();
    const input = requestIdentity(request);
    if (request.action === "hold") return hold(input);
    if (request.action === "hydrate") return hydrate(input);
    if (request.action === "permit") return permit(input);
    if (request.action === "unreserve") return unreserve(input);
    return resume(input);
  };
  const server = createServer(supervisorRequestListener(
    (request) => runSerial(() => dispatch(request)),
    opts.log,
  ));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  await fs.chmod(socketPath, 0o600);

  if (initial.mode === "permitted") {
    void runSerial(startChild).catch((error) => {
      opts.log(`[surge-openclaw] initial permitted start failed: ${errorMessage(error)}`);
    });
  }

  return {
    socketPath,
    state: current,
    async stop() {
      await runSerial(stopChild);
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await fs.rm(socketPath, { force: true });
    },
  };
}

async function main(): Promise<void> {
  const podUid = process.env.POD_UID?.trim();
  if (!podUid) throw new Error("POD_UID is required for the surge OpenClaw supervisor");
  const openclawDir = process.env.OPENCLAW_DIR?.trim() || "/home/node/.openclaw";
  const supervisor = await startSurgeOpenClawSupervisor({
    openclawDir,
    podUid,
    log: (message) => console.error(message),
    onUnexpectedChildExit: () => {
      console.error("[surge-openclaw] exiting so the runner restarts the supervisor and OpenClaw");
      process.exit(1);
    },
  });
  const stop = () => {
    supervisor.stop().then(
      () => process.exit(0),
      (error) => {
        console.error(`[surge-openclaw] supervisor stop failed: ${errorMessage(error)}`);
        process.exit(1);
      },
    );
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[surge-openclaw] supervisor fatal: ${errorMessage(error)}`);
    process.exit(1);
  });
}
