import { once } from "node:events";
import * as crypto from "node:crypto";
import express, { type Request, type Response as ExpressResponse, type NextFunction } from "express";

import type {
  ModelBrokerProviderKeyResolver,
  ModelBrokerProviderKey,
  ModelBrokerProviderKeySource,
} from "./lib/model-broker-provider-keys.js";
import type {
  ModelBrokerProvider,
  ModelBrokerTokenRecord,
  ModelBrokerTokenStore,
} from "./lib/model-broker-tokens.js";
import {
  estimateAnthropicCost,
  isUnknownAnthropicPricingModel,
  mergeAnthropicUsage,
  normalizeAnthropicUsage,
  totalTokens,
  type AnthropicCacheWriteTtl,
  type AnthropicTokenUsage,
  type ModelBrokerUsageStore,
} from "./lib/model-broker-usage.js";

export interface LlmBrokerAppDeps {
  store: Pick<ModelBrokerTokenStore, "lookupToken">;
  usageStore?: ModelBrokerUsageStore;
  providerKeys: Partial<Record<ModelBrokerProvider, string | undefined>>;
  providerKeyResolver?: ModelBrokerProviderKeyResolver;
  upstreamBaseUrl?: string;
  // Model a builder is degraded to when over budget (or always, on the free tier),
  // served on the platform "house" key and not billed to the builder's window.
  houseModel?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  bodyLimit?: string;
  onMeteringError?: (err: unknown) => void;
}

const DEFAULT_UPSTREAM_BASE_URL = "https://api.anthropic.com";
const DEFAULT_HOUSE_MODEL = "claude-haiku-4-5";
const DEFAULT_BODY_LIMIT = "32mb";
const MAX_SSE_METERING_BUFFER_CHARS = 1_000_000;

const ALLOWED_ANTHROPIC_ENDPOINTS = new Set([
  "GET /v1/models",
  "POST /v1/messages",
  "POST /v1/messages/count_tokens",
]);

const FORBIDDEN_RESPONSE_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const PASSTHROUGH_REQUEST_HEADERS = new Set([
  "accept",
  "anthropic-beta",
  "anthropic-version",
  "content-type",
  "user-agent",
]);

function trimTrailingSlash(value: string): string {
  let out = value.trim();
  while (out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

function authToken(req: Request): string {
  const xApiKey = req.get("x-api-key");
  if (xApiKey?.trim()) return xApiKey.trim();
  const auth = req.get("authorization") ?? "";
  const [scheme, ...rest] = auth.split(" ");
  if (scheme?.toLowerCase() !== "bearer") return "";
  return rest.join(" ").trim();
}

function requestUrl(req: Request): URL {
  return new URL(req.originalUrl, "https://llm-broker.local");
}

function allowedEndpoint(req: Request, url: URL): boolean {
  return ALLOWED_ANTHROPIC_ENDPOINTS.has(
    `${req.method.toUpperCase()} ${url.pathname}`,
  );
}

function upstreamHeaders(req: Request, apiKey: string): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase();
    if (!PASSTHROUGH_REQUEST_HEADERS.has(lower)) continue;
    if (Array.isArray(value)) {
      headers.set(name, value.join(", "));
    } else if (typeof value === "string") {
      headers.set(name, value);
    }
  }
  headers.set("x-api-key", apiKey);
  return headers;
}

async function resolveProviderKey(input: {
  record: ModelBrokerTokenRecord;
  providerKeys: Partial<Record<ModelBrokerProvider, string | undefined>>;
  providerKeyResolver?: ModelBrokerProviderKeyResolver;
}): Promise<ModelBrokerProviderKey | null> {
  if (input.providerKeyResolver) {
    return input.providerKeyResolver({
      provider: input.record.provider,
      record: input.record,
    });
  }
  const apiKey = input.providerKeys[input.record.provider]?.trim();
  return apiKey ? { apiKey, source: "platform" } : null;
}

async function resolveProviderKeyForRequest(input: {
  record: ModelBrokerTokenRecord;
  providerKeys: Partial<Record<ModelBrokerProvider, string | undefined>>;
  providerKeyResolver?: ModelBrokerProviderKeyResolver;
  onError: (err: unknown) => void;
}): Promise<ModelBrokerProviderKey | null> {
  try {
    return await resolveProviderKey({
      record: input.record,
      providerKeys: input.providerKeys,
      providerKeyResolver: input.providerKeyResolver,
    });
  } catch (err) {
    input.onError(err);
    return null;
  }
}

