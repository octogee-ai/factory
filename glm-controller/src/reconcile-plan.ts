import {
  GATEWAY_PLATFORM_SERVICE_ACCOUNT_NAME,
  defaultOperatorGatewayAccess,
  OPERATOR_GATEWAY_LOCKED_SERVICE_ACCOUNT,
  operatorGatewayServiceAccountName,
  resolveGatewayClass,
  resolveGatewayImageProfile,
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
  apiServerEgressCidrs: readonly string[] = [],
): HelmInstancesMap {
  const out: HelmInstancesMap = {};
  for (const d of desired) {
    if (d.desiredStatus === "retired") continue;
    out[d.gatewayId] = buildHelmInstanceValue(d, chartFingerprint, apiServerEgressCidrs);
  }
  return out;
}

export function buildHelmTargetMap(
  desired: GatewayDesiredState[],
  actual: HelmInstancesMap,
  mountedByGatewayId: Map<string, readonly string[]> = new Map(),
  chartFingerprint?: string,
  apiServerEgressCidrs: readonly string[] = [],
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
    out[d.gatewayId] = buildHelmInstanceValue(d, chartFingerprint, apiServerEgressCidrs);
  }
  return out;
}

function resolveGatewayHelmKnobs(d: GatewayDesiredState): Pick<
  HelmInstanceValue,
  "serviceAccountName" | "serviceAccount" | "operatorAccess"
> {
  const gatewayClass = resolveGatewayClass(d);
  let serviceAccountName = d.serviceAccountName;
  let serviceAccount = d.serviceAccount;
  const generatedGatewayServiceAccountName = operatorGatewayServiceAccountName(d.gatewayId);
  if (
    (!serviceAccountName || serviceAccountName === GATEWAY_PLATFORM_SERVICE_ACCOUNT_NAME)
  ) {
    serviceAccountName = generatedGatewayServiceAccountName;
  }
  if (
    gatewayClass === "operator" &&
    serviceAccountName === generatedGatewayServiceAccountName &&
    !serviceAccount
  ) {
    serviceAccount = OPERATOR_GATEWAY_LOCKED_SERVICE_ACCOUNT;
  }
  if (
    gatewayClass !== "operator" &&
    serviceAccountName === generatedGatewayServiceAccountName &&
    !serviceAccount
  ) {
    serviceAccount = { create: true };
  }
  const operatorAccess =
    gatewayClass === "operator"
      ? d.operatorAccess ?? defaultOperatorGatewayAccess(d.ownerUid)
      : d.operatorAccess;
  return { serviceAccountName, serviceAccount, operatorAccess };
}

// Cowboy injects the live apiserver egress CIDRs (resolved per reconcile) for
// operator gateways with shells on, so the egress NetworkPolicy tracks the real
// control-plane endpoint without an operator ever setting it. Skipped when none
// resolved, so a transient read failure can't strip a working gateway's egress.
function injectApiServerEgress(
  operatorAccess: HelmInstanceValue["operatorAccess"],
  apiServerEgressCidrs: readonly string[],
): HelmInstanceValue["operatorAccess"] {
  if (!operatorAccess?.shellsEnabled || apiServerEgressCidrs.length === 0) {
    return operatorAccess;
  }
  return { ...operatorAccess, kubeApiServerEgressCidrs: [...apiServerEgressCidrs] };
}

