import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type { GatewayRpcClient } from "./gateway-rpc.js";

const MARKER_FILE = ".mattermost-routing-restart-required.json";
const RESTART_TIMEOUT_MS = 60_000;
const POLL_MS = 250;

interface PendingActivation {
  token: string;
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
    return {
      token: value.token,
      reason: value.reason,
      accountIds: [...new Set(value.accountIds)],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function readPendingActivation(openclawDir: string): PendingActivation | null {
  return readPendingActivationFile(markerPath(openclawDir));
}

export function mattermostRoutingActivationPending(openclawDir: string): boolean {
  return readPendingActivation(openclawDir) !== null;
}

export function markMattermostRoutingActivationPending(
  openclawDir: string,
  reason: string,
  accountIds: readonly string[],
): string {
  const existing = readPendingActivation(openclawDir);
  const pending = {
    token: randomUUID(),
    reason: existing?.reason ?? reason,
    accountIds: [...new Set([...(existing?.accountIds ?? []), ...accountIds])].sort(),
  };
  if (pending.accountIds.length === 0) {
    throw new Error("Mattermost routing activation requires at least one account");
  }
  const target = markerPath(openclawDir);
  const temporary = `${target}.${pending.token}.tmp`;
  fs.mkdirSync(openclawDir, { recursive: true });
  fs.writeFileSync(temporary, `${JSON.stringify(pending)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, target);
  return pending.token;
}

function clearPendingActivation(openclawDir: string, token: string): boolean {
  const target = markerPath(openclawDir);
  const claimed = `${target}.${randomUUID()}.confirmed`;
  try {
    fs.renameSync(target, claimed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const activation = readPendingActivationFile(claimed);
  if (activation?.token !== token) {
    if (fs.existsSync(target)) {
      markMattermostRoutingActivationPending(
        openclawDir,
        activation?.reason ?? "Mattermost routing activation",
        activation?.accountIds ?? [],
      );
      fs.rmSync(claimed);
    } else {
      fs.renameSync(claimed, target);
    }
    return false;
  }
  fs.rmSync(claimed);
  return !fs.existsSync(target);
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

export async function activatePendingMattermostRouting(
  rpc: GatewayRpcClient,
  openclawDir: string,
  log: (message: string) => void,
  options: {
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    timeoutMs?: number;
  } = {},
): Promise<void> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms)));

  while (true) {
    const pending = readPendingActivation(openclawDir);
    if (!pending) return;
    const phaseTimeoutMs = options.timeoutMs ?? RESTART_TIMEOUT_MS;
    const baselineDeadline = now() + phaseTimeoutMs;
    let baseline: Map<string, number> | null = null;
    let lastBaselineIssue = "";
    while (now() < baselineDeadline) {
      try {
        const before = await mattermostAccountStatuses(rpc);
        const missing = pending.accountIds.filter((accountId) =>
          typeof before.get(accountId)?.lastStartAt !== "number");
        if (missing.length === 0) {
          baseline = new Map(
            pending.accountIds.map((accountId) => [accountId, before.get(accountId)!.lastStartAt!]),
          );
          break;
        }
        const issue = `accounts missing lastStartAt: ${missing.join(", ")}`;
        if (issue !== lastBaselineIssue) {
          log(`${pending.reason}; waiting for routing activation baseline: ${issue}`);
          lastBaselineIssue = issue;
        }
      } catch (error) {
        const issue = error instanceof Error ? error.message : String(error);
        if (issue !== lastBaselineIssue) {
          log(`${pending.reason}; waiting for routing activation baseline: ${issue}`);
          lastBaselineIssue = issue;
        }
      }
      await sleep(POLL_MS);
    }
    if (!baseline) {
      throw new Error(`${pending.reason}; Mattermost account start baseline was not observed`);
    }
    await rpc.gatewayRestartRequest({ reason: pending.reason, skipDeferral: true });
    log(`${pending.reason}; OpenClaw restart accepted`);

    const restartDeadline = now() + phaseTimeoutMs;
    let confirmed = false;
    let lastPollError = "";
    while (now() < restartDeadline) {
      await sleep(POLL_MS);
      try {
        const after = await mattermostAccountStatuses(rpc);
        if (pending.accountIds.every((accountId) => {
          const account = after.get(accountId);
          return account?.running === true &&
            account.connected === true &&
            typeof account.lastStartAt === "number" &&
            account.lastStartAt > (baseline.get(accountId) ?? 0);
        })) {
          confirmed = true;
          break;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message !== lastPollError) {
          log(`${pending.reason}; waiting for restarted Mattermost accounts: ${message}`);
          lastPollError = message;
        }
      }
    }
    if (!confirmed) {
      throw new Error(`${pending.reason}; OpenClaw restart generation was not observed`);
    }
    if (clearPendingActivation(openclawDir, pending.token)) return;
  }
}
