import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const verifier = resolve(import.meta.dirname, "../lib/gateway-capacity-placement.sh");
const verifyEnv = readFileSync(resolve(import.meta.dirname, "../verify-env.sh"), "utf8");
const temporaryDirectories: string[] = [];
const disposableComputeClassName = "octogee-gateway-test";
const sharedComputeClassName = "octogee-gateway-shared-test";

function gatewayClass(instance: string): "operator" | "shared" {
  return instance === "operator" ? "operator" : "shared";
}

function computeClassFor(instance: string): string {
  return gatewayClass(instance) === "shared"
    ? sharedComputeClassName
    : disposableComputeClassName;
}

function deployment(instance: string, overrides: Record<string, unknown> = {}) {
  const gatewayClassName = gatewayClass(instance);
  return {
    metadata: {
      name: `octogee-gateway-${instance}`,
      labels: {
        app: "octogee-gateway",
        "gateway-instance": instance,
        "gateway-class": gatewayClassName,
      },
    },
    spec: {
      template: {
        metadata: {
          labels: {
            app: "octogee-gateway",
            "gateway-instance": instance,
            "gateway-class": gatewayClassName,
          },
        },
        spec: {
          nodeSelector: { "cloud.google.com/compute-class": computeClassFor(instance) },
          ...overrides,
        },
      },
    },
  };
}

function pod(
  instance: string,
  nodeName = gatewayClass(instance) === "shared" ? `shared-node-${instance}` : "spot-node",
  overrides: Record<string, unknown> = {},
) {
  return {
    metadata: {
      name: `octogee-gateway-${instance}-abc`,
      labels: {
        app: "octogee-gateway",
        "gateway-instance": instance,
        "gateway-class": gatewayClass(instance),
      },
    },
    spec: {
      nodeName,
      nodeSelector: { "cloud.google.com/compute-class": computeClassFor(instance) },
      ...overrides,
    },
    status: { phase: "Running" },
  };
}

function computeClass(
  name: string,
  priorities: Array<Record<string, unknown>>,
  overrides: Record<string, unknown> = {},
) {
  const location = {
    zones: ["us-central1-a", "us-central1-b", "us-central1-c", "us-central1-f"],
    locationPolicy: "ANY",
  };
  return {
    metadata: { name },
    spec: {
      priorities: priorities.map((priority) => ({ ...priority, location })),
      autopilot: { enabled: true },
      activeMigration: { optimizeRulePriority: true },
      nodePoolAutoCreation: { enabled: true },
      whenUnsatisfiable: "DoNotScaleUp",
      ...overrides,
    },
  };
}

function disposableComputeClass(overrides: Record<string, unknown> = {}) {
  return computeClass(disposableComputeClassName, [
    { podFamily: "general-purpose", spot: true },
    { podFamily: "general-purpose", spot: false },
  ], overrides);
}

function sharedComputeClass(overrides: Record<string, unknown> = {}) {
  return computeClass(sharedComputeClassName, [
    { podFamily: "general-purpose", spot: false },
  ], overrides);
}

function node(name: string, computeClassName: string, spot: boolean, zone: string) {
  return {
    metadata: {
      name,
      labels: {
        "cloud.google.com/compute-class": computeClassName,
        "topology.kubernetes.io/zone": zone,
        ...(spot ? { "cloud.google.com/gke-spot": "true" } : {}),
      },
    },
  };
}

function pdb(instance: string, overrides: Record<string, unknown> = {}) {
  return {
    metadata: {
      name: `octogee-gateway-${instance}`,
      labels: { app: "octogee-gateway", "gateway-instance": instance },
    },
    spec: {
      maxUnavailable: 1,
      selector: {
        matchLabels: {
          app: "octogee-gateway",
          "gateway-instance": instance,
        },
      },
      ...overrides,
    },
  };
}

function sharedPdb(instance: string, overrides: Record<string, unknown> = {}) {
  return {
    metadata: {
      name: `shared-gateway-${instance}`,
      labels: { "app.kubernetes.io/name": "octogee" },
    },
    spec: {
      minAvailable: 1,
      unhealthyPodEvictionPolicy: "AlwaysAllow",
      selector: {
        matchLabels: {
          app: "octogee-gateway",
          "gateway-class": "shared",
          "gateway-instance": instance,
        },
      },
      ...overrides,
    },
  };
}