function buildHelmInstanceValue(
  d: GatewayDesiredState,
  chartFingerprint?: string,
  apiServerEgressCidrs: readonly string[] = [],
): HelmInstanceValue {
  const gatewayClass = resolveGatewayClass(d);
  const imageProfile = resolveGatewayImageProfile(d);
  const persistence = resolveGatewayPersistence(imageProfile, d.persistence);
  const { serviceAccountName, serviceAccount, operatorAccess: baseAccess } = resolveGatewayHelmKnobs(d);
  const operatorAccess = injectApiServerEgress(baseAccess, apiServerEgressCidrs);
  return {
    enabled: true,
    image: { repository: resolveGatewayImageRepository(d), tag: d.imageTag },
    gatewayId: d.gatewayId,
    ...(d.builderSlug ? { builderSlug: d.builderSlug } : {}),
    replicas: d.desiredStatus === "paused" ? 0 : 1,
    ...(chartFingerprint ? { chartFingerprint } : {}),
    ...(serviceAccountName ? { serviceAccountName } : {}),
    ...(serviceAccount ? { serviceAccount } : {}),
    ...(d.gatewayContainerSecurityContext
      ? { gatewayContainerSecurityContext: d.gatewayContainerSecurityContext }
      : {}),
    ...(persistence ? { persistence } : {}),
    ...(operatorAccess ? { operatorAccess } : {}),
    ...(gatewayClass !== "shared" ? { gatewayClass } : {}),
    ...(imageProfile !== "standard" ? { imageProfile, profile: imageProfile } : {}),
    ...(isSizingTier(d.sizingTier) ? { sizingTier: d.sizingTier } : {}),
    ...(typeof d.computeClass === "string" && d.computeClass.length > 0
      ? { computeClassOverride: d.computeClass }
      : {}),
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
    [a.builderSlug, b.builderSlug],
    [effectiveServiceAccountName(a), effectiveServiceAccountName(b)],
    [a.sizingTier, b.sizingTier],
    [a.computeClassOverride, b.computeClassOverride],
    [a.replicas, b.replicas],
  ];
  for (const [x, y] of scalars) if (x !== y) return false;
  if (resolveGatewayClass(a) !== resolveGatewayClass(b)) return false;
  if (resolveGatewayImageProfile(a) !== resolveGatewayImageProfile(b)) return false;
  if (compareChartFingerprint && a.chartFingerprint !== b.chartFingerprint) return false;
  const objects: ReadonlyArray<[unknown, unknown]> = [
    [a.gatewayContainerSecurityContext, b.gatewayContainerSecurityContext],
    [effectiveServiceAccount(a), effectiveServiceAccount(b)],
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
  if (c.from.builderSlug !== c.to.builderSlug) return false;
  if (effectiveServiceAccountName(c.from) !== effectiveServiceAccountName(c.to)) return false;
  if (resolveGatewayClass(c.from) !== resolveGatewayClass(c.to)) return false;
  if (resolveGatewayImageProfile(c.from) !== resolveGatewayImageProfile(c.to)) return false;
  if (c.from.sizingTier !== c.to.sizingTier) return false;
  if (c.from.chartFingerprint !== c.to.chartFingerprint) return false;
  const objects: ReadonlyArray<[unknown, unknown]> = [
    [c.from.gatewayContainerSecurityContext, c.to.gatewayContainerSecurityContext],
    [effectiveServiceAccount(c.from), effectiveServiceAccount(c.to)],
    [c.from.persistence, c.to.persistence],
    [c.from.operatorAccess, c.to.operatorAccess],
  ];
  for (const [x, y] of objects) {
    if (!stableEqual(x, y)) return false;
  }
  return true;
}

function effectiveServiceAccountName(v: HelmInstanceValue): string | undefined {
  if (!v.gatewayId) return v.serviceAccountName;
  const requested = v.serviceAccountName ?? "";
  if (requested === "" || requested === GATEWAY_PLATFORM_SERVICE_ACCOUNT_NAME) {
    return operatorGatewayServiceAccountName(v.gatewayId);
  }
  return requested;
}

function effectiveServiceAccount(v: HelmInstanceValue): HelmInstanceValue["serviceAccount"] {
  if (v.serviceAccount) return v.serviceAccount;
  if (
    resolveGatewayClass(v) !== "operator" &&
    v.gatewayId &&
    effectiveServiceAccountName(v) === operatorGatewayServiceAccountName(v.gatewayId)
  ) {
    return { create: true };
  }
  return undefined;
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
