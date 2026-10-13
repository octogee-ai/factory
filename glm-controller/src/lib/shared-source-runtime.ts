import { managementHealthDriverSource } from './runtime-restart-driver.js';
import { isDeepStrictEqual } from 'node:util';
import { FieldValue, type DocumentData, type Transaction } from 'firebase-admin/firestore';
import type { Operation } from '@octogee/shared/types/glm';
import { assertSharedSourceRecoveryUnchanged, assertSharedSourceRecoveryPredecessor, readSharedSourceRecoveryAuthority, type SharedSourceRecoveryAuthority, type SharedSourceRecoverySupersession } from '@octogee/core/shared-source-recovery';
import type { OperationContext } from '../operation-router.js';
import { assertRecoveryImages, existingOwnedPod, imagePatch, json, recoveredPodReady, type SharedPodRecoveryDeps } from './shared-restore-runtime.js';

type Row = DocumentData;
interface SourceRecovery extends SharedSourceRecoveryAuthority { sourceSha: string; images: Record<string, string>; supersede?: SharedSourceRecoverySupersession }
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
    readSharedSourceRecoveryAuthority(deps.db, tx, gatewayId, op.id, input.supersede?.operationId),
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
      if (root.runtimeRestartFence.attemptId === op.id) { assertOwnedFence(object(root.runtimeRestartFence), op, input, pod); return; }
      await transferPredecessor({ deps, tx, op, input, pod, root }); return;
    }
    if (input.supersede) throw new Error('captured source recovery predecessor fence is absent');
    if (input.managementRecovery && (!pod.status.conditions?.some((condition: Row) => condition.type === 'Ready' && condition.status === 'True') ||
      !pod.status.containerStatuses?.every((status: Row) => status.ready === true))) throw new Error('source management Pod is unready');
    const fence = newFence(deps, op, input, pod);
    tx.update(deps.db.doc(`gateways/${op.input.gatewayId}`), { runtimeRestartFence: fence });
  });
}
function newFence(deps: SharedPodRecoveryDeps, op: Operation, input: SourceRecovery, pod: Row): Row {
  return { kind: 'source-recovery', attemptId: op.id, auditId: op.id, gatewayId: op.input.gatewayId,
      startedAt: (deps.now ?? Date.now)(), phase: 'reserved', doctor: { requestId: op.id },
      target: { podName: pod.metadata.name, podUid: pod.metadata.uid, sourceSha: input.sourceSha, images: input.images,
        originalImages: Object.fromEntries(pod.spec.containers.map((container: Row) => [container.name, container.image])),
        agents: expectedAgents(input), failedExportOperationIds: input.failedExports.map(row => row.operationId) } };
}
async function transferPredecessor(request: { deps: SharedPodRecoveryDeps; tx: Transaction; op: Operation; input: SourceRecovery; pod: Row; root: Row }): Promise<void> {
  const { deps, tx, op, input, pod, root } = request;
  const supersede = input.supersede;
  if (!supersede || supersede.operationId === op.id) throw new Error('source recovery predecessor is unavailable');
  const prior = await tx.get(deps.db.doc(`glmOperations/${supersede.operationId}`));
  const captured = assertSharedSourceRecoveryPredecessor({ gatewayId: op.input.gatewayId as string, operationId: supersede.operationId,
    row: object(prior.data()), fence: object(root.runtimeRestartFence), source: input });
  if (!isDeepStrictEqual(captured, supersede)) throw new Error('source recovery predecessor changed');
  const old = object(supersede.input.sourceRecovery);
  assertRecoveryImages(object(old.images), old.sourceSha);
  assertOwnedFence(supersede.fence, { ...op, id: supersede.operationId, input: supersede.input }, old as SourceRecovery, pod);
  assertPredecessorPodImages(pod, old.images);
  tx.update(deps.db.doc(`glmOperations/${supersede.operationId}`), { cancellationRequestedAt: (deps.now ?? Date.now)(), sourceRecoverySupersededBy: op.id });
  tx.update(deps.db.doc(`gateways/${op.input.gatewayId}`), { runtimeRestartFence: newFence(deps, op, input, pod) });
}
function assertPredecessorPodImages(pod: Row, oldImages: Row): void {
  for (const [name, image] of Object.entries(oldImages)) {
    const spec = pod.spec?.containers?.find((c: Row) => c.name === name), status = pod.status?.containerStatuses?.find((c: Row) => c.name === name);
    if (spec?.image !== image || typeof status?.imageID !== 'string' ||
      !status.imageID.endsWith(`@${String(image).split('@')[1]}`)) throw new Error('source recovery predecessor Pod image changed');
  }
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
function releaseCapturedPlacements(deps: SharedPodRecoveryDeps, tx: Transaction, op: Operation, input: SourceRecovery, completedAt: number): Row[] {
  if (!input.managementRecovery) return [];
  return input.managementRecovery.failures.map((failure, index) => {
    const assignment = input.assignments[index]!, user = input.managementRecovery!.users[index]!;
    const receipt = { operationId: op.id, sourceAssignmentEpoch: assignment.assignmentEpoch, completedAt };
    tx.update(deps.db.doc(`glmOperations/${failure.operationId}`), { sourceRuntimeRecovery: receipt });
    if (user.migration !== null) tx.update(deps.db.doc(`users/${assignment.uid}`), { 'provisioning.openclaw.migration': FieldValue.delete() });
    return { operationId: failure.operationId, uid: assignment.uid, assignmentEpoch: assignment.assignmentEpoch, marker: user.migration };
  });
}
async function finish(deps: SharedPodRecoveryDeps, op: Operation, input: SourceRecovery, pod: Row, managementHealth?: Row): Promise<void> {
  await deps.db.runTransaction(async tx => {
    const root = await authority(deps, tx, op, input), fence = object(root.runtimeRestartFence);
    assertOwnedFence(fence, op, input, pod);
    if (input.managementRecovery && !managementHealth) throw new Error('source management health is unavailable');
    if (!doctorComplete(fence, input) || !recoveredPodReady(pod, fence.target, input.images)) throw new Error('source repair acknowledgment is unavailable');
    const completedAt = (deps.now ?? Date.now)();
    const releasedPlacements = releaseCapturedPlacements(deps, tx, op, input, completedAt);
    tx.update(deps.db.doc(`glmOperations/${op.id}`), { sourceRuntimeRecovery: { gatewayId: op.input.gatewayId,
      sourceSha: input.sourceSha, images: input.images, podUid: pod.metadata.uid, doctor: fence.doctor, installedImage: fence.installedImage,
      ...(managementHealth ? { managementHealth, releasedPlacements } : {}), completedAt } });
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
  if (input.managementRecovery && (pod.metadata.uid !== input.managementRecovery.podUid || pod.metadata.name !== input.managementRecovery.podName ||
    pod.metadata.namespace !== deps.namespace)) throw new Error('source management Pod custody changed');
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
      if (input.managementRecovery) {
        const proof = await managementHealth(deps, op, current);
        await ctx.assertActiveClaim!();
        const after = await json(deps, ['get', 'pod', pod.metadata.name]);
        await finish(deps, op, input, after, proof);
      } else await finish(deps, op, input, current);
      return;
    }
    await wait(1000);
  }
  throw new Error('source repair is not ready; outcome remains fenced');
}

async function managementHealth(deps: SharedPodRecoveryDeps, op: Operation, pod: Row): Promise<Row> {
  const result = await deps.runKubectl(['-n', deps.namespace, 'exec', pod.metadata.name, '-c', 'gateway', '-i', '--', 'node', '--input-type=commonjs'],
    { stdin: managementHealthDriverSource(op.id), timeoutMs: 50_000 }).catch(cause => {
      throw new Error('source management health unconfirmed; outcome remains fenced', { cause });
    });
  if (result.code !== 0) throw new Error('source management health unconfirmed; outcome remains fenced');
  let proof: Row;
  try { proof = JSON.parse(result.stdout.trim()); } catch { throw new Error('source management health receipt invalid'); }
  if (!isDeepStrictEqual(Object.keys(proof).sort(), ['attemptId', 'bootId', 'health', 'version']) || proof.version !== 1 || proof.attemptId !== op.id ||
    proof.health !== true || typeof proof.bootId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(proof.bootId)) throw new Error('source management health receipt invalid');
  return proof;
}
