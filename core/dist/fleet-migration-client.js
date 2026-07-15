import { signFleetRequest } from "./fleet-signature.js";
import { randomUUID } from "node:crypto";
import { SIGNATURE_HEADER, MIGRATION_QUIESCE_TIMEOUT_MS, MIGRATION_TRANSFER_TIMEOUT_MS, MIGRATION_UNMOUNT_TIMEOUT_MS, MIGRATION_VERIFY_TIMEOUT_MS, CONFIG_CONTROL_OWNER_CONFLICT_CODE, CONFIG_CONTROL_SCOPE_CONFLICT_CODE, CONFIG_CONTROL_REF_CONFLICT_CODE, CONFIG_CONTROL_REVISION_MISMATCH_CODE, } from "@octogee/shared/types/fleet-controller";
export class MigrationRpcError extends Error {
    status;
    code;
    ownerMigrationId;
    slug;
    constructor(message, options = {}) {
        super(message);
        this.name = "MigrationRpcError";
        this.status = options.status;
        this.code = options.code;
        this.ownerMigrationId = options.ownerMigrationId;
        this.slug = options.slug;
    }
}
export class MigrationTransportError extends Error {
    retryable = true;
    constructor(message, options = {}) {
        super(message, options);
        this.name = "MigrationTransportError";
    }
}
export function isDefinitiveConfigRpcRejection(error) {
    if (!error || typeof error !== "object")
        return false;
    const rpc = error;
    if (rpc.code === CONFIG_CONTROL_OWNER_CONFLICT_CODE ||
        rpc.code === CONFIG_CONTROL_SCOPE_CONFLICT_CODE ||
        rpc.code === CONFIG_CONTROL_REF_CONFLICT_CODE ||
        rpc.code === CONFIG_CONTROL_REVISION_MISMATCH_CODE ||
        rpc.code === "system-config-freeze-owned") {
        return true;
    }
    return typeof rpc.status === "number" &&
        (rpc.status === 501 ||
            rpc.status >= 400 &&
                rpc.status < 500 &&
                rpc.status !== 408 &&
                rpc.status !== 429);
}
export function isDefinitiveFreezeRejection(error) {
    if (!error || typeof error !== "object")
        return false;
    const status = error.status;
    return status === 501 ||
        typeof status === "number" &&
            status >= 400 &&
            status < 500 &&
            status !== 408 &&
            status !== 429;
}
export function isFreezeOwnerConflict(error) {
    return error instanceof MigrationRpcError &&
        (error.code === CONFIG_CONTROL_OWNER_CONFLICT_CODE ||
            error.code === "system-config-freeze-owned") &&
        typeof error.ownerMigrationId === "string" &&
        error.ownerMigrationId.length > 0 &&
        typeof error.slug === "string" &&
        error.slug.length > 0;
}
function assertConfigResponseBinding(response, opts) {
    if (response.migrationId !== opts.migrationId ||
        response.slug !== opts.slug ||
        response.sourceRevisionId !== opts.sourceRevisionId ||
        response.targetRevisionId !== opts.targetRevisionId) {
        throw new Error("malformed config response binding");
    }
}
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
export function createMigrationClient(deps) {
    const fetchImpl = deps.fetch ?? globalThis.fetch;
    const log = deps.log ?? (() => undefined);
    const quiesceMs = deps.timeouts?.quiesceMs ?? MIGRATION_QUIESCE_TIMEOUT_MS;
    const transferMs = deps.timeouts?.transferMs ?? MIGRATION_TRANSFER_TIMEOUT_MS;
    const unmountMs = deps.timeouts?.unmountMs ?? MIGRATION_UNMOUNT_TIMEOUT_MS;
    const verifyMs = deps.timeouts?.verifyMs ?? MIGRATION_VERIFY_TIMEOUT_MS;
    const now = deps.now ?? Date.now;
    const genRequestId = deps.genRequestId ?? (() => randomUUID().replaceAll("-", ""));
    const configMutationBody = (body) => {
        const issuedAt = now();
        return {
            ...body,
            issuedAt,
            expiresAt: issuedAt + 30_000,
            requestId: genRequestId(),
        };
    };
    const fetchWithTimeout = async (label, url, init, timeoutMs) => {
        const controller = new AbortController();
        let didTimeout = false;
        const timer = setTimeout(() => {
            didTimeout = true;
            controller.abort();
        }, timeoutMs);
        try {
            return await fetchImpl(url, { ...init, signal: controller.signal });
        }
        catch (err) {
            if (didTimeout) {
                throw new MigrationTransportError(`${label} timed out after ${timeoutMs}ms (${url})`, { cause: err });
            }
            const message = err instanceof Error ? err.message : String(err);
            throw new MigrationTransportError(`${label} transport failed: ${message}`, { cause: err });
        }
        finally {
            clearTimeout(timer);
        }
    };
    // `transportId` resolves the K8s Service URL (revision); `path` already
    // carries the bare tenant gatewayId — the two are deliberately independent.
    const postSignedJson = async (transportId, path, migrationId, body, timeoutMs) => {
        const rawBody = JSON.stringify(body);
        const signature = signFleetRequest(deps.privateKey, migrationId, rawBody);
        const url = `${deps.resolveGatewayUrl(transportId)}${path}`;
        const res = await fetchWithTimeout(path, url, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                [SIGNATURE_HEADER]: signature,
            },
            body: rawBody,
        }, timeoutMs);
        if (!res.ok) {
            const text = await res.text().catch(() => "<no body>");
            let details = {};
            try {
                const parsed = JSON.parse(text);
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                    details = parsed;
                }
            }
            catch {
                details = {};
            }
            const owner = details.owner && typeof details.owner === "object" && !Array.isArray(details.owner)
                ? details.owner
                : {};
            throw new MigrationRpcError(`${path}: ${res.status} ${text}`, {
                status: res.status,
                ...(typeof details.code === "string" ? { code: details.code } : {}),
                ...(typeof owner.migrationId === "string" || typeof details.ownerMigrationId === "string"
                    ? { ownerMigrationId: (owner.migrationId ?? details.ownerMigrationId) }
                    : {}),
                ...(typeof owner.slug === "string" || typeof details.slug === "string"
                    ? { slug: (owner.slug ?? details.slug) }
                    : {}),
            });
        }
        try {
            return (await res.json());
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            throw new MigrationTransportError(`${path} response body was incomplete: ${message}`, {
                cause: err,
            });
        }
    };
    return {
        async freezeConfig({ migrationId, gatewayId, transportId, slug }) {
            const response = await postSignedJson(transportId ?? gatewayId, `/config-freeze/${gatewayId}`, migrationId, configMutationBody({ action: "freeze", migrationId, slug }), transferMs);
            if (response.migrationId !== migrationId || response.slug !== slug) {
                throw new Error("malformed config response binding");
            }
            if (response.frozen !== true ||
                !COMMIT_PATTERN.test(response.checkpointCommit) ||
                !HASH_PATTERN.test(response.configHash))
                throw new Error("malformed config checkpoint response");
            return response;
        },
        async proveConfigRestore({ migrationId, gatewayId, transportId, slug, checkpointCommit }) {
            const response = await postSignedJson(transportId ?? gatewayId, `/config-restore-proof/${gatewayId}`, migrationId, configMutationBody({ action: "restore-proof", migrationId, slug, checkpointCommit }), transferMs);
            if (response.migrationId !== migrationId ||
                response.slug !== slug ||
                !COMMIT_PATTERN.test(response.restoredCommit) ||
                !COMMIT_PATTERN.test(response.acceptedCommit) ||
                !HASH_PATTERN.test(response.configHash) ||
                response.configReady !== true ||
                response.observedRevisionId !== (transportId ?? gatewayId) ||
                !Number.isFinite(response.restoreProvenAt) ||
                !Number.isFinite(response.configReadyAt) ||
                response.configReadyAt < response.restoreProvenAt ||
                !response.runtimeConfigHash)
                throw new Error("malformed config restore proof response");
            return response;
        },
        async reproveConfigRestore(opts) {
            const response = await postSignedJson(opts.transportId ?? opts.gatewayId, `/config-restore-proof/${opts.gatewayId}`, opts.migrationId, configMutationBody({
                action: "restore-proof",
                migrationId: opts.migrationId,
                slug: opts.slug,
                checkpointCommit: opts.checkpointCommit,
                proofOnly: true,
            }), transferMs);
            if (response.migrationId !== opts.migrationId ||
                response.slug !== opts.slug ||
                response.observedRevisionId !== (opts.transportId ?? opts.gatewayId) ||
                response.configReady !== true)
                throw new Error("malformed config reproof response");
            return response;
        },
        async unfreezeConfig({ migrationId, gatewayId, transportId, slug }) {
            const response = await postSignedJson(transportId ?? gatewayId, `/config-unfreeze/${gatewayId}`, migrationId, configMutationBody({ action: "unfreeze", migrationId, slug }), transferMs);
            if (response.migrationId !== migrationId || response.slug !== slug || response.unfrozen !== true) {
                throw new Error("config unfreeze was not confirmed");
            }
            return response;
        },
        async freezeConfigV2(opts) {
            const response = await postSignedJson(opts.transportId ?? opts.gatewayId, `/config-freeze-v2/${opts.gatewayId}`, opts.migrationId, configMutationBody({
                action: "freeze-v2",
                migrationId: opts.migrationId,
                slug: opts.slug,
                sourceRevisionId: opts.sourceRevisionId,
                targetRevisionId: opts.targetRevisionId,
            }), transferMs);
            assertConfigResponseBinding(response, opts);
            if (response.frozen !== true ||
                !COMMIT_PATTERN.test(response.checkpointCommit) ||
                !HASH_PATTERN.test(response.configHash) ||
                response.freezeRef !== `refs/octogee/system-config/freeze/${opts.sourceRevisionId}` ||
                !COMMIT_PATTERN.test(response.freezeObject))
                throw new Error("malformed config checkpoint response");
            return response;
        },
        async proveConfigCandidate(opts) {
            const response = await postSignedJson(opts.transportId ?? opts.gatewayId, `/config-candidate-proof/${opts.gatewayId}`, opts.migrationId, configMutationBody({
                action: "candidate-proof",
                migrationId: opts.migrationId,
                slug: opts.slug,
                sourceRevisionId: opts.sourceRevisionId,
                targetRevisionId: opts.targetRevisionId,
                checkpointCommit: opts.checkpointCommit,
                freezeObject: opts.freezeObject,
            }), transferMs);
            assertConfigResponseBinding(response, opts);
            if (response.checkpointCommit !== opts.checkpointCommit ||
                !COMMIT_PATTERN.test(response.candidateCommit) ||
                !HASH_PATTERN.test(response.candidateHash) ||
                response.candidateRef !== `refs/octogee/system-config/candidate/${opts.targetRevisionId}` ||
                response.freezeObject !== opts.freezeObject ||
                response.configReady !== true ||
                response.observedRevisionId !== opts.targetRevisionId ||
                !Number.isFinite(response.targetStartedAt) ||
                !Number.isFinite(response.provenAt) ||
                !response.runtimeConfigHash ||
                !response.imageTag ||
                !response.buildSha ||
                !response.openclawVersion)
                throw new Error("malformed config candidate proof response");
            return response;
        },
        async promoteConfigCandidate(opts) {
            const response = await postSignedJson(opts.transportId ?? opts.gatewayId, `/config-promote-candidate/${opts.gatewayId}`, opts.migrationId, configMutationBody({
                action: "promote-candidate",
                migrationId: opts.migrationId,
                slug: opts.slug,
                sourceRevisionId: opts.sourceRevisionId,
                targetRevisionId: opts.targetRevisionId,
                checkpointCommit: opts.checkpointCommit,
                candidateCommit: opts.candidateCommit,
                candidateHash: opts.candidateHash,
                freezeObject: opts.freezeObject,
            }), transferMs);
            assertConfigResponseBinding(response, opts);
            if (response.promoted !== true || response.promotedCommit !== opts.candidateCommit) {
                throw new Error("malformed config promotion response");
            }
            return response;
        },
        async abortConfigV2(opts) {
            const response = await postSignedJson(opts.transportId ?? opts.gatewayId, `/config-abort-v2/${opts.gatewayId}`, opts.migrationId, configMutationBody({
                action: "abort-v2",
                migrationId: opts.migrationId,
                slug: opts.slug,
                sourceRevisionId: opts.sourceRevisionId,
                targetRevisionId: opts.targetRevisionId,
                checkpointCommit: opts.checkpointCommit,
                candidateCommit: opts.candidateCommit,
                freezeObject: opts.freezeObject,
            }), transferMs);
            assertConfigResponseBinding(response, opts);
            if (response.aborted !== true)
                throw new Error("config abort was not confirmed");
            return response;
        },
        async finalizeConfigV2(opts) {
            const response = await postSignedJson(opts.transportId ?? opts.gatewayId, `/config-finalize-v2/${opts.gatewayId}`, opts.migrationId, configMutationBody({
                action: "finalize-v2",
                migrationId: opts.migrationId,
                slug: opts.slug,
                sourceRevisionId: opts.sourceRevisionId,
                targetRevisionId: opts.targetRevisionId,
                checkpointCommit: opts.checkpointCommit,
                candidateCommit: opts.candidateCommit,
                candidateHash: opts.candidateHash,
                freezeObject: opts.freezeObject,
            }), transferMs);
            assertConfigResponseBinding(response, opts);
            if (response.finalized !== true)
                throw new Error("config finalize was not confirmed");
            return response;
        },
        async retireConfigV2(opts) {
            const response = await postSignedJson(opts.transportId ?? opts.gatewayId, `/config-retire-v2/${opts.gatewayId}`, opts.migrationId, configMutationBody({
                action: "retire-v2",
                migrationId: opts.migrationId,
                slug: opts.slug,
                sourceRevisionId: opts.sourceRevisionId,
                targetRevisionId: opts.targetRevisionId,
                checkpointCommit: opts.checkpointCommit,
                freezeObject: opts.freezeObject,
            }), transferMs);
            assertConfigResponseBinding(response, opts);
            if (response.retired !== true ||
                response.retirementRef !==
                    `refs/octogee/system-config/retired/${opts.sourceRevisionId}` ||
                !COMMIT_PATTERN.test(response.retirementObject))
                throw new Error("malformed config retirement response");
            return response;
        },
        async recoverRetiredConfigV2(opts) {
            const response = await postSignedJson(opts.transportId ?? opts.gatewayId, `/config-retire-v2/${opts.gatewayId}`, opts.migrationId, configMutationBody({
                action: "retire-v2",
                migrationId: opts.migrationId,
                slug: opts.slug,
                sourceRevisionId: opts.sourceRevisionId,
                targetRevisionId: opts.targetRevisionId,
                checkpointCommit: opts.checkpointCommit,
                freezeObject: opts.freezeObject,
                recoverOnly: true,
            }), transferMs);
            assertConfigResponseBinding(response, opts);
            if (response.retired !== true ||
                response.retirementRef !==
                    `refs/octogee/system-config/retired/${opts.sourceRevisionId}` ||
                !COMMIT_PATTERN.test(response.retirementObject))
                throw new Error("malformed config retirement recovery response");
            return response;
        },
        async restoreTarget({ migrationId, gatewayId, transportId, uid, slug, snapshot }) {
            const res = await postSignedJson(transportId ?? gatewayId, `/restore/${gatewayId}`, migrationId, { migrationId, uid, slug, snapshot }, transferMs);
            log(`[migration-client] ✅ restoreTarget migrationId=${migrationId} slug=${slug} gateway=${gatewayId} steps=${res.steps.join(",")}`);
            return res;
        },
        async quiesce({ migrationId, gatewayId, transportId, slug, timeoutMs }) {
            const res = await postSignedJson(transportId ?? gatewayId, `/quiesce/${gatewayId}`, migrationId, timeoutMs == null ? { migrationId, slug } : { migrationId, slug, timeoutMs }, quiesceMs);
            if (!res.drained) {
                throw new Error(`quiesce did not drain: ${res.runningCount} still running on ${gatewayId} for slug=${slug}`);
            }
            log(`[migration-client] ✅ quiesce ok migrationId=${migrationId} slug=${slug}`);
            return res;
        },
        async flushGateway({ migrationId, gatewayId, transportId, slug, reason }) {
            const res = await postSignedJson(transportId ?? gatewayId, `/flush/${gatewayId}`, migrationId, { migrationId, slug, reason }, transferMs);
            log(`[migration-client] ✅ flushGateway migrationId=${migrationId} slug=${slug} gateway=${gatewayId} ok=${res.ok}`);
            return res;
        },
        async unmount({ migrationId, gatewayId, transportId, slug }) {
            const res = await postSignedJson(transportId ?? gatewayId, `/unmount/${gatewayId}`, migrationId, { migrationId, slug }, unmountMs);
            log(`[migration-client] ✅ unmount migrationId=${migrationId} slug=${slug} wasMounted=${res.unmounted}`);
            return res;
        },
        async transferState({ migrationId, fromGatewayId, toGatewayId, fromTransportId, toTransportId, slug, mode, includeActivationManifest }) {
            const targetUrl = deps.resolveGatewayUrl(toTransportId ?? toGatewayId);
            const targetImportSignature = signFleetRequest(deps.privateKey, migrationId, slug);
            const parsed = await postSignedJson(fromTransportId ?? fromGatewayId, `/push-state/${fromGatewayId}`, migrationId, {
                migrationId,
                slug,
                targetGatewayId: toGatewayId,
                targetUrl,
                targetImportSignature,
                ...(mode ? { mode } : {}),
                ...(includeActivationManifest ? { includeActivationManifest: true } : {}),
            }, transferMs);
            log(`[migration-client] ✅ transferState mode=${mode ?? "default"} migrationId=${migrationId} slug=${slug} ${fromGatewayId} → ${toGatewayId}`);
            return parsed;
        },
        async verifyTarget({ migrationId, gatewayId, transportId, slug, timeoutMs }) {
            const requestTimeoutMs = timeoutMs == null ? verifyMs : Math.max(verifyMs, timeoutMs + 30_000);
            const res = await postSignedJson(transportId ?? gatewayId, `/verify/${gatewayId}`, migrationId, timeoutMs == null ? { migrationId, slug } : { migrationId, slug, timeoutMs }, requestTimeoutMs);
            if (!res.ready) {
                throw new Error(`target verify failed on ${gatewayId} for slug=${slug}: ${JSON.stringify(res.checks)}`);
            }
            log(`[migration-client] ✅ verifyTarget migrationId=${migrationId} slug=${slug} gateway=${gatewayId}`);
            return res;
        },
    };
}
