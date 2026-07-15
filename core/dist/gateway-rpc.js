import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WebSocket } from "ws";
import { OPENCLAW_PROTOCOL_VERSION } from "@octogee/shared/types/openclaw-wire";
import { OpenclawWireError, startConnectChallengeTracker, waitForWsOpen, sendWsRequest, } from "@octogee/shared/types/openclaw-wire-core";
import { log as defaultLog } from "./config.js";
import { loadOrCreateDeviceIdentity, signConnectDevice, } from "./gateway-device-identity.js";
export { OpenclawWireError, } from "@octogee/shared/types/openclaw-wire-core";
const INVALID_RESPONSE = "invalid-response";
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
export function createGatewayRpc(opts = {}) {
    const url = opts.url ??
        `ws://127.0.0.1:${process.env.OPENCLAW_GATEWAY_PORT || process.env.GATEWAY_PORT || 18789}`;
    const auth = resolveGatewayAuth(opts);
    const connectTimeoutMs = opts.connectTimeoutMs ?? 30_000;
    const callTimeoutMs = opts.callTimeoutMs ?? 30_000;
    const scopes = opts.scopes ?? ["operator.admin"];
    const traceVerbose = /^(1|true|yes|debug)$/i.test(process.env.OCTOGEE_RPC_TRACE_VERBOSE ?? "");
    const slowTraceMs = Number.parseInt(process.env.OCTOGEE_RPC_TRACE_SLOW_MS ?? "5000", 10);
    const failureSampleMs = Number.parseInt(process.env.OCTOGEE_RPC_TRACE_FAILURE_SAMPLE_MS ?? "30000", 10);
    let lastFailureKey = "";
    let lastFailureLogAt = 0;
    let suppressedFailures = 0;
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
    const onConnectTrace = opts.onConnectTrace ??
        ((trace) => {
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
        });
    let identity = opts.identity ?? null;
    function resolveIdentity() {
        if (identity)
            return identity;
        identity = loadOrCreateDeviceIdentity();
        return identity;
    }
    async function call(method, params) {
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
                timeoutMs: callTimeoutMs,
            });
        }
        finally {
            try {
                ws.close();
            }
            catch { /* */ }
        }
    }
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
            return { config: snap.config, hash: snap.hash };
        },
        async configApply(config, baseHash) {
            return await writeConfig(call, "config.apply", config, baseHash);
        },
        async configPatch(patch, baseHash, opts) {
            return await writeConfig(call, "config.patch", patch, baseHash, opts?.replacePaths);
        },
        async channelsStatus() {
            return await call("channels.status", {});
        },
        async gatewayRestartRequest(params) {
            const payload = await call("gateway.restart.request", params);
            if (!payload || typeof payload !== "object") {
                throw new OpenclawWireError(INVALID_RESPONSE, "gateway.restart.request returned non-object payload");
            }
            return payload;
        },
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
        async secretsReload() {
            const payload = await call("secrets.reload", {});
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
        async close() { },
    };
}
function resolveGatewayAuth(opts) {
    if (typeof opts.deviceToken === "string" && opts.deviceToken.length > 0) {
        return { deviceToken: opts.deviceToken };
    }
    if (typeof opts.token === "string" && opts.token.length > 0)
        return { token: opts.token };
    if (!opts.allowLegacyGatewayTokenFallback)
        return {};
    const fromEnv = process.env.OPENCLAW_GATEWAY_TOKEN;
    if (typeof fromEnv === "string" && fromEnv.length > 0)
        return { token: fromEnv };
    const fromFile = readTokenFromOpenClawJson(opts.openclawConfigPath);
    return fromFile ? { token: fromFile } : {};
}
function readTokenFromOpenClawJson(configPath) {
    const resolved = configPath ?? path.join(os.homedir(), ".openclaw", "openclaw.json");
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
    const ws = new WebSocket(params.url);
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
        const connectStart = Date.now();
        await sendWsRequest({
            ws,
            id: randomUUID(),
            method: "connect",
            params: {
                minProtocol: PROTOCOL_VERSION,
                maxProtocol: PROTOCOL_VERSION,
                client: clientInfo,
                role: "operator",
                scopes: params.scopes,
                device,
                ...(auth ? { auth } : {}),
            },
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
