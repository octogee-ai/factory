import { isDeepStrictEqual } from 'node:util';
import { FieldValue, type DocumentData, type Firestore, type Transaction } from 'firebase-admin/firestore';
import type { Operation } from '@octogee/shared/types/glm';
import type { OperationContext } from '../operation-router.js';
import type { KubectlSubprocess } from '../fleet-ingress.js';

type RecordValue = DocumentData;
interface Recovery { operationId: string; sourceSha: string; images: Record<string, string> }
interface Deps { db: Firestore; namespace: string; sourceSha: string; runKubectl: KubectlSubprocess; now?: () => number; wait?: (ms: number) => Promise<void> }
function object(value: unknown): RecordValue { return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {}; }
function customerState(user: RecordValue | undefined): RecordValue { return object(object(user?.provisioning).openclaw); }
function liveShared(root: RecordValue): boolean {
  return root.gatewayClass === 'shared' && ['running', 'draining'].includes(root.desiredStatus) && root.retirementClaim == null &&
    Number.isSafeInteger(root.liveRelease) && root.liveRelease >= 1 && root.liveRelease === root.desiredRelease;
}
function restoreMatches(receipt: RecordValue, returned: RecordValue, gatewayId: string): boolean {
  const handoff = object(returned.schedulerHandoff); const input = object(returned.input);
  return [input.uid === receipt.uid, input.toGatewayId === gatewayId, input.fromGatewayId === receipt.fromGatewayId,
    receipt.fromGatewayId !== gatewayId, handoff.uid === receipt.uid, handoff.slug === receipt.slug,
    handoff.toGatewayId === gatewayId, handoff.fromGatewayId === receipt.fromGatewayId].every(Boolean);
}
function recovery(op: Operation, sourceSha: string): Recovery {
  const input = object(op.input.restoreRecovery);
  if (op.kind !== 'restart-gateway' || typeof op.input.gatewayId !== 'string' ||
      typeof input.operationId !== 'string' || !input.operationId || input.operationId.includes('/') ||
      !/^[a-f0-9]{40}$/.test(input.sourceSha) || input.sourceSha !== sourceSha) throw new Error('restore recovery build identity is unavailable');
  const images = object(input.images);
  for (const [name, repository] of [['gateway', 'octogee-gateway'], ['gateway-edge', 'gateway-edge']]) {
    const prefix = `us-central1-docker.pkg.dev/octogee/octogee/${repository}:${sourceSha.slice(0, 7)}`;
    if (typeof images[name!] !== 'string' || !images[name!].startsWith(prefix) ||
        !/^[a-z0-9._-]*@sha256:[a-f0-9]{64}$/.test(images[name!].slice(prefix.length))) throw new Error('restore recovery requires digest-addressed images from the deployed build');
  }
  if (Object.keys(images).length !== 2) throw new Error('restore recovery image surface is invalid');
  return input as Recovery;
}

async function authority(deps: Deps, tx: Transaction, op: Operation, input: Recovery): Promise<RecordValue> {
  const gatewayId = op.input.gatewayId as string;
  const [root, claim, restore, users, active, transfersFrom, transfersTo] = await Promise.all([
    tx.get(deps.db.doc(`gateways/${gatewayId}`)), tx.get(deps.db.doc(`glmOperations/${op.id}`)),
    tx.get(deps.db.doc(`glmOperations/${input.operationId}`)),
    tx.get(deps.db.collection('users').where('provisioning.openclaw.gatewayId', '==', gatewayId)),
    tx.get(deps.db.collection('glmOperations').where('status', 'in', ['running', 'pending'])),
    tx.get(deps.db.collection('users').where('provisioning.openclaw.sourceTransferFence.sourceGatewayId', '==', gatewayId)),
    tx.get(deps.db.collection('users').where('provisioning.openclaw.sourceTransferFence.targetGatewayId', '==', gatewayId)),
  ]);
  const data = object(root.data()); const current = object(claim.data()); const returned = object(restore.data());
  const receipt = object(returned.restoreAttempt); const uid = receipt.uid;
  const user = users.docs.find(row => row.id === uid)?.data();
  const openclaw = customerState(user);
  const fence = object(openclaw.restoreFence);
  const exact = [
    transfersFrom.docs.length === 0, transfersTo.docs.length === 0,
    liveShared(data),
    current.status === 'running', current.startedAt === op.startedAt, current.cancellationRequestedAt === undefined,
    isDeepStrictEqual(current.input, op.input), returned.kind === 'migrate-customer',
    ['pending', 'failed'].includes(returned.status), returned.cancellationRequestedAt === undefined,
    returned.cutoverCommittedAt > 0, Number.isFinite(returned.cutoverCommittedAt),
    receipt.phase === 'dispatched', isDeepStrictEqual(receipt, fence), typeof uid === 'string', Boolean(uid),
    receipt.operationId === input.operationId, receipt.gatewayId === gatewayId, Number.isSafeInteger(receipt.assignmentEpoch),
    typeof receipt.attemptId === 'string', Boolean(String(receipt.attemptId ?? '').trim()),
    restoreMatches(receipt, returned, gatewayId),
    openclaw.status === 'complete', !Object.hasOwn(openclaw, 'sourceTransferFence'),
  ].every(Boolean);
  if (!exact) throw new Error('paired post-cutover restore authority is unavailable');
  const assignment = object((await tx.get(deps.db.doc(`gateways/${gatewayId}/assignments/${uid}`))).data());
  if (assignment.state !== 'serving' || assignment.uid !== uid || assignment.slug !== receipt.slug ||
      assignment.gatewayId !== gatewayId || assignment.epoch !== receipt.assignmentEpoch) throw new Error('restore recovery assignment changed');
  for (const row of users.docs) {
    const state = customerState(row.data());
    if (row.id !== uid && (Object.hasOwn(state, 'restoreFence') || Object.hasOwn(state, 'sourceTransferFence'))) throw new Error('another customer runtime outcome is unresolved');
  }
  if (active.docs.some(row => competingMigration(row.id, row.data(), input.operationId, gatewayId))) throw new Error('another migration is active on the restore target');
  return data;
}
function competingMigration(id: string, row: RecordValue, operationId: string, gatewayId: string): boolean {
  const input = object(row.input);
  return id !== operationId && row.kind === 'migrate-customer' && [input.fromGatewayId, input.toGatewayId].includes(gatewayId);
}

