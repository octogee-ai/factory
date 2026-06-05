import {
  GATEWAY_PLATFORM_SERVICE_ACCOUNT_NAME,
  OPERATOR_GATEWAY_LOCKED_ACCESS,
  OPERATOR_GATEWAY_LOCKED_SERVICE_ACCOUNT,
  operatorGatewayServiceAccountName,
  resolveGatewayPersistence,
  type GatewayDesiredState,
  type HelmInstanceValue,
  type HelmInstancesMap,
} from "../../shared/types/glm.js";
import { resolveGatewayImageRepository } from "./gateway-profiles.js";
import { isSizingTier } from "../../shared/types/sizing.js";

export type ReconcileChange =
  | { kind: "create"; gatewayId: string; to: HelmInstanceValue }
  | { kind: "update"; gatewayId: string; from: HelmInstanceValue; to: HelmInstanceValue }
  | { kind: "drift"; gatewayId: string; current: HelmInstanceValue };

export function deriveFleetImageTag(
  desired: GatewayDesiredState[],
): string | undefined {
  const live = desired.filter((d) => d.desiredStatus !== "retired");
  if (live.length === 0) return undefined;
  const primary = live.find((d) => d.gatewayId === "default") ?? live[0];
  return primary.imageTag;
}

export function buildInstancesMap(
  desired: GatewayDesiredState[],
  chartFingerprint?: string,
): HelmInstancesMap {
  const out: HelmInstancesMap = {};
  for (const d of desired) {
    if (d.desiredStatus === "retired") continue;
    out[d.gatewayId] = buildHelmInstanceValue(d, chartFingerprint);
  }
  return out;
}

export function buildHelmTargetMap(
  desired: GatewayDesiredState[],
  actual: HelmInstancesMap,
  mountedByGatewayId: Map<string, readonly string[]> = new Map(),
  chartFingerprint?: string,
): HelmInstancesMap {
  const out: HelmInstancesMap = { ...actual };
  for (const d of desired) {
    if (d.desiredStatus === "retired") {
      const mounted = mountedByGatewayId.get(d.gatewayId);

if (mounted === undefined || mounted.length === 0) {
        delete out[d.gatewayId];
      }
      continue;
    }
    out[d.gatewayId] = buildHelmInstanceValue(d, chartFingerprint);
  }
  return out;
}

function resolveOperatorHelmKnobs(d: GatewayDesiredState): Pick<
  HelmInstanceValue,
  "serviceAccountName" | "serviceAccount" | "operatorAccess"
> {
  let serviceAccountName = d.serviceAccountName;
  let serviceAccount = d.serviceAccount;
  const generatedOperatorServiceAccountName = operatorGatewayServiceAccountName(d.gatewayId);
  if (
    d.profile === "operator" &&
    (!serviceAccountName || serviceAccountName === GATEWAY_PLATFORM_SERVICE_ACCOUNT_NAME)
  ) {
    serviceAccountName = generatedOperatorServiceAccountName;
  }
  if (
    d.profile === "operator" &&
    serviceAccountName === generatedOperatorServiceAccountName &&
    !serviceAccount
  ) {
    serviceAccount = OPERATOR_GATEWAY_LOCKED_SERVICE_ACCOUNT;
  }
  const operatorAccess =
    d.profile === "operator"
      ? d.operatorAccess ?? OPERATOR_GATEWAY_LOCKED_ACCESS
      : d.operatorAccess;
  return { serviceAccountName, serviceAccount, operatorAccess };
}

function buildHelmInstanceValue(
  d: GatewayDesiredState,
  chartFingerprint?: string,
): HelmInstanceValue {
  const persistence = resolveGatewayPersistence(d.profile, d.persistence);
  const { serviceAccountName, serviceAccount, operatorAccess } = resolveOperatorHelmKnobs(d);
  return {
    enabled: true,
    image: { repository: resolveGatewayImageRepository(d), tag: d.imageTag },
    gatewayId: d.gatewayId,
    replicas: d.desiredStatus === "paused" ? 0 : 1,
    ...(chartFingerprint ? { chartFingerprint } : {}),
    ...(serviceAccountName ? { serviceAccountName } : {}),
    ...(serviceAccount ? { serviceAccount } : {}),
    ...(d.gatewayContainerSecurityContext
      ? { gatewayContainerSecurityContext: d.gatewayContainerSecurityContext }
      : {}),
    ...(persistence ? { persistence } : {}),
    ...(operatorAccess ? { operatorAccess } : {}),
    ...(d.profile ? { profile: d.profile } : {}),
    ...(isSizingTier(d.sizingTier) ? { sizingTier: d.sizingTier } : {}),
  };
}

