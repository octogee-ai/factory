export declare const VOICE_TALK_FLAG: "release-voice-talk";
export declare const TALK_PROTOCOL_VERSION: 1;
export declare const TALK_INPUT_SAMPLE_RATE: 16000;
export declare const TALK_OUTPUT_SAMPLE_RATE: 24000;
export declare const TALK_TICKET_PURPOSE: "voice-ws";
export type TalkMode = "converse" | "dictate";
export interface TalkCapabilities {
    speed: boolean;
    interrupt?: boolean;
    bargeIn?: boolean;
}
export declare const TALK_CAPABILITIES_DEFAULT: TalkCapabilities;
export type TalkState = "idle" | "listening" | "thinking" | "speaking" | "error";
export type TalkEndpointing = "normal" | "patient";
export interface TalkSettings {
    voice?: string;
    /** Playback speed multiplier passed to the speech engine (0.5–2.0). */
    speed?: number;
    /** Hands-free listening window after Octo finishes speaking (0 = tap to talk). */
    handsFreeMs?: number;
    endpointing?: TalkEndpointing;
}
export type ResolvedTalkSettings = Required<TalkSettings>;
export declare const TALK_SETTINGS_DEFAULTS: ResolvedTalkSettings;
export declare const TALK_SPEED_MIN = 0.5;
export declare const TALK_SPEED_MAX = 2;
export declare const TALK_HANDS_FREE_MAX_MS = 60000;
/** A speech-engine voice a Builder can pick for their coach; `id` is what the provider accepts. */
export interface TalkVoice {
    id: string;
    name: string;
    language?: string;
    gender?: string;
    tags?: string[];
}
/** `GET /api/voice/voices`: what the configured speech engine offers, and which voice speaks by default. */
export interface TalkVoiceCatalog {
    configured: boolean;
    default: TalkVoice | null;
    voices: TalkVoice[];
}
export declare const TALK_VOICE_ID_MAX = 128;
/** A voice id as stored on the coach: provider-shaped (slug, uuid, `kokoro/af_heart`), or empty for the engine default. */
export declare function isTalkVoiceId(value: unknown): value is string;
export type TalkClientMessage = {
    type: "session.start";
    protocol: typeof TALK_PROTOCOL_VERSION;
    mode: TalkMode;
    channelId: string;
    threadRootPostId: string;
    settings?: TalkSettings;
    client?: {
        platform?: string;
        userAgent?: string;
    };
} | {
    type: "listen.start";
} | {
    type: "listen.stop";
} | {
    type: "turn.commit";
} | {
    type: "speak.cancel";
} | {
    type: "agent.interrupt";
    requestId: string;
} | {
    type: "playback.done";
    turnId: string;
} | {
    type: "playback.mark";
    name: string;
} | {
    type: "replay";
} | {
    type: "settings.update";
    settings: TalkSettings;
} | {
    type: "session.end";
};
export type TalkTranscriptFinalReason = "endpoint" | "commit" | "timeout";
export type TalkErrorCode = "not_configured" | "bad_message" | "session_not_started" | "vad_failed" | "stt_failed" | "tts_failed" | "brain_failed" | "reply_timeout" | "internal";
export interface TalkTurnMetrics {
    turnId: string;
    /** Speech end (endpoint) → final transcript available. */
    sttMs: number | null;
    /** Final transcript → first assistant text delta. */
    firstReplyMs: number | null;
    /** Final transcript → first audio frame sent to the client. */
    firstAudioMs: number | null;
    /** Final transcript → reply fully spoken. */
    totalMs: number | null;
}
export type TalkServerEvent = {
    type: "session.ready";
    sessionId: string;
    protocol: typeof TALK_PROTOCOL_VERSION;
    input: {
        sampleRate: typeof TALK_INPUT_SAMPLE_RATE | 24000;
    };
    output: {
        sampleRate: typeof TALK_OUTPUT_SAMPLE_RATE;
    };
    engines: {
        stt: string;
        tts: string;
    };
    /** What the speech engine can do itself; the client compensates for the rest (speed → playback rate). */
    capabilities: TalkCapabilities;
    settings: ResolvedTalkSettings;
} | {
    type: "ui.command";
    payload: Record<string, unknown>;
} | {
    type: "audio.mark";
    name: string;
} | {
    type: "agent.interrupting";
    requestId: string;
} | {
    type: "agent.interrupted";
    requestId: string;
    status: "aborted" | "no-active-run";
    runId?: string;
} | {
    type: "agent.interrupted";
    requestId: string;
    status: "failed";
    message: string;
} | {
    type: "state";
    state: TalkState;
    turnId?: string;
} | {
    type: "vad";
    speaking: boolean;
} | {
    type: "transcript.delta";
    turnId: string;
    text: string;
} | {
    type: "transcript.final";
    turnId: string;
    text: string;
    reason: TalkTranscriptFinalReason;
} | {
    type: "reply.delta";
    turnId: string;
    text: string;
} | {
    type: "reply.final";
    turnId: string;
    text: string;
} | {
    type: "audio.start";
    turnId: string;
    sampleRate: typeof TALK_OUTPUT_SAMPLE_RATE;
} | {
    type: "audio.end";
    turnId: string;
    cancelled: boolean;
} | {
    type: "listen.window";
    ms: number;
} | {
    type: "settings";
    settings: ResolvedTalkSettings;
} | {
    type: "metrics";
    metrics: TalkTurnMetrics;
} | {
    type: "error";
    code: TalkErrorCode;
    message: string;
    recoverable: boolean;
};
/**
 * Validate partial settings from a client. Unknown keys are dropped; out-of-range
 * numbers are clamped; a malformed value for a known key rejects the whole object
 * so a client bug never silently becomes a weird default.
 */
export declare function parseTalkSettings(value: unknown): TalkSettings | null;
export declare function resolveTalkSettings(...layers: ReadonlyArray<TalkSettings | null | undefined>): ResolvedTalkSettings;
/** Parse a client text frame. Returns null for anything that is not a well-formed message. */
export declare function parseTalkClientMessage(raw: string): TalkClientMessage | null;
/** Parse a server text frame on the client. Structural check only — the engine is trusted. */
export declare function parseTalkServerEvent(raw: string): TalkServerEvent | null;
