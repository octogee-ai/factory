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
import type {
  LiveOwnerGrantResolver,
  OwnerModelBrokerGrant,
} from "./lib/model-broker-limits.js";
import {
  estimateModelBrokerCost,
  isUnknownAnthropicPricingModel,
  isUnknownOpenAiPricingModel,
  isUnknownOpenRouterPricingModel,
  mergeAnthropicUsage,
  normalizeAnthropicUsage,
  totalTokens,
  type AnthropicCacheWriteTtl,
  type AnthropicTokenUsage,
  type ModelBrokerUsageStore,
} from "./lib/model-broker-usage.js";
import type { ResolvedFreeTierModel } from "@octogee/shared/types/platform-config";
import {
  MODEL_BROKER_USAGE_WINDOW_MS,
  MODEL_BROKER_WEEK_WINDOW_MS,
  usageWindowStartMs,
  weekWindowStartMs,
} from "@octogee/shared/types/model-broker-usage";
import { meterExhausted, readPlatformSpendState } from "./lib/platform-usage-allowance.js";
import type { ModelBrokerOwnerAccessResolver } from "./lib/model-broker-owner-access.js";

export interface LlmBrokerAppDeps {
  store: Pick<ModelBrokerTokenStore, "lookupToken">;
  usageStore?: ModelBrokerUsageStore;
  providerKeys: Partial<Record<ModelBrokerProvider, string | undefined>>;
  providerKeyResolver?: ModelBrokerProviderKeyResolver;
  upstreamBaseUrl?: string;
  providerUpstreamBaseUrls?: Partial<Record<ModelBrokerProvider, string | undefined>>;
  // Model a builder is degraded to when over budget (or always, on the free tier),
  // served on the platform "house" key and not billed to the builder's window.
  houseModel?: string;
  providerHouseModels?: Partial<Record<ModelBrokerProvider, string | undefined>>;
  // The operator's free-tier dial (platformConfig/models). Free-tier degrades
  // rewrite to this model when the token's provider matches; budget/credit
  // degrades keep the per-provider house model.
  resolveFreeTierModel?: () => Promise<ResolvedFreeTierModel | null>;
  fetchImpl?: typeof fetch;
  upstreamHeaderTimeoutMs?: number;
  now?: () => number;
  bodyLimit?: string;
  onMeteringError?: (err: unknown) => void;
  // Live per-owner grant resolution (tier limits + policy). When present it is
  // authoritative on every call — mint-time token limits stop being load-bearing,
  // so plan changes and the trial daily decay reach the gate within one cache TTL.
  resolveGrant?: LiveOwnerGrantResolver;
  resolveOwnerAccess?: ModelBrokerOwnerAccessResolver;
  // Structured gate-decision log: one line per proxied model call with the
  // owner, budget, and model routing needed to verify billing in TEST.
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}

const DEFAULT_ANTHROPIC_UPSTREAM_BASE_URL = "https://api.anthropic.com";
const DEFAULT_OPENROUTER_UPSTREAM_BASE_URL = "https://openrouter.ai/api";
const DEFAULT_OPENAI_UPSTREAM_BASE_URL = "https://api.openai.com";
const DEFAULT_HOUSE_MODEL = "claude-haiku-4-5";
const DEFAULT_OPENROUTER_HOUSE_MODEL = "z-ai/glm-5.2";
const DEFAULT_OPENAI_HOUSE_MODEL = "gpt-5.4-mini";
const PLATFORM_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_BODY_LIMIT = "32mb";
const DEFAULT_UPSTREAM_HEADER_TIMEOUT_MS = 120_000;
const MAX_SSE_METERING_BUFFER_CHARS = 1_000_000;

class UpstreamHeaderTimeoutError extends Error {
  constructor() {
    super("llm broker upstream timed out");
    this.name = "UpstreamHeaderTimeoutError";
  }
}

const ALLOWED_ANTHROPIC_ENDPOINTS = new Set([
  "GET /v1/models",
  "POST /v1/messages",
  "POST /v1/messages/count_tokens",
]);

const ALLOWED_OPENROUTER_ENDPOINTS = new Set([
  "GET /v1/models",
  "POST /v1/chat/completions",
]);

const ALLOWED_OPENAI_MODEL_ENDPOINTS = new Set([
  "GET /v1/models",
  "POST /v1/chat/completions",
]);

const ALLOWED_OPENAI_EMBEDDING_ENDPOINTS = new Set([
  "POST /v1/embeddings",
]);

