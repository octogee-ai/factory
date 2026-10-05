import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { isDeepStrictEqual } from 'node:util';
import { spawn } from 'node:child_process';
import type { CustomerMigrationV2State, Operation, SourceTransferExecution } from '@octogee/shared/types/glm';
import { GLM_OPERATIONS_COLLECTION } from '@octogee/shared/types/glm';
import { customerRuntimeMutationFenced } from '@octogee/shared/types/gateway-releases';
import { accountAllowsInteractiveAccess } from '@octogee/shared/types/account-lifecycle';
import { slugFromAssignedUser } from '@octogee/core/assigned-roster';
import type { PushRsyncStateRequestBody } from '@octogee/shared/types/fleet-controller';
import type { CommandRunner } from './migration-rsync-transfer.js';
import { planSourceTransfer, observeSourceTransfer, sourceTransferBlocksRelease, type SourceTransferPod } from './source-transfer-execution.js';
import { runGatewayRuntimeExclusive } from './gateway-runtime-mutation.js';

export interface RetainedSourceContext { op: Operation; state: CustomerMigrationV2State }
export interface RetainedSourceTarget { name: string; podIP: string; vm: boolean }
export interface RetainedSourceTransfer {
  observe(): Promise<SourceTransferExecution | undefined>;
  assertActiveClaim(): Promise<void>;
  settledTarget(target: RetainedSourceTarget): Promise<SourceTransferExecution | undefined>;
  acknowledgeCleanup(record: SourceTransferExecution): Promise<SourceTransferExecution>;
  execute(input: { target: RetainedSourceTarget; prepare(sourceIp: string): Promise<PushRsyncStateRequestBody> }): Promise<SourceTransferExecution>;
}
interface Deps { db: Firestore; namespace: string; image: string; runCommand: CommandRunner; now(): number; attach?: typeof attachTransfer; wait?: (ms: number) => Promise<void> }
const PROBE = `const fs=require('fs');const m=fs.readFileSync('/proc/meminfo','utf8').match(/^MemAvailable:\\s+(\\d+) kB$/m);const max=fs.readFileSync('/sys/fs/cgroup/memory.max','utf8').trim();const current=fs.readFileSync('/sys/fs/cgroup/memory.current','utf8').trim();const disk=fs.statfsSync('/tmp');if(!m||!/^\\d+$/.test(max)||!/^\\d+$/.test(current)||Number(m[1])*1024<4294967296||Number(max)-Number(current)<4294967296||disk.bavail*disk.bsize<1073741824)process.exit(1);process.stdout.write(JSON.stringify({sourceMemoryMax:Number(max),sourceMemoryCurrent:Number(current)}));`;

export function assertRetainedSourceAuthority(input: RetainedSourceContext, fresh: Operation & { cancellationRequestedAt?: unknown; restoreAttempt?: {phase?:string} }, user: Record<string, unknown>, assignment: Record<string, unknown>, roots: {source:Record<string,unknown>;target:Record<string,unknown>}): void {
  const {op,state} = input;
  const {source:root,target}=roots;
  const oc = (user.provisioning as {openclaw?:Record<string,unknown>} | undefined)?.openclaw;
  const durable = fresh.customerMigrationV2;
  if (!durable) throw new Error('retained source transfer has no durable migration');
  const exact = [
    fresh.kind === 'migrate-customer', fresh.status === 'running', fresh.startedAt === op.startedAt,
    fresh.input.sourceTransferMode === 'retained-pod', fresh.input.uid === state.uid,
    fresh.input.fromGatewayId === state.sourceGatewayId, fresh.input.toGatewayId === state.targetGatewayId,
    fresh.cancellationRequestedAt === undefined, !customerRuntimeMutationFenced(user),
    fresh.restoreAttempt === undefined || fresh.restoreAttempt.phase === 'acknowledged',
    durable.phase === 'sourceQuiesced', durable.operationId === op.id,
    durable.migrationId === state.migrationId, durable.uid === state.uid, durable.slug === state.slug,
    durable.sourceGatewayId === state.sourceGatewayId, durable.sourceEpoch === state.sourceEpoch,
    durable.targetGatewayId === state.targetGatewayId, state.sourceGatewayId.startsWith('shared-'),
    state.sourceAssignmentMode === 'assigned', slugFromAssignedUser(user) === state.slug,
    oc?.gatewayId === state.sourceGatewayId, accountAllowsInteractiveAccess(user),
    assignment.uid === state.uid, assignment.slug === state.slug, assignment.gatewayId === state.sourceGatewayId,
    assignment.epoch === state.sourceEpoch, assignment.state === 'quiescing',
    assignment.updatedByOperationId === op.id, root.gatewayClass === 'shared',
    ['running','draining'].includes(String(root.desiredStatus)), root.retirementClaim == null, root.runtimeRestartFence === undefined,
    root.desiredRelease === state.sourceRelease, root.liveRelease === state.sourceRelease,
    ['shared','builder'].includes(String(target.gatewayClass)), target.desiredStatus === 'running',
    target.retirementClaim == null, target.runtimeRestartFence === undefined, target.desiredRelease === state.targetRelease, target.liveRelease === state.targetRelease,
  ].every(Boolean);
  if (!exact) throw new Error('retained source transfer authority changed');
}

