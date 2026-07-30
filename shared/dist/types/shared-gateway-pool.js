import { isOperatorManaged, isValidGatewayId } from "./glm.js";
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
    return {
        defaultGatewayId: value.defaultGatewayId,
        sharedGatewayIds: rawSharedGatewayIds,
    };
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
        !candidate.converging &&
        isNonNegativeInteger(candidate.assignmentCount) &&
        isNonNegativeInteger(candidate.incomingMigrationCount) &&
        candidate.incomingMigrationCount === 0);
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
