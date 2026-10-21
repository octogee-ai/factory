import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { exportSource, snapshot, worktreeSource } from '../ci/snapshot.mjs';

function repository() {
  const root = mkdtempSync(join(tmpdir(), 'ci-snapshot-test-'));
  const git = (...args: string[]) => execFileSync('/usr/bin/git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'CI fixture');
  git('config', 'user.email', 'ci@example.invalid');
  writeFileSync(join(root, 'input'), 'first');
  git('add', '.');
  git('commit', '-m', 'first');
  const first = git('rev-parse', 'HEAD');
  writeFileSync(join(root, 'input'), 'second');
  git('commit', '-am', 'second');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  return { root, first, second: git('rev-parse', 'HEAD') };
}

it.each(['clean', 'edited', 'untracked', 'ignored'])('builds the selected commit in a pristine worktree when the checkout is %s', state => {
  const { root, first } = repository();
  try {
    writeFileSync(join(root, '.git', 'info', 'exclude'), 'ignored-artifact.tgz\n');
    if (state === 'edited') writeFileSync(join(root, 'input'), 'edited');
    if (state === 'untracked') writeFileSync(join(root, 'new file'), 'new');
    if (state === 'ignored') writeFileSync(join(root, 'ignored-artifact.tgz'), 'stale');
    const copy = worktreeSource(root, first);
    expect(copy.source).not.toBe(root);
    expect(execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: copy.source, encoding: 'utf8' }).trim()).toBe(first);
    expect(execFileSync('/usr/bin/git', ['merge-base', '--is-ancestor', first, 'origin/main'], { cwd: copy.source }).toString()).toBe('');
    expect(readFileSync(join(copy.source, 'input'), 'utf8')).toBe('first');
    for (const file of ['new file', 'ignored-artifact.tgz']) expect(existsSync(join(copy.source, file))).toBe(false);
    copy.remove();
    expect(existsSync(copy.source)).toBe(false);
    expect(execFileSync('/usr/bin/git', ['worktree', 'list', '--porcelain'], { cwd: root, encoding: 'utf8' })).not.toContain(copy.source);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('exports a disposable copy of the selected commit that deployment can mutate freely', () => {
  const { root, first } = repository();
  try {
    writeFileSync(join(root, 'untracked'), 'local');
    const copy = exportSource(root, first);
    expect(copy.source).not.toBe(root);
    expect(readFileSync(join(copy.source, 'input'), 'utf8')).toBe('first');
    expect(existsSync(join(copy.source, 'untracked'))).toBe(false);
    writeFileSync(join(copy.source, 'input'), 'deploy mutation');
    copy.remove();
    expect(existsSync(copy.source)).toBe(false);
    expect(readFileSync(join(root, 'input'), 'utf8')).toBe('second');
    expect(execFileSync('/usr/bin/git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' })).toBe('');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

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
