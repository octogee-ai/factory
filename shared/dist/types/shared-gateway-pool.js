import { isOperatorManaged, isValidGatewayId, } from "./glm.js";
export const PRIMARY_SHARED_GATEWAY_ID = "shared-a";
export const STANDARD_SHARED_GATEWAY_IDS = [
    PRIMARY_SHARED_GATEWAY_ID,
    "shared-b",
    "shared-c",
    "shared-d",
];
export const DEFAULT_SHARED_GATEWAY_MIN_HOT_MEMBERS = 2;
export const DEFAULT_SHARED_GATEWAY_AUTOSCALING_ENABLED = true;
export const DEFAULT_SHARED_GATEWAY_BUILDERS_PER_GATEWAY = 4;
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isNonNegativeInteger(value) {
    return Number.isInteger(value) && value >= 0;
}
export function parseSharedGatewayPoolConfig(value) {
    if (!isRecord(value) || !isValidGatewayId(value.defaultGatewayId))
        return null;
    const rawSharedGatewayIds = value.sharedGatewayIds;
    if (!Array.isArray(rawSharedGatewayIds) || rawSharedGatewayIds.length === 0)
        return null;
    if (rawSharedGatewayIds[0] !== value.defaultGatewayId ||
        !rawSharedGatewayIds.every(isValidGatewayId) ||
        new Set(rawSharedGatewayIds).size !== rawSharedGatewayIds.length) {
        return null;
    }
    const sharedGatewayAutoscaling = value.sharedGatewayAutoscaling === undefined
        ? undefined
        : parseSharedGatewayAutoscalingConfig(value.sharedGatewayAutoscaling, rawSharedGatewayIds.length);
    if (value.sharedGatewayAutoscaling !== undefined && sharedGatewayAutoscaling === null) {
        return null;
    }
    return {
        defaultGatewayId: value.defaultGatewayId,
        sharedGatewayIds: rawSharedGatewayIds,
        ...(sharedGatewayAutoscaling ? { sharedGatewayAutoscaling } : {}),
    };
}
function isValidMinHotMembers(value, memberCount) {
    return typeof value === "number" &&
        Number.isInteger(value) &&
        value >= DEFAULT_SHARED_GATEWAY_MIN_HOT_MEMBERS &&
        value <= memberCount;
}
function isValidBuildersPerGateway(value) {
    return typeof value === "number" && Number.isInteger(value) && value >= 2;
}
export function parseSharedGatewayAutoscalingConfig(value, memberCount) {
    if (!Number.isInteger(memberCount) || memberCount < DEFAULT_SHARED_GATEWAY_MIN_HOT_MEMBERS) {
        return null;
    }
    if (value !== undefined && !isRecord(value))
        return null;
    const config = value ?? {};
    if (!isRecord(config))
        return null;
    const enabled = config.enabled ?? DEFAULT_SHARED_GATEWAY_AUTOSCALING_ENABLED;
    const minHotMembers = config.minHotMembers ?? DEFAULT_SHARED_GATEWAY_MIN_HOT_MEMBERS;
    const buildersPerGateway = config.buildersPerGateway ?? DEFAULT_SHARED_GATEWAY_BUILDERS_PER_GATEWAY;
    if (typeof enabled !== "boolean" ||
        !isValidMinHotMembers(minHotMembers, memberCount) ||
        !isValidBuildersPerGateway(buildersPerGateway)) {
        return null;
    }
    return { enabled, minHotMembers, buildersPerGateway };
}
export function authoritativeSharedGatewayLoad(candidate) {
    return candidate.assignmentCount + candidate.incomingMigrationCount;
}
export function isAcceptingSharedGateway(config, candidate) {
    return (config.sharedGatewayIds.includes(candidate.gatewayId) &&
        candidate.gatewayClass === "shared" &&
        candidate.desiredStatus === "running" &&
        !isOperatorManaged(candidate.managedBy) &&
        candidate.ready &&
        candidate.serving &&
        candidate.heartbeatFresh &&
        candidate.liveReleaseReady &&
        candidate.rosterComplete &&
        isNonNegativeInteger(candidate.assignmentCount) &&
        isNonNegativeInteger(candidate.incomingMigrationCount));
}
export function stableGatewayUidHash(uid) {
    let hash = 2166136261;
    for (let index = 0; index < uid.length; index += 1) {
        hash ^= uid.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}
function leastLoadedGatewayForUid(uid, candidates) {
    const leastLoad = Math.min(...candidates.map(authoritativeSharedGatewayLoad));
    const ties = candidates
        .filter((candidate) => authoritativeSharedGatewayLoad(candidate) === leastLoad)
        .slice()
        .sort((left, right) => left.gatewayId.localeCompare(right.gatewayId));
    return ties[stableGatewayUidHash(uid) % ties.length];
}
export function selectSharedGateway(input) {
    const accepting = input.candidates.filter((candidate) => isAcceptingSharedGateway(input.config, candidate));
    if (accepting.length === 0)
        return { kind: "blocked", reason: "no-accepting-shared-gateway" };
    const selected = leastLoadedGatewayForUid(input.uid, accepting);
    const current = input.currentGatewayId === undefined || input.currentGatewayId === null
        ? undefined
        : accepting.find((candidate) => candidate.gatewayId === input.currentGatewayId);
    if (current &&
        authoritativeSharedGatewayLoad(current) - authoritativeSharedGatewayLoad(selected) <= 1) {
        return {
            kind: "selected",
            gatewayId: current.gatewayId,
            load: authoritativeSharedGatewayLoad(current),
            retainedCurrent: true,
        };
    }
    return {
        kind: "selected",
        gatewayId: selected.gatewayId,
        load: authoritativeSharedGatewayLoad(selected),
        retainedCurrent: false,
    };
}
export function planSharedGatewayRebalance(input) {
    const accepting = input.candidates
        .filter((candidate) => isAcceptingSharedGateway(input.config, candidate))
        .slice();
    if (accepting.length < 2)
        return null;
    accepting.sort((left, right) => {
        const loadDifference = authoritativeSharedGatewayLoad(left) - authoritativeSharedGatewayLoad(right);
        return loadDifference !== 0 ? loadDifference : left.gatewayId.localeCompare(right.gatewayId);
    });
    const to = accepting[0];
    const from = accepting[accepting.length - 1];
    return authoritativeSharedGatewayLoad(from) - authoritativeSharedGatewayLoad(to) >= 2
        ? { fromGatewayId: from.gatewayId, toGatewayId: to.gatewayId }
        : null;
}
