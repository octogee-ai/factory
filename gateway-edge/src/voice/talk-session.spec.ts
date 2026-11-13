import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TalkClientMessage, TalkServerEvent } from "@octogee/shared/types/voice";
import { TALK_PROTOCOL_VERSION } from "@octogee/shared/types/voice";
import type { BrainReplyHandlers } from "./brain.js";
import type { SttStream, SttStreamEvents, TtsRequest } from "@octogee/core/voice-relay-client";
import { TalkSession } from "./talk-session.js";
import { VAD_FRAME_SAMPLES } from "./silero-vad.js";

const CHANNEL_ID = "c".repeat(26);
const THREAD_ROOT_POST_ID = "r".repeat(26);

class FakeStt implements SttStream {
  audio: Buffer[] = [];
  ended = false;
  aborted = false;
  constructor(readonly events: SttStreamEvents) {}
  sendAudio(pcm: Buffer) {
    this.audio.push(pcm);
  }
  end() {
    this.ended = true;
  }
  abort() {
    this.aborted = true;
  }
}

class FakeRelay {
  stts: FakeStt[] = [];
  ttsRequests: TtsRequest[] = [];
  ttsChunksPerRequest = 2;
  ttsFail = false;
  openStt(events: SttStreamEvents) {
    const stt = new FakeStt(events);
    this.stts.push(stt);
    queueMicrotask(() => events.onReady?.());
    return stt;
  }
  async *tts(request: TtsRequest): AsyncIterable<Buffer> {
    this.ttsRequests.push(request);
    if (this.ttsFail) throw new Error("tts down");
    for (let i = 0; i < this.ttsChunksPerRequest; i++) {
      await Promise.resolve();
      if (request.signal?.aborted) return;
      yield Buffer.alloc(4800, i + 1);
    }
  }
  get last() {
    return this.stts[this.stts.length - 1];
  }
}

class FakeBrain {
  asks: Array<{ channelId: string; text: string; turnId: string; handlers: BrainReplyHandlers; cancel: ReturnType<typeof vi.fn> }> = [];
  failNext = false;
  holdNext = false;
  release: ((post: { id: string }) => void) | null = null;
  dispose = vi.fn();
  interrupt = vi.fn(async () => ({ status: "aborted" as const, runId: "run-1" }));
  async ask(input: { channelId: string; text: string; turnId: string }, handlers: BrainReplyHandlers) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("MM 401");
    }
    const cancel = vi.fn(() => handlers.onDone({ text: "", status: "aborted", runId: null }));
    this.asks.push({ ...input, handlers, cancel });
    if (this.holdNext) {
      this.holdNext = false;
      const post = await new Promise<{ id: string }>((resolve) => (this.release = resolve));
      return { postId: post.id, cancel, interrupt: this.interrupt };
    }
    return { postId: `post-${this.asks.length}`, cancel, interrupt: this.interrupt };
  }
  get last() {
    return this.asks[this.asks.length - 1];
  }
}

class FakeVad {
  probs: number[] = [];
  resets = 0;
  failAfter: number | null = null;
  async process(): Promise<number> {
    if (this.failAfter !== null && this.failAfter-- <= 0) throw new Error("onnx session lost");
    return this.probs.length ? this.probs.shift()! : 0;
  }
  reset() {
    this.resets += 1;
  }
}

function frameBuffer(frames: number): Buffer {
  return Buffer.alloc(frames * VAD_FRAME_SAMPLES * 2);
}

