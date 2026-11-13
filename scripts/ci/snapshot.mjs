import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { overlayTree } from '../ops/overlay.mjs';

const GIT = '/usr/bin/git';
const git = (cwd, args) => execFileSync(GIT, args, { cwd, encoding: 'utf8' });

function submodules(cwd) {
  if (!existsSync(join(cwd, '.gitmodules'))) return [];
  return git(cwd, ['config', '--file', '.gitmodules', '--null', '--get-regexp', '^submodule\\..*\\.path$'])
    .split('\0').filter(Boolean).map(record => {
      const [key, path] = record.split('\n');
      return { name: key.slice('submodule.'.length, -'.path'.length), path };
    });
}

function initializedSubmodule(root, path) {
  const directory = join(root, path);
  if (!existsSync(join(directory, '.git'))) throw new Error(`Submodule ${path} is not initialized in ${root}; run git submodule update --init --recursive`);
  return directory;
}

function initSubmodules(root, source) {
  for (const { name, path } of submodules(source)) {
    const origin = initializedSubmodule(root, path);
    execFileSync(GIT, ['-c', 'protocol.file.allow=always', '-c', `submodule.${name}.url=${origin}`, 'submodule', 'update', '--init', '--recursive', '--quiet', '--', path], { cwd: source, stdio: ['ignore', 'pipe', 'inherit'] });
  }
}

function carryWorkingTree(from, to) {
  const patch = git(from, ['diff', '--binary', '--ignore-submodules=all', 'HEAD']);
  if (patch) execFileSync(GIT, ['apply', '-'], { cwd: to, input: patch });
  const untracked = git(from, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  for (const file of untracked) {
    mkdirSync(dirname(join(to, file)), { recursive: true });
    cpSync(join(from, file), join(to, file), { dereference: false });
  }
  for (const { path } of submodules(to)) {
    const origin = initializedSubmodule(from, path);
    git(join(to, path), ['checkout', '--quiet', '--detach', git(origin, ['rev-parse', 'HEAD']).trim()]);
    carryWorkingTree(origin, join(to, path));
  }
}

export function snapshot(root, { sha = 'HEAD', working = false } = {}) {
  const temporary = mkdtempSync(join(tmpdir(), 'octogee-source-'));
  const source = join(temporary, 'source');
  try {
    const commit = git(root, ['rev-parse', '--verify', `${sha}^{commit}`]).trim();
    git(root, ['clone', '--no-hardlinks', '--quiet', '--no-checkout', root, source]);
    git(source, ['checkout', '--quiet', '--detach', commit]);
    initSubmodules(root, source);
    git(source, ['update-ref', 'refs/remotes/origin/main', git(root, ['rev-parse', 'origin/main']).trim()]);
    if (working) carryWorkingTree(root, source);
    return { source, remove: () => rmSync(temporary, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

export function worktreeSource(root, sha) {
  const temporary = mkdtempSync(join(tmpdir(), 'octogee-worktree-'));
  const source = join(temporary, 'source');
  const run = args => execFileSync(GIT, args, { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    run(['worktree', 'add', '--detach', '--quiet', source, `${sha}^{commit}`]);
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
  const remove = () => {
    run(['worktree', 'remove', '--force', source]);
    rmSync(temporary, { recursive: true, force: true });
  };
  try {
    initSubmodules(root, source);
  } catch (error) {
    remove();
    throw error;
  }
  return { source, remove };
}

function extract(repository, commit, destination, archive) {
  mkdirSync(destination, { recursive: true });
  execFileSync(GIT, ['archive', '--format=tar', `--output=${archive}`, `${commit}^{commit}`], { cwd: repository });
  execFileSync('/usr/bin/tar', ['-xf', archive, '-C', destination]);
  rmSync(archive);
  const gitlinks = git(repository, ['ls-tree', '-r', '-z', commit]).split('\0').filter(Boolean)
    .map(record => ({ meta: record.slice(0, record.indexOf('\t')).split(' '), path: record.slice(record.indexOf('\t') + 1) }))
    .filter(({ meta }) => meta[1] === 'commit');
  for (const { meta, path } of gitlinks) extract(initializedSubmodule(repository, path), meta[2], join(destination, path), archive);
}

export function exportSource(root, sha) {
  const temporary = mkdtempSync(join(tmpdir(), 'octogee-export-'));
  const source = join(temporary, 'source');
  try {
    extract(root, git(root, ['rev-parse', '--verify', `${sha}^{commit}`]).trim(), source, join(temporary, 'source.tar'));
    return { source, remove: () => rmSync(temporary, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

const CI_SCRIPT_DIRECTORIES = ['platform/scripts/ci', 'scripts/ci'];

export function sourceCiScript(source, name) {
  const script = CI_SCRIPT_DIRECTORIES.map(directory => `${directory}/${name}`).find(file => existsSync(join(source, file)));
  if (!script) throw new Error(`${source} carries no ${name} in ${CI_SCRIPT_DIRECTORIES.join(' or ')}`);
  return script;
}

export function deploymentSource(root, sha) {
  const copy = exportSource(root, sha);
  const platform = join(copy.source, 'platform');
  const product = join(copy.source, 'product');
  if (!existsSync(product)) return copy;
  try {
    for (const name of Object.keys(overlayTree({ platform, product, out: join(dirname(copy.source), 'overlay') }))) {
      cpSync(join(product, name), join(platform, name), { recursive: true, force: true, verbatimSymlinks: true });
    }
    return copy;
  } catch (error) {
    copy.remove();
    throw error;
  }
}
