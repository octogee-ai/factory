import { describe, expect, it } from "vitest";

import { disruptionObserverTest } from "../disruption-observer";

describe("disruption observer classification", () => {
  it("keeps NodeShutdown explicitly unconfirmed until Cloud Audit Logs confirm preemption", () => {
    expect(disruptionObserverTest.causeFor("NodeShutdown")).toBe("node_shutdown_unconfirmed");
    expect(disruptionObserverTest.causeFor("FailedPreStopHook")).toBe("prestop_hook_failure");
    expect(disruptionObserverTest.causeFor("FailedScheduling")).toBe("scheduler_pending");
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
