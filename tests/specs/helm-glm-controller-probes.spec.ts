import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { findDoc, useUmbrellaChart } from "./helpers/umbrella-chart";

const chart = useUmbrellaChart("octogee-glm-probes-");

type Probe = { timeoutSeconds?: number; periodSeconds?: number; failureThreshold?: number };

function probes(): Record<string, Probe> {
  const rendered = findDoc(chart.helmTemplate({ values: "test" }), "Deployment", "glm-controller");
  if (!rendered) throw new Error("glm-controller Deployment not found in rendered chart");
  const doc = parse(rendered) as {
    spec: {
      template: {
        spec: {
          containers: Array<{
            livenessProbe?: Probe;
            readinessProbe?: Probe;
            startupProbe?: Probe;
          }>;
        };
      };
    };
  };
  const container = doc.spec.template.spec.containers[0]!;
  return {
    liveness: container.livenessProbe ?? {},
    readiness: container.readinessProbe ?? {},
    startup: container.startupProbe ?? {},
  };
}

// A convergence pass holds the fleet controller's event loop for seconds — one measured at
// 11.9s over the shared pool — so /healthz cannot answer inside kubelet's 1s
// default. When it could not, liveness killed the controller mid-reconcile and
// orphaned whatever operation it had claimed, leaving rollouts "running" with
// no worker.
const MEASURED_RECONCILE_SECONDS = 12;

describe("glm-controller health probes", () => {
  it("gives every probe more than kubelet's 1s default", () => {
    for (const [name, probe] of Object.entries(probes())) {
      expect(probe.timeoutSeconds, `${name} probe timeoutSeconds`).toBeGreaterThan(1);
    }
  });

  it("survives a full reconcile before liveness restarts the controller", () => {
    const { liveness } = probes();
    const budgetSeconds =
      (liveness.timeoutSeconds ?? 1) * (liveness.failureThreshold ?? 1) +
      (liveness.periodSeconds ?? 0) * ((liveness.failureThreshold ?? 1) - 1);
    expect(budgetSeconds).toBeGreaterThan(MEASURED_RECONCILE_SECONDS);
  });
});
