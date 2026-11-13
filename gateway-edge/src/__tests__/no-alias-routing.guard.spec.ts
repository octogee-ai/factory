import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';

// Scope: gateway-edge/src only — deliberately. gateway-edge is the only service
// that synthesizes gateway cluster-DNS. octogee-api and the browser route by the
// `/api/g/<gid>` path; glm-controller reads `internalUrl` from Firestore. If any
// other service ever starts building gateway DNS, widen this walk to cover it too.
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The bare Service alias `octogee-gateway.<ns>.svc.cluster.local` (note the DOT
// right after "octogee-gateway") round-robins a request to a RANDOM user's
// pod. Per-instance routing uses `octogee-gateway-<instance>.…` (a DASH) or the
// `/api/g/<gid>` path. Client-routing code must never build the bare alias.
// The char class after the dot covers alnum + `$` (template `${ns}`) + quote and
// backtick, so literal, template, AND string-concat (`'octogee-gateway.' + ns`)
// forms all trip it; the per-instance DASH form never has a dot here.
const BARE_ALIAS = /octogee-gateway\.[a-z0-9$'"`]/i;

function tsSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === '__tests__') continue;
      out.push(...tsSources(full));
      continue;
    }
    if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) out.push(full);
  }
  return out;
}

describe('no-alias routing guard (GATEWAY-ROUTING-PATTERN D4)', () => {
  it('no gateway-edge source constructs the bare octogee-gateway round-robin alias', () => {
    const offenders: string[] = [];
    for (const file of tsSources(SRC)) {
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (BARE_ALIAS.test(line)) {
          offenders.push(`${file.replace(SRC, 'src')}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('flags every bare-alias construction form (literal/template/concat), never the per-instance dash form', () => {
    // literal, template, and string-concat reconstructions all trip the guard
    expect(BARE_ALIAS.test('http://octogee-gateway.octogee.svc.cluster.local:18789')).toBe(true);
    expect(BARE_ALIAS.test('`http://octogee-gateway.${ns}.svc`')).toBe(true);
    expect(BARE_ALIAS.test("'octogee-gateway.' + namespace")).toBe(true);
    expect(BARE_ALIAS.test('`octogee-gateway.` + ns')).toBe(true);
    // per-instance routing + the bare Service name are legitimate, never flagged
    expect(BARE_ALIAS.test('octogee-gateway-walter.octogee.svc.cluster.local')).toBe(false);
    expect(BARE_ALIAS.test('name: octogee-gateway')).toBe(false);
  });
});
