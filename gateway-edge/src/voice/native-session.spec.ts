import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { NativeTalkSession } from './native-session.js';
const key = `agent:octogee-alice-coach:mattermost:group:${'a'.repeat(26)}`;
function setup() {
  const ws = Object.assign(new EventEmitter(), { close: vi.fn() });
  const rpc = { call: vi.fn<(method: string, params: Record<string, unknown>) => Promise<{ ok: true; result: Record<string, unknown> }>>().mockImplementation(async (method: string) => ({ ok: true, result: method === 'talk.session.create' ? { sessionId: 'native', relaySessionId: 'native' } : { ok: true } })), dispose: vi.fn() };
  const send = vi.fn(); const audio = vi.fn(); const reauthorize = vi.fn<() => Promise<void>>().mockResolvedValue();
  const session = new NativeTalkSession({ conversation: { uid: 'u', gatewayId: 'b-alice', sessionKey: key, agentId: 'octogee-alice-coach' }, send, sendAudio: audio, open: async () => ({ ws, scopes: new Set(['operator.talk']) }) as any, attachRpc: () => rpc as any, reauthorize, log: vi.fn() });
  const event = (payload: object) => ws.emit('message', Buffer.from(JSON.stringify({ type: 'event', event: 'talk.event', payload: { relaySessionId: 'native', ...payload } })));
  return { session, ws, rpc, send, audio, event, reauthorize };
}
const start = JSON.stringify({ type: 'session.start', protocol: 1, mode: 'converse', channelId: 'a'.repeat(26) });
describe('native Talk transport', () => {
  it('rejects a duplicate session start while native authorization is pending', async () => {
    const h = setup();
    let authorize!: () => void;
    h.reauthorize.mockReturnValueOnce(new Promise<void>((resolve) => { authorize = resolve; }));
    const opening = h.session.handleText(start);
    await expect(h.session.handleText(start)).rejects.toThrow('already started');
    authorize(); await opening;
    expect(h.rpc.call).toHaveBeenCalledTimes(1);
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
    expect(h.rpc.call).toHaveBeenNthCalledWith(3, 'talk.session.cancelOutput', { sessionId: 'native', reason: 'speech-only' });
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
  it('forwards presentation commands scoped to the bound conversation or carried only by its dedicated connection', async () => {
    const h = setup(); await h.session.handleText(start); h.event({ type: 'ready' });
    const command = { type: 'panel', panel: 'browser', open: true };
    const deliver = (payload: object) => h.ws.emit('message', Buffer.from(JSON.stringify({ type: 'event', event: 'ui.command', payload })));
    const forwarded = () => h.send.mock.calls.filter(([event]) => event.type === 'ui.command').map(([event]) => event.payload);
    deliver({ command, sessionKey: 'agent:other:main' });
    deliver({ command, agentId: 'other' });
    deliver({ command: { type: 'navigate', sessionKey: 'agent:other:main' } });
    deliver({ agentId: 'octogee-alice-coach', command: { ...command, sessionKey: 'agent:other:main' } });
    deliver({ command: 'panel' });
    deliver({ sessionKey: key });
    expect(forwarded()).toEqual([]);
    deliver({ command, sessionKey: key });
    deliver({ command, agentId: 'octogee-alice-coach' });
    deliver({ command });
    expect(forwarded()).toEqual([{ command, sessionKey: key }, { command, agentId: 'octogee-alice-coach' }, { command }]);
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
