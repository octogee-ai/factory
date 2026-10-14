import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { snapshot } from '../ci/snapshot.mjs';

it('publishes committed bytes but checks changed and non-ignored new files locally', () => {
  const root = mkdtempSync(join(tmpdir(), 'ci-snapshot-test-'));
  const git = (...args: string[]) => execFileSync('/usr/bin/git', args, { cwd: root, stdio: 'pipe' });
  try {
    git('init', '-b', 'main');
    git('config', 'user.name', 'CI fixture');
    git('config', 'user.email', 'ci@example.invalid');
    writeFileSync(join(root, '.gitignore'), 'ignored\n');
    writeFileSync(join(root, 'input'), 'committed');
    git('add', '.');
    git('commit', '-m', 'fixture');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    writeFileSync(join(root, 'input'), 'edited');
    writeFileSync(join(root, 'new file'), 'new');
    writeFileSync(join(root, 'ignored'), 'private');
    for (const working of [false, true]) {
      const copy = snapshot(root, { working });
      try {
        expect(readFileSync(join(copy.source, 'input'), 'utf8')).toBe(working ? 'edited' : 'committed');
        expect(existsSync(join(copy.source, 'new file'))).toBe(working);
        expect(existsSync(join(copy.source, 'ignored'))).toBe(false);
      } finally { copy.remove(); }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
