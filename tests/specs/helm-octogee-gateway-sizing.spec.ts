import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import { parseAllDocuments } from "yaml";
import { TIER_PRESETS, SIZING_TIERS } from "../../shared/types/sizing.js";

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
  "env.mmInternalUrl": "http://mattermost.octogee-test.svc.cluster.local:8065",
  "env.chatProxyPublicUrl": "https://chat-test.octogee.com",
};

function helmTemplate(setValues: Record<string, string> = {}): string {
  const args = [
    "template",
    "octogee-gw-default",
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

function gatewayContainer(rendered: string): {
  resources: { requests: { cpu?: string; memory?: string }; limits: { cpu?: string; memory?: string } };
  env: Array<{ name: string; value?: string }>;
  podLabels: Record<string, string>;
} {
  const docs = parseAllDocuments(rendered);
  for (const doc of docs) {
    const d = doc.toJS() as
      | { kind?: string; metadata?: { name?: string }; spec?: { template?: { metadata?: { labels?: Record<string, string> }; spec?: { containers?: Array<{ name?: string; env?: Array<{ name: string; value?: string }>; resources?: any }> } } } }
      | undefined;
    if (d?.kind !== "Deployment" || d?.metadata?.name !== "octogee-gateway-default") continue;
    const c = d.spec?.template?.spec?.containers?.find((c) => c.name === "gateway");
    if (!c) throw new Error("gateway container not found");
    return {
      resources: c.resources ?? { requests: {}, limits: {} },
      env: c.env ?? [],
      podLabels: d.spec?.template?.metadata?.labels ?? {},
    };
  }
  throw new Error("Deployment octogee-gateway-default not found");
}

function expectResourcesMatchTier(rendered: string, tier: keyof typeof TIER_PRESETS) {
  const preset = TIER_PRESETS[tier];
  const c = gatewayContainer(rendered);
  expect(c.resources.requests.cpu, `requests.cpu for ${tier}`).toBe(preset.resources.requests.cpu);
  expect(c.resources.requests.memory, `requests.memory for ${tier}`).toBe(preset.resources.requests.memory);
  expect(c.resources.limits.cpu, `limits.cpu for ${tier}`).toBe(preset.resources.limits.cpu);
  expect(c.resources.limits.memory, `limits.memory for ${tier}`).toBe(preset.resources.limits.memory);
}

function expectNodejsMatchTier(rendered: string, tier: keyof typeof TIER_PRESETS) {
  const preset = TIER_PRESETS[tier];
  const c = gatewayContainer(rendered);
  const uv = c.env.find((e) => e.name === "UV_THREADPOOL_SIZE");
  expect(uv?.value, `UV_THREADPOOL_SIZE for ${tier}`).toBe(preset.nodejs.uvThreadpoolSize);
  const nodeOpts = c.env.find((e) => e.name === "NODE_OPTIONS");
  expect(nodeOpts?.value, `NODE_OPTIONS for ${tier}`).toContain(`--max-old-space-size=${preset.nodejs.maxOldSpaceSizeMb}`);
}

describe("helm/octogee-gateway/ — sizing tier explicit override", () => {
  for (const tier of SIZING_TIERS) {
    it(`renders gateway container resources matching the ${tier} preset`, () => {
      const out = helmTemplate({ sizingTier: tier });
      expectResourcesMatchTier(out, tier);
    });

    it(`renders Node.js UV/V8 env tuned for the ${tier} preset`, () => {
      const out = helmTemplate({ sizingTier: tier });
      expectNodejsMatchTier(out, tier);
    });

    it(`labels the pod template with tier=${tier} (Phase D billing hand-off)`, () => {
      const out = helmTemplate({ sizingTier: tier });
      const c = gatewayContainer(out);
      expect(c.podLabels.tier).toBe(tier);
    });
  }

  it("explicit sizingTier beats profile-default", () => {
    // operator profile would default to operator-tier; force cattle-shared.
    const out = helmTemplate({ profile: "operator", sizingTier: "cattle-shared" });
    expectResourcesMatchTier(out, "cattle-shared");
  });
});

describe("helm/octogee-gateway/ — sizing tier profile-default fallback", () => {
  it("operator profile without sizingTier renders operator-tier resources", () => {
    const out = helmTemplate({ profile: "operator" });
    expectResourcesMatchTier(out, "operator");
  });

  it("standard profile without sizingTier renders cattle-heavy resources (PROD-floor migration safety)", () => {
    const out = helmTemplate({ profile: "standard" });
    expectResourcesMatchTier(out, "cattle-heavy");
  });

  it("empty profile without sizingTier falls back to cattle-heavy (PROD-floor migration safety)", () => {
    const out = helmTemplate({});
    expectResourcesMatchTier(out, "cattle-heavy");
  });

  it("operator-profile pod label is the resolved tier, not the bare profile string", () => {
    const out = helmTemplate({ profile: "operator" });
    const c = gatewayContainer(out);
    expect(c.podLabels.tier).toBe("operator");
  });

  it("standard-profile pod label resolves to cattle-heavy (PROD-floor migration safety)", () => {
    const out = helmTemplate({ profile: "standard" });
    const c = gatewayContainer(out);
    expect(c.podLabels.tier).toBe("cattle-heavy");
  });
});

describe("helm/octogee-gateway/ — Phase D tier label on PVC", () => {
  it("stamps the resolved tier on PersistentVolumeClaim when persistence is enabled (storage chargeback hand-off)", () => {
    const out = helmTemplate({
      sizingTier: "operator",
      "persistence.enabled": "true",
    });
    const docs = parseAllDocuments(out);
    const pvc = docs
      .map((d) => d.toJS() as { kind?: string; metadata?: { name?: string; labels?: Record<string, string> } })
      .find((d) => d.kind === "PersistentVolumeClaim" && d.metadata?.name === "octogee-gateway-default-data");
    expect(pvc, "expected PVC to render when persistence.enabled=true").toBeDefined();
    expect(pvc!.metadata!.labels!.tier).toBe("operator");
  });

  it("PVC tier label matches the gateway pod label (same effectiveTier source)", () => {
    const out = helmTemplate({
      profile: "operator",
      "persistence.enabled": "true",
    });
    const docs = parseAllDocuments(out);
    const pvc = docs
      .map((d) => d.toJS() as { kind?: string; metadata?: { labels?: Record<string, string> } })
      .find((d) => d.kind === "PersistentVolumeClaim");
    const dep = docs
      .map((d) => d.toJS() as { kind?: string; spec?: { template?: { metadata?: { labels?: Record<string, string> } } } })
      .find((d) => d.kind === "Deployment");
    expect(pvc?.metadata?.labels?.tier).toBe(dep?.spec?.template?.metadata?.labels?.tier);
  });
});

describe("helm/octogee-gateway/ — replicas knob (paused mode)", () => {
  it("defaults to replicas: 1 when not set (running gateway)", () => {
    const out = helmTemplate();
    const docs = parseAllDocuments(out);
    const deployment = docs
      .map((d) => d.toJS() as { kind?: string; metadata?: { name?: string }; spec?: { replicas?: number } })
      .find((d) => d.kind === "Deployment" && d.metadata?.name === "octogee-gateway-default");
    expect(deployment?.spec?.replicas).toBe(1);
  });

  it("renders replicas: 0 when explicitly set (paused gateway)", () => {
    const out = helmTemplate({ replicas: "0" });
    const docs = parseAllDocuments(out);
    const deployment = docs
      .map((d) => d.toJS() as { kind?: string; metadata?: { name?: string }; spec?: { replicas?: number } })
      .find((d) => d.kind === "Deployment" && d.metadata?.name === "octogee-gateway-default");
    expect(deployment?.spec?.replicas).toBe(0);
  });

  it("rejects replicas > 1 via schema (HPA / multi-replica is out of scope)", () => {
    const args = [
      "template",
      "octogee-gw-default",
      CHART_PATH,
      "--namespace=octogee-test",
    ];
    for (const [k, v] of Object.entries(REQUIRED_VALUES)) args.push("--set", `${k}=${v}`);
    args.push("--set", "replicas=2");
    const result = spawnSync("helm", args, { encoding: "utf-8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/replicas|schema/i);
  });
});

describe("helm/octogee-gateway/ — invalid sizingTier rejected by schema", () => {
  it("fails to render when sizingTier is not in the SIZING_TIERS enum", () => {
    const args = [
      "template",
      "octogee-gw-default",
      CHART_PATH,
      "--namespace=octogee-test",
    ];
    for (const [k, v] of Object.entries(REQUIRED_VALUES)) {
      args.push("--set", `${k}=${v}`);
    }
    args.push("--set", "sizingTier=bogus-tier");
    const result = spawnSync("helm", args, { encoding: "utf-8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/schema|sizingTier|enum/i);
  });
});
