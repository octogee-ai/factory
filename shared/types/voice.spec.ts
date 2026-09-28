import { describe, expect, it } from "vitest";
import {
  parseTalkClientMessage,
  parseTalkServerEvent,
  parseTalkSettings,
  resolveTalkSettings,
  TALK_HANDS_FREE_MAX_MS,
  TALK_PROTOCOL_VERSION,
  TALK_SETTINGS_DEFAULTS,
  TALK_SPEED_MAX,
  isTalkVoiceId,
} from "./voice.js";

describe("parseTalkClientMessage", () => {
  const start = {
    type: "session.start",
    protocol: TALK_PROTOCOL_VERSION,
    mode: "converse",
    channelId: "chan1",
  };

  it("accepts a well-formed session.start and drops unknown fields", () => {
    const parsed = parseTalkClientMessage(
      JSON.stringify({ ...start, settings: { speed: 0.9, junk: 1 }, client: { platform: "ios", extra: true }, extra: 1 }),
    );
    expect(parsed).toEqual({
      type: "session.start",
      protocol: 1,
      mode: "converse",
      channelId: "chan1",
        settings: { speed: 0.9 },
      client: { platform: "ios" },
    });
  });

  it("rejects session.start with the wrong protocol, mode, or missing identity", () => {
    expect(parseTalkClientMessage(JSON.stringify({ ...start, protocol: 2 }))).toBeNull();
    expect(parseTalkClientMessage(JSON.stringify({ ...start, mode: "shout" }))).toBeNull();
    expect(parseTalkClientMessage(JSON.stringify({ ...start, channelId: "" }))).toBeNull();
    expect(parseTalkClientMessage(JSON.stringify({ ...start, mmToken: "forged" }))).toBeNull();
  });

  it("rejects session.start whose settings are malformed rather than silently defaulting", () => {
    expect(parseTalkClientMessage(JSON.stringify({ ...start, settings: { speed: "fast" } }))).toBeNull();
    expect(parseTalkClientMessage(JSON.stringify({ ...start, settings: "loud" }))).toBeNull();
  });

  it("accepts the bare control messages and nothing else", () => {
    for (const type of ["listen.start", "listen.stop", "turn.commit", "speak.cancel", "replay", "session.end"]) {
      expect(parseTalkClientMessage(JSON.stringify({ type }))).toEqual({ type });
    }
    expect(parseTalkClientMessage(JSON.stringify({ type: "format.disk" }))).toBeNull();
    expect(parseTalkClientMessage("not json")).toBeNull();
    expect(parseTalkClientMessage(JSON.stringify(["listen.start"]))).toBeNull();
  });

  it("requires a turnId on playback.done", () => {
    expect(parseTalkClientMessage(JSON.stringify({ type: "playback.done", turnId: "t1" }))).toEqual({ type: "playback.done", turnId: "t1" });
    expect(parseTalkClientMessage(JSON.stringify({ type: "playback.done" }))).toBeNull();
  });

  it("parses settings.update through the same validator", () => {
    expect(parseTalkClientMessage(JSON.stringify({ type: "settings.update", settings: { endpointing: "patient" } })))
      .toEqual({ type: "settings.update", settings: { endpointing: "patient" } });
    expect(parseTalkClientMessage(JSON.stringify({ type: "settings.update", settings: { endpointing: "sloppy" } })))
      .toBeNull();
    expect(parseTalkClientMessage(JSON.stringify({ type: "settings.update" }))).toBeNull();
  });
});

describe("parseTalkSettings", () => {
  it("clamps numeric ranges instead of trusting the client", () => {
    expect(parseTalkSettings({ speed: 9, handsFreeMs: -5 })).toEqual({ speed: TALK_SPEED_MAX, handsFreeMs: 0 });
    expect(parseTalkSettings({ handsFreeMs: 10 ** 9 })).toEqual({ handsFreeMs: TALK_HANDS_FREE_MAX_MS });
    expect(parseTalkSettings({ handsFreeMs: 1234.6 })).toEqual({ handsFreeMs: 1235 });
  });

  it("rejects non-object input and over-long voice ids", () => {
    expect(parseTalkSettings(null)).toBeNull();
    expect(parseTalkSettings("x")).toBeNull();
    expect(parseTalkSettings({ voice: "v".repeat(129) })).toBeNull();
    expect(parseTalkSettings({ voice: "kokoro/af_heart" })).toEqual({ voice: "kokoro/af_heart" });
  });
});

describe("isTalkVoiceId", () => {
  it("accepts provider-shaped ids and the empty default, rejects control characters and over-long values", () => {
    for (const ok of ["", "en_paul_neutral", "c69964a6-ab8b-4f8a-9465-ec0925096ec8", "kokoro/af_heart", "Paul 2"]) {
      expect(isTalkVoiceId(ok)).toBe(true);
    }
    for (const bad of [" leading", "new\nline", "<script>", "a".repeat(129), 42, null]) {
      expect(isTalkVoiceId(bad)).toBe(false);
    }
  });
});

describe("resolveTalkSettings", () => {
  it("layers later settings over earlier ones and over the defaults", () => {
    expect(resolveTalkSettings()).toEqual(TALK_SETTINGS_DEFAULTS);
    expect(resolveTalkSettings({ speed: 0.8, voice: "a" }, null, { voice: "b" })).toEqual({
      ...TALK_SETTINGS_DEFAULTS,
      speed: 0.8,
      voice: "b",
    });
  });
});

describe("parseTalkServerEvent", () => {
  it("returns typed events for well-formed JSON objects and null otherwise", () => {
    expect(parseTalkServerEvent(JSON.stringify({ type: "state", state: "listening" }))).toEqual({
      type: "state",
      state: "listening",
    });
    expect(parseTalkServerEvent("{")).toBeNull();
    expect(parseTalkServerEvent(JSON.stringify(42))).toBeNull();
    expect(parseTalkServerEvent(JSON.stringify({ state: "listening" }))).toBeNull();
  });
});
