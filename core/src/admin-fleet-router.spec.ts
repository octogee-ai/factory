import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Firestore } from "firebase-admin/firestore";

import {
  addAdminFleetRoutes,
  projectBuilderRuntime,
  projectDisposableFleetCapacity,
  projectGatewayReservation,
  projectGatewayControl,
  projectGatewaySummary,
  resolveFleetDeploymentSettings,
  shapeOperationsHistoryRecord,
  type GatewayPodDiagnostics,
} from "./admin-fleet-router.js";
import {
  GLM_GATEWAYS_COLLECTION,
  GLM_OPERATIONS_COLLECTION,
} from "@octogee/shared/types/glm";
import { SPOT_PRICE_MULTIPLIER } from "@octogee/shared/types/cost-estimator";

describe("projectGatewayControl", () => {
  const root = {
    gatewayId: "gw-1",
    imageRepository: "repo",
    imageTag: "tag",
    desiredStatus: "running",
    createdBy: "test",
    desiredRelease: 3,
    liveRelease: 2,
  };

  it("exposes every mutable config knob with explicit nulls", () => {
    const control = projectGatewayControl(
      {
        ...root,
        gatewayClass: "builder",
        sizingTier: "m",
        ownerUid: "uid-1",
        builderSlug: "alice",
        modelBrokerLimits: { rpm: 10 },
      } as never,
      { runtime: "gce-vm", vm: { instanceName: "octogee-computer-prod-uid", zone: "us-central1-a", status: "TERMINATED" } },
    );

    expect(control).toMatchObject({
      desiredStatus: "running",
      desiredRelease: 3,
      liveRelease: 2,
      runtime: "gce-vm",
      gatewayClass: "builder",
      imageProfile: "builder",
      sizingTier: "m",
      ownerUid: "uid-1",
      builderSlug: "alice",
      modelBrokerLimits: { rpm: 10 },
      builderAccess: null,
      gcpProject: null,
      serviceAccountName: null,
      vm: { instanceName: "octogee-computer-prod-uid", status: "TERMINATED" },
    });
  });

  it("projects a cluster gateway with no VM", () => {
    const control = projectGatewayControl(root as never, undefined);
    expect(control).toMatchObject({ runtime: "cluster", gatewayClass: "shared", vm: null, liveRelease: 2 });
  });
});

describe("projectGatewayReservation", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("defaults Shared gateways to on-demand and disposable gateways to Spot before a pod schedules", () => {
    expect(projectGatewayReservation({ gatewayClass: "shared" })).toEqual({
      type: "on-demand",
      priceMultiplier: 1,
      source: "class-default",
    });
    expect(projectGatewayReservation({ gatewayClass: "builder" })).toEqual({
      type: "spot",
      priceMultiplier: SPOT_PRICE_MULTIPLIER,
      source: "class-default",
    });
  });

  it("uses observed pod-node capacity instead of the class default", () => {
    expect(projectGatewayReservation({ gatewayClass: "shared" }, "spot")).toEqual({
      type: "spot",
      priceMultiplier: SPOT_PRICE_MULTIPLIER,
      source: "kubernetes",
    });
    expect(projectGatewayReservation({ gatewayClass: "builder" }, "on-demand")).toEqual({
      type: "on-demand",
      priceMultiplier: 1,
      source: "kubernetes",
    });
  });
});

describe("resolveFleetDeploymentSettings", () => {
  it("uses the active deployment target for the fleet namespace", () => {
    expect(resolveFleetDeploymentSettings("octogee-test")).toMatchObject({
      targetId: "test-central",
      artifactRegistryRepository: "us-central1-docker.pkg.dev/octogee/octogee",
    });
  });

  it("accepts an explicit target matching the runtime namespace", () => {
    expect(resolveFleetDeploymentSettings("octogee", "prod-central")).toMatchObject({
      targetId: "prod-central",
      artifactRegistryRepository: "us-central1-docker.pkg.dev/octogee/octogee",
    });
  });

  it("rejects an explicit target from another runtime namespace", () => {
    expect(() => resolveFleetDeploymentSettings("octogee-test", "prod-central")).toThrow(
      "Deployment target prod-central belongs to namespace octogee, not octogee-test",
    );
  });

  it("fails closed for a namespace outside the deployment contract", () => {
    expect(() => resolveFleetDeploymentSettings("feat-alice")).toThrow(
      "Unknown deployment environment for fleet namespace: feat-alice",
    );
  });
});

describe("shapeOperationsHistoryRecord", () => {
  it("preserves an audit union member without projecting it as a command", () => {
    expect(shapeOperationsHistoryRecord("audit-1", {
      recordType: "audit",
      schemaVersion: 1,
      status: "completed",
      lifecycleStage: "action-completed",
      idempotencyKey: "key",
      mutationFingerprint: "fingerprint",
      mutation: { action: "move-alias" },
      actor: "fleet-cli:chris",
      forced: true,
      what: "move release alias",
      why: "candidate verified in TEST",
      target: { gatewayId: "bender" },
      preActionStatus: { alias: "stable", target: "sha-old" },
      aliasPlan: [],
      createdAt: 1,
      actionClaimId: "runner-1",
      actionStartedAt: 1.5,
      actionRecoveryCount: 0,
      completedAt: 2,
      outcome: "completed",
    })).toEqual({
      id: "audit-1",
      recordType: "audit",
      schemaVersion: 1,
      status: "completed",
      lifecycleStage: "action-completed",
      idempotencyKey: "key",
      mutationFingerprint: "fingerprint",
      mutation: { action: "move-alias" },
      actor: "fleet-cli:chris",
      forced: true,
      what: "move release alias",
      why: "candidate verified in TEST",
      target: { gatewayId: "bender" },
      preActionStatus: { alias: "stable", target: "sha-old" },
      aliasPlan: [],
      createdAt: 1,
      actionClaimId: "runner-1",
      actionStartedAt: 1.5,
      actionRecoveryCount: 0,
      completedAt: 2,
      outcome: "completed",
    });
  });

  it("projects malformed and future audit rows as safe invalid history records", () => {
    expect(shapeOperationsHistoryRecord("audit-future", {
      recordType: "audit",
      schemaVersion: 2,
      status: "recorded",
      lifecycleStage: "intent-recorded",
      createdAt: 5,
    })).toEqual({
      id: "audit-future",
      recordType: "audit",
      invalid: true,
      schemaVersion: 2,
      status: "invalid",
      lifecycleStage: "invalid",
      createdAt: 5,
      completedAt: null,
      error: "Unsupported or malformed operation audit record",
    });
  });
});

// Step 1 of the Fleet regroup (GATEWAY-RELEASES-SPEC): every row projects its
// durable "gateway" identity so the client can group blue/green siblings under
// one card without an id/route migration.
describe("projectGatewaySummary — pod replacement projection", () => {
  const HOUR = 60 * 60 * 1000;
  const NOW = 1_770_000_000_000;

  function summaryWith(podReplacements: unknown) {
    return projectGatewaySummary(
      { id: "ceckert-test-xs", data: () => ({ gatewayId: "ceckert-test-xs" }) },
      { gatewayId: "ceckert-test-xs", podReplacements },
      NOW,
    );
  }

  it("derives the rolling counts against the request clock", () => {
    const summary = summaryWith({
      recentAt: [NOW - 30 * HOUR, NOW - 5 * HOUR, NOW - HOUR],
      lastAt: NOW - HOUR,
      lastVacatedPodUid: "uid-fresh",
      lastVacatedNodeName: "gk3-octogee-gateway-nap-1dx2tv8d-3ce41e28-q7zd",
      lastVacatedInstanceId: "7311234567890123456",
      lastVacatedNodePool: "nap-1dx2tv8d",
      total: 12,
    });
    expect(summary.podReplacements).toEqual({
      count24h: 2,
      count7d: 3,
      lastAgeMs: HOUR,
      lastVacatedNodeName: "gk3-octogee-gateway-nap-1dx2tv8d-3ce41e28-q7zd",
      lastVacatedInstanceId: "7311234567890123456",
      lastVacatedNodePool: "nap-1dx2tv8d",
      total: 12,
      warn: false,
    });
  });

  it("flags a gateway that crossed the 24h warning threshold", () => {
    const summary = summaryWith({
      recentAt: [NOW - 3 * HOUR, NOW - 2 * HOUR, NOW - HOUR],
      lastAt: NOW - HOUR,
      lastVacatedPodUid: "uid-c",
      lastVacatedNodeName: null,
      lastVacatedInstanceId: null,
      lastVacatedNodePool: null,
      total: 3,
    });
    expect(summary.podReplacements?.count24h).toBe(3);
    expect(summary.podReplacements?.warn).toBe(true);
  });

  it("projects null for a gateway Cowboy has not tracked yet", () => {
    expect(summaryWith(undefined).podReplacements).toBeNull();
  });

  it("projects null rather than trusting a malformed stored record", () => {
    expect(summaryWith({ recentAt: "lots", total: 3 }).podReplacements).toBeNull();
  });
});

describe("projectGatewaySummary — gateway identity projection", () => {
  it("uses the explicit glmGateways.gateway field when present", () => {
    const summary = projectGatewaySummary(
      { id: "default-blue", data: () => ({ gatewayId: "default-blue" }) },
      { gatewayId: "default-blue", gateway: "default" },
      Date.now(),
    );
    expect(summary.gateway).toBe("default");
  });

  it("falls back to convention-parse (strip trailing -blue/-green) when the field is absent", () => {
    const summary = projectGatewaySummary(
      { id: "bender-green", data: () => ({ gatewayId: "bender-green" }) },
      { gatewayId: "bender-green" },
      Date.now(),
    );
    expect(summary.gateway).toBe("bender");
  });

  it("treats an unsuffixed id as its own bare gateway identity", () => {
    const summary = projectGatewaySummary(
      { id: "jack", data: () => ({ gatewayId: "jack" }) },
      { gatewayId: "jack" },
      Date.now(),
    );
    expect(summary.gateway).toBe("jack");
  });

  it("marks an allocated builder gateway as one disposable Builder generation", () => {
    const summary = projectGatewaySummary(
      { id: "run-alice-12345678", data: () => ({ gatewayId: "run-alice-12345678" }) },
      {
        gatewayId: "run-alice-12345678",
        gatewayClass: "builder",
        ownerUid: "uid-alice",
        allocation: {
          kind: "disposable-builder",
          schemaVersion: 1,
          leaseId: "lease-1",
          generation: 3,
          claimedByUid: "uid-alice",
        },
      },
      Date.now(),
    );

    expect(summary.disposableRuntime).toEqual({
      ownerUid: "uid-alice",
      leaseId: "lease-1",
      generation: 3,
    });
  });
});

describe("projectGatewaySummary — openclaw version projection", () => {
  function summaryFor(heartbeat: Record<string, unknown>, glmDoc: Record<string, unknown> = {}) {
    return projectGatewaySummary(
      { id: "default", data: () => ({ gatewayId: "default", ...heartbeat }) },
      { gatewayId: "default", ...glmDoc },
      Date.now(),
    );
  }

  it.each([
    ["OpenClaw 2026.7.1 (2ddb9a9)", "2026.7.1"],
    ["OpenClaw 2026.7.2-beta.7", "2026.7.2-beta.7"],
    ["2026.7.1 (2ddb9a9)", "2026.7.1"],
    ["  OpenClaw 2026.7.1  ", "2026.7.1"],
  ])("projects the raw `openclaw --version` string %j as the bare version", (reported, expected) => {
    expect(summaryFor({ openclawVersion: reported }).openclawVersion).toBe(expected);
  });

  it.each(["unknown", "OpenClaw unknown", "", "   "])(
    "falls back to the image tag when the pod reports %j",
    (reported) => {
      const summary = summaryFor(
        { openclawVersion: reported },
        { imageTag: "0bf497e-oc2026.7.2-beta.7" },
      );
      expect(summary.openclawVersion).toBe("2026.7.2-beta.7");
    },
  );
});