export interface DiffOptions {
  compareChartFingerprint?: boolean;
}

export function diffInstancesMap(
  actual: HelmInstancesMap,
  desired: HelmInstancesMap,
  opts: DiffOptions = {},
): ReconcileChange[] {
  const compareChartFingerprint = opts.compareChartFingerprint ?? true;
  const changes: ReconcileChange[] = [];
  const allNames = new Set([
    ...Object.keys(actual),
    ...Object.keys(desired),
  ]);
  const actualEntries = new Map(Object.entries(actual));
  const desiredEntries = new Map(Object.entries(desired));
  for (const name of allNames) {
    const a = actualEntries.get(name);
    const d = desiredEntries.get(name);
    if (!a && d) {
      changes.push({ kind: "create", gatewayId: name, to: d });
    } else if (a && !d) {
      changes.push({ kind: "drift", gatewayId: name, current: a });
    } else if (a && d && !instanceEqual(a, d, compareChartFingerprint)) {
      changes.push({ kind: "update", gatewayId: name, from: a, to: d });
    }
  }
  return changes;
}

function instanceEqual(
  a: HelmInstanceValue,
  b: HelmInstanceValue,
  compareChartFingerprint: boolean,
): boolean {
  const scalars: ReadonlyArray<[unknown, unknown]> = [
    [a.enabled, b.enabled],
    [a.image.repository, b.image.repository],
    [a.image.tag, b.image.tag],
    [a.gatewayId, b.gatewayId],
    [a.serviceAccountName, b.serviceAccountName],
    [a.profile, b.profile],
    [a.sizingTier, b.sizingTier],
    [a.replicas, b.replicas],
  ];
  for (const [x, y] of scalars) if (x !== y) return false;
  if (compareChartFingerprint && a.chartFingerprint !== b.chartFingerprint) return false;
  const objects: ReadonlyArray<[unknown, unknown]> = [
    [a.gatewayContainerSecurityContext, b.gatewayContainerSecurityContext],
    [a.serviceAccount, b.serviceAccount],
    [a.persistence, b.persistence],
    [a.operatorAccess, b.operatorAccess],
  ];
  for (const [x, y] of objects) {
    if (!stableEqual(x, y)) return false;
  }
  return true;
}

export function isReplicasOnlyUpdate(c: ReconcileChange): boolean {
  if (c.kind !== "update") return false;
  if (c.from.replicas === c.to.replicas) return false;
  if (c.from.enabled !== c.to.enabled) return false;
  if (c.from.image.repository !== c.to.image.repository) return false;
  if (c.from.image.tag !== c.to.image.tag) return false;
  if (c.from.gatewayId !== c.to.gatewayId) return false;
  if (c.from.serviceAccountName !== c.to.serviceAccountName) return false;
  if (c.from.profile !== c.to.profile) return false;
  if (c.from.sizingTier !== c.to.sizingTier) return false;
  if (c.from.chartFingerprint !== c.to.chartFingerprint) return false;
  const objects: ReadonlyArray<[unknown, unknown]> = [
    [c.from.gatewayContainerSecurityContext, c.to.gatewayContainerSecurityContext],
    [c.from.serviceAccount, c.to.serviceAccount],
    [c.from.persistence, c.to.persistence],
    [c.from.operatorAccess, c.to.operatorAccess],
  ];
  for (const [x, y] of objects) {
    if (!stableEqual(x, y)) return false;
  }
  return true;
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const entries = Object.entries(v as Record<string, unknown>).sort(
    ([a], [b]) => {
      if (a < b) return -1;
      if (a > b) return 1;
      return 0;
    },
  );
  return `{${entries
    .map(([k, val]) => `${JSON.stringify(k)}:${stableStringify(val)}`)
    .join(",")}}`;
}

function stableEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a ?? null) === stableStringify(b ?? null);
}
