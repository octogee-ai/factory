import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAllDocuments } from 'yaml';
import { bootstrapReleaseParameters, extractPlatformValues, manifestYaml, splitPlatformManifest, valuesTemplate, verifyBootstrapResources, writeNamespaceChart } from '../ci/platform-manifest.mjs';
import { TEST_TARGET } from "./fixtures/deployment.js";

it.each([TEST_TARGET.namespace, 'octogee'])('gives bootstrapped admission parameters to the %s Helm release', namespace => {
  const parameters = ['octogee-project-runner'].flatMap(name => [
    { kind: 'ConfigMap', metadata: { name: `${name}-image`, namespace }, data: { image: 'image@sha256:reviewed' } },
    { kind: 'Role', metadata: { name: `${name}-parameters`, namespace, labels: { existing: 'retained' } }, rules: [{ resources: ['configmaps'], verbs: ['get'] }] },
    { kind: 'RoleBinding', metadata: { name: `${name}-parameters`, namespace, annotations: { existing: 'retained' } }, roleRef: { kind: 'Role', name: `${name}-parameters` }, subjects: [{ kind: 'ServiceAccount', name: 'controller', namespace }] },
  ]);
  const unrelated = [{ kind: 'ConfigMap', metadata: { name: 'octogee-native-context-worker-image', namespace } }, { kind: 'Role', metadata: { name: 'octogee-platform-release', namespace } }, { kind: 'Deployment', metadata: { name: 'octogee-api', namespace } }];
  const source = [...parameters, ...unrelated];
  const original = structuredClone(source);
  expect(bootstrapReleaseParameters(source, namespace)).toEqual(parameters.map(resource => ({
    ...resource,
    metadata: {
      ...resource.metadata,
      labels: { ...resource.metadata.labels, 'app.kubernetes.io/managed-by': 'Helm' },
      annotations: { ...resource.metadata.annotations, 'meta.helm.sh/release-name': 'octogee', 'meta.helm.sh/release-namespace': namespace },
    },
  })));
  expect(source).toEqual(original);
});

it('keeps only environment-owned namespace objects in the release chart', () => {
  const resources = [
    { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'image' }, data: { image: 'reviewed' } },
    { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'runner', namespace: `${TEST_TARGET.namespace}-project-runs` } },
    { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole', metadata: { name: 'observer' }, rules: [] },
    { apiVersion: 'admissionregistration.k8s.io/v1', kind: 'ValidatingAdmissionPolicy', metadata: { name: 'fixed' }, spec: { failurePolicy: 'Fail' } },
    { apiVersion: 'v1', kind: 'Namespace', metadata: { name: `${TEST_TARGET.namespace}-project-runs` } },
  ];
  const result = splitPlatformManifest(manifestYaml(resources), TEST_TARGET.namespace);
  expect(result.release.map(resource => resource.kind)).toEqual(['ConfigMap', 'Deployment']);
  expect(result.release.map(resource => resource.metadata.namespace)).toEqual([TEST_TARGET.namespace, `${TEST_TARGET.namespace}-project-runs`]);
  expect(result.bootstrap.map(resource => resource.kind)).toEqual(['ClusterRole', 'ValidatingAdmissionPolicy', 'Namespace']);
});
it.each(['octogee', 'default', 'kube-system'])('rejects a TEST release object in %s', namespace => {
  expect(() => splitPlatformManifest(manifestYaml([{ kind: 'Secret', metadata: { name: 'other', namespace } }]), TEST_TARGET.namespace)).toThrow('cannot manage');
});
it('requires preserved live cluster resources to agree with the reviewed security definition', () => {
  const desired = { kind: 'ClusterRole', metadata: { name: 'reader' }, rules: [{ resources: ['nodes'], verbs: ['get'] }] };
  const live = { ...desired, metadata: { ...desired.metadata, annotations: { 'helm.sh/resource-policy': 'keep' } } };
  expect(() => verifyBootstrapResources([desired], [live])).not.toThrow();
  expect(() => verifyBootstrapResources([desired], [])).toThrow('bootstrap required');
  expect(() => verifyBootstrapResources([desired], [desired])).toThrow('bootstrap required');
  expect(() => verifyBootstrapResources([{ ...desired, rules: [{ resources: ['nodes'], verbs: ['get', 'list'] }] }], [live])).toThrow('bootstrap required');
});

