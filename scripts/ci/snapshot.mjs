import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export function snapshot(root, { sha = 'HEAD', working = false } = {}) {
  const temporary = mkdtempSync(join(tmpdir(), 'octogee-source-'));
  const source = join(temporary, 'source');
  const git = (cwd, args) => execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8' });
  try {
    const commit = git(root, ['rev-parse', '--verify', `${sha}^{commit}`]).trim();
    git(root, ['clone', '--no-hardlinks', '--quiet', '--no-checkout', root, source]);
    git(source, ['checkout', '--quiet', '--detach', commit]);
    git(source, ['update-ref', 'refs/remotes/origin/main', git(root, ['rev-parse', 'origin/main']).trim()]);
    if (working) {
      const patch = git(root, ['diff', '--binary', 'HEAD']);
      if (patch) execFileSync('/usr/bin/git', ['apply', '-'], { cwd: source, input: patch });
      const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
      for (const file of untracked) {
        mkdirSync(dirname(join(source, file)), { recursive: true });
        cpSync(join(root, file), join(source, file), { dereference: false });
      }
    }
    return { source, remove: () => rmSync(temporary, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}
