import * as crypto from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";

import {
  GATEWAY_ID_REQUIREMENT,
  isValidGatewayId,
} from "../../../shared/types/glm.js";
import { logger } from "../../../gateway-edge/src/middleware/logging.js";

const GATEWAY_MODEL_KEY_SECRET_PREFIX = "gateway-model-key-";
const DEFAULT_HTTP_TIMEOUT_MS = 10_000;

export interface GatewayModelKeyIssueRequest {
  gatewayId: string;
  ownerUid?: string;
  secretName: string;
  provider: "anthropic";
}

export interface IssuedGatewayModelKey {
  value: string;
  provider: "anthropic";
  capped: true;
}

export interface GatewayModelKeyIssuerBackend {
  issueGatewayModelKey(
    req: GatewayModelKeyIssueRequest,
  ): Promise<IssuedGatewayModelKey | null>;
  revokeGatewayModelKey?(req: GatewayModelKeyIssueRequest): Promise<void>;
}

export interface GatewayModelKeyIssuerRoutesOptions {
  bearerToken?: string;
  backend?: GatewayModelKeyIssuerBackend;
}

export interface HttpGatewayModelKeyIssuerBackendOptions {
  issueUrl: string;
  revokeUrl?: string;
  bearerToken?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface PoolGatewayModelKey {
  gatewayId: string;
  value: string;
  provider: "anthropic";
  capped: true;
}

function gatewayModelKeySecretName(gatewayId: string): string {
  return `${GATEWAY_MODEL_KEY_SECRET_PREFIX}${gatewayId}`;
}

function safeDocId(value: string | undefined): boolean {
  return !value || (value.length > 0 && !value.includes("/"));
}

function timingSafeStringEqual(a: string, b: string): boolean {
  try {
    return (
      a.length === b.length &&
      crypto.timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"))
    );
  } catch {
    return false;
  }
}

function bearerFromRequest(req: Request): string | null {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice("Bearer ".length).trim();
  return token || null;
}

function requireIssuerBearer(
  configuredToken: string | undefined,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    if (!configuredToken) {
      res.status(503).json({ error: "model key issuer auth is not configured" });
      return;
    }
    const provided = bearerFromRequest(req);
    if (!provided || !timingSafeStringEqual(provided, configuredToken)) {
      res.status(401).json({ error: "invalid model key issuer token" });
      return;
    }
    next();
  };
}

function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === "string" ? value.trim() : "";
}

function parseIssueRequest(
  body: unknown,
): { ok: true; value: GatewayModelKeyIssueRequest } | { ok: false; error: string } {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "body must be an object" };
  }
  const data = body as Record<string, unknown>;
  const gatewayId = stringField(data, "gatewayId");
  const ownerUid = stringField(data, "ownerUid") || undefined;
  const secretName = stringField(data, "secretName");
  const provider = stringField(data, "provider");

  if (!isValidGatewayId(gatewayId)) {
    return { ok: false, error: GATEWAY_ID_REQUIREMENT };
  }
  if (!safeDocId(ownerUid)) {
    return { ok: false, error: "ownerUid must be a safe document id when present" };
  }
  if (secretName !== gatewayModelKeySecretName(gatewayId)) {
    return { ok: false, error: "secretName must match gateway-model-key-<gatewayId>" };
  }
  if (provider !== "anthropic") {
    return { ok: false, error: "provider must be anthropic" };
  }

  return { ok: true, value: { gatewayId, ownerUid, secretName, provider } };
}

function issuedKeyIsValid(value: unknown): value is IssuedGatewayModelKey {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  return (
    data.provider === "anthropic" &&
    data.capped === true &&
    typeof data.value === "string" &&
    data.value.trim().length > 0
  );
}

function parseIssuedKey(value: unknown): IssuedGatewayModelKey | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  const rawValue = typeof data.value === "string" ? data.value : data.apiKey;
  const normalized = {
    value: typeof rawValue === "string" ? rawValue : "",
    provider: data.provider,
    capped: data.capped,
  };
  return issuedKeyIsValid(normalized) ? normalized : null;
}

