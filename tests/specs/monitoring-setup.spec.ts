import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";

const root = resolve(__dirname, "../..");
const setupMonitoring = readFileSync(
  resolve(root, "scripts/setup-monitoring.sh"),
  "utf8",
);
const verifyMonitoring = readFileSync(
  resolve(root, "scripts/verify-monitoring.sh"),
  "utf8",
);
const setupMonitoringSecrets = readFileSync(
  resolve(root, "scripts/setup-monitoring-secrets.sh"),
  "utf8",
);
const setupMonitoringIap = readFileSync(
  resolve(root, "scripts/setup-monitoring-iap.sh"),
  "utf8",
);

function chart(path: string): string {
  return readFileSync(resolve(root, "helm/monitoring", path), "utf8");
}

function renderedDeployment(name: string): Record<string, unknown> {
  const rendered = execFileSync(
    "helm",
    [
      "template",
      "grafana",
      resolve(root, "helm/monitoring"),
      "--namespace",
      "monitoring",
      "--set-string",
      "platformComputeClass=octogee-platform-test-spot",
      "--set-string",
      "grafana.nodeSelector.cloud\\.google\\.com/compute-class=octogee-platform-test-spot",
    ],
    { encoding: "utf8" },
  );
  const deployment = parseAllDocuments(rendered)
    .map((document) => document.toJSON() as Record<string, unknown> | null)
    .find((document) =>
      document?.kind === "Deployment" &&
      (document.metadata as Record<string, unknown> | undefined)?.name === name,
    );
  if (!deployment) throw new Error(`Deployment ${name} did not render`);
  return deployment;
}

