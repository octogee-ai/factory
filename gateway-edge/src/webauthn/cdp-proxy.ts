import { WebSocket } from "ws";
import { isWebAuthnRequest, WEBAUTHN_MAX_PAYLOAD_BYTES, WEBAUTHN_RP_ID_MAX_LENGTH, webAuthnFailure, type WebAuthnKind, type WebAuthnRequest, type WebAuthnResponse } from "./protocol.js";
import { WEBAUTHN_BINDING_NAME, webAuthnDeliverName, webAuthnPageScriptSource } from "./page-script.js";

export interface CdpSocket {
  send(text: string): void;
  onMessage(handler: (text: string) => void): void;
  onClose(handler: () => void): void;
  close(): void;
}

export interface WebAuthnCdpProxyOptions {
  cdpUrl: string;
  handle(request: WebAuthnRequest, signal: AbortSignal): Promise<WebAuthnResponse>;
  platformAvailable?: () => boolean;
  bindingName?: string;
  fetchImpl?: typeof fetch;
  connect?: (wsUrl: string) => Promise<CdpSocket>;
  connectTimeoutMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

export interface WebAuthnCdpProxy {
  start(): void;
  stop(): void;
  connected(): boolean;
}

interface CdpEvent {
  id?: number;
  sessionId?: string;
  method?: string;
  params?: Record<string, unknown>;
  error?: { code?: number; message?: string };
}

interface BindingPayload { seq: number; kind: WebAuthnKind; mediation?: string; options: Record<string, unknown> }

const INJECTED_TARGET_TYPES = new Set(["page", "iframe", "webview", "background_page", "app"]);
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/iu;
const DELIVER_FUNCTION = "function(name, seq, response) { const deliver = globalThis[name]; if (typeof deliver === 'function') deliver(seq, response); }";

function cdpSocketFor(socket: WebSocket): CdpSocket {
  return {
    send: (text) => socket.send(text),
    onMessage: (handler) => socket.on("message", (data) => handler(String(data))),
    onClose: (handler) => { socket.once("close", handler); socket.once("error", handler); },
    close: () => socket.close(),
  };
}

export function wsCdpSocket(wsUrl: string, timeoutMs: number): Promise<CdpSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl, { handshakeTimeout: timeoutMs, maxPayload: 16 * 1024 * 1024 });
    const timer = setTimeout(() => { socket.terminate(); reject(new Error("CDP connection timed out")); }, timeoutMs);
    socket.once("open", () => {
      clearTimeout(timer);
      resolve(cdpSocketFor(socket));
    });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

interface PageContext { origin: string; frameId: string | null }

const POLICY_FEATURE: Record<WebAuthnKind, string> = { get: "publickey-credentials-get", create: "publickey-credentials-create" };
const COMMAND_TIMEOUT_MS = 5_000;

function policyAllows(result: Record<string, unknown>, feature: string): boolean {
  const states = result.states;
  return Array.isArray(states) && states.some((state) => (state as { feature?: unknown })?.feature === feature && (state as { allowed?: unknown }).allowed === true);
}

type CdpCommand = { sessionId?: string; method: string; params?: Record<string, unknown> };

function createCommandChannel(send: (frame: CdpCommand) => number | null) {
  const pending = new Map<number, { resolve(result: Record<string, unknown>): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  return {
    call(frame: CdpCommand): Promise<Record<string, unknown>> {
      const id = send(frame);
      if (id === null) return Promise.reject(new Error("the computer's Chromium is not attached"));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error("CDP command timed out")); }, COMMAND_TIMEOUT_MS);
        timer.unref();
        pending.set(id, { resolve, reject, timer });
      });
    },
    settle(event: CdpEvent): boolean {
      const waiting = typeof event.id === "number" ? pending.get(event.id) : undefined;
      if (!waiting) return false;
      pending.delete(event.id as number);
      clearTimeout(waiting.timer);
      if (event.error) waiting.reject(new Error(event.error.message ?? "CDP command failed"));
      else waiting.resolve((event as { result?: Record<string, unknown> }).result ?? {});
      return true;
    },
    failAll(reason: string): void {
      for (const waiting of pending.values()) { clearTimeout(waiting.timer); waiting.reject(new Error(reason)); }
      pending.clear();
    },
  };
}

const FRAME_NOT_ALLOWED = "This frame is not allowed to use passkeys.";
const EMBEDDED_NOT_SUPPORTED = "Passkeys in embedded cross-origin frames are not supported on this computer.";

