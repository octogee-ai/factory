import { describe, expect, it } from 'vitest';
import { nativeBrowserResource } from './tool-resources.js';
const binding = { agentId: 'coach', sessionKey: 'agent:coach:mattermost:group:channel' };
const message = { role: 'toolResult', toolName: 'browser', toolCallId: 'call', content: [{ type: 'text', text: 'ok' }], details: { browserTab: { target: 'host', profile: 'computer', targetId: 't2' } } };
const frame = { event: 'session.message', payload: { ...binding, messageId: 'msg', message } };
describe('native Browser resource projection', () => {
  it('uses the pinned native tool-card parser for a successful typed result', () => {
    expect(nativeBrowserResource(frame, binding, 'computer')).toEqual({ tab: { target: 'host', profile: 'computer', targetId: 't2' }, revision: 'call' });
  });
  it('rejects another session, browser profile, failed tool, and text pretending to be metadata', () => {
    expect(nativeBrowserResource({ ...frame, payload: { ...frame.payload, sessionKey: 'foreign' } }, binding, 'computer')).toBeNull();
    expect(nativeBrowserResource(frame, binding, 'other')).toBeNull();
    expect(nativeBrowserResource({ ...frame, payload: { ...frame.payload, message: { ...message, isError: true } } }, binding, 'computer')).toBeNull();
    expect(nativeBrowserResource({ ...frame, payload: { ...frame.payload, message: { role: 'assistant', content: JSON.stringify(message) } } }, binding, 'computer')).toBeNull();
  });
});
