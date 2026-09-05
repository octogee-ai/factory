import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { placementPodDiagnosticsScope } from "../placement-policy-reconciler";

describe("placementPodDiagnosticsScope", () => {
  it("keeps gce-vm gateways out of the pod scan and reports them as unknown to Kubernetes", () => {
    const runtimes = new Map<string, Record<string, unknown>>([
      ["b-vm", { docKind: "runtime", gatewayId: "b-vm", runtime: "gce-vm", vm: { status: "RUNNING" } }],
      ["b-pod", { docKind: "runtime", gatewayId: "b-pod", runtime: "cluster" }],
    ]);

    const scope = placementPodDiagnosticsScope(["b-vm", "b-pod", "shared-1"], runtimes);

    expect(scope.clusterGatewayIds).toEqual(["b-pod", "shared-1"]);
    expect(scope.vmDiagnostics).toEqual({ "b-vm": { status: "unknown", totalPods: 0, readyPods: 0 } });
  });
});

describe("agent computer wiring", () => {
  const indexSource = readFileSync(resolve(import.meta.dirname, "../index.ts"), "utf8");
  const reconcilerSource = readFileSync(resolve(import.meta.dirname, "../placement-policy-reconciler.ts"), "utf8");

  it("scopes the placement pod scan by runtime and recovers preempted computers from the heartbeat poller", () => {
    expect(reconcilerSource).toMatch(/placementPodDiagnosticsScope\(gatewayDocs\.map\(\(doc\) => doc\.id\), runtimes\)/u);
    expect(indexSource).toMatch(/onUnreachable: async \(gatewayId: string\) => \{\s*await vmGatewayRuntimeRef\.current\?\.recoverUnreachable\(gatewayId\);/u);
    expect(indexSource).toMatch(/deleteComputer: async \(uid: string\) => \{/u);
  });
});
