import { once } from "node:events";
import * as crypto from "node:crypto";
import express, { type Request, type Response as ExpressResponse, type NextFunction } from "express";

import type {
  ModelBrokerProvider,
  ModelBrokerTokenRecord,
  ModelBrokerTokenStore,
} from "./lib/model-broker-tokens.js";
import {
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
  upstreamBaseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  bodyLimit?: string;
  onMeteringError?: (err: unknown) => void;
}

const DEFAULT_UPSTREAM_BASE_URL = "https://api.anthropic.com";
const DEFAULT_BODY_LIMIT = "32mb";

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

function upstreamHeaders(req: Request, platformKey: string): Headers {
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
  headers.set("x-api-key", platformKey);
  return headers;
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

function extractAnthropicPayloadUsage(
  payload: unknown,
): { usage: AnthropicTokenUsage | null; model: string | null } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { usage: null, model: null };
  }
  const data = payload as Record<string, unknown>;
  const message =
    data.message && typeof data.message === "object" && !Array.isArray(data.message)
      ? (data.message as Record<string, unknown>)
      : null;
  const model = data.model ?? message?.model;
  return {
    usage: normalizeAnthropicUsage(data.usage ?? message?.usage),
    model: typeof model === "string" && model ? model : null,
  };
}

class AnthropicSseUsageCollector {
  private readonly decoder = new TextDecoder();
  private buffered = "";
  usage: AnthropicTokenUsage | null = null;
  model: string | null = null;

  push(chunk: Uint8Array): void {
    this.buffered += this.decoder.decode(chunk, { stream: true });
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
    } catch {
      // Ignore malformed upstream event fragments; the response is still proxied verbatim.
    }
  }
}

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
}

async function recordUsage(
  ctx: MeteringContext,
  upstream: globalThis.Response,
  usage: AnthropicTokenUsage | null,
  responseModel: string | null,
): Promise<void> {
  if (!ctx.usageStore || !usage || totalTokens(usage) <= 0) return;
  try {
    await ctx.usageStore.recordUsage({
      requestId: ctx.requestId,
      provider: "anthropic",
      gatewayId: ctx.record.gatewayId,
      ownerUid: ctx.record.ownerUid,
      model: responseModel ?? ctx.requestModel ?? "unknown",
      usage,
      cacheWriteTtl: ctx.cacheWriteTtl,
      method: ctx.req.method.toUpperCase(),
      path: ctx.url.pathname,
      upstreamStatus: upstream.status,
      now: ctx.now(),
    });
  } catch (err) {
    ctx.onMeteringError(err);
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
      await recordUsage(metering, upstream, extracted.usage, extracted.model);
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
  const collector = metering ? new AnthropicSseUsageCollector() : null;
  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        collector?.push(value);
        await writeChunk(res, value);
      }
    }
    collector?.finish();
    res.end();
    if (metering && collector) {
      await recordUsage(metering, upstream, collector.usage, collector.model);
    }
  } finally {
    reader.releaseLock();
  }
}

export function createLlmBrokerApp(deps: LlmBrokerAppDeps): express.Express {
  const app = express();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const upstreamBaseUrl = trimTrailingSlash(deps.upstreamBaseUrl ?? DEFAULT_UPSTREAM_BASE_URL);
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
        const platformKey = deps.providerKeys.anthropic;
        if (!platformKey) {
          res.status(503).json({ error: "anthropic upstream is not configured" });
          return;
        }
        const body =
          req.method === "GET" || req.method === "HEAD"
            ? undefined
            : (req.body as unknown as BodyInit);
        const requestMetadata = readRequestMetadata(req.body);
        const requestId = crypto.randomUUID();
        const upstream = await fetchImpl(`${upstreamBaseUrl}${url.pathname}${url.search}`, {
          method: req.method,
          headers: Object.fromEntries(upstreamHeaders(req, platformKey).entries()),
          body,
          redirect: "manual",
        });
        const metering = shouldMeter(req, url, upstream)
          ? {
              req,
              url,
              record,
              requestId,
              requestModel: requestMetadata.model,
              cacheWriteTtl: requestMetadata.cacheWriteTtl,
              usageStore: deps.usageStore,
              now,
              onMeteringError: deps.onMeteringError ?? (() => undefined),
            }
          : undefined;
        if (isEventStream(upstream)) {
          await writeStreamingUpstreamResponse(upstream, res, metering);
        } else {
          await writeBufferedUpstreamResponse(upstream, res, metering);
        }
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