async function attachTransfer(namespace: string, pod: string, container: string, body: Record<string, unknown>): Promise<void> {
  const payload = JSON.stringify(body);
  if (Buffer.byteLength(payload) > 1024 ** 2) throw new Error('source transfer request exceeds limit');
  await new Promise<void>((resolve, reject) => {
    const child = spawn('/usr/local/bin/kubectl',['-n',namespace,'attach',pod,'-c',container,'-i'],{stdio:['pipe','ignore','ignore']});
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('source transfer observation pending')); },610_000);
    child.on('error',() => {clearTimeout(timer);reject(new Error('source transfer attach unavailable'));});
    child.on('close',() => {clearTimeout(timer);resolve();});
    child.stdin.on('error',() => { child.kill('SIGTERM'); });
    child.stdin.end(payload);
  });
}

function assertExecutionContext(record: SourceTransferExecution, context: RetainedSourceContext): void {
  const state = context.state;
  const exact = [record.operationId === context.op.id, record.migrationId === state.migrationId,
    record.uid === state.uid, record.slug === state.slug, record.sourceGatewayId === state.sourceGatewayId,
    record.assignmentEpoch === state.sourceEpoch, record.targetGatewayId === state.targetGatewayId].every(Boolean);
  if (!exact) throw new Error('source transfer durable scope changed');
}

function requireTransferred(record: SourceTransferExecution | undefined): SourceTransferExecution {
  if (!record || record.status !== 'transferred') throw new Error(record?.status === 'failed' ? 'source transfer helper failed' : 'source transfer observation pending');
  return record;
}

function sourcePodFromList(stdout: string): SourceTransferPod {
  const pods = (JSON.parse(stdout) as {items:SourceTransferPod[]}).items.filter(p => !p.metadata.deletionTimestamp);
  if (pods.length !== 1) throw new Error('retained transfer requires exactly one source pod');
  return pods[0]!;
}

