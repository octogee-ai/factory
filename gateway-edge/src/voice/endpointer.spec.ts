import { describe, expect, it } from "vitest";
import { ENDPOINTER_PROFILES, Endpointer, type EndpointerEvent } from "./endpointer.js";

const FRAME_MS = 32;

function run(ep: Endpointer, probs: number[], startMs = 0): EndpointerEvent[] {
  const events: EndpointerEvent[] = [];
  probs.forEach((p, i) => {
    const ev = ep.push(p, startMs + i * FRAME_MS);
    if (ev) events.push(ev);
  });
  return events;
}

const speech = (frames: number) => Array<number>(frames).fill(0.9);
const silence = (frames: number) => Array<number>(frames).fill(0.05);

describe("Endpointer", () => {
  it("opens an utterance after two consecutive speech frames and closes it after the silence window", () => {
    const ep = new Endpointer(ENDPOINTER_PROFILES.normal);
    const events = run(ep, [...silence(3), ...speech(20), ...silence(25)]);
    expect(events[0]).toEqual({ type: "speech.start", atMs: 4 * FRAME_MS });
    const end = events[1];
    expect(end.type).toBe("speech.end");
    if (end.type !== "speech.end") throw new Error("expected end");
    expect(end.reason).toBe("silence");
    expect(end.atMs - end.speechMs - 4 * FRAME_MS).toBeGreaterThanOrEqual(ENDPOINTER_PROFILES.normal.silenceMs);
    expect(end.atMs - end.speechMs - 4 * FRAME_MS).toBeLessThan(ENDPOINTER_PROFILES.normal.silenceMs + FRAME_MS);
    expect(ep.isSpeaking).toBe(false);
  });

  it("ignores a single spurious speech frame", () => {
    const ep = new Endpointer(ENDPOINTER_PROFILES.normal);
    expect(run(ep, [...silence(2), 0.9, ...silence(30)])).toEqual([]);
  });

  it("discards blips shorter than the minimum speech duration", () => {
    const ep = new Endpointer(ENDPOINTER_PROFILES.normal);
    const events = run(ep, [...speech(3), ...silence(30)]);
    expect(events.map((e) => e.type)).toEqual(["speech.start", "speech.discard"]);
  });

  it("holds an utterance open across short pauses below the silence window", () => {
    const ep = new Endpointer(ENDPOINTER_PROFILES.normal);
    const events = run(ep, [...speech(10), ...silence(10), ...speech(10), ...silence(30)]);
    expect(events.map((e) => e.type)).toEqual(["speech.start", "speech.end"]);
  });

  it("the patient profile waits longer before ending", () => {
    const normal = new Endpointer(ENDPOINTER_PROFILES.normal);
    const patient = new Endpointer(ENDPOINTER_PROFILES.patient);
    const probs = [...speech(10), ...silence(25)];
    expect(run(normal, probs).map((e) => e.type)).toEqual(["speech.start", "speech.end"]);
    expect(run(patient, probs).map((e) => e.type)).toEqual(["speech.start"]);
  });

  it("closes a monologue at the max duration", () => {
    const ep = new Endpointer({ ...ENDPOINTER_PROFILES.normal, maxSpeechMs: 1_000 });
    const events = run(ep, speech(60));
    expect(events.map((e) => e.type)).toEqual(["speech.start", "speech.end", "speech.start"]);
    expect((events[1] as { reason: string }).reason).toBe("max");
  });

  it("forceEnd closes only when speaking and reports voiced duration", () => {
    const ep = new Endpointer(ENDPOINTER_PROFILES.normal);
    expect(ep.forceEnd(10)).toBeNull();
    run(ep, speech(5));
    const ev = ep.forceEnd(1000);
    expect(ev?.type).toBe("speech.end");
    expect((ev as { speechMs: number }).speechMs).toBe(3 * FRAME_MS);
    expect(ep.isSpeaking).toBe(false);
  });
});
