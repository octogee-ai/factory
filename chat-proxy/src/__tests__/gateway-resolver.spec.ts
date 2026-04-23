/**
 * Unit tests for the Firestore → gateway-URL resolver.
 *
 * Uses a minimal in-memory stub of the firebase-admin Firestore shape so
 * the test never touches a real client.
 */
import { describe, it, expect } from 'vitest';
import {
  canonicalGatewayUrl,
  resolveGatewayUrl,
  GatewayResolveError,
} from '../openclaw/gateway-resolver';

type DocData = Record<string, unknown> | undefined;

function mkDb(docs: Record<string, DocData>): any {
  return {
    doc: (path: string) => ({
      async get() {
        const data = docs[path];
        return {
          exists: data !== undefined,
          data: () => data,
        };
      },
    }),
  };
}

describe('canonicalGatewayUrl', () => {
  it('formats the cluster-internal DNS shape', () => {
    expect(canonicalGatewayUrl('gw-a', 'octogee-test', '18789')).toBe(
      'http://octogee-gateway-gw-a.octogee-test.svc.cluster.local:18789',
    );
  });
});

describe('resolveGatewayUrl', () => {
  it('returns the heartbeat-written internalUrl when present', async () => {
    const db = mkDb({
      'users/u1': { provisioning: { openclaw: { gatewayId: 'gw-a' } } },
      'gateways/gw-a': {
        internalUrl: 'http://octogee-gateway-gw-a.octogee-test.svc.cluster.local:18789',
      },
    });
    const r = await resolveGatewayUrl({ db, uid: 'u1' });
    expect(r.gatewayId).toBe('gw-a');
    expect(r.url).toBe('http://octogee-gateway-gw-a.octogee-test.svc.cluster.local:18789');
    expect(r.usedFallback).toBe(false);
  });

  it('falls back to canonical DNS when internalUrl is absent (fresh deploy)', async () => {
    const db = mkDb({
      'users/u1': { provisioning: { openclaw: { gatewayId: 'gw-b' } } },
      'gateways/gw-b': { status: 'ready' },
    });
    const r = await resolveGatewayUrl({
      db,
      uid: 'u1',
      namespace: 'octogee-test',
      port: '18789',
    });
    expect(r.url).toBe('http://octogee-gateway-gw-b.octogee-test.svc.cluster.local:18789');
    expect(r.usedFallback).toBe(true);
  });

  it('throws user-not-provisioned when the user doc lacks gatewayId', async () => {
    const db = mkDb({ 'users/u1': { provisioning: { openclaw: {} } } });
    await expect(resolveGatewayUrl({ db, uid: 'u1' })).rejects.toThrow(GatewayResolveError);
    await expect(resolveGatewayUrl({ db, uid: 'u1' })).rejects.toMatchObject({
      code: 'user-not-provisioned',
    });
  });

  it('throws user-not-provisioned when the user doc is missing', async () => {
    const db = mkDb({});
    await expect(resolveGatewayUrl({ db, uid: 'u1' })).rejects.toMatchObject({
      code: 'user-not-provisioned',
    });
  });

  it('throws gateway-not-registered when gateways/{id} is missing', async () => {
    const db = mkDb({
      'users/u1': { provisioning: { openclaw: { gatewayId: 'gw-missing' } } },
    });
    await expect(resolveGatewayUrl({ db, uid: 'u1' })).rejects.toMatchObject({
      code: 'gateway-not-registered',
    });
  });
});
