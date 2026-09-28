// Talk protocol — the wire contract between a voice client (PWA today; a phone
// line or a counter-top device later) and the gateway-edge Talk engine.
//
// One WebSocket carries both directions. Text frames are JSON messages typed
// below; binary frames are raw PCM16LE mono audio — microphone audio at
// TALK_INPUT_SAMPLE_RATE from the client, synthesized speech at
// TALK_OUTPUT_SAMPLE_RATE from the engine. Event names mirror OpenClaw's
// `talk.event` vocabulary so a later gateway-relay convergence is a rename.
export const VOICE_TALK_FLAG = "release-voice-talk";
export const TALK_PROTOCOL_VERSION = 1;
export const TALK_INPUT_SAMPLE_RATE = 16_000;
export const TALK_OUTPUT_SAMPLE_RATE = 24_000;
export const TALK_TICKET_PURPOSE = "voice-ws";
export const TALK_CAPABILITIES_DEFAULT = { speed: true };
export const TALK_SETTINGS_DEFAULTS = {
    voice: "",
    speed: 1,
    handsFreeMs: 12_000,
    endpointing: "normal",
};
export const TALK_SPEED_MIN = 0.5;
export const TALK_SPEED_MAX = 2;
export const TALK_HANDS_FREE_MAX_MS = 60_000;
export const TALK_VOICE_ID_MAX = 128;
const TALK_VOICE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9 _.:/-]*$/;
/** A voice id as stored on the coach: provider-shaped (slug, uuid, `kokoro/af_heart`), or empty for the engine default. */
export function isTalkVoiceId(value) {
    return typeof value === "string" && value.length <= TALK_VOICE_ID_MAX && (value === "" || TALK_VOICE_ID_RE.test(value));
}
const TALK_MODES = ["converse", "dictate"];
const TALK_ENDPOINTINGS = ["normal", "patient"];
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nonEmptyString(value) {
    return typeof value === "string" && value.length > 0;
}
/**
 * Validate partial settings from a client. Unknown keys are dropped; out-of-range
 * numbers are clamped; a malformed value for a known key rejects the whole object
 * so a client bug never silently becomes a weird default.
 */
export function parseTalkSettings(value) {
    if (!isRecord(value))
        return null;
    const out = {};
    if ("voice" in value) {
        if (typeof value.voice !== "string" || value.voice.length > 128)
            return null;
        out.voice = value.voice;
    }
    if ("speed" in value) {
        if (typeof value.speed !== "number" || !Number.isFinite(value.speed))
            return null;
        out.speed = Math.min(TALK_SPEED_MAX, Math.max(TALK_SPEED_MIN, value.speed));
    }
    if ("handsFreeMs" in value) {
        if (typeof value.handsFreeMs !== "number" || !Number.isFinite(value.handsFreeMs))
            return null;
        out.handsFreeMs = Math.min(TALK_HANDS_FREE_MAX_MS, Math.max(0, Math.round(value.handsFreeMs)));
    }
    if ("endpointing" in value) {
        if (!TALK_ENDPOINTINGS.includes(value.endpointing))
            return null;
        out.endpointing = value.endpointing;
    }
    return out;
}
export function resolveTalkSettings(...layers) {
    const resolved = { ...TALK_SETTINGS_DEFAULTS };
    for (const layer of layers) {
        if (!layer)
            continue;
        if (layer.voice !== undefined)
            resolved.voice = layer.voice;
        if (layer.speed !== undefined)
            resolved.speed = layer.speed;
        if (layer.handsFreeMs !== undefined)
            resolved.handsFreeMs = layer.handsFreeMs;
        if (layer.endpointing !== undefined)
            resolved.endpointing = layer.endpointing;
    }
    return resolved;
}
const BARE_CONTROL_TYPES = new Set(["listen.start", "listen.stop", "turn.commit", "speak.cancel", "replay", "session.end"]);
function parseSessionStart(value) {
    if (value.protocol !== TALK_PROTOCOL_VERSION)
        return null;
    if (!TALK_MODES.includes(value.mode))
        return null;
    if (!nonEmptyString(value.channelId) || "mmToken" in value)
        return null;
    const settings = value.settings === undefined ? undefined : parseTalkSettings(value.settings);
    if (value.settings !== undefined && settings === null)
        return null;
    const client = parseClientInfo(value.client);
    return {
        type: "session.start",
        protocol: TALK_PROTOCOL_VERSION,
        mode: value.mode,
        channelId: value.channelId,
        ...(settings ? { settings } : {}),
        ...(client ? { client } : {}),
    };
}
function parseClientInfo(value) {
    if (!isRecord(value))
        return undefined;
    return {
        ...(typeof value.platform === "string" ? { platform: value.platform } : {}),
        ...(typeof value.userAgent === "string" ? { userAgent: value.userAgent } : {}),
    };
}
function parseIdentifiedControl(value) {
    if (value.type === "agent.interrupt") {
        return nonEmptyString(value.requestId) && value.requestId.length <= 128 ? { type: "agent.interrupt", requestId: value.requestId } : null;
    }
    if (value.type === "playback.mark") {
        return nonEmptyString(value.name) && value.name.length <= 256 ? { type: "playback.mark", name: value.name } : null;
    }
    if (value.type === "playback.done") {
        return nonEmptyString(value.turnId) ? { type: "playback.done", turnId: value.turnId } : null;
    }
    return null;
}
/** Parse a client text frame. Returns null for anything that is not a well-formed message. */
export function parseTalkClientMessage(raw) {
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch {
        return null;
    }
    if (!isRecord(value) || typeof value.type !== "string")
        return null;
    if (value.type === "session.start")
        return parseSessionStart(value);
    if (value.type === "settings.update") {
        const settings = parseTalkSettings(value.settings);
        return settings ? { type: "settings.update", settings } : null;
    }
    const identified = parseIdentifiedControl(value);
    if (identified)
        return identified;
    if (BARE_CONTROL_TYPES.has(value.type)) {
        return { type: value.type };
    }
    return null;
}
/** Parse a server text frame on the client. Structural check only — the engine is trusted. */
export function parseTalkServerEvent(raw) {
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch {
        return null;
    }
    if (!isRecord(value) || typeof value.type !== "string")
        return null;
    return value;
}
