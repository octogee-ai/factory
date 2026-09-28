import { describe, expect, it } from 'vitest';
import { TerminalConversationScope } from './terminal-conversation.js';
const binding = { agentId: 'coach', sessionKey: 'agent:coach:mattermost:group:channel' };
const req = (id: string, method: string, params = {}) => JSON.stringify({ type: 'req', id, method, params });
const res = (id: string, payload: unknown) => JSON.stringify({ type: 'res', id, ok: true, payload });
describe('conversation-owned native terminals', () => {
  it('injects canonical session ownership and refuses client-selected ownership', () => {
    const scope = new TerminalConversationScope(binding);
    expect(JSON.parse(scope.request(req('1', 'terminal.open', { cols: 80, rows: 24 }))!)).toMatchObject({ params: { ...binding, cols: 80, rows: 24 } });
    expect(scope.request(req('2', 'terminal.open', { agentId: 'other', cols: 80, rows: 24 }))).toBeNull();
  });
  it('only lists and attaches shells owned by this exact native session', () => {
    const scope = new TerminalConversationScope(binding);
    scope.request(req('1', 'terminal.list'));
    const sessions = [{ sessionId: 'own', agentId: 'coach', owner: `agent:${binding.sessionKey}` }, { sessionId: 'foreign', agentId: 'coach', owner: 'conn' }];
    expect(JSON.parse(scope.response(res('1', { sessions }))!).payload.sessions).toEqual([sessions[0]]);
    expect(scope.request(req('2', 'terminal.attach', { sessionId: 'foreign' }))).toBeNull();
    expect(scope.request(req('3', 'terminal.attach', { sessionId: 'own' }))).not.toBeNull();
    expect(scope.response(JSON.stringify({ type: 'event', event: 'terminal.data', payload: { sessionId: 'foreign', data: 'secret' } }))).toBeNull();
  });
  it('tracks a newly opened native shell and discards unrelated responses', () => {
    const scope = new TerminalConversationScope(binding);
    scope.request(req('1', 'terminal.open', { cols: 80, rows: 24 }));
    expect(scope.response(res('1', { sessionId: 'new', agentId: 'coach' }))).not.toBeNull();
    expect(scope.request(req('2', 'terminal.input', { sessionId: 'new', data: 'ls\n' }))).not.toBeNull();
    expect(scope.response(res('unasked', {}))).toBeNull();
  });
});
