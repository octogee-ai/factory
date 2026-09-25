import * as fs from "node:fs";
import * as path from "node:path";

import { agentIdBelongsToSlug } from "../../shared/types/agent-models.js";
import type { SchedulerMigrationResult } from "../../shared/types/fleet-controller.js";
import {
  MIGRATION_QUIESCE_GRACE_MS,
  MIGRATION_QUIESCE_STOP_RECHECK_MS,
} from "../../shared/types/workspace-migration.js";
import { schedulerHandoffAgentIds } from "./agent-roster-deletion.js";
import {
  type AgentSessionEntry,
  customerCoachAgentId,
  readAgentSessions,
  readAgentSessionsAtPath,
  resolveOpenClawStateDir,
} from "./fleet-http-migration.js";
import type { GatewayRpcClient } from "./gateway-rpc.js";

export interface CustomerSessionStore {
  agentId: string;
  path: string;
}

export function sessionStoreForPath(storePath: string): CustomerSessionStore {
  const segments = storePath.split(path.sep);
  const agentId = segments[segments.lastIndexOf("agents") + 1];
  if (segments.lastIndexOf("agents") < 0 || !agentId) {
    throw new Error(`session store path names no agent: ${storePath}`);
  }
  return { agentId, path: storePath };
}

export interface BoundedQuiesceOptions {
  rpc: Pick<GatewayRpcClient, "configGet" | "schedulerMigration" | "sessionsAbort">;
  slug: string;
  agentIds: readonly string[];
  stores: readonly CustomerSessionStore[];
  schedulerMigrationId?: string;
  retainNonportable?: boolean;
  graceMs?: number;
  recheckMs?: number;
  abortAfterGrace?: boolean;
  readSessions?: (path: string) => Promise<AgentSessionEntry[]>;
  now?: () => number;
  wait?: (delayMs: number) => Promise<void>;
  log?: (message: string) => void;
}

export interface BoundedQuiesceResult {
  drained: boolean;
  runningCount: number;
  abortedSessions: number;
}

interface RunningSession {
  agentId: string;
  key: string;
}

const POLL_MS = 1_000;

async function listRunningSessions(
  stores: readonly CustomerSessionStore[],
  readSessions: (path: string) => Promise<AgentSessionEntry[]>,
): Promise<RunningSession[]> {
  const running: RunningSession[] = [];
  for (const store of stores) {
    for (const session of await readSessions(store.path)) {
      if (session.status !== "running") continue;
      if (typeof session.key !== "string" || session.key.length === 0) {
        throw new Error(`running session in ${store.path} has no session key to abort`);
      }
      running.push({ agentId: store.agentId, key: session.key });
    }
  }
  return running;
}

async function holdScheduler(
  opts: BoundedQuiesceOptions,
  agentIds: readonly string[],
): Promise<SchedulerMigrationResult | null> {
  if (!opts.schedulerMigrationId) return null;
  return opts.rpc.schedulerMigration({
    operationId: opts.schedulerMigrationId,
    phase: "hold",
    agentIds: [...agentIds],
    ...(opts.retainNonportable ? { retainNonportable: true } : {}),
  });
}

async function scheduledAgentIds(opts: BoundedQuiesceOptions): Promise<string[]> {
  if (!opts.schedulerMigrationId) return [...opts.agentIds];
  const { config } = await opts.rpc.configGet();
  const agentIds = schedulerHandoffAgentIds(config, opts.slug, opts.agentIds, opts.retainNonportable === true);
  if (agentIds.length === 0) throw new Error(`Cannot hold scheduler for ${opts.slug}: no customer agents`);
  return agentIds;
}

