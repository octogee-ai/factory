import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as path from "node:path";

export const SURGE_OPENCLAW_PROCESS_GATE_FILE = ".surge-openclaw-process-gate.json";
export const SURGE_OPENCLAW_PROCESS_SOCKET_FILE = ".surge-openclaw-process-gate.sock";

export type SurgeOpenClawProcessRole = "normal" | "source" | "target";
export type SurgeOpenClawProcessMode = "held" | "permitted";
export type SurgeOpenClawProcessPhase = "held" | "stopping" | "starting" | "running";

export interface SurgeOpenClawProcessGateState {
  version: 1;
  podUid: string;
  role: SurgeOpenClawProcessRole;
  mode: SurgeOpenClawProcessMode;
  phase: SurgeOpenClawProcessPhase;
  migrationId?: string;
  slug?: string;
  targetPodUid?: string;
}

export interface SurgeOpenClawProcessRequest {
  migrationId: string;
  slug: string;
  targetPodUid: string;
}

export interface SurgeOpenClawProcessGate {
  ensure: (input: { podUid: string; readinessReleased: boolean }) => Promise<SurgeOpenClawProcessGateState>;
  read: () => Promise<SurgeOpenClawProcessGateState | null>;
  hold: (input: SurgeOpenClawProcessRequest & { podUid: string }) => Promise<SurgeOpenClawProcessGateState>;
  holdNormal: (input: { podUid: string }) => Promise<SurgeOpenClawProcessGateState>;
  permitNormal: (input: { podUid: string }) => Promise<SurgeOpenClawProcessGateState>;
  hydrateTarget: (input: SurgeOpenClawProcessRequest & { podUid: string }) => Promise<SurgeOpenClawProcessGateState>;
  permitTarget: (input: SurgeOpenClawProcessRequest & { podUid: string }) => Promise<SurgeOpenClawProcessGateState>;
  resumeSource: (input: SurgeOpenClawProcessRequest & { podUid: string }) => Promise<SurgeOpenClawProcessGateState>;
  unreserveTarget: (input: SurgeOpenClawProcessRequest & { podUid: string }) => Promise<SurgeOpenClawProcessGateState>;
  settle: (input: { podUid: string }) => Promise<SurgeOpenClawProcessGateState>;
  markHeld: (input: { podUid: string; migrationId?: string }) => Promise<SurgeOpenClawProcessGateState>;
  markStarting: (input: { podUid: string; migrationId?: string }) => Promise<SurgeOpenClawProcessGateState>;
  markRunning: (input: { podUid: string; migrationId?: string }) => Promise<SurgeOpenClawProcessGateState>;
}

export const SURGE_OPENCLAW_PROCESS_SUPERVISOR_ACTIONS = [
  "status",
  "hold",
  "hold-normal",
  "hydrate",
  "permit",
  "permit-normal",
  "resume",
  "unreserve",
  "settle",
] as const;

export type SurgeOpenClawProcessSupervisorAction =
  typeof SURGE_OPENCLAW_PROCESS_SUPERVISOR_ACTIONS[number];

export interface SurgeOpenClawProcessSupervisorRequest {
  action: SurgeOpenClawProcessSupervisorAction;
  migrationId?: string;
  slug?: string;
  targetPodUid?: string;
}

export function isSurgeOpenClawProcessSupervisorAction(
  value: unknown,
): value is SurgeOpenClawProcessSupervisorAction {
  return typeof value === "string" &&
    (SURGE_OPENCLAW_PROCESS_SUPERVISOR_ACTIONS as readonly string[]).includes(value);
}

export function surgeOpenClawProcessActionNamesMigration(
  action: SurgeOpenClawProcessSupervisorAction,
): action is "hold" | "hydrate" | "permit" | "resume" | "unreserve" {
  return action === "hold" || action === "hydrate" || action === "permit" ||
    action === "resume" || action === "unreserve";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireNonemptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 512) {
    throw new Error(`surge OpenClaw process gate has invalid ${name}`);
  }
  return value;
}

function validateOptionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  return requireNonemptyString(value, name);
}

const ROLES: readonly SurgeOpenClawProcessRole[] = ["normal", "source", "target"];
const MODES: readonly SurgeOpenClawProcessMode[] = ["held", "permitted"];
const PHASES: readonly SurgeOpenClawProcessPhase[] = ["held", "stopping", "starting", "running"];

function parseEnum<T extends string>(value: unknown, allowed: readonly T[], name: string): T {
  if (!(allowed as readonly unknown[]).includes(value)) {
    throw new Error(`surge OpenClaw process gate has invalid ${name}`);
  }
  return value as T;
}

function parseMigrationIdentity(
  value: Record<string, unknown>,
  role: SurgeOpenClawProcessRole,
): Partial<SurgeOpenClawProcessRequest> {
  const migrationId = validateOptionalString(value.migrationId, "migrationId");
  const slug = validateOptionalString(value.slug, "slug");
  const targetPodUid = validateOptionalString(value.targetPodUid, "targetPodUid");
  const named = migrationId !== undefined || slug !== undefined || targetPodUid !== undefined;
  if (role === "normal" && named) {
    throw new Error("normal surge OpenClaw process gate cannot name a migration");
  }
  if (role !== "normal" && (!migrationId || !slug || !targetPodUid)) {
    throw new Error("migration surge OpenClaw process gate is missing migration identity");
  }
  return {
    ...(migrationId ? { migrationId } : {}),
    ...(slug ? { slug } : {}),
    ...(targetPodUid ? { targetPodUid } : {}),
  };
}

function assertModePhaseCoherent(mode: SurgeOpenClawProcessMode, phase: SurgeOpenClawProcessPhase): void {
  if (mode === "held" && phase === "running") {
    throw new Error("held surge OpenClaw process gate cannot be running");
  }
  if (mode === "permitted" && (phase === "held" || phase === "stopping")) {
    throw new Error("permitted surge OpenClaw process gate has invalid phase");
  }
}

function parseState(value: unknown): SurgeOpenClawProcessGateState {
  if (!isRecord(value) || value.version !== 1) {
    throw new Error("surge OpenClaw process gate is malformed");
  }
  const podUid = requireNonemptyString(value.podUid, "podUid");
  const role = parseEnum(value.role, ROLES, "role");
  const mode = parseEnum(value.mode, MODES, "mode");
  const phase = parseEnum(value.phase, PHASES, "phase");
  assertModePhaseCoherent(mode, phase);
  return { version: 1, podUid, role, mode, phase, ...parseMigrationIdentity(value, role) };
}

function assertRequest(input: SurgeOpenClawProcessRequest & { podUid: string }): void {
  requireNonemptyString(input.podUid, "podUid");
  requireNonemptyString(input.migrationId, "migrationId");
  requireNonemptyString(input.slug, "slug");
  requireNonemptyString(input.targetPodUid, "targetPodUid");
}

function sameMigration(
  state: SurgeOpenClawProcessGateState,
  input: SurgeOpenClawProcessRequest,
): boolean {
  return state.migrationId === input.migrationId &&
    state.slug === input.slug &&
    state.targetPodUid === input.targetPodUid;
}

function ownedByAnotherMigration(
  state: SurgeOpenClawProcessGateState,
  input: SurgeOpenClawProcessRequest,
): boolean {
  return state.role !== "normal" && !sameMigration(state, input);
}

function migrationIdentity(input: SurgeOpenClawProcessRequest): Pick<
  SurgeOpenClawProcessGateState,
  "migrationId" | "slug" | "targetPodUid"
> {
  return {
    migrationId: input.migrationId,
    slug: input.slug,
    targetPodUid: input.targetPodUid,
  };
}

function normalState(state: SurgeOpenClawProcessGateState): SurgeOpenClawProcessGateState {
  return {
    version: 1,
    podUid: state.podUid,
    role: "normal",
    mode: state.mode,
    phase: state.phase,
  };
}

