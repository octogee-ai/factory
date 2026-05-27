import type {
  GatewayDesiredState,
  HelmInstanceValue,
  HelmInstancesMap,
} from "../../shared/types/glm.js";
import { resolveGatewayImageRepository } from "./gateway-profiles.js";

export type ReconcileChange =
  | { kind: "create"; instanceName: string; to: HelmInstanceValue }
  | { kind: "update"; instanceName: string; from: HelmInstanceValue; to: HelmInstanceValue }
  | { kind: "drift"; instanceName: string; current: HelmInstanceValue };

export function deriveFleetImageTag(
  desired: GatewayDesiredState[],
): string | undefined {
  const live = desired.filter((d) => d.desiredStatus !== "retired");
  if (live.length === 0) return undefined;
  const primary = live.find((d) => d.instanceName === "default") ?? live[0];
  return primary.imageTag;
}

export function buildInstancesMap(
  desired: GatewayDesiredState[],
  chartFingerprint?: string,
): HelmInstancesMap {
  const out: HelmInstancesMap = {};
  for (const d of desired) {
    if (d.desiredStatus === "retired") continue;
    out[d.instanceName] = {
      enabled: true,
      image: { repository: resolveGatewayImageRepository(d), tag: d.imageTag },
      gatewayId: d.gatewayId,
      replicas: d.desiredStatus === "paused" ? 0 : 1,
      ...(chartFingerprint ? { chartFingerprint } : {}),
      ...(d.serviceAccountName ? { serviceAccountName: d.serviceAccountName } : {}),
      ...(d.gatewayContainerSecurityContext
        ? { gatewayContainerSecurityContext: d.gatewayContainerSecurityContext }
        : {}),
      ...(d.persistence ? { persistence: d.persistence } : {}),
      ...(d.profile ? { profile: d.profile } : {}),
      ...(d.sizingTier ? { sizingTier: d.sizingTier } : {}),
    };
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
        delete out[d.instanceName];
      }
      continue;
    }
    out[d.instanceName] = {
      enabled: true,
      image: { repository: resolveGatewayImageRepository(d), tag: d.imageTag },
      gatewayId: d.gatewayId,
      replicas: d.desiredStatus === "paused" ? 0 : 1,
      ...(chartFingerprint ? { chartFingerprint } : {}),
      ...(d.serviceAccountName ? { serviceAccountName: d.serviceAccountName } : {}),
      ...(d.gatewayContainerSecurityContext
        ? { gatewayContainerSecurityContext: d.gatewayContainerSecurityContext }
        : {}),
      ...(d.persistence ? { persistence: d.persistence } : {}),
      ...(d.profile ? { profile: d.profile } : {}),
      ...(d.sizingTier ? { sizingTier: d.sizingTier } : {}),
    };
  }
  return out;
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
      changes.push({ kind: "create", instanceName: name, to: d });
    } else if (a && !d) {
      changes.push({ kind: "drift", instanceName: name, current: a });
    } else if (a && d && !instanceEqual(a, d, compareChartFingerprint)) {
      changes.push({ kind: "update", instanceName: name, from: a, to: d });
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
  if (stableStringify(a.gatewayContainerSecurityContext ?? null) !==
      stableStringify(b.gatewayContainerSecurityContext ?? null)) return false;
  if (stableStringify(a.persistence ?? null) !== stableStringify(b.persistence ?? null)) return false;
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
  if (
    stableStringify(c.from.gatewayContainerSecurityContext ?? null) !==
    stableStringify(c.to.gatewayContainerSecurityContext ?? null)
  ) {
    return false;
  }
  if (stableStringify(c.from.persistence ?? null) !== stableStringify(c.to.persistence ?? null)) {
    return false;
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
