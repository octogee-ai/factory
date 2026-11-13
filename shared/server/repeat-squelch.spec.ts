import { describe, expect, it } from "vitest";
import { createRepeatSquelch } from "./repeat-squelch.js";

function squelch() {
  const clock = { now: 0 };
  return { clock, repeats: createRepeatSquelch({ windowMs: 60_000, now: () => clock.now }) };
}

describe("repeat squelch", () => {
  it("admits the first occurrence and holds back repeats inside the window", () => {
    const { repeats } = squelch();
    expect(repeats.admit("a", "down")).toEqual({ suppressed: 0, note: "" });
    expect(repeats.admit("a", "down")).toBeNull();
  });

  it("admits again after the window and says how many were held back", () => {
    const { clock, repeats } = squelch();
    repeats.admit("a", "down");
    repeats.admit("a", "down");
    repeats.admit("a", "down");
    clock.now = 60_000;
    expect(repeats.admit("a", "down")).toEqual({ suppressed: 2, note: " (2 repeats suppressed)" });
    expect(repeats.admit("a", "down")).toBeNull();
  });

  it("admits immediately when the value changes", () => {
    const { repeats } = squelch();
    repeats.admit("a", "down");
    repeats.admit("a", "down");
    expect(repeats.admit("a", "timeout")).toEqual({ suppressed: 1, note: " (1 repeat suppressed)" });
  });

  it("tracks keys independently", () => {
    const { repeats } = squelch();
    repeats.admit("a", "down");
    expect(repeats.admit("b", "down")).not.toBeNull();
  });

  it("reports what settled and starts fresh afterwards", () => {
    const { repeats } = squelch();
    expect(repeats.settle("a")).toBeNull();
    repeats.admit("a", "down");
    repeats.admit("a", "down");
    expect(repeats.settle("a")).toEqual({ suppressed: 1, note: " (1 repeat suppressed)" });
    expect(repeats.settle("a")).toBeNull();
    expect(repeats.admit("a", "down")).not.toBeNull();
  });

  it("forgets the oldest key rather than growing without limit", () => {
    const { repeats } = squelch();
    for (let index = 0; index <= 4096; index += 1) repeats.admit(`k${index}`);
    expect(repeats.admit("k0")).not.toBeNull();
    expect(repeats.admit("k4096")).toBeNull();
  });
});