async function readState(filePath: string): Promise<SurgeOpenClawProcessGateState | null> {
  try {
    return parseState(JSON.parse(await fs.readFile(filePath, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeState(filePath: string, state: SurgeOpenClawProcessGateState): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, filePath);
}

function initialState(podUid: string, readinessReleased: boolean): SurgeOpenClawProcessGateState {
  return readinessReleased
    ? {
      version: 1,
      podUid,
      role: "normal",
      mode: "permitted",
      phase: "starting",
    }
    : {
      version: 1,
      podUid,
      role: "normal",
      mode: "held",
      phase: "held",
    };
}

// A supervisor restart never inherits a running child. A permit is only valid
// inside the process lifetime that verified it, so an unreleased pod returns to
// held; a released pod restarts its child under a normal identity because its
// migration finished the moment readiness opened. A held NORMAL record on a
// released pod is wedge residue (deliberate holds either precede release or
// carry a migration identity), so restart heals it back to serving.
function restartedState(
  state: SurgeOpenClawProcessGateState,
  readinessReleased: boolean,
): SurgeOpenClawProcessGateState {
  if (state.mode === "held") {
    return readinessReleased && state.role === "normal"
      ? { ...state, mode: "permitted", phase: "starting" }
      : { ...state, phase: "held" };
  }
  if (!readinessReleased) return { ...state, mode: "held", phase: "held" };
  return { ...normalState(state), phase: "starting" };
}

export function surgeOpenClawProcessSocketPath(openclawDir: string): string {
  return path.join(openclawDir, SURGE_OPENCLAW_PROCESS_SOCKET_FILE);
}

export function createSurgeOpenClawProcessGate(openclawDir: string): SurgeOpenClawProcessGate {
  const gatePath = path.join(openclawDir, SURGE_OPENCLAW_PROCESS_GATE_FILE);

  const current = async (podUid: string): Promise<SurgeOpenClawProcessGateState> => {
    const state = await readState(gatePath);
    if (!state) throw new Error("surge OpenClaw process gate is not initialized");
    if (state.podUid !== podUid) {
      throw new Error(
        `surge OpenClaw process gate belongs to pod ${state.podUid}, not current pod ${podUid}`,
      );
    }
    return state;
  };

  const requireMigrationOwner = (
    state: SurgeOpenClawProcessGateState,
    input: SurgeOpenClawProcessRequest,
  ): void => {
    if (ownedByAnotherMigration(state, input)) {
      throw new Error(`surge OpenClaw process gate belongs to ${state.migrationId}/${state.slug}`);
    }
  };

  const requireNormal = (state: SurgeOpenClawProcessGateState): void => {
    if (state.role !== "normal") {
      throw new Error("surge OpenClaw process gate is owned by a migration");
    }
  };

  const requireMigrationMatch = (
    state: SurgeOpenClawProcessGateState,
    migrationId: string | undefined,
  ): void => {
    if (migrationId && state.migrationId !== migrationId) {
      throw new Error(`surge OpenClaw process gate belongs to ${state.migrationId ?? "normal"}`);
    }
  };

  const write = async (next: SurgeOpenClawProcessGateState): Promise<SurgeOpenClawProcessGateState> => {
    await writeState(gatePath, next);
    return next;
  };

  return {
    async ensure({ podUid, readinessReleased }) {
      requireNonemptyString(podUid, "podUid");
      const state = await readState(gatePath);
      return write(
        state?.podUid === podUid
          ? restartedState(state, readinessReleased)
          : initialState(podUid, readinessReleased),
      );
    },
    read: () => readState(gatePath),
    async hold(input) {
      assertRequest(input);
      const state = await current(input.podUid);
      if (state.mode === "held" && sameMigration(state, input)) return state;
      // A running permitted gate that still names a finished migration is an
      // unsettled completion — a correct controller never holds an unreleased
      // target for a new migration, so a cross-migration hold settles it here.
      const finishedMigration = state.role !== "normal" &&
        state.mode === "permitted" && state.phase === "running";
      if (!finishedMigration) requireMigrationOwner(state, input);
      const effectiveRole = finishedMigration ? "normal" : state.role;
      const heldRole: SurgeOpenClawProcessRole = input.targetPodUid === input.podUid ? "target" : "source";
      return write({
        version: 1,
        podUid: input.podUid,
        role: effectiveRole === "normal" ? heldRole : effectiveRole,
        mode: "held",
        phase: "stopping",
        ...migrationIdentity(input),
      });
    },
    async permitTarget(input) {
      assertRequest(input);
      const state = await current(input.podUid);
      if (state.role === "target" && state.mode === "permitted" && sameMigration(state, input)) {
        return state;
      }
      requireMigrationOwner(state, input);
      return write({
        version: 1,
        podUid: input.podUid,
        role: "target",
        mode: "permitted",
        phase: "starting",
        ...migrationIdentity(input),
      });
    },
    async hydrateTarget(input) {
      assertRequest(input);
      const state = await current(input.podUid);
      if (state.role === "target" && state.mode === "held" && sameMigration(state, input)) {
        return state;
      }
      requireMigrationOwner(state, input);
      if (state.mode === "permitted") {
        throw new Error("cannot hydrate a permitted surge OpenClaw process gate");
      }
      return write({
        version: 1,
        podUid: input.podUid,
        role: "target",
        mode: "held",
        phase: "held",
        ...migrationIdentity(input),
      });
    },
    async holdNormal(input) {
      requireNonemptyString(input.podUid, "podUid");
      const state = await current(input.podUid);
      requireNormal(state);
      if (state.mode === "held") return state;
      return write({ ...state, mode: "held", phase: "stopping" });
    },
    async permitNormal(input) {
      requireNonemptyString(input.podUid, "podUid");
      const state = await current(input.podUid);
      requireNormal(state);
      if (state.mode === "permitted") return state;
      return write({ ...state, mode: "permitted", phase: "starting" });
    },
    // Resume accepts any held source, not only the holding migration: the fleet
    // controller is the single serialized driver, and a source stranded by a
    // replaced target names a migration no future request can repeat. Copies
    // stay safe because every transfer digest-verifies against the source.
    async resumeSource(input) {
      assertRequest(input);
      const state = await current(input.podUid);
      if (state.role !== "source") {
        throw new Error("surge OpenClaw process gate does not hold a source migration");
      }
      if (state.mode === "permitted") return state;
      return write({ ...state, mode: "permitted", phase: "starting" });
    },
    async unreserveTarget(input) {
      assertRequest(input);
      const state = await current(input.podUid);
      if (state.role === "normal") return state;
      if (state.role !== "target" || !sameMigration(state, input)) {
        throw new Error("surge OpenClaw process gate does not reserve this target migration");
      }
      if (state.mode !== "held") {
        throw new Error("cannot unreserve a permitted surge OpenClaw process gate");
      }
      return write({ ...normalState(state), mode: "held", phase: "held" });
    },
    async settle(input) {
      requireNonemptyString(input.podUid, "podUid");
      const state = await current(input.podUid);
      if (state.mode !== "permitted") {
        throw new Error("cannot settle a held surge OpenClaw process gate");
      }
      if (state.role === "normal") return state;
      return write(normalState(state));
    },
    async markHeld(input) {
      requireNonemptyString(input.podUid, "podUid");
      const state = await current(input.podUid);
      requireMigrationMatch(state, input.migrationId);
      return write({ ...state, mode: "held", phase: "held" });
    },
    async markRunning(input) {
      requireNonemptyString(input.podUid, "podUid");
      const state = await current(input.podUid);
      requireMigrationMatch(state, input.migrationId);
      if (state.mode !== "permitted") {
        throw new Error("cannot mark a held surge OpenClaw process gate running");
      }
      return write({ ...state, phase: "running" });
    },
    async markStarting(input) {
      requireNonemptyString(input.podUid, "podUid");
      const state = await current(input.podUid);
      requireMigrationMatch(state, input.migrationId);
      if (state.mode !== "permitted") {
        throw new Error("cannot mark a held surge OpenClaw process gate starting");
      }
      return write({ ...state, phase: "starting" });
    },
  };
}

export interface SurgeOpenClawProcessSupervisorClient {
  status: () => Promise<SurgeOpenClawProcessGateState>;
  hold: (input: SurgeOpenClawProcessRequest) => Promise<SurgeOpenClawProcessGateState>;
  holdNormal: () => Promise<SurgeOpenClawProcessGateState>;
  hydrate: (input: SurgeOpenClawProcessRequest) => Promise<SurgeOpenClawProcessGateState>;
  permitNormal: () => Promise<SurgeOpenClawProcessGateState>;
  permit: (input: SurgeOpenClawProcessRequest) => Promise<SurgeOpenClawProcessGateState>;
  resume: (input: SurgeOpenClawProcessRequest) => Promise<SurgeOpenClawProcessGateState>;
  unreserve: (input: SurgeOpenClawProcessRequest) => Promise<SurgeOpenClawProcessGateState>;
  settle: () => Promise<SurgeOpenClawProcessGateState>;
}

function parseSupervisorResponse(statusCode: number | undefined, response: string): SurgeOpenClawProcessGateState {
  let parsed: unknown;
  try {
    parsed = response ? JSON.parse(response) : null;
  } catch {
    throw new Error("surge OpenClaw process supervisor returned invalid JSON");
  }
  if (statusCode !== 200) {
    throw new Error(
      isRecord(parsed) && typeof parsed.error === "string"
        ? parsed.error
        : `surge OpenClaw process supervisor returned HTTP ${statusCode ?? 0}`,
    );
  }
  return parseState(parsed);
}

function collectSupervisorResponse(
  res: http.IncomingMessage,
  resolve: (state: SurgeOpenClawProcessGateState) => void,
  reject: (error: unknown) => void,
): void {
  let response = "";
  res.setEncoding("utf8");
  res.on("data", (chunk) => { response += chunk; });
  res.on("end", () => {
    try {
      resolve(parseSupervisorResponse(res.statusCode, response));
    } catch (error) {
      reject(error);
    }
  });
}

// Mutations take no deadline: abandoning one loses the transition it applies.
export const SURGE_OPENCLAW_PROCESS_READ_TIMEOUT_MS = 5_000;

export function createSurgeOpenClawProcessSupervisorClient(
  openclawDir: string,
  deps: { request?: typeof http.request; socketPath?: string } = {},
): SurgeOpenClawProcessSupervisorClient {
  const socketPath = deps.socketPath ?? surgeOpenClawProcessSocketPath(openclawDir);
  const call = (
    input: SurgeOpenClawProcessSupervisorRequest,
    timeoutMs?: number,
  ): Promise<SurgeOpenClawProcessGateState> => {
    if (!isSurgeOpenClawProcessSupervisorAction(input.action)) {
      return Promise.reject(new Error("invalid surge OpenClaw process supervisor action"));
    }
    const body = JSON.stringify(input);
    const request = deps.request ?? http.request;
    return new Promise((resolve, reject) => {
      const req = request({
        socketPath,
        path: "/",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      }, (res) => collectSupervisorResponse(res, resolve, reject));
      if (timeoutMs !== undefined) {
        req.setTimeout(timeoutMs, () => {
          req.destroy(new Error(
            `surge OpenClaw process supervisor ${input.action} timed out after ${timeoutMs}ms`,
          ));
        });
      }
      req.once("error", reject);
      req.end(body);
    });
  };
  return {
    status: () => call({ action: "status" }, SURGE_OPENCLAW_PROCESS_READ_TIMEOUT_MS),
    hold: (input) => call({ action: "hold", ...input }),
    holdNormal: () => call({ action: "hold-normal" }),
    hydrate: (input) => call({ action: "hydrate", ...input }),
    permitNormal: () => call({ action: "permit-normal" }),
    permit: (input) => call({ action: "permit", ...input }),
    resume: (input) => call({ action: "resume", ...input }),
    unreserve: (input) => call({ action: "unreserve", ...input }),
    settle: () => call({ action: "settle" }),
  };
}
