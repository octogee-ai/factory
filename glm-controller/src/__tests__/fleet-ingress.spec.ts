import { describe, it, expect, vi } from "vitest";
import {
  computeApiFleetPathOps,
  computeDesiredApiFleetPaths,
  computeDesiredFleetPaths,
  computeDesiredPreviewPaths,
  computeIngressHostPathOps,
  extractIngressPaths,
  pathsEqual,
  syncApiFleetIngressPaths,
  syncFleetIngressPaths,
  syncPreviewIngressPaths,
  type FleetGateway,
  type IngressPathRule,
  type KubectlSubprocess,
} from "../fleet-ingress";

const FLEET_PORT = 3003;
const ALIAS = "octogee-gateway";

describe("computeDesiredFleetPaths", () => {
  it("emits the static /health rule pointing at the alias Service when no gateways exist", () => {
    const paths = computeDesiredFleetPaths({
      gateways: [],
      fleetControllerPort: FLEET_PORT,
      aliasServiceName: ALIAS,
    });
    expect(paths).toEqual([
      { path: "/health", pathType: "ImplementationSpecific", serviceName: ALIAS, servicePort: FLEET_PORT },
    ]);
  });

  it("emits 6 RPC paths per gateway routed to the per-instance Service plus /health at the end", () => {
    const gateways: FleetGateway[] = [
      { gatewayId: "gw-test", instanceName: "default" },
    ];
    const paths = computeDesiredFleetPaths({
      gateways,
      fleetControllerPort: FLEET_PORT,
      aliasServiceName: ALIAS,
    });
    expect(paths.map((p) => p.path)).toEqual([
      "/restore-customer/gw-test",
      "/quiesce/gw-test",
      "/export/gw-test",
      "/push-state/gw-test",
      "/import/gw-test",
      "/unmount/gw-test",
      "/health",
    ]);
    expect(paths[0]).toMatchObject({
      pathType: "ImplementationSpecific",
      serviceName: "octogee-gateway-default",
      servicePort: FLEET_PORT,
    });
    expect(paths.at(-1)).toMatchObject({
      path: "/health",
      serviceName: ALIAS,
    });
  });

  it("orders gateways by gatewayId for deterministic output", () => {
    const gateways: FleetGateway[] = [
      { gatewayId: "gw-zebra", instanceName: "z" },
      { gatewayId: "gw-alpha", instanceName: "a" },
      { gatewayId: "gw-mike", instanceName: "m" },
    ];
    const paths = computeDesiredFleetPaths({
      gateways,
      fleetControllerPort: FLEET_PORT,
      aliasServiceName: ALIAS,
    });
    const restorePaths = paths.filter((p) => p.path.startsWith("/restore-customer/"));
    expect(restorePaths.map((p) => p.path)).toEqual([
      "/restore-customer/gw-alpha",
      "/restore-customer/gw-mike",
      "/restore-customer/gw-zebra",
    ]);
  });
});

