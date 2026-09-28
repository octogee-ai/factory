export interface TerminalConversation { agentId: string; sessionKey: string }

export class TerminalConversationScope {
  private readonly pending = new Map<string, string>();
  private readonly sessions = new Set<string>();
  constructor(private readonly binding: TerminalConversation) {}

  request(raw: string): string | null {
    const frame = JSON.parse(raw);
    const params = frame.params ?? {};
    if (this.pending.size >= 64 || this.pending.has(frame.id)) return null;
    if (frame.method === 'terminal.open') {
      if ((params.agentId !== undefined && params.agentId !== this.binding.agentId) || params.sessionKey !== undefined) return null;
      frame.params = { ...params, ...this.binding };
    } else if (frame.method !== 'terminal.list' && !this.sessions.has(params.sessionId)) return null;
    this.pending.set(frame.id, frame.method);
    return JSON.stringify(frame);
  }

  response(raw: string): string | null {
    const frame = JSON.parse(raw);
    if (frame.type === 'event') return this.sessions.has(frame.payload?.sessionId) ? raw : null;
    const method = this.pending.get(frame.id);
    if (!method) return null;
    this.pending.delete(frame.id);
    if (frame.ok && method === 'terminal.list') {
      const sessions = Array.isArray(frame.payload?.sessions) ? frame.payload.sessions.filter((item: Record<string, unknown>) =>
        item.owner === `agent:${this.binding.sessionKey}` && item.agentId === this.binding.agentId && typeof item.sessionId === 'string') : [];
      this.sessions.clear();
      sessions.forEach((item: { sessionId: string }) => this.sessions.add(item.sessionId));
      return JSON.stringify({ ...frame, payload: { sessions } });
    }
    if (frame.ok && method === 'terminal.open') {
      if (frame.payload?.agentId !== this.binding.agentId || typeof frame.payload?.sessionId !== 'string') {
        return JSON.stringify({ type: 'res', id: frame.id, ok: false, error: { code: 'INVALID_SESSION', message: 'Native terminal returned a different owner' } });
      }
      this.sessions.add(frame.payload.sessionId);
    }
    return raw;
  }
}
