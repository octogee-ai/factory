import { Firestore, FieldValue } from "firebase-admin/firestore";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { formatUsageLogLine } from "./usage-log-line.js";
import {
  WINDOW_LENGTH_HOURS,
  windowBudgetUsdForTier,
} from "../../shared/types/billing.js";
import { computeThrottleLevel } from "../../shared/types/throttle.js";

export type LogFn = (msg: string) => void;

interface WatchedFile {
  path: string;
  position: number;
  agentId: string;
  role: string;
}

interface UsageData {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  costUsd: number;
  model: string;
  costBreakdown: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
}

export function extractRole(agentId: string): string {
  const knownRoles = ["coach"];
  for (const role of knownRoles) {
    if (agentId.endsWith(`-${role}`)) return role;
  }
  return "coach";
}

type ReadResult<T> =
  | { kind: "ok"; value: T }
  | { kind: "missing" }       
  | { kind: "unreadable" }    
  | { kind: "corrupt" };       

function readJson<T>(filePath: string): ReadResult<T> {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "ENOENT"
      ? { kind: "missing" }
      : { kind: "unreadable" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "corrupt" };
  }
  if (parsed === null || typeof parsed !== "object") {
    return { kind: "corrupt" };
  }
  return { kind: "ok", value: parsed as T };
}

export function readWorkspaceId(agentDir: string): string | null {
  const direct = readJson<{ slug?: unknown }>(path.join(agentDir, "customer-config.json"));
  if (direct.kind === "ok") {
    return typeof direct.value.slug === "string" && direct.value.slug ? direct.value.slug : null;
  }
  if (direct.kind === "corrupt" || direct.kind === "unreadable") return null;

  const shared = readJson<{ slug?: unknown }>(
    path.join(path.dirname(agentDir), "shared", "customer-config.json"),
  );
  if (shared.kind !== "ok") return null;
  return typeof shared.value.slug === "string" && shared.value.slug ? shared.value.slug : null;
}

function parseLineForUsage(line: string): UsageData | null {
  try {
    const data = JSON.parse(line);
    if (data.type !== "message") return null;
    if (data.message?.role !== "assistant") return null;
    if (!data.message?.usage) return null;

    const usage = data.message.usage;
    const cost = usage.cost || {};

    return {
      input:        usage.input      || 0,
      output:       usage.output     || 0,
      cacheRead:    usage.cacheRead  || 0,
      cacheWrite:   usage.cacheWrite || 0,
      totalTokens:  usage.totalTokens || 0,
      costUsd:      cost.total       || 0,
      model:        data.message.model || "unknown",
      costBreakdown: {
        input:      cost.input      || 0,
        output:     cost.output     || 0,
        cacheRead:  cost.cacheRead  || 0,
        cacheWrite: cost.cacheWrite || 0,
      },
    };
  } catch {
    return null;
  }
}

