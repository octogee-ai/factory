import { spawn } from "node:child_process";

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

const RPC_VERBS = ["restore-customer", "quiesce", "export", "push-state", "import", "unmount"] as const;

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

export function computeDesiredApiFleetPaths(opts: {
  gateways: ReadonlyArray<FleetGateway>;
  gatewayEdgePort: number;

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

export interface JsonPatchOp {
  op: "add" | "remove" | "test";
  path: string;
  value?: unknown;
}

const API_FLEET_PREFIX = "/api/g/";

export function computeApiFleetPathOps(
  rawPaths: ReadonlyArray<RawIngressPath>,
  desired: ReadonlyArray<IngressPathRule>,
): JsonPatchOp[] {
  const sig = (path: string, svc: string, port: number, pathType: string): string =>
    `${path}\0${svc}\0${port}\0${pathType}`;

  const liveFleet = rawPaths
    .map((p, index) => ({ p, index }))
    .filter((e) => typeof e.p.path === "string" && e.p.path.startsWith(API_FLEET_PREFIX));

  const liveSig = new Set(
    liveFleet
      .map((e) => parsePathRule(e.p))
      .filter((r): r is IngressPathRule => r !== null)
      .map((r) => sig(r.path, r.serviceName, r.servicePort, r.pathType)),
  );
  const desiredSig = new Set(
    desired.map((r) => sig(r.path, r.serviceName, r.servicePort, r.pathType)),
  );

  const inSync =
    liveSig.size === desiredSig.size &&
    liveFleet.length === desired.length &&
    [...desiredSig].every((s) => liveSig.has(s));
  if (inSync) return [];

  const ops: JsonPatchOp[] = [];

for (const e of [...liveFleet].sort((a, b) => b.index - a.index)) {
    ops.push({
      op: "test",
      path: `/spec/rules/0/http/paths/${e.index}/path`,
      value: e.p.path,
    });
    ops.push({ op: "remove", path: `/spec/rules/0/http/paths/${e.index}` });
  }
  for (const r of desired) {
    ops.push({
      op: "add",
      path: "/spec/rules/0/http/paths/-",
      value: {
        path: r.path,
        pathType: r.pathType,
        backend: { service: { name: r.serviceName, port: { number: r.servicePort } } },
      },
    });
  }
  return ops;
}

function ruleEqual(x: IngressPathRule, y: IngressPathRule): boolean {
  return (
    x.path === y.path &&
    x.pathType === y.pathType &&
    x.serviceName === y.serviceName &&
    x.servicePort === y.servicePort
  );
}

export function pathsEqual(
  a: ReadonlyArray<IngressPathRule>,
  b: ReadonlyArray<IngressPathRule>,
): boolean {
  if (a.length !== b.length) return false;
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

export async function syncApiFleetIngressPaths(
  opts: SyncApiFleetIngressPathsOpts,
): Promise<SyncFleetIngressPathsResult> {
  const desired = computeDesiredApiFleetPaths({
    gateways: opts.desiredGateways,
    gatewayEdgePort: opts.gatewayEdgePort,
    gatewayEdgeServiceName: opts.gatewayEdgeServiceName,
  }).filter((p) => p.path !== "/health");

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
  const live = JSON.parse(getResult.stdout) as RawIngress;
  const rawPaths = live?.spec?.rules?.[0]?.http?.paths ?? [];
  const ops = computeApiFleetPathOps(rawPaths, desired);
  if (ops.length === 0) {
    return { changed: false };
  }

  const patchResult = await opts.runKubectl([
    "patch",
    "ingress",
    opts.ingressName,
    "-n",
    opts.namespace,
    "--type=json",
    "-p",
    JSON.stringify(ops),
  ]);
  if (patchResult.code !== 0) {
    throw new Error(
      `kubectl patch ${opts.ingressName} failed (code=${patchResult.code}): ${patchResult.stderr.trim() || patchResult.stdout.trim()}`,
    );
  }
  opts.log(
    `[fleet-ingress] patched ${desired.length} /api/g/* path(s) onto ${opts.ingressName} (${opts.namespace})`,
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
