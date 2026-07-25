import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { isIP } from "node:net";
import path from "node:path";
import { Transform } from "node:stream";
import { WsUpgradeRouter } from "@octogee/core/ws/upgrade-router";
import {
  acquireSystemConfigMutationLease,
  type SystemConfigMutationLease,
} from "@octogee/core/system-config-mutation-lease";
import type { SystemConfigInvariantContext } from "@octogee/core/system-config-invariants";
import { isResponseFrame } from "@octogee/shared/types/openclaw-wire-core";
import { Router, type Request, type Response } from "express";
import { WebSocket, type RawData } from "ws";

import { fetchGatewayToken } from "../chat-proxy/openclaw/gateway-token.js";
import { logger } from "../middleware/logging.js";
import {
  auditOpenClawControlRpc,
  authorizeOpenClawControlSession,
  redeemOpenClawControlTicket,
  type OpenClawControlAuditCategory,
  type OpenClawControlAuditReason,
} from "./broker.js";
import {
  challengeNonce,
  rewriteTrustedOpenClawConnect,
  sanitizeOpenClawControlServerFrame,
} from "./connect-rewrite.js";
import {
  evaluateNativeOpenClawControlRpc,
  evaluateDelegatedOpenClawControlRpc,
  installedMethodsFromHello,
  isOpenClawControlMutation,
  openClawConfigSnapshotFromGetResponse,
  openClawControlPolicyError,
  openClawControlTimeoutError,
  pinnedOpenClawRuntimeMatches,
  projectOpenClawServerFrameForProfile,
  type OpenClawConfigSnapshot,
  type OpenClawControlRpcDecision,
  type OpenClawControlRpcCategory,
} from "./rpc-policy.js";
import {
  OpenClawControlResourceLimiter,
  type OpenClawControlLease,
  type OpenClawControlResourceIdentity,
} from "./limits.js";
import { OpenClawControlSessionManager, type OpenClawControlSession } from "./session.js";
import type { OpenClawControlMetrics, OpenClawControlMetricIdentity } from "./metrics.js";

const MAX_WS_FRAME_BYTES = 1_048_576;
const DEFAULT_HTTP_TIMEOUT_MS = 5_000;
const DEFAULT_RPC_TIMEOUT_MS = 10_000;
const DEFAULT_AUTHORIZATION_INTERVAL_MS = 10_000;
const CSP_BEFORE_FRAME_ANCESTORS = "default-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors";
const CSP_AFTER_FRAME_ANCESTORS = "; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self' blob:";
const DASHBOARD_ERROR_EVENT = "octogee-openclaw-dashboard-error";
const ALLOWED_REQUEST_HEADERS = new Set([
  "accept",
  "accept-language",
  "cache-control",
  "content-type",
  "if-match",
  "if-modified-since",
  "if-none-match",
  "if-unmodified-since",
  "pragma",
  "range",
]);
const ALLOWED_RESPONSE_HEADERS = new Set([
  "accept-ranges",
  "cache-control",
  "content-disposition",
  "content-language",
  "content-length",
  "content-range",
  "content-type",
  "etag",
  "last-modified",
  "vary",
]);
const DASHBOARD_ROUTES = new Set([
  "/activity",
  "/agents",
  "/ai-agents",
  "/appearance",
  "/automation",
  "/channels",
  "/chat",
  "/communications",
  "/config",
  "/cron",
  "/debug",
  "/dreaming",
  "/dreams",
  "/infrastructure",
  "/instances",
  "/logs",
  "/mcp",
  "/nodes",
  "/overview",
  "/plugin",
  "/sessions",
  "/settings/ai-agents",
  "/settings/appearance",
  "/settings/automation",
  "/settings/channels",
  "/settings/communications",
  "/settings/general",
  "/settings/infrastructure",
  "/settings/mcp",
  "/settings/worktrees",
  "/skills",
  "/skills/workshop",
  "/tasks",
  "/usage",
  "/workboard",
  "/worktrees",
]);
const DASHBOARD_ROOT_ASSETS = new Set([
  "/apple-touch-icon.png",
  "/favicon-32.png",
  "/favicon.ico",
  "/favicon.svg",
  "/manifest.webmanifest",
  "/sw.js",
]);
const DASHBOARD_STATIC_EXTENSIONS = new Set([
  ".css",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".js",
  ".json",
  ".map",
  ".png",
  ".svg",
  ".txt",
  ".wasm",
  ".webmanifest",
  ".webp",
]);
const defaultSessions = new OpenClawControlSessionManager();
const defaultLimiter = new OpenClawControlResourceLimiter();
const retainedMutationLeases = new Set<SystemConfigMutationLease>();

function retainMutationLeaseUntilProcessReplacement(lease: SystemConfigMutationLease): void {
  if (!retainedMutationLeases.has(lease)) retainedMutationLeases.add(lease);
}

