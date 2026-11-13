import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function capture() {
  const lines: string[] = [];
  for (const level of ["log", "warn", "error"] as const) vi.spyOn(console, level).mockImplementation(line => { lines.push(String(line)); });
  return lines;
}

describe("provisioner log levels", () => {
  it("emits migration failures as ERROR and diagnostics as DEBUG", async () => {
    const { log, dlog } = await import("./config.js");
    vi.stubEnv("LOG_LEVEL", "debug");
    const lines = capture();
    log("Unmount failed", { status: "failed", builderSlug: "alice" });
    dlog("No changes");
    expect(lines.map(line => JSON.parse(line).severity)).toEqual(["ERROR", "DEBUG"]);
  });
});