function isEventStream(upstream: globalThis.Response): boolean {
  return (upstream.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream");
}

function isJson(upstream: globalThis.Response): boolean {
  return (upstream.headers.get("content-type") ?? "").toLowerCase().includes("application/json");
}

function shouldMeter(req: Request, url: URL, upstream: globalThis.Response): boolean {
  return req.method.toUpperCase() === "POST" && url.pathname === "/v1/messages" && upstream.ok;
}

function readRequestMetadata(body: unknown): {
  model: string | null;
  cacheWriteTtl: AnthropicCacheWriteTtl;
} {
  if (!Buffer.isBuffer(body)) return { model: null, cacheWriteTtl: "5m" };
  try {
    const parsed = JSON.parse(body.toString("utf8")) as unknown;
    const model =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>).model
        : null;
    return {
      model: typeof model === "string" && model ? model : null,
      cacheWriteTtl: containsOneHourCacheControl(parsed) ? "1h" : "5m",
    };
  } catch {
    return { model: null, cacheWriteTtl: "5m" };
  }
}

// Degrade rewrites only the top-level `model`, preserving the rest of the request
// (messages, cache_control breakpoints, tools). Returns null on a non-JSON body so
// the caller forwards the original bytes unchanged.
function rewriteRequestModel(body: unknown, model: string): Buffer | null {
  if (!Buffer.isBuffer(body)) return null;
  try {
    const parsed = JSON.parse(body.toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    (parsed as Record<string, unknown>).model = model;
    return Buffer.from(JSON.stringify(parsed), "utf8");
  } catch {
    return null;
  }
}

function containsOneHourCacheControl(value: unknown): boolean {
  const stack = [value];
  const seen = new Set<object>();
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== "object") continue;
    if (seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    const record = current as Record<string, unknown>;
    const cacheControl = record.cache_control;
    if (cacheControl && typeof cacheControl === "object" && !Array.isArray(cacheControl)) {
      const ttl = (cacheControl as Record<string, unknown>).ttl;
      if (ttl === "1h") return true;
    }
    stack.push(...Object.values(record));
  }
  return false;
}

// Anthropic reports one aggregate cache-creation counter even when a request
// mixes 5m and 1h breakpoints. Pricing all cache creation at 1h when any 1h
// breakpoint appears deliberately over-counts until we have per-block usage.

function copyResponseHeaders(upstream: globalThis.Response, res: ExpressResponse): void {
  upstream.headers.forEach((value, key) => {
    if (!FORBIDDEN_RESPONSE_HEADERS.has(key.toLowerCase())) {
      res.setHeader(key, value);
    }
  });
}

async function writeChunk(res: ExpressResponse, chunk: Uint8Array): Promise<void> {
  if (!res.write(Buffer.from(chunk))) {
    await once(res, "drain");
  }
}

const ANTHROPIC_USAGE_FIELDS = [
  "input_tokens",
  "output_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
] as const;

function invalidAnthropicUsageFields(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const data = value as Record<string, unknown>;
  return ANTHROPIC_USAGE_FIELDS.filter((field) => {
    if (!(field in data)) return false;
    const raw = data[field];
    return typeof raw !== "number" || !Number.isFinite(raw) || raw < 0;
  });
}

interface AnthropicPayloadExtraction {
  usage: AnthropicTokenUsage | null;
  model: string | null;
  messageId: string | null;
  invalidUsageFields: string[];
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function extractAnthropicPayloadUsage(payload: unknown): AnthropicPayloadExtraction {
  const data = objectRecord(payload);
  if (!data) {
    return { usage: null, model: null, messageId: null, invalidUsageFields: [] };
  }
  const message = objectRecord(data.message);
  const model = data.model ?? message?.model;
  const messageId = data.id ?? message?.id;
  const rawUsage = data.usage ?? message?.usage;
  return {
    usage: normalizeAnthropicUsage(rawUsage),
    model: nonEmptyString(model),
    messageId: nonEmptyString(messageId),
    invalidUsageFields: invalidAnthropicUsageFields(rawUsage),
  };
}

class AnthropicSseUsageCollector {
  private readonly decoder = new TextDecoder();
  private buffered = "";
  usage: AnthropicTokenUsage | null = null;
  model: string | null = null;
  messageId: string | null = null;
  invalidUsageFields: string[] = [];

  push(chunk: Uint8Array): void {
    this.buffered += this.decoder.decode(chunk, { stream: true });
    if (this.buffered.length > MAX_SSE_METERING_BUFFER_CHARS) {
      throw new Error("Anthropic SSE metering buffer exceeded cap");
    }
    this.processCompleteEvents();
  }

  finish(): void {
    this.buffered += this.decoder.decode();
    const trailing = this.buffered.trim();
    if (trailing) this.processEvent(trailing);
    this.buffered = "";
  }