async function settle(rounds = 8) {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

function setup(opts: { handsFreeMs?: number; mode?: "converse" | "dictate"; speedControl?: boolean } = {}) {
  const events: TalkServerEvent[] = [];
  const audio: Buffer[] = [];
  const relay = new FakeRelay();
  const brain = new FakeBrain();
  const vad = new FakeVad();
  const createBrain = vi.fn(() => brain as unknown as ReturnType<TalkSessionDepsCreateBrain>);
  const session = new TalkSession({
    sessionId: "s1",
    send: (e) => events.push(e),
    sendAudio: (b) => audio.push(b),
    relay,
    createBrain: createBrain as never,
    vad,
    engines: { stt: "fake-stt", tts: "fake-tts" },
    capabilities: { speed: opts.speedControl ?? true, interrupt: true },
  });
  session.handleText(
    JSON.stringify({
      type: "session.start",
      protocol: TALK_PROTOCOL_VERSION,
      mode: opts.mode ?? "converse",
      channelId: CHANNEL_ID,
      threadRootPostId: THREAD_ROOT_POST_ID,
      settings: { handsFreeMs: opts.handsFreeMs ?? 0, speed: 0.9 },
    } satisfies TalkClientMessage),
  );
  return { session, events, audio, relay, brain, vad, createBrain };
}
type TalkSessionDepsCreateBrain = () => unknown;

const states = (events: TalkServerEvent[]) =>
  events.filter((e): e is Extract<TalkServerEvent, { type: "state" }> => e.type === "state").map((e) => e.state);

describe("TalkSession", () => {
  beforeEach(() => vi.useFakeTimers({ now: 100_000 }));
  afterEach(() => vi.useRealTimers());

  it('acknowledges agent interruption only after the native run abort completes', async () => {
    const { session, brain, relay, events } = setup();
    session.handleText(JSON.stringify({ type: 'listen.start' }));
    relay.last.events.onFinal?.('Do something');
    await settle();
    let acknowledge!: (value: { status: 'aborted'; runId: string }) => void;
    brain.interrupt.mockImplementationOnce(() => new Promise(resolve => { acknowledge = resolve; }));
    session.handleText(JSON.stringify({ type: 'agent.interrupt', requestId: 'request-1' }));
    await settle();
    expect(events).toContainEqual({ type: 'agent.interrupting', requestId: 'request-1' });
    expect(events.some(event => event.type === 'agent.interrupted')).toBe(false);
    acknowledge({ status: 'aborted', runId: 'run-1' });
    await settle();
    expect(events).toContainEqual({ type: 'agent.interrupted', requestId: 'request-1', status: 'aborted', runId: 'run-1' });
    expect(session.currentState).toBe('idle');
  });

  it('reports an unbound run as a failed interruption instead of claiming to stop it', async () => {
    const { session, events } = setup();
    session.handleText(JSON.stringify({ type: 'agent.interrupt', requestId: 'request-1' }));
    await settle();
    expect(events).toContainEqual(expect.objectContaining({ type: 'agent.interrupted', requestId: 'request-1', status: 'failed' }));
  });

  it('keeps native run control available after stopping only speech', async () => {
    const { session, brain, relay, events } = setup();
    session.handleText(JSON.stringify({ type: 'listen.start' }));
    relay.last.events.onFinal?.('Do something');
    await settle();
    session.handleText(JSON.stringify({ type: 'speak.cancel' }));
    expect(brain.interrupt).not.toHaveBeenCalled();
    session.handleText(JSON.stringify({ type: 'agent.interrupt', requestId: 'request-1' }));
    await settle();
    expect(brain.interrupt).toHaveBeenCalledOnce();
    expect(events).toContainEqual(expect.objectContaining({ type: 'agent.interrupted', status: 'aborted' }));
  });


  it("announces readiness with engines and resolved settings, then idles", () => {
    const { events, createBrain } = setup();
    expect(events[0]).toMatchObject({
      type: "session.ready",
      sessionId: "s1",
      engines: { stt: "fake-stt", tts: "fake-tts" },
      capabilities: { speed: true },
      settings: { speed: 0.9, handsFreeMs: 0, endpointing: "normal" },
    });
    expect(states(events)).toEqual(["idle"]);
    expect(createBrain).toHaveBeenCalledWith();
  });

  it("rejects malformed messages and refuses control before session.start", () => {
    const events: TalkServerEvent[] = [];
    const session = new TalkSession({
      send: (e) => events.push(e),
      sendAudio: () => undefined,
      relay: new FakeRelay(),
      createBrain: (() => new FakeBrain()) as never,
      vad: new FakeVad(),
      engines: { stt: "x", tts: "y" },
    });
    session.handleText("{nope");
    session.handleText(JSON.stringify({ type: "listen.start" }));
    expect(events.map((e) => (e as { code?: string }).code)).toEqual(["bad_message", "session_not_started"]);
  });

  it("runs a full converse turn: listen → endpoint → transcript → agent → sentence-pipelined speech → idle", async () => {
    const { session, events, audio, relay, brain, vad } = setup();
    session.handleText(JSON.stringify({ type: "listen.start" }));
    expect(states(events).at(-1)).toBe("listening");
    expect(events.find((e) => e.type === "listen.window")).toEqual({ type: "listen.window", ms: 20_000 });
    expect(relay.stts).toHaveLength(1);
    expect(vad.resets).toBe(1);

    vad.probs = [...Array<number>(10).fill(0.9), ...Array<number>(30).fill(0.02)];
    session.handleAudio(frameBuffer(10));
    await session.drainVad();
    expect(events).toContainEqual({ type: "vad", speaking: true });
    expect(relay.last.audio).toHaveLength(1);
    session.handleAudio(frameBuffer(30));
    await session.drainVad();
    expect(events).toContainEqual({ type: "vad", speaking: false });
    expect(relay.last.ended).toBe(true);
    expect(states(events).at(-1)).toBe("thinking");

    relay.last.events.onPartial?.("What's the wea");
    relay.last.events.onFinal?.("What's the weather today?");
    await settle();
    expect(events.find((e) => e.type === "transcript.delta")).toMatchObject({ text: "What's the wea" });
    expect(events.find((e) => e.type === "transcript.final")).toMatchObject({ text: "What's the weather today?", reason: "endpoint" });
    expect(brain.asks).toHaveLength(1);
    expect(brain.last).toMatchObject({ channelId: CHANNEL_ID, text: "What's the weather today?" });

    brain.last.handlers.onDelta("It's sunny and 72 degrees. ");
    await settle(40);
    expect(relay.ttsRequests.map((r) => r.text)).toEqual(["It's sunny and 72 degrees."]);
    brain.last.handlers.onDelta("Perfect for a walk, Mom!");
    await settle(40);
    expect(states(events)).toContain("speaking");
    expect(events.find((e) => e.type === "audio.start")).toMatchObject({ sampleRate: 24_000 });
    expect(audio.length).toBeGreaterThan(0);

    brain.last.handlers.onDone({ text: "It's sunny and 72 degrees. Perfect for a walk, Mom!", status: "complete", runId: "run-1" });
    await settle(60);
    expect(relay.ttsRequests.map((r) => r.text)).toEqual(["It's sunny and 72 degrees.", "Perfect for a walk, Mom!"]);
    expect(relay.ttsRequests[0]).toMatchObject({ speed: 0.9 });
    expect(audio).toHaveLength(4);
    expect(events.find((e) => e.type === "reply.final")).toMatchObject({ text: "It's sunny and 72 degrees. Perfect for a walk, Mom!" });
    expect(events.find((e) => e.type === "audio.end")).toMatchObject({ cancelled: false });
    expect(states(events).at(-1)).toBe("speaking");

    const turnId = (events.find((e) => e.type === "audio.end") as { turnId: string }).turnId;
    session.handleText(JSON.stringify({ type: "playback.done", turnId }));
    expect(states(events).at(-1)).toBe("idle");
    const metrics = events.find((e) => e.type === "metrics") as { metrics: { sttMs: number | null; firstAudioMs: number | null } };
    expect(metrics.metrics.sttMs).not.toBeNull();
    expect(metrics.metrics.firstAudioMs).not.toBeNull();
  });

  it("announces an engine without speed control and then never asks the relay for a speed", async () => {
    const { session, events, relay, brain, vad } = setup({ speedControl: false });
    expect(events[0]).toMatchObject({ type: "session.ready", capabilities: { speed: false } });
    session.handleText(JSON.stringify({ type: "listen.start" }));
    vad.probs = [...Array<number>(10).fill(0.9), ...Array<number>(30).fill(0.02)];
    session.handleAudio(frameBuffer(40));
    await session.drainVad();
    relay.last.events.onFinal?.("Slow down please");
    await settle();
    brain.last.handlers.onDelta("Of course, I will.");
    brain.last.handlers.onDone({ text: "Of course, I will.", status: "complete", runId: "r" });
    await settle(40);
    expect(relay.ttsRequests).toHaveLength(1);
    expect(relay.ttsRequests[0]).not.toHaveProperty("speed");
  });

  it("dictate mode delivers the transcript and returns to idle without asking the agent", async () => {
    const { session, events, relay, brain, vad } = setup({ mode: "dictate" });
    session.handleText(JSON.stringify({ type: "listen.start" }));
    vad.probs = [...Array<number>(10).fill(0.9), ...Array<number>(30).fill(0.02)];
    session.handleAudio(frameBuffer(40));
    await session.drainVad();
    relay.last.events.onFinal?.("Remind me to call Susan.");
    await settle();
    expect(events.find((e) => e.type === "transcript.final")).toMatchObject({ text: "Remind me to call Susan." });
    expect(brain.asks).toHaveLength(0);
    expect(states(events).at(-1)).toBe("idle");
  });

  it("hands-free: after speaking it listens again with the hands-free window, and idles when nobody speaks", async () => {
    const { session, events, relay, brain, vad } = setup({ handsFreeMs: 5_000 });
    session.handleText(JSON.stringify({ type: "listen.start" }));
    vad.probs = [...Array<number>(10).fill(0.9), ...Array<number>(30).fill(0.02)];
    session.handleAudio(frameBuffer(40));
    await session.drainVad();
    relay.last.events.onFinal?.("Hello");
    await settle();
    brain.last.handlers.onDelta("Hi there, how are you feeling today?");
    brain.last.handlers.onDone({ text: "Hi there, how are you feeling today?", status: "complete", runId: "r" });
    await settle(60);
    const turnId = (events.find((e) => e.type === "audio.end") as { turnId: string }).turnId;
    session.handleText(JSON.stringify({ type: "playback.done", turnId }));
    expect(states(events).at(-1)).toBe("listening");
    expect(relay.stts).toHaveLength(2);
    expect(events.filter((e) => e.type === "listen.window").at(-1)).toEqual({ type: "listen.window", ms: 5_000 });
    vi.advanceTimersByTime(5_001);
    expect(states(events).at(-1)).toBe("idle");
    expect(relay.last.aborted).toBe(true);
  });

  it("speak.cancel stops audio, cancels the agent turn, and returns to idle when not hands-free", async () => {
    const { session, events, relay, brain, vad } = setup();
    session.handleText(JSON.stringify({ type: "listen.start" }));
    vad.probs = [...Array<number>(10).fill(0.9), ...Array<number>(30).fill(0.02)];
    session.handleAudio(frameBuffer(40));
    await session.drainVad();
    relay.last.events.onFinal?.("Tell me a long story");
    await settle();
    relay.ttsChunksPerRequest = 3;
    brain.last.handlers.onDelta("Once upon a time there was a fox. ");
    await settle(20);
    expect(states(events)).toContain("speaking");
    session.handleText(JSON.stringify({ type: "speak.cancel" }));
    expect(brain.last.cancel).toHaveBeenCalled();
    expect(events.filter((e) => e.type === "audio.end").at(-1)).toMatchObject({ cancelled: true });
    expect(states(events).at(-1)).toBe("idle");
    await settle(40);
    expect(states(events).filter((s) => s === "idle")).toHaveLength(2);
  });

  it("speak.cancel while still thinking is not a failure: no error, and hands-free re-listens exactly once", async () => {
    const { session, events, relay, brain, vad } = setup({ handsFreeMs: 5_000 });
    session.handleText(JSON.stringify({ type: "listen.start" }));
    vad.probs = [...Array<number>(10).fill(0.9), ...Array<number>(30).fill(0.02)];
    session.handleAudio(frameBuffer(40));
    await session.drainVad();
    relay.last.events.onFinal?.("Tell me about my day");
    await settle();
    expect(brain.asks).toHaveLength(1);
    expect(states(events).at(-1)).toBe("thinking");
    const before = events.length;

    session.handleText(JSON.stringify({ type: "speak.cancel" }));
    expect(brain.last.cancel).toHaveBeenCalledTimes(1);
    const after = events.slice(before);
    expect(after.filter((e) => e.type === "error")).toEqual([]);
    expect(after.filter((e) => e.type === "state").map((e) => (e as { state: string }).state)).toEqual(["listening"]);
    expect(relay.stts).toHaveLength(2);
    await settle(20);
    expect(relay.stts).toHaveLength(2);
    expect(events.filter((e) => e.type === "reply.final")).toEqual([]);
  });

  it("a new utterance while the agent post is still in flight abandons that turn's reply instead of speaking it", async () => {
    const { session, events, relay, brain, vad } = setup();
    session.handleText(JSON.stringify({ type: "listen.start" }));
    vad.probs = [...Array<number>(10).fill(0.9), ...Array<number>(30).fill(0.02)];
    session.handleAudio(frameBuffer(40));
    await session.drainVad();
    brain.holdNext = true;
    relay.last.events.onFinal?.("First question");
    await settle();
    expect(brain.asks).toHaveLength(1);

    session.handleText(JSON.stringify({ type: "listen.start" }));
    expect(states(events).at(-1)).toBe("listening");
    brain.release?.({ id: "post-late" });
    await settle();
    expect(brain.asks[0].cancel).toHaveBeenCalledTimes(1);
    brain.asks[0].handlers.onDelta("Answer to the first question.");
    await settle(20);
    expect(relay.ttsRequests).toHaveLength(0);
    expect(events.filter((e) => e.type === "reply.delta")).toEqual([]);
  });

  it("speak.cancel while the transcript is still pending abandons it: nothing is asked when the final arrives", async () => {
    const { session, events, relay, brain, vad } = setup();
    session.handleText(JSON.stringify({ type: "listen.start" }));
    vad.probs = [...Array<number>(10).fill(0.9), ...Array<number>(30).fill(0.02)];
    session.handleAudio(frameBuffer(40));
    await session.drainVad();
    expect(states(events).at(-1)).toBe("thinking");
    session.handleText(JSON.stringify({ type: "speak.cancel" }));
    expect(states(events).at(-1)).toBe("idle");
    expect(relay.last.aborted).toBe(true);
    relay.last.events.onFinal?.("Late transcript");
    await settle();
    expect(brain.asks).toHaveLength(0);
    expect(events.filter((e) => e.type === "transcript.final")).toEqual([]);
  });

  it("a VAD failure mid-utterance ends the turn with a recoverable error instead of streaming forever", async () => {
    const { session, events, relay, vad } = setup();
    session.handleText(JSON.stringify({ type: "listen.start" }));
    vad.probs = Array<number>(10).fill(0.9);
    session.handleAudio(frameBuffer(10));
    await session.drainVad();
    expect(events).toContainEqual({ type: "vad", speaking: true });
    const resetsBefore = vad.resets;

    vad.failAfter = 2;
    session.handleAudio(frameBuffer(5));
    await session.drainVad();
    expect(events.at(-2)).toEqual({ type: "error", code: "vad_failed", message: expect.stringContaining("Tap to try again"), recoverable: true });
    expect(states(events).at(-1)).toBe("idle");
    expect(relay.last.aborted).toBe(true);
    expect(vad.resets).toBeGreaterThan(resetsBefore);
    expect(events).toContainEqual({ type: "vad", speaking: false });

    session.handleAudio(frameBuffer(5));
    await session.drainVad();
    expect(relay.last.audio).toHaveLength(2);
    session.handleText(JSON.stringify({ type: "listen.start" }));
    expect(states(events).at(-1)).toBe("listening");
    expect(relay.stts).toHaveLength(2);
  });

  it("turn.commit force-ends an utterance in progress and listen.stop abandons it", async () => {
    const { session, events, relay, vad } = setup();
    session.handleText(JSON.stringify({ type: "listen.start" }));
    vad.probs = Array<number>(10).fill(0.9);
    session.handleAudio(frameBuffer(10));
    await session.drainVad();
    session.handleText(JSON.stringify({ type: "turn.commit" }));
    expect(relay.last.ended).toBe(true);
    expect(states(events).at(-1)).toBe("thinking");

    session.handleText(JSON.stringify({ type: "listen.start" }));
    session.handleText(JSON.stringify({ type: "listen.stop" }));
    expect(relay.last.aborted).toBe(true);
    expect(states(events).at(-1)).toBe("idle");
  });

  it("surfaces STT, agent, TTS and timeout failures as recoverable errors and recovers to idle", async () => {
    const { session, events, relay, brain, vad } = setup();
    session.handleText(JSON.stringify({ type: "listen.start" }));
    relay.last.events.onError?.(new Error("relay down"));
    expect(events.at(-2)).toMatchObject({ type: "error", code: "stt_failed", recoverable: true });
    expect(states(events).at(-1)).toBe("idle");

    brain.failNext = true;
    session.handleText(JSON.stringify({ type: "listen.start" }));
    vad.probs = [...Array<number>(10).fill(0.9), ...Array<number>(30).fill(0.02)];
    session.handleAudio(frameBuffer(40));
    await session.drainVad();
    relay.last.events.onFinal?.("Hi");
    await settle();
    expect(events.at(-2)).toMatchObject({ type: "error", code: "brain_failed" });
    expect(states(events).at(-1)).toBe("idle");

    session.handleText(JSON.stringify({ type: "listen.start" }));
    vad.probs = [...Array<number>(10).fill(0.9), ...Array<number>(30).fill(0.02)];
    session.handleAudio(frameBuffer(40));
    await session.drainVad();
    relay.last.events.onFinal?.("Hi again");
    await settle();
    brain.last.handlers.onDone({ text: "", status: "timeout", runId: null });
    expect(events.at(-3)).toMatchObject({ type: "error", code: "reply_timeout" });
    expect(states(events).at(-1)).toBe("idle");

    relay.ttsFail = true;
    session.handleText(JSON.stringify({ type: "listen.start" }));
    vad.probs = [...Array<number>(10).fill(0.9), ...Array<number>(30).fill(0.02)];
    session.handleAudio(frameBuffer(40));
    await session.drainVad();
    relay.last.events.onFinal?.("Once more");
    await settle();
    brain.last.handlers.onDelta("A full sentence for you.");
    brain.last.handlers.onDone({ text: "A full sentence for you.", status: "complete", runId: "r" });
    await settle(60);
    expect(events).toContainEqual(expect.objectContaining({ type: "error", code: "tts_failed" }));
    expect(states(events).at(-1)).toBe("idle");
  });

  it("empty transcripts do not reach the agent; replay speaks the last reply again", async () => {
    const { session, events, relay, brain, vad } = setup();
    session.handleText(JSON.stringify({ type: "listen.start" }));
    vad.probs = [...Array<number>(10).fill(0.9), ...Array<number>(30).fill(0.02)];
    session.handleAudio(frameBuffer(40));
    await session.drainVad();
    relay.last.events.onFinal?.("   ");
    await settle();
    expect(brain.asks).toHaveLength(0);
    expect(states(events).at(-1)).toBe("idle");

    session.handleText(JSON.stringify({ type: "replay" }));
    expect(relay.ttsRequests).toHaveLength(0);

    session.handleText(JSON.stringify({ type: "listen.start" }));
    vad.probs = [...Array<number>(10).fill(0.9), ...Array<number>(30).fill(0.02)];
    session.handleAudio(frameBuffer(40));
    await session.drainVad();
    relay.last.events.onFinal?.("Say something");
    await settle();
    brain.last.handlers.onDelta("Something nice for you.");
    brain.last.handlers.onDone({ text: "Something nice for you.", status: "complete", runId: "r" });
    await settle(60);
    let turnId = (events.filter((e) => e.type === "audio.end").at(-1) as { turnId: string }).turnId;
    session.handleText(JSON.stringify({ type: "playback.done", turnId }));
    expect(states(events).at(-1)).toBe("idle");

    session.handleText(JSON.stringify({ type: "replay" }));
    await settle(60);
    expect(relay.ttsRequests.map((r) => r.text)).toEqual(["Something nice for you.", "Something nice for you."]);
    turnId = (events.filter((e) => e.type === "audio.end").at(-1) as { turnId: string }).turnId;
    session.handleText(JSON.stringify({ type: "playback.done", turnId }));
    expect(states(events).at(-1)).toBe("idle");
  });

  it("settings.update changes speed/endpointing for later turns and echoes the resolved settings", () => {
    const { session, events } = setup();
    session.handleText(JSON.stringify({ type: "settings.update", settings: { speed: 1.2, endpointing: "patient", handsFreeMs: 8_000 } }));
    expect(events.at(-1)).toEqual({
      type: "settings",
      settings: { voice: "", speed: 1.2, handsFreeMs: 8_000, endpointing: "patient" },
    });
  });

  it("close aborts everything and ignores further input", async () => {
    const { session, events, relay } = setup();
    session.handleText(JSON.stringify({ type: "listen.start" }));
    session.close();
    expect(relay.last.aborted).toBe(true);
    const count = events.length;
    session.handleText(JSON.stringify({ type: "listen.start" }));
    session.handleAudio(frameBuffer(1));
    expect(events).toHaveLength(count);
    expect(session.currentState).toBe("closed");
  });
});
