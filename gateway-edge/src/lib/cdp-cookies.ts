import { WebSocket } from "ws";

export interface CdpCookiePartitionKey {
  topLevelSite: string;
  hasCrossSiteAncestor: boolean;
}

type CdpCookieSourceScheme = "Unset" | "NonSecure" | "Secure";

export interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  expires?: number;
  sameSite?: "Strict" | "Lax" | "None";
  partitionKey?: CdpCookiePartitionKey;
  sourceScheme?: CdpCookieSourceScheme;
  sourcePort?: number;
}

export interface CdpCookieTransport {
  send(frame: { id: number; method: string; params?: unknown }): void;
  onMessage(handler: (frame: Record<string, unknown>) => void): void;
  close(): void;
}

export interface ApplyCookiesDeps {
  cdpUrl: string;
  fetchImpl?: typeof fetch;
  connect?: (wsUrl: string) => Promise<CdpCookieTransport>;
  timeoutMs?: number;
}

interface CdpTarget {
  type?: string;
  webSocketDebuggerUrl?: string;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]"]);

export function assertLoopbackCdp(rawUrl: string, protocols: string[], label: string): URL {
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new Error(`CDP ${label} URL is invalid`); }
  const hostname = url.hostname.replace(/^\[|\]$/gu, "");
  if (!protocols.includes(url.protocol) || !LOOPBACK_HOSTS.has(hostname)) {
    throw new Error(`CDP ${label} URL must be loopback (got ${rawUrl})`);
  }
  return url;
}

async function resolvePageTarget(cdpUrl: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<string> {
  const response = await fetchImpl(`${cdpUrl}/json/list`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`CDP target list failed with status ${response.status}`);
  const targets = (await response.json()) as CdpTarget[];
  const page = targets.find((target) => target.type === "page" && typeof target.webSocketDebuggerUrl === "string")
    ?? targets.find((target) => typeof target.webSocketDebuggerUrl === "string");
  if (!page?.webSocketDebuggerUrl) throw new Error("No CDP page target is available");
  assertLoopbackCdp(page.webSocketDebuggerUrl, ["ws:", "wss:"], "websocket");
  return page.webSocketDebuggerUrl;
}

function socketTransport(socket: WebSocket): CdpCookieTransport {
  const dispatch = (handler: (frame: Record<string, unknown>) => void, data: unknown): void => {
    try { handler(JSON.parse(String(data)) as Record<string, unknown>); } catch { /* ignore non-JSON frames */ }
  };
  return {
    send: (frame) => socket.send(JSON.stringify(frame)),
    onMessage: (handler) => socket.on("message", (data) => dispatch(handler, data)),
    close: () => socket.close(),
  };
}

function wsTransport(wsUrl: string, timeoutMs: number): Promise<CdpCookieTransport> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl, { handshakeTimeout: timeoutMs });
    const timer = setTimeout(() => { socket.close(); reject(new Error("CDP connection timed out")); }, timeoutMs);
    socket.once("open", () => { clearTimeout(timer); resolve(socketTransport(socket)); });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

export interface CdpCookieOutcome {
  stored: number;
  dropped: Array<{ name: string; domain: string }>;
}

interface StoredCookie {
  name?: unknown;
  value?: unknown;
  domain?: unknown;
  path?: unknown;
  secure?: unknown;
  httpOnly?: unknown;
  sameSite?: unknown;
  sourceScheme?: unknown;
  sourcePort?: unknown;
  partitionKey?: { topLevelSite?: unknown; hasCrossSiteAncestor?: unknown } | null;
}

function sameDomain(stored: unknown, requested: string): boolean {
  return typeof stored === "string" && stored.toLowerCase() === requested.toLowerCase();
}

function samePartition(stored: StoredCookie["partitionKey"], requested: CdpCookiePartitionKey | undefined): boolean {
  if (!requested) return !stored?.topLevelSite;
  return stored?.topLevelSite === requested.topLevelSite && stored.hasCrossSiteAncestor === requested.hasCrossSiteAncestor;
}

function sameScope(stored: StoredCookie, requested: CdpCookie): boolean {
  if (requested.sourceScheme !== undefined && stored.sourceScheme !== requested.sourceScheme) return false;
  return requested.sourcePort === undefined || stored.sourcePort === requested.sourcePort;
}

function sameSecurity(stored: StoredCookie, requested: CdpCookie): boolean {
  if (stored.secure !== requested.secure || stored.httpOnly !== requested.httpOnly) return false;
  return requested.sameSite === undefined || stored.sameSite === requested.sameSite;
}

function isStored(jar: StoredCookie[], cookie: CdpCookie): boolean {
  return jar.some((entry) => entry.name === cookie.name
    && sameDomain(entry.domain, cookie.domain)
    && entry.path === cookie.path
    && samePartition(entry.partitionKey, cookie.partitionKey)
    && sameScope(entry, cookie)
    && sameSecurity(entry, cookie)
    && entry.value === cookie.value);
}

export function compareStoredCookies(requested: CdpCookie[], jar: unknown): CdpCookieOutcome {
  const entries = Array.isArray(jar) ? (jar as StoredCookie[]) : [];
  const dropped = requested
    .filter((cookie) => !isStored(entries, cookie))
    .map((cookie) => ({ name: cookie.name, domain: cookie.domain }));
  return { stored: requested.length - dropped.length, dropped };
}

function cdpCall(transport: CdpCookieTransport, timeoutMs: number) {
  let nextId = 0;
  const pending = new Map<number, { resolve: (result: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  transport.onMessage((frame) => {
    const waiter = typeof frame.id === "number" ? pending.get(frame.id) : undefined;
    if (!waiter) return;
    pending.delete(frame.id as number);
    if (frame.error) waiter.reject(new Error(JSON.stringify(frame.error)));
    else waiter.resolve((frame.result ?? {}) as Record<string, unknown>);
  });
  return (method: string, params?: unknown): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
    nextId += 1;
    const id = nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} timed out`)); }, timeoutMs);
    pending.set(id, {
      resolve: (result) => { clearTimeout(timer); resolve(result); },
      reject: (error) => { clearTimeout(timer); reject(new Error(`CDP ${method} failed: ${error.message}`)); },
    });
    transport.send(params === undefined ? { id, method } : { id, method, params });
  });
}

export async function applyCookiesOverCdp(cookies: CdpCookie[], deps: ApplyCookiesDeps): Promise<CdpCookieOutcome> {
  if (cookies.length === 0) return { stored: 0, dropped: [] };
  assertLoopbackCdp(deps.cdpUrl, ["http:"], "endpoint");
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const connect = deps.connect ?? ((wsUrl: string) => wsTransport(wsUrl, timeoutMs));
  const wsUrl = await resolvePageTarget(deps.cdpUrl, fetchImpl, timeoutMs);
  const transport = await connect(wsUrl);
  try {
    const call = cdpCall(transport, timeoutMs);
    await call("Network.setCookies", { cookies });
    const { cookies: jar } = await call("Network.getAllCookies");
    return compareStoredCookies(cookies, jar);
  } finally {
    transport.close();
  }
}
