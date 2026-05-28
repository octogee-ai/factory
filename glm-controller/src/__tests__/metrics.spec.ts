import { afterEach, describe, expect, it } from "vitest";

import { recordReconcile, renderMetrics, resetMetrics } from "../metrics";

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
});
