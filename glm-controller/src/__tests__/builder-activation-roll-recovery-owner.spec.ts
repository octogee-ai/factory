import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Firestore } from 'firebase-admin/firestore';
import type { Operation } from '@octogee/shared/types/glm';
import type { ReleasePayload } from '@octogee/shared/types/gateway-releases';
import { createBuilderActivationRollRecoveryOwner } from '../builder-activation-roll-recovery-owner.js';
import { readBuilderActivationRollRecovery, hasBuilderActivationTargetRollback } from '../builder-activation-roll-recovery.js';
import { createSurgePodTransport } from '../surge-customer-handoff-runtime.js';
import { FLEET_KEY_PAIR } from './fixtures/fleet-keys.js';
import { buildOperationCompletionUpdate } from '../operation-retry.js';
import { rearmOwnedLegacyMigration } from '../legacy-migration-recovery.js';

function fixture(scenario = 'success') {
  const events: string[] = []; let applied = scenario === 'post-helm-crash';
  const gatewayId = 'builder-a', operationId = 'builder-activate-builder-a-g1';
  const migrationId = `mig-${operationId}:scheduler:1:claim:1000`;
  const gateway = { gatewayId, gatewayClass: 'builder', ownerUid: 'alice', builderSlug: 'alice', desiredStatus: 'running', liveRelease: 1, desiredRelease: 2, latestRelease: 2,
    allocation: { kind: 'disposable-builder', leaseId: 'lease-a', generation: 1, claimedByUid: 'alice' } };
  const recovery = { id: operationId, kind: 'migrate-customer', status: 'pending', startedAt: null, input: { uid: 'alice', builderSlug: 'alice', source: 'builder-activation-lease', recoverSourceOnly: true, fromGatewayId: 'shared-a', toGatewayId: gatewayId },
    schedulerHandoff: { migrationId, uid: 'alice', slug: 'alice', fromGatewayId: 'shared-a', toGatewayId: gatewayId, stageAfterCutover: true, sourceRecovery: { migrationId, sourceEpoch: 7, steps: [{ name: 'quiesce-source', status: 'done' }] } } };
  const lease = { leaseId: 'lease-a', generation: 1, status: 'activating', sourceGatewayId: 'shared-a', sourceAssignmentEpoch: 7, targetGatewayId: gatewayId };
  const user = { username: 'alice', provisioning: { openclaw: { gatewayId: 'shared-a', slug: 'alice', activationLease: lease, migration: { state: 'moving', operationId, startedAt: 1000 } } } };
  const source = { gatewayId: 'shared-a', gatewayClass: 'shared', desiredStatus: 'running' };
  const assignment = { uid: 'alice', slug: 'alice', gatewayId: 'shared-a', epoch: 7, state: 'quiescing', updatedByOperationId: operationId };
  const roll = { id: 'roll-2', kind: 'rollout', status: 'running', startedAt: 2000, input: { gatewayId, targetRelease: 2 } } as unknown as Operation;
  const documents = new Map<string, unknown>([
    [`gateways/${gatewayId}`, gateway], [`glmOperations/${operationId}`, recovery], [`glmOperations/${roll.id}`, roll], ['users/alice', user],
    ['gateways/shared-a', source], ['gateways/shared-a/assignments/alice', assignment], [`glmGateways/${gatewayId}`, { runtime: 'cluster', release: 2 }],
  ]);
  const snapshot = (path: string) => ({ exists: documents.has(path), data: () => documents.get(path) });
  interface Ref { path: string; id: string; get: () => Promise<ReturnType<typeof snapshot>>; collection: (name: string) => { doc: (id: string) => Ref } }
  const doc = (path: string): Ref => ({ path, id: path.split('/').at(-1)!, get: async () => snapshot(path), collection: name => ({ doc: id => doc(`${path}/${name}/${id}`) }) });
  const query = (path: string, field?: string, value?: unknown) => ({ doc: (id: string) => doc(`${path}/${id}`), limit: () => ({ get: async () => ({ empty: ![...documents].some(([key, entry]) => {
    if (!key.startsWith(path + '/') || key.slice(path.length + 1).includes('/')) return false;
    if (!field) return true;
    return field.split('.').reduce<unknown>((current, part) => typeof current === 'object' && current !== null ? (current as Record<string, unknown>)[part] : undefined, entry) === value;
  }) }) }), where: (next: string, _operator: string, expected: unknown) => query(path, next, expected) });
  const db = { doc, collection: (path: string) => query(path), runTransaction: async (run: (transaction: object) => Promise<void>) => {
    if (scenario === 'epoch-before-proof') assignment.epoch++;
    return await run({ get: (ref: { get: () => Promise<unknown> }) => ref.get(), update: (ref: { path: string }, patch: Record<string, unknown>) => {
      events.push('journal-proof'); const current = documents.get(ref.path) as Record<string, unknown>;
      for (const [field, value] of Object.entries(patch)) {
        const parts = field.split('.'), key = parts.pop()!;
        const parent = parts.reduce((entry, part) => entry[part] as Record<string, unknown>, current); parent[key] = value;
      }
    } });
  } } as unknown as Firestore;
  const oldTag = 'abc1234-oc2026@sha256:' + 'a'.repeat(64), newTag = 'def1234-oc2026@sha256:' + 'b'.repeat(64);
  const artifact = (tag: string, edgeTag: string) => ({ imageRepository: 'reg/gateway', imageTag: tag, profileImages: { builder: { imageRepository: 'reg/builder', imageTag: tag } }, gatewayEdgeImage: { imageRepository: 'reg/edge', imageTag: edgeTag } }) as ReleasePayload;
  const liveArtifact = artifact(oldTag, 'abc1234@sha256:' + 'c'.repeat(64)), installedArtifact = artifact(newTag, 'def1234@sha256:' + 'd'.repeat(64));
  const retained = { uid: 'old', name: 'pod-old', podIP: '10.0.0.1', image: 'reg/builder:' + oldTag, ready: false, terminating: false, crashLooping: false };
  const target = { ...retained, uid: 'new', name: 'pod-new', podIP: '10.0.0.2', image: 'reg/builder:' + newTag };
  const health = { status: 'booting' as const, version: 'unused', fleetSignatureCapability: 'gateway-scoped' as const, handoffReleased: false, prelaunchState: 'held' as const, mountedCustomers: [], migratingIn: [] };
  const template = (tag: string, label: string, edgeTag: string) => ({ metadata: { labels: { 'gateway-image': label } }, spec: { containers: [{ name: 'gateway', image: 'reg/builder:' + tag, env: [{ name: 'GATEWAY_IMAGE_TAG', value: tag }] }, { name: 'gateway-edge', image: 'reg/edge:' + edgeTag }], serviceAccountName: 'builder-sa' } });
  const oldTemplate = template(oldTag, 'abc1234', liveArtifact.gatewayEdgeImage!.imageTag), newTemplate = template(newTag, 'def1234', installedArtifact.gatewayEdgeImage!.imageTag);
  const owner = (uid: string) => [{ controller: true, uid }];
  const objects = { items: [
    { kind: 'Deployment', metadata: { uid: 'deployment', name: 'octogee-gateway-builder-a' }, spec: { template: applied ? oldTemplate : newTemplate } },
    { kind: 'ReplicaSet', metadata: { uid: 'rs-old', ownerReferences: owner('deployment') }, spec: { template: oldTemplate } },
    { kind: 'ReplicaSet', metadata: { uid: 'rs-new', ownerReferences: owner('deployment') }, spec: { template: newTemplate } },
    { kind: 'Pod', metadata: { uid: 'old', ownerReferences: owner('rs-old') } },
    ...applied ? [] : [{ kind: 'Pod', metadata: { uid: 'new', ownerReferences: owner('rs-new') } }],
  ] };
  if (scenario === 'template-drift') newTemplate.spec.serviceAccountName = 'different';
  const deps = {
    db, namespace: 'octogee-test', chartFingerprint: 'chart', runExclusive: async (work: () => Promise<void>) => { events.push('exclusive'); await work(); },
    helm: { readDeployedInstance: async () => ({ image: { repository: 'reg/builder', tag: scenario === 'post-helm-crash' ? oldTag : newTag }, chartFingerprint: 'chart', deploymentIntentFingerprint: 'intent' }),
      upsertInstance: vi.fn(async () => { events.push('helm-old-artifact'); applied = true; }) },
    readRelease: async (_gatewayId: string, release: number) => release === 1 ? liveArtifact : installedArtifact,
    prepareIntent: async (_gateway: unknown, release: ReleasePayload) => ({ imageRepository: 'reg/builder', imageTag: release.imageTag, deploymentIntentFingerprint: 'intent', rollStrategy: 'surge', waitForReady: false }),
    listPods: async () => ({ pods: applied ? [retained] : [retained, target], observedPodUids: applied ? ['old'] : ['old', 'new'] }),
    readPodHealth: async () => health,
    holdTarget: async (request: unknown) => { events.push('hold'); if (scenario === 'hold-unavailable') { throw Error('old target lacks cleanup protocol'); } return request; },
    unreserveTarget: async () => { events.push('unreserve'); if (scenario === 'claim-during-cleanup') roll.startedAt = 3000; },
    readTemplateObjects: async () => objects, now: () => 5000, wait: async () => undefined, log: vi.fn(),
  } as unknown as Parameters<typeof createBuilderActivationRollRecoveryOwner>[0];
  const ctx = { reportStep: vi.fn(async () => undefined), assertActiveClaim: async () => { if (roll.startedAt !== 2000) throw Error('claim changed'); } };
  return { run: () => createBuilderActivationRollRecoveryOwner(deps)({ ...roll, startedAt: 2000 }, ctx), events, db, documents, operationId, recovery, assignment, lease, user, deps, ctx };
}

