import * as crypto from "node:crypto";
import { Router, type Request, type Response } from "express";

import {
  createFirestoreModelBrokerTokenStore,
  normalizeModelBrokerTokenLimits,
  type ModelBrokerTokenLimits,
  type ModelBrokerTokenStore,
} from "../lib/model-broker-tokens.js";
import type { Firestore } from "firebase-admin/firestore";
import { resolveTier, windowBudgetUsdForTier } from "../../../shared/types/billing.js";
import {
  GATEWAY_ID_REQUIREMENT,
  isValidGatewayId,
} from "../../../shared/types/glm.js";

export interface ModelKeyIssuerRouteDeps {
  db?: Pick<Firestore, "collection">;
  store?: ModelBrokerTokenStore;
  bearerToken?: string;
  ttlSeconds?: number | null;
  defaultLimits?: Partial<ModelBrokerTokenLimits> | null;
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
}

interface IssueBody {
  gatewayId?: unknown;
  ownerUid?: unknown;
  secretName?: unknown;
  provider?: unknown;
}

const PROVIDER = "anthropic";
const UNAUTHORIZED = { error: "unauthorized" } as const;

function readBearer(req: Request): string {
  const raw = req.get("authorization") ?? "";
  const [scheme, ...rest] = raw.split(" ");
  if (scheme?.toLowerCase() !== "bearer") return "";
  return rest.join(" ").trim();
}

function timingSafeEqual(a: string, b: string): boolean {
  try {
    return (
      a.length === b.length &&
      crypto.timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"))
    );
  } catch {
    return false;
  }
}

function authorize(req: Request, token: string | undefined, res: Response): boolean {
  if (!token) {
    res.status(503).json({ error: "model key issuer disabled" });
    return false;
  }
  if (!timingSafeEqual(readBearer(req), token)) {
    res.status(401).json(UNAUTHORIZED);
    return false;
  }
  return true;
}

function stringBody(body: IssueBody, key: keyof IssueBody): string {
  const value = body[key];
  return typeof value === "string" ? value.trim() : "";
}

function safeDocId(value: string | undefined): boolean {
  return !value || (value.length > 0 && !value.includes("/"));
}

function validIssueBody(body: IssueBody):
  | {
      gatewayId: string;
      ownerUid?: string;
      secretName: string;
    }
  | { error: string } {
  const gatewayId = stringBody(body, "gatewayId");
  const secretName = stringBody(body, "secretName");
  const ownerUid = stringBody(body, "ownerUid");
  if (!isValidGatewayId(gatewayId)) {
    return { error: GATEWAY_ID_REQUIREMENT };
  }
  if (!safeDocId(ownerUid)) {
    return { error: "ownerUid must be a safe document id when present" };
  }
  if (body.provider !== PROVIDER) {
    return { error: "unsupported provider" };
  }
  if (secretName !== `gateway-model-key-${gatewayId}`) {
    return { error: "secretName does not match gatewayId" };
  }
  return {
    gatewayId,
    ...(ownerUid ? { ownerUid } : {}),
    secretName,
  };
}

