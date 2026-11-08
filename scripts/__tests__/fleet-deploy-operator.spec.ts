import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { centralGatewayReleasePayload, type ReleaseDigestManifest } from "@octogee/core/artifact-registry";
import { GatewayRetirementConflictError } from "@octogee/core/gateway-retirement-claim";
import { InvalidGatewayRootError, StaleGatewayReleaseError } from "@octogee/core/gateway-release-append";
import { FleetDeploymentDeferredError } from "../lib/fleet-deploy.js";
import { releasePayloadHash } from "@octogee/shared/types/gateway-releases";

const mocks = vi.hoisted(() => ({ append: vi.fn(), mutate: vi.fn() }));
vi.mock("@octogee/core/gateway-release-append", async (importOriginal) => ({
  ...await importOriginal<typeof import("@octogee/core/gateway-release-append")>(),
  asDurableGatewayRoot: (value: unknown) => value,
  appendGatewayRelease: mocks.append,
}));
vi.mock("@octogee/core/normal-fleet-mutation", () => ({ runNormalFleetMutation: mocks.mutate }));
import { deployFleetBuilder, parseFleetDeployArgs } from "../ops/deploy-fleet.js";

const manifest: ReleaseDigestManifest = {
  sourceSha: "a".repeat(40), manifestDigest: `sha256:${"d".repeat(64)}`, openclawVersion: "2026.10.2", repository: "registry/images",
  surfaces: { gateway: { "octogee-gateway": `sha256:${"a".repeat(64)}`, "octogee-gateway-builder": `sha256:${"b".repeat(64)}`, "gateway-edge": `sha256:${"c".repeat(64)}` }, platform: {} },
};
const payload = centralGatewayReleasePayload(manifest);

function database(gatewayClass = "builder", platformHash = releasePayloadHash(payload)) {
  const root = { gatewayId: "b-paused", gatewayClass, desiredStatus: "paused", latestRelease: 1, desiredRelease: 1 };
  const db = {
    collection: vi.fn(() => ({ doc: vi.fn(() => ({ get: vi.fn(async () => ({ data: () => root })) })) })),
    doc: vi.fn(() => ({ get: vi.fn(async () => ({ data: () => ({ schemaVersion: 1, payloadHash: platformHash, imageTag: payload.imageTag, openclawSourceSha: null, writtenAt: 100 }) })) })),
  };
  return { root, db: db as unknown as Firestore };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.append.mockResolvedValue({ release: 2, operationId: "roll-2" });
  mocks.mutate.mockImplementation(async (_db, mutation) => mutation.action());
});

afterEach(() => vi.unstubAllEnvs());

describe("TEST fleet operator release mutation", () => {
  it("journals a PROD Builder release in the PROD environment", async () => {
    const { db, root } = database();
    await deployFleetBuilder(db, { gatewayId: root.gatewayId }, manifest, payload, "prod");
    expect(mocks.mutate).toHaveBeenCalledWith(expect.objectContaining({ transaction: expect.any(Function) }), expect.objectContaining({ target: { gatewayId: root.gatewayId, environment: "prod" } }));
  });
  it("uses the ordinary audit wrapper and immutable append without changing paused status", async () => {
    const { db, root } = database();
    expect(await deployFleetBuilder(db, { gatewayId: root.gatewayId }, manifest, payload, "test")).toEqual({ release: 2, operationId: "roll-2" });
    expect(mocks.mutate).toHaveBeenCalledWith(expect.objectContaining({ transaction: expect.any(Function) }), expect.objectContaining({
      forced: false, target: { gatewayId: "b-paused", environment: "test" },
      mutation: { kind: "deploy-gateway-build", gatewayId: "b-paused", sourceSha: manifest.sourceSha, manifestDigest: manifest.manifestDigest },
    }));
    expect(mocks.append).toHaveBeenCalledWith(mocks.mutate.mock.calls[0]![0], expect.objectContaining({ gateway: root, payload, artifact: payload, sourceRelease: 1, origin: "operator" }));
    expect(root.desiredStatus).toBe("paused");
  });
  it.each([new GatewayRetirementConflictError("transfer busy"), new StaleGatewayReleaseError("b-paused", 1, 2)])("defers typed owned mutation races: %s", async (error) => {
    const { db } = database();
    mocks.append.mockRejectedValue(error);
    await expect(deployFleetBuilder(db, { gatewayId: "b-paused" }, manifest, payload, "test")).rejects.toBeInstanceOf(FleetDeploymentDeferredError);
    expect(mocks.mutate).toHaveBeenCalledOnce();
  });
  it.each([true, false])("requires succeeded owned retirement proof for a root deleted during append: %s", async (succeeded) => {
    const { db } = database();
    const collection = vi.mocked(db.collection).getMockImplementation()!;
    vi.mocked(db.collection).mockImplementation((name) => name === "glmOperations" ? {
      where: () => ({ get: async () => ({ docs: [{ data: () => ({ status: succeeded ? "succeeded" : "running", input: { gatewayId: "b-paused" } }) }] }) }),
    } as unknown as ReturnType<Firestore["collection"]> : collection(name));
    mocks.append.mockRejectedValue(new InvalidGatewayRootError("b-paused"));
    await expect(deployFleetBuilder(db, { gatewayId: "b-paused" }, manifest, payload, "test")).rejects.toBeInstanceOf(succeeded ? FleetDeploymentDeferredError : InvalidGatewayRootError);
  });
  it("retains the explicit operator identity and reason in the operations journal", async () => {
    vi.stubEnv("RELEASE_ACTOR", "operator:chris");
    vi.stubEnv("RELEASE_REASON", "Ship TEST from Cloud Build 123");
    const { db } = database();
    await deployFleetBuilder(db, { gatewayId: "b-paused" }, manifest, payload, "test");
    expect(mocks.mutate).toHaveBeenCalledWith(expect.objectContaining({ transaction: expect.any(Function) }), expect.objectContaining({ actor: "operator:chris", why: "Ship TEST from Cloud Build 123" }));
  });
  it("revalidates Builder class before writing an audit or release", async () => {
    const { db } = database("shared");
    await expect(deployFleetBuilder(db, { gatewayId: "b-paused" }, manifest, payload, "test")).rejects.toThrow("non-retired Builder");
    expect(mocks.mutate).not.toHaveBeenCalled();
  });
  it("rechecks platform supersession immediately before a Builder mutation", async () => {
    const { db } = database("builder", "e".repeat(64));
    await expect(deployFleetBuilder(db, { gatewayId: "b-paused" }, manifest, payload, "test")).rejects.toThrow("superseded");
    expect(mocks.mutate).not.toHaveBeenCalled();
  });
  it("requires an immutable SHA and exposes no environment override", () => {
    expect(parseFleetDeployArgs([`--sha=${manifest.sourceSha}`])).toEqual({ sourceSha: manifest.sourceSha, timeoutMs: 2_700_000 });
    expect(() => parseFleetDeployArgs(["--sha=main"])).toThrow("full-lowercase-sha");
    expect(() => parseFleetDeployArgs([`--sha=${manifest.sourceSha}`, "--env=prod"])).toThrow("invalid TEST fleet argument");
  });
});
