import { describe, expect, it, vi } from "vitest";

import type { Firestore } from "firebase-admin/firestore";

import { disruptionObserverTest, startDisruptionObserver } from "../disruption-observer";
import { renderMetrics, resetMetrics } from "../metrics";

describe("disruption observer classification", () => {
  it("keeps NodeShutdown explicitly unconfirmed until Cloud Audit Logs confirm preemption", () => {
    expect(disruptionObserverTest.causeFor("NodeShutdown")).toBe("node_shutdown_unconfirmed");
    expect(disruptionObserverTest.causeFor("FailedPreStopHook")).toBe("prestop_hook_failure");
    expect(disruptionObserverTest.causeFor("FailedScheduling")).toBe("scheduler_pending");
  });

  it("names kubelet critical-pod preemption as its own warning-level cause", () => {
    const cause = disruptionObserverTest.causeFor("Preempting");
    expect(cause).toBe("kubelet_critical_preemption");
    expect(disruptionObserverTest.severityFor(cause)).toBe("WARNING");
  });

  it("classifies missing Spot labels as unknown rather than on-demand", () => {
    const node = disruptionObserverTest.parseNode({
      metadata: { name: "node-a", uid: "node-uid", labels: {} },
      spec: { providerID: "gce://octogee/us-central1-a/node-a", taints: [] },
      status: { conditions: [] },
    });

    expect(node.capacityClass).toBe("unknown");
    expect(node.zone).toBe("us-central1-a");
  });

  it("extracts gateway and Builder identity from pod metadata", () => {
    const pod = disruptionObserverTest.parsePod({
      metadata: {
        name: "octogee-gateway-default-abc",
        uid: "pod-uid",
        labels: {
          "gateway-id": "default",
          "gateway-instance": "default",
          "gateway-class": "shared",
          "octogee.ai/builder-slug": "ada",
        },
      },
      spec: { nodeName: "node-a" },
      status: { phase: "Running", reason: null },
    });

    expect(pod).toMatchObject({
      name: "octogee-gateway-default-abc",
      uid: "pod-uid",
      nodeName: "node-a",
      gatewayId: "default",
      gatewayClass: "shared",
      builderSlug: "ada",
    });
  });
});

describe("disruption observer environment isolation", () => {
  it.each([
    { namespace: "octogee", kind: "Pod", expectedRecords: 0 },
    { namespace: "octogee-test", kind: "Pod", expectedRecords: 1 },
    { namespace: undefined, kind: "Node", expectedRecords: 1 },
    { namespace: "octogee-test", kind: "Pod", reason: "Preempting", expectedRecords: 1 },
  ])("handles $kind $reason events from $namespace", async ({ namespace, kind, reason, expectedRecords }) => {
    const pod = {
      metadata: { name: "gateway-pod", uid: "pod-uid", namespace: namespace ?? "octogee-test", labels: { "gateway-id": "gateway-a" } },
      spec: { nodeName: "node-a" },
      status: { phase: "Running" },
    };
    const event = {
      metadata: { uid: "event-uid" },
      reason: reason ?? (kind === "Node" ? "NodeShutdown" : "FailedPreStopHook"),
      type: "Warning",
      involvedObject: { kind, namespace, name: kind === "Node" ? "node-a" : "gateway-pod", uid: kind === "Node" ? "node-uid" : "pod-uid" },
    };
    const runKubectl = vi.fn(async (args: string[]) => {
      let response: unknown;
      if (args.includes("nodes")) response = { items: [{ metadata: { name: "node-a", uid: "node-uid" } }] };
      else if (args.includes("events")) response = { items: [event] };
      else if (args.includes("pods")) response = { items: namespace === "octogee" ? [] : [pod] };
      else response = pod;
      return { code: 0, stdout: JSON.stringify(response), stderr: "" };
    });
    const query = { get: vi.fn(async () => ({ docs: [] })) };
    const collection = vi.fn(() => ({
      doc: () => ({ get: async () => ({ exists: false }), collection: () => query }),
      where: () => query,
    }));
    const emit = vi.fn();
    const log = vi.fn();
    vi.useFakeTimers();
    const stop = startDisruptionObserver({
      db: { collection } as unknown as Firestore,
      runKubectl,
      environment: "test",
      cluster: "cluster-a",
      namespace: "octogee-test",
      intervalMs: 60_000,
      log,
      emit,
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(log).not.toHaveBeenCalled();
      expect(emit).toHaveBeenCalledTimes(expectedRecords);
      if (expectedRecords === 0) {
        expect(collection).not.toHaveBeenCalled();
        expect(runKubectl.mock.calls.some(([args]) => args.includes("octogee"))).toBe(false);
      } else {
        expect(emit.mock.calls[0][0]).toMatchObject({
          namespace: "octogee-test",
          affectedGateways: [{ gatewayId: "gateway-a" }],
        });
      }
    } finally {
      stop();
      vi.useRealTimers();
    }
  });
});

describe("disruption observer preemption counter", () => {
  it("exports kubelet_critical_preemption at zero before any event so increase() sees the first one", () => {
    resetMetrics();
    const runKubectl = vi.fn(async () => ({ code: 0, stdout: JSON.stringify({ items: [] }), stderr: "" }));
    vi.useFakeTimers();
    const stop = startDisruptionObserver({
      db: {} as Firestore,
      runKubectl,
      environment: "test",
      cluster: "cluster-a",
      namespace: "octogee-test",
      intervalMs: 60_000,
      log: vi.fn(),
    });
    try {
      const rendered = renderMetrics();
      for (const capacityClass of ["spot", "on-demand", "unknown"]) {
        expect(rendered).toContain(
          `glm_disruption_observations_total{cause="kubelet_critical_preemption",source="kubernetes_event",capacity_class="${capacityClass}",namespace="octogee-test"} 0`,
        );
      }
    } finally {
      stop();
      vi.useRealTimers();
    }
  });
});
