import { describe, it, expect } from "vitest";
import {
  apiFleetPaths,
  previewFleetPaths,
  mergeFleetRules,
  parseBaseRoutes,
  rulesEqual,
  syncEdgeIngress,
  type FleetGateway,
  type IngressRule,
  type KubectlSubprocess,
  type KubectlSubprocessResult,
} from "../fleet-ingress";

const API_HOST = "api-test.octogee.com";
const PREVIEW_HOST = "preview-test.octogee.com";
const GATEWAY_EDGE_PORT = 3001;
const PREVIEW_PORT = 9080;
const CONFIGMAP = "octogee-edge-routes";
const INGRESS = "octogee-edge-ingress";
const NS = "octogee-test";
const FIELD_MANAGER = "cowboy-fleet-ingress";

const BASE_RULES: IngressRule[] = [
  {
    host: API_HOST,
    http: {
      paths: [
        { path: "/api/admin/gateways/*", pathType: "ImplementationSpecific", backend: { service: { name: "glm-controller", port: { name: "http" } } } },
        { path: "/api/*", pathType: "ImplementationSpecific", backend: { service: { name: "octogee-api", port: { name: "http" } } } },
        { path: "/health", pathType: "ImplementationSpecific", backend: { service: { name: "gateway-edge", port: { name: "http" } } } },
      ],
    },
  },
  {
    host: "git-test.octogee.com",
    http: {
      paths: [
        { path: "/*", pathType: "ImplementationSpecific", backend: { service: { name: "octogee-gitea-http", port: { number: 3000 } } } },
      ],
    },
  },
  {
    host: PREVIEW_HOST,
    http: {
      paths: [
        { path: "/health", pathType: "ImplementationSpecific", backend: { service: { name: "octogee-gateway", port: { number: 9080 } } } },
      ],
    },
  },
];

const GATEWAYS: FleetGateway[] = [{ gatewayId: "default" }, { gatewayId: "bender" }];

function ok(stdout: string): KubectlSubprocessResult {
  return { stdout, stderr: "", code: 0 };
}
function notFound(): KubectlSubprocessResult {
  return { stdout: "", stderr: "Error from server (NotFound): not found", code: 1 };
}
function configMapStdout(rules: IngressRule[] = BASE_RULES): string {
  return JSON.stringify({ data: { "routes.json": JSON.stringify(rules) } });
}
function ingressStdout(rules: IngressRule[]): string {
  return JSON.stringify({ spec: { rules } });
}

interface FakeKubectl {
  run: KubectlSubprocess;
  calls: { args: string[]; stdin?: string }[];
}
function fakeKubectl(handlers: {
  configmap?: KubectlSubprocessResult;
  ingress?: KubectlSubprocessResult;
  apply?: KubectlSubprocessResult;
}): FakeKubectl {
  const calls: { args: string[]; stdin?: string }[] = [];
  const run: KubectlSubprocess = async (args, opts) => {
    calls.push({ args, stdin: opts?.stdin });
    if (args[0] === "get" && args[1] === "configmap") return handlers.configmap ?? ok(configMapStdout());
    if (args[0] === "get" && args[1] === "ingress") return handlers.ingress ?? ok(ingressStdout(BASE_RULES));
    if (args[0] === "apply") return handlers.apply ?? ok("ingress.networking.k8s.io/octogee-edge-ingress serverside-applied");
    throw new Error(`unexpected kubectl ${args.join(" ")}`);
  };
  return { run, calls };
}

function applyCall(k: FakeKubectl): { args: string[]; stdin?: string } | undefined {
  return k.calls.find((c) => c.args[0] === "apply");
}

function baseSyncOpts(k: FakeKubectl, gateways: FleetGateway[] = GATEWAYS) {
  return {
    runKubectl: k.run,
    ingressName: INGRESS,
    namespace: NS,
    baseRoutesConfigMap: CONFIGMAP,
    apiHost: API_HOST,
    previewHost: PREVIEW_HOST,
    gatewayEdgePort: GATEWAY_EDGE_PORT,
    previewPort: PREVIEW_PORT,
    desiredGateways: gateways,
    fieldManager: FIELD_MANAGER,
    log: () => {},
  };
}

