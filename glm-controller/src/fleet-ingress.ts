import { spawn } from "node:child_process";

/**
 * Cowboy-owned reconciliation of the umbrella's
 * `octogee-gateway-fleet-control-ingress` Ingress: per-instance RPC
 * paths (/restore-customer/<gid>, /quiesce/<gid>, ...) appear when a
 * gateway is added and disappear when one is retired, without an
 * operator-driven `helm upgrade` of the umbrella.
 *
 * The umbrella's gateway-fleet.yaml renders the Ingress shell with
 * only the static /health path. Cowboy uses server-side apply with
 * field manager `cowboy-fleet-controller` and `--force-conflicts` to
 * own `.spec.rules`. The canonical umbrella install also runs with
 * `--server-side=true --force-conflicts`, so a `helm upgrade` can hand
 * ownership back to Helm transiently; Cowboy reclaims and re-applies
 * the desired path list on its next reconcile tick (~1s debounce).
 *
 * To minimize what Cowboy claims ownership of, the apply payload
 * carries ONLY `spec.rules[].http.paths` (and the `host` that wraps
 * them). Annotations, labels, ingressClassName, and tls stay owned by
 * Helm.
 */
export interface FleetGateway {
  gatewayId: string;
  instanceName: string;
}

export interface IngressPathRule {
  path: string;
  pathType: string;
  serviceName: string;
  servicePort: number;
}

const RPC_VERBS = ["restore-customer", "quiesce", "export", "import", "unmount"] as const;

export function computeDesiredFleetPaths(opts: {
  gateways: ReadonlyArray<FleetGateway>;
  fleetControllerPort: number;
  aliasServiceName: string;
}): IngressPathRule[] {
  const sorted = [...opts.gateways].sort((a, b) =>
    a.gatewayId.localeCompare(b.gatewayId),
  );
  const out: IngressPathRule[] = [];
  for (const gw of sorted) {
    for (const verb of RPC_VERBS) {
      out.push({
        path: `/${verb}/${gw.gatewayId}`,
        pathType: "ImplementationSpecific",
        serviceName: `octogee-gateway-${gw.instanceName}`,
        servicePort: opts.fleetControllerPort,
      });
    }
  }
  out.push({
    path: "/health",
    pathType: "ImplementationSpecific",
    serviceName: opts.aliasServiceName,
    servicePort: opts.fleetControllerPort,
  });
  return out;
}

/**
 * Per-gateway path rules for the api.octogee.com gateway-edge seam
 * (FLEET-API-ROUTING-SPEC). One rule per gateway: `/api/g/<gatewayId>/*`
 * → `gateway-edge-<instanceName>:3001` (the per-instance Service that
 * already pins to the gateway's pod). Helm continues to render the
 * static admin / legacy paths on `gateway-edge-ingress`; Cowboy owns
 * the per-gateway path list on a sibling Ingress shell. Same SSA-with-
 * field-manager pattern as `computeDesiredFleetPaths` above.
 */
export function computeDesiredApiFleetPaths(opts: {
  gateways: ReadonlyArray<FleetGateway>;
  gatewayEdgePort: number;
  /** Round-robin alias Service for the `/health` fallback path. K8s
   *  Ingress requires every rule to have ≥1 path, so /health doubles as
   *  the always-present minimum AND the LB health check target. */
  gatewayEdgeServiceName: string;
}): IngressPathRule[] {
  const sorted = [...opts.gateways].sort((a, b) =>
    a.gatewayId.localeCompare(b.gatewayId),
  );
  const out: IngressPathRule[] = sorted.map((gw) => ({
    path: `/api/g/${gw.gatewayId}/*`,
    pathType: "ImplementationSpecific",
    serviceName: `gateway-edge-${gw.instanceName}`,
    servicePort: opts.gatewayEdgePort,
  }));
  out.push({
    path: "/health",
    pathType: "ImplementationSpecific",
    serviceName: opts.gatewayEdgeServiceName,
    servicePort: opts.gatewayEdgePort,
  });
  return out;
}

function ruleEqual(x: IngressPathRule, y: IngressPathRule): boolean {
  return (
    x.path === y.path &&
    x.pathType === y.pathType &&
    x.serviceName === y.serviceName &&
    x.servicePort === y.servicePort
  );
}

/**
 * Strict equality on path lists, including order (GCE URL maps respect
 * the order of `paths` for longest-prefix matching). Note: if the live
 * Ingress ever contains a path with a *named* port (e.g. `port: { name:
 * "http" }`), `extractIngressPaths` drops it and `pathsEqual` will
 * report a diff — Cowboy will then re-apply with numbered ports. This
 * is correct: the BackendConfig binds the port number, named ports
 * would not match. The noop optimization is defeated for that ingress
 * but convergence is unaffected.
 */
