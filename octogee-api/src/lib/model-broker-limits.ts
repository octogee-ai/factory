import type { Firestore } from "firebase-admin/firestore";

import { resolveEffectivePlan, type BillingRail } from "@octogee/shared/types/billing";
import {
  normalizeModelBrokerTokenLimits,
  normalizeModelBrokerTokenPolicy,
  type ModelBrokerTokenLimits,
  type ModelBrokerTokenPolicy,
} from "./model-broker-tokens.js";

// Resolves the spend cap + plan policy stamped on a broker token from the owner's
// tier. Single source for both mint paths: the per-gateway issuer (builder/operator
// single-tenant pods) and the per-agent mint (shared multi-tenant pods). The broker
// enforces whatever lands here, so a null spendWindowUsd means "unmetered" — only
// the env default or an explicit admin override should produce that.
export interface OwnerModelBrokerGrant {
  limits: ModelBrokerTokenLimits;
  policy: ModelBrokerTokenPolicy;
  // Which rail bills platform calls: subscription = window budgets; Builders
  // ride prepaid_credits (their credit balance is the gate, not a window).
  rail: BillingRail;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function parseOptionalLimitNumber(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function envDefaultModelBrokerLimits(
  env: NodeJS.ProcessEnv = process.env,
): Partial<ModelBrokerTokenLimits> {
  return {
    spendWindowUsd: parseOptionalLimitNumber(env.MODEL_BROKER_SPEND_WINDOW_USD),
    spendWeekUsd: parseOptionalLimitNumber(env.MODEL_BROKER_SPEND_WEEK_USD),
    requestsPerMinute: parseOptionalLimitNumber(env.MODEL_BROKER_REQUESTS_PER_MINUTE),
  };
}

async function readOwnerTier(
  db: Pick<Firestore, "collection"> | undefined,
  ownerUid: string | undefined,
  now: number,
): Promise<{
  spendWindowUsd: number;
  spendWeekUsd: number;
  freeTier: boolean;
  rail: BillingRail;
} | null> {
  if (!db || !ownerUid) return null;
  const snap = await db.collection("users").doc(ownerUid).get();
  const data = snap.data() as Record<string, unknown> | undefined;
  if (!data) return null;
  const plan = resolveEffectivePlan(data, new Date(now));
  return {
    spendWindowUsd: plan.windowBudgetUsd,
    spendWeekUsd: plan.weeklyBudgetUsd,
    // "freeTier" on the wire = the house-only policy: always degrade to the
    // house model, never billed. Personal Free (and lapsed trials) land here.
    freeTier: plan.modelAccess === "house_only",
    rail: plan.tier === "builder" ? "prepaid_credits" : "subscription",
  };
}

async function readGatewayLimitOverrides(
  db: Pick<Firestore, "collection"> | undefined,
  gatewayId: string,
): Promise<Partial<ModelBrokerTokenLimits>> {
  if (!db) return {};
  const snap = await db.collection("glmGateways").doc(gatewayId).get();
  const data = snap.data() as Record<string, unknown> | undefined;
  const raw =
    data?.modelBrokerLimits &&
    typeof data.modelBrokerLimits === "object" &&
    !Array.isArray(data.modelBrokerLimits)
      ? (data.modelBrokerLimits as Record<string, unknown>)
      : {};
  const spendWindowUsd = finiteNumber(raw.spendWindowUsd);
  const spendWeekUsd = finiteNumber(raw.spendWeekUsd);
  const requestsPerMinute = finiteNumber(raw.requestsPerMinute);
  return {
    ...(spendWindowUsd === null ? {} : { spendWindowUsd }),
    ...(spendWeekUsd === null ? {} : { spendWeekUsd }),
    ...(requestsPerMinute === null ? {} : { requestsPerMinute }),
  };
}

export async function resolveOwnerModelBrokerGrant(input: {
  db?: Pick<Firestore, "collection">;
  gatewayId: string;
  ownerUid?: string;
  now: number;
  defaults?: Partial<ModelBrokerTokenLimits> | null;
}): Promise<OwnerModelBrokerGrant> {
  const tier = await readOwnerTier(input.db, input.ownerUid, input.now);
  const overrides = await readGatewayLimitOverrides(input.db, input.gatewayId);
  const rail: BillingRail = tier?.rail ?? "subscription";
  const limits = normalizeModelBrokerTokenLimits({
    ...(input.defaults ?? {}),
    // Prepaid-rail owners carry no window/week budget — the credit balance gates.
    ...(tier === null || rail === "prepaid_credits"
      ? {}
      : { spendWindowUsd: tier.spendWindowUsd, spendWeekUsd: tier.spendWeekUsd }),
    ...overrides,
  });
  const policy = normalizeModelBrokerTokenPolicy({ freeTier: tier?.freeTier === true });
  return { limits, policy, rail };
}

export interface LiveOwnerGrantInput {
  gatewayId: string;
  ownerUid: string | null;
  now: number;
}

export type LiveOwnerGrantResolver = (
  input: LiveOwnerGrantInput,
) => Promise<OwnerModelBrokerGrant>;

const DEFAULT_GRANT_CACHE_TTL_MS = 60_000;
const DEFAULT_GRANT_CACHE_MAX_ENTRIES = 10_000;

// The gate resolves the owner grant live on every call so tier changes and the
// trial daily decay take effect within one TTL — broker tokens carry identity,
// not limits. The cache bounds Firestore reads on the hot path; the cap +
// expired-entry sweep bounds memory under owner churn on a long-lived broker.
export function createCachedOwnerModelBrokerGrantResolver(opts: {
  db: Pick<Firestore, "collection">;
  defaults?: Partial<ModelBrokerTokenLimits> | null;
  ttlMs?: number;
  maxEntries?: number;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}): LiveOwnerGrantResolver {
  const ttlMs = opts.ttlMs ?? DEFAULT_GRANT_CACHE_TTL_MS;
  const maxEntries = opts.maxEntries ?? DEFAULT_GRANT_CACHE_MAX_ENTRIES;
  const cache = new Map<string, { grant: OwnerModelBrokerGrant; resolvedAt: number }>();

  const sweepExpired = (now: number): void => {
    if (cache.size < maxEntries) return;
    let evicted = 0;
    for (const [key, entry] of cache) {
      if (now - entry.resolvedAt >= ttlMs) {
        cache.delete(key);
        evicted += 1;
      }
    }
    // Everything still live at the cap: drop the oldest insertions rather
    // than grow unbounded — they re-resolve on their next call.
    while (cache.size >= maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
      evicted += 1;
    }
    opts.log?.("llm-broker grant cache swept", { evicted, remaining: cache.size });
  };

  return async ({ gatewayId, ownerUid, now }) => {
    const key = `${gatewayId}:${ownerUid ?? ""}`;
    const cached = cache.get(key);
    if (cached && now - cached.resolvedAt < ttlMs) return cached.grant;
    if (cached) cache.delete(key);
    sweepExpired(now);

    const grant = await resolveOwnerModelBrokerGrant({
      db: opts.db,
      gatewayId,
      ownerUid: ownerUid ?? undefined,
      now,
      defaults: opts.defaults,
    });
    cache.set(key, { grant, resolvedAt: now });
    opts.log?.("llm-broker grant resolved", {
      gatewayId,
      ownerUid,
      spendWindowUsd: grant.limits.spendWindowUsd,
      spendWeekUsd: grant.limits.spendWeekUsd,
      requestsPerMinute: grant.limits.requestsPerMinute,
      freeTier: grant.policy.freeTier,
      rail: grant.rail,
    });
    return grant;
  };
}
