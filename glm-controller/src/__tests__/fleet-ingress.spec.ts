import { describe, it, expect, vi } from "vitest";
import {
  computeDesiredApiFleetPaths,
  computeDesiredChatProxyFleetPaths,
  computeDesiredFleetPaths,
  extractIngressPaths,
  pathsEqual,
  syncApiFleetIngressPaths,
  syncChatProxyFleetIngressPaths,
  syncFleetIngressPaths,
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

  it("emits 5 RPC paths per gateway routed to the per-instance Service plus /health at the end", () => {
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
  const WSAPI_ALIAS = "workspace-api";

  it("emits the static /health rule pointing at the alias Service when no gateways exist (K8s Ingress requires ≥1 path)", () => {
    const paths = computeDesiredApiFleetPaths({
      gateways: [],
      workspaceApiPort: WSAPI_PORT,
      workspaceApiServiceName: WSAPI_ALIAS,
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

  it("emits one /api/g/<gatewayId>/* path per gateway routed to the per-instance workspace-api Service, /health last", () => {
    const gateways: FleetGateway[] = [
      { gatewayId: "gw-bender", instanceName: "bender" },
    ];
    const paths = computeDesiredApiFleetPaths({
      gateways,
      workspaceApiPort: WSAPI_PORT,
      workspaceApiServiceName: WSAPI_ALIAS,
    });
    expect(paths.map((p) => p.path)).toEqual([
      "/api/g/gw-bender/*",
      "/health",
    ]);
    expect(paths[0]).toMatchObject({
      pathType: "ImplementationSpecific",
      serviceName: "workspace-api-bender",
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
      workspaceApiPort: WSAPI_PORT,
      workspaceApiServiceName: WSAPI_ALIAS,
    });
    const gatewayPaths = paths.filter((p) => p.path.startsWith("/api/g/"));
    expect(gatewayPaths.map((p) => p.serviceName)).toEqual([
      "workspace-api-default",
      "workspace-api-bender",
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
      workspaceApiPort: WSAPI_PORT,
      workspaceApiServiceName: WSAPI_ALIAS,
    });
    const gatewayPaths = paths.filter((p) => p.path.startsWith("/api/g/"));
    expect(gatewayPaths.map((p) => p.path)).toEqual([
      "/api/g/default/*",
      "/api/g/gw-alpha/*",
      "/api/g/gw-zebra/*",
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

  it("no-ops when live paths already match desired", async () => {
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

  it("applies a new manifest when desired paths differ from live", async () => {
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
      { stdout: "ingress.networking.k8s.io/octogee-gateway-fleet-control-ingress configured" },
    ]);

    const result = await syncFleetIngressPaths({
      runKubectl,
      ingressName,
      namespace,
      desiredGateways: [{ gatewayId: "gw-test", instanceName: "default" }],
      fleetControllerPort: FLEET_PORT,
      aliasServiceName: ALIAS,
      log: vi.fn(),
    });

    expect(result.changed).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1].args).toContain("apply");
    expect(calls[1].args).toContain("-f");
    expect(calls[1].args).toContain("-");
    expect(calls[1].stdin).toBeDefined();
    const applied = JSON.parse(calls[1].stdin as string);
    const appliedPaths = applied.spec.rules[0].http.paths;
    expect(appliedPaths.map((p: { path: string }) => p.path)).toEqual([
      "/restore-customer/gw-test",
      "/quiesce/gw-test",
      "/export/gw-test",
      "/import/gw-test",
      "/unmount/gw-test",
      "/health",
    ]);
    // host + class must round-trip so apply doesn't drop anything else
    expect(applied.spec.rules[0].host).toBe("fleet.example.com");
    // Cowboy owns ONLY paths (and the host wrapping them, since SSA
    // can't own paths without the rule). Helm continues to own
    // ingressClassName, annotations, tls, etc — leave them out of the
    // apply payload so we don't claim their field ownership.
    expect(applied.spec.ingressClassName).toBeUndefined();
    expect(applied.metadata.annotations).toBeUndefined();
    expect(applied.metadata.labels).toBeUndefined();
    expect(applied.spec.tls).toBeUndefined();
  });

  it("preserves the existing managedFields by re-using kubectl apply (not replace)", async () => {
    const live = {
      kind: "Ingress",
      apiVersion: "networking.k8s.io/v1",
      metadata: {
        name: ingressName,
        namespace,
        managedFields: [{ manager: "Helm" }],
      },
      spec: {
        rules: [
          {
            http: { paths: [] },
          },
        ],
      },
    };
    const { runKubectl, calls } = mockKubectl([
      { stdout: JSON.stringify(live) },
      { stdout: "configured" },
    ]);

    await syncFleetIngressPaths({
      runKubectl,
      ingressName,
      namespace,
      desiredGateways: [{ gatewayId: "gw-test", instanceName: "default" }],
      fleetControllerPort: FLEET_PORT,
      aliasServiceName: ALIAS,
      log: vi.fn(),
    });

    expect(calls[1].args).toContain("apply");
    expect(calls[1].args).toContain("--server-side");
    expect(calls[1].args).toContain("--field-manager=cowboy-fleet-controller");
    // force-conflicts so Cowboy can take ownership of paths from Helm
    expect(calls[1].args).toContain("--force-conflicts");
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
    expect(calls).toHaveLength(1); // never tries to apply if the Ingress doesn't exist
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

  it("propagates errors from the apply step with context", async () => {
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
    ).rejects.toThrow(/kubectl apply.*denied/);
  });
});

describe("syncApiFleetIngressPaths", () => {
  const ingressName = "workspace-api-fleet-ingress";
  const namespace = "octogee-test";
  const WSAPI_PORT = 3001;
  const WSAPI_ALIAS = "workspace-api";

  it("no-ops when live paths already match desired (no gateways → just /health)", async () => {
    const live = {
      kind: "Ingress",
      metadata: { name: ingressName, namespace },
      spec: {
        rules: [
          {
            host: "api.example.com",
            http: {
              paths: [
                {
                  path: "/health",
                  pathType: "ImplementationSpecific",
                  backend: { service: { name: WSAPI_ALIAS, port: { number: WSAPI_PORT } } },
                },
              ],
            },
          },
        ],
      },
    };
    const { runKubectl, calls } = mockKubectl([{ stdout: JSON.stringify(live) }]);

    const result = await syncApiFleetIngressPaths({
      runKubectl,
      ingressName,
      namespace,
      desiredGateways: [],
      workspaceApiPort: WSAPI_PORT,
      workspaceApiServiceName: WSAPI_ALIAS,
      log: vi.fn(),
    });

    expect(result.changed).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0]).toBe("get");
  });

  it("applies per-gateway /api/g/<gatewayId>/* paths plus /health to the workspace-api seam", async () => {
    const live = {
      kind: "Ingress",
      apiVersion: "networking.k8s.io/v1",
      metadata: { name: ingressName, namespace },
      spec: {
        rules: [
          {
            host: "api.example.com",
            http: {
              paths: [
                {
                  path: "/health",
                  pathType: "ImplementationSpecific",
                  backend: { service: { name: WSAPI_ALIAS, port: { number: WSAPI_PORT } } },
                },
              ],
            },
          },
        ],
      },
    };
    const { runKubectl, calls } = mockKubectl([
      { stdout: JSON.stringify(live) },
      { stdout: "ingress.networking.k8s.io/workspace-api-fleet-ingress configured" },
    ]);

    const result = await syncApiFleetIngressPaths({
      runKubectl,
      ingressName,
      namespace,
      desiredGateways: [
        { gatewayId: "default", instanceName: "default" },
        { gatewayId: "gw-bender", instanceName: "bender" },
      ],
      workspaceApiPort: WSAPI_PORT,
      workspaceApiServiceName: WSAPI_ALIAS,
      log: vi.fn(),
    });

    expect(result.changed).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1].args).toContain("apply");
    expect(calls[1].args).toContain("--server-side");
    const applied = JSON.parse(calls[1].stdin as string);
    expect(applied.spec.rules[0].host).toBe("api.example.com");
    expect(applied.spec.rules[0].http.paths.map((p: { path: string }) => p.path)).toEqual([
      "/api/g/default/*",
      "/api/g/gw-bender/*",
      "/health",
    ]);
    expect(applied.spec.rules[0].http.paths[0].backend.service.name).toBe(
      "workspace-api-default",
    );
    expect(applied.spec.rules[0].http.paths[1].backend.service.name).toBe(
      "workspace-api-bender",
    );
    expect(applied.spec.rules[0].http.paths[2].backend.service.name).toBe(WSAPI_ALIAS);
    const fmArg = calls[1].args.find((a) => a.startsWith("--field-manager"));
    expect(fmArg).toMatch(/cowboy/);
  });

  it("defers cleanly when the ingress shell is not yet present (bootstrap)", async () => {
    const { runKubectl, calls } = mockKubectl([
      {
        code: 1,
        stderr: 'Error from server (NotFound): ingresses.networking.k8s.io "workspace-api-fleet-ingress" not found',
      },
    ]);
    const log = vi.fn();
    const result = await syncApiFleetIngressPaths({
      runKubectl,
      ingressName,
      namespace,
      desiredGateways: [{ gatewayId: "gw-bender", instanceName: "bender" }],
      workspaceApiPort: WSAPI_PORT,
      workspaceApiServiceName: WSAPI_ALIAS,
      log,
    });
    expect(result.changed).toBe(false);
    expect(calls).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("deferring"));
  });
});

// ── Chat-proxy fleet ingress (mirror of api-fleet) ─────────────────────
//
// chat.octogee.com is currently a single ingress that LB-fans across
// every pod's chat-proxy sidecar. With per-customer cattle gateways
// each running its own sidecar triplet (openclaw + chat-proxy +
// workspace-api), a user whose `provisioning.openclaw.gatewayId = gw-X`
// must land on the chat-proxy in gw-X's pod — anything else bridges
// upstream to the wrong gateway sidecar.
//
// The fix mirrors the api.octogee.com seam landed earlier today
// (FLEET-API-ROUTING-SPEC): Cowboy SSA-reconciles a per-gateway
// `/g/<gatewayId>/*` rule list on `chat-proxy-fleet-ingress`, routed
// to per-instance `chat-proxy-<instanceName>` Services. App constructs
// `wss://chat.octogee.com/g/<gatewayId>/api/openclaw/ws/<ticket>`.

describe("computeDesiredChatProxyFleetPaths", () => {
  const CHAT_PORT = 8080;
  const CHAT_ALIAS = "chat-proxy";

  it("emits the static /health rule pointing at the alias Service when no gateways exist (K8s Ingress requires ≥1 path)", () => {
    const paths = computeDesiredChatProxyFleetPaths({
      gateways: [],
      chatProxyPort: CHAT_PORT,
      chatProxyServiceName: CHAT_ALIAS,
    });
    expect(paths).toEqual([
      {
        path: "/health",
        pathType: "ImplementationSpecific",
        serviceName: CHAT_ALIAS,
        servicePort: CHAT_PORT,
      },
    ]);
  });

  it("emits one /g/<gatewayId>/* path per gateway routed to the per-instance chat-proxy Service, /health last", () => {
    const gateways: FleetGateway[] = [
      { gatewayId: "gw-bender", instanceName: "bender" },
    ];
    const paths = computeDesiredChatProxyFleetPaths({
      gateways,
      chatProxyPort: CHAT_PORT,
      chatProxyServiceName: CHAT_ALIAS,
    });
    expect(paths.map((p) => p.path)).toEqual(["/g/gw-bender/*", "/health"]);
    expect(paths[0]).toMatchObject({
      pathType: "ImplementationSpecific",
      serviceName: "chat-proxy-bender",
      servicePort: CHAT_PORT,
    });
    expect(paths.at(-1)).toMatchObject({
      path: "/health",
      serviceName: CHAT_ALIAS,
    });
  });

  it("uses instanceName (never gatewayId) for the per-gateway Service name — same convention as fleet-control + api-fleet", () => {
    // gw-prod → instanceName=default is the load-bearing case: stripping
    // 'gw-' from gatewayId would yield 'prod', not 'default', and the
    // Service `chat-proxy-prod` doesn't exist. instanceName comes from
    // glmGateways/{id}.instanceName and must be used as the source of
    // truth.
    const gateways: FleetGateway[] = [
      { gatewayId: "gw-bender", instanceName: "bender" },
      { gatewayId: "gw-prod", instanceName: "default" },
    ];
    const paths = computeDesiredChatProxyFleetPaths({
      gateways,
      chatProxyPort: CHAT_PORT,
      chatProxyServiceName: CHAT_ALIAS,
    });
    const gatewayPaths = paths.filter((p) => p.path.startsWith("/g/"));
    expect(gatewayPaths.map((p) => p.serviceName)).toEqual([
      "chat-proxy-bender",
      "chat-proxy-default",
    ]);
  });

  it("orders gateways by gatewayId for deterministic output (matches fleet-control + api-fleet)", () => {
    const gateways: FleetGateway[] = [
      { gatewayId: "gw-zebra", instanceName: "z" },
      { gatewayId: "gw-alpha", instanceName: "a" },
      { gatewayId: "default", instanceName: "default" },
    ];
    const paths = computeDesiredChatProxyFleetPaths({
      gateways,
      chatProxyPort: CHAT_PORT,
      chatProxyServiceName: CHAT_ALIAS,
    });
    const gatewayPaths = paths.filter((p) => p.path.startsWith("/g/"));
    expect(gatewayPaths.map((p) => p.path)).toEqual([
      "/g/default/*",
      "/g/gw-alpha/*",
      "/g/gw-zebra/*",
    ]);
  });
});

describe("syncChatProxyFleetIngressPaths", () => {
  const ingressName = "chat-proxy-fleet-ingress";
  const namespace = "octogee-test";
  const CHAT_PORT = 8080;
  const CHAT_ALIAS = "chat-proxy";

  it("no-ops when live paths already match desired (no gateways → just /health)", async () => {
    const live = {
      kind: "Ingress",
      metadata: { name: ingressName, namespace },
      spec: {
        rules: [
          {
            host: "chat.octogee.com",
            http: {
              paths: [
                {
                  path: "/health",
                  pathType: "ImplementationSpecific",
                  backend: { service: { name: CHAT_ALIAS, port: { number: CHAT_PORT } } },
                },
              ],
            },
          },
        ],
      },
    };
    const { runKubectl, calls } = mockKubectl([{ stdout: JSON.stringify(live) }]);

    const result = await syncChatProxyFleetIngressPaths({
      runKubectl,
      ingressName,
      namespace,
      desiredGateways: [],
      chatProxyPort: CHAT_PORT,
      chatProxyServiceName: CHAT_ALIAS,
      log: vi.fn(),
    });

    expect(result.changed).toBe(false);
    expect(calls).toHaveLength(1); // get only — no apply
  });

  it("applies desired paths with SSA + cowboy field manager when the live ingress diverges", async () => {
    const live = {
      kind: "Ingress",
      apiVersion: "networking.k8s.io/v1",
      metadata: { name: ingressName, namespace },
      spec: {
        ingressClassName: "gce",
        rules: [
          {
            host: "chat.octogee.com",
            http: {
              paths: [
                {
                  path: "/health",
                  pathType: "ImplementationSpecific",
                  backend: { service: { name: CHAT_ALIAS, port: { number: CHAT_PORT } } },
                },
              ],
            },
          },
        ],
      },
    };
    const { runKubectl, calls } = mockKubectl([
      { stdout: JSON.stringify(live) },
      { stdout: "configured" },
    ]);
    await syncChatProxyFleetIngressPaths({
      runKubectl,
      ingressName,
      namespace,
      desiredGateways: [{ gatewayId: "gw-bender", instanceName: "bender" }],
      chatProxyPort: CHAT_PORT,
      chatProxyServiceName: CHAT_ALIAS,
      log: vi.fn(),
    });
    expect(calls[1].args).toContain("apply");
    expect(calls[1].args).toContain("--server-side");
    expect(calls[1].args).toContain("--field-manager=cowboy-fleet-controller");
    expect(calls[1].args).toContain("--force-conflicts");

    const applied = JSON.parse(calls[1].stdin as string);
    expect(applied.spec.rules[0].host).toBe("chat.octogee.com");
    expect(applied.spec.rules[0].http.paths.map((p: { path: string }) => p.path)).toEqual([
      "/g/gw-bender/*",
      "/health",
    ]);
    // Helm continues to own annotations / class / tls — exclude them
    expect(applied.spec.ingressClassName).toBeUndefined();
    expect(applied.metadata.annotations).toBeUndefined();
  });

  it("returns changed=false (not a throw) when the umbrella hasn't deployed the Ingress shell yet", async () => {
    const log = vi.fn();
    const { runKubectl, calls } = mockKubectl([
      {
        code: 1,
        stderr: 'Error from server (NotFound): ingresses.networking.k8s.io "chat-proxy-fleet-ingress" not found',
      },
    ]);
    const result = await syncChatProxyFleetIngressPaths({
      runKubectl,
      ingressName,
      namespace,
      desiredGateways: [{ gatewayId: "gw-bender", instanceName: "bender" }],
      chatProxyPort: CHAT_PORT,
      chatProxyServiceName: CHAT_ALIAS,
      log,
    });
    expect(result.changed).toBe(false);
    expect(calls).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("deferring"));
  });
});
