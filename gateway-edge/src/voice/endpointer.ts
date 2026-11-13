import type { TalkEndpointing } from "@octogee/shared/types/voice";

export interface EndpointerProfile {
  /** Speech probability at or above which a frame counts as speech. */
  startThreshold: number;
  /** Speech probability below which a frame counts as silence once speaking. */
  stopThreshold: number;
  /** Consecutive speech frames required to open an utterance. */
  startFrames: number;
  /** Trailing silence that closes an utterance. */
  silenceMs: number;
  /** Utterances shorter than this are noise, not turns. */
  minSpeechMs: number;
  /** Hard cap; a monologue longer than this is closed and transcribed. */
  maxSpeechMs: number;
}

export const ENDPOINTER_PROFILES: Record<TalkEndpointing, EndpointerProfile> = {
  normal: {
    startThreshold: 0.5,
    stopThreshold: 0.35,
    startFrames: 2,
    silenceMs: 650,
    minSpeechMs: 250,
    maxSpeechMs: 45_000,
  },
  patient: {
    startThreshold: 0.5,
    stopThreshold: 0.35,
    startFrames: 2,
    silenceMs: 1_100,
    minSpeechMs: 250,
    maxSpeechMs: 60_000,
  },
};

export type EndpointerEvent =
  | { type: "speech.start"; atMs: number }
  | { type: "speech.end"; atMs: number; speechMs: number; reason: "silence" | "max" }
  | { type: "speech.discard"; atMs: number; speechMs: number };

/**
 * Turns a stream of per-frame speech probabilities into utterance boundaries.
 * Pure and clock-free: callers pass the frame timestamp so tests are deterministic
 * and a slow VAD never skews the silence window.
 */
export class Endpointer {
  private speaking = false;
  private candidateFrames = 0;
  private speechStartMs = 0;
  private lastSpeechMs = 0;

  constructor(private profile: EndpointerProfile) {}

  setProfile(profile: EndpointerProfile): void {
    this.profile = profile;
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  reset(): void {
    this.speaking = false;
    this.candidateFrames = 0;
    this.speechStartMs = 0;
    this.lastSpeechMs = 0;
  }

  /** Feed one frame's speech probability; returns zero or one boundary event. */
  push(probability: number, atMs: number): EndpointerEvent | null {
    if (!this.speaking) {
      if (probability >= this.profile.startThreshold) {
        this.candidateFrames += 1;
        if (this.candidateFrames >= this.profile.startFrames) {
          this.speaking = true;
          this.speechStartMs = atMs;
          this.lastSpeechMs = atMs;
          this.candidateFrames = 0;
          return { type: "speech.start", atMs };
        }
      } else {
        this.candidateFrames = 0;
      }
      return null;
    }
    if (probability >= this.profile.stopThreshold) {
      this.lastSpeechMs = atMs;
    }
    const speechMs = atMs - this.speechStartMs;
    if (speechMs >= this.profile.maxSpeechMs) {
      this.speaking = false;
      return { type: "speech.end", atMs, speechMs, reason: "max" };
    }
    if (atMs - this.lastSpeechMs >= this.profile.silenceMs) {
      this.speaking = false;
      const voiced = this.lastSpeechMs - this.speechStartMs;
      if (voiced < this.profile.minSpeechMs) {
        return { type: "speech.discard", atMs, speechMs: voiced };
      }
      return { type: "speech.end", atMs, speechMs: voiced, reason: "silence" };
    }
    return null;
  }

  /** Close the current utterance now (user tapped "done"). */
  forceEnd(atMs: number): EndpointerEvent | null {
    if (!this.speaking) return null;
    this.speaking = false;
    const voiced = Math.max(0, this.lastSpeechMs - this.speechStartMs);
    return { type: "speech.end", atMs, speechMs: voiced, reason: "silence" };
  }
}
