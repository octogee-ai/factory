import { signFleetRequest } from "./fleet-signature.js";
import { SIGNATURE_HEADER, MIGRATION_QUIESCE_TIMEOUT_MS, MIGRATION_TRANSFER_TIMEOUT_MS, MIGRATION_UNMOUNT_TIMEOUT_MS, MIGRATION_VERIFY_TIMEOUT_MS, } from "@octogee/shared/types/fleet-controller";
export class MigrationRpcError extends Error {
    status;
    code;
    constructor(message, options = {}) {
        super(message);
        this.name = "MigrationRpcError";
        this.status = options.status;
        this.code = options.code;
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
    return typeof rpc.status === "number" &&
        (rpc.status === 501 ||
            rpc.status >= 400 &&
                rpc.status < 500 &&
                rpc.status !== 408 &&
                rpc.status !== 429);
}
export function createMigrationClient(deps) {
    const fetchImpl = deps.fetch ?? globalThis.fetch;
    const log = deps.log ?? (() => undefined);
    const quiesceMs = deps.timeouts?.quiesceMs ?? MIGRATION_QUIESCE_TIMEOUT_MS;
    const transferMs = deps.timeouts?.transferMs ?? MIGRATION_TRANSFER_TIMEOUT_MS;
    const unmountMs = deps.timeouts?.unmountMs ?? MIGRATION_UNMOUNT_TIMEOUT_MS;
    const verifyMs = deps.timeouts?.verifyMs ?? MIGRATION_VERIFY_TIMEOUT_MS;
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
        if (!res.ok)
            throw await migrationRpcError(path, res);
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
        async flushGateway({ migrationId, gatewayId, transportId, slug, reason, expectedSystemConfigCommit, }) {
            const res = await postSignedJson(transportId ?? gatewayId, `/flush/${gatewayId}`, migrationId, {
                migrationId,
                slug,
                reason,
                ...(expectedSystemConfigCommit ? { expectedSystemConfigCommit } : {}),
            }, transferMs);
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
async function migrationRpcError(path, response) {
    const text = await response.text().catch(() => "<no body>");
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
    const options = { status: response.status };
    if (typeof details.code === "string")
        options.code = details.code;
    return new MigrationRpcError(`${path}: ${response.status} ${text}`, options);
}
