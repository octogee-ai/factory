import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { desktopObserveParams, desktopStreamPath, desktopEnvironment, desktopNodeIdentity, readDesktopNodeIdentity } from './tool-desktop.js';
const publicKey = Buffer.alloc(32, 1).toString('base64url');
const deviceId = createHash('sha256').update(Buffer.from(publicKey, 'base64url')).digest('hex');
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const node = {nodeId:deviceId,displayName:'octogee-desktop',paired:true,connected:true,remoteIp:'127.0.0.1',commands:['desktop.stream','computer.click']};
describe('native paired gateway desktop transport contract', () => {
  it('selects the exported native identity of the separately installed desktop node', () => {
    expect(desktopNodeIdentity({nodes:[node]},deviceId,'octogee-desktop')).toBe(deviceId);
    for (const changed of [{nodeId:'foreign'},{paired:false},{connected:false},{remoteIp:'203.0.113.5'},{displayName:'foreign'},{commands:[]}]) {
      expect(() => desktopNodeIdentity({nodes:[{...node,...changed}]},deviceId,'octogee-desktop')).toThrow();
    }
    expect(() => desktopNodeIdentity({nodes:[node,{...node}]},deviceId,'octogee-desktop')).toThrow();
  });
  it('does not adopt a gateway-local or same-name node instead of the pinned desktop', () => {
    expect(() => desktopNodeIdentity({nodes:[{...node,nodeId:'foreign',gatewayLocal:true}]}, deviceId)).toThrow();
    expect(() => desktopNodeIdentity({nodes:[node]}, '')).toThrow();
    expect(desktopNodeIdentity({nodes:[node,{...node,nodeId:'foreign',gatewayLocal:true}]}, deviceId)).toBe(deviceId);
  });
  it('reads only a complete native public identity whose device id matches its key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'desktop-identity-')); roots.push(root);
    const path = join(root, 'identity.json');
    await expect(readDesktopNodeIdentity(path)).rejects.toThrow('Native desktop identity unavailable');
    for (const value of ['{', '{}', JSON.stringify({deviceId, publicKey: 'invalid'}), JSON.stringify({deviceId:'f'.repeat(64), publicKey}), JSON.stringify({deviceId, publicKey, privateKey:'private'})]) {
      await writeFile(path, value);
      await expect(readDesktopNodeIdentity(path)).rejects.toThrow('Native desktop identity unavailable');
    }
    await writeFile(path, JSON.stringify({deviceId, publicKey}));
    await expect(readDesktopNodeIdentity(path)).resolves.toBe(deviceId);
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
    expect(desktopEnvironment({ id: 'node:desktop-node', type: 'node', status: 'available', desktop: true },'desktop-node', { mode: 'desktop', shell: 'disconnected', listener: 'closed-pending-mode' })).toEqual({ id: 'node:desktop-node', type: 'node', status: 'available', desktop: true, egress: { mode: 'desktop', shell: 'disconnected', listener: 'closed-pending-mode' } });
    for (const changed of [{id:'gateway'},{id:'node:foreign'},{type:'gateway'},{status:'unavailable'},{desktop:false}]) expect(() => desktopEnvironment({id:'node:desktop-node',type:'node',status:'available',desktop:true,...changed},'desktop-node')).toThrow();
  });
});
