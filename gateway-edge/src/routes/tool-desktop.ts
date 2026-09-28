import { GATEWAY_DESKTOP_NODE_NAME } from '@octogee/shared/types/glm';
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
export function desktopNodeIdentity(value: unknown, nodeName = GATEWAY_DESKTOP_NODE_NAME): string {
  const inventory = browserRecord(value);
  if (!Array.isArray(inventory?.nodes)) throw new Error('Native desktop node inventory unavailable');
  const matching = inventory.nodes.map(browserRecord).filter(node => node?.gatewayLocal === true && node.displayName === nodeName);
  if (matching.length !== 1) throw new Error('The shared desktop node identity is unavailable or ambiguous');
  const node = matching[0]!;
  const address = typeof node.remoteIp === 'string' ? node.remoteIp.replace(/^::ffff:/u, '') : '';
  if (node.paired !== true || node.connected !== true || !['', '127.0.0.1', '::1'].includes(address) ||
    typeof node.nodeId !== 'string' || !/^[a-zA-Z0-9_-]{1,256}$/u.test(node.nodeId) ||
    !Array.isArray(node.commands) || !node.commands.includes('desktop.stream')) throw new Error('The shared desktop node is not connected and approved');
  return node.nodeId;
}
export function desktopEnvironment(value: unknown, nodeId: string): Record<string, unknown> {
  const entry = browserRecord(value);
  if (entry?.id !== `node:${nodeId}` || entry.type !== 'node' || entry.status !== 'available' || entry.desktop !== true) throw new Error('Native shared desktop unavailable');
  return Object.fromEntries(['id', 'type', 'label', 'status', 'platform', 'desktop', 'desktopAvailability', 'desktopSetup'].filter(key => entry[key] !== undefined).map(key => [key, entry[key]]));
}