function frameOrigins(node: unknown, frameId: string): unknown[] | null {
  if (!node || typeof node !== "object") return null;
  const { frame, childFrames } = node as { frame?: { id?: unknown; securityOrigin?: unknown }; childFrames?: unknown };
  if (frame?.id === frameId) return [frame.securityOrigin];
  if (!Array.isArray(childFrames)) return null;
  for (const child of childFrames) {
    const below = frameOrigins(child, frameId);
    if (below) return [frame?.securityOrigin, ...below];
  }
  return null;
}

async function frameRefusal(
  call: (frame: CdpCommand) => Promise<Record<string, unknown>>,
  log: (message: string, meta?: Record<string, unknown>) => void,
  sessionId: string,
  context: PageContext,
  kind: WebAuthnKind,
): Promise<string | null> {
  const { frameId, origin } = context;
  if (!frameId) return FRAME_NOT_ALLOWED;
  try {
    if (!policyAllows(await call({ sessionId, method: "Page.getPermissionsPolicyState", params: { frameId } }), POLICY_FEATURE[kind])) return FRAME_NOT_ALLOWED;
    const origins = frameOrigins((await call({ sessionId, method: "Page.getFrameTree" })).frameTree, frameId);
    return origins !== null && origins.every((ancestor) => ancestor === origin) ? null : EMBEDDED_NOT_SUPPORTED;
  } catch (error) {
    log("webauthn frame check failed; refusing the request", { sessionId, frameId, error: error instanceof Error ? error.message : String(error) });
    return FRAME_NOT_ALLOWED;
  }
}

type BindingMessage = { type: "cancel"; seq: number } | { type: "query"; seq: number } | { type: "request"; payload: BindingPayload };

function classifyBinding(raw: unknown): BindingMessage | null {
  if (typeof raw !== "string") return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  const control = value as Record<string, unknown> | null;
  if (control && typeof control === "object" && Number.isInteger(control.seq)) {
    if (control.cancel === true) return { type: "cancel", seq: control.seq as number };
    if (control.query === "platform") return { type: "query", seq: control.seq as number };
  }
  const payload = parseBindingPayload(raw);
  return payload ? { type: "request", payload } : null;
}

function parseBindingPayload(raw: unknown): BindingPayload | null {
  if (typeof raw !== "string") return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  if (!Number.isInteger(payload.seq) || (payload.kind !== "get" && payload.kind !== "create")) return null;
  if (!payload.options || typeof payload.options !== "object" || Array.isArray(payload.options)) return null;
  if (payload.mediation !== undefined && typeof payload.mediation !== "string") return null;
  return { seq: payload.seq as number, kind: payload.kind, mediation: payload.mediation as string | undefined, options: payload.options as Record<string, unknown> };
}

function requestedRpId(payload: BindingPayload, origin: URL): unknown {
  if (payload.kind === "get") return payload.options.rpId ?? origin.hostname;
  const rp = payload.options.rp;
  const id = rp && typeof rp === "object" ? (rp as Record<string, unknown>).id : undefined;
  return id ?? origin.hostname;
}

export function buildWebAuthnRequest(origin: string, payload: BindingPayload): WebAuthnRequest | WebAuthnResponse {
  let url: URL;
  try { url = new URL(origin); } catch { return webAuthnFailure("NotAllowedError", "Passkeys need a secure (https) page."); }
  if (url.protocol !== "https:") return webAuthnFailure("NotAllowedError", "Passkeys need a secure (https) page.");
  const rpId = requestedRpId(payload, url);
  if (typeof rpId !== "string" || rpId.length > WEBAUTHN_RP_ID_MAX_LENGTH || !HOSTNAME.test(rpId)) return webAuthnFailure("SecurityError", "The relying party ID is not a valid domain.");
  const options = payload.mediation === undefined ? payload.options : { ...payload.options, mediation: payload.mediation };
  const request: WebAuthnRequest = { origin: url.origin, rpId: rpId.toLowerCase(), kind: payload.kind, options };
  if (!isWebAuthnRequest(request)) return webAuthnFailure("NotAllowedError", "The passkey request is malformed.");
  if (Buffer.byteLength(JSON.stringify(request)) > WEBAUTHN_MAX_PAYLOAD_BYTES) return webAuthnFailure("NotAllowedError", "The passkey request is too large to relay.");
  return request;
}

