// Minimal Prometheus exposition for Cowboy (glm-controller). Hand-rolled (no
// prom-client dep) — the high-value signals are: is the fleet reconciler ticking
// and succeeding, and how often does it fail. Process metrics are deferred.
// Scraped at /metrics by the glm-controller ServiceMonitor.

let reconcileOk = 0;
let reconcileFail = 0;
let lastSuccessMs: number | null = null;
let gatewayHealth: GatewayHealthSample[] = [];
const configRoll = new Map<string, number>();

export type ConfigRollStage = "checkpoint" | "proof" | "unfreeze";
export type ConfigRollResult = "ok" | "fail";

export interface ConfigRollSample {
  stage: ConfigRollStage;
  result: ConfigRollResult;
  gatewayId: string;
  revisionId: string;
}

export interface GatewayHealthSample {
  gatewayId: string;
  availableReplicas: number;
}

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
  gatewayHealth = [];
  configRoll.clear();
}

export function recordConfigRoll(sample: ConfigRollSample): void {
  const key = [sample.gatewayId, sample.revisionId, sample.stage, sample.result].join("\0");
  configRoll.set(key, (configRoll.get(key) ?? 0) + 1);
}

export function recordGatewayHealth(samples: GatewayHealthSample[]): void {
  gatewayHealth = samples.map((sample) => ({
    gatewayId: sample.gatewayId,
    availableReplicas: Math.max(0, Math.trunc(sample.availableReplicas)),
  }));
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
    "# HELP glm_gateway_available_replicas Available Kubernetes replicas for each desired-running gateway.",
    "# TYPE glm_gateway_available_replicas gauge",
    ...gatewayHealth.map(
      (sample) =>
        `glm_gateway_available_replicas{gateway_id="${escapeLabel(sample.gatewayId)}"} ${sample.availableReplicas}`,
    ),
    "# HELP glm_gateway_desired_running_unavailable Desired-running gateway has no available Kubernetes replica.",
    "# TYPE glm_gateway_desired_running_unavailable gauge",
    ...gatewayHealth.map(
      (sample) =>
        `glm_gateway_desired_running_unavailable{gateway_id="${escapeLabel(sample.gatewayId)}"} ${
          sample.availableReplicas > 0 ? 0 : 1
        }`,
    ),
    "# HELP glm_config_roll_total Durable config roll fencing outcomes.",
    "# TYPE glm_config_roll_total counter",
    ...[...configRoll.entries()].map(([key, count]) => {
      const [gatewayId, revisionId, stage, result] = key.split("\0");
      return `glm_config_roll_total{gateway_id="${escapeLabel(gatewayId)}",revision_id="${escapeLabel(revisionId)}",stage="${stage}",result="${result}"} ${count}`;
    }),
    "",
  ].join("\n");
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}
