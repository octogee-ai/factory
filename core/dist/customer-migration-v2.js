import { createHash } from "node:crypto";
import { isGatewayDesiredDoc, } from "@octogee/shared/types/gateway-releases";
import { isGatewayMutableConfigForGateway, } from "@octogee/shared/types/gateway-mutable-config";
import { isDefinitiveConfigRpcRejection, MigrationTransportError, } from "./fleet-migration-client.js";
function canonicalJsonValue(value) {
    if (Array.isArray(value))
        return value.map(canonicalJsonValue);
    if (!value || typeof value !== "object")
        return value;
    return Object.fromEntries(Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalJsonValue(entry)]));
}
function mutableConfigHash(config) {
    const canonical = canonicalJsonValue({
        configSchemaVersion: config.configSchemaVersion,
        profile: config.profile,
        gatewayClass: config.gatewayClass,
        imageProfile: config.imageProfile,
        sizingTier: config.sizingTier,
        computeClass: config.computeClass,
        gcpProject: config.gcpProject,
        gatewayContainerSecurityContext: config.gatewayContainerSecurityContext,
        serviceAccountName: config.serviceAccountName,
        serviceAccount: config.serviceAccount,
        operatorAccess: config.operatorAccess,
        ownerUid: config.ownerUid,
        coOwnerUids: config.coOwnerUids,
        builderSlug: config.builderSlug,
        openclawOverrides: config.openclawOverrides,
        modelBrokerLimits: config.modelBrokerLimits,
        preemption: config.preemption,
    });
    return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
export function customerMigrationV2GatewayRootFence(value, gatewayId) {
    if (!isGatewayDesiredDoc(value) ||
        value.gatewayId !== gatewayId ||
        !isGatewayMutableConfigForGateway(value, gatewayId) ||
        value.desiredStatus !== "running" ||
        value.roll !== null ||
        value.retireAfter != null ||
        value.retirementClaim != null ||
        typeof value.liveRevisionId !== "string" ||
        value.trafficRevisionId !== value.liveRevisionId ||
        typeof value.liveRelease !== "number" ||
        value.desiredRelease !== value.liveRelease ||
        typeof value.updatedAt !== "number" ||
        !Number.isFinite(value.updatedAt) ||
        (value.gatewayClass !== "builder" && value.gatewayClass !== "operator") ||
        typeof value.ownerUid !== "string" ||
        value.ownerUid.length === 0 ||
        typeof value.builderSlug !== "string" ||
        value.builderSlug.length === 0) {
        return null;
    }
    return {
        gatewayId,
        updatedAt: value.updatedAt,
        latestRelease: value.latestRelease,
        desiredRelease: value.desiredRelease,
        liveRelease: value.liveRelease,
        liveRevisionId: value.liveRevisionId,
        trafficRevisionId: value.trafficRevisionId,
        gatewayClass: value.gatewayClass,
        ownerUid: value.ownerUid,
        builderSlug: value.builderSlug,
        configHash: mutableConfigHash(value),
    };
}
export function customerMigrationV2GatewayRootFenceEqual(left, right) {
    return !!left && !!right &&
        left.gatewayId === right.gatewayId &&
        left.updatedAt === right.updatedAt &&
        left.latestRelease === right.latestRelease &&
        left.desiredRelease === right.desiredRelease &&
        left.liveRelease === right.liveRelease &&
        left.liveRevisionId === right.liveRevisionId &&
        left.trafficRevisionId === right.trafficRevisionId &&
        left.gatewayClass === right.gatewayClass &&
        left.ownerUid === right.ownerUid &&
        left.builderSlug === right.builderSlug &&
        left.configHash === right.configHash;
}
export function customerMigrationV2GatewayRootFenceMatches(value, fence) {
    const current = customerMigrationV2GatewayRootFence(value, fence.gatewayId);
    return current !== null && customerMigrationV2GatewayRootFenceEqual(current, fence);
}
function configOpts(state) {
    return {
        migrationId: state.migrationId,
        slug: state.slug,
        sourceRevisionId: state.sourceRevisionId,
        targetRevisionId: state.targetRevisionId,
    };
}
function requireCheckpoint(state) {
    const { checkpointCommit, configHash, freezeRef, freezeObject } = state;
    if (!checkpointCommit || !configHash || !freezeRef || !freezeObject) {
        throw new Error(`customer migration V2 phase ${state.phase} lacks its checkpoint binding`);
    }
    return { checkpointCommit, configHash, freezeRef, freezeObject };
}
function requireCandidate(state) {
    if (!state.candidateProof) {
        throw new Error(`customer migration V2 phase ${state.phase} lacks its candidate proof`);
    }
    return state.candidateProof;
}
function checkpointPatch(response) {
    return {
        checkpointCommit: response.checkpointCommit,
        configHash: response.configHash,
        freezeRef: response.freezeRef,
        freezeObject: response.freezeObject,
    };
}
function proofMatchesCandidate(prior, current) {
    return prior.checkpointCommit === current.checkpointCommit &&
        prior.candidateCommit === current.candidateCommit &&
        prior.candidateHash === current.candidateHash &&
        prior.candidateRef === current.candidateRef &&
        prior.freezeObject === current.freezeObject;
}
export async function advanceCustomerMigrationV2(state, deps) {
    const sourceTransportId = state.sourceRevisionId;
    const targetTransportId = state.targetRevisionId;
    switch (state.phase) {
        case "initialized": {
            const checkpoint = await deps.client.freezeConfigV2({
                ...configOpts(state),
                gatewayId: state.sourceGatewayId,
                transportId: sourceTransportId,
            });
            return { ...state, phase: "checkpointed", ...checkpointPatch(checkpoint) };
        }
        case "checkpointed": {
            const checkpoint = requireCheckpoint(state);
            await deps.installTargetContext({
                ...configOpts(state),
                checkpointCommit: checkpoint.checkpointCommit,
                freezeObject: checkpoint.freezeObject,
            });
            return { ...state, phase: "targetPrepared" };
        }
        case "targetPrepared":
            await deps.client.transferState({
                migrationId: state.migrationId,
                fromGatewayId: state.sourceGatewayId,
                toGatewayId: state.targetGatewayId,
                fromTransportId: sourceTransportId,
                toTransportId: targetTransportId,
                slug: state.slug,
                mode: "keys",
                includeActivationManifest: true,
            });
            return { ...state, phase: "keysSynced" };
        case "keysSynced":
            if (!deps.restoreSnapshot) {
                throw new Error("customer migration V2 restore phase lacks its durable snapshot");
            }
            await deps.client.restoreTarget({
                migrationId: state.migrationId,
                gatewayId: state.targetGatewayId,
                transportId: targetTransportId,
                uid: state.uid,
                slug: state.slug,
                snapshot: deps.restoreSnapshot,
            });
            return { ...state, phase: "targetRestored" };
        case "targetRestored": {
            const checkpoint = requireCheckpoint(state);
            const proof = await deps.client.proveConfigCandidate({
                ...configOpts(state),
                gatewayId: state.targetGatewayId,
                transportId: targetTransportId,
                checkpointCommit: checkpoint.checkpointCommit,
                freezeObject: checkpoint.freezeObject,
            });
            await deps.assertCandidateProofCurrent(proof);
            return { ...state, phase: "candidateProven", candidateProof: proof };
        }
        case "candidateProven":
            await deps.client.transferState({
                migrationId: state.migrationId,
                fromGatewayId: state.sourceGatewayId,
                toGatewayId: state.targetGatewayId,
                fromTransportId: sourceTransportId,
                toTransportId: targetTransportId,
                slug: state.slug,
                mode: "pre",
                includeActivationManifest: true,
            });
            return { ...state, phase: "preSynced" };
        case "preSynced":
            await deps.setSourceAssignmentState("quiescing");
            await deps.client.quiesce({
                migrationId: state.migrationId,
                gatewayId: state.sourceGatewayId,
                transportId: sourceTransportId,
                slug: state.slug,
            });
            return { ...state, phase: "sourceQuiesced" };
        case "sourceQuiesced":
            await deps.client.transferState({
                migrationId: state.migrationId,
                fromGatewayId: state.sourceGatewayId,
                toGatewayId: state.targetGatewayId,
                fromTransportId: sourceTransportId,
                toTransportId: targetTransportId,
                slug: state.slug,
                mode: "final",
                includeActivationManifest: true,
            });
            return { ...state, phase: "finalSynced" };
        case "finalSynced":
            await deps.client.verifyTarget({
                migrationId: state.migrationId,
                gatewayId: state.targetGatewayId,
                transportId: targetTransportId,
                slug: state.slug,
            });
            return { ...state, phase: "targetVerified" };
        case "targetVerified": {
            const checkpoint = requireCheckpoint(state);
            const prior = requireCandidate(state);
            const proof = await deps.client.proveConfigCandidate({
                ...configOpts(state),
                gatewayId: state.targetGatewayId,
                transportId: targetTransportId,
                checkpointCommit: checkpoint.checkpointCommit,
                freezeObject: checkpoint.freezeObject,
            });
            if (!proofMatchesCandidate(prior, proof)) {
                throw new Error("target candidate identity changed before promotion intent");
            }
            await deps.assertCandidateProofCurrent(proof);
            return {
                ...state,
                phase: "promotionIntent",
                candidateProof: proof,
                promotionIntentAt: deps.now(),
            };
        }
        case "promotionIntent": {
            const checkpoint = requireCheckpoint(state);
            const proof = requireCandidate(state);
            await deps.client.promoteConfigCandidate({
                ...configOpts(state),
                gatewayId: state.targetGatewayId,
                transportId: targetTransportId,
                checkpointCommit: checkpoint.checkpointCommit,
                candidateCommit: proof.candidateCommit,
                candidateHash: proof.candidateHash,
                freezeObject: checkpoint.freezeObject,
            });
            return { ...state, phase: "promoted", promotedAt: deps.now() };
        }
        case "promoted": {
            const checkpoint = requireCheckpoint(state);
            let proof = requireCandidate(state);
            try {
                await deps.assertCandidateProofCurrent(proof);
            }
            catch {
                const refreshed = await deps.client.proveConfigCandidate({
                    ...configOpts(state),
                    gatewayId: state.targetGatewayId,
                    transportId: targetTransportId,
                    checkpointCommit: checkpoint.checkpointCommit,
                    freezeObject: checkpoint.freezeObject,
                });
                if (!proofMatchesCandidate(proof, refreshed)) {
                    throw new Error("promoted target candidate identity changed during reproof");
                }
                await deps.assertCandidateProofCurrent(refreshed);
                return { ...state, candidateProof: refreshed };
            }
            await deps.commitCutover({
                operationId: state.operationId,
                migrationId: state.migrationId,
                sourceGatewayId: state.sourceGatewayId,
                sourceRevisionId: state.sourceRevisionId,
                sourceEpoch: state.sourceEpoch,
                sourceRelease: state.sourceRelease,
                sourceAssignmentMode: state.sourceAssignmentMode,
                sourceRootFence: state.sourceRootFence,
                targetGatewayId: state.targetGatewayId,
                targetRevisionId: state.targetRevisionId,
                targetRelease: state.targetRelease,
                targetRootFence: state.targetRootFence,
                checkpointCommit: checkpoint.checkpointCommit,
                configHash: checkpoint.configHash,
                freezeObject: checkpoint.freezeObject,
                candidateCommit: proof.candidateCommit,
                candidateHash: proof.candidateHash,
                runtimeConfigHash: proof.runtimeConfigHash,
                targetStartedAt: proof.targetStartedAt,
                imageTag: proof.imageTag,
                buildSha: proof.buildSha,
                openclawVersion: proof.openclawVersion,
                provenAt: proof.provenAt,
            });
            return { ...state, phase: "cutover", cutoverAt: deps.now() };
        }
        case "cutover":
            await deps.client.unmount({
                migrationId: state.migrationId,
                gatewayId: state.sourceGatewayId,
                transportId: sourceTransportId,
                slug: state.slug,
            });
            return { ...state, phase: "sourceRetired", sourceRetiredAt: deps.now() };
        case "sourceRetired": {
            const checkpoint = requireCheckpoint(state);
            const proof = requireCandidate(state);
            await deps.client.finalizeConfigV2({
                ...configOpts(state),
                gatewayId: state.targetGatewayId,
                transportId: targetTransportId,
                checkpointCommit: checkpoint.checkpointCommit,
                candidateCommit: proof.candidateCommit,
                candidateHash: proof.candidateHash,
                freezeObject: checkpoint.freezeObject,
            });
            return { ...state, phase: "finalized", finalizedAt: deps.now() };
        }
        case "finalized":
            await deps.clearTargetContext();
            return { ...state, phase: "complete", completedAt: deps.now() };
        case "abortIntent": {
            const checkpoint = requireCheckpoint(state);
            await deps.client.abortConfigV2({
                ...configOpts(state),
                gatewayId: state.sourceGatewayId,
                transportId: sourceTransportId,
                checkpointCommit: checkpoint.checkpointCommit,
                candidateCommit: state.candidateProof?.candidateCommit ?? null,
                freezeObject: checkpoint.freezeObject,
            });
            return { ...state, phase: "abortPublished" };
        }
        case "abortPublished":
            await deps.client.unmount({
                migrationId: state.migrationId,
                gatewayId: state.targetGatewayId,
                transportId: targetTransportId,
                slug: state.slug,
            });
            return { ...state, phase: "abortTargetUnmounted" };
        case "abortTargetUnmounted":
            await deps.clearTargetContext();
            return { ...state, phase: "abortContextCleared" };
        case "abortContextCleared":
            await deps.setSourceAssignmentState("serving");
            return { ...state, phase: "aborted", abortedAt: deps.now() };
        case "complete":
        case "aborted":
            return state;
    }
}
const POST_INTENT_PHASES = new Set([
    "promotionIntent",
    "promoted",
    "cutover",
    "sourceRetired",
    "finalized",
    "complete",
]);
export function isCustomerMigrationV2PostIntent(state) {
    return POST_INTENT_PHASES.has(state.phase);
}
const NEXT_PHASE = {
    initialized: "checkpointed",
    checkpointed: "targetPrepared",
    targetPrepared: "keysSynced",
    keysSynced: "targetRestored",
    targetRestored: "candidateProven",
    candidateProven: "preSynced",
    preSynced: "sourceQuiesced",
    sourceQuiesced: "finalSynced",
    finalSynced: "targetVerified",
    targetVerified: "promotionIntent",
    promotionIntent: "promoted",
    promoted: "cutover",
    cutover: "sourceRetired",
    sourceRetired: "finalized",
    finalized: "complete",
    abortIntent: "abortPublished",
    abortPublished: "abortTargetUnmounted",
    abortTargetUnmounted: "abortContextCleared",
    abortContextCleared: "aborted",
};
export function isCustomerMigrationV2Transition(from, to) {
    if (from === to)
        return true;
    if (NEXT_PHASE[from] === to)
        return true;
    return to === "abortIntent" &&
        from !== "initialized" &&
        !POST_INTENT_PHASES.has(from) &&
        !isAbortPhaseName(from);
}
function isAbortPhaseName(phase) {
    return phase === "abortIntent" ||
        phase === "abortPublished" ||
        phase === "abortTargetUnmounted" ||
        phase === "abortContextCleared" ||
        phase === "aborted";
}
export function beginCustomerMigrationV2Abort(state, reason, now) {
    if (isCustomerMigrationV2PostIntent(state)) {
        throw new Error(`customer migration V2 phase ${state.phase} crossed promotion intent and must roll forward`);
    }
    if (state.phase === "initialized") {
        throw new Error("customer migration V2 has no durable freeze to abort");
    }
    if (state.phase === "abortIntent" ||
        state.phase === "abortPublished" ||
        state.phase === "abortTargetUnmounted" ||
        state.phase === "abortContextCleared" ||
        state.phase === "aborted") {
        return state;
    }
    return {
        ...state,
        phase: "abortIntent",
        abortFromPhase: state.phase,
        abortReason: reason,
        abortIntentAt: now,
    };
}
export function classifyCustomerMigrationV2Error(error) {
    if (isDefinitiveConfigRpcRejection(error))
        return "terminal";
    if (error instanceof MigrationTransportError)
        return "retry";
    const record = error && typeof error === "object"
        ? error
        : {};
    if (record.retryable === true)
        return "retry";
    if (record.name === "AbortError" || record.name === "TimeoutError")
        return "retry";
    if (record.code === 4 || record.code === 8 || record.code === 10 || record.code === 14 ||
        record.code === "ECONNRESET" || record.code === "ECONNREFUSED" ||
        record.code === "ETIMEDOUT" || record.code === "EAI_AGAIN" ||
        record.code === "UND_ERR_SOCKET")
        return "retry";
    const status = record.status;
    if (typeof status === "number") {
        return status === 408 || status === 429 || status >= 500 ? "retry" : "terminal";
    }
    const message = error instanceof Error ? error.message : String(record.message ?? error);
    return /response lost|fetch failed|terminated|premature close|unexpected end|truncated|network|socket|ECONN|timed? out|timeout|unavailable|temporar|stale|restarted/i.test(message)
        ? "retry"
        : "terminal";
}
