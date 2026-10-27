import { describe, expect, it, vi } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import type { DurableGateway } from "../converge-gateway.js";
import { markGatewayLive } from "../index.js";

function fixture(changed: Record<string, unknown> = {}, status = "draining") {
  const gateway = {
    gatewayId: "shared-blue", createdAt: 1, createdBy: "test", updatedAt: 2, updatedBy: "test",
    latestRelease: 3, desiredRelease: 3, liveRelease: null, desiredStatus: status,
    configSchemaVersion: 1, profile: null, gatewayClass: "shared", imageProfile: "standard",
    sizingTier: null, gcpProject: null, gatewayContainerSecurityContext: null,
    serviceAccountName: null, serviceAccount: null, builderAccess: null,
    ownerUid: null, builderSlug: null, modelBrokerLimits: null,
  } as DurableGateway;
  const documents = new Map<string, Record<string, unknown>>([
    ["gateways/shared-blue", { ...gateway, ...changed }],
    ["glmGateways/shared-blue", { lifecycle: "provisioning", release: 3 }],
  ]);
  const writes = vi.fn((ref: { path: string }, patch: object) => {
    documents.set(ref.path, { ...documents.get(ref.path), ...patch });
  });
  const db = {
    collection: (name: string) => ({ doc: (id: string) => ({ path: `${name}/${id}` }) }),
    runTransaction: async (run: (tx: object) => Promise<unknown>) => run({
      get: async (ref: { path: string }) => ({ exists: documents.has(ref.path), data: () => documents.get(ref.path) }),
      set: writes,
    }),
  } as unknown as Firestore;
  const publish = () => markGatewayLive({ db, log: vi.fn() }, gateway, {
    imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway", imageTag: "build-3",
  });
  return { documents, writes, publish };
}

describe("verified Gateway live publication", () => {
  it("publishes a draining source as serving without reopening placement", async () => {
    const h = fixture();
    await h.publish();
    expect(h.documents.get("gateways/shared-blue")).toMatchObject({ desiredStatus: "draining", liveRelease: 3 });
    expect(h.documents.get("glmGateways/shared-blue")).toMatchObject({ lifecycle: "serving", release: 3 });
  });

  it("publishes a paused release without advertising a serving runtime", async () => {
    const h = fixture({}, "paused");
    await h.publish();
    expect(h.documents.get("gateways/shared-blue")).toMatchObject({ desiredStatus: "paused", liveRelease: 3 });
    expect(h.documents.get("glmGateways/shared-blue")).toMatchObject({ lifecycle: "provisioning" });
  });

  it.each([
    { desiredRelease: 4 },
    { desiredStatus: "paused" },
    { desiredStatus: "retired" },
    { desiredStatus: "running" },
    { runtimeRestartFence: { kind: "source-recovery", phase: "reserved" } },
    { retirementClaim: { operationId: "retire-source" } },
  ])("refuses publication after transaction-time custody changes: %j", async (changed) => {
    const h = fixture(changed);
    await h.publish();
    expect(h.writes).not.toHaveBeenCalled();
  });
});