  private processCompleteEvents(): void {
    const parts = this.buffered.split(/\r?\n\r?\n/);
    this.buffered = parts.pop() ?? "";
    for (const part of parts) this.processEvent(part);
  }

  private processEvent(raw: string): void {
    const data = raw
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart())
      .join("\n")
      .trim();
    if (!data || data === "[DONE]") return;
    try {
      const extracted = extractAnthropicPayloadUsage(JSON.parse(data) as unknown);
      this.usage = mergeAnthropicUsage(this.usage, extracted.usage);
      if (extracted.model) this.model = extracted.model;
      if (extracted.messageId) this.messageId = extracted.messageId;
      this.invalidUsageFields.push(...extracted.invalidUsageFields);
    } catch {
      // Ignore malformed upstream event fragments; the response is still proxied verbatim.
    }
  }
}

function collectSseUsageChunk(
  collector: AnthropicSseUsageCollector | null,
  chunk: Uint8Array,
  onError: (err: unknown) => void,
): AnthropicSseUsageCollector | null {
  if (!collector) return null;
  try {
    collector.push(chunk);
    return collector;
  } catch (err) {
    onError(err);
    return null;
  }
}

function finishSseUsageCollection(
  collector: AnthropicSseUsageCollector | null,
  onError: (err: unknown) => void,
): AnthropicSseUsageCollector | null {
  if (!collector) return null;
  try {
    collector.finish();
    return collector;
  } catch (err) {
    onError(err);
    return null;
  }
}

interface GateDecisionAllowed {
  allowed: true;
  // Serve the house model on the house key, uncounted. True when the builder is
  // over their spend window or on the free tier. Spend exhaustion degrades — it
  // never rejects — so the builder keeps working on cheap Haiku.
  degrade: boolean;
}

interface GateDecisionDenied {
  allowed: false;
  status: 429 | 503;
  error: string;
  retryAfterSeconds?: number;
}

type GateDecision = GateDecisionAllowed | GateDecisionDenied;

interface MeteringContext {
  req: Request;
  url: URL;
  record: ModelBrokerTokenRecord;
  requestId: string;
  requestModel: string | null;
  cacheWriteTtl: AnthropicCacheWriteTtl;
  usageStore?: ModelBrokerUsageStore;
  now: () => number;
  onMeteringError: (err: unknown) => void;
  countsTowardSpendWindow: boolean;
}

async function recordUsage(
  ctx: MeteringContext,
  upstream: globalThis.Response,
  usage: AnthropicTokenUsage | null,
  responseModel: string | null,
  upstreamId: string | null,
): Promise<void> {
  if (!ctx.usageStore || !usage || totalTokens(usage) <= 0) return;
  const model = responseModel ?? ctx.requestModel ?? "unknown";
  const cost = estimateAnthropicCost(model, usage, ctx.cacheWriteTtl);
  if (isUnknownAnthropicPricingModel(cost.pricingModel)) {
    ctx.onMeteringError(
      new Error(`llm-broker used fallback pricing for unknown Anthropic model: ${model}`),
    );
  }
  try {
    await ctx.usageStore.recordUsage({
      eventId: usageEventId(ctx.record, upstreamId, ctx.requestId),
      requestId: ctx.requestId,
      upstreamId,
      provider: "anthropic",
      gatewayId: ctx.record.gatewayId,
      ownerUid: ctx.record.ownerUid,
      model,
      usage,
      cacheWriteTtl: ctx.cacheWriteTtl,
      method: ctx.req.method.toUpperCase(),
      path: ctx.url.pathname,
      upstreamStatus: upstream.status,
      now: ctx.now(),
      countsTowardSpendWindow: ctx.countsTowardSpendWindow,
    });
  } catch (err) {
    ctx.onMeteringError(err);
  }
}

function usageEventId(
  record: ModelBrokerTokenRecord,
  upstreamId: string | null,
  requestId: string,
): string {
  if (!upstreamId) return requestId;
  return `${record.provider}_${record.gatewayId}_${crypto
    .createHash("sha256")
    .update(upstreamId, "utf8")
    .digest("hex")}`;
}

interface PreflightGateInput {
  req: Request;
  url: URL;
  record: ModelBrokerTokenRecord;
  source: ModelBrokerProviderKeySource;
  usageStore?: ModelBrokerUsageStore;
  now: () => number;
  onMeteringError: (err: unknown) => void;
}

