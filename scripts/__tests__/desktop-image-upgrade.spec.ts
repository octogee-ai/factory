import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

it.each([0, 37])('runs migrations as the desktop user and propagates migration status %s', (migrationStatus) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'computer-migration-'));
  try {
    const probe = path.join(dir, 'migration');
    const continued = path.join(dir, 'continued');
    const stubs = {
      pacman: 'exit 0',
      sudo: 'printf "%s\\n" "${OMARCHY_ALLOW_DIRECT_PACMAN:-}" "$@" > "$MIGRATION_PROBE"\nexit "$MIGRATION_STATUS"',
      rm: 'exit 0',
      git: 'touch "$CONTINUATION_PROBE"\nexit 42',
    };
    for (const [name, body] of Object.entries(stubs)) {
      writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    }
    const source = readFileSync(path.resolve('../infra/desktop/image/customize.sh'), 'utf8');
    const script = path.join(dir, 'customize.sh');
    writeFileSync(script, source.replaceAll('/tmp/pacman.log', path.join(dir, 'pacman.log')));
    const result = spawnSync('bash', [script], {
      env: {
        ...process.env, PATH: `${dir}:${process.env.PATH}`, OMARCHY_VERSION: 'test', IMAGE_NAME: 'test',
        OMARCHY_ALLOW_DIRECT_PACMAN: '', MIGRATION_PROBE: probe, MIGRATION_STATUS: String(migrationStatus),
        CONTINUATION_PROBE: continued,
      },
      encoding: 'utf8',
    });
    expect(readFileSync(probe, 'utf8').trimEnd().split('\n')).toEqual(['', '-H', '-u', 'octo', 'bash', '-lc', 'omarchy migrate']);
    expect(result.status).toBe(migrationStatus === 0 ? 42 : migrationStatus);
    expect(existsSync(continued)).toBe(migrationStatus === 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
