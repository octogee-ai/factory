import { latestNativeBrowserTab } from '../vendor/openclaw-browser-resources/index.js';
import { browserRecord } from './browser-policy.js';
export interface NativeBrowserTab { tab: { target: 'host'; profile: string; targetId: string }; revision: string }
export function nativeBrowserResource(frame: Record<string, unknown>, binding: { agentId: string; sessionKey: string }, profile: string): NativeBrowserTab | null {
  const payload = browserRecord(frame.payload);
  if (frame.event !== 'session.message' || payload?.sessionKey !== binding.sessionKey || payload.agentId !== binding.agentId) return null;
  const message = browserRecord(payload.message);
  return message ? latestNativeBrowserTab([{ ...message, messageId: payload.messageId }], profile) : null;
}