function modelKey(model: string): string {
  return model.replace(/\//g, "_").slice(0, 100);
}

export interface ReportUsageInput {
  db: Firestore;
  agentId: string;
  role: string;
  agentDir: string;
  usage: UsageData;
  agentToUid: Map<string, string>;
  log: LogFn;
  gatewayId: string;
}

type FirestoreUpdate = Record<string, unknown>;

function decideTrialBackfill(
  tier: string,
  trialStartedAt: Date | null,
  byotActive: boolean,
  now: Date,
): { trialStartedAt: Date | null; update: FirestoreUpdate } {
  if (tier === "trial" && !trialStartedAt && !byotActive) {
    return { trialStartedAt: now, update: { "subscription.trialStartedAt": now } };
  }
  return { trialStartedAt, update: {} };
}

function buildWindowUpdates(
  usage: UsageData,
  usageData: { windowCostUsd?: number; windowStartedAt?: Date | null },
  windowBudgetUsd: number,
  now: Date,
): { windowUpdates: FirestoreUpdate; newWindowCostUsd: number; windowStartedAt: Date | null } {
  const REFILL_MS = WINDOW_LENGTH_HOURS * 60 * 60 * 1000;
  const windowStartedAt = usageData.windowStartedAt ?? null;
  const windowExpired = !windowStartedAt ||
    (now.getTime() - windowStartedAt.getTime()) >= REFILL_MS;

  if (windowExpired) {
    return {
      newWindowCostUsd: usage.costUsd,
      windowStartedAt,
      windowUpdates: {
        "usage.windowCostUsd":    usage.costUsd,
        "usage.windowTokensUsed": usage.totalTokens,
        "usage.windowStartedAt":  now,
        "usage.windowBudgetUsd":  windowBudgetUsd,
      },
    };
  }
  return {
    newWindowCostUsd: (usageData.windowCostUsd ?? 0) + usage.costUsd,
    windowStartedAt,
    windowUpdates: {
      "usage.windowCostUsd":    FieldValue.increment(usage.costUsd),
      "usage.windowTokensUsed": FieldValue.increment(usage.totalTokens),
      "usage.windowBudgetUsd":  windowBudgetUsd,
    },
  };
}

function tokenBreakdownIncrements(usage: UsageData): Record<string, ReturnType<typeof FieldValue.increment>> {
  return {
    input:      FieldValue.increment(usage.input),
    output:     FieldValue.increment(usage.output),
    cacheRead:  FieldValue.increment(usage.cacheRead),
    cacheWrite: FieldValue.increment(usage.cacheWrite),
  };
}

function decideThrottle(args: {
  byotActive: boolean;
  tier: string;
  newWindowCostUsd: number;
  windowBudgetUsd: number;
  subscriptionStatus: string;
  windowStartedAt: Date | null;
}): { level: 0 | 1 | 3; reason: string } {
  if (args.byotActive) {
    return { level: 0, reason: "byot_skip" };
  }
  if (args.tier === "free") {
    return { level: 3, reason: "free_tier_house_key" };
  }
  const state = computeThrottleLevel(
    args.newWindowCostUsd,
    args.windowBudgetUsd,
    args.subscriptionStatus,
    args.windowStartedAt,
  );
  const level = (state.level === 2 ? 3 : state.level) as 0 | 1 | 3;
  return { level, reason: state.reason };
}

export async function reportUsage(input: ReportUsageInput): Promise<void> {
  const { db, agentId, role, agentDir, usage, agentToUid, log, gatewayId } = input;
  const uid = agentToUid.get(agentId);
  if (!uid) return;

  const userRef = db.collection("users").doc(uid);
  const today   = new Date().toISOString().slice(0, 10);
  const logRef  = userRef.collection("usage_logs").doc(today);
  const workspaceId = readWorkspaceId(agentDir);

  try {
    await db.runTransaction(async (t) => {
      const userDoc = await t.get(userRef);
      const data = userDoc.data() || {};
      const usageData = data.usage || {};
      const tier = data.selectedTier || data.subscription?.tier || "trial";
      const subscriptionStatus = data.subscription?.status ?? "active";
      const byotActive = data.byotActive === true;
      const now = new Date();

      const initialTrialStartedAt = data.subscription?.trialStartedAt?.toDate?.() ?? null;
      const backfill = decideTrialBackfill(tier, initialTrialStartedAt, byotActive, now);
      if (Object.keys(backfill.update).length) {
        log(`usage: backfilled subscription.trialStartedAt=now for trial user ${uid} (was missing)`);
      }

      const windowBudgetUsd = windowBudgetUsdForTier(tier, backfill.trialStartedAt);
      const startedAt = usageData.windowStartedAt?.toDate?.() ?? null;
      const { newWindowCostUsd, windowUpdates, windowStartedAt } = buildWindowUpdates(
        usage,
        { windowCostUsd: usageData.windowCostUsd, windowStartedAt: startedAt },
        windowBudgetUsd,
        now,
      );

      if (tier === "trial" && !backfill.trialStartedAt && !byotActive) {
        log(`⚠ usage: trial user ${uid} has no subscription.trialStartedAt — running on platform key with no USD budget`);
      }

      const throttle = decideThrottle({
        byotActive,
        tier,
        newWindowCostUsd,
        windowBudgetUsd,
        subscriptionStatus,
        windowStartedAt,
      });
      const throttleLevel = throttle.level;
      const throttleReason = throttle.reason;

      t.update(userRef, {
        ...windowUpdates,
        ...backfill.update,
        "usage.totalTokensUsed":    FieldValue.increment(usage.totalTokens),
        "usage.tokensUsed":         FieldValue.increment(usage.totalTokens),
        "usage.costUsd":            FieldValue.increment(usage.costUsd),
        "usage.interactionCount":   FieldValue.increment(1),
        "usage.requestsThisHour":   FieldValue.increment(1),
        "usage.throttleLevel":      throttleLevel,
        "usage.throttleReason":     throttleReason,
        "usage.lastUpdated":        FieldValue.serverTimestamp(),
      });

t.set(logRef, {
        date:             today,
        tokensUsed:       FieldValue.increment(usage.totalTokens),
        costUsd:          FieldValue.increment(usage.costUsd),
        interactions:     FieldValue.increment(1),
        gatewayId,
        breakdown: {
          [role]: FieldValue.increment(usage.totalTokens),
          ...tokenBreakdownIncrements(usage),
          costInput:      FieldValue.increment(usage.costBreakdown.input),
          costOutput:     FieldValue.increment(usage.costBreakdown.output),
          costCacheRead:  FieldValue.increment(usage.costBreakdown.cacheRead),
          costCacheWrite: FieldValue.increment(usage.costBreakdown.cacheWrite),
        },
      }, { merge: true });

if (workspaceId) {
        const wsRef = db.collection("workspaces").doc(workspaceId);

t.set(wsRef.collection("usage_sessions").doc(today), {
          date:            today,
          tokensUsed:      FieldValue.increment(usage.totalTokens),
          costUsd:         FieldValue.increment(usage.costUsd),
          interactions:    FieldValue.increment(1),
          gatewayId,
          workspaceId,
          roles: { [role]: FieldValue.increment(usage.totalTokens) },
          token_breakdown: tokenBreakdownIncrements(usage),
        }, { merge: true });

const mk = `${modelKey(usage.model)}_${today}`;
        t.set(wsRef.collection("usage_models").doc(mk), {
          date:              today,
          model:             usage.model,
          workspaceId,
          tokens:            FieldValue.increment(usage.totalTokens),
          cost_usd:          FieldValue.increment(usage.costUsd),
          interaction_count: FieldValue.increment(1),
          role,
          lastUsedAt:        FieldValue.serverTimestamp(),
          token_breakdown:   tokenBreakdownIncrements(usage),
        }, { merge: true });

t.set(wsRef.collection("usage_summary").doc("current"), {
          workspaceId,
          totalTokens:        FieldValue.increment(usage.totalTokens),
          totalCostUsd:       FieldValue.increment(usage.costUsd),
          totalInteractions:  FieldValue.increment(1),
          lastUpdated:        FieldValue.serverTimestamp(),
          modelCosts: { [modelKey(usage.model)]: FieldValue.increment(usage.costUsd) },
        }, { merge: true });
      }
    });

    log(formatUsageLogLine({
      totalTokens: usage.totalTokens,
      costUsd:     usage.costUsd,
      role,
      model:       usage.model,
      uid,
      workspaceId: workspaceId ?? null,
    }));
  } catch (err) {

const e = err as { code?: string; stack?: string };
    const codeTag = e.code ? ` [${e.code}]` : "";
    const stackSuffix = e.stack ? `\n${e.stack}` : "";
    log(`\u2717 usage write failed for ${agentId}${codeTag}: ${err}${stackSuffix}`);
  }
}

async function processFile(
  filePath: string,
  watchedFiles: Map<string, WatchedFile>,
  db: Firestore,
  agentToUid: Map<string, string>,
  _agentPrefix: string,
  log: LogFn,
  gatewayId: string,
): Promise<void> {
  const parts    = filePath.split(path.sep);
  const agentIdx = parts.findIndex(p => p === "agents") + 1;
  const agentId  = parts[agentIdx] || "unknown";
  const agentDir = parts.slice(0, agentIdx + 1).join(path.sep);
  const role     = extractRole(agentId);

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
    start:    watched.position,
    encoding: "utf-8",
  });
  const rl = readline.createInterface({ input: stream });

  for await (const line of rl) {
    if (!line.trim()) continue;
    const usage = parseLineForUsage(line);
    if (usage) {
      await reportUsage({ db, agentId, role, agentDir, usage, agentToUid, log, gatewayId });
    }
  }

  watched.position = stats.size;
}

