import {
  getTierConfig,
  calculateAvailableTokens,
  type TierName,
} from "./billing-tiers.js";
import type {
  CSIDocument,
  TrialState,
  TrialFunnelStage,
} from "./csi-types.js";

export function toISODate(val: unknown): string | null {
  if (!val) return null;
  if (typeof (val as { toDate?: unknown }).toDate === "function") {
    return (val as { toDate: () => Date }).toDate().toISOString();
  }
  if (val instanceof Date) return val.toISOString();
  return null;
}

export function isActiveStatus(status: string): boolean {
  return status === "active" || status === "trialing";
}

// ── Customer Summary (list view) ────────────────────────────────────────────

export interface TrialSummary {
  startedAt:     string | null;
  endsAt:        string | null;
  dayN:          number;
  daysRemaining: number;
  expired:       boolean;
  funnelStage:   TrialFunnelStage;
  flags: {
    inactive_24h:     boolean;
    inactive_72h:     boolean;
    high_token_usage: boolean;
    at_budget_limit:  boolean;
    converted_paid:   boolean;
  };
}

export interface CSISummary {
  healthScore:        "active" | "at_risk" | "churning" | null;
  sentiment:          "frustrated" | "neutral" | "satisfied" | null;
  intentGapScore:     number | null;
  updatedAt:          string | null;
  daysInactive:       number | null;
  messagesThisWeek:   number | null;
  streakDays:         number | null;
  onboardingComplete: boolean | null;
  provisionerStatus:  string | null;
  sessionOutcome:     string | null;
  watchItems:         string[];
  highlights:         string[];
  riskFactors:        string[];
  positiveSignals:    string[];
}

export interface CustomerSummary {
  uid:                 string;
  displayName:         string;
  email:               string;
  username:            string;
  tier:                string;
  subscriptionStatus:  string;
  byotActive:          boolean;
  windowTokensUsed:    number;
  windowSize:          number;
  available:           number;
  nextRefillAt:        string | null;
  weeklyBudget:        number;
  totalTokensUsed:     number;
  costUsd:             number;
  throttleLevel:       number;
  faceModel:           string | null;
  brainModel:          string | null;
  lastActive:          string | null;
  mattermostConnected: boolean;
  mattermostUsername:  string | null;
  agentCount:          number;
  createdAt:           string | null;
  percentUsed:         number;
  revenueUsd:          number;
  marginUsd:           number;
  // Legacy aliases — kept until app/ migrates fully off the old shape.
  tokensUsed:          number;
  tokensLimit:         number;
  csi:                 CSISummary | null;
  trial:               TrialSummary | null;
  /**
   * Lifecycle status of the per-customer provisioning pipeline. Distinct
   * from subscriptionStatus (billing). `complete` is steady; anything
   * else surfaces a Provisioning badge in the admin UI so stuck/failed
   * customers can't hide.
   */
  provisioningStatus:  string | null;
}