describe("projectBuilderRuntime — disposable lifecycle visibility", () => {
  const now = 1_722_000_900_000;

  function user(activationLease: Record<string, unknown>) {
    return {
      id: "uid-alice",
      data: () => ({
        username: "alice",
        provisioning: {
          openclaw: {
            gatewayId: "shared-blue",
            slug: "alice",
            activationLease,
          },
        },
      }),
    };
  }

  it("projects requestedAt as the wake duration origin", () => {
    expect(projectBuilderRuntime(
      user({
        leaseId: "lease-1",
        generation: 1,
        status: "requested",
        cause: "run-start",
        requestedAt: now - 90_000,
        sourceGatewayId: "shared-blue",
        sizingTier: "xs",
      }),
      new Map(),
      new Map(),
      now,
    )).toMatchObject({
      uid: "uid-alice",
      builderSlug: "alice",
      lifecycle: "requested",
      wakeDurationMs: 90_000,
      currentGatewayId: "shared-blue",
      sourceGatewayId: "shared-blue",
      targetGatewayId: null,
      sizingTier: "xs",
    });
  });

  it("keeps stale provisioning visible with the exact disposable target", () => {
    expect(projectBuilderRuntime(
      user({
        leaseId: "lease-1",
        generation: 1,
        status: "provisioning",
        cause: "scheduled",
        requestedAt: now - 20 * 60_000,
        provisionedAt: now - 60_000,
        sourceGatewayId: "shared-blue",
        targetGatewayId: "run-alice-12345678",
        sizingTier: "s",
      }),
      new Map(),
      new Map(),
      now,
    )).toMatchObject({
      lifecycle: "provisioning",
      stale: true,
      targetGatewayId: "run-alice-12345678",
      wakeDurationMs: 20 * 60_000,
    });
  });

  it("freezes wake duration at cutover and never marks an active runtime stale", () => {
    expect(projectBuilderRuntime(
      user({
        leaseId: "lease-1",
        generation: 1,
        status: "active",
        cause: "chat",
        requestedAt: now - 20 * 60_000,
        activeAt: now - 19 * 60_000,
        sourceGatewayId: "shared-blue",
        targetGatewayId: "run-alice-12345678",
        sizingTier: "xs",
      }),
      new Map(),
      new Map(),
      now,
    )).toMatchObject({
      lifecycle: "active",
      wakeDurationMs: 60_000,
      stale: false,
    });
  });

  it.each([
    ["running", "retiring", null],
    ["failed", "failed", "helm uninstall timed out"],
  ] as const)(
    "projects a %s teardown receipt as %s",
    (operationStatus, lifecycle, error) => {
      const targetGatewayId = "run-alice-12345678";
      const operationId = `placement-retire-uid-alice-${targetGatewayId}`;
      const projected = projectBuilderRuntime(
        user({
          leaseId: "lease-1",
          generation: 1,
          status: "returning",
          requestedAt: now - 300_000,
          returningAt: now - 30_000,
          sourceGatewayId: "shared-blue",
          targetGatewayId,
          sizingTier: "xs",
        }),
        new Map([[targetGatewayId, {
          gatewayId: targetGatewayId,
          desiredStatus: "retired",
        }]]),
        new Map([[operationId, {
          status: operationStatus,
          ...(error ? { error } : {}),
        }]]),
        now,
      );

      expect(projected).toMatchObject({
        lifecycle,
        phase: "retirement",
        operationId,
        error,
      });
    },
  );

  it("keeps a failed activation visible after its target cleanup is retired", () => {
    const targetGatewayId = "run-alice-12345678";
    const activationOperationId = `builder-activate-${targetGatewayId}`;
    const cleanupOperationId = `placement-retire-uid-alice-${targetGatewayId}`;
    const projected = projectBuilderRuntime(
      user({
        leaseId: "lease-1",
        generation: 1,
        status: "failed",
        requestedAt: now - 300_000,
        failedAt: now - 10_000,
        sourceGatewayId: "shared-blue",
        targetGatewayId,
        sizingTier: "xs",
        activationOperationId,
        lastError: {
          message: "restore target failed",
          operationId: activationOperationId,
        },
      }),
      new Map([[targetGatewayId, {
        gatewayId: targetGatewayId,
        desiredStatus: "retired",
        retirementClaim: { operationId: cleanupOperationId },
      }]]),
      new Map([
        [activationOperationId, {
          status: "failed",
          error: "restore target failed",
          steps: [
            { name: "restore-target", status: "failed" },
            { name: "cutover", status: "pending" },
            { secret: "drop-me" },
          ],
        }],
        [cleanupOperationId, {
          status: "running",
          steps: [{ name: "helm-uninstall", status: "running" }],
        }],
      ]),
      now,
    );

    expect(projected).toMatchObject({
      lifecycle: "failed",
      phase: "activation",
      operationId: activationOperationId,
      operationStatus: "failed",
      operationSteps: [
        { name: "restore-target", status: "failed" },
        { name: "cutover", status: "pending" },
      ],
      cleanupOperationId,
      cleanupOperationStatus: "running",
      cleanupOperationSteps: [
        { name: "helm-uninstall", status: "running" },
      ],
      cleanupError: null,
      error: "restore target failed",
    });
  });

  it("omits a failed activation once its cleanup succeeded or its runtime record is gone", () => {
    const targetGatewayId = "alice-xs-12345678";
    const cleanupOperationId = `placement-retire-uid-alice-${targetGatewayId}`;
    const failedLease = {
      leaseId: "lease-1",
      generation: 1,
      status: "failed",
      requestedAt: now - 300_000,
      failedAt: now - 10_000,
      sourceGatewayId: "shared-blue",
      targetGatewayId,
    };

    expect(projectBuilderRuntime(
      user(failedLease),
      new Map([[targetGatewayId, {
        gatewayId: targetGatewayId,
        desiredStatus: "retired",
        retirementClaim: { operationId: cleanupOperationId },
      }]]),
      new Map([[cleanupOperationId, { status: "succeeded" }]]),
      now,
    )).toBeNull();

    expect(projectBuilderRuntime(user(failedLease), new Map(), new Map(), now)).toBeNull();
  });

  it("omits parked leases after teardown receipts have completed", () => {
    expect(projectBuilderRuntime(
      user({
        leaseId: "lease-1",
        generation: 1,
        status: "parked",
        requestedAt: now - 300_000,
      }),
      new Map(),
      new Map(),
      now,
    )).toBeNull();
  });

  it("keeps a parked lease visible until its disposable teardown completes", () => {
    const targetGatewayId = "run-alice-12345678";
    const operationId = `placement-retire-uid-alice-${targetGatewayId}`;
    expect(projectBuilderRuntime(
      user({
        leaseId: "lease-1",
        generation: 1,
        status: "parked",
        requestedAt: now - 300_000,
        activeAt: now - 240_000,
        sourceGatewayId: "shared-blue",
        targetGatewayId,
      }),
      new Map([[targetGatewayId, {
        gatewayId: targetGatewayId,
        desiredStatus: "retired",
        retirementClaim: { operationId },
      }]]),
      new Map([[operationId, { status: "running" }]]),
      now,
    )).toMatchObject({
      lifecycle: "retiring",
      phase: "retirement",
      operationId,
      operationStatus: "running",
    });
  });

  it("omits a parked lease after its disposable teardown succeeds", () => {
    const targetGatewayId = "run-alice-12345678";
    const operationId = `placement-retire-uid-alice-${targetGatewayId}`;
    expect(projectBuilderRuntime(
      user({
        leaseId: "lease-1",
        generation: 1,
        status: "parked",
        requestedAt: now - 300_000,
        sourceGatewayId: "shared-blue",
        targetGatewayId,
      }),
      new Map([[targetGatewayId, {
        gatewayId: targetGatewayId,
        desiredStatus: "retired",
        retirementClaim: { operationId },
      }]]),
      new Map([[operationId, { status: "succeeded" }]]),
      now,
    )).toBeNull();
  });
});

describe("projectDisposableFleetCapacity", () => {
  it("counts only allocated disposable pods without inventing node disk allocation", () => {
    const gateways = [
      projectGatewaySummary(
        { id: "shared-blue", data: () => ({ gatewayId: "shared-blue" }) },
        { gatewayId: "shared-blue", gatewayClass: "shared" },
        Date.now(),
      ),
      projectGatewaySummary(
        { id: "run-alice", data: () => ({ gatewayId: "run-alice" }) },
        {
          gatewayId: "run-alice",
          gatewayClass: "builder",
          sizingTier: "xs",
          ownerUid: "uid-alice",
          allocation: {
            kind: "disposable-builder",
            schemaVersion: 1,
            leaseId: "lease-1",
            generation: 1,
            claimedByUid: "uid-alice",
          },
        },
        Date.now(),
      ),
    ];

    expect(projectDisposableFleetCapacity(gateways)).toEqual({
      disposableInstances: 1,
      stagedInstances: 0,
      byTier: { xs: 1 },
      parkedBuilders: 0,
      byLifecycle: {
        requested: 0,
        provisioning: 0,
        activating: 0,
        active: 0,
        returning: 0,
        retiring: 0,
        failed: 0,
        parked: 0,
      },
      failedBuilders: 0,
      staleActivations: 0,
      oldestActivationAgeMs: null,
    });
  });
});

