import { describe, expect, it, vi } from 'vitest';
import { FieldValue } from 'firebase-admin/firestore';
import { acknowledgeCustomerRestore, beginCustomerRestore, type FleetStateDeps } from '@octogee/core/fleet-state';
import type { Operation } from '@octogee/shared/types/glm';
import { recoverSharedRestoreRuntime } from '../lib/shared-restore-runtime.js';
import { processOperation } from '../index.js';

const sha = 'a'.repeat(40);
const images = { gateway: `us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway:aaaaaaa@sha256:${'b'.repeat(64)}`,
  'gateway-edge': `us-central1-docker.pkg.dev/octogee/octogee/gateway-edge:aaaaaaa@sha256:${'c'.repeat(64)}` };
function harness() {
  const intent = { uid: 'u', slug: 'alice', gatewayId: 'shared-1', fromGatewayId: 'builder-alice', operationId: 'return',
    assignmentEpoch: 3, phase: 'dispatched', attemptId: 'original', claimStartedAt: 100, dispatchedAt: 100 };
  const op = { id: 'recover', kind: 'restart-gateway', status: 'running', startedAt: 300,
    input: { gatewayId: 'shared-1', restoreRecovery: { sourceSha: sha, operationId: 'return', images } }, steps: [] } as unknown as Operation;
  const store: Record<string, any> = {
    'gateways/shared-1': { gatewayClass: 'shared', desiredStatus: 'running', desiredRelease: 1, liveRelease: 1 },
    'glmOperations/recover': structuredClone(op),
    'glmOperations/return': { kind: 'migrate-customer', status: 'pending', input: { uid: 'u', fromGatewayId: 'builder-alice', toGatewayId: 'shared-1' },
      cutoverCommittedAt: 50, schedulerHandoff: { uid: 'u', slug: 'alice', fromGatewayId: 'builder-alice', toGatewayId: 'shared-1' }, restoreAttempt: intent },
    'users/u': { username: 'alice', provisioning: { status: 'complete', openclaw: { gatewayId: 'shared-1', status: 'complete', restoreFence: structuredClone(intent) } } },
    'gateways/shared-1/assignments/u': { uid: 'u', slug: 'alice', gatewayId: 'shared-1', epoch: 3, state: 'serving' },
  };
  const value = (row: any, key: string) => key.split('.').reduce((current, part) => current?.[part], row);
  const ref = (path: string, filters: any[] = []): any => ({ path, id: path.split('/').at(-1), filters, get: async () => snapshot({ path, filters }),
    doc: (id: string) => ref(`${path}/${id}`), collection: (name: string) => ref(`${path}/${name}`),
    where: (key: string, comparator: string, match: unknown) => ref(path, [...filters, { key, comparator, match }]) });
  const snapshot = (target: any): any => {
    if (target.path.includes('/')) return { exists: !!store[target.path], data: () => store[target.path] };
    return { docs: Object.entries(store).filter(([path, row]) => path.split('/').length === 2 && path.startsWith(`${target.path}/`) &&
      target.filters.every((filter: any) => filter.comparator === 'in' ? filter.match.includes(value(row, filter.key)) : value(row, filter.key) === filter.match))
      .map(([path, row]) => ({ id: path.split('/')[1], data: () => row })) };
  };
  const db = { doc: ref, collection: ref, runTransaction: async (body: any) => {
    const writes: (() => void)[] = [];
    const result = await body({ get: async (target: any) => snapshot(target), update: (target: any, patch: any) => writes.push(() => {
      for (const [key, val] of Object.entries(patch)) {
        const parts = key.split('.'); let row = store[target.path];
        for (const part of parts.slice(0, -1)) row = row[part] ??= {};
        if (val instanceof FieldValue && val.isEqual(FieldValue.delete())) delete row[parts.at(-1)!];
        else row[parts.at(-1)!] = structuredClone(val);
      }
    }) });
    writes.forEach(write => write()); return result;
  } };
  const pod: any = { metadata: { name: 'pod', uid: 'pod-uid', resourceVersion: 'rv', labels: { 'gateway-instance': 'shared-1' },
    ownerReferences: [{ controller: true, kind: 'ReplicaSet', name: 'rs', uid: 'rs-uid' }] },
    spec: { volumes: [{ name: 'data', emptyDir: {} }], containers: Object.keys(images).map(name => ({ name, image: `old-${name}`,
      volumeMounts: [{ name: 'data', mountPath: '/home/node' }] })) }, status: { phase: 'Running', conditions: [], containerStatuses: [] } };
  let lostReply = false;
  let ready = true;
  const runKubectl = vi.fn(async (args: string[]) => {
    if (args.includes('patch')) {
      const fence = store['gateways/shared-1'].runtimeRestartFence;
      expect(fence.phase).toBe('dispatched'); expect(store['users/u'].provisioning.openclaw.restoreFence).toEqual(intent);
      const patch = JSON.parse(args[args.indexOf('-p') + 1]);
      expect(patch.slice(0, 2)).toEqual([{ op: 'test', path: '/metadata/uid', value: 'pod-uid' }, { op: 'test', path: '/metadata/resourceVersion', value: 'rv' }]);
      expect(patch.filter((item: any) => item.op === 'replace').every((item: any) => /^\/spec\/containers\/\d\/image$/.test(item.path))).toBe(true);
      for (const replacement of patch.filter((item: any) => item.op === 'replace')) {
        const index = Number(replacement.path.split('/')[3]);
        pod.spec.containers[index].image = replacement.value;
      }
      pod.status.conditions = [{ type: 'Ready', status: ready ? 'True' : 'False' }];
      pod.status.containerStatuses = pod.spec.containers.map(({ name, image }: any) => ({ name, ready, imageID: image }));
      if (lostReply) return { code: 1, stdout: '', stderr: 'lost reply' };
    }
    const result = args.includes('pods') ? { items: [pod] } : args.includes('replicaset') ?
      { metadata: { uid: 'rs-uid', ownerReferences: [{ controller: true, kind: 'Deployment', uid: 'deployment-uid' }] } } :
      args.includes('deployment') ? { metadata: { uid: 'deployment-uid' } } : pod;
    return { code: 0, stdout: JSON.stringify(result), stderr: '' };
  });
  const ctx = { assertActiveClaim: vi.fn(async () => {}), reportStep: vi.fn() };
  const deps = { db: db as never, namespace: 'octogee-test', sourceSha: sha, runKubectl };
  return { deps, op, ctx, store, pod, lostReply: () => { lostReply = true; }, setReady: (value: boolean) => { ready = value; } };
}
describe('journaled Shared restore runtime recovery', () => {
  function reauthorize(h: ReturnType<typeof harness>) {
    const original = h.store['glmOperations/return'].restoreAttempt;
    original.claimStartedAt = 200;
    h.store['users/u'].provisioning.openclaw.restoreFence = structuredClone(original);
    h.op.input.restoreRecovery = { ...h.op.input.restoreRecovery as object, reauthorize: structuredClone(original) };
    h.store['glmOperations/recover'].input = structuredClone(h.op.input);
    return structuredClone(original);
  }
  async function failedRecovery() {
    const h = harness();
    const intent = reauthorize(h);
    h.setReady(false);
    let clock = 1;
    await expect(recoverSharedRestoreRuntime({ ...h.deps, now: () => clock, wait: async () => { clock += 240_000; } }, h.op, h.ctx))
      .rejects.toThrow('restore recovery images are not ready; outcome remains fenced');
    Object.assign(h.store['glmOperations/recover'], { status: 'failed', completedAt: 500, error: 'restore recovery images are not ready; outcome remains fenced' });
    const predecessor = { operationId: 'recover', input: structuredClone(h.op.input), completedAt: 500,
      fence: structuredClone(h.store['gateways/shared-1'].runtimeRestartFence) };
    const nextSha = 'd'.repeat(40);
    const nextImages = Object.fromEntries(Object.entries(images).map(([name, image]) => [name,
      image.replace('aaaaaaa', 'ddddddd').replace(/@sha256:.+$/, `@sha256:${'e'.repeat(64)}`)]));
    const next = { ...h.op, id: 'successor', startedAt: 600, input: { gatewayId: 'shared-1',
      restoreRecovery: { operationId: 'return', sourceSha: nextSha, images: nextImages, reauthorize: intent, supersede: predecessor } } } as Operation;
    h.store['glmOperations/successor'] = structuredClone(next);
    h.deps.runKubectl.mockClear();
    h.setReady(true);
    return { h, next, deps: { ...h.deps, sourceSha: nextSha }, predecessor, intent, nextImages };
  }
  function queuedMigration(h: ReturnType<typeof harness>) {
    h.store['glmOperations/queued'] = { kind: 'migrate-customer', status: 'pending', createdAt: 1_000,
      createdBy: 'glm-controller-placement-policy', origin: 'automatic', startedAt: null, completedAt: null,
      input: { uid: 'other', fromGatewayId: 'shared-1', toGatewayId: 'builder-other' }, steps: [] };
    const handler = vi.fn(async () => ({ success: true, steps: [] }));
    const log = vi.fn();
    const run = () => processOperation({ ...h.store['glmOperations/queued'], id: 'queued' },
      (h.deps.db as any).doc('glmOperations/queued'),
      { db: h.deps.db, handlers: { 'migrate-customer': handler }, log } as never);
    return { run, handler, log };
  }

  it.each(['implicit', 'zero'])('recovers ahead of unclaimed queued migrations with %s attempts while the real claim path retains the restart fence', async count => {
    const { h, next, deps, intent } = await failedRecovery();
    const queued = queuedMigration(h);
    if (count === 'zero') Object.assign(h.store['glmOperations/queued'], { attempts: 0, resumeCount: 0, attemptHistory: [] });
    const queuedBefore = structuredClone(h.store['glmOperations/queued']);
    await queued.run();
    expect(queued.handler).not.toHaveBeenCalled();
    expect(queued.log).toHaveBeenCalledWith(expect.stringContaining('runtime restart outcome is unresolved'));
    expect(h.store['glmOperations/queued']).toEqual(queuedBefore);
    const kubectl = h.deps.runKubectl.getMockImplementation()!;
    h.deps.runKubectl.mockImplementation(async args => {
      if (args.includes('patch')) {
        expect(h.store['gateways/shared-1'].runtimeRestartFence.attemptId).toBe(next.id);
        await queued.run();
        expect(queued.handler).not.toHaveBeenCalled();
        expect(h.store['glmOperations/queued']).toEqual(queuedBefore);
      }
      return kubectl(args);
    });
    await recoverSharedRestoreRuntime(deps, next, h.ctx);
    expect(h.store['glmOperations/queued']).toEqual(queuedBefore);
    expect(h.store['gateways/shared-1'].runtimeRestartFence).toBeUndefined();
    expect(h.store['users/u'].provisioning.openclaw.restoreFence).toMatchObject({ phase: 'dispatched', attemptId: intent.attemptId });
    const claimStartedAt = h.store['glmOperations/return'].restoreAttempt.claimStartedAt + 1;
    Object.assign(h.store['glmOperations/return'], { status: 'running', startedAt: claimStartedAt, attemptHistory: [] });
    const stateDeps: FleetStateDeps = { db: h.deps.db, deleteField: () => FieldValue.delete(), serverTimestamp: () => FieldValue.serverTimestamp() };
    const owned = await beginCustomerRestore(stateDeps, { uid: intent.uid, slug: intent.slug, gatewayId: intent.gatewayId,
      fromGatewayId: intent.fromGatewayId, assignmentEpoch: intent.assignmentEpoch, operationId: intent.operationId,
      claimStartedAt, attemptId: 'native-resume' }, { resume: true });
    await acknowledgeCustomerRestore(stateDeps, owned);
    expect(h.store['users/u'].provisioning.openclaw.restoreFence).toBeUndefined();
    await queued.run();
    expect(queued.handler).toHaveBeenCalledOnce();
    expect(h.store['glmOperations/queued']).toMatchObject({ status: 'succeeded', attempts: 1 });
  });

  it('refuses recovery if the migration claim wins before restart custody is reserved', async () => {
    const h = harness();
    const queued = queuedMigration(h);
    let entered!: () => void;
    const claimed = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    queued.handler.mockImplementation(async () => { entered(); await held; return { success: true, steps: [] }; });
    const claim = queued.run();
    await claimed;
    try {
      expect(h.store['glmOperations/queued']).toMatchObject({ status: 'running', firstStartedAt: expect.any(Number) });
      await expect(recoverSharedRestoreRuntime(h.deps, h.op, h.ctx)).rejects.toThrow('another migration is active');
      expect(h.deps.runKubectl.mock.calls.some(([args]) => args.includes('patch'))).toBe(false);
      expect(h.store['gateways/shared-1'].runtimeRestartFence).toBeUndefined();
    } finally { release(); await claim; }
  });

  it.each([
    ['startedAt', 1], ['startedAt', undefined], ['firstStartedAt', 1], ['firstStartedAt', null],
    ['lastProgressAt', 1], ['lastResumedAt', 1], ['attempts', 1], ['attempts', '0'], ['resumeCount', 1],
    ['attemptHistory', [{}]], ['attemptHistory', {}], ['steps', [{}]], ['steps', undefined],
    ['customerMigrationV2', { phase: 'initialized' }], ['schedulerHandoff', {}], ['sourceTransferExecution', {}],
    ['restoreAttempt', {}], ['cutoverCommittedAt', 1], ['output', {}], ['nextAttemptAt', 1],
    ['completedAt', 1], ['completedAt', undefined], ['status', 'running'], ['createdAt', 0], ['createdAt', undefined],
    ['input', { fromGatewayId: 'shared-1' }], ['schedulerHandoffReleased', false], ['schedulerHandoffLost', 'unknown'],
    ['cancellationRequestedAt', 1], ['error', 'prior error'], ['rolledBack', false],
  ])('still blocks queued migration with prior or unknown work in %s=%j', async (field, value) => {
    const h = harness(); queuedMigration(h);
    h.store['glmOperations/queued'][field as string] = value;
    await expect(recoverSharedRestoreRuntime(h.deps, h.op, h.ctx)).rejects.toThrow('another migration is active');
    expect(h.deps.runKubectl.mock.calls.some(([args]) => args.includes('patch'))).toBe(false);
  });

  it('transfers a failed recovery fence to one new build without reopening the predecessor or acknowledging native restore', async () => {
    const { h, next, deps, predecessor, intent, nextImages } = await failedRecovery();
    const priorOperation = structuredClone(h.store['glmOperations/recover']);
    let observedTransfer = false;
    h.ctx.assertActiveClaim.mockImplementation(async () => {
      const fence = h.store['gateways/shared-1'].runtimeRestartFence;
      if (fence?.attemptId === next.id) {
        observedTransfer = true;
        expect(fence.target.podUid).toBe(predecessor.fence.target.podUid);
        expect(h.store['users/u'].provisioning.openclaw.restoreFence).toEqual(intent);
      }
    });
    await recoverSharedRestoreRuntime(deps, next, h.ctx);
    expect(observedTransfer).toBe(true);
    expect(h.store['glmOperations/recover']).toEqual(priorOperation);
    expect(h.store['glmOperations/successor'].restoreRuntimeRecovery).toMatchObject({ images: nextImages, previousRestoreAttempt: intent });
    expect(h.store['glmOperations/successor'].input.restoreRecovery.supersede).toEqual(predecessor);
    expect(h.store['users/u'].provisioning.openclaw.restoreFence).toMatchObject({ attemptId: intent.attemptId, phase: 'dispatched', reauthorizedBy: 'successor' });
    expect(h.store['gateways/shared-1'].runtimeRestartFence).toBeUndefined();
    expect(h.deps.runKubectl.mock.calls.filter(([args]) => args.includes('patch'))).toHaveLength(1);
    const renewed = h.store['glmOperations/return'].restoreAttempt;
    const claimStartedAt = renewed.claimStartedAt + 1;
    Object.assign(h.store['glmOperations/return'], { status: 'running', startedAt: claimStartedAt, attemptHistory: [] });
    const stateDeps: FleetStateDeps = { db: h.deps.db, deleteField: () => FieldValue.delete(), serverTimestamp: () => FieldValue.serverTimestamp() };
    const owned = await beginCustomerRestore(stateDeps, { uid: intent.uid, slug: intent.slug, gatewayId: intent.gatewayId,
      fromGatewayId: intent.fromGatewayId, assignmentEpoch: intent.assignmentEpoch, operationId: intent.operationId,
      claimStartedAt, attemptId: 'native-resume' }, { resume: true });
    await acknowledgeCustomerRestore(stateDeps, owned);
    expect(h.store['users/u'].provisioning.openclaw.restoreFence).toBeUndefined();
    expect(h.store['glmOperations/return'].restoreAttempt.phase).toBe('acknowledged');
  });
  it.each(['missing-fence', 'stale-id', 'running', 'succeeded', 'completed-proof', 'input-drift', 'unknown-predecessor',
    'pod-uid', 'pod-name', 'return', 'epoch', 'custody', 'reauthorization-drift', 'rebound-epoch', 'images', 'fence-drift', 'cancelled'])('rejects predecessor %s before changing custody or pod images', async (change) => {
    const { h, next, deps } = await failedRecovery();
    if (change === 'missing-fence') delete h.store['gateways/shared-1'].runtimeRestartFence;
    if (change === 'stale-id') (next.input.restoreRecovery as any).supersede.operationId = 'stale';
    if (change === 'running') h.store['glmOperations/recover'].status = 'running';
    if (change === 'succeeded') h.store['glmOperations/recover'].status = 'succeeded';
    if (change === 'completed-proof') h.store['glmOperations/recover'].restoreRuntimeRecovery = { completedAt: 500 };
    if (change === 'input-drift') h.store['glmOperations/recover'].input.extra = true;
    if (change === 'unknown-predecessor') delete h.store['glmOperations/recover'];
    if (change === 'pod-uid') h.pod.metadata.uid = 'replacement';
    if (change === 'pod-name') h.pod.metadata.name = 'replacement';
    if (change === 'return') (next.input.restoreRecovery as any).operationId = 'other-return';
    if (change === 'epoch') h.store['gateways/shared-1/assignments/u'].epoch++;
    if (change === 'custody') {
      h.store['glmOperations/return'].restoreAttempt.claimStartedAt++;
      h.store['users/u'].provisioning.openclaw.restoreFence.claimStartedAt++;
    }
    if (change === 'reauthorization-drift' || change === 'rebound-epoch') {
      const field = change === 'reauthorization-drift' ? 'claimStartedAt' : 'assignmentEpoch';
      h.store['glmOperations/return'].restoreAttempt[field]++;
      h.store['users/u'].provisioning.openclaw.restoreFence[field]++;
      (next.input.restoreRecovery as any).reauthorize[field]++;
      if (change === 'rebound-epoch') h.store['gateways/shared-1/assignments/u'].epoch++;
    }
    if (change === 'images') h.pod.spec.containers[0].image = 'unclaimed-image';
    if (change === 'fence-drift') h.store['gateways/shared-1'].runtimeRestartFence.startedAt++;
    if (change === 'cancelled') h.store['glmOperations/recover'].cancellationRequestedAt = 1;
    h.store['glmOperations/successor'].input = structuredClone(next.input);
    const before = structuredClone(h.store);
    await expect(recoverSharedRestoreRuntime(deps, next, h.ctx)).rejects.toThrow();
    expect(h.store).toEqual(before);
    expect(h.deps.runKubectl.mock.calls.some(([args]) => args.includes('patch'))).toBe(false);
  });
  it('rejects a second successor after the first has atomically acquired the retained fence', async () => {
    const { h, next, deps } = await failedRecovery();
    h.lostReply();
    await expect(recoverSharedRestoreRuntime(deps, next, h.ctx)).rejects.toThrow('unresolved');
    const owned = structuredClone(h.store['gateways/shared-1'].runtimeRestartFence);
    expect(owned.attemptId).toBe('successor');
    const other = { ...next, id: 'competitor', startedAt: 700 };
    h.store['glmOperations/competitor'] = structuredClone(other);
    await expect(recoverSharedRestoreRuntime(deps, other, h.ctx)).rejects.toThrow('predecessor changed');
    expect(h.store['gateways/shared-1'].runtimeRestartFence).toEqual(owned);
    await recoverSharedRestoreRuntime(deps, next, h.ctx);
    expect(h.deps.runKubectl.mock.calls.filter(([args]) => args.includes('patch'))).toHaveLength(1);
    expect(h.store['gateways/shared-1'].runtimeRestartFence).toBeUndefined();
  });
  it('waits for accepted successor images without repeating their patch and keeps native custody unchanged until ready', async () => {
    const { h, next, deps, intent } = await failedRecovery();
    h.setReady(false);
    let clock = 1;
    await expect(recoverSharedRestoreRuntime({ ...deps, now: () => clock, wait: async () => { clock += 240_000; } }, next, h.ctx))
      .rejects.toThrow('images are not ready');
    expect(h.store['gateways/shared-1'].runtimeRestartFence.attemptId).toBe(next.id);
    expect(h.store['users/u'].provisioning.openclaw.restoreFence).toEqual(intent);
    await expect(recoverSharedRestoreRuntime({ ...deps, now: () => clock, wait: async () => { clock += 240_000; } }, next, h.ctx))
      .rejects.toThrow('images are not ready');
    expect(h.deps.runKubectl.mock.calls.filter(([args]) => args.includes('patch'))).toHaveLength(1);
    h.pod.status.conditions = [{ type: 'Ready', status: 'True' }];
    h.pod.status.containerStatuses.forEach((container: any) => { container.ready = true; });
    await recoverSharedRestoreRuntime(deps, next, h.ctx);
    expect(h.deps.runKubectl.mock.calls.filter(([args]) => args.includes('patch'))).toHaveLength(1);
    expect(h.store['users/u'].provisioning.openclaw.restoreFence.reauthorizedBy).toBe(next.id);
  });
  it('reauthorizes only the retained paired intent after same-pod image readiness, preserving the original journal evidence', async () => {
    const h = harness(); const before = reauthorize(h);
    const scope = { uid: before.uid, slug: before.slug, gatewayId: before.gatewayId, fromGatewayId: before.fromGatewayId,
      assignmentEpoch: before.assignmentEpoch, operationId: before.operationId, attemptId: 'new-request', claimStartedAt: 300 };
    const stateDeps: FleetStateDeps = { db: h.deps.db, deleteField: () => FieldValue.delete(), serverTimestamp: () => FieldValue.serverTimestamp() };
    Object.assign(h.store['glmOperations/return'], { status: 'running', startedAt: 300, attemptHistory: [] });
    await expect(beginCustomerRestore(stateDeps, scope, { resume: true })).rejects.toThrow('resumption');
    h.store['glmOperations/return'].status = 'pending';
    await recoverSharedRestoreRuntime(h.deps, h.op, h.ctx);
    const renewed = h.store['glmOperations/return'].restoreAttempt;
    expect(renewed).toMatchObject({ uid: before.uid, attemptId: before.attemptId, assignmentEpoch: before.assignmentEpoch,
      operationId: before.operationId, phase: 'dispatched', reauthorizedBy: 'recover' });
    expect(renewed.claimStartedAt).toBeGreaterThan(200);
    expect(renewed.dispatchClaimStartedAt).toBe(renewed.claimStartedAt);
    expect(renewed.dispatchedAt).toBe(renewed.claimStartedAt);
    expect(h.store['users/u'].provisioning.openclaw.restoreFence).toEqual(renewed);
    expect(h.store['glmOperations/recover'].restoreRuntimeRecovery.previousRestoreAttempt).toEqual(before);
    expect(h.store['gateways/shared-1'].runtimeRestartFence).toBeUndefined();
    const calls = h.deps.runKubectl.mock.calls.length;
    await recoverSharedRestoreRuntime(h.deps, h.op, h.ctx);
    expect(h.deps.runKubectl).toHaveBeenCalledTimes(calls);
    expect(h.store['glmOperations/return'].restoreAttempt).toEqual(renewed);
    const nextClaim = renewed.claimStartedAt + 1;
    Object.assign(h.store['glmOperations/return'], { status: 'running', startedAt: nextClaim, attemptHistory: [] });
    const owned = await beginCustomerRestore(stateDeps, { ...scope, claimStartedAt: nextClaim }, { resume: true });
    expect(h.store['users/u'].provisioning.openclaw.restoreFence).toBeDefined();
    await acknowledgeCustomerRestore(stateDeps, owned);
    expect(h.store['users/u'].provisioning.openclaw.restoreFence).toBeUndefined();
    expect(h.store['glmOperations/return'].restoreAttempt.phase).toBe('acknowledged');
  });
  it('does not reauthorize after an ambiguous patch reply until readiness is observed on retry', async () => {
    const h = harness(); const before = reauthorize(h); h.lostReply();
    await expect(recoverSharedRestoreRuntime(h.deps, h.op, h.ctx)).rejects.toThrow('unresolved');
    expect(h.store['glmOperations/return'].restoreAttempt).toEqual(before);
    await recoverSharedRestoreRuntime(h.deps, h.op, h.ctx);
    expect(h.store['glmOperations/return'].restoreAttempt.reauthorizedBy).toBe('recover');
    expect(h.deps.runKubectl.mock.calls.filter(([args]) => args.includes('patch'))).toHaveLength(1);
  });
  it('rejects a changed paired intent even when both live copies agree', async () => {
    const h = harness(); reauthorize(h);
    h.store['glmOperations/return'].restoreAttempt.claimStartedAt++;
    h.store['users/u'].provisioning.openclaw.restoreFence.claimStartedAt++;
    await expect(recoverSharedRestoreRuntime(h.deps, h.op, h.ctx)).rejects.toThrow('reauthorization');
    expect(h.deps.runKubectl.mock.calls.some(([args]) => args.includes('patch'))).toBe(false);
  });
  it('refuses to renew terminally failed returns rather than reporting recovery without a runnable native return', async () => {
    const h = harness(); const before = reauthorize(h);
    h.store['glmOperations/return'].status = 'failed';
    await expect(recoverSharedRestoreRuntime(h.deps, h.op, h.ctx)).rejects.toThrow('reauthorization');
    expect(h.store['glmOperations/return'].restoreAttempt).toEqual(before);
    expect(h.store['users/u'].provisioning.openclaw.restoreFence).toEqual(before);
    expect(h.store['glmOperations/recover'].restoreRuntimeRecovery).toBeUndefined();
    expect(h.deps.runKubectl.mock.calls.some(([args]) => args.includes('patch'))).toBe(false);
  });
  it('keeps both fences when the return is claimed during the image update', async () => {
    const h = harness(); const before = reauthorize(h);
    h.ctx.assertActiveClaim.mockImplementation(async () => {
      if (h.ctx.assertActiveClaim.mock.calls.length === 4) h.store['glmOperations/return'].status = 'running';
    });
    await expect(recoverSharedRestoreRuntime(h.deps, h.op, h.ctx)).rejects.toThrow('authority');
    expect(h.store['users/u'].provisioning.openclaw.restoreFence).toEqual(before);
    expect(h.store['gateways/shared-1'].runtimeRestartFence).toBeDefined();
    h.store['glmOperations/return'].status = 'pending';
    await recoverSharedRestoreRuntime(h.deps, h.op, h.ctx);
    expect(h.store['gateways/shared-1'].runtimeRestartFence).toBeUndefined();
  });
  it('changes only same-pod images and preserves customer intent and release policy', async () => {
    const h = harness(); const before = structuredClone(h.store['users/u']);
    await recoverSharedRestoreRuntime(h.deps, h.op, h.ctx);
    expect(h.store['users/u']).toEqual(before);
    expect(h.store['gateways/shared-1']).toEqual({ gatewayClass: 'shared', desiredStatus: 'running', desiredRelease: 1, liveRelease: 1 });
    expect(h.store['glmOperations/recover'].restoreRuntimeRecovery).toMatchObject({ podUid: 'pod-uid', sourceSha: sha, images });
  });
  it('observes an executed patch after a lost reply without redispatch or a new pod', async () => {
    const h = harness(); h.lostReply();
    await expect(recoverSharedRestoreRuntime(h.deps, h.op, h.ctx)).rejects.toThrow('unresolved');
    expect(h.store['gateways/shared-1'].runtimeRestartFence.phase).toBe('dispatched');
    await recoverSharedRestoreRuntime(h.deps, h.op, h.ctx);
    expect(h.deps.runKubectl.mock.calls.filter(([args]) => args.includes('patch'))).toHaveLength(1);
  });
  it('retains durable completion if the worker dies before reporting success', async () => {
    const h = harness(); await recoverSharedRestoreRuntime(h.deps, h.op, h.ctx);
    h.store['glmOperations/return'].status = 'succeeded';
    const calls = h.deps.runKubectl.mock.calls.length;
    await recoverSharedRestoreRuntime(h.deps, h.op, h.ctx);
    expect(h.deps.runKubectl).toHaveBeenCalledTimes(calls);
  });
  it.each(['running-return', 'foreign-intent', 'epoch', 'retired', 'builder', 'roll', 'foreign-restart', 'migration', 'retained-transfer', 'stale-claim', 'cancelled', 'disk', 'wrong-owner', 'wrong-build'])('rejects %s before any image patch', async change => {
    const h = harness();
    if (change === 'running-return') h.store['glmOperations/return'].status = 'running';
    if (change === 'foreign-intent') h.store['users/u'].provisioning.openclaw.restoreFence.attemptId = 'foreign';
    if (change === 'epoch') h.store['gateways/shared-1/assignments/u'].epoch++;
    if (change === 'retired') h.store['gateways/shared-1'].desiredStatus = 'retired';
    if (change === 'builder') h.store['gateways/shared-1'].gatewayClass = 'builder';
    if (change === 'roll') h.store['gateways/shared-1'].desiredRelease++;
    if (change === 'foreign-restart') h.store['gateways/shared-1'].runtimeRestartFence = {};
    if (change === 'migration') h.store['glmOperations/other'] = { kind: 'migrate-customer', status: 'pending', input: { fromGatewayId: 'shared-1' } };
    if (change === 'retained-transfer') h.store['users/other'] = { provisioning: { openclaw: { sourceTransferFence: { sourceGatewayId: 'shared-1' } } } };
    if (change === 'stale-claim') h.store['glmOperations/recover'].startedAt++;
    if (change === 'cancelled') h.store['glmOperations/recover'].cancellationRequestedAt = 1;
    if (change === 'disk') h.pod.spec.volumes = [];
    if (change === 'wrong-owner') h.pod.metadata.ownerReferences[0].uid = 'foreign';
    if (change === 'wrong-build') h.deps.sourceSha = 'd'.repeat(40);
    await expect(recoverSharedRestoreRuntime(h.deps, h.op, h.ctx)).rejects.toThrow();
    expect(h.deps.runKubectl.mock.calls.some(([args]) => args.includes('patch'))).toBe(false);
  });
  it('refuses replacement pod storage after an ambiguous dispatch', async () => {
    const h = harness(); h.lostReply(); await expect(recoverSharedRestoreRuntime(h.deps, h.op, h.ctx)).rejects.toThrow();
    h.pod.metadata.uid = 'replacement';
    await expect(recoverSharedRestoreRuntime(h.deps, h.op, h.ctx)).rejects.toThrow('restart outcome');
    expect(h.store['gateways/shared-1'].runtimeRestartFence).toBeDefined();
  });
});
