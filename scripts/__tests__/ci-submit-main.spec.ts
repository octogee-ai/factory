import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { command, snapshot, remove } = vi.hoisted(() => ({ command: vi.fn(), snapshot: vi.fn(), remove: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync: command }));
vi.mock('../ci/snapshot.mjs', () => ({ snapshot }));
const argv = process.argv;
const sha = 'a'.repeat(40);
const template = parse(readFileSync(resolve(import.meta.dirname, '../../ci/cloudbuild-main.yaml'), 'utf8'));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.argv = [...argv, 'main', `--sha=${sha}`];
  snapshot.mockReturnValue({ source: '/committed-snapshot', remove });
  command.mockImplementation((file: string, args: string[]) => {
    if (file === '/usr/bin/git') return args.includes('--show-toplevel') ? '/repository' : sha;
    if (file === '/usr/bin/which') return '/gcloud';
    if (file === '/gcloud') {
      const substitutions = Object.fromEntries(args.find(arg => arg.startsWith('--substitutions='))!.slice('--substitutions='.length).split(',').map(pair => pair.split('=')));
      const values = { ...template.substitutions, ...substitutions };
      const effective = JSON.stringify({ ...template, substitutions: values });
      const referenced = new Set([...effective.matchAll(/\$(?:\{([A-Z_][A-Z_0-9]*)\}|([A-Z_][A-Z_0-9]*))/g)].map(match => match[1] ?? match[2]));
      for (const key of Object.keys(substitutions)) if (!referenced.has(key)) throw new Error(`Unused Cloud Build substitution: ${key}`);
      const sourceSha = values._SOURCE_SHA.replace(/\$(?:\{([A-Z_][A-Z_0-9]*)\}|([A-Z_][A-Z_0-9]*))/g, (_match: string, braced: string, plain: string) => values[braced ?? plain]);
      expect(template.options.dynamic_substitutions).toBe(true);
      expect(sourceSha).toBe(sha);
      expect(substitutions.BRANCH_NAME).toBe('main');
      expect(substitutions.SHORT_SHA).toBe(sha.slice(0, 7));
      return 'main-build-id';
    }
    return '';
  });
});
afterEach(() => { process.argv = argv; });

it.each([false, true])('submits committed main with only variables used by the effective template (force=%s)', async force => {
  if (force) process.argv.push('--force');
  await import('../ci/submit.mjs');
  const args = command.mock.calls.find(([file]) => file === '/gcloud')![1];
  expect(args).toContain('/committed-snapshot');
  expect(args.find((arg: string) => arg.startsWith('--substitutions='))).toContain(`_FORCE_REBUILD=${force}`);
  expect(command).toHaveBeenCalledWith('/bin/bash', expect.arrayContaining(['main-build-id', '--label=Build main']), expect.anything());
  expect(remove).toHaveBeenCalledOnce();
});
