import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('opts the disposable image provisioner into a full Omarchy package upgrade', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'computer-upgrade-'));
  try {
    const probe = path.join(dir, 'invocation');
    writeFileSync(path.join(dir, 'pacman'), '#!/bin/sh\nprintf "%s\\n" "${OMARCHY_ALLOW_DIRECT_PACMAN:-}" "$@" > "$UPGRADE_PROBE"\nexit 42\n', { mode: 0o755 });
    const source = readFileSync(path.resolve('../infra/desktop/image/customize.sh'), 'utf8');
    const script = path.join(dir, 'customize.sh');
    writeFileSync(script, source.replaceAll('/tmp/pacman.log', path.join(dir, 'pacman.log')));
    const result = spawnSync('bash', [script], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, OMARCHY_VERSION: 'test', IMAGE_NAME: 'test', UPGRADE_PROBE: probe, OMARCHY_ALLOW_DIRECT_PACMAN: '' },
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    const [optIn, ...args] = readFileSync(probe, 'utf8').trimEnd().split('\n');
    expect(optIn).toBe('1');
    expect(args).toContain('-Syu');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