export function createWebAuthnCdpProxy(options: WebAuthnCdpProxyOptions): WebAuthnCdpProxy {
  const log = options.log ?? (() => {});
  const fetchImpl = options.fetchImpl ?? fetch;
  const connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
  const connect = options.connect ?? ((wsUrl: string) => wsCdpSocket(wsUrl, connectTimeoutMs));
  const setTimer = options.setTimer ?? ((callback, delayMs) => { const timer = setTimeout(callback, delayMs); timer.unref(); return timer; });
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  const retryBaseMs = options.retryBaseMs ?? 2_000;
  const retryMaxMs = options.retryMaxMs ?? 30_000;
  const bindingName = options.bindingName ?? WEBAUTHN_BINDING_NAME;
  const deliverName = webAuthnDeliverName(bindingName);
  const source = webAuthnPageScriptSource(bindingName);

  let running = false;
  let attempt = 0;
  let socket: CdpSocket | null = null;
  let retryTimer: unknown = null;
  let nextId = 0;
  let lastFailure: string | null = null;
  const contexts = new Map<string, Map<number, PageContext>>();
  const embeddedSessions = new Set<string>();
  const send = (frame: CdpCommand): number | null => {
    if (!socket) return null;
    nextId += 1;
    socket.send(JSON.stringify({ id: nextId, ...frame }));
    return nextId;
  };
  const commands = createCommandChannel(send);

  const scheduleRetry = (reason: string, meta: Record<string, unknown>) => {
    if (!running) return;
    if (lastFailure !== reason) { lastFailure = reason; log(reason, meta); }
    attempt += 1;
    const delay = Math.min(retryMaxMs, retryBaseMs * 2 ** Math.min(attempt - 1, 10));
    retryTimer = setTimer(() => { retryTimer = null; void attach(); }, delay);
  };

  const deliver = (sessionId: string, contextId: number, seq: number, response: WebAuthnResponse | { available: boolean }) => {
    send({ sessionId, method: "Runtime.callFunctionOn", params: { functionDeclaration: DELIVER_FUNCTION, executionContextId: contextId, arguments: [{ value: deliverName }, { value: seq }, { value: response }], returnByValue: true } });
  };

  const inFlight = new Map<string, AbortController>();
  const flightKey = (sessionId: string, contextId: number, seq: number) => `${sessionId}:${contextId}:${seq}`;
  const abortFlights = (prefix = "") => {
    for (const [key, controller] of inFlight) {
      if (key.startsWith(prefix)) { controller.abort(); inFlight.delete(key); }
    }
  };

  const relay = async (sessionId: string, contextId: number, context: PageContext, payload: BindingPayload) => {
    const built = buildWebAuthnRequest(context.origin, payload);
    if ("ok" in built) { deliver(sessionId, contextId, payload.seq, built); return; }
    const key = flightKey(sessionId, contextId, payload.seq);
    const controller = new AbortController();
    inFlight.set(key, controller);
    let response: WebAuthnResponse;
    try {
      const refusal = embeddedSessions.has(sessionId) ? EMBEDDED_NOT_SUPPORTED : await frameRefusal(commands.call, log, sessionId, context, payload.kind);
      if (controller.signal.aborted) return;
      response = refusal === null
        ? await options.handle(built, controller.signal)
        : webAuthnFailure("NotAllowedError", refusal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log("webauthn relay failed", { origin: built.origin, rpId: built.rpId, kind: built.kind, error: message });
      response = webAuthnFailure("NotAllowedError", `The passkey request could not reach your desktop (${message}).`);
    } finally {
      if (inFlight.get(key) === controller) inFlight.delete(key);
    }
    if (!controller.signal.aborted) deliver(sessionId, contextId, payload.seq, response);
  };

  const onBindingCalled = async (sessionId: string, params: Record<string, unknown>) => {
    if (params.name !== bindingName) return;
    const contextId = params.executionContextId;
    const message = classifyBinding(params.payload);
    if (!message || typeof contextId !== "number") { log("webauthn binding payload rejected", { sessionId, contextId }); return; }
    if (message.type === "cancel") { inFlight.get(flightKey(sessionId, contextId, message.seq))?.abort(); return; }
    if (message.type === "query") { deliver(sessionId, contextId, message.seq, { available: options.platformAvailable?.() ?? false }); return; }
    const context = contexts.get(sessionId)?.get(contextId);
    if (context === undefined) { log("webauthn binding called from an unknown context", { sessionId, contextId }); return; }
    await relay(sessionId, contextId, context, message.payload);
  };

  const onAttached = (params: Record<string, unknown>) => {
    const sessionId = params.sessionId;
    const info = params.targetInfo as { type?: string } | undefined;
    if (typeof sessionId !== "string") return;
    if (info?.type && INJECTED_TARGET_TYPES.has(info.type)) {
      contexts.set(sessionId, new Map());
      if (info.type === "iframe") embeddedSessions.add(sessionId);
      send({ sessionId, method: "Runtime.enable" });
      send({ sessionId, method: "Runtime.addBinding", params: { name: bindingName } });
      send({ sessionId, method: "Page.addScriptToEvaluateOnNewDocument", params: { source, runImmediately: true } });
      send({ sessionId, method: "Target.setAutoAttach", params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true } });
    }
    if (params.waitingForDebugger) send({ sessionId, method: "Runtime.runIfWaitingForDebugger" });
  };

  const onSessionEvent = (sessionId: string, sessionContexts: Map<number, PageContext>, method: string | undefined, params: Record<string, unknown>) => {
    switch (method) {
      case "Runtime.executionContextCreated": {
        const context = params.context as { id?: number; origin?: string; auxData?: { isDefault?: boolean; frameId?: unknown } } | undefined;
        if (!context || typeof context.id !== "number" || context.auxData?.isDefault === false) return;
        sessionContexts.set(context.id, { origin: typeof context.origin === "string" ? context.origin : "", frameId: typeof context.auxData?.frameId === "string" ? context.auxData.frameId : null });
        send({ sessionId, method: "Runtime.evaluate", params: { expression: source, contextId: context.id, returnByValue: true } });
        return;
      }
      case "Runtime.executionContextDestroyed":
        if (typeof params.executionContextId === "number") {
          sessionContexts.delete(params.executionContextId);
          abortFlights(`${sessionId}:${params.executionContextId}:`);
        }
        return;
      case "Runtime.executionContextsCleared":
        sessionContexts.clear();
        abortFlights(`${sessionId}:`);
        return;
      case "Runtime.bindingCalled":
        void onBindingCalled(sessionId, params);
        return;
      default:
        return;
    }
  };

  const onEvent = (event: CdpEvent) => {
    const { method, params = {}, sessionId } = event;
    if (method === "Target.attachedToTarget") { onAttached(params); return; }
    if (method === "Target.detachedFromTarget") {
      if (typeof params.sessionId === "string") {
        contexts.delete(params.sessionId);
        embeddedSessions.delete(params.sessionId);
        abortFlights(`${params.sessionId}:`);
      }
      return;
    }
    const sessionContexts = sessionId ? contexts.get(sessionId) : undefined;
    if (sessionId && sessionContexts) onSessionEvent(sessionId, sessionContexts, method, params);
  };

  const onMessage = (text: string) => {
    let event: CdpEvent;
    try { event = JSON.parse(text) as CdpEvent; } catch { return; }
    if (event.method) { onEvent(event); return; }
    if (commands.settle(event)) return;
    if (event.error) log("webauthn proxy CDP command failed", { id: event.id, error: event.error.message });
  };

  const attach = async () => {
    if (!running || socket) return;
    let wsUrl: string;
    try {
      const response = await fetchImpl(`${options.cdpUrl}/json/version`, { signal: AbortSignal.timeout(connectTimeoutMs) });
      if (!response.ok) throw new Error(`CDP version endpoint answered ${response.status}`);
      const version = (await response.json()) as { webSocketDebuggerUrl?: unknown };
      if (typeof version.webSocketDebuggerUrl !== "string") throw new Error("CDP version endpoint has no browser websocket url");
      wsUrl = version.webSocketDebuggerUrl;
    } catch (error) {
      scheduleRetry("webauthn proxy cannot reach the computer's Chromium", { cdpUrl: options.cdpUrl, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (!running) return;
    let connection: CdpSocket;
    try {
      connection = await connect(wsUrl);
    } catch (error) {
      scheduleRetry("webauthn proxy could not open the CDP browser socket", { error: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (!running) { connection.close(); return; }
    socket = connection;
    attempt = 0;
    lastFailure = null;
    log("webauthn proxy attached to the computer's Chromium", { cdpUrl: options.cdpUrl });
    connection.onMessage(onMessage);
    connection.onClose(() => {
      if (socket !== connection) return;
      socket = null;
      contexts.clear();
      embeddedSessions.clear();
      abortFlights();
      commands.failAll("the computer's Chromium went away");
      scheduleRetry("webauthn proxy lost the computer's Chromium", { cdpUrl: options.cdpUrl });
    });
    send({ method: "Target.setAutoAttach", params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true } });
  };

  return {
    start() {
      if (running) return;
      running = true;
      attempt = 0;
      void attach();
    },
    stop() {
      running = false;
      if (retryTimer) { clearTimer(retryTimer); retryTimer = null; }
      const current = socket;
      socket = null;
      contexts.clear();
      embeddedSessions.clear();
      abortFlights();
      commands.failAll("the webauthn proxy stopped");
      current?.close();
    },
    connected: () => socket !== null,
  };
}
