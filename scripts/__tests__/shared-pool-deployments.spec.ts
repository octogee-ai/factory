import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const helper = resolve(import.meta.dirname, "../lib/shared-pool-deployments.sh");

function deployment(
  name: string,
  instance: string,
  gatewayClass: string,
  readyReplicas: number,
  replicas = 1,
): {
  metadata: { name: string; labels: Record<string, string>; deletionTimestamp?: string };
  spec: { replicas: number };
  status: { readyReplicas: number };
} {
  return {
    metadata: {
      name,
      labels: {
        "app.kubernetes.io/name": "octogee-gateway",
        "gateway-instance": instance,
        "gateway-class": gatewayClass,
      },
    },
    spec: { replicas },
    status: { readyReplicas },
  };
}

function listShared(items: unknown[]) {
  return spawnSync(
    "bash",
    ["-c", 'source "$1"; octogee_list_shared_gateway_deployments', "--", helper],
    { encoding: "utf8", input: JSON.stringify({ items }) },
  );
}

describe("shared pool deployment listing", () => {
  it("lists shared slots ordinal-first with ready and desired replicas", () => {
    const result = listShared([
      deployment("octogee-gateway-shared-a", "shared-a", "shared", 1),
      deployment("octogee-gateway-shared-10", "shared-10", "shared", 0, 0),
      deployment("octogee-gateway-shared-2", "shared-2", "shared", 1),
      deployment("octogee-gateway-builder-alice", "builder-alice", "builder", 1),
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "octogee-gateway-shared-2\tshared-2\t1\t1",
      "octogee-gateway-shared-10\tshared-10\t0\t0",
      "octogee-gateway-shared-a\tshared-a\t1\t1",
    ]);
  });

  it("ignores terminating deployments", () => {
    const terminating = deployment("octogee-gateway-shared-3", "shared-3", "shared", 1);
    terminating.metadata.deletionTimestamp = "2026-09-09T00:00:00Z";
    const result = listShared([terminating, deployment("octogee-gateway-shared-0", "shared-0", "shared", 1)]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("octogee-gateway-shared-0\tshared-0\t1\t1");
  });
});