function valueAtPath(data: Record<string, unknown>, path: string): unknown {
  let cursor: unknown = data;
  for (const part of path.split(".")) {
    if (!cursor || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

function docsFrom(records: Record<string, Record<string, unknown>>) {
  return Object.entries(records).map(([id, data]) => ({ id, data: () => data }));
}

function applyDottedPatch(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
): void {
  for (const [path, value] of Object.entries(patch)) {
    const parts = path.split(".");
    let cursor = target;
    for (const part of parts.slice(0, -1)) {
      const current = cursor[part];
      if (!current || typeof current !== "object" || Array.isArray(current)) {
        cursor[part] = {};
      }
      cursor = cursor[part] as Record<string, unknown>;
    }
    const leaf = parts.at(-1)!;
    if ((value as { constructor?: { name?: string } })?.constructor?.name === "DeleteTransform") {
      delete cursor[leaf];
    } else {
      cursor[leaf] = value;
    }
  }
}

function mkCollection(
  records: Record<string, Record<string, unknown>>,
  createId?: () => string,
) {
  const query = (filters: Array<{ field: string; op: string; value: unknown }> = []) => ({
    where: vi.fn((field: string, op: string, value: unknown) =>
      query([...filters, { field, op, value }]),
    ),
    orderBy: vi.fn(() => query(filters)),
    limit: vi.fn(() => query(filters)),
    get: vi.fn(async () => ({
      docs: docsFrom(records).filter((doc) =>
        filters.every((filter) => {
          const actual = valueAtPath(doc.data(), filter.field);
          return filter.op === "in" && Array.isArray(filter.value)
            ? filter.value.includes(actual)
            : actual === filter.value;
        }),
      ),
      size: docsFrom(records).filter((doc) =>
        filters.every((filter) => {
          const actual = valueAtPath(doc.data(), filter.field);
          return filter.op === "in" && Array.isArray(filter.value)
            ? filter.value.includes(actual)
            : actual === filter.value;
        }),
      ).length,
    })),
    add: vi.fn(async (data: Record<string, unknown>) => {
      if (!createId) throw new Error("collection is read-only in this test harness");
      const id = createId();
      records[id] = data;
      return { id };
    }),
    doc: vi.fn((id: string) => ({
      get: vi.fn(async () => ({
        id,
        exists: records[id] !== undefined,
        data: () => records[id],
      })),
      delete: vi.fn(async () => {
        delete records[id];
      }),
      update: vi.fn(async (patch: Record<string, unknown>) => {
        if (!records[id]) throw new Error(`missing record ${id}`);
        applyDottedPatch(records[id], patch);
      }),
      set: vi.fn(async (data: Record<string, unknown>) => {
        records[id] = data;
      }),
    })),
  });
  return query();
}

function mkAdminFleetRouteApp(opts: {
  config: Record<string, unknown>;
  users: Record<string, Record<string, unknown>>;
  glmGateways?: Record<string, Record<string, unknown>>;
  gateways?: Record<string, Record<string, unknown>>;
  operations?: Record<string, Record<string, unknown>>;
  podDiagnostics?: Record<string, GatewayPodDiagnostics>;
  // gateways/{gatewayId}/assignments/{uid} durable roster docs (PR7).
  assignments?: Record<string, Record<string, Record<string, unknown>>>;
}) {
  const sharedGatewayIds = typeof opts.config.defaultGatewayId === "string" &&
    opts.config.sharedGatewayIds === undefined
    ? [opts.config.defaultGatewayId]
    : opts.config.sharedGatewayIds;
  const state = {
    config: {
      ...opts.config,
      ...(sharedGatewayIds === undefined ? {} : { sharedGatewayIds }),
    },
    users: { ...opts.users },
    operations: { ...(opts.operations ?? {}) },
  };
  // The pool derives from the shared-class root query. A test that names pool
  // members in `config` without seeding their roots gets them synthesized into
  // that query only, so the rest of the fleet projection sees the seeded roots.
  const poolRoots: Record<string, Record<string, unknown>> = { ...(opts.gateways ?? {}) };
  for (const gatewayId of (sharedGatewayIds as string[] | undefined) ?? []) {
    poolRoots[gatewayId] ??= durableGatewayRoot(gatewayId, { liveRelease: 1 });
  }
  const gatewaysCollection = mkCollection(opts.gateways ?? {});
  const poolQueryCollection = mkCollection(poolRoots);
  let operationId = 0;
  const assignmentDocs = Object.values(opts.assignments ?? {}).flatMap((byUid) =>
    Object.entries(byUid).map(([uid, data]) => ({ id: uid, data: () => data })),
  );
  const db = {
    doc: vi.fn((path: string) => {
      const assignment = /^gateways\/([^/]+)\/assignments\/([^/]+)$/.exec(path);
      if (assignment) {
        const [, gatewayId, uid] = assignment;
        const data = opts.assignments?.[gatewayId]?.[uid];
        return {
          get: vi.fn(async () => ({
            exists: data !== undefined,
            data: () => data,
          })),
        };
      }
      expect(path).toBe("config/orchestrator");
      return {
        get: vi.fn(async () => ({
          exists: true,
          data: () => state.config,
        })),
        set: vi.fn(async (update: Record<string, unknown>) => {
          state.config = { ...state.config, ...update };
        }),
      };
    }),
    collection: vi.fn((name: string) => {
      if (name === "users") return mkCollection(state.users);
      if (name === GLM_GATEWAYS_COLLECTION) return mkCollection(opts.glmGateways ?? {});
      if (name === "gateways") {
        return { ...gatewaysCollection, where: poolQueryCollection.where };
      }
      if (name === GLM_OPERATIONS_COLLECTION) {
        return mkCollection(state.operations, () => `operation-${++operationId}`);
      }
      return mkCollection({});
    }),
    runTransaction: vi.fn(async (body: (transaction: {
      get: (ref: { get: () => Promise<unknown> }) => Promise<unknown>;
      create: (ref: { set: (data: Record<string, unknown>) => Promise<void> }, data: Record<string, unknown>) => void;
      delete: (ref: { delete: () => Promise<void> }) => void;
      update: (
        ref: { update: (patch: Record<string, unknown>) => Promise<void> },
        patch: Record<string, unknown>,
      ) => void;
    }) => Promise<unknown>) => {
      const pendingDeletes: Array<() => Promise<void>> = [];
      const pendingUpdates: Array<() => Promise<void>> = [];
      const pendingCreates: Array<() => Promise<void>> = [];
      const result = await body({
        get: (ref) => ref.get(),
        create: (ref, data) => {
          pendingCreates.push(() => ref.set(data));
        },
        delete: (ref) => {
          pendingDeletes.push(() => ref.delete());
        },
        update: (ref, patch) => {
          pendingUpdates.push(() => ref.update(patch));
        },
      });
      for (const create of pendingCreates) await create();
      for (const update of pendingUpdates) await update();
      for (const remove of pendingDeletes) await remove();
      return result;
    }),
    collectionGroup: vi.fn((name: string) => ({
      get: vi.fn(async () => ({
        docs: name === "assignments" ? assignmentDocs : [],
        size: name === "assignments" ? assignmentDocs.length : 0,
      })),
    })),
  } as unknown as Firestore;

  const app = express();
  app.use(express.json());
  addAdminFleetRoutes(app, {
    db,
    logger: { info: vi.fn(), warn: vi.fn() },
    workspaceSlugsForUser: (data) => data.username ? [data.username] : [],
    provisionGatewayAuthSecret: vi.fn(async () => ({})),
    listGatewayBuilds: vi.fn(async () => []),
    ...(opts.podDiagnostics
      ? {
          readGatewayPodDiagnostics: vi.fn(async (gatewayId: string) =>
            opts.podDiagnostics?.[gatewayId] ?? {
              status: "unknown",
              totalPods: 0,
              readyPods: 0,
              totalRestarts: 0,
              pods: [],
              error: "diagnostics unavailable",
            }),
        }
      : {}),
    suspendAuthUser: vi.fn(async () => undefined),
    revokeConnectorGrantsForUser: vi.fn(async () => undefined),
  });
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: error.message });
  });
  return { app, state };
}

describe("retired operator reservation routes", () => {
  it.each([
    ["get", "/operator-gateway-reservations"],
    ["delete", "/operator-gateway-reservations/uid-orphan"],
    ["post", "/operator-gateway-reservations/uid-orphan/activate"],
    ["post", "/operator-gateway-reservations/uid-orphan/fulfill"],
    ["patch", "/fleet-settings"],
  ] as const)("returns 404 for %s %s", async (method, path) => {
    const { app } = mkAdminFleetRouteApp({ config: {}, users: {} });
    await request(app)[method](path).send({}).expect(404);
  });
});

function durableGatewayRoot(
  gatewayId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    gatewayId,
    createdAt: 1,
    createdBy: "test",
    updatedAt: 1,
    updatedBy: "test",
    latestRelease: 1,
    desiredRelease: 1,
    liveRelease: null,
    liveRevisionId: null,
    trafficRevisionId: null,
    desiredStatus: "running",
    roll: null,
    configSchemaVersion: 1,
    profile: null,
    gatewayClass: "shared",
    imageProfile: "standard",
    sizingTier: null,
    gcpProject: null,
    gatewayContainerSecurityContext: null,
    serviceAccountName: null,
    serviceAccount: null,
    builderAccess: null,
    ownerUid: null,
    builderSlug: null,
    modelBrokerLimits: null,
    preemption: null,
    ...overrides,
  };
}

