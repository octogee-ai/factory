import { randomUUID } from "node:crypto";
import {
  TALK_CAPABILITIES_DEFAULT,
  TALK_INPUT_SAMPLE_RATE,
  TALK_OUTPUT_SAMPLE_RATE,
  TALK_PROTOCOL_VERSION,
  parseTalkClientMessage,
  resolveTalkSettings,
  type ResolvedTalkSettings,
  type TalkCapabilities,
  type TalkClientMessage,
  type TalkErrorCode,
  type TalkMode,
  type TalkServerEvent,
  type TalkSettings,
  type TalkState,
  type TalkTurnMetrics,
} from "@octogee/shared/types/voice";
import type { BrainReplyStatus, MattermostBrain } from "./brain.js";
import { ENDPOINTER_PROFILES, Endpointer } from "./endpointer.js";
import type { SttStream, VoiceRelayClient } from "./relay-client.js";
import { VadFramer, type SpeechProbabilityModel } from "./silero-vad.js";
import { SentenceChunker, prepareSpeechText } from "./speech-text.js";

export const TALK_TAP_LISTEN_IDLE_MS = 20_000;
export const TALK_PLAYBACK_DONE_GRACE_MS = 2_500;
export const TALK_TTS_PREFETCH = 2;
export const TALK_MAX_TRANSCRIPT_CHARS = 4_000;

const REPLY_FAILURE_MESSAGES: Record<Exclude<BrainReplyStatus, "complete">, string> = {
  timeout: "Octo did not answer in time",
  aborted: "Octo stopped before answering",
  error: "Octo's reply failed",
};

export interface TalkSessionDeps {
  sessionId?: string;
  send: (event: TalkServerEvent) => void;
  sendAudio: (pcm16le24k: Buffer) => void;
  relay: Pick<VoiceRelayClient, "openStt" | "tts">;
  createBrain: (mmToken: string) => MattermostBrain;
  vad: SpeechProbabilityModel;
  engines: { stt: string; tts: string };
  capabilities?: TalkCapabilities;
  now?: () => number;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

interface Turn {
  id: string;
  transcript: string;
  reply: string;
  audioBytesSent: number;
  endpointAt: number | null;
  finalAt: number | null;
  firstDeltaAt: number | null;
  firstAudioAt: number | null;
  /** Set when the user moved on (interrupt, new utterance, close): agent callbacks for this turn are ignored. */
  abandoned: boolean;
}

interface SentenceJob {
  text: string;
  chunks: Buffer[];
  started: boolean;
  done: boolean;
  error: Error | null;
  abort: AbortController;
}

/**
 * One Talk session = one client socket. Owns the listen → think → speak loop:
 * mic audio → VAD endpointing → streaming STT (relay) → Mattermost post → OpenClaw
 * assistant deltas → sentence-pipelined TTS (relay) → PCM back to the client.
 * All timing is injectable so the loop is unit-testable end to end.
 */
export class TalkSession {
  readonly sessionId: string;
  private readonly now: () => number;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;
  private readonly log: (message: string, fields?: Record<string, unknown>) => void;

  private state: TalkState | "closed" | "init" = "init";
  private mode: TalkMode = "converse";
  private channelId = "";
  private settings: ResolvedTalkSettings = resolveTalkSettings();
  private brain: MattermostBrain | null = null;

  private readonly framer = new VadFramer();
  private readonly endpointer = new Endpointer(ENDPOINTER_PROFILES.normal);
  private vadChain: Promise<void> = Promise.resolve();
  private samplesHeard = 0;
  private stt: SttStream | null = null;
  private listenIdleTimer: ReturnType<typeof setTimeout> | null = null;

  private turn: Turn | null = null;
  private brainTurn: { cancel(): void } | null = null;
  private replyDone = false;
  private chunker = new SentenceChunker();
  private speakQueue: SentenceJob[] = [];
  private speakerRunning = false;
  private speakerGeneration = 0;
  private audioStarted = false;
  private awaitingPlayback = false;
  private playbackGraceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastReplyText = "";

  private readonly capabilities: TalkCapabilities;

  constructor(private readonly deps: TalkSessionDeps) {
    this.sessionId = deps.sessionId ?? randomUUID();
    this.capabilities = deps.capabilities ?? TALK_CAPABILITIES_DEFAULT;
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimeoutImpl ?? setTimeout;
    this.clearTimer = deps.clearTimeoutImpl ?? clearTimeout;
    this.log = deps.log ?? (() => undefined);
  }

