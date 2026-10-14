import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { extractPlatformValues, manifestYaml, splitPlatformManifest, valuesTemplate, verifyBootstrapResources, writeNamespaceChart } from './platform-manifest.mjs';
const executable = name => execFileSync('/usr/bin/which', [name], { encoding: 'utf8' }).trim();

if (process.argv[2] === 'prepare') {
  const directory = join(process.env.RUNNER_TEMP, 'render-chart');
  mkdirSync(directory);
  execFileSync(executable('tar'), ['-xzf', process.argv[3], '-C', directory]);
  const chart = join(directory, 'octogee');
  writeFileSync(join(chart, 'templates/ci-effective-values.yaml'), valuesTemplate, { mode: 0o600 });
  process.stdout.write(chart);
  process.exit(0);
}

const input = readFileSync(0, 'utf8');
const context = process.env.CI_KUBE_CONTEXT;
const kubectl = executable('kubectl');
const discovery = execFileSync(kubectl, ['--context', context, 'api-resources', '--namespaced=false', '--no-headers', '-o', 'wide'], { encoding: 'utf8' });
const kinds = new Set(discovery.split('\n').filter(Boolean).map(line => {
  const match = line.match(/\sfalse\s+(\S+)\s/);
  if (!match) throw new Error(`Invalid Kubernetes discovery row: ${line}`);
  return match[1];
}));
if (!kinds.has('Namespace')) throw new Error('Kubernetes cluster resource discovery is incomplete');
const { manifest, values } = extractPlatformValues(input);
const { release, bootstrap } = splitPlatformManifest(manifest, process.env.CI_RELEASE_NAMESPACE, kinds);
const definitions = join(process.env.RUNNER_TEMP, 'cluster-resources.yaml');
writeFileSync(definitions, manifestYaml(bootstrap), { mode: 0o600 });
const live = JSON.parse(execFileSync(kubectl, ['--context', context, 'get', '-f', definitions, '-o', 'json'], { encoding: 'utf8' }));
verifyBootstrapResources(bootstrap, live.items ?? [live]);
const chart = join(process.env.RUNNER_TEMP, 'namespace-chart');
const original = parse(readFileSync(join(process.env.CI_SOURCE_CHART, 'Chart.yaml'), 'utf8'));
const metadata = Object.fromEntries(['apiVersion', 'name', 'version', 'type', 'appVersion', 'description'].filter(key => original[key] !== undefined).map(key => [key, original[key]]));
writeNamespaceChart(chart, metadata, release, values);
process.stdout.write(chart);
