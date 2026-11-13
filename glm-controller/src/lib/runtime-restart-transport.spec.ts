import {describe,it,expect} from 'vitest';
import {deploymentRestartComplete,validateProcessRestartReceipt} from './runtime-restart-transport.js';
import type {RuntimeRestartFence} from './runtime-restart-coordinator.js';

describe('runtime restart positive completion proof',()=>{
 it.each([{}, {version:1,attemptId:'attempt',beforeBootId:'before',afterBootId:'before',ready:true},{version:1,attemptId:'other',beforeBootId:'before',afterBootId:'after',ready:true},{version:1,attemptId:'attempt',beforeBootId:'before',afterBootId:'after',ready:false}])('rejects incomplete or mismatched process receipts %j',receipt=>{
  expect(()=>validateProcessRestartReceipt(receipt,'attempt')).toThrow('completion unverified');
 });
 it('accepts only distinct boot IDs for the exact attempt',()=>{
  expect(()=>validateProcessRestartReceipt({version:1,attemptId:'attempt',beforeBootId:'before',afterBootId:'after',ready:true},'attempt')).not.toThrow();
 });
 it.each(['ready','old-pod','wrong-owner','unready','wrong-token','wrong-generation','wrong-deployment'])('requires exact rollout completion for %s',fault=>{
  const fence:RuntimeRestartFence={attemptId:'attempt',auditId:'audit',gatewayId:'gateway',kind:'deployment',phase:'acknowledged',startedAt:1,target:{deploymentUid:'deployment',oldPodUids:['old']},acknowledgement:{generation:2}};
  const deployment={metadata:{uid:'deployment',name:'deployment',resourceVersion:'2',generation:2},spec:{replicas:1,template:{metadata:{annotations:{'octogee.com/runtime-restart-attempt':'attempt'}}}},status:{observedGeneration:2,updatedReplicas:1,readyReplicas:1,availableReplicas:1}};
  const pod={metadata:{uid:'new',name:'pod',resourceVersion:'2',annotations:{'octogee.com/runtime-restart-attempt':'attempt'},ownerReferences:[{uid:'replica-set'}]},status:{conditions:[{type:'Ready',status:'True'}]}};
  const replicaSet={metadata:{uid:'replica-set',name:'replica-set',resourceVersion:'2',ownerReferences:[{uid:'deployment'}]}};
  if(fault==='old-pod')pod.metadata.uid='old';
  if(fault==='wrong-owner')pod.metadata.ownerReferences=[{uid:'foreign'}];
  if(fault==='unready')pod.status.conditions=[];
  if(fault==='wrong-token')pod.metadata.annotations['octogee.com/runtime-restart-attempt']='other';
  if(fault==='wrong-generation')deployment.status.observedGeneration=1;
  if(fault==='wrong-deployment')deployment.metadata.uid='replaced';
  expect(deploymentRestartComplete(deployment,[pod],[replicaSet],fence)).toBe(fault==='ready');
 });
});
