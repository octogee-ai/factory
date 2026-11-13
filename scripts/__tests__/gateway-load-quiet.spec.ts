import { describe, expect, it, vi } from "vitest";
import { busyReasons, quietSince, readSharedQuietSlots, type QuietSample } from "../lib/gateway-load-quiet.js";

const sample = (at: number, over: Partial<QuietSample> = {}): QuietSample => ({
  at,
  deploysRunning: 0,
  slots: [{ slot: "shared-1d4ef9d5a9da", cores: 0.05, pods: 1, ready: true }],
  ...over,
});

describe("TEST quiet gate", () => {
  it("names every reason TEST is busy", () => {
    expect(busyReasons(sample(0, {
      deploysRunning: 1,
      slots: [
        { slot: "shared-1d4ef9d5a9da", cores: 0.9, pods: 1, ready: true },
        { slot: "shared-7bf0dde2d0a4", cores: 0.01, pods: 2, ready: true },
        { slot: "shared-0aa0aa0aa0aa", cores: 0, pods: 1, ready: false },
      ],
    }), 0.2)).toEqual([
      "a Ship TEST or platform deploy is running",
      "shared-1d4ef9d5a9da at 0.90 cores",
      "shared-7bf0dde2d0a4 has 2 pods",
      "shared-0aa0aa0aa0aa is not ready",
    ]);
  });

  it("treats a pool with no serving slot as busy", () => {
    expect(busyReasons(sample(0, { slots: [] }), 0.2)).toEqual(["no shared slot is serving"]);
  });

  it("keeps the start of an unbroken quiet stretch and resets it on any busy sample", () => {
    let since: number | null = null;
    since = quietSince(since, sample(0), 0.2);
    since = quietSince(since, sample(30_000), 0.2);
    expect(since).toBe(0);
    since = quietSince(since, sample(60_000, { deploysRunning: 1 }), 0.2);
    expect(since).toBeNull();
    since = quietSince(since, sample(90_000), 0.2);
    expect(since).toBe(90_000);
  });
});

describe("shared quiet slot metrics", () => {
  const pod = {
    metadata: { name: "shared-0-pod", labels: { "gateway-id": "shared-0" } },
    spec: { containers: [{ name: "gateway" }, { name: "gateway-edge" }] },
    status: { containerStatuses: [{ ready: true }, { ready: true }] },
  };
  const metrics = (name: string, cpu: unknown) => ({ name, usage: { cpu } });
  const kubectlFor = (containers: unknown[], ready = true) => vi.fn(async (...args: string[]) => JSON.stringify(
    args[1] === "pods"
      ? { items: [{ ...pod, status: { containerStatuses: [{ ready }, { ready }] } }] }
      : { containers },
  ));

  it("sums CPU usage for every expected container", async () => {
    expect(await readSharedQuietSlots(kubectlFor([metrics("gateway-edge", "10m"), metrics("gateway", "500000000n")]))).toEqual([
      { slot: "shared-0", cores: 0.51, pods: 1, ready: true },
    ]);
  });

  it.each([
    { containers: [] },
    { containers: [metrics("gateway-edge", "10m")] },
    { containers: [metrics("gateway", "10m")] },
    { containers: [metrics("gateway", "10m"), metrics("gateway-edge", "invalid")] },
    { containers: [metrics("gateway", undefined), metrics("gateway-edge", "10m")] },
  ])("rejects incomplete or invalid CPU metrics $containers", async ({ containers }) => {
    await expect(readSharedQuietSlots(kubectlFor(containers))).rejects.toThrow();
  });

  it("marks unready pods busy without fetching unavailable metrics", async () => {
    const kubectl = kubectlFor([], false);
    const slots = await readSharedQuietSlots(kubectl);
    expect(busyReasons(sample(0, { slots }), 0.35)).toEqual(["shared-0 is not ready"]);
    expect(kubectl).toHaveBeenCalledTimes(1);
  });
});