export function pathsEqual(
  a: ReadonlyArray<IngressPathRule>,
  b: ReadonlyArray<IngressPathRule>,
): boolean {
  if (a.length !== b.length) return false;
  // eslint-disable-next-line security/detect-object-injection -- typed array index from .every()
  return a.every((x, i) => ruleEqual(x, b[i]!));
}

interface RawIngressPath {
  path?: unknown;
  pathType?: unknown;
  backend?: { service?: { name?: unknown; port?: { number?: unknown; name?: unknown } } };
}

interface RawIngress {
  spec?: {
    rules?: Array<{ http?: { paths?: RawIngressPath[] } }>;
  };
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}

function parsePathRule(p: RawIngressPath): IngressPathRule | null {
  const path = asString(p?.path);
  const pathType = asString(p?.pathType);
  const serviceName = asString(p?.backend?.service?.name);
  const servicePort = asNumber(p?.backend?.service?.port?.number);
  if (path == null || pathType == null || serviceName == null || servicePort == null) {
    return null;
  }
  return { path, pathType, serviceName, servicePort };
}

export function extractIngressPaths(raw: unknown): IngressPathRule[] {
  const ingress = raw as RawIngress;
  const rules = ingress?.spec?.rules ?? [];
  const out: IngressPathRule[] = [];
  for (const rule of rules) {
    const paths = rule?.http?.paths ?? [];
    for (const p of paths) {
      const parsed = parsePathRule(p);
      if (parsed) out.push(parsed);
    }
  }
  return out;
}

export interface KubectlSubprocessResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type KubectlSubprocess = (
  args: string[],
  opts?: { stdin?: string },
) => Promise<KubectlSubprocessResult>;

export interface SyncFleetIngressPathsOpts {
  runKubectl: KubectlSubprocess;
  ingressName: string;
  namespace: string;
  desiredGateways: ReadonlyArray<FleetGateway>;
  fleetControllerPort: number;
  aliasServiceName: string;
  log: (msg: string) => void;
}

export interface SyncFleetIngressPathsResult {
  changed: boolean;
}

export const FIELD_MANAGER = "cowboy-fleet-controller";

const NOT_FOUND_PATTERNS = [
  /Error from server \(NotFound\)/i,
  /ingresses.networking.k8s.io.*not found/i,
];

function isIngressNotFound(stderr: string): boolean {
  return NOT_FOUND_PATTERNS.some((p) => p.test(stderr));
}

export async function syncFleetIngressPaths(
  opts: SyncFleetIngressPathsOpts,
): Promise<SyncFleetIngressPathsResult> {
  const desired = computeDesiredFleetPaths({
    gateways: opts.desiredGateways,
    fleetControllerPort: opts.fleetControllerPort,
    aliasServiceName: opts.aliasServiceName,
  });

  const getResult = await opts.runKubectl([
    "get",
    "ingress",
    opts.ingressName,
    "-n",
    opts.namespace,
    "-o",
    "json",
  ]);
  if (getResult.code !== 0) {
    if (isIngressNotFound(getResult.stderr)) {
      // Bootstrap state: umbrella hasn't been deployed yet (or the
      // Ingress was manually deleted). Defer — once helm renders the
      // shell, the next reconciler tick picks up routing.
      opts.log(
        `[fleet-ingress] ingress ${opts.ingressName} not yet present in ${opts.namespace} — deferring`,
      );
      return { changed: false };
    }
    throw new Error(
      `kubectl get ingress ${opts.ingressName} failed (code=${getResult.code}): ${getResult.stderr.trim() || getResult.stdout.trim()}`,
    );
  }
  const live = JSON.parse(getResult.stdout) as Record<string, unknown>;
  const livePaths = extractIngressPaths(live);
  if (pathsEqual(livePaths, desired)) {
    return { changed: false };
  }

  const next = buildAppliableIngress(live, desired);
  const applyResult = await opts.runKubectl(
    [
      "apply",
      "-n",
      opts.namespace,
      "--server-side",
      `--field-manager=${FIELD_MANAGER}`,
      "--force-conflicts",
      "-f",
      "-",
    ],
    { stdin: JSON.stringify(next) },
  );
  if (applyResult.code !== 0) {
    throw new Error(
      `kubectl apply ${opts.ingressName} failed (code=${applyResult.code}): ${applyResult.stderr.trim() || applyResult.stdout.trim()}`,
    );
  }
  opts.log(
    `[fleet-ingress] applied ${desired.length} path(s) to ${opts.ingressName} (${opts.namespace})`,
  );
  return { changed: true };
}

export interface SyncApiFleetIngressPathsOpts {
  runKubectl: KubectlSubprocess;
  ingressName: string;
  namespace: string;
  desiredGateways: ReadonlyArray<FleetGateway>;
  gatewayEdgePort: number;
  gatewayEdgeServiceName: string;
  log: (msg: string) => void;
}

