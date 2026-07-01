import { afterEach, describe, expect, it } from "vitest";

import {
  recordGatewayHealth,
  recordReconcile,
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
});
