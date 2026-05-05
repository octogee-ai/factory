// Tests the helm/octogee-gateway/ standalone chart — one helm release
// per gateway instance, owned by Cowboy. Replaces the old helm-gateway-
// instances + helm-multi-instance-routing + helm-workspace-api-sidecar
// suites that rendered the now-deleted gateway sub-chart of the umbrella.
import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";

const REPO_ROOT = path.resolve(__dirname, "../..");
const CHART_PATH = path.join(REPO_ROOT, "helm/octogee-gateway");

beforeAll(() => {
  if (!fs.existsSync(CHART_PATH)) {
    throw new Error(`octogee-gateway chart not found at ${CHART_PATH}`);
  }
});

const REQUIRED_VALUES: Record<string, string> = {
  gatewayId: "gw-test",
  instanceName: "default",
  imageTag: "abc1234",
  "env.mmSiteUrl": "https://mm-test.example.com",
};

function helmTemplate(
  releaseName = "octogee-gw-default",
  setValues: Record<string, string> = {},
): string {
  const args = [
    "template",
    releaseName,
    CHART_PATH,
    "--namespace=octogee-test",
  ];
  const merged = { ...REQUIRED_VALUES, ...setValues };
  for (const [k, v] of Object.entries(merged)) {
    args.push("--set", `${k}=${v}`);
  }
  const result = spawnSync("helm", args, { encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(
      `helm template failed (status=${result.status}):\n--- stderr ---\n${result.stderr}\n--- stdout ---\n${result.stdout}`,
    );
  }
  return result.stdout;
}

function findDoc(out: string, kind: string, name: string): string | null {
  const docs = out.split(/^---\s*$/m);
  return (
    docs.find((d) => {
      if (!new RegExp(`^kind:\\s*${kind}\\s*$`, "m").test(d)) return false;
      return new RegExp(`^  name:\\s*${name}\\s*$`, "m").test(d);
    }) ?? null
  );
}

describe("helm/octogee-gateway/ — single-instance rendering", () => {
  it("renders one Deployment named octogee-gateway-<instanceName>", () => {
    const out = helmTemplate();
    const dep = findDoc(out, "Deployment", "octogee-gateway-default");
    expect(dep).not.toBeNull();
  });

  it("renders the per-instance Service octogee-gateway-<instanceName>", () => {
    const out = helmTemplate();
    const svc = findDoc(out, "Service", "octogee-gateway-default");
    expect(svc).not.toBeNull();
    expect(svc).toMatch(/gateway-instance:\s*default/);
  });

  it("renders the workspace-api-<instanceName> alias Service", () => {
    const out = helmTemplate();
    const svc = findDoc(out, "Service", "workspace-api-default");
    expect(svc).not.toBeNull();
    expect(svc).toMatch(/gateway-instance:\s*default/);
  });

  it("renders a PodDisruptionBudget keyed by gateway-instance", () => {
    const out = helmTemplate();
    const pdb = findDoc(out, "PodDisruptionBudget", "octogee-gateway-default");
    expect(pdb).not.toBeNull();
    expect(pdb).toMatch(/gateway-instance:\s*default/);
  });

  it("does NOT render the umbrella's spanning resources (alias Service, Ingress, NetworkPolicy)", () => {
    const out = helmTemplate();
    expect(findDoc(out, "Service", "octogee-gateway")).toBeNull();
    expect(findDoc(out, "Ingress", "octogee-gateway-fleet-control-ingress")).toBeNull();
    expect(findDoc(out, "Ingress", "preview-ingress")).toBeNull();
    expect(findDoc(out, "NetworkPolicy", "gateway-egress")).toBeNull();
  });

  it("emits a different deployment name for a second instance", () => {
    const out = helmTemplate("octogee-gw-canary", {
      gatewayId: "gw-test-canary",
      instanceName: "canary",
    });
    expect(findDoc(out, "Deployment", "octogee-gateway-canary")).not.toBeNull();
    expect(findDoc(out, "Service", "octogee-gateway-canary")).not.toBeNull();
    expect(findDoc(out, "Service", "workspace-api-canary")).not.toBeNull();
  });
});

describe("helm/octogee-gateway/ — bundle image-tag inheritance", () => {
  it("inherits gateway, chat-proxy, workspace-api images from one imageTag field by default", () => {
    const out = helmTemplate("octogee-gw-default", { imageTag: "cafef00d" });
    const dep = findDoc(out, "Deployment", "octogee-gateway-default") ?? "";
    // Find each container block and assert the resolved image tag.
    const gatewayBlock = dep.match(/- name:\s*gateway[\s\S]*?(?=\n {8}- name:|\n {6}volumes:)/);
    const chatProxyBlock = dep.match(/- name:\s*chat-proxy[\s\S]*?(?=\n {8}- name:|\n {6}volumes:)/);
    const wsApiBlock = dep.match(/- name:\s*workspace-api[\s\S]*?(?=\n {8}- name:|\n {6}volumes:)/);
    expect(gatewayBlock?.[0]).toMatch(/image:\s*"[^"]*octogee-gateway:cafef00d"/);
    expect(chatProxyBlock?.[0]).toMatch(/image:\s*"[^"]*octogee-chat-proxy:cafef00d"/);
    expect(wsApiBlock?.[0]).toMatch(/image:\s*"[^"]*workspace-api:cafef00d"/);
  });

  it("per-image override beats imageTag (escape hatch for hotfix)", () => {
    const out = helmTemplate("octogee-gw-default", {
      imageTag: "abc1234",
      "chatProxy.image.tag": "hotfix-cp-99",
    });
    const dep = findDoc(out, "Deployment", "octogee-gateway-default") ?? "";
    const cp = dep.match(/- name:\s*chat-proxy[\s\S]*?(?=\n {8}- name:|\n {6}volumes:)/);
    expect(cp?.[0]).toMatch(/image:\s*"[^"]*octogee-chat-proxy:hotfix-cp-99"/);
    // gateway + workspace-api still use bundle SHA
    const gw = dep.match(/- name:\s*gateway[\s\S]*?(?=\n {8}- name:|\n {6}volumes:)/);
    expect(gw?.[0]).toMatch(/image:\s*"[^"]*octogee-gateway:abc1234"/);
  });
});

describe("helm/octogee-gateway/ — workspace-api sidecar (Phase 6.B collocation)", () => {
  it("renders workspace-api as a third sidecar inside the gateway pod", () => {
    const out = helmTemplate();
    const dep = findDoc(out, "Deployment", "octogee-gateway-default") ?? "";
    expect(dep).toMatch(/- name:\s*gateway/);
    expect(dep).toMatch(/- name:\s*chat-proxy/);
    expect(dep).toMatch(/- name:\s*workspace-api/);
  });

  it("workspace-api sidecar exposes port 3001 and probes /health", () => {
    const out = helmTemplate();
    const dep = findDoc(out, "Deployment", "octogee-gateway-default") ?? "";
    const wsBlock =
      dep.match(/- name:\s*workspace-api[\s\S]*?(?=\n {8}- name:|\n {6}volumes:)/)?.[0] ?? "";
    expect(wsBlock).toMatch(/containerPort:\s*3001/);
    expect(wsBlock).toMatch(/path:\s*\/health/);
  });

  it("workspace-api sidecar wires every secret from the chart's secrets list", () => {
    const out = helmTemplate();
    const dep = findDoc(out, "Deployment", "octogee-gateway-default") ?? "";
    const wsBlock =
      dep.match(/- name:\s*workspace-api[\s\S]*?(?=\n {8}- name:|\n {6}volumes:)/)?.[0] ?? "";
    // Spot-check a sample of required + optional secrets that the
    // factory (admin-fleet-router) and BYOT routes need.
    expect(wsBlock).toMatch(/INTERNAL_SERVICE_KEY/);
    expect(wsBlock).toMatch(/STRIPE_SECRET_KEY/);
    expect(wsBlock).toMatch(/MM_ADMIN_TOKEN/);
    expect(wsBlock).toMatch(/GITEA_TOKEN/);
    expect(wsBlock).toMatch(/GITHUB_TOKEN/);
  });
});

describe("helm/octogee-gateway/ — gateway container required env", () => {
  it("threads PREVIEW_HOST when preview.host is set (so test gateways advertise the right host)", () => {
    const out = helmTemplate("octogee-gw-default", {
      "preview.host": "preview-test.octogee.com",
    });
    const dep = findDoc(out, "Deployment", "octogee-gateway-default") ?? "";
    expect(dep).toMatch(/- name:\s*PREVIEW_HOST[\s\S]*?value:\s*"preview-test\.octogee\.com"/);
  });

  it("emits MM_INTERACTIONS_CALLBACK_BASE_URL pointing at the per-instance Service DNS", () => {
    const out = helmTemplate();
    const dep = findDoc(out, "Deployment", "octogee-gateway-default") ?? "";
    expect(dep).toMatch(
      /- name:\s*MM_INTERACTIONS_CALLBACK_BASE_URL[\s\S]*?value:[^\n]*octogee-gateway-default\.octogee-test\.svc\.cluster\.local:18789/,
    );
  });

  it("emits the MM_INTERACTIONS_ALLOWED_SOURCE_IPS pod CIDR allowlist", () => {
    const out = helmTemplate();
    const dep = findDoc(out, "Deployment", "octogee-gateway-default") ?? "";
    expect(dep).toMatch(/- name:\s*MM_INTERACTIONS_ALLOWED_SOURCE_IPS[\s\S]*?value:\s*"10\.117\.0\.0\/17"/);
  });

  it("renders an init container that runs as root to chown /home/node/.openclaw", () => {
    const out = helmTemplate();
    const dep = findDoc(out, "Deployment", "octogee-gateway-default") ?? "";
    expect(dep).toMatch(/initContainers:[\s\S]*?- name:\s*fix-perms/);
    expect(dep).toMatch(/runAsUser:\s*0[\s\S]*?runAsNonRoot:\s*false/);
    expect(dep).toMatch(/chown -R 1000:1000 \/home\/node\/\.openclaw/);
  });

  it("configures startup, liveness, and readiness probes on tcpSocket port 18789", () => {
    const out = helmTemplate();
    const dep = findDoc(out, "Deployment", "octogee-gateway-default") ?? "";
    expect(dep).toMatch(/startupProbe:[\s\S]*?tcpSocket:[\s\S]*?port:\s*18789/);
    expect(dep).toMatch(/livenessProbe:[\s\S]*?tcpSocket:[\s\S]*?port:\s*18789/);
    expect(dep).toMatch(/readinessProbe:[\s\S]*?tcpSocket:[\s\S]*?port:\s*18789/);
  });
});

describe("helm/octogee-gateway/ — per-instance Service annotations", () => {
  it("annotates the gateway Service with the per-port BackendConfig map", () => {
    const out = helmTemplate();
    const svc = findDoc(out, "Service", "octogee-gateway-default") ?? "";
    expect(svc).toMatch(/cloud\.google\.com\/backend-config/);
    expect(svc).toMatch(/9080":"preview-backend"/);
    expect(svc).toMatch(/3003":"octogee-gateway-fleet-control"/);
  });
});

describe("helm/octogee-gateway/ — required value validation", () => {
  it("fails to render when gatewayId is missing", () => {
    const args = [
      "template",
      "octogee-gw-broken",
      CHART_PATH,
      "--namespace=octogee-test",
      "--set",
      "instanceName=broken",
      "--set",
      "imageTag=abc",
      "--set",
      "env.mmSiteUrl=https://x",
    ];
    const result = spawnSync("helm", args, { encoding: "utf-8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/gatewayId/);
  });

  it("fails to render when instanceName is missing", () => {
    const args = [
      "template",
      "octogee-gw-broken",
      CHART_PATH,
      "--namespace=octogee-test",
      "--set",
      "gatewayId=gw-broken",
      "--set",
      "imageTag=abc",
      "--set",
      "env.mmSiteUrl=https://x",
    ];
    const result = spawnSync("helm", args, { encoding: "utf-8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/instanceName/);
  });
});