function envValue(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required for OpenClaw Dashboard`);
  return value;
}

function apiOrigin(env: NodeJS.ProcessEnv): string {
  const origin = new URL(envValue(env, "API_PUBLIC_URL"));
  if (origin.pathname !== "/" || origin.search || origin.hash ||
    (origin.protocol !== "https:" && origin.hostname !== "localhost")) {
    throw new Error("API_PUBLIC_URL must be an HTTPS origin for OpenClaw Dashboard");
  }
  return origin.origin;
}

function appOrigin(env: NodeJS.ProcessEnv): string {
  const origin = new URL(envValue(env, "APP_URL"));
  const allowedProtocol = origin.protocol === "https:" ||
    (origin.protocol === "http:" && origin.hostname === "localhost");
  if (origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password ||
    !allowedProtocol) {
    throw new Error("APP_URL must be an HTTPS origin for OpenClaw Dashboard");
  }
  return origin.origin;
}

function gatewayClass(env: NodeJS.ProcessEnv): "shared" | "builder" | "operator" {
  const value = env.GATEWAY_CLASS ?? env.GATEWAY_PROFILE;
  return value === "builder" || value === "operator" ? value : "shared";
}

function metricIdentity(env: NodeJS.ProcessEnv): OpenClawControlMetricIdentity {
  return {
    gatewayId: envValue(env, "GATEWAY_ID"),
    revisionId: envValue(env, "GATEWAY_REVISION_ID"),
    gatewayClass: gatewayClass(env),
  };
}

function invariantContext(env: NodeJS.ProcessEnv, gatewayId: string): SystemConfigInvariantContext {
  const value = gatewayClass(env);
  return value === "shared"
    ? { gatewayClass: value }
    : { gatewayClass: value, gatewayId, apiOrigin: apiOrigin(env) };
}

export function isOpenClawControlWsPath(pathname: string): boolean {
  return pathname === "/openclaw";
}

export function openClawControlUpstreamBase(env: NodeJS.ProcessEnv): URL {
  const url = new URL(env.OPENCLAW_GATEWAY_URL?.trim() || "http://127.0.0.1:18789");
  const hostname = url.hostname.toLowerCase();
  const loopback = hostname === "localhost" || hostname === "[::1]" || hostname === "::1" ||
    (isIP(hostname) === 4 && hostname.startsWith("127."));
  if (url.protocol !== "http:") throw new Error("OpenClaw Dashboard upstream must use HTTP");
  if (!loopback) throw new Error("OpenClaw Dashboard upstream must use a loopback address");
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("OpenClaw Dashboard upstream must be a bare loopback origin");
  }
  return url;
}

function isNativeChatSessionSelector(parsed: URL, key: string): boolean {
  const chatSessions = parsed.searchParams.getAll(key);
  return parsed.pathname.endsWith("/openclaw/chat") &&
    key === "session" &&
    chatSessions.length === 1 &&
    /^[A-Za-z0-9:_-]{1,256}$/u.test(chatSessions[0] ?? "");
}

export function openClawControlUpstreamPath(originalUrl: string, gatewayId: string): string {
  const rawPath = originalUrl.split("?", 1)[0] ?? "";
  if (!rawPath.startsWith("/") || rawPath.includes("\\") || rawPath.includes("..") ||
    /%(?:2e|2f|5c)/iu.test(rawPath)) {
    throw new Error("OpenClaw Dashboard request path is outside its base path");
  }
  const parsed = new URL(originalUrl, "https://octogee.invalid");
  for (const key of parsed.searchParams.keys()) {
    if (isNativeChatSessionSelector(parsed, key)) continue;
    if (/(?:token|ticket|secret|session|auth|key)/iu.test(key)) {
      throw new Error("OpenClaw Dashboard request contains a sensitive query parameter");
    }
  }
  const publicBase = `/api/g/${gatewayId}/openclaw`;
  const strippedBase = "/openclaw";
  let inboundBase: string | null = null;
  if (parsed.pathname === publicBase || parsed.pathname.startsWith(`${publicBase}/`)) {
    inboundBase = publicBase;
  } else if (parsed.pathname === strippedBase || parsed.pathname.startsWith(`${strippedBase}/`)) {
    inboundBase = strippedBase;
  }
  if (!inboundBase) throw new Error("OpenClaw Dashboard request path is outside its base path");
  const suffix = parsed.pathname.slice(inboundBase.length);
  return `/g/${gatewayId}/openclaw${suffix}${parsed.search}`;
}

function openClawControlHttpSuffix(originalUrl: string, gatewayId: string): URL {
  const parsed = new URL(originalUrl, "https://octogee.invalid");
  const publicBase = `/api/g/${gatewayId}/openclaw`;
  const strippedBase = "/openclaw";
  const inboundBase = parsed.pathname === publicBase || parsed.pathname.startsWith(`${publicBase}/`)
    ? publicBase
    : strippedBase;
  parsed.pathname = parsed.pathname.slice(inboundBase.length) || "/";
  return parsed;
}

function isDashboardStaticAsset(pathname: string): boolean {
  if (!pathname.startsWith("/assets/")) return false;
  const relativePath = pathname.slice("/assets/".length);
  if (!relativePath || relativePath.split("/").some((segment) =>
    !/^[A-Za-z0-9@+._-]+$/u.test(segment))) {
    return false;
  }
  return DASHBOARD_STATIC_EXTENSIONS.has(path.extname(relativePath).toLowerCase());
}

function isDashboardAvatar(parsed: URL): boolean {
  if (!/^\/avatar\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(parsed.pathname)) return false;
  if (!parsed.search) return true;
  return parsed.searchParams.size === 1 && parsed.searchParams.get("meta") === "1";
}

function isDashboardProviderIcon(pathname: string): boolean {
  return /^\/provider-icons\/ProviderIcon-[A-Za-z0-9_-]+\.svg$/u.test(pathname);
}

export function isOpenClawControlHttpResource(originalUrl: string, gatewayId: string): boolean {
  openClawControlUpstreamPath(originalUrl, gatewayId);
  const parsed = openClawControlHttpSuffix(originalUrl, gatewayId);
  const route = parsed.pathname.length > 1 && parsed.pathname.endsWith("/")
    ? parsed.pathname.slice(0, -1)
    : parsed.pathname;
  return route === "/" ||
    route === "/control-ui-config.json" ||
    DASHBOARD_ROUTES.has(route) ||
    DASHBOARD_ROOT_ASSETS.has(route) ||
    isDashboardStaticAsset(route) ||
    isDashboardAvatar(parsed) ||
    isDashboardProviderIcon(route);
}

function securityHeaders(res: Response | http.ServerResponse, frameAncestor: string): void {
  res.setHeader("cache-control", "no-store");
  res.setHeader(
    "content-security-policy",
    `${CSP_BEFORE_FRAME_ANCESTORS} ${frameAncestor}${CSP_AFTER_FRAME_ANCESTORS}`,
  );
  res.setHeader("cross-origin-opener-policy", "same-origin");
  res.setHeader("cross-origin-resource-policy", "cross-origin");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("x-content-type-options", "nosniff");
  res.removeHeader("x-frame-options");
}

function isDashboardNavigation(req: Request): boolean {
  const destination = req.get("sec-fetch-dest")?.toLowerCase();
  return destination === "document" || destination === "iframe" ||
    /(?:^|,)\s*text\/html(?:\s*;[^,]*)?(?:,|$)/iu.test(req.get("accept") ?? "");
}

function dashboardFailureDocument(
  res: Response,
  frameAncestor: string,
  status: number,
): void {
  securityHeaders(res, frameAncestor);
  const targetOrigin = JSON.stringify(frameAncestor);
  const eventType = JSON.stringify(DASHBOARD_ERROR_EVENT);
  res.status(status).type("html").send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>OpenClaw Dashboard</title>
  <style>html,body{height:100%;margin:0}body{display:grid;place-items:center;background:#f8fafc;color:#1e293b;font:14px system-ui,sans-serif}.card{max-width:24rem;margin:1.5rem;padding:1.5rem;border:1px solid #e2e8f0;border-radius:.75rem;background:#fff;text-align:center}h1{margin:0 0 .5rem;font-size:1rem}p{margin:0;color:#64748b}</style>
</head>
<body>
  <main class="card"><h1>OpenClaw Dashboard</h1><p>The secure Dashboard could not load. Return to Octogee and try again.</p></main>
  <script>window.parent.postMessage({type:${eventType}},${targetOrigin})</script>
</body>
</html>`);
}