async function spendWindowGate(
  input: PreflightGateInput,
  spendWindowUsd: number,
): Promise<{ degrade: boolean } | GateDecisionDenied> {
  if (!input.usageStore?.readWindowUsage) {
    return { allowed: false, status: 503, error: "model broker spend gate unavailable" };
  }
  const usage = await input.usageStore.readWindowUsage({
    gatewayId: input.record.gatewayId,
    ownerUid: input.record.ownerUid,
    now: input.now(),
  });
  return { degrade: usage.costUsd >= spendWindowUsd };
}

async function rateWindowDenial(
  input: PreflightGateInput,
  requestsPerMinute: number,
): Promise<GateDecisionDenied | null> {
  if (!input.usageStore?.reserveRateWindow) {
    return { allowed: false, status: 503, error: "model broker rate gate unavailable" };
  }
  const rate = await input.usageStore.reserveRateWindow({
    gatewayId: input.record.gatewayId,
    ownerUid: input.record.ownerUid,
    now: input.now(),
  });
  return rate.requestCount > requestsPerMinute
    ? { allowed: false, status: 429, error: "model broker rate limit exceeded", retryAfterSeconds: 60 }
    : null;
}

async function preflightGate(input: PreflightGateInput): Promise<GateDecision> {
  const { record } = input;
  if (input.source === "owner_model_credential") return { allowed: true, degrade: false };
  if (input.req.method.toUpperCase() === "GET" && input.url.pathname === "/v1/models") {
    return { allowed: true, degrade: false };
  }
  const spendWindowUsd = record.limits.spendWindowUsd;
  const requestsPerMinute = record.limits.requestsPerMinute;
  if (!record.policy.freeTier && spendWindowUsd === null && requestsPerMinute === null) {
    return { allowed: true, degrade: false };
  }
  try {
    // Free tier always degrades; a paid builder degrades once their window is spent.
    let degrade = record.policy.freeTier;
    if (!degrade && spendWindowUsd !== null) {
      const spend = await spendWindowGate(input, spendWindowUsd);
      if ("allowed" in spend) return spend;
      degrade = spend.degrade;
    }
    if (requestsPerMinute !== null) {
      const denial = await rateWindowDenial(input, requestsPerMinute);
      if (denial) return denial;
    }
    return { allowed: true, degrade };
  } catch (err) {
    input.onMeteringError(err);
    return { allowed: false, status: 503, error: "model broker limit check failed" };
  }
}

async function writeBufferedUpstreamResponse(
  upstream: globalThis.Response,
  res: ExpressResponse,
  metering?: MeteringContext,
): Promise<void> {
  res.status(upstream.status);
  copyResponseHeaders(upstream, res);
  const text = await upstream.text();
  res.end(text);
  if (metering && isJson(upstream)) {
    try {
      const extracted = extractAnthropicPayloadUsage(JSON.parse(text) as unknown);
      if (extracted.invalidUsageFields.length) {
        metering.onMeteringError(
          new Error(`Anthropic usage contained invalid fields: ${extracted.invalidUsageFields.join(",")}`),
        );
      }
      await recordUsage(metering, upstream, extracted.usage, extracted.model, extracted.messageId);
    } catch {
      // Non-JSON success bodies are simply not meterable.
    }
  }
}

async function writeStreamingUpstreamResponse(
  upstream: globalThis.Response,
  res: ExpressResponse,
  metering?: MeteringContext,
): Promise<void> {
  res.status(upstream.status);
  copyResponseHeaders(upstream, res);
  if (!upstream.body) {
    res.end();
    return;
  }
  let collector = metering ? new AnthropicSseUsageCollector() : null;
  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        collector = collectSseUsageChunk(
          collector,
          value,
          metering?.onMeteringError ?? (() => undefined),
        );
        await writeChunk(res, value);
      }
    }
    collector = finishSseUsageCollection(
      collector,
      metering?.onMeteringError ?? (() => undefined),
    );
    res.end();
    if (metering && collector) {
      if (collector.invalidUsageFields.length) {
        metering.onMeteringError(
          new Error(`Anthropic usage contained invalid fields: ${collector.invalidUsageFields.join(",")}`),
        );
      }
      await recordUsage(metering, upstream, collector.usage, collector.model, collector.messageId);
    }
  } finally {
    reader.releaseLock();
  }
}

async function writeUpstreamResponse(
  upstream: globalThis.Response,
  res: ExpressResponse,
  metering?: MeteringContext,
): Promise<void> {
  if (isEventStream(upstream)) {
    await writeStreamingUpstreamResponse(upstream, res, metering);
  } else {
    await writeBufferedUpstreamResponse(upstream, res, metering);
  }
}

