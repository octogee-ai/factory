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

function durableRoot(gatewayId: string, overrides: Record<string, unknown> = {}) {
  return {
    gatewayId,
    createdAt: 1,
    createdBy: 'test',
    updatedAt: 1,
    updatedBy: 'test',
    desiredRelease: 1,
    latestRelease: 1,
    liveRelease: 1,
    desiredStatus: 'running',
    liveRevisionId: `${gatewayId}-r1`,
    trafficRevisionId: `${gatewayId}-r1`,
    roll: null,
    configSchemaVersion: 1,
    profile: 'standard',
    gatewayClass: 'shared',
    imageProfile: 'standard',
    sizingTier: null,
    computeClass: null,
    gcpProject: null,
    gatewayContainerSecurityContext: null,
    serviceAccountName: null,
    serviceAccount: null,
    operatorAccess: null,
    ownerUid: null,
    coOwnerUids: [],
    builderSlug: null,
    openclawOverrides: null,
    modelBrokerLimits: null,
    preemption: null,
    ...overrides,
  };
}

function servingRevision(
  gatewayId: string,
  release: number,
  heartbeat: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
) {
  const revisionId = `${gatewayId}-r${release}`;
  return {
    docKind: 'revision',
    revisionId,
    gateway: gatewayId,
    release,
    rollRole: null,
    lifecycle: 'serving',
    createdAt: 1,
    createdByOperationId: null,
    retiredAt: null,
    retireReason: null,
    helm: {
      releaseName: `octogee-gw-${revisionId}`,
      deploymentName: `octogee-gateway-${revisionId}`,
      gatewayServiceName: `gateway-${revisionId}`,
      gatewayEdgeServiceName: `gateway-edge-${revisionId}`,
      serviceAccountName: `octogee-gw-${gatewayId}`,
      imageRepository: 'us-central1-docker.pkg.dev/octogee/octogee/gateway',
      imageTag: 'abc1234',
      replicas: 1,
      availableReplicas: 1,
      lastAppliedAt: 1,
    },
    heartbeat: {
      status: 'ready',
      lastHeartbeatAt: 1,
      version: 'abc1234',
      openclawVersion: null,
      internalUrl: null,
      startedAt: 1,
      mountedCustomers: [],
      migratingIn: [],
      ...heartbeat,
    },
    lastError: { message: null, at: null },
    ...overrides,
  };
}

