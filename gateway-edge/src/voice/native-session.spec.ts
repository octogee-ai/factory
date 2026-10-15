import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { NativeTalkSession } from './native-session.js';
import type { openNativeUserSocket } from '../openclaw-control/native-user-client.js';
const grant = 'g'.repeat(43);
const expiresAt = Date.now() + 60_000;
const threadRootPostId = 'r'.repeat(26);
const key = `agent:octogee-alice-coach:mattermost:group:${'a'.repeat(26)}`;
function setup(options: Partial<ConstructorParameters<typeof NativeTalkSession>[0]> = {}) {
  const ws = Object.assign(new EventEmitter(), { close: vi.fn() });
  const rpc = { call: vi.fn<(method: string, params: Record<string, unknown>) => Promise<{ ok: true; result: Record<string, unknown> }>>().mockImplementation(async (method: string) => ({ ok: true, result: method === 'talk.session.create' ? { sessionId: 'native', relaySessionId: 'native' } : { ok: true } })), dispose: vi.fn() };
  const send = vi.fn(); const audio = vi.fn(); const reauthorize = vi.fn<() => Promise<void>>().mockResolvedValue();
  const bindSession = vi.fn<ConstructorParameters<typeof NativeTalkSession>[0]['bindSession']>().mockResolvedValue({ sessionId: 'native', sessionKey: key, expiresAt });
  const log = vi.fn();
  const open = vi.fn<typeof openNativeUserSocket>().mockResolvedValue({ ws, scopes: new Set(['operator.talk']) } as any);
  const session = new NativeTalkSession({ voiceGrant: grant, voiceGrantExpiresAt: expiresAt, conversation: { uid: 'u', gatewayId: 'b-alice', sessionKey: key, agentId: 'octogee-alice-coach', threadRootPostId }, send, sendAudio: audio, open, attachRpc: () => rpc as any, reauthorize, bindSession, log, ...options });
  const event = (payload: object) => ws.emit('message', Buffer.from(JSON.stringify({ type: 'event', event: 'talk.event', payload: { relaySessionId: 'native', ...payload } })));
  return { session, ws, rpc, send, audio, event, reauthorize, bindSession, log, open };
}
const start = JSON.stringify({ type: 'session.start', protocol: 1, mode: 'converse', channelId: 'a'.repeat(26), threadRootPostId });
describe('native Talk transport', () => {
  it('binds the exact created session through the central owner without a fork-only native RPC', async () => {
    const h = setup();
    await h.session.handleText(start);
    expect(h.bindSession).toHaveBeenCalledExactlyOnceWith('native');
    expect(h.rpc.call.mock.calls.map(([method]) => method)).toEqual(['talk.session.create']);
    expect(h.rpc.call.mock.invocationCallOrder[0]).toBeLessThan(h.bindSession.mock.invocationCallOrder[0]);
    h.session.close();
  });
  it('selects OpenAI Live with the same canonical coach and reports its duplex engine', async () => {
    const h = setup({ provider: 'octogee-openai' });
    await h.session.handleText(start); h.event({ type: 'ready' });
    expect(h.rpc.call).toHaveBeenCalledWith('talk.session.create', expect.objectContaining({ provider: 'octogee-openai', sessionKey: key, brain: 'agent-consult' }));
    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'session.ready', engines: { stt: 'openai:gpt-live-1', tts: 'openai:gpt-live-1' }, capabilities: expect.objectContaining({ bargeIn: true }) }));
    h.session.close();
  });
  it('falls back only after grant binding when OpenAI fails before readiness', async () => {
    const onUnavailable = vi.fn(); const onClose = vi.fn();
    const h = setup({ provider: 'octogee-openai', onUnavailable, onClose });
    await h.session.handleText(start);
    h.event({ type: 'error', message: 'OpenAI unavailable' });
    expect(onUnavailable).toHaveBeenCalledExactlyOnceWith('native', 'OpenAI unavailable');
    expect(h.send).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(h.session.currentState).toBe('closed');
  });
  it('falls back from an unavailable create RPC using a fresh session ID for broker binding', async () => {
    const onUnavailable = vi.fn(); const onClose = vi.fn();
    const h = setup({ provider: 'octogee-openai', onUnavailable, onClose });
    h.rpc.call.mockResolvedValueOnce({ ok: false, reason: 'OpenAI unavailable', error: { code: 'UNAVAILABLE', message: 'OpenAI unavailable' } } as any);
    await h.session.handleText(start);
    expect(onUnavailable).toHaveBeenCalledExactlyOnceWith(h.session.sessionId, 'OpenAI unavailable');
    expect(h.send).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
    expect(h.rpc.call).toHaveBeenCalledOnce(); expect(h.session.boundNativeSessionId).toBeUndefined();
    expect(h.ws.close).toHaveBeenCalledOnce();
  });
  it('does not start fallback when a late creation failure arrives after voice ends', async () => {
    const onUnavailable = vi.fn(); const h = setup({ provider: 'octogee-openai', onUnavailable });
    let rejectCreation!: (response: any) => void;
    h.rpc.call.mockReturnValueOnce(new Promise(resolve => { rejectCreation = resolve; }));
    const opening = h.session.handleText(start);
    await vi.waitFor(() => expect(h.rpc.call).toHaveBeenCalledOnce());
    h.session.close();
    rejectCreation({ ok: false, reason: 'OpenAI unavailable', error: { code: 'UNAVAILABLE', message: 'OpenAI unavailable' } });
    await opening;
    expect(onUnavailable).not.toHaveBeenCalled(); expect(h.send).not.toHaveBeenCalled();
  });
  it('never falls back from a create RPC authorization rejection', async () => {
    const onUnavailable = vi.fn(); const h = setup({ provider: 'octogee-openai', onUnavailable });
    h.rpc.call.mockResolvedValueOnce({ ok: false, reason: 'Not authorized', error: { code: 'INVALID_REQUEST', message: 'Not authorized' } } as any);
    await expect(h.session.handleText(start)).rejects.toThrow('Not authorized');
    expect(onUnavailable).not.toHaveBeenCalled(); h.session.close();
  });
  it('keeps OpenAI failures fatal after readiness to avoid repeating an active turn', async () => {
    const onUnavailable = vi.fn(); const h = setup({ provider: 'octogee-openai', onUnavailable });
    await h.session.handleText(start); h.event({ type: 'ready' });
    h.event({ type: 'error', message: 'OpenAI disconnected' });
    expect(onUnavailable).not.toHaveBeenCalled();
    expect(h.send).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'error', recoverable: false }));
  });
  it('never falls back on a rejected grant even if an OpenAI failure was queued', async () => {
    const onUnavailable = vi.fn(); const h = setup({ provider: 'octogee-openai', onUnavailable });
    h.rpc.call.mockImplementation(async method => {
      if (method === 'talk.session.create') { h.event({ type: 'error', message: 'OpenAI unavailable' }); return { ok: true, result: { sessionId: 'native', relaySessionId: 'native' } }; }
      return { ok: true, result: {} };
    });
    h.bindSession.mockRejectedValueOnce(new Error('Grant rejected'));
    await expect(h.session.handleText(start)).rejects.toThrow('grant binding');
    expect(onUnavailable).not.toHaveBeenCalled();
  });
  it('initializes only the authorized native channel before creating Talk', async () => {
    const h = setup();
    await h.session.handleText(start);
    expect(h.open.mock.calls.map(([uid, gatewayId, , options]) => ({ uid, gatewayId, options }))).toEqual([{ uid: 'u', gatewayId: 'b-alice', options: { caps: ['ui-commands'], channelSessionKey: key, threadRootPostId } }]);
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
    let bound!: (value: Awaited<ReturnType<typeof h.bindSession>>) => void;
    h.bindSession.mockReturnValueOnce(new Promise(resolve => { bound = resolve; }));
    const opening = h.session.handleText(start);
    await vi.waitFor(() => expect(h.bindSession).toHaveBeenCalledExactlyOnceWith('native'));
    h.event({ type: 'ready' });
    h.event({ type: 'audio', audioBase64: 'AQI=' });
    h.session.handleAudio(Buffer.alloc(2));
    expect(h.send).not.toHaveBeenCalled();
    expect(h.audio).not.toHaveBeenCalled();
    expect(h.rpc.call).not.toHaveBeenCalledWith('talk.session.appendAudio', expect.anything());
    bound({ sessionId: 'native', sessionKey: key, expiresAt });
    await opening;
    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'session.ready' }));
    expect(h.audio).toHaveBeenCalledOnce();
    expect(JSON.stringify(h.send.mock.calls)).not.toContain(grant);
    h.session.close();
  });
  it.each(['error', 'close'])('discards startup readiness and audio queued after native %s during grant binding', async type => {
    const h = setup();
    let bound!: (value: Awaited<ReturnType<typeof h.bindSession>>) => void;
    h.bindSession.mockReturnValueOnce(new Promise(resolve => { bound = resolve; }));
    const opening = h.session.handleText(start);
    await vi.waitFor(() => expect(h.bindSession).toHaveBeenCalledExactlyOnceWith('native'));
    h.event({ type, message: 'Native startup failed' });
    h.event({ type: 'ready' });
    h.event({ type: 'audio', audioBase64: 'AQI=' });
    bound({ sessionId: 'native', sessionKey: key, expiresAt });
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
    h.rpc.call.mockImplementation(async () => {
      h.event({ type: 'ready' });
      return { ok: true, result: { sessionId: 'native', relaySessionId: 'native' } };
    });
    h.bindSession.mockResolvedValueOnce(binding);
    await expect(h.session.handleText(start)).rejects.toThrow('grant binding');
    expect(h.session.currentState).toBe('closed');
    expect(h.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'session.ready' }));
  });
  it('does not publish readiness for a late successful grant binding after close', async () => {
    const h = setup();
    let bound!: (value: Awaited<ReturnType<typeof h.bindSession>>) => void;
    h.bindSession.mockReturnValueOnce(new Promise(resolve => { bound = resolve; }));
    const opening = h.session.handleText(start);
    await vi.waitFor(() => expect(h.bindSession).toHaveBeenCalledOnce());
    h.event({ type: 'ready' });
    h.session.close();
    bound({ sessionId: 'native', sessionKey: key, expiresAt });
    await opening;
    expect(h.send).not.toHaveBeenCalled();
    expect(h.session.currentState).toBe('closed');
  });
  it('does not expose a grant when native binding rejects with sensitive details', async () => {
    const h = setup();
    h.bindSession.mockRejectedValueOnce(new Error(`Rejected secret ${grant}`));
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
    expect(h.rpc.call).toHaveBeenCalledOnce();
    expect(h.bindSession).toHaveBeenCalledOnce();
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
  it('records only finalized speech from the bound native call, deduplicated by native transcript ID', async () => {
    const h = setup(); await h.session.handleText(start); h.event({ type: 'ready' });
    h.event({ type: 'transcript', role: 'assistant', text: 'Provisional text', final: false });
    h.event({ type: 'transcript', role: 'user', text: 'Find my glasses', final: true, transcriptId: 'voice:native:1' });
    h.event({ type: 'transcript', role: 'user', text: 'Find my glasses', final: true, transcriptId: 'voice:native:1' });
    h.event({ type: 'transcript', role: 'assistant', text: 'On the kitchen table', final: true, textMode: 'snapshot', transcriptId: 'voice:native:2' });
    h.ws.emit('message', Buffer.from(JSON.stringify({ type: 'event', event: 'talk.event', payload: { relaySessionId: 'other', type: 'transcript', role: 'assistant', text: 'Another caller', final: true, transcriptId: 'voice:other:1' } })));
    h.session.close();
    h.event({ type: 'transcript', role: 'assistant', text: 'After detach', final: true, transcriptId: 'voice:native:3' });
    expect(h.session.archive).toEqual({ entries: [
      { transcriptId: 'voice:native:1', role: 'user', text: 'Find my glasses' },
      { transcriptId: 'voice:native:2', role: 'assistant', text: 'On the kitchen table' },
    ], truncated: false });
  });
  it('keeps microphone input flowing while a spoken reply is playing', async () => {
    const h = setup(); await h.session.handleText(start); h.event({ type: 'ready' });
    await h.session.handleText(JSON.stringify({ type: 'listen.start' }));
    h.event({ type: 'audio', audioBase64: 'AQI=' });
    expect(h.session.currentState).toBe('speaking');
    h.session.handleAudio(Buffer.from([3, 4]));
    expect(h.rpc.call).toHaveBeenCalledWith('talk.session.appendAudio', { sessionId: 'native', audioBase64: 'AwQ=' });
    h.session.close();
  });
  it('bounds the compact speech record and visibly marks omitted or clipped speech', async () => {
    const h = setup(); await h.session.handleText(start);
    for (let index = 0; index < 10; index++) h.event({ type: 'transcript', role: 'user', text: 'x'.repeat(2500), final: true, transcriptId: `voice:native:${index}` });
    expect(h.session.archive.entries).toHaveLength(6);
    expect(h.session.archive.entries.map(entry => entry.text.length)).toEqual([2000, 2000, 2000, 2000, 2000, 2000]);
    expect(h.session.archive.truncated).toBe(true);
    h.session.close();
  });
  it('acknowledges only marks issued on the current native connection', async () => {
    const h = setup(); await h.session.handleText(start); h.event({ type: "ready" });
    await h.session.handleText(JSON.stringify({ type: 'playback.mark', name: 'forged' }));
    expect(h.rpc.call).not.toHaveBeenCalledWith('talk.session.acknowledgeMark', expect.anything());
    h.event({ type: 'mark', markName: 'm1' }); await h.session.handleText(JSON.stringify({ type: 'playback.mark', name: 'm1' }));
    expect(h.rpc.call).toHaveBeenCalledWith('talk.session.acknowledgeMark', { sessionId: 'native', markName: 'm1' }); h.session.close();
  });
  it('uses exact native Talk run cancellation without a preliminary output cancel', async () => {
    const h = setup(); await h.session.handleText(start); h.event({ type: "ready" });
    await h.session.handleText(JSON.stringify({ type: 'speak.cancel' }));
    expect(h.rpc.call).toHaveBeenCalledWith('talk.session.cancelOutput', { sessionId: 'native', reason: 'output-cancelled' });
    h.rpc.call.mockImplementation(async (method) => ({ ok: true, result: method === 'talk.session.steer' ? { ok: true, aborted: true, sessionKey: key } : { ok: true } }));
    await h.session.handleText(JSON.stringify({ type: 'agent.interrupt', requestId: 'r1' }));
    expect(h.rpc.call.mock.calls.filter(([method]) => method === 'talk.session.cancelOutput')).toHaveLength(1);
    expect(h.rpc.call).toHaveBeenNthCalledWith(3, 'talk.session.steer', { sessionId: 'native', sessionKey: key, text: 'Stop', mode: 'cancel' });
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