// Gate has passed → degrade the model if needed, forward to Anthropic on the
// resolved key, and meter the response. Split out of the route handler to keep
// its cyclomatic complexity in check.
async function forwardAllowed(args: {
  req: Request;
  res: ExpressResponse;
  url: URL;
  record: ModelBrokerTokenRecord;
  providerKey: ModelBrokerProviderKey;
  gate: GateDecisionAllowed;
  fetchImpl: typeof fetch;
  upstreamBaseUrl: string;
  houseModel: string;
  usageStore?: ModelBrokerUsageStore;
  now: () => number;
  onMeteringError: (err: unknown) => void;
}): Promise<void> {
  const { req, res, url, record, providerKey, gate } = args;
  const degradedBody = gate.degrade ? rewriteRequestModel(req.body, args.houseModel) : null;
  const effectiveBody = degradedBody ?? req.body;
  const body =
    req.method === "GET" || req.method === "HEAD"
      ? undefined
      : (effectiveBody as unknown as BodyInit);
  const requestMetadata = readRequestMetadata(effectiveBody);
  const requestId = crypto.randomUUID();
  const upstream = await args.fetchImpl(`${args.upstreamBaseUrl}${url.pathname}${url.search}`, {
    method: req.method,
    headers: Object.fromEntries(upstreamHeaders(req, providerKey.apiKey).entries()),
    body,
    redirect: "manual",
  });
  const metering: MeteringContext | undefined = shouldMeter(req, url, upstream)
    ? {
        req,
        url,
        record,
        requestId,
        requestModel: requestMetadata.model,
        cacheWriteTtl: requestMetadata.cacheWriteTtl,
        usageStore: args.usageStore,
        now: args.now,
        onMeteringError: args.onMeteringError,
        // Degraded + free-tier traffic runs "on the house": metered for our
        // books (rollup) but never debited against the builder's window.
        countsTowardSpendWindow:
          providerKey.source !== "owner_model_credential" && !gate.degrade,
      }
    : undefined;
  await writeUpstreamResponse(upstream, res, metering);
}

export function createLlmBrokerApp(deps: LlmBrokerAppDeps): express.Express {
  const app = express();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const upstreamBaseUrl = trimTrailingSlash(deps.upstreamBaseUrl ?? DEFAULT_UPSTREAM_BASE_URL);
  const houseModel = deps.houseModel ?? DEFAULT_HOUSE_MODEL;
  const now = deps.now ?? Date.now;

  app.disable("x-powered-by");

  app.get("/healthz", (_req, res) => {
    res.json({
      status: "ok",
      service: "llm-broker",
      providers: {
        anthropic: Boolean(deps.providerKeys.anthropic),
      },
    });
  });

  app.use(
    "/v1",
    express.raw({ type: "*/*", limit: deps.bodyLimit ?? DEFAULT_BODY_LIMIT }),
    async (req: Request, res: ExpressResponse, next: NextFunction) => {
      try {
        const url = requestUrl(req);
        if (!allowedEndpoint(req, url)) {
          res.status(404).json({ error: "unsupported LLM broker endpoint" });
          return;
        }
        const record = await deps.store.lookupToken(authToken(req), now());
        if (!record || record.provider !== "anthropic" || record.capped !== true) {
          res.status(401).json({ error: "invalid broker token" });
          return;
        }
        const providerKey = await resolveProviderKeyForRequest({
          record,
          providerKeys: deps.providerKeys,
          providerKeyResolver: deps.providerKeyResolver,
          onError: deps.onMeteringError ?? (() => undefined),
        });
        if (!providerKey) {
          res.status(503).json({ error: "anthropic upstream is not configured" });
          return;
        }
        const gate = await preflightGate({
          req,
          url,
          record,
          source: providerKey.source,
          usageStore: deps.usageStore,
          now,
          onMeteringError: deps.onMeteringError ?? (() => undefined),
        });
        if (!gate.allowed) {
          if (gate.retryAfterSeconds) {
            res.setHeader("retry-after", String(gate.retryAfterSeconds));
          }
          res.status(gate.status).json({ error: gate.error });
          return;
        }
        await forwardAllowed({
          req,
          res,
          url,
          record,
          providerKey,
          gate,
          fetchImpl,
          upstreamBaseUrl,
          houseModel,
          usageStore: deps.usageStore,
          now,
          onMeteringError: deps.onMeteringError ?? (() => undefined),
        });
      } catch (err) {
        next(err);
      }
    },
  );

  app.use((err: Error, _req: Request, res: ExpressResponse, _next: NextFunction) => {
    if (res.headersSent) return;
    res.status(502).json({ error: "llm broker upstream failure", message: err.message });
  });

  return app;
}
