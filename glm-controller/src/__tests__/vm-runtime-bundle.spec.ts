import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { isGatewayVmRuntimeBundle } from "@octogee/shared/types/glm";
import {
  helmTemplateArgsFromUpgradeArgs,
  parseConcatenatedJson,
  renderDesktopNode,
  renderVmRuntimeBundle,
} from "../lib/vm-runtime-bundle";

const manifests = JSON.parse(
  readFileSync(new URL("./fixtures/vm-runtime-render.json", import.meta.url), "utf8"),
) as unknown[];

const secrets: Record<string, string> = {
  "gateway-auth-token-b-x/token": "gwtoken",
  "octogee-fleet-controller/public-key": "fleetpub",
  "agent-control-signing/secret": "acs",
  "agent-control-router/secret": "acr",
  "byot-sync-internal/secret": "byot",
};

function render(overrides: Partial<Parameters<typeof renderVmRuntimeBundle>[0]> = {}) {
  return renderVmRuntimeBundle({
    gatewayId: "b-x",
    namespace: "octogee-test",
    imageRepository: "us-docker.pkg.dev/octogee/octogee/gateway",
    imageTag: "main.abc123",
    computer: { serviceAccountEmail: "octogee-computer-test@octogee.iam.gserviceaccount.com", projectId: "octogee" },
    manifests,
    readSecret: async (name, key) => {
      const value = secrets[`${name}/${key}`];
      if (value === undefined) throw new Error(`missing secret ${name}/${key}`);
      return value;
    },
    hostAliases: { "octogee-api.octogee-test.svc.cluster.local": "172.20.5.5" },
    kubernetes: { apiHost: "172.20.16.18", apiPort: "443", caCert: "CA" },
    now: () => 1_000,
    ...overrides,
  });
}

describe("parseConcatenatedJson", () => {
  it("splits kubectl's concatenated objects, respecting braces inside strings", () => {
    expect(parseConcatenatedJson('{"a":"}{"}\n{"b":[1,{"c":2}]}')).toEqual([{ a: "}{" }, { b: [1, { c: 2 }] }]);
    expect(parseConcatenatedJson("")).toEqual([]);
    expect(() => parseConcatenatedJson('{"a":')).toThrow(/ended inside/);
  });
});

describe("helmTemplateArgsFromUpgradeArgs", () => {
  it("turns the upgrade argv into a template argv with the apply flags removed", () => {
    expect(helmTemplateArgsFromUpgradeArgs([
      "upgrade", "--install", "octogee-gw-b-x", "/chart", "-n", "ns", "--set-string", "gatewayId=b-x",
      "--server-side=true", "--force-conflicts", "--take-ownership", "--wait", "--timeout=10m",
    ])).toEqual(["template", "octogee-gw-b-x", "/chart", "-n", "ns", "--set-string", "gatewayId=b-x"]);
    expect(() => helmTemplateArgsFromUpgradeArgs(["status", "x"])).toThrow(/upgrade --install/);
  });
});

