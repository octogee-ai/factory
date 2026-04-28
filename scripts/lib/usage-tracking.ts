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
 *   Workspace-scoped (v3.1 — rooted at top-level workspaces/{slug}):
 *     workspaces/{slug}/usage_sessions/{date}              ← daily session rollup
 *     workspaces/{slug}/usage_models/{model}_{date}        ← per-model per-day
 *     workspaces/{slug}/usage_summary/current              ← rolling totals
 *
 *   Each rollup carries (uid, workspace slug, role, model). Rollup dimensions
 *   are therefore workspace slug × role × model.
 *
 *   Why no key fingerprint: OpenClaw's session JSONL doesn't expose which
 *   API key billed a turn. With BYOT in play we can't reliably distinguish
 *   platform-billed turns from customer-billed turns inside this stream.
 *   The user's own Anthropic dashboard is the source of truth for that.
 *   We attribute by uid + slug; the BYOT echo block in /api/billing/usage
 *   tells the UI "is BYOT on for this user, what's the configured key" via
 *   `users/{uid}/system/config.byot.fingerprint` (the workspace-api writer
 *   for that field is authoritative — see workspace-api/src/routes/billing/byot.ts).
 *
 * The earlier v2 path `users/{uid}/workspaces/{wid}/usage/...` was abandoned
 * in the v3.1 collection cleanup (DATA-MODEL-REVIEW.md). Writes there were
 * silently failing because `.doc("sessions/{date}")` from a 5-segment
 * collection reference produces a 7-segment path (collection, not document).
 */

import { Firestore, FieldValue } from "firebase-admin/firestore";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { formatUsageLogLine } from "./usage-log-line.js";
import {
  WINDOW_LENGTH_HOURS,
  windowBudgetUsdForTier,
} from "../../shared/types/billing.js";
import { computeThrottleLevel } from "../../functions/src/billing/throttle.js";

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

