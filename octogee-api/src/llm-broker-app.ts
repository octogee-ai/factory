import { Readable } from "node:stream";
import express, { type Request, type Response as ExpressResponse, type NextFunction } from "express";

import type {
  ModelBrokerProvider,
  ModelBrokerTokenStore,
} from "./lib/model-broker-tokens.js";

export interface LlmBrokerAppDeps {
  store: Pick<ModelBrokerTokenStore, "lookupToken">;
  providerKeys: Partial<Record<ModelBrokerProvider, string | undefined>>;
  upstreamBaseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  bodyLimit?: string;
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

function copyResponseHeaders(upstream: globalThis.Response, res: ExpressResponse): void {
  upstream.headers.forEach((value, key) => {
    if (!FORBIDDEN_RESPONSE_HEADERS.has(key.toLowerCase())) {
      res.setHeader(key, value);
    }
  });
}

async function writeUpstreamResponse(
  upstream: globalThis.Response,
  res: ExpressResponse,
): Promise<void> {
  res.status(upstream.status);
  copyResponseHeaders(upstream, res);
  if (!upstream.body) {
    res.end();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0])
      .on("error", reject)
      .on("end", resolve)
      .pipe(res);
  });
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
        const upstream = await fetchImpl(`${upstreamBaseUrl}${url.pathname}${url.search}`, {
          method: req.method,
          headers: Object.fromEntries(upstreamHeaders(req, platformKey).entries()),
          body,
          redirect: "manual",
        });
        await writeUpstreamResponse(upstream, res);
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
