import { describe, expect, it, vi } from 'vitest';
import { proveRuntimeRestart, runtimeRestartDriverSource } from './runtime-restart-driver.js';
function harness(boots = ['boot-a', 'boot-b']) {
 let now=0,index=0;
 const connections=boots.map(bootId=>({bootId,request:vi.fn(async()=>({ok:true,status:'scheduled',restart:{ok:true}})),close:vi.fn(),alive:()=>true}));
 const deps={connect:vi.fn(async()=>connections[Math.min(index++,connections.length-1)]!),ready:vi.fn(async()=>true),now:()=>now,wait:vi.fn(async()=>{now+=1000;})};
 return {deps,connections};
}
describe('runtime restart completion proof',()=>{
 it('binds request to the same connection boot and requires changed ready boot',async()=>{
  const h=harness();expect(await proveRuntimeRestart('attempt-1',h.deps,3000)).toEqual({version:1,attemptId:'attempt-1',beforeBootId:'boot-a',afterBootId:'boot-b',ready:true});
  expect(h.connections[0]!.request).toHaveBeenCalledWith('gateway.restart.request',{reason:'octogee.runtime-restart',skipDeferral:true});expect(h.connections[1]!.request).toHaveBeenCalledWith('health',{});
 });
 it('never repeats an unacknowledged restart',async()=>{const h=harness();h.connections[0]!.request.mockRejectedValue(new Error('lost acknowledgement'));await expect(proveRuntimeRestart('attempt-1',h.deps,3000)).rejects.toThrow();expect(h.deps.connect).toHaveBeenCalledTimes(1);});
 it('refuses a healthy unchanged boot',async()=>{const h=harness(['boot-a']);await expect(proveRuntimeRestart('attempt-1',h.deps,2000)).rejects.toThrow('deadline');expect(h.deps.ready).not.toHaveBeenCalled();});
 it('requires readiness after changed boot',async()=>{const h=harness();h.deps.ready.mockResolvedValue(false);await expect(proveRuntimeRestart('attempt-1',h.deps,2000)).rejects.toThrow('deadline');});
 it('refuses a connection lost during readiness',async()=>{const h=harness();h.connections[1]!.alive=()=>false;await expect(proveRuntimeRestart('attempt-1',h.deps,2000)).rejects.toThrow('deadline');});
 it.each([null,{}, {ok:true,status:'done',restart:{ok:true}}])('refuses malformed acknowledgement %j',async ack=>{const h=harness();h.connections[0]!.request.mockResolvedValue(ack as never);await expect(proveRuntimeRestart('attempt-1',h.deps,2000)).rejects.toThrow('acknowledgement');});
 it('refuses absent boot before dispatch',async()=>{const h=harness(['']);await expect(proveRuntimeRestart('attempt-1',h.deps,2000)).rejects.toThrow('boot');expect(h.connections[0]!.request).not.toHaveBeenCalled();});
 it('serializes bounded generic failure output',()=>{const s=runtimeRestartDriverSource('attempt-1');expect(s).toContain('180000');expect(s).toContain('runtime restart unconfirmed');expect(()=>runtimeRestartDriverSource('../invalid')).toThrow();});
});
