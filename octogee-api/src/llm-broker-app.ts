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
  isUnknownOpenRouterPricingModel,
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
  providerUpstreamBaseUrls?: Partial<Record<ModelBrokerProvider, string | undefined>>;
  // Model a builder is degraded to when over budget (or always, on the free tier),
  // served on the platform "house" key and not billed to the builder's window.
  houseModel?: string;
  providerHouseModels?: Partial<Record<ModelBrokerProvider, string | undefined>>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  bodyLimit?: string;
  onMeteringError?: (err: unknown) => void;
  // Live per-owner grant resolution (tier limits + policy). When present it is
  // authoritative on every call — mint-time token limits stop being load-bearing,
  // so plan changes and the trial daily decay reach the gate within one cache TTL.
  resolveGrant?: LiveOwnerGrantResolver;
  // Structured gate-decision log: one line per proxied model call with the
  // owner, budget, and model routing needed to verify billing in TEST.
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}

const DEFAULT_ANTHROPIC_UPSTREAM_BASE_URL = "https://api.anthropic.com";
const DEFAULT_OPENROUTER_UPSTREAM_BASE_URL = "https://openrouter.ai/api";
const DEFAULT_HOUSE_MODEL = "claude-haiku-4-5";
const DEFAULT_OPENROUTER_HOUSE_MODEL = "z-ai/glm-5.2";
const DEFAULT_BODY_LIMIT = "32mb";
const MAX_SSE_METERING_BUFFER_CHARS = 1_000_000;

const ALLOWED_ANTHROPIC_ENDPOINTS = new Set([
  "GET /v1/models",
  "POST /v1/messages",
  "POST /v1/messages/count_tokens",
]);

const ALLOWED_OPENROUTER_ENDPOINTS = new Set([
  "GET /v1/models",
  "POST /v1/chat/completions",
]);

