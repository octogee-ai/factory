import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WebSocket } from "ws";
import { OPENCLAW_PROTOCOL_VERSION } from "@octogee/shared/types/openclaw-wire";
import { OpenclawWireError, startConnectChallengeTracker, waitForWsOpen, sendWsRequest, } from "@octogee/shared/types/openclaw-wire-core";
import { OPENCLAW_CONTROL_UI_CLIENT_ID, OPENCLAW_CONTROL_UI_CLIENT_MODE, isPerUserControlIdentity, openClawProxyIdentityHeaders, serviceProxyIdentity, } from "@octogee/shared/types/openclaw-proxy-identity";
import { log as defaultLog } from "./config.js";
import { loadOrCreateDeviceIdentity, signConnectDevice, } from "./gateway-device-identity.js";
export { OpenclawWireError, } from "@octogee/shared/types/openclaw-wire-core";
const INVALID_RESPONSE = "invalid-response";
function parseSecretsReloadPayload(payload) {
    if (!payload || typeof payload !== "object") {
        throw new OpenclawWireError(INVALID_RESPONSE, "secrets.reload returned non-object payload");
    }
    const p = payload;
    if (p.warningCount !== undefined && typeof p.warningCount !== "number") {
        throw new OpenclawWireError(INVALID_RESPONSE, `secrets.reload payload.warningCount must be a number when present (got ${typeof p.warningCount})`);
    }
    if (p.ok !== undefined && typeof p.ok !== "boolean") {
        throw new OpenclawWireError(INVALID_RESPONSE, `secrets.reload payload.ok must be a boolean when present (got ${typeof p.ok})`);
    }
    return p;
}
function parseSecretsApplyPayload(payload) {
    if (!payload || typeof payload !== "object") {
        throw new OpenclawWireError(INVALID_RESPONSE, "secrets.apply returned non-object payload");
    }
    const p = payload;
    if (p.changed !== undefined && typeof p.changed !== "boolean") {
        throw new OpenclawWireError(INVALID_RESPONSE, `secrets.apply payload.changed must be a boolean when present (got ${typeof p.changed})`);
    }
    return payload;
}
const AGENT_NOT_FOUND_MESSAGE = /^agent "[^"]*" not found$/;
const AGENT_ALREADY_EXISTS_MESSAGE = /^agent "[^"]*" already exists$/;
/**
 * openclaw refuses `agents.create` for an id already in the roster with
 * `errorShape(INVALID_REQUEST, 'agent "<id>" already exists')`. An ensure that
 * raced another writer has to treat that as already-done; every other refusal —
 * an unwritable workspace, a wedged deletion journal, a transport failure —
 * must still fail the mount.
 */
export function isAgentAlreadyExistsRpcError(err) {
    return (err instanceof OpenclawWireError &&
        err.code === "rpc-error" &&
        AGENT_ALREADY_EXISTS_MESSAGE.test(err.message));
}
/**
 * openclaw refuses `agents.delete` for an id that is neither rostered nor
 * mid-deletion with `errorShape(INVALID_REQUEST, 'agent "<id>" not found')`
 * (server-methods/agents.ts respondAgentNotFound). An eviction has to treat
 * that as already-done; every other refusal — the default agent, a wedged
 * deletion journal, a transport failure — must still fail the eviction.
 */
