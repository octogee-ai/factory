import { createVoiceMigrationRegistry } from './migration.js';
import { EventEmitter, once } from "node:events";
import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { TALK_PROTOCOL_VERSION, type TalkServerEvent } from "@octogee/shared/types/voice";
import type { SttStream, SttStreamEvents, TtsRequest, VoiceRelayClient } from "@octogee/core/voice-relay-client";
import {
  VOICE_NOT_CONFIGURED_MESSAGE,
  VOICE_AGENT_UNAVAILABLE_MESSAGE,
  VOICE_RELAY_UNAVAILABLE_MESSAGE,
  createVoiceWsUpgradeHandler,
  type VoiceWsRouteDeps,
} from "./route.js";

import { NativeTalkSession } from "./native-session.js";

const TICKET = "0f0e0d0c-0b0a-4908-8706-050403020100";
const GRANT = "g".repeat(43);
const CHANNEL = 'c'.repeat(26);
const threadRootPostId = 'r'.repeat(26);
const SESSION_KEY = `agent:mom-coach:mattermost:channel:${CHANNEL}`;
const POST_ID = "p".repeat(26);
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  vi.restoreAllMocks();
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
  const grantExpiresAt = Date.now() + 60_000;
  const relayStatus = { nativeOpenAi: false, configured: true, engines: { stt: "fake-stt", tts: "fake-tts" }, capabilities: { speed: false } };
  const relay = fakeRelay();
  const posts: Array<Record<string, unknown>> = [];
  const events = eventFanout();
  const deps: VoiceWsRouteDeps = {
    runtimeBroker: {
      redeemOpenClawWs: vi.fn(async () => ({
        kind: "redeemed" as const,
        redeemed: { uid: "uid-mom", gatewayId: "gw-mom", gatewayUrl: "http://unused", expectedAgentId: "mom-coach", voiceGrant: GRANT, voiceGrantExpiresAt: grantExpiresAt, voiceConversation: { ownerUid: "uid-owner", workspaceSlug: "mom", channelId: CHANNEL, threadRootPostId, sessionKey: SESSION_KEY } },
      })),
    },
    eventSourceForAgent: events.source,
    resolveConversation: vi.fn(async ({ uid, gatewayId, channelId, threadRootPostId }) => ({ uid, gatewayId, channelId, threadRootPostId, workspaceSlug: "mom", agentId: "mom-coach", sessionKey: `agent:mom-coach:mattermost:channel:${channelId}`, callerMmUserId: "b".repeat(26), nativeInterrupt: false })),
    bindGrant: vi.fn(async ({ sessionId }) => ({ ...await deps.resolveConversation!({ uid: "uid-mom", gatewayId: "gw-mom", channelId: CHANNEL, threadRootPostId, expectedAgentId: "mom-coach" }), sessionId, expiresAt: grantExpiresAt })),
    endGrant: vi.fn(async () => ({ revoked: true as const })),
    isAgentReady: () => true,
    upgradeGate: null,
    isAllowedWsOrigin: () => true,
    stripGatewayPrefix: (p) => p.replace(/^\/g\/[^/]+/, ""),
    relayBaseUrl: "http://relay.local",
    createVad: async () => ({ process: async () => 0, reset: () => undefined }),
    fetchImpl: vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/internal/voice/status")) return new Response(JSON.stringify(relayStatus), { status: 200 });
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch,
    postTurn: vi.fn(async (turn) => {
      posts.push({ ...turn });
      return { postId: POST_ID, channelId: CHANNEL, threadRootPostId, userId: "b".repeat(26) };
    }),
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

function captureVoiceExpiry() {
  const schedule = globalThis.setTimeout;
  const expiry: { callback: () => void; scheduledAt: number; delay: number } = {
    callback: () => { throw new Error('Voice expiry was not scheduled'); }, scheduledAt: 0, delay: 0,
  };
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void, timeout?: number, ...args: unknown[]) => {
    if (typeof callback === 'function' && typeof timeout === 'number' && timeout > 30_000 && timeout <= 60_000) {
      expiry.callback = callback;
      expiry.scheduledAt = Date.now();
      expiry.delay = timeout;
    }
    return schedule(callback, timeout, ...args);
  }) as typeof setTimeout);
  return expiry;
}