it.each([undefined, false])('accepts the serialized PriorityClass globalDefault of %s as false', globalDefault => {
  const desired = { kind: 'PriorityClass', metadata: { name: 'capacity' }, value: -1000, globalDefault: false, preemptionPolicy: 'PreemptLowerPriority' };
  const live = { kind: desired.kind, value: desired.value, preemptionPolicy: desired.preemptionPolicy, ...(globalDefault === undefined ? {} : { globalDefault }), metadata: { ...desired.metadata, annotations: { 'helm.sh/resource-policy': 'keep' } } };
  expect(() => verifyBootstrapResources([desired], [live])).not.toThrow();
});

it.each([
  { globalDefault: true },
  { globalDefault: null },
  { value: 0 },
  { preemptionPolicy: 'Never' },
])('rejects PriorityClass drift in %j', changed => {
  const desired = { kind: 'PriorityClass', metadata: { name: 'capacity' }, value: -1000, globalDefault: false, preemptionPolicy: 'PreemptLowerPriority' };
  const live = { ...desired, ...changed, metadata: { ...desired.metadata, annotations: { 'helm.sh/resource-policy': 'keep' } } };
  expect(() => verifyBootstrapResources([desired], [live])).toThrow('bootstrap required');
});

it('requires an explicitly enabled PriorityClass globalDefault to be present', () => {
  const desired = { kind: 'PriorityClass', metadata: { name: 'capacity' }, value: -1000, globalDefault: true };
  const live = { kind: desired.kind, value: desired.value, metadata: { ...desired.metadata, annotations: { 'helm.sh/resource-policy': 'keep' } } };
  expect(() => verifyBootstrapResources([desired], [live])).toThrow('bootstrap required');
});

it('does not default missing false fields on other resource kinds', () => {
  const desired = { kind: 'StorageClass', metadata: { name: 'storage' }, allowVolumeExpansion: false };
  const live = { kind: desired.kind, metadata: { ...desired.metadata, annotations: { 'helm.sh/resource-policy': 'keep' } } };
  expect(() => verifyBootstrapResources([desired], [live])).toThrow('bootstrap required');
});

it('preserves effective values and literal template data through the namespace-only Helm chart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'namespace-chart-'));
  try {
    const source = join(directory, 'source');
    mkdirSync(join(source, 'templates'), { recursive: true });
    writeFileSync(join(source, 'Chart.yaml'), 'apiVersion: v2\nname: octogee\nversion: 1.2.3\n');
    writeFileSync(join(source, 'values.yaml'), 'settings:\n  retained: original\n  overridden: original\n');
    writeFileSync(join(source, 'templates/values.yaml'), valuesTemplate);
    writeFileSync(join(source, 'templates/resources.yaml'), 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: config\ndata:\n  literal: {{ "{{ mustStayLiteral }}" | quote }}\n---\napiVersion: v1\nkind: Pod\nmetadata:\n  name: check\n  annotations:\n    helm.sh/hook: test\nspec:\n  containers: []\n---\napiVersion: rbac.authorization.k8s.io/v1\nkind: ClusterRole\nmetadata:\n  name: fixed-security\nrules: []\n');
    const captured = extractPlatformValues(execFileSync('helm', ['template', 'octogee', source, '--namespace', TEST_TARGET.namespace, '--set', 'settings.overridden=new'], { encoding: 'utf8' }));
    const resources = splitPlatformManifest(captured.manifest, TEST_TARGET.namespace);
    const output = join(directory, 'release');
    writeNamespaceChart(output, { apiVersion: 'v2', name: 'octogee', version: '1.2.3' }, resources.release, captured.values);
    const rendered = execFileSync('helm', ['template', 'octogee', output, '--namespace', TEST_TARGET.namespace], { encoding: 'utf8' });
    const documents = parseAllDocuments(rendered).map(document => document.toJSON());
    expect(documents.map(document => document.kind)).toEqual(['ConfigMap', 'Pod']);
    expect(documents[0].data.literal).toBe('{{ mustStayLiteral }}');
    expect(documents[1].metadata.annotations['helm.sh/hook']).toBe('test');
    expect(readFileSync(join(output, 'values.yaml'), 'utf8')).toContain('retained: original');
    expect(captured.values.settings).toEqual({ retained: 'original', overridden: 'new' });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it('fails closed if effective values were omitted from rendering', () => {
  expect(() => extractPlatformValues('kind: ConfigMap\nmetadata:\n  name: config\n')).toThrow('capture its effective');
});
