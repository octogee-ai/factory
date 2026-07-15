import { Counter, Histogram, type Registry } from "prom-client";

export interface OpenClawControlMetricIdentity {
  gatewayId: string;
  revisionId: string;
  gatewayClass: string;
}

function labels(identity: OpenClawControlMetricIdentity): Record<string, string> {
  return {
    gateway_id: identity.gatewayId,
    revision_id: identity.revisionId,
    gateway_class: identity.gatewayClass,
  };
}

export function createOpenClawControlMetrics(registry: Registry) {
  const httpTotal = new Counter({
    name: "openclaw_dashboard_http_total",
    help: "OpenClaw Dashboard HTTP requests",
    labelNames: ["gateway_id", "revision_id", "gateway_class", "kind", "outcome"] as const,
    registers: [registry],
  });
  const httpDuration = new Histogram({
    name: "openclaw_dashboard_http_duration_seconds",
    help: "OpenClaw Dashboard HTTP request duration",
    labelNames: ["gateway_id", "revision_id", "gateway_class", "kind", "outcome"] as const,
    registers: [registry],
  });
  const wsTotal = new Counter({
    name: "openclaw_dashboard_ws_total",
    help: "OpenClaw Dashboard WebSocket lifecycle events",
    labelNames: ["gateway_id", "revision_id", "gateway_class", "event", "outcome"] as const,
    registers: [registry],
  });
  const sessionTotal = new Counter({
    name: "openclaw_dashboard_session_total",
    help: "OpenClaw Dashboard session broker outcomes",
    labelNames: ["gateway_id", "revision_id", "gateway_class", "operation", "outcome"] as const,
    registers: [registry],
  });
  const rpcTotal = new Counter({
    name: "openclaw_dashboard_rpc_total",
    help: "OpenClaw Dashboard RPC outcomes",
    labelNames: ["gateway_id", "revision_id", "gateway_class", "category", "outcome"] as const,
    registers: [registry],
  });
  const policyTotal = new Counter({
    name: "openclaw_dashboard_policy_total",
    help: "OpenClaw Dashboard policy denials",
    labelNames: ["gateway_id", "revision_id", "gateway_class", "reason"] as const,
    registers: [registry],
  });
  return {
    http(identity: OpenClawControlMetricIdentity, kind: string, outcome: string, durationSeconds: number) {
      const values = { ...labels(identity), kind, outcome };
      httpTotal.inc(values);
      httpDuration.observe(values, durationSeconds);
    },
    ws(identity: OpenClawControlMetricIdentity, event: string, outcome: string) {
      wsTotal.inc({ ...labels(identity), event, outcome });
    },
    session(identity: OpenClawControlMetricIdentity, operation: string, outcome: string) {
      sessionTotal.inc({ ...labels(identity), operation, outcome });
    },
    rpc(identity: OpenClawControlMetricIdentity, category: string, outcome: string) {
      rpcTotal.inc({ ...labels(identity), category, outcome });
    },
    policy(identity: OpenClawControlMetricIdentity, reason: string) {
      policyTotal.inc({ ...labels(identity), reason });
    },
  };
}

export type OpenClawControlMetrics = ReturnType<typeof createOpenClawControlMetrics>;