describe("voice ws route", () => {
  it('ends an active voice connection after the migration grace period', async () => {
    const migrationRegistry = createVoiceMigrationRegistry({ graceMs: 50 });
    const { base } = await serverWith({ migrationRegistry });
    const ws = new WebSocket(`${base}/api/voice/ws/${TICKET}`);
    await once(ws, 'open');
    expect(migrationRegistry.hold('mom', 'move-1')).toBe(1);
    const [data] = await once(ws, 'message');
    expect(JSON.parse(String(data))).toMatchObject({ type: 'error', message: 'Your workspace is moving. Reconnect voice when the move finishes.' });
    await once(ws, 'close');
    await waitFor(() => migrationRegistry.hold('mom', 'move-1') === 0);
    migrationRegistry.resume('mom', 'move-1');
    expect(migrationRegistry.begin('mom')).toBeTypeOf('function');
  });
  it('protects handshakes and idle calls through a migration longer than the takeover lease', async () => {
    let now = 0;
    const migrationRegistry = createVoiceMigrationRegistry({ now: () => now });
    let resolveStatus!: (response: Response) => void;
    const fetchImpl = vi.fn(() => new Promise<Response>(resolve => { resolveStatus = resolve; })) as unknown as typeof fetch;
    const { base } = await serverWith({ migrationRegistry, fetchImpl });
    const ws = new WebSocket(`${base}/api/voice/ws/${TICKET}`);
    await waitFor(() => Boolean(resolveStatus));
    expect(migrationRegistry.hold('mom', 'move-1')).toBe(1);
    expect(() => migrationRegistry.resume('mom', 'old-move')).toThrow(/another migration/);
    resolveStatus(new Response(JSON.stringify({ configured: true, engines: { stt: 'fake', tts: 'fake' } })));
    await once(ws, 'open');
    expect(migrationRegistry.hold('mom', 'move-1')).toBe(1);
    now = 179_000;
    const blocked = new WebSocket(`${base}/api/voice/ws/${TICKET}`);
    await once(blocked, 'error');
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close(); await once(ws, 'close');
    await waitFor(() => migrationRegistry.hold('mom', 'move-1') === 0);
  });

  it('binds the legacy grant before readiness and revokes it when the client closes', async () => {
    const { base, deps } = await serverWith();
    const ws = new WebSocket(`${base}/api/voice/ws/${TICKET}`);
    await once(ws, 'open');
    const ready = once(ws, 'message');
    ws.send(JSON.stringify({ type: 'session.start', protocol: 1, mode: 'converse', channelId: CHANNEL, threadRootPostId }));
    const event = JSON.parse(String((await ready)[0]));
    expect(event.type).toBe('session.ready');
    expect(deps.bindGrant).toHaveBeenCalledWith(expect.objectContaining({ voiceGrant: GRANT, sessionId: event.sessionId }));
    expect(JSON.stringify(event)).not.toContain(GRANT);
    ws.close(); await once(ws, 'close');
    await waitFor(() => (deps.endGrant as ReturnType<typeof vi.fn>).mock.calls.length === 1);
    expect(deps.endGrant).toHaveBeenCalledWith(expect.objectContaining({ voiceGrant: GRANT }));
  });
  it.each(['posted', 'rejected', 'wrong-channel'])('settles the %s after-call archive before grant revocation without gating live speech', async outcome => {
    const nativeWs = Object.assign(new EventEmitter(), { close: vi.fn() });
    const rpc = { call: vi.fn(async () => ({ ok: true, result: { sessionId: 'native', relaySessionId: 'native' } })), dispose: vi.fn() };
    rpc.call.mockImplementation(async (...args: unknown[]) => {
      if (args[0] === 'talk.session.close') {
        await new Promise(resolve => setTimeout(resolve, 10));
        nativeWs.emit('message', Buffer.from(JSON.stringify({ type: 'event', event: 'talk.event', payload: { relaySessionId: 'native', type: 'transcript', role: 'user', text: 'Final words on close', final: true, transcriptId: 'voice:native:3' } })));
      }
      return { ok: true, result: { sessionId: 'native', relaySessionId: 'native' } };
    });
    let nativeSession: NativeTalkSession | undefined;
    let finishArchive!: (value: Awaited<ReturnType<NonNullable<VoiceWsRouteDeps['archiveCall']>>>) => void;
    let rejectArchive!: (error: Error) => void;
    const archiveCall = vi.fn(() => new Promise<Awaited<ReturnType<NonNullable<VoiceWsRouteDeps['archiveCall']>>>>((resolve, reject) => { finishArchive = resolve; rejectArchive = reject; }));
    const log = vi.fn();
    const { base, deps, posts } = await serverWith({ nativeVoiceEnabled: true, archiveCall, log,
      createNativeSession: options => nativeSession = new NativeTalkSession({ ...options, open: vi.fn().mockResolvedValue({ ws: nativeWs, scopes: new Set(['operator.talk']) }), attachRpc: () => rpc as any }),
      resolveConversation: async ({ uid, gatewayId, channelId }) => ({ uid, gatewayId, channelId, threadRootPostId, workspaceSlug: 'mom', agentId: 'mom-coach', sessionKey: SESSION_KEY, callerMmUserId: 'b'.repeat(26), nativeInterrupt: true }),
    });
    const ws = new WebSocket(`${base}/api/voice/ws/${TICKET}`); await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'session.start', protocol: 1, mode: 'converse', channelId: CHANNEL, threadRootPostId }));
    await waitFor(() => nativeSession?.boundNativeSessionId === 'native');
    const event = (payload: object) => nativeWs.emit('message', Buffer.from(JSON.stringify({ type: 'event', event: 'talk.event', payload: { relaySessionId: 'native', ...payload } })));
    event({ type: 'transcript', role: 'user', text: 'Find my glasses', final: true, transcriptId: 'voice:native:1' });
    event({ type: 'transcript', role: 'assistant', text: 'Checking', final: false });
    event({ type: 'transcript', role: 'assistant', text: 'On the kitchen table', final: true, transcriptId: 'voice:native:2' });
    expect(archiveCall).not.toHaveBeenCalled(); expect(posts).toEqual([]);
    const closed = once(ws, 'close');
    ws.send(JSON.stringify({ type: 'session.end' })); await closed;
    await waitFor(() => archiveCall.mock.calls.length === 1);
    expect(archiveCall).toHaveBeenCalledExactlyOnceWith({ voiceGrant: GRANT, sessionId: 'native', entries: [
      { transcriptId: 'voice:native:1', role: 'user', text: 'Find my glasses' },
      { transcriptId: 'voice:native:2', role: 'assistant', text: 'On the kitchen table' },
      { transcriptId: 'voice:native:3', role: 'user', text: 'Final words on close' },
    ], truncated: false, fetchImpl: deps.fetchImpl });
    expect(deps.endGrant).not.toHaveBeenCalled();
    expect(nativeWs.close.mock.invocationCallOrder[0]).toBeLessThan(archiveCall.mock.invocationCallOrder[0]);
    if (outcome === 'rejected') rejectArchive(new Error(`Archive denied: ${GRANT}`));
    else finishArchive({ postId: POST_ID, channelId: outcome === 'wrong-channel' ? 'foreign' : CHANNEL, threadRootPostId, userId: 'a'.repeat(26) });
    await waitFor(() => (deps.endGrant as ReturnType<typeof vi.fn>).mock.calls.length === 1);
    if (outcome === 'posted') expect(log).toHaveBeenCalledWith('voice archive posted', expect.objectContaining({ postId: POST_ID }));
    else expect(log).toHaveBeenCalledWith('voice archive failed', expect.anything());
    expect(JSON.stringify(log.mock.calls)).not.toContain(GRANT);
    expect(nativeWs.close).toHaveBeenCalledOnce();
    expect(rpc.call).toHaveBeenCalledWith('talk.session.close', { sessionId: 'native', disposition: 'detach' });
  });
  it('closes a timed-out native call with an active grant for its bounded final archive', async () => {
    const expiry = captureVoiceExpiry();
    const nativeWs = Object.assign(new EventEmitter(), { close: vi.fn() });
    const rpc = { call: vi.fn(async () => ({ ok: true, result: { sessionId: 'native', relaySessionId: 'native' } })), dispose: vi.fn() };
    let nativeSession: NativeTalkSession | undefined;
    let grantExpiresAt = 0;
    const archiveTimes: number[] = [];
    const archiveCall = vi.fn(async () => {
      archiveTimes.push(Date.now());
      if (Date.now() >= grantExpiresAt) throw new Error('voice_grant_forbidden');
      return { postId: POST_ID, channelId: CHANNEL, threadRootPostId, userId: 'a'.repeat(26) };
    });
    const log = vi.fn();
    const { base, deps } = await serverWith({ nativeVoiceEnabled: true, archiveCall, log,
      createNativeSession: options => nativeSession = new NativeTalkSession({ ...options, open: vi.fn().mockResolvedValue({ ws: nativeWs, scopes: new Set(['operator.talk']) }), attachRpc: () => rpc as any }),
      resolveConversation: async ({ uid, gatewayId, channelId }) => ({ uid, gatewayId, channelId, threadRootPostId, workspaceSlug: 'mom', agentId: 'mom-coach', sessionKey: SESSION_KEY, callerMmUserId: 'b'.repeat(26), nativeInterrupt: true }),
    });
    const ticket = await deps.runtimeBroker.redeemOpenClawWs(TICKET, 'voice-ws');
    if (ticket.kind !== 'redeemed' || typeof ticket.redeemed.voiceGrantExpiresAt !== 'number') throw new Error('fixture');
    grantExpiresAt = ticket.redeemed.voiceGrantExpiresAt;
    const ws = new WebSocket(`${base}/api/voice/ws/${TICKET}`); await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'session.start', protocol: 1, mode: 'converse', channelId: CHANNEL, threadRootPostId }));
    await waitFor(() => nativeSession?.boundNativeSessionId === 'native');
    nativeWs.emit('message', Buffer.from(JSON.stringify({ type: 'event', event: 'talk.event', payload: {
      relaySessionId: 'native', type: 'transcript', role: 'user', text: 'Keep this record', final: true, transcriptId: 'voice:native:1',
    } })));
    vi.spyOn(Date, 'now').mockReturnValue(expiry.scheduledAt + expiry.delay + 1);
    const closed = once(ws, 'close');
    expiry.callback();
    await closed;
    await waitFor(() => (deps.endGrant as ReturnType<typeof vi.fn>).mock.calls.length === 1);
    expect(archiveCall).toHaveBeenCalledOnce();
    expect(archiveTimes[0] + 5_000).toBeLessThan(grantExpiresAt);
    expect(log).toHaveBeenCalledWith('voice archive posted', expect.objectContaining({ postId: POST_ID }));
    expect(log).not.toHaveBeenCalledWith('voice archive failed', expect.anything());
    expect(nativeWs.close).toHaveBeenCalledOnce();
    expect(deps.endGrant).toHaveBeenCalledOnce();
    expect(archiveCall.mock.invocationCallOrder[0]).toBeLessThan((deps.endGrant as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]);
  });
  it('does not expose readiness or audio while legacy grant binding is pending, including a late bind after close', async () => {
    let resolveBind!: (binding: Awaited<ReturnType<NonNullable<VoiceWsRouteDeps['bindGrant']>>>) => void;
    const bindGrant = vi.fn(() => new Promise<Awaited<ReturnType<NonNullable<VoiceWsRouteDeps['bindGrant']>>>>(resolve => { resolveBind = resolve; }));
    const { base, deps, relay } = await serverWith({ bindGrant });
    const ws = new WebSocket(`${base}/api/voice/ws/${TICKET}`);
    const messages: string[] = [];
    ws.on('message', data => messages.push(data.toString()));
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'session.start', protocol: 1, mode: 'converse', channelId: CHANNEL, threadRootPostId }));
    await waitFor(() => bindGrant.mock.calls.length === 1);
    ws.send(JSON.stringify({ type: 'listen.start' })); ws.send(Buffer.alloc(2));
    expect(relay.stts).toHaveLength(0);
    expect(messages.some(message => message.includes('session.ready'))).toBe(false);
    ws.close(); await once(ws, 'close');
    resolveBind({ ...await deps.resolveConversation!({ uid: 'uid-mom', gatewayId: 'gw-mom', channelId: CHANNEL, threadRootPostId }), sessionId: 'late', expiresAt: Date.now() + 30_000 });
    await waitFor(() => (deps.endGrant as ReturnType<typeof vi.fn>).mock.calls.length === 1);
    expect(messages.some(message => message.includes('session.ready'))).toBe(false);
  });
  it('revokes a grant when legacy binding fails without logging the raw grant', async () => {
    const log = vi.fn();
    const { base, deps } = await serverWith({ bindGrant: vi.fn(async () => { throw new Error(`bad ${GRANT}`); }), log });
    const ws = new WebSocket(`${base}/api/voice/ws/${TICKET}`);
    await once(ws, 'open');
    const closed = firstEventThenClose(ws);
    ws.send(JSON.stringify({ type: 'session.start', protocol: 1, mode: 'converse', channelId: CHANNEL, threadRootPostId }));
    expect((await closed).event).toMatchObject({ type: 'error', recoverable: false });
    expect(deps.endGrant).toHaveBeenCalledOnce();
    expect(JSON.stringify(log.mock.calls)).not.toContain(GRANT);
  });
  it('revokes a redeemed grant if admission rejects before upgrade', async () => {
    const { base, deps } = await serverWith({ isAgentReady: () => false });
    const ws = new WebSocket(`${base}/api/voice/ws/${TICKET}`);
    await firstEventThenClose(ws);
    expect(deps.endGrant).toHaveBeenCalledOnce();
  });
  it('keeps the original Shared grant deadline without waiting for channel startup', async () => {
    const expiry = captureVoiceExpiry();
    const { base, deps } = await serverWith({ nativeVoiceEnabled: false });
    const original = await deps.runtimeBroker.redeemOpenClawWs(TICKET, 'voice-ws');
    if (original.kind !== 'redeemed' || typeof original.redeemed.voiceGrantExpiresAt !== 'number') throw new Error('fixture');
    const ws = new WebSocket(`${base}/api/voice/ws/${TICKET}`);
    await once(ws, 'open');
    expect(expiry.scheduledAt + expiry.delay).toBeGreaterThanOrEqual(original.redeemed.voiceGrantExpiresAt);
    const closed = firstEventThenClose(ws);
    expiry.callback();
    const result = await closed;
    expect(result.event).toMatchObject({ type: 'error', recoverable: false, message: expect.stringContaining('expired') });
    expect(deps.endGrant).toHaveBeenCalledOnce();
  });

  it("refuses unauthorized channel startup without publishing readiness or posting", async () => {
    const { base, posts, deps } = await serverWith({ resolveConversation: vi.fn(async () => { throw new Error('forbidden'); }) });
    const ws = new WebSocket(`${base}/api/voice/ws/${TICKET}`);
    await once(ws, 'open');
    const event = firstEventThenClose(ws);
    ws.send(JSON.stringify({ type: 'session.start', protocol: 1, mode: 'converse', channelId: CHANNEL, threadRootPostId }));
    expect((await event).event).toMatchObject({ type: 'error', recoverable: false });
    expect(deps.resolveConversation).toHaveBeenCalledWith(expect.objectContaining({ uid: 'uid-mom', gatewayId: 'gw-mom', channelId: CHANNEL, threadRootPostId, expectedAgentId: 'mom-coach' }));
    expect(posts).toEqual([]);
  });

  it("refuses a different channel than the one authorized by the voice ticket", async () => {
    const { base, deps } = await serverWith();
    const ws = new WebSocket(`${base}/api/voice/ws/${TICKET}`);
    await once(ws, "open");
    const event = firstEventThenClose(ws);
    ws.send(JSON.stringify({ type: "session.start", protocol: 1, mode: "converse", channelId: 'd'.repeat(26), threadRootPostId }));
    expect((await event).event).toMatchObject({ type: "error", recoverable: false });
    expect(deps.resolveConversation).not.toHaveBeenCalled();
  });
  it("checks the selected workspace owner roster while retaining the member caller identity", async () => {
    const checkUid = vi.fn(() => ({ allow: true as const }));
    const { base } = await serverWith({ upgradeGate: { checkUid } as unknown as VoiceWsRouteDeps["upgradeGate"] });
    const ws = new WebSocket(`${base}/api/voice/ws/${TICKET}`);
    await once(ws, "open"); ws.close();
    expect(checkUid).toHaveBeenCalledWith("uid-owner");
  });

  it('admits native OpenAI independently of the original provider', async () => {
    const createVad = vi.fn(); const handleText = vi.spyOn(NativeTalkSession.prototype, 'handleText').mockImplementation(async function (this: NativeTalkSession) {
      (this as any).options.send({ type: 'session.ready', engines: { stt: 'openai:gpt-live-1', tts: 'openai:gpt-live-1' } });
    });
    const { base, relayStatus } = await serverWith({ nativeVoiceEnabled: true, createVad,
      resolveConversation: async ({ uid, gatewayId, channelId }) => ({ uid, gatewayId, channelId, threadRootPostId, workspaceSlug: 'mom', agentId: 'mom-coach', sessionKey: SESSION_KEY, callerMmUserId: 'b'.repeat(26), nativeInterrupt: true }),
    });
    relayStatus.nativeOpenAi = true; relayStatus.configured = false;
    const ws = new WebSocket(`${base}/api/voice/ws/${TICKET}`); await once(ws, 'open'); const ready = once(ws, 'message');
    ws.send(JSON.stringify({ type: 'session.start', protocol: 1, mode: 'converse', channelId: CHANNEL, threadRootPostId }));
    expect(JSON.parse(String((await ready)[0]))).toMatchObject({ type: 'session.ready', engines: { stt: 'openai:gpt-live-1' } });
    expect(handleText).toHaveBeenCalledOnce(); expect(createVad).not.toHaveBeenCalled(); ws.close(); await once(ws, 'close');
  });

  it.each(['event', 'create'])('selects platform OpenAI and falls back with the same grant after startup %s failure', async failure => {
    const nativeWs = Object.assign(new EventEmitter(), { close: vi.fn() });
    const rpc = { call: vi.fn(async (method: string) => ({ ok: true, result: method === 'talk.session.create' ? { sessionId: 'native', relaySessionId: 'native' } : { sessionId: 'native', sessionKey: SESSION_KEY, expiresAt: Date.now() + 30_000 } })), dispose: vi.fn() };
    if (failure === 'create') rpc.call.mockResolvedValueOnce({ ok: false, reason: 'OpenAI unavailable', error: { code: 'UNAVAILABLE', message: 'OpenAI unavailable' } } as any);
    const log = vi.fn(); const createVad = vi.fn(async () => ({ process: async () => 0, reset: () => undefined }));
    const { base, deps, relayStatus } = await serverWith({ nativeVoiceEnabled: true, createVad, log,
      createNativeSession: options => new NativeTalkSession({ ...options, open: vi.fn().mockResolvedValue({ ws: nativeWs, scopes: new Set(['operator.talk']) }), attachRpc: () => rpc as any }),
      resolveConversation: async ({ uid, gatewayId, channelId }) => ({ uid, gatewayId, channelId, threadRootPostId, workspaceSlug: 'mom', agentId: 'mom-coach', sessionKey: SESSION_KEY, callerMmUserId: 'b'.repeat(26), nativeInterrupt: true }),
    });
    relayStatus.nativeOpenAi = true;
    const ws = new WebSocket(`${base}/api/voice/ws/${TICKET}`); await once(ws, 'open');
    const ready = once(ws, 'message');
    ws.send(JSON.stringify({ type: 'session.start', protocol: 1, mode: 'converse', channelId: CHANNEL, threadRootPostId, settings: { voice: 'cedar' } }));
    if (failure === 'event') {
      await waitFor(() => (deps.bindGrant as ReturnType<typeof vi.fn>).mock.calls.length === 1);
      nativeWs.emit('message', Buffer.from(JSON.stringify({ type: 'event', event: 'talk.event', payload: { relaySessionId: 'native', type: 'error', message: 'OpenAI unavailable' } })));
    }
    const event = JSON.parse(String((await ready)[0]));
    expect(rpc.call).toHaveBeenCalledWith('talk.session.create', expect.objectContaining({ provider: 'octogee-openai', sessionKey: SESSION_KEY }));
    expect(event).toMatchObject({ type: 'session.ready', sessionId: failure === 'event' ? 'native' : expect.any(String), input: { sampleRate: 16000 }, engines: { stt: 'fake-stt', tts: 'fake-tts' }, settings: { voice: '' } });
    expect(createVad).toHaveBeenCalledOnce();
    expect(deps.bindGrant).toHaveBeenCalledWith(expect.objectContaining({ voiceGrant: GRANT, sessionId: event.sessionId }));
    expect(deps.endGrant).not.toHaveBeenCalled();
    expect(nativeWs.close).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith('OpenAI voice startup failed; using original voice', expect.objectContaining({ reason: 'OpenAI unavailable' }));
    const messages: Array<Record<string, unknown>> = [];
    ws.on('message', data => messages.push(JSON.parse(String(data))));
    ws.send(JSON.stringify({ type: 'settings.update', settings: { voice: 'marin' } }));
    await waitFor(() => messages.some(message => message.type === 'settings'));
    expect(messages.find(message => message.type === 'settings')).toMatchObject({ settings: { voice: '' } });
    ws.close(); await once(ws, 'close');
  });
  it('keeps shared gateways on the original engine and clears unsupported OpenAI voice IDs', async () => {
    const createNativeSession = vi.fn();
    const { base, relayStatus } = await serverWith({ nativeVoiceEnabled: false, createNativeSession }); relayStatus.nativeOpenAi = true;
    const ws = new WebSocket(`${base}/api/voice/ws/${TICKET}`); await once(ws, 'open');
    const ready = once(ws, 'message');
    ws.send(JSON.stringify({ type: 'session.start', protocol: 1, mode: 'converse', channelId: CHANNEL, threadRootPostId, settings: { voice: 'cedar' } }));
    expect(JSON.parse(String((await ready)[0]))).toMatchObject({ type: 'session.ready', input: { sampleRate: 16000 }, settings: { voice: '' } });
    expect(createNativeSession).not.toHaveBeenCalled(); ws.close(); await once(ws, 'close');
  });

  it('revokes the grant when native Talk closes without another browser message', async () => {
    const handleText = vi.spyOn(NativeTalkSession.prototype, 'handleText').mockResolvedValue();
    const { base, deps } = await serverWith({ nativeVoiceEnabled: true,
      resolveConversation: async ({ uid, gatewayId, channelId }) => ({ uid, gatewayId, channelId, threadRootPostId, workspaceSlug: 'mom', agentId: 'mom-coach', sessionKey: `agent:mom-coach:mattermost:channel:${channelId}`, callerMmUserId: 'b'.repeat(26), nativeInterrupt: true }),
    });
    const ws = new WebSocket(`${base}/api/voice/ws/${TICKET}`);
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'session.start', protocol: 1, mode: 'converse', channelId: CHANNEL, threadRootPostId }));
    await waitFor(() => handleText.mock.calls.length === 1);
    (handleText.mock.contexts[0] as NativeTalkSession).close();
    try {
      await vi.waitFor(() => expect(deps.endGrant).toHaveBeenCalledOnce(), { timeout: 100 });
      await vi.waitFor(() => expect(ws.readyState).toBe(WebSocket.CLOSED));
    } finally { ws.close(); }
  });

  it("revokes a native connection when native control is disabled and never loads legacy VAD", async () => {
    const handleText = vi.spyOn(NativeTalkSession.prototype, "handleText").mockResolvedValue();
    const createVad = vi.fn(async () => ({ process: async () => 0, reset: () => undefined }));
    let allowed = true;
    const { base } = await serverWith({ nativeVoiceEnabled: true, createVad, conversationCheckMs: 5,
      resolveConversation: async ({ uid, gatewayId, channelId }) => ({ uid, gatewayId, channelId, threadRootPostId, workspaceSlug: "mom", agentId: "mom-coach", sessionKey: `agent:mom-coach:mattermost:channel:${channelId}`, callerMmUserId: "b".repeat(26), nativeInterrupt: allowed }),
    });
    const ws = new WebSocket(`${base}/api/voice/ws/${TICKET}`);
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "session.start", protocol: 1, mode: "converse", channelId: CHANNEL, threadRootPostId }));
    await waitFor(() => handleText.mock.calls.length === 1);
    const closed = Promise.race([
      once(ws, "close").then(([, reason]) => String(reason)),
      new Promise<string>((resolve) => setTimeout(() => { ws.close(); resolve("timed out"); }, 250)),
    ]);
    allowed = false;
    expect(await closed).toBe("conversation-revoked");
    expect(createVad).not.toHaveBeenCalled();
  });

  it("closes an already-open voice session when workspace or live channel membership is revoked", async () => {
    const handleText = vi.spyOn(NativeTalkSession.prototype, "handleText").mockResolvedValue();
    let member = true;
    const { base } = await serverWith({ nativeVoiceEnabled: true, conversationCheckMs: 5,
      resolveConversation: async ({ uid, gatewayId, channelId }) => {
        if (!member) throw new Error("Workspace or channel membership removed");
        return { uid, gatewayId, channelId, threadRootPostId, workspaceSlug: "mom", agentId: "mom-coach", sessionKey: `agent:mom-coach:mattermost:channel:${channelId}`, callerMmUserId: "b".repeat(26), nativeInterrupt: true };
      },
    });
    const ws = new WebSocket(`${base}/api/voice/ws/${TICKET}`);
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "session.start", protocol: 1, mode: "converse", channelId: CHANNEL, threadRootPostId }));
    await waitFor(() => handleText.mock.calls.length === 1);
    const closed = once(ws, "close");
    member = false;
    expect(String((await closed)[1])).toBe("conversation-revoked");
  });

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
    ws.send(JSON.stringify({ type: "session.start", protocol: TALK_PROTOCOL_VERSION, mode: "converse", channelId: CHANNEL, threadRootPostId }));
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
    ws.send(JSON.stringify({ type: "session.start", protocol: TALK_PROTOCOL_VERSION, mode: "converse", channelId: CHANNEL, threadRootPostId }));
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
    next.send(JSON.stringify({ type: "session.start", protocol: TALK_PROTOCOL_VERSION, mode: "converse", channelId: CHANNEL, threadRootPostId }));
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
    ws.send(JSON.stringify({ type: "session.start", protocol: TALK_PROTOCOL_VERSION, mode: "converse", channelId: CHANNEL, threadRootPostId }));
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
    expect(posts[0]).toMatchObject({ voiceGrant: GRANT, sessionId: expect.any(String), text: "Where are my glasses?", turnId: expect.any(String) });
    expect(posts[0]).not.toHaveProperty("uid");
    expect(posts[0]).not.toHaveProperty("gatewayId");
    expect(posts[0]).not.toHaveProperty("channelId");
    expect(JSON.stringify(posts[0])).not.toContain("mmToken");
    const session = SESSION_KEY;
    const agentEvent = (runId: string, stream: string, data: Record<string, unknown>) =>
      source.emit("mom-coach", { kind: "agent", runId, stream, ts: Date.now(), sessionKey: session, data });
    agentEvent("run-typed", "lifecycle", { phase: "start" });
    agentEvent("run-typed", "assistant", { delta: "This answers a typed message, not the voice turn. " });
    agentEvent("run-typed", "lifecycle", { phase: "end" });
    source.emit("mom-coach", { kind: "inbound", messageId: POST_ID, sessionKey: session, ts: Date.now() });
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
