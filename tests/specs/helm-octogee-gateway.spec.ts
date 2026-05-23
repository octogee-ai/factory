

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

spawnSync("helm", ["template", "warmup", CHART_PATH, "--set", "gatewayId=warmup", "--set", "instanceName=warmup", "--set", "imageTag=warmup", "--set", "env.mmSiteUrl=https://example.com", "--set", "env.mmInternalUrl=http://example", "--set", "env.chatProxyPublicUrl=https://example.com"], { encoding: "utf-8" });
}, 60_000);

const REQUIRED_VALUES: Record<string, string> = {
  gatewayId: "gw-test",
  instanceName: "default",
  imageTag: "abc1234",
  "env.mmSiteUrl": "https://mm-test.example.com",
  "env.mmInternalUrl": "http://mattermost.octogee-test.svc.cluster.local:8065",
  "env.chatProxyPublicUrl": "https://chat-test.octogee.com",
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

  it("wires the activity-bridge broadcast env vars on the gateway container (Appendix A anti-recurrence: the env var was the silent killer)", () => {
    const dep = findDoc(helmTemplate(), "Deployment", "octogee-gateway-default");
    expect(dep).not.toBeNull();
    expect(dep).toMatch(/name:\s*OPENCLAW_BROADCAST_ALL_AGENT_RUNS/);

expect(dep).toMatch(/name:\s*OPENCLAW_BROADCAST_DIAGNOSTIC_EVENTS/);
  });

  it("every doc starts with `apiVersion:` (regression: requireIdentity helper used to leak its values onto the first line)", () => {

const out = helmTemplate();
    const docs = out.split(/^---\s*$/m).map((d) => d.trim()).filter(Boolean);
    for (const doc of docs) {
      
      const firstNonComment = doc
        .split("\n")
        .find((line) => line.trim() && !line.trim().startsWith("#"));
      if (!firstNonComment) continue;
      expect(firstNonComment).toMatch(/^apiVersion:/);
    }
  });

  it("renders the per-instance Service octogee-gateway-<instanceName>", () => {
    const out = helmTemplate();
    const svc = findDoc(out, "Service", "octogee-gateway-default");
    expect(svc).not.toBeNull();
    expect(svc).toMatch(/gateway-instance:\s*default/);
  });

  it("renders the gateway-edge-<instanceName> alias Service", () => {
    const out = helmTemplate();
    const svc = findDoc(out, "Service", "gateway-edge-default");
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
    expect(findDoc(out, "Service", "gateway-edge-canary")).not.toBeNull();
  });
});

describe("helm/octogee-gateway/ — bundle image-tag inheritance", () => {
  it("inherits gateway + gateway-edge images from one imageTag field by default", () => {
    const out = helmTemplate("octogee-gw-default", { imageTag: "cafef00d" });
    const dep = findDoc(out, "Deployment", "octogee-gateway-default") ?? "";

const gatewayBlock = dep.match(/- name:\s*gateway[\s\S]*?(?=\n {8}- name:|\n {6}volumes:)/);
    const wsApiBlock = dep.match(/- name:\s*gateway-edge[\s\S]*?(?=\n {8}- name:|\n {6}volumes:)/);
    expect(gatewayBlock?.[0]).toMatch(/image:\s*"[^"]*octogee-gateway:cafef00d"/);
    expect(wsApiBlock?.[0]).toMatch(/image:\s*"[^"]*gateway-edge:cafef00d"/);
    expect(dep).not.toMatch(/octogee-chat-proxy/);
  });

  it("per-image override beats imageTag (escape hatch for hotfix)", () => {
    const out = helmTemplate("octogee-gw-default", {
      imageTag: "abc1234",
      "gatewayEdge.image.tag": "hotfix-ge-99",
    });
    const dep = findDoc(out, "Deployment", "octogee-gateway-default") ?? "";
    const ge = dep.match(/- name:\s*gateway-edge[\s\S]*?(?=\n {8}- name:|\n {6}volumes:)/);
    expect(ge?.[0]).toMatch(/image:\s*"[^"]*gateway-edge:hotfix-ge-99"/);
    
    const gw = dep.match(/- name:\s*gateway[\s\S]*?(?=\n {8}- name:|\n {6}volumes:)/);
    expect(gw?.[0]).toMatch(/image:\s*"[^"]*octogee-gateway:abc1234"/);
  });
});

