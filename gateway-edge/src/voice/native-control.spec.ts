import { describe, expect, it, vi } from 'vitest';
import { interruptNativeVoiceRun } from './native-control.js';

const target = { uid: 'u1', gatewayId: 'gw1', agentId: 'scout', sessionKey: 'agent:scout:mattermost:channel:channel1', runId: 'run1' };
function client(result: unknown) {
  return { call: vi.fn(async () => ({ ok: true as const, result })), close: vi.fn() };
}

describe('native voice interruption', () => {
  it('cancels the exact native run as the authenticated user and waits for acknowledgement', async () => {
    let resolve!: (value: unknown) => void;
    const native = { call: vi.fn<(method: string, params: unknown) => Promise<unknown>>().mockImplementation(() => new Promise((done) => { resolve = done; })), close: vi.fn() };
    const open = vi.fn<(uid: string, gatewayId: string) => Promise<typeof native>>().mockResolvedValue(native);
    let settled = false;
    const result = interruptNativeVoiceRun(target, { open: open as never }).then((value) => { settled = true; return value; });
    await Promise.resolve();
    expect(open).toHaveBeenCalledWith('u1', 'gw1');
    expect(native.call).toHaveBeenCalledWith('sessions.abort', { key: target.sessionKey, agentId: 'scout', runId: 'run1', clearQueued: true });
    expect(settled).toBe(false);
    resolve({ ok: true, result: { ok: true, status: 'aborted', abortedRunId: 'run1' } });
    await expect(result).resolves.toEqual({ status: 'aborted', runId: 'run1' });
    expect(native.close).toHaveBeenCalledOnce();
  });

  it('accepts native confirmation that the exact run already ended', async () => {
    const native = client({ ok: true, status: 'no-active-run', abortedRunId: null });
    await expect(interruptNativeVoiceRun(target, { open: async () => native as never })).resolves.toEqual({ status: 'no-active-run', runId: 'run1' });
  });

  it.each([
    { ok: true, status: 'aborted', abortedRunId: 'other-run' },
    { ok: true, status: 'aborted', abortedRunId: null },
    { ok: false, status: 'aborted', abortedRunId: 'run1' },
    { ok: true, status: 'queued', abortedRunId: 'run1' },
  ])('refuses an invalid native acknowledgement without claiming the agent stopped', async (result) => {
    const native = client(result);
    await expect(interruptNativeVoiceRun(target, { open: async () => native as never })).rejects.toThrow('did not confirm');
    expect(native.close).toHaveBeenCalledOnce();
  });

  it('reports native refusal and closes its connection', async () => {
    const native = { call: vi.fn(async () => ({ ok: false as const, reason: 'permission changed' })), close: vi.fn() };
    await expect(interruptNativeVoiceRun(target, { open: async () => native as never })).rejects.toThrow('permission changed');
    expect(native.close).toHaveBeenCalledOnce();
  });
});
