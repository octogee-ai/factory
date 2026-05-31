

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

spawnSync("helm", ["template", "warmup", CHART_PATH, "--set", "gatewayId=warmup", "--set", "instanceName=warmup", "--set", "imageTag=warmup", "--set", "env.mmSiteUrl=https://example.com", "--set", "env.mmInternalUrl=http://example"], { encoding: "utf-8" });
}, 60_000);

const REQUIRED_VALUES: Record<string, string> = {
  gatewayId: "gw-test",
  instanceName: "default",
  imageTag: "abc1234",
  "env.mmSiteUrl": "https://mm-test.example.com",
  "env.mmInternalUrl": "http://mattermost.octogee-test.svc.cluster.local:8065",
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
      return new RegExp(`^  name:\\s*"?${name}"?\\s*$`, "m").test(d);
    }) ?? null
  );
}

function containerBlock(dep: string, name: string): string {
  return (
    dep.match(new RegExp(`- name:\\s*${name}[\\s\\S]*?(?=\\n {8}- name:|\\n {6}volumes:)`))?.[0] ??
    ""
  );
}

describe("helm/octogee-gateway/ — single-instance rendering", () => {
  it("renders one Deployment named octogee-gateway-<instanceName>", () => {
    const out = helmTemplate();
    const dep = findDoc(out, "Deployment", "octogee-gateway-default");
    expect(dep).not.toBeNull();
  });

  it("can render the generated per-operator ServiceAccount without a Workload Identity annotation", () => {
    const out = helmTemplate("octogee-gw-bender", {
      gatewayId: "gw-bender",
      instanceName: "bender",
      profile: "operator",
      "serviceAccount.create": "true",
    });
    const sa = findDoc(out, "ServiceAccount", "octogee-gw-bender");
    expect(sa).not.toBeNull();
    expect(sa).not.toMatch(/iam\.gke\.io\/gcp-service-account/);
    const dep = findDoc(out, "Deployment", "octogee-gateway-bender") ?? "";
    expect(dep).toMatch(/serviceAccountName:\s*octogee-gw-bender/);
  });

  it("operator profile does not inherit the shared platform ServiceAccount when Cowboy omits an override", () => {
    const out = helmTemplate("octogee-gw-bender", {
      gatewayId: "gw-bender",
      instanceName: "bender",
      profile: "operator",
    });
    const dep = findDoc(out, "Deployment", "octogee-gateway-bender") ?? "";

    expect(dep).toMatch(/serviceAccountName:\s*octogee-gw-bender/);
    expect(dep).not.toMatch(/serviceAccountName:\s*octogee-gateway\b/);
    expect(findDoc(out, "ServiceAccount", "octogee-gw-bender")).toBeNull();
  });

  it("disables the default Kubernetes ServiceAccount token automount", () => {
    const dep = findDoc(helmTemplate(), "Deployment", "octogee-gateway-default") ?? "";
    expect(dep).toMatch(/automountServiceAccountToken:\s*false/);
  });

  it("stamps gateway-profile labels so alias Services can exclude operator pods after rollout", () => {
    const standardDep = findDoc(helmTemplate(), "Deployment", "octogee-gateway-default") ?? "";
    expect(standardDep).toMatch(/gateway-profile:\s*"standard"/);

    const operatorDep =
      findDoc(
        helmTemplate("octogee-gw-default", { profile: "operator" }),
        "Deployment",
        "octogee-gateway-default",
      ) ?? "";
    expect(operatorDep).toMatch(/gateway-profile:\s*"operator"/);
  });

  it("standard profile mounts the octogee-api audience token into gateway and gateway-edge", () => {
    const dep = findDoc(helmTemplate(), "Deployment", "octogee-gateway-default") ?? "";
    const gw = containerBlock(dep, "gateway");
    const edge = containerBlock(dep, "gateway-edge");

    expect(gw).toMatch(/name:\s*octogee-api-sa-token\s*\n\s*mountPath:\s*\/var\/run\/secrets\/octogee-api\s*\n\s*readOnly:\s*true/);
    expect(edge).toMatch(/name:\s*octogee-api-sa-token\s*\n\s*mountPath:\s*\/var\/run\/secrets\/octogee-api\s*\n\s*readOnly:\s*true/);
    expect(dep).toMatch(/name:\s*octogee-api-sa-token\s*\n\s*projected:\s*\n\s*sources:\s*\n\s*-\s*serviceAccountToken:\s*\n\s*path:\s*token\s*\n\s*audience:\s*octogee-api\s*\n\s*expirationSeconds:\s*3600/);
  });

  it("operator profile keeps the octogee-api token file out of the shell-bearing gateway container", () => {
    const dep =
      findDoc(
        helmTemplate("octogee-gw-bender", {
          gatewayId: "gw-bender",
          instanceName: "bender",
          profile: "operator",
        }),
        "Deployment",
        "octogee-gateway-bender",
      ) ?? "";
    const gw = containerBlock(dep, "gateway");
    const edge = containerBlock(dep, "gateway-edge");

    expect(gw).not.toMatch(/mountPath:\s*\/var\/run\/secrets\/octogee-api/);
    expect(edge).toMatch(/name:\s*octogee-api-sa-token\s*\n\s*mountPath:\s*\/var\/run\/secrets\/octogee-api\s*\n\s*readOnly:\s*true/);
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

  it("exposes the runner-metrics port (9092) on the gateway container + Service (scraped by the octogee-gateway ServiceMonitor)", () => {
    const out = helmTemplate();
    const dep = findDoc(out, "Deployment", "octogee-gateway-default") ?? "";
    expect(dep).toMatch(/containerPort:\s*9092\s*\n\s*name:\s*runner-metrics/);
    const svc = findDoc(out, "Service", "octogee-gateway-default") ?? "";
    expect(svc).toMatch(/name:\s*runner-metrics\s*\n\s*port:\s*9092\s*\n\s*targetPort:\s*9092/);
  });

  it("does not expose builder-shell on locked operator gateways", () => {
    const out = helmTemplate("octogee-gw-default", { profile: "operator" });
    const dep = findDoc(out, "Deployment", "octogee-gateway-default") ?? "";
    const gw = containerBlock(dep, "gateway");
    expect(gw).not.toMatch(/name:\s*builder-shell/);
    expect(gw).toMatch(
      /- name:\s*OPERATOR_SHELLS_ENABLED[\s\S]*?value:\s*"false"/,
    );

    const svc = findDoc(out, "Service", "octogee-gateway-default") ?? "";
    expect(svc).not.toMatch(/name:\s*builder-shell/);
  });

  it("exposes builder-shell only after explicit operator shell access is enabled", () => {
    const out = helmTemplate("octogee-gw-default", {
      profile: "operator",
      "operatorAccess.shellsEnabled": "true",
    });
    const dep = findDoc(out, "Deployment", "octogee-gateway-default") ?? "";
    const gw = containerBlock(dep, "gateway");
    expect(gw).toMatch(/containerPort:\s*3005\s*\n\s*name:\s*builder-shell/);
    expect(gw).toMatch(
      /- name:\s*OPERATOR_SHELLS_ENABLED[\s\S]*?value:\s*"true"/,
    );
    expect(gw).toMatch(
      /- name:\s*BUILDER_SHELL_REQUIRE_KEY[\s\S]*?value:\s*"false"/,
    );
    expect(gw).not.toMatch(/name:\s*INTERNAL_SERVICE_KEY\b/);

    const svc = findDoc(out, "Service", "octogee-gateway-default") ?? "";
    expect(svc).toMatch(/name:\s*builder-shell\s*\n\s*port:\s*3005\s*\n\s*targetPort:\s*3005/);
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

  it("cattle gateway-edge sidecar wires every secret from the chart's secrets list", () => {
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

  it("operator gateway-edge sidecar omits platform secret refs but keeps the per-gateway token", () => {
    const out = helmTemplate("octogee-gw-default", {
      profile: "operator",
      "gatewayEdge.env.OCTOGEE_KMS_KEY_NAME": "projects/octogee/locations/us/keyRings/r/cryptoKeys/k",
    });
    const dep = findDoc(out, "Deployment", "octogee-gateway-default") ?? "";
    const wsBlock = containerBlock(dep, "gateway-edge");

    for (const name of [
      "INTERNAL_SERVICE_KEY",
      "STRIPE_SECRET_KEY",
      "MM_ADMIN_TOKEN",
      "GITEA_TOKEN",
      "MM_ADMIN_PAT",
      "OCTOGEE_APPROVAL_SIGNING_SECRET",
      "OCTOGEE_KMS_KEY_NAME",
    ]) {
      expect(wsBlock).not.toMatch(new RegExp(`name:\\s*${name}\\b`));
    }
    expect(wsBlock).toMatch(/name:\s*OPENCLAW_GATEWAY_TOKEN\b/);
  });

  it("cattle gateway-edge keeps KMS key config when set", () => {
    const out = helmTemplate("octogee-gw-default", {
      "gatewayEdge.env.OCTOGEE_KMS_KEY_NAME": "projects/octogee/locations/us/keyRings/r/cryptoKeys/k",
    });
    const dep = findDoc(out, "Deployment", "octogee-gateway-default") ?? "";
    const wsBlock = containerBlock(dep, "gateway-edge");
    expect(wsBlock).toMatch(/name:\s*OCTOGEE_KMS_KEY_NAME/);
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

  it("sets CLOUDSDK_CORE_PROJECT on the gateway container so gcloud cannot inherit the cluster host project", () => {
    const out = helmTemplate("octogee-gw-default", {
      "env.gcloudProject": "octogee-test",
    });
    const dep = findDoc(out, "Deployment", "octogee-gateway-default") ?? "";
    const gw = containerBlock(dep, "gateway");
    expect(gw).toMatch(
      /- name:\s*CLOUDSDK_CORE_PROJECT[\s\S]*?value:\s*"octogee-test"/,
    );
  });

  it("keeps MM_ADMIN_PAT out of the runtime gateway container (operator shells must not inherit platform MM admin)", () => {
    const dep = findDoc(helmTemplate(), "Deployment", "octogee-gateway-default") ?? "";
    const gw = containerBlock(dep, "gateway");
    expect(gw).not.toMatch(/- name:\s*MM_ADMIN_PAT\b/);
  });

  it("uses an init container for per-gateway Mattermost bot bootstrap, so the admin PAT is not present at shell runtime", () => {
    const dep = findDoc(helmTemplate(), "Deployment", "octogee-gateway-default") ?? "";
    const bootstrap = containerBlock(dep, "mac-ops-bootstrap");
    expect(bootstrap).toMatch(/node \/octogee\/scripts\/bootstrap-mac-ops\.mjs/);
    expect(bootstrap).toMatch(
      /- name:\s*MM_ADMIN_PAT[\s\S]*?name:\s*mattermost-gateway[\s\S]*?key:\s*admin_token[\s\S]*?optional:\s*true/,
    );
  });

  it("omits the Mattermost admin-PAT bootstrap init container on operator gateways", () => {
    const dep =
      findDoc(
        helmTemplate("octogee-gw-default", { profile: "operator" }),
        "Deployment",
        "octogee-gateway-default",
      ) ?? "";
    expect(dep).not.toMatch(/name:\s*mac-ops-bootstrap/);
    const init = dep.match(/initContainers:[\s\S]*?(?=\n {6}containers:)/)?.[0] ?? "";
    expect(init).not.toMatch(/name:\s*MM_ADMIN_PAT\b/);
    expect(init).not.toMatch(/name:\s*MM_BOT_TOKEN\b/);
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
    expect(dataMounts.length).toBe(4);
    expect(dep).not.toMatch(/mountPath:\s*\/home\/node\/\.openclaw\b/);
  });

  it("operator gateways mount the data PVC only on fix-perms, gateway, and gateway-edge", () => {
    const dep =
      findDoc(
        helmTemplate("octogee-gw-default", { profile: "operator" }),
        "Deployment",
        "octogee-gateway-default",
      ) ?? "";
    const dataMounts = dep.match(/- name:\s*data\s+mountPath:\s*\/home\/node\b/g) ?? [];
    expect(dataMounts.length).toBe(3);
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
      helmTemplate("octogee-gw-default", {
        profile: "operator",
        "gatewayEdge.env.OCTOGEE_KMS_KEY_NAME": "projects/octogee/locations/us/keyRings/r/cryptoKeys/k",
      }),
      "Deployment",
      "octogee-gateway-default",
    );
    expect(dep).not.toBeNull();
    expect(dep).not.toMatch(/name:\s*ANTHROPIC_API_KEY\b/);
  });

  it("keeps platform Mattermost + Gitea tokens on the standard gateway container", () => {
    const dep = findDoc(helmTemplate(), "Deployment", "octogee-gateway-default");
    expect(dep).not.toBeNull();
    const gw = containerBlock(dep ?? "", "gateway");
    expect(gw).toMatch(/name:\s*MM_BOT_TOKEN\b/);
    expect(gw).toMatch(/name:\s*GIT_API_TOKEN\b/);
  });

  it("omits platform tokens from operator gateway + gateway-edge containers", () => {
    const dep = findDoc(
      helmTemplate("octogee-gw-default", { profile: "operator" }),
      "Deployment",
      "octogee-gateway-default",
    );
    expect(dep).not.toBeNull();
    const gw = containerBlock(dep ?? "", "gateway");
    for (const name of [
      "FLEET_CONTROLLER_SECRET",
      "GIT_API_TOKEN",
      "BRAVE_API_KEY",
      "MM_BOT_TOKEN",
      "MM_ADMIN_USER",
      "MM_ADMIN_PASS",
      "MM_COMMUNITY_TEAM_ID",
      "MM_BOT_USER_ID",
      "MM_ADMIN_USER_ID",
      "DISCORD_OPS_WEBHOOK_URL",
      "INTERNAL_SERVICE_KEY",
      "ANTHROPIC_API_KEY",
    ]) {
      expect(gw).not.toMatch(new RegExp(`name:\\s*${name}\\b`));
    }
    const edge = containerBlock(dep ?? "", "gateway-edge");
    for (const name of [
      "MM_ADMIN_PAT",
      "OCTOGEE_APPROVAL_SIGNING_SECRET",
      "STRIPE_SECRET_KEY",
      "MM_ADMIN_TOKEN",
      "GITEA_TOKEN",
      "INTERNAL_SERVICE_KEY",
      "RESEND_API_KEY",
      "EMAIL_UNSUBSCRIBE_SECRET",
      "OCTOGEE_KMS_KEY_NAME",
    ]) {
      expect(edge).not.toMatch(new RegExp(`name:\\s*${name}\\b`));
    }
    expect(edge).toMatch(/name:\s*OPENCLAW_GATEWAY_TOKEN\b/);
  });

  it("threads the chart's profile through to gateway and gateway-edge containers", () => {
    const operatorDep =
      findDoc(
        helmTemplate("octogee-gw-default", { profile: "operator" }),
        "Deployment",
        "octogee-gateway-default",
      ) ?? "";
    const operatorGateway = containerBlock(operatorDep, "gateway");
    const operatorEdge = containerBlock(operatorDep, "gateway-edge");
    expect(operatorGateway).toMatch(
      /- name:\s*GATEWAY_PROFILE[\s\S]*?value:\s*"operator"/,
    );
    expect(operatorEdge).toMatch(
      /- name:\s*GATEWAY_PROFILE[\s\S]*?value:\s*"operator"/,
    );

const cattleDep = findDoc(helmTemplate(), "Deployment", "octogee-gateway-default") ?? "";
    const cattleGateway = containerBlock(cattleDep, "gateway");
    const cattleEdge = containerBlock(cattleDep, "gateway-edge");
    expect(cattleGateway).toMatch(/- name:\s*GATEWAY_PROFILE[\s\S]*?value:\s*""/);
    expect(cattleEdge).toMatch(/- name:\s*GATEWAY_PROFILE[\s\S]*?value:\s*""/);
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
      helmTemplate("octogee-gw-default", {
        profile: "operator",
        "operatorAccess.shellsEnabled": "true",
      }),
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
      helmTemplate("octogee-gw-default", {
        profile: "operator",
        "operatorAccess.shellsEnabled": "true",
      }),
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

  it("scopes runner-metrics (:9092) to the monitoring namespace only — never the open any-source rule", () => {
    const np = findDoc(
      helmTemplate("octogee-gw-default", {
        profile: "operator",
        "operatorAccess.shellsEnabled": "true",
      }),
      "NetworkPolicy",
      "octogee-gateway-builder-shell-default",
    );
    expect(np).not.toBeNull();
    const { restricted, open } = splitNetworkPolicyRules(np!);
    expect(restricted).toMatch(/namespaceSelector:[\s\S]*?kubernetes\.io\/metadata\.name:\s*monitoring/);
    expect(restricted).toMatch(/port:\s*9092/);
    expect(open).not.toMatch(/port:\s*9092/);
  });

  it("is NOT rendered for standard-profile gateways (cattle don't expose :3005 so no backstop needed)", () => {
    const out = helmTemplate();
    expect(findDoc(out, "NetworkPolicy", "octogee-gateway-builder-shell-default")).toBeNull();
  });

  it("is NOT rendered for locked operator gateways before tenant shell access is provisioned", () => {
    const out = helmTemplate("octogee-gw-default", { profile: "operator" });
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

  describe("env dedup — operator profile omits INTERNAL_SERVICE_KEY from the pod", () => {
    it("operator profile renders no INTERNAL_SERVICE_KEY entries because the pod is tenant-untrusted", () => {
      const operatorOut = helmTemplate("octogee-gw-bender", {
        gatewayId: "gw-bender",
        instanceName: "bender",
        profile: "operator",
      });
      const baselineOut = helmTemplate();
      const operatorDep = findDoc(
        operatorOut,
        "Deployment",
        "octogee-gateway-bender",
      );
      const baselineDep = findDoc(
        baselineOut,
        "Deployment",
        "octogee-gateway-default",
      );
      expect(operatorDep).not.toBeNull();
      expect(baselineDep).not.toBeNull();
      const count = (s: string): number =>
        (s.match(/name:\s*INTERNAL_SERVICE_KEY/g) ?? []).length;
      expect(count(operatorDep!)).toBe(0);
      expect(count(baselineDep!)).toBeGreaterThan(count(operatorDep!));
    });

    it("INTERNAL_SERVICE_KEY is absent from both operator containers", () => {
      const out = helmTemplate("octogee-gw-bender", {
        gatewayId: "gw-bender",
        instanceName: "bender",
        profile: "operator",
      });
      const dep = findDoc(out, "Deployment", "octogee-gateway-bender");
      expect(dep).not.toBeNull();
      const count = (dep!.match(/name:\s*INTERNAL_SERVICE_KEY/g) ?? []).length;
      expect(count).toBe(0);
      const gw = containerBlock(dep ?? "", "gateway");
      const edge = containerBlock(dep ?? "", "gateway-edge");
      expect(gw).not.toMatch(/name:\s*INTERNAL_SERVICE_KEY\b/);
      expect(edge).not.toMatch(/name:\s*INTERNAL_SERVICE_KEY\b/);
    });
  });
});

// ── Platform-owned OPENCLAW_GATEWAY_TOKEN ──────────────────────────────────
// Pre-#TBD the token was generated inside the pod by entrypoint.sh and
// mirrored to GCP Secret Manager. That left K8s/helm blind to it, so an
// agent's openclaw.json edit + a kubectl-set-env workaround for the gap on
// gateway-edge produced field-manager drift that silently dropped
// INTERNAL_SERVICE_KEY when #1159's dedup landed. New model: Cowboy creates
// a per-gateway K8s secret `gateway-auth-token-{gatewayId}` with a random
// value; the chart threads it via secretKeyRef on every container that
// needs it. Token is stable across reboots, helm-owned end to end.
describe("helm/octogee-gateway/ — OPENCLAW_GATEWAY_TOKEN platform-owned", () => {
  const SECRET_NAME = "gateway-auth-token-gw-test";

  function envBlock(dep: string, containerName: "gateway" | "gateway-edge"): string {
    return (
      dep.match(
        new RegExp(`- name:\\s*${containerName}[\\s\\S]*?(?=\\n {8}- name:|\\n {6}volumes:)`),
      )?.[0] ?? ""
    );
  }

  function initContainerBlock(dep: string): string {
    return dep.match(/initContainers:[\s\S]*?(?=\n {6}containers:)/)?.[0] ?? "";
  }

  function tokenEntry(block: string): string {
    // Slice the 8 lines starting at the OPENCLAW_GATEWAY_TOKEN env entry —
    // covers the entire `valueFrom: secretKeyRef: { name, key }` sub-block
    // without resorting to a wide-lookahead regex.
    const lines = block.split("\n");
    const idx = lines.findIndex((l) =>
      /- name:\s*OPENCLAW_GATEWAY_TOKEN\b/.test(l),
    );
    if (idx === -1) return "";
    return lines.slice(idx, idx + 8).join("\n");
  }

  it("renders OPENCLAW_GATEWAY_TOKEN via secretKeyRef on the gateway container (not a plain value)", () => {
    const dep = findDoc(helmTemplate(), "Deployment", "octogee-gateway-default") ?? "";
    const gw = envBlock(dep, "gateway");
    const entry = tokenEntry(gw);
    expect(entry).toMatch(/secretKeyRef:/);
    expect(entry).toMatch(new RegExp(`name:\\s*${SECRET_NAME}\\b`));
    expect(entry).toMatch(/key:\s*token\b/);
  });

  it("renders OPENCLAW_GATEWAY_TOKEN via secretKeyRef on the gateway-edge container (same secret — single source of truth)", () => {
    const dep = findDoc(helmTemplate(), "Deployment", "octogee-gateway-default") ?? "";
    const ge = envBlock(dep, "gateway-edge");
    const entry = tokenEntry(ge);
    expect(entry).toMatch(/secretKeyRef:/);
    expect(entry).toMatch(new RegExp(`name:\\s*${SECRET_NAME}\\b`));
    expect(entry).toMatch(/key:\s*token\b/);
  });

  it("renders OPENCLAW_GATEWAY_TOKEN via secretKeyRef on the fix-perms init container (so the PVC seed sees the same token the gateway will use)", () => {
    const dep = findDoc(helmTemplate(), "Deployment", "octogee-gateway-default") ?? "";
    const init = initContainerBlock(dep);
    const entry = tokenEntry(init);
    expect(entry).toMatch(/secretKeyRef:/);
    expect(entry).toMatch(new RegExp(`name:\\s*${SECRET_NAME}\\b`));
    expect(entry).toMatch(/key:\s*token\b/);
  });

  it("does NOT render OPENCLAW_GATEWAY_TOKEN as a plain `value:` anywhere (proves platform owns it via secretKeyRef, not entrypoint-generated)", () => {
    const dep = findDoc(helmTemplate(), "Deployment", "octogee-gateway-default") ?? "";
    expect(dep).not.toMatch(/name:\s*OPENCLAW_GATEWAY_TOKEN[\s\S]{0,80}\n\s+value:\s*[^\n]+/);
  });

  it("derives the secret name from gatewayId so operator and cattle gateways get distinct secrets", () => {
    const benderOut = helmTemplate("octogee-gw-bender", {
      gatewayId: "gw-bender",
      instanceName: "bender",
      profile: "operator",
    });
    const benderDep = findDoc(benderOut, "Deployment", "octogee-gateway-bender") ?? "";
    expect(benderDep).toMatch(/name:\s*gateway-auth-token-gw-bender\b/);
    expect(benderDep).not.toMatch(/name:\s*gateway-auth-token-gw-test\b/);
  });

  it("operator profile threads the same secret on the same three containers (no profile-specific drift)", () => {
    const dep =
      findDoc(
        helmTemplate("octogee-gw-default", { profile: "operator" }),
        "Deployment",
        "octogee-gateway-default",
      ) ?? "";
    const count = (dep.match(/name:\s*OPENCLAW_GATEWAY_TOKEN\b/g) ?? []).length;
    expect(count).toBe(3);
  });

  it("cattle profile threads the same secret on the same three containers (no profile-specific drift)", () => {
    const dep = findDoc(helmTemplate(), "Deployment", "octogee-gateway-default") ?? "";
    const count = (dep.match(/name:\s*OPENCLAW_GATEWAY_TOKEN\b/g) ?? []).length;
    expect(count).toBe(3);
  });
});

// ── GCP_PROJECT_ID on gateway-edge ─────────────────────────────────────────
// Pre-#TBD GCP_PROJECT_ID was only rendered on the `gateway` container; for
// gateway-edge an operator had to `kubectl set env` it in by hand, which
// created the kubectl-set field-manager ownership that broke #1159's dedup
// merge. The chart already has `gatewayEdge.env.GCP_PROJECT_ID` in
// defaults — pin that as a contract so a future trim doesn't silently
// remove it.
describe("helm/octogee-gateway/ — GCP_PROJECT_ID on gateway-edge", () => {
  it("renders GCP_PROJECT_ID on the gateway-edge container for cattle profile (no kubectl-set workaround needed)", () => {
    const dep = findDoc(helmTemplate(), "Deployment", "octogee-gateway-default") ?? "";
    const ge =
      dep.match(/- name:\s*gateway-edge[\s\S]*?(?=\n {8}- name:|\n {6}volumes:)/)?.[0] ?? "";
    expect(ge).toMatch(/- name:\s*GCP_PROJECT_ID[\s\S]*?value:\s*"octogee"/);
  });

  it("renders GCP_PROJECT_ID on the gateway-edge container for operator profile", () => {
    const dep =
      findDoc(
        helmTemplate("octogee-gw-default", { profile: "operator" }),
        "Deployment",
        "octogee-gateway-default",
      ) ?? "";
    const ge =
      dep.match(/- name:\s*gateway-edge[\s\S]*?(?=\n {8}- name:|\n {6}volumes:)/)?.[0] ?? "";
    expect(ge).toMatch(/- name:\s*GCP_PROJECT_ID/);
  });
});

// ── Profile-aware render-time assertions ───────────────────────────────────
// Cattle gateway-edge still requires INTERNAL_SERVICE_KEY at render time.
// Operator gateway-edge intentionally omits platform-scoped secrets; the
// profile-aware runtime boot check and builder-shell locality auth cover that
// path without a platform credential in the pod spec.
describe("helm/octogee-gateway/ — required-env render assertions", () => {
  function templateWithSecretsListReplaced(extra: Record<string, string> = {}): {
    status: number | null;
    stderr: string;
  } {
    const args = [
      "template",
      "octogee-gw-default",
      CHART_PATH,
      "--namespace=octogee-test",
      "--set",
      "gatewayId=gw-test",
      "--set",
      "instanceName=default",
      "--set",
      "imageTag=abc",
      "--set",
      "env.mmInternalUrl=http://x",
      "--set",
      "env.mmSiteUrl=https://x",
      // Replace gatewayEdge.secrets with a one-entry list missing INTERNAL_SERVICE_KEY.
      "--set-json",
      'gatewayEdge.secrets=[{"envName":"STRIPE_SECRET_KEY","secretName":"stripe-secrets","secretKey":"secret_key","optional":true}]',
    ];
    for (const [k, v] of Object.entries(extra)) args.push("--set", `${k}=${v}`);
    const result = spawnSync("helm", args, { encoding: "utf-8" });
    return { status: result.status, stderr: result.stderr };
  }

  it("renders operator profile when gatewayEdge.secrets omits INTERNAL_SERVICE_KEY", () => {
    const result = templateWithSecretsListReplaced({ profile: "operator" });
    expect(result.status).toBe(0);
  });

  it("fails to render when gatewayEdge.secrets omits INTERNAL_SERVICE_KEY (cattle profile)", () => {
    const result = templateWithSecretsListReplaced();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/INTERNAL_SERVICE_KEY/);
    expect(result.stderr).toMatch(/gatewayEdge\.secrets/);
  });
});

// ── values.schema.json defense-in-depth ────────────────────────────────────
// Helm validates values.schema.json before rendering — so structurally bad
// inputs (missing required top-level keys, wrong types) fail BEFORE template
// logic runs. This is layered defense alongside the render-time `required`
// helpers above: the schema catches shape errors, the helpers catch semantic
// ones.
describe("helm/octogee-gateway/ — values.schema.json", () => {
  it("rejects a values file with gatewayEdge.secrets as the wrong type", () => {
    const args = [
      "template",
      "octogee-gw-default",
      CHART_PATH,
      "--namespace=octogee-test",
      "--set",
      "gatewayId=gw-test",
      "--set",
      "instanceName=default",
      "--set",
      "imageTag=abc",
      "--set",
      "env.mmInternalUrl=http://x",
      "--set",
      "env.mmSiteUrl=https://x",
      "--set-json",
      'gatewayEdge.secrets="not-an-array"',
    ];
    const result = spawnSync("helm", args, { encoding: "utf-8" });
    expect(result.status).not.toBe(0);
    // helm's schema-validation error wording varies by version; tolerate either.
    expect(result.stderr).toMatch(/schema|values don't meet|validation/i);
  });

  it("rejects an empty profile when set to an unknown enum value (operator gateways have an explicit set of profiles)", () => {
    const args = [
      "template",
      "octogee-gw-default",
      CHART_PATH,
      "--namespace=octogee-test",
      "--set",
      "gatewayId=gw-test",
      "--set",
      "instanceName=default",
      "--set",
      "imageTag=abc",
      "--set",
      "env.mmInternalUrl=http://x",
      "--set",
      "env.mmSiteUrl=https://x",
      "--set",
      "profile=bogus-profile-name",
    ];
    const result = spawnSync("helm", args, { encoding: "utf-8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/schema|profile|enum/i);
  });
});

// ── Class-wide K8s schema invariant: env entries are EITHER value OR valueFrom ─
// K8s rejects any env entry with both `value` and `valueFrom` set:
//   "valueFrom: Invalid value: ...: may not be specified when value is not empty"
// A live PROD apply on 2026-05-24 (octogee-gw-bender helm rev 33) was
// rejected by K8s because a chart-render-vs-live-state strategic-merge
// collision combined kubectl-set-managed `value:` with helm-managed
// `valueFrom:` for the same env name. The chart itself rendered clean
// — the collision was in the apply, not the manifest. But the failure
// mode is easy to recreate from the chart side too (e.g. a future `if`
// branch that adds `valueFrom:` without unconditionally suppressing a
// sibling `value:` line). This guard walks every env entry across every
// container in every profile and fails loud at chart-render time,
// before anything reaches a cluster.
//
// Parse via real YAML rather than regex — env blocks are deeply nested
// and regex-walking miscounts (the original reproduce attempt did).
import { parseAllDocuments } from "yaml";

interface ContainerEnv {
  name?: string;
  value?: unknown;
  valueFrom?: unknown;
}

function collectAllEnvEntries(
  dep: string,
): Array<{ container: string; index: number; entry: ContainerEnv }> {
  const docs = parseAllDocuments(dep);
  const deployment = docs[0]?.toJS() as
    | { spec?: { template?: { spec?: Record<string, unknown> } } }
    | undefined;
  const podSpec = deployment?.spec?.template?.spec;
  if (!podSpec) throw new Error("findDoc returned a non-Deployment doc");

  const out: Array<{ container: string; index: number; entry: ContainerEnv }> = [];
  const sections: Array<[string, unknown]> = [
    ["initContainers", podSpec.initContainers],
    ["containers", podSpec.containers],
  ];
  for (const [section, rawContainers] of sections) {
    const containers = Array.isArray(rawContainers) ? rawContainers : [];
    for (const c of containers) {
      const cont = c as { name?: string; env?: unknown };
      const env = Array.isArray(cont.env) ? (cont.env as ContainerEnv[]) : [];
      env.forEach((entry, index) => {
        out.push({ container: `${section}/${cont.name ?? "?"}`, index, entry });
      });
    }
  }
  return out;
}

function findDoubleSetEntries(
  entries: ReturnType<typeof collectAllEnvEntries>,
): typeof entries {
  return entries.filter(
    ({ entry }) =>
      entry.value !== undefined &&
      entry.value !== null &&
      entry.valueFrom !== undefined &&
      entry.valueFrom !== null,
  );
}

describe("helm/octogee-gateway/ — env entries pass K8s schema (no value+valueFrom)", () => {
  it("cattle profile: no env entry sets both `value` and `valueFrom` (K8s rejects with 'may not be specified when value is not empty')", () => {
    const dep = findDoc(helmTemplate(), "Deployment", "octogee-gateway-default") ?? "";
    const bad = findDoubleSetEntries(collectAllEnvEntries(dep));
    if (bad.length > 0) {
      // Detailed diagnostic so a regression points at the exact entries.
      const summary = bad
        .map(
          (b) =>
            `  ${b.container}[${b.index}] name=${b.entry.name} value=${JSON.stringify(b.entry.value)} valueFrom=${JSON.stringify(b.entry.valueFrom)}`,
        )
        .join("\n");
      throw new Error(`Double-set env entries (K8s will reject):\n${summary}`);
    }
    expect(bad).toEqual([]);
  });

  it("operator profile: no env entry sets both `value` and `valueFrom`", () => {
    const out = helmTemplate("octogee-gw-bender", {
      gatewayId: "gw-bender",
      instanceName: "bender",
      profile: "operator",
    });
    const dep = findDoc(out, "Deployment", "octogee-gateway-bender") ?? "";
    const bad = findDoubleSetEntries(collectAllEnvEntries(dep));
    if (bad.length > 0) {
      const summary = bad
        .map(
          (b) =>
            `  ${b.container}[${b.index}] name=${b.entry.name} value=${JSON.stringify(b.entry.value)} valueFrom=${JSON.stringify(b.entry.valueFrom)}`,
        )
        .join("\n");
      throw new Error(`Double-set env entries (K8s will reject):\n${summary}`);
    }
    expect(bad).toEqual([]);
  });

  it("every env entry has a non-empty `name` (sanity guard: an entry without a name is silently dropped by K8s)", () => {
    const dep = findDoc(helmTemplate(), "Deployment", "octogee-gateway-default") ?? "";
    const entries = collectAllEnvEntries(dep);
    const nameless = entries.filter(
      ({ entry }) => typeof entry.name !== "string" || entry.name.length === 0,
    );
    expect(nameless).toEqual([]);
  });

  describe("workspace auto-commit env wiring (operator vs cattle defaults)", () => {
    it("omits WORKSPACE_AUTOSAVE_ENABLED when the helm value is unset — gateway code defaults from profile", () => {
      const out = helmTemplate("octogee-gw-default");
      const gateway = containerBlock(
        findDoc(out, "Deployment", "octogee-gateway-default") ?? "",
        "gateway",
      );
      expect(gateway).not.toMatch(/WORKSPACE_AUTOSAVE_ENABLED/);
    });

    it("renders the override when workspaceAutosaveEnabled=true (operator opts back in)", () => {
      const out = helmTemplate("octogee-gw-bender", {
        gatewayId: "gw-bender",
        instanceName: "bender",
        profile: "operator",
        workspaceAutosaveEnabled: "true",
      });
      const gateway = containerBlock(
        findDoc(out, "Deployment", "octogee-gateway-bender") ?? "",
        "gateway",
      );
      expect(gateway).toMatch(
        /- name:\s*WORKSPACE_AUTOSAVE_ENABLED[\s\S]*?value:\s*"true"/,
      );
    });

    it("renders the override when workspaceAutosaveEnabled=false (cattle opts out)", () => {
      const out = helmTemplate("octogee-gw-default", {
        workspaceAutosaveEnabled: "false",
      });
      const gateway = containerBlock(
        findDoc(out, "Deployment", "octogee-gateway-default") ?? "",
        "gateway",
      );
      expect(gateway).toMatch(
        /- name:\s*WORKSPACE_AUTOSAVE_ENABLED[\s\S]*?value:\s*"false"/,
      );
    });
  });
});
