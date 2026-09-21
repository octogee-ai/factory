import { randomUUID } from "node:crypto";

export const WS_TICKET_TTL_MS = 30_000;

export interface WsTicketStore<S extends object> {
  issue(session: S): { ticket: string; expiresAt: number };
  redeem(ticket: string): S | null;
}

export function createWsTicketStore<S extends object>(
  opts: { now?: () => number; ttlMs?: number } = {},
): WsTicketStore<S> {
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? WS_TICKET_TTL_MS;
  const pending = new Map<string, { session: S; expiresAt: number }>();
  const sweep = () => {
    const t = now();
    for (const [ticket, entry] of pending) {
      if (entry.expiresAt <= t) pending.delete(ticket);
    }
  };
  return {
    issue(session) {
      sweep();
      const ticket = randomUUID();
      const expiresAt = now() + ttlMs;
      pending.set(ticket, { session: { ...session }, expiresAt });
      return { ticket, expiresAt };
    },
    redeem(ticket) {
      const entry = pending.get(ticket);
      if (!entry) return null;
      pending.delete(ticket);
      return entry.expiresAt > now() ? entry.session : null;
    },
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function wsTicketFromPath(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(prefix)) return null;
  const ticket = pathname.slice(prefix.length);
  return UUID_RE.test(ticket) ? ticket : null;
}
