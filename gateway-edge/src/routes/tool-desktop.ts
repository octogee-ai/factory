import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { GATEWAY_DESKTOP_NODE_IDENTITY_PATH, GATEWAY_DESKTOP_NODE_NAME } from '@octogee/shared/types/glm';
import { browserRecord } from './browser-policy.js';
export function desktopObserveParams(value: unknown, canControl: boolean, nodeId: string): Record<string, unknown> {
  const params = browserRecord(value); const source = browserRecord(params?.source);
  if (!params || Object.keys(params).some(key => !['source', 'control'].includes(key)) || !source || source.kind !== 'node' || source.nodeId !== nodeId || Object.keys(source).some(key => !['kind', 'nodeId'].includes(key)) ||
    (params.control !== undefined && typeof params.control !== 'boolean') || (params.control === true && !canControl)) throw new Error('Desktop operation is unavailable');
  return { source: { kind: 'node', nodeId }, control: params.control === true };
}
export function desktopStreamPath(value: unknown, kind: 'rfb' | 'audio'): string {
  if (typeof value !== 'string' || !value.startsWith('/desktop/')) throw new Error('Invalid native desktop stream');
  const url = new URL(value, 'http://localhost'); const token = url.searchParams.get('token');
  if (url.pathname !== (kind === 'rfb' ? '/desktop/observe' : '/desktop/audio') || !token || token.length > 256 || !/^[A-Za-z0-9_-]+$/u.test(token) ||
    [...url.searchParams.keys()].join(',') !== 'token' || url.hash) throw new Error('Invalid native desktop stream');
  return value;
}
export async function readDesktopNodeIdentity(path = GATEWAY_DESKTOP_NODE_IDENTITY_PATH): Promise<string> {
  try {
    const value = browserRecord(JSON.parse(await readFile(path, 'utf8')));
    if (!value || Object.keys(value).sort().join(',') !== 'deviceId,publicKey' ||
      typeof value.deviceId !== 'string' || !/^[a-f0-9]{64}$/u.test(value.deviceId) ||
      typeof value.publicKey !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(value.publicKey)) throw new Error('Invalid public identity');
    const key = Buffer.from(value.publicKey, 'base64url');
    if (key.toString('base64url') !== value.publicKey || createHash('sha256').update(key).digest('hex') !== value.deviceId) throw new Error('Public identity fingerprint mismatch');
    return value.deviceId;
  } catch (cause) {
    throw new Error('Native desktop identity unavailable', { cause });
  }
}
export function desktopNodeIdentity(value: unknown, expectedNodeId: string, nodeName = GATEWAY_DESKTOP_NODE_NAME): string {
  const inventory = browserRecord(value);
  if (!Array.isArray(inventory?.nodes)) throw new Error('Native desktop node inventory unavailable');
  if (!/^[a-f0-9]{64}$/u.test(expectedNodeId)) throw new Error('Native desktop identity unavailable');
  const matching = inventory.nodes.map(browserRecord).filter(node => node?.nodeId === expectedNodeId);
  if (matching.length !== 1) throw new Error('The shared desktop node identity is unavailable or ambiguous');
  const node = matching[0]!;
  const address = typeof node.remoteIp === 'string' ? node.remoteIp.replace(/^::ffff:/u, '') : '';
  if (node.displayName !== nodeName || node.paired !== true || node.connected !== true || !['', '127.0.0.1', '::1'].includes(address) ||
    typeof node.nodeId !== 'string' || !/^[a-zA-Z0-9_-]{1,256}$/u.test(node.nodeId) ||
    !Array.isArray(node.commands) || !node.commands.includes('desktop.stream')) throw new Error('The shared desktop node is not connected and approved');
  return node.nodeId;
}
export function desktopEnvironment(value: unknown, nodeId: string): Record<string, unknown> {
  const entry = browserRecord(value);
  if (entry?.id !== `node:${nodeId}` || entry.type !== 'node' || entry.status !== 'available' || entry.desktop !== true) throw new Error('Native shared desktop unavailable');
  return Object.fromEntries(['id', 'type', 'label', 'status', 'platform', 'desktop', 'desktopAvailability', 'desktopSetup'].filter(key => entry[key] !== undefined).map(key => [key, entry[key]]));
}