  get currentState(): TalkState | "closed" | "init" {
    return this.state;
  }

  private isClosed(): boolean {
    return this.state === "closed";
  }

  /** Resolves once every audio frame received so far has been scored by the VAD. */
  drainVad(): Promise<void> {
    return this.vadChain;
  }

  handleText(raw: string): void {
    if (this.state === "closed") return;
    const message = parseTalkClientMessage(raw);
    if (!message) {
      this.sendError("bad_message", "message not understood", true);
      return;
    }
    if (message.type === "session.start") {
      this.start(message);
      return;
    }
    if (this.state === "init") {
      this.sendError("session_not_started", "send session.start first", true);
      return;
    }
    this.dispatchControl(message);
  }

  private dispatchControl(message: Exclude<TalkClientMessage, { type: "session.start" }>): void {
    switch (message.type) {
      case "listen.start":
        this.startListening("tap");
        return;
      case "listen.stop":
        this.stopListening();
        this.setState("idle");
        return;
      case "turn.commit":
        this.commitTurn();
        return;
      case "speak.cancel":
        this.cancelSpeaking();
        return;
      case "playback.done":
        if (this.awaitingPlayback && this.turn?.id === message.turnId) this.finishSpeaking();
        return;
      case "replay":
        this.replay();
        return;
      case "settings.update":
        this.applySettings(message.settings);
        return;
      case "session.end":
        this.close();
        return;
      default:
        return;
    }
  }

  private applySettings(patch: TalkSettings): void {
    this.settings = resolveTalkSettings(this.settings, patch);
    this.endpointer.setProfile(ENDPOINTER_PROFILES[this.settings.endpointing]);
    this.deps.send({ type: "settings", settings: this.settings });
  }

  handleAudio(pcm16le16k: Buffer): void {
    if (this.state !== "listening" || !this.stt) return;
    this.stt.sendAudio(pcm16le16k);
    const frames = this.framer.push(pcm16le16k);
    for (const frame of frames) {
      const atMs = (this.samplesHeard / TALK_INPUT_SAMPLE_RATE) * 1000;
      this.samplesHeard += frame.length;
      this.vadChain = this.vadChain
        .then(() => this.deps.vad.process(frame))
        .then((probability) => this.onVadFrame(probability, atMs))
        .catch((err) => {
          this.log("talk vad failed", { error: err instanceof Error ? err.message : String(err) });
          if (this.state === "listening") this.failTurnInput("vad_failed", "I could not process the microphone audio. Tap to try again.");
        });
    }
  }

  close(): void {
    if (this.state === "closed") return;
    this.stopListening();
    this.abortSpeaking();
    this.abandonBrainTurn();
    this.brain?.dispose();
    this.state = "closed";
  }

  /** Detach the current agent turn: its callbacks are ignored from here on and its subscription is released. */
  private abandonBrainTurn(): void {
    if (this.turn) this.turn.abandoned = true;
    const handle = this.brainTurn;
    this.brainTurn = null;
    handle?.cancel();
  }

  /** Listening or the transcript could not be completed: back to idle with a recoverable error. */
  private failTurnInput(code: TalkErrorCode, message: string): void {
    this.stopListening();
    this.deps.vad.reset();
    this.sendError(code, message, true);
    this.setState("idle");
  }

  private start(message: Extract<TalkClientMessage, { type: "session.start" }>): void {
    if (this.state !== "init") {
      this.sendError("bad_message", "session already started", true);
      return;
    }
    this.mode = message.mode;
    this.channelId = message.channelId;
    this.settings = resolveTalkSettings(message.settings);
    this.endpointer.setProfile(ENDPOINTER_PROFILES[this.settings.endpointing]);
    this.brain = this.deps.createBrain(message.mmToken);
    this.deps.send({
      type: "session.ready",
      sessionId: this.sessionId,
      protocol: TALK_PROTOCOL_VERSION,
      input: { sampleRate: TALK_INPUT_SAMPLE_RATE },
      output: { sampleRate: TALK_OUTPUT_SAMPLE_RATE },
      engines: this.deps.engines,
      capabilities: this.capabilities,
      settings: this.settings,
    });
    this.setState("idle");
  }

  private setState(state: TalkState): void {
    if (this.state === "closed") return;
    this.state = state;
    this.deps.send({ type: "state", state, ...(this.turn ? { turnId: this.turn.id } : {}) });
  }