async function settleWithin(
  opts: BoundedQuiesceOptions,
  agentIds: readonly string[],
  deadline: number,
  phase: "grace" | "recheck",
): Promise<{ settled: boolean; running: RunningSession[] }> {
  const now = opts.now ?? Date.now;
  const wait = opts.wait ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const readSessions = opts.readSessions ?? readAgentSessionsAtPath;
  while (true) {
    const held = await holdScheduler(opts, agentIds);
    const running = await listRunningSessions(opts.stores, readSessions);
    const schedulerDrained = held === null || held.drained;
    if (schedulerDrained && running.length === 0) return { settled: true, running };
    opts.log?.(
      `[quiesce:${opts.slug}] ${phase}: ${running.length} running session(s)` +
      `${schedulerDrained ? "" : ", scheduler still draining"}; waiting`,
    );
    const remainingMs = deadline - now();
    if (remainingMs <= 0) return { settled: false, running };
    await wait(Math.min(POLL_MS, remainingMs));
  }
}

async function abortSessions(
  opts: BoundedQuiesceOptions,
  running: readonly RunningSession[],
): Promise<number> {
  let aborted = 0;
  for (const session of running) {
    const result = await opts.rpc.sessionsAbort({ key: session.key, agentId: session.agentId, clearQueued: true });
    const run = result.abortedRunId ? ` run=${result.abortedRunId}` : "";
    opts.log?.(`[quiesce:${opts.slug}] aborted ${session.agentId} ${session.key}: ${result.status}${run}`);
    if (result.status === "aborted") aborted += 1;
  }
  return aborted;
}

export interface CustomerSessionQuiesceOptions {
  timeoutMs: number;
  log?: (message: string) => void;
  stateDir?: string;
  now?: () => number;
  wait?: (delayMs: number) => Promise<void>;
}

function customerAgentIds(stateDir: string, slug: string): string[] {
  const agentIds = new Set([customerCoachAgentId(slug)]);
  const agentsDir = path.join(stateDir, "agents");
  if (fs.existsSync(agentsDir)) {
    for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (entry.isDirectory() && agentIdBelongsToSlug(entry.name, slug)) agentIds.add(entry.name);
    }
  }
  return [...agentIds].sort();
}

export async function quiesceCustomerSessions(
  slug: string,
  opts: CustomerSessionQuiesceOptions,
): Promise<{ drained: boolean; runningCount: number }> {
  const stateDir = opts.stateDir ?? resolveOpenClawStateDir();
  const now = opts.now ?? Date.now;
  const wait = opts.wait ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const deadline = now() + opts.timeoutMs;
  let runningCount = 0;
  do {
    runningCount = 0;
    for (const agentId of customerAgentIds(stateDir, slug)) {
      const sessions = await readAgentSessions(stateDir, agentId);
      runningCount += sessions.filter((session) => session.status === "running").length;
    }
    if (runningCount === 0) return { drained: true, runningCount: 0 };
    opts.log?.(`[quiesce:${slug}] ${runningCount} running session(s); waiting`);
    const remainingMs = deadline - now();
    if (remainingMs <= 0) break;
    await wait(Math.min(POLL_MS, remainingMs));
  } while (now() < deadline);
  return { drained: false, runningCount };
}

export async function quiesceCustomerSessionsBounded(
  opts: BoundedQuiesceOptions,
): Promise<BoundedQuiesceResult> {
  const now = opts.now ?? Date.now;
  const agentIds = await scheduledAgentIds(opts);
  const grace = await settleWithin(opts, agentIds, now() + (opts.graceMs ?? MIGRATION_QUIESCE_GRACE_MS), "grace");
  if (grace.settled) return { drained: true, runningCount: 0, abortedSessions: 0 };
  if (opts.abortAfterGrace === false) {
    return { drained: false, runningCount: grace.running.length, abortedSessions: 0 };
  }
  const abortedSessions = await abortSessions(opts, grace.running);
  const recheck = await settleWithin(
    opts,
    agentIds,
    now() + (opts.recheckMs ?? MIGRATION_QUIESCE_STOP_RECHECK_MS),
    "recheck",
  );
  return { drained: recheck.settled, runningCount: recheck.running.length, abortedSessions };
}
