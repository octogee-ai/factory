// Talk protocol — the wire contract between a voice client (PWA today; a phone
// line or a counter-top device later) and the gateway-edge Talk engine.
//
// One WebSocket carries both directions. Text frames are JSON messages typed
// below; binary frames are raw PCM16LE mono audio — microphone audio at
// TALK_INPUT_SAMPLE_RATE from the client, synthesized speech at
// TALK_OUTPUT_SAMPLE_RATE from the engine. Event names mirror OpenClaw's
// `talk.event` vocabulary so a later gateway-relay convergence is a rename.
import { isMattermostThreadSelection } from './mattermost-session-route.js';

export const VOICE_TALK_FLAG = "release-voice-talk" as const;

export const TALK_PROTOCOL_VERSION = 1 as const;
export const TALK_INPUT_SAMPLE_RATE = 16_000 as const;
export const TALK_OUTPUT_SAMPLE_RATE = 24_000 as const;
export const TALK_TICKET_PURPOSE = "voice-ws" as const;

export type TalkMode = "converse" | "dictate";

export interface TalkCapabilities {
  speed: boolean;
  interrupt?: boolean;
  bargeIn?: boolean;
  /** Provider owns a continuous audio stream rather than cancellable responses. */
  continuousOutput?: boolean;
}
export const TALK_CAPABILITIES_DEFAULT: TalkCapabilities = { speed: true };
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

export const TALK_SETTINGS_DEFAULTS: ResolvedTalkSettings = {
  voice: "",
  speed: 1,
  handsFreeMs: 12_000,
  endpointing: "normal",
};

export const TALK_SPEED_MIN = 0.5;
export const TALK_SPEED_MAX = 2;
export const TALK_HANDS_FREE_MAX_MS = 60_000;

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

export const TALK_VOICE_ID_MAX = 128;
const TALK_VOICE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9 _.:/-]*$/;

/** A voice id as stored on the coach: provider-shaped (slug, uuid, `kokoro/af_heart`), or empty for the engine default. */
export function isTalkVoiceId(value: unknown): value is string {
  return typeof value === "string" && value.length <= TALK_VOICE_ID_MAX && (value === "" || TALK_VOICE_ID_RE.test(value));
}

export type TalkClientMessage =
  | {
      type: "session.start";
      protocol: typeof TALK_PROTOCOL_VERSION;
      mode: TalkMode;
      channelId: string;
      threadRootPostId: string;
      settings?: TalkSettings;
      client?: { platform?: string; userAgent?: string };
    }
  | { type: "listen.start" }
  | { type: "listen.stop" }
  | { type: "turn.commit" }
  | { type: "speak.cancel" }
  | { type: "agent.interrupt"; requestId: string }
  | { type: "playback.done"; turnId: string }
  | { type: "playback.mark"; name: string }
  | { type: "replay" }
  | { type: "settings.update"; settings: TalkSettings }
  | { type: "session.end" };

export type TalkTranscriptFinalReason = "endpoint" | "commit" | "timeout";

export type TalkErrorCode =
  | "not_configured"
  | "bad_message"
  | "session_not_started"
  | "vad_failed"
  | "stt_failed"
  | "tts_failed"
  | "brain_failed"
  | "reply_timeout"
  | "internal";

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

export type TalkServerEvent =
  | {
      type: "session.ready";
      sessionId: string;
      protocol: typeof TALK_PROTOCOL_VERSION;
      input: { sampleRate: typeof TALK_INPUT_SAMPLE_RATE | 24000 };
      output: { sampleRate: typeof TALK_OUTPUT_SAMPLE_RATE };
      engines: { stt: string; tts: string };
      /** What the speech engine can do itself; the client compensates for the rest (speed → playback rate). */
      capabilities: TalkCapabilities;
      settings: ResolvedTalkSettings;
    }
  | { type: "ui.command"; payload: Record<string, unknown> }
  | { type: "audio.mark"; name: string }
  | { type: "agent.interrupting"; requestId: string }
  | { type: "agent.interrupted"; requestId: string; status: "aborted" | "no-active-run"; runId?: string }
  | { type: "agent.interrupted"; requestId: string; status: "failed"; message: string }
  | { type: "state"; state: TalkState; turnId?: string }
  | { type: "vad"; speaking: boolean }
  | { type: "transcript.delta"; turnId: string; text: string }
  | { type: "transcript.final"; turnId: string; text: string; reason: TalkTranscriptFinalReason }
  | { type: "reply.delta"; turnId: string; text: string }
  | { type: "reply.final"; turnId: string; text: string }
  | { type: "audio.start"; turnId: string; sampleRate: typeof TALK_OUTPUT_SAMPLE_RATE }
  | { type: "audio.end"; turnId: string; cancelled: boolean }
  | { type: "listen.window"; ms: number }
  | { type: "settings"; settings: ResolvedTalkSettings }
  | { type: "metrics"; metrics: TalkTurnMetrics }
  | { type: "error"; code: TalkErrorCode; message: string; recoverable: boolean };

