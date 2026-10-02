import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isValidUsername } from '@octogee/shared/types/identity';

export const VOICE_MIGRATION_PATH = '/internal/openclaw/voice/v1/migration';
const HOLD_TAKEOVER_AFTER_MS = 120_000;

export function createVoiceMigrationRegistry({ now = Date.now }: { now?: () => number } = {}) {
  const calls = new Map<string, Set<symbol>>();
  const holds = new Map<string, { operationId: string; takeoverAfter: number }>();
  return {
    begin(slug: string): (() => void) | null {
      if (holds.has(slug)) return null;
      const id = Symbol(slug);
      const active = calls.get(slug) ?? new Set<symbol>();
      calls.set(slug, active); active.add(id);
      return () => {
        if (!active.delete(id)) return;
        if (active.size === 0) calls.delete(slug);
      };
    },
    hold(slug: string, operationId: string): number {
      const current = holds.get(slug);
      if (current && current.operationId !== operationId && current.takeoverAfter > now()) throw new Error('voice admission held by another migration');
      holds.set(slug, { operationId, takeoverAfter: now() + HOLD_TAKEOVER_AFTER_MS });
      return calls.get(slug)?.size ?? 0;
    },
    resume(slug: string, operationId: string): number {
      const current = holds.get(slug);
      if (current && current.operationId !== operationId) throw new Error('voice admission held by another migration');
      holds.delete(slug);
      return calls.get(slug)?.size ?? 0;
    },
  };
}

export type VoiceMigrationRegistry = ReturnType<typeof createVoiceMigrationRegistry>;

function writeJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function authorized(req: IncomingMessage, gatewayToken: string): boolean {
  const peer = req.socket.remoteAddress?.replace(/^::ffff:/, '');
  const supplied = Buffer.from(req.headers.authorization ?? '');
  const expected = Buffer.from(`Bearer ${gatewayToken}`);
  return (peer === '127.0.0.1' || peer === '::1') && supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function parseMigration(body: unknown): { slug: string; operationId: string; phase: 'hold' | 'resume' } | null {
  const { slug, operationId, phase } = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  if (typeof slug !== 'string' || !isValidUsername(slug) || typeof operationId !== 'string' || !operationId || operationId.length > 256 || (phase !== 'hold' && phase !== 'resume')) return null;
  return { slug, operationId, phase };
}

async function readMigration(req: IncomingMessage, res: ServerResponse): Promise<ReturnType<typeof parseMigration>> {
  let raw = ''; let size = 0;
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > 1024) { req.resume(); writeJson(res, 413, { error: 'body_too_large' }); return null; }
    raw += chunk.toString();
  }
  let body: unknown;
  try { body = JSON.parse(raw); } catch { writeJson(res, 422, { error: 'invalid_json' }); return null; }
  const input = parseMigration(body);
  if (!input) writeJson(res, 422, { error: 'invalid_voice_migration' });
  return input;
}

export function createVoiceMigrationHandler({ gatewayToken, registry }: { gatewayToken: string; registry: VoiceMigrationRegistry }) {
  if (!gatewayToken.trim()) throw new Error('voice migration gateway token is required');
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!authorized(req, gatewayToken)) { req.resume(); writeJson(res, 401, { error: 'unauthorized' }); return; }
    if (req.method !== 'POST') { req.resume(); writeJson(res, 405, { error: 'method_not_allowed' }); return; }
    const input = await readMigration(req, res);
    if (!input) return;
    try { writeJson(res, 200, { activeCalls: registry[input.phase](input.slug, input.operationId) }); }
    catch { writeJson(res, 409, { error: 'voice_migration_owner_changed' }); }
  };
}
