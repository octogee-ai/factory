import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { scanWorkingTree } from '../ci/working-tree-scan.mjs';

const gitleaks = execFileSync('/usr/bin/which', ['gitleaks'], { encoding: 'utf8' }).trim();
const config = resolve(import.meta.dirname, '../../../.gitleaks.toml');
it.each(['tests/new.spec.ts', 'app/src/__tests__/new.spec.ts', 'templates/brain-context/NEW.md'])('scans new credentials in %s', file => {
  const root = mkdtempSync(join(tmpdir(), 'ci-secret-boundary-'));
  try {
    const target = join(root, file);
    mkdirSync(resolve(target, '..'), { recursive: true });
    const key = 'ghp_' + createHash('sha256').update('synthetic public-readiness test').digest('hex').slice(0, 36);
    writeFileSync(target, `const token = "${key}";\n`);
    const result = spawnSync(gitleaks, ['dir', '.', `--config=${config}`, '--redact', '--exit-code=1'], { cwd: root, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
function fixture(run: (root: string, git: (...args: string[]) => void) => void) {
  const root = mkdtempSync(join(tmpdir(), 'ci-secret-fixture-'));
  const git = (...args: string[]) => { execFileSync('/usr/bin/git', args, { cwd: root, stdio: 'pipe' }); };
  try {
    git('init', '-b', 'main');
    git('config', 'user.name', 'CI fixture');
    git('config', 'user.email', 'ci@example.invalid');
    writeFileSync(join(root, '.gitignore'), 'ignored\nnode_modules\n');
    writeFileSync(join(root, 'source.js'), 'export const enabled = true;\n');
    git('add', '.');
    git('commit', '-m', 'clean');
    run(root, git);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
it.each(['staged', 'unstaged', 'untracked'])('rejects a credential in %s local source even when commit scanning is clean', mode => {
  fixture((root, git) => {
    const key = 'ghp_' + createHash('sha256').update('synthetic scanner test only').digest('hex').slice(0, 36);
    writeFileSync(join(root, mode === 'untracked' ? 'new file.js' : 'source.js'), `export const token = "${key}";\n`);
    if (mode === 'staged') git('add', '.');
    const committed = spawnSync(gitleaks, ['detect', `--config=${config}`, '--source=.', '--redact', '--exit-code=1'], { cwd: root, encoding: 'utf8' });
    expect(committed.status).toBe(0);
    scanWorkingTree(root, (directory: string) => {
      const working = spawnSync(gitleaks, ['detect', '--no-git', `--config=${config}`, '--source=.', '--redact', '--exit-code=1'], { cwd: directory, encoding: 'utf8' });
      expect(working.status, working.stderr).toBe(1);
    });
  });
});
it('copies current source, excludes ignored files and git metadata, and scans symlink text without following it', () => {
  fixture(root => {
    writeFileSync(join(root, 'ignored'), 'private');
    writeFileSync(join(root, 'source.js'), 'edited');
    symlinkSync(join(root, 'ignored'), join(root, 'link'));
    scanWorkingTree(root, (directory: string) => {
      expect(readFileSync(join(directory, 'source.js'), 'utf8')).toBe('edited');
      expect(existsSync(join(directory, 'ignored'))).toBe(false);
      expect(existsSync(join(directory, '.git'))).toBe(false);
      expect(readFileSync(join(directory, 'link'), 'utf8')).toBe(join(root, 'ignored'));
    });
  });
});