const TALK_MODES: readonly TalkMode[] = ["converse", "dictate"];
const TALK_ENDPOINTINGS: readonly TalkEndpointing[] = ["normal", "patient"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Validate partial settings from a client. Unknown keys are dropped; out-of-range
 * numbers are clamped; a malformed value for a known key rejects the whole object
 * so a client bug never silently becomes a weird default.
 */
export function parseTalkSettings(value: unknown): TalkSettings | null {
  if (!isRecord(value)) return null;
  const out: TalkSettings = {};
  if ("voice" in value) {
    if (typeof value.voice !== "string" || value.voice.length > 128) return null;
    out.voice = value.voice;
  }
  if ("speed" in value) {
    if (typeof value.speed !== "number" || !Number.isFinite(value.speed)) return null;
    out.speed = Math.min(TALK_SPEED_MAX, Math.max(TALK_SPEED_MIN, value.speed));
  }
  if ("handsFreeMs" in value) {
    if (typeof value.handsFreeMs !== "number" || !Number.isFinite(value.handsFreeMs)) return null;
    out.handsFreeMs = Math.min(TALK_HANDS_FREE_MAX_MS, Math.max(0, Math.round(value.handsFreeMs)));
  }
  if ("endpointing" in value) {
    if (!TALK_ENDPOINTINGS.includes(value.endpointing as TalkEndpointing)) return null;
    out.endpointing = value.endpointing as TalkEndpointing;
  }
  return out;
}

export function resolveTalkSettings(
  ...layers: ReadonlyArray<TalkSettings | null | undefined>
): ResolvedTalkSettings {
  const resolved: ResolvedTalkSettings = { ...TALK_SETTINGS_DEFAULTS };
  for (const layer of layers) {
    if (!layer) continue;
    if (layer.voice !== undefined) resolved.voice = layer.voice;
    if (layer.speed !== undefined) resolved.speed = layer.speed;
    if (layer.handsFreeMs !== undefined) resolved.handsFreeMs = layer.handsFreeMs;
    if (layer.endpointing !== undefined) resolved.endpointing = layer.endpointing;
  }
  return resolved;
}

const BARE_CONTROL_TYPES = new Set(["listen.start", "listen.stop", "turn.commit", "speak.cancel", "replay", "session.end"]);

function parseSessionStart(value: Record<string, unknown>): TalkClientMessage | null {
  if (value.protocol !== TALK_PROTOCOL_VERSION) return null;
  if (!TALK_MODES.includes(value.mode as TalkMode)) return null;
  if (!isMattermostThreadSelection({ channelId: value.channelId, threadRootPostId: value.threadRootPostId }) || "mmToken" in value) return null;
  const settings = value.settings === undefined ? undefined : parseTalkSettings(value.settings);
  if (value.settings !== undefined && settings === null) return null;
  const client = parseClientInfo(value.client);
  return {
    type: "session.start",
    protocol: TALK_PROTOCOL_VERSION,
    mode: value.mode as TalkMode,
    channelId: value.channelId as string,
    threadRootPostId: value.threadRootPostId as string,
    ...(settings ? { settings } : {}),
    ...(client ? { client } : {}),
  };
}

function parseClientInfo(value: unknown): { platform?: string; userAgent?: string } | undefined {
  if (!isRecord(value)) return undefined;
  return {
    ...(typeof value.platform === "string" ? { platform: value.platform } : {}),
    ...(typeof value.userAgent === "string" ? { userAgent: value.userAgent } : {}),
  };
}

function parseIdentifiedControl(value: Record<string, unknown>): TalkClientMessage | null {
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
export function parseTalkClientMessage(raw: string): TalkClientMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.type !== "string") return null;
  if (value.type === "session.start") return parseSessionStart(value);
  if (value.type === "settings.update") {
    const settings = parseTalkSettings(value.settings);
    return settings ? { type: "settings.update", settings } : null;
  }
  const identified = parseIdentifiedControl(value);
  if (identified) return identified;
  if (BARE_CONTROL_TYPES.has(value.type)) {
    return { type: value.type as Extract<TalkClientMessage, { type: string }>["type"] } as TalkClientMessage;
  }
  return null;
}

/** Parse a server text frame on the client. Structural check only — the engine is trusted. */
export function parseTalkServerEvent(raw: string): TalkServerEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.type !== "string") return null;
  return value as unknown as TalkServerEvent;
}
