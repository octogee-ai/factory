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
import { WINDOW_LENGTH_HOURS } from "@octogee/shared/types/model-broker-usage";
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

function attributedWorkspaceId(data: Record<string, unknown>, agentId: string, platformWorkspaceSlug: string | null | undefined): string | null {
  if (platformWorkspaceSlug === undefined) return workspaceIdFromUserData(data, agentId);
  return platformWorkspaceSlug !== null && isValidUsername(platformWorkspaceSlug) ? platformWorkspaceSlug : workspaceIdFromAgentId(agentId);
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
  platformWorkspaceSlug?: string | null;
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
  platformWorkspaceSlug?: string | null;
}

function usageTransactionState(args: {
  data: FirebaseFirestore.DocumentData;
  uid: string;
  agentId: string;
  usage: UsageData;
  log: LogFn;
  platformWorkspaceSlug?: string | null;
}): UsageTransactionState {
  const { data, agentId, usage } = args;
  const workspaceId = attributedWorkspaceId(data, agentId, args.platformWorkspaceSlug);
  const usageData = data.usage || {};
  const now = new Date();

  const startedAt = usageData.windowStartedAt?.toDate?.() ?? null;
  const { windowUpdates } = buildWindowUpdates(usage, { windowStartedAt: startedAt }, now);

  return {
    workspaceId,
    windowUpdates,
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

// 180d, matching the broker ledger. expiresAt is refreshed on every write, so a
// model's telemetry doc expires 180d after its LAST use (a Firestore TTL policy
// on workspaces/*/usage_models drains it) — inactive workspaces self-clean.
const USAGE_MODEL_TTL_MS = 180 * 24 * 60 * 60 * 1000;

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
    expiresAt:         new Date(Date.now() + USAGE_MODEL_TTL_MS),
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
  // usage_models is the surviving per-workspace telemetry (token volume incl.
  // BYOSUB, read by the customer usage panel + admin detail). usage_sessions and
  // usage_summary were retired: their only reader was the admin usage panel,
  // which now sources sessions + summary from the broker event stream (the
  // billing truth). A one-shot deletes their legacy docs.
  const ids = workspaceUsageDocumentIds(args.usage.model, args.today);
  const wsRef = db.collection("workspaces").doc(args.workspaceId);

  t.set(
    wsRef.collection("usage_models").doc(ids.modelId),
    workspaceModelData(args),
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
    platformWorkspaceSlug: input.platformWorkspaceSlug,
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
      platformWorkspaceSlug: input.platformWorkspaceSlug,
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
