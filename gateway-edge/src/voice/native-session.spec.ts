import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { NativeTalkSession } from './native-session.js';
import type { openNativeUserSocket } from '../openclaw-control/native-user-client.js';
const grant = 'g'.repeat(43);
const expiresAt = Date.now() + 60_000;
const key = `agent:octogee-alice-coach:mattermost:group:${'a'.repeat(26)}`;
function setup() {
  const ws = Object.assign(new EventEmitter(), { close: vi.fn() });
  const rpc = { call: vi.fn<(method: string, params: Record<string, unknown>) => Promise<{ ok: true; result: Record<string, unknown> }>>().mockImplementation(async (method: string) => ({ ok: true, result: method === 'talk.session.create' ? { sessionId: 'native', relaySessionId: 'native' } : method === 'octogee.voice.bind' ? { sessionId: 'native', sessionKey: key, expiresAt } : { ok: true } })), dispose: vi.fn() };
  const send = vi.fn(); const audio = vi.fn(); const reauthorize = vi.fn<() => Promise<void>>().mockResolvedValue();
  const log = vi.fn();
  const open = vi.fn<typeof openNativeUserSocket>().mockResolvedValue({ ws, scopes: new Set(['operator.talk']) } as any);
  const session = new NativeTalkSession({ voiceGrant: grant, voiceGrantExpiresAt: expiresAt, conversation: { uid: 'u', gatewayId: 'b-alice', sessionKey: key, agentId: 'octogee-alice-coach' }, send, sendAudio: audio, open, attachRpc: () => rpc as any, reauthorize, log });
  const event = (payload: object) => ws.emit('message', Buffer.from(JSON.stringify({ type: 'event', event: 'talk.event', payload: { relaySessionId: 'native', ...payload } })));
  return { session, ws, rpc, send, audio, event, reauthorize, log, open };
}
const start = JSON.stringify({ type: 'session.start', protocol: 1, mode: 'converse', channelId: 'a'.repeat(26) });
describe('native Talk transport', () => {
  it('initializes only the authorized native channel before creating Talk', async () => {
    const h = setup();
    await h.session.handleText(start);
    expect(h.open.mock.calls.map(([uid, gatewayId, , options]) => ({ uid, gatewayId, options }))).toEqual([{ uid: 'u', gatewayId: 'b-alice', options: { caps: ['ui-commands'], channelSessionKey: key } }]);
    expect(h.reauthorize.mock.invocationCallOrder[0]).toBeLessThan(h.open.mock.invocationCallOrder[0]);
    expect(h.open.mock.invocationCallOrder[0]).toBeLessThan(h.rpc.call.mock.invocationCallOrder[0]);
    h.session.close();
  });
  it('does not create Talk when native channel provenance is rejected', async () => {
    const h = setup();
    h.open.mockRejectedValueOnce(new Error('Native channel membership synchronization failed'));
    await expect(h.session.handleText(start)).rejects.toThrow('membership synchronization failed');
    expect(h.rpc.call).not.toHaveBeenCalled();
  });
  it('closes a late native connection without creating Talk after ending during channel synchronization', async () => {
    const h = setup();
    let connected!: (value: Awaited<ReturnType<typeof openNativeUserSocket>>) => void;
    h.open.mockReturnValueOnce(new Promise(resolve => { connected = resolve; }));
    const opening = h.session.handleText(start);
    await vi.waitFor(() => expect(h.open).toHaveBeenCalledOnce());
    h.session.close();
    connected({ ws: h.ws, scopes: new Set(['operator.talk']) } as any);
    await opening;
    expect(h.ws.close).toHaveBeenCalledOnce();
    expect(h.rpc.call).not.toHaveBeenCalled();
  });
  it('withholds readiness and audio until the exact native session grant is acknowledged', async () => {
    const h = setup();
    let bound!: (value: { ok: true; result: Record<string, unknown> }) => void;
    h.rpc.call.mockImplementation(async method => {
      if (method === 'talk.session.create') return { ok: true, result: { sessionId: 'native', relaySessionId: 'native' } };
      return new Promise(resolve => { bound = resolve; });
    });
    const opening = h.session.handleText(start);
    await vi.waitFor(() => expect(h.rpc.call).toHaveBeenCalledWith('octogee.voice.bind', { voiceGrant: grant, sessionId: 'native' }));
    h.event({ type: 'ready' });
    h.event({ type: 'audio', audioBase64: 'AQI=' });
    h.session.handleAudio(Buffer.alloc(2));
    expect(h.send).not.toHaveBeenCalled();
    expect(h.audio).not.toHaveBeenCalled();
    expect(h.rpc.call).not.toHaveBeenCalledWith('talk.session.appendAudio', expect.anything());
    bound({ ok: true, result: { sessionId: 'native', sessionKey: key, expiresAt } });
    await opening;
    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'session.ready' }));
    expect(h.audio).toHaveBeenCalledOnce();
    expect(JSON.stringify(h.send.mock.calls)).not.toContain(grant);
    h.session.close();
  });
  it.each(['error', 'close'])('discards startup readiness and audio queued after native %s during grant binding', async type => {
    const h = setup();
    let bound!: (value: { ok: true; result: Record<string, unknown> }) => void;
    h.rpc.call.mockImplementation(async method => method === 'talk.session.create'
      ? { ok: true, result: { sessionId: 'native', relaySessionId: 'native' } }
      : new Promise(resolve => { bound = resolve; }));
    const opening = h.session.handleText(start);
    await vi.waitFor(() => expect(h.rpc.call).toHaveBeenCalledWith('octogee.voice.bind', { voiceGrant: grant, sessionId: 'native' }));
    h.event({ type, message: 'Native startup failed' });
    h.event({ type: 'ready' });
    h.event({ type: 'audio', audioBase64: 'AQI=' });
    bound({ ok: true, result: { sessionId: 'native', sessionKey: key, expiresAt } });
    await opening;
    expect(h.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: 'error', recoverable: false }));
    expect(h.audio).not.toHaveBeenCalled();
    expect(h.session.currentState).toBe('closed');
    expect(h.ws.close).toHaveBeenCalledOnce();
  });
  it.each([
    { sessionId: 'wrong', sessionKey: key, expiresAt },
    { sessionId: 'native', sessionKey: 'wrong', expiresAt },
    { sessionId: 'native', sessionKey: key, expiresAt: 1 },
    { sessionId: 'native', sessionKey: key, expiresAt: expiresAt + 1 },
  ])('rejects an invalid native grant binding %j without publishing readiness', async binding => {
    const h = setup();
    h.rpc.call.mockImplementation(async method => {
      h.event({ type: 'ready' });
      return { ok: true, result: method === 'talk.session.create' ? { sessionId: 'native', relaySessionId: 'native' } : binding };
    });
    await expect(h.session.handleText(start)).rejects.toThrow('grant binding');
    expect(h.session.currentState).toBe('closed');
    expect(h.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'session.ready' }));
  });
  it('does not publish readiness for a late successful grant binding after close', async () => {
    const h = setup();
    let bound!: (value: { ok: true; result: Record<string, unknown> }) => void;
    h.rpc.call.mockImplementation(async method => method === 'talk.session.create'
      ? { ok: true, result: { sessionId: 'native', relaySessionId: 'native' } }
      : new Promise(resolve => { bound = resolve; }));
    const opening = h.session.handleText(start);
    await vi.waitFor(() => expect(h.rpc.call).toHaveBeenCalledTimes(2));
    h.event({ type: 'ready' });
    h.session.close();
    bound({ ok: true, result: { sessionId: 'native', sessionKey: key, expiresAt } });
    await opening;
    expect(h.send).not.toHaveBeenCalled();
    expect(h.session.currentState).toBe('closed');
  });
  it('does not expose a grant when native binding rejects with sensitive details', async () => {
    const h = setup();
    h.rpc.call.mockImplementation(async method => {
      if (method === 'talk.session.create') return { ok: true, result: { sessionId: 'native', relaySessionId: 'native' } };
      throw new Error(`Rejected secret ${grant}`);
    });
    await expect(h.session.handleText(start)).rejects.toThrow('grant binding');
    expect(h.session.currentState).toBe('closed');
    expect(h.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: 'error', recoverable: false }));
    expect(JSON.stringify([h.log.mock.calls, h.send.mock.calls])).not.toContain(grant);
  });
  it('rejects a duplicate session start while native authorization is pending', async () => {
    const h = setup();
    let authorize!: () => void;
    h.reauthorize.mockReturnValueOnce(new Promise<void>((resolve) => { authorize = resolve; }));
    const opening = h.session.handleText(start);
    await expect(h.session.handleText(start)).rejects.toThrow('already started');
    authorize(); await opening;
    expect(h.rpc.call).toHaveBeenCalledTimes(2);
    h.session.close();
  });
  it('reports native standard endpointing when an older saved patient setting is supplied', async () => {
    const h = setup();
    await h.session.handleText(JSON.stringify({ ...JSON.parse(start), settings: { endpointing: 'patient' } }));
    h.event({ type: 'ready' });
    expect(h.rpc.call).toHaveBeenCalledWith('talk.session.create', expect.objectContaining({ silenceDurationMs: 700 }));
    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'session.ready', settings: expect.objectContaining({ endpointing: 'normal' }) }));
    h.session.close();
  });
  it('creates the server-authorized canonical conversation and forwards only its audio', async () => {
    const h = setup(); await h.session.handleText(start); h.event({ type: "ready" });
    expect(h.rpc.call).toHaveBeenCalledWith('talk.session.create', expect.objectContaining({ sessionKey: key, transport: 'gateway-relay', brain: 'agent-consult' }));
    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'session.ready', input: { sampleRate: 24000 }, capabilities: expect.objectContaining({ bargeIn: true }) }));
    h.event({ type: 'audio', audioBase64: Buffer.from([0,1]).toString('base64'), talkEvent: { turnId: 'turn' } }); expect(h.audio).toHaveBeenCalledWith(Buffer.from([0,1]));
    h.ws.emit('message', Buffer.from(JSON.stringify({ type: 'event', event: 'talk.event', payload: { relaySessionId: 'other', type: 'audio', audioBase64: 'AQI=' } }))); expect(h.audio).toHaveBeenCalledTimes(1);
    h.session.close();
  });
  it('acknowledges only marks issued on the current native connection', async () => {
    const h = setup(); await h.session.handleText(start); h.event({ type: "ready" });
    await h.session.handleText(JSON.stringify({ type: 'playback.mark', name: 'forged' }));
    expect(h.rpc.call).not.toHaveBeenCalledWith('talk.session.acknowledgeMark', expect.anything());
    h.event({ type: 'mark', markName: 'm1' }); await h.session.handleText(JSON.stringify({ type: 'playback.mark', name: 'm1' }));
    expect(h.rpc.call).toHaveBeenCalledWith('talk.session.acknowledgeMark', { sessionId: 'native', markName: 'm1' }); h.session.close();
  });
  it('uses exact native Talk run cancellation separately from speech-only cancellation', async () => {
    const h = setup(); await h.session.handleText(start); h.event({ type: "ready" });
    await h.session.handleText(JSON.stringify({ type: 'speak.cancel' }));
    expect(h.rpc.call).toHaveBeenCalledWith('talk.session.cancelOutput', { sessionId: 'native', reason: 'speech-only' });
    h.rpc.call.mockImplementation(async (method) => ({ ok: true, result: method === 'talk.session.steer' ? { ok: true, aborted: true, sessionKey: key } : { ok: true } }));
    await h.session.handleText(JSON.stringify({ type: 'agent.interrupt', requestId: 'r1' }));
    expect(h.rpc.call).toHaveBeenNthCalledWith(4, 'talk.session.cancelOutput', { sessionId: 'native', reason: 'speech-only' });
    expect(h.rpc.call).toHaveBeenCalledWith('talk.session.steer', { sessionId: 'native', sessionKey: key, text: 'Stop', mode: 'cancel' });
    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'agent.interrupted', status: 'aborted', requestId: 'r1' })); h.session.close();
  });
  it('refuses false interruption success while a native run is pending even after speech clears', async () => {
    const h = setup(); await h.session.handleText(start); h.event({ type: 'ready' });
    h.event({ type: 'transcript', role: 'user', text: 'Open the news', final: true });
    h.rpc.call.mockImplementation(async (method) => {
      if (method === 'talk.session.cancelOutput') h.event({ type: 'clear' });
      return { ok: true, result: method === 'talk.session.steer' ? { ok: true, aborted: false, reason: 'no_active_run', sessionKey: key } : { ok: true } };
    });
    await h.session.handleText(JSON.stringify({ type: 'agent.interrupt', requestId: 'pending' }));
    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'agent.interrupted', requestId: 'pending', status: 'failed' }));
    h.session.close();
  });
  it('rejects interruption after channel authority is revoked', async () => {
    const h = setup(); await h.session.handleText(start); h.event({ type: 'ready' });
    h.reauthorize.mockRejectedValueOnce(new Error('Conversation access was revoked'));
    await h.session.handleText(JSON.stringify({ type: 'agent.interrupt', requestId: 'revoked' }));
    expect(h.rpc.call).not.toHaveBeenCalledWith('talk.session.steer', expect.anything());
    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'agent.interrupted', requestId: 'revoked', status: 'failed', message: 'Conversation access was revoked' }));
    h.session.close();
  });
  it('forwards presentation only with an explicit matching conversation scope', async () => {
    const h = setup(); await h.session.handleText(start); h.event({ type: 'ready' });
    const command = { kind: 'panel', panel: 'browser', open: true };
    const deliver = (payload: object) => h.ws.emit('message', Buffer.from(JSON.stringify({ type: 'event', event: 'ui.command', payload })));
    const forwarded = () => h.send.mock.calls.filter(([event]) => event.type === 'ui.command').map(([event]) => event.payload);
    for (const payload of [
      { command },
      { command, agentId: 'octogee-alice-coach' },
      { command, sessionKey: 'agent:other:main' },
      { command, sessionKey: key, agentId: 'other' },
      { command: { kind: 'navigate', sessionKey: 'agent:other:main' }, sessionKey: key },
      { command: { kind: 'navigate', sessionKey: key }, sessionKey: 'agent:other:main' },
      { command, sessionKey: null },
    ]) deliver(payload);
    expect(forwarded()).toEqual([]);
    expect(h.log).toHaveBeenCalledTimes(7);
    const scoped = [
      { command, sessionKey: key },
      { command, agentId: 'octogee-alice-coach', sessionKey: key },
      { command: { kind: 'navigate', sessionKey: key } },
    ];
    for (const payload of scoped) deliver(payload);
    expect(forwarded()).toEqual(scoped);
    h.session.close();
  });
  it.each([
    null, [], 'text', 42, {}, { type: 'res', id: 'broken' },
    { type: 'event' }, { type: 'event', event: 42 },
    { type: 'event', event: 'talk.event' },
    { type: 'event', event: 'talk.event', payload: [] },
    { type: 'event', event: 'talk.event', payload: {} },
    { type: 'event', event: 'talk.event', payload: { relaySessionId: 'native' } },
    { type: 'event', event: 'ui.command', payload: { sessionKey: key, command: [] } },
    { type: 'event', event: 'ui.command', payload: { sessionKey: key, command: 'panel' } },
  ])('fails closed and reports malformed native frame shape %j', async frame => {
    const h = setup(); await h.session.handleText(start); h.event({ type: 'ready' });
    expect(() => h.ws.emit('message', Buffer.from(JSON.stringify(frame)))).not.toThrow();
    expect(h.send).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'error', code: 'internal', recoverable: false, message: expect.stringContaining('malformed') }));
    expect(h.log).toHaveBeenCalledWith('native voice transport failed', expect.objectContaining({ error: expect.stringContaining('malformed') }));
    expect(h.session.currentState).toBe('closed');
    expect(h.ws.close).toHaveBeenCalledOnce();
    expect(h.rpc.dispose).toHaveBeenCalledOnce();
  });
  it.each([
    { type: 'transcript', role: 'user', final: true },
    { type: 'transcript', role: 'tool', text: 'wrong role', final: true },
    { type: 'transcript', role: 'user', text: 'hello', final: 'true' },
    { type: 'audio', audioBase64: 42 },
    { type: 'mark' },
    { type: 'ready', talkEvent: { turnId: 42 } },
  ])('fails closed on a malformed bound Talk event %j', async payload => {
    const h = setup(); await h.session.handleText(start); h.event(payload);
    expect(h.send).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'error', recoverable: false, message: expect.stringContaining('malformed') }));
    expect(h.session.currentState).toBe('closed');
    expect(h.audio).not.toHaveBeenCalled();
  });
  it('cannot revive voice when native creation resolves after a malformed startup event', async () => {
    const h = setup();
    let created!: (value: { ok: true; result: Record<string, unknown> }) => void;
    h.rpc.call.mockReturnValueOnce(new Promise(resolve => { created = resolve; }));
    const opening = h.session.handleText(start);
    await vi.waitFor(() => expect(h.rpc.call).toHaveBeenCalledOnce());
    h.event({ type: 'ready' });
    h.ws.emit('message', Buffer.from('null'));
    expect(h.session.currentState).toBe('closed');
    created({ ok: true, result: { sessionId: 'native', relaySessionId: 'native' } });
    await opening;
    expect(h.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'session.ready' }));
    expect(h.send).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'error', recoverable: false }));
    expect(h.session.currentState).toBe('closed');
  });
  it('ignores valid RPC responses and unrelated events without interrupting voice', async () => {
    const h = setup(); await h.session.handleText(start); h.event({ type: 'ready' });
    h.send.mockClear();
    for (const frame of [
      { type: 'res', id: 'r1', ok: true, payload: { sessionId: 'native' } },
      { type: 'res', id: 'r2', ok: false, error: { code: 'UNAVAILABLE', message: 'request failed' } },
      { type: 'event', event: 'tick' },
      { type: 'event', event: 'presence', payload: [] },
    ]) h.ws.emit('message', Buffer.from(JSON.stringify(frame)));
    expect(h.send).not.toHaveBeenCalled();
    expect(h.ws.close).not.toHaveBeenCalled();
    expect(h.session.currentState).not.toBe('closed');
    h.session.close();
  });
  it('fails the session on a malformed native frame instead of leaving it hanging', async () => {
    const h = setup(); await h.session.handleText(start); h.event({ type: 'ready' });
    h.ws.emit('message', Buffer.from('{not json'));
    expect(h.send).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'error', code: 'internal', recoverable: false, message: expect.stringContaining('malformed') }));
    expect(h.session.currentState).toBe('closed');
    expect(h.ws.close).toHaveBeenCalled();
    expect(h.rpc.dispose).toHaveBeenCalled();
  });
  it('reports voice settings that need a new native session instead of silently claiming they applied', async () => {
    const h = setup(); await h.session.handleText(start); h.event({ type: 'ready' });
    await h.session.handleText(JSON.stringify({ type: 'settings.update', settings: { voice: 'new-voice', endpointing: 'patient' } }));
    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', recoverable: true, message: expect.stringContaining('reconnect') }));
    expect(h.send).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'settings', settings: expect.objectContaining({ endpointing: 'normal' }) }));
    h.session.close();
  });

});