describe("computeDesiredApiFleetPaths", () => {
  const WSAPI_PORT = 3001;
  const WSAPI_ALIAS = "gateway-edge";

  it("emits the static /health rule pointing at the alias Service when no gateways exist (K8s Ingress requires ≥1 path)", () => {
    const paths = computeDesiredApiFleetPaths({
      gateways: [],
      gatewayEdgePort: WSAPI_PORT,
      gatewayEdgeServiceName: WSAPI_ALIAS,
    });
    expect(paths).toEqual([
      {
        path: "/health",
        pathType: "ImplementationSpecific",
        serviceName: WSAPI_ALIAS,
        servicePort: WSAPI_PORT,
      },
    ]);
  });

  it("emits one /api/g/<gatewayId>/* path per gateway routed to the per-instance gateway-edge Service, /health last", () => {
    const gateways: FleetGateway[] = [
      { gatewayId: "gw-bender", instanceName: "bender" },
    ];
    const paths = computeDesiredApiFleetPaths({
      gateways,
      gatewayEdgePort: WSAPI_PORT,
      gatewayEdgeServiceName: WSAPI_ALIAS,
    });
    expect(paths.map((p) => p.path)).toEqual([
      "/api/g/gw-bender/*",
      "/health",
    ]);
    expect(paths[0]).toMatchObject({
      pathType: "ImplementationSpecific",
      serviceName: "gateway-edge-bender",
      servicePort: WSAPI_PORT,
    });
    expect(paths.at(-1)).toMatchObject({ path: "/health", serviceName: WSAPI_ALIAS });
  });

  it("uses instanceName (never gatewayId) for the per-gateway Service name — same convention as fleet-control", () => {
    const gateways: FleetGateway[] = [
      { gatewayId: "gw-bender", instanceName: "bender" },
      { gatewayId: "default", instanceName: "default" },
    ];
    const paths = computeDesiredApiFleetPaths({
      gateways,
      gatewayEdgePort: WSAPI_PORT,
      gatewayEdgeServiceName: WSAPI_ALIAS,
    });
    const gatewayPaths = paths.filter((p) => p.path.startsWith("/api/g/"));
    expect(gatewayPaths.map((p) => p.serviceName)).toEqual([
      "gateway-edge-default",
      "gateway-edge-bender",
    ]);
  });

  it("orders gateways by gatewayId for deterministic output (matches fleet-control)", () => {
    const gateways: FleetGateway[] = [
      { gatewayId: "gw-zebra", instanceName: "z" },
      { gatewayId: "gw-alpha", instanceName: "a" },
      { gatewayId: "default", instanceName: "default" },
    ];
    const paths = computeDesiredApiFleetPaths({
      gateways,
      gatewayEdgePort: WSAPI_PORT,
      gatewayEdgeServiceName: WSAPI_ALIAS,
    });
    const gatewayPaths = paths.filter((p) => p.path.startsWith("/api/g/"));
    expect(gatewayPaths.map((p) => p.path)).toEqual([
      "/api/g/default/*",
      "/api/g/gw-alpha/*",
      "/api/g/gw-zebra/*",
    ]);
  });
});

describe("computeDesiredPreviewPaths", () => {
  it("emits one /g/<gatewayId>/* path per gateway routed to the per-instance gateway Service", () => {
    const paths = computeDesiredPreviewPaths({
      gateways: [
        { gatewayId: "gw-zebra", instanceName: "z" },
        { gatewayId: "gw-alpha", instanceName: "a" },
      ],
      previewPort: 9080,
    });
    expect(paths).toEqual([
      {
        path: "/g/gw-alpha/*",
        pathType: "ImplementationSpecific",
        serviceName: "octogee-gateway-a",
        servicePort: 9080,
      },
      {
        path: "/g/gw-zebra/*",
        pathType: "ImplementationSpecific",
        serviceName: "octogee-gateway-z",
        servicePort: 9080,
      },
    ]);
  });
});

describe("pathsEqual", () => {
  const a: IngressPathRule = { path: "/health", pathType: "ImplementationSpecific", serviceName: ALIAS, servicePort: FLEET_PORT };
  it("returns true for identical lists", () => {
    expect(pathsEqual([a], [a])).toBe(true);
  });
  it("returns false when length differs", () => {
    expect(pathsEqual([a], [a, a])).toBe(false);
  });
  it("returns false when any field differs", () => {
    const b: IngressPathRule = { ...a, serviceName: "other" };
    expect(pathsEqual([a], [b])).toBe(false);
  });
  it("treats different orderings as not equal (paths order matters for GCE URL maps)", () => {
    const x: IngressPathRule = { path: "/a", pathType: "ImplementationSpecific", serviceName: ALIAS, servicePort: FLEET_PORT };
    const y: IngressPathRule = { path: "/b", pathType: "ImplementationSpecific", serviceName: ALIAS, servicePort: FLEET_PORT };
    expect(pathsEqual([x, y], [y, x])).toBe(false);
  });
});

