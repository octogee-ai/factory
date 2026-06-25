import type { Firestore } from "firebase-admin/firestore";

import { resolveTier, windowBudgetUsdForTier } from "../../../shared/types/billing.js";
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
}

function timestampDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (value && typeof value === "object" && "toDate" in value) {
    const date = (value as { toDate?: () => unknown }).toDate?.();
    return date instanceof Date ? date : null;
  }
  return null;
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
    requestsPerMinute: parseOptionalLimitNumber(env.MODEL_BROKER_REQUESTS_PER_MINUTE),
  };
}

async function readOwnerTier(
  db: Pick<Firestore, "collection"> | undefined,
  ownerUid: string | undefined,
  now: number,
): Promise<{ spendWindowUsd: number; freeTier: boolean } | null> {
  if (!db || !ownerUid) return null;
  const snap = await db.collection("users").doc(ownerUid).get();
  const data = snap.data() as Record<string, unknown> | undefined;
  if (!data) return null;
  const subscription =
    data.subscription && typeof data.subscription === "object" && !Array.isArray(data.subscription)
      ? (data.subscription as Record<string, unknown>)
      : {};
  const tier = resolveTier(data);
  return {
    spendWindowUsd: windowBudgetUsdForTier(
      tier,
      timestampDate(subscription.trialStartedAt),
      new Date(now),
    ),
    freeTier: tier === "free",
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
  const requestsPerMinute = finiteNumber(raw.requestsPerMinute);
  return {
    ...(spendWindowUsd === null ? {} : { spendWindowUsd }),
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
  const limits = normalizeModelBrokerTokenLimits({
    ...(input.defaults ?? {}),
    ...(tier === null ? {} : { spendWindowUsd: tier.spendWindowUsd }),
    ...overrides,
  });
  const policy = normalizeModelBrokerTokenPolicy({ freeTier: tier?.freeTier === true });
  return { limits, policy };
}