describe('rollout owner settles a held abandoned activation', () => {
  it('uses its rollout claim, keeps recovery pending and journals only after one retained predecessor remains', async () => {
    const h = fixture();
    await expect(h.run()).resolves.toMatchObject({ operationId: h.operationId, retainedPodUid: 'old', discardedPodUid: 'new', rollOperationId: 'roll-2', rollClaimStartedAt: 2000 });
    expect(h.events).toEqual(['exclusive', 'hold', 'unreserve', 'helm-old-artifact', 'journal-proof']);
    const current = await readBuilderActivationRollRecovery({ db: h.db, gatewayId: 'builder-a' });
    expect(current?.operation).toMatchObject({ status: 'pending', startedAt: null });
    expect(hasBuilderActivationTargetRollback({ id: h.operationId, ...current!.operation })).toBe(true);
    expect(h.assignment).toMatchObject({ state: 'quiescing', epoch: 7 });
    expect(h.deps.helm.upsertInstance).toHaveBeenCalledWith(expect.objectContaining({ imageTag: expect.stringContaining('abc1234'), builderIdentity: { ownerUid: 'alice', builderSlug: 'alice' } }));
  });
  it.each(['template-drift', 'hold-unavailable'])('keeps original target-repair behavior when predecessor proof is unavailable: %s', async scenario => {
    const h = fixture(scenario); await expect(h.run()).resolves.toBeNull();
    expect(h.events).not.toContain('helm-old-artifact'); expect(h.events).not.toContain('journal-proof'); expect(h.deps.log).toHaveBeenCalled();
  });
  it.each(['claim-during-cleanup', 'epoch-before-proof'])('does not journal proof after %s', async scenario => {
    const h = fixture(scenario); await expect(h.run()).rejects.toThrow(); expect(h.events).not.toContain('journal-proof');
  });
  it('does not use an arbitrary pending migration as an active cleanup claim', async () => {
    const h = fixture(); h.lease.generation++;
    await expect(h.run()).resolves.toBeNull(); expect(h.events).toEqual(['exclusive']);
  });
  it('does not repair a source whose canonical Shared assignment is already serving', async () => {
    const h = fixture(); h.assignment.state = 'serving';
    await expect(h.run()).resolves.toBeNull(); expect(h.events).toEqual(['exclusive']);
  });
});