describe("extractIngressPaths", () => {
  it("pulls path/pathType/service-name/service-port out of a kubectl get ingress -o json payload", () => {
    const json = {
      spec: {
        rules: [
          {
            host: "fleet.octogee.com",
            http: {
              paths: [
                {
                  path: "/restore-customer/gw-x",
                  pathType: "ImplementationSpecific",
                  backend: { service: { name: "octogee-gateway-default", port: { number: 3003 } } },
                },
                {
                  path: "/health",
                  pathType: "ImplementationSpecific",
                  backend: { service: { name: "octogee-gateway", port: { number: 3003 } } },
                },
              ],
            },
          },
        ],
      },
    };
    expect(extractIngressPaths(json)).toEqual([
      { path: "/restore-customer/gw-x", pathType: "ImplementationSpecific", serviceName: "octogee-gateway-default", servicePort: 3003 },
      { path: "/health", pathType: "ImplementationSpecific", serviceName: "octogee-gateway", servicePort: 3003 },
    ]);
  });

  it("returns empty when the ingress has no rules", () => {
    expect(extractIngressPaths({ spec: { rules: [] } })).toEqual([]);
  });

  it("returns empty when the rules block is missing entirely", () => {
    expect(extractIngressPaths({ spec: {} })).toEqual([]);
  });

  it("ignores paths with named ports — fleet ingress always uses numbered ports", () => {
    const json = {
      spec: {
        rules: [
          {
            http: {
              paths: [
                {
                  path: "/health",
                  pathType: "ImplementationSpecific",
                  backend: { service: { name: "x", port: { name: "http" } } },
                },
              ],
            },
          },
        ],
      },
    };
    expect(extractIngressPaths(json)).toEqual([]);
  });
});

function mockKubectl(
  responses: Array<{ stdout?: string; stderr?: string; code?: number }>,
): { runKubectl: KubectlSubprocess; calls: Array<{ args: string[]; stdin?: string }> } {
  const calls: Array<{ args: string[]; stdin?: string }> = [];
  let i = 0;
  const runKubectl: KubectlSubprocess = vi.fn(async (args: string[], opts?: { stdin?: string }) => {
    calls.push({ args, stdin: opts?.stdin });
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.code ?? 0 };
  });
  return { runKubectl, calls };
}