function legacySharedPoolPdb() {
  return {
    metadata: { name: "shared-gateway-pool" },
    spec: {
      minAvailable: 2,
      selector: {
        matchLabels: {
          app: "octogee-gateway",
          "gateway-class": "shared",
        },
        matchExpressions: [{
          key: "gateway-instance",
          operator: "In",
          values: ["shared-a", "shared-b"],
        }],
      },
    },
  };
}

function runPlacementCheck(fixtures: {
  deployments?: unknown;
  pods?: unknown;
  nodes?: unknown;
  pdbs?: unknown;
  computeClasses?: unknown;
}) {
  const directory = mkdtempSync(join(tmpdir(), "octogee-gateway-capacity-placement-"));
  temporaryDirectories.push(directory);
  const kubectl = join(directory, "kubectl");
  writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  *" get deployments "*) printf '%s' "$MOCK_DEPLOYMENTS" ;;
  *" get pods "*) printf '%s' "$MOCK_PODS" ;;
  *" get nodes "*) printf '%s' "$MOCK_NODES" ;;
  *" get poddisruptionbudgets "*) printf '%s' "$MOCK_PDBS" ;;
  *" get computeclasses"*) printf '%s' "$MOCK_COMPUTE_CLASSES" ;;
  *) printf 'unexpected kubectl invocation: %s\\n' "$*" >&2; exit 64 ;;
