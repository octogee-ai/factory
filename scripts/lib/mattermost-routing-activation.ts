import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { CONFIG_PATCH_DEADLINE_MS } from "@octogee/shared/types/fleet-controller";
import type { GatewayRpcClient } from "./gateway-rpc.js";

const MARKER_FILE = ".mattermost-routing-restart-required.json";
const RESTART_TIMEOUT_MS = 60_000;
const POLL_MS = 250;
const ACCOUNT_ABSENCE_GRACE_MS = CONFIG_PATCH_DEADLINE_MS + RESTART_TIMEOUT_MS;

interface PendingActivation {
  token: string;
  reason: string;
  accountIds: string[];
  createdAt: number;
}

interface PendingActivationClaim {
  filePath: string;
  activation: PendingActivation;
}

interface PendingActivationBatch {
  claims: PendingActivationClaim[];
  reason: string;
  accountIds: string[];
}

function markerPath(openclawDir: string): string {
  return path.join(openclawDir, MARKER_FILE);
}

function readPendingActivationFile(filePath: string): PendingActivation | null {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<PendingActivation>;
    if (
      typeof value.token !== "string" ||
      typeof value.reason !== "string" ||
      !Array.isArray(value.accountIds) ||
      !value.accountIds.every((accountId) => typeof accountId === "string" && accountId.length > 0)
    ) {
      throw new Error("Mattermost routing activation marker is malformed");
    }
    if (
      value.createdAt !== undefined &&
      (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt) || value.createdAt < 0)
    ) {
      throw new Error("Mattermost routing activation marker has invalid createdAt");
    }
    return {
      token: value.token,
      reason: value.reason,
      accountIds: [...new Set(value.accountIds)],
      createdAt: value.createdAt ?? fs.statSync(filePath).mtimeMs,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function pendingActivationFilePaths(openclawDir: string): string[] {
  try {
    return fs.readdirSync(openclawDir)
      .filter((entry) =>
        entry === MARKER_FILE ||
        (entry.startsWith(`${MARKER_FILE}.`) &&
          (entry.endsWith(".pending") || entry.endsWith(".confirmed")))
      )
      .sort()
      .map((entry) => path.join(openclawDir, entry));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function readPendingActivation(openclawDir: string): PendingActivationBatch | null {
  const claims = pendingActivationFilePaths(openclawDir).flatMap((filePath) => {
    const activation = readPendingActivationFile(filePath);
    return activation ? [{ filePath, activation }] : [];
  });
  if (claims.length === 0) return null;
  return {
    claims,
    reason: claims[0]!.activation.reason,
    accountIds: [...new Set(claims.flatMap((claim) => claim.activation.accountIds))].sort(),
  };
}

export function mattermostRoutingActivationPending(openclawDir: string): boolean {
  return readPendingActivation(openclawDir) !== null;
}

export function markMattermostRoutingActivationPending(
  openclawDir: string,
  reason: string,
  accountIds: readonly string[],
): string {
  const token = randomUUID();
  const existing = readPendingActivation(openclawDir);
  const pending = {
    token,
    reason: existing?.reason ?? reason,
    accountIds: [...new Set(accountIds)].sort(),
    createdAt: Date.now(),
  };
  if (pending.accountIds.length === 0) {
    throw new Error("Mattermost routing activation requires at least one account");
  }
  const target = `${markerPath(openclawDir)}.${token}.pending`;
  const temporary = `${target}.${pending.token}.tmp`;
  fs.mkdirSync(openclawDir, { recursive: true });
  fs.writeFileSync(temporary, `${JSON.stringify(pending)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, target);
  return pending.token;
}

function clearPendingActivation(openclawDir: string, batch: PendingActivationBatch): boolean {
  for (const claim of batch.claims) {
    const current = readPendingActivationFile(claim.filePath);
    if (current?.token !== claim.activation.token) continue;
    try {
      fs.rmSync(claim.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return readPendingActivation(openclawDir) === null;
}

interface MattermostAccountStatus {
  accountId?: string;
  lastStartAt?: number;
  running?: boolean;
  connected?: boolean;
}

async function mattermostAccountStatuses(
  rpc: GatewayRpcClient,
): Promise<Map<string, MattermostAccountStatus>> {
  const snapshot = (await rpc.channelsStatus()) as {
    channelAccounts?: { mattermost?: MattermostAccountStatus[] };
  };
  return new Map(
    (snapshot.channelAccounts?.mattermost ?? [])
      .filter((entry): entry is MattermostAccountStatus & { accountId: string } =>
        typeof entry.accountId === "string")
      .map((entry) => [entry.accountId, entry]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function configuredMattermostAccountIds(
  rpc: GatewayRpcClient,
): Promise<Set<string>> {
  const snapshot = await rpc.configGet();
  const config = snapshot.config;
  if (!isRecord(config)) {
    throw new Error("Mattermost routing activation requires an object config snapshot");
  }
  const channels = config.channels;
  if (channels === undefined) return new Set();
  if (!isRecord(channels)) {
    throw new Error("Mattermost routing activation requires channels to be an object");
  }
  const mattermost = channels.mattermost;
  if (mattermost === undefined) return new Set();
  if (!isRecord(mattermost)) {
    throw new Error("Mattermost routing activation requires channels.mattermost to be an object");
  }
  const accounts = mattermost.accounts;
  if (accounts === undefined) return new Set();
  if (!isRecord(accounts)) {
    throw new Error("Mattermost routing activation requires Mattermost accounts to be an object");
  }
  return new Set(
    Object.entries(accounts)
      .filter(([, account]) => account !== null)
      .map(([accountId]) => accountId),
  );
}

function latestClaimCreatedAt(batch: PendingActivationBatch, accountId: string): number {
  return Math.max(
    ...batch.claims.flatMap((claim) =>
      claim.activation.accountIds.includes(accountId) ? [claim.activation.createdAt] : []
    ),
  );
}

async function activePendingAccountIds(
  rpc: GatewayRpcClient,
  batch: PendingActivationBatch,
  now: () => number,
  accountAbsenceGraceMs: number,
  log: (message: string) => void,
): Promise<string[]> {
  const configured = await configuredMattermostAccountIds(rpc);
  const retired = batch.accountIds.filter((accountId) =>
    !configured.has(accountId) &&
    now() - latestClaimCreatedAt(batch, accountId) >= accountAbsenceGraceMs
  );
  if (retired.length > 0) {
    log(`${batch.reason}; discarded retired Mattermost accounts: ${retired.join(", ")}`);
  }
  const retiredSet = new Set(retired);
  return batch.accountIds.filter((accountId) => !retiredSet.has(accountId));
}

function channelsStatusConnectionGeneration(rpc: GatewayRpcClient): number {
  const generation = rpc.channelsStatusConnectionGeneration();
  if (!Number.isSafeInteger(generation) || generation <= 0) {
    throw new Error("Mattermost routing activation could not observe channels.status connection generation");
  }
  return generation;
}

function acceptedRestart(result: Awaited<ReturnType<GatewayRpcClient["gatewayRestartRequest"]>>): boolean {
  return result.ok === true &&
    (result.status === "scheduled" || result.status === "coalesced") &&
    result.restart?.ok === true &&
    result.restart.signal === "SIGUSR1" &&
    Number.isSafeInteger(result.restart.pid) &&
    result.restart.pid > 0 &&
    result.restart.coalesced === (result.status === "coalesced");
}

interface RoutingActivationBaseline {
  accounts: Map<string, number>;
  connectionGeneration: number;
}

interface RoutingActivationRuntime {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  phaseTimeoutMs: number;
  log: (message: string) => void;
}

async function observeRoutingBaseline(
  rpc: GatewayRpcClient,
  pending: PendingActivationBatch,
  accountIds: readonly string[],
  runtime: RoutingActivationRuntime,
): Promise<RoutingActivationBaseline> {
  const deadline = runtime.now() + runtime.phaseTimeoutMs;
  let lastIssue = "";
  while (runtime.now() < deadline) {
    try {
      const before = await mattermostAccountStatuses(rpc);
      const missing = accountIds.filter((accountId) =>
        typeof before.get(accountId)?.lastStartAt !== "number");
      if (missing.length === 0) {
        return {
          accounts: new Map(
            accountIds.map((accountId) => [accountId, before.get(accountId)!.lastStartAt!]),
          ),
          connectionGeneration: channelsStatusConnectionGeneration(rpc),
        };
      }
      const issue = `accounts missing lastStartAt: ${missing.join(", ")}`;
      if (issue !== lastIssue) {
        runtime.log(`${pending.reason}; waiting for routing activation baseline: ${issue}`);
        lastIssue = issue;
      }
    } catch (error) {
      const issue = error instanceof Error ? error.message : String(error);
      if (issue !== lastIssue) {
        runtime.log(`${pending.reason}; waiting for routing activation baseline: ${issue}`);
        lastIssue = issue;
      }
    }
    await runtime.sleep(POLL_MS);
  }
  throw new Error(`${pending.reason}; Mattermost account start baseline was not observed`);
}

function accountsRestarted(
  after: ReadonlyMap<string, MattermostAccountStatus>,
  accountIds: readonly string[],
  baseline: RoutingActivationBaseline,
): boolean {
  return accountIds.every((accountId) => {
    const account = after.get(accountId);
    if (account?.running !== true || account.connected !== true) return false;
    if (typeof account.lastStartAt !== "number") return false;
    return account.lastStartAt > (baseline.accounts.get(accountId) ?? 0);
  });
}

async function confirmRoutingRestart(
  rpc: GatewayRpcClient,
  pending: PendingActivationBatch,
  accountIds: readonly string[],
  baseline: RoutingActivationBaseline,
  runtime: RoutingActivationRuntime,
): Promise<void> {
  const deadline = runtime.now() + runtime.phaseTimeoutMs;
  let lastPollError = "";
  while (runtime.now() < deadline) {
    await runtime.sleep(POLL_MS);
    try {
      const after = await mattermostAccountStatuses(rpc);
      const connectionRestarted = channelsStatusConnectionGeneration(rpc) >
        baseline.connectionGeneration;
      if (connectionRestarted && accountsRestarted(after, accountIds, baseline)) return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== lastPollError) {
        runtime.log(`${pending.reason}; waiting for restarted Mattermost accounts: ${message}`);
        lastPollError = message;
      }
    }
  }
  throw new Error(`${pending.reason}; OpenClaw restart generation was not observed`);
}

export async function activatePendingMattermostRouting(
  rpc: GatewayRpcClient,
  openclawDir: string,
  log: (message: string) => void,
  options: {
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    timeoutMs?: number;
    accountAbsenceGraceMs?: number;
  } = {},
): Promise<void> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const accountAbsenceGraceMs = options.accountAbsenceGraceMs ?? ACCOUNT_ABSENCE_GRACE_MS;
  if (!Number.isFinite(accountAbsenceGraceMs) || accountAbsenceGraceMs < 0) {
    throw new Error("Mattermost routing activation account absence grace must be non-negative");
  }
  const runtime = {
    now,
    sleep,
    phaseTimeoutMs: options.timeoutMs ?? RESTART_TIMEOUT_MS,
    log,
  };

  while (true) {
    const pending = readPendingActivation(openclawDir);
    if (!pending) return;
    const accountIds = await activePendingAccountIds(
      rpc,
      pending,
      now,
      accountAbsenceGraceMs,
      log,
    );
    if (accountIds.length === 0) {
      if (clearPendingActivation(openclawDir, pending)) return;
      continue;
    }
    const baseline = await observeRoutingBaseline(rpc, pending, accountIds, runtime);
    const restart = await rpc.gatewayRestartRequest({ reason: pending.reason, skipDeferral: true });
    if (!acceptedRestart(restart)) {
      throw new Error(`${pending.reason}; OpenClaw restart was not accepted`);
    }
    log(`${pending.reason}; OpenClaw restart accepted`);
    await confirmRoutingRestart(rpc, pending, accountIds, baseline, runtime);
    if (clearPendingActivation(openclawDir, pending)) return;
  }
}