function requestThroughHandler(handle: (path: string, body: string) => Promise<{ status: number; body: unknown }>): typeof import('node:http').request {
  return ((options: { path: string }, onResponse: (response: EventEmitter) => void) => {
    const request = new EventEmitter() as EventEmitter & { setTimeout: () => void; destroy: () => void; end: (body: string) => void };
    request.setTimeout = () => undefined; request.destroy = () => undefined;
    request.end = body => { void handle(options.path, body).then(response => {
      const incoming = new EventEmitter() as EventEmitter & { statusCode: number; setEncoding: () => void };
      incoming.statusCode = response.status; incoming.setEncoding = () => undefined; onResponse(incoming);
      incoming.emit('data', JSON.stringify(response.body)); incoming.emit('end');
    }).catch(error => request.emit('error', error)); };
    return request;
  }) as unknown as typeof import('node:http').request;
}

describe('retained predecessor recovery after a post-Helm crash', () => {
  it.each(['success', 'cleanup-unavailable'])('requires exact signed released-target cleanup before writing the missing proof: %s', async scenario => {
      const h = fixture('post-helm-crash'); let cleaned = 0;
      const request = requestThroughHandler(async (path, body) => {
        const parsed = JSON.parse(body);
        expect(parsed).toEqual({ migrationId: `mig-${h.operationId}`, slug: 'alice', targetPodUid: 'old', receivingPodUid: 'old' });
        if (path.startsWith('/hold-surge-openclaw/')) {
          return { status: 409, body: { error: 'OpenClaw process hold failed', message: 'surge OpenClaw process gate target migration already released' } };
        }
        expect(path).toBe('/unreserve-surge-openclaw/builder-a');
        if (scenario === 'cleanup-unavailable') return { status: 409, body: { error: 'OpenClaw process unreserve failed', message: 'Native cleanup unavailable' } };
        cleaned++; return { status: 200, body: { ...parsed, operation: 'unreserve', mode: 'held', phase: 'held', role: 'normal' } };
      });
      const transport = createSurgePodTransport({ privateKey: FLEET_KEY_PAIR.privateKey, request, log: vi.fn() });
      h.deps.holdTarget = transport.holdTargetOpenClaw!; h.deps.unreserveTarget = transport.unreserveTargetOpenClaw!;
      const outcome = await h.run();
      if (scenario === 'success') {
        expect(outcome).toMatchObject({ retainedPodUid: 'old', discardedPodUid: null });
        expect(cleaned).toBe(1); expect(h.events).toEqual(['exclusive', 'helm-old-artifact', 'journal-proof']);
      } else {
        expect(outcome).toBeNull(); expect(cleaned).toBe(0); expect(h.events).toEqual(['exclusive']);
      }
  });
});

