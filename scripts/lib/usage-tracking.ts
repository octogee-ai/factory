import { Firestore, FieldValue } from "firebase-admin/firestore";
import { formatUsageLogLine } from "./usage-log-line.js";
import {
  extractRole,
  startUsageEventTailer,
  type LogFn,
  type UsageData,
} from "./usage-log-tailer.js";
import {
  WINDOW_LENGTH_HOURS,
  resolveTier,
  windowBudgetUsdForTier,
} from "../../shared/types/billing.js";
import { computeThrottleLevel } from "../../shared/types/throttle.js";
import { isValidUsername } from "../../shared/types/identity.js";
export { extractRole, findSessionFiles, parseLineForUsage } from "./usage-log-tailer.js";
export type { LogFn, UsageData, UsageEvent } from "./usage-log-tailer.js";

function workspaceIdFromAgentId(agentId: string): string | null {
  for (const role of ["coach", "alex", "morgan", "riley", "robert"]) {
    const suffix = `-${role}`;
    if (!agentId.endsWith(suffix)) continue;
    const withoutRole = agentId.slice(0, -suffix.length);
    const slug = withoutRole.startsWith("octogee-")
      ? withoutRole.slice("octogee-".length)
      : withoutRole;
    return isValidUsername(slug) ? slug : null;
  }
  return null;
}

function workspaceIdFromUserData(data: Record<string, unknown>, agentId: string): string | null {
  const provisioning = data.provisioning as { openclaw?: { slug?: unknown } } | undefined;
  const slug = provisioning?.openclaw?.slug ?? data.username;
  if (typeof slug === "string" && isValidUsername(slug)) return slug;
  return workspaceIdFromAgentId(agentId);
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

export interface ReportUsageForUidInput {
  db: Firestore;
  uid: string;
  agentId: string;
  role?: string;
  usage: UsageData;
  log: LogFn;
  gatewayId: string;
}

export interface StartUsageTrackingOptions {
  db: Firestore;
  agentPrefix: string;
  agentsDir: string;
  agentToUid: Map<string, string>;
  log: LogFn;
  gatewayId?: string;
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

export async function reportUsageForUid(input: ReportUsageForUidInput): Promise<void> {
  const { db, uid, agentId, usage, log, gatewayId } = input;
  const role = input.role ?? extractRole(agentId);

  const userRef = db.collection("users").doc(uid);
  const today   = new Date().toISOString().slice(0, 10);
  const logRef  = userRef.collection("usage_logs").doc(today);
  let workspaceId: string | null = null;

  try {
    await db.runTransaction(async (t) => {
      const userDoc = await t.get(userRef);
      const data = userDoc.data() || {};
      workspaceId = workspaceIdFromUserData(data, agentId);
      const usageData = data.usage || {};
      const tier = resolveTier(data);
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

export async function reportUsage(input: ReportUsageInput): Promise<void> {
  const { db, agentId, role, usage, agentToUid, log, gatewayId } = input;
  const uid = agentToUid.get(agentId);
  if (!uid) return;
  await reportUsageForUid({ db, uid, agentId, role, usage, log, gatewayId });
}

export function startUsageTracking(options: StartUsageTrackingOptions): NodeJS.Timeout {
  const {
    db,
    agentPrefix,
    agentsDir,
    agentToUid,
    log,
    gatewayId = "local",
  } = options;
  return startUsageEventTailer({
    agentPrefix,
    agentsDir,
    submit: async (event) => {
      await reportUsage({
        db,
        agentId: event.agentId,
        role: event.role,
        agentDir: event.agentDir,
        usage: event.usage,
        agentToUid,
        log,
        gatewayId,
      });
    },
    log,
    gatewayId,
  });
}
