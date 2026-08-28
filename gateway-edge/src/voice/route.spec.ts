import { once } from "node:events";
import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { TALK_PROTOCOL_VERSION, type TalkServerEvent } from "@octogee/shared/types/voice";
import type { SttStream, SttStreamEvents, TtsRequest, VoiceRelayClient } from "./relay-client.js";
import {
  VOICE_NOT_CONFIGURED_MESSAGE,
  VOICE_AGENT_UNAVAILABLE_MESSAGE,
  VOICE_RELAY_UNAVAILABLE_MESSAGE,
  createVoiceWsUpgradeHandler,
  type VoiceWsRouteDeps,
} from "./route.js";

const TICKET = "0f0e0d0c-0b0a-4908-8706-050403020100";
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const sttFault = { throwOnAudio: false };

class FakeStt implements SttStream {
  audio: Buffer[] = [];
  constructor(readonly events: SttStreamEvents) {}
  sendAudio(pcm: Buffer) {
    if (sttFault.throwOnAudio) throw new RangeError("start offset of Int16Array should be a multiple of 2");
    this.audio.push(pcm);
  }
  end() {
    this.events.onFinal?.("Where are my glasses?");
  }
  abort() {
    /* noop */
  }
}

function fakeRelay() {
  const stts: FakeStt[] = [];
  const ttsRequests: TtsRequest[] = [];
  const client: VoiceRelayClient = {
    openStt(events) {
      const stt = new FakeStt(events);
      stts.push(stt);
      queueMicrotask(() => events.onReady?.());
      return stt;
    },
    async *tts(request) {
      ttsRequests.push(request);
      yield Buffer.alloc(9600, 7);
    },
  };
  return { client, stts, ttsRequests };
}

function eventFanout() {
  const listeners = new Map<string, Set<(event: import("./brain.js").BrainEvent) => void>>();
  return {
    source(agentId: string) {
      return {
        subscribe(listener: (event: import("./brain.js").BrainEvent) => void) {
          const subscribers = listeners.get(agentId) ?? new Set();
          subscribers.add(listener);
          listeners.set(agentId, subscribers);
          return () => {
            subscribers.delete(listener);
            if (subscribers.size === 0) listeners.delete(agentId);
          };
        },
      };
    },
    emit(agentId: string, event: import("./brain.js").BrainEvent) {
      for (const listener of listeners.get(agentId) ?? []) listener(event);
    },
  };
}