  private sendError(code: TalkErrorCode, message: string, recoverable: boolean): void {
    this.deps.send({ type: "error", code, message, recoverable });
  }

  private newTurn(): Turn {
    const turn: Turn = {
      id: randomUUID(),
      transcript: "",
      reply: "",
      audioBytesSent: 0,
      endpointAt: null,
      finalAt: null,
      firstDeltaAt: null,
      firstAudioAt: null,
      abandoned: false,
    };
    this.turn = turn;
    return turn;
  }

  private startListening(origin: "tap" | "auto"): void {
    if (this.state === "closed" || this.state === "init") return;
    if (this.state === "speaking") this.abortSpeaking();
    this.abandonBrainTurn();
    this.stopListening();
    const turn = this.newTurn();
    this.framer.reset();
    this.deps.vad.reset();
    this.endpointer.reset();
    this.samplesHeard = 0;
    const live = () => this.turn === turn && !turn.abandoned;
    this.stt = this.deps.relay.openStt({
      onPartial: (text) => {
        if (!live()) return;
        turn.transcript = text;
        this.deps.send({ type: "transcript.delta", turnId: turn.id, text });
      },
      onFinal: (text) => {
        if (!live()) return;
        this.onTranscriptFinal(turn, text);
      },
      onError: (error) => {
        if (!live()) return;
        this.log("talk stt failed", { error: error.message });
        this.failTurnInput("stt_failed", error.message);
      },
    });
    const idleMs = this.settings.handsFreeMs > 0 && origin === "auto" ? this.settings.handsFreeMs : TALK_TAP_LISTEN_IDLE_MS;
    this.listenIdleTimer = this.setTimer(() => {
      if (this.state !== "listening" || this.endpointer.isSpeaking) return;
      this.stopListening();
      this.setState("idle");
    }, idleMs);
    this.deps.send({ type: "listen.window", ms: idleMs });
    this.setState("listening");
  }

  private stopListening(): void {
    if (this.listenIdleTimer) {
      this.clearTimer(this.listenIdleTimer);
      this.listenIdleTimer = null;
    }
    if (this.stt) {
      this.stt.abort();
      this.stt = null;
    }
    if (this.endpointer.isSpeaking) this.deps.send({ type: "vad", speaking: false });
    this.endpointer.reset();
  }

  private onVadFrame(probability: number, atMs: number): void {
    if (this.state !== "listening") return;
    const event = this.endpointer.push(probability, atMs);
    if (!event) return;
    if (event.type === "speech.start") {
      if (this.listenIdleTimer) {
        this.clearTimer(this.listenIdleTimer);
        this.listenIdleTimer = null;
      }
      this.deps.send({ type: "vad", speaking: true });
      return;
    }
    if (event.type === "speech.discard") {
      this.deps.send({ type: "vad", speaking: false });
      this.armListenIdle();
      return;
    }
    this.deps.send({ type: "vad", speaking: false });
    this.endUtterance();
  }

  private armListenIdle(): void {
    if (this.listenIdleTimer) this.clearTimer(this.listenIdleTimer);
    this.listenIdleTimer = this.setTimer(() => {
      if (this.state !== "listening" || this.endpointer.isSpeaking) return;
      this.stopListening();
      this.setState("idle");
    }, TALK_TAP_LISTEN_IDLE_MS);
  }

  private commitTurn(): void {
    if (this.state !== "listening" || !this.stt) return;
    const atMs = (this.samplesHeard / TALK_INPUT_SAMPLE_RATE) * 1000;
    const forced = this.endpointer.forceEnd(atMs);
    if (!forced) return;
    this.deps.send({ type: "vad", speaking: false });
    this.endUtterance();
  }

  private endUtterance(): void {
    if (!this.turn || !this.stt) return;
    this.turn.endpointAt = this.now();
    if (this.listenIdleTimer) {
      this.clearTimer(this.listenIdleTimer);
      this.listenIdleTimer = null;
    }
    this.stt.end();
    this.setState("thinking");
  }

  private onTranscriptFinal(turn: Turn, rawText: string): void {
    this.stt = null;
    const text = rawText.trim().slice(0, TALK_MAX_TRANSCRIPT_CHARS);
    turn.transcript = text;
    turn.finalAt = this.now();
    this.deps.send({ type: "transcript.final", turnId: turn.id, text, reason: "endpoint" });
    if (!text) {
      this.afterTurn();
      return;
    }
    if (this.mode === "dictate") {
      this.setState("idle");
      return;
    }
    void this.runConverseTurn(turn, text);
  }