export function isAgentNotFoundRpcError(err) {
    return (err instanceof OpenclawWireError &&
        err.code === "rpc-error" &&
        AGENT_NOT_FOUND_MESSAGE.test(err.message));
}
function configChangedHash(data) {
    let parsed;
    try {
        parsed = JSON.parse(typeof data === "string"
            ? data
            : data.toString("utf-8"));
    }
    catch {
        return null;
    }
    if (!parsed ||
        typeof parsed !== "object" ||
        parsed.type !== "event" ||
        parsed.event !== "config.changed") {
        return null;
    }
    const hash = parsed.payload?.hash;
    return typeof hash === "string" && hash.length > 0 ? hash : null;
}
function trackConfigChange(ws) {
    const changedHashes = new Set();
    const waiters = new Map();
    const onMessage = (data) => {
        const hash = configChangedHash(data);
        if (!hash)
            return;
        changedHashes.add(hash);
        for (const resolve of waiters.get(hash) ?? [])
            resolve();
        waiters.delete(hash);
    };
    ws.on("message", onMessage);
    return {
        waitFor(hash, timeoutMs) {
            if (changedHashes.has(hash))
                return Promise.resolve();
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    cleanup();
                    reject(new OpenclawWireError("timeout", `config.changed for persisted hash ${hash} timed out after ${timeoutMs}ms`));
                }, timeoutMs);
                const onClose = () => {
                    cleanup();
                    reject(new OpenclawWireError("connect-failed", `socket closed before config.changed published hash ${hash}`));
                };
                const accepted = () => {
                    cleanup();
                    resolve();
                };
                function cleanup() {
                    clearTimeout(timer);
                    ws.removeListener("close", onClose);
                    waiters.get(hash)?.delete(accepted);
                }
                const hashWaiters = waiters.get(hash) ?? new Set();
                hashWaiters.add(accepted);
                waiters.set(hash, hashWaiters);
                ws.on("close", onClose);
                if (changedHashes.has(hash))
                    accepted();
            });
        },
        close() {
            ws.removeListener("message", onMessage);
            waiters.clear();
        },
    };
}
async function writeConfig(call, method, config, baseHash, replacePaths) {
    try {
        const payload = await call(method, {
            raw: JSON.stringify(config),
            baseHash,
            ...(replacePaths && replacePaths.length > 0
                ? { replacePaths: [...replacePaths] }
                : {}),
        });
        if (!payload || typeof payload !== "object") {
            throw new OpenclawWireError(INVALID_RESPONSE, `${method} returned non-object payload`);
        }
        const result = payload;
        if (result.ok !== true) {
            throw new OpenclawWireError(INVALID_RESPONSE, `${method} payload missing \`ok: true\``);
        }
        return result;
    }
    catch (err) {
        if (err instanceof OpenclawWireError && err.code === "rpc-error") {
            const message = err.message.toLowerCase();
            if (message.includes("config changed since last load") || message.includes("base hash")) {
                throw new OpenclawWireError("hash-mismatch", err.message, err.details);
            }
            if (message.includes("invalid config")) {
                throw new OpenclawWireError("invalid-patch", err.message, err.details);
            }
        }
        throw err;
    }
}
function formatConnectTrace(trace) {
    const phases = [
        trace.wsOpenMs !== undefined ? `wsOpen=${trace.wsOpenMs}ms` : null,
        trace.challengeMs !== undefined ? `challenge=${trace.challengeMs}ms` : null,
        trace.connectMs !== undefined ? `connect=${trace.connectMs}ms` : null,
    ]
        .filter(Boolean)
        .join(" ");
    const outcome = trace.success
        ? "OK"
        : `FAIL stage=${trace.stage} ${trace.errorCode}: ${trace.errorMessage}`;
    return `[rpc-trace] ${outcome} total=${trace.totalMs}ms ${phases} url=${trace.url}`;
}
function parseToolsCatalogResult(payload, agentId) {
    if (!payload || typeof payload !== "object") {
        throw new OpenclawWireError(INVALID_RESPONSE, "tools.catalog returned non-object payload");
    }
    const result = payload;
    if (result.agentId !== agentId || !Array.isArray(result.groups)) {
        throw new OpenclawWireError(INVALID_RESPONSE, "tools.catalog payload missing the requested agentId or groups array");
    }
    return payload;
}
async function fetchToolsCatalog(call, params, timeoutMs) {
    return parseToolsCatalogResult(await call("tools.catalog", params, timeoutMs), params.agentId);
}
function createDefaultConnectTraceHandler(traceVerbose, slowTraceMs, failureSampleMs) {
    let lastFailureKey = "";
    let lastFailureLogAt = 0;
    let suppressedFailures = 0;
    return (trace) => {
        if (traceVerbose) {
            defaultLog(formatConnectTrace(trace));
            return;
        }
        if (trace.success) {
            if (suppressedFailures > 0) {
                defaultLog(`${formatConnectTrace(trace)} (recovered after ${suppressedFailures} suppressed failures)`);
                suppressedFailures = 0;
                lastFailureKey = "";
            }
            else if (trace.totalMs >= slowTraceMs) {
                defaultLog(formatConnectTrace(trace));
            }
            return;
        }
        const now = Date.now();
        const failureKey = `${trace.stage}:${trace.errorCode}:${trace.errorMessage ?? ""}`;
        const shouldLog = failureKey !== lastFailureKey ||
            lastFailureLogAt === 0 ||
            now - lastFailureLogAt >= failureSampleMs;
        if (shouldLog) {
            const suffix = suppressedFailures > 0 ? ` (suppressed ${suppressedFailures} similar failures)` : "";
            defaultLog(`${formatConnectTrace(trace)}${suffix}`);
            lastFailureKey = failureKey;
            lastFailureLogAt = now;
            suppressedFailures = 0;
        }
        else {
            suppressedFailures++;
        }
    };
}
async function patchConfigAndWaitForChange(connection, patch, baseHash, replacePaths) {
    const ws = await openAndConnect({
        url: connection.url,
        ...connection.auth,
        connectTimeoutMs: connection.connectTimeoutMs,
        identity: connection.identity,
        scopes: connection.scopes,
        onConnectTrace: connection.onConnectTrace,
    });
    const change = trackConfigChange(ws);
    const connectedCall = async (method, params) => await sendWsRequest({
        ws,
        id: randomUUID(),
        method,
        params,
        timeoutMs: connection.callTimeoutMs,
    });
    try {
        const result = await writeConfig(connectedCall, "config.patch", patch, baseHash, replacePaths);
        if (result.noop === true)
            return result;
        if (!result.hash) {
            throw new OpenclawWireError(INVALID_RESPONSE, "config.patch payload missing `hash` required for config.changed correlation");
        }
        await change.waitFor(result.hash, connection.callTimeoutMs);
        return result;
    }
    finally {
        change.close();
        try {
            ws.close();
        }
        catch { /* */ }
    }
}
function createChannelsStatusConnection(connection) {
    let ws = null;
    let connecting = null;
    let generation = 0;
    let connectionGeneration = 0;
    function disconnect(activeWs) {
        if (ws === activeWs)
            ws = null;
        try {
            activeWs.close();
        }
        catch { /* */ }
    }
    async function getConnection() {
        if (ws?.readyState === WebSocket.OPEN)
            return ws;
        if (connecting)
            return await connecting;
        const activeGeneration = generation;
        const pending = (async () => {
            const activeWs = await openAndConnect({
                url: connection.url,
                ...connection.auth,
                connectTimeoutMs: connection.connectTimeoutMs,
                identity: connection.identity(),
                scopes: connection.scopes,
                onConnectTrace: connection.onConnectTrace,
            });
            if (generation !== activeGeneration) {
                disconnect(activeWs);
                throw new OpenclawWireError("connect-failed", "gateway RPC client closed while channels.status was connecting");
            }
            ws = activeWs;
            connectionGeneration += 1;
            activeWs.once("close", () => {
                if (ws === activeWs)
                    ws = null;
            });
            return activeWs;
        })();
        connecting = pending;
        try {
            return await pending;
        }
        finally {
            if (connecting === pending)
                connecting = null;
        }
    }
    return {
        async call() {
            const activeWs = await getConnection();
            try {
                return await sendWsRequest({
                    ws: activeWs,
                    id: randomUUID(),
                    method: "channels.status",
                    params: {},
                    timeoutMs: connection.callTimeoutMs,
                });
            }
            catch (err) {
                if (!(err instanceof OpenclawWireError) || err.code !== "rpc-error") {
                    disconnect(activeWs);
                }
                throw err;
            }
        },
        connectionGeneration: () => connectionGeneration,
        async close() {
            generation++;
            const activeWs = ws;
            ws = null;
            if (activeWs)
                disconnect(activeWs);
            const pending = connecting;
            connecting = null;
            if (pending) {
                try {
                    disconnect(await pending);
                }
                catch { /* */ }
            }
        },
    };
}
function createIdentityResolver(initialIdentity) {
    let identity = initialIdentity ?? null;
    return () => {
        if (identity)
            return identity;
        identity = loadOrCreateDeviceIdentity();
        return identity;
    };
}
function resolveRpcTraceSettings() {
    return {
        traceVerbose: /^(1|true|yes|debug)$/i.test(process.env.OCTOGEE_RPC_TRACE_VERBOSE ?? ""),
        slowTraceMs: Number.parseInt(process.env.OCTOGEE_RPC_TRACE_SLOW_MS ?? "5000", 10),
        failureSampleMs: Number.parseInt(process.env.OCTOGEE_RPC_TRACE_FAILURE_SAMPLE_MS ?? "30000", 10),
    };
}
async function stopChannels(call, params) {
    const payload = await call("channels.stop", params);
    if (!payload || typeof payload !== "object" ||
        payload.stopped !== true) {
        throw new OpenclawWireError(INVALID_RESPONSE, "channels.stop payload missing `stopped: true`");
    }
    return payload;
}
async function startChannels(call, params) {
    const payload = await call("channels.start", params);
    if (!payload || typeof payload !== "object" ||
        typeof payload.started !== "boolean") {
        throw new OpenclawWireError(INVALID_RESPONSE, "channels.start payload missing boolean `started`");
    }
    return payload;
}
async function requestGatewayRestart(call, params) {
    const payload = await call("gateway.restart.request", params);
    const result = payload;
    const restart = result?.restart;
    if (!result ||
        typeof result !== "object" ||
        result.ok !== true ||
        !["scheduled", "deferred", "coalesced"].includes(String(result.status)) ||
        !restart ||
        typeof restart !== "object" ||
        restart.ok !== true ||
        !Number.isSafeInteger(restart.pid) ||
        restart.pid <= 0 ||
        restart.signal !== "SIGUSR1" ||
        typeof restart.coalesced !== "boolean" ||
        (result.status === "coalesced") !== restart.coalesced) {
        throw new OpenclawWireError(INVALID_RESPONSE, "gateway.restart.request returned malformed restart acknowledgement");
    }
    return result;
}
async function callOkPayload(call, method, params) {
    const payload = await call(method, params);
    if (!payload || typeof payload !== "object" || payload.ok !== true) {
        throw new OpenclawWireError(INVALID_RESPONSE, `${method} payload missing \`ok: true\``);
    }
    return payload;
}
async function callAgentsCreate(call, params) {
    const payload = await callOkPayload(call, "agents.create", params);
    if (typeof payload.agentId !== "string" || payload.agentId.length === 0) {
        throw new OpenclawWireError(INVALID_RESPONSE, "agents.create payload missing string `agentId`");
    }
    return payload;
}
async function callAgentsDelete(call, params) {
    return (await callOkPayload(call, "agents.delete", params));
}
export function createGatewayRpc(opts = {}) {
    const url = opts.url ??
        `ws://127.0.0.1:${process.env.OPENCLAW_GATEWAY_PORT || process.env.GATEWAY_PORT || 18789}`;
    const auth = resolveGatewayAuth(opts);
    const connectTimeoutMs = opts.connectTimeoutMs ?? 30_000;
    const callTimeoutMs = opts.callTimeoutMs ?? 30_000;
    const scopes = opts.scopes ?? ["operator.admin"];
    const { traceVerbose, slowTraceMs, failureSampleMs } = resolveRpcTraceSettings();
    const onConnectTrace = opts.onConnectTrace ??
        createDefaultConnectTraceHandler(traceVerbose, slowTraceMs, failureSampleMs);
    const resolveIdentity = createIdentityResolver(opts.identity);
    async function call(method, params, requestTimeoutMs = callTimeoutMs) {
        const ws = await openAndConnect({
            url,
            ...auth,
            connectTimeoutMs,
            identity: resolveIdentity(),
            scopes,
            onConnectTrace,
        });
        try {
            return await sendWsRequest({
                ws,
                id: randomUUID(),
                method,
                params,
                timeoutMs: requestTimeoutMs,
            });
        }
        finally {
            try {
                ws.close();
            }
            catch { /* */ }
        }
    }
    const statusConnection = createChannelsStatusConnection({
        url, auth, connectTimeoutMs, callTimeoutMs, identity: resolveIdentity,
        scopes, onConnectTrace,
    });
    return {
        async configGet() {
            const payload = await call("config.get", {});
            const snap = payload;
            if (!snap || typeof snap !== "object") {
                throw new OpenclawWireError(INVALID_RESPONSE, "config.get returned non-object payload");
            }
            if (typeof snap.hash !== "string" || snap.hash.length === 0) {
                throw new OpenclawWireError(INVALID_RESPONSE, "config.get payload missing `hash`");
            }
            if (typeof snap.configRevisionHash !== "string" || snap.configRevisionHash.length === 0) {
                throw new OpenclawWireError(INVALID_RESPONSE, "config.get payload missing `configRevisionHash`");
            }
            if (snap.appliedConfigHash !== null &&
                (typeof snap.appliedConfigHash !== "string" || snap.appliedConfigHash.length === 0)) {
                throw new OpenclawWireError(INVALID_RESPONSE, "config.get payload has invalid `appliedConfigHash`");
            }
            return {
                config: snap.config,
                hash: snap.hash,
                configRevisionHash: snap.configRevisionHash,
                appliedConfigHash: snap.appliedConfigHash,
            };
        },
        async configApply(config, baseHash) {
            return await writeConfig(call, "config.apply", config, baseHash);
        },
        async configPatch(patch, baseHash, opts) {
            return await writeConfig(call, "config.patch", patch, baseHash, opts?.replacePaths);
        },
        async configPatchAndWaitForChange(patch, baseHash, opts) {
            return await patchConfigAndWaitForChange({
                url,
                auth,
                connectTimeoutMs,
                callTimeoutMs,
                identity: resolveIdentity(),
                scopes,
                onConnectTrace,
            }, patch, baseHash, opts?.replacePaths);
        },
        channelsStatus: statusConnection.call,
        channelsStatusConnectionGeneration: statusConnection.connectionGeneration,
        channelsStop: (params) => stopChannels(call, params),
        channelsStart: (params) => startChannels(call, params),
        gatewayRestartRequest: (params) => requestGatewayRestart(call, params),
        async sessionsList(params) {
            const payload = await call("sessions.list", params);
            if (!payload || typeof payload !== "object") {
                throw new OpenclawWireError(INVALID_RESPONSE, "sessions.list returned non-object payload");
            }
            const sessions = payload.sessions;
            if (!Array.isArray(sessions)) {
                throw new OpenclawWireError(INVALID_RESPONSE, "sessions.list payload missing `sessions` array");
            }
            for (const session of sessions) {
                if (!session || typeof session !== "object" || typeof session.key !== "string") {
                    throw new OpenclawWireError(INVALID_RESPONSE, "sessions.list returned a session without string `key`");
                }
            }
            return payload;
        },
        async sessionsReset(params) {
            const payload = await call("sessions.reset", params);
            if (!payload || typeof payload !== "object" || payload.ok !== true) {
                throw new OpenclawWireError(INVALID_RESPONSE, "sessions.reset payload missing `ok: true`");
            }
            return payload;
        },
        toolsCatalog: (params, timeoutMs) => fetchToolsCatalog(call, params, timeoutMs),
        async cronAdd(spec) {
            const payload = await call("cron.add", spec);
            if (!payload || typeof payload !== "object") {
                throw new OpenclawWireError(INVALID_RESPONSE, "cron.add returned non-object payload");
            }
            const p = payload;
            if (typeof p.id !== "string" || p.id.length === 0) {
                throw new OpenclawWireError(INVALID_RESPONSE, "cron.add payload missing string `id`");
            }
            return payload;
        },
        agentsCreate: (params) => callAgentsCreate(call, params),
        agentsDelete: (params) => callAgentsDelete(call, params),
        async secretsReload() {
            return parseSecretsReloadPayload(await call("secrets.reload", {}));
        },
        async secretsApply(params) {
            return parseSecretsApplyPayload(await call("secrets.apply", {
                plan: params.plan,
                allowExec: true,
                ...(params.dryRun !== undefined ? { dryRun: params.dryRun } : {}),
            }));
        },
        async isGatewayUp(timeoutMs) {
            const t = timeoutMs ?? connectTimeoutMs;
            try {
                const ws = await openAndConnect({
                    url,
                    ...auth,
                    connectTimeoutMs: t,
                    identity: resolveIdentity(),
                    scopes,
                    onConnectTrace,
                });
                try {
                    ws.close();
                }
                catch { /* */ }
                return true;
            }
            catch {
                return false;
            }
        },
        close: statusConnection.close,
    };
}
const IN_POD_SERVICE_IDENTITY = serviceProxyIdentity("octogee-provisioner");
function resolveGatewayAuth(opts) {
    if (typeof opts.deviceToken === "string" && opts.deviceToken.length > 0) {
        return { deviceToken: opts.deviceToken };
    }
    if (typeof opts.token === "string" && opts.token.length > 0)
        return { token: opts.token };
    if (!opts.allowLegacyGatewayTokenFallback)
        return {};
    if (isPerUserControlIdentity()) {
        return { proxyIdentity: openClawProxyIdentityHeaders({ user: IN_POD_SERVICE_IDENTITY }) };
    }
    const fromEnv = process.env.OPENCLAW_GATEWAY_TOKEN;
    if (typeof fromEnv === "string" && fromEnv.length > 0)
        return { token: fromEnv };
    const fromFile = readTokenFromOpenClawJson(opts.openclawConfigPath);
    return fromFile ? { token: fromFile } : {};
}
function readTokenFromOpenClawJson(configPath) {
    const activeConfigPath = process.env.OPENCLAW_CONFIG_PATH?.trim();
    const resolved = configPath
        ?? activeConfigPath
        ?? path.join(os.homedir(), ".openclaw", "openclaw.json");
    try {
        const raw = fs.readFileSync(resolved, "utf8");
        const parsed = JSON.parse(raw);
        const token = parsed?.gateway?.auth?.token;
        if (typeof token === "string" && token.length > 0)
            return token;
    }
    catch { /* */ }
    return "";
}
const PROTOCOL_VERSION = OPENCLAW_PROTOCOL_VERSION;
function proxyIdentityConnectParams() {
    return {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: {
            id: OPENCLAW_CONTROL_UI_CLIENT_ID,
            displayName: "octogee-provisioner",
            version: "1.0.0",
            platform: process.platform,
            mode: OPENCLAW_CONTROL_UI_CLIENT_MODE,
        },
        role: "operator",
    };
}
function deviceConnectParams(params, nonce) {
    const clientInfo = {
        id: "gateway-client",
        displayName: "octogee-provisioner",
        version: "1.0.0",
        platform: process.platform,
        mode: "backend",
    };
    const device = signConnectDevice({
        identity: params.identity,
        clientId: clientInfo.id,
        clientMode: clientInfo.mode,
        role: "operator",
        scopes: params.scopes,
        nonce,
        token: params.deviceToken || params.token || null,
        platform: clientInfo.platform,
    });
    let auth;
    if (params.deviceToken)
        auth = { deviceToken: params.deviceToken };
    else if (params.token)
        auth = { token: params.token };
    else
        auth = undefined;
    return {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: clientInfo,
        role: "operator",
        scopes: params.scopes,
        device,
        ...(auth ? { auth } : {}),
    };
}
async function openAndConnect(params) {
    const t0 = Date.now();
    let wsOpenMs;
    let challengeMs;
    let connectMs;
    let stage = "ws-open";
    const emitTrace = (success, err) => {
        if (!params.onConnectTrace)
            return;
        params.onConnectTrace({
            url: params.url,
            stage: success ? "done" : stage,
            success,
            wsOpenMs,
            challengeMs,
            connectMs,
            totalMs: Date.now() - t0,
            errorCode: err?.code,
            errorMessage: err?.message,
        });
    };
    const ws = params.proxyIdentity
        ? new WebSocket(params.url, { headers: params.proxyIdentity })
        : new WebSocket(params.url);
    ws.on("error", () => { });
    const nonceTracker = startConnectChallengeTracker(ws);
    try {
        const wsOpenStart = Date.now();
        await waitForWsOpen(ws, params.connectTimeoutMs);
        wsOpenMs = Date.now() - wsOpenStart;
        stage = "challenge";
        const challengeStart = Date.now();
        const nonce = await nonceTracker.wait(params.connectTimeoutMs);
        challengeMs = Date.now() - challengeStart;
        stage = "connect";
        const connectStart = Date.now();
        await sendWsRequest({
            ws,
            id: randomUUID(),
            method: "connect",
            params: params.proxyIdentity
                ? proxyIdentityConnectParams()
                : deviceConnectParams(params, nonce),
            timeoutMs: params.connectTimeoutMs,
            mapConnectErrors: true,
        });
        connectMs = Date.now() - connectStart;
        emitTrace(true);
    }
    catch (err) {
        try {
            ws.terminate();
        }
        catch { /* */ }
        emitTrace(false, err instanceof OpenclawWireError ? err : undefined);
        throw err;
    }
    return ws;
}
