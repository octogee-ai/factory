import type { Firestore } from "firebase-admin/firestore";

import {
  resolveBillingProfile,
  signupOfferBudgetForOwner,
  type BillingRail,
  type OwnedSignupOfferBudget,
} from "@octogee/shared/types/billing";
import {
  readGatewayAuthorization,
  type GatewayAuthorization,
} from "@octogee/core/gateway-live-release";
import {
  normalizeModelBrokerTokenLimits,
  normalizeModelBrokerTokenPolicy,
  type ModelBrokerTokenLimits,
  type ModelBrokerTokenPolicy,
} from "./model-broker-tokens.js";

export interface OwnerModelBrokerGrant {
  limits: ModelBrokerTokenLimits;
  policy: ModelBrokerTokenPolicy;
  // Which rail bills platform calls: subscription = window budgets; Builders
  // ride prepaid_credits (their credit balance is the gate, not a window).
  rail: BillingRail;
  signupOfferBudget?: OwnedSignupOfferBudget | null;
}

type ModelBrokerFirestore = Pick<Firestore, "collection" | "doc">;

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
  db: ModelBrokerFirestore | undefined,
  ownerUid: string | undefined,
  now: number,
): Promise<{
  spendWindowUsd: number;
  spendWeekUsd: number;
  freeTier: boolean;
  houseFallback: boolean;
  rail: BillingRail;
  signupOfferBudget: OwnedSignupOfferBudget | null;
} | null> {
  if (!db || !ownerUid) return null;
  const snap = await db.collection("users").doc(ownerUid).get();
  const data = snap.data() as Record<string, unknown> | undefined;
  if (!data) return null;
  const profile = resolveBillingProfile(data, new Date(now));
  return {
    spendWindowUsd: profile.windowBudgetUsd,
    spendWeekUsd: profile.weeklyBudgetUsd,
    // "freeTier" on the wire = the house-only policy: always degrade to the
    // house model, never billed. Personal Free (and lapsed trials) land here.
    freeTier: profile.modelAccess === "house_only",
    // Builders with no live paid token path get denied instead of degraded.
    houseFallback: profile.houseFallback,
    rail: profile.rail,
    signupOfferBudget: signupOfferBudgetForOwner(data, ownerUid, new Date(now)),
  };
}

async function readGatewayLimitOverrides(
  db: ModelBrokerFirestore | undefined,
  gatewayId: string,
  authorization?: GatewayAuthorization,
): Promise<Partial<ModelBrokerTokenLimits>> {
  if (!db) return {};
  const resolved = authorization ?? await readGatewayAuthorization(db, gatewayId);
  if (!resolved) {
    throw new Error(`durable root config unavailable for gateways/${gatewayId}`);
  }
  const raw = resolved.config.modelBrokerLimits ?? {};
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
  db?: ModelBrokerFirestore;
  gatewayId: string;
  ownerUid?: string;
  now: number;
  defaults?: Partial<ModelBrokerTokenLimits> | null;
  gatewayAuthorization?: GatewayAuthorization;
}): Promise<OwnerModelBrokerGrant> {
  const tier = await readOwnerTier(input.db, input.ownerUid, input.now);
  const overrides = await readGatewayLimitOverrides(
    input.db,
    input.gatewayId,
    input.gatewayAuthorization,
  );
  const rail: BillingRail = tier?.rail ?? "subscription";
  const limits = normalizeModelBrokerTokenLimits({
    ...(input.defaults ?? {}),
    // Prepaid-rail owners carry no window/week budget — the credit balance gates.
    ...(tier === null || rail === "prepaid_credits" || rail === "signup_offer"
      ? {}
      : { spendWindowUsd: tier.spendWindowUsd, spendWeekUsd: tier.spendWeekUsd }),
    ...overrides,
  });
  const policy = normalizeModelBrokerTokenPolicy({
    freeTier: tier?.freeTier === true,
    houseFallback: tier?.houseFallback !== false,
  });
  return { limits, policy, rail, signupOfferBudget: tier?.signupOfferBudget ?? null };
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

function cachedGrantIsFresh(
  entry: { grant: OwnerModelBrokerGrant; resolvedAt: number },
  now: number,
  ttlMs: number,
): boolean {
  if (now - entry.resolvedAt >= ttlMs) return false;
  const budget = entry.grant.signupOfferBudget;
  if (!budget) return true;
  if (now >= budget.endsAtMs) return false;
  return budget.nextUnlockAtMs === null || now < budget.nextUnlockAtMs;
}

function mutableLimitFingerprint(authorization: GatewayAuthorization): string {
  const limits = authorization.config.modelBrokerLimits;
  return [
    authorization.gateway.updatedAt,
    authorization.config.configSchemaVersion,
    limits?.spendWindowUsd ?? null,
    limits?.spendWeekUsd ?? null,
    limits?.requestsPerMinute ?? null,
  ].join(":");
}

export function createCachedOwnerModelBrokerGrantResolver(opts: {
  db: ModelBrokerFirestore;
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
    const authorization = await readGatewayAuthorization(opts.db, gatewayId);
    if (!authorization) {
      throw new Error(`durable root config unavailable for gateways/${gatewayId}`);
    }
    const key = `${gatewayId}:${mutableLimitFingerprint(authorization)}:${ownerUid ?? ""}`;
    const cached = cache.get(key);
    if (cached && cachedGrantIsFresh(cached, now, ttlMs)) return cached.grant;
    if (cached) cache.delete(key);
    sweepExpired(now);

    const grant = await resolveOwnerModelBrokerGrant({
      db: opts.db,
      gatewayId,
      ownerUid: ownerUid ?? undefined,
      now,
      defaults: opts.defaults,
      gatewayAuthorization: authorization,
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
      offerId: grant.signupOfferBudget?.offerId,
      offerVersion: grant.signupOfferBudget?.offerVersion,
      offerDayIndex: grant.signupOfferBudget?.offerDayIndex,
    });
    return grant;
  };
}