function dashboardFailure(
  req: Request,
  res: Response,
  frameAncestor: string,
  status: number,
  body: Record<string, unknown>,
): void {
  if (isDashboardNavigation(req)) {
    dashboardFailureDocument(res, frameAncestor, status);
    return;
  }
  securityHeaders(res, frameAncestor);
  res.status(status).json(body);
}

function unauthorized(req: Request, res: Response, frameAncestor: string): void {
  dashboardFailure(req, res, frameAncestor, 401, {
    error: "dashboard-session-invalid",
    relaunch: true,
  });
}

function rejectDashboardHttpRequest(
  req: Request,
  res: Response,
  frameAncestor: string,
  gatewayId: string,
): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") {
    securityHeaders(res, frameAncestor);
    res.setHeader("allow", "GET, HEAD");
    res.status(405).json({ error: "method-not-allowed" });
    return true;
  }
  if (!isOpenClawControlHttpResource(req.originalUrl, gatewayId)) {
    securityHeaders(res, frameAncestor);
    res.status(404).json({ error: "dashboard-resource-not-found" });
    return true;
  }
  return false;
}

function httpAssetOutcome(statusCode: number): "ok" | "timeout" | "error" {
  if (statusCode < 400) return "ok";
  return statusCode === 504 ? "timeout" : "error";
}

function requestHeaders(
  req: Request,
  env: NodeJS.ProcessEnv,
  gatewayToken: string,
): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (ALLOWED_REQUEST_HEADERS.has(name.toLowerCase())) headers[name] = value;
  }
  headers.host = openClawControlUpstreamBase(env).host;
  headers.origin = apiOrigin(env);
  headers.authorization = `Bearer ${gatewayToken}`;
  headers["accept-encoding"] = "identity";
  return headers;
}

function scrubCredentialText(value: string, credentials: readonly string[]): string {
  return credentials.filter(Boolean).reduce(
    (cleaned, credential) => cleaned.replaceAll(credential, "*".repeat(credential.length)),
    value,
  );
}

function credentialScrubber(credentials: readonly string[]): Transform {
  const needles = credentials.filter(Boolean).map((value) => Buffer.from(value)).sort((a, b) => b.length - a.length);
  const overlap = Math.max(0, ...needles.map((needle) => needle.length - 1));
  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  const scrub = (input: Buffer): Buffer => {
    const output = Buffer.from(input);
    for (const needle of needles) {
      let index = output.indexOf(needle);
      while (index >= 0) {
        output.fill(0x2a, index, index + needle.length);
        index = output.indexOf(needle, index + needle.length);
      }
    }
    return output;
  };
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const combined = Buffer.concat([pending, Buffer.from(chunk)]);
      const safeLength = Math.max(0, combined.length - overlap);
      const cleaned = scrub(combined);
      pending = cleaned.subarray(safeLength);
      callback(null, cleaned.subarray(0, safeLength));
    },
    flush(callback) {
      callback(null, scrub(pending));
    },
  });
}

export interface CreateOpenClawControlHttpRouterOptions {
  env?: NodeJS.ProcessEnv;
  sessions?: OpenClawControlSessionManager;
  redeem?: typeof redeemOpenClawControlTicket;
  authorize?: typeof authorizeOpenClawControlSession;
  loadGatewayToken?: typeof fetchGatewayToken;
  httpTimeoutMs?: number;
  metrics?: OpenClawControlMetrics;
}

