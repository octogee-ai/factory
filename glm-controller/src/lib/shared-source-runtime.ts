import { isDeepStrictEqual } from 'node:util';
import { FieldValue, type DocumentData, type Transaction } from 'firebase-admin/firestore';
import type { Operation } from '@octogee/shared/types/glm';
import { assertSharedSourceRecoveryUnchanged, readSharedSourceRecoveryAuthority, type SharedSourceRecoveryAuthority } from '@octogee/core/shared-source-recovery';
import type { OperationContext } from '../operation-router.js';
import { assertRecoveryImages, existingOwnedPod, imagePatch, json, recoveredPodReady, type SharedPodRecoveryDeps } from './shared-restore-runtime.js';

type Row = DocumentData;
interface SourceRecovery extends SharedSourceRecoveryAuthority { sourceSha: string; images: Record<string, string> }
const object = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
function sourceRecovery(op: Operation, deployedSha: string): SourceRecovery {
  const input = object(op.input.sourceRecovery);
  if (op.kind !== 'restart-gateway' || typeof op.input.gatewayId !== 'string' || !op.input.gatewayId || op.input.gatewayId.includes('/') ||
    op.input.restoreRecovery !== undefined || input.sourceSha !== deployedSha || !/^[a-f0-9]{40}$/.test(input.sourceSha)) {
    throw new Error('source recovery build identity is unavailable');
  }
  assertRecoveryImages(object(input.images), deployedSha);
  if (Object.keys(object(input.images)).length !== 2) throw new Error('source recovery image surface is invalid');
  return input as SourceRecovery;
}
async function authority(deps: SharedPodRecoveryDeps, tx: Transaction, op: Operation, input: SourceRecovery): Promise<Row> {
  const gatewayId = op.input.gatewayId as string;
  const [claim, root, captured] = await Promise.all([
    tx.get(deps.db.doc(`glmOperations/${op.id}`)), tx.get(deps.db.doc(`gateways/${gatewayId}`)),
    readSharedSourceRecoveryAuthority(deps.db, tx, gatewayId, op.id),
  ]);
  const current = claim.data();
  if (current?.status !== 'running' || current.startedAt !== op.startedAt || current.cancellationRequestedAt !== undefined ||
    !isDeepStrictEqual(current.input, op.input)) throw new Error('source recovery operation claim changed');
  assertSharedSourceRecoveryUnchanged(captured, input);
  return root.data()!;
}
function expectedAgents(input: SourceRecovery): Row[] {
  return input.assignments.map(({ uid, slug, agentId, assignmentEpoch }) => ({ uid, slug, agentId, assignmentEpoch }));
}
function assertOwnedFence(fence: Row, op: Operation, input: SourceRecovery, pod: Row): void {
  const target = object(fence.target), doctor = object(fence.doctor);
  if (![fence.kind === 'source-recovery', fence.attemptId === op.id, fence.auditId === op.id,
    fence.gatewayId === op.input.gatewayId, ['reserved', 'dispatched'].includes(fence.phase), doctor.requestId === op.id,
    target.podUid === pod.metadata.uid, target.podName === pod.metadata.name, target.sourceSha === input.sourceSha,
    isDeepStrictEqual(target.images, input.images), isDeepStrictEqual(target.agents, expectedAgents(input)),
    isDeepStrictEqual(target.failedExportOperationIds, input.failedExports.map(row => row.operationId))].every(Boolean)) {
    throw new Error('source recovery runtime fence changed');
  }
}
async function reserve(deps: SharedPodRecoveryDeps, op: Operation, input: SourceRecovery, pod: Row): Promise<void> {
  await deps.db.runTransaction(async tx => {
    const root = await authority(deps, tx, op, input);
    if (root.runtimeRestartFence !== undefined) {
      assertOwnedFence(object(root.runtimeRestartFence), op, input, pod); return;
    }
    const fence = { kind: 'source-recovery', attemptId: op.id, auditId: op.id, gatewayId: op.input.gatewayId,
      startedAt: (deps.now ?? Date.now)(), phase: 'reserved', doctor: { requestId: op.id },
      target: { podName: pod.metadata.name, podUid: pod.metadata.uid, sourceSha: input.sourceSha, images: input.images,
        originalImages: Object.fromEntries(pod.spec.containers.map((container: Row) => [container.name, container.image])),
        agents: expectedAgents(input), failedExportOperationIds: input.failedExports.map(row => row.operationId) } };
    tx.update(deps.db.doc(`gateways/${op.input.gatewayId}`), { runtimeRestartFence: fence });
  });
}
async function dispatch(deps: SharedPodRecoveryDeps, op: Operation, input: SourceRecovery, pod: Row): Promise<Row> {
  return deps.db.runTransaction(async tx => {
    const root = await authority(deps, tx, op, input), fence = object(root.runtimeRestartFence);
    assertOwnedFence(fence, op, input, pod);
    imagePatch(pod, fence, input.images);
    tx.update(deps.db.doc(`gateways/${op.input.gatewayId}`), { 'runtimeRestartFence.phase': 'dispatched' });
    return fence;
  });
}
function installedGateway(pod: Row, input: SourceRecovery): string | null {
  const spec = pod.spec?.containers?.find((container: Row) => container.name === 'gateway');
  const status = pod.status?.containerStatuses?.find((container: Row) => container.name === 'gateway');
  return spec?.image === input.images.gateway && status?.state?.running && typeof status.imageID === 'string' &&
    status.imageID.endsWith(`@${input.images.gateway!.split('@')[1]}`) ? status.imageID : null;
}
function doctorComplete(fence: Row, input: SourceRecovery): boolean {
  const doctor = object(fence.doctor), image = object(fence.installedImage);
  return [doctor.requestId === fence.attemptId, doctor.error === undefined,
    Number.isSafeInteger(doctor.startedAt), doctor.startedAt > 0, Number.isSafeInteger(doctor.completedAt), doctor.completedAt >= doctor.startedAt,
    typeof doctor.releaseKey === 'string', Boolean(doctor.releaseKey),
    isDeepStrictEqual(doctor.verifiedAgentIds, input.assignments.map(row => row.agentId)),
    image.podUid === fence.target.podUid, typeof image.gatewayImageId === 'string',
    String(image.gatewayImageId).endsWith(`@${input.images.gateway!.split('@')[1]}`)].every(Boolean);
}
async function recordInstalled(deps: SharedPodRecoveryDeps, op: Operation, input: SourceRecovery, pod: Row, imageID: string): Promise<boolean> {
  return deps.db.runTransaction(async tx => {
    const root = await authority(deps, tx, op, input), fence = object(root.runtimeRestartFence);
    assertOwnedFence(fence, op, input, pod);
    const proof = { podUid: pod.metadata.uid, gatewayImageId: imageID, verifiedAt: (deps.now ?? Date.now)() };
    if (fence.installedImage !== undefined) {
      if (fence.installedImage.podUid !== proof.podUid || fence.installedImage.gatewayImageId !== imageID) throw new Error('source recovery installed image proof changed');
      return false;
    }
    tx.update(deps.db.doc(`gateways/${op.input.gatewayId}`), { 'runtimeRestartFence.installedImage': proof });
    return true;
  });
}
async function finish(deps: SharedPodRecoveryDeps, op: Operation, input: SourceRecovery, pod: Row): Promise<void> {
  await deps.db.runTransaction(async tx => {
    const root = await authority(deps, tx, op, input), fence = object(root.runtimeRestartFence);
    assertOwnedFence(fence, op, input, pod);
    if (!doctorComplete(fence, input) || !recoveredPodReady(pod, fence.target, input.images)) throw new Error('source repair acknowledgment is unavailable');
    tx.update(deps.db.doc(`glmOperations/${op.id}`), { sourceRuntimeRecovery: { gatewayId: op.input.gatewayId,
      sourceSha: input.sourceSha, images: input.images, podUid: pod.metadata.uid, doctor: fence.doctor, installedImage: fence.installedImage,
      completedAt: (deps.now ?? Date.now)() } });
    tx.update(deps.db.doc(`gateways/${op.input.gatewayId}`), { runtimeRestartFence: FieldValue.delete() });
  });
}
export async function recoverSharedSourceRuntime(deps: SharedPodRecoveryDeps, op: Operation, ctx: OperationContext): Promise<void> {
  const input = sourceRecovery(op, deps.sourceSha), gatewayId = op.input.gatewayId as string;
  if (!ctx.assertActiveClaim) throw new Error('source recovery operation claim is unavailable');
  await ctx.assertActiveClaim();
  const prior = object((await deps.db.doc(`glmOperations/${op.id}`).get()).data()?.sourceRuntimeRecovery);
  if (prior.completedAt > 0 && prior.sourceSha === input.sourceSha && isDeepStrictEqual(prior.images, input.images)) return;
  const pod = await existingOwnedPod(deps, gatewayId);
  await reserve(deps, op, input, pod);
  const saved = await dispatch(deps, op, input, pod);
  if (Object.entries(input.images).some(([name, image]) => pod.spec.containers.find((container: Row) => container.name === name)?.image !== image)) {
    await ctx.assertActiveClaim();
    await json(deps, ['patch', 'pod', pod.metadata.name, '--type=json', '-p', JSON.stringify(imagePatch(pod, saved, input.images))]);
  }
  await waitForSourceRepair({ deps, op, input, ctx, pod, saved });
}
async function waitForSourceRepair(request: {
  deps: SharedPodRecoveryDeps; op: Operation; input: SourceRecovery; ctx: OperationContext; pod: Row; saved: Row;
}): Promise<void> {
  const { deps, op, input, ctx, pod, saved } = request;
  const gatewayId = op.input.gatewayId as string;
  const now = deps.now ?? Date.now, wait = deps.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms))), deadline = now() + 600_000;
  while (now() < deadline) {
    await ctx.assertActiveClaim!();
    const current = await json(deps, ['get', 'pod', pod.metadata.name]);
    if (current.metadata?.uid !== pod.metadata.uid || current.metadata.deletionTimestamp) throw new Error('source repair Pod was replaced; outcome remains fenced');
    imagePatch(current, saved, input.images);
    const imageID = installedGateway(current, input);
    if (imageID && await recordInstalled(deps, op, input, current, imageID)) continue;
    const root = object((await deps.db.doc(`gateways/${gatewayId}`).get()).data()), fence = object(root.runtimeRestartFence);
    assertOwnedFence(fence, op, input, current);
    if (fence.doctor?.error !== undefined) throw new Error('source Doctor failed; outcome remains fenced');
    if (doctorComplete(fence, input) && recoveredPodReady(current, fence.target, input.images)) {
      await finish(deps, op, input, current); return;
    }
    await wait(1000);
  }
  throw new Error('source repair is not ready; outcome remains fenced');
}
