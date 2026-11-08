import type { FleetRegistryRecord, PlatformStateStore, Stored } from "@octogee/core/platform-state";
import { GATEWAY_UNREACHABLE_AFTER_MS } from "@octogee/shared/types/fleet-controller";
import { projectGatewayDesiredRootForGateway } from "@octogee/shared/types/gateway-releases";
import { deriveSharedGatewayPoolConfig } from "@octogee/shared/types/shared-gateway-pool";
import { imageTagMatchesArtifact } from "./release-convergence.js";

export type ReleaseStatusObservation =
  | "converged"
  | "rolling"
  | "missing-release"
  | "missing-runtime"
  | "runtime-stale"
  | "heartbeat-stale"
  | "not-serving"
  | "unhealthy"
  | "version-drift"
  | "paused"
  | "retired"
  | "invalid-root";

export interface ReleaseStatusRuntime {
  release: number;
  lifecycle: string;
  heartbeatStatus: string;
  heartbeatVersion: string | null;
  lastHeartbeatAt: number;
}

export interface ReleaseStatusGatewayInput {
  gatewayId: string;
  desiredStatus: string;
  desiredRelease: number;
  liveRelease: number | null;
  desiredImageTag: string | null;
  runtime: ReleaseStatusRuntime | null;
}

export interface ReleaseStatusGateway {
  gatewayId: string;
  isDefault: boolean;
  desiredStatus: string | null;
  desiredRelease: number | null;
  liveRelease: number | null;
  desiredImageTag: string | null;
  runtimeRelease: number | null;
  runtimeLifecycle: string | null;
  heartbeatStatus: string | null;
  heartbeatVersion: string | null;
  lastHeartbeatAt: number | null;
  observation: ReleaseStatusObservation;
}

export interface ReleaseStatusSnapshot {
  defaultGatewayId: string | null;
  defaultSelection: ReleaseStatusDefaultSelection;
  gateways: ReleaseStatusGateway[];
}

export type ReleaseStatusDefaultSelection =
  | "selected"
  | "unconfigured"
  | "invalid";

export function summarizeReleaseStatus(snapshot: ReleaseStatusSnapshot): {
  status: "converged" | "incomplete";
  serving: number;
  converged: number;
  excluded: number;
  blockers: string[];
} {
  const blockers: string[] = [];
  if (snapshot.defaultSelection !== "selected") {
    blockers.push(`default gateway: ${snapshot.defaultSelection}`);
  } else {
    const selected = snapshot.gateways.find((gateway) => gateway.gatewayId === snapshot.defaultGatewayId);
    if (!selected || selected.observation === "paused" || selected.observation === "retired") {
      blockers.push(`default gateway: ${selected?.observation ?? "missing"}`);
    }
  }
  let serving = 0;
  let converged = 0;
  let excluded = 0;
  for (const gateway of snapshot.gateways) {
    if (gateway.observation === "paused" || gateway.observation === "retired") {
      excluded += 1;
      continue;
    }
    if (gateway.observation !== "invalid-root") serving += 1;
    if (gateway.observation === "converged") {
      converged += 1;
    } else {
      blockers.push(`${gateway.gatewayId}: ${gateway.observation}`);
    }
  }
  if (serving === 0) blockers.push("no serving gateways");
  return { status: blockers.length === 0 ? "converged" : "incomplete", serving, converged, excluded, blockers };
}

export function observeGatewayRelease(
  input: ReleaseStatusGatewayInput,
  now = Date.now(),
): ReleaseStatusObservation {
  if (input.desiredStatus === "retired") return "retired";
  if (input.desiredStatus === "paused") return "paused";
  if (!input.desiredImageTag) return "missing-release";
  if (!input.runtime) return "missing-runtime";
  if (input.desiredRelease !== input.liveRelease) return "rolling";
  if (input.runtime.release !== input.desiredRelease) return "runtime-stale";
  if (input.runtime.lifecycle !== "serving") return "not-serving";
  if (input.runtime.heartbeatStatus !== "ready") return "unhealthy";
  if (now - input.runtime.lastHeartbeatAt > GATEWAY_UNREACHABLE_AFTER_MS) {
    return "heartbeat-stale";
  }
  if (!imageTagMatchesArtifact(input.runtime.heartbeatVersion, input.desiredImageTag)) {
    return "version-drift";
  }
  return "converged";
}

