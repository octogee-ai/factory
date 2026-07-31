import { afterEach, describe, expect, it } from "vitest";

import {
  recordGatewayHealth,
  recordConfigRoll,
  recordDisruptionObservation,
  recordDisruptionSnapshot,
  recordReconcile,
  recordSharedGatewayMaxCapacity,
  renderMetrics,
  resetMetrics,
} from "../metrics";

afterEach(() => resetMetrics());

describe("glm-controller metrics", () => {
  it("renders zeroed counters + TYPE lines before any tick", () => {
    const out = renderMetrics();
    expect(out).toContain("# TYPE glm_reconcile_total counter");
    expect(out).toContain('glm_reconcile_total{result="ok"} 0');
    expect(out).toContain('glm_reconcile_total{result="fail"} 0');
    expect(out).toContain("glm_reconcile_last_success_timestamp_seconds 0.000");
  });

  it("counts an ok tick and stamps last-success", () => {
    recordReconcile("ok", 1_700_000_000_000);
    const out = renderMetrics();
    expect(out).toContain('glm_reconcile_total{result="ok"} 1');
    expect(out).toContain("glm_reconcile_last_success_timestamp_seconds 1700000000.000");
  });

  it("counts a fail tick without moving last-success", () => {
    recordReconcile("ok", 1_700_000_000_000);
    recordReconcile("fail", 1_700_000_500_000);
    const out = renderMetrics();
    expect(out).toContain('glm_reconcile_total{result="ok"} 1');
    expect(out).toContain('glm_reconcile_total{result="fail"} 1');
    expect(out).toContain("glm_reconcile_last_success_timestamp_seconds 1700000000.000");
  });

  it("renders desired running gateway availability gauges for alerting", () => {
    recordGatewayHealth([
      { gatewayId: "bender-blue", availableReplicas: 1 },
      { gatewayId: "default-green", availableReplicas: 0 },
    ]);

    const out = renderMetrics();

    expect(out).toContain('glm_gateway_available_replicas{gateway_id="bender-blue"} 1');
    expect(out).toContain('glm_gateway_desired_running_unavailable{gateway_id="bender-blue"} 0');
    expect(out).toContain('glm_gateway_available_replicas{gateway_id="default-green"} 0');
    expect(out).toContain('glm_gateway_desired_running_unavailable{gateway_id="default-green"} 1');
  });

  it("replaces stale gateway availability series on each refresh", () => {
    recordGatewayHealth([{ gatewayId: "old-blue", availableReplicas: 0 }]);
    recordGatewayHealth([{ gatewayId: "new-green", availableReplicas: 1 }]);

    const out = renderMetrics();

    expect(out).not.toContain("old-blue");
    expect(out).toContain("new-green");
  });

  it("counts config checkpoint, proof, and unfreeze outcomes without customer labels", () => {
    recordConfigRoll({ stage: "checkpoint", result: "ok", gatewayId: "bender", revisionId: "bender-r1" });
    recordConfigRoll({ stage: "proof", result: "fail", gatewayId: "bender", revisionId: "bender-r2" });
    recordConfigRoll({ stage: "unfreeze", result: "ok", gatewayId: "bender", revisionId: "bender-r1" });

    const out = renderMetrics();

    expect(out).toContain('glm_config_roll_total{gateway_id="bender",revision_id="bender-r1",stage="checkpoint",result="ok"} 1');
    expect(out).toContain('glm_config_roll_total{gateway_id="bender",revision_id="bender-r2",stage="proof",result="fail"} 1');
    expect(out).toContain('glm_config_roll_total{gateway_id="bender",revision_id="bender-r1",stage="unfreeze",result="ok"} 1');
    expect(out).not.toContain("uid=");
    expect(out).not.toContain("slug=");
  });

  it("renders disruption counters and the current substrate snapshot", () => {
    recordDisruptionObservation({
      cause: "node_shutdown_unconfirmed",
      source: "kubernetes_event",
      capacityClass: "spot",
      namespace: "octogee-test",
      now: 1_700_000_000_000,
    });
    recordDisruptionSnapshot({
      spotNodes: 3,
      onDemandNodes: 1,
      unknownNodes: 0,
      gatewayPods: 4,
      pendingGatewayPods: 1,
      now: 1_700_000_000_000,
    });

    const out = renderMetrics();

    expect(out).toContain('glm_disruption_observations_total{cause="node_shutdown_unconfirmed",source="kubernetes_event",capacity_class="spot",namespace="octogee-test"} 1');
    expect(out).toContain('glm_disruption_nodes{capacity_class="spot"} 3');
    expect(out).toContain("glm_disruption_gateway_pods 4");
    expect(out).toContain("glm_disruption_pending_gateway_pods 1");
    expect(out).toContain("glm_disruption_last_observed_timestamp_seconds 1700000000.000");
  });

  it("counts Shared Barn maximum-capacity observations and exposes the last bounded snapshot", () => {
    recordSharedGatewayMaxCapacity({ assignmentCount: 15, hotMemberCount: 4 });
    recordSharedGatewayMaxCapacity({ assignmentCount: 16.8, hotMemberCount: 4.9 });

    const out = renderMetrics();

    expect(out).toContain("glm_shared_gateway_max_capacity_total 2");
    expect(out).toContain("glm_shared_gateway_assignment_count 16");
    expect(out).toContain("glm_shared_gateway_hot_members 4");
  });
});