/** Map a single user doc + (optional) CSI doc to a CustomerSummary. */
export function buildCustomerSummary(
  uid: string,
  d: Record<string, any>,
  csi: CSIDocument | null,
): CustomerSummary {
  const subscription = d.subscription ?? {};
  const tier: TierName = subscription.tier ?? "trial";
  const tierConfig = getTierConfig(tier);
  const subscriptionStatus: string = subscription.status ?? "trial";
  const usage = d.usage ?? {};
  const costUsd: number = usage.costUsd ?? 0;
  const throttleLevel: number = usage.throttleLevel ?? 0;
  const agentIds: string[] = d.provisioning?.openclaw?.agentIds ?? [];
  const revenueUsd: number = isActiveStatus(subscriptionStatus)
    ? tierConfig.monthlyPrice
    : 0;
  const windowTokensUsed = usage.windowTokensUsed ?? 0;
  const windowStartedAt = usage.windowStartedAt?.toDate?.() ?? null;
  const { available, windowSize, nextRefillAt } = calculateAvailableTokens(
    tier,
    windowTokensUsed,
    windowStartedAt,
  );
  const percentUsed = windowSize > 0
    ? Math.min(100, Math.round((windowTokensUsed / windowSize) * 100))
    : 0;

  const csiSummary: CSISummary | null = csi
    ? {
        healthScore: csi.healthScore,
        sentiment: csi.sentiment,
        intentGapScore: csi.intentGapScore,
        updatedAt: toISODate(csi.updatedAt),
        daysInactive: csi.featureSignals?.daysInactive ?? null,
        messagesThisWeek: csi.featureSignals?.messagesThisWeek ?? null,
        streakDays: csi.featureSignals?.streakDays ?? null,
        onboardingComplete: csi.featureSignals?.onboardingComplete ?? null,
        provisionerStatus: csi.provisioner?.status ?? null,
        sessionOutcome: csi.lastSessionSummary?.outcome ?? null,
        watchItems: csi.lastSessionSummary?.watchItems ?? [],
        highlights: csi.lastSessionSummary?.highlights ?? [],
        riskFactors: csi.notes?.riskFactors ?? [],
        positiveSignals: csi.notes?.positiveSignals ?? [],
      }
    : null;

  const trial: TrialSummary | null = csi?.trial
    ? buildTrialSummary(csi.trial)
    : null;

  return {
    uid,
    displayName:
      d.displayName ?? d.username ?? d.email?.split("@")[0] ?? "(unknown)",
    email: d.email ?? "",
    username: d.username ?? "",
    tier,
    subscriptionStatus,
    byotActive: d.byotActive === true,
    windowTokensUsed,
    windowSize,
    available,
    nextRefillAt: nextRefillAt?.toISOString() ?? null,
    weeklyBudget: tierConfig.weeklyTokenBudget,
    totalTokensUsed: usage.totalTokensUsed ?? usage.tokensUsed ?? 0,
    costUsd,
    throttleLevel,
    faceModel: d.faceModel ?? null,
    brainModel: d.brainModel ?? null,
    lastActive: toISODate(usage.lastUpdated),
    mattermostConnected: !!d.mattermost?.userId,
    mattermostUsername: d.mattermost?.username ?? null,
    agentCount: agentIds.length,
    createdAt: toISODate(d.createdAt),
    percentUsed,
    revenueUsd,
    marginUsd: revenueUsd - costUsd,
    tokensUsed: windowTokensUsed,
    tokensLimit: windowSize,
    csi: csiSummary,
    trial,
    // Prefer the openclaw sub-status (provisioner pipeline state); fall
    // back to the root status (older docs may not have nested it). Null
    // when neither is set.
    provisioningStatus:
      d.provisioning?.openclaw?.status ??
      d.provisioning?.status ??
      null,
  };
}

function buildTrialSummary(t: TrialState): TrialSummary {
  return {
    startedAt: toISODate(t.startedAt),
    endsAt: toISODate(t.endsAt),
    dayN: t.dayN,
    daysRemaining: t.daysRemaining,
    expired: t.expired,
    funnelStage: t.funnelStage,
    flags: { ...t.flags },
  };
}

// ── Funnel Rollup ───────────────────────────────────────────────────────────

export interface FunnelStageRow {
  stage: TrialFunnelStage;
  count: number;
  pct:   number;
  byBranch?: { byot: number; paid: number };
}

export interface FunnelMetrics {
  trialToBYOT:           number;
  trialToPaid:           number;
  activationRate:        number;
  medianHoursToProject:  number | null;
  medianDaysToConvert:   number | null;
  activeInTrial:         number;
}

export interface FunnelResponse {
  windowDays: number;
  stages:     FunnelStageRow[];
  metrics:    FunnelMetrics;
  generatedAt: string;
}

const ALL_STAGES: TrialFunnelStage[] = [
  "signed_up",
  "activated",
  "building",
  "converted",
  "expired",
];

/**
 * Roll up the per-user trial blobs from CSI docs into stage counts +
 * conversion metrics for the dashboard's funnel view.
 *
 * `inputs` is the list of (user, csi) pairs in the rollup window. Users
 * without a `csi.trial` blob are excluded — they're either pre-trial-
 * timestamp-write users or paid-from-the-start customers.
 */
