import { describe, expect, it, vi } from "vitest";
import type { WebAuthnRequest, WebAuthnResponse } from "./protocol.js";
import { createWebAuthnCdpProxy, type CdpSocket } from "./cdp-proxy.js";
import { WEBAUTHN_BINDING_NAME, webAuthnDeliverName } from "./page-script.js";

interface Frame { id?: number; sessionId?: string; method: string; params?: Record<string, unknown> }

class FakeCdp implements CdpSocket {
  sent: Frame[] = [];
  denied = new Set<string>();
  heldPolicy: Array<() => void> | null = null;
  frames = new Map<string, { origin: string; parentId?: string }>();
  private policyFrame = "";
  frameTree(id: string): Record<string, unknown> {
    const children = [...this.frames].filter(([, frame]) => frame.parentId === id).map(([childId]) => this.frameTree(childId));
    return { frame: { id, securityOrigin: this.frames.get(id)?.origin }, childFrames: children };
  }
  rootOf(id: string): string {
    let current = id;
    while (this.frames.get(current)?.parentId) current = this.frames.get(current)!.parentId!;
    return current;
  }
  closed = false;
  private messageHandlers: Array<(text: string) => void> = [];
  private closeHandlers: Array<() => void> = [];
  send(text: string): void {
    const frame = JSON.parse(text) as Frame;
    this.sent.push(frame);
    const frameId = frame.params?.frameId as string | undefined;
    if (frame.method === "Page.getPermissionsPolicyState") this.policyFrame = frameId ?? "";
    const result = frame.method === "Page.getPermissionsPolicyState"
      ? { states: ["publickey-credentials-get", "publickey-credentials-create"].map((feature) => ({ feature, allowed: !this.denied.has(`${frameId}:${feature}`) })) }
      : frame.method === "Page.getFrameTree" ? { frameTree: this.frameTree(this.rootOf(this.policyFrame)) } : {};
    const reply = () => this.emit({ id: frame.id, sessionId: frame.sessionId, result });
    if (this.heldPolicy && frame.method === "Page.getPermissionsPolicyState") this.heldPolicy.push(reply);
    else setImmediate(reply);
  }
  onMessage(handler: (text: string) => void): void { this.messageHandlers.push(handler); }
  onClose(handler: () => void): void { this.closeHandlers.push(handler); }
  close(): void { if (!this.closed) { this.closed = true; for (const handler of this.closeHandlers) handler(); } }
  emit(frame: Record<string, unknown>): void { for (const handler of this.messageHandlers) handler(JSON.stringify(frame)); }
  of(method: string, sessionId?: string): Frame[] { return this.sent.filter((frame) => frame.method === method && (sessionId === undefined || frame.sessionId === sessionId)); }
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function harness(options: { handle?: (request: WebAuthnRequest, signal: AbortSignal) => Promise<WebAuthnResponse>; version?: () => Promise<Response>; platformAvailable?: () => boolean } = {}) {
  const sockets: FakeCdp[] = [];
  const timers: Array<{ callback: () => void; delayMs: number; cleared: boolean }> = [];
  const handle = vi.fn(options.handle ?? (async () => ({ ok: true as const, credential: { id: "cred" } })));
  const fetchImpl = vi.fn(options.version ?? (async () => new Response(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/abc" }), { status: 200 })));
  const connect = vi.fn(async (_wsUrl: string) => { const socket = new FakeCdp(); sockets.push(socket); return socket; });
  const log = vi.fn();
  const proxy = createWebAuthnCdpProxy({
    cdpUrl: "http://127.0.0.1:9222",
    handle,
    platformAvailable: options.platformAvailable,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    connect,
    log,
    setTimer: (callback, delayMs) => { const timer = { callback, delayMs, cleared: false }; timers.push(timer); return timer; },
    clearTimer: (handle) => { (handle as { cleared: boolean }).cleared = true; },
    retryBaseMs: 1_000,
    retryMaxMs: 8_000,
  });
  const attachPage = async (socket: FakeCdp, sessionId: string, type = "page") => {
    socket.emit({ method: "Target.attachedToTarget", params: { sessionId, targetInfo: { targetId: `t-${sessionId}`, type }, waitingForDebugger: true } });
    await flush();
  };
  const createContext = async (socket: FakeCdp, sessionId: string, id: number, origin: string, isDefault = true, frameId = "f") => {
    socket.frames.set(frameId, { ...socket.frames.get(frameId), origin });
    socket.emit({ sessionId, method: "Runtime.executionContextCreated", params: { context: { id, origin, name: "", auxData: { isDefault, frameId } } } });
    await flush();
  };
  const callBinding = async (socket: FakeCdp, sessionId: string, contextId: number, payload: unknown, name = WEBAUTHN_BINDING_NAME) => {
    socket.emit({ sessionId, method: "Runtime.bindingCalled", params: { name, payload: typeof payload === "string" ? payload : JSON.stringify(payload), executionContextId: contextId } });
    await flush();
    await flush();
  };
  const fireTimers = async () => {
    for (const timer of timers.splice(0)) { if (!timer.cleared) timer.callback(); }
    await flush();
    await flush();
  };
  const start = async () => { proxy.start(); await flush(); await flush(); return sockets.at(-1)!; };
  return { proxy, sockets, timers, handle, fetchImpl, connect, log, attachPage, createContext, callBinding, fireTimers, start };
}

describe("webauthn CDP proxy", () => {
  it("attaches to the browser target, auto-attaches every page and installs the binding plus the new-document script per session", async () => {
    const h = harness();
    const socket = await h.start();
    expect(h.fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:9222/json/version", expect.anything());
    expect(h.connect).toHaveBeenCalledWith("ws://127.0.0.1:9222/devtools/browser/abc");
    expect(h.proxy.connected()).toBe(true);
    expect(socket.sent[0]).toMatchObject({ method: "Target.setAutoAttach", params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true } });
    expect(socket.sent[0]!.sessionId).toBeUndefined();

    await h.attachPage(socket, "S1");
    const methods = socket.sent.filter((frame) => frame.sessionId === "S1").map((frame) => frame.method);
    expect(methods).toEqual(["Runtime.enable", "Runtime.addBinding", "Page.addScriptToEvaluateOnNewDocument", "Target.setAutoAttach", "Runtime.runIfWaitingForDebugger"]);
    expect(socket.of("Runtime.addBinding", "S1")[0]!.params).toEqual({ name: WEBAUTHN_BINDING_NAME });
    expect(String(socket.of("Page.addScriptToEvaluateOnNewDocument", "S1")[0]!.params!.source)).toContain(WEBAUTHN_BINDING_NAME);
    expect(socket.of("Target.setAutoAttach", "S1")[0]!.params).toMatchObject({ autoAttach: true, flatten: true });

    await h.attachPage(socket, "W1", "service_worker");
    expect(socket.sent.filter((frame) => frame.sessionId === "W1").map((frame) => frame.method)).toEqual(["Runtime.runIfWaitingForDebugger"]);

    await h.createContext(socket, "S1", 7, "https://login.example.com");
    const evaluate = socket.of("Runtime.evaluate", "S1");
    expect(evaluate).toHaveLength(1);
    expect(evaluate[0]!.params).toMatchObject({ contextId: 7 });
    expect(String(evaluate[0]!.params!.expression)).toContain(WEBAUTHN_BINDING_NAME);
    await h.createContext(socket, "S1", 8, "https://login.example.com", false);
    expect(socket.of("Runtime.evaluate", "S1")).toHaveLength(1);
  });

  it("builds the request from the context's origin, never the page's claim, and delivers the answer to that context", async () => {
    const h = harness();
    const socket = await h.start();
    await h.attachPage(socket, "S1");
    await h.createContext(socket, "S1", 7, "https://login.example.com");
    await h.callBinding(socket, "S1", 7, { seq: 1, kind: "get", origin: "https://accounts.google.com", mediation: "optional", options: { challenge: "AQID", rpId: "example.com", origin: "https://accounts.google.com" } });
    expect(h.handle).toHaveBeenCalledTimes(1);
    expect(h.handle).toHaveBeenCalledWith({ origin: "https://login.example.com", rpId: "example.com", kind: "get", options: { challenge: "AQID", rpId: "example.com", origin: "https://accounts.google.com", mediation: "optional" } }, expect.any(AbortSignal));
    const delivered = socket.of("Runtime.callFunctionOn", "S1");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.params).toMatchObject({ executionContextId: 7, arguments: [{ value: webAuthnDeliverName() }, { value: 1 }, { value: { ok: true, credential: { id: "cred" } } }] });
  });

  it("aborts the relayed request when the page cancels it, and delivers nothing afterwards", async () => {
    let seen: AbortSignal | null = null;
    const h = harness({ handle: (_request, signal) => { seen = signal; return new Promise<WebAuthnResponse>((resolve) => signal.addEventListener("abort", () => resolve({ ok: false, error: { name: "AbortError", message: "aborted" } }))); } });
    const socket = await h.start();
    await h.attachPage(socket, "S1");
    await h.createContext(socket, "S1", 7, "https://login.example.com");
    await h.callBinding(socket, "S1", 7, { seq: 4, kind: "get", options: { challenge: "AQID" } });
    expect(seen!.aborted).toBe(false);
    await h.callBinding(socket, "S1", 7, { seq: 4, cancel: true });
    expect(seen!.aborted).toBe(true);
    expect(socket.of("Runtime.callFunctionOn", "S1")).toHaveLength(0);
  });

  it("aborts relayed requests whose context, session or CDP connection goes away", async () => {
    const signals: AbortSignal[] = [];
    const h = harness({ handle: (_request, signal) => { signals.push(signal); return new Promise<WebAuthnResponse>(() => {}); } });
    const socket = await h.start();
    await h.attachPage(socket, "S1");
    await h.attachPage(socket, "S2");
    await h.createContext(socket, "S1", 7, "https://login.example.com");
    await h.createContext(socket, "S1", 8, "https://login.example.com");
    await h.createContext(socket, "S2", 9, "https://login.example.com");
    for (const [session, context, seq] of [["S1", 7, 1], ["S1", 8, 2], ["S2", 9, 3]] as const) {
      await h.callBinding(socket, session, context, { seq, kind: "get", options: { challenge: "AQID" } });
    }
    socket.emit({ sessionId: "S1", method: "Runtime.executionContextDestroyed", params: { executionContextId: 7 } });
    expect(signals.map((signal) => signal.aborted)).toEqual([true, false, false]);
    socket.emit({ sessionId: "S1", method: "Runtime.executionContextsCleared", params: {} });
    expect(signals.map((signal) => signal.aborted)).toEqual([true, true, false]);
    await h.createContext(socket, "S2", 10, "https://login.example.com");
    await h.callBinding(socket, "S2", 10, { seq: 4, kind: "get", options: { challenge: "AQID" } });
    socket.emit({ method: "Target.detachedFromTarget", params: { sessionId: "S2" } });
    expect(signals.map((signal) => signal.aborted)).toEqual([true, true, true, true]);
    await h.attachPage(socket, "S3");
    await h.createContext(socket, "S3", 11, "https://login.example.com");
    await h.callBinding(socket, "S3", 11, { seq: 5, kind: "get", options: { challenge: "AQID" } });
    socket.close();
    expect(signals.at(-1)!.aborted).toBe(true);
  });

  it("refuses a request from a frame whose permissions policy does not allow that passkey ceremony", async () => {
    const h = harness();
    const socket = await h.start();
    socket.denied.add("child:publickey-credentials-get");
    await h.attachPage(socket, "S1");
    await h.createContext(socket, "S1", 7, "https://widget.example", true, "child");
    await h.callBinding(socket, "S1", 7, { seq: 1, kind: "get", options: { challenge: "AQID" } });
    await h.callBinding(socket, "S1", 7, { seq: 2, kind: "create", options: { challenge: "AQ", rp: { name: "W" }, user: { id: "Ag", name: "b", displayName: "B" }, pubKeyCredParams: [] } });
    expect(socket.of("Page.getPermissionsPolicyState", "S1").map((frame) => frame.params)).toEqual([{ frameId: "child" }, { frameId: "child" }]);
    expect(h.handle).toHaveBeenCalledTimes(1);
    expect(h.handle).toHaveBeenCalledWith(expect.objectContaining({ kind: "create" }), expect.any(AbortSignal));
    const delivered = socket.of("Runtime.callFunctionOn", "S1").map((frame) => (frame.params!.arguments as Array<{ value: unknown }>)[2]!.value);
    expect(delivered[0]).toMatchObject({ ok: false, error: { name: "NotAllowedError" } });
  });

  it("refuses a passkey request from a frame with any cross-origin ancestor, since the desktop cannot sign that context", async () => {
    const h = harness();
    const socket = await h.start();
    socket.frames.set("top", { origin: "https://portal.example" });
    socket.frames.set("same", { origin: "https://portal.example", parentId: "top" });
    socket.frames.set("embedded", { origin: "https://login.example.com", parentId: "top" });
    await h.attachPage(socket, "S1");
    await h.attachPage(socket, "OOPIF", "iframe");
    await h.createContext(socket, "S1", 7, "https://portal.example", true, "same");
    await h.createContext(socket, "S1", 8, "https://login.example.com", true, "embedded");
    await h.createContext(socket, "OOPIF", 9, "https://login.example.com", true, "remote");
    await h.callBinding(socket, "S1", 7, { seq: 1, kind: "get", options: { challenge: "AQID" } });
    await h.callBinding(socket, "S1", 8, { seq: 2, kind: "get", options: { challenge: "AQID" } });
    await h.callBinding(socket, "OOPIF", 9, { seq: 3, kind: "get", options: { challenge: "AQID" } });
    expect(h.handle).toHaveBeenCalledTimes(1);
    expect(h.handle).toHaveBeenCalledWith(expect.objectContaining({ origin: "https://portal.example" }), expect.any(AbortSignal));
    for (const session of ["S1", "OOPIF"]) {
      const answers = socket.of("Runtime.callFunctionOn", session).map((frame) => (frame.params!.arguments as Array<{ value: unknown }>)[2]!.value);
      expect(answers.filter((answer) => (answer as { ok?: boolean }).ok === false)).toEqual([{ ok: false, error: { name: "NotAllowedError", message: expect.stringContaining("embedded") } }]);
    }
  });

  it("drops a request cancelled or orphaned while its permissions-policy check is still pending", async () => {
    const h = harness();
    const socket = await h.start();
    socket.heldPolicy = [];
    await h.attachPage(socket, "S1");
    await h.createContext(socket, "S1", 7, "https://login.example.com");
    await h.createContext(socket, "S1", 8, "https://login.example.com");
    await h.callBinding(socket, "S1", 7, { seq: 1, kind: "get", options: { challenge: "AQID" } });
    await h.callBinding(socket, "S1", 7, { seq: 1, cancel: true });
    await h.callBinding(socket, "S1", 8, { seq: 2, kind: "get", options: { challenge: "AQID" } });
    socket.emit({ sessionId: "S1", method: "Runtime.executionContextDestroyed", params: { executionContextId: 8 } });
    for (const reply of socket.heldPolicy.splice(0)) reply();
    await flush();
    await flush();
    expect(h.handle).not.toHaveBeenCalled();
    expect(socket.of("Runtime.callFunctionOn", "S1")).toHaveLength(0);
  });

  it("answers the page's platform-authenticator question from whether a desktop is linked", async () => {
    let linked = false;
    const h = harness({ platformAvailable: () => linked });
    const socket = await h.start();
    await h.attachPage(socket, "S1");
    await h.createContext(socket, "S1", 7, "https://login.example.com");
    await h.callBinding(socket, "S1", 7, { seq: 3, query: "platform" });
    linked = true;
    await h.callBinding(socket, "S1", 7, { seq: 4, query: "platform" });
    const delivered = socket.of("Runtime.callFunctionOn", "S1").map((frame) => (frame.params!.arguments as Array<{ value: unknown }>).slice(1).map((argument) => argument.value));
    expect(delivered).toEqual([[3, { available: false }], [4, { available: true }]]);
    expect(h.handle).not.toHaveBeenCalled();
  });

  it("defaults the RP ID to the origin host and refuses insecure origins, foreign RP IDs that are not hostnames, and unknown contexts without asking the desktop", async () => {
    const h = harness();
    const socket = await h.start();
    await h.attachPage(socket, "S1");
    await h.createContext(socket, "S1", 1, "https://example.com");
    await h.createContext(socket, "S1", 2, "http://insecure.example", true, "g");
    await h.callBinding(socket, "S1", 1, { seq: 5, kind: "create", options: { challenge: "AQ", rp: { name: "Example" }, user: { id: "Ag", name: "b", displayName: "B" }, pubKeyCredParams: [] } });
    expect(h.handle).toHaveBeenLastCalledWith(expect.objectContaining({ origin: "https://example.com", rpId: "example.com", kind: "create" }), expect.any(AbortSignal));

    await h.callBinding(socket, "S1", 2, { seq: 1, kind: "get", options: { challenge: "AQ" } });
    await h.callBinding(socket, "S1", 1, { seq: 6, kind: "get", options: { challenge: "AQ", rpId: "not a host" } });
    await h.callBinding(socket, "S1", 99, { seq: 7, kind: "get", options: { challenge: "AQ" } });
    expect(h.handle).toHaveBeenCalledTimes(1);
    const delivered = socket.of("Runtime.callFunctionOn", "S1").map((frame) => frame.params!.arguments as Array<{ value: unknown }>);
    expect(delivered.map((args) => [args[1]!.value, (args[2]!.value as { ok: boolean; error?: { name: string } }).error?.name])).toEqual([[5, undefined], [1, "NotAllowedError"], [6, "SecurityError"]]);
    expect(h.log).toHaveBeenCalledWith("webauthn binding called from an unknown context", expect.objectContaining({ sessionId: "S1", contextId: 99 }));
  });

  it("logs and ignores malformed binding payloads and other bindings, and turns a failed relay into NotAllowedError", async () => {
    const h = harness({ handle: async () => { throw new Error("tunnel exploded"); } });
    const socket = await h.start();
    await h.attachPage(socket, "S1");
    await h.createContext(socket, "S1", 1, "https://example.com");
    await h.callBinding(socket, "S1", 1, "{not json");
    await h.callBinding(socket, "S1", 1, { kind: "get", options: {} });
    await h.callBinding(socket, "S1", 1, { seq: 1, kind: "list", options: {} });
    await h.callBinding(socket, "S1", 1, { seq: 2, kind: "get", options: {} }, "someOtherBinding");
    expect(h.handle).not.toHaveBeenCalled();
    expect(socket.of("Runtime.callFunctionOn")).toHaveLength(0);
    expect(h.log).toHaveBeenCalledWith("webauthn binding payload rejected", expect.anything());

    await h.callBinding(socket, "S1", 1, { seq: 3, kind: "get", options: { challenge: "AQ" } });
    expect(h.handle).toHaveBeenCalledTimes(1);
    const args = socket.of("Runtime.callFunctionOn")[0]!.params!.arguments as Array<{ value: unknown }>;
    expect(args[2]!.value).toEqual({ ok: false, error: { name: "NotAllowedError", message: expect.stringContaining("tunnel exploded") } });
  });

  it("forgets destroyed contexts and detached sessions", async () => {
    const h = harness();
    const socket = await h.start();
    await h.attachPage(socket, "S1");
    await h.attachPage(socket, "S2");
    await h.createContext(socket, "S1", 1, "https://example.com");
    await h.createContext(socket, "S2", 1, "https://other.example");
    socket.emit({ sessionId: "S1", method: "Runtime.executionContextDestroyed", params: { executionContextId: 1 } });
    socket.emit({ method: "Target.detachedFromTarget", params: { sessionId: "S2" } });
    await flush();
    await h.callBinding(socket, "S1", 1, { seq: 1, kind: "get", options: { challenge: "AQ" } });
    await h.callBinding(socket, "S2", 1, { seq: 1, kind: "get", options: { challenge: "AQ" } });
    expect(h.handle).not.toHaveBeenCalled();
  });

  it("reconnects with backoff when Chromium goes away or is not up yet, and stops cleanly", async () => {
    let versionCalls = 0;
    const h = harness({
      version: async () => {
        versionCalls += 1;
        if (versionCalls === 1) throw new Error("ECONNREFUSED");
        return new Response(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/abc" }));
      },
    });
    h.proxy.start();
    await flush();
    await flush();
    expect(h.proxy.connected()).toBe(false);
    expect(h.connect).not.toHaveBeenCalled();
    expect(h.timers).toHaveLength(1);
    expect(h.log).toHaveBeenCalledWith("webauthn proxy cannot reach the VM's Chromium", expect.objectContaining({ error: "ECONNREFUSED" }));
    await h.fireTimers();
    expect(h.proxy.connected()).toBe(true);
    const first = h.sockets[0]!;
    first.close();
    await flush();
    expect(h.proxy.connected()).toBe(false);
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0]!.delayMs).toBeGreaterThanOrEqual(1_000);
    await h.fireTimers();
    expect(h.sockets).toHaveLength(2);
    expect(h.proxy.connected()).toBe(true);
    h.proxy.stop();
    expect(h.sockets[1]!.closed).toBe(true);
    expect(h.proxy.connected()).toBe(false);
    await flush();
    expect(h.timers.filter((timer) => !timer.cleared)).toHaveLength(0);
  });
});