/**
 * SSA-reconcile per-gateway `/api/g/<gatewayId>/*` paths on the
 * Cowboy-owned `gateway-edge-fleet-ingress` shell. Mirror of
 * `syncFleetIngressPaths` for the api.octogee.com seam — shares
 * `buildAppliableIngress`, `extractIngressPaths`, `pathsEqual`, and the
 * same field manager. Helm renders the Ingress shell (host, cert, IP);
 * Cowboy owns spec.rules[].http.paths. Defers cleanly when the shell
 * is not yet present.
 */
export async function syncApiFleetIngressPaths(
  opts: SyncApiFleetIngressPathsOpts,
): Promise<SyncFleetIngressPathsResult> {
  const desired = computeDesiredApiFleetPaths({
    gateways: opts.desiredGateways,
    gatewayEdgePort: opts.gatewayEdgePort,
    gatewayEdgeServiceName: opts.gatewayEdgeServiceName,
  });

  const getResult = await opts.runKubectl([
    "get",
    "ingress",
    opts.ingressName,
    "-n",
    opts.namespace,
    "-o",
    "json",
  ]);
  if (getResult.code !== 0) {
    if (isIngressNotFound(getResult.stderr)) {
      opts.log(
        `[fleet-ingress] ingress ${opts.ingressName} not yet present in ${opts.namespace} — deferring`,
      );
      return { changed: false };
    }
    throw new Error(
      `kubectl get ingress ${opts.ingressName} failed (code=${getResult.code}): ${getResult.stderr.trim() || getResult.stdout.trim()}`,
    );
  }
  const live = JSON.parse(getResult.stdout) as Record<string, unknown>;
  const livePaths = extractIngressPaths(live);
  if (pathsEqual(livePaths, desired)) {
    return { changed: false };
  }

  const next = buildAppliableIngress(live, desired);
  const applyResult = await opts.runKubectl(
    [
      "apply",
      "-n",
      opts.namespace,
      "--server-side",
      `--field-manager=${FIELD_MANAGER}`,
      "--force-conflicts",
      "-f",
      "-",
    ],
    { stdin: JSON.stringify(next) },
  );
  if (applyResult.code !== 0) {
    throw new Error(
      `kubectl apply ${opts.ingressName} failed (code=${applyResult.code}): ${applyResult.stderr.trim() || applyResult.stdout.trim()}`,
    );
  }
  opts.log(
    `[fleet-ingress] applied ${desired.length} path(s) to ${opts.ingressName} (${opts.namespace})`,
  );
  return { changed: true };
}

function buildAppliableIngress(
  live: Record<string, unknown>,
  desired: ReadonlyArray<IngressPathRule>,
): Record<string, unknown> {
  const liveTyped = live as {
    apiVersion?: string;
    kind?: string;
    metadata?: { name?: string; namespace?: string };
    spec?: { rules?: Array<{ host?: string }> };
  };
  const host = liveTyped.spec?.rules?.[0]?.host;
  const newPaths = desired.map((p) => ({
    path: p.path,
    pathType: p.pathType,
    backend: {
      service: {
        name: p.serviceName,
        port: { number: p.servicePort },
      },
    },
  }));
  return {
    apiVersion: liveTyped.apiVersion ?? "networking.k8s.io/v1",
    kind: liveTyped.kind ?? "Ingress",
    metadata: {
      name: liveTyped.metadata?.name,
      namespace: liveTyped.metadata?.namespace,
    },
    spec: {
      rules: [
        {
          ...(host ? { host } : {}),
          http: { paths: newPaths },
        },
      ],
    },
  };
}

const DEFAULT_KUBECTL_BIN = "/usr/local/bin/kubectl";

/**
 * Subprocess implementation that shells out to the real `kubectl` CLI.
 * Spawned with stdin support so server-side apply can stream a manifest.
 */
export function spawnKubectl(
  args: string[],
  opts: { stdin?: string } = {},
): Promise<KubectlSubprocessResult> {
  const bin = process.env.KUBECTL_BIN ?? DEFAULT_KUBECTL_BIN;
  return new Promise<KubectlSubprocessResult>((resolve, reject) => {
    const proc = spawn(bin, args, {
      stdio: [opts.stdin ? "pipe" : "ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout!.on("data", (chunk) => { stdout += chunk.toString(); });
    proc.stderr!.on("data", (chunk) => { stderr += chunk.toString(); });
    proc.on("error", reject);
    proc.on("close", (code, signal) => {
      if (signal !== null) {
        resolve({
          stdout,
          stderr: stderr + `\nkubectl terminated by signal ${signal}`,
          code: 128,
        });
        return;
      }
      resolve({ stdout, stderr, code: code ?? 1 });
    });
    if (opts.stdin) {
      proc.stdin!.write(opts.stdin);
      proc.stdin!.end();
    }
  });
}