describe("fleet gateway projection", () => {
  it("keeps disposable retirement intent and Builder lifecycle in the Fleet response", async () => {
    const targetGatewayId = "run-alice-12345678";
    const retirementOperationId = `placement-retire-uid-alice-${targetGatewayId}`;
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "shared-blue" },
      users: {
        "uid-alice": {
          username: "alice",
          provisioning: {
            openclaw: {
              slug: "alice",
              gatewayId: "shared-blue",
              activationLease: {
                leaseId: "lease-1",
                generation: 1,
                status: "parked",
                cause: "run-start",
                requestedAt: Date.now() - 120_000,
                activeAt: Date.now() - 90_000,
                sourceGatewayId: "shared-blue",
                targetGatewayId,
                sizingTier: "xs",
              },
            },
          },
        },
      },
      gateways: {
        "shared-blue": durableGatewayRoot("shared-blue"),
        [targetGatewayId]: durableGatewayRoot(targetGatewayId, {
          desiredStatus: "retired",
          profile: "builder",
          gatewayClass: "builder",
          imageProfile: "builder",
          sizingTier: "xs",
          ownerUid: "uid-alice",
          builderSlug: "alice",
          allocation: {
            kind: "disposable-builder",
            schemaVersion: 1,
            leaseId: "lease-1",
            generation: 1,
            claimedByUid: "uid-alice",
          },
        }),
      },
      operations: {
        [retirementOperationId]: {
          kind: "retire-gateway",
          status: "running",
          input: { gatewayId: targetGatewayId },
        },
      },
    });

    const fleet = await request(app).get("/gateways").expect(200);

    expect(fleet.body.builderRuntimes).toEqual([
      expect.objectContaining({
        uid: "uid-alice",
        builderSlug: "alice",
        lifecycle: "retiring",
        phase: "retirement",
        targetGatewayId,
        operationId: retirementOperationId,
        operationStatus: "running",
      }),
    ]);
    expect(fleet.body.gateways).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          gatewayId: targetGatewayId,
          desiredStatus: "retired",
          disposableRuntime: {
            ownerUid: "uid-alice",
            leaseId: "lease-1",
            generation: 1,
          },
        }),
      ]),
    );
    expect(fleet.body.disposableCapacity).toEqual({
      disposableInstances: 1,
      stagedInstances: 0,
      byTier: { xs: 1 },
      parkedBuilders: 1,
      byLifecycle: {
        requested: 0,
        provisioning: 0,
        activating: 0,
        active: 0,
        returning: 0,
        retiring: 1,
        failed: 0,
        parked: 1,
      },
      failedBuilders: 0,
      staleActivations: 0,
      oldestActivationAgeMs: null,
    });
  });

  it("keeps a failed activation target in Fleet until its cleanup operation succeeds", async () => {
    const targetGatewayId = "run-alice-failed";
    const activationOperationId = "builder-activate-run-alice-failed";
    const cleanupOperationId = "placement-retire-uid-alice-run-alice-failed";
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "shared-blue" },
      users: {
        "uid-alice": {
          username: "alice",
          provisioning: {
            openclaw: {
              slug: "alice",
              gatewayId: "shared-blue",
              activationLease: {
                leaseId: "lease-1",
                generation: 1,
                status: "failed",
                requestedAt: Date.now() - 120_000,
                failedAt: Date.now() - 30_000,
                sourceGatewayId: "shared-blue",
                targetGatewayId,
                sizingTier: "xs",
                activationOperationId,
                lastError: { message: "restore failed" },
              },
            },
          },
        },
      },
      gateways: {
        "shared-blue": durableGatewayRoot("shared-blue"),
        [targetGatewayId]: durableGatewayRoot(targetGatewayId, {
          desiredStatus: "retired",
          profile: "builder",
          gatewayClass: "builder",
          imageProfile: "builder",
          sizingTier: "xs",
          ownerUid: "uid-alice",
          builderSlug: "alice",
          allocation: {
            kind: "disposable-builder",
            schemaVersion: 1,
            leaseId: "lease-1",
            generation: 1,
            claimedByUid: "uid-alice",
          },
          retirementClaim: { operationId: cleanupOperationId },
        }),
      },
      operations: {
        [activationOperationId]: {
          kind: "migrate-customer",
          status: "failed",
          error: "restore failed",
        },
        [cleanupOperationId]: {
          kind: "retire-gateway",
          status: "running",
          input: { gatewayId: targetGatewayId },
        },
      },
    });

    const fleet = await request(app).get("/gateways").expect(200);

    expect(fleet.body.builderRuntimes).toEqual([
      expect.objectContaining({
        lifecycle: "failed",
        phase: "activation",
        operationId: activationOperationId,
        cleanupOperationId,
        cleanupOperationStatus: "running",
      }),
    ]);
    expect(fleet.body.gateways).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          gatewayId: targetGatewayId,
          desiredStatus: "retired",
        }),
      ]),
    );
    expect(fleet.body.disposableCapacity.disposableInstances).toBe(1);
  });

  it("offers retry only after the retired target has an explicit zero-pod proof", async () => {
    const targetGatewayId = "run-alice-clean";
    const activationOperationId = "builder-activate-run-alice-clean";
    const cleanupOperationId = "placement-retire-uid-alice-run-alice-clean";
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "shared-blue" },
      users: {
        "uid-alice": {
          username: "alice",
          provisioning: {
            openclaw: {
              slug: "alice",
              gatewayId: "shared-blue",
              activationLease: {
                leaseId: "lease-1",
                generation: 1,
                status: "failed",
                requestedAt: Date.now() - 120_000,
                failedAt: Date.now() - 30_000,
                sourceGatewayId: "shared-blue",
                targetGatewayId,
                sizingTier: "xs",
                activationOperationId,
              },
            },
          },
        },
      },
      gateways: {
        "shared-blue": durableGatewayRoot("shared-blue"),
        [targetGatewayId]: durableGatewayRoot(targetGatewayId, {
          desiredStatus: "retired",
          profile: "builder",
          gatewayClass: "builder",
          imageProfile: "builder",
          sizingTier: "xs",
          ownerUid: "uid-alice",
          builderSlug: "alice",
          allocation: {
            kind: "disposable-builder",
            schemaVersion: 1,
            leaseId: "lease-1",
            generation: 1,
            claimedByUid: "uid-alice",
          },
          retirementClaim: { operationId: cleanupOperationId },
        }),
      },
      operations: {
        [activationOperationId]: {
          kind: "migrate-customer",
          status: "failed",
        },
        [cleanupOperationId]: {
          kind: "retire-gateway",
          status: "succeeded",
          input: { gatewayId: targetGatewayId },
        },
      },
      podDiagnostics: {
        "shared-blue": {
          status: "ready",
          totalPods: 1,
          readyPods: 1,
          totalRestarts: 0,
          pods: [],
        },
        [targetGatewayId]: {
          status: "missing",
          totalPods: 0,
          readyPods: 0,
          totalRestarts: 0,
          pods: [],
        },
      },
    });

    const fleet = await request(app).get("/gateways").expect(200);

    expect(fleet.body.builderRuntimes).toEqual([]);
    expect(fleet.body.gateways).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ gatewayId: targetGatewayId }),
      ]),
    );
  });

  it("keeps a failed runtime on Fleet only while its cleanup is unfinished", async () => {
    const targetGatewayId = "run-alice-cleaning";
    const cleanupOperationId = "placement-retire-uid-alice-run-alice-cleaning";
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "shared-blue" },
      users: {
        "uid-alice": {
          username: "alice",
          provisioning: {
            openclaw: {
              gatewayId: "shared-blue",
              activationLease: {
                leaseId: "lease-1",
                generation: 1,
                status: "failed",
                requestedAt: Date.now() - 120_000,
                failedAt: Date.now() - 30_000,
                sourceGatewayId: "shared-blue",
                targetGatewayId,
                sizingTier: "xs",
              },
            },
          },
        },
      },
      gateways: {
        "shared-blue": durableGatewayRoot("shared-blue"),
        [targetGatewayId]: durableGatewayRoot(targetGatewayId, {
          desiredStatus: "retired",
          profile: "builder",
          gatewayClass: "builder",
          imageProfile: "builder",
          sizingTier: "xs",
          ownerUid: "uid-alice",
          builderSlug: "alice",
          allocation: {
            kind: "disposable-builder",
            schemaVersion: 1,
            leaseId: "lease-1",
            generation: 1,
            claimedByUid: "uid-alice",
          },
          retirementClaim: { operationId: cleanupOperationId },
        }),
      },
      operations: {
        [cleanupOperationId]: {
          kind: "retire-gateway",
          status: "running",
          input: { gatewayId: targetGatewayId },
        },
      },
      podDiagnostics: {
        [targetGatewayId]: {
          status: "missing",
          totalPods: 0,
          readyPods: 0,
          totalRestarts: 0,
          pods: [],
        },
      },
    });

    const fleet = await request(app).get("/gateways").expect(200);

    expect(fleet.body.builderRuntimes).toEqual([
      expect.objectContaining({
        lifecycle: "failed",
        cleanupOperationStatus: "running",
      }),
    ]);
    expect(fleet.body.builderRuntimes[0]).not.toHaveProperty("retryAvailable");
  });

  it("keeps an old disposable visible after a new lease replaces the user target", async () => {
    const oldGatewayId = "run-alice-old";
    const cleanupOperationId = "placement-retire-uid-alice-run-alice-old";
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "shared-blue" },
      users: {
        "uid-alice": {
          username: "alice",
          provisioning: {
            openclaw: {
              gatewayId: "shared-blue",
              activationLease: {
                leaseId: "lease-new",
                generation: 2,
                status: "requested",
                requestedAt: Date.now(),
                sourceGatewayId: "shared-blue",
              },
            },
          },
        },
      },
      gateways: {
        [oldGatewayId]: durableGatewayRoot(oldGatewayId, {
          desiredStatus: "retired",
          profile: "builder",
          gatewayClass: "builder",
          imageProfile: "builder",
          sizingTier: "xs",
          ownerUid: "uid-alice",
          builderSlug: "alice",
          allocation: {
            kind: "disposable-builder",
            schemaVersion: 1,
            leaseId: "lease-old",
            generation: 1,
            claimedByUid: "uid-alice",
          },
          retirementClaim: { operationId: cleanupOperationId },
        }),
      },
      operations: {
        [cleanupOperationId]: {
          kind: "retire-gateway",
          status: "running",
          input: { gatewayId: oldGatewayId },
        },
      },
    });

    const fleet = await request(app).get("/gateways").expect(200);

    expect(fleet.body.gateways).toEqual([
      expect.objectContaining({ gatewayId: oldGatewayId, desiredStatus: "retired" }),
    ]);
    expect(fleet.body.disposableCapacity.disposableInstances).toBe(1);
  });

  it("summarizes parked Builders, lifecycle failures, staleness, and oldest activation", async () => {
    const now = Date.now();
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "shared-blue", sharedGatewayIds: ["shared-blue", "shared-green"] },
      users: {
        parked: {
          provisioning: {
            openclaw: {
              gatewayId: "shared-green",
              activationLease: {
                leaseId: "lease-parked",
                generation: 1,
                status: "parked",
              },
            },
          },
        },
        requested: {
          provisioning: {
            openclaw: {
              gatewayId: "shared-blue",
              activationLease: {
                leaseId: "lease-requested",
                generation: 1,
                status: "requested",
                requestedAt: now - 20 * 60_000,
              },
            },
          },
        },
        failed: {
          provisioning: {
            openclaw: {
              gatewayId: "shared-blue",
              activationLease: {
                leaseId: "lease-failed",
                generation: 1,
                status: "failed",
                requestedAt: now - 60_000,
                failedAt: now - 30_000,
                targetGatewayId: "fail-xs-deadbeef",
              },
            },
          },
        },
      },
      gateways: {
        "fail-xs-deadbeef": durableGatewayRoot("fail-xs-deadbeef", {
          desiredStatus: "retired",
          profile: "builder",
          gatewayClass: "builder",
          imageProfile: "builder",
          sizingTier: "xs",
          ownerUid: "failed",
          builderSlug: "failed",
          allocation: {
            kind: "disposable-builder",
            schemaVersion: 1,
            leaseId: "lease-failed",
            generation: 1,
            claimedByUid: "failed",
          },
          retirementClaim: { operationId: "placement-retire-failed-fail-xs-deadbeef" },
        }),
      },
      operations: {
        "placement-retire-failed-fail-xs-deadbeef": {
          kind: "retire-gateway",
          status: "running",
          input: { gatewayId: "fail-xs-deadbeef" },
        },
      },
    });

    const fleet = await request(app).get("/gateways").expect(200);

    expect(fleet.body.disposableCapacity).toMatchObject({
      parkedBuilders: 1,
      byLifecycle: {
        requested: 1,
        failed: 1,
        parked: 1,
      },
      failedBuilders: 1,
      staleActivations: 1,
    });
    expect(fleet.body.disposableCapacity.oldestActivationAgeMs).toBeGreaterThanOrEqual(
      20 * 60_000,
    );
  });

  it("does not revive stale bare runtime state when an existing root is malformed", async () => {
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "default" },
      users: {
        "uid-alice": {
          username: "alice",
          email: "alice@example.com",
          provisioning: { openclaw: { slug: "alice", gatewayId: "default" } },
        },
      },
      gateways: {
        default: {
          gatewayId: "default",
          latestRelease: 1,
          desiredRelease: 1,
          desiredStatus: "running",
          status: "ready",
          mountedCustomers: ["alice"],
        },
      },
      glmGateways: {
        default: {
          gatewayId: "default",
          desiredStatus: "running",
          gatewayClass: "shared",
          heartbeat: { status: "ready", mountedCustomers: ["alice"] },
        },
      },
    });

    const fleet = await request(app).get("/gateways").expect(200);
    expect(fleet.body.gateways).toEqual([]);

    const onboarding = await request(app).get("/onboarding-placement").expect(200);
    expect(onboarding.body.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "default-gateway-missing" })]),
    );
    expect(onboarding.body.customers).toEqual([
      expect.objectContaining({
        uid: "uid-alice",
        mountedGatewayId: null,
        driftState: "missing-gateway",
      }),
    ]);
  });

  it("keeps the durable gateway ID while reading telemetry from its exact live revision", async () => {
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "default" },
      users: {
        "uid-alice": {
          username: "alice",
          email: "alice@example.com",
          provisioning: { openclaw: { slug: "alice", gatewayId: "default" } },
        },
      },
      gateways: {
        default: durableGatewayRoot("default", {
          liveRelease: 1,
        }),
      },
      glmGateways: {
        default: {
          docKind: "runtime",
          gatewayId: "default",
          release: 1,
          lifecycle: "serving",
          helm: {
            imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/gateway",
            imageTag: "1234567",
          },
          heartbeat: {
            status: "ready",
            mountedCustomers: ["alice"],
            version: "1234567",
            lastHeartbeatAt: 1_000,
            startedAt: 500,
          },
          lastError: { message: null, at: null },
        },
      },
    });

    const fleet = await request(app).get("/gateways").expect(200);
    expect(fleet.body.gateways).toEqual([
      expect.objectContaining({
        gatewayId: "default",
        status: "ready",
        mountedCustomers: ["alice"],
      }),
    ]);

    const onboarding = await request(app).get("/onboarding-placement").expect(200);
    expect(onboarding.body.warnings).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "default-gateway-missing" })]),
    );
    expect(onboarding.body.customers).toEqual([
      expect.objectContaining({
        uid: "uid-alice",
        assignedGatewayId: "default",
        mountedGatewayId: "default",
        driftState: "healthy",
      }),
    ]);

    const distribution = await request(app).get("/customer-distribution").expect(200);
    expect(distribution.body.perGateway).toEqual([
      expect.objectContaining({
        gatewayId: "default",
        status: "ready",
        assignedCount: 1,
        mountedCount: 1,
      }),
    ]);

    const details = await request(app).get("/gateways/default/details").expect(200);
    expect(details.body.mountedCustomers).toEqual([
      expect.objectContaining({ uid: "uid-alice", slug: "alice" }),
    ]);
  });

  it("excludes retired gateways from the customer distribution", async () => {
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "default" },
      users: {},
      gateways: {
        default: durableGatewayRoot("default", { liveRelease: 1 }),
        "alice-xs-deadbeef": durableGatewayRoot("alice-xs-deadbeef", {
          desiredStatus: "retired",
          profile: "builder",
          gatewayClass: "builder",
          imageProfile: "builder",
          sizingTier: "xs",
          ownerUid: "uid-alice",
          builderSlug: "alice",
          allocation: {
            kind: "disposable-builder",
            schemaVersion: 1,
            leaseId: "lease-old",
            generation: 1,
            claimedByUid: "uid-alice",
          },
        }),
      },
    });

    const distribution = await request(app).get("/customer-distribution").expect(200);

    expect(
      distribution.body.perGateway.map((row: { gatewayId: string }) => row.gatewayId),
    ).toEqual(["default"]);
  });

  it("renders one fleet entry per durable gateway from its bare-id runtime doc", async () => {
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "default" },
      users: {},
      gateways: {
        default: durableGatewayRoot("default", {
          latestRelease: 2,
          desiredRelease: 2,
          liveRelease: 2,
        }),
        bender: durableGatewayRoot("bender", {
          latestRelease: 2,
          desiredRelease: 2,
          liveRelease: 2,
        }),
      },
      glmGateways: {
        bender: {
          docKind: "runtime",
          gatewayId: "bender",
          release: 2,
          lifecycle: "serving",
          helm: {
            imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/gateway",
            imageTag: "1234567",
          },
          heartbeat: { status: "ready", mountedCustomers: ["ceckert"] },
          lastError: { message: null, at: null },
        },
        default: {
          docKind: "runtime",
          gatewayId: "default",
          release: 2,
          lifecycle: "serving",
          helm: {
            imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/gateway",
            imageTag: "1234567",
          },
          heartbeat: { status: "ready", mountedCustomers: ["alice"] },
          lastError: { message: null, at: null },
        },
      },
    });

    const res = await request(app).get("/gateways").expect(200);

    expect(res.body.gateways.map((gateway: { gatewayId: string }) => gateway.gatewayId).sort()).toEqual([
      "bender",
      "default",
    ]);
  });

  it("counts intentionally paused gateways separately from unreachable gateways", async () => {
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "default" },
      users: {},
      gateways: {
        default: durableGatewayRoot("default", { liveRelease: 1 }),
        standby: durableGatewayRoot("standby", { desiredStatus: "paused", liveRelease: 1 }),
      },
      glmGateways: {
        default: {
          docKind: "runtime",
          gatewayId: "default",
          release: 1,
          lifecycle: "serving",
          desiredStatus: "running",
          helm: {
            imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/gateway",
            imageTag: "1234567",
          },
          heartbeat: { status: "ready", mountedCustomers: [], lastHeartbeatAt: Date.now() },
        },
        standby: {
          docKind: "runtime",
          gatewayId: "standby",
          release: 1,
          lifecycle: "serving",
          desiredStatus: "paused",
          helm: {
            imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/gateway",
            imageTag: "1234567",
          },
          heartbeat: { status: "ready", mountedCustomers: [], lastHeartbeatAt: 1 },
        },
      },
    });

    const res = await request(app).get("/gateways").expect(200);

    expect(res.body.stats.gateways).toEqual({
      total: 2,
      ready: 1,
      paused: 1,
      unreachable: 0,
    });
  });

  it("reports the bare openclaw version from a verbatim `openclaw --version` heartbeat", async () => {
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "default" },
      users: {},
      gateways: { default: durableGatewayRoot("default", { liveRelease: 1 }) },
      glmGateways: {
        default: {
          docKind: "runtime",
          gatewayId: "default",
          release: 1,
          lifecycle: "serving",
          desiredStatus: "running",
          helm: {
            imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/gateway",
            imageTag: "1234567",
          },
          heartbeat: {
            status: "ready",
            mountedCustomers: [],
            lastHeartbeatAt: Date.now(),
            openclawVersion: "OpenClaw 2026.7.1 (2ddb9a9)",
          },
        },
      },
    });

    const res = await request(app).get("/gateways").expect(200);

    expect(res.body.gateways).toEqual([
      expect.objectContaining({ gatewayId: "default", openclawVersion: "2026.7.1" }),
    ]);
  });

  it("rejects termination when the canonical shared assignment is missing", async () => {
    const { app, state } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "shared-blue" },
      users: {
        "uid-alice": {
          provisioning: {
            openclaw: {
              gatewayId: "shared-blue",
              activationLease: {
                leaseId: "lease-1",
                generation: 3,
                status: "failed",
                targetGatewayId: "run-alice",
              },
            },
          },
        },
      },
      gateways: {
        "run-alice": {
          gatewayId: "run-alice",
          ownerUid: "uid-alice",
          allocation: {
            kind: "disposable-builder",
            leaseId: "lease-1",
            generation: 3,
            claimedByUid: "uid-alice",
          },
        },
      },
    });

    await request(app)
      .post("/customers/uid-alice/activation-lease/terminate")
      .send({ leaseId: "lease-1", generation: 3 })
      .expect(409);

    expect(state.users["uid-alice"]).toMatchObject({
      provisioning: {
        openclaw: {
          activationLease: {
            status: "failed",
          },
        },
      },
    });
  });
});

