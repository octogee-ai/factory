import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { isValidGatewayId } from "@octogee/shared/types/glm";

const MAX_BODY_BYTES = 64 * 1024;
const BODY_TIMEOUT_MS = 10_000;
const PROOF_WINDOW_MS = 30_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const UPSTREAM_TIMEOUT_MS = 10_000;

export interface AgentControlRouterProof {
  gatewayId: string;
  timestamp: string;
  signature: string;
}

function validRouterKey(key: string): boolean {
  return Buffer.byteLength(key) >= 32 && !/[\u0000-\u001f\u007f]/.test(key);
}

function bodySha256(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

function proofPayload(body: Buffer, gatewayId: string, timestamp: string): string {
  return `v1\n${gatewayId}\n${timestamp}\n${bodySha256(body)}`;
}

export function signAgentControlRouterRequest(
  body: Buffer,
  gatewayId: string,
  timestamp: string,
  key: string,
): string {
  if (!validRouterKey(key)) throw new Error("AGENT_CONTROL_ROUTER_KEY must be at least 32 bytes");
  return createHmac("sha256", key).update(proofPayload(body, gatewayId, timestamp)).digest("hex");
}

export function verifyAgentControlRouterRequest(
  body: Buffer,
  proof: AgentControlRouterProof,
  key: string,
  now: number,
): boolean {
  if (!validRouterKey(key)) return false;
  if (!isValidGatewayId(proof.gatewayId) || !/^\d+$/.test(proof.timestamp)) return false;
  const timestamp = Number(proof.timestamp);
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > PROOF_WINDOW_MS) return false;
  if (!/^[a-f0-9]{64}$/i.test(proof.signature)) return false;
  const expected = signAgentControlRouterRequest(body, proof.gatewayId, proof.timestamp, key);
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(proof.signature, "hex"));
}

type CallbackRoute =
  | { kind: "agent-control"; gatewayId: string }
  | { kind: "mattermost-interaction"; gatewayId: string; accountId: string };

function parseRoute(url: string): CallbackRoute | null {
  const path = new URL(url, "http://callback-router.local").pathname;
  const control = /^\/internal\/openclaw\/agent-control\/([^/]+)\/callback$/.exec(path);
  if (control && isValidGatewayId(control[1])) {
    return { kind: "agent-control", gatewayId: control[1] };
  }
  const interaction = /^\/internal\/openclaw\/mattermost\/([^/]+)\/mattermost\/interactions\/([^/]+)$/.exec(path);
  if (
    interaction &&
    isValidGatewayId(interaction[1]) &&
    /^[A-Za-z0-9_-]{1,128}$/.test(interaction[2])
  ) {
    return {
      kind: "mattermost-interaction",
      gatewayId: interaction[1],
      accountId: interaction[2],
    };
  }
  return null;
}

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

const HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function forwardedHeaders(
  incoming: IncomingHttpHeaders,
  body: Buffer,
  proof: AgentControlRouterProof,
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
      lower === "host" ||
      lower === "content-length" ||
      HOP_HEADERS.has(lower) ||
      connectionHeaders.has(lower) ||
      lower.startsWith("x-octogee-")
    ) continue;
    headers[name] = value;
  }
  headers["content-length"] = String(body.length);
  headers["x-octogee-agent-control-gateway"] = proof.gatewayId;
  headers["x-octogee-agent-control-timestamp"] = proof.timestamp;
  headers["x-octogee-agent-control-signature"] = proof.signature;
  return headers;
}

function responseHeaders(
  incoming: IncomingHttpHeaders,
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

function readUpstreamBody(
  upstream: IncomingMessage,
  maxBytes: number,
): Promise<Buffer> {
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

function downstreamPath(route: CallbackRoute): string {
  if (route.kind === "agent-control") {
    return `/api/g/${route.gatewayId}/internal/openclaw/agent-control/callback`;
  }
  return `/api/g/${route.gatewayId}/internal/openclaw/mattermost/interactions/${route.accountId}`;
}

function writeJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function createAgentControlCallbackRouter(input: {
  namespace: string;
  hmacKey: string;
  now?: () => number;
  targetOrigin?: (gatewayId: string) => string;
  upstreamTimeoutMs?: number;
  maxResponseBytes?: number;
  log: (message: string, meta?: Record<string, unknown>) => void;
}): http.Server {
  if (!validRouterKey(input.hmacKey)) {
    throw new Error("AGENT_CONTROL_ROUTER_KEY must be at least 32 bytes");
  }
  const now = input.now ?? Date.now;
  const targetOrigin = input.targetOrigin ?? ((gatewayId: string) =>
    `http://gateway-edge-${gatewayId}.${input.namespace}.svc.cluster.local:3001`);
  const upstreamTimeoutMs = input.upstreamTimeoutMs ?? UPSTREAM_TIMEOUT_MS;
  const maxResponseBytes = input.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(upstreamTimeoutMs) || upstreamTimeoutMs < 1) {
    throw new Error("invalid agent control upstreamTimeoutMs");
  }
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) {
    throw new Error("invalid agent control maxResponseBytes");
  }

  return http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      writeJson(res, 200, { status: "ok" });
      return;
    }
    if (req.method !== "POST") {
      req.resume();
      writeJson(res, req.method === "GET" ? 404 : 405, { error: "not_found" });
      return;
    }
    const route = parseRoute(req.url ?? "");
    if (!route) {
      req.resume();
      writeJson(res, 404, { error: "not_found" });
      return;
    }
    let body: Buffer;
    try {
      body = await readBody(req);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeJson(res, message === "body_too_large" ? 413 : 400, { error: message });
      return;
    }
    const timestamp = String(now());
    const proof = {
      gatewayId: route.gatewayId,
      timestamp,
      signature: signAgentControlRouterRequest(body, route.gatewayId, timestamp, input.hmacKey),
    };
    const origin = new URL(targetOrigin(route.gatewayId));
    let responded = false;
    const fail = (error: Error): void => {
      input.log("[agent-control-router] upstream request failed", {
        gatewayId: route.gatewayId,
        error: error.message,
      });
      if (responded) return;
      responded = true;
      writeJson(res, 502, { error: "gateway_unavailable" });
    };
    const proxy = http.request({
      protocol: origin.protocol,
      hostname: origin.hostname,
      port: origin.port,
      method: "POST",
      path: downstreamPath(route),
      headers: forwardedHeaders(req.headers, body, proof),
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
  });
}
