import * as crypto from "node:crypto";
import { Router, type Request, type Response } from "express";

import {
  createFirestoreModelBrokerTokenStore,
  type ModelBrokerTokenLimits,
  type ModelBrokerTokenStore,
} from "../lib/model-broker-tokens.js";
import {
  envDefaultModelBrokerLimits,
  resolveOwnerModelBrokerGrant,
} from "../lib/model-broker-limits.js";
import type { Firestore } from "firebase-admin/firestore";
import {
  GATEWAY_ID_REQUIREMENT,
} from "@octogee/shared/types/glm";
import { isBareGatewayId } from "@octogee/core/gateway-live-release";

export interface ModelKeyIssuerRouteDeps {
  db?: Pick<Firestore, "collection" | "doc">;
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
  if (!isBareGatewayId(gatewayId)) {
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
      const grant = await resolveOwnerModelBrokerGrant({
        db: deps.db,
        gatewayId: parsed.gatewayId,
        ownerUid: parsed.ownerUid,
        now: issuedAt,
        defaults:
          deps.defaultLimits === undefined ? envDefaultModelBrokerLimits() : deps.defaultLimits,
      });
      const issued = await activeStore.issueToken({
        ...parsed,
        provider: PROVIDER,
        ttlSeconds,
        limits: grant.limits,
        policy: grant.policy,
        trace: { source: "gateway_model_key_issuer" },
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