const ALLOWED_LLM_ENDPOINTS = new Set([
  ...ALLOWED_ANTHROPIC_ENDPOINTS,
  ...ALLOWED_OPENROUTER_ENDPOINTS,
  ...ALLOWED_OPENAI_MODEL_ENDPOINTS,
  ...ALLOWED_OPENAI_EMBEDDING_ENDPOINTS,
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

function configuredString(...values: (string | undefined)[]): string {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return "";
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
  return ALLOWED_LLM_ENDPOINTS.has(`${req.method.toUpperCase()} ${url.pathname}`);
}

const ALLOWED_ENDPOINTS_BY_PROVIDER: Record<ModelBrokerProvider, ReadonlySet<string>> = {
  anthropic: ALLOWED_ANTHROPIC_ENDPOINTS,
  openai: ALLOWED_OPENAI_MODEL_ENDPOINTS,
  openrouter: ALLOWED_OPENROUTER_ENDPOINTS,
};

function providerAllowedEndpoint(
  record: ModelBrokerTokenRecord,
  req: Request,
  url: URL,
): boolean {
  const key = `${req.method.toUpperCase()} ${url.pathname}`;
  return record.purpose === "embeddings"
    ? record.provider === "openai" &&
        ALLOWED_OPENAI_EMBEDDING_ENDPOINTS.has(key)
    : ALLOWED_ENDPOINTS_BY_PROVIDER[record.provider].has(key);
}

function upstreamHeaders(req: Request, apiKey: string, provider: ModelBrokerProvider): Headers {
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
  if (provider === "anthropic") {
    headers.set("x-api-key", apiKey);
  } else {
    headers.set("authorization", `Bearer ${apiKey}`);
  }
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

function shouldMeter(
  provider: ModelBrokerProvider,
  req: Request,
  url: URL,
  upstream: globalThis.Response,
): boolean {
  if (req.method.toUpperCase() !== "POST" || !upstream.ok) return false;
  return provider === "anthropic"
    ? url.pathname === "/v1/messages"
    : url.pathname === "/v1/chat/completions" ||
        (provider === "openai" && url.pathname === "/v1/embeddings");
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

// Body rewrites preserve the rest of the request (messages, cache_control
// breakpoints, tools): degrade swaps only the top-level `model`; OpenRouter
// chat completions additionally get `usage: {include: true}` so the response
// carries the upstream's own USD accounting — the broker meters that reported
// cost instead of a static table estimate. Returns null on a non-JSON body so
// the caller forwards the original bytes unchanged.
function rewriteRequestBody(input: {
  body: unknown;
  degradeModel: string | null;
  includeOpenRouterUsage: boolean;
}): Buffer | null {
  if (!Buffer.isBuffer(input.body)) return null;
  if (!input.degradeModel && !input.includeOpenRouterUsage) return null;
  try {
    const parsed = JSON.parse(input.body.toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (input.degradeModel) record.model = input.degradeModel;
    if (input.includeOpenRouterUsage) record.usage = { include: true };
    return Buffer.from(JSON.stringify(record), "utf8");
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
  reportedCostUsd: number | null;
}

type PayloadUsageExtractor = (payload: unknown) => AnthropicPayloadExtraction;

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
    return { usage: null, model: null, messageId: null, invalidUsageFields: [], reportedCostUsd: null };
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
    reportedCostUsd: null,
  };
}

const OPENAI_USAGE_FIELDS = [
  "prompt_tokens",
  "completion_tokens",
  "total_tokens",
] as const;

function invalidOpenAiUsageFields(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const data = value as Record<string, unknown>;
  return OPENAI_USAGE_FIELDS.filter((field) => {
    if (!(field in data)) return false;
    const raw = data[field];
    return typeof raw !== "number" || !Number.isFinite(raw) || raw < 0;
  });
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

// OpenAI-format prompt_tokens INCLUDES cached tokens; split them out so cache
// reads are priced at the discounted rate instead of full input price.
function normalizeOpenAiUsage(value: unknown): AnthropicTokenUsage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const details = objectRecord(data.prompt_tokens_details);
  const promptTokens = numberOrZero(data.prompt_tokens);
  const cachedTokens = Math.min(promptTokens, numberOrZero(details?.cached_tokens));
  const usage = {
    inputTokens: promptTokens - cachedTokens,
    outputTokens: numberOrZero(data.completion_tokens),
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: cachedTokens,
  };
  return totalTokens(usage) > 0 ? usage : null;
}

function reportedUsageCostUsd(rawUsage: Record<string, unknown> | null): number | null {
  const cost = rawUsage?.cost;
  return typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : null;
}

function extractOpenRouterPayloadUsage(payload: unknown): AnthropicPayloadExtraction {
  const data = objectRecord(payload);
  if (!data) {
    return { usage: null, model: null, messageId: null, invalidUsageFields: [], reportedCostUsd: null };
  }
  const rawUsage = data.usage;
  return {
    usage: normalizeOpenAiUsage(rawUsage),
    model: nonEmptyString(data.model),
    messageId: nonEmptyString(data.id),
    invalidUsageFields: invalidOpenAiUsageFields(rawUsage),
    reportedCostUsd: reportedUsageCostUsd(objectRecord(rawUsage)),
  };
}

function usageExtractor(provider: ModelBrokerProvider): PayloadUsageExtractor {
  return provider === "anthropic"
    ? extractAnthropicPayloadUsage
    : extractOpenRouterPayloadUsage;
}

function providerLabel(provider: ModelBrokerProvider): string {
  if (provider === "anthropic") return "Anthropic";
  return provider === "openai" ? "OpenAI" : "OpenRouter";
}

function isUnknownPricingModel(provider: ModelBrokerProvider, pricingModel: string): boolean {
  if (provider === "anthropic") return isUnknownAnthropicPricingModel(pricingModel);
  if (provider === "openai") return isUnknownOpenAiPricingModel(pricingModel);
  return isUnknownOpenRouterPricingModel(pricingModel);
}

class SseUsageCollector {
  private readonly decoder = new TextDecoder();
  private buffered = "";
  usage: AnthropicTokenUsage | null = null;
  model: string | null = null;
  messageId: string | null = null;
  invalidUsageFields: string[] = [];
  reportedCostUsd: number | null = null;

  constructor(private readonly extractPayloadUsage: PayloadUsageExtractor) {}

  push(chunk: Uint8Array): void {
    this.buffered += this.decoder.decode(chunk, { stream: true });
    if (this.buffered.length > MAX_SSE_METERING_BUFFER_CHARS) {
      throw new Error("LLM broker SSE metering buffer exceeded cap");
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
      const extracted = this.extractPayloadUsage(JSON.parse(data) as unknown);
      this.usage = mergeAnthropicUsage(this.usage, extracted.usage);
      if (extracted.model) this.model = extracted.model;
      if (extracted.messageId) this.messageId = extracted.messageId;
      if (extracted.reportedCostUsd !== null) this.reportedCostUsd = extracted.reportedCostUsd;
      this.invalidUsageFields.push(...extracted.invalidUsageFields);
    } catch {
      // Ignore malformed upstream event fragments; the response is still proxied verbatim.
    }
  }
}

function collectSseUsageChunk(
  collector: SseUsageCollector | null,
  chunk: Uint8Array,
  onError: (err: unknown) => void,
): SseUsageCollector | null {
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
  collector: SseUsageCollector | null,
  onError: (err: unknown) => void,
): SseUsageCollector | null {
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
  // over their weekly ledger or burst window, or on the free tier. Spend
  // exhaustion degrades — it never rejects — so the builder keeps working on
  // the house model.
  degrade: boolean;
  degradeReason: "free" | "budget" | "credits" | null;
  windowCostUsd: number | null;
  weekCostUsd: number | null;
  creditBalanceUsd: number | null;
}

interface GateDecisionDenied {
  allowed: false;
  status: 402 | 429 | 503;
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
  providerKey: ModelBrokerProviderKey;
  degraded: boolean;
  now: () => number;
  onMeteringError: (err: unknown) => void;
  countsTowardSpendWindow: boolean;
  debitsCreditBalance: boolean;
}

// The metered outcome of one proxied call, collected identically from a
// buffered JSON body (AnthropicPayloadExtraction) or a streamed SSE tee
// (SseUsageCollector).
interface MeteredUsage {
  usage: AnthropicTokenUsage | null;
  model: string | null;
  messageId: string | null;
  reportedCostUsd: number | null;
}

async function recordUsage(
  ctx: MeteringContext,
  upstream: globalThis.Response,
  metered: MeteredUsage,
): Promise<void> {
  const { usage, reportedCostUsd } = metered;
  if (!ctx.usageStore || !usage || totalTokens(usage) <= 0) return;
  const model = metered.model ?? ctx.requestModel ?? "unknown";
  const cost = estimateModelBrokerCost(ctx.record.provider, model, usage, ctx.cacheWriteTtl);
  const unknownPricing = isUnknownPricingModel(ctx.record.provider, cost.pricingModel);
  // A reported upstream cost makes the table irrelevant for this call — only a
  // genuine fallback to estimates is worth an alert.
  if (unknownPricing && reportedCostUsd === null) {
    ctx.onMeteringError(
      new Error(`llm-broker used fallback pricing for unknown ${providerLabel(ctx.record.provider)} model: ${model}`),
    );
  }
  const upstreamId = metered.messageId;
  try {
    await ctx.usageStore.recordUsage({
      eventId: usageEventId(ctx.record, upstreamId, ctx.requestId),
      requestId: ctx.requestId,
      upstreamId,
      provider: ctx.record.provider,
      gatewayId: ctx.record.gatewayId,
      ownerUid: ctx.record.ownerUid,
      brokerTokenHash: ctx.record.tokenHash,
      brokerTokenSecretName: ctx.record.secretName,
      providerKeySource: ctx.providerKey.source,
      providerKeySecretName: ctx.providerKey.secretName ?? null,
      degraded: ctx.degraded,
      model,
      usage,
      cacheWriteTtl: ctx.cacheWriteTtl,
      method: ctx.req.method.toUpperCase(),
      path: ctx.url.pathname,
      upstreamStatus: upstream.status,
      now: ctx.now(),
      countsTowardSpendWindow: ctx.countsTowardSpendWindow,
      debitsCreditBalance: ctx.debitsCreditBalance,
      reportedCostUsd,
      usageKind:
        ctx.record.purpose === "embeddings" ? "embedding" : "model",
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
  grant: OwnerModelBrokerGrant;
  source: ModelBrokerProviderKeySource;
  usageStore?: ModelBrokerUsageStore;
  now: () => number;
  onMeteringError: (err: unknown) => void;
}

async function spendWindowGate(
  input: PreflightGateInput,
  spendWindowUsd: number | null,
  spendWeekUsd: number | null,
): Promise<
  { degrade: boolean; windowCostUsd: number | null; weekCostUsd: number | null } | GateDecisionDenied
> {
  const state = await readPlatformSpendState({
    usageStore: input.usageStore,
    gatewayId: input.record.gatewayId,
    ownerUid: input.record.ownerUid,
    now: input.now(),
    spendWindowUsd,
    spendWeekUsd,
  });
  if (!state.available) {
    return { allowed: false, status: 503, error: "model broker spend gate unavailable" };
  }
  return {
    degrade: state.exhausted,
    windowCostUsd: state.windowChargeUsd,
    weekCostUsd: state.weekChargeUsd,
  };
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
    ...(input.record.purpose === "embeddings"
      ? { scope: "embedding" as const }
      : {}),
    now: input.now(),
  });
  return rate.requestCount > requestsPerMinute
    ? { allowed: false, status: 429, error: "model broker rate limit exceeded", retryAfterSeconds: 60 }
    : null;
}

function gateDecisionName(gate: GateDecisionAllowed): string {
  if (!gate.degrade) return "forward";
  if (gate.degradeReason === "free") return "degrade_free";
  return gate.degradeReason === "credits" ? "degrade_credits" : "degrade_budget";
}

type GateLogger = (decision: string, extra?: Record<string, unknown>) => void;

function deniedDecisionName(status: GateDecisionDenied["status"]): string {
  if (status === 402) return "denied_no_token_path";
  if (status === 429) return "rate_limited";
  return "gate_unavailable";
}

function sendGateDenied(
  res: ExpressResponse,
  gate: GateDecisionDenied,
  logGate: GateLogger,
): void {
  if (gate.retryAfterSeconds) {
    res.setHeader("retry-after", String(gate.retryAfterSeconds));
  }
  logGate(deniedDecisionName(gate.status), {
    status: gate.status,
    error: gate.error,
  });
  res.status(gate.status).json({ error: gate.error });
}

async function grantForRecord(
  deps: LlmBrokerAppDeps,
  record: ModelBrokerTokenRecord,
  nowMs: number,
): Promise<OwnerModelBrokerGrant> {
  if (record.purpose === "embeddings" || !deps.resolveGrant) {
    return { limits: record.limits, policy: record.policy, rail: "subscription" };
  }
  return deps.resolveGrant({
    gatewayId: record.gatewayId,
    ownerUid: record.ownerUid,
    now: nowMs,
  });
}

const GATE_PASS: GateDecisionAllowed = {
  allowed: true,
  degrade: false,
  degradeReason: null,
  windowCostUsd: null,
  weekCostUsd: null,
  creditBalanceUsd: null,
};

type DegradeOutcome =
  | { kind: "denied"; decision: GateDecision }
  | {
      kind: "state";
      degrade: boolean;
      degradeReason: GateDecisionAllowed["degradeReason"];
      windowCostUsd: number | null;
      weekCostUsd: number | null;
      creditBalanceUsd: number | null;
    };

// Free tier rides the house model against the same weekly-ledger + burst
// machinery as paid plans — but it is already on the floor model, so an
// exhausted allowance locks until the meter refills instead of degrading.
async function freeTierGateOutcome(
  input: PreflightGateInput,
  spendWindowUsd: number | null,
  spendWeekUsd: number | null,
): Promise<DegradeOutcome> {
  if (spendWindowUsd === null && spendWeekUsd === null) {
    return {
      kind: "state",
      degrade: true,
      degradeReason: "free",
      windowCostUsd: null,
      weekCostUsd: null,
      creditBalanceUsd: null,
    };
  }
  const spend = await spendWindowGate(input, spendWindowUsd, spendWeekUsd);
  if ("allowed" in spend) return { kind: "denied", decision: spend };
  if (spend.degrade) {
    const now = input.now();
    const weekSpent = meterExhausted(spend.weekCostUsd, spendWeekUsd);
    const refillAtMs = weekSpent
      ? weekWindowStartMs(now) + MODEL_BROKER_WEEK_WINDOW_MS
      : usageWindowStartMs(now) + MODEL_BROKER_USAGE_WINDOW_MS;
    return {
      kind: "denied",
      decision: {
        allowed: false,
        status: 429,
        error:
          // Meter-neutral (weekly ledger OR burst window) and deliberately
          // token/USD-free: user surfaces never see cost mechanics.
          "free plan allowance exhausted — resumes at the next refill, or upgrade for a bigger budget",
        retryAfterSeconds: Math.max(1, Math.ceil((refillAtMs - now) / 1000)),
      },
    };
  }
  return {
    kind: "state",
    degrade: true,
    degradeReason: "free",
    windowCostUsd: spend.windowCostUsd,
    weekCostUsd: spend.weekCostUsd,
    creditBalanceUsd: null,
  };
}

function deniedNoTokenPath(): DegradeOutcome {
  return {
    kind: "denied",
    decision: {
      allowed: false,
      status: 402,
      error:
        "no active token path — upgrade to a paid Personal plan, add prepaid credits, or bring your own subscription",
    },
  };
}

async function purchasedCreditOutcome(input: PreflightGateInput): Promise<DegradeOutcome> {
  if (!input.usageStore?.readCreditBalance) {
    return {
      kind: "denied",
      decision: { allowed: false, status: 503, error: "model broker credit gate unavailable" },
    };
  }
  const creditBalanceUsd = await input.usageStore.readCreditBalance(
    input.record.ownerUid as string,
  );
  if (creditBalanceUsd <= 0) return deniedNoTokenPath();
  return {
    kind: "state",
    degrade: false,
    degradeReason: null,
    windowCostUsd: null,
    weekCostUsd: null,
    creditBalanceUsd,
  };
}

async function degradeStateForGrant(
  input: PreflightGateInput,
  prepaid: boolean,
  spendWindowUsd: number | null,
  spendWeekUsd: number | null,
): Promise<DegradeOutcome> {
  if (input.grant.policy.freeTier) {
    return freeTierGateOutcome(input, spendWindowUsd, spendWeekUsd);
  }
  if (prepaid) {
    if (!input.usageStore?.readCreditBalance) {
      return {
        kind: "denied",
        decision: { allowed: false, status: 503, error: "model broker credit gate unavailable" },
      };
    }
    const creditBalanceUsd = await input.usageStore.readCreditBalance(
      input.record.ownerUid as string,
    );
    const dry = creditBalanceUsd <= 0;
    // Builders paying for infrastructure have no house fallback: a dry balance
    // (and no attached paid Personal plan or BYOSUB) is a hard deny, not a
    // degrade — pricing v3's "paying customers pay for tokens" rule.
    if (dry && input.grant.policy.houseFallback === false) {
      return deniedNoTokenPath();
    }
    return {
      kind: "state",
      degrade: dry,
      degradeReason: dry ? "credits" : null,
      windowCostUsd: null,
      weekCostUsd: null,
      creditBalanceUsd,
    };
  }
  if (spendWindowUsd !== null || spendWeekUsd !== null) {
    const spend = await spendWindowGate(input, spendWindowUsd, spendWeekUsd);
    if ("allowed" in spend) return { kind: "denied", decision: spend };
    if (spend.degrade && input.grant.policy.houseFallback === false) {
      return purchasedCreditOutcome(input);
    }
    return {
      kind: "state",
      degrade: spend.degrade,
      degradeReason: spend.degrade ? "budget" : null,
      windowCostUsd: spend.windowCostUsd,
      weekCostUsd: spend.weekCostUsd,
      creditBalanceUsd: null,
    };
  }
  return {
    kind: "state",
    degrade: false,
    degradeReason: null,
    windowCostUsd: null,
    weekCostUsd: null,
    creditBalanceUsd: null,
  };
}

async function preflightGate(input: PreflightGateInput): Promise<GateDecision> {
  const { grant } = input;
  if (input.source === "owner_model_credential") return GATE_PASS;
  if (input.req.method.toUpperCase() === "GET" && input.url.pathname === "/v1/models") {
    return GATE_PASS;
  }
  const spendWindowUsd = grant.limits.spendWindowUsd;
  const spendWeekUsd = grant.limits.spendWeekUsd;
  const requestsPerMinute = grant.limits.requestsPerMinute;
  const prepaid = grant.rail === "prepaid_credits" && Boolean(input.record.ownerUid);
  if (
    !prepaid &&
    !grant.policy.freeTier &&
    spendWindowUsd === null &&
    spendWeekUsd === null &&
    requestsPerMinute === null
  ) {
    return GATE_PASS;
  }
  try {
    const outcome = await degradeStateForGrant(input, prepaid, spendWindowUsd, spendWeekUsd);
    if (outcome.kind === "denied") return outcome.decision;
    if (requestsPerMinute !== null) {
      const denial = await rateWindowDenial(input, requestsPerMinute);
      if (denial) return denial;
    }
    const { degrade, degradeReason, windowCostUsd, weekCostUsd, creditBalanceUsd } = outcome;
    return { allowed: true, degrade, degradeReason, windowCostUsd, weekCostUsd, creditBalanceUsd };
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
      const extracted = usageExtractor(metering.record.provider)(JSON.parse(text) as unknown);
      if (extracted.invalidUsageFields.length) {
        metering.onMeteringError(
          new Error(`${providerLabel(metering.record.provider)} usage contained invalid fields: ${extracted.invalidUsageFields.join(",")}`),
        );
      }
      await recordUsage(metering, upstream, extracted);
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
  let collector = metering ? new SseUsageCollector(usageExtractor(metering.record.provider)) : null;
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
          new Error(`${providerLabel(metering.record.provider)} usage contained invalid fields: ${collector.invalidUsageFields.join(",")}`),
        );
      }
      await recordUsage(metering, upstream, collector);
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

async function effectiveHouseModel(args: {
  gate: GateDecisionAllowed;
  provider: ModelBrokerProvider;
  houseModels: Record<ModelBrokerProvider, string>;
  resolveFreeTierModel: LlmBrokerAppDeps["resolveFreeTierModel"];
  onError: (err: unknown) => void;
}): Promise<string> {
  const houseModel = args.houseModels[args.provider];
  if (!args.gate.degrade || args.gate.degradeReason !== "free" || !args.resolveFreeTierModel) {
    return houseModel;
  }
  try {
    const dial = await args.resolveFreeTierModel();
    return dial && dial.provider === args.provider ? dial.upstreamModelId : houseModel;
  } catch (err) {
    args.onError(err);
    return houseModel;
  }
}

async function logAndForwardAllowed(args: {
  req: Request;
  res: ExpressResponse;
  url: URL;
  record: ModelBrokerTokenRecord;
  providerKey: ModelBrokerProviderKey;
  gate: GateDecisionAllowed;
  fetchImpl: typeof fetch;
  upstreamBaseUrl: string;
  houseModels: Record<ModelBrokerProvider, string>;
  resolveFreeTierModel: LlmBrokerAppDeps["resolveFreeTierModel"];
  requestModel: string | null;
  logGate: GateLogger;
  rail: OwnerModelBrokerGrant["rail"];
  usageStore?: ModelBrokerUsageStore;
  upstreamHeaderTimeoutMs: number;
  now: () => number;
  onMeteringError: (err: unknown) => void;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}): Promise<void> {
  const { gate, record } = args;
  const houseModel = await effectiveHouseModel({
    gate,
    provider: record.provider,
    houseModels: args.houseModels,
    resolveFreeTierModel: args.resolveFreeTierModel,
    onError: args.onMeteringError,
  });
  if (args.req.method.toUpperCase() === "POST") {
    args.logGate(gateDecisionName(gate), {
      effectiveModel: gate.degrade ? houseModel : args.requestModel,
      windowCostUsd: gate.windowCostUsd,
      weekCostUsd: gate.weekCostUsd,
      creditBalanceUsd: gate.creditBalanceUsd,
    });
  }
  await forwardAllowed({ ...args, houseModel });
}

function degradeModelForRequest(
  gate: GateDecisionAllowed,
  url: URL,
  houseModel: string,
): string | null {
  return gate.degrade && url.pathname !== "/v1/embeddings" ? houseModel : null;
}

function includeOpenRouterUsageForRequest(
  record: ModelBrokerTokenRecord,
  req: Request,
  url: URL,
): boolean {
  return (
    record.provider === "openrouter" &&
    req.method.toUpperCase() === "POST" &&
    url.pathname === "/v1/chat/completions"
  );
}

function meteringContextFor(args: {
  req: Request;
  url: URL;
  record: ModelBrokerTokenRecord;
  requestId: string;
  requestModel: string | null;
  cacheWriteTtl: AnthropicCacheWriteTtl;
  usageStore?: ModelBrokerUsageStore;
  providerKey: ModelBrokerProviderKey;
  gate: GateDecisionAllowed;
  now: () => number;
  onMeteringError: (err: unknown) => void;
  usingCredits: boolean;
}): MeteringContext {
  const { providerKey, gate, usingCredits } = args;
  const platformFundedEmbedding = args.record.purpose === "embeddings";
  return {
    req: args.req,
    url: args.url,
    record: args.record,
    requestId: args.requestId,
    requestModel: args.requestModel,
    cacheWriteTtl: args.cacheWriteTtl,
    usageStore: args.usageStore,
    providerKey,
    degraded: gate.degrade,
    now: args.now,
    onMeteringError: args.onMeteringError,
    // Prepaid traffic debits the credit balance; only subscription traffic
    // counts toward spend windows. A paid plan's degraded house traffic is
    // on the house — but for the free tier the house model IS the plan, so
    // its traffic debits the weekly allowance ledger.
    countsTowardSpendWindow:
      !platformFundedEmbedding &&
      providerKey.source !== "owner_model_credential" &&
      !usingCredits &&
      (!gate.degrade || gate.degradeReason === "free"),
    debitsCreditBalance:
      !platformFundedEmbedding &&
      usingCredits &&
      providerKey.source !== "owner_model_credential" &&
      !gate.degrade,
  };
}

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
  rail: OwnerModelBrokerGrant["rail"];
  usageStore?: ModelBrokerUsageStore;
  upstreamHeaderTimeoutMs: number;
  now: () => number;
  onMeteringError: (err: unknown) => void;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}): Promise<void> {
  const { req, res, url, record, providerKey, gate } = args;
  const prepaid = args.rail === "prepaid_credits" && Boolean(record.ownerUid);
  const usingCredits = prepaid || gate.creditBalanceUsd !== null;
  const rewrittenBody = rewriteRequestBody({
    body: req.body,
    degradeModel: degradeModelForRequest(gate, url, args.houseModel),
    includeOpenRouterUsage: includeOpenRouterUsageForRequest(record, req, url),
  });
  const effectiveBody = rewrittenBody ?? req.body;
  const body =
    req.method === "GET" || req.method === "HEAD"
      ? undefined
      : (effectiveBody as unknown as BodyInit);
  const requestMetadata = readRequestMetadata(effectiveBody);
  const requestId = crypto.randomUUID();
  const upstream = await fetchAndLogUpstream({
    fetchImpl: args.fetchImpl,
    url: `${args.upstreamBaseUrl}${url.pathname}${url.search}`,
    init: {
      method: req.method,
      headers: Object.fromEntries(upstreamHeaders(req, providerKey.apiKey, record.provider).entries()),
      body,
      redirect: "manual",
    },
    timeoutMs: args.upstreamHeaderTimeoutMs,
    now: args.now,
    log: args.log,
    fields: {
      gatewayId: record.gatewayId,
      ownerUid: record.ownerUid,
      provider: record.provider,
      path: url.pathname,
      requestId,
      requestModel: requestMetadata.model,
    },
  });
  const metering: MeteringContext | undefined = shouldMeter(record.provider, req, url, upstream)
    ? meteringContextFor({
        req,
        url,
        record,
        requestId,
        requestModel: requestMetadata.model,
        cacheWriteTtl: requestMetadata.cacheWriteTtl,
        usageStore: args.usageStore,
        providerKey,
        gate,
        now: args.now,
        onMeteringError: args.onMeteringError,
        usingCredits,
      })
    : undefined;
  await writeUpstreamResponse(upstream, res, metering);
}

async function fetchAndLogUpstream(args: {
  fetchImpl: typeof fetch;
  url: string;
  init: RequestInit;
  timeoutMs: number;
  now: () => number;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
  fields: Record<string, unknown>;
}): Promise<globalThis.Response> {
  const startedAt = args.now();
  args.log?.("llm-broker upstream request", args.fields);
  try {
    const upstream = await fetchUpstreamHeaders(args);
    args.log?.("llm-broker upstream headers", {
      ...args.fields,
      upstreamStatus: upstream.status,
      durationMs: args.now() - startedAt,
    });
    return upstream;
  } catch (err) {
    if (err instanceof UpstreamHeaderTimeoutError) {
      args.log?.("llm-broker upstream timeout", {
        ...args.fields,
        timeoutMs: args.timeoutMs,
        durationMs: args.now() - startedAt,
      });
    }
    throw err;
  }
}

async function fetchUpstreamHeaders(args: {
  fetchImpl: typeof fetch;
  url: string;
  init: RequestInit;
  timeoutMs: number;
}): Promise<globalThis.Response> {
  const controller = new AbortController();
  const timeoutError = new UpstreamHeaderTimeoutError();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, args.timeoutMs);
  });
  try {
    return await Promise.race([
      args.fetchImpl(args.url, { ...args.init, signal: controller.signal }),
      deadline,
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function reportBrokerResolutionError(deps: LlmBrokerAppDeps, error: unknown): void {
  deps.onMeteringError?.(error);
}

async function ownerAllowsBrokerRequest(
  deps: LlmBrokerAppDeps,
  record: ModelBrokerTokenRecord,
  res: ExpressResponse,
): Promise<boolean> {
  if (!deps.resolveOwnerAccess) return true;
  try {
    const active = await deps.resolveOwnerAccess({
      gatewayId: record.gatewayId,
      ownerUid: record.ownerUid,
    });
    if (active) return true;
    res.status(403).json({ error: "model broker owner is not active" });
    return false;
  } catch (error) {
    reportBrokerResolutionError(deps, error);
    res.status(503).json({ error: "model broker owner resolution failed" });
    return false;
  }
}

async function resolveGrantForBrokerRequest(
  deps: LlmBrokerAppDeps,
  record: ModelBrokerTokenRecord,
  now: number,
  res: ExpressResponse,
): Promise<OwnerModelBrokerGrant | null> {
  try {
    return await grantForRecord(deps, record, now);
  } catch (error) {
    reportBrokerResolutionError(deps, error);
    res.status(503).json({ error: "model broker grant resolution failed" });
    return null;
  }
}

export function createLlmBrokerApp(deps: LlmBrokerAppDeps): express.Express {
  const app = express();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const upstreamBaseUrls: Record<ModelBrokerProvider, string> = {
    anthropic: trimTrailingSlash(
      configuredString(
        deps.providerUpstreamBaseUrls?.anthropic,
        deps.upstreamBaseUrl,
        DEFAULT_ANTHROPIC_UPSTREAM_BASE_URL,
      ),
    ),
    openrouter: trimTrailingSlash(
      configuredString(
        deps.providerUpstreamBaseUrls?.openrouter,
        DEFAULT_OPENROUTER_UPSTREAM_BASE_URL,
      ),
    ),
    openai: trimTrailingSlash(
      configuredString(
        deps.providerUpstreamBaseUrls?.openai,
        DEFAULT_OPENAI_UPSTREAM_BASE_URL,
      ),
    ),
  };
  const houseModels: Record<ModelBrokerProvider, string> = {
    anthropic: configuredString(
      deps.providerHouseModels?.anthropic,
      deps.houseModel,
      DEFAULT_HOUSE_MODEL,
    ),
    openrouter: configuredString(
      deps.providerHouseModels?.openrouter,
      DEFAULT_OPENROUTER_HOUSE_MODEL,
    ),
    openai: configuredString(
      deps.providerHouseModels?.openai,
      DEFAULT_OPENAI_HOUSE_MODEL,
    ),
  };
  const now = deps.now ?? Date.now;
  const upstreamHeaderTimeoutMs =
    deps.upstreamHeaderTimeoutMs ?? DEFAULT_UPSTREAM_HEADER_TIMEOUT_MS;

  app.disable("x-powered-by");

  app.get("/healthz", (_req, res) => {
    res.json({
      status: "ok",
      service: "llm-broker",
      providers: {
        anthropic: Boolean(deps.providerKeys.anthropic),
        openrouter: Boolean(deps.providerKeys.openrouter),
        openai: Boolean(deps.providerKeys.openai),
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
        if (!record || record.capped !== true) {
          res.status(401).json({ error: "invalid broker token" });
          return;
        }
        if (!(await ownerAllowsBrokerRequest(deps, record, res))) return;
        if (!providerAllowedEndpoint(record, req, url)) {
          res.status(404).json({ error: "unsupported LLM broker endpoint" });
          return;
        }
        const requestModel = readRequestMetadata(req.body).model;
        if (
          record.purpose === "embeddings" &&
          requestModel !== PLATFORM_OPENAI_EMBEDDING_MODEL
        ) {
          res.status(400).json({ error: "unsupported embedding model" });
          return;
        }
        const providerKey = await resolveProviderKeyForRequest({
          record,
          providerKeys: deps.providerKeys,
          providerKeyResolver: deps.providerKeyResolver,
          onError: deps.onMeteringError ?? (() => undefined),
        });
        if (!providerKey) {
          res.status(503).json({ error: `${record.provider} upstream is not configured` });
          return;
        }
        const grant = await resolveGrantForBrokerRequest(deps, record, now(), res);
        if (!grant) return;
        const logGate: GateLogger = (decision, extra = {}) => {
          deps.log?.("llm-broker gate", {
            decision,
            gatewayId: record.gatewayId,
            ownerUid: record.ownerUid,
            provider: record.provider,
            purpose: record.purpose,
            path: url.pathname,
            keySource: providerKey.source,
            spendWindowUsd: grant.limits.spendWindowUsd,
            spendWeekUsd: grant.limits.spendWeekUsd,
            requestsPerMinute: grant.limits.requestsPerMinute,
            freeTier: grant.policy.freeTier,
            rail: grant.rail,
            requestModel,
            ...extra,
          });
        };
        const gate = await preflightGate({
          req,
          url,
          record,
          grant,
          source: providerKey.source,
          usageStore: deps.usageStore,
          now,
          onMeteringError: deps.onMeteringError ?? (() => undefined),
        });
        if (!gate.allowed) {
          sendGateDenied(res, gate, logGate);
          return;
        }
        await logAndForwardAllowed({
          req,
          res,
          url,
          record,
          providerKey,
          gate,
          fetchImpl,
          upstreamBaseUrl: upstreamBaseUrls[record.provider],
          houseModels,
          resolveFreeTierModel: deps.resolveFreeTierModel,
          requestModel,
          logGate,
          rail: grant.rail,
          usageStore: deps.usageStore,
          upstreamHeaderTimeoutMs,
          now,
          onMeteringError: deps.onMeteringError ?? (() => undefined),
          log: deps.log,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  app.use((err: Error, _req: Request, res: ExpressResponse, _next: NextFunction) => {
    if (res.headersSent) return;
    if (err instanceof UpstreamHeaderTimeoutError) {
      res.status(504).json({ error: err.message });
      return;
    }
    res.status(502).json({ error: "llm broker upstream failure", message: err.message });
  });

  return app;
}