function millis(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 8.64e15 ? value : null;
}

function projectRuntime(record: Stored<FleetRegistryRecord>): ReleaseStatusRuntime | null {
  const heartbeat = record.heartbeat as unknown;
  if (!heartbeat || typeof heartbeat !== "object") return null;
  const observation = heartbeat as Record<string, unknown>;
  if (typeof observation.status !== "string" || observation.status.length === 0) return null;
  if (
    observation.version !== undefined &&
    observation.version !== null &&
    typeof observation.version !== "string"
  ) return null;
  const lastHeartbeatAt = millis(observation.lastHeartbeatAt);
  if (lastHeartbeatAt === null) return null;
  return {
    release: record.release,
    lifecycle: record.lifecycle,
    heartbeatStatus: observation.status,
    heartbeatVersion: typeof observation.version === "string" ? observation.version : null,
    lastHeartbeatAt,
  };
}

function invalidRoot(gatewayId: string, defaultGatewayId: string | null): ReleaseStatusGateway {
  return {
    gatewayId,
    isDefault: gatewayId === defaultGatewayId,
    desiredStatus: null,
    desiredRelease: null,
    liveRelease: null,
    desiredImageTag: null,
    runtimeRelease: null,
    runtimeLifecycle: null,
    heartbeatStatus: null,
    heartbeatVersion: null,
    lastHeartbeatAt: null,
    observation: "invalid-root",
  };
}

export async function readReleaseStatus(
  store: PlatformStateStore,
  now = Date.now(),
): Promise<ReleaseStatusSnapshot> {
  const roots = await store.gateways.roots.list();
  const pool = deriveSharedGatewayPoolConfig(roots.map((root) => ({
    gatewayId: root.gatewayId,
    gatewayClass: root.gatewayClass,
    desiredStatus: root.desiredStatus,
  })));
  const defaultGatewayId = pool?.defaultGatewayId ?? null;
  const validRoots = roots.flatMap(({ revision: _revision, ...stored }) => {
    const root = projectGatewayDesiredRootForGateway(stored, stored.gatewayId);
    return root ? [{ gatewayId: stored.gatewayId, root }] : [];
  });
  const validGatewayIds = new Set(validRoots.map(({ gatewayId }) => gatewayId));
  let defaultSelection: ReleaseStatusDefaultSelection = "unconfigured";
  if (defaultGatewayId !== null) {
    defaultSelection = validGatewayIds.has(defaultGatewayId) ? "selected" : "invalid";
  }
  const selectedDefaultGatewayId = defaultSelection === "selected" ? defaultGatewayId : null;
  const observed = await Promise.all(validRoots.map(async ({ gatewayId, root }) => {
    const [release, registry] = await Promise.all([
      store.gateways.releases.get(gatewayId, root.desiredRelease),
      store.fleetRegistry.get(gatewayId),
    ]);
    const desiredImageTag = release?.payload.imageTag ?? null;
    const runtime = registry === null ? null : projectRuntime(registry);
    return {
      gatewayId,
      isDefault: gatewayId === selectedDefaultGatewayId,
      desiredStatus: root.desiredStatus,
      desiredRelease: root.desiredRelease,
      liveRelease: root.liveRelease,
      desiredImageTag,
      runtimeRelease: runtime?.release ?? null,
      runtimeLifecycle: runtime?.lifecycle ?? null,
      heartbeatStatus: runtime?.heartbeatStatus ?? null,
      heartbeatVersion: runtime?.heartbeatVersion ?? null,
      lastHeartbeatAt: runtime?.lastHeartbeatAt ?? null,
      observation: observeGatewayRelease({
        gatewayId,
        desiredStatus: root.desiredStatus,
        desiredRelease: root.desiredRelease,
        liveRelease: root.liveRelease,
        desiredImageTag,
        runtime,
      }, now),
    } satisfies ReleaseStatusGateway;
  }));
  const invalidRoots = roots
    .filter((root) => !validGatewayIds.has(root.gatewayId))
    .map((root) => invalidRoot(root.gatewayId, selectedDefaultGatewayId));

  return {
    defaultGatewayId,
    defaultSelection,
    gateways: [...observed, ...invalidRoots].sort(
      (left, right) => left.gatewayId.localeCompare(right.gatewayId),
    ),
  };
}