function findSessionFiles(agentsDir: string, agentPrefix: string): string[] {
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

export function startUsageTracking(
  db: Firestore,
  agentPrefix: string,
  agentsDir: string,
  agentToUid: Map<string, string>,
  log: LogFn,
  gatewayId: string = "local",
): void {
  const POLL_INTERVAL_MS = 30_000;
  const watchedFiles: Map<string, WatchedFile> = new Map();
  let lastPollFileCount: number | null = null;

  log(`usage-tracker: starting \u2014 agents dir: ${agentsDir}, prefix: ${agentPrefix}, gateway: ${gatewayId}`);

  async function poll() {
    const pollFiles = findSessionFiles(agentsDir, agentPrefix);
    if (pollFiles.length > 0 && pollFiles.length !== lastPollFileCount) {
      log(`usage-poll: tracking ${pollFiles.length} session files`);
    }
    lastPollFileCount = pollFiles.length;
    for (const file of pollFiles) {
      try {
        await processFile(file, watchedFiles, db, agentToUid, agentPrefix, log, gatewayId);
      } catch (err) {
        log(`usage: error processing ${file}: ${err}`);
      }
    }
  }

  poll().catch(err => log(`usage: initial poll error: ${err}`));
  setInterval(() => poll().catch(err => log(`usage: poll error: ${err}`)), POLL_INTERVAL_MS);
}