export function createOpenClawControlHttpRouter(
  options: CreateOpenClawControlHttpRouterOptions,
): Router {
  const env = options.env ?? process.env;
  const sessions = options.sessions ?? defaultSessions;
  const redeem = options.redeem ?? redeemOpenClawControlTicket;
  const authorize = options.authorize ?? authorizeOpenClawControlSession;
  const loadGatewayToken = options.loadGatewayToken ?? fetchGatewayToken;
  const httpTimeoutMs = options.httpTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const metrics = options.metrics;
  const identity = metricIdentity(env);
  const frameAncestor = appOrigin(env);
  if (!Number.isSafeInteger(httpTimeoutMs) || httpTimeoutMs <= 0) {
    throw new Error("OpenClaw Dashboard HTTP timeout must be a positive integer");
  }
  const router = Router({ mergeParams: true });
  router.get("/launch/:ticket", async (req: Request, res: Response) => {
    const startedAt = performance.now();
    res.once("finish", () => metrics?.http(
      identity,
      "launch",
      res.statusCode < 400 ? "ok" : "denied",
      (performance.now() - startedAt) / 1_000,
    ));
    try {
      const gatewayId = req.params.gatewayId;
      const revisionId = envValue(env, "GATEWAY_REVISION_ID");
      const ticket = req.params.ticket;
      if (gatewayId !== envValue(env, "GATEWAY_ID") || typeof ticket !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/u.test(ticket)) {
        unauthorized(req, res, frameAncestor);
        return;
      }
      const sessionId = randomUUID();
      const redeemed = await redeem({ ticket, sessionId, gatewayId, revisionId, env });
      if (!redeemed || redeemed.gatewayId !== gatewayId || redeemed.revisionId !== revisionId) {
        metrics?.session(identity, "redeem", "denied");
        unauthorized(req, res, frameAncestor);
        return;
      }
      metrics?.session(identity, "redeem", "ok");
      const issued = sessions.issue({
        sessionId,
        uid: redeemed.uid,
        gatewayId,
        revisionId,
        brokerProfile: redeemed.brokerProfile,
        permissionSetIds: redeemed.permissionSetIds,
        grantRevision: redeemed.grantRevision,
        absoluteExpiresAt: redeemed.expiresAt,
      });
      securityHeaders(res, frameAncestor);
      res.setHeader("set-cookie", issued.cookie);
      res.setHeader("location", `/g/${gatewayId}/openclaw/`);
      res.status(303).end();
    } catch (error) {
      logger.error("OpenClaw Dashboard ticket redemption failed", {
        error: error instanceof Error ? error.name : "UnknownError",
        gatewayId: req.params.gatewayId,
      });
      dashboardFailure(req, res, frameAncestor, 502, {
        error: "openclaw-unavailable",
        retryable: true,
      });
    }
  });
  router.use(async (req: Request, res: Response) => {
    const startedAt = performance.now();
    res.once("finish", () => metrics?.http(
      identity,
      "asset",
      httpAssetOutcome(res.statusCode),
      (performance.now() - startedAt) / 1_000,
    ));
    try {
      const gatewayId = req.params.gatewayId;
      const revisionId = env.GATEWAY_REVISION_ID?.trim();
      if (gatewayId !== env.GATEWAY_ID || !revisionId) {
        unauthorized(req, res, frameAncestor);
        return;
      }
      const session = sessions.verify({ cookieHeader: req.headers.cookie, gatewayId, revisionId });
      if (!session || !await authorize({ sessionId: session.sessionId, gatewayId, revisionId, env })) {
        metrics?.session(identity, "authorize", "denied");
        if (session) sessions.revoke(session.sessionId);
        unauthorized(req, res, frameAncestor);
        return;
      }
      metrics?.session(identity, "authorize", "ok");
      if (rejectDashboardHttpRequest(req, res, frameAncestor, gatewayId)) return;
      const touched = sessions.touchSession(session);
      if (!touched) {
        unauthorized(req, res, frameAncestor);
        return;
      }
      const gatewayToken = await loadGatewayToken({ gatewayId });
      const base = openClawControlUpstreamBase(env);
      let timedOut = false;
      let settled = false;
      const proxy = http.request({
        protocol: base.protocol,
        hostname: base.hostname,
        port: base.port,
        method: req.method,
        path: openClawControlUpstreamPath(req.originalUrl, gatewayId),
        headers: requestHeaders(req, env, gatewayToken),
      }, (upstream) => {
        settled = true;
        res.status(upstream.statusCode ?? 502);
        for (const [name, value] of Object.entries(upstream.headers)) {
          if (value !== undefined && ALLOWED_RESPONSE_HEADERS.has(name.toLowerCase())) {
            const scrubbed = Array.isArray(value)
              ? value.map((item) => scrubCredentialText(item, [gatewayToken]))
              : scrubCredentialText(String(value), [gatewayToken]);
            res.setHeader(name, scrubbed);
          }
        }
        securityHeaders(res, frameAncestor);
        res.setHeader("set-cookie", touched.cookie);
        upstream.pipe(credentialScrubber([gatewayToken])).pipe(res);
      });
      proxy.setTimeout(httpTimeoutMs, () => {
        timedOut = true;
        proxy.destroy();
      });
      proxy.once("error", () => {
        if (settled || res.headersSent) {
          res.destroy();
          return;
        }
        if (timedOut) {
          dashboardFailure(req, res, frameAncestor, 504, {
            error: "openclaw-timeout",
            retryable: true,
          });
        } else {
          dashboardFailure(req, res, frameAncestor, 502, {
            error: "openclaw-unavailable",
            retryable: true,
          });
        }
      });
      req.once("aborted", () => proxy.destroy());
      proxy.end();
    } catch (error) {
      logger.error("OpenClaw Dashboard HTTP proxy failed", {
        error: error instanceof Error ? error.name : "UnknownError",
        gatewayId: req.params.gatewayId,
      });
      if (!res.headersSent) {
        dashboardFailure(req, res, frameAncestor, 502, {
          error: "openclaw-unavailable",
          retryable: true,
        });
      } else {
        res.destroy();
      }
    }
  });
  return router;
}

function parseFrame(data: RawData): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : String(data)) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function frameBytes(data: RawData): number {
  if (Buffer.isBuffer(data)) return data.byteLength;
  if (Array.isArray(data)) return data.reduce((total, item) => total + item.byteLength, 0);
  return Buffer.byteLength(data as ArrayBuffer);
}

function configFrozen(env: NodeJS.ProcessEnv): boolean {
  const openclawDir = envValue(env, "OPENCLAW_DIR");
  return fs.existsSync(path.join(openclawDir, "system_config.freeze.json"));
}

interface PendingRpc {
  category: OpenClawControlRpcCategory;
  method: string;
  internal: boolean;
  proposed?: Record<string, unknown>;
  lease: OpenClawControlLease;
  mutationLease?: SystemConfigMutationLease;
  timer: NodeJS.Timeout;
}

function canonicalReason(reason: string | undefined): OpenClawControlAuditReason {
  if (reason === "rate-limited" || reason === "inflight-limited" || reason === "socket-limited") {
    return "rate_limited";
  }
  if (reason === "request-timeout" || reason === "capability-unavailable") {
    return "upstream_unavailable";
  }
  if (reason === "invalid-frame" || reason === "runtime-drift") return "protocol_invalid";
  return reason ? "method_denied" : "none";
}

interface AuditEventInput {
  audit: typeof auditOpenClawControlRpc;
  env: NodeJS.ProcessEnv;
  session: OpenClawControlSession;
  event: "rpc_allow" | "rpc_deny" | "rpc_result";
  category: OpenClawControlAuditCategory;
  outcome: "ok" | "denied" | "error";
  reason?: string;
}

