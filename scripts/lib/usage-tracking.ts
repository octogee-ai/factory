/**
 * Octogee Usage Tracking — reusable module
 *
 * Tails OpenClaw session JSONL files for Octogee agents and reports
 * token usage to Firestore in real-time.
 *
 * Firestore paths written:
 *   Legacy (backward compat):
 *     users/{uid}                              ← usage.* fields + throttle
 *     users/{uid}/usage_logs/{date}            ← daily rollup
 *
 *   Workspace-scoped (v2):
 *     users/{uid}/workspaces/{wid}/usage/sessions/{date}        ← daily session rollup
 *     users/{uid}/workspaces/{wid}/usage/models/{model}_{date}  ← per-model per-day
 *     users/{uid}/workspaces/{wid}/usage/summary                ← rolling totals
 */

import { Firestore, FieldValue } from "firebase-admin/firestore";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";

// ── Types ─────────────────────────────────────────────────────────────────────

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

// ── Role extraction ───────────────────────────────────────────────────────────

/**
 * Extract role from agent ID.
 * Pattern: octogee-{slug}-{role}  e.g. octogee-swift-harbor-coach → "coach"
 */
export function extractRole(agentId: string): string {
  const knownRoles = ["coach"];
  for (const role of knownRoles) {
    if (agentId.endsWith(`-${role}`)) return role;
  }
  return "coach";
}

// ── Read workspace ID from customer-config.json ───────────────────────────────

/**
 * Read the workspace slug (workspace ID) from customer-config.json in an agent dir.
 * Returns null if the file cannot be read.
 */
export function readWorkspaceId(agentDir: string): string | null {
  // Primary: customer-config.json sits directly in the agent dir
  const direct = path.join(agentDir, "customer-config.json");
  if (fs.existsSync(direct)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(direct, "utf-8"));
      return cfg.slug || null;
    } catch {
      return null;
    }
  }

  // Fallback: shared/ sibling (one level up from role dir)
  const sharedCfg = path.join(path.dirname(agentDir), "shared", "customer-config.json");
  if (fs.existsSync(sharedCfg)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(sharedCfg, "utf-8"));
      return cfg.slug || null;
    } catch {
      return null;
    }
  }

  return null;
}

// ── Parse JSONL line ──────────────────────────────────────────────────────────

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

// ── Safe model key (Firestore doc IDs cannot contain "/") ────────────────────

