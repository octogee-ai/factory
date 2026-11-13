import { readFile } from "node:fs/promises";
import { WebSocket } from "ws";
import { DEFAULT_PROJECTED_API_TOKEN_PATH, K8S_SA_TOKEN_HEADER, internalFetch, } from "./internal-fetch.js";
export const VOICE_RELAY_TTS_TIMEOUT_MS = 30_000;
const STT_CONNECT_TIMEOUT_MS = 10_000;
export class VoiceRelayError extends Error {
    status;
    name = "VoiceRelayError";
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}
async function projectedToken(tokenPath) {
    try {
        const token = (await readFile(tokenPath, "utf8")).trim();
        return token.length > 0 ? token : null;
    }
    catch {
        return null;
    }
}
function trimTrailingSlashes(url) {
    let out = url;
    while (out.endsWith("/"))
        out = out.slice(0, -1);
    return out;
}
function toWsBase(baseUrl) {
    const trimmed = trimTrailingSlashes(baseUrl);
    return trimmed.startsWith("https://") ? `wss://${trimmed.slice("https://".length)}` : `ws://${trimmed.replace(/^http:\/\//, "")}`;
}
export function createVoiceRelayClient(options) {
    const baseUrl = trimTrailingSlashes(options.baseUrl);
    const tokenPath = options.tokenPath ?? process.env.OCTOGEE_API_SA_TOKEN_PATH ?? DEFAULT_PROJECTED_API_TOKEN_PATH;
    const WebSocketImpl = options.WebSocketImpl ?? WebSocket;
    return {
        openStt(events) {
            let socket = null;
            let finished = false;
            let ending = false;
            const queued = [];
            let queuedBytes = 0;
            const MAX_QUEUED = 2 * 1024 * 1024;
            const fail = (error) => {
                if (finished)
                    return;
                finished = true;
                events.onError?.(error);
                try {
                    socket?.close();
                }
                catch {
                    /* already closed */
                }
            };
            const connectTimer = setTimeout(() => fail(new VoiceRelayError("voice relay STT connect timeout")), STT_CONNECT_TIMEOUT_MS);
            void (async () => {
                const token = await projectedToken(tokenPath);
                if (finished)
                    return;
                const url = `${toWsBase(baseUrl)}/internal/voice/stt?gatewayId=${encodeURIComponent(options.gatewayId)}`;
                const ws = new WebSocketImpl(url, { headers: token ? { [K8S_SA_TOKEN_HEADER]: token } : {} });
                socket = ws;
                ws.on("open", () => {
                    clearTimeout(connectTimer);
                    for (const chunk of queued)
                        ws.send(chunk, { binary: true });
                    queued.length = 0;
                    queuedBytes = 0;
                    if (ending)
                        ws.send(JSON.stringify({ type: "end" }));
                });
                ws.on("message", (data, isBinary) => {
                    if (finished || isBinary)
                        return;
                    let message;
                    try {
                        message = JSON.parse(data.toString());
                    }
                    catch {
                        return;
                    }
                    if (message.type === "ready")
                        events.onReady?.();
                    else if (message.type === "partial" && typeof message.text === "string")
                        events.onPartial?.(message.text);
                    else if (message.type === "final") {
                        finished = true;
                        events.onFinal?.(typeof message.text === "string" ? message.text : "");
                    }
                    else if (message.type === "error") {
                        fail(new VoiceRelayError(message.message ?? "voice relay STT error"));
                    }
                });
                ws.on("unexpected-response", (_req, res) => {
                    clearTimeout(connectTimer);
                    fail(new VoiceRelayError(`voice relay STT refused: HTTP ${res.statusCode ?? "?"}`, res.statusCode));
                });
                ws.on("error", (err) => {
                    clearTimeout(connectTimer);
                    fail(err instanceof Error ? err : new VoiceRelayError(String(err)));
                });
                ws.on("close", () => {
                    clearTimeout(connectTimer);
                    if (!finished)
                        fail(new VoiceRelayError("voice relay STT closed before a final transcript"));
                });
            })();
            return {
                sendAudio(pcm) {
                    if (finished || ending)
                        return;
                    if (socket && socket.readyState === WebSocketImpl.OPEN) {
                        socket.send(pcm, { binary: true });
                        return;
                    }
                    queuedBytes += pcm.length;
                    if (queuedBytes > MAX_QUEUED) {
                        fail(new VoiceRelayError("voice relay STT queue overflow"));
                        return;
                    }
                    queued.push(pcm);
                },
                end() {
                    if (finished || ending)
                        return;
                    ending = true;
                    if (socket && socket.readyState === WebSocketImpl.OPEN)
                        socket.send(JSON.stringify({ type: "end" }));
                },
                abort() {
                    if (finished)
                        return;
                    finished = true;
                    clearTimeout(connectTimer);
                    try {
                        if (socket && socket.readyState === WebSocketImpl.OPEN)
                            socket.send(JSON.stringify({ type: "abort" }));
                        socket?.close();
                    }
                    catch {
                        /* already closed */
                    }
                },
            };
        },
        async *tts(request) {
            const res = await internalFetch(`${baseUrl}/internal/voice/tts`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    gatewayId: options.gatewayId,
                    text: request.text,
                    ...(request.voice ? { voice: request.voice } : {}),
                    ...(request.speed !== undefined ? { speed: request.speed } : {}),
                }),
                ...(request.signal ? { signal: request.signal } : {}),
            }, { fetchImpl: options.fetchImpl, tokenPath, timeoutMs: VOICE_RELAY_TTS_TIMEOUT_MS });
            if (!res.ok) {
                const detail = (await res.text().catch(() => "")).slice(0, 300);
                const suffix = detail ? `: ${detail}` : "";
                throw new VoiceRelayError(`voice relay TTS HTTP ${res.status}${suffix}`, res.status);
            }
            if (!res.body)
                throw new VoiceRelayError("voice relay TTS returned no body");
            const reader = res.body.getReader();
            let carry = Buffer.alloc(0);
            try {
                while (true) {
                    const { value, done } = await reader.read();
                    if (done)
                        break;
                    if (!value || value.byteLength === 0)
                        continue;
                    const bytes = carry.length
                        ? Buffer.concat([carry, Buffer.from(value.buffer, value.byteOffset, value.byteLength)])
                        : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
                    const whole = bytes.length - (bytes.length % 2);
                    carry = Buffer.from(bytes.subarray(whole));
                    if (whole > 0)
                        yield bytes.subarray(0, whole);
                }
            }
            finally {
                reader.releaseLock();
            }
        },
    };
}
