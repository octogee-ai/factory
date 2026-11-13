import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { exportSource, snapshot, sourceCiScript, worktreeSource } from '../ci/snapshot.mjs';

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

function superproject() {
  const directory = mkdtempSync(join(tmpdir(), 'ci-snapshot-submodule-test-'));
  const run = (cwd: string, ...args: string[]) => execFileSync('/usr/bin/git', ['-c', 'user.name=CI fixture', '-c', 'user.email=ci@example.invalid', '-c', 'commit.gpgSign=false', '-c', 'protocol.file.allow=always', ...args], { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  const upstream = join(directory, 'upstream');
  const root = join(directory, 'root');
  run(directory, 'init', '-q', '-b', 'main', upstream);
  writeFileSync(join(upstream, 'library'), 'pinned');
  mkdirSync(join(upstream, 'scripts', 'ci'), { recursive: true });
  writeFileSync(join(upstream, 'scripts', 'ci', 'run-main.mjs'), '');
  run(upstream, 'add', '.');
  run(upstream, 'commit', '-qm', 'pinned');
  const pinned = run(upstream, 'rev-parse', 'HEAD');
  writeFileSync(join(upstream, 'library'), 'newer');
  run(upstream, 'commit', '-qam', 'newer');
  run(directory, 'init', '-q', '-b', 'main', root);
  writeFileSync(join(root, 'input'), 'committed');
  run(root, 'submodule', 'add', '-q', upstream, 'platform');
  run(join(root, 'platform'), 'checkout', '-q', pinned);
  run(root, 'add', '.');
  run(root, 'commit', '-qm', 'fixture');
  run(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  return { directory, root, pinned, head: run(root, 'rev-parse', 'HEAD'), run };
}

const read = (source: string, file: string) => readFileSync(join(source, file), 'utf8');

it.each([
  ['snapshot', (root: string, sha: string) => snapshot(root, { sha })],
  ['worktree', (root: string, sha: string) => worktreeSource(root, sha)],
  ['export', (root: string, sha: string) => exportSource(root, sha)],
])('materializes the pinned platform submodule in a %s source', (_, materialize) => {
  const fixture = superproject();
  try {
    writeFileSync(join(fixture.root, 'platform', 'library'), 'local edit');
    const copy = materialize(fixture.root, fixture.head);
    try {
      expect(read(copy.source, 'input')).toBe('committed');
      expect(read(copy.source, 'platform/library')).toBe('pinned');
    } finally { copy.remove(); }
    expect(existsSync(copy.source)).toBe(false);
  } finally { rmSync(fixture.directory, { recursive: true, force: true }); }
});

it.each([
  ['worktree', (root: string, sha: string) => worktreeSource(root, sha)],
  ['export', (root: string, sha: string) => exportSource(root, sha)],
])('resolves CI scripts inside the platform submodule of a %s source', (_, materialize) => {
  const fixture = superproject();
  try {
    const copy = materialize(fixture.root, fixture.head);
    try {
      expect(sourceCiScript(copy.source, 'run-main.mjs')).toBe('platform/scripts/ci/run-main.mjs');
    } finally { copy.remove(); }
  } finally { rmSync(fixture.directory, { recursive: true, force: true }); }
});

it('carries the checked-out platform commit, its edits and its new files into a working snapshot', () => {
  const fixture = superproject();
  try {
    const platform = join(fixture.root, 'platform');
    fixture.run(platform, 'checkout', '-q', 'main');
    writeFileSync(join(platform, 'added'), 'untracked');
    writeFileSync(join(fixture.root, 'input'), 'edited');
    const clean = snapshot(fixture.root);
    try {
      expect(read(clean.source, 'platform/library')).toBe('pinned');
      expect(existsSync(join(clean.source, 'platform/added'))).toBe(false);
    } finally { clean.remove(); }
    const working = snapshot(fixture.root, { working: true });
    try {
      expect(read(working.source, 'input')).toBe('edited');
      expect(read(working.source, 'platform/library')).toBe('newer');
      expect(read(working.source, 'platform/added')).toBe('untracked');
      writeFileSync(join(platform, 'library'), 'uncommitted');
    } finally { working.remove(); }
    const edited = snapshot(fixture.root, { working: true });
    try {
      expect(read(edited.source, 'platform/library')).toBe('uncommitted');
    } finally { edited.remove(); }
  } finally { rmSync(fixture.directory, { recursive: true, force: true }); }
});

it.each(['snapshot', 'worktree', 'export'])('refuses a %s source when the platform submodule is not initialized', kind => {
  const fixture = superproject();
  try {
    fixture.run(fixture.root, 'submodule', 'deinit', '-q', '--force', 'platform');
    const materialize = { snapshot: () => snapshot(fixture.root), worktree: () => worktreeSource(fixture.root, fixture.head), export: () => exportSource(fixture.root, fixture.head) }[kind]!;
    expect(materialize).toThrow(/platform is not initialized/);
    expect(fixture.run(fixture.root, 'worktree', 'list', '--porcelain')).not.toContain('octogee-worktree-');
  } finally { rmSync(fixture.directory, { recursive: true, force: true }); }
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
