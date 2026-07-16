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
import { Router, type NextFunction, type Request, type Response } from "express";
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
  evaluateOpenClawControlRpc,
  installedMethodsFromHello,
  isOpenClawControlMutation,
  openClawConfigSnapshotFromGetResponse,
  openClawControlPolicyError,
  openClawControlTimeoutError,
  pinnedOpenClawRuntimeMatches,
  type OpenClawConfigSnapshot,
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
const DEFAULT_AUTHORIZATION_INTERVAL_MS = 30_000;
const CSP = "default-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self' blob:";
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
const defaultSessions = new OpenClawControlSessionManager();
const defaultLimiter = new OpenClawControlResourceLimiter();

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

export function openClawControlUpstreamPath(originalUrl: string, gatewayId: string): string {
  const rawPath = originalUrl.split("?", 1)[0] ?? "";
  if (!rawPath.startsWith("/") || rawPath.includes("\\") || rawPath.includes("..") ||
    /%(?:2e|2f|5c)/iu.test(rawPath)) {
    throw new Error("OpenClaw Dashboard request path is outside its base path");
  }
  const parsed = new URL(originalUrl, "https://octogee.invalid");
  for (const key of parsed.searchParams.keys()) {
    if (/(?:token|ticket|secret|session|auth|key)/iu.test(key)) {
      throw new Error("OpenClaw Dashboard request contains a sensitive query parameter");
    }
  }
  const publicBase = `/api/g/${gatewayId}/openclaw`;
  const strippedBase = "/openclaw";
  const inboundBase = parsed.pathname === publicBase || parsed.pathname.startsWith(`${publicBase}/`)
    ? publicBase
    : parsed.pathname === strippedBase || parsed.pathname.startsWith(`${strippedBase}/`)
      ? strippedBase
      : null;
  if (!inboundBase) throw new Error("OpenClaw Dashboard request path is outside its base path");
  const suffix = parsed.pathname.slice(inboundBase.length);
  return `/g/${gatewayId}/openclaw${suffix}${parsed.search}`;
}

function securityHeaders(res: Response | http.ServerResponse): void {
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-security-policy", CSP);
  res.setHeader("cross-origin-opener-policy", "same-origin");
  res.setHeader("cross-origin-resource-policy", "same-origin");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
}

function unauthorized(res: Response): void {
  securityHeaders(res);
  res.status(401).json({ error: "dashboard-session-invalid", relaunch: true });
}

