import { signFleetRequest } from "./fleet-signature.js";
import { randomUUID } from "node:crypto";
import { SIGNATURE_HEADER, MIGRATION_QUIESCE_TIMEOUT_MS, MIGRATION_TRANSFER_TIMEOUT_MS, MIGRATION_UNMOUNT_TIMEOUT_MS, MIGRATION_VERIFY_TIMEOUT_MS, SYSTEM_CONFIG_FREEZE_OWNED, SYSTEM_CONFIG_FREEZE_SCOPE_MISMATCH, } from "@octogee/shared/types/fleet-controller";
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
export function isDefinitiveConfigRpcRejection(error) {
    if (!(error instanceof MigrationRpcError))
        return false;
    if (error.code === SYSTEM_CONFIG_FREEZE_OWNED ||
        error.code === SYSTEM_CONFIG_FREEZE_SCOPE_MISMATCH) {
        return true;
    }
    return error.status === 404 || error.status === 501;
}
export function isDefinitiveFreezeRejection(error) {
    return error instanceof MigrationRpcError &&
        (error.status === 501 ||
            typeof error.status === "number" &&
                error.status >= 400 &&
                error.status < 500 &&
                error.status !== 408 &&
                error.status !== 429);
}
export function isFreezeOwnerConflict(error) {
    return error instanceof MigrationRpcError &&
        error.code === SYSTEM_CONFIG_FREEZE_OWNED &&
        typeof error.ownerMigrationId === "string" &&
        error.ownerMigrationId.length > 0 &&
        typeof error.slug === "string" &&
        error.slug.length > 0;
}
function assertConfigResponseBinding(response, migrationId, slug) {
    if (response.migrationId !== migrationId || response.slug !== slug) {
        throw new Error("malformed config response binding");
    }
}
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
                throw new Error(`${label} timed out after ${timeoutMs}ms (${url})`);
            }
            throw err;
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
            throw new MigrationRpcError(`${path}: ${res.status} ${text}`, {
                status: res.status,
                ...(typeof details.code === "string" ? { code: details.code } : {}),
                ...(typeof details.ownerMigrationId === "string"
                    ? { ownerMigrationId: details.ownerMigrationId }
                    : {}),
                ...(typeof details.slug === "string" ? { slug: details.slug } : {}),
            });
        }
        return (await res.json());
    };
    return {
        async freezeConfig({ migrationId, gatewayId, transportId, slug }) {
            const response = await postSignedJson(transportId ?? gatewayId, `/config-freeze/${gatewayId}`, migrationId, configMutationBody({ migrationId, slug }), transferMs);
            assertConfigResponseBinding(response, migrationId, slug);
            if (response.frozen !== true ||
                !/^[0-9a-f]{40}$/.test(response.checkpointCommit) ||
                !/^[0-9a-f]{64}$/.test(response.configHash)) {
                throw new Error("malformed config checkpoint response");
            }
            log(`[migration-client] config checkpoint migrationId=${migrationId} commit=${response.checkpointCommit}`);
            return response;
        },
        async proveConfigRestore({ migrationId, gatewayId, transportId, slug, checkpointCommit }) {
            const response = await postSignedJson(transportId ?? gatewayId, `/config-restore-proof/${gatewayId}`, migrationId, configMutationBody({ migrationId, slug, checkpointCommit }), transferMs);
            assertConfigResponseBinding(response, migrationId, slug);
            if (!/^[0-9a-f]{40}$/.test(response.restoredCommit) ||
                !/^[0-9a-f]{40}$/.test(response.acceptedCommit) ||
                !/^[0-9a-f]{64}$/.test(response.configHash) ||
                response.configReady !== true ||
                response.observedRevisionId !== (transportId ?? gatewayId) ||
                !Number.isFinite(response.restoreProvenAt) ||
                !Number.isFinite(response.configReadyAt) ||
                response.configReadyAt < response.restoreProvenAt ||
                typeof response.runtimeConfigHash !== "string" ||
                response.runtimeConfigHash.length === 0) {
                throw new Error("malformed config restore proof response");
            }
            log(`[migration-client] config restore proof migrationId=${migrationId} restored=${response.restoredCommit} accepted=${response.acceptedCommit}`);
            return response;
        },
        async reproveConfigRestore({ migrationId, gatewayId, transportId, slug, checkpointCommit }) {
            const response = await postSignedJson(transportId ?? gatewayId, `/config-restore-proof/${gatewayId}`, migrationId, configMutationBody({ migrationId, slug, checkpointCommit, proofOnly: true }), transferMs);
            assertConfigResponseBinding(response, migrationId, slug);
            if (!/^[0-9a-f]{40}$/.test(response.restoredCommit) ||
                !/^[0-9a-f]{40}$/.test(response.acceptedCommit) ||
                !/^[0-9a-f]{64}$/.test(response.configHash) ||
                response.configReady !== true ||
                response.observedRevisionId !== (transportId ?? gatewayId) ||
                !Number.isFinite(response.restoreProvenAt) ||
                !Number.isFinite(response.configReadyAt) ||
                response.configReadyAt < response.restoreProvenAt ||
                typeof response.runtimeConfigHash !== "string" ||
                response.runtimeConfigHash.length === 0) {
                throw new Error("malformed config reproof response");
            }
            log(`[migration-client] config restore reproof migrationId=${migrationId} accepted=${response.acceptedCommit}`);
            return response;
        },
        async unfreezeConfig({ migrationId, gatewayId, transportId, slug }) {
            const response = await postSignedJson(transportId ?? gatewayId, `/config-unfreeze/${gatewayId}`, migrationId, configMutationBody({ migrationId, slug }), transferMs);
            assertConfigResponseBinding(response, migrationId, slug);
            if (response.unfrozen !== true) {
                throw new Error("config unfreeze was not confirmed");
            }
            log(`[migration-client] config unfreeze migrationId=${migrationId}`);
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
