import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { parse } from 'yaml';

interface Step { uses?: string; run?: string; with?: Record<string, string>; env?: Record<string, string>; 'working-directory'?: string }
interface Job { steps: Step[] }

const workflows = resolve(import.meta.dirname, '../../../.github/workflows');
const SOURCE_CHECKOUT_STEPS = [
  ['build-main.yml', 'build', 'main.mjs'],
  ['build-main.yml', 'desktop', 'desktop.mjs'],
  ['deploy.yml', 'deploy', 'deploy.mjs'],
  ['ship-test.yml', 'deploy', 'deploy.mjs'],
  ['ship-test.yml', 'end-to-end', 'end-to-end-tests.mjs'],
  ['test.yml', 'desktop-package', 'verify-linux-package.sh'],
] as const;

function sourceCheckoutSteps() {
  return readdirSync(workflows).filter(file => file.endsWith('.yml')).sort().flatMap(file => {
    const workflow = parse(readFileSync(join(workflows, file), 'utf8')) as { jobs: Record<string, Job> };
    return Object.entries(workflow.jobs).flatMap(([name, job]) => {
      const checkout = job.steps.find(step => step.uses?.startsWith('actions/checkout@'));
      if (!checkout?.with?.ref) return [];
      return job.steps.filter(step => step.run?.includes('scripts/ci')).map(step => ({ file, name, step }));
    });
  });
}

function runStep(step: Step, layout: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'source-checkout-')));
  try {
    mkdirSync(join(root, layout), { recursive: true });
    for (const [, , script] of SOURCE_CHECKOUT_STEPS) writeFileSync(join(root, layout, script), '');
    const stubs = join(root, '.stubs');
    const calls = join(root, '.calls');
    mkdirSync(stubs);
    for (const program of ['node', 'bash']) {
      writeFileSync(join(stubs, program), `#!/bin/sh\nprintf '%s\\n' "$PWD/$1" >> "${calls}"\n`);
      chmodSync(join(stubs, program), 0o755);
    }
    const cwd = join(root, step['working-directory'] ?? '.');
    mkdirSync(cwd, { recursive: true });
    const script = join(stubs, 'step.sh');
    writeFileSync(script, step.run!);
    const env = Object.fromEntries(Object.keys(step.env ?? {}).map(key => [key, '']));
    execFileSync('/bin/bash', ['--noprofile', '--norc', '-eo', 'pipefail', script], {
      cwd, env: { ...env, PATH: `${stubs}:/usr/bin:/bin` }, stdio: 'pipe',
    });
    return readFileSync(calls, 'utf8').trim().split('\n').map(call => relative(root, resolve(call)));
  } finally { rmSync(root, { recursive: true, force: true }); }
}

it('covers every workflow step that runs CI scripts from a selected SHA checkout', () => {
  expect(sourceCheckoutSteps().map(({ file, name }) => [file, name])).toEqual(SOURCE_CHECKOUT_STEPS.map(([file, name]) => [file, name]));
});

it.each(SOURCE_CHECKOUT_STEPS.flatMap(([file, name, script]) => ['platform/scripts/ci', 'scripts/ci'].map(layout => [file, name, script, layout])))(
  '%s %s runs %s from the checked-out SHA in the %s layout', (file, name, script, layout) => {
    const { step } = sourceCheckoutSteps().find(candidate => candidate.file === file && candidate.name === name)!;
    expect(runStep(step, layout)).toEqual([`${layout}/${script}`]);
  },
);