function servingAssignment(
  gatewayId: string,
  uid: string,
  release: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    uid,
    slug: 'alice',
    gatewayId,
    revisionId: `${gatewayId}-r${release}`,
    release,
    source: 'rollout',
    state: 'serving',
    epoch: 1,
    updatedAt: 1,
    updatedByOperationId: null,
    ...overrides,
  };
}

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

  it('backfilled rolling GatewayDoc + serving assignment: resolves via the canonical target revision heartbeat', async () => {
    const db = mkDb({
      'users/u1': { provisioning: { openclaw: { gatewayId: 'gw-a' } } },
      'gateways/gw-a': durableRoot('gw-a', {
        desiredRelease: 2,
        latestRelease: 2,
        roll: {
          operationId: 'roll-gw-a-r2',
          status: 'migrating',
          fromRelease: 1,
          toRelease: 2,
          sourceRevisionId: 'gw-a-r1',
          targetRevisionId: 'gw-a-r2',
          acceptingNewAssignments: true,
          startedAt: 1,
          updatedAt: 1,
          error: null,
          flippedAt: null,
        },
      }),
      'gateways/gw-a/assignments/u1': servingAssignment('gw-a', 'u1', 2),
      'glmGateways/gw-a-r1': servingRevision('gw-a', 1, {
        internalUrl: 'http://stale-r1:18789',
      }),
      'glmGateways/gw-a-r2': servingRevision('gw-a', 2, { internalUrl: URL_A }),
    });
    const r = await resolveGatewayUrl({ db, uid: 'u1' });
    // Must dial the customer's assigned revision (r2), never the stale live/other.
    expect(r.url).toBe(URL_A);
  });

  it('backfilled GatewayDoc, no assignment: falls back to the live revision heartbeat', async () => {
    const db = mkDb({
      'users/u1': { provisioning: { openclaw: { gatewayId: 'gw-a' } } },
      'gateways/gw-a': durableRoot('gw-a'),
      'glmGateways/gw-a-r1': servingRevision('gw-a', 1, { internalUrl: URL_A }),
    });
    const r = await resolveGatewayUrl({ db, uid: 'u1' });
    expect(r.url).toBe(URL_A);
  });

  it('backfilled GatewayDoc with NO resolvable revision: fails loud, never dials', async () => {
    const db = mkDb({
      'users/u1': { provisioning: { openclaw: { gatewayId: 'gw-a' } } },
      'gateways/gw-a': durableRoot('gw-a', {
        liveRelease: null,
        liveRevisionId: null,
        trafficRevisionId: null,
      }),
    });
    await expect(resolveGatewayUrl({ db, uid: 'u1' })).rejects.toMatchObject({
      code: 'gateway-url-unresolved',
    });
  });

  it('NEVER honors a flat internalUrl contaminating a backfilled GatewayDoc', async () => {
    const db = mkDb({
      'users/u1': { provisioning: { openclaw: { gatewayId: 'gw-a' } } },
      'gateways/gw-a': durableRoot('gw-a', {
        internalUrl: 'http://WRONG-flat:18789',
      }),
      'glmGateways/gw-a-r1': servingRevision('gw-a', 1, { internalUrl: URL_A }),
    });
    const r = await resolveGatewayUrl({ db, uid: 'u1' });
    expect(r.url).toBe(URL_A);
  });

  it('rejects an existing incomplete root instead of falling back to the legacy glm heartbeat', async () => {
    const db = mkDb({
      'users/u1': { provisioning: { openclaw: { gatewayId: 'gw-a' } } },
      'gateways/gw-a': { gatewayId: 'gw-a', internalUrl: 'http://WRONG-flat:18789' },
      'glmGateways/gw-a': { heartbeat: { internalUrl: URL_A } },
    });

    await expect(resolveGatewayUrl({ db, uid: 'u1' })).rejects.toMatchObject({
      code: 'gateway-root-invalid',
    });
  });

  it('rejects a malformed assignment instead of falling back to the live revision', async () => {
    const db = mkDb({
      'users/u1': { provisioning: { openclaw: { gatewayId: 'gw-a' } } },
      'gateways/gw-a': durableRoot('gw-a'),
      'gateways/gw-a/assignments/u1': { gatewayId: 'gw-a' },
      'glmGateways/gw-a-r1': servingRevision('gw-a', 1, { internalUrl: URL_A }),
    });

    await expect(resolveGatewayUrl({ db, uid: 'u1' })).rejects.toMatchObject({
      code: 'gateway-url-unresolved',
    });
  });

  it('rejects an assignment that does not point at a current root revision', async () => {
    const db = mkDb({
      'users/u1': { provisioning: { openclaw: { gatewayId: 'gw-a' } } },
      'gateways/gw-a': durableRoot('gw-a'),
      'gateways/gw-a/assignments/u1': servingAssignment('gw-a', 'u1', 2),
      'glmGateways/gw-a-r1': servingRevision('gw-a', 1, { internalUrl: 'http://r1:18789' }),
      'glmGateways/gw-a-r2': servingRevision('gw-a', 2, { internalUrl: URL_A }),
    });

    await expect(resolveGatewayUrl({ db, uid: 'u1' })).rejects.toMatchObject({
      code: 'gateway-url-unresolved',
    });
  });

  it.each([
    ['a non-serving assignment', servingAssignment('gw-a', 'u1', 1, { state: 'migrating' })],
    ['an assignment with an invalid state', servingAssignment('gw-a', 'u1', 1, { state: 'unknown' })],
    ['an assignment for another gateway', servingAssignment('gw-a', 'u1', 1, { gatewayId: 'other' })],
  ])('rejects %s instead of routing it', async (_label, assignment) => {
    const db = mkDb({
      'users/u1': { provisioning: { openclaw: { gatewayId: 'gw-a' } } },
      'gateways/gw-a': durableRoot('gw-a'),
      'gateways/gw-a/assignments/u1': assignment,
      'glmGateways/gw-a-r1': servingRevision('gw-a', 1, { internalUrl: URL_A }),
    });

    await expect(resolveGatewayUrl({ db, uid: 'u1' })).rejects.toMatchObject({
      code: 'gateway-url-unresolved',
    });
  });

  it('rejects a durable root with a mismatched traffic pointer', async () => {
    const db = mkDb({
      'users/u1': { provisioning: { openclaw: { gatewayId: 'gw-a' } } },
      'gateways/gw-a': durableRoot('gw-a', { trafficRevisionId: 'gw-a-r2' }),
      'glmGateways/gw-a-r1': servingRevision('gw-a', 1, { internalUrl: URL_A }),
    });

    await expect(resolveGatewayUrl({ db, uid: 'u1' })).rejects.toMatchObject({
      code: 'gateway-url-unresolved',
    });
  });

  it.each([
    ['different gateway', servingRevision('gw-a', 1, { internalUrl: URL_A }, { gateway: 'other' })],
    ['noncanonical revision id', servingRevision('gw-a', 1, { internalUrl: URL_A }, { revisionId: 'gw-a-r2' })],
    ['wrong release', servingRevision('gw-a', 1, { internalUrl: URL_A }, { release: 2 })],
    ['retired lifecycle', servingRevision('gw-a', 1, { internalUrl: URL_A }, { lifecycle: 'retired' })],
  ])('rejects a durable revision with %s', async (_label, revision) => {
    const db = mkDb({
      'users/u1': { provisioning: { openclaw: { gatewayId: 'gw-a' } } },
      'gateways/gw-a': durableRoot('gw-a'),
      'glmGateways/gw-a-r1': revision,
    });

    await expect(resolveGatewayUrl({ db, uid: 'u1' })).rejects.toMatchObject({
      code: 'gateway-url-unresolved',
    });
  });

  it('rejects a retired durable root even when its revision still has an internal URL', async () => {
    const db = mkDb({
      'users/u1': { provisioning: { openclaw: { gatewayId: 'gw-a' } } },
      'gateways/gw-a': durableRoot('gw-a', { desiredStatus: 'retired' }),
      'glmGateways/gw-a-r1': servingRevision('gw-a', 1, { internalUrl: URL_A }),
    });

    await expect(resolveGatewayUrl({ db, uid: 'u1' })).rejects.toMatchObject({
      code: 'gateway-url-unresolved',
    });
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
