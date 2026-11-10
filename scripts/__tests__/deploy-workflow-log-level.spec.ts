import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { parse } from 'yaml';

it.each(['ship-test.yml', 'deploy.yml'])('passes the chart log level to %s without setting the tooling LOG_LEVEL', file => {
  const workflow = parse(readFileSync(resolve(import.meta.dirname, `../../.github/workflows/${file}`), 'utf8'));
  const step = workflow.jobs.deploy.steps.find((candidate: { run?: string }) => candidate.run?.includes('scripts/ci/deploy.mjs'));
  expect(step.env).not.toHaveProperty('LOG_LEVEL');
  expect(step.env.CHART_LOG_LEVEL).toBe('${{ inputs.log_level }}');
  expect(step.run).toContain('--log-level="$CHART_LOG_LEVEL"');
});
