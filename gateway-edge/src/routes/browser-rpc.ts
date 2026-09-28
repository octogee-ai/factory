import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { browserRecord } from './browser-policy.js';
export class NativeBrowserError extends Error {
  constructor(readonly details: Record<string, unknown>) { super(typeof details.message === 'string' ? details.message : 'Native Browser request failed'); }
}
export function browserRpc(ws: WebSocket, onEvent?: (frame: Record<string, unknown>) => void) {
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  const close = () => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Native Browser disconnected')); }
    pending.clear();
  };
  ws.on('close', close);
  ws.on('message', data => {
    let frame: Record<string, unknown> | null;
    try { frame = browserRecord(JSON.parse(data.toString())); } catch { return; }
    if (frame?.type === 'event') { onEvent?.(frame); return; }
    if (frame?.type !== 'res' || typeof frame.id !== 'string') return;
    const item = pending.get(frame.id); if (!item) return;
    pending.delete(frame.id); clearTimeout(item.timer);
    if (frame.ok === true) item.resolve(frame.payload);
    else item.reject(new NativeBrowserError(browserRecord(frame.error) ?? { code: 'UNAVAILABLE', message: 'Native Browser failed' }));
  });
  return {
    call(method: string, params: Record<string, unknown>, timeoutMs = 35000): Promise<unknown> {
      if (pending.size >= 16) return Promise.reject(new Error('Too many Browser requests'));
      return new Promise((resolve, reject) => {
        const id = randomUUID();
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Native Browser request timed out')); }, timeoutMs); timer.unref();
        pending.set(id, { resolve, reject, timer });
        try { ws.send(JSON.stringify({ type: 'req', id, method, params })); }
        catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
      });
    },
    close() { close(); ws.close(); },
  };
}