describe("apiFleetPaths", () => {
  it("emits one /api/g/<id>/* path per gateway routed to the per-gateway gateway-edge Service", () => {
    expect(apiFleetPaths(GATEWAYS, GATEWAY_EDGE_PORT)).toEqual([
      { path: "/api/g/bender/*", pathType: "ImplementationSpecific", backend: { service: { name: "gateway-edge-bender", port: { number: 3001 } } } },
      { path: "/api/g/default/*", pathType: "ImplementationSpecific", backend: { service: { name: "gateway-edge-default", port: { number: 3001 } } } },
    ]);
  });

  it("is empty when there are no gateways", () => {
    expect(apiFleetPaths([], GATEWAY_EDGE_PORT)).toEqual([]);
  });

  it("orders by gatewayId for deterministic output", () => {
    const paths = apiFleetPaths([{ gatewayId: "zeta" }, { gatewayId: "alpha" }], GATEWAY_EDGE_PORT);
    expect(paths.map((p) => p.path)).toEqual(["/api/g/alpha/*", "/api/g/zeta/*"]);
  });
});

describe("previewFleetPaths", () => {
  it("emits one /g/<id>/* path per gateway routed to the per-gateway gateway Service", () => {
    expect(previewFleetPaths(GATEWAYS, PREVIEW_PORT)).toEqual([
      { path: "/g/bender/*", pathType: "ImplementationSpecific", backend: { service: { name: "octogee-gateway-bender", port: { number: 9080 } } } },
      { path: "/g/default/*", pathType: "ImplementationSpecific", backend: { service: { name: "octogee-gateway-default", port: { number: 9080 } } } },
    ]);
  });
});

describe("mergeFleetRules", () => {
  it("appends /api/g/* to the api host after the base paths, in gatewayId order", () => {
    const merged = mergeFleetRules(BASE_RULES, {
      apiHost: API_HOST,
      previewHost: PREVIEW_HOST,
      gateways: GATEWAYS,
      gatewayEdgePort: GATEWAY_EDGE_PORT,
      previewPort: PREVIEW_PORT,
    });
    const apiRule = merged.find((r) => r.host === API_HOST)!;
    expect(apiRule.http.paths.map((p) => p.path)).toEqual([
      "/api/admin/gateways/*",
      "/api/*",
      "/health",
      "/api/g/bender/*",
      "/api/g/default/*",
    ]);
  });

  it("appends /g/* to the preview host and leaves other hosts untouched", () => {
    const merged = mergeFleetRules(BASE_RULES, {
      apiHost: API_HOST,
      previewHost: PREVIEW_HOST,
      gateways: GATEWAYS,
      gatewayEdgePort: GATEWAY_EDGE_PORT,
      previewPort: PREVIEW_PORT,
    });
    expect(merged.find((r) => r.host === PREVIEW_HOST)!.http.paths.map((p) => p.path)).toEqual([
      "/health",
      "/g/bender/*",
      "/g/default/*",
    ]);
    expect(merged.find((r) => r.host === "git-test.octogee.com")!.http.paths.map((p) => p.path)).toEqual(["/*"]);
  });

  it("is a no-op on the rules when there are no gateways (base routes pass through)", () => {
    const merged = mergeFleetRules(BASE_RULES, {
      apiHost: API_HOST,
      previewHost: PREVIEW_HOST,
      gateways: [],
      gatewayEdgePort: GATEWAY_EDGE_PORT,
      previewPort: PREVIEW_PORT,
    });
    expect(rulesEqual(merged, BASE_RULES)).toBe(true);
  });
});