describe("syncFleetIngressPaths", () => {
  const ingressName = "octogee-gateway-fleet-control-ingress";
  const namespace = "octogee-test";

  it("no-ops when no managed fleet paths are desired or live", async () => {
    const live = {
      kind: "Ingress",
      metadata: { name: ingressName, namespace },
      spec: {
        rules: [
          {
            host: "fleet.example.com",
            http: {
              paths: [
                {
                  path: "/health",
                  pathType: "ImplementationSpecific",
                  backend: { service: { name: ALIAS, port: { number: FLEET_PORT } } },
                },
              ],
            },
          },
        ],
      },
    };
    const { runKubectl, calls } = mockKubectl([{ stdout: JSON.stringify(live) }]);

    const result = await syncFleetIngressPaths({
      runKubectl,
      ingressName,
      namespace,
      desiredGateways: [],
      fleetControllerPort: FLEET_PORT,
      aliasServiceName: ALIAS,
      log: vi.fn(),
    });

    expect(result.changed).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0]).toBe("get");
  });

  it("JSON-patches managed fleet paths onto the selected host and leaves /health Helm-owned", async () => {
    const live = {
      kind: "Ingress",
      apiVersion: "networking.k8s.io/v1",
      metadata: {
        name: ingressName,
        namespace,
        annotations: { "kubernetes.io/ingress.class": "gce" },
      },
      spec: {
        ingressClassName: "gce",
        rules: [
          {
            host: "api.example.com",
            http: {
              paths: [
                {
                  path: "/api/*",
                  pathType: "ImplementationSpecific",
                  backend: { service: { name: "gateway-edge", port: { name: "http" } } },
                },
              ],
            },
          },
          {
            host: "fleet.example.com",
            http: {
              paths: [
                {
                  path: "/health",
                  pathType: "ImplementationSpecific",
                  backend: { service: { name: ALIAS, port: { number: FLEET_PORT } } },
                },
              ],
            },
          },
        ],
      },
    };
    const { runKubectl, calls } = mockKubectl([
      { stdout: JSON.stringify(live) },
      { stdout: "ingress.networking.k8s.io/octogee-edge-ingress patched" },
    ]);

    const result = await syncFleetIngressPaths({
      runKubectl,
      ingressName,
      ingressHost: "fleet.example.com",
      namespace,
      desiredGateways: [{ gatewayId: "gw-test", instanceName: "default" }],
      fleetControllerPort: FLEET_PORT,
      aliasServiceName: ALIAS,
      log: vi.fn(),
    });

    expect(result.changed).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1].args).toContain("patch");
    expect(calls[1].args).toContain("--type=json");
    expect(calls[1].args).not.toContain("--server-side");
    const ops = JSON.parse(calls[1].args[calls[1].args.length - 1]);
    expect(ops.map((op: { path: string }) => op.path)).toEqual([
      "/spec/rules/1/host",
      "/spec/rules/1/http/paths/-",
      "/spec/rules/1/http/paths/-",
      "/spec/rules/1/http/paths/-",
      "/spec/rules/1/http/paths/-",
      "/spec/rules/1/http/paths/-",
      "/spec/rules/1/http/paths/-",
    ]);
    expect(ops[0]).toEqual({ op: "test", path: "/spec/rules/1/host", value: "fleet.example.com" });
    expect(
      ops
        .filter((op: { op: string }) => op.op === "add")
        .map((op: { value: { path: string } }) => op.value.path),
    ).toEqual([
      "/restore-customer/gw-test",
      "/quiesce/gw-test",
      "/export/gw-test",
      "/push-state/gw-test",
      "/import/gw-test",
      "/unmount/gw-test",
    ]);
  });

  it("returns changed=false (not a throw) when the umbrella hasn't deployed the Ingress shell yet — bootstrap state", async () => {
    const log = vi.fn();
    const { runKubectl, calls } = mockKubectl([
      { code: 1, stderr: 'Error from server (NotFound): ingresses.networking.k8s.io "octogee-gateway-fleet-control-ingress" not found' },
    ]);
    const result = await syncFleetIngressPaths({
      runKubectl,
      ingressName,
      namespace,
      desiredGateways: [{ gatewayId: "gw-test", instanceName: "default" }],
      fleetControllerPort: FLEET_PORT,
      aliasServiceName: ALIAS,
      log,
    });
    expect(result.changed).toBe(false);
    expect(calls).toHaveLength(1); 
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/not yet present.*deferring/));
  });

  it("propagates errors from the read step with context (non-NotFound)", async () => {
    const { runKubectl } = mockKubectl([{ code: 1, stderr: "connection refused" }]);
    await expect(
      syncFleetIngressPaths({
        runKubectl,
        ingressName,
        namespace,
        desiredGateways: [],
        fleetControllerPort: FLEET_PORT,
        aliasServiceName: ALIAS,
        log: vi.fn(),
      }),
    ).rejects.toThrow(/kubectl get ingress.*connection refused/);
  });

  it("propagates errors from the patch step with context", async () => {
    const live = {
      kind: "Ingress",
      apiVersion: "networking.k8s.io/v1",
      metadata: { name: ingressName, namespace },
      spec: { rules: [{ http: { paths: [] } }] },
    };
    const { runKubectl } = mockKubectl([
      { stdout: JSON.stringify(live) },
      { code: 1, stderr: "denied" },
    ]);
    await expect(
      syncFleetIngressPaths({
        runKubectl,
        ingressName,
        namespace,
        desiredGateways: [{ gatewayId: "gw-test", instanceName: "default" }],
        fleetControllerPort: FLEET_PORT,
        aliasServiceName: ALIAS,
        log: vi.fn(),
      }),
    ).rejects.toThrow(/kubectl patch.*denied/);
  });
});

