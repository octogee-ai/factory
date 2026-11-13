import { describe, expect, it, vi } from "vitest";
import type { ReleasePayload } from "@octogee/shared/types/gateway-releases";
import type { FleetGateway } from "../lib/fleet-deploy.js";
import { checkIsolatedGateway } from "../lib/isolated-gateway-check.js";

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const tag = "aaaaaaa-oc2026.10.2";
const payload: ReleasePayload = {
  imageRepository: "registry/images/octogee-gateway",
  imageTag: `${tag}@${digest("a")}`,
  profileImages: { builder: { imageRepository: "registry/images/octogee-gateway-builder", imageTag: `${tag}@${digest("b")}` } },
  gatewayEdgeImage: { imageRepository: "registry/images/gateway-edge", imageTag: `${tag}@${digest("c")}` },
};
const previousPayload = { ...payload, imageTag: `old@${digest("d")}` };
const START = 1_000;

function serving(patch: Partial<FleetGateway> = {}): FleetGateway {
  const image = payload.profileImages!.builder;
  return {
    gatewayId: "check-s-1", gatewayClass: "builder", imageProfile: "builder", addedBy: null,
    desiredStatus: "running", latestRelease: 3, desiredRelease: 3, liveRelease: 3,
    latestPayload: payload, desiredPayload: payload, assignments: [{ slug: "check", state: "serving" }], operations: [],
    runtime: { release: 3, lifecycle: "serving", status: "ready", heartbeatAt: START + 200, mountedCustomers: ["check"], migratingIn: [] },
    live: { observedAt: START + 200, instances: [{ id: "vm-1", ready: true, containers: [
      { name: "gateway", image: `${image.imageRepository}:${image.imageTag}`, digests: [digest("b")], running: true },
      { name: "gateway-edge", image: `${payload.gatewayEdgeImage!.imageRepository}:${payload.gatewayEdgeImage!.imageTag}`, digests: [digest("c")], running: true },
    ] }] },
    ...patch,
  };
}

const parked = (patch: Partial<FleetGateway> = {}) => serving({
  desiredStatus: "paused", liveRelease: 2,
  runtime: { release: 2, lifecycle: "serving", status: "ready", heartbeatAt: START - 500, mountedCustomers: [], migratingIn: [] },
  live: { observedAt: START - 500, instances: [] },
  ...patch,
});

function harness(observations: Array<FleetGateway | null>) {
  let time = START;
  let index = 0;
  const statuses: string[] = [];
  const deps = {
    readGateway: vi.fn(async (_gatewayId: string) => structuredClone(observations[Math.min(index++, observations.length - 1)])),
    setDesiredStatus: vi.fn(async (_gatewayId: string, desiredStatus: "running" | "paused") => { statuses.push(desiredStatus); }),
    now: () => time,
    sleep: async (ms: number) => { time += ms; },
    log: vi.fn(),
  };
  const run = () => checkIsolatedGateway({ gatewayId: "check-s-1", sourceSha: "a".repeat(40), payload, timeoutMs: 1_000, pollIntervalMs: 100, maxObservationAgeMs: 5_000 }, deps);
  return { run, deps, statuses };
}

describe("Ship TEST isolated gateway check", () => {
  it("resumes the parked gateway, waits until it serves the shipped build from a fresh boot, then parks it again", async () => {
    const booting = serving({ liveRelease: 2, runtime: { release: 2, lifecycle: "starting", status: "booting", heartbeatAt: START + 100, mountedCustomers: [], migratingIn: [] } });
    const staleReady = serving({ runtime: { ...serving().runtime!, heartbeatAt: START - 1 } });
    const h = harness([parked(), booting, staleReady, serving()]);

    const result = await h.run();

    expect(result.status).toBe("live");
    expect(h.statuses).toEqual(["running", "paused"]);
    expect(h.deps.readGateway).toHaveBeenCalledTimes(4);
    expect(h.deps.setDesiredStatus).toHaveBeenCalledWith("check-s-1", "running");
  });

  it("fails and parks the gateway again when it does not report in service within the limit", async () => {
    const h = harness([parked(), serving({ runtime: { ...serving().runtime!, status: "booting" } })]);

    await expect(h.run()).rejects.toThrow(/check-s-1 did not serve a{40} within 1000ms: runtime is not serving and ready/);
    expect(h.statuses).toEqual(["running", "paused"]);
  });

  it("fails at once and parks the gateway again when its rollout of the shipped build fails", async () => {
    const h = harness([parked(), serving({ liveRelease: 2, operations: [{ id: "roll-3", release: 3, status: "failed", error: "image pull failed" }] })]);

    await expect(h.run()).rejects.toThrow("check-s-1 failed: rollout roll-3 failed: image pull failed");
    expect(h.deps.readGateway).toHaveBeenCalledTimes(2);
    expect(h.statuses).toEqual(["running", "paused"]);
  });

  it("does not pass a gateway still running the previous build", async () => {
    const h = harness([parked({ desiredPayload: previousPayload, latestPayload: previousPayload }), serving({ desiredPayload: previousPayload, latestPayload: previousPayload })]);

    await expect(h.run()).rejects.toThrow(/desired image family differs from requested build/);
    expect(h.statuses).toEqual(["running", "paused"]);
  });

  it("fails loudly without resuming anything when the configured gateway does not exist", async () => {
    const h = harness([null]);

    await expect(h.run()).rejects.toThrow("isolated gateway check-s-1 does not exist");
    expect(h.deps.setDesiredStatus).not.toHaveBeenCalled();
  });

  it.each([
    ["a shared gateway", { gatewayClass: "shared" as const, imageProfile: "standard" as const }],
    ["a retired gateway", { desiredStatus: "retired" as const }],
  ])("refuses %s without resuming it", async (_name, patch) => {
    const h = harness([parked(patch)]);

    await expect(h.run()).rejects.toThrow("check-s-1 is not a non-retired isolated gateway");
    expect(h.deps.setDesiredStatus).not.toHaveBeenCalled();
  });

  it("parks the gateway again when resuming it fails", async () => {
    const h = harness([parked()]);
    h.deps.setDesiredStatus.mockRejectedValueOnce(new Error("user migration is in flight for gateway check-s-1"));

    await expect(h.run()).rejects.toThrow("user migration is in flight for gateway check-s-1");
    expect(h.deps.setDesiredStatus.mock.calls.map(([, status]) => status)).toEqual(["running", "paused"]);
  });

  it("reports the check failure and the parking failure together", async () => {
    const h = harness([parked(), serving({ runtime: { ...serving().runtime!, status: "booting" } })]);
    h.deps.setDesiredStatus.mockImplementation(async (_gatewayId, desiredStatus) => {
      if (desiredStatus === "paused") throw new Error("gateway has a current retirement claim");
    });

    const failure = await h.run().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).message).toBe("isolated gateway check-s-1 check failed and the gateway was not parked");
    expect((failure as AggregateError).errors.map((error: Error) => error.message)).toEqual([
      expect.stringMatching(/did not serve/),
      "gateway has a current retirement claim",
    ]);
  });

  it("fails the ship when the check passes but the gateway cannot be parked", async () => {
    const h = harness([parked(), serving()]);
    h.deps.setDesiredStatus.mockImplementation(async (_gatewayId, desiredStatus) => {
      if (desiredStatus === "paused") throw new Error("gateway has a current retirement claim");
    });

    await expect(h.run()).rejects.toThrow("gateway has a current retirement claim");
  });
});