// Exported for unit testing. Not part of the public module surface — callers
// should go through startUsageTracking(), which tails session JSONL files
// and invokes this per parsed usage event.
export async function reportUsage(
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

      // ── Window-based refill logic (USD-driven, 5h windows) ─────────
      // §9.2 of ADMIN-DASHBOARD-SPEC: throttle math reads windowCostUsd.
      // Tokens are kept for diagnostic display only.
      const REFILL_MS = WINDOW_LENGTH_HOURS * 60 * 60 * 1000;
      const trialStartedAt = data.subscription?.trialStartedAt?.toDate?.() ?? null;
      const subscriptionStatus = data.subscription?.status ?? "active";
      const byotActive = data.byotActive === true;

      // For trial users we tier-derive in USD via tapered curve. Paid
      // tiers convert weekly token budget at the Sonnet blended rate.
      const windowBudgetUsd = windowBudgetUsdForTier(tier, trialStartedAt);

      const windowStartedAt = usageData.windowStartedAt?.toDate?.() || null;
      const now = new Date();
      const windowExpired = !windowStartedAt ||
        (now.getTime() - windowStartedAt.getTime()) >= REFILL_MS;

      let newWindowCostUsd: number;
      let newWindowTokensUsed: number;
      const windowUpdates: Record<string, any> = {};

      if (windowExpired) {
        newWindowCostUsd    = usage.costUsd;
        newWindowTokensUsed = usage.totalTokens;
        windowUpdates["usage.windowCostUsd"]    = usage.costUsd;
        windowUpdates["usage.windowTokensUsed"] = usage.totalTokens;
        windowUpdates["usage.windowStartedAt"]  = now;
        windowUpdates["usage.windowBudgetUsd"]  = windowBudgetUsd;
      } else {
        newWindowCostUsd    = (usageData.windowCostUsd ?? 0) + usage.costUsd;
        newWindowTokensUsed = (usageData.windowTokensUsed ?? 0) + usage.totalTokens;
        windowUpdates["usage.windowCostUsd"]    = FieldValue.increment(usage.costUsd);
        windowUpdates["usage.windowTokensUsed"] = FieldValue.increment(usage.totalTokens);
        // Refresh budget every turn so day-N tapering takes effect
        // immediately on rollover without a separate cron.
        windowUpdates["usage.windowBudgetUsd"]  = windowBudgetUsd;
      }

      // ── Throttle level (§9.2 + §9.3) ─────────────────────────────
      // BYOT customers pay Anthropic directly — never throttled.
      // Otherwise delegate to functions/src/billing/throttle.ts so the
      // gateway-side compute (this file) and the trigger-side compute
      // (functions/src/triggers/onUsageUpdate.ts) can never drift.
      // Trial users with no trialStartedAt fall through with budget=0,
      // which the trigger treats as "unlimited" — log so ops can spot
      // stuck users before they become free riders.
      if (tier === "trial" && !trialStartedAt && !byotActive) {
        log(`⚠ usage: trial user ${uid} has no subscription.trialStartedAt — running on platform key with no USD budget`);
      }

      let throttleLevel: 0 | 1 | 3 = 0;
      let throttleReason = "normal";
      if (byotActive) {
        throttleReason = "byot_skip";
      } else if (tier === "free") {
        // §9.5: free tier is always on the house key, no real budget.
        // Without this branch, windowBudgetUsd=0 would route through
        // computeThrottleLevel's "unlimited" path and free users would
        // silently get unlimited service on the platform's dime.
        throttleLevel = 3;
        throttleReason = "free_tier_house_key";
      } else {
        const state = computeThrottleLevel(
          newWindowCostUsd,
          windowBudgetUsd,
          subscriptionStatus,
          windowStartedAt,
        );
        // Compute returns 0|1|2|3 in type but never emits 2 — narrow.
        throttleLevel = (state.level === 2 ? 3 : state.level) as 0 | 1 | 3;
        throttleReason = state.reason;
      }

      // ── User-level write — diagnostic totals + throttle state ──────
      t.update(userRef, {
        ...windowUpdates,
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

      // ── Workspace-scoped writes (v3.1) ──────────────────────────────
      // workspaceId is the slug (e.g. "eckert"); the top-level workspaces
      // collection is the v3.1 authoritative parent. Three parallel
      // subcollections keep reads cheap and rules simple. Rollups are
      // dimensioned by (slug, role, model) — no per-key splits because
      // the key fingerprint is not knowable from the JSONL session feed
      // (see module header).
      if (workspaceId) {
        const wsRef = db.collection("workspaces").doc(workspaceId);

        // usage_sessions/{date} — daily rollup for this workspace
        t.set(wsRef.collection("usage_sessions").doc(today), {
          date:            today,
          tokensUsed:      FieldValue.increment(usage.totalTokens),
          costUsd:         FieldValue.increment(usage.costUsd),
          interactions:    FieldValue.increment(1),
          gatewayId,
          workspaceId,
          [`roles.${role}`]:              FieldValue.increment(usage.totalTokens),
          "token_breakdown.input":        FieldValue.increment(usage.input),
          "token_breakdown.output":       FieldValue.increment(usage.output),
          "token_breakdown.cacheRead":    FieldValue.increment(usage.cacheRead),
          "token_breakdown.cacheWrite":   FieldValue.increment(usage.cacheWrite),
        }, { merge: true });

        // usage_models/{modelKey}_{date} — per-model per-day granularity,
        // per role.
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
          "token_breakdown.input":      FieldValue.increment(usage.input),
          "token_breakdown.output":     FieldValue.increment(usage.output),
          "token_breakdown.cacheRead":  FieldValue.increment(usage.cacheRead),
          "token_breakdown.cacheWrite": FieldValue.increment(usage.cacheWrite),
        }, { merge: true });

        // usage_summary/current — rolling workspace totals (single doc)
        t.set(wsRef.collection("usage_summary").doc("current"), {
          workspaceId,
          totalTokens:        FieldValue.increment(usage.totalTokens),
          totalCostUsd:       FieldValue.increment(usage.costUsd),
          totalInteractions:  FieldValue.increment(1),
          lastUpdated:        FieldValue.serverTimestamp(),
          [`modelCosts.${modelKey(usage.model)}`]: FieldValue.increment(usage.costUsd),
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
    // Include code/stack so systemic write failures (e.g. a new
    // arrayUnion schema migration colliding with a pre-existing scalar
    // field, or missing composite index) surface in logs instead of
    // silently retrying every turn.
    const code = (err as any)?.code;
    const stack = (err as any)?.stack;
    log(`\u2717 usage write failed for ${agentId}${code ? ` [${code}]` : ""}: ${err}${stack ? `\n${stack}` : ""}`);
  }
}

// ── Process one session file ──────────────────────────────────────────────────

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
