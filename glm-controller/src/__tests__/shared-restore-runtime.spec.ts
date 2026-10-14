import { enqueuePlacementMigration, continuousPlacementMigrationOperationId } from '../placement-policy-reconciler.js';
import { createRestartGatewayHandler } from '../handlers/restart-gateway.js';
import { buildOperationCompletionUpdate, MAX_OPERATION_ATTEMPTS, MAX_OPERATION_ATTEMPT_HISTORY, classifyOperationFailure } from '../operation-retry.js';
import { readSharedSourceRecoveryAuthority } from "@octogee/core/shared-source-recovery";
import { recoverSharedSourceRuntime } from "../lib/shared-source-runtime.js";
import { describe, expect, it, vi } from 'vitest';
import { FieldValue } from 'firebase-admin/firestore';
import { acknowledgeCustomerRestore, beginCustomerRestore, setWorkspaceMigrationPhase, type FleetStateDeps } from '@octogee/core/fleet-state';
import type { Operation } from '@octogee/shared/types/glm';
import { recoverSharedRestoreRuntime } from '../lib/shared-restore-runtime.js';
import { processOperation } from '../index.js';
import { releaseAbandonedSchedulerHandoffs } from '../scheduler-handoff-release.js';
import { createRsyncMigrationTransfer } from '../lib/migration-rsync-transfer.js';

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
    const updateTime = (row: any) => { const version = JSON.stringify(row); return { version, isEqual: (other: any) => version === other?.version }; };
    if (target.path.split('/').length % 2 === 0) return { exists: !!store[target.path], data: () => store[target.path], updateTime: updateTime(store[target.path]) };
    return { docs: Object.entries(store).filter(([path, row]) => path.startsWith(`${target.path}/`) && !path.slice(target.path.length + 1).includes('/') &&
      target.filters.every((filter: any) => filter.comparator === 'in' ? filter.match.includes(value(row, filter.key)) : value(row, filter.key) === filter.match))
      .map(([path, row]) => ({ id: path.split('/').at(-1), ref: ref(path), updateTime: updateTime(row), data: () => row })) };
  };
  const db = { doc: ref, collection: ref, runTransaction: async (body: any) => {
    const writes: (() => void)[] = [];
    const result = await body({ get: async (target: any) => snapshot(target), create: (target: any, row: any) => writes.push(() => { expect(store[target.path]).toBeUndefined(); store[target.path] = structuredClone(row); }), update: (target: any, patch: any) => writes.push(() => {
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
  function nativeRestore(h: ReturnType<typeof harness>) {
    const returned = h.store['glmOperations/return'];
    returned.input.builderSlug = 'alice';
    const hold = { operationId: 'return', uid: 'u', slug: 'alice', fromGatewayId: 'builder-alice',
      toGatewayId: 'shared-1', migrationId: 'mig-return', archiveId: 'mig-activate', contextSha256: 'f'.repeat(64) };
    h.store['users/u'].provisioning.openclaw.nativeSharedContextRestore = hold;
    returned.nativeSharedAgentContextStage = { toGatewayId: 'shared-1', migrationId: hold.migrationId, slug: 'alice',
      targetName: 'pod', targetIp: '10.0.0.1', targetVm: false, targetCertificateSha256: 'e'.repeat(64),
      archive: { uid: 'u', slug: 'alice', archiveId: hold.archiveId, contextSha256: hold.contextSha256 } };
    Object.assign(h.store['gateways/shared-1/assignments/u'], { state: 'quiescing', updatedByOperationId: 'return' });
    return hold;
  }
  it('recovers a quiescing native archive restore on the same pod without admitting or acknowledging the customer', async () => {
    const h = harness(); nativeRestore(h);
    const user = structuredClone(h.store['users/u']);
    const returned = structuredClone(h.store['glmOperations/return']);
    const assignment = structuredClone(h.store['gateways/shared-1/assignments/u']);
    await recoverSharedRestoreRuntime(h.deps, h.op, h.ctx);
    expect(h.deps.runKubectl.mock.calls.filter(([args]) => args.includes('patch'))).toHaveLength(1);
    expect(h.store['users/u']).toEqual(user);
    expect(h.store['glmOperations/return']).toEqual(returned);
    expect(h.store['gateways/shared-1/assignments/u']).toEqual(assignment);
    expect(h.store['glmOperations/recover'].restoreRuntimeRecovery.podUid).toBe('pod-uid');
    expect(h.store['gateways/shared-1'].runtimeRestartFence).toBeUndefined();
  });
  it('observes a lost quiescing recovery patch reply on the same pod without repeating it or changing native custody', async () => {
    const h = harness(); nativeRestore(h); h.lostReply();
    const returned = structuredClone(h.store['glmOperations/return']);
    await expect(recoverSharedRestoreRuntime(h.deps, h.op, h.ctx)).rejects.toThrow('unresolved');
    await recoverSharedRestoreRuntime(h.deps, h.op, h.ctx);
    expect(h.deps.runKubectl.mock.calls.filter(([args]) => args.includes('patch'))).toHaveLength(1);
    expect(h.store['glmOperations/return']).toEqual(returned);
    expect(h.store['gateways/shared-1/assignments/u'].state).toBe('quiescing');
  });
  it('retains restart and restore fences when native archive authority changes during the image update', async () => {
    const h = harness(); const hold = nativeRestore(h);
    const original = structuredClone(hold);
    const returned = structuredClone(h.store['glmOperations/return']);
    const kubectl = h.deps.runKubectl.getMockImplementation()!;
    h.deps.runKubectl.mockImplementation(async args => {
      const result = await kubectl(args);
      if (args.includes('patch')) hold.archiveId = 'other';
      return result;
    });
    await expect(recoverSharedRestoreRuntime(h.deps, h.op, h.ctx)).rejects.toThrow('assignment changed');
    expect(h.store['gateways/shared-1'].runtimeRestartFence.phase).toBe('dispatched');
    expect(h.store['users/u'].provisioning.openclaw.restoreFence).toEqual(returned.restoreAttempt);
    expect(h.store['glmOperations/return']).toEqual(returned);
    Object.assign(hold, original);
    await recoverSharedRestoreRuntime(h.deps, h.op, h.ctx);
    expect(h.deps.runKubectl.mock.calls.filter(([args]) => args.includes('patch'))).toHaveLength(1);
    expect(h.store['gateways/shared-1'].runtimeRestartFence).toBeUndefined();
  });
  it.each(['missing-hold', 'operation', 'uid', 'slug', 'from', 'to', 'migration', 'archive', 'digest', 'invalid-digest',
    'stage-target', 'stage-slug', 'stage-migration', 'archive-owner', 'archive-slug', 'archive-id', 'archive-digest',
    'missing-stage', 'assignment-operation', 'epoch', 'restored', 'receipt', 'other-migration', 'input-slug'])('rejects quiescing native restore %s before reserving custody or patching images', async change => {
      const h = harness(); const hold = nativeRestore(h);
      const returned = h.store['glmOperations/return'], stage = returned.nativeSharedAgentContextStage;
      const openclaw = h.store['users/u'].provisioning.openclaw;
      if (change === 'missing-hold') delete openclaw.nativeSharedContextRestore;
      for (const [key, field] of [['operation', 'operationId'], ['uid', 'uid'], ['slug', 'slug'], ['from', 'fromGatewayId'],
        ['to', 'toGatewayId'], ['migration', 'migrationId'], ['archive', 'archiveId'], ['digest', 'contextSha256']]) {
        if (change === key) (hold as any)[field] = 'foreign';
      }
      if (change === 'invalid-digest') hold.contextSha256 = stage.archive.contextSha256 = 'invalid';
      if (change === 'stage-target') stage.toGatewayId = 'other';
      if (change === 'stage-slug') stage.slug = 'other';
      if (change === 'stage-migration') stage.migrationId = 'other';
      if (change === 'archive-owner') stage.archive.uid = 'other';
      if (change === 'archive-slug') stage.archive.slug = 'other';
      if (change === 'archive-id') stage.archive.archiveId = 'other';
      if (change === 'archive-digest') stage.archive.contextSha256 = 'a'.repeat(64);
      if (change === 'missing-stage') delete returned.nativeSharedAgentContextStage;
      if (change === 'assignment-operation') h.store['gateways/shared-1/assignments/u'].updatedByOperationId = 'other';
      if (change === 'epoch') h.store['gateways/shared-1/assignments/u'].epoch++;
      if (change === 'restored') returned.nativeSharedAgentContextRestored = true;
      if (change === 'receipt') returned.nativeSharedAgentContextRestoreReceipt = {};
      if (change === 'other-migration') openclaw.migration = {};
      if (change === 'input-slug') returned.input.builderSlug = 'other';
      const before = structuredClone(h.store);
      await expect(recoverSharedRestoreRuntime(h.deps, h.op, h.ctx)).rejects.toThrow();
      expect(h.store).toEqual(before);
      expect(h.deps.runKubectl.mock.calls.some(([args]) => args.includes('patch'))).toBe(false);
    });
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
  it('keeps explicit reauthorization mandatory for a failed predecessor even when its prior request omitted it', async () => {
    const { h, next, deps } = await failedRecovery();
    delete (next.input.restoreRecovery as any).reauthorize;
    delete (h.store['glmOperations/recover'].input.restoreRecovery as any).reauthorize;
    delete (next.input.restoreRecovery as any).supersede.input.restoreRecovery.reauthorize;
    h.store['glmOperations/successor'].input = structuredClone(next.input);
    const before = structuredClone(h.store);
    await expect(recoverSharedRestoreRuntime(deps, next, h.ctx)).rejects.toThrow();
    expect(h.store).toEqual(before);
    expect(h.deps.runKubectl.mock.calls.some(([args]) => args.includes('patch'))).toBe(false);
  });
  async function pendingRecovery() {
    const h = harness(); const hold = nativeRestore(h);
    Object.assign(h.store['glmOperations/return'], { startedAt: null, completedAt: null });
    h.store['users/u'].provisioning.openclaw.activationLease = { status: 'returning', returnOperationId: 'return', targetGatewayId: 'builder-alice' };
    h.setReady(false); let clock = 1;
    await expect(recoverSharedRestoreRuntime({ ...h.deps, now: () => clock, wait: async () => { clock += 240_000; } }, h.op, h.ctx)).rejects.toThrow('images are not ready');
    Object.assign(h.store['glmOperations/recover'], { status: 'pending', startedAt: null, completedAt: null,
      error: 'restore recovery images are not ready; outcome remains fenced', attempts: 1, nextAttemptAt: Date.now() + 60_000 });
    const predecessor = { operationId: 'recover', status: 'pending', startedAt: null, input: structuredClone(h.op.input), completedAt: null,
      fence: structuredClone(h.store['gateways/shared-1'].runtimeRestartFence), pendingNativeRestore: {
        restoreAttempt: structuredClone(h.store['glmOperations/return'].restoreAttempt), nativeSharedContextRestore: structuredClone(hold),
        nativeSharedAgentContextStage: structuredClone(h.store['glmOperations/return'].nativeSharedAgentContextStage),
        assignment: structuredClone(h.store['gateways/shared-1/assignments/u']) } };
    const nextSha = 'd'.repeat(40), nextImages = Object.fromEntries(Object.entries(images).map(([name, image]) => [name,
      image.replace('aaaaaaa', 'ddddddd').replace(/@sha256:.+$/, `@sha256:${'e'.repeat(64)}`)]));
    const next = { ...h.op, id: 'successor', startedAt: 600, input: { gatewayId: 'shared-1',
      restoreRecovery: { operationId: 'return', sourceSha: nextSha, images: nextImages, supersede: predecessor } } } as Operation;
    h.store['glmOperations/successor'] = structuredClone(next); h.deps.runKubectl.mockClear(); h.setReady(true);
    return { h, next, deps: { ...h.deps, sourceSha: nextSha }, predecessor, nextImages };
  }
  it('atomically supersedes only an unclaimed pending image recovery while preserving the native restore intent and same pod', async () => {
    const { h, next, deps, predecessor } = await pendingRecovery();
    const originalReturn = structuredClone(h.store['glmOperations/return']);
    const originalUser = structuredClone(h.store['users/u']);
    const prior = structuredClone(h.store['glmOperations/recover']);
    const kubectl = h.deps.runKubectl.getMockImplementation()!;
    h.deps.runKubectl.mockImplementation(async args => {
      if (args.includes('patch')) {
        expect(h.store['glmOperations/recover']).toMatchObject({ status: 'failed', startedAt: null,
          cancellationRequestedAt: expect.any(Number), restoreRecoverySupersededBy: next.id });
        expect(h.store['gateways/shared-1'].runtimeRestartFence.attemptId).toBe(next.id);
      }
      return kubectl(args);
    });
    await recoverSharedRestoreRuntime(deps, next, h.ctx);
    expect(h.store['glmOperations/recover']).toMatchObject({ input: prior.input, error: prior.error, attempts: 1, completedAt: expect.any(Number) });
    expect(h.store['glmOperations/return']).toEqual(originalReturn);
    expect(h.store['users/u']).toEqual(originalUser);
    expect(h.store['glmOperations/successor'].restoreRuntimeRecovery.podUid).toBe(predecessor.fence.target.podUid);
    expect(h.store['glmOperations/successor'].input.restoreRecovery.reauthorize).toBeUndefined();
  });
  it.each(['running', 'claimed', 'completed', 'cancelled', 'receipt', 'input', 'fence', 'intent', 'stage', 'epoch', 'pod'])('refuses pending predecessor %s without changing either owner or pod', async change => {
      const { h, next, deps } = await pendingRecovery(); const prior = h.store['glmOperations/recover'];
      if (change === 'running') prior.status = 'running';
      if (change === 'claimed') prior.startedAt = 800;
      if (change === 'completed') prior.completedAt = 800;
      if (change === 'cancelled') prior.cancellationRequestedAt = 800;
      if (change === 'receipt') prior.restoreRuntimeRecovery = {};
      if (change === 'input') prior.input.extra = true;
      if (change === 'fence') h.store['gateways/shared-1'].runtimeRestartFence.startedAt++;
      if (change === 'intent') { h.store['glmOperations/return'].restoreAttempt.claimStartedAt++;
        h.store['users/u'].provisioning.openclaw.restoreFence.claimStartedAt++; }
      if (change === 'stage') h.store['glmOperations/return'].nativeSharedAgentContextStage.targetCertificateSha256 = 'a'.repeat(64);
      if (change === 'epoch') { h.store['gateways/shared-1/assignments/u'].epoch++;
        h.store['glmOperations/return'].restoreAttempt.assignmentEpoch++; h.store['users/u'].provisioning.openclaw.restoreFence.assignmentEpoch++; }
      if (change === 'pod') h.pod.metadata.uid = 'replacement';
      const before = structuredClone(h.store);
      await expect(recoverSharedRestoreRuntime(deps, next, h.ctx)).rejects.toThrow();
      expect(h.store).toEqual(before); expect(h.deps.runKubectl.mock.calls.some(([args]) => args.includes('patch'))).toBe(false);
    });
  it('prevents a superseded pending retry from claiming and a stale predecessor from clearing the successor fence', async () => {
    const { h, next, deps } = await pendingRecovery();
    const pending = structuredClone(h.store['glmOperations/recover']);
    const handler = vi.fn(async () => ({ success: true, steps: [] }));
    const kubectl = h.deps.runKubectl.getMockImplementation()!;
    h.deps.runKubectl.mockImplementation(async args => {
      if (args.includes('patch')) {
        const fence = structuredClone(h.store['gateways/shared-1'].runtimeRestartFence);
        await processOperation({ ...pending, id: 'recover' }, (h.deps.db as any).doc('glmOperations/recover'),
          { db: h.deps.db, handlers: { 'restart-gateway': handler }, log: vi.fn() } as never);
        expect(handler).not.toHaveBeenCalled();
        await expect(recoverSharedRestoreRuntime(h.deps, h.op, h.ctx)).rejects.toThrow('paired post-cutover restore authority');
        expect(h.store['gateways/shared-1'].runtimeRestartFence).toEqual(fence);
      }
      return kubectl(args);
    });
    await recoverSharedRestoreRuntime(deps, next, h.ctx);
    expect(h.store['glmOperations/recover'].restoreRuntimeRecovery).toBeUndefined();
    expect(h.store['glmOperations/successor'].restoreRuntimeRecovery.podUid).toBe('pod-uid');
  });
  async function failedNativeRecovery() {
    const h = await pendingRecovery();
    Object.assign(h.h.store['glmOperations/recover'], { status: 'failed', startedAt: 300, completedAt: 500 });
    Object.assign(h.predecessor, { status: 'failed', startedAt: 300, completedAt: 500 });
    h.h.store['glmOperations/successor'].input = structuredClone(h.next.input);
    return h;
  }
  it('supersedes a failed native image recovery without rewriting completion, failure, history or restore intent', async () => {
    const { h, next, deps } = await failedNativeRecovery();
    const prior = structuredClone(h.store['glmOperations/recover']);
    const returned = structuredClone(h.store['glmOperations/return']);
    await recoverSharedRestoreRuntime(deps, next, h.ctx);
    expect(h.store['glmOperations/recover']).toMatchObject({ completedAt: prior.completedAt, error: prior.error,
      input: prior.input, attempts: prior.attempts, cancellationRequestedAt: expect.any(Number), restoreRecoverySupersededBy: next.id });
    expect(h.store['glmOperations/return']).toEqual(returned);
    expect(h.store['glmOperations/successor'].restoreRuntimeRecovery.previousRestoreAttempt).toBeUndefined();
  });
  it.each(['completedAt', 'error'])('refuses a changed failed native predecessor %s without transferring custody', async change => {
    const { h, next, deps } = await failedNativeRecovery();
    h.store['glmOperations/recover'][change] = change === 'completedAt' ? 501 : 'another failure';
    const before = structuredClone(h.store);
    await expect(recoverSharedRestoreRuntime(deps, next, h.ctx)).rejects.toThrow();
    expect(h.store).toEqual(before);
    expect(h.deps.runKubectl.mock.calls.some(([args]) => args.includes('patch'))).toBe(false);
  });
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

  function blockedPreTransportMigration(h: ReturnType<typeof harness>, attempts = 13) {
    const queued = queuedMigration(h);
    const row = h.store['glmOperations/queued'];
    const error = 'expected exactly one ready pod for transport=shared-1; found 0';
    row.input = { uid: 'other', builderSlug: 'bob', fromGatewayId: 'shared-1', toGatewayId: 'shared-2' };
    Object.assign(row, { attempts, firstStartedAt: 1_100, lastProgressAt: 1_200 + attempts * 100, nextAttemptAt: 481_200 + attempts * 100,
      error: `attempt ${attempts} failed (transient): ${error} — retrying in 480s`, output: { stateMigration: { strategy: 'migrate-state' } },
      schedulerHandoff: { uid: 'other', slug: 'bob', fromGatewayId: 'shared-1', toGatewayId: 'shared-2', migrationId: `mig-queued:scheduler:${attempts}` },
      schedulerHandoffReleased: false, attemptHistory: Array.from({ length: attempts }, (_, index) => ({
        attempt: index + 1, startedAt: 1_100 + index * 100, completedAt: 1_200 + index * 100,
        error, classification: 'transient', steps: [{ name: 'keys-sync-state', status: 'failed', error }],
      })).slice(-MAX_OPERATION_ATTEMPT_HISTORY) });
    h.store['users/other'] = { provisioning: { openclaw: { status: 'complete', gatewayId: 'shared-1',
      migration: { operationId: 'queued', phase: 'preparing', state: 'preparing', startedAt: 1_100 } } } };
    h.store['gateways/shared-1/assignments/other'] = { uid: 'other', slug: 'bob', gatewayId: 'shared-1', state: 'serving', epoch: 0, updatedByOperationId: null };
    const scheduler = vi.fn(async () => { throw new Error('no scheduler RPC is safe while the source is unavailable'); });
    const release = () => releaseAbandonedSchedulerHandoffs({ db: h.deps.db, scheduler,
      gatewayExists: vi.fn(async () => false), log: vi.fn(), now: () => Math.max(3_000, 1_300 + attempts * 100) });
    return { ...queued, release, scheduler, row };
  }

  it('releases a proven pre-transport retry through its owner before admitting same-pod restore recovery', async () => {
    const h = harness(); const queued = blockedPreTransportMigration(h);
    const before = structuredClone(h.store);
    await expect(recoverSharedRestoreRuntime(h.deps, h.op, h.ctx)).rejects.toThrow('another migration is active');
    expect(h.store).toEqual(before);
    await expect(queued.release()).resolves.toEqual({ released: 1 });
    expect(queued.scheduler).not.toHaveBeenCalled();
    expect(queued.row).toEqual({ ...before['glmOperations/queued'], schedulerHandoffReleased: true, schedulerHandoffReleasedAt: 3_000 });
    const released = structuredClone(queued.row);
    const kubectl = h.deps.runKubectl.getMockImplementation()!;
    h.deps.runKubectl.mockImplementation(async args => {
      if (args.includes('patch')) {
        await queued.run();
        expect(queued.handler).not.toHaveBeenCalled();
        expect(queued.row).toEqual(released);
      }
      return kubectl(args);
    });
    await recoverSharedRestoreRuntime(h.deps, h.op, h.ctx);
    expect(h.deps.runKubectl.mock.calls.filter(([args]) => args.includes('patch'))).toHaveLength(1);
    expect(queued.row).toEqual(released);
    expect(h.store['users/other']).toEqual(before['users/other']);
    expect(h.store['gateways/shared-1/assignments/other']).toEqual(before['gateways/shared-1/assignments/other']);
    expect(h.store['glmOperations/return']).toEqual(before['glmOperations/return']);
    expect(h.store['users/u']).toEqual(before['users/u']);
  });

  it.each([1, 5, 282])('recovers a repeated Shared placement with serving epoch %s and a prior operation owner', async epoch => {
    const h = harness(); const queued = blockedPreTransportMigration(h);
    Object.assign(h.store['gateways/shared-1/assignments/other'], { epoch, updatedByOperationId: 'completed-prior-shared-move' });
    const assignment = structuredClone(h.store['gateways/shared-1/assignments/other']);
    await expect(queued.release()).resolves.toEqual({ released: 1 });
    await recoverSharedRestoreRuntime(h.deps, h.op, h.ctx);
    expect(queued.scheduler).not.toHaveBeenCalled();
    expect(h.store['gateways/shared-1/assignments/other']).toEqual(assignment);
    expect(h.deps.runKubectl.mock.calls.filter(([args]) => args.includes('patch'))).toHaveLength(1);
  });

  it.each([21, 37])('recovers after attempt %s with the complete retained contiguous suffix ending at its current handoff', async attempts => {
    const h = harness(); const queued = blockedPreTransportMigration(h, attempts);
    const history = structuredClone(queued.row.attemptHistory);
    expect(history).toHaveLength(MAX_OPERATION_ATTEMPT_HISTORY); expect(history[0].attempt).toBe(attempts - MAX_OPERATION_ATTEMPT_HISTORY + 1);
    await expect(queued.release()).resolves.toEqual({ released: 1 });
    await recoverSharedRestoreRuntime(h.deps, h.op, h.ctx);
    expect(queued.scheduler).not.toHaveBeenCalled(); expect(queued.row.attemptHistory).toEqual(history);
    expect(h.deps.runKubectl.mock.calls.filter(([args]) => args.includes('patch'))).toHaveLength(1);
  });

  it('recovers a retained two-pod selector failure followed by the current zero-pod failure', async () => {
    const h = harness(); const queued = blockedPreTransportMigration(h);
    const prior = queued.row.attemptHistory[0];
    prior.error = prior.steps[0].error = 'expected exactly one ready pod for transport=shared-1; found 2';
    const before = structuredClone(h.store);
    await expect(queued.release()).resolves.toEqual({ released: 1 });
    await recoverSharedRestoreRuntime(h.deps, h.op, h.ctx);
    expect(queued.scheduler).not.toHaveBeenCalled();
    expect(queued.row.attemptHistory).toEqual(before['glmOperations/queued'].attemptHistory);
    expect(h.store['users/other']).toEqual(before['users/other']);
    expect(h.store['gateways/shared-1/assignments/other']).toEqual(before['gateways/shared-1/assignments/other']);
    expect(h.deps.runKubectl.mock.calls.filter(([args]) => args.includes('patch'))).toHaveLength(1);
  });

  it('releases the captured provisioning owner without completing it or changing its preparing migration custody', async () => {
    const h = harness(); const queued = blockedPreTransportMigration(h, 25);
    const owner = h.store['users/other'].provisioning.openclaw;
    owner.status = 'provisioning'; owner.migration.startedAt = 1_791_942_726_854;
    const before = structuredClone(h.store);
    await expect(queued.release()).resolves.toEqual({ released: 1 });
    await recoverSharedRestoreRuntime(h.deps, h.op, h.ctx);
    expect(queued.scheduler).not.toHaveBeenCalled();
    expect(h.store['users/other']).toEqual(before['users/other']);
    expect(h.store['gateways/shared-1/assignments/other']).toEqual(before['gateways/shared-1/assignments/other']);
    expect(h.store['gateways/shared-2/assignments/other']).toBeUndefined();
    expect(h.store['glmOperations/queued'].attemptHistory).toEqual(before['glmOperations/queued'].attemptHistory);
    expect(h.store['glmOperations/return']).toEqual(before['glmOperations/return']);
    expect(h.store['users/u']).toEqual(before['users/u']);
    expect(h.deps.runKubectl.mock.calls.filter(([args]) => args.includes('patch'))).toHaveLength(1);
  });

  it.each(['unknown', 'error', undefined])('denies an unrecognized lifecycle owner status %j', async status => {
    const h = harness(); const queued = blockedPreTransportMigration(h, 25);
    h.store['users/other'].provisioning.openclaw.status = status;
    const before = structuredClone(h.store);
    await expect(queued.release()).resolves.toEqual({ released: 0 });
    expect(h.store).toEqual(before);
    Object.assign(queued.row, { schedulerHandoffReleased: true, schedulerHandoffReleasedAt: 4_000 });
    await expect(recoverSharedRestoreRuntime(h.deps, h.op, h.ctx)).rejects.toThrow('another migration is active');
    expect(h.deps.runKubectl.mock.calls.some(([args]) => args.includes('patch'))).toBe(false);
  });

  it('does not release a provisioning owner whose preparing marker belongs to another operation', async () => {
    const h = harness(); const queued = blockedPreTransportMigration(h, 25);
    Object.assign(h.store['users/other'].provisioning.openclaw, { status: 'provisioning',
      migration: { state: 'preparing', phase: 'preparing', operationId: 'another-move', startedAt: 1_791_942_726_854 } });
    await expect(queued.release()).resolves.toEqual({ released: 0 });
    Object.assign(queued.row, { schedulerHandoffReleased: true, schedulerHandoffReleasedAt: 4_000 });
    await expect(recoverSharedRestoreRuntime(h.deps, h.op, h.ctx)).rejects.toThrow('another migration is active');
    expect(h.deps.runKubectl.mock.calls.some(([args]) => args.includes('patch'))).toBe(false);
  });

  it.each([
    'expected exactly one ready pod for transport=shared-1; found 1',
    'expected exactly one ready pod for transport=shared-1; found -1',
    'expected exactly one ready pod for transport=shared-1; found 2.5',
    'expected exactly one ready pod for transport=shared-1; found 02',
    'expected exactly one ready pod for transport=shared-1; found 1e1',
    'expected exactly one ready pod for transport=shared-1; found unknown',
    'expected exactly one ready pod for transport=shared-1; found 2; socket closed',
    'expected exactly one ready pod for transport=shared-2; found 2',
    'expected exactly one running pod for transport=shared-1; found 2',
    'socket closed before connect response',
  ])('denies prior keys failures outside the exact same-source pod-selector contract: %s', async error => {
    const h = harness(); const queued = blockedPreTransportMigration(h);
    const prior = queued.row.attemptHistory[0]; prior.error = prior.steps[0].error = error;
    await expect(queued.release()).resolves.toEqual({ released: 0 });
    Object.assign(queued.row, { schedulerHandoffReleased: true, schedulerHandoffReleasedAt: 3_000 });
    const before = structuredClone(h.store);
    await expect(recoverSharedRestoreRuntime(h.deps, h.op, h.ctx)).rejects.toThrow('another migration is active');
    expect(h.store).toEqual(before); expect(queued.scheduler).not.toHaveBeenCalled();
    expect(h.deps.runKubectl.mock.calls.some(([args]) => args.includes('patch'))).toBe(false);
  });

  it('requires the latest selector failure to remain zero even after a known earlier two-pod failure', async () => {
    const h = harness(); const queued = blockedPreTransportMigration(h);
    for (const attempt of queued.row.attemptHistory) {
      attempt.error = attempt.steps[0].error = 'expected exactly one ready pod for transport=shared-1; found 2';
    }
    await expect(queued.release()).resolves.toEqual({ released: 0 });
    Object.assign(queued.row, { schedulerHandoffReleased: true, schedulerHandoffReleasedAt: 3_000 });
    await expect(recoverSharedRestoreRuntime(h.deps, h.op, h.ctx)).rejects.toThrow('another migration is active');
    expect(h.deps.runKubectl.mock.calls.some(([args]) => args.includes('patch'))).toBe(false);
  });

  it.each([0, 2])('fails actual source pod selection at cardinality %s before gateway RPC or guest execution', async count => {
    let task: any;
    const ref = { get: async () => ({ exists: task !== undefined, data: () => task }),
      set: async (patch: any) => { task = { ...task, ...patch }; } };
    const db = { collection: () => ({ doc: () => ref }), runTransaction: async (fn: any) => fn({
      get: (target: any) => target.get(), set: (target: any, value: any) => target.set(value),
    }) };
    const fetch = vi.fn(async () => { throw new Error('gateway RPC must not run before source selection'); });
    const resolveGatewayUrl = vi.fn(() => { throw new Error('gateway control URL must not be used before source selection'); });
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      expect(command).toBe('kubectl'); expect(args.slice(0, 4)).toEqual(['-n', 'octogee-test', 'get', 'pods']);
      const source = args[args.indexOf('-l') + 1].endsWith('gateway-instance=shared-1');
      return { code: 0, stderr: '', stdout: JSON.stringify({ items: Array.from({ length: source ? count : 1 }, (_, index) => ({
        metadata: { name: `pod-${index}` }, status: { phase: 'Running', podIP: `10.0.0.${index + 1}`, conditions: [{ type: 'Ready', status: 'True' }] },
      })) }) };
    });
    const transfer = createRsyncMigrationTransfer({ db: db as never, namespace: 'octogee-test',
      privateKey: 'unused-before-gateway-rpc', fleetControllerPort: '3003', fetch, resolveGatewayUrl, runCommand });
    await expect(transfer({ migrationId: 'mig-queued', slug: 'bob', fromGatewayId: 'shared-1', toGatewayId: 'shared-2', mode: 'keys' }))
      .rejects.toMatchObject({ message: `expected exactly one ready pod for transport=shared-1; found ${count}`, retryable: true });
    expect(fetch).not.toHaveBeenCalled(); expect(resolveGatewayUrl).not.toHaveBeenCalled(); expect(runCommand).toHaveBeenCalledTimes(2);
    expect(task).toMatchObject({ status: 'failed', error: `expected exactly one ready pod for transport=shared-1; found ${count}` });
  });

  it.each(['short-suffix', 'gap', 'duplicate', 'unknown-attempt', 'wrong-latest', 'stale-handoff', 'retained-hold', 'unknown-steps'])('denies capped history with %s', async change => {
    const h = harness(); const queued = blockedPreTransportMigration(h, 37);
    const history = queued.row.attemptHistory;
    if (change === 'short-suffix') history.shift();
    if (change === 'gap') history[4].attempt += 1;
    if (change === 'duplicate') history[4].attempt = history[3].attempt;
    if (change === 'unknown-attempt') delete history[4].attempt;
    if (change === 'wrong-latest') history.at(-1).attempt -= 1;
    if (change === 'stale-handoff') queued.row.schedulerHandoff.migrationId = 'mig-queued:scheduler:36';
    if (change === 'retained-hold') history[0].steps.push({ name: 'quiesce-source', status: 'done' });
    if (change === 'unknown-steps') delete history.at(-1).steps;
    const before = structuredClone(h.store);
    await expect(queued.release()).resolves.toEqual({ released: 0 });
    expect(h.store).toEqual(before); expect(queued.scheduler).not.toHaveBeenCalled();
    Object.assign(queued.row, { schedulerHandoffReleased: true, schedulerHandoffReleasedAt: 5_000 });
    const released = structuredClone(h.store);
    await expect(recoverSharedRestoreRuntime(h.deps, h.op, h.ctx)).rejects.toThrow('another migration is active');
    expect(h.store).toEqual(released);
    expect(h.deps.runKubectl.mock.calls.some(([args]) => args.includes('patch'))).toBe(false);
  });

  it.each([-1, 1.5, '2', undefined, Number.NaN])('denies a noncanonical source epoch %j', async epoch => {
    const h = harness(); const queued = blockedPreTransportMigration(h);
    h.store['gateways/shared-1/assignments/other'].epoch = epoch;
    await expect(queued.release()).resolves.toEqual({ released: 0 });
    Object.assign(queued.row, { schedulerHandoffReleased: true, schedulerHandoffReleasedAt: 3_000 });
    await expect(recoverSharedRestoreRuntime(h.deps, h.op, h.ctx)).rejects.toThrow('another migration is active');
    expect(h.deps.runKubectl.mock.calls.some(([args]) => args.includes('patch'))).toBe(false);
  });

  it('denies a source assignment already owned by the current attempted migration', async () => {
    const h = harness(); const queued = blockedPreTransportMigration(h);
    h.store['gateways/shared-1/assignments/other'].updatedByOperationId = 'queued';
    await expect(queued.release()).resolves.toEqual({ released: 0 });
    Object.assign(queued.row, { schedulerHandoffReleased: true, schedulerHandoffReleasedAt: 3_000 });
    await expect(recoverSharedRestoreRuntime(h.deps, h.op, h.ctx)).rejects.toThrow('another migration is active');
    expect(h.deps.runKubectl.mock.calls.some(([args]) => args.includes('patch'))).toBe(false);
  });

  it.each([
    ['startedAt', 2_600], ['status', 'running'], ['completedAt', 2_600], ['steps', [{ name: 'keys-sync-state', status: 'running' }]],
    ['attempts', 14], ['attemptHistory', undefined], ['attemptHistory', []], ['resumeCount', 1], ['lastResumedAt', 2_500],
    ['customerMigrationV2', {}], ['sourceTransferExecution', {}], ['schedulerHandoffLost', true], ['cutoverCommittedAt', 2_000],
    ['restoreAttempt', {}], ['cancellationRequestedAt', 2_000], ['rolledBack', false], ['output', { configCleanup: {} }],
    ['input.toGatewayId', 'builder-other'], ['input.sourceTransferMode', 'retained-pod'],
    ['input.recoverSourceOnly', true], ['schedulerHandoff.migrationId', 'mig-queued:scheduler:12'], ['schedulerHandoff.uid', 'foreign'],
    ['schedulerHandoff.slug', 'foreign'], ['schedulerHandoff.fromGatewayId', 'shared-foreign'], ['schedulerHandoff.toGatewayId', 'shared-foreign'],
    ['schedulerHandoff.stageAfterCutover', true], ['schedulerHandoff.stagedAt', 2_000], ['schedulerHandoff.sourceRecovery', {}],
    ['attemptHistory.0.steps', [{ name: 'quiesce-source', status: 'done' }]], ['attemptHistory.12.classification', 'terminal'],
    ['attemptHistory.12.steps.0.status', 'running'], ['attemptHistory.12.steps.0.error', 'socket closed before connect response'],
    ['attemptHistory.12.error', 'expected exactly one ready pod for transport=shared-2; found 0'],
  ])('keeps attempted or ambiguous queued work fenced at %s=%j', async (path, value) => {
    const h = harness(); const queued = blockedPreTransportMigration(h);
    const parts = (path as string).split('.');
    const target = parts.slice(0, -1).reduce((row, key) => row[key], queued.row);
    target[parts.at(-1)!] = value;
    const before = structuredClone(h.store);
    await expect(queued.release()).resolves.toEqual({ released: 0 });
    expect(h.store).toEqual(before); expect(queued.scheduler).not.toHaveBeenCalled();
    Object.assign(queued.row, { schedulerHandoffReleased: true, schedulerHandoffReleasedAt: 3_000 });
    const released = structuredClone(h.store);
    await expect(recoverSharedRestoreRuntime(h.deps, h.op, h.ctx)).rejects.toThrow('another migration is active');
    expect(h.store).toEqual(released);
    expect(h.deps.runKubectl.mock.calls.some(([args]) => args.includes('patch'))).toBe(false);
  });

  it.each(['owner', 'marker', 'phase', 'restore-fence', 'transfer-fence', 'native-custody', 'source-missing', 'source-uid', 'source-slug',
    'source-gateway', 'source-state', 'source-epoch', 'source-operation', 'target-assignment'])('refuses pre-transport release and recovery after %s changes', async change => {
    const h = harness(); const queued = blockedPreTransportMigration(h);
    const owner = h.store['users/other'].provisioning.openclaw;
    const source = h.store['gateways/shared-1/assignments/other'];
    if (change === 'owner') owner.gatewayId = 'shared-2';
    if (change === 'marker') owner.migration.operationId = 'foreign';
    if (change === 'phase') owner.migration.phase = 'transferring';
    if (change === 'restore-fence') owner.restoreFence = {};
    if (change === 'transfer-fence') owner.sourceTransferFence = { sourceGatewayId: 'shared-1' };
    if (change === 'native-custody') owner.nativeSharedContextRestore = {};
    if (change === 'source-missing') delete h.store['gateways/shared-1/assignments/other'];
    if (change === 'source-uid') source.uid = 'foreign';
    if (change === 'source-slug') source.slug = 'foreign';
    if (change === 'source-gateway') source.gatewayId = 'shared-2';
    if (change === 'source-state') source.state = 'quiescing';
    if (change === 'source-epoch') source.epoch = -1;
    if (change === 'source-operation') source.updatedByOperationId = {};
    if (change === 'target-assignment') h.store['gateways/shared-2/assignments/other'] = { ...source, gatewayId: 'shared-2' };
    const before = structuredClone(h.store);
    await expect(queued.release()).resolves.toEqual({ released: 0 });
    expect(h.store).toEqual(before); expect(queued.scheduler).not.toHaveBeenCalled();
    Object.assign(queued.row, { schedulerHandoffReleased: true, schedulerHandoffReleasedAt: 3_000 });
    const released = structuredClone(h.store);
    await expect(recoverSharedRestoreRuntime(h.deps, h.op, h.ctx)).rejects.toThrow();
    expect(h.store).toEqual(released);
    expect(h.deps.runKubectl.mock.calls.some(([args]) => args.includes('patch'))).toBe(false);
  });

  it('does not release a migration claimed after the scheduler sweep snapshot', async () => {
    const h = harness(); const queued = blockedPreTransportMigration(h);
    const db = h.deps.db, transaction = db.runTransaction.bind(db);
    vi.spyOn(db, 'runTransaction').mockImplementationOnce(async fn => {
      queued.row.status = 'running'; queued.row.startedAt = 2_700;
      return transaction(fn);
    });
    await expect(queued.release()).resolves.toEqual({ released: 0 });
    expect(queued.row.schedulerHandoffReleased).toBe(false); expect(queued.scheduler).not.toHaveBeenCalled();
  });

  it('denies a released retry that claims before runtime recovery reserves the pod', async () => {
    const h = harness(); const queued = blockedPreTransportMigration(h);
    await expect(queued.release()).resolves.toEqual({ released: 1 });
    queued.row.status = 'running'; queued.row.startedAt = 2_700;
    const before = structuredClone(h.store);
    await expect(recoverSharedRestoreRuntime(h.deps, h.op, h.ctx)).rejects.toThrow('another migration is active');
    expect(h.store).toEqual(before);
    expect(h.deps.runKubectl.mock.calls.some(([args]) => args.includes('patch'))).toBe(false);
  });

  it('does not admit an attempted inbound migration as a released source dependency', async () => {
    const h = harness(); const queued = blockedPreTransportMigration(h);
    queued.row.input.fromGatewayId = 'shared-foreign'; queued.row.input.toGatewayId = 'shared-1';
    Object.assign(queued.row, { schedulerHandoffReleased: true, schedulerHandoffReleasedAt: 3_000 });
    await expect(recoverSharedRestoreRuntime(h.deps, h.op, h.ctx)).rejects.toThrow('another migration is active');
    expect(h.deps.runKubectl.mock.calls.some(([args]) => args.includes('patch'))).toBe(false);
  });

  it('continues releasing a failed held migration through the native scheduler', async () => {
    const h = harness(); const queued = blockedPreTransportMigration(h);
    queued.row.status = 'failed';
    queued.row.steps = [{ name: 'quiesce-source', status: 'done' }, { name: 'final-sync-state', status: 'failed' }];
    const scheduler = vi.fn(async () => ({ agentIds: [] }));
    await expect(releaseAbandonedSchedulerHandoffs({ db: h.deps.db, scheduler,
      gatewayExists: async () => true, log: vi.fn(), now: () => 3_000 })).resolves.toEqual({ released: 1 });
    expect(scheduler.mock.calls).toEqual([
      ['shared-2', { migrationId: 'mig-queued:scheduler:13', slug: 'bob', phase: 'abort' }],
      ['shared-1', { migrationId: 'mig-queued:scheduler:13', slug: 'bob', phase: 'resume' }],
    ]);
    expect(queued.row).toMatchObject({ status: 'failed', schedulerHandoffReleased: true });
  });

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

describe('journaled Shared source schema repair', () => {
  async function sourceHarness(management = false, absent = false) {
    const h = harness();
    for (const key of Object.keys(h.store)) if (key.startsWith('users/') || key.includes('/assignments/') || key === 'glmOperations/return') delete h.store[key];
    Object.assign(h.store['gateways/shared-1'], { gatewayId: 'shared-1', ownerUid: null, builderSlug: null, latestRelease: 1, desiredStatus: 'draining' });
    for (const [index, slug] of ['jdog99', 'oct01', 'journeyd093e6f87', 'journey94a458e32', 'jefe', 'oct08'].entries()) {
      const uid = `source-${index}`, id = `octogee-${slug}-coach`, file = `/home/node/.openclaw/agents/${id}/agent/openclaw-agent.sqlite`;
      const error = '/push-rsync-state/shared-1: 500 ' + JSON.stringify({ error: 'push-rsync-state failed', message:
        `OpenClaw snapshot of ${id} failed: SQLite database cannot be snapshotted safely: ${file}. OpenClaw agent database ${file} uses schema version 24; run openclaw doctor --fix before compacting it.` });
      h.store[`users/${uid}`] = { username: slug, provisioning: { openclaw: { gatewayId: 'shared-1', status: 'complete' } } };
      h.store[`gateways/shared-1/assignments/${uid}`] = { uid, slug, gatewayId: 'shared-1', state: 'serving', epoch: index + 1 };
      h.store[`glmOperations/export-${index}`] = { kind: 'migrate-customer', status: 'failed', startedAt: 100, completedAt: 200,
        input: { uid, fromGatewayId: 'shared-1', toGatewayId: 'shared-2' }, error,
        steps: [{ name: 'pre-sync-state', status: 'failed', error }, { name: 'rollback:unmount-target', status: 'done' }] };
    }
    if (management) {
      h.store['glmGateways/shared-1'] = { runtime: 'cluster', kubernetes: { totalPods: 1, readyPods: 1, status: 'ready', pods: [{ uid: 'pod-uid', name: 'pod' }] },
        heartbeat: { status: 'ready', lastHeartbeatAt: Date.now(), mountedCustomers: ['jdog99', 'oct01'], migratingIn: [] } };
      h.pod.metadata.namespace = 'octogee-test'; h.pod.status.conditions = [{ type: 'Ready', status: 'True' }];
      h.pod.status.containerStatuses = h.pod.spec.containers.map((c: any) => ({ name: c.name, ready: true, imageID: c.image }));
      for (let index = 2; index < 6; index++) {
        delete h.store[`users/source-${index}`]; delete h.store[`gateways/shared-1/assignments/source-${index}`]; delete h.store[`glmOperations/export-${index}`];
      }
      for (let index = 0; index < 2; index++) {
        const uid = `source-${index}`, slug = ['jdog99', 'oct01'][index], row = h.store[`glmOperations/export-${index}`];
        const operationId = continuousPlacementMigrationOperationId({ uid, builderSlug: slug!, fromGatewayId: 'shared-1', toGatewayId: 'shared-2', sourceAssignmentEpoch: index + 1 });
        delete h.store[`glmOperations/export-${index}`]; h.store[`glmOperations/${operationId}`] = row;
        Object.assign(row, { origin: 'automatic', createdBy: 'glm-controller-placement-policy', attempts: 1,
          error: '/quiesce/shared-1: 500 ' + JSON.stringify({ error: 'quiesce failed', message: 'WorkerTaskError: Session history database read was revoked: code=unavailable' }),
          rolledBack: true, schedulerHandoffReleased: true, schedulerHandoffReleasedAt: 250, attemptHistory: [],
          schedulerHandoff: { migrationId: `mig-${operationId}:scheduler:1`, fromGatewayId: 'shared-1', toGatewayId: 'shared-2', uid, slug } });
        Object.assign(row.input, { builderSlug: slug, source: 'continuous-placement-policy' });
        row.steps = [{ name: 'keys-sync-state', status: 'done' }, { name: 'pre-sync-state', status: 'done' }, { name: 'target-scheduler-ready', status: 'done' },
          { name: 'wait-for-active-work', status: 'failed', error: row.error }, { name: 'rollback:unmount-target', status: 'done' }];
        row.attemptHistory = [{ attempt: 1, startedAt: row.startedAt, completedAt: row.completedAt, error: row.error, steps: structuredClone(row.steps) }];
        Object.assign(h.store[`users/${uid}`].provisioning.openclaw, { mounted: true,
          migration: { state: 'preparing', phase: 'waiting', operationId, startedAt: 110 } });
      }
    }
    if (absent) delete h.store['users/source-0'].provisioning.openclaw.migration;
    const captured = await (h.deps.db as any).runTransaction((tx: any) => readSharedSourceRecoveryAuthority(h.deps.db, tx, 'shared-1', h.op.id));
    h.op.input = { gatewayId: 'shared-1', sourceRecovery: { sourceSha: sha, images, ...captured } };
    h.store['glmOperations/recover'].input = structuredClone(h.op.input);
    let ack = true, wrongImage = false, healthyWithoutAck = false, managementFailure = false, changedAfterProbe = false, transportFailure = false;
    let managementReceipt: string | undefined;
    const runKubectl = vi.fn(async (args: string[]) => {
      if (args.includes('exec')) {
        if (transportFailure) throw new Error('worker transport rejected');
        if (changedAfterProbe) h.store['users/source-0'].provisioning.openclaw.migration.startedAt++;
        return { code: managementFailure ? 1 : 0, stdout: managementFailure ? '' : managementReceipt ?? JSON.stringify({ version: 1, attemptId: h.op.id, bootId: 'fresh-boot', health: true }), stderr: '' };
      }
      if (args.includes('patch')) {
        const saved = h.store['gateways/shared-1'].runtimeRestartFence;
        expect(saved.kind).toBe('source-recovery'); expect(saved.phase).toBe('dispatched');
        expect(saved.doctor.startedAt).toBeUndefined(); expect(saved.installedImage).toBeUndefined();
        const patch = JSON.parse(args[args.indexOf('-p') + 1]);
        expect(patch.slice(0, 2)).toEqual([{ op: 'test', path: '/metadata/uid', value: 'pod-uid' }, { op: 'test', path: '/metadata/resourceVersion', value: 'rv' }]);
        for (const item of patch.filter((item: any) => item.op === 'replace')) h.pod.spec.containers[Number(item.path.split('/')[3])].image = item.value;
        h.pod.status.conditions = [{ type: 'Ready', status: healthyWithoutAck ? 'True' : 'False' }];
        h.pod.status.containerStatuses = h.pod.spec.containers.map((c: any) => ({ name: c.name, ready: healthyWithoutAck,
          imageID: wrongImage ? 'old-image' : c.image, state: { running: { startedAt: 'now' } } }));
      }
      const fence = h.store['gateways/shared-1'].runtimeRestartFence;
      if (args.includes('pod') && ack && fence?.installedImage && !fence.doctor.completedAt) {
        expect(fence.installedImage.podUid).toBe('pod-uid');
        if (!healthyWithoutAck) expect(h.pod.status.conditions[0].status).toBe('False');
        const now = Date.now();
        fence.doctor = { ...fence.doctor, releaseKey: 'actual-reused-image-tag', startedAt: now, completedAt: now,
          verifiedAgentIds: fence.target.agents.map((a: any) => a.agentId) };
        h.pod.status.conditions = [{ type: 'Ready', status: 'True' }];
        for (const c of h.pod.status.containerStatuses) c.ready = true;
      }
      const result = args.includes('pods') ? { items: [h.pod] } : args.includes('replicaset') ?
        { metadata: { uid: 'rs-uid', ownerReferences: [{ controller: true, kind: 'Deployment', uid: 'deployment-uid' }] } } :
        args.includes('deployment') ? { metadata: { uid: 'deployment-uid' } } : h.pod;
      return { code: 0, stdout: JSON.stringify(result), stderr: '' };
    });
    let clock = Date.now();
    return { ...h, deps: { ...h.deps, runKubectl, now: () => clock, wait: async () => { clock += 600_000; } },
      setManagementTransportFailure: () => { transportFailure = true; }, setManagementReceipt: (value: string) => { managementReceipt = value; },
      setManagementFailure: (value = true) => { managementFailure = value; }, setChangedAfterProbe: () => { changedAfterProbe = true; },
      setAck: (value: boolean) => { ack = value; }, setWrongImage: () => { wrongImage = true; }, setHealthyWithoutAck: () => { healthyWithoutAck = true; } };
  }
  it('requires fresh authenticated management health after Doctor ACK on the preserved source Pod', async () => {
    const h = await sourceHarness(true), before = structuredClone(h.store);
    await recoverSharedSourceRuntime(h.deps, h.op, h.ctx);
    expect(h.deps.runKubectl.mock.calls.filter(([args]) => args.includes('exec'))).toHaveLength(1);
    expect(h.store['glmOperations/recover'].sourceRuntimeRecovery.managementHealth).toMatchObject({ attemptId: h.op.id, bootId: 'fresh-boot', health: true });
    for (const [key, value] of Object.entries(before)) {
      if (key.startsWith('users/')) { const expected = structuredClone(value); delete expected.provisioning.openclaw.migration; expect(h.store[key]).toEqual(expected); }
      if (key.includes('/assignments/')) expect(h.store[key]).toEqual(value);
      if (key.startsWith('glmOperations/placement-')) { const { sourceRuntimeRecovery, ...preserved } = h.store[key]; expect(sourceRuntimeRecovery.operationId).toBe(h.op.id); expect(preserved).toEqual(value); }
    }
  });
  it('preserves explicit marker absence after Doctor and fresh management health and retains its placement proof', async () => {
    const h = await sourceHarness(true, true), user = structuredClone(h.store['users/source-0']);
    const failure = (h.op.input.sourceRecovery as any).managementRecovery.failures[0];
    await recoverSharedSourceRuntime(h.deps, h.op, h.ctx);
    expect(h.store['users/source-0']).toEqual(user);
    expect(h.store['glmOperations/recover'].sourceRuntimeRecovery.releasedPlacements[0].marker).toBeNull();
    await expect(enqueuePlacementMigration(currentPlacement(h), { ...failure.receipt.input, operationId: failure.operationId })).resolves.toBe(failure.operationId);
    expect(h.store['users/source-0']).toEqual(user);
  });
  it.each(['reservation', 'completion'])('rejects a migration marker that appears before %s rather than clearing it', async stage => {
    const h = await sourceHarness(true, true);
    const failure = (h.op.input.sourceRecovery as any).managementRecovery.failures[0];
    const marker = { state: 'preparing', phase: 'waiting', operationId: failure.operationId, startedAt: 110 };
    const appear = () => { h.store['users/source-0'].provisioning.openclaw.migration = structuredClone(marker); };
    if (stage === 'reservation') appear();
    else {
      const original = h.deps.runKubectl.getMockImplementation()!;
      h.deps.runKubectl.mockImplementation(async args => {
        const result = await original(args);
        if (args.includes('exec')) appear();
        return result;
      });
    }
    await expect(recoverSharedSourceRuntime(h.deps, h.op, h.ctx)).rejects.toThrow('custody changed');
    expect(h.store['users/source-0'].provisioning.openclaw.migration).toEqual(marker);
    expect(h.store['glmOperations/recover'].sourceRuntimeRecovery).toBeUndefined();
    if (stage === 'completion') expect(h.store['gateways/shared-1'].runtimeRestartFence).toBeDefined();
    else expect(h.deps.runKubectl.mock.calls.some(([args]) => args.includes('patch'))).toBe(false);
  });
  it('makes the exact recovered failed placement runnable through normal enqueue and a fresh worker claim', async () => {
    const h = await sourceHarness(true), failedId = (h.op.input.sourceRecovery as any).managementRecovery.failures[0].operationId, prior = structuredClone(h.store[`glmOperations/${failedId}`]);
    await recoverSharedSourceRuntime(h.deps, h.op, h.ctx);
    const request = { ...prior.input, operationId: failedId };
    await expect(enqueuePlacementMigration(currentPlacement(h), request)).resolves.toBe(failedId);
    expect(h.store['users/source-0'].provisioning.openclaw.migration).toBeUndefined();
    expect(h.store[`glmOperations/${failedId}`].attemptHistory).toEqual(prior.attemptHistory);
    const handler = vi.fn(async () => ({ success: true, steps: [] }));
    await processOperation({ ...h.store[`glmOperations/${failedId}`], id: failedId }, h.deps.db.doc(`glmOperations/${failedId}`),
      { db: h.deps.db, handlers: { 'migrate-customer': handler }, log: vi.fn() } as never);
    expect(handler).toHaveBeenCalledOnce();
    expect(h.store[`glmOperations/${failedId}`].status).toBe('succeeded');
    expect(h.store[`glmOperations/${failedId}`].attemptHistory).toEqual(prior.attemptHistory);
  });
  it('releases the exact old marker for a new current-target claim and phase without rearming the old native target', async () => {
    const h = await sourceHarness(true), failedId = (h.op.input.sourceRecovery as any).managementRecovery.failures[0].operationId;
    const before = structuredClone(h.store[`glmOperations/${failedId}`]);
    await recoverSharedSourceRuntime(h.deps, h.op, h.ctx);
    const input = currentPlacement(h), oldPayload = h.store['gateways/shared-2/releases/1'].payload;
    oldPayload.imageTag = 'legacy@sha256:' + 'e'.repeat(64); oldPayload.openclawSourceSha = 'c'.repeat(40);
    await expect(enqueuePlacementMigration(input, { ...before.input, operationId: failedId })).rejects.toThrow('current target authority changed');
    const current = currentPlacement(h, 'shared-3');
    const request = { ...before.input, toGatewayId: 'shared-3', operationId: continuousPlacementMigrationOperationId({
      uid: before.input.uid, builderSlug: before.input.builderSlug, fromGatewayId: before.input.fromGatewayId, toGatewayId: 'shared-3', sourceAssignmentEpoch: 1 }),
      sharedDrain: { pairedTargetGatewayId: null } };
    await enqueuePlacementMigration(current, request);
    const handler = vi.fn(async (op: Operation) => {
      await setWorkspaceMigrationPhase({ db: h.deps.db as never, serverTimestamp: () => FieldValue.serverTimestamp(), deleteField: () => FieldValue.delete() },
        { uid: before.input.uid, sourceGatewayId: 'shared-1', operationId: op.id, phase: 'preparing' });
      return { success: true, steps: [] };
    });
    await processOperation({ ...h.store[`glmOperations/${request.operationId}`], id: request.operationId }, h.deps.db.doc(`glmOperations/${request.operationId}`),
      { db: h.deps.db, handlers: { 'migrate-customer': handler }, log: vi.fn() } as never);
    expect(handler).toHaveBeenCalledOnce();
    expect(h.store['users/source-0'].provisioning.openclaw.migration.operationId).toBe(request.operationId);
    const { sourceRuntimeRecovery, ...preserved } = h.store[`glmOperations/${failedId}`];
    expect(sourceRuntimeRecovery.operationId).toBe(h.op.id); expect(preserved).toEqual(before);
  });
  it.each(['uid', 'epoch', 'marker', 'failed-operation'])('refuses stale %s during proof-keyed same-target rearm', async change => {
    const h = await sourceHarness(true), failedId = (h.op.input.sourceRecovery as any).managementRecovery.failures[0].operationId;
    const request = { ...h.store[`glmOperations/${failedId}`].input, operationId: failedId };
    await recoverSharedSourceRuntime(h.deps, h.op, h.ctx);
    const input = currentPlacement(h);
    if (change === 'uid') h.store['users/source-0'].username = 'foreign';
    if (change === 'epoch') h.store['gateways/shared-1/assignments/source-0'].epoch++;
    if (change === 'marker') h.store['users/source-0'].provisioning.openclaw.migration = { state: 'preparing', operationId: 'foreign', startedAt: 1 };
    if (change === 'failed-operation') h.store[`glmOperations/${failedId}`].completedAt++;
    const before = structuredClone(h.store);
    await expect(enqueuePlacementMigration(input, request)).rejects.toThrow(); expect(h.store).toEqual(before);
  });
  it('resumes only the failed management probe using the completed Doctor acknowledgment and unchanged retained fence', async () => {
    const h = await sourceHarness(true); h.setManagementFailure();
    h.op.attempts = MAX_OPERATION_ATTEMPTS; h.store['glmOperations/recover'].attempts = MAX_OPERATION_ATTEMPTS;
    const handler = createRestartGatewayHandler({ kubeOps: {} as never, namespace: h.deps.namespace,
      resolveLiveRevisionId: async () => null, now: h.deps.now, log: vi.fn(),
      recoverSource: (op, ctx) => recoverSharedSourceRuntime(h.deps, op, ctx) });
    const result = await handler(h.op, h.ctx);
    expect(result).toMatchObject({ success: false, error: 'source management health unconfirmed; outcome remains fenced', retryAfterMs: 60_000 });
    const fence = structuredClone(h.store['gateways/shared-1'].runtimeRestartFence);
    expect(fence.doctor.completedAt).toBeGreaterThan(0);
    const completion = buildOperationCompletionUpdate({ op: h.op, result, steps: [], now: h.deps.now() });
    await h.deps.db.runTransaction(async tx => { tx.update(h.deps.db.doc('glmOperations/recover'), completion); });
    expect(h.store['glmOperations/recover']).toMatchObject({ status: 'pending', startedAt: null, attempts: MAX_OPERATION_ATTEMPTS + 1 });
    expect(h.store['gateways/shared-1'].runtimeRestartFence).toEqual(fence);
    const freshStartedAt = completion.nextAttemptAt as number;
    await h.deps.db.runTransaction(async tx => {
      tx.update(h.deps.db.doc('glmOperations/recover'), { status: 'running', startedAt: freshStartedAt });
    });
    Object.assign(h.op, structuredClone(h.store['glmOperations/recover']));
    expect(h.op.startedAt).toBe(freshStartedAt);
    h.setManagementFailure(false); expect(await handler(h.op, h.ctx)).toMatchObject({ success: true });
    expect(h.store['glmOperations/recover'].sourceRuntimeRecovery.doctor).toEqual(fence.doctor);
    expect(h.deps.runKubectl.mock.calls.filter(([args]) => args.includes('patch'))).toHaveLength(1);
    expect(h.deps.runKubectl.mock.calls.filter(([args]) => args.includes('exec'))).toHaveLength(2);
    expect(h.store['gateways/shared-1'].runtimeRestartFence).toBeUndefined();
  });
  it('normalizes a rejected management exec transport to fenced availability without changing the completed Doctor proof', async () => {
    const h = await sourceHarness(true); h.setManagementTransportFailure();
    await expect(recoverSharedSourceRuntime(h.deps, h.op, h.ctx)).rejects.toThrow('source management health unconfirmed; outcome remains fenced');
    expect(h.store['gateways/shared-1'].runtimeRestartFence.doctor.completedAt).toBeGreaterThan(0);
    expect(h.store['glmOperations/recover'].sourceRuntimeRecovery).toBeUndefined();
  });
  it.each(['not-json', JSON.stringify({ version: 2, attemptId: 'recover', bootId: 'fresh', health: true }),
    JSON.stringify({ version: 1, attemptId: 'foreign', bootId: 'fresh', health: true }),
    JSON.stringify({ version: 1, attemptId: 'recover', bootId: '', health: true })])('refuses invalid management receipt %s as terminal while retaining the fence', async receipt => {
    const h = await sourceHarness(true); h.setManagementReceipt(receipt);
    await expect(recoverSharedSourceRuntime(h.deps, h.op, h.ctx)).rejects.toThrow('source management health receipt invalid');
    expect(classifyOperationFailure('source management health receipt invalid')).toBe('terminal');
    expect(h.store['gateways/shared-1'].runtimeRestartFence.doctor.completedAt).toBeGreaterThan(0);
    expect(h.store['glmOperations/recover'].sourceRuntimeRecovery).toBeUndefined();
  });
  it('resumes an owned management repair while its preserved Pod is temporarily unready without repeating the image patch', async () => {
    const h = await sourceHarness(true); h.setAck(false);
    await expect(recoverSharedSourceRuntime(h.deps, h.op, h.ctx)).rejects.toThrow('source repair is not ready');
    expect(h.pod.status.conditions[0].status).toBe('False');
    h.setAck(true); await recoverSharedSourceRuntime(h.deps, h.op, h.ctx);
    expect(h.deps.runKubectl.mock.calls.filter(([args]) => args.includes('patch'))).toHaveLength(1);
    expect(h.deps.runKubectl.mock.calls.filter(([args]) => args.includes('exec'))).toHaveLength(1);
    expect(h.store['gateways/shared-1'].runtimeRestartFence).toBeUndefined();
  });
  it.each(['health', 'custody', 'pod'])('keeps management repair fenced on failed %s proof', async change => {
    const h = await sourceHarness(true);
    if (change === 'health') h.setManagementFailure();
    if (change === 'custody') h.setChangedAfterProbe();
    if (change === 'pod') h.pod.metadata.uid = 'replacement';
    await expect(recoverSharedSourceRuntime(h.deps, h.op, h.ctx)).rejects.toThrow();
    expect(h.store['glmOperations/recover'].sourceRuntimeRecovery).toBeUndefined();
    if (change !== 'pod') expect(h.store['gateways/shared-1'].runtimeRestartFence).toBeDefined();
  });
  function currentPlacement(h: Awaited<ReturnType<typeof sourceHarness>>, target = 'shared-2') {
    const payload = { imageRepository: 'us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway', imageTag: images.gateway.split('octogee-gateway:')[1]!, openclawSourceSha: 'd'.repeat(40) };
    h.store[`gateways/${target}`] = { configSchemaVersion: 1, profile: 'standard', imageProfile: 'standard', sizingTier: null, gcpProject: null, gatewayContainerSecurityContext: null, serviceAccountName: null, serviceAccount: null, builderAccess: null, modelBrokerLimits: null, gatewayId: target, gatewayClass: 'shared', ownerUid: null, builderSlug: null, desiredStatus: 'running', desiredRelease: 1, latestRelease: 1, liveRelease: 1 };
    h.store[`gateways/${target}/releases/1`] = { payload };
    h.store[`glmGateways/${target}`] = { docKind: 'runtime', gatewayId: target, runtime: 'cluster', release: 1, lifecycle: 'serving',
      heartbeat: { status: 'ready', lastHeartbeatAt: h.deps.now(), version: payload.imageTag, mountedCustomers: [], migratingIn: [] } };
    return { db: h.deps.db, now: h.deps.now, platformArtifact: payload } as Parameters<typeof enqueuePlacementMigration>[0];
  }
  async function sourceSuccessor() {
    const h = await sourceHarness(); h.setAck(false);
    await expect(recoverSharedSourceRuntime(h.deps, h.op, h.ctx)).rejects.toThrow('source repair is not ready');
    const fence = h.store['gateways/shared-1'].runtimeRestartFence; delete fence.installedImage;
    const prior = h.store['glmOperations/recover']; Object.assign(prior, { status: 'failed', completedAt: 400, error: 'another source operation is active' });
    const before = structuredClone(prior), oldOp = structuredClone(h.op), oldFence = structuredClone(fence);
    h.store['glmOperations/queued'] = { kind: 'migrate-customer', status: 'pending', origin: 'automatic', createdBy: 'glm-controller-placement-policy',
      startedAt: null, completedAt: null, attempts: 0, steps: [], input: { uid: 'source-0', fromGatewayId: 'shared-1', toGatewayId: 'shared-2' } };
    const nextSha = 'd'.repeat(40), nextImages = { gateway: `us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway:ddddddd@sha256:${'e'.repeat(64)}`,
      'gateway-edge': `us-central1-docker.pkg.dev/octogee/octogee/gateway-edge:ddddddd@sha256:${'f'.repeat(64)}` };
    Object.assign(h.op, { id: 'successor', startedAt: 500, input: { gatewayId: 'shared-1', sourceRecovery: { ...before.input.sourceRecovery,
      sourceSha: nextSha, images: nextImages, supersede: { operationId: 'recover', input: before.input,
        startedAt: before.startedAt, completedAt: before.completedAt, error: before.error, fence: oldFence } } } });
    h.store['glmOperations/successor'] = structuredClone(h.op); h.deps.sourceSha = nextSha; h.setAck(true);
    return { ...h, before, oldOp, oldFence };
  }
  it('atomically transfers the failed queue-race fence to a new immutable family, preserving its failure and preventing stale completion', async () => {
    const h = await sourceSuccessor();
    await recoverSharedSourceRuntime(h.deps, h.op, h.ctx);
    expect(h.store['glmOperations/recover']).toEqual({ ...h.before, sourceRecoverySupersededBy: 'successor', cancellationRequestedAt: expect.any(Number) });
    expect(h.store['glmOperations/successor'].sourceRuntimeRecovery.doctor.requestId).toBe('successor');
    expect(h.store['gateways/shared-1'].runtimeRestartFence).toBeUndefined();
    const before = structuredClone(h.store);
    await expect(recoverSharedSourceRuntime({ ...h.deps, sourceSha: sha }, h.oldOp, h.ctx)).rejects.toThrow();
    expect(h.store).toEqual(before);
  });
  async function spentSourceSuccessor() {
    const h = await sourceSuccessor(), prior = h.store['glmOperations/recover'], fence = h.store['gateways/shared-1'].runtimeRestartFence;
    prior.error = 'source repair is not ready; outcome remains fenced';
    prior.input.sourceRecovery.supersede = { operationId: 'original-queue-repair', history: 'preserved' };
    prior.completedAt = fence.startedAt + 20;
    Object.assign(fence.doctor, { startedAt: fence.startedAt + 10, releaseKey: 'actual-baked-source-key' });
    fence.installedImage = { podUid: 'pod-uid', gatewayImageId: h.pod.status.containerStatuses[0].imageID, verifiedAt: fence.startedAt + 5 };
    h.op.input.sourceRecovery.supersede = { operationId: 'recover', input: structuredClone(prior.input), startedAt: prior.startedAt,
      completedAt: prior.completedAt, error: prior.error, fence: structuredClone(fence) };
    h.store['glmOperations/successor'] = structuredClone(h.op);
    return { ...h, before: structuredClone(prior) };
  }
  it('transfers a terminal spent-but-unacknowledged Doctor to a distinct once-only request preserving every failed history field', async () => {
    const h = await spentSourceSuccessor();
    await recoverSharedSourceRuntime(h.deps, h.op, h.ctx);
    expect(h.store['glmOperations/recover']).toEqual({ ...h.before, sourceRecoverySupersededBy: 'successor', cancellationRequestedAt: expect.any(Number) });
    expect(h.store['glmOperations/successor'].sourceRuntimeRecovery.doctor.requestId).toBe('successor');
    expect(h.store['gateways/shared-1'].runtimeRestartFence).toBeUndefined();
  });
  it.each(['running', 'acknowledged', 'changed-start', 'changed-image'])('refuses changed spent source %s without clearing its fence', async change => {
    const h = await spentSourceSuccessor();
    if (change === 'running') h.store['glmOperations/recover'].status = 'running';
    if (change === 'acknowledged') h.store['gateways/shared-1'].runtimeRestartFence.doctor.completedAt = Date.now();
    if (change === 'changed-start') h.store['gateways/shared-1'].runtimeRestartFence.doctor.startedAt++;
    if (change === 'changed-image') h.store['gateways/shared-1'].runtimeRestartFence.installedImage.gatewayImageId = 'foreign';
    const before = structuredClone(h.store);
    await expect(recoverSharedSourceRuntime(h.deps, h.op, h.ctx)).rejects.toThrow();
    expect(h.store).toEqual(before);
  });
  it('supersedes the exact old installed image while its failed repair is in CrashLoopBackOff without weakening the new running proof', async () => {
    const h = await sourceSuccessor();
    h.pod.status.containerStatuses[0].state = { waiting: { reason: 'CrashLoopBackOff' } };
    await recoverSharedSourceRuntime(h.deps, h.op, h.ctx);
    expect(h.store['glmOperations/successor'].sourceRuntimeRecovery.doctor.requestId).toBe('successor');
    expect(h.store['glmOperations/recover'].status).toBe('failed');
  });
  it.each(['completed-at', 'doctor-spent', 'same-pod', 'prior-image', 'missing-prior-image', 'cancelled', 'progressed-queue', 'missing-fence', 'claimed-history'])('refuses source successor %s without changing the prior fence or failed history', async change => {
    const h = await sourceSuccessor();
    if (change === 'completed-at') h.store['glmOperations/recover'].completedAt++;
    if (change === 'doctor-spent') h.store['gateways/shared-1'].runtimeRestartFence.doctor.startedAt = 1;
    if (change === 'same-pod') h.pod.metadata.uid = 'replacement';
    if (change === 'prior-image') h.pod.status.containerStatuses[0].imageID = 'wrong';
    if (change === 'missing-prior-image') delete h.pod.status.containerStatuses[0].imageID;
    if (change === 'cancelled') h.store['glmOperations/recover'].cancellationRequestedAt = 1;
    if (change === 'progressed-queue') h.store['glmOperations/queued'].steps = [{ name: 'keys-sync-state', status: 'running' }];
    if (change === 'missing-fence') { delete h.store['gateways/shared-1'].runtimeRestartFence; delete h.store['glmOperations/queued']; }
    if (change === 'claimed-history') h.store['glmOperations/queued'].attemptHistory = [{ startedAt: 200, completedAt: 250 }];
    const before = structuredClone(h.store), calls = h.deps.runKubectl.mock.calls.filter(([a]) => a.includes('patch')).length;
    await expect(recoverSharedSourceRuntime(h.deps, h.op, h.ctx)).rejects.toThrow();
    expect(h.store).toEqual(before); expect(h.deps.runKubectl.mock.calls.filter(([a]) => a.includes('patch'))).toHaveLength(calls);
  });
  it('finishes an owned repair when pristine automatic outbound moves were queued after its fence', async () => {
    const h = await sourceHarness(), run = h.deps.runKubectl.getMockImplementation()!;
    h.deps.runKubectl.mockImplementation(async args => {
      const result = await run(args);
      if (args.includes('patch')) h.store['glmOperations/queued'] = { kind: 'migrate-customer', status: 'pending', origin: 'automatic',
        createdBy: 'glm-controller-placement-policy', startedAt: null, completedAt: null, attempts: 0, steps: [],
        input: { uid: 'source-0', fromGatewayId: 'shared-1', toGatewayId: 'shared-2' } };
      return result;
    });
    await recoverSharedSourceRuntime(h.deps, h.op, h.ctx);
    expect(h.store['glmOperations/recover'].sourceRuntimeRecovery).toBeDefined();
    expect(h.store['glmOperations/queued']).toMatchObject({ status: 'pending', startedAt: null, steps: [] });
  });
  it('holds the same Pod/home, records actual installed digest before Doctor and clears only after real repair ACK plus Ready', async () => {
    const h = await sourceHarness(), before = structuredClone(h.store);
    await recoverSharedSourceRuntime(h.deps, h.op, h.ctx);
    expect(h.store['gateways/shared-1'].runtimeRestartFence).toBeUndefined();
    expect(h.store['glmOperations/recover'].sourceRuntimeRecovery).toMatchObject({ sourceSha: sha, podUid: 'pod-uid',
      doctor: { requestId: h.op.id, releaseKey: 'actual-reused-image-tag', verifiedAgentIds: expect.arrayContaining(['octogee-jefe-coach', 'octogee-oct08-coach']) } });
    for (const [key, value] of Object.entries(before)) if (key.startsWith('users/') || key.includes('/assignments/') || key.startsWith('glmOperations/export-')) expect(h.store[key]).toEqual(value);
    expect(h.deps.runKubectl.mock.calls.filter(([args]) => args.includes('patch'))).toHaveLength(1);
  });
  it.each(['epoch', 'failed-export', 'foreign-fence', 'source-sha', 'pod'])('refuses changed source %s before image mutation', async change => {
    const h = await sourceHarness();
    if (change === 'epoch') h.store['gateways/shared-1/assignments/source-0'].epoch++;
    if (change === 'failed-export') h.store['glmOperations/export-0'].completedAt++;
    if (change === 'foreign-fence') h.store['gateways/shared-1'].runtimeRestartFence = {};
    if (change === 'source-sha') h.deps.sourceSha = 'd'.repeat(40);
    if (change === 'pod') h.pod.metadata.deletionTimestamp = 'now';
    const before = structuredClone(h.store);
    await expect(recoverSharedSourceRuntime(h.deps, h.op, h.ctx)).rejects.toThrow();
    expect(h.store).toEqual(before); expect(h.deps.runKubectl.mock.calls.some(([args]) => args.includes('patch'))).toBe(false);
  });
  it('keeps mandatory repair fenced even if the image became Ready without a Doctor acknowledgment', async () => {
    const h = await sourceHarness(); h.setAck(false); h.setHealthyWithoutAck();
    await expect(recoverSharedSourceRuntime(h.deps, h.op, h.ctx)).rejects.toThrow('source repair is not ready');
    const fence = h.store['gateways/shared-1'].runtimeRestartFence;
    expect(fence.phase).toBe('dispatched'); expect(fence.installedImage.podUid).toBe('pod-uid');
    expect(fence.doctor.completedAt).toBeUndefined(); expect(h.store['glmOperations/recover'].sourceRuntimeRecovery).toBeUndefined();
    h.setAck(true);
    await recoverSharedSourceRuntime(h.deps, h.op, h.ctx);
    expect(h.store['glmOperations/recover'].sourceRuntimeRecovery).toBeDefined();
    expect(h.deps.runKubectl.mock.calls.filter(([args]) => args.includes('patch'))).toHaveLength(1);
  });
  it('never grants installed-image proof or spends Doctor for an old running imageID', async () => {
    const h = await sourceHarness(); h.setWrongImage();
    await expect(recoverSharedSourceRuntime(h.deps, h.op, h.ctx)).rejects.toThrow('source repair is not ready');
    expect(h.store['gateways/shared-1'].runtimeRestartFence.installedImage).toBeUndefined();
    expect(h.store['gateways/shared-1'].runtimeRestartFence.doctor.startedAt).toBeUndefined();
  });
});