describe("computeApiFleetPathOps", () => {
  const STATIC = {
    path: "/api/*",
    pathType: "ImplementationSpecific",
    
    backend: { service: { name: "gateway-edge", port: { name: "http" } } },
  };
  const fleet = (id: string, instance: string) => ({
    path: `/api/g/${id}/*`,
    pathType: "ImplementationSpecific",
    backend: { service: { name: `gateway-edge-${instance}`, port: { number: 3001 } } },
  });
  const desired = (gws: FleetGateway[]) =>
    computeDesiredApiFleetPaths({
      gateways: gws,
      gatewayEdgePort: 3001,
      gatewayEdgeServiceName: "gateway-edge",
    }).filter((p) => p.path !== "/health");

  it("returns [] when live /api/g/* entries already match desired", () => {
    const raw = [STATIC, fleet("gw-bender", "bender")];
    expect(
      computeApiFleetPathOps(raw, desired([{ gatewayId: "gw-bender", instanceName: "bender" }])),
    ).toEqual([]);
  });

  it("adds a missing /api/g/* entry without touching the named-port static path", () => {
    const ops = computeApiFleetPathOps(
      [STATIC],
      desired([{ gatewayId: "gw-bender", instanceName: "bender" }]),
    );
    expect(ops).toEqual([
      {
        op: "add",
        path: "/spec/rules/0/http/paths/-",
        value: {
          path: "/api/g/gw-bender/*",
          pathType: "ImplementationSpecific",
          backend: { service: { name: "gateway-edge-bender", port: { number: 3001 } } },
        },
      },
    ]);
  });

  it("removes a stale /api/g/* entry test-guarded at its index, static path index untouched", () => {
    
    const ops = computeApiFleetPathOps([STATIC, fleet("old", "old")], desired([]));
    expect(ops).toEqual([
      { op: "test", path: "/spec/rules/0/http/paths/1/path", value: "/api/g/old/*" },
      { op: "remove", path: "/spec/rules/0/http/paths/1" },
    ]);
    
    expect(ops.some((o) => o.path.includes("paths/0"))).toBe(false);
  });

  it("removes descending then re-adds when the fleet set changes (race-safe ordering)", () => {
    const raw = [STATIC, fleet("a", "a"), fleet("b", "b")];
    const ops = computeApiFleetPathOps(raw, desired([{ gatewayId: "c", instanceName: "c" }]));
    
    const removeIdx = ops
      .filter((o) => o.op === "remove")
      .map((o) => Number(o.path.split("/").pop()));
    expect(removeIdx).toEqual([2, 1]);
    expect(ops.some((o) => o.op === "add" && (o.value as { path: string }).path === "/api/g/c/*")).toBe(true);
  });
});

describe("computeIngressHostPathOps", () => {
  it("patches only the matching host rule in a multi-host Ingress", () => {
    const live = {
      spec: {
        rules: [
          {
            host: "api.example.com",
            http: {
              paths: [
                {
                  path: "/api/*",
                  pathType: "ImplementationSpecific",
                  backend: { service: { name: "gateway-edge", port: { name: "http" } } },
                },
              ],
            },
          },
          {
            host: "preview.example.com",
            http: {
              paths: [
                {
                  path: "/health",
                  pathType: "ImplementationSpecific",
                  backend: { service: { name: "octogee-gateway", port: { number: 9080 } } },
                },
              ],
            },
          },
        ],
      },
    };
    const ops = computeIngressHostPathOps(
      [
        {
          path: "/g/gw-test/*",
          pathType: "ImplementationSpecific",
          serviceName: "octogee-gateway-default",
          servicePort: 9080,
        },
      ],
      live,
      { ingressHost: "preview.example.com", managedPathPrefixes: ["/g/"] },
    );
    expect(ops).toEqual([
      { op: "test", path: "/spec/rules/1/host", value: "preview.example.com" },
      {
        op: "add",
        path: "/spec/rules/1/http/paths/-",
        value: {
          path: "/g/gw-test/*",
          pathType: "ImplementationSpecific",
          backend: { service: { name: "octogee-gateway-default", port: { number: 9080 } } },
        },
      },
    ]);
  });

  it("throws when the requested host is absent instead of falling back to rule 0", () => {
    expect(() =>
      computeIngressHostPathOps([], { spec: { rules: [{ host: "api.example.com" }] } }, {
        ingressHost: "preview.example.com",
        managedPathPrefixes: ["/g/"],
      }),
    ).toThrow(/missing host preview\.example\.com/);
  });
});