export function buildFunnelRollup(
  inputs: Array<{ uid: string; user: Record<string, any>; csi: CSIDocument | null }>,
  windowDays: number,
  nowMs: number,
): FunnelResponse {
  const trials = inputs
    .map((i) => i.csi?.trial)
    .filter((t): t is TrialState => !!t);

  const total = trials.length;

  // The funnel is monotonic — each user counts at every rung up to the
  // highest they reached. So `signed_up` always equals `total`, and lower
  // stages include users from higher stages.
  // Each user's `trial.funnelStage` field is the highest rung achieved.
  // We want a "count at each level" that respects the funnel-ladder
  // visualization: signed_up shows everyone, activated shows everyone who
  // got at least to activated, etc. For `expired` we count users whose
  // FINAL stage is expired (they didn't convert) — it's mutually exclusive
  // with converted.
  const reached = new Map<TrialFunnelStage, number>();
  for (const stage of ALL_STAGES) reached.set(stage, 0);

  for (const t of trials) {
    const stage = t.funnelStage;
    // Everyone is signed_up. Then count up the ladder by their actual stage.
    reached.set("signed_up", (reached.get("signed_up") ?? 0) + 1);
    if (
      stage === "activated" || stage === "building" ||
      stage === "converted" || stage === "expired"
    ) {
      reached.set("activated", (reached.get("activated") ?? 0) + 1);
    }
    if (
      stage === "building" || stage === "converted" || stage === "expired"
    ) {
      // expired counts here too — users who reached building before expiring
      // are visible at building. The expiry annotation lives on its own row.
      reached.set("building", (reached.get("building") ?? 0) + 1);
    }
    if (stage === "converted") {
      reached.set("converted", (reached.get("converted") ?? 0) + 1);
    }
    if (stage === "expired") {
      reached.set("expired", (reached.get("expired") ?? 0) + 1);
    }
  }

  const convertedTrials = trials.filter((t) => t.funnelStage === "converted");
  const paidConversions = convertedTrials.filter((t) => t.flags.converted_paid).length;
  const byotConversions = convertedTrials.length - paidConversions;

  const stages: FunnelStageRow[] = ALL_STAGES.map((stage) => {
    const count = reached.get(stage) ?? 0;
    const pct = total > 0 ? Math.round((count / total) * 100) : 0;
    if (stage === "converted") {
      return { stage, count, pct, byBranch: { byot: byotConversions, paid: paidConversions } };
    }
    return { stage, count, pct };
  });

  // Time-to-convert (days from startedAt → first paid/byot milestone)
  const convertTimes: number[] = convertedTrials.map((t) => {
    const startMs = t.startedAt.toMillis?.() ?? 0;
    const paidMs = t.milestones.paidStartedAt;
    const byotMs = t.milestones.byotConfiguredAt;
    const convertedMs = paidMs ?? byotMs ?? nowMs;
    return (convertedMs - startMs) / (24 * 60 * 60 * 1000);
  }).filter((d) => isFinite(d) && d >= 0);

  // Time-to-first-project (hours)
  const projectTimes: number[] = trials
    .map((t) => {
      const startMs = t.startedAt.toMillis?.() ?? 0;
      const projMs = t.milestones.firstProjectCreatedAt;
      if (!projMs) return null;
      return (projMs - startMs) / (60 * 60 * 1000);
    })
    .filter((h): h is number => h !== null && h >= 0);

  const activatedCount = reached.get("activated") ?? 0;
  const activeInTrial = trials.filter((t) =>
    !t.expired && t.funnelStage !== "converted",
  ).length;

  const metrics: FunnelMetrics = {
    trialToBYOT: total > 0 ? round3(byotConversions / total) : 0,
    trialToPaid: total > 0 ? round3(paidConversions / total) : 0,
    activationRate: total > 0 ? round3(activatedCount / total) : 0,
    medianHoursToProject: median(projectTimes),
    medianDaysToConvert: median(convertTimes),
    activeInTrial,
  };

  return {
    windowDays,
    stages,
    metrics,
    generatedAt: new Date(nowMs).toISOString(),
  };
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 10) / 10;
  }
  return Math.round(sorted[mid] * 10) / 10;
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}
