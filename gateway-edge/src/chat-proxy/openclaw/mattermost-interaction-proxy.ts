import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { verifyAgentControlRouterRequest } from "../../agent-control-callback-router.js";
import { containsAsciiControlCharacter } from "../../lib/text-validation.js";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const BODY_TIMEOUT_MS = 10_000;
const UPSTREAM_TIMEOUT_MS = 10_000;
const LOOPBACK_PROTOCOL = "http:";
const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_LOOPBACK_ORIGIN = `${LOOPBACK_PROTOCOL}${LOOPBACK_HOST}:18789`;
const HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
]);

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const timeout = setTimeout(() => {
      req.destroy();
      reject(new Error("body_read_timeout"));
    }, BODY_TIMEOUT_MS);
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        clearTimeout(timeout);
        req.destroy();
        reject(new Error("body_too_large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      clearTimeout(timeout);
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function readUpstreamBody(upstream: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    upstream.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        upstream.destroy(new Error("upstream_response_too_large"));
        reject(new Error("upstream_response_too_large"));
        return;
      }
      chunks.push(chunk);
    });
    upstream.on("end", () => resolve(Buffer.concat(chunks)));
    upstream.on("error", reject);
  });
}

function responseHeaders(
  incoming: http.IncomingHttpHeaders,
  bodyLength: number,
): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  const connectionHeaders = new Set(
    (typeof incoming.connection === "string" ? incoming.connection : "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  for (const [name, value] of Object.entries(incoming)) {
    const lower = name.toLowerCase();
    if (
      lower === "content-length" ||
      HOP_HEADERS.has(lower) ||
      connectionHeaders.has(lower)
    ) continue;
    headers[name] = value;
  }
  headers["content-length"] = String(bodyLength);
  return headers;
}

function header(req: IncomingMessage, name: string): string {
  const value = req.headers[name];
  return typeof value === "string" ? value : "";
}

function originFormPath(url: string): string | null {
  if (!url.startsWith("/")) return null;
  const queryStart = url.indexOf("?");
  return queryStart === -1 ? url : url.slice(0, queryStart);
}

function writeJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function createMattermostInteractionProxyHandler(input: {
  gatewayId: string;
  routerKey: string;
  targetOrigin?: string;
  upstreamTimeoutMs?: number;
  maxResponseBytes?: number;
  now?: () => number;
  log: (message: string, meta?: Record<string, unknown>) => void;
}): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  if (Buffer.byteLength(input.routerKey) < 32 || containsAsciiControlCharacter(input.routerKey)) {
    throw new Error("AGENT_CONTROL_ROUTER_KEY must be at least 32 bytes");
  }
  const now = input.now ?? Date.now;
  const target = new URL(input.targetOrigin ?? DEFAULT_LOOPBACK_ORIGIN);
  if (
    target.protocol !== LOOPBACK_PROTOCOL ||
    target.hostname !== LOOPBACK_HOST ||
    target.username ||
    target.password ||
    target.pathname !== "/" ||
    target.search ||
    target.hash
  ) {
    throw new Error("invalid Mattermost interaction targetOrigin");
  }
  const upstreamTimeoutMs = input.upstreamTimeoutMs ?? UPSTREAM_TIMEOUT_MS;
  const maxResponseBytes = input.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(upstreamTimeoutMs) || upstreamTimeoutMs < 1) {
    throw new Error("invalid Mattermost interaction upstreamTimeoutMs");
  }
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) {
    throw new Error("invalid Mattermost interaction maxResponseBytes");
  }
  return async (req, res) => {
    if (req.method !== "POST") {
      req.resume();
      writeJson(res, 405, { error: "method_not_allowed" });
      return;
    }
    const path = originFormPath(req.url ?? "");
    const match = path && /^\/internal\/openclaw\/mattermost\/interactions\/([A-Za-z0-9_-]{1,128})$/.exec(path);
    if (!match) {
      req.resume();
      writeJson(res, 404, { error: "not_found" });
      return;
    }
    let body: Buffer;
    try {
      body = await readBody(req);
    } catch (error) {
      writeJson(res, error instanceof Error && error.message === "body_too_large" ? 413 : 400, {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const proof = {
      gatewayId: header(req, "x-octogee-agent-control-gateway"),
      timestamp: header(req, "x-octogee-agent-control-timestamp"),
      signature: header(req, "x-octogee-agent-control-signature"),
    };
    if (
      proof.gatewayId !== input.gatewayId ||
      !verifyAgentControlRouterRequest(body, proof, input.routerKey, now())
    ) {
      writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    const headers: http.OutgoingHttpHeaders = {
      "content-type": header(req, "content-type") || "application/json",
      "content-length": String(body.length),
    };
    let responded = false;
    const fail = (error: Error): void => {
      input.log("[mattermost-interaction-proxy] OpenClaw request failed", {
        accountId: match[1],
        error: error.message,
      });
      if (responded) return;
      responded = true;
      writeJson(res, 502, { error: "openclaw_unavailable" });
    };
    const proxy = http.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: "POST",
      path: `/mattermost/interactions/${match[1]}`,
      headers,
    }, async (upstream) => {
      try {
        const upstreamBody = await readUpstreamBody(upstream, maxResponseBytes);
        if (responded) return;
        responded = true;
        res.writeHead(
          upstream.statusCode ?? 502,
          responseHeaders(upstream.headers, upstreamBody.length),
        );
        res.end(upstreamBody);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    proxy.setTimeout(upstreamTimeoutMs, () => proxy.destroy(new Error("upstream_timeout")));
    proxy.on("error", fail);
    proxy.end(body);
  };
}