describe("syncApiFleetIngressPaths (surgical patch on the shared ingress)", () => {
  const ingressName = "gateway-edge-ingress";
  const namespace = "octogee-test";
  const WSAPI_PORT = 3001;
  const WSAPI_ALIAS = "gateway-edge";

  const liveWith = (paths: unknown[]) => ({
    kind: "Ingress",
    apiVersion: "networking.k8s.io/v1",
    metadata: { name: ingressName, namespace },
    spec: { rules: [{ host: "api.example.com", http: { paths } }] },
  });
  const staticPath = {
    path: "/api/*",
    pathType: "ImplementationSpecific",
    backend: { service: { name: WSAPI_ALIAS, port: { name: "http" } } },
  };

  it("no-ops when the shared ingress already carries the desired /api/g/* paths", async () => {
    const live = liveWith([
      staticPath,
      {
        path: "/api/g/gw-bender/*",
        pathType: "ImplementationSpecific",
        backend: { service: { name: "gateway-edge-bender", port: { number: WSAPI_PORT } } },
      },
    ]);
    const { runKubectl, calls } = mockKubectl([{ stdout: JSON.stringify(live) }]);
    const result = await syncApiFleetIngressPaths({
      runKubectl,
      ingressName,
      namespace,
      desiredGateways: [{ gatewayId: "gw-bender", instanceName: "bender" }],
      gatewayEdgePort: WSAPI_PORT,
      gatewayEdgeServiceName: WSAPI_ALIAS,
      log: vi.fn(),
    });
    expect(result.changed).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0]).toBe("get");
  });

  it("JSON-patches missing /api/g/* paths onto the shared ingress (static path preserved)", async () => {
    const live = liveWith([staticPath]);
    const { runKubectl, calls } = mockKubectl([
      { stdout: JSON.stringify(live) },
      { stdout: "ingress.networking.k8s.io/gateway-edge-ingress patched" },
    ]);
    const result = await syncApiFleetIngressPaths({
      runKubectl,
      ingressName,
      namespace,
      desiredGateways: [
        { gatewayId: "default", instanceName: "default" },
        { gatewayId: "gw-bender", instanceName: "bender" },
      ],
      gatewayEdgePort: WSAPI_PORT,
      gatewayEdgeServiceName: WSAPI_ALIAS,
      log: vi.fn(),
    });
    expect(result.changed).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1].args).toContain("patch");
    expect(calls[1].args).toContain("--type=json");
    
    expect(calls[1].args).not.toContain("--server-side");
    const ops = JSON.parse(calls[1].args[calls[1].args.length - 1]);
    expect(ops).toEqual([
      {
        op: "add",
        path: "/spec/rules/0/http/paths/-",
        value: {
          path: "/api/g/default/*",
          pathType: "ImplementationSpecific",
          backend: { service: { name: "gateway-edge-default", port: { number: WSAPI_PORT } } },
        },
      },
      {
        op: "add",
        path: "/spec/rules/0/http/paths/-",
        value: {
          path: "/api/g/gw-bender/*",
          pathType: "ImplementationSpecific",
          backend: { service: { name: "gateway-edge-bender", port: { number: WSAPI_PORT } } },
        },
      },
    ]);
  });

  it("uses ingressHost to patch the API rule inside a consolidated Ingress", async () => {
    const live = {
      kind: "Ingress",
      apiVersion: "networking.k8s.io/v1",
      metadata: { name: "octogee-edge-ingress", namespace },
      spec: {
        rules: [
          {
            host: "preview.example.com",
            http: { paths: [{ path: "/health", pathType: "ImplementationSpecific", backend: { service: { name: "octogee-gateway", port: { number: 9080 } } } }] },
          },
          { host: "api.example.com", http: { paths: [staticPath] } },
        ],
      },
    };
    const { runKubectl, calls } = mockKubectl([
      { stdout: JSON.stringify(live) },
      { stdout: "ingress.networking.k8s.io/octogee-edge-ingress patched" },
    ]);
    await syncApiFleetIngressPaths({
      runKubectl,
      ingressName: "octogee-edge-ingress",
      ingressHost: "api.example.com",
      namespace,
      desiredGateways: [{ gatewayId: "gw-bender", instanceName: "bender" }],
      gatewayEdgePort: WSAPI_PORT,
      gatewayEdgeServiceName: WSAPI_ALIAS,
      log: vi.fn(),
    });
    const ops = JSON.parse(calls[1].args[calls[1].args.length - 1]);
    expect(ops[0]).toEqual({ op: "test", path: "/spec/rules/1/host", value: "api.example.com" });
    expect(ops[1].path).toBe("/spec/rules/1/http/paths/-");
  });

  it("defers cleanly when the ingress is not yet present (bootstrap)", async () => {
    const { runKubectl, calls } = mockKubectl([
      {
        code: 1,
        stderr: 'Error from server (NotFound): ingresses.networking.k8s.io "gateway-edge-ingress" not found',
      },
    ]);
    const log = vi.fn();
    const result = await syncApiFleetIngressPaths({
      runKubectl,
      ingressName,
      namespace,
      desiredGateways: [{ gatewayId: "gw-bender", instanceName: "bender" }],
      gatewayEdgePort: WSAPI_PORT,
      gatewayEdgeServiceName: WSAPI_ALIAS,
      log,
    });
    expect(result.changed).toBe(false);
    expect(calls).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("deferring"));
  });
});