function parseOptionalTtlSeconds(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

function parseOptionalNumber(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function envDefaultLimits(): ModelBrokerTokenLimits {
  return normalizeModelBrokerTokenLimits({
    spendWindowUsd: parseOptionalNumber(process.env.MODEL_BROKER_SPEND_WINDOW_USD),
    requestsPerMinute: parseOptionalNumber(process.env.MODEL_BROKER_REQUESTS_PER_MINUTE),
  });
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

async function readOwnerTierLimit(
  db: Pick<Firestore, "collection"> | undefined,
  ownerUid: string | undefined,
  now: number,
): Promise<number | null> {
  if (!db || !ownerUid) return null;
  const snap = await db.collection("users").doc(ownerUid).get();
  const data = snap.data() as Record<string, unknown> | undefined;
  if (!data) return null;
  const subscription =
    data.subscription && typeof data.subscription === "object" && !Array.isArray(data.subscription)
      ? (data.subscription as Record<string, unknown>)
      : {};
  return windowBudgetUsdForTier(
    resolveTier(data),
    timestampDate(subscription.trialStartedAt),
    new Date(now),
  );
}

async function readGatewayLimitOverrides(
  db: Pick<Firestore, "collection"> | undefined,
  gatewayId: string,
): Promise<Partial<ModelBrokerTokenLimits>> {
  if (!db) return {};
  const snap = await db.collection("glmGateways").doc(gatewayId).get();
  const data = snap.data() as Record<string, unknown> | undefined;
  const raw =
    data?.modelBrokerLimits && typeof data.modelBrokerLimits === "object" && !Array.isArray(data.modelBrokerLimits)
      ? (data.modelBrokerLimits as Record<string, unknown>)
      : {};
  return {
    ...(finiteNumber(raw.spendWindowUsd) !== null
      ? { spendWindowUsd: finiteNumber(raw.spendWindowUsd) }
      : {}),
    ...(finiteNumber(raw.requestsPerMinute) !== null
      ? { requestsPerMinute: finiteNumber(raw.requestsPerMinute) }
      : {}),
  };
}

async function resolveLimits(
  deps: ModelKeyIssuerRouteDeps,
  parsed: { gatewayId: string; ownerUid?: string },
  now: number,
): Promise<ModelBrokerTokenLimits> {
  const defaults =
    deps.defaultLimits === undefined
      ? envDefaultLimits()
      : normalizeModelBrokerTokenLimits(deps.defaultLimits);
  const tierSpendWindowUsd = await readOwnerTierLimit(deps.db, parsed.ownerUid, now);
  const gatewayOverrides = await readGatewayLimitOverrides(deps.db, parsed.gatewayId);
  return normalizeModelBrokerTokenLimits({
    ...defaults,
    ...(tierSpendWindowUsd === null ? {} : { spendWindowUsd: tierSpendWindowUsd }),
    ...gatewayOverrides,
  });
}

export function createModelKeyIssuerRoutes(deps: ModelKeyIssuerRouteDeps = {}): Router {
  const router = Router();
  let store = deps.store;
  const bearerToken = deps.bearerToken ?? process.env.GATEWAY_MODEL_KEY_ISSUER_BEARER_TOKEN;
  const ttlSeconds =
    deps.ttlSeconds === undefined
      ? parseOptionalTtlSeconds(process.env.GATEWAY_MODEL_KEY_TOKEN_TTL_SECONDS)
      : deps.ttlSeconds;
  const now = deps.now ?? Date.now;

  const tokenStore = (): ModelBrokerTokenStore | undefined => {
    if (store) return store;
    if (!deps.db) return undefined;
    store = createFirestoreModelBrokerTokenStore(deps.db);
    return store;
  };

  router.post("/issue", async (req, res, next) => {
    try {
      if (!authorize(req, bearerToken, res)) return;
      const activeStore = tokenStore();
      if (!activeStore) {
        res.status(503).json({ error: "model broker token store unavailable" });
        return;
      }
      const parsed = validIssueBody((req.body ?? {}) as IssueBody);
      if ("error" in parsed) {
        res.status(400).json({ error: parsed.error });
        return;
      }
      const issuedAt = now();
      const issued = await activeStore.issueToken({
        ...parsed,
        provider: PROVIDER,
        ttlSeconds,
        limits: await resolveLimits(deps, parsed, issuedAt),
        now: issuedAt,
        randomBytes: deps.randomBytes,
      });
      res.json({
        value: issued.token,
        provider: PROVIDER,
        capped: true,
        expiresAt: issued.record.expiresAt,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/revoke", async (req, res, next) => {
    try {
      if (!authorize(req, bearerToken, res)) return;
      const activeStore = tokenStore();
      if (!activeStore) {
        res.status(503).json({ error: "model broker token store unavailable" });
        return;
      }
      const parsed = validIssueBody((req.body ?? {}) as IssueBody);
      if ("error" in parsed) {
        res.status(400).json({ error: parsed.error });
        return;
      }
      const result = await activeStore.revokeGatewayToken({
        ...parsed,
        provider: PROVIDER,
        now: now(),
      });
      res.json({ ok: true, revoked: result.revoked });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
