import {
  Firestore,
  FieldValue,
  type DocumentReference,
  type Transaction,
} from "firebase-admin/firestore";
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
} from "@octogee/shared/types/billing";
import { isValidUsername } from "@octogee/shared/types/identity";
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

export function workspaceUsageDocumentIds(model: string, today: string): {
  sessionId: string;
  modelId: string;
  summaryId: string;
} {
  return {
    sessionId: today,
    modelId: `${modelKey(model)}_${today}`,
    summaryId: "current",
  };
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

// The 7-day Personal trial clock starts at first real usage — a fresh
// personal_free owner with no trialStartedAt gets one stamped here, and
// resolveEffectivePlan boosts them to the Personal grant for TRIAL_LENGTH_DAYS.
function decideTrialBackfill(
  data: FirebaseFirestore.DocumentData,
  trialStartedAt: Date | null,
  byotActive: boolean,
  now: Date,
): { trialStartedAt: Date | null; update: FirestoreUpdate } {
  if (resolveTier(data) === "personal_free" && !trialStartedAt && !byotActive) {
    return { trialStartedAt: now, update: { "subscription.trialStartedAt": now } };
  }
  return { trialStartedAt, update: {} };
}

// Legacy telemetry only: token counts for surfaces that also cover BYOSUB
// traffic. USD budgets and throttling live at the broker; nothing reads the
// old usage.windowCostUsd/windowBudgetUsd fields anymore.
function buildWindowUpdates(
  usage: UsageData,
  usageData: { windowStartedAt?: Date | null },
  now: Date,
): { windowUpdates: FirestoreUpdate } {
  const REFILL_MS = WINDOW_LENGTH_HOURS * 60 * 60 * 1000;
  const windowStartedAt = usageData.windowStartedAt ?? null;
  const windowExpired = !windowStartedAt ||
    (now.getTime() - windowStartedAt.getTime()) >= REFILL_MS;

  if (windowExpired) {
    return {
      windowUpdates: {
        "usage.windowTokensUsed": usage.totalTokens,
        "usage.windowStartedAt":  now,
      },
    };
  }
  return {
    windowUpdates: {
      "usage.windowTokensUsed": FieldValue.increment(usage.totalTokens),
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

interface UsageTransactionState {
  workspaceId: string | null;
  windowUpdates: FirestoreUpdate;
}

interface UsageTransactionInput {
  db: Firestore;
  userRef: DocumentReference;
  logRef: DocumentReference;
  uid: string;
  agentId: string;
  role: string;
  usage: UsageData;
  log: LogFn;
  gatewayId: string;
  today: string;
}

function usageTransactionState(args: {
  data: FirebaseFirestore.DocumentData;
  uid: string;
  agentId: string;
  usage: UsageData;
  log: LogFn;
}): UsageTransactionState {
  const { data, uid, agentId, usage, log } = args;
  const workspaceId = workspaceIdFromUserData(data, agentId);
  const usageData = data.usage || {};
  const byotActive = data.byotActive === true;
  const now = new Date();

  const initialTrialStartedAt = data.subscription?.trialStartedAt?.toDate?.() ?? null;
  const backfill = decideTrialBackfill(data, initialTrialStartedAt, byotActive, now);
  if (Object.keys(backfill.update).length) {
    log(`usage: started the 7-day Personal trial clock for ${uid} (first usage, no trialStartedAt)`);
  }

  const startedAt = usageData.windowStartedAt?.toDate?.() ?? null;
  const { windowUpdates } = buildWindowUpdates(usage, { windowStartedAt: startedAt }, now);

  return {
    workspaceId,
    windowUpdates: { ...windowUpdates, ...backfill.update },
  };
}

function userUsageUpdate(state: UsageTransactionState, usage: UsageData): FirestoreUpdate {
  return {
    ...state.windowUpdates,
    "usage.totalTokensUsed":    FieldValue.increment(usage.totalTokens),
    "usage.tokensUsed":         FieldValue.increment(usage.totalTokens),
    "usage.costUsd":            FieldValue.increment(usage.costUsd),
    "usage.interactionCount":   FieldValue.increment(1),
    "usage.requestsThisHour":   FieldValue.increment(1),
    "usage.lastUpdated":        FieldValue.serverTimestamp(),
  };
}

function usageLogData(args: {
  today: string;
  usage: UsageData;
  gatewayId: string;
  role: string;
}): FirestoreUpdate {
  const { today, usage, gatewayId, role } = args;
  return {
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
  };
}

function workspaceSessionData(args: {
  today: string;
  usage: UsageData;
  gatewayId: string;
  workspaceId: string;
  role: string;
}): FirestoreUpdate {
  const { today, usage, gatewayId, workspaceId, role } = args;
  return {
    date:            today,
    tokensUsed:      FieldValue.increment(usage.totalTokens),
    costUsd:         FieldValue.increment(usage.costUsd),
    interactions:    FieldValue.increment(1),
    gatewayId,
    workspaceId,
    roles: { [role]: FieldValue.increment(usage.totalTokens) },
    token_breakdown: tokenBreakdownIncrements(usage),
  };
}

function workspaceModelData(args: {
  today: string;
  usage: UsageData;
  workspaceId: string;
  role: string;
}): FirestoreUpdate {
  const { today, usage, workspaceId, role } = args;
  return {
    date:              today,
    model:             usage.model,
    workspaceId,
    tokens:            FieldValue.increment(usage.totalTokens),
    cost_usd:          FieldValue.increment(usage.costUsd),
    interaction_count: FieldValue.increment(1),
    role,
    lastUsedAt:        FieldValue.serverTimestamp(),
    token_breakdown:   tokenBreakdownIncrements(usage),
  };
}

function workspaceSummaryData(args: {
  usage: UsageData;
  workspaceId: string;
}): FirestoreUpdate {
  const { usage, workspaceId } = args;
  return {
    workspaceId,
    totalTokens:        FieldValue.increment(usage.totalTokens),
    totalCostUsd:       FieldValue.increment(usage.costUsd),
    totalInteractions:  FieldValue.increment(1),
    lastUpdated:        FieldValue.serverTimestamp(),
    modelCosts: { [modelKey(usage.model)]: FieldValue.increment(usage.costUsd) },
  };
}

function writeWorkspaceUsageDocuments(
  t: Transaction,
  db: Firestore,
  args: {
    today: string;
    usage: UsageData;
    gatewayId: string;
    workspaceId: string;
    role: string;
  },
): void {
  const ids = workspaceUsageDocumentIds(args.usage.model, args.today);
  const wsRef = db.collection("workspaces").doc(args.workspaceId);

  t.set(
    wsRef.collection("usage_sessions").doc(ids.sessionId),
    workspaceSessionData(args),
    { merge: true },
  );
  t.set(
    wsRef.collection("usage_models").doc(ids.modelId),
    workspaceModelData(args),
    { merge: true },
  );
  t.set(
    wsRef.collection("usage_summary").doc(ids.summaryId),
    workspaceSummaryData(args),
    { merge: true },
  );
}

async function writeUsageTransaction(t: Transaction, input: UsageTransactionInput): Promise<string | null> {
  const userDoc = await t.get(input.userRef);
  const data = userDoc.data() || {};
  const state = usageTransactionState({
    data,
    uid: input.uid,
    agentId: input.agentId,
    usage: input.usage,
    log: input.log,
  });

  t.update(input.userRef, userUsageUpdate(state, input.usage));
  t.set(
    input.logRef,
    usageLogData(input),
    { merge: true },
  );

  if (state.workspaceId) {
    writeWorkspaceUsageDocuments(t, input.db, { ...input, workspaceId: state.workspaceId });
  }

  return state.workspaceId;
}

export async function reportUsageForUid(input: ReportUsageForUidInput): Promise<void> {
  const { db, uid, agentId, usage, log, gatewayId } = input;
  const role = input.role ?? extractRole(agentId);

  const userRef = db.collection("users").doc(uid);
  const today   = new Date().toISOString().slice(0, 10);
  const logRef  = userRef.collection("usage_logs").doc(today);
  let workspaceId: string | null = null;

  try {
    workspaceId = await db.runTransaction((t) => writeUsageTransaction(t, {
      db,
      userRef,
      logRef,
      uid,
      agentId,
      role,
      usage,
      log,
      gatewayId,
      today,
    }));

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