function auditEvent(input: AuditEventInput): void {
  void input.audit({
    gatewayId: input.session.gatewayId,
    revisionId: input.session.revisionId,
    sessionId: input.session.sessionId,
    event: input.event,
    category: input.category,
    outcome: input.outcome,
    reason: canonicalReason(input.reason),
    env: input.env,
  }).catch(() => {
    logger.warn("OpenClaw Dashboard RPC audit failed", {
      gatewayId: input.session.gatewayId,
      revisionId: input.session.revisionId,
      event: input.event,
      category: input.category,
    });
  });
}

interface BridgeControlSocketArgs {
  browser: WebSocket;
  requestPath: string;
  cookieHeader?: string;
  session: OpenClawControlSession;
  sessions: OpenClawControlSessionManager;
  env: NodeJS.ProcessEnv;
  authorize: typeof authorizeOpenClawControlSession;
  loadGatewayToken: typeof fetchGatewayToken;
  audit: typeof auditOpenClawControlRpc;
  limiter: OpenClawControlResourceLimiter;
  socketLease: OpenClawControlLease;
  rpcTimeoutMs: number;
  authorizationIntervalMs: number;
  metrics?: OpenClawControlMetrics;
  retainMutationLeaseUntilProcessReplacement: (
    lease: SystemConfigMutationLease,
    reason: string,
  ) => void;
}

interface BrowserRpcFrame extends Record<string, unknown> {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

function browserRpcFrame(data: RawData): BrowserRpcFrame | null {
  const frame = parseFrame(data);
  if (!frame || typeof frame.id !== "string" || typeof frame.method !== "string") return null;
  if (!frame.params || typeof frame.params !== "object" || Array.isArray(frame.params)) return null;
  return frame as BrowserRpcFrame;
}

class OpenClawControlSocketBridge {
  private readonly identity: OpenClawControlResourceIdentity;
  private readonly metricsIdentity: OpenClawControlMetricIdentity;
  private activeSession: OpenClawControlSession;
  private gatewayToken = "";
  private upstream?: WebSocket;
  private nonce: string | null = null;
  private connectForwarded = false;
  private installedMethods?: Set<string>;
  private currentConfig?: OpenClawConfigSnapshot;
  private readonly pending = new Map<string, PendingRpc>();
  private readonly admittingIds = new Set<string>();
  private readonly timedOut = new Map<string, SystemConfigMutationLease | undefined>();
  private quarantineTimer?: NodeJS.Timeout;
  private authorizationTimer?: NodeJS.Timeout;
  private closing = false;
  private socketReleased = false;

  constructor(private readonly args: BridgeControlSocketArgs) {
    this.activeSession = args.session;
    this.identity = {
      uid: args.session.uid,
      gatewayId: args.session.gatewayId,
      sessionId: args.session.sessionId,
    };
    this.metricsIdentity = metricIdentity(args.env);
  }

  async start(): Promise<void> {
    this.gatewayToken = await this.args.loadGatewayToken({ gatewayId: this.args.session.gatewayId });
    if (this.args.browser.readyState !== WebSocket.OPEN) {
      this.args.socketLease.release();
      return;
    }
    const base = openClawControlUpstreamBase(this.args.env);
    const upstreamUrl = new URL(this.args.requestPath, base);
    upstreamUrl.protocol = "ws:";
    this.upstream = new WebSocket(upstreamUrl, { maxPayload: MAX_WS_FRAME_BYTES });
    this.args.metrics?.ws(this.metricsIdentity, "open", "ok");
    this.startAuthorizationChecks();
    this.attachSocketHandlers();
  }

  private upstreamSocket(): WebSocket {
    if (!this.upstream) throw new Error("OpenClaw Dashboard upstream is not initialized");
    return this.upstream;
  }

  private attachSocketHandlers(): void {
    const upstream = this.upstreamSocket();
    upstream.on("message", (data) => this.handleUpstreamMessage(data));
    upstream.once("close", () => this.closeBoth("upstream-closed"));
    upstream.once("error", () => this.closeBoth("upstream-unavailable"));
    this.args.browser.once("close", () => this.closeBoth("browser-closed"));
    this.args.browser.once("error", () => this.closeBoth("browser-error"));
    this.args.browser.on("message", (data, isBinary) => this.handleBrowserMessage(data, isBinary));
  }

  private startAuthorizationChecks(): void {
    this.authorizationTimer = setInterval(() => this.checkAuthorization(), this.args.authorizationIntervalMs);
    this.authorizationTimer.unref?.();
  }

  private checkAuthorization(): void {
    const local = this.args.sessions.verify({
      cookieHeader: this.args.cookieHeader,
      gatewayId: this.activeSession.gatewayId,
      revisionId: this.activeSession.revisionId,
    });
    if (!local) {
      this.closeBoth("session-expired");
      return;
    }
    void this.args.authorize({
      sessionId: this.activeSession.sessionId,
      gatewayId: this.activeSession.gatewayId,
      revisionId: this.activeSession.revisionId,
      env: this.args.env,
    }).then((allowed) => {
      this.args.metrics?.session(this.metricsIdentity, "authorize", allowed ? "ok" : "denied");
      if (!allowed) {
        this.args.sessions.revoke(this.activeSession.sessionId);
        this.closeBoth("capability-revoked");
      }
    }).catch(() => this.closeBoth("capability-unavailable"));
  }

  private touch(): boolean {
    const touched = this.args.sessions.touchSession(this.activeSession);
    if (!touched) return false;
    this.activeSession = touched.session;
    return true;
  }

  private releaseMutationLease(lease: SystemConfigMutationLease): void {
    void lease.release().catch((error) => {
      logger.error("OpenClaw Dashboard config mutation lease release failed", {
        gatewayId: this.activeSession.gatewayId,
        revisionId: this.activeSession.revisionId,
        error: error instanceof Error ? error.message : String(error),
      });
      this.closeBoth("config-lease-release-failed");
    });
  }

  private retainMutationLease(lease: SystemConfigMutationLease, reason: string): void {
    this.args.retainMutationLeaseUntilProcessReplacement(lease, reason);
    logger.error("OpenClaw Dashboard config mutation outcome is uncertain; writer lease retained", {
      gatewayId: this.activeSession.gatewayId,
      revisionId: this.activeSession.revisionId,
      reason,
    });
  }

  private takePending(id: string): PendingRpc | undefined {
    const item = this.pending.get(id);
    if (!item) return undefined;
    this.pending.delete(id);
    clearTimeout(item.timer);
    item.lease.release();
    return item;
  }

