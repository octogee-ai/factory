import { GATEWAY_UNREACHABLE_AFTER_MS } from "@octogee/shared/types/fleet-controller";
import { projectGatewayDesiredRootForGateway } from "@octogee/shared/types/gateway-releases";
import { deriveSharedGatewayPoolConfig } from "@octogee/shared/types/shared-gateway-pool";
export function imageTagMatchesArtifact(artifactTag, expectedImageTag) {
    return artifactTag?.split("@", 1)[0] === expectedImageTag.split("@", 1)[0];
}
export function summarizeReleaseStatus(snapshot) {
    const blockers = [];
    if (snapshot.defaultSelection !== "selected") {
        blockers.push(`default gateway: ${snapshot.defaultSelection}`);
    }
    else {
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
        if (gateway.observation !== "invalid-root")
            serving += 1;
        if (gateway.observation === "converged") {
            converged += 1;
        }
        else {
            blockers.push(`${gateway.gatewayId}: ${gateway.observation}`);
        }
    }
    if (serving === 0)
        blockers.push("no serving gateways");
    return { status: blockers.length === 0 ? "converged" : "incomplete", serving, converged, excluded, blockers };
}
export function observeGatewayRelease(input, now = Date.now()) {
    if (input.desiredStatus === "retired")
        return "retired";
    if (input.desiredStatus === "paused")
        return "paused";
    if (!input.desiredImageTag)
        return "missing-release";
    if (!input.runtime)
        return "missing-runtime";
    if (input.desiredRelease !== input.liveRelease)
        return "rolling";
    if (input.runtime.release !== input.desiredRelease)
        return "runtime-stale";
    if (input.runtime.lifecycle !== "serving")
        return "not-serving";
    if (input.runtime.heartbeatStatus !== "ready")
        return "unhealthy";
    if (now - input.runtime.lastHeartbeatAt > GATEWAY_UNREACHABLE_AFTER_MS) {
        return "heartbeat-stale";
    }
    if (!imageTagMatchesArtifact(input.runtime.heartbeatVersion, input.desiredImageTag)) {
        return "version-drift";
    }
    return "converged";
}
function millis(value) {
    return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 8.64e15 ? value : null;
}
function projectRuntime(record) {
    const heartbeat = record.heartbeat;
    if (!heartbeat || typeof heartbeat !== "object")
        return null;
    const observation = heartbeat;
    if (typeof observation.status !== "string" || observation.status.length === 0)
        return null;
    if (observation.version !== undefined &&
        observation.version !== null &&
        typeof observation.version !== "string")
        return null;
    const lastHeartbeatAt = millis(observation.lastHeartbeatAt);
    if (lastHeartbeatAt === null)
        return null;
    return {
        release: record.release,
        lifecycle: record.lifecycle,
        heartbeatStatus: observation.status,
        heartbeatVersion: typeof observation.version === "string" ? observation.version : null,
        lastHeartbeatAt,
    };
}
function invalidRoot(gatewayId, defaultGatewayId) {
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
export async function readReleaseStatus(store, now = Date.now()) {
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
    let defaultSelection = "unconfigured";
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
        };
    }));
    const invalidRoots = roots
        .filter((root) => !validGatewayIds.has(root.gatewayId))
        .map((root) => invalidRoot(root.gatewayId, selectedDefaultGatewayId));
    return {
        defaultGatewayId,
        defaultSelection,
        gateways: [...observed, ...invalidRoots].sort((left, right) => left.gatewayId.localeCompare(right.gatewayId)),
    };
}