async function serverWith(overrides: Partial<VoiceWsRouteDeps> = {}) {
  const relayStatus = { configured: true, engines: { stt: "fake-stt", tts: "fake-tts" }, capabilities: { speed: false } };
  const relay = fakeRelay();
  const posts: Array<Record<string, unknown>> = [];
  const events = eventFanout();
  const deps: VoiceWsRouteDeps = {
    runtimeBroker: {
      redeemOpenClawWs: vi.fn(async () => ({
        kind: "redeemed" as const,
        redeemed: { uid: "uid-mom", gatewayId: "gw-mom", gatewayUrl: "http://unused", expectedAgentId: "mom-coach" },
      })),
    },
    eventSourceForAgent: events.source,
    isAgentReady: () => true,
    upgradeGate: null,
    isAllowedWsOrigin: () => true,
    stripGatewayPrefix: (p) => p.replace(/^\/g\/[^/]+/, ""),
    relayBaseUrl: "http://relay.local",
    mmInternalUrl: "http://mattermost.octogee-test.svc.cluster.local:8065",
    createVad: async () => ({ process: async () => 0, reset: () => undefined }),
    fetchImpl: vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/internal/voice/status")) return new Response(JSON.stringify(relayStatus), { status: 200 });
      if (url.endsWith("/api/v4/posts")) {
        posts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ id: "post-1" }), { status: 201 });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch,
    createRelayClient: () => relay.client,
    ...overrides,
  };
  const handler = createVoiceWsUpgradeHandler(deps);
  const server = http.createServer((_req, res) => res.end("ok"));
  server.on("upgrade", (req, socket, head) => {
    void handler(req, socket, head);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(async () => new Promise<void>((r) => server.close(() => r())));
  const base = `ws://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { base, deps, relay, posts, events, relayStatus };
}

async function waitFor(pred: () => boolean, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function firstEventThenClose(ws: WebSocket): Promise<{ event: TalkServerEvent; code: number }> {
  const [raw] = (await once(ws, "message")) as [Buffer];
  const [code] = (await once(ws, "close")) as [number];
  return { event: JSON.parse(raw.toString()) as TalkServerEvent, code };
}

describe("voice ws route", () => {
  it("refuses the handshake without a ticket or on an unauthorized ticket", async () => {
    const { base, deps } = await serverWith();
    const noTicket = new WebSocket(`${base}/api/voice/ws/`);
    expect(((await once(noTicket, "error")) as [Error])[0].message).toMatch(/401/);

    (deps.runtimeBroker.redeemOpenClawWs as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ kind: "unauthorized" });
    const bad = new WebSocket(`${base}/api/voice/ws/${TICKET}`);
    expect(((await once(bad, "error")) as [Error])[0].message).toMatch(/401/);
    expect(deps.runtimeBroker.redeemOpenClawWs).toHaveBeenLastCalledWith(TICKET, "voice-ws");
  });

  it("past authentication, an unconfigured or unreachable relay is a typed error the browser can render, then a clean close", async () => {
    const { base, deps, relayStatus } = await serverWith();
    relayStatus.configured = false;
    const unconfigured = new WebSocket(`${base}/g/gw-mom/api/voice/ws/${TICKET}`);
    expect(await firstEventThenClose(unconfigured)).toEqual({
      event: { type: "error", code: "not_configured", message: VOICE_NOT_CONFIGURED_MESSAGE, recoverable: false },
      code: 1000,
    });
    const statusUrl = (deps.fetchImpl as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0])).find((u) => u.includes("/internal/voice/status"));
    expect(statusUrl).toBe("http://relay.local/internal/voice/status?gatewayId=gw-mom");

    (deps.fetchImpl as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => new Response("forbidden", { status: 403 }));
    const unreachable = new WebSocket(`${base}/g/gw-mom/api/voice/ws/${TICKET}`);
    expect(await firstEventThenClose(unreachable)).toEqual({
      event: { type: "error", code: "internal", message: VOICE_RELAY_UNAVAILABLE_MESSAGE, recoverable: false },
      code: 1000,
    });
  });

  it("refuses when the roster gate says the uid is not served here", async () => {
    const refuse = vi.fn((socket: { write: (s: string) => void; destroy: () => void }) => {
      socket.write("HTTP/1.1 409 Conflict\r\n\r\n");
      socket.destroy();
    });
    const { base } = await serverWith({
      upgradeGate: {
        checkRequest: () => ({ allow: true }),
        checkUid: () => ({ allow: false, reason: "quiescing" }),
        checkUnmappedIdentity: () => ({ allow: true }),
        refuse,
      } as unknown as VoiceWsRouteDeps["upgradeGate"],
    });
    const ws = new WebSocket(`${base}/api/voice/ws/${TICKET}`);
    expect(((await once(ws, "error")) as [Error])[0].message).toMatch(/409/);
    expect(refuse).toHaveBeenCalled();
  });

  it("returns a typed agent-unavailable error when the local plugin relay has no fresh source heartbeat", async () => {
    const { base } = await serverWith({ isAgentReady: () => false });
    const ws = new WebSocket(`${base}/api/voice/ws/${TICKET}`);
    expect(await firstEventThenClose(ws)).toEqual({
      event: { type: "error", code: "internal", message: VOICE_AGENT_UNAVAILABLE_MESSAGE, recoverable: false },
      code: 1000,
    });
  });

  it("ends an active Talk session when the plugin heartbeat expires", async () => {
    let ready = true;
    const { base } = await serverWith({ isAgentReady: () => ready, agentReadinessPollMs: 5 });
    const ws = new WebSocket(`${base}/api/voice/ws/${TICKET}`);
    const events: TalkServerEvent[] = [];
    ws.on("message", (data, isBinary) => {
      if (!isBinary) events.push(JSON.parse(data.toString()) as TalkServerEvent);
    });
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "session.start", protocol: TALK_PROTOCOL_VERSION, mode: "converse", channelId: "chan1", mmToken: "mm-token-1234567890" }));
    await waitFor(() => events.some((event) => event.type === "session.ready"));
    ready = false;
    const [code, reason] = (await once(ws, "close")) as [number, Buffer];

    expect(code).toBe(1000);
    expect(reason.toString()).toBe("agent-unavailable");
    expect(events.at(-1)).toEqual({
      type: "error",
      code: "internal",
      message: VOICE_AGENT_UNAVAILABLE_MESSAGE,
      recoverable: false,
    });
  });

  it("a session that throws mid-frame is torn down with a typed error while the server keeps serving other sessions", async () => {
    const { base, relay } = await serverWith();
    const ws = new WebSocket(`${base}/g/gw-mom/api/voice/ws/${TICKET}`);
    const events: TalkServerEvent[] = [];
    ws.on("message", (data, isBinary) => {
      if (!isBinary) events.push(JSON.parse(data.toString()) as TalkServerEvent);
    });
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "session.start", protocol: TALK_PROTOCOL_VERSION, mode: "converse", channelId: "chan1", mmToken: "mm-token-1234567890" }));
    await waitFor(() => events.some((e) => e.type === "session.ready"));
    ws.send(JSON.stringify({ type: "listen.start" }));
    await waitFor(() => relay.stts.length === 1);
    sttFault.throwOnAudio = true;
    try {
      ws.send(Buffer.alloc(1024), { binary: true });
      const [code, reason] = (await once(ws, "close")) as [number, Buffer];
      expect(code).toBe(1000);
      expect(reason.toString()).toBe("session-error");
      expect(events.at(-1)).toMatchObject({ type: "error", code: "internal", recoverable: false });
    } finally {
      sttFault.throwOnAudio = false;
    }

    const next = new WebSocket(`${base}/g/gw-mom/api/voice/ws/${TICKET}`);
    const nextEvents: TalkServerEvent[] = [];
    next.on("message", (data, isBinary) => {
      if (!isBinary) nextEvents.push(JSON.parse(data.toString()) as TalkServerEvent);
    });
    await once(next, "open");
    next.send(JSON.stringify({ type: "session.start", protocol: TALK_PROTOCOL_VERSION, mode: "converse", channelId: "chan1", mmToken: "mm-token-1234567890" }));
    await waitFor(() => nextEvents.some((e) => e.type === "session.ready"));
    next.close();
  });

  it("runs a talk turn end to end: audio → relay STT → Mattermost post → agent events → speech frames", async () => {
    const { base, relay, posts, events: source } = await serverWith();
    const ws = new WebSocket(`${base}/g/gw-mom/api/voice/ws/${TICKET}`);
    const events: TalkServerEvent[] = [];
    const audio: Buffer[] = [];
    ws.on("message", (data, isBinary) => {
      if (isBinary) audio.push(data as Buffer);
      else events.push(JSON.parse(data.toString()) as TalkServerEvent);
    });
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "session.start", protocol: TALK_PROTOCOL_VERSION, mode: "converse", channelId: "chan1", mmToken: "mm-token-1234567890" }));
    await waitFor(() => events.some((e) => e.type === "session.ready"));
    expect(events[0]).toMatchObject({ type: "session.ready", engines: { stt: "fake-stt", tts: "fake-tts" }, capabilities: { speed: false } });

    ws.send(JSON.stringify({ type: "listen.start" }));
    await waitFor(() => relay.stts.length === 1);
    ws.send(Buffer.alloc(1024), { binary: true });
    await waitFor(() => relay.stts[0].audio.length === 1);
    ws.send(JSON.stringify({ type: "turn.commit" }));
    ws.send(JSON.stringify({ type: "listen.stop" }));

    ws.send(JSON.stringify({ type: "listen.start" }));
    await waitFor(() => relay.stts.length === 2);
    relay.stts[1].events.onFinal?.("Where are my glasses?");
    await waitFor(() => posts.length === 1);
    expect(posts[0]).toMatchObject({ channel_id: "chan1", message: "🎙 Where are my glasses?" });
    const session = "agent:mom-coach:mattermost:channel:chan1";
    const agentEvent = (runId: string, stream: string, data: Record<string, unknown>) =>
      source.emit("mom-coach", { kind: "agent", runId, stream, ts: Date.now(), sessionKey: session, data });
    agentEvent("run-typed", "lifecycle", { phase: "start" });
    agentEvent("run-typed", "assistant", { delta: "This answers a typed message, not the voice turn. " });
    agentEvent("run-typed", "lifecycle", { phase: "end" });
    source.emit("mom-coach", { kind: "inbound", messageId: "post-1", sessionKey: session, ts: Date.now() });
    agentEvent("run-1", "lifecycle", { phase: "start" });
    agentEvent("run-1", "assistant", { delta: "They are on the kitchen table. " });
    agentEvent("run-1", "lifecycle", { phase: "end" });
    await waitFor(() => events.some((e) => e.type === "audio.end"));
    expect(relay.ttsRequests.map((r) => r.text)).toEqual(["They are on the kitchen table."]);
    expect(audio.length).toBeGreaterThan(0);
    expect(events).toContainEqual(expect.objectContaining({ type: "reply.final", text: "They are on the kitchen table. " }));

    ws.send(JSON.stringify({ type: "session.end" }));
    const [code] = (await once(ws, "close")) as [number];
    expect(code).toBe(1000);
  });
});
