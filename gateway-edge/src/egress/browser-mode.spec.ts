import { describe, expect, it, vi } from "vitest";
import type { GatewayEgressMode } from "@octogee/shared/types/glm";
import { controlApiModePoster, createBrowserModeSync } from "./browser-mode.js";

function harness() {
  const posts: Array<{ mode: GatewayEgressMode; resolve: () => void; reject: (error: Error) => void }> = [];
  const timers: Array<{ callback: () => void; delayMs: number; cleared: boolean }> = [];
  const log = vi.fn();
  const sync = createBrowserModeSync({
    post: (mode) => new Promise<void>((resolve, reject) => { posts.push({ mode, resolve, reject }); }),
    logger: { warn: log, error: log },
    retryDelaysMs: [10, 20],
    setTimer: (callback, delayMs) => { const timer = { callback, delayMs, cleared: false }; timers.push(timer); return timer; },
    clearTimer: (handle) => { (handle as { cleared: boolean }).cleared = true; },
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return { sync, posts, timers, log, settle };
}

describe("browser egress mode sync", () => {
  it("tells the VM each mode once, and only the latest of several requested while one is in flight", async () => {
    const h = harness();
    h.sync.apply("desktop");
    expect(h.posts.map((post) => post.mode)).toEqual(["desktop"]);
    h.sync.apply("cloud");
    h.sync.apply("desktop");
    h.sync.apply("cloud");
    expect(h.posts).toHaveLength(1);
    h.posts[0]!.resolve();
    await h.settle();
    expect(h.posts.map((post) => post.mode)).toEqual(["desktop", "cloud"]);
    h.posts[1]!.resolve();
    await h.settle();
    expect(h.posts).toHaveLength(2);
  });

  it("retries a failed delivery with capped backoff until the VM acknowledges the latest mode", async () => {
    const h = harness();
    h.sync.apply("desktop");
    h.posts[0]!.reject(new Error("connect ECONNREFUSED 127.0.0.1:7777"));
    await h.settle();
    expect(h.timers.map((timer) => timer.delayMs)).toEqual([10]);
    expect(h.log).toHaveBeenCalledWith("computer browser did not take the egress mode; retrying", expect.objectContaining({ mode: "desktop", retryInMs: 10, error: "connect ECONNREFUSED 127.0.0.1:7777" }));
    h.timers[0]!.callback();
    h.posts[1]!.reject(new Error("still starting"));
    await h.settle();
    h.timers[1]!.callback();
    h.posts[2]!.reject(new Error("still starting"));
    await h.settle();
    expect(h.timers.map((timer) => timer.delayMs)).toEqual([10, 20, 20]);
    h.timers[2]!.callback();
    expect(h.posts.at(-1)!.mode).toBe("desktop");
    h.posts.at(-1)!.resolve();
    await h.settle();
    expect(h.timers).toHaveLength(3);
  });

  it("sends a superseding mode straight away instead of waiting out the backoff of the failed one", async () => {
    const h = harness();
    h.sync.apply("desktop");
    h.posts[0]!.reject(new Error("connect ECONNREFUSED 127.0.0.1:7777"));
    await h.settle();
    expect(h.timers).toHaveLength(1);
    h.sync.apply("desktop");
    expect(h.posts).toHaveLength(1);
    h.sync.apply("cloud");
    expect(h.timers[0]!.cleared).toBe(true);
    expect(h.posts.map((post) => post.mode)).toEqual(["desktop", "cloud"]);
  });

  it("starts a superseding mode's retries from the shortest delay, not the failed mode's capped one", async () => {
    const h = harness();
    h.sync.apply("desktop");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      h.posts.at(-1)!.reject(new Error("still starting"));
      await h.settle();
      if (attempt < 2) h.timers.at(-1)!.callback();
    }
    expect(h.timers.at(-1)!.delayMs).toBe(20);
    h.sync.apply("cloud");
    h.posts.at(-1)!.reject(new Error("still starting"));
    await h.settle();
    expect(h.timers.at(-1)!.delayMs).toBe(10);
  });

  it("sends the newer mode at once when the request it superseded fails in flight", async () => {
    const h = harness();
    h.sync.apply("desktop");
    h.sync.apply("cloud");
    h.posts[0]!.reject(new Error("socket hang up"));
    await h.settle();
    expect(h.timers).toHaveLength(0);
    expect(h.posts.map((post) => post.mode)).toEqual(["desktop", "cloud"]);
  });

  it("posts the mode to the desktop control API and surfaces a refusal", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ mode: "desktop", restarted: true }), { status: 200 }));
    await controlApiModePoster("http://127.0.0.1:7777", fetchImpl as unknown as typeof fetch)("desktop");
    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:7777/egress", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ mode: "desktop" }),
      headers: { "content-type": "application/json", "x-octogee-egress-control": "1" },
    }));
    const refusing = vi.fn(async () => new Response(JSON.stringify({ error: "the desktop supervisor is unknown" }), { status: 500 }));
    await expect(controlApiModePoster("http://127.0.0.1:7777", refusing as unknown as typeof fetch)("cloud")).rejects.toThrow("desktop control answered 500: {\"error\":\"the desktop supervisor is unknown\"}");
  });

  it("stops retrying, with one error, when the VM's desktop image predates mode switching", async () => {
    const log = vi.fn();
    const timers: Array<() => void> = [];
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: "not found" }), { status: 404 }));
    const sync = createBrowserModeSync({ post: controlApiModePoster("http://127.0.0.1:7777", fetchImpl as unknown as typeof fetch), logger: { warn: log, error: log }, setTimer: (callback) => { timers.push(callback); return callback; }, clearTimer: () => {} });
    sync.apply("desktop");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(timers).toHaveLength(0);
    expect(log).toHaveBeenCalledWith("computer browser cannot follow the egress mode on this desktop image", expect.objectContaining({ mode: "desktop" }));
    sync.apply("cloud");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