describe('retained rollback proof fences the entire source-recovery custody period', () => {
  it('continues to defer after pending recovery is claimed and during cleanup, then ends only at canonical settlement', async () => {
    const { readBuilderActivationRollRecoveryCustody } = await import('../builder-activation-roll-recovery.js');
    const h = fixture(); await h.run();
    const pending = await readBuilderActivationRollRecoveryCustody({ db: h.db, gatewayId: 'builder-a' });
    expect(hasBuilderActivationTargetRollback({ id: h.operationId, ...pending!.operation }, pending!.recovery)).toBe(true);
    Object.assign(h.documents.get(`glmOperations/${h.operationId}`) as object, { status: 'running', startedAt: 6000 });
    expect(await readBuilderActivationRollRecovery({ db: h.db, gatewayId: 'builder-a' })).toBeNull();
    const claimed = await readBuilderActivationRollRecoveryCustody({ db: h.db, gatewayId: 'builder-a' });
    expect(hasBuilderActivationTargetRollback({ id: h.operationId, ...claimed!.operation }, claimed!.recovery)).toBe(true);
    Object.assign(h.documents.get(`glmOperations/${h.operationId}`) as object, { steps: [{ name: 'recover-source', status: 'running' }] });
    h.recovery.schedulerHandoff.sourceRecovery.steps.push({ name: 'rollback:unmount-target', status: 'done' });
    const cleaning = await readBuilderActivationRollRecoveryCustody({ db: h.db, gatewayId: 'builder-a' });
    expect(hasBuilderActivationTargetRollback({ id: h.operationId, ...cleaning!.operation }, cleaning!.recovery)).toBe(true);
    Object.assign(h.documents.get(`glmOperations/${h.operationId}`) as object, { status: 'failed', error: 'target cleanup transport interrupted' });
    const retrying = await readBuilderActivationRollRecoveryCustody({ db: h.db, gatewayId: 'builder-a' });
    expect(retrying).not.toBeNull();
    expect(hasBuilderActivationTargetRollback({ id: h.operationId, ...retrying!.operation }, retrying!.recovery)).toBe(true);
    Object.assign(h.documents.get(`glmOperations/${h.operationId}`) as object, { schedulerHandoffReleased: true });
    h.assignment.state = 'serving';
    delete (h.user.provisioning.openclaw as { migration?: unknown }).migration;
    expect(await readBuilderActivationRollRecoveryCustody({ db: h.db, gatewayId: 'builder-a' })).toBeNull();
  });
  it('retains the custody proof through normal failed completion and the existing source-recovery rearm owner', async () => {
    const h = fixture(); await h.run();
    const operation = h.documents.get(`glmOperations/${h.operationId}`) as Operation;
    Object.assign(operation, { status: 'running', startedAt: 6000 });
    const completion = buildOperationCompletionUpdate({ op: operation, result: { success: false, steps: [], error: 'target cleanup refused' }, steps: [], now: 7000 });
    Object.assign(operation, completion);
    expect(operation.status).toBe('failed');
    expect(hasBuilderActivationTargetRollback(operation)).toBe(true);
    expect(await rearmOwnedLegacyMigration({ db: h.db, ref: h.db.doc(`glmOperations/${h.operationId}`), now: 8000, admitted: () => true })).toBe(true);
    const current = await readBuilderActivationRollRecovery({ db: h.db, gatewayId: 'builder-a' });
    expect(current!.operation).toMatchObject({ status: 'pending', startedAt: null });
    expect(hasBuilderActivationTargetRollback({ id: h.operationId, ...current!.operation }, current!.recovery)).toBe(true);
  });
  it.each(['lease', 'generation', 'epoch'])('does not consume a rollback proof for another %s', async field => {
    const h = fixture(); await h.run();
    const current = await readBuilderActivationRollRecovery({ db: h.db, gatewayId: 'builder-a' });
    const expected = { ...current!.recovery };
    if (field === 'lease') expected.leaseId = 'different';
    if (field === 'generation') expected.generation++;
    if (field === 'epoch') expected.sourceEpoch++;
    expect(hasBuilderActivationTargetRollback({ id: h.operationId, ...current!.operation }, expected)).toBe(false);
  });
});