describe("monitoring setup", () => {
  it("adopts all first-party monitoring objects through one pinned Helm release", () => {
    expect(chart("Chart.yaml")).toContain("name: octogee-monitoring");
    expect(chart("Chart.yaml")).toContain("name: grafana");
    expect(chart("Chart.yaml")).toContain('version: "10.5.15"');
    expect(chart("Chart.lock")).toContain("grafana");
    expect(readFileSync(resolve(root, "helm/monitoring/charts/grafana-10.5.15.tgz")).length).toBeGreaterThan(0);

    expect(setupMonitoring).toContain('helm upgrade --install grafana "$REPO_DIR/helm/monitoring"');
    expect(setupMonitoring).toContain("--take-ownership");
    expect(setupMonitoring).not.toContain("kubectl apply -f");
    expect(setupMonitoring).not.toContain("kubectl create configmap");
    expect(setupMonitoringIap).toContain('setup-monitoring.sh" "${setup_args[@]}"');
    expect(setupMonitoringIap).not.toContain("kubectl apply -f");
    expect(setupMonitoringIap).not.toContain("gcloud compute addresses create");
  });

  it("passes the selected platform ComputeClass to monitoring Helm and rejects an active target without one", () => {
    expect(setupMonitoring).toContain('platformComputeClass=$TARGET_PLATFORM_COMPUTE_CLASS');
    expect(setupMonitoring).toContain('grafana.nodeSelector.cloud\\\\.google\\\\.com/compute-class=$TARGET_PLATFORM_COMPUTE_CLASS');
    expect(setupMonitoring).toContain("requires a platform ComputeClass");
  });

  it("uses the tested secret materializer instead of a workstation environment file", () => {
    expect(setupMonitoring).toContain("setup-monitoring-secrets.sh");
    expect(setupMonitoring).not.toContain("ENV_FILE=");
    expect(setupMonitoringSecrets).toContain("GRAFANA_ADMIN_PASSWORD-");
    expect(setupMonitoringSecrets).toContain("grafana-admin");
    expect(setupMonitoringSecrets).toContain('source_secret="grafana"');
    expect(setupMonitoringSecrets).toContain("--adopt-existing-secret");
    expect(setupMonitoringSecrets).toContain("--bootstrap-secret");
    expect(setupMonitoringSecrets).not.toContain(".env");
  });

  it("materializes the exact Grafana admin secret contract without exposing credentials", () => {
    const values = chart("values.yaml");
    const grafana = renderedDeployment("grafana");
    const containers = ((grafana.spec as { template: { spec: { containers: Array<{
      name: string;
      env?: Array<{ name: string; valueFrom?: { secretKeyRef?: unknown } }>;
    }> } } }).template.spec.containers);
    const server = containers.find((container) => container.name === "grafana");
    const secretRef = (name: string) => server?.env?.find((entry) => entry.name === name)?.valueFrom?.secretKeyRef;

    expect(values).toContain("userKey: admin-user");
    expect(values).toContain("passwordKey: admin-password");
    expect(secretRef("GF_SECURITY_ADMIN_USER")).toEqual({
      key: "admin-user",
      name: "grafana-admin",
    });
    expect(secretRef("GF_SECURITY_ADMIN_PASSWORD")).toEqual({
      key: "admin-password",
      name: "grafana-admin",
    });
    expect(setupMonitoringSecrets).toContain('GRAFANA_ADMIN_USER="admin"');
    expect(setupMonitoringSecrets).toContain('--from-literal=admin-user="$GRAFANA_ADMIN_USER"');
    expect(setupMonitoringSecrets).toContain(".data.admin-user");
    expect(setupMonitoringSecrets).not.toContain("set -x");
  });

  it("grants the dashboard sidecar only namespace-scoped ConfigMap access", () => {
    const values = chart("values.yaml");
    const dashboardReader = chart("templates/grafana-dashboard-reader.yaml");

    expect(values).toContain(
      "useExistingRole: octogee-monitoring-grafana-dashboard-reader",
    );
    expect(values).toContain("namespaced: true");
    expect(values).toContain("resource: configmap");
    expect(dashboardReader).toContain("kind: Role");
    expect(dashboardReader).not.toContain("kind: ClusterRole");
    expect(dashboardReader).toContain("namespace: {{ .Release.Namespace }}");
    expect(dashboardReader).toContain("resources: [\"configmaps\"]");
    expect(dashboardReader).not.toContain("secrets");
    expect(verifyMonitoring).toContain("role octogee-monitoring-grafana-dashboard-reader");
    expect(verifyMonitoring).toContain("rolebinding grafana");
  });

  it("keeps the GKE-owned singleton as the explicit verified patch exception", () => {
    expect(setupMonitoring).toMatch(/operatorconfig config -n gmp-public[\s\S]*--type=merge/);
    expect(setupMonitoring).toContain("gmp-collection-filter.json");
    expect(setupMonitoring).toContain("verify-monitoring.sh");
    expect(verifyMonitoring).toContain("gmp-public/config collection filter");
    expect(verifyMonitoring).toContain("metadata.annotations.meta\\.helm\\.sh/release-name");
    expect(verifyMonitoring).not.toContain("grep '^grafana-dash-' || true");
  });

  it("waits for the managed rule evaluator after Helm renders ClusterRules", () => {
    const release = setupMonitoring.indexOf(
      'helm upgrade --install grafana "$REPO_DIR/helm/monitoring"',
    );
    const evaluatorWait = setupMonitoring.indexOf(
      "deployment/rule-evaluator",
      release,
    );

    expect(release).toBeGreaterThan(-1);
    expect(evaluatorWait).toBeGreaterThan(release);
    expect(
      setupMonitoring.slice(evaluatorWait - 180, evaluatorWait + 180),
    ).toMatch(
      /kubectl wait[\s\S]*?--for=condition=Available[\s\S]*?--timeout=5m/,
    );
  });

  it("converges IAP without first deleting the existing protected endpoint", () => {
    expect(setupMonitoring).toContain("--iap) IAP_ENABLED=true");
    expect(setupMonitoring).toContain("--set iap.enabled=true");
    expect(setupMonitoringIap).toContain('setup_args=(--target="$TARGET_ID" --iap)');
    expect(setupMonitoringIap).not.toContain('helm upgrade grafana "$REPO_DIR/helm/monitoring"');
    expect(setupMonitoringIap).toContain('setup-monitoring.sh" "${setup_args[@]}"');
  });

  it("verifies every Helm-owned IAP resource when IAP is enabled", () => {
    expect(verifyMonitoring).toContain("--iap) IAP_ENABLED=true");
    expect(verifyMonitoring).toContain("backendconfig grafana-iap");
    expect(verifyMonitoring).toContain("service grafana-nodeport");
    expect(verifyMonitoring).toContain("managedcertificate grafana-cert");
    expect(verifyMonitoring).toContain("ingress grafana");
    expect(verifyMonitoring).toContain("networking\\.gke\\.io/managed-certificates");
    expect(verifyMonitoring).toContain("compute backend-services describe");
    expect(verifyMonitoring).toContain("iap_policy_grants_principal");
    expect(verifyMonitoring).toContain("is_expected_iap_redirect");
  });

  it("renders Grafana for Restricted PSA without a root ownership init container", () => {
    const rendered = execFileSync(
      "helm",
      [
        "template",
        "grafana",
        resolve(root, "helm/monitoring"),
        "--namespace",
        "monitoring",
        "--set-string",
        "platformComputeClass=octogee-platform-test-spot",
        "--set-string",
        "grafana.nodeSelector.cloud\\.google\\.com/compute-class=octogee-platform-test-spot",
      ],
      { encoding: "utf8" },
    );
    const values = chart("values.yaml");

    expect(rendered).not.toContain("init-chown-data");
    expect(rendered).toContain("fsGroupChangePolicy: OnRootMismatch");
    expect(rendered).toContain("runAsNonRoot: true");
    expect(rendered).toContain("replicas: 1");
    expect(rendered).toContain("app.kubernetes.io/part-of: octogee-monitoring");
    expect(values).toContain("initChownData:");
    expect(values).toContain("enabled: false");
    expect(values).toContain("replicas: 1");
    expect(values).not.toContain("replicaCount:");
    expect(values).not.toContain("commonLabels:");
    expect(verifyMonitoring).toContain("kubectl exec deployment/grafana");
    expect(verifyMonitoring).toContain("test -w /var/lib/grafana");
  });

  it("places every monitoring workload on the target platform ComputeClass", () => {
    const expectedSelector = {
      "cloud.google.com/compute-class": "octogee-platform-test-spot",
      "kubernetes.io/os": "linux",
    };

    for (const name of ["grafana", "gmp-frontend", "gmp-kube-state-metrics"]) {
      const spec = renderedDeployment(name).spec as {
        template: { spec: { nodeSelector: Record<string, string> } };
      };
      expect(spec.template.spec.nodeSelector).toEqual(expectedSelector);
    }
  });
});
