import { gatewayScopedJobId, signFleetRequest } from "./fleet-signature.js";
import { SIGNATURE_HEADER, MIGRATION_QUIESCE_TIMEOUT_MS, MIGRATION_TRANSFER_TIMEOUT_MS, MIGRATION_UNMOUNT_TIMEOUT_MS, MIGRATION_VERIFY_TIMEOUT_MS, } from "@octogee/shared/types/fleet-controller";
export class MigrationRpcError extends Error {
    details;
    status;
    code;
    constructor(message, options = {}) {
        super(message);
        this.name = "MigrationRpcError";
        this.details = options.details;
        this.status = options.status;
        this.code = options.code;
    }
}
export class MigrationDrainPendingError extends Error {
    retryable = true;
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
function createFetchWithTimeout(fetchImpl) {
    return async (label, url, init, timeoutMs) => {
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
}
function createSignedJsonPoster(deps) {
    return async (request) => {
        const { path, timeoutMs } = request;
        const rawBody = JSON.stringify(request.body);
        const signature = signFleetRequest(deps.privateKey, gatewayScopedJobId(request.migrationId, request.gatewayId), rawBody);
        const res = await deps.fetchWithTimeout(path, `${deps.resolveGatewayUrl(request.transportId)}${path}`, {
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
}
export function createMigrationClient(deps) {
    const log = deps.log ?? (() => undefined);
    const quiesceMs = deps.timeouts?.quiesceMs ?? MIGRATION_QUIESCE_TIMEOUT_MS;
    const transferMs = deps.timeouts?.transferMs ?? MIGRATION_TRANSFER_TIMEOUT_MS;
    const unmountMs = deps.timeouts?.unmountMs ?? MIGRATION_UNMOUNT_TIMEOUT_MS;
    const verifyMs = deps.timeouts?.verifyMs ?? MIGRATION_VERIFY_TIMEOUT_MS;
    const postSignedJson = createSignedJsonPoster({
        privateKey: deps.privateKey,
        resolveGatewayUrl: deps.resolveGatewayUrl,
        fetchWithTimeout: createFetchWithTimeout(deps.fetch ?? globalThis.fetch),
    });
    return {
        async abortImport({ migrationId, gatewayId, slug, mode }) {
            const result = await postSignedJson({
                transportId: gatewayId, path: `/abort-rsync-import/${gatewayId}`, gatewayId, migrationId,
                body: { migrationId, slug, mode, rpcPhase: "abort-rsync-import" }, timeoutMs: unmountMs,
            });
            if (result.migrationId !== migrationId || result.slug !== slug || result.imported !== false) {
                throw new Error("import cleanup acknowledgement mismatch");
            }
        },
        async scheduler({ gatewayId, transportId, ...body }) {
            const result = await postSignedJson({
                transportId: transportId ?? gatewayId,
                path: `/scheduler/${gatewayId}`,
                gatewayId,
                migrationId: body.migrationId,
                body,
                timeoutMs: quiesceMs,
            });
            if (result.operationId !== body.migrationId || result.phase !== body.phase ||
                !Array.isArray(result.agentIds) || result.agentIds.some(id => typeof id !== "string" || !id) ||
                (result.agentIds.length === 0 && body.phase !== "resume" && body.phase !== "abort") ||
                result.drained !== true || (body.phase === "export" && result.snapshot === undefined)) {
                throw new Error(`scheduler ${body.phase} did not prove a drained matching operation`);
            }
            return result;
        },
        async schedulerReady({ migrationId, gatewayId, transportId, slug }) {
            const result = await postSignedJson({
                transportId: transportId ?? gatewayId,
                path: `/scheduler-ready/${gatewayId}`,
                gatewayId,
                migrationId,
                body: { migrationId, slug },
                timeoutMs: quiesceMs,
            });
            if (result.ready !== true)
                throw new Error(`/scheduler-ready/${gatewayId} did not confirm readiness`);
        },
        async restoreTarget({ migrationId, gatewayId, transportId, uid, slug, snapshot, resume }) {
            const res = await postSignedJson({
                transportId: transportId ?? gatewayId,
                path: `/${resume === true ? "resume-restore" : "restore"}/${gatewayId}`,
                gatewayId,
                migrationId,
                body: { migrationId, uid, slug, snapshot },
                timeoutMs: transferMs,
            });
            log(`[migration-client] ✅ restoreTarget migrationId=${migrationId} slug=${slug} gateway=${gatewayId} steps=${res.steps.join(",")}`);
            return res;
        },
        async resume({ migrationId, gatewayId, transportId, slug }) {
            const response = await postSignedJson({
                transportId: transportId ?? gatewayId, path: `/resume/${gatewayId}`,
                gatewayId, migrationId, body: { migrationId, slug }, timeoutMs: quiesceMs,
            });
            if (response.resumed !== true)
                throw new Error(`source ingress did not resume for ${slug}`);
        },
        async quiesce({ migrationId, gatewayId, transportId, slug, timeoutMs, stopMattermost, schedulerHandoff, schedulerMigrationId, retainNonportable }) {
            const handoff = schedulerHandoff
                ? { schedulerHandoff: true, schedulerMigrationId: schedulerMigrationId ?? migrationId, ...(retainNonportable ? { retainNonportable: true } : {}) }
                : {};
            const res = await postSignedJson({
                transportId: transportId ?? gatewayId,
                path: `/quiesce/${gatewayId}`,
                gatewayId,
                migrationId,
                body: { migrationId, slug, ...(timeoutMs == null ? {} : { timeoutMs }), ...(stopMattermost === undefined ? {} : { stopMattermost }), ...handoff },
                timeoutMs: Math.max(quiesceMs, (timeoutMs ?? MIGRATION_QUIESCE_TIMEOUT_MS) + 30_000),
            });
            if (!res.drained) {
                throw new MigrationDrainPendingError(`quiesce did not drain: ${res.runningCount} still running on ${gatewayId} for slug=${slug}`);
            }
            log(`[migration-client] ✅ quiesce ok migrationId=${migrationId} slug=${slug}`);
            return res;
        },
        async flushGateway({ migrationId, gatewayId, transportId, slug, reason, expectedSystemConfigCommit, }) {
            const res = await postSignedJson({
                transportId: transportId ?? gatewayId,
                path: `/flush/${gatewayId}`,
                gatewayId,
                migrationId,
                body: {
                    migrationId,
                    slug,
                    reason,
                    ...(expectedSystemConfigCommit ? { expectedSystemConfigCommit } : {}),
                },
                timeoutMs: transferMs,
            });
            log(`[migration-client] ✅ flushGateway migrationId=${migrationId} slug=${slug} gateway=${gatewayId} ok=${res.ok}`);
            return res;
        },
        async unmount({ migrationId, gatewayId, transportId, slug }) {
            const res = await postSignedJson({
                transportId: transportId ?? gatewayId,
                path: `/unmount/${gatewayId}`,
                gatewayId,
                migrationId,
                body: { migrationId, slug },
                timeoutMs: unmountMs,
            });
            if (res.migrationId !== migrationId || res.slug !== slug || typeof res.unmounted !== "boolean") {
                throw new Error("unmount cleanup acknowledgement mismatch");
            }
            log(`[migration-client] ✅ unmount migrationId=${migrationId} slug=${slug} wasMounted=${res.unmounted}`);
            return res;
        },
        transferState: deps.transferState,
        async verifyTarget({ migrationId, gatewayId, transportId, slug, timeoutMs }) {
            const requestTimeoutMs = timeoutMs == null ? verifyMs : Math.max(verifyMs, timeoutMs + 30_000);
            const res = await postSignedJson({
                transportId: transportId ?? gatewayId,
                path: `/verify/${gatewayId}`,
                gatewayId,
                migrationId,
                body: timeoutMs == null ? { migrationId, slug } : { migrationId, slug, timeoutMs },
                timeoutMs: requestTimeoutMs,
            });
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
    const options = { status: response.status, details };
    if (typeof details.code === "string")
        options.code = details.code;
    return new MigrationRpcError(`${path}: ${response.status} ${text}`, options);
}
export async function reportMigrationProgress(deps, gatewayId, body) {
    const post = createSignedJsonPoster({
        privateKey: deps.privateKey,
        resolveGatewayUrl: deps.resolveGatewayUrl,
        fetchWithTimeout: createFetchWithTimeout(deps.fetch ?? globalThis.fetch),
    });
    await post({
        transportId: gatewayId,
        path: `/migration-progress/${gatewayId}`,
        gatewayId,
        migrationId: body.migrationId,
        body: { ...body },
        timeoutMs: 2_000,
    });
}
