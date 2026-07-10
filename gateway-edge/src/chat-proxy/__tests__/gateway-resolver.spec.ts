import { describe, it, expect } from 'vitest';
import {
  resolveGatewayUrl,
  GatewayResolveError,
} from '../openclaw/gateway-resolver.js';

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

const URL_A =
  'http://octogee-gateway-gw-a.octogee-test.svc.cluster.local:18789';

describe('resolveGatewayUrl — glm-heartbeat / revision resolution (no round-robin alias)', () => {
  it('legacy gateway: resolves internalUrl from glmGateways/{id}.heartbeat', async () => {
    const db = mkDb({
      'users/u1': { provisioning: { openclaw: { gatewayId: 'gw-a' } } },
      // legacy desired doc (no GatewayDoc fields) carries the relocated heartbeat.
      'glmGateways/gw-a': { gatewayId: 'gw-a', heartbeat: { internalUrl: URL_A } },
    });
    const r = await resolveGatewayUrl({ db, uid: 'u1' });
    expect(r.gatewayId).toBe('gw-a');
    expect(r.url).toBe(URL_A);
  });

  it('backfilled GatewayDoc + assignment: resolves via the assignment revision heartbeat', async () => {
    const db = mkDb({
      'users/u1': { provisioning: { openclaw: { gatewayId: 'gw-a' } } },
      'gateways/gw-a': {
        gatewayId: 'gw-a',
        desiredRelease: 2,
        latestRelease: 2,
        desiredStatus: 'running',
        liveRevisionId: 'gw-a-r1',
      },
      'gateways/gw-a/assignments/u1': {
        uid: 'u1',
        slug: 'alice',
        gatewayId: 'gw-a',
        revisionId: 'gw-a-r2',
        release: 2,
        source: 'rollout',
      },
      'glmGateways/gw-a-r1': { heartbeat: { internalUrl: 'http://stale-r1:18789' } },
      'glmGateways/gw-a-r2': { heartbeat: { internalUrl: URL_A } },
    });
    const r = await resolveGatewayUrl({ db, uid: 'u1' });
    // Must dial the customer's assigned revision (r2), never the stale live/other.
    expect(r.url).toBe(URL_A);
  });

  it('backfilled GatewayDoc, no assignment: falls back to the live revision heartbeat', async () => {
    const db = mkDb({
      'users/u1': { provisioning: { openclaw: { gatewayId: 'gw-a' } } },
      'gateways/gw-a': {
        gatewayId: 'gw-a',
        desiredRelease: 1,
        latestRelease: 1,
        desiredStatus: 'running',
        liveRevisionId: 'gw-a-r1',
      },
      'glmGateways/gw-a-r1': { heartbeat: { internalUrl: URL_A } },
    });
    const r = await resolveGatewayUrl({ db, uid: 'u1' });
    expect(r.url).toBe(URL_A);
  });

  it('backfilled GatewayDoc with NO resolvable revision: fails loud, never dials', async () => {
    const db = mkDb({
      'users/u1': { provisioning: { openclaw: { gatewayId: 'gw-a' } } },
      'gateways/gw-a': {
        gatewayId: 'gw-a',
        desiredRelease: 1,
        latestRelease: 1,
        desiredStatus: 'running',
        liveRevisionId: null,
      },
    });
    await expect(resolveGatewayUrl({ db, uid: 'u1' })).rejects.toMatchObject({
      code: 'gateway-url-unresolved',
    });
  });

  it('NEVER honors a flat internalUrl contaminating a backfilled GatewayDoc', async () => {
    const db = mkDb({
      'users/u1': { provisioning: { openclaw: { gatewayId: 'gw-a' } } },
      'gateways/gw-a': {
        gatewayId: 'gw-a',
        desiredRelease: 1,
        latestRelease: 1,
        desiredStatus: 'running',
        liveRevisionId: 'gw-a-r1',
        // stale dual-write residue — must be ignored in favor of revision resolution
        internalUrl: 'http://WRONG-flat:18789',
      },
      'glmGateways/gw-a-r1': { heartbeat: { internalUrl: URL_A } },
    });
    const r = await resolveGatewayUrl({ db, uid: 'u1' });
    expect(r.url).toBe(URL_A);
  });

  it('honors overrideUrl (sidecar mode) and skips the gateway reads', async () => {
    const db = mkDb({
      'users/u1': { provisioning: { openclaw: { gatewayId: 'gw-a' } } },
    });
    const r = await resolveGatewayUrl({
      db,
      uid: 'u1',
      overrideUrl: 'http://127.0.0.1:18789',
    });
    expect(r.gatewayId).toBe('gw-a');
    expect(r.url).toBe('http://127.0.0.1:18789');
  });

  it('still requires user provisioning when overrideUrl is set', async () => {
    const db = mkDb({});
    await expect(
      resolveGatewayUrl({ db, uid: 'u1', overrideUrl: 'http://127.0.0.1:18789' }),
    ).rejects.toMatchObject({ code: 'user-not-provisioned' });
  });

  it('throws gateway-url-unresolved when the revision heartbeat has no internalUrl', async () => {
    const db = mkDb({
      'users/u1': { provisioning: { openclaw: { gatewayId: 'gw-b' } } },
      'glmGateways/gw-b': { heartbeat: { status: 'ready' } },
    });
    await expect(resolveGatewayUrl({ db, uid: 'u1' })).rejects.toThrow(GatewayResolveError);
    await expect(resolveGatewayUrl({ db, uid: 'u1' })).rejects.toMatchObject({
      code: 'gateway-url-unresolved',
    });
  });

  it('throws user-not-provisioned when the user doc lacks gatewayId', async () => {
    const db = mkDb({ 'users/u1': { provisioning: { openclaw: {} } } });
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

  it('throws gateway-not-registered when the resolved revision doc is missing', async () => {
    const db = mkDb({
      'users/u1': { provisioning: { openclaw: { gatewayId: 'gw-missing' } } },
    });
    await expect(resolveGatewayUrl({ db, uid: 'u1' })).rejects.toMatchObject({
      code: 'gateway-not-registered',
    });
  });
});
