import { describe, expect, it } from 'vitest';
import { desktopObserveParams, desktopStreamPath, desktopEnvironment, desktopNodeIdentity } from './tool-desktop.js';
const node = {nodeId:'desktop-node',displayName:'octogee-desktop',gatewayLocal:true,paired:true,connected:true,remoteIp:'127.0.0.1',commands:['desktop.stream','computer.click']};
describe('native paired gateway desktop transport contract', () => {
  it('selects the exact connected native same-install desktop identity', () => {
    expect(desktopNodeIdentity({nodes:[node]},'octogee-desktop')).toBe('desktop-node');
    for (const changed of [{gatewayLocal:false},{paired:false},{connected:false},{remoteIp:'203.0.113.5'},{displayName:'foreign'},{commands:[]}]) {
      expect(() => desktopNodeIdentity({nodes:[{...node,...changed}]},'octogee-desktop')).toThrow();
    }
    expect(() => desktopNodeIdentity({nodes:[node,{...node,nodeId:'ambiguous'}]},'octogee-desktop')).toThrow();
  });
  it('admits only that node source and native control permission', () => {
    expect(desktopObserveParams({ source: {kind: 'node',nodeId:'desktop-node'}, control: true }, true, 'desktop-node')).toEqual({ source: {kind: 'node',nodeId:'desktop-node'}, control: true });
    for (const value of [{ source: {kind: 'node', nodeId: 'foreign'} }, { source: {kind:'host'} }, { source: {kind: 'node',nodeId:'desktop-node'}, credentials: {password: 'x'} }, { source: {kind: 'node',nodeId:'desktop-node'}, control: 'yes' }]) expect(() => desktopObserveParams(value, true, 'desktop-node')).toThrow();
    expect(() => desktopObserveParams({ source: {kind: 'node',nodeId:'desktop-node'}, control: true }, false, 'desktop-node')).toThrow();
  });
  it('restricts native RFB and audio upgrades to their issued endpoint', () => {
    expect(desktopStreamPath('/desktop/observe?token=native', 'rfb')).toBe('/desktop/observe?token=native');
    expect(desktopStreamPath('/desktop/audio?token=native', 'audio')).toBe('/desktop/audio?token=native');
    for (const value of ['https://evil/desktop/observe?token=native', '/desktop/audio?token=native', '/desktop/observe?token=native&x=y', '/desktop/observe?token=one&token=two']) expect(() => desktopStreamPath(value, 'rfb')).toThrow();
  });
  it('projects only the bound native node inventory', () => {
    expect(desktopEnvironment({ id: 'node:desktop-node', type: 'node', status: 'available', desktop: true, secret: 'omit' },'desktop-node')).toEqual({ id: 'node:desktop-node', type: 'node', status: 'available', desktop: true });
    for (const changed of [{id:'gateway'},{id:'node:foreign'},{type:'gateway'},{status:'unavailable'},{desktop:false}]) expect(() => desktopEnvironment({id:'node:desktop-node',type:'node',status:'available',desktop:true,...changed},'desktop-node')).toThrow();
  });
});