export function createRetainedSourceTransfer(deps: Deps, context: RetainedSourceContext): RetainedSourceTransfer {
  const ref = deps.db.collection(GLM_OPERATIONS_COLLECTION).doc(context.op.id);
  function requireActiveClaim(fresh: FirebaseFirestore.DocumentData | undefined, allowCancelled = false): void {
    if (fresh?.status !== 'running' || fresh.startedAt !== context.op.startedAt || (!allowCancelled && fresh.cancellationRequestedAt !== undefined)) throw new Error('source transfer active claim changed');
  }
  async function assertActiveClaim(): Promise<void> { requireActiveClaim((await ref.get()).data()); }
  async function transferred(record: SourceTransferExecution | undefined): Promise<SourceTransferExecution> {
    await assertActiveClaim();
    return requireTransferred(record);
  }
  async function readPod(name: string): Promise<SourceTransferPod> {
    const result = await deps.runCommand('kubectl',['-n',deps.namespace,'get','pod',name,'-o','json'],{timeoutMs:15_000});
    if (result.code !== 0) throw new Error('source transfer pod observation unavailable');
    return JSON.parse(result.stdout) as SourceTransferPod;
  }
  async function targetIdentity(target: RetainedSourceTarget): Promise<string> {
    if (!target.vm) {
      const pod = await readPod(target.name);
      if (!pod.metadata.uid || pod.metadata.deletionTimestamp || pod.metadata.name !== target.name || (pod.status as {podIP?:string} | undefined)?.podIP !== target.podIP) throw new Error('target pod unavailable');
      return pod.metadata.uid;
    }
    const runtime = (await deps.db.doc(`glmGateways/${context.state.targetGatewayId}`).get()).data();
    const vm = runtime?.vm;
    if (runtime?.runtime !== 'gce-vm' || !vm?.instanceId || vm.instanceName !== target.name || vm.internalIp !== target.podIP) throw new Error('target VM identity changed');
    return vm.instanceId;
  }
  async function persistObservation(current: SourceTransferExecution, observed: SourceTransferExecution, requireClaim = false): Promise<SourceTransferExecution> {
    await deps.db.runTransaction(async txn => {
      const userRef = deps.db.doc(`users/${current.uid}`);
      const [operation,user] = await Promise.all([txn.get(ref),txn.get(userRef)]);
      const fresh = operation.data();
      if (requireClaim) requireActiveClaim(fresh,true);
      if (fresh?.sourceTransferExecution?.executionId !== current.executionId) throw new Error('source transfer execution changed');
      if (!isDeepStrictEqual(fresh.sourceTransferExecution,current)) return;
      const fence = user.data()?.provisioning?.openclaw?.sourceTransferFence;
      if (!sourceTransferBlocksRelease(observed)) {
        const {status: _status,exitCode: _exitCode,failureReason: _reason,targetCleanup: _cleanup,...identity} = current;
        if (fence !== undefined || current.status !== 'transferred') {
          if (!isDeepStrictEqual(fence,identity)) throw new Error('source transfer user fence changed');
          txn.update(userRef,{'provisioning.openclaw.sourceTransferFence':FieldValue.delete()});
        }
      }
      txn.update(ref,{sourceTransferExecution:observed,lastProgressAt:deps.now()});
    });
    const final = (await ref.get()).data()?.sourceTransferExecution as SourceTransferExecution | undefined;
    if (!final) throw new Error('source transfer execution unavailable');
    return final;
  }
  async function observe(): Promise<SourceTransferExecution | undefined> {
    const operation = (await ref.get()).data();
    if (!operation) throw new Error('source transfer operation unavailable');
    const current = operation.sourceTransferExecution as SourceTransferExecution | undefined;
    if (!current) return undefined;
    assertExecutionContext(current,context);
    if (!sourceTransferBlocksRelease(current)) return current;
    if (current.status === 'preparing' || current.status === 'failed') return current;
    let observed: SourceTransferExecution;
    if (current.status === 'reserved') observed={...current,status:'failed',failureReason:'not-dispatched'};
    else if (current.status === 'prepared') observed={...current,status:'failed',failureReason:'not-dispatched',targetCleanup:'pending'};
    else {
      observed=observeSourceTransfer(current,await readPod(current.podName));
      if(observed.status==='failed') observed={...observed,targetCleanup:'pending'};
    }
    return persistObservation(current,observed);
  }
  async function transitionAuthority(record: SourceTransferExecution, status: 'preparing'|'prepared'|'dispatched', requireClaim: boolean): Promise<SourceTransferExecution> {
    const next={...record,status};
    await deps.db.runTransaction(async txn => {
      const [operation,user] = await Promise.all([txn.get(ref),txn.get(deps.db.doc(`users/${record.uid}`))]);
      const fresh=operation.data();
      const {status: _status,...identity}=record;
      const claimValid=!requireClaim || (fresh?.status === 'running' && fresh?.startedAt === context.op.startedAt && fresh?.cancellationRequestedAt === undefined);
      const exact=[claimValid,isDeepStrictEqual(fresh?.sourceTransferExecution,record),
        isDeepStrictEqual(user.data()?.provisioning?.openclaw?.sourceTransferFence,identity)].every(Boolean);
      if (!exact) throw new Error('source transfer dispatch authority changed');
      txn.update(ref,{sourceTransferExecution:next,lastProgressAt:deps.now()});
    });
    return next;
  }
  async function settledTarget(target: RetainedSourceTarget): Promise<SourceTransferExecution | undefined> {
    requireActiveClaim((await ref.get()).data(),true);
    const record=await observe();
    if (!record || (record.status==='failed' && record.targetCleanup===undefined)) return undefined;
    if (record.status!=='failed' && record.status!=='transferred') throw new Error('source transfer observation pending');
    if (record.targetIdentity !== await targetIdentity(target) || record.targetName!==target.name || record.targetIp!==target.podIP || record.targetVm!==target.vm) throw new Error('source transfer target identity changed');
    return record;
  }
  async function acknowledgeCleanup(record: SourceTransferExecution): Promise<SourceTransferExecution> {
    return persistObservation(record,{...record,targetCleanup:'complete'},true);
  }
  async function probeResources(record: SourceTransferExecution, container: string) {
    const probe = await deps.runCommand('kubectl',['-n',deps.namespace,'exec',record.podName,'-c',container,'--','/usr/local/bin/node','-e',PROBE],{timeoutMs:15_000});
    if (probe.code !== 0) throw new Error('retained source resource admission failed');
    return {...JSON.parse(probe.stdout),observedAt:deps.now()};
  }
  async function waitForHelper(record: SourceTransferExecution): Promise<boolean> {
    const deadline=deps.now()+120_000;
    const wait=deps.wait ?? (ms => new Promise(resolve=>setTimeout(resolve,ms)));
    while(deps.now()<deadline) {
      const pod=await readPod(record.podName);
      if(pod.metadata.uid!==record.podUid) throw new Error('source transfer pod changed during startup');
      const state=pod.status?.ephemeralContainerStatuses?.find(container=>container.name===record.executionId)?.state;
      if(state?.terminated) return false;
      if(state?.running) return true;
      await wait(1000);
    }
    throw new Error('source transfer startup observation pending');
  }
  async function discoverSource(target: RetainedSourceTarget, targetUid: string) {
    const listed = await deps.runCommand('kubectl',['-n',deps.namespace,'get','pods','-l',`app=octogee-gateway,gateway-instance=${context.state.sourceGatewayId}`,'-o','json'],{timeoutMs:15_000});
    if (listed.code !== 0) throw new Error('source transfer pod discovery unavailable');
    const pod = sourcePodFromList(listed.stdout);
    const planned = planSourceTransfer({targetIdentity:targetUid,operationId:context.op.id,claimStartedAt:context.op.startedAt ?? 0,migrationId:context.state.migrationId,uid:context.state.uid,slug:context.state.slug,sourceGatewayId:context.state.sourceGatewayId,assignmentEpoch:context.state.sourceEpoch,podName:pod.metadata.name!,podUid:pod.metadata.uid!,namespace:deps.namespace,image:deps.image,targetGatewayId:context.state.targetGatewayId,targetName:target.name,targetIp:target.podIP,targetVm:target.vm},pod);
    const sourceContainer = pod.spec.containers?.find(c => c.volumeMounts?.some(m => m.name === 'data' && m.mountPath === '/home/node'));
    if (!sourceContainer) throw new Error('retained source container unavailable');
    const resourceAdmission=await probeResources(planned.record,sourceContainer.name);
    const sourceIp = (pod as SourceTransferPod & {status?:{podIP?:string}}).status?.podIP;
    if (!sourceIp) throw new Error('retained source pod has no address');
    return {planned,sourceIp,resourceAdmission,sourceContainerName:sourceContainer.name};
  }
  return {observe,assertActiveClaim,settledTarget,acknowledgeCleanup, async execute(input) {
    const reservation = await runGatewayRuntimeExclusive(async () => {
      const targetUid = await targetIdentity(input.target);
      const previous = await observe();
      if (previous) {
        if (previous.targetIdentity !== targetUid) throw new Error('source transfer target identity changed');
        return { kind: 'existing' as const, previous };
      }
      const source = await discoverSource(input.target,targetUid);
      if (!source.planned.patch) throw new Error('source transfer execution existed before reservation');
      await deps.db.runTransaction(async txn => {
        const [operation,user,assignment,root,targetRoot] = await Promise.all([txn.get(ref),txn.get(deps.db.doc(`users/${context.state.uid}`)),txn.get(deps.db.doc(`gateways/${context.state.sourceGatewayId}/assignments/${context.state.uid}`)),txn.get(deps.db.doc(`gateways/${context.state.sourceGatewayId}`)),txn.get(deps.db.doc(`gateways/${context.state.targetGatewayId}`))]);
        const fresh = operation.data() as Operation;
        assertRetainedSourceAuthority(context,fresh,user.data() ?? {},assignment.data() ?? {},{source:root.data() ?? {},target:targetRoot.data() ?? {}});
        if (fresh.sourceTransferExecution) throw new Error('source transfer already reserved');
        txn.update(ref,{sourceTransferExecution:source.planned.record,lastProgressAt:deps.now()});
        const {status: _status,...identity} = source.planned.record;
        txn.update(deps.db.doc(`users/${context.state.uid}`),{'provisioning.openclaw.sourceTransferFence':identity});
      });
      return { kind: 'reserved' as const, ...source };
    });
    if (reservation.kind === 'existing') return transferred(reservation.previous);
    const {planned,sourceIp,resourceAdmission,sourceContainerName} = reservation;
    let preparing: SourceTransferExecution;
    try {
      preparing=await transitionAuthority(planned.record,'preparing',true);
    } catch(error) {
      await persistObservation(planned.record,{...planned.record,status:'failed',failureReason:'not-dispatched'});
      throw error;
    }
    const push=await input.prepare(sourceIp);
    const prepared=await transitionAuthority(preparing,'prepared',false);
    let dispatchPatch: NonNullable<typeof planned.patch>;
    try {
      if (deps.now()-resourceAdmission.observedAt > 30_000) throw new Error('source transfer resource admission expired');
      const refreshed=planSourceTransfer(planned.record,await readPod(planned.record.podName));
      if (!refreshed.patch) throw new Error('source transfer execution appeared before dispatch');
      dispatchPatch=refreshed.patch;
      await transitionAuthority(prepared,'dispatched',true);
    } catch (error) {
      await persistObservation(prepared,{...prepared,status:'failed',failureReason:'not-dispatched',targetCleanup:'pending'});
      throw error;
    }
    const patched = await deps.runCommand('kubectl',['-n',deps.namespace,'patch','pod',planned.record.podName,'--subresource=ephemeralcontainers','--type=json','-p',JSON.stringify(dispatchPatch)],{timeoutMs:15_000});
    if (patched.code !== 0) throw new Error('source transfer dispatch outcome unresolved');
    if (!await waitForHelper(planned.record)) return transferred(await observe());
    const freshAdmission=await probeResources(planned.record,sourceContainerName);
    const attachClaim = (await ref.get()).data();
    if (attachClaim?.status !== 'running' || attachClaim.startedAt !== context.op.startedAt || attachClaim.cancellationRequestedAt !== undefined) throw new Error('source transfer claim changed before attach');
    await (deps.attach ?? attachTransfer)(deps.namespace,planned.record.podName,planned.record.executionId,{
      resourceAdmission:freshAdmission,version:1,executionId:planned.record.executionId,operationId:context.op.id,claimStartedAt:planned.record.claimStartedAt,migrationId:context.state.migrationId,uid:context.state.uid,slug:context.state.slug,sourceGatewayId:context.state.sourceGatewayId,sourcePodUid:planned.record.podUid,assignmentEpoch:context.state.sourceEpoch,mode:'final',includeActivationManifest:push.includeActivationManifest === true,targetHost:push.targetHost,targetPort:push.targetPort,targetCertificatePem:push.targetCertificatePem,transferUser:push.transferUser,transferKey:push.transferKey,
    });
    return transferred(await observe());
  }};
}
