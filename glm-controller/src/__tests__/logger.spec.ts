import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createLogger, formatLine, COWBOY } from "../lib/logger.js";

// `formatLine` is the pure formatter — colors disabled in tests so we
// match the exact text without ANSI noise. The `createLogger` cases below
// drive the full pipeline through console spies to confirm wiring.
const NO_COLOR = { color: false } as const;

describe("formatLine", () => {
  it("emits timestamp + level badge + cowboy badge + message", () => {
    const out = formatLine("info", "starting up", undefined, {
      ...NO_COLOR,
      now: () => new Date("2026-01-01T12:00:00.000Z"),
    });
    expect(out).toBe("2026-01-01T12:00:00.000Z  ℹ  🤠 cowboy  starting up");
  });

  it("warn level uses warn glyph", () => {
    const out = formatLine("warn", "drift detected", undefined, NO_COLOR);
    expect(out).toContain(" ⚠  🤠 cowboy  drift detected");
  });

  it("error level uses error glyph", () => {
    const out = formatLine("error", "boom", undefined, NO_COLOR);
    expect(out).toContain(" ✗  🤠 cowboy  boom");
  });

  it("scope renders between cowboy and message", () => {
    const out = formatLine(
      "info",
      "tick complete",
      { scope: "reconcile", emoji: "🔁" },
      NO_COLOR,
    );
    expect(out).toContain("🤠 cowboy  🔁 reconcile  tick complete");
  });

  it("scope without emoji falls back to bracketed tag", () => {
    const out = formatLine("info", "claim ok", { scope: "op" }, NO_COLOR);
    expect(out).toContain("🤠 cowboy  [op]  claim ok");
  });
});

describe("createLogger", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("info goes to console.log", () => {
    const log = createLogger({ color: false });
    log.info("hello");
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("warn goes to console.warn", () => {
    const log = createLogger({ color: false });
    log.warn("oops");
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("error goes to console.error", () => {
    const log = createLogger({ color: false });
    log.error("boom");
    expect(errSpy).toHaveBeenCalledTimes(1);
  });

  it("debug suppressed by default", () => {
    const log = createLogger({ color: false, debug: false });
    log.debug("noise");
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("debug enabled when configured", () => {
    const log = createLogger({ color: false, debug: true });
    log.debug("noise");
    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  it("child carries scope into all children", () => {
    const log = createLogger({ color: false }).child("reconcile", "🔁");
    log.info("tick");
    expect(logSpy.mock.calls[0]?.[0]).toContain("🔁 reconcile  tick");
  });

  it("legacy() routes warn lines (⚠ marker) to console.warn", () => {
    const log = createLogger({ color: false });
    log.legacy("[glm-controller] ⚠ reconcile tick failed: helm boom");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const out = warnSpy.mock.calls[0]?.[0] as string;
    // The legacy `[glm-controller]` prefix is stripped (the cowboy badge
    // already identifies the service); the ⚠ marker is consumed by the
    // level inference, not duplicated in the body.
    expect(out).not.toContain("[glm-controller]");
    expect(out).toContain(" ⚠  🤠 cowboy  reconcile tick failed: helm boom");
  });

  it("legacy() routes plain lines to console.log", () => {
    const log = createLogger({ color: false });
    log.legacy("[glm-controller] reconcile tick: no changes");
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
    const out = logSpy.mock.calls[0]?.[0] as string;
    expect(out).toContain(" ℹ  🤠 cowboy  reconcile tick: no changes");
  });

  it("legacy() preserves payload when no [glm-controller] prefix", () => {
    const log = createLogger({ color: false });
    log.legacy("[deprovision] step done ✅");
    const out = logSpy.mock.calls[0]?.[0] as string;
    expect(out).toContain("[deprovision] step done ✅");
  });

  it("legacy() routes [subsystem] ⚠ msg to warn while preserving the [subsystem] tag", () => {
    // Sub-systems like the reaper, helm-runner, deprovision use their
    // own prefix tag. The warn glyph appears AFTER the tag, not at the
    // start. Without this case, those messages would silently route
    // to info — losing the visual color cue and console.warn routing.
    const log = createLogger({ color: false });
    log.legacy("[reaper] ⚠ orphan heartbeat gw-zombie — deleting");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).not.toHaveBeenCalled();
    const out = warnSpy.mock.calls[0]?.[0] as string;
    expect(out).toContain(" ⚠  🤠 cowboy");
    // [reaper] tag should still be in the body so operators can still
    // tell which sub-system emitted the line.
    expect(out).toContain("[reaper]");
    expect(out).toContain("orphan heartbeat gw-zombie");
    // The warn glyph itself should not appear twice (once is via the
    // level badge, the legacy ⚠ marker should have been consumed).
    const warnGlyphCount = (out.match(/⚠/g) ?? []).length;
    expect(warnGlyphCount).toBe(1);
  });
});

describe("color rendering", () => {
  it("emits ANSI codes when color enabled", () => {
    const out = formatLine("warn", "drift", undefined, { color: true });
    // Yellow color code for warn level glyph.
    expect(out).toMatch(/\x1b\[33m/);
    expect(out).toMatch(/\x1b\[0m/);
  });

  it("emits NO ANSI codes when color disabled", () => {
    const out = formatLine("warn", "drift", undefined, { color: false });
    expect(out).not.toMatch(/\x1b\[/);
  });
});

describe("COWBOY constant", () => {
  it("is the literal cowboy emoji + name (so other modules can reference it)", () => {
    expect(COWBOY).toContain("🤠");
    expect(COWBOY).toContain("cowboy");
  });
});