function requestHeaders(req: Request, env: NodeJS.ProcessEnv): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (ALLOWED_REQUEST_HEADERS.has(name.toLowerCase())) headers[name] = value;
  }
  headers.host = openClawControlUpstreamBase(env).host;
  headers.origin = apiOrigin(env);
  headers["accept-encoding"] = "identity";
  return headers;
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
  const httpTimeoutMs = options.httpTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const metrics = options.metrics;
  const identity = metricIdentity(env);
  if (!Number.isSafeInteger(httpTimeoutMs) || httpTimeoutMs <= 0) {
    throw new Error("OpenClaw Dashboard HTTP timeout must be a positive integer");
  }
  const router = Router({ mergeParams: true });
  router.get("/launch/:ticket", async (req: Request, res: Response, next: NextFunction) => {
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
        unauthorized(res);
        return;
      }
      const sessionId = randomUUID();
      const redeemed = await redeem({ ticket, sessionId, gatewayId, revisionId, env });
      if (!redeemed || redeemed.gatewayId !== gatewayId || redeemed.revisionId !== revisionId) {
        metrics?.session(identity, "redeem", "denied");
        unauthorized(res);
        return;
      }
      metrics?.session(identity, "redeem", "ok");
      const issued = sessions.issue({
        sessionId,
        uid: redeemed.uid,
        gatewayId,
        revisionId,
        absoluteExpiresAt: redeemed.expiresAt,
      });
      securityHeaders(res);
      res.setHeader("set-cookie", issued.cookie);
      res.setHeader("location", `/g/${gatewayId}/openclaw/`);
      res.status(303).end();
    } catch (error) {
      next(error);
    }
  });
  router.use(async (req: Request, res: Response, next: NextFunction) => {
    const startedAt = performance.now();
    res.once("finish", () => metrics?.http(
      identity,
      "asset",
      res.statusCode < 400 ? "ok" : res.statusCode === 504 ? "timeout" : "error",
      (performance.now() - startedAt) / 1_000,
    ));
    try {
      const gatewayId = req.params.gatewayId;
      const revisionId = env.GATEWAY_REVISION_ID?.trim();
      if (gatewayId !== env.GATEWAY_ID || !revisionId) {
        unauthorized(res);
        return;
      }
      const session = sessions.verify({ cookieHeader: req.headers.cookie, gatewayId, revisionId });
      if (!session || !await authorize({ sessionId: session.sessionId, gatewayId, revisionId, env })) {
        metrics?.session(identity, "authorize", "denied");
        if (session) sessions.revoke(session.sessionId);
        unauthorized(res);
        return;
      }
      metrics?.session(identity, "authorize", "ok");
      if (req.method !== "GET" && req.method !== "HEAD") {
        securityHeaders(res);
        res.setHeader("allow", "GET, HEAD");
        res.status(405).json({ error: "method-not-allowed" });
        return;
      }
      const touched = sessions.touchSession(session);
      if (!touched) {
        unauthorized(res);
        return;
      }
      const base = openClawControlUpstreamBase(env);
      let timedOut = false;
      let settled = false;
      const proxy = http.request({
        protocol: base.protocol,
        hostname: base.hostname,
        port: base.port,
        method: req.method,
        path: openClawControlUpstreamPath(req.originalUrl, gatewayId),
        headers: requestHeaders(req, env),
      }, (upstream) => {
        settled = true;
        res.status(upstream.statusCode ?? 502);
        for (const [name, value] of Object.entries(upstream.headers)) {
          if (value !== undefined && ALLOWED_RESPONSE_HEADERS.has(name.toLowerCase())) res.setHeader(name, value);
        }
        securityHeaders(res);
        res.setHeader("set-cookie", touched.cookie);
        upstream.pipe(credentialScrubber([env.OPENCLAW_GATEWAY_TOKEN ?? ""])).pipe(res);
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
        securityHeaders(res);
        if (timedOut) res.status(504).json({ error: "openclaw-timeout", retryable: true });
        else res.status(502).json({ error: "openclaw-unavailable", retryable: true });
      });
      req.once("aborted", () => proxy.destroy());
      proxy.end();
    } catch (error) {
      next(error);
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

function auditEvent(
  audit: typeof auditOpenClawControlRpc,
  env: NodeJS.ProcessEnv,
  session: OpenClawControlSession,
  event: "rpc_allow" | "rpc_deny" | "rpc_result",
  category: OpenClawControlAuditCategory,
  outcome: "ok" | "denied" | "error",
  reason?: string,
): void {
  void audit({
    gatewayId: session.gatewayId,
    revisionId: session.revisionId,
    sessionId: session.sessionId,
    event,
    category,
    outcome,
    reason: canonicalReason(reason),
    env,
  }).catch(() => {
    logger.warn("OpenClaw Dashboard RPC audit failed", {
      gatewayId: session.gatewayId,
      revisionId: session.revisionId,
      event,
      category,
    });
  });
}

async function bridgeControlSocket(args: {
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
}): Promise<void> {
  const identity: OpenClawControlResourceIdentity = {
    uid: args.session.uid,
    gatewayId: args.session.gatewayId,
    sessionId: args.session.sessionId,
  };
  const gatewayToken = await args.loadGatewayToken({ gatewayId: args.session.gatewayId });
  if (args.browser.readyState !== WebSocket.OPEN) {
    args.socketLease.release();
    return;
  }
  const base = openClawControlUpstreamBase(args.env);
  const upstreamUrl = new URL(args.requestPath, base);
  upstreamUrl.protocol = "ws:";
  const upstream = new WebSocket(upstreamUrl, {
    maxPayload: MAX_WS_FRAME_BYTES,
    origin: apiOrigin(args.env),
  });
  let nonce: string | null = null;
  let connectForwarded = false;
  let installedMethods: Set<string> | undefined;
  let currentConfig: OpenClawConfigSnapshot | undefined;
  let activeSession = args.session;
  const pending = new Map<string, PendingRpc>();
  const admittingIds = new Set<string>();
  const timedOutIds = new Set<string>();
  let quarantineTimer: NodeJS.Timeout | undefined;
  let closing = false;
  let socketReleased = false;
  const metricsIdentity = metricIdentity(args.env);
  args.metrics?.ws(metricsIdentity, "open", "ok");

  const touch = (): boolean => {
    const touched = args.sessions.touchSession(activeSession);
    if (!touched) return false;
    activeSession = touched.session;
    return true;
  };
  const releasePending = (id: string): PendingRpc | undefined => {
    const item = pending.get(id);
    if (!item) return undefined;
    pending.delete(id);
    clearTimeout(item.timer);
    item.lease.release();
    void item.mutationLease?.release().catch((error) => {
      logger.error("OpenClaw Dashboard config mutation lease release failed", {
        gatewayId: activeSession.gatewayId,
        revisionId: activeSession.revisionId,
        error: error instanceof Error ? error.message : String(error),
      });
      closeBoth("config-lease-release-failed");
    });
    return item;
  };
  const closeBoth = (reason = "dashboard-session-invalid"): void => {
    if (closing) return;
    closing = true;
    clearInterval(authorizationTimer);
    if (quarantineTimer) clearTimeout(quarantineTimer);
    timedOutIds.clear();
    admittingIds.clear();
    for (const id of [...pending.keys()]) releasePending(id);
    if (!socketReleased) {
      socketReleased = true;
      args.socketLease.release();
    }
    if (args.browser.readyState === WebSocket.CONNECTING || args.browser.readyState === WebSocket.OPEN) {
      args.browser.terminate();
    }
    if (upstream.readyState === WebSocket.CONNECTING || upstream.readyState === WebSocket.OPEN) upstream.terminate();
    logger.debug("OpenClaw Dashboard socket closed", {
      gatewayId: activeSession.gatewayId,
      revisionId: activeSession.revisionId,
      reason,
    });
    args.metrics?.ws(metricsIdentity, "close", reason);
  };
  const authorizationTimer = setInterval(() => {
    const local = args.sessions.verify({
      cookieHeader: args.cookieHeader,
      gatewayId: activeSession.gatewayId,
      revisionId: activeSession.revisionId,
    });
    if (!local) {
      closeBoth("session-expired");
      return;
    }
    void args.authorize({
      sessionId: activeSession.sessionId,
      gatewayId: activeSession.gatewayId,
      revisionId: activeSession.revisionId,
      env: args.env,
    }).then((allowed) => {
      args.metrics?.session(metricsIdentity, "authorize", allowed ? "ok" : "denied");
      if (!allowed) {
        args.sessions.revoke(activeSession.sessionId);
        closeBoth("capability-revoked");
      }
    }).catch(() => closeBoth("capability-unavailable"));
  }, args.authorizationIntervalMs);
  authorizationTimer.unref?.();

  const quarantine = (id: string): void => {
    timedOutIds.add(id);
    if (quarantineTimer) return;
    quarantineTimer = setTimeout(() => closeBoth("request-timeout"), args.rpcTimeoutMs);
    quarantineTimer.unref?.();
  };

  const drainQuarantined = (id: string): boolean => {
    if (!timedOutIds.delete(id)) return false;
    if (timedOutIds.size === 0 && quarantineTimer) {
      clearTimeout(quarantineTimer);
      quarantineTimer = undefined;
    }
    return true;
  };

  const track = (
    id: string,
    method: string,
    category: OpenClawControlRpcCategory,
    lease: OpenClawControlLease,
    options: {
      internal?: boolean;
      proposed?: Record<string, unknown>;
      mutationLease?: SystemConfigMutationLease;
    } = {},
  ): void => {
    const pendingRpc = {} as PendingRpc;
    const timer = setTimeout(() => {
      if (pending.get(id) !== pendingRpc) return;
      releasePending(id);
      if (pendingRpc.internal) {
        closeBoth("request-timeout");
        return;
      }
      quarantine(id);
      if (args.browser.readyState === WebSocket.OPEN) {
        args.browser.send(openClawControlTimeoutError({ type: "req", id, method, params: {} }));
        auditEvent(args.audit, args.env, activeSession, "rpc_result", category, "error", "request-timeout");
        args.metrics?.rpc(metricsIdentity, category, "timeout");
      }
    }, args.rpcTimeoutMs);
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
    pending.set(id, pendingRpc);
  };

  upstream.on("message", (data) => {
    const frame = parseFrame(data);
    if (!frame) {
      closeBoth("protocol-invalid");
      return;
    }
    nonce = challengeNonce(frame) ?? nonce;
    const id = typeof frame.id === "string" ? frame.id : undefined;
    if (frame.type === "res" && id && drainQuarantined(id)) return;
    const request = id ? releasePending(id) : undefined;
    const methods = installedMethodsFromHello(frame);
    if (methods) {
      if (!pinnedOpenClawRuntimeMatches(methods)) {
        if (args.browser.readyState === WebSocket.OPEN) {
          args.browser.send(openClawControlPolicyError({ id, type: "req" }, "runtime-drift"));
        }
        closeBoth("runtime-drift");
        return;
      }
      installedMethods = methods;
    }
    const snapshot = openClawConfigSnapshotFromGetResponse(frame, request?.method);
    if (snapshot) currentConfig = snapshot;
    if (request?.proposed && frame.ok === true) currentConfig = { raw: request.proposed, hash: currentConfig?.hash ?? "" };
    if (request && !request.internal) {
      auditEvent(
        args.audit,
        args.env,
        activeSession,
        "rpc_result",
        request.category,
        frame.ok === true ? "ok" : "error",
      );
    }
    if (request?.category === "config_mutation" && frame.ok === true && upstream.readyState === WebSocket.OPEN) {
      const lease = args.limiter.acquireRequest(identity);
      if (lease) {
        const refreshId = `octogee-config-refresh-${randomUUID()}`;
        track(refreshId, "config.get", "read", lease, { internal: true });
        upstream.send(JSON.stringify({ type: "req", id: refreshId, method: "config.get", params: {} }));
      }
    }
    if (!request?.internal && args.browser.readyState === WebSocket.OPEN) {
      args.browser.send(sanitizeOpenClawControlServerFrame(frame, [gatewayToken]));
    }
  });
  upstream.once("close", () => closeBoth("upstream-closed"));
  upstream.once("error", () => closeBoth("upstream-unavailable"));
  args.browser.once("close", () => closeBoth("browser-closed"));
  args.browser.once("error", () => closeBoth("browser-error"));
  args.browser.on("message", (data, isBinary) => {
    if (!touch() || isBinary || frameBytes(data) > MAX_WS_FRAME_BYTES || upstream.readyState !== WebSocket.OPEN) {
      closeBoth("invalid-dashboard-frame");
      return;
    }
    const frame = parseFrame(data);
    if (!frame || typeof frame.id !== "string" || typeof frame.method !== "string" ||
      !frame.params || typeof frame.params !== "object" || Array.isArray(frame.params)) {
      if (args.browser.readyState === WebSocket.OPEN) args.browser.send(openClawControlPolicyError(frame, "invalid-frame"));
      return;
    }
    if (timedOutIds.has(frame.id)) {
      args.browser.send(openClawControlPolicyError(frame, "request-id-quarantined"));
      auditEvent(args.audit, args.env, activeSession, "rpc_deny", "unknown", "denied", "request-id-quarantined");
      args.metrics?.rpc(metricsIdentity, "unknown", "denied");
      args.metrics?.policy(metricsIdentity, "request_id_quarantined");
      return;
    }
    if (timedOutIds.size > 0) {
      args.browser.send(openClawControlPolicyError(frame, "upstream-quarantined"));
      auditEvent(args.audit, args.env, activeSession, "rpc_deny", "unknown", "denied", "upstream-quarantined");
      args.metrics?.rpc(metricsIdentity, "unknown", "denied");
      args.metrics?.policy(metricsIdentity, "upstream_quarantined");
      return;
    }
    if (pending.has(frame.id) || admittingIds.has(frame.id)) {
      args.browser.send(openClawControlPolicyError(frame, "request-id-pending"));
      return;
    }
    if (frame.method === "connect") {
      if (connectForwarded || !nonce || installedMethods) {
        args.browser.send(openClawControlPolicyError(frame, "connect-state"));
        return;
      }
      const lease = args.limiter.acquireRequest(identity);
      if (!lease) {
        args.browser.send(openClawControlPolicyError(frame, "inflight-limited"));
        return;
      }
      const rewritten = rewriteTrustedOpenClawConnect({ frame, nonce, gatewayToken });
      if (!rewritten) {
        lease.release();
        args.browser.send(openClawControlPolicyError(frame, "invalid-frame"));
        return;
      }
      connectForwarded = true;
      track(frame.id, "connect", "unknown", lease);
      upstream.send(rewritten);
      return;
    }
    if (!installedMethods) {
      args.browser.send(openClawControlPolicyError(frame, "connect-state"));
      return;
    }
    const decision = evaluateOpenClawControlRpc(frame, {
      installedMethods,
      invariantContext: invariantContext(args.env, activeSession.gatewayId),
      currentConfig,
      configFrozen: configFrozen(args.env),
    });
    if (!decision.allowed) {
      args.browser.send(openClawControlPolicyError(frame, decision.reason ?? "method-denied"));
      auditEvent(args.audit, args.env, activeSession, "rpc_deny", decision.category, "denied", decision.reason);
      args.metrics?.rpc(metricsIdentity, decision.category, "denied");
      args.metrics?.policy(metricsIdentity, (decision.reason ?? "method-denied").replaceAll("-", "_"));
      return;
    }
    if (isOpenClawControlMutation(decision.category) && !args.limiter.consumeMutation(identity)) {
      args.browser.send(openClawControlPolicyError(frame, "rate-limited"));
      auditEvent(args.audit, args.env, activeSession, "rpc_deny", decision.category, "denied", "rate-limited");
      args.metrics?.rpc(metricsIdentity, decision.category, "rate_limited");
      args.metrics?.policy(metricsIdentity, "rate_limited");
      return;
    }
    const lease = args.limiter.acquireRequest(identity);
    if (!lease) {
      args.browser.send(openClawControlPolicyError(frame, "inflight-limited"));
      auditEvent(args.audit, args.env, activeSession, "rpc_deny", decision.category, "denied", "inflight-limited");
      args.metrics?.rpc(metricsIdentity, decision.category, "rate_limited");
      args.metrics?.policy(metricsIdentity, "inflight_limited");
      return;
    }
    const requestId = frame.id;
    const requestMethod = frame.method;
    const forward = async (): Promise<void> => {
      let mutationLease: SystemConfigMutationLease | undefined;
      if (decision.category === "config_mutation") {
        admittingIds.add(requestId);
        let acquired;
        try {
          acquired = await acquireSystemConfigMutationLease({
            openclawDir: envValue(args.env, "OPENCLAW_DIR"),
          });
        } catch (error) {
          lease.release();
          throw error;
        }
        admittingIds.delete(requestId);
        if (!acquired.ok) {
          lease.release();
          const reason = acquired.code === "config-frozen" ? "config-frozen" : "config-writer-busy";
          if (args.browser.readyState === WebSocket.OPEN) {
            args.browser.send(openClawControlPolicyError(frame, reason));
          }
          auditEvent(args.audit, args.env, activeSession, "rpc_deny", decision.category, "denied", reason);
          args.metrics?.rpc(metricsIdentity, decision.category, "denied");
          args.metrics?.policy(metricsIdentity, reason.replaceAll("-", "_"));
          return;
        }
        mutationLease = acquired.lease;
        if (closing || args.browser.readyState !== WebSocket.OPEN || upstream.readyState !== WebSocket.OPEN) {
          lease.release();
          await mutationLease.release();
          return;
        }
      }
      track(requestId, requestMethod, decision.category, lease, {
        proposed: decision.proposedConfig,
        mutationLease,
      });
      try {
        upstream.send(JSON.stringify(decision.outbound ?? frame));
      } catch (error) {
        releasePending(requestId);
        throw error;
      }
      auditEvent(args.audit, args.env, activeSession, "rpc_allow", decision.category, "ok");
      args.metrics?.rpc(metricsIdentity, decision.category, "ok");
    };
    void forward().catch((error) => {
      admittingIds.delete(requestId);
      logger.error("OpenClaw Dashboard RPC forwarding failed", {
        gatewayId: activeSession.gatewayId,
        revisionId: activeSession.revisionId,
        category: decision.category,
        error: error instanceof Error ? error.message : String(error),
      });
      closeBoth("rpc-forward-failed");
    });
  });
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
      }).catch(() => {
        options.metrics?.ws(metricIdentity(env), "connect", "error");
        socketLease.release();
        if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) ws.terminate();
        logger.error("OpenClaw Dashboard WebSocket bridge failed", { gatewayId, revisionId });
      });
    },
  });
}