describe("manual disposable runtime return", () => {
  it("cancels an exact requested lease before a disposable runtime is allocated", async () => {
    const { app, state } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "shared-blue" },
      users: {
        "uid-alice": {
          username: "alice",
          provisioning: {
            openclaw: {
              gatewayId: "shared-blue",
              activationLease: {
                leaseId: "lease-1",
                generation: 3,
                status: "requested",
                sourceGatewayId: "shared-blue",
              },
            },
          },
        },
      },
    });

    await request(app)
      .post("/customers/uid-alice/activation-lease/cancel")
      .send({ leaseId: "lease-1", generation: 3 })
      .expect(200, {
        status: "cancelled",
        leaseId: "lease-1",
        generation: 3,
      });

    expect(state.users["uid-alice"]?.provisioning.openclaw).not.toHaveProperty(
      "activationLease",
    );
    expect(
      Object.values(state.operations).filter(
        (operation) =>
          operation.recordType === "audit" &&
          (operation.mutation as Record<string, unknown> | undefined)?.kind ===
            "cancel-activation-lease",
      ),
    ).toEqual([expect.objectContaining({ status: "completed" })]);
  });

  it("refuses to cancel after activation has allocated a target", async () => {
    const { app, state } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "shared-blue" },
      users: {
        "uid-alice": {
          username: "alice",
          provisioning: {
            openclaw: {
              gatewayId: "shared-blue",
              activationLease: {
                leaseId: "lease-1",
                generation: 3,
                status: "requested",
                sourceGatewayId: "shared-blue",
                targetGatewayId: "run-alice",
              },
            },
          },
        },
      },
    });

    await request(app)
      .post("/customers/uid-alice/activation-lease/cancel")
      .send({ leaseId: "lease-1", generation: 3 })
      .expect(409);

    expect(state.users["uid-alice"]).toMatchObject({
      provisioning: {
        openclaw: {
          activationLease: { status: "requested", targetGatewayId: "run-alice" },
        },
      },
    });
  });

  it("records an idempotent return request against the exact active lease generation", async () => {
    const { app, state } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "shared-blue" },
      users: {
        "uid-alice": {
          username: "alice",
          provisioning: {
            openclaw: {
              gatewayId: "run-alice",
              slug: "alice",
              activationLease: {
                leaseId: "lease-1",
                generation: 3,
                status: "active",
                targetGatewayId: "run-alice",
              },
            },
          },
        },
      },
    });

    await request(app)
      .post("/customers/uid-alice/activation-lease/return")
      .send({ leaseId: "lease-1", generation: 3 })
      .expect(202);
    const duplicate = await request(app)
      .post("/customers/uid-alice/activation-lease/return")
      .send({ leaseId: "lease-1", generation: 3 })
      .expect(200);

    expect(duplicate.body).toMatchObject({
      status: "return-requested",
      leaseId: "lease-1",
      generation: 3,
      adopted: true,
    });
    expect(
      Object.values(state.operations).filter(
        (operation) =>
          operation.recordType === "audit" &&
          (operation.mutation as Record<string, unknown> | undefined)?.kind ===
            "return-activation-lease",
      ),
    ).toEqual([
      expect.objectContaining({ status: "completed" }),
      expect.objectContaining({
        status: "failed",
        error: "activation lease return was already requested",
      }),
    ]);
    expect(state.users["uid-alice"]).toMatchObject({
      provisioning: {
        openclaw: {
          activationLease: {
            returnRequestedBy: "unknown",
            returnRequestedAt: expect.any(Number),
          },
        },
      },
    });
  });

  it.each([
    { label: "completed rollback", rolledBack: true, steps: [], expected: 202 },
    { label: "first key transfer failure", rolledBack: false, steps: [{ name: "keys-sync-state", status: "failed" }], expected: 202 },
    { label: "source readiness preflight failure", rolledBack: false, steps: [], error: "source gateway run-alice is not migration-ready (desiredStatus=running, desiredRelease=8, liveRelease=7); requires running or draining with a converged release", expected: 202 },
    { label: "target readiness preflight failure", rolledBack: false, steps: [], error: "target gateway shared-blue is not migration-ready (desiredStatus=running, desiredRelease=8, liveRelease=7); requires running with a converged release", expected: 202 },
    { label: "retired target placement preflight failure", rolledBack: false, steps: [], error: "target gateway shared-blue has no durable placement", expected: 202 },
    { label: "rejected target placement preflight failure", rolledBack: false, steps: [], error: "placement rejected for shared-blue: gateway is draining", expected: 202 },
    { label: "another gateway placement failure", rolledBack: false, steps: [], error: "target gateway shared-green has no durable placement", expected: 409 },
    { label: "another gateway readiness failure", rolledBack: false, steps: [], error: "source gateway run-bob is not migration-ready (desiredStatus=running)", expected: 409 },
    { label: "unknown failure without rollback", rolledBack: false, steps: [], expected: 409 },
    { label: "source quiesce without rollback", rolledBack: false, steps: [{ name: "keys-sync-state", status: "done" }, { name: "quiesce-source", status: "failed" }], expected: 409 },
  ])("safely handles return retry after $label", async ({ rolledBack, steps, expected, error = "checkpoint failed" }) => {
    const targetGatewayId = "run-alice";
    const operationId = `builder-return-${targetGatewayId}`;
    const { app, state } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "shared-blue" },
      users: {
        "uid-alice": {
          username: "alice",
          provisioning: {
            openclaw: {
              gatewayId: targetGatewayId,
              activationLease: {
                leaseId: "lease-1",
                generation: 3,
                status: "returning",
                targetGatewayId,
                returnOperationId: operationId,
              },
            },
          },
        },
      },
      gateways: {
        [targetGatewayId]: {
          gatewayId: targetGatewayId,
          gatewayClass: "builder",
          ownerUid: "uid-alice",
          allocation: {
            kind: "disposable-builder",
            leaseId: "lease-1",
            generation: 3,
            claimedByUid: "uid-alice",
          },
        },
      },
      assignments: {
        [targetGatewayId]: {
          "uid-alice": {
            uid: "uid-alice",
            gatewayId: targetGatewayId,
            slug: "alice",
            epoch: 7,
            state: "serving",
          },
        },
      },
      operations: {
        [operationId]: {
          kind: "migrate-customer",
          status: "failed",
          origin: "automatic",
          createdBy: "glm-controller-placement-policy",
          inputUid: "uid-alice",
          gatewayId: "shared-blue",
          attempts: 1,
          attemptHistory: [{ attempt: 1, error: "checkpoint failed" }],
          rolledBack,
          steps,
          error,
          completedAt: 2,
          output: { ignored: true },
          input: {
            uid: "uid-alice",
            builderSlug: "alice",
            fromGatewayId: targetGatewayId,
            toGatewayId: "shared-blue",
            source: "builder-activation-lease",
          },
        },
      },
    });

    await request(app)
      .post("/customers/uid-alice/activation-lease/return/retry")
      .send({ operationId })
      .expect(expected);

    if (expected === 409) {
      expect(state.operations[operationId].status).toBe("failed");
      return;
    }

    expect(state.operations[operationId]).toMatchObject({
      kind: "migrate-customer",
      status: "failed",
      gatewayId: "shared-blue",
      rolledBack,
      steps,
      error,
      completedAt: 2,
      retryRequestedAt: expect.any(Number),
      retryRequestedBy: "unknown",
      input: {
        uid: "uid-alice",
        builderSlug: "alice",
        fromGatewayId: targetGatewayId,
        toGatewayId: "shared-blue",
        source: "builder-activation-lease",
      },
    });
    expect(state.users["uid-alice"]).toMatchObject({
      provisioning: {
        openclaw: {
          gatewayId: targetGatewayId,
          activationLease: { status: "returning", returnOperationId: operationId },
        },
      },
    });
  });

  it("refuses to rearm a manual migration as a Builder return", async () => {
    const targetGatewayId = "run-alice";
    const operationId = `builder-return-${targetGatewayId}`;
    const { app, state } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "shared-blue" },
      users: {
        "uid-alice": {
          provisioning: {
            openclaw: {
              gatewayId: targetGatewayId,
              activationLease: {
                leaseId: "lease-1",
                generation: 3,
                status: "returning",
                targetGatewayId,
                returnOperationId: operationId,
              },
            },
          },
        },
      },
      gateways: {
        [targetGatewayId]: {
          gatewayId: targetGatewayId,
          gatewayClass: "builder",
          ownerUid: "uid-alice",
          allocation: {
            kind: "disposable-builder",
            leaseId: "lease-1",
            generation: 3,
            claimedByUid: "uid-alice",
          },
        },
      },
      assignments: {
        [targetGatewayId]: {
          "uid-alice": {
            uid: "uid-alice",
            gatewayId: targetGatewayId,
            state: "serving",
            epoch: 7,
          },
        },
      },
      operations: {
        [operationId]: {
          kind: "migrate-customer",
          status: "failed",
          origin: "operator",
          createdBy: "admin",
          inputUid: "uid-alice",
          gatewayId: "shared-blue",
          rolledBack: true,
          input: {
            uid: "uid-alice",
            fromGatewayId: targetGatewayId,
            toGatewayId: "shared-blue",
            source: "builder-activation-lease",
          },
        },
      },
    });

    await request(app)
      .post("/customers/uid-alice/activation-lease/return/retry")
      .send({ operationId })
      .expect(409);

    expect(state.operations[operationId]).toMatchObject({
      status: "failed",
      origin: "operator",
      rolledBack: true,
    });
  });

  it("rejects stale generations and caller-selected target gateways", async () => {
    const { app, state } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "shared-blue" },
      users: {
        "uid-alice": {
          username: "alice",
          provisioning: {
            openclaw: {
              gatewayId: "run-alice",
              activationLease: {
                leaseId: "lease-1",
                generation: 3,
                status: "active",
                targetGatewayId: "run-alice",
              },
            },
          },
        },
      },
    });

    await request(app)
      .post("/customers/uid-alice/activation-lease/return")
      .send({ leaseId: "lease-1", generation: 2 })
      .expect(409);
    await request(app)
      .post("/customers/uid-alice/activation-lease/return")
      .send({
        leaseId: "lease-1",
        generation: 3,
        targetGatewayId: "forged",
      })
      .expect(400);

    expect(state.users["uid-alice"]).not.toMatchObject({
      provisioning: {
        openclaw: {
          activationLease: {
            returnRequestedAt: expect.any(Number),
          },
        },
      },
    });
  });

  it("records an exact lifecycle-owned termination intent for a failed pre-cutover runtime", async () => {
    const { app, state } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "shared-blue" },
      users: {
        "uid-alice": {
          username: "alice",
          provisioning: {
            openclaw: {
              gatewayId: "shared-blue",
              activationLease: {
                leaseId: "lease-1",
                generation: 3,
                status: "failed",
                targetGatewayId: "run-alice",
              },
            },
          },
        },
      },
      gateways: {
        "run-alice": {
          gatewayId: "run-alice",
          ownerUid: "uid-alice",
          allocation: {
            kind: "disposable-builder",
            leaseId: "lease-1",
            generation: 3,
            claimedByUid: "uid-alice",
          },
        },
      },
      assignments: {
        "shared-blue": {
          "uid-alice": {
            uid: "uid-alice",
            gatewayId: "shared-blue",
            state: "serving",
            epoch: 4,
          },
        },
      },
    });

    await request(app)
      .post("/customers/uid-alice/activation-lease/terminate")
      .send({ leaseId: "lease-1", generation: 3 })
      .expect(202);
    await request(app)
      .post("/customers/uid-alice/activation-lease/terminate")
      .send({ leaseId: "lease-1", generation: 3 })
      .expect(200);

    expect(state.users["uid-alice"]).toMatchObject({
      provisioning: {
        openclaw: {
          activationLease: {
            status: "returning",
            operatorTerminateRequestedAt: expect.any(Number),
            operatorTerminateRequestedBy: "unknown",
          },
        },
      },
    });
    expect(
      Object.values(state.operations).filter(
        (operation) =>
          operation.recordType === "audit" &&
          (operation.mutation as Record<string, unknown> | undefined)?.kind ===
            "terminate-activation-lease",
      ),
    ).toEqual([
      expect.objectContaining({ status: "completed" }),
      expect.objectContaining({
        status: "failed",
        error: "activation lease termination was already requested",
      }),
    ]);
  });
});