describe("helm/octogee-gateway/ — gateway-edge sidecar (chat-proxy folded in)", () => {
  it("renders gateway + gateway-edge containers; no separate chat-proxy container", () => {
    const out = helmTemplate();
    const dep = findDoc(out, "Deployment", "octogee-gateway-default") ?? "";
    expect(dep).toMatch(/- name:\s*gateway/);
    expect(dep).toMatch(/- name:\s*gateway-edge/);
    expect(dep).not.toMatch(/- name:\s*chat-proxy\b/);
  });

  it("gateway-edge container exposes one port (chat-proxy folded onto 3001) — no separate chat/metrics ports", () => {
    const out = helmTemplate();
    const dep = findDoc(out, "Deployment", "octogee-gateway-default") ?? "";
    const ge = dep.match(/- name:\s*gateway-edge[\s\S]*?(?=\n {8}- name:|\n {6}volumes:)/);
    expect(ge?.[0]).toMatch(/name:\s*gateway-edge/);

expect(ge?.[0]).not.toMatch(/name:\s*chat-proxy/);
    expect(ge?.[0]).not.toMatch(/name:\s*cp-metrics/);
  });

  it("gateway-edge sidecar exposes port 3001 and probes /health", () => {
    const out = helmTemplate();
    const dep = findDoc(out, "Deployment", "octogee-gateway-default") ?? "";
    const wsBlock =
      dep.match(/- name:\s*gateway-edge[\s\S]*?(?=\n {8}- name:|\n {6}volumes:)/)?.[0] ?? "";
    expect(wsBlock).toMatch(/containerPort:\s*3001/);
    expect(wsBlock).toMatch(/path:\s*\/health/);
  });

  it("gateway-edge sidecar wires every secret from the chart's secrets list", () => {
    const out = helmTemplate();
    const dep = findDoc(out, "Deployment", "octogee-gateway-default") ?? "";
    const wsBlock =
      dep.match(/- name:\s*gateway-edge[\s\S]*?(?=\n {8}- name:|\n {6}volumes:)/)?.[0] ?? "";

expect(wsBlock).toMatch(/INTERNAL_SERVICE_KEY/);
    expect(wsBlock).toMatch(/STRIPE_SECRET_KEY/);
    expect(wsBlock).toMatch(/MM_ADMIN_TOKEN/);
    expect(wsBlock).toMatch(/GITEA_TOKEN/);
    // GITHUB_TOKEN intentionally NOT in the platform chart — it comes
    // from per-customer client secrets, not from a shared K8s secret.
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

  it("renders an init container that runs as root to seed + chown /home/node (operator pet-home parity)", () => {
    const out = helmTemplate();
    const dep = findDoc(out, "Deployment", "octogee-gateway-default") ?? "";
    expect(dep).toMatch(/initContainers:[\s\S]*?- name:\s*fix-perms/);
    expect(dep).toMatch(/runAsUser:\s*0[\s\S]*?runAsNonRoot:\s*false/);

expect(dep).toMatch(/cp -an \/etc\/skel\/\. \/home\/node\//);
    expect(dep).toMatch(/chown -R 1000:1000 \/home\/node\b/);
    expect(dep).not.toMatch(/chown -R 1000:1000 \/home\/node\/\.openclaw\b/);
  });

  it("mounts the data PVC at /home/node (the whole operator home, not just .openclaw)", () => {
    const out = helmTemplate();
    const dep = findDoc(out, "Deployment", "octogee-gateway-default") ?? "";

const dataMounts = dep.match(/- name:\s*data\s+mountPath:\s*\/home\/node\b/g) ?? [];
    expect(dataMounts.length).toBe(3);
    expect(dep).not.toMatch(/mountPath:\s*\/home\/node\/\.openclaw\b/);
  });

  it("NPM_CONFIG_CACHE points at /home/node/.npm-cache (conventional home location)", () => {
    const out = helmTemplate();
    const dep = findDoc(out, "Deployment", "octogee-gateway-default") ?? "";
    expect(dep).toMatch(
      /- name:\s*NPM_CONFIG_CACHE[\s\S]*?value:\s*"\/home\/node\/\.npm-cache"/,
    );
  });

  it("startup probe is HTTP GET /healthz; liveness + readiness stay TCP; all on 18789", () => {
    const out = helmTemplate();
    const dep = findDoc(out, "Deployment", "octogee-gateway-default") ?? "";
    const gw =
      dep.match(/- name:\s*gateway[\s\S]*?(?=\n {8}- name:|\n {6}volumes:)/)?.[0] ??
      "";

expect(gw).toMatch(
      /startupProbe:\s+httpGet:\s+path:\s*\/healthz\s+port:\s*18789/,
    );
    expect(gw).toMatch(/livenessProbe:\s+tcpSocket:\s+port:\s*18789/);
    expect(gw).toMatch(/readinessProbe:\s+tcpSocket:\s+port:\s*18789/);
    expect(dep).not.toMatch(/__openclaw__/);
  });
});

describe("helm/octogee-gateway/ — profile-aware credential injection", () => {
  it("injects ANTHROPIC_API_KEY on the gateway container for the standard profile (default, zero-regression)", () => {
    const dep = findDoc(helmTemplate(), "Deployment", "octogee-gateway-default");
    expect(dep).not.toBeNull();
    expect(dep).toMatch(/name:\s*ANTHROPIC_API_KEY\b/);
  });

  it("injects ANTHROPIC_API_KEY when profile is explicitly standard", () => {
    const dep = findDoc(
      helmTemplate("octogee-gw-default", { profile: "standard" }),
      "Deployment",
      "octogee-gateway-default",
    );
    expect(dep).not.toBeNull();
    expect(dep).toMatch(/name:\s*ANTHROPIC_API_KEY\b/);
  });

  it("OMITS ANTHROPIC_API_KEY when profile is operator (operator uses `claude auth login` instead)", () => {
    const dep = findDoc(
      helmTemplate("octogee-gw-default", { profile: "operator" }),
      "Deployment",
      "octogee-gateway-default",
    );
    expect(dep).not.toBeNull();
    expect(dep).not.toMatch(/name:\s*ANTHROPIC_API_KEY\b/);
  });

  it("keeps the Mattermost + Gitea platform tokens for ALL profiles (chat-proxy + gateway-edge need them)", () => {
    const dep = findDoc(
      helmTemplate("octogee-gw-default", { profile: "operator" }),
      "Deployment",
      "octogee-gateway-default",
    );
    expect(dep).not.toBeNull();
    expect(dep).toMatch(/name:\s*MM_BOT_TOKEN\b/);
    expect(dep).toMatch(/name:\s*GIT_API_TOKEN\b/);
  });

  it("threads the chart's profile through to the gateway container as GATEWAY_PROFILE so the entrypoint can gate operator-only boot steps", () => {
    const operatorDep =
      findDoc(
        helmTemplate("octogee-gw-default", { profile: "operator" }),
        "Deployment",
        "octogee-gateway-default",
      ) ?? "";
    expect(operatorDep).toMatch(
      /- name:\s*GATEWAY_PROFILE[\s\S]*?value:\s*"operator"/,
    );

const cattleDep = findDoc(helmTemplate(), "Deployment", "octogee-gateway-default") ?? "";
    expect(cattleDep).toMatch(/- name:\s*GATEWAY_PROFILE[\s\S]*?value:\s*""/);
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

describe("helm/octogee-gateway/ — per-instance persistence + security knobs", () => {
  it("default instance stays cattle: emptyDir, no PVC, locked-down securityContext", () => {
    const out = helmTemplate();
    const dep = findDoc(out, "Deployment", "octogee-gateway-default") ?? "";
    expect(dep).toMatch(/emptyDir:\s*\{\}/);
    expect(dep).toMatch(/allowPrivilegeEscalation:\s*false/);
    expect(dep).toMatch(/drop:\s*\n\s*-\s*ALL/);
    expect(
      findDoc(out, "PersistentVolumeClaim", "octogee-gateway-default-data"),
    ).toBeNull();
  });

  it("persistence.enabled renders a PVC that survives `helm uninstall` (pet volume must not be reclaimed)", () => {
    const out = helmTemplate("octogee-gw-bender", {
      gatewayId: "gw-bender",
      instanceName: "bender",
      "persistence.enabled": "true",
    });
    const pvc = findDoc(out, "PersistentVolumeClaim", "octogee-gateway-bender-data");
    expect(pvc).not.toBeNull();
    expect(pvc).toMatch(/helm\.sh\/resource-policy"?:\s*"?keep/);
    const dep = findDoc(out, "Deployment", "octogee-gateway-bender") ?? "";
    expect(dep).toMatch(
      /persistentVolumeClaim:\s*\n\s*claimName:\s*"?octogee-gateway-bender-data/,
    );
  });

  it("gatewayContainerSecurityContext override elevates one instance without touching the default", () => {
    const out = helmTemplate("octogee-gw-bender", {
      gatewayId: "gw-bender",
      instanceName: "bender",
      "gatewayContainerSecurityContext.allowPrivilegeEscalation": "true",
    });
    const dep = findDoc(out, "Deployment", "octogee-gateway-bender") ?? "";
    expect(dep).toMatch(/allowPrivilegeEscalation:\s*true/);
  });
});

function splitNetworkPolicyRules(np: string): { restricted: string; open: string } {
  const fromIdx = np.indexOf("- from:");
  const openIdx = np.indexOf("\n    - ports:", fromIdx);
  if (fromIdx === -1 || openIdx === -1) {
    throw new Error(`NetworkPolicy structure unexpected — fromIdx=${fromIdx} openIdx=${openIdx}`);
  }
  return { restricted: np.slice(fromIdx, openIdx), open: np.slice(openIdx) };
}

describe("helm/octogee-gateway/ — operator-profile NetworkPolicy port allowlist", () => {
  it("restricts :3005 (builder-shell) to same-instance pods — the backstop intent", () => {
    const np = findDoc(
      helmTemplate("octogee-gw-default", { profile: "operator" }),
      "NetworkPolicy",
      "octogee-gateway-builder-shell-default",
    );
    expect(np).not.toBeNull();
    const { restricted } = splitNetworkPolicyRules(np!);
    expect(restricted).toMatch(/podSelector:[\s\S]*?gateway-instance:\s*default/);
    expect(restricted).toMatch(/port:\s*3005/);
    expect(restricted).not.toMatch(/port:\s*3003/);
  });

  it("allows other pod ports from any source — listed in a rule WITHOUT `from:` so the LB / sibling workloads / Prometheus can reach them", () => {
    const np = findDoc(
      helmTemplate("octogee-gw-default", { profile: "operator" }),
      "NetworkPolicy",
      "octogee-gateway-builder-shell-default",
    );
    expect(np).not.toBeNull();
    const { open } = splitNetworkPolicyRules(np!);
    
    expect(open).not.toMatch(/from:/);

expect(open).toMatch(/port:\s*3003/);

expect(open).toMatch(/port:\s*3001/);

expect(open).not.toMatch(/port:\s*8080/);
    expect(open).not.toMatch(/port:\s*9092/);
    
    expect(open).toMatch(/port:\s*9080/);
    
    expect(open).toMatch(/port:\s*9091/);

expect(open).toMatch(/port:\s*18789/);
  });

  it("is NOT rendered for standard-profile gateways (cattle don't expose :3005 so no backstop needed)", () => {
    const out = helmTemplate();
    expect(findDoc(out, "NetworkPolicy", "octogee-gateway-builder-shell-default")).toBeNull();
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