  private async runConverseTurn(turn: Turn, text: string): Promise<void> {
    if (!this.brain) {
      this.sendError("session_not_started", "session has no agent binding", false);
      return;
    }
    this.replyDone = false;
    this.chunker = new SentenceChunker();
    this.speakQueue = [];
    this.setState("thinking");
    const live = () => this.turn === turn && !turn.abandoned && !this.isClosed();
    let handle: { cancel(): void };
    try {
      handle = await this.brain.ask(
        { channelId: this.channelId, text, turnId: turn.id },
        {
          onDelta: (piece) => {
            if (!live()) return;
            if (turn.firstDeltaAt === null) turn.firstDeltaAt = this.now();
            turn.reply += piece;
            this.deps.send({ type: "reply.delta", turnId: turn.id, text: piece });
            for (const sentence of this.chunker.push(piece)) this.enqueueSentence(turn, sentence);
          },
          onDone: ({ text: replyText, status }) => {
            if (!live()) return;
            this.brainTurn = null;
            for (const sentence of this.chunker.flush()) this.enqueueSentence(turn, sentence);
            this.replyDone = true;
            this.notifySpeaker?.();
            this.deps.send({ type: "reply.final", turnId: turn.id, text: replyText });
            if (replyText.trim()) this.lastReplyText = replyText;
            this.onReplyDone(turn, status);
          },
        },
      );
    } catch (err) {
      if (!live()) return;
      this.log("talk brain post failed", { error: err instanceof Error ? err.message : String(err) });
      this.sendError("brain_failed", "could not send your message to Octo", true);
      this.setState("idle");
      return;
    }
    if (!live()) {
      handle.cancel();
      return;
    }
    this.brainTurn = handle;
  }

  private onReplyDone(turn: Turn, status: BrainReplyStatus): void {
    if (status !== "complete" && !turn.reply.trim()) {
      const code: TalkErrorCode = status === "timeout" ? "reply_timeout" : "brain_failed";
      this.sendError(code, REPLY_FAILURE_MESSAGES[status], true);
      this.afterTurn();
      return;
    }
    if (!this.speakerRunning && this.speakQueue.length === 0) {
      if (!this.audioStarted) {
        this.afterTurn();
      }
    }
  }

  private enqueueSentence(turn: Turn, sentence: string): void {
    const spoken = prepareSpeechText(sentence);
    if (!spoken) return;
    const job: SentenceJob = { text: spoken, chunks: [], started: false, done: false, error: null, abort: new AbortController() };
    this.speakQueue.push(job);
    this.prefetch(turn);
    if (!this.speakerRunning) void this.runSpeaker(turn);
  }

  private prefetch(turn: Turn): void {
    let inFlight = 0;
    for (const job of this.speakQueue) {
      if (job.done) continue;
      if (inFlight >= TALK_TTS_PREFETCH) break;
      inFlight += 1;
      if (job.started) continue;
      job.started = true;
      void this.synthesize(turn, job);
    }
  }

  private async synthesize(turn: Turn, job: SentenceJob): Promise<void> {
    try {
      const stream = this.deps.relay.tts({
        text: job.text,
        ...(this.settings.voice ? { voice: this.settings.voice } : {}),
        ...(this.capabilities.speed ? { speed: this.settings.speed } : {}),
        signal: job.abort.signal,
      });
      for await (const chunk of stream) {
        if (job.abort.signal.aborted) break;
        job.chunks.push(chunk);
        this.notifySpeaker?.();
      }
    } catch (err) {
      if (!job.abort.signal.aborted) job.error = err instanceof Error ? err : new Error(String(err));
    } finally {
      job.done = true;
      this.notifySpeaker?.();
      if (this.turn === turn) this.prefetch(turn);
    }
  }

  private notifySpeaker: (() => void) | null = null;

  private async runSpeaker(turn: Turn): Promise<void> {
    this.speakerRunning = true;
    const generation = this.speakerGeneration;
    const live = () => this.turn === turn && !this.isClosed() && this.speakerGeneration === generation;
    while (live()) {
      const job = this.speakQueue[0];
      if (!job) {
        if (this.replyDone) break;
        await this.waitSpeaker();
        continue;
      }
      await this.speakJob(turn, job, live);
      if (!live()) break;
      if (job.error) {
        this.log("talk tts failed", { error: job.error.message });
        this.sendError("tts_failed", "voice playback failed for part of the reply", true);
      }
      this.speakQueue.shift();
    }
    this.speakerRunning = false;
    if (live()) this.finishSpeakerRun(turn);
  }