describe("onboarding placement (post-cohorts)", () => {
  it("labels in-flight operations with the builder slug and uid", async () => {
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "default" },
      users: {
        "uid-alice": {
          username: "alice",
          email: "alice@example.com",
          provisioning: { openclaw: { slug: "alice", gatewayId: "default" } },
        },
      },
      glmGateways: { default: { gatewayClass: "shared", desiredStatus: "running" } },
      operations: {
        "operation-opaque-id": {
          kind: "migrate-customer",
          status: "pending",
          inputUid: "uid-alice",
          createdAt: 1_000,
        },
      },
    });

    const res = await request(app).get("/onboarding-placement").expect(200);

    expect(res.body.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "migration-in-flight",
          operationId: "operation-opaque-id",
          message: "migrate-customer alice (uid-alice) is pending",
        }),
      ]),
    );
  });

  it("excludes non-interactive accounts from the active Builder roster", async () => {
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "default" },
      users: {
        "uid-active": {
          username: "active-builder",
          provisioning: { openclaw: { slug: "active-builder", gatewayId: "default" } },
        },
        "uid-scheduled": {
          username: "scheduled-builder",
          accountLifecycle: { status: "deletion_scheduled", eraseAfter: 1_800_000_000_000 },
          provisioning: { openclaw: { slug: "scheduled-builder", gatewayId: "default" } },
        },
        "uid-erasing": {
          username: "erasing-builder",
          accountLifecycle: { status: "erasing" },
          provisioning: { openclaw: { slug: "erasing-builder", gatewayId: "default" } },
        },
        "uid-suspended": {
          username: "suspended-builder",
          accountLifecycle: { status: "suspended" },
          provisioning: { openclaw: { slug: "suspended-builder", gatewayId: "default" } },
        },
      },
      glmGateways: { default: { gatewayClass: "shared", desiredStatus: "running" } },
      operations: {
        "erase-operation": {
          kind: "erase-customer",
          status: "pending",
          inputUid: "uid-scheduled",
          createdAt: 1_000,
        },
      },
    });

    const res = await request(app).get("/onboarding-placement").expect(200);

    expect(res.body.customers.map((customer: { uid: string }) => customer.uid)).toEqual([
      "uid-active",
    ]);
    expect(res.body.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "account-deletion-pending",
          uid: "uid-scheduled",
          slug: "scheduled-builder",
          operationId: "erase-operation",
          expiresAt: 1_800_000_000_000,
          message: "scheduled-builder (uid-scheduled) is scheduled for deletion",
        }),
      ]),
    );
  });

  it("returns the placement config with default-gateway warnings", async () => {
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "gw-missing" },
      users: {},
      glmGateways: {
        "gw-shared": { gatewayClass: "shared", desiredStatus: "running" },
      },
    });

    const res = await request(app).get("/onboarding-placement").expect(200);

    expect(res.body.config).toEqual({
      defaultGatewayId: "gw-missing",
      sharedGatewayIds: ["gw-missing"],
      sharedGatewayAutoscaling: { enabled: true, buildersPerGateway: 4 },
    });
    expect(res.body.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "default-gateway-missing", gatewayId: "gw-missing" }),
      ]),
    );
    const shared = res.body.gateways.find(
      (g: { gatewayId: string }) => g.gatewayId === "gw-shared",
    );
    expect(shared).toMatchObject({ assignableAsDefault: false, defaultTarget: false });
  });

  it("surfaces the DURABLE roster state + epoch from the assignment doc", async () => {
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "default" },
      users: {
        "uid-a": {
          username: "alice",
          email: "alice@example.com",
          provisioning: { openclaw: { slug: "alice", gatewayId: "default" } },
        },
      },
      glmGateways: { default: { gatewayClass: "shared", desiredStatus: "running" } },
      assignments: {
        default: {
          "uid-a": {
            uid: "uid-a",
            slug: "alice",
            gatewayId: "default",
            source: "migrate-customer",
            state: "quiescing",
            epoch: 5,
          },
        },
      },
    });

    const res = await request(app).get("/onboarding-placement").expect(200);
    const customer = res.body.customers.find((c: { uid: string }) => c.uid === "uid-a");
    expect(customer).toMatchObject({
      rosterState: "quiescing",
      rosterRevisionId: "default",
      rosterEpoch: 5,
    });
  });

  it("projects draining gateway counts and rosters from durable assignments", async () => {
    const { app } = mkAdminFleetRouteApp({
      config: {
        defaultGatewayId: "shared-a",
        sharedGatewayIds: ["shared-a", "shared-c"],
      },
      users: {
        "uid-alice": {
          username: "alice",
          email: "alice@example.com",
          provisioning: { openclaw: { slug: "alice", gatewayId: "shared-a" } },
        },
      },
      glmGateways: {
        "shared-a": {
          gatewayClass: "shared",
          desiredStatus: "running",
          heartbeat: { status: "ready", mountedCustomers: [] },
        },
        "shared-c": {
          gatewayClass: "shared",
          desiredStatus: "draining",
          heartbeat: { status: "ready", mountedCustomers: ["alice"] },
        },
      },
      assignments: {
        "shared-c": {
          "uid-alice": {
            uid: "uid-alice",
            slug: "alice",
            gatewayId: "shared-c",
            source: "migrate-customer",
            state: "serving",
            epoch: 7,
          },
        },
      },
    });

    const res = await request(app).get("/onboarding-placement").expect(200);
    const draining = res.body.gateways.find(
      (gateway: { gatewayId: string }) => gateway.gatewayId === "shared-c",
    );

    expect(draining).toMatchObject({ assignedCount: 1, mountedCount: 1 });
    expect(res.body.customers[0]).toMatchObject({
      assignedGatewayId: "shared-c",
      mountedGatewayId: "shared-c",
      rosterRevisionId: "shared-c",
      rosterState: "serving",
      rosterEpoch: 7,
    });
  });

  it("reports null roster fields for a customer with no assignment doc (legacy/un-backfilled)", async () => {
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "default" },
      users: {
        "uid-a": {
          username: "alice",
          email: "alice@example.com",
          provisioning: { openclaw: { slug: "alice", gatewayId: "default" } },
        },
      },
      glmGateways: { default: { gatewayClass: "shared", desiredStatus: "running" } },
    });

    const res = await request(app).get("/onboarding-placement").expect(200);
    const customer = res.body.customers.find((c: { uid: string }) => c.uid === "uid-a");
    expect(customer).toMatchObject({
      rosterState: null,
      rosterRevisionId: null,
      rosterEpoch: null,
    });
  });

  it("updates shared pool autoscaling through the platform config route", async () => {
    const { app, state } = mkAdminFleetRouteApp({
      config: {
        defaultGatewayId: "shared-0",
        sharedGatewayIds: ["shared-0", "shared-1"],
        sharedGatewayAutoscaling: { enabled: true, buildersPerGateway: 4 },
      },
    });

    const response = await request(app)
      .patch("/onboarding-placement/autoscaling")
      .send({ enabled: false, buildersPerGateway: 6 })
      .expect(200);

    expect(state.config.sharedGatewayAutoscaling).toEqual({ enabled: false, buildersPerGateway: 6 });
    expect(response.body.config.sharedGatewayAutoscaling).toEqual({
      enabled: false,
      buildersPerGateway: 6,
    });

    await request(app)
      .patch("/onboarding-placement/autoscaling")
      .send({ enabled: true, buildersPerGateway: 1 })
      .expect(400);
    await request(app)
      .patch("/onboarding-placement/autoscaling")
      .send({ enabled: "yes", buildersPerGateway: 4 })
      .expect(400);
  });

  it("derives the shared pool from shared-class roots, not config/orchestrator", async () => {
    const { app } = mkAdminFleetRouteApp({
      config: {},
      users: {},
      gateways: {
        "shared-1": durableGatewayRoot("shared-1"),
        "shared-0": durableGatewayRoot("shared-0", { desiredStatus: "paused" }),
        "shared-a": durableGatewayRoot("shared-a", { desiredStatus: "draining" }),
        bender: durableGatewayRoot("bender", {
          gatewayClass: "builder",
          ownerUid: "uid-bender",
          builderSlug: "bender",
        }),
      },
      glmGateways: {
        "shared-1": { gatewayClass: "shared", desiredStatus: "running" },
      },
    });

    const res = await request(app).get("/onboarding-placement").expect(200);

    expect(res.body.config).toEqual({
      defaultGatewayId: "shared-1",
      sharedGatewayIds: ["shared-1", "shared-0", "shared-a"],
      sharedGatewayAutoscaling: { enabled: true, buildersPerGateway: 4 },
    });
  });

  it("ignores retired override data and exposes no override API", async () => {
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "gw-default", overrides: { "uid-alice": "gw-canary" } },
      users: {
        "uid-alice": {
          username: "alice-old",
          email: "alice@example.com",
          provisioning: { openclaw: { slug: "alice" } },
        },
      },
      gateways: {
        "gw-default": durableGatewayRoot("gw-default"),
        "gw-canary": durableGatewayRoot("gw-canary"),
      },
    });

    const res = await request(app).get("/onboarding-placement").expect(200);

    expect(res.body.config).toEqual({
      defaultGatewayId: "gw-canary",
      sharedGatewayIds: ["gw-canary", "gw-default"],
      sharedGatewayAutoscaling: { enabled: true, buildersPerGateway: 4 },
    });
    expect(res.body).not.toHaveProperty("overrides");
    expect(res.body.customers[0]).not.toHaveProperty("overrideGatewayId");

    await request(app)
      .put("/onboarding-placement/overrides/by-slug/alice")
      .send({ gatewayId: "gw-canary" })
      .expect(404);

    await request(app).delete("/onboarding-placement/overrides/uid-alice").expect(404);
  });

  it("does not report pointer drift for an active disposable builder runtime outside onboarding placement", async () => {
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "default-blue" },
      users: {
        "uid-ceckert": {
          username: "ceckert",
          email: "ceckert@example.com",
          builderSubscription: { tier: "pro", status: "active" },
          provisioning: {
            openclaw: {
              slug: "ceckert",
              gatewayId: "bender-blue",
              activationLease: {
                leaseId: "lease-one",
                generation: 1,
                status: "active",
                targetGatewayId: "bender-blue",
                requestedAt: 1_000,
                activeAt: 2_000,
              },
            },
          },
        },
      },
      glmGateways: {
        "default-blue": { gatewayId: "default-blue", gatewayClass: "shared", desiredStatus: "running" },
        "bender-blue": {
          gatewayId: "bender-blue",
          gatewayClass: "builder",
          desiredStatus: "running",
          ownerUid: "uid-ceckert",
          builderSlug: "ceckert",
          allocation: {
            kind: "disposable-builder",
            schemaVersion: 1,
            leaseId: "lease-one",
            generation: 1,
            claimedByUid: "uid-ceckert",
          },
          // Readiness/mounted telemetry relocated to glmGateways/{id}.heartbeat
          // (cutover step 2); the flat gateways/{id} writer is contracted.
          heartbeat: { status: "ready", mountedCustomers: ["ceckert"] },
        },
      },
    });

    const res = await request(app).get("/onboarding-placement").expect(200);

    const customer = res.body.customers.find((c: { uid: string }) => c.uid === "uid-ceckert");
    expect(customer).toMatchObject({
      uid: "uid-ceckert",
      assignedGatewayId: "bender-blue",
      mountedGatewayId: "bender-blue",
      policyTargetGatewayId: "bender-blue",
      driftState: "healthy",
    });
    expect(customer.warnings).toEqual([]);
    expect(res.body.driftSummary).toMatchObject({
      healthy: 1,
      "pointer-drift": 0,
    });
  });

  it("treats an assignment on a non-primary shared pool member as authoritative", async () => {
    const { app } = mkAdminFleetRouteApp({
      config: {
        defaultGatewayId: "default-blue",
        sharedGatewayIds: ["default-blue", "default-green"],
      },
      users: {
        "uid-bob": {
          username: "bob",
          provisioning: { openclaw: { slug: "bob", gatewayId: "default-green" } },
        },
      },
      glmGateways: {
        "default-blue": {
          gatewayId: "default-blue",
          gatewayClass: "shared",
          desiredStatus: "running",
          heartbeat: { status: "ready", mountedCustomers: [] },
        },
        "default-green": {
          gatewayId: "default-green",
          gatewayClass: "shared",
          desiredStatus: "running",
          heartbeat: { status: "ready", mountedCustomers: ["bob"] },
        },
      },
    });

    const res = await request(app).get("/onboarding-placement").expect(200);

    expect(res.body.customers[0]).toMatchObject({
      policyTargetGatewayId: "default-green",
      assignedGatewayId: "default-green",
      mountedGatewayId: "default-green",
      driftState: "healthy",
    });
  });

  it("targets the Platform default when a stale owner-runtime assignment has no live lease", async () => {
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "default-blue" },
      users: {
        "uid-stale": {
          username: "stale",
          provisioning: { openclaw: { slug: "stale", gatewayId: "stale-builder" } },
        },
      },
      glmGateways: {
        "default-blue": { gatewayId: "default-blue", gatewayClass: "shared", desiredStatus: "running" },
        "stale-builder": {
          gatewayId: "stale-builder",
          gatewayClass: "builder",
          desiredStatus: "running",
          ownerUid: "uid-stale",
          builderSlug: "stale",
          allocation: {
            kind: "disposable-builder",
            schemaVersion: 1,
            leaseId: "lease-stale",
            generation: 1,
            claimedByUid: "uid-stale",
          },
          heartbeat: { status: "ready", mountedCustomers: ["stale"] },
        },
      },
    });

    const res = await request(app).get("/onboarding-placement").expect(200);

    expect(res.body.customers[0]).toMatchObject({
      uid: "uid-stale",
      policyTargetGatewayId: "default-blue",
      assignedGatewayId: "stale-builder",
      driftState: "pointer-drift",
    });
  });
});

