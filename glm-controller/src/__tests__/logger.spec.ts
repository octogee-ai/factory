import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createLogger, formatLine, COWBOY } from "../lib/logger.js";

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

const log = createLogger({ color: false });
    log.legacy("[reaper] ⚠ orphan heartbeat gw-zombie — deleting");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).not.toHaveBeenCalled();
    const out = warnSpy.mock.calls[0]?.[0] as string;
    expect(out).toContain(" ⚠  🤠 cowboy");

expect(out).toContain("[reaper]");
    expect(out).toContain("orphan heartbeat gw-zombie");

const warnGlyphCount = (out.match(/⚠/g) ?? []).length;
    expect(warnGlyphCount).toBe(1);
  });
});

describe("color rendering", () => {

const ESC_BRACKET = "\x1b[";

  it("emits ANSI codes when color enabled", () => {
    const out = formatLine("warn", "drift", undefined, { color: true });
    
    expect(out).toContain(`${ESC_BRACKET}33m`);
    expect(out).toContain(`${ESC_BRACKET}0m`);
  });

  it("emits NO ANSI codes when color disabled", () => {
    const out = formatLine("warn", "drift", undefined, { color: false });
    expect(out).not.toContain(ESC_BRACKET);
  });
});

describe("COWBOY constant", () => {
  it("is the literal cowboy emoji + name (so other modules can reference it)", () => {
    expect(COWBOY).toContain("🤠");
    expect(COWBOY).toContain("cowboy");
  });
});