  private async speakJob(turn: Turn, job: SentenceJob, live: () => boolean): Promise<void> {
    let sent = 0;
    while (live()) {
      while (sent < job.chunks.length) this.emitAudio(turn, job.chunks[sent++]);
      if (job.done) return;
      await this.waitSpeaker();
    }
  }

  private emitAudio(turn: Turn, chunk: Buffer): void {
    if (!this.audioStarted) {
      this.audioStarted = true;
      turn.firstAudioAt = this.now();
      this.setState("speaking");
      this.deps.send({ type: "audio.start", turnId: turn.id, sampleRate: TALK_OUTPUT_SAMPLE_RATE });
    }
    turn.audioBytesSent += chunk.length;
    this.deps.sendAudio(chunk);
  }

  private finishSpeakerRun(turn: Turn): void {
    if (this.audioStarted) {
      this.deps.send({ type: "audio.end", turnId: turn.id, cancelled: false });
      this.awaitingPlayback = true;
      const durationMs = (turn.audioBytesSent / 2 / TALK_OUTPUT_SAMPLE_RATE) * 1000;
      this.playbackGraceTimer = this.setTimer(() => this.finishSpeaking(), durationMs + TALK_PLAYBACK_DONE_GRACE_MS);
      return;
    }
    if (this.replyDone) this.afterTurn();
  }

  private waitSpeaker(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.notifySpeaker = () => {
        this.notifySpeaker = null;
        resolve();
      };
    });
  }

  private finishSpeaking(): void {
    if (!this.awaitingPlayback) return;
    this.awaitingPlayback = false;
    if (this.playbackGraceTimer) {
      this.clearTimer(this.playbackGraceTimer);
      this.playbackGraceTimer = null;
    }
    this.afterTurn();
  }

  private cancelSpeaking(): void {
    if (this.state !== "speaking" && this.state !== "thinking") return;
    const wasSpeaking = this.audioStarted;
    this.abandonBrainTurn();
    this.stopListening();
    this.abortSpeaking();
    if (wasSpeaking && this.turn) this.deps.send({ type: "audio.end", turnId: this.turn.id, cancelled: true });
    this.afterTurn();
  }

  private abortSpeaking(): void {
    this.speakerGeneration += 1;
    for (const job of this.speakQueue) job.abort.abort();
    this.speakQueue = [];
    this.replyDone = true;
    this.awaitingPlayback = false;
    if (this.playbackGraceTimer) {
      this.clearTimer(this.playbackGraceTimer);
      this.playbackGraceTimer = null;
    }
    this.notifySpeaker?.();
    this.audioStarted = false;
  }

  private afterTurn(): void {
    if (this.state === "closed") return;
    const turn = this.turn;
    if (turn) this.deps.send({ type: "metrics", metrics: this.metricsFor(turn) });
    this.audioStarted = false;
    this.awaitingPlayback = false;
    if (this.mode === "converse" && this.settings.handsFreeMs > 0) {
      this.startListening("auto");
      return;
    }
    this.setState("idle");
  }

  private replay(): void {
    if (!this.lastReplyText || (this.state !== "idle" && this.state !== "listening")) return;
    this.stopListening();
    const turn = this.newTurn();
    turn.finalAt = this.now();
    this.replyDone = false;
    this.speakQueue = [];
    this.setState("thinking");
    const chunker = new SentenceChunker();
    for (const sentence of [...chunker.push(this.lastReplyText), ...chunker.flush()]) this.enqueueSentence(turn, sentence);
    this.replyDone = true;
    this.notifySpeaker?.();
    if (this.speakQueue.length === 0 && !this.speakerRunning) this.afterTurn();
  }

  private metricsFor(turn: Turn): TalkTurnMetrics {
    const since = (from: number | null, to: number | null) => (from !== null && to !== null ? Math.max(0, to - from) : null);
    return {
      turnId: turn.id,
      sttMs: since(turn.endpointAt, turn.finalAt),
      firstReplyMs: since(turn.finalAt, turn.firstDeltaAt),
      firstAudioMs: since(turn.finalAt, turn.firstAudioAt),
      totalMs: since(turn.finalAt, this.now()),
    };
  }
}
