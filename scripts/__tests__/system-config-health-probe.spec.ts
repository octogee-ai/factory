import { afterEach, expect, it, vi } from "vitest";
import { probeOpenClawHealth } from "../lib/system-config-runtime-health.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([503, 502])("records HTTP %s separately from a health timeout", async (status) => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status })));
  expect(await probeOpenClawHealth()).toBe(false);
  expect(log).toHaveBeenCalledWith("[openclaw-health] probe failed", {
    failure: "http-error", status, durationMs: expect.any(Number),
  });
});

it("records an aborted health probe as a timeout without logging its URL", async () => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
  })));
  expect(await probeOpenClawHealth("http://127.0.0.1/healthz?private=value", 1)).toBe(false);
  expect(log).toHaveBeenCalledWith("[openclaw-health] probe failed", {
    failure: "timeout", durationMs: expect.any(Number),
  });
  expect(JSON.stringify(log.mock.calls)).not.toContain("private");
});

it("distinguishes a failed connection and stays quiet on success", async () => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new TypeError("fetch failed"))
    .mockResolvedValueOnce(new Response(null, { status: 200 })));
  expect(await probeOpenClawHealth()).toBe(false);
  expect(log).toHaveBeenCalledWith("[openclaw-health] probe failed", {
    failure: "request-failed", durationMs: expect.any(Number),
  });
  expect(await probeOpenClawHealth()).toBe(true);
  expect(log).toHaveBeenCalledOnce();
});
