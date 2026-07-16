import { DURABLE_OPENCLAW_CONFIG_CONTROL_PROTOCOL, DURABLE_OPENCLAW_CONFIG_CONTROL_PROTOCOL_VERSION, GATEWAY_HEARTBEAT_INTERVAL_MS, OPENCLAW_DASHBOARD_BRIDGE_CAPABILITY_TTL_MS, OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL, OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL_VERSION, } from "@octogee/shared/types/fleet-controller";
import { CANONICAL_OPENCLAW_FORK_SHA, CANONICAL_OPENCLAW_VERSION, } from "@octogee/shared/types/openclaw-release";
export const OPENCLAW_CONTROL_RUNTIME_FRESH_MS = GATEWAY_HEARTBEAT_INTERVAL_MS * 4;
export const OPENCLAW_CONTROL_OPENCLAW_VERSION = CANONICAL_OPENCLAW_VERSION;
export const OPENCLAW_CONTROL_OPENCLAW_FORK_SHA = CANONICAL_OPENCLAW_FORK_SHA;
const MAX_CLOCK_SKEW_MS = 5_000;
function record(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value
        : null;
}
function epochMillis(value) {
    if (typeof value === "number")
        return Number.isFinite(value) ? value : null;
    if (typeof value === "string") {
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    const item = record(value);
    if (!item)
        return null;
    if (typeof item.seconds === "number" && typeof item.nanoseconds === "number") {
        return item.seconds * 1_000 + item.nanoseconds / 1_000_000;
    }
    if (typeof item.toMillis === "function") {
        const parsed = item.toMillis.call(value);
        return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}
function isFreshWithin(value, now, freshMs) {
    const observedAt = epochMillis(value);
    return observedAt !== null &&
        observedAt <= now + MAX_CLOCK_SKEW_MS &&
        now - observedAt <= freshMs;
}
function hasReadyRevisionIdentity(revision, input) {
    return revision?.docKind === "revision" &&
        revision.gateway === input.gatewayId &&
        revision.revisionId === input.revisionId &&
        revision.lifecycle === "serving";
}
function hasExpectedRuntimeIdentity(configStatus) {
    const controlProtocol = record(configStatus?.controlProtocol);
    return configStatus?.runtimeReady === true &&
        configStatus.runtimeHealth === "healthy" &&
        configStatus.freezeState === "unfrozen" &&
        configStatus.openclawVersion === OPENCLAW_CONTROL_OPENCLAW_VERSION &&
        configStatus.openclawForkSha === OPENCLAW_CONTROL_OPENCLAW_FORK_SHA &&
        controlProtocol?.protocol === DURABLE_OPENCLAW_CONFIG_CONTROL_PROTOCOL &&
        controlProtocol.version === DURABLE_OPENCLAW_CONFIG_CONTROL_PROTOCOL_VERSION;
}
function hasReadyDashboard(configStatus, now) {
    const dashboardProtocol = record(configStatus?.dashboardControlProtocol);
    return configStatus?.dashboardControlState === "ready" &&
        dashboardProtocol?.protocol === OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL &&
        dashboardProtocol.version === OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL_VERSION &&
        isFreshWithin(configStatus.dashboardControlObservedAt, now, OPENCLAW_DASHBOARD_BRIDGE_CAPABILITY_TTL_MS);
}
function hasFreshRuntimeProof(heartbeat, configStatus, now) {
    return heartbeat?.status === "ready" &&
        isFreshWithin(heartbeat.lastHeartbeatAt, now, OPENCLAW_CONTROL_RUNTIME_FRESH_MS) &&
        isFreshWithin(configStatus?.runtimeHealthCheckedAt, now, OPENCLAW_CONTROL_RUNTIME_FRESH_MS) &&
        isFreshWithin(configStatus?.observedAt, now, OPENCLAW_CONTROL_RUNTIME_FRESH_MS);
}
export function isOpenClawControlRevisionRuntimeReady(value, input) {
    const revision = record(value);
    if (!revision || !hasReadyRevisionIdentity(revision, input))
        return false;
    const now = input.now ?? Date.now();
    const heartbeat = record(revision.heartbeat);
    const configStatus = record(heartbeat?.configStatus);
    return hasExpectedRuntimeIdentity(configStatus) &&
        hasReadyDashboard(configStatus, now) &&
        hasFreshRuntimeProof(heartbeat, configStatus, now);
}
