import { describe, expect, it, vi } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { isolatedGatewayToCheck, setIsolatedGatewayDesiredStatus } from "../ops/check-isolated-gateway.js";

const sourceSha = "a".repeat(40);

function gatewayRoot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    gatewayId: "check-s-1", createdAt: 1, createdBy: "test", updatedAt: 1, updatedBy: "test",
    latestRelease: 3, desiredRelease: 3, liveRelease: 2, desiredStatus: "paused",
    configSchemaVersion: 1, profile: null, gatewayClass: "builder", imageProfile: "builder", sizingTier: "s", gcpProject: null,
    gatewayContainerSecurityContext: null, serviceAccountName: null, serviceAccount: null, builderAccess: null,
    ownerUid: "u1", builderSlug: "check", modelBrokerLimits: null, preemption: null,
    ...overrides,
  };
}

function fixture(root: Record<string, unknown> = gatewayRoot()) {
  const records = new Map<string, Record<string, unknown>>([["gateways/check-s-1", root]]);
  return { store: createDocumentFixtureStore(records), records };
}

const audits = (records: Map<string, Record<string, unknown>>) =>
  [...records.entries()].filter(([path]) => path.startsWith("glmOperations/audit-")).map(([, audit]) => audit);

describe("Ship TEST isolated gateway check wiring", () => {
  it("says in one line that it skips the check when the TEST target names no isolated gateway", () => {
    const log = vi.fn();

    expect(isolatedGatewayToCheck({ targetId: "test-central" }, log)).toBeNull();
    expect(log.mock.calls).toEqual([["skipped the isolated gateway check: deployment target test-central names no shipTestIsolatedGatewayId"]]);
  });

  it("names the configured isolated gateway without logging a skip", () => {
    const log = vi.fn();

    expect(isolatedGatewayToCheck({ targetId: "test-central", shipTestIsolatedGatewayId: "check-s-1" }, log)).toBe("check-s-1");
    expect(log).not.toHaveBeenCalled();
  });

  it("resumes and parks the gateway through journaled desired-status patches", async () => {
    const { store, records } = fixture();

    await setIsolatedGatewayDesiredStatus(store, { gatewayId: "check-s-1", desiredStatus: "running", sourceSha, actor: "operator:test" });
    expect((await store.gateways.roots.get("check-s-1"))?.desiredStatus).toBe("running");
    await setIsolatedGatewayDesiredStatus(store, { gatewayId: "check-s-1", desiredStatus: "paused", sourceSha, actor: "operator:test" });

    const root = await store.gateways.roots.get("check-s-1");
    expect(root).toMatchObject({ desiredStatus: "paused", updatedBy: "operator:test" });
    expect(audits(records)).toEqual([
      expect.objectContaining({ actor: "operator:test", status: "completed", mutation: { kind: "patch-gateway", gatewayId: "check-s-1", patch: { desiredStatus: "running" } } }),
      expect.objectContaining({ actor: "operator:test", status: "completed", mutation: { kind: "patch-gateway", gatewayId: "check-s-1", patch: { desiredStatus: "paused" } } }),
    ]);
  });

  it("refuses to resume a gateway that is being retired, and journals the refusal", async () => {
    const { store, records } = fixture(gatewayRoot({ desiredStatus: "retired" }));

    await expect(setIsolatedGatewayDesiredStatus(store, { gatewayId: "check-s-1", desiredStatus: "running", sourceSha, actor: "operator:test" }))
      .rejects.toThrow("check-s-1 was not set running: gateway has a current retirement claim");
    expect((await store.gateways.roots.get("check-s-1"))?.desiredStatus).toBe("retired");
    expect(audits(records)).toEqual([expect.objectContaining({ status: "failed", error: "gateway has a current retirement claim" })]);
  });

  it("fails loudly when the gateway does not exist", async () => {
    const store = createDocumentFixtureStore(new Map());

    await expect(setIsolatedGatewayDesiredStatus(store, { gatewayId: "check-s-1", desiredStatus: "running", sourceSha, actor: "operator:test" }))
      .rejects.toThrow("isolated gateway check-s-1 does not exist");
  });
});
