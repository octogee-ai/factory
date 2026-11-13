const CONNECT_FAILED = "connect-failed";
export class OpenclawWireError extends Error {
    code;
    details;
    name = "OpenclawWireError";
    constructor(code, message, details) {
        super(message);
        this.code = code;
        this.details = details;
    }
}
export function isResponseFrame(v) {
    return (typeof v === "object" &&
        v !== null &&
        v.type === "res" &&
        typeof v.id === "string" &&
        typeof v.ok === "boolean");
}
function frameToString(data) {
    if (typeof data === "string")
        return data;
    if (data instanceof ArrayBuffer) {
        return new TextDecoder("utf-8").decode(new Uint8Array(data));
    }
    if (Array.isArray(data)) {
        const parts = data.map(frameToString);
        return parts.some((p) => p === undefined)
            ? undefined
            : parts.join("");
    }
    if (data && typeof data.toString === "function") {
        return data.toString("utf-8");
    }
    return undefined;
}
function parseFrame(data) {
    const s = frameToString(data);
    if (s === undefined)
        return undefined;
    try {
        return JSON.parse(s);
    }
    catch {
        return undefined;
    }
}
export function waitForWsOpen(ws, timeoutMs) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            cleanup();
            try {
                ws.terminate();
            }
            catch {
                /* */
            }
            reject(new OpenclawWireError(CONNECT_FAILED, `WS open timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        const onOpen = () => {
            cleanup();
            resolve();
        };
        const onError = (...args) => {
            cleanup();
            try {
                ws.terminate();
            }
            catch {
                /* */
            }
            reject(new OpenclawWireError(CONNECT_FAILED, `WS open failed: ${args[0].message}`));
        };
        function cleanup() {
            clearTimeout(timer);
            ws.removeListener("open", onOpen);
            ws.removeListener("error", onError);
        }
        ws.once("open", onOpen);
        ws.once("error", onError);
    });
}
export function startConnectChallengeTracker(ws) {
    let cached = null;
    let pendingResolve = null;
    let pendingReject = null;
    const onMessage = (...args) => {
        if (cached !== null)
            return;
        const parsed = parseFrame(args[0]);
        if (typeof parsed !== "object" ||
            parsed === null ||
            parsed.type !== "event" ||
            parsed.event !== "connect.challenge") {
            return;
        }
        const nonce = parsed.payload?.nonce;
        if (typeof nonce !== "string" || nonce.length === 0) {
            if (pendingReject) {
                pendingReject(new OpenclawWireError("invalid-response", "connect.challenge event has no string nonce"));
            }
            return;
        }
        cached = nonce;
        if (pendingResolve)
            pendingResolve(nonce);
    };
    ws.on("message", onMessage);
    return {
        wait(timeoutMs) {
            if (cached !== null)
                return Promise.resolve(cached);
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    cleanup();
                    reject(new OpenclawWireError(CONNECT_FAILED, `connect.challenge not received within ${timeoutMs}ms`));
                }, timeoutMs);
                const onClose = () => {
                    cleanup();
                    reject(new OpenclawWireError(CONNECT_FAILED, "socket closed before connect.challenge arrived"));
                };
                pendingResolve = (nonce) => {
                    cleanup();
                    resolve(nonce);
                };
                pendingReject = (err) => {
                    cleanup();
                    reject(err);
                };
                function cleanup() {
                    clearTimeout(timer);
                    ws.removeListener("close", onClose);
                    pendingResolve = null;
                    pendingReject = null;
                }
                ws.on("close", onClose);
            });
        },
    };
}
export function sendWsRequest({ ws, id, method, params, timeoutMs, mapConnectErrors = false, }) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            cleanup();
            reject(new OpenclawWireError("timeout", `${method} response timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        const onMessage = (...args) => {
            const parsed = parseFrame(args[0]);
            if (!isResponseFrame(parsed) || parsed.id !== id)
                return;
            cleanup();
            if (parsed.ok) {
                resolve(parsed.payload);
                return;
            }
            const serverCode = parsed.error?.code ?? "UNKNOWN";
            const errMsg = parsed.error?.message ?? "gateway error";
            reject(new OpenclawWireError(mapConnectErrors ? "auth-failed" : "rpc-error", errMsg, { serverCode, details: parsed.error?.details }));
        };
        const onClose = () => {
            cleanup();
            reject(new OpenclawWireError(CONNECT_FAILED, `socket closed before ${method} response`));
        };
        const onError = (...args) => {
            cleanup();
            reject(new OpenclawWireError(CONNECT_FAILED, `socket error during ${method}: ${args[0].message}`));
        };
        function cleanup() {
            clearTimeout(timer);
            ws.removeListener("message", onMessage);
            ws.removeListener("close", onClose);
            ws.removeListener("error", onError);
        }
        ws.on("message", onMessage);
        ws.on("close", onClose);
        ws.on("error", onError);
        ws.send(JSON.stringify({ type: "req", id, method, params }));
    });
}