  private settlePending(id: string): PendingRpc | undefined {
    const item = this.takePending(id);
    if (item?.mutationLease) this.releaseMutationLease(item.mutationLease);
    return item;
  }

  private closeBoth(reason = "dashboard-session-invalid"): void {
    if (this.closing) return;
    this.closing = true;
    if (this.authorizationTimer) clearInterval(this.authorizationTimer);
    if (this.quarantineTimer) clearTimeout(this.quarantineTimer);
    this.admittingIds.clear();
    this.retainUncertainLeases(reason);
    if (!this.socketReleased) {
      this.socketReleased = true;
      this.args.socketLease.release();
    }
    this.closeBrowser(reason);
    if (this.upstream) this.terminate(this.upstream);
    logger.debug("OpenClaw Dashboard socket closed", {
      gatewayId: this.activeSession.gatewayId,
      revisionId: this.activeSession.revisionId,
      reason,
    });
    this.args.metrics?.ws(this.metricsIdentity, "close", reason);
  }

  private terminate(socket: WebSocket): void {
    if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.terminate();
  }

  private closeBrowser(reason: string): void {
    if (this.args.browser.readyState === WebSocket.CONNECTING) {
      this.args.browser.terminate();
      return;
    }
    if (this.args.browser.readyState !== WebSocket.OPEN) return;
    const policyFailure = reason === "session-expired" || reason === "capability-revoked" ||
      reason === "invalid-dashboard-frame" || reason === "protocol-invalid" ||
      reason === "runtime-drift";
    this.args.browser.close(policyFailure ? 1008 : 1011, reason);
  }

  private retainUncertainLeases(reason: string): void {
    for (const [id, mutationLease] of this.timedOut) {
      this.timedOut.delete(id);
      if (mutationLease) this.retainMutationLease(mutationLease, reason);
    }
    for (const id of [...this.pending.keys()]) {
      const item = this.takePending(id);
      if (item?.mutationLease) this.retainMutationLease(item.mutationLease, reason);
    }
  }

  private quarantine(id: string, mutationLease?: SystemConfigMutationLease): void {
    this.timedOut.set(id, mutationLease);
    if (this.quarantineTimer) return;
    this.quarantineTimer = setTimeout(() => this.closeBoth("request-timeout"), this.args.rpcTimeoutMs);
    this.quarantineTimer.unref?.();
  }

  private drainQuarantined(id: string): boolean {
    if (!this.timedOut.has(id)) return false;
    const mutationLease = this.timedOut.get(id);
    this.timedOut.delete(id);
    if (mutationLease) this.releaseMutationLease(mutationLease);
    if (this.timedOut.size === 0 && this.quarantineTimer) {
      clearTimeout(this.quarantineTimer);
      this.quarantineTimer = undefined;
    }
    return true;
  }

  private track(
    id: string,
    method: string,
    category: OpenClawControlRpcCategory,
    lease: OpenClawControlLease,
    options: {
      internal?: boolean;
      proposed?: Record<string, unknown>;
      mutationLease?: SystemConfigMutationLease;
    } = {},
  ): void {
    const pendingRpc = {} as PendingRpc;
    const timer = setTimeout(() => this.expirePending(id, method, category, pendingRpc), this.args.rpcTimeoutMs);
    timer.unref?.();
    Object.assign(pendingRpc, {
      category,
      method,
      internal: options.internal ?? false,
      proposed: options.proposed,
      lease,
      mutationLease: options.mutationLease,
      timer,
    });
    this.pending.set(id, pendingRpc);
  }

  private expirePending(
    id: string,
    method: string,
    category: OpenClawControlRpcCategory,
    pendingRpc: PendingRpc,
  ): void {
    if (this.pending.get(id) !== pendingRpc) return;
    const expired = this.takePending(id);
    if (pendingRpc.internal) {
      this.closeBoth("request-timeout");
      return;
    }
    this.quarantine(id, expired?.mutationLease);
    if (this.args.browser.readyState === WebSocket.OPEN) {
      this.args.browser.send(openClawControlTimeoutError({ type: "req", id, method, params: {} }));
      this.audit("rpc_result", category, "error", "request-timeout");
      this.args.metrics?.rpc(this.metricsIdentity, category, "timeout");
    }
  }

  private audit(
    event: AuditEventInput["event"],
    category: OpenClawControlAuditCategory,
    outcome: AuditEventInput["outcome"],
    reason?: string,
  ): void {
    auditEvent({
      audit: this.args.audit,
      env: this.args.env,
      session: this.activeSession,
      event,
      category,
      outcome,
      reason,
    });
  }

  private handleUpstreamMessage(data: RawData): void {
    const frame = parseFrame(data);
    if (!frame) {
      this.closeBoth("protocol-invalid");
      return;
    }
    this.nonce = challengeNonce(frame) ?? this.nonce;
    const response = isResponseFrame(frame) ? frame : undefined;
    if (frame.type === "res" && !response) {
      this.closeBoth("protocol-invalid");
      return;
    }
    const id = typeof frame.id === "string" ? frame.id : undefined;
    if (response && this.drainQuarantined(response.id)) return;
    const request = response ? this.settlePending(response.id) : undefined;
    if (!this.acceptInstalledMethods(frame, id)) return;
    this.updateCurrentConfig(frame, request);
    this.recordUpstreamResult(frame, request);
    this.refreshConfigAfterMutation(frame, request);
    this.forwardProjectedFrame(frame, request);
  }

  private forwardProjectedFrame(
    frame: Record<string, unknown>,
    request: PendingRpc | undefined,
  ): void {
    if (request?.internal || this.args.browser.readyState !== WebSocket.OPEN) return;
    const projected = projectOpenClawServerFrameForProfile(
      frame,
      request?.method,
      this.activeSession.brokerProfile,
    );
    if (projected) {
      this.args.browser.send(sanitizeOpenClawControlServerFrame(projected, [this.gatewayToken]));
    }
  }