describe("rulesEqual", () => {
  it("is true for structurally identical rules", () => {
    expect(rulesEqual(BASE_RULES, JSON.parse(JSON.stringify(BASE_RULES)))).toBe(true);
  });
  it("is false when a path order differs (GCE URL-map order matters)", () => {
    const reordered = JSON.parse(JSON.stringify(BASE_RULES)) as IngressRule[];
    reordered[0].http.paths.reverse();
    expect(rulesEqual(BASE_RULES, reordered)).toBe(false);
  });
  it("is false when a backend differs", () => {
    const changed = JSON.parse(JSON.stringify(BASE_RULES)) as IngressRule[];
    changed[0].http.paths[1].backend.service.name = "gateway-edge";
    expect(rulesEqual(BASE_RULES, changed)).toBe(false);
  });
});

describe("parseBaseRoutes", () => {
  it("parses a valid routes.json payload", () => {
    expect(parseBaseRoutes(JSON.stringify(BASE_RULES))).toEqual(BASE_RULES);
  });
  it("throws on non-JSON", () => {
    expect(() => parseBaseRoutes("not json")).toThrow(/not parseable/);
  });
  it("throws when the payload is not an array of rules", () => {
    expect(() => parseBaseRoutes(JSON.stringify({ host: "x" }))).toThrow(/array of/);
    expect(() => parseBaseRoutes(JSON.stringify([{ host: "x" }]))).toThrow(/array of/);
  });
});

describe("syncEdgeIngress", () => {
  it("server-side-applies the merged base+fleet rules under the cowboy field manager", async () => {
    const k = fakeKubectl({});
    const result = await syncEdgeIngress(baseSyncOpts(k));

    const apply = applyCall(k)!;
    expect(apply.args).toEqual([
      "apply", "--server-side", "--field-manager", FIELD_MANAGER, "--force-conflicts", "-n", NS, "-f", "-",
    ]);
    const manifest = JSON.parse(apply.stdin!) as { spec: { rules: IngressRule[] } };
    const apiRule = manifest.spec.rules.find((r) => r.host === API_HOST)!;
    expect(apiRule.http.paths.map((p) => p.path)).toContain("/api/g/bender/*");
    expect(apiRule.http.paths.map((p) => p.path)).toContain("/api/g/default/*");
    const previewRule = manifest.spec.rules.find((r) => r.host === PREVIEW_HOST)!;
    expect(previewRule.http.paths.map((p) => p.path)).toContain("/g/bender/*");
    expect(result.changed).toBe(true);
  });

  it("reports changed=false (and still applies) when the live rules already match", async () => {
    const desired = mergeFleetRules(BASE_RULES, {
      apiHost: API_HOST,
      previewHost: PREVIEW_HOST,
      gateways: GATEWAYS,
      gatewayEdgePort: GATEWAY_EDGE_PORT,
      previewPort: PREVIEW_PORT,
    });
    const k = fakeKubectl({ ingress: ok(ingressStdout(desired)) });
    const result = await syncEdgeIngress(baseSyncOpts(k));
    expect(result.changed).toBe(false);
    expect(applyCall(k)).toBeDefined();
  });

  it("defers (no apply) when the base-routes ConfigMap is absent", async () => {
    const k = fakeKubectl({ configmap: notFound() });
    const result = await syncEdgeIngress(baseSyncOpts(k));
    expect(result.changed).toBe(false);
    expect(applyCall(k)).toBeUndefined();
    expect(k.calls.some((c) => c.args[1] === "ingress")).toBe(false);
  });

  it("defers (no apply) when the Ingress object is absent", async () => {
    const k = fakeKubectl({ ingress: notFound() });
    const result = await syncEdgeIngress(baseSyncOpts(k));
    expect(result.changed).toBe(false);
    expect(applyCall(k)).toBeUndefined();
  });

  it("throws when a get fails for a non-NotFound reason", async () => {
    const k = fakeKubectl({ configmap: { stdout: "", stderr: "Forbidden", code: 1 } });
    await expect(syncEdgeIngress(baseSyncOpts(k))).rejects.toThrow(/configmap .* failed/);
  });

  it("throws when the apply fails", async () => {
    const k = fakeKubectl({ apply: { stdout: "", stderr: "conflict", code: 1 } });
    await expect(syncEdgeIngress(baseSyncOpts(k))).rejects.toThrow(/apply ingress .* failed/);
  });
});