describe("syncPreviewIngressPaths", () => {
  const namespace = "octogee-test";

  it("patches /g/<gatewayId>/* preview paths on the preview host only", async () => {
    const live = {
      kind: "Ingress",
      apiVersion: "networking.k8s.io/v1",
      metadata: { name: "octogee-edge-ingress", namespace },
      spec: {
        rules: [
          {
            host: "api.example.com",
            http: {
              paths: [
                {
                  path: "/api/*",
                  pathType: "ImplementationSpecific",
                  backend: { service: { name: "gateway-edge", port: { name: "http" } } },
                },
              ],
            },
          },
          {
            host: "preview.example.com",
            http: {
              paths: [
                {
                  path: "/health",
                  pathType: "ImplementationSpecific",
                  backend: { service: { name: "octogee-gateway", port: { number: 9080 } } },
                },
              ],
            },
          },
        ],
      },
    };
    const { runKubectl, calls } = mockKubectl([
      { stdout: JSON.stringify(live) },
      { stdout: "ingress.networking.k8s.io/octogee-edge-ingress patched" },
    ]);
    const result = await syncPreviewIngressPaths({
      runKubectl,
      ingressName: "octogee-edge-ingress",
      ingressHost: "preview.example.com",
      namespace,
      desiredGateways: [{ gatewayId: "gw-test", instanceName: "default" }],
      previewPort: 9080,
      log: vi.fn(),
    });
    expect(result.changed).toBe(true);
    const ops = JSON.parse(calls[1].args[calls[1].args.length - 1]);
    expect(ops).toEqual([
      { op: "test", path: "/spec/rules/1/host", value: "preview.example.com" },
      {
        op: "add",
        path: "/spec/rules/1/http/paths/-",
        value: {
          path: "/g/gw-test/*",
          pathType: "ImplementationSpecific",
          backend: { service: { name: "octogee-gateway-default", port: { number: 9080 } } },
        },
      },
    ]);
  });
});