  private acceptInstalledMethods(frame: Record<string, unknown>, id: string | undefined): boolean {
    const methods = installedMethodsFromHello(frame);
    if (!methods) return true;
    const delegated = this.activeSession.brokerProfile === "delegated-config" ||
      this.activeSession.brokerProfile === "delegated-read";
    if (delegated && !pinnedOpenClawRuntimeMatches(methods)) {
      if (this.args.browser.readyState === WebSocket.OPEN) {
        this.args.browser.send(openClawControlPolicyError({ id, type: "req" }, "runtime-drift"));
      }
      this.closeBoth("runtime-drift");
      return false;
    }
    this.installedMethods = methods;
    return true;
  }

  private updateCurrentConfig(frame: Record<string, unknown>, request: PendingRpc | undefined): void {
    const snapshot = openClawConfigSnapshotFromGetResponse(frame, request?.method);
    if (snapshot) this.currentConfig = snapshot;
    if (request?.proposed && frame.ok === true) {
      this.currentConfig = { raw: request.proposed, hash: this.currentConfig?.hash ?? "" };
    }
  }

  private recordUpstreamResult(frame: Record<string, unknown>, request: PendingRpc | undefined): void {
    if (request && !request.internal) {
      this.audit("rpc_result", request.category, frame.ok === true ? "ok" : "error");
    }
  }

  private refreshConfigAfterMutation(frame: Record<string, unknown>, request: PendingRpc | undefined): void {
    if (request?.category !== "config_mutation" || frame.ok !== true) return;
    const upstream = this.upstreamSocket();
    if (upstream.readyState !== WebSocket.OPEN) return;
    const lease = this.args.limiter.acquireRequest(this.identity);
    if (!lease) return;
    const refreshId = `octogee-config-refresh-${randomUUID()}`;
    this.track(refreshId, "config.get", "read", lease, { internal: true });
    upstream.send(JSON.stringify({ type: "req", id: refreshId, method: "config.get", params: {} }));
  }

  private handleBrowserMessage(data: RawData, isBinary: boolean): void {
    const upstream = this.upstreamSocket();
    if (!this.touch() || isBinary || frameBytes(data) > MAX_WS_FRAME_BYTES || upstream.readyState !== WebSocket.OPEN) {
      this.closeBoth("invalid-dashboard-frame");
      return;
    }
    const frame = browserRpcFrame(data);
    if (!frame) {
      if (this.args.browser.readyState === WebSocket.OPEN) {
        this.args.browser.send(openClawControlPolicyError(parseFrame(data), "invalid-frame"));
      }
      return;
    }
    if (this.rejectQuarantined(frame) || this.rejectPending(frame)) return;
    if (frame.method === "connect") {
      this.forwardConnect(frame);
      return;
    }
    if (!this.installedMethods) {
      this.args.browser.send(openClawControlPolicyError(frame, "connect-state"));
      return;
    }
    this.evaluateAndForward(frame);
  }

  private rejectQuarantined(frame: BrowserRpcFrame): boolean {
    let reason: "request-id-quarantined" | "upstream-quarantined" | undefined;
    if (this.timedOut.has(frame.id)) reason = "request-id-quarantined";
    else if (this.timedOut.size > 0) reason = "upstream-quarantined";
    if (!reason) return false;
    this.args.browser.send(openClawControlPolicyError(frame, reason));
    this.audit("rpc_deny", "unknown", "denied", reason);
    this.args.metrics?.rpc(this.metricsIdentity, "unknown", "denied");
    this.args.metrics?.policy(this.metricsIdentity, reason.replaceAll("-", "_"));
    return true;
  }

  private rejectPending(frame: BrowserRpcFrame): boolean {
    if (!this.pending.has(frame.id) && !this.admittingIds.has(frame.id)) return false;
    this.args.browser.send(openClawControlPolicyError(frame, "request-id-pending"));
    return true;
  }

  private forwardConnect(frame: BrowserRpcFrame): void {
    if (this.connectForwarded || !this.nonce || this.installedMethods) {
      this.args.browser.send(openClawControlPolicyError(frame, "connect-state"));
      return;
    }
    const lease = this.args.limiter.acquireRequest(this.identity);
    if (!lease) {
      this.args.browser.send(openClawControlPolicyError(frame, "inflight-limited"));
      return;
    }
    const rewritten = rewriteTrustedOpenClawConnect({
      frame,
      nonce: this.nonce,
      gatewayToken: this.gatewayToken,
    });
    if (!rewritten) {
      lease.release();
      this.args.browser.send(openClawControlPolicyError(frame, "invalid-frame"));
      return;
    }
    this.connectForwarded = true;
    this.track(frame.id, "connect", "unknown", lease);
    this.upstreamSocket().send(rewritten);
  }

  private evaluateAndForward(frame: BrowserRpcFrame): void {
    const profile = this.activeSession.brokerProfile;
    const decision = profile === "native-owner" || profile === "native-co-owner"
      ? evaluateNativeOpenClawControlRpc(frame, { installedMethods: this.installedMethods! })
      : evaluateDelegatedOpenClawControlRpc(
        frame,
        {
          installedMethods: this.installedMethods!,
          invariantContext: invariantContext(this.args.env, this.activeSession.gatewayId),
          currentConfig: this.currentConfig,
          configFrozen: configFrozen(this.args.env),
        },
        profile,
      );
    if (!decision.allowed) {
      this.deny(frame, decision, decision.reason ?? "method-denied");
      return;
    }
    if (isOpenClawControlMutation(decision.category) && !this.args.limiter.consumeMutation(this.identity)) {
      this.deny(frame, decision, "rate-limited");
      return;
    }
    const lease = this.args.limiter.acquireRequest(this.identity);
    if (!lease) {
      this.deny(frame, decision, "inflight-limited");
      return;
    }
    void this.forwardAllowed(frame, decision, lease).catch((error) => {
      this.admittingIds.delete(frame.id);
      logger.error("OpenClaw Dashboard RPC forwarding failed", {
        gatewayId: this.activeSession.gatewayId,
        revisionId: this.activeSession.revisionId,
        category: decision.category,
        error: error instanceof Error ? error.message : String(error),
      });
      this.closeBoth("rpc-forward-failed");
    });
  }

