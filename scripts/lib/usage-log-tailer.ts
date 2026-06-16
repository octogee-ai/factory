import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import type {
  FleetBrokerUsageData,
  FleetBrokerUsageEvent,
} from "../../shared/types/fleet-broker.js";

export type LogFn = (msg: string) => void;

interface WatchedFile {
  path: string;
  position: number;
  agentId: string;
  role: string;
}

export type UsageData = FleetBrokerUsageData;
export type UsageEvent = FleetBrokerUsageEvent & {
  role: string;
  agentDir: string;
  filePath: string;
};

export type UsageEventSink = (event: UsageEvent) => Promise<void>;

type JsonRecord = Record<string, unknown>;

export interface UsageEventTailerOptions {
  agentPrefix: string;
  agentsDir: string;
  submit: UsageEventSink;
  log: LogFn;
  gatewayId?: string;
  pollIntervalMs?: number;
}

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function modelOrUnknown(value: unknown): string {
  return typeof value === "string" && value ? value : "unknown";
}

export function extractRole(agentId: string): string {
  const knownRoles = ["coach"];
  for (const role of knownRoles) {
    if (agentId.endsWith(`-${role}`)) return role;
  }
  return "coach";
}

export function parseLineForUsage(line: string): UsageData | null {
  try {
    const data = asRecord(JSON.parse(line));
    if (!data || data.type !== "message") return null;
    const message = asRecord(data.message);
    if (!message || message.role !== "assistant") return null;
    const usage = asRecord(message.usage);
    if (!usage) return null;

    const cost = asRecord(usage.cost) ?? {};

    return {
      input: numberOrZero(usage.input),
      output: numberOrZero(usage.output),
      cacheRead: numberOrZero(usage.cacheRead),
      cacheWrite: numberOrZero(usage.cacheWrite),
      totalTokens: numberOrZero(usage.totalTokens),
      costUsd: numberOrZero(cost.total),
      model: modelOrUnknown(message.model),
      costBreakdown: {
        input: numberOrZero(cost.input),
        output: numberOrZero(cost.output),
        cacheRead: numberOrZero(cost.cacheRead),
        cacheWrite: numberOrZero(cost.cacheWrite),
      },
    };
  } catch {
    return null;
  }
}

async function processFile(
  filePath: string,
  watchedFiles: Map<string, WatchedFile>,
  submit: UsageEventSink,
  log: LogFn,
): Promise<void> {
  const parts = filePath.split(path.sep);
  const agentIdx = parts.findIndex((p) => p === "agents") + 1;
  const agentId = parts[agentIdx] || "unknown";
  const agentDir = parts.slice(0, agentIdx + 1).join(path.sep);
  const role = extractRole(agentId);

  let watched = watchedFiles.get(filePath);

  if (!watched) {
    const stats = fs.statSync(filePath);
    watched = { path: filePath, position: stats.size, agentId, role };
    watchedFiles.set(filePath, watched);
    log(`usage: watching ${agentId} (${path.basename(filePath)})`);
    return;
  }

  const stats = fs.statSync(filePath);
  if (stats.size <= watched.position) return;

  const stream = fs.createReadStream(filePath, {
    start: watched.position,
    encoding: "utf-8",
  });
  const rl = readline.createInterface({ input: stream });

  for await (const line of rl) {
    if (!line.trim()) continue;
    const usage = parseLineForUsage(line);
    if (usage) {
      await submit({ agentId, role, agentDir, filePath, usage });
    }
  }

  watched.position = stats.size;
}

export function findSessionFiles(agentsDir: string, agentPrefix: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(agentsDir)) return files;

  for (const agent of fs.readdirSync(agentsDir)) {
    if (!agent.startsWith(agentPrefix)) continue;
    const sessionsDir = path.join(agentsDir, agent, "sessions");
    if (!fs.existsSync(sessionsDir)) continue;
    for (const sf of fs.readdirSync(sessionsDir)) {
      if (sf.endsWith(".jsonl") && !sf.endsWith(".lock")) {
        files.push(path.join(sessionsDir, sf));
      }
    }
  }
  return files;
}

export function startUsageEventTailer(options: UsageEventTailerOptions): NodeJS.Timeout {
  const {
    agentPrefix,
    agentsDir,
    submit,
    log,
    gatewayId = "local",
    pollIntervalMs = 30_000,
  } = options;
  const watchedFiles: Map<string, WatchedFile> = new Map();
  let lastPollFileCount: number | null = null;

  log(`usage-tracker: starting - agents dir: ${agentsDir}, prefix: ${agentPrefix}, gateway: ${gatewayId}`);

  async function poll() {
    const pollFiles = findSessionFiles(agentsDir, agentPrefix);
    if (pollFiles.length > 0 && pollFiles.length !== lastPollFileCount) {
      log(`usage-poll: tracking ${pollFiles.length} session files`);
    }
    lastPollFileCount = pollFiles.length;
    for (const file of pollFiles) {
      try {
        await processFile(file, watchedFiles, submit, log);
      } catch (err) {
        log(`usage: error processing ${file}: ${err}`);
      }
    }
  }

  poll().catch((err) => log(`usage: initial poll error: ${err}`));
  return setInterval(() => poll().catch((err) => log(`usage: poll error: ${err}`)), pollIntervalMs);
}