async function json(deps: Deps, args: string[]): Promise<RecordValue> {
  const result = await deps.runKubectl(['-n', deps.namespace, ...args, '-o', 'json'], { timeoutMs: 15_000 });
  if (result.code !== 0) throw new Error('restore recovery Kubernetes outcome is unresolved');
  return JSON.parse(result.stdout);
}
function validatePod(pod: RecordValue, gatewayId: string): void {
  const metadata = object(pod.metadata); const spec = object(pod.spec); const status = object(pod.status);
  const containers = spec.containers;
  if (metadata.deletionTimestamp || status.phase !== 'Running' || !metadata.uid || !metadata.resourceVersion ||
      object(metadata.labels)['gateway-instance'] !== gatewayId || !Array.isArray(containers) || containers.length !== 2 ||
      !retainsSharedStorage(spec)) throw new Error('restore recovery requires the existing Shared pod storage');
}
function retainsSharedStorage(spec: RecordValue): boolean {
  return spec.volumes?.some((volume: RecordValue) => volume.name === 'data' && volume.emptyDir) &&
    ['gateway', 'gateway-edge'].every(name => spec.containers.find((container: RecordValue) => container.name === name)?.volumeMounts?.some(
      (mount: RecordValue) => mount.name === 'data' && mount.mountPath === '/home/node' && !mount.subPath));
}
export function recoveredPodReady(pod: RecordValue, saved: RecordValue, images: Recovery['images']): boolean {
  return pod.metadata?.uid === saved.podUid && !pod.metadata?.deletionTimestamp &&
    pod.status?.conditions?.some((condition: RecordValue) => condition.type === 'Ready' && condition.status === 'True') &&
    Object.entries(images).every(([name, image]) => pod.spec?.containers?.find((container: RecordValue) => container.name === name)?.image === image &&
      pod.status?.containerStatuses?.some((status: RecordValue) => status.name === name && status.ready === true &&
        status.imageID?.endsWith(`@${image.split('@')[1]}`)));
}