async function postJson(
  url: string,
  body: GatewayModelKeyIssueRequest,
  opts: {
    bearerToken?: string;
    timeoutMs: number;
    fetchImpl: typeof fetch;
  },
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const resp = await opts.fetchImpl(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        ...(opts.bearerToken ? { authorization: `Bearer ${opts.bearerToken}` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(
        `upstream issuer HTTP ${resp.status}: ${text.slice(0, 200) || resp.statusText}`,
      );
    }
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

export function createHttpGatewayModelKeyIssuerBackend(
  opts: HttpGatewayModelKeyIssuerBackendOptions,
): GatewayModelKeyIssuerBackend {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  return {
    async issueGatewayModelKey(req) {
      return parseIssuedKey(
        await postJson(opts.issueUrl, req, {
          bearerToken: opts.bearerToken,
          timeoutMs,
          fetchImpl,
        }),
      );
    },
    revokeGatewayModelKey: opts.revokeUrl
      ? async (req) => {
          await postJson(opts.revokeUrl!, req, {
            bearerToken: opts.bearerToken,
            timeoutMs,
            fetchImpl,
          });
        }
      : undefined,
  };
}

function parsePositiveNumber(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function fingerprintSecret(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

export function parseGatewayModelKeyPool(raw: string): PoolGatewayModelKey[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("GATEWAY_MODEL_KEY_POOL_JSON must be an array");
  }
  const seenGateways = new Set<string>();
  const seenFingerprints = new Set<string>();
  return parsed.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new Error(`pool entry ${index} must be an object`);
    }
    const data = item as Record<string, unknown>;
    const gatewayId = typeof data.gatewayId === "string" ? data.gatewayId.trim() : "";
    const value = typeof data.value === "string" ? data.value.trim() : "";
    if (!isValidGatewayId(gatewayId)) {
      throw new Error(`pool entry ${index} has invalid gatewayId`);
    }
    if (data.provider !== "anthropic") {
      throw new Error(`pool entry ${index} must set provider=anthropic`);
    }
    if (data.capped !== true) {
      throw new Error(`pool entry ${index} must set capped=true`);
    }
    if (!value) {
      throw new Error(`pool entry ${index} must include a non-empty value`);
    }
    if (seenGateways.has(gatewayId)) {
      throw new Error(`duplicate model key pool gatewayId: ${gatewayId}`);
    }
    seenGateways.add(gatewayId);

    const fingerprint = fingerprintSecret(value);
    if (seenFingerprints.has(fingerprint)) {
      throw new Error("duplicate model key pool value fingerprint");
    }
    seenFingerprints.add(fingerprint);

    return { gatewayId, value, provider: "anthropic", capped: true };
  });
}

export function createPoolGatewayModelKeyIssuerBackend(
  entries: PoolGatewayModelKey[],
): GatewayModelKeyIssuerBackend {
  const byGateway = new Map(entries.map((entry) => [entry.gatewayId, entry]));
  return {
    async issueGatewayModelKey(req) {
      const entry = byGateway.get(req.gatewayId);
      return entry ? { value: entry.value, provider: "anthropic", capped: true } : null;
    },
  };
}

export function createConfiguredGatewayModelKeyIssuerBackend(
  env: NodeJS.ProcessEnv,
): GatewayModelKeyIssuerBackend | undefined {
  const upstreamUrl = env.GATEWAY_MODEL_KEY_UPSTREAM_ISSUER_URL;
  if (upstreamUrl) {
    return createHttpGatewayModelKeyIssuerBackend({
      issueUrl: upstreamUrl,
      revokeUrl: env.GATEWAY_MODEL_KEY_UPSTREAM_REVOKE_URL,
      bearerToken: env.GATEWAY_MODEL_KEY_UPSTREAM_BEARER_TOKEN,
      timeoutMs: parsePositiveNumber(env.GATEWAY_MODEL_KEY_UPSTREAM_TIMEOUT_MS),
    });
  }

  if (env.GATEWAY_MODEL_KEY_POOL_JSON) {
    return createPoolGatewayModelKeyIssuerBackend(
      parseGatewayModelKeyPool(env.GATEWAY_MODEL_KEY_POOL_JSON),
    );
  }

  return undefined;
}

export function createGatewayModelKeyIssuerRoutes(
  opts: GatewayModelKeyIssuerRoutesOptions,
): Router {
  const router = Router();
  router.use(requireIssuerBearer(opts.bearerToken));

  router.post("/issue", async (req, res) => {
    const parsed = parseIssueRequest(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    if (!opts.backend) {
      res.status(503).json({ error: "model key issuer backend is not configured" });
      return;
    }

    try {
      const issued = await opts.backend.issueGatewayModelKey(parsed.value);
      if (!issued) {
        res.json({ provider: "anthropic", capped: false, reason: "unavailable" });
        return;
      }
      if (!issuedKeyIsValid(issued)) {
        res.status(502).json({ error: "issuer backend returned an uncapped or invalid key" });
        return;
      }
      res.json({ value: issued.value, provider: "anthropic", capped: true });
    } catch (err) {
      logger.error("model key issuer failed", { err, gatewayId: parsed.value.gatewayId });
      res.status(502).json({ error: "model key issuer failed" });
    }
  });

  router.post("/revoke", async (req, res) => {
    const parsed = parseIssueRequest(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    if (!opts.backend?.revokeGatewayModelKey) {
      res.json({ revoked: false, reason: "revoke_not_configured" });
      return;
    }

    try {
      await opts.backend.revokeGatewayModelKey(parsed.value);
      res.json({ revoked: true });
    } catch (err) {
      logger.error("model key revoke failed", { err, gatewayId: parsed.value.gatewayId });
      res.status(502).json({ error: "model key revoke failed" });
    }
  });

  return router;
}