esac
`, { mode: 0o755 });

  return spawnSync(
    "bash",
    ["-c", 'source "$1"; octogee_verify_gateway_capacity_placement test-context test-ns', "--", verifier],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        MOCK_DEPLOYMENTS: JSON.stringify(fixtures.deployments ?? {
          items: [deployment("shared-a"), deployment("shared-b"), deployment("operator")],
        }),
        MOCK_PODS: JSON.stringify(fixtures.pods ?? {
          items: [pod("shared-a"), pod("shared-b"), pod("operator")],
        }),
        MOCK_NODES: JSON.stringify(fixtures.nodes ?? {
          items: [
            node("shared-node-shared-a", sharedComputeClassName, false, "us-central1-a"),
            node("shared-node-shared-b", sharedComputeClassName, false, "us-central1-b"),
            node("spot-node", disposableComputeClassName, true, "us-central1-c"),
          ],
        }),
        MOCK_PDBS: JSON.stringify(fixtures.pdbs ?? {
          items: [sharedPdb("shared-a"), sharedPdb("shared-b"), pdb("operator")],
        }),
        MOCK_COMPUTE_CLASSES: JSON.stringify(fixtures.computeClasses ?? {
          items: [disposableComputeClass(), sharedComputeClass()],
        }),
      },
    },
  );
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("gateway capacity placement verifier", () => {
  it("runs the live capacity policy check from the environment verifier", () => {
    expect(verifyEnv).toContain('source "$SCRIPT_DIR/lib/gateway-capacity-placement.sh"');
    expect(verifyEnv).toContain('header "5a. Gateway capacity placement"');
    expect(verifyEnv).toContain(
      'octogee_verify_gateway_capacity_placement "$K8S_CONTEXT" "$NAMESPACE"',
    );
  });

  it("accepts on-demand shared capacity and regional Spot-first owner-bound capacity", () => {
    const result = runPlacementCheck({});

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "gateway capacity placement verified: 3 Deployment(s), 2 shared on-demand pod(s), 0 owner-bound on-demand fallback pod(s)",
    );
  });

  it("rejects a shared deployment covered by a non-shared PDB", () => {
    const result = runPlacementCheck({
      pdbs: {
        items: [sharedPdb("shared-a"), sharedPdb("shared-b"), pdb("shared-a"), pdb("operator")],
      },
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "Deployment octogee-gateway-shared-a expected exactly one matching PDB, found 2",
    );
  });

  it("rejects the legacy pooled shared PDB", () => {
    const result = runPlacementCheck({
      pdbs: {
        items: [
          legacySharedPoolPdb(),
          pdb("operator"),
        ],
      },
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "expected 2 per-identity shared PDBs, found 1",
    );
  });

  it("rejects a shared PDB that blocks eviction of an unhealthy pod", () => {
    const result = runPlacementCheck({
      pdbs: {
        items: [
          sharedPdb("shared-a", { unhealthyPodEvictionPolicy: undefined }),
          sharedPdb("shared-b"),
          pdb("operator"),
        ],
      },
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "shared PDB shared-gateway-shared-a must always allow unhealthy pod eviction",
    );
  });

  it("accepts and reports an active on-demand fallback", () => {
    const result = runPlacementCheck({
      pods: { items: [pod("shared-a"), pod("operator", "on-demand-node")] },
      nodes: { items: [
        node("shared-node-shared-a", sharedComputeClassName, false, "us-central1-a"),
        node("on-demand-node", disposableComputeClassName, false, "us-central1-c"),
      ] },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("1 owner-bound on-demand fallback pod(s)");
    expect(result.stdout).toContain("octogee-gateway-operator-abc");
  });

  it("rejects a ComputeClass that does not explicitly enable Autopilot", () => {
    const result = runPlacementCheck({
      computeClasses: {
        items: [
          disposableComputeClass({ autopilot: { enabled: false } }),
          sharedComputeClass(),
        ],
      },
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      `ComputeClass ${disposableComputeClassName} must explicitly enable Autopilot`,
    );
  });

  it("rejects a broken fallback class, unsafe Deployment, PDB, or running pod", () => {
    const result = runPlacementCheck({
      deployments: {
        items: [
          deployment("shared-a", { nodeSelector: {} }),
          deployment("operator"),
        ],
      },
      pods: { items: [pod("shared-a", "wrong-class-node", { nodeSelector: {} })] },
      nodes: {
        items: [{
          metadata: {
            name: "wrong-class-node",
            labels: { "cloud.google.com/compute-class": "other" },
          },
        }],
      },
      pdbs: {
        items: [
          sharedPdb("shared-a", { minAvailable: 0 }),
          pdb("operator", { minAvailable: 1, maxUnavailable: undefined }),
        ],
      },
      computeClasses: {
        items: [
          disposableComputeClass({
            priorities: [{
              podFamily: "general-purpose",
              spot: true,
              location: { zones: ["us-central1-b"], locationPolicy: "BALANCED" },
            }],
            activeMigration: { optimizeRulePriority: false },
          }),
          sharedComputeClass(),
        ],
      },
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "Deployment octogee-gateway-shared-a must select a gateway ComputeClass",
    );
    expect(result.stdout).toContain(
      `ComputeClass ${disposableComputeClassName} must prefer regional Spot before on-demand`,
    );
    expect(result.stdout).toContain(
      `ComputeClass ${disposableComputeClassName} must actively migrate fallback nodes back to Spot`,
    );
    expect(result.stdout).toContain(
      "shared PDB for Deployment octogee-gateway-shared-a must set minAvailable=1",
    );
    expect(result.stdout).toContain(
      "PDB for Deployment octogee-gateway-operator must not set minAvailable",
    );
    expect(result.stdout).toContain(
      "PDB for Deployment octogee-gateway-operator must set maxUnavailable=1",
    );
    expect(result.stdout).toContain(
      "running pod octogee-gateway-shared-a-abc must retain the gateway ComputeClass selector",
    );
  });

  it("rejects shared gateways on Spot or on the same node", () => {
    const result = runPlacementCheck({
      pods: {
        items: [
          pod("shared-a", "shared-spot-node"),
          pod("shared-b", "shared-spot-node"),
          pod("operator"),
        ],
      },
      nodes: {
        items: [
          node("shared-spot-node", sharedComputeClassName, true, "us-central1-a"),
          node("spot-node", disposableComputeClassName, true, "us-central1-c"),
        ],
      },
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("shared gateway pod octogee-gateway-shared-a-abc must run on on-demand capacity");
    expect(result.stdout).toContain("shared gateway instances shared-a and shared-b share node shared-spot-node");
  });

  it("rejects shared gateways on different nodes in the same zone", () => {
    const result = runPlacementCheck({
      nodes: {
        items: [
          node("shared-node-shared-a", sharedComputeClassName, false, "us-central1-a"),
          node("shared-node-shared-b", sharedComputeClassName, false, "us-central1-a"),
          node("spot-node", disposableComputeClassName, true, "us-central1-c"),
        ],
      },
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "shared gateway instances shared-a and shared-b share zone us-central1-a",
    );
  });
});