function modelKey(model: string): string {
  return model.replace(/\//g, "_").slice(0, 100);
}

// ── Report usage to Firestore ─────────────────────────────────────────────────

async function reportUsage(
  db: Firestore,
  agentId: string,
  role: string,
  agentDir: string,
  usage: UsageData,
  agentToUid: Map<string, string>,
  log: LogFn,
  gatewayId: string,
): Promise<void> {
  const uid = agentToUid.get(agentId);
  if (!uid) return;

  const userRef = db.collection("users").doc(uid);
  const today   = new Date().toISOString().slice(0, 10);
  const logRef  = userRef.collection("usage_logs").doc(today);

  // Workspace ID sourced from customer-config.json in the agent directory
  const workspaceId = readWorkspaceId(agentDir);

  try {
    await db.runTransaction(async (t) => {
      const userDoc = await t.get(userRef);
      const data = userDoc.data() || {};
      const usageData = data.usage || {};
      const tier = data.selectedTier || data.subscription?.tier || "trial";

      // ── Window-based refill logic ──────────────────────────────────
      const REFILL_MS = 4 * 60 * 60 * 1000;
      const WINDOWS_PER_WEEK = 42;
      const WEEKLY_BUDGETS: Record<string, number> = {
        free: 50_000, hobby: 200_000, pro: 500_000,
        max: 1_500_000, trial: 1_500_000,
      };
      const weeklyBudget = WEEKLY_BUDGETS[tier] ?? 50_000;
      const windowSize = weeklyBudget === 0 ? 0 : Math.floor(weeklyBudget / WINDOWS_PER_WEEK);

      const windowStartedAt = usageData.windowStartedAt?.toDate?.() || null;
      const now = new Date();
      const windowExpired = !windowStartedAt ||
        (now.getTime() - windowStartedAt.getTime()) >= REFILL_MS;

      let newWindowUsed: number;
      const windowUpdates: Record<string, any> = {};

      if (windowExpired) {
        newWindowUsed = usage.totalTokens;
        windowUpdates["usage.windowTokensUsed"] = usage.totalTokens;
        windowUpdates["usage.windowStartedAt"]  = now;
        windowUpdates["usage.windowSize"]       = windowSize;
      } else {
        newWindowUsed = (usageData.windowTokensUsed || 0) + usage.totalTokens;
        windowUpdates["usage.windowTokensUsed"] = FieldValue.increment(usage.totalTokens);
      }

      let throttleLevel = 0;
      if (windowSize > 0) {
        const pct = (newWindowUsed / windowSize) * 100;
        if (pct >= 100) throttleLevel = 2;
        else if (pct >= 80) throttleLevel = 1;
      }

      // ── Legacy user-level write (kept for backward compat + throttle) ──
      t.update(userRef, {
        ...windowUpdates,
        "usage.totalTokensUsed":  FieldValue.increment(usage.totalTokens),
        "usage.tokensUsed":       FieldValue.increment(usage.totalTokens),
        "usage.costUsd":          FieldValue.increment(usage.costUsd),
        "usage.interactionCount": FieldValue.increment(1),
        "usage.requestsThisHour": FieldValue.increment(1),
        "usage.throttleLevel":    throttleLevel,
        "usage.lastUpdated":      FieldValue.serverTimestamp(),
      });

      t.set(logRef, {
        date:         today,
        tokensUsed:   FieldValue.increment(usage.totalTokens),
        costUsd:      FieldValue.increment(usage.costUsd),
        interactions: FieldValue.increment(1),
        gatewayId,
        [`breakdown.${role}`]:         FieldValue.increment(usage.totalTokens),
        "breakdown.input":             FieldValue.increment(usage.input),
        "breakdown.output":            FieldValue.increment(usage.output),
        "breakdown.cacheRead":         FieldValue.increment(usage.cacheRead),
        "breakdown.cacheWrite":        FieldValue.increment(usage.cacheWrite),
        "breakdown.costInput":         FieldValue.increment(usage.costBreakdown.input),
        "breakdown.costOutput":        FieldValue.increment(usage.costBreakdown.output),
        "breakdown.costCacheRead":     FieldValue.increment(usage.costBreakdown.cacheRead),
        "breakdown.costCacheWrite":    FieldValue.increment(usage.costBreakdown.cacheWrite),
      }, { merge: true });

      // ── Workspace-scoped writes (v2) ───────────────────────────────
      if (workspaceId) {
        const wsUsageRef = userRef
          .collection("workspaces").doc(workspaceId)
          .collection("usage");

        // sessions/{date} — daily rollup for this workspace
        t.set(wsUsageRef.doc(`sessions/${today}`), {
          date:         today,
          tokensUsed:   FieldValue.increment(usage.totalTokens),
          costUsd:      FieldValue.increment(usage.costUsd),
          interactions: FieldValue.increment(1),
          gatewayId,
          workspaceId,
          [`roles.${role}`]:              FieldValue.increment(usage.totalTokens),
          "token_breakdown.input":        FieldValue.increment(usage.input),
          "token_breakdown.output":       FieldValue.increment(usage.output),
          "token_breakdown.cacheRead":    FieldValue.increment(usage.cacheRead),
          "token_breakdown.cacheWrite":   FieldValue.increment(usage.cacheWrite),
        }, { merge: true });

        // models/{modelKey}_{date} — per-model per-day granularity
        const mk = `${modelKey(usage.model)}_${today}`;
        t.set(wsUsageRef.doc(`models/${mk}`), {
          date:              today,
          model:             usage.model,
          workspaceId,
          tokens:            FieldValue.increment(usage.totalTokens),
          cost_usd:          FieldValue.increment(usage.costUsd),
          interaction_count: FieldValue.increment(1),
          role,
          "token_breakdown.input":      FieldValue.increment(usage.input),
          "token_breakdown.output":     FieldValue.increment(usage.output),
          "token_breakdown.cacheRead":  FieldValue.increment(usage.cacheRead),
          "token_breakdown.cacheWrite": FieldValue.increment(usage.cacheWrite),
        }, { merge: true });

        // summary — rolling workspace totals
        t.set(wsUsageRef.doc("summary"), {
          workspaceId,
          totalTokens:       FieldValue.increment(usage.totalTokens),
          totalCostUsd:      FieldValue.increment(usage.costUsd),
          totalInteractions: FieldValue.increment(1),
          lastUpdated:       FieldValue.serverTimestamp(),
          [`modelCosts.${modelKey(usage.model)}`]: FieldValue.increment(usage.costUsd),
        }, { merge: true });
      }
    });

    const wLabel = workspaceId ? ` ws:${workspaceId}` : "";
    log(`\u2713 usage: ${usage.totalTokens} tokens ($${usage.costUsd.toFixed(4)}) [${role}/${usage.model}] uid:${uid.slice(0, 8)}${wLabel}`);
  } catch (err) {
    log(`\u2717 usage write failed for ${agentId}: ${err}`);
  }
}

// ── Process one session file ──────────────────────────────────────────────────

async function processFile(
  filePath: string,
  watchedFiles: Map<string, WatchedFile>,
  db: Firestore,
  agentToUid: Map<string, string>,
  agentPrefix: string,
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
      await reportUsage(db, agentId, role, agentDir, usage, agentToUid, log, gatewayId);
    }
  }

  watched.position = stats.size;
}

// ── Find all session files ────────────────────────────────────────────────────

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

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Start the usage tracking loop.
 * Polls session files every POLL_INTERVAL_MS and writes token usage to Firestore.
 * Non-blocking — runs setInterval internally.
 */
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

  log(`usage-tracker: starting \u2014 agents dir: ${agentsDir}, prefix: ${agentPrefix}, gateway: ${gatewayId}`);

  async function poll() {
    const pollFiles = findSessionFiles(agentsDir, agentPrefix);
    if (pollFiles.length > 0) log(`usage-poll: checking ${pollFiles.length} files`);
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
