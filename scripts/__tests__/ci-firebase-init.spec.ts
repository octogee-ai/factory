import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFirebaseInit } from "../ci/firebase-init.mjs";

const origin = "https://octogee-test.web.app";
let fetchMock: ReturnType<typeof vi.fn>;
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("survives the 502s a fresh Hosting deploy answers for a few seconds", async () => {
  fetchMock
    .mockResolvedValueOnce(new Response("bad gateway", { status: 502 }))
    .mockResolvedValueOnce(new Response("bad gateway", { status: 502 }))
    .mockResolvedValueOnce(Response.json({ projectId: "octogee-test", apiKey: "public-key" }));
  const config = readFirebaseInit(origin);
  await vi.runAllTimersAsync();
  await expect(config).resolves.toEqual({ projectId: "octogee-test", apiKey: "public-key" });
  expect(fetchMock).toHaveBeenCalledWith(`${origin}/__/firebase/init.json`, undefined);
  expect(warn).toHaveBeenCalledTimes(2);
  expect(String(warn.mock.calls[1][0])).toMatch(/attempt 2 of 6 failed \(HTTP 502\)/);
});

it("names the status when the configuration stays unavailable", async () => {
  fetchMock.mockImplementation(async () => new Response("unavailable", { status: 503 }));
  const config = readFirebaseInit(origin).catch(error => error);
  await vi.runAllTimersAsync();
  expect((await config).message).toBe(`Firebase configuration ${origin}/__/firebase/init.json: HTTP 503`);
  expect(fetchMock).toHaveBeenCalledTimes(6);
});

it("does not retry a missing configuration", async () => {
  fetchMock.mockResolvedValue(new Response("missing", { status: 404 }));
  await expect(readFirebaseInit(origin)).rejects.toThrow("HTTP 404");
  expect(fetchMock).toHaveBeenCalledOnce();
});