async function existingOwnedPod(deps: Deps, gatewayId: string): Promise<RecordValue> {
  const pods = (await json(deps, ['get', 'pods', '-l', `gateway-instance=${gatewayId}`])).items;
  if (!Array.isArray(pods) || pods.length !== 1) throw new Error('restore recovery requires one existing pod');
  const pod = pods[0]; validatePod(pod, gatewayId);
  const replicaSet = pod.metadata.ownerReferences?.find((owner: RecordValue) => owner.controller && owner.kind === 'ReplicaSet');
  if (!replicaSet) throw new Error('restore recovery pod owner is unavailable');
  const [rs, deployment] = await Promise.all([
    json(deps, ['get', 'replicaset', replicaSet.name]), json(deps, ['get', 'deployment', `octogee-gateway-${gatewayId}`]),
  ]);
  if (rs.metadata?.uid !== replicaSet.uid || !rs.metadata?.ownerReferences?.some((owner: RecordValue) => owner.controller && owner.kind === 'Deployment' &&
      owner.uid === deployment.metadata?.uid) || deployment.metadata?.deletionTimestamp) throw new Error('restore recovery pod deployment changed');
  return pod;
}
async function reserveRecovery(deps: Deps, op: Operation, input: Recovery, pod: RecordValue): Promise<RecordValue> {
  const gatewayId = op.input.gatewayId as string;
  return deps.db.runTransaction(async tx => {
    const root = await authority(deps, tx, op, input);
    const existing = root.runtimeRestartFence;
    if (existing !== undefined) {
      if (existing.kind !== 'restore-recovery' || existing.attemptId !== op.id || existing.target?.podUid !== pod.metadata.uid ||
          existing.target?.restoreOperationId !== input.operationId || !isDeepStrictEqual(existing.target?.images, input.images)) throw new Error('another runtime restart outcome is unresolved');
      return existing as RecordValue;
    }
    const fence = { kind: 'restore-recovery', attemptId: op.id, auditId: op.id, gatewayId, startedAt: Date.now(), phase: 'reserved',
      target: { podName: pod.metadata.name, podUid: pod.metadata.uid, restoreOperationId: input.operationId, images: input.images,
        originalImages: Object.fromEntries(pod.spec.containers.map((container: RecordValue) => [container.name, container.image])) } };
    tx.update(deps.db.doc(`gateways/${gatewayId}`), { runtimeRestartFence: fence });
    return fence;
  });
}
function imagePatch(current: RecordValue, saved: RecordValue, images: Recovery['images']) {
  const patch = [{ op: 'test', path: '/metadata/uid', value: current.metadata.uid },
    { op: 'test', path: '/metadata/resourceVersion', value: current.metadata.resourceVersion }];
  current.spec.containers.forEach((container: RecordValue, index: number) => {
    if (![saved.target.originalImages[container.name], images[container.name]].includes(container.image)) throw new Error('restore recovery image changed outside its claim');
    patch.push({ op: 'test', path: `/spec/containers/${index}/image`, value: container.image });
    patch.push({ op: 'replace', path: `/spec/containers/${index}/image`, value: images[container.name] });
  });
  return patch;
}
async function waitForRecovery(deps: Deps, ctx: OperationContext, saved: RecordValue, input: Recovery): Promise<void> {
  const now = deps.now ?? Date.now; const wait = deps.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms))); const deadline = now() + 240_000;
  while (now() < deadline) {
    await ctx.assertActiveClaim!();
    const observed = await json(deps, ['get', 'pod', saved.target.podName]);
    if (observed.metadata?.uid !== saved.target.podUid || observed.metadata?.deletionTimestamp) throw new Error('restore recovery pod was replaced; outcome remains fenced');
    if (recoveredPodReady(observed, saved.target, input.images)) return;
    await wait(1000);
  }
  throw new Error('restore recovery images are not ready; outcome remains fenced');
}
function completedRecovery(completed: RecordValue, gatewayId: string, input: Recovery): boolean {
  return completed.completedAt > 0 && completed.gatewayId === gatewayId && completed.restoreOperationId === input.operationId &&
    completed.sourceSha === input.sourceSha && isDeepStrictEqual(completed.images, input.images);
}
export async function recoverSharedRestoreRuntime(deps: Deps, op: Operation, ctx: OperationContext): Promise<void> {
  const input = recovery(op, deps.sourceSha); const gatewayId = op.input.gatewayId as string;
  if (!ctx.assertActiveClaim) throw new Error('restore recovery operation claim is unavailable');
  await ctx.assertActiveClaim();
  const completed = object((await deps.db.doc(`glmOperations/${op.id}`).get()).data()?.restoreRuntimeRecovery);
  if (completedRecovery(completed, gatewayId, input)) return;
  const pod = await existingOwnedPod(deps, gatewayId);
  let saved = await reserveRecovery(deps, op, input, pod);
  const update = async (next: RecordValue | null) => {
    await ctx.assertActiveClaim!();
    await deps.db.runTransaction(async tx => {
      const root = await authority(deps, tx, op, input);
      if (!isDeepStrictEqual(root.runtimeRestartFence, saved)) throw new Error('restore recovery restart fence changed');
      tx.update(deps.db.doc(`gateways/${gatewayId}`), { runtimeRestartFence: next ?? FieldValue.delete() });
      if (!next) tx.update(deps.db.doc(`glmOperations/${op.id}`), { restoreRuntimeRecovery: {
        gatewayId, restoreOperationId: input.operationId, sourceSha: input.sourceSha, images: input.images,
        podUid: saved.target.podUid, completedAt: Date.now(),
      } });
    });
    if (next) saved = next;
  };
  const current = await json(deps, ['get', 'pod', saved.target.podName]); validatePod(current, gatewayId);
  if (current.metadata.uid !== saved.target.podUid) throw new Error('restore recovery refuses replacement pod storage');
  const patch = imagePatch(current, saved, input.images);
  if (!recoveredPodReady(current, saved.target, input.images)) {
    await update({ ...saved, phase: 'dispatched' });
    await json(deps, ['patch', 'pod', current.metadata.name, '--type=json', '-p', JSON.stringify(patch)]);
  }
  await waitForRecovery(deps, ctx, saved, input);
  await update(null);
}
