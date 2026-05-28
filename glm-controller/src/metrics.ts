// Minimal Prometheus exposition for Cowboy (glm-controller). Hand-rolled (no
// prom-client dep) — the high-value signals are: is the fleet reconciler ticking
// and succeeding, and how often does it fail. Process metrics are deferred.
// Scraped at /metrics by the glm-controller ServiceMonitor.

let reconcileOk = 0;
let reconcileFail = 0;
let lastSuccessMs: number | null = null;

export function recordReconcile(result: "ok" | "fail", now: number = Date.now()): void {
  if (result === "ok") {
    reconcileOk += 1;
    lastSuccessMs = now;
  } else {
    reconcileFail += 1;
  }
}

export function resetMetrics(): void {
  reconcileOk = 0;
  reconcileFail = 0;
  lastSuccessMs = null;
}

export function renderMetrics(): string {
  const lastSuccessSec = lastSuccessMs == null ? 0 : lastSuccessMs / 1000;
  return [
    "# HELP glm_reconcile_total Fleet reconcile ticks by result.",
    "# TYPE glm_reconcile_total counter",
    `glm_reconcile_total{result="ok"} ${reconcileOk}`,
    `glm_reconcile_total{result="fail"} ${reconcileFail}`,
    "# HELP glm_reconcile_last_success_timestamp_seconds Unix time of the last successful reconcile tick.",
    "# TYPE glm_reconcile_last_success_timestamp_seconds gauge",
    `glm_reconcile_last_success_timestamp_seconds ${lastSuccessSec.toFixed(3)}`,
    "",
  ].join("\n");
}