describe("renderVmRuntimeBundle", () => {
  it("renders the chart's pod into containers, resolved secrets, token volumes, and mounts", async () => {
    const bundle = await render();
    expect(isGatewayVmRuntimeBundle(bundle)).toBe(true);
    expect(bundle.version).toMatch(/^[0-9a-f]{16}$/);
    expect(bundle.init?.name).toBe("fix-perms");
    expect(bundle.init?.command?.[0]).toBe("sh");
    expect(bundle.init?.env.OPENCLAW_GATEWAY_TOKEN).toBe("gwtoken");
    expect(bundle.containers.map((c) => c.name)).toEqual(["gateway", "gateway-edge", "desktop-node"]);

    const gateway = bundle.containers[0];
    expect(gateway.image).toBe("us-docker.pkg.dev/octogee/octogee/gateway:main.abc123");
    expect(gateway.env).toMatchObject({
      GATEWAY_ID: "b-x",
      GATEWAY_CLASS: "builder",
      K8S_NAMESPACE: "octogee-test",
      POD_UID: "",
      OPENCLAW_GATEWAY_TOKEN: "gwtoken",
      FLEET_CONTROLLER_PUBLIC_KEY: "fleetpub",
      OCTOGEE_API_SA_TOKEN_PATH: "/var/run/secrets/octogee-gateway-broker/token",
    });
    expect(gateway.mounts).toEqual(expect.arrayContaining([
      { volume: "data", mountPath: "/home/node", readOnly: false, subPath: null },
      { volume: "secret-resolver", mountPath: "/octogee/scripts/secret-resolver.mjs", readOnly: true, subPath: "secret-resolver.mjs" },
      { volume: "gateway-credential-sa-token", mountPath: "/var/run/secrets/octogee-gateway-credentials", readOnly: true, subPath: null },
    ]));

    const edge = bundle.containers[1];
    expect(edge.env).toMatchObject({
      OCTOGEE_AGENT_CONTROL_SIGNING_SECRET: "acs",
      AGENT_CONTROL_ROUTER_KEY: "acr",
      BYOT_SYNC_INTERNAL_SIGNING_SECRET: "byot",
      GATEWAY_ID: "b-x",
    });
    expect(edge.mounts.find((m) => m.volume === "k8s-api-token")?.mountPath).toBe("/var/run/secrets/kubernetes.io/serviceaccount");

    expect(bundle.volumes).toEqual(expect.arrayContaining([
      { name: "data", kind: "emptyDir" },
      { name: "octogee-api-sa-token", kind: "identityToken", audience: "octogee-api" },
      { name: "gateway-credential-sa-token", kind: "identityToken", audience: "octogee-api-gateway-credentials" },
      { name: "sidecar-broker-sa-token", kind: "identityToken", audience: "octogee-api-sidecar-broker" },
      { name: "k8s-api-token", kind: "kubernetesApi" },
    ]));
    expect(bundle.hostAliases).toEqual({ "octogee-api.octogee-test.svc.cluster.local": "172.20.5.5" });
    expect(bundle.kubernetes.apiHost).toBe("172.20.16.18");
    expect(bundle.renderedAt).toBe(1_000);
  });

  it("connects only the edge to the visible desktop and marks the gateway's runtime", async () => {
    const bundle = await render();
    const [gateway, edge] = bundle.containers;
    expect(edge.name).toBe("gateway-edge");
    expect(edge.env).toMatchObject({
      GATEWAY_COMPUTER_CONTROL_URL: "http://127.0.0.1:7777",
      GATEWAY_COMPUTER_VNC_URL: "ws://127.0.0.1:6080",
      GATEWAY_COMPUTER_SERVICE_ACCOUNT_EMAIL: "octogee-computer-test@octogee.iam.gserviceaccount.com",
      GATEWAY_COMPUTER_PROJECT_ID: "octogee",
    });
    expect(gateway.env).toMatchObject({ GATEWAY_RUNTIME_KIND: "gce-vm" });
    expect(gateway.env).not.toHaveProperty("GATEWAY_COMPUTER_SERVICE_ACCOUNT_EMAIL");
    expect(gateway.env).not.toHaveProperty("GATEWAY_COMPUTER_CONTROL_URL");
    expect(gateway.env).not.toHaveProperty("GATEWAY_COMPUTER_VNC_URL");
    expect(bundle.init?.env).not.toHaveProperty("GATEWAY_RUNTIME_KIND");
  });

  it("runs the desktop node from the gateway image with the gateway's own credential", async () => {
    const bundle = await render();
    const gateway = bundle.containers[0];
    const node = bundle.containers.at(-1)!;
    expect(node.name).toBe("desktop-node");
    expect(node.image).toBe(gateway.image);
    expect(node.command).toEqual(["/usr/local/bin/octogee-desktop-node"]);
    expect(node.env).toMatchObject({
      OCTOGEE_DESKTOP_NODE_NAME: "octogee-desktop",
      XDG_RUNTIME_DIR: "/run/user/1000",
    });
    expect(node.mounts).toEqual([
      { volume: "desktop-node-state", mountPath: "/home/node/.openclaw", readOnly: false, subPath: null },
    ]);
    expect(bundle.volumes).toContainEqual({ name: "desktop-node-state", kind: "emptyDir" });
    expect(node.env.OPENCLAW_GATEWAY_PASSWORD).toBe(gateway.env.OPENCLAW_GATEWAY_TOKEN);
    expect(node.env).not.toHaveProperty("OPENCLAW_GATEWAY_TOKEN");
  });

  it("refuses to render a desktop node without the gateway secret", () => {
    const gateway = { name: "gateway", image: "img", env: {}, command: null, args: null, mounts: [] };
    expect(() => renderDesktopNode(gateway)).toThrow("OPENCLAW_GATEWAY_TOKEN");
  });

  it("versions the bundle by content, not by render time", async () => {
    const a = await render({ now: () => 1 });
    const b = await render({ now: () => 2 });
    const c = await render({ imageTag: "main.def456" });
    expect(a.version).toBe(b.version);
    expect(c.version).not.toBe(a.version);
  });

  it("fails loudly on a missing secret or an unrenderable chart", async () => {
    await expect(render({ readSecret: async () => { throw new Error("missing secret x"); } })).rejects.toThrow(/missing secret x/);
    await expect(render({ manifests: manifests.filter((m) => (m as { kind: string }).kind !== "Deployment") })).rejects.toThrow(/exactly one Deployment/);
    const readSecret = vi.fn(async () => "v");
    await render({ readSecret });
    expect(readSecret).toHaveBeenCalledWith("gateway-auth-token-b-x", "token");
  });
});
