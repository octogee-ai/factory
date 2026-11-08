import { randomUUID } from 'node:crypto';
import { type Firestore, type Transaction } from 'firebase-admin/firestore';
import { updateRuntimeRestart, type RuntimeRestartFence } from '@octogee/core/gateway-runtime-restart';
export { updateRuntimeRestart, type RuntimeRestartFence } from '@octogee/core/gateway-runtime-restart';
import { assertGatewayRuntimeMutationUnfenced } from '@octogee/core/gateway-retirement-claim';
import { findActiveGatewayMigration, type FleetOperationLockRef } from '@octogee/core/fleet-operation-lock';
import { runNormalFleetMutation } from '@octogee/core/normal-fleet-mutation';
import { createFirestorePlatformStateStore } from '@octogee/core/platform-state';
import { runGatewayRuntimeExclusive } from './gateway-runtime-mutation.js';

export async function assertMigrationRestartUnfenced(db:Firestore,transaction:Transaction,input:Record<string,unknown>):Promise<void> {
  const ids=[input.fromGatewayId,input.toGatewayId].filter((id):id is string=>typeof id==='string');
  const uid = typeof input.uid === 'string' && input.uid && !input.uid.includes('/') ? input.uid : null;
  const [roots, owner] = await Promise.all([
    Promise.all(ids.map(id=>transaction.get(db.collection("gateways").doc(id)))),
    uid ? transaction.get(db.collection('users').doc(uid)) : null,
  ]);
  if(roots.some(root=>root.data()?.runtimeRestartFence!==undefined))throw new Error('gateway runtime restart outcome is unresolved');
  if (owner?.data()?.provisioning?.computerRecovery != null) throw new Error('Builder computer recovery is in progress');
}
export async function acquireRuntimeRestart(db:Firestore,fence:RuntimeRestartFence):Promise<void> {
  await db.runTransaction(async transaction=>{
    const rootRef=db.doc(`gateways/${fence.gatewayId}`);
    const [root,running,pending]=await Promise.all([transaction.get(rootRef),transaction.get(db.collection('glmOperations').where('status','==','running')),transaction.get(db.collection('glmOperations').where('status','==','pending'))]);
    await assertGatewayRuntimeMutationUnfenced(db,transaction,fence.gatewayId);
    const data=root.data();
    if(!data || !['running','draining'].includes(data.desiredStatus) || data.retirementClaim!=null || data.runtimeRestartFence!==undefined || !Number.isSafeInteger(data.liveRelease) || data.liveRelease<1 || data.desiredRelease!==data.liveRelease)throw new Error('gateway restart authority is unavailable');
    const operations=[...running.docs,...pending.docs].map(doc=>({id:doc.id,...doc.data()} as FleetOperationLockRef));
    if(findActiveGatewayMigration(fence.gatewayId,operations))throw new Error('gateway migration is pending during restart admission');
    transaction.update(rootRef,{runtimeRestartFence:fence});
  });
}
export async function coordinateRuntimeRestart(
  db:Firestore,gatewayId:string,kind:RuntimeRestartFence['kind'],
  work:(fence:RuntimeRestartFence,save:(next:RuntimeRestartFence)=>Promise<void>)=>Promise<void>,
  observe?:(fence:RuntimeRestartFence)=>Promise<void>,
):Promise<void> {
  const attemptId=randomUUID();
  const store=createFirestorePlatformStateStore({ db });
  const saved=(await db.doc(`gateways/${gatewayId}`).get()).data()?.runtimeRestartFence as RuntimeRestartFence|undefined;
  await runNormalFleetMutation(store,{
    actor:'cowboy',forced:false,what:saved?.phase==='acknowledged'?'gateway-restart-observation':`gateway-${kind}-restart`,why:kind==='deployment'?'model-key secret changed':'operator requested process restart',
    target:{gatewayId},preActionStatus:saved?{restartAttemptId:saved.attemptId,phase:saved.phase}:{},mutation:{kind,attemptId},idempotencyKey:attemptId,
    action:async claim=>{
      const existing=(await db.doc(`gateways/${gatewayId}`).get()).data()?.runtimeRestartFence as RuntimeRestartFence|undefined;
      if(existing?.phase==='acknowledged') {
        if(!observe || existing.gatewayId!==gatewayId)throw new Error('gateway restart observation unavailable');
        await observe(existing);
        await updateRuntimeRestart(store,existing,null);
        return;
      }
      let current:RuntimeRestartFence={attemptId,auditId:claim.auditId,gatewayId,kind,startedAt:Date.now(),phase:'reserved'};
      await runGatewayRuntimeExclusive(() => acquireRuntimeRestart(db,current));
      try {
        await work(current,async next=>{await updateRuntimeRestart(store,current,next);current=next;});
        if(current.phase!=='acknowledged')throw new Error('gateway restart completion was not acknowledged');
        await updateRuntimeRestart(store,current,null);
      } catch(error) {
        if(current.phase==='reserved')await updateRuntimeRestart(store,current,null);
        throw error;
      }
    },
  });
}