const ALLOWED_LLM_ENDPOINTS = new Set([
  ...ALLOWED_ANTHROPIC_ENDPOINTS,
  ...ALLOWED_OPENROUTER_ENDPOINTS,
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

function providerAllowedEndpoint(
  provider: ModelBrokerProvider,
  req: Request,
  url: URL,
): boolean {
  const key = `${req.method.toUpperCase()} ${url.pathname}`;
  return provider === "anthropic"
    ? ALLOWED_ANTHROPIC_ENDPOINTS.has(key)
    : ALLOWED_OPENROUTER_ENDPOINTS.has(key);
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
    : url.pathname === "/v1/chat/completions";
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

function normalizeOpenAiUsage(value: unknown): AnthropicTokenUsage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const usage = {
    inputTokens: numberOrZero(data.prompt_tokens),
    outputTokens: numberOrZero(data.completion_tokens),
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };
  return totalTokens(usage) > 0 ? usage : null;
}

function extractOpenRouterPayloadUsage(payload: unknown): AnthropicPayloadExtraction {
  const data = objectRecord(payload);
  if (!data) {
    return { usage: null, model: null, messageId: null, invalidUsageFields: [] };
  }
  const rawUsage = data.usage;
  return {
    usage: normalizeOpenAiUsage(rawUsage),
    model: nonEmptyString(data.model),
    messageId: nonEmptyString(data.id),
    invalidUsageFields: invalidOpenAiUsageFields(rawUsage),
  };
}

function usageExtractor(provider: ModelBrokerProvider): PayloadUsageExtractor {
  return provider === "anthropic"
    ? extractAnthropicPayloadUsage
    : extractOpenRouterPayloadUsage;
}

function providerLabel(provider: ModelBrokerProvider): string {
  return provider === "anthropic" ? "Anthropic" : "OpenRouter";
}

class SseUsageCollector {
  private readonly decoder = new TextDecoder();
  private buffered = "";
  usage: AnthropicTokenUsage | null = null;
  model: string | null = null;
  messageId: string | null = null;
  invalidUsageFields: string[] = [];

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
  // over their spend window or on the free tier. Spend exhaustion degrades — it
  // never rejects — so the builder keeps working on cheap Haiku.
  degrade: boolean;
  degradeReason: "free" | "budget" | "credits" | null;
  windowCostUsd: number | null;
  creditBalanceUsd: number | null;
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
  providerKey: ModelBrokerProviderKey;
  degraded: boolean;
  now: () => number;
  onMeteringError: (err: unknown) => void;
  countsTowardSpendWindow: boolean;
  debitsCreditBalance: boolean;
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
  const cost = estimateModelBrokerCost(ctx.record.provider, model, usage, ctx.cacheWriteTtl);
  const unknownPricing =
    ctx.record.provider === "anthropic"
      ? isUnknownAnthropicPricingModel(cost.pricingModel)
      : isUnknownOpenRouterPricingModel(cost.pricingModel);
  if (unknownPricing) {
    ctx.onMeteringError(
      new Error(`llm-broker used fallback pricing for unknown ${providerLabel(ctx.record.provider)} model: ${model}`),
    );
  }
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
  spendWindowUsd: number,
): Promise<{ degrade: boolean; windowCostUsd: number } | GateDecisionDenied> {
  if (!input.usageStore?.readWindowUsage) {
    return { allowed: false, status: 503, error: "model broker spend gate unavailable" };
  }
  const usage = await input.usageStore.readWindowUsage({
    gatewayId: input.record.gatewayId,
    ownerUid: input.record.ownerUid,
    now: input.now(),
  });
  return { degrade: usage.costUsd >= spendWindowUsd, windowCostUsd: usage.costUsd };
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

function gateDecisionName(gate: GateDecisionAllowed): string {
  if (!gate.degrade) return "forward";
  if (gate.degradeReason === "free") return "degrade_free";
  return gate.degradeReason === "credits" ? "degrade_credits" : "degrade_budget";
}

type GateLogger = (decision: string, extra?: Record<string, unknown>) => void;

function sendGateDenied(
  res: ExpressResponse,
  gate: GateDecisionDenied,
  logGate: GateLogger,
): void {
  if (gate.retryAfterSeconds) {
    res.setHeader("retry-after", String(gate.retryAfterSeconds));
  }
  logGate(gate.status === 429 ? "rate_limited" : "gate_unavailable", {
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
  if (!deps.resolveGrant) {
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
  creditBalanceUsd: null,
};

type DegradeOutcome =
  | { kind: "denied"; decision: GateDecision }
  | {
      kind: "state";
      degrade: boolean;
      degradeReason: GateDecisionAllowed["degradeReason"];
      windowCostUsd: number | null;
      creditBalanceUsd: number | null;
    };

// Free tier always degrades; a prepaid builder degrades once their balance is
// dry; a subscription plan degrades once its window budget is spent.
async function degradeStateForGrant(
  input: PreflightGateInput,
  prepaid: boolean,
  spendWindowUsd: number | null,
): Promise<DegradeOutcome> {
  if (input.grant.policy.freeTier) {
    return { kind: "state", degrade: true, degradeReason: "free", windowCostUsd: null, creditBalanceUsd: null };
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
    return {
      kind: "state",
      degrade: dry,
      degradeReason: dry ? "credits" : null,
      windowCostUsd: null,
      creditBalanceUsd,
    };
  }
  if (spendWindowUsd !== null) {
    const spend = await spendWindowGate(input, spendWindowUsd);
    if ("allowed" in spend) return { kind: "denied", decision: spend };
    return {
      kind: "state",
      degrade: spend.degrade,
      degradeReason: spend.degrade ? "budget" : null,
      windowCostUsd: spend.windowCostUsd,
      creditBalanceUsd: null,
    };
  }
  return { kind: "state", degrade: false, degradeReason: null, windowCostUsd: null, creditBalanceUsd: null };
}

async function preflightGate(input: PreflightGateInput): Promise<GateDecision> {
  const { grant } = input;
  if (input.source === "owner_model_credential") return GATE_PASS;
  if (input.req.method.toUpperCase() === "GET" && input.url.pathname === "/v1/models") {
    return GATE_PASS;
  }
  const spendWindowUsd = grant.limits.spendWindowUsd;
  const requestsPerMinute = grant.limits.requestsPerMinute;
  const prepaid = grant.rail === "prepaid_credits" && Boolean(input.record.ownerUid);
  if (!prepaid && !grant.policy.freeTier && spendWindowUsd === null && requestsPerMinute === null) {
    return GATE_PASS;
  }
  try {
    const outcome = await degradeStateForGrant(input, prepaid, spendWindowUsd);
    if (outcome.kind === "denied") return outcome.decision;
    if (requestsPerMinute !== null) {
      const denial = await rateWindowDenial(input, requestsPerMinute);
      if (denial) return denial;
    }
    const { degrade, degradeReason, windowCostUsd, creditBalanceUsd } = outcome;
    return { allowed: true, degrade, degradeReason, windowCostUsd, creditBalanceUsd };
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
  now: () => number;
  onMeteringError: (err: unknown) => void;
}): Promise<void> {
  const { req, res, url, record, providerKey, gate } = args;
  const prepaid = args.rail === "prepaid_credits" && Boolean(record.ownerUid);
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
    headers: Object.fromEntries(upstreamHeaders(req, providerKey.apiKey, record.provider).entries()),
    body,
    redirect: "manual",
  });
  const metering: MeteringContext | undefined = shouldMeter(record.provider, req, url, upstream)
    ? {
        req,
        url,
        record,
        requestId,
        requestModel: requestMetadata.model,
        cacheWriteTtl: requestMetadata.cacheWriteTtl,
        usageStore: args.usageStore,
        providerKey,
        degraded: gate.degrade,
        now: args.now,
        onMeteringError: args.onMeteringError,
        // Prepaid traffic debits the credit balance; only subscription traffic
        // counts toward spend windows. House/degraded traffic touches neither.
        countsTowardSpendWindow:
          providerKey.source !== "owner_model_credential" && !gate.degrade && !prepaid,
        debitsCreditBalance:
          prepaid && providerKey.source !== "owner_model_credential" && !gate.degrade,
      }
    : undefined;
  await writeUpstreamResponse(upstream, res, metering);
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
  };
  const now = deps.now ?? Date.now;

  app.disable("x-powered-by");

  app.get("/healthz", (_req, res) => {
    res.json({
      status: "ok",
      service: "llm-broker",
      providers: {
        anthropic: Boolean(deps.providerKeys.anthropic),
        openrouter: Boolean(deps.providerKeys.openrouter),
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
        if (!providerAllowedEndpoint(record.provider, req, url)) {
          res.status(404).json({ error: "unsupported LLM broker endpoint" });
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
        let grant: OwnerModelBrokerGrant;
        try {
          grant = await grantForRecord(deps, record, now());
        } catch (err) {
          (deps.onMeteringError ?? (() => undefined))(err);
          res.status(503).json({ error: "model broker grant resolution failed" });
          return;
        }
        const requestModel = readRequestMetadata(req.body).model;
        const logGate: GateLogger = (decision, extra = {}) => {
          deps.log?.("llm-broker gate", {
            decision,
            gatewayId: record.gatewayId,
            ownerUid: record.ownerUid,
            provider: record.provider,
            path: url.pathname,
            keySource: providerKey.source,
            spendWindowUsd: grant.limits.spendWindowUsd,
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
        if (req.method.toUpperCase() === "POST") {
          logGate(gateDecisionName(gate), {
            effectiveModel: gate.degrade ? houseModels[record.provider] : requestModel,
            windowCostUsd: gate.windowCostUsd,
            creditBalanceUsd: gate.creditBalanceUsd,
          });
        }
        await forwardAllowed({
          req,
          res,
          url,
          record,
          providerKey,
          gate,
          fetchImpl,
          upstreamBaseUrl: upstreamBaseUrls[record.provider],
          houseModel: houseModels[record.provider],
          rail: grant.rail,
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