  private deny(
    frame: BrowserRpcFrame,
    decision: OpenClawControlRpcDecision,
    reason: string,
    sendResponse = true,
  ): void {
    if (sendResponse) this.args.browser.send(openClawControlPolicyError(frame, reason));
    this.audit("rpc_deny", decision.category, "denied", reason);
    const outcome = reason === "rate-limited" || reason === "inflight-limited" ? "rate_limited" : "denied";
    this.args.metrics?.rpc(this.metricsIdentity, decision.category, outcome);
    this.args.metrics?.policy(this.metricsIdentity, reason.replaceAll("-", "_"));
  }

  private async forwardAllowed(
    frame: BrowserRpcFrame,
    decision: OpenClawControlRpcDecision,
    lease: OpenClawControlLease,
  ): Promise<void> {
    const mutationLease = await this.acquireMutationLease(frame, decision, lease);
    if (mutationLease === null) return;
    this.track(frame.id, frame.method, decision.category, lease, {
      proposed: decision.proposedConfig,
      mutationLease,
    });
    try {
      this.upstreamSocket().send(JSON.stringify(decision.outbound ?? frame));
    } catch (error) {
      this.settlePending(frame.id);
      throw error;
    }
    this.audit("rpc_allow", decision.category, "ok");
    this.args.metrics?.rpc(this.metricsIdentity, decision.category, "ok");
  }

  private async acquireMutationLease(
    frame: BrowserRpcFrame,
    decision: OpenClawControlRpcDecision,
    lease: OpenClawControlLease,
  ): Promise<SystemConfigMutationLease | undefined | null> {
    if (decision.category !== "config_mutation") return undefined;
    this.admittingIds.add(frame.id);
    let acquired;
    try {
      acquired = await acquireSystemConfigMutationLease({
        openclawDir: envValue(this.args.env, "OPENCLAW_DIR"),
      });
    } catch (error) {
      lease.release();
      throw error;
    }
    this.admittingIds.delete(frame.id);
    if (!acquired.ok) {
      lease.release();
      this.deny(frame, decision, "config-writer-busy", this.args.browser.readyState === WebSocket.OPEN);
      return null;
    }
    if (this.closing || this.args.browser.readyState !== WebSocket.OPEN ||
      this.upstreamSocket().readyState !== WebSocket.OPEN) {
      lease.release();
      await acquired.lease.release();
      return null;
    }
    return acquired.lease;
  }
}

async function bridgeControlSocket(args: BridgeControlSocketArgs): Promise<void> {
  await new OpenClawControlSocketBridge(args).start();
}

export interface AttachOpenClawControlWsRouteOptions {
  router: WsUpgradeRouter;
  env?: NodeJS.ProcessEnv;
  sessions?: OpenClawControlSessionManager;
  authorize?: typeof authorizeOpenClawControlSession;
  loadGatewayToken?: typeof fetchGatewayToken;
  audit?: typeof auditOpenClawControlRpc;
  resourceLimiter?: OpenClawControlResourceLimiter;
  rpcTimeoutMs?: number;
  authorizationIntervalMs?: number;
  metrics?: OpenClawControlMetrics;
  retainMutationLeaseUntilProcessReplacement?: (
    lease: SystemConfigMutationLease,
    reason: string,
  ) => void;
}

export function attachOpenClawControlWsRoute(options: AttachOpenClawControlWsRouteOptions): void {
  const env = options.env ?? process.env;
  const sessions = options.sessions ?? defaultSessions;
  const authorize = options.authorize ?? authorizeOpenClawControlSession;
  const loadGatewayToken = options.loadGatewayToken ?? fetchGatewayToken;
  const audit = options.audit ?? auditOpenClawControlRpc;
  const limiter = options.resourceLimiter ?? defaultLimiter;
  const rpcTimeoutMs = options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
  const authorizationIntervalMs = options.authorizationIntervalMs ?? DEFAULT_AUTHORIZATION_INTERVAL_MS;
  if (!Number.isSafeInteger(rpcTimeoutMs) || rpcTimeoutMs <= 0 ||
    !Number.isSafeInteger(authorizationIntervalMs) || authorizationIntervalMs <= 0) {
    throw new Error("OpenClaw Dashboard timeouts must be positive integers");
  }
  const gatewayId = envValue(env, "GATEWAY_ID");
  const revisionId = envValue(env, "GATEWAY_REVISION_ID");
  options.router.add({
    match: isOpenClawControlWsPath,
    extractTicket: (pathname) => {
      try {
        return openClawControlUpstreamPath(pathname, gatewayId);
      } catch {
        return null;
      }
    },
    allowedOrigins: new Set([apiOrigin(env)]),
    maxPayloadBytes: MAX_WS_FRAME_BYTES,
    authorize: async (req) => {
      const session = sessions.verify({ cookieHeader: req.headers.cookie, gatewayId, revisionId });
      const allowed = session !== null && await authorize({
        sessionId: session.sessionId,
        gatewayId,
        revisionId,
        env,
      });
      options.metrics?.session(metricIdentity(env), "authorize", allowed ? "ok" : "denied");
      return allowed;
    },
    onUpgrade: ({ ws, req, ticket }) => {
      const session = sessions.verify({ cookieHeader: req.headers.cookie, gatewayId, revisionId });
      if (!session || !ticket) {
        ws.close(1008, "dashboard-session-invalid");
        return;
      }
      const socketLease = limiter.acquireSocket({
        uid: session.uid,
        gatewayId,
        sessionId: session.sessionId,
      });
      if (!socketLease) {
        ws.close(1013, "dashboard-socket-limit");
        return;
      }
      void bridgeControlSocket({
        browser: ws,
        requestPath: ticket,
        cookieHeader: req.headers.cookie,
        session,
        sessions,
        env,
        authorize,
        loadGatewayToken,
        audit,
        limiter,
        socketLease,
        rpcTimeoutMs,
        authorizationIntervalMs,
        metrics: options.metrics,
        retainMutationLeaseUntilProcessReplacement:
          options.retainMutationLeaseUntilProcessReplacement ?? retainMutationLeaseUntilProcessReplacement,
      }).catch(() => {
        options.metrics?.ws(metricIdentity(env), "connect", "error");
        socketLease.release();
        if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) ws.terminate();
        logger.error("OpenClaw Dashboard WebSocket bridge failed", { gatewayId, revisionId });
      });
    },
  });
}
