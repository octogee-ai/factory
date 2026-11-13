import { parseAllDocuments, stringify } from 'yaml';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deploymentEnvironmentSettings } from '../../core/dist/deployment-environment.js';

export const clusterKinds = new Set(['Namespace', 'ClusterRole', 'ClusterRoleBinding', 'ValidatingAdmissionPolicy', 'ValidatingAdmissionPolicyBinding', 'StorageClass', 'PriorityClass', 'ComputeClass', 'CustomResourceDefinition', 'RuntimeClass']);
const isApiReader = (resource, namespace) => resource.metadata.namespace === 'default' && ['Role', 'RoleBinding'].includes(resource.kind) && resource.metadata.name === `glm-controller-apiserver-read-${namespace}`;

export function splitPlatformManifest(input, namespace, kinds = clusterKinds) {
  if (!['prod', 'test'].some(environment => deploymentEnvironmentSettings(environment).namespace === namespace)) throw new Error(`Unknown release namespace ${namespace}`);
  const release = [], bootstrap = [];
  for (const document of parseAllDocuments(input)) {
    if (document.errors.length) throw document.errors[0];
    const resource = document.toJSON();
    if (resource === null) continue;
    if (typeof resource !== 'object' || !resource.kind || !resource.metadata?.name) throw new Error('Invalid platform resource');
    if (kinds.has(resource.kind) || isApiReader(resource, namespace)) {
      bootstrap.push(resource);
    } else {
      const target = resource.metadata.namespace ?? namespace;
      if (![namespace, `${namespace}-project-runs`].includes(target)) throw new Error(`Release cannot manage ${resource.kind}/${resource.metadata.name} in ${target}`);
      resource.metadata.namespace = target;
      release.push(resource);
    }
  }
  return { release, bootstrap };
}
export function manifestYaml(resources) { return resources.map(resource => stringify(resource)).join('---\n'); }

export function bootstrapReleaseParameters(release, namespace) {
  return release.filter(value => /^octogee-project-runner-(image|parameters)$/.test(value.metadata.name)).map(value => ({
    ...value,
    metadata: {
      ...value.metadata,
      labels: { ...value.metadata.labels, 'app.kubernetes.io/managed-by': 'Helm' },
      annotations: { ...value.metadata.annotations, 'meta.helm.sh/release-name': 'octogee', 'meta.helm.sh/release-namespace': namespace },
    },
  }));
}

export const valuesTemplate = 'apiVersion: octogee.internal/v1\nkind: EffectiveValues\nmetadata:\n  name: octogee-ci-values\nvalues: {{ .Values | toJson }}\n';
export function extractPlatformValues(input) {
  const documents = parseAllDocuments(input).map(document => {
    if (document.errors.length) throw document.errors[0];
    return document.toJSON();
  }).filter(Boolean);
  const captured = documents.filter(resource => resource.apiVersion === 'octogee.internal/v1' && resource.kind === 'EffectiveValues' && resource.metadata?.name === 'octogee-ci-values');
  if (captured.length !== 1 || !captured[0].values || typeof captured[0].values !== 'object') throw new Error('Platform rendering must capture its effective Helm values');
  return { values: captured[0].values, manifest: manifestYaml(documents.filter(resource => resource !== captured[0])) };
}
export function writeNamespaceChart(directory, metadata, release, values) {
  mkdirSync(join(directory, 'templates'), { recursive: true });
  writeFileSync(join(directory, 'Chart.yaml'), stringify(metadata), { mode: 0o600 });
  writeFileSync(join(directory, 'values.yaml'), stringify(values), { mode: 0o600 });
  writeFileSync(join(directory, 'rendered.yaml'), manifestYaml(release), { mode: 0o600 });
  writeFileSync(join(directory, 'templates/platform.yaml'), '{{ .Files.Get "rendered.yaml" }}\n', { mode: 0o600 });
}

function containsExpected(expected, actual) {
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.length === actual.length && expected.every((value, index) => containsExpected(value, actual[index]));
  if (expected !== null && typeof expected === 'object') return actual !== null && typeof actual === 'object' && Object.entries(expected).every(([key, value]) => containsExpected(value, actual[key]));
  return expected === actual;
}
export function verifyBootstrapResources(expected, actual) {
  for (const resource of expected) {
    const live = actual.find(value => value.kind === resource.kind && value.metadata.name === resource.metadata.name && value.metadata.namespace === resource.metadata.namespace);
    const normalizedLive = live?.kind === 'PriorityClass' && live.globalDefault === undefined ? { ...live, globalDefault: false } : live;
    const fields = Object.fromEntries(Object.entries(resource).filter(([key]) => !['apiVersion', 'kind', 'metadata'].includes(key)));
    if (!live || live.metadata.annotations?.['helm.sh/resource-policy'] !== 'keep' || !containsExpected(fields, normalizedLive) || !containsExpected(resource.metadata.labels ?? {}, live.metadata.labels ?? {})) {
      throw new Error(`Operator bootstrap required for ${resource.kind}/${resource.metadata.name}`);
    }
  }
}
