import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { parseAllDocuments } from "yaml";

const REPO_ROOT = path.resolve(__dirname, "../..");
const CHART_PATH = path.join(REPO_ROOT, "helm/octogee-gateway");

const REQUIRED_VALUES: Record<string, string> = {
  imageTag: "abc1234",
  "image.repository": "registry.example/octogee-gateway",
  "gatewayEdge.image.repository": "registry.example/gateway-edge",
  "env.mmSiteUrl": "https://mm-test.example.com",
  "env.mmInternalUrl": "http://mattermost.octogee-test.svc.cluster.local:8065",
  "gatewayEdge.publicAppOrigins[0]": "https://app-test.octogee.com",
};

const BUILDER_VALUES: Record<string, string> = {
  gatewayClass: "builder",
  imageProfile: "builder",
  profile: "builder",
  sizingTier: "s",
  runtimeKind: "gce-vm",
  "builderAccess.controlUiEnabled": "true",
  "builderAccess.controlIdentity": "per-user",
};

const VM_VALUES: Record<string, string> = { ...BUILDER_VALUES, computerDesktop: "omarchy" };

interface Container {
  name: string;
  env?: Array<{ name: string; value?: string }>;
  volumeMounts?: Array<{ name: string; mountPath: string; subPath?: string }>;
}

interface Pod {
  metadata: { annotations?: Record<string, string>; labels?: Record<string, string> };
  spec: {
    initContainers?: Container[];
    containers: Container[];
    volumes: Array<{ name: string; emptyDir?: { sizeLimit?: string } }>;
  };
}

function renderPod(gatewayId: string, values: Record<string, string>): { pod: Pod; rendered: string } {
  const args = ["template", `octogee-gw-${gatewayId}`, CHART_PATH, "--namespace=octogee-test"];
  for (const [key, value] of Object.entries({ ...REQUIRED_VALUES, gatewayId, ...values })) {
    args.push("--set", `${key}=${value}`);
  }
  const result = spawnSync("helm", args, { encoding: "utf-8" });
  if (result.status !== 0) throw new Error(`helm template failed:\n${result.stderr}`);
  for (const doc of parseAllDocuments(result.stdout)) {
    const value = doc.toJS() as { kind?: string; spec?: { template?: Pod } } | null;
    if (value?.kind === "Deployment" && value.spec?.template) return { pod: value.spec.template, rendered: result.stdout };
  }
  throw new Error("no Deployment rendered");
}

function allContainers(pod: Pod): Container[] {
  return [...(pod.spec.initContainers ?? []), ...pod.spec.containers];
}

describe("helm/octogee-gateway/ — Builder identity is never rendered", () => {
  it.each([
    ["X11 VM", BUILDER_VALUES],
    ["Omarchy VM", { ...VM_VALUES, sizingTier: "m" }],
  ])("renders a %s Builder pod with no owner or slug env, annotation, label, or path", (_label, values) => {
    const { pod, rendered } = renderPod("b-alice", values);

    expect(pod.metadata.annotations ?? {}).not.toHaveProperty("octogee.ai/owner-uid");
    expect(pod.metadata.annotations ?? {}).not.toHaveProperty("octogee.ai/builder-slug");
    expect(pod.metadata.labels ?? {}).not.toHaveProperty("octogee.ai/builder-slug");
    for (const container of allContainers(pod)) {
      const names = (container.env ?? []).map((entry) => entry.name);
      expect(names, container.name).not.toContain("GATEWAY_BUILDER_SLUG");
      expect(names, container.name).not.toContain("GATEWAY_OWNER_UID");
      for (const mount of container.volumeMounts ?? []) {
        expect(mount.mountPath, container.name).not.toMatch(/\/customers\//);
      }
    }
    expect(rendered).not.toMatch(/ownerUid and builderSlug/);
  });

  it("ignores owner values a caller still passes", () => {
    const { rendered } = renderPod("b-x", { ...BUILDER_VALUES, ownerUid: "uid-alice", builderSlug: "alice" });
    expect(rendered).not.toContain("uid-alice");
    expect(rendered).not.toMatch(/\balice\b/);
  });

  it("renders a Builder without an owner", () => {
    expect(() => renderPod("b-unowned", BUILDER_VALUES)).not.toThrow();
  });

  it.each(["x11", "omarchy", "none"])("refuses to render a %s Builder as a Kubernetes Deployment", (computerDesktop) => {
    expect(() => renderPod("b-alice", { ...BUILDER_VALUES, computerDesktop, sizingTier: "m", runtimeKind: "cluster" }))
      .toThrow(/renders only as a GCE VM bundle/);
  });

  it("keeps the Omarchy VM's own project materialization volume for its runtime to bind", () => {
    const { pod } = renderPod("b-alice", { ...VM_VALUES, sizingTier: "m" });

    expect(pod.spec.volumes.map((volume) => volume.name)).toContain("project-materializations");
    for (const name of ["gateway", "gateway-edge"]) {
      const container = pod.spec.containers.find((entry) => entry.name === name)!;
      expect(container.volumeMounts).toContainEqual({ name: "project-materializations", mountPath: "/work/materialized", subPath: "projects" });
    }
  });
});