describe("account deletion revokes connector grants at the provider first", () => {
  function makeDeleteApp(
    users: Record<string, Record<string, unknown>>,
    otherDocs: Record<string, Record<string, unknown>> = {},
  ) {
    const calls: string[] = [];
    const remaining = { ...users };
    const added: Record<string, unknown>[] = [];
    const operationDocsRead = { count: 0 };
    let autoId = 0;
    let transactionTail = Promise.resolve();
    const ref = (path: string) => ({
      id: path.split("/").at(-1)!,
      path,
      get: async () => ({
        id: path.split("/").at(-1)!,
        exists: path in otherDocs,
        data: () => otherDocs[path],
      }),
      collection: (name: string) => ref(`${path}/${name}`),
      doc: (id = `auto-${++autoId}`) => ref(`${path}/${id}`),
    });
    const queryCollection = (
      name: string,
      collectionGroup: boolean,
      filters: Array<{ field: string; op: string; value: unknown }> = [],
    ) => {
      const chain = {
        collectionName: name,
        where: (field: string, op: string, value: unknown) =>
          queryCollection(name, collectionGroup, [...filters, { field, op, value }]),
        get: async () => {
          const docs = Object.entries(otherDocs)
            .filter(([path, data]) => {
              const parts = path.split("/");
              const inCollection = collectionGroup
                ? parts.at(-2) === name
                : parts.length === 2 && parts[0] === name;
              return inCollection && filters.every(({ field, op, value }) => {
                const actual = field.split(".").reduce<unknown>((current, part) =>
                  current && typeof current === "object"
                    ? (current as Record<string, unknown>)[part]
                    : undefined, data);
                return op === "in" ? (value as unknown[]).includes(actual) : actual === value;
              });
            })
            .map(([path, data]) => ({
              id: path.split("/").at(-1)!,
              ref: ref(path),
              data: () => data,
            }));
          if (name === "glmOperations") operationDocsRead.count += docs.length;
          return { docs };
        },
        doc: (id = `op-${++autoId}`) => ref(`${name}/${id}`),
      };
      return chain;
    };
    const db = {
      collection: (name: string) => {
        if (name === "users") {
          return {
            doc: (id: string) => ({
              id,
              path: `users/${id}`,
              get: async () => ({
                id,
                exists: id in remaining,
                data: () => remaining[id],
              }),
              collection: (sub: string) => ref(`users/${id}/${sub}`),
            }),
          };
        }
        return queryCollection(name, false);
      },
      doc: (path: string) => ref(path),
      collectionGroup: (name: string) => queryCollection(name, true),
      batch: () => ({
        update: (target: { path?: string }, data: Record<string, unknown>) => {
          calls.push(`batch:update:${target.path ?? "unknown"}`);
          added.push(data);
        },
        set: (target: { path: string }, data: Record<string, unknown>) => {
          calls.push(`batch:set:${target.path.split("/")[0]}`);
          added.push(data);
        },
        delete: (target: { path: string }) => {
          calls.push(`batch:delete:${target.path}`);
        },
        commit: async () => {
          calls.push("batch:commit");
        },
      }),
      runTransaction: <T>(callback: (transaction: {
        get: (target: { path?: string; collectionName?: string }) => Promise<unknown>;
        update: (target: { path: string }, data: Record<string, unknown>) => void;
        set: (target: { path: string }, data: Record<string, unknown>) => void;
        delete: (target: { path: string }) => void;
      }) => Promise<T>) => {
        const transaction = {
          get: async (target: { path?: string; collectionName?: string }) => {
            if (target.path?.startsWith("users/")) {
              const id = target.path.split("/")[1]!;
              return { exists: id in remaining, data: () => remaining[id] };
            }
            if (typeof (target as { get?: unknown }).get === "function") {
              return (target as { get(): Promise<unknown> }).get();
            }
            throw new Error("unexpected transaction read");
          },
        update: (target: { path: string }, data: Record<string, unknown>) => {
            calls.push(`batch:update:${target.path}`);
            added.push(data);
            if (target.path.startsWith("users/")) {
              const id = target.path.split("/")[1]!;
              remaining[id] = { ...remaining[id], ...data };
            } else if (target.path in otherDocs) {
              otherDocs[target.path] = { ...otherDocs[target.path], ...data };
          }
        },
        create: (target: { path: string }, data: Record<string, unknown>) => {
          calls.push(`batch:create:${target.path.split("/")[0]}`);
          added.push(data);
          otherDocs[target.path] = data;
        },
        set: (target: { path: string }, data: Record<string, unknown>) => {
            calls.push(`batch:set:${target.path.split("/")[0]}`);
            added.push(data);
            otherDocs[target.path] = data;
          },
          delete: (target: { path: string }) => {
            calls.push(`batch:delete:${target.path}`);
            delete otherDocs[target.path];
          },
        };
        const execution = transactionTail.then(() => callback(transaction));
        transactionTail = execution.then(() => undefined, () => undefined);
        return execution;
      },
    } as unknown as Firestore;

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { uid?: string }).uid = "admin-1";
      next();
    });
    addAdminFleetRoutes(app, {
      db,
      logger: { info: vi.fn(), warn: vi.fn() },
      workspaceSlugsForUser: (data) => (data.username ? [String(data.username)] : []),
      provisionGatewayAuthSecret: vi.fn(async () => ({})),
      listGatewayBuilds: vi.fn(async () => []),
      suspendAuthUser: vi.fn(async (uid: string) => {
        calls.push(`suspend-auth:${uid}`);
      }),
      revokeConnectorGrantsForUser: vi.fn(async (uid: string) => {
        calls.push(`revoke:${uid}`);
      }),
    });
    return { app, calls, added, remaining, otherDocs, operationDocsRead };
  }

  it("reads only a customer's in-flight operations, never their terminal history", async () => {
    const history = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [
        `glmOperations/failed-${index}`,
        { kind: "migrate-customer", status: "failed", inputUid: "u2" },
      ]),
    );
    const { app, operationDocsRead } = makeDeleteApp(
      { u2: { username: "acme", email: "c@d.co" } },
      history,
    );

    await request(app).post("/customer/u2/delete").expect(202);

    expect(operationDocsRead.count).toBe(0);
  });

  it.each(["failed", "succeeded"])("refuses unassignment after a restore operation is %s while its fence remains", async (status) => {
    const user = { username: "alice", provisioning: { openclaw: { gatewayId: "shared-1", restoreFence: { operationId: "restore-1", phase: "dispatched" } } } };
    const assignmentPath = "gateways/shared-1/assignments/u1";
    const assignment = { uid: "u1", slug: "alice", gatewayId: "shared-1", source: "migrate-customer", state: "serving", epoch: 3, createdAt: 1, updatedAt: 2, updatedByOperationId: null };
    const { app, calls, remaining, otherDocs } = makeDeleteApp({ u1: user }, {
      [assignmentPath]: assignment,
      "glmOperations/restore-1": { kind: "migrate-customer", status, inputUid: "u1", input: { uid: "u1" } },
    });

    const response = await request(app).post("/customers/u1/unassign");

    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/restore/);
    expect(remaining.u1).toEqual(user);
    expect(otherDocs[assignmentPath]).toEqual(assignment);
    expect(calls).not.toContain("batch:update:users/u1");
    expect(calls).not.toContain(`batch:delete:${assignmentPath}`);
  });

  it("refuses suspension while an ambiguous restore holds customer authority", async () => {
    const { app, calls, remaining } = makeDeleteApp({
      u1: { username: "alice", provisioning: { openclaw: { restoreFence: { phase: "dispatched" }, gatewayId: "shared-1" } } },
    });
    await request(app).post("/customer/u1/delete").expect(409);
    expect(calls).not.toContain("suspend-auth:u1");
    expect(calls).not.toContain("revoke:u1");
    expect(remaining.u1.accountLifecycle).toBeUndefined();
  });

  it.each(["failed", "succeeded"])("refuses unassignment after a source transfer operation is %s while its fence remains", async (status) => {
    const user = { username: "alice", provisioning: { openclaw: { gatewayId: "shared-1", sourceTransferFence: { operationId: "restore-1", phase: "dispatched" } } } };
    const assignmentPath = "gateways/shared-1/assignments/u1";
    const assignment = { uid: "u1", slug: "alice", gatewayId: "shared-1", source: "migrate-customer", state: "serving", epoch: 3, createdAt: 1, updatedAt: 2, updatedByOperationId: null };
    const { app, calls, remaining, otherDocs } = makeDeleteApp({ u1: user }, {
      [assignmentPath]: assignment,
      "glmOperations/restore-1": { kind: "migrate-customer", status, inputUid: "u1", input: { uid: "u1" } },
    });

    const response = await request(app).post("/customers/u1/unassign");

    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/source transfer/);
    expect(remaining.u1).toEqual(user);
    expect(otherDocs[assignmentPath]).toEqual(assignment);
    expect(calls).not.toContain("batch:update:users/u1");
    expect(calls).not.toContain(`batch:delete:${assignmentPath}`);
  });

  it("refuses suspension while an ambiguous source transfer holds customer authority", async () => {
    const { app, calls, remaining } = makeDeleteApp({
      u1: { username: "alice", provisioning: { openclaw: { sourceTransferFence: { phase: "dispatched" }, gatewayId: "shared-1" } } },
    });
    await request(app).post("/customer/u1/delete").expect(409);
    expect(calls).not.toContain("suspend-auth:u1");
    expect(calls).not.toContain("revoke:u1");
    expect(remaining.u1.accountLifecycle).toBeUndefined();
  });

  it("schedules retention for a pre-provisioning account instead of deleting inline", async () => {
    const { app, calls } = makeDeleteApp({ u1: { email: "a@b.co" } });

    const res = await request(app).post("/customer/u1/delete").expect(202);

    expect(res.body).toMatchObject({ status: "deletion_scheduled", slug: null });
    expect(calls).toContain("suspend-auth:u1");
    expect(calls).toContain("revoke:u1");
  });

  it("queues independent suspension and delayed erasure operations", async () => {
    const { app, calls, added } = makeDeleteApp({
      u2: { username: "acme", email: "c@d.co" },
    });

    const res = await request(app).post("/customer/u2/delete").expect(202);

    expect(res.body).toMatchObject({ status: "deletion_scheduled", slug: "acme" });
    expect(added).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "suspend-customer", inputUid: "u2" }),
      expect.objectContaining({ kind: "erase-customer", inputUid: "u2" }),
    ]));
    expect(calls).toContain("suspend-auth:u2");
    expect(calls).toContain("revoke:u2");
  });

  it("atomically admits one deletion when two requests race for the same user", async () => {
    const { app, added } = makeDeleteApp({
      u2: { username: "acme", email: "c@d.co" },
    });

    const responses = await Promise.all([
      request(app).post("/customer/u2/delete"),
      request(app).post("/customer/u2/delete"),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([202, 409]);
    expect(added.filter((data) => data.kind === "suspend-customer")).toHaveLength(1);
    expect(added.filter((data) => data.kind === "erase-customer")).toHaveLength(1);
  });

  it("admits deletion without reading or writing an unbounded public-document fan-out", async () => {
    const publicDocs = {
      "workspaces/acme": { ownerUid: "u2", ownerActive: true },
      "workspaces/acme/projects/project-one": { ownerUid: "u2", ownerActive: true },
      "posts/post-one": { authorUid: "u2", ownerActive: true },
      "feed/feed-one": { actorUid: "u2" },
      "stars/star-one": { target: { ownerUid: "u2" } },
      "follows/follow-one": { actorUid: "u2" },
    };
    const { app } = makeDeleteApp({ u2: { username: "acme" } }, publicDocs);

    await request(app).post("/customer/u2/delete").expect(202);

    expect(publicDocs).toMatchObject({
      "workspaces/acme": { ownerUid: "u2", ownerActive: true },
      "workspaces/acme/projects/project-one": { ownerUid: "u2", ownerActive: true },
      "posts/post-one": { authorUid: "u2", ownerActive: true },
      "feed/feed-one": { actorUid: "u2" },
      "stars/star-one": { target: { ownerUid: "u2" } },
      "follows/follow-one": { actorUid: "u2" },
    });
  });

  it("does not revoke or delete when the user does not exist", async () => {
    const { app, calls } = makeDeleteApp({});

    await request(app).post("/customer/ghost/delete").expect(404);

    expect(calls).toEqual([]);
  });

  it("marks a deletion admission conflict as a failed audit", async () => {
    const { app, otherDocs } = makeDeleteApp(
      { u2: { username: "acme", email: "c@d.co" } },
      {
        "glmOperations/existing": {
          kind: "suspend-customer",
          status: "pending",
          inputUid: "u2",
        },
      },
    );

    await request(app).post("/customer/u2/delete").expect(409);

    expect(Object.values(otherDocs)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        recordType: "audit",
        status: "failed",
        lifecycleStage: "action-failed",
      }),
    ]));
  });

  it("moves an already scheduled erasure to now only after an explicit eraseNow request", async () => {
    const { app, calls, added } = makeDeleteApp(
      {
        u3: {
          username: "later",
          accountLifecycle: {
            status: "deletion_scheduled",
            deletionId: "delete-3",
            eraseAfter: Date.now() + 90 * 24 * 60 * 60 * 1_000,
          },
        },
      },
      {
        "customerDeletionJobs/delete-3": {
          erasureOperationId: "erase-3",
        },
        "glmOperations/erase-3": {
          kind: "erase-customer",
          status: "pending",
        },
      },
    );

    const res = await request(app)
      .post("/customer/u3/delete")
      .send({ eraseNow: true })
      .expect(202);

    expect(res.body).toMatchObject({
      status: "erasure_requested",
      deletionId: "delete-3",
      erasureOperationId: "erase-3",
    });
    expect(added).toEqual(expect.arrayContaining([
      expect.objectContaining({ "accountLifecycle.eraseAfter": expect.any(Number) }),
      expect.objectContaining({ eraseAfter: expect.any(Number) }),
      expect.objectContaining({ nextAttemptAt: expect.any(Number) }),
    ]));
    expect(calls).not.toContain("suspend-auth:u3");
    expect(calls).not.toContain("revoke:u3");
  });
});
