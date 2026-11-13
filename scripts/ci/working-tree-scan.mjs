import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const listed = (cwd, args) => execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8' }).split('\0').filter(Boolean);

function sourceFiles(root, prefix = '') {
  const directory = join(root, prefix);
  const gitlinks = new Set(listed(directory, ['ls-files', '--stage', '-z'])
    .filter(record => record.startsWith('160000 '))
    .map(record => record.slice(record.indexOf('\t') + 1)));
  return listed(directory, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).flatMap(file => {
    const path = join(prefix, file);
    if (!gitlinks.has(file)) return [path];
    if (!existsSync(join(root, path, '.git'))) throw new Error(`Submodule ${path} is not initialized; run git submodule update --init --recursive`);
    return sourceFiles(root, path);
  });
}

export function scanWorkingTree(root, scan) {
  const directory = mkdtempSync(join(tmpdir(), 'octogee-secret-scan-'));
  try {
    for (const file of new Set(sourceFiles(root))) {
      const source = join(root, file);
      let metadata;
      try { metadata = lstatSync(source); }
      catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      const target = join(directory, file);
      mkdirSync(dirname(target), { recursive: true });
      if (metadata.isSymbolicLink()) writeFileSync(target, readlinkSync(source));
      else if (metadata.isFile()) copyFileSync(source, target);
      else throw new Error(`Unexpected secret-scan source type: ${file}`);
    }
    return scan(directory);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.cwd();
  const gitleaks = execFileSync('/usr/bin/which', ['gitleaks'], { encoding: 'utf8' }).trim();
  scanWorkingTree(root, directory => execFileSync(gitleaks, ['detect', '--no-git', `--config=${join(root, '.gitleaks.toml')}`, '--source=.', '--redact', '--exit-code=1'], { cwd: directory, stdio: 'inherit' }));
}
