import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { describe, expect, it, vi } from "vitest";
import { bridgeDesktopObserver, DesktopObserverTickets } from "./desktop-stream.js";

const session = { sessionId: "session-a", gatewayId: "walter", revisionId: "r1" };
const response = () => ({ type: "res", ok: true, payload: { transport: "rfb", wsPath: "/desktop/observe?token=upstream-token", expiresAtMs: 20_000, control: true } });

describe("desktop observer tickets", () => {
  it("rewrites the upstream URL into the gateway route and binds redemption to its session", () => {
    const tickets = new DesktopObserverTickets(() => 1_000);
    const frame = tickets.project(response(), session);
    const url = new URL((frame.payload as any).wsPath, "https://api.test");
    expect(url.pathname).toBe("/g/walter/openclaw/desktop/observe");
    expect(url.searchParams.get("token")).not.toBe("upstream-token");
    const token = url.searchParams.get("token")!;
    expect(tickets.redeem(token, { ...session, sessionId: "other" })).toBeNull();
    expect(tickets.redeem(token, { ...session, gatewayId: "other" })).toBeNull();
    expect(tickets.redeem(token, { ...session, revisionId: "r2" })).toBeNull();
    expect(tickets.redeem(token, session)).toBe("/desktop/observe?token=upstream-token");
    expect(tickets.redeem(token, session)).toBeNull();
  });
  it("expires unclaimed streams and refuses upstream URLs outside the observer endpoint", () => {
    let now = 1_000;
    const tickets = new DesktopObserverTickets(() => now);
    const frame = tickets.project(response(), session);
    const token = new URL((frame.payload as any).wsPath, "https://api.test").searchParams.get("token")!;
    now = 20_000;
    expect(tickets.redeem(token, session)).toBeNull();
    for (const wsPath of ["https://evil.test/desktop/observe?token=x", "/other?token=x", "/desktop/observe?token=x&extra=y"]) {
      expect(() => tickets.project({ ...response(), payload: { ...response().payload, wsPath } }, session)).toThrow();
    }
  });
});

describe("desktop observer transport", () => {
  it.each(["upstream", "browser"] as const)("preserves close codes and releases its lease when the %s closes", async (closingSide) => {
    const upstream = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    const edge = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await Promise.all([once(upstream, "listening"), once(edge, "listening")]);
    const release = vi.fn();
    const log = vi.fn();
    edge.on("connection", (browser) => bridgeDesktopObserver({
      browser, upstreamUrl: new URL(`ws://127.0.0.1:${(upstream.address() as AddressInfo).port}`),
      authorize: async () => true, touch: () => true, release, log, authorizationIntervalMs: 60_000,
    }));
    const connected = once(upstream, "connection");
    const browser = new WebSocket(`ws://127.0.0.1:${(edge.address() as AddressInfo).port}`);
    try {
      const [native] = await connected as [WebSocket];
      const sender = closingSide === "upstream" ? native : browser;
      const receiver = closingSide === "upstream" ? browser : native;
      const closed = once(receiver, "close");
      sender.close(4000, "control-taken");
      const [code, reason] = await closed;
      expect(code).toBe(4000);
      expect(reason.toString()).toBe("control-taken");
      await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
      expect(log).not.toHaveBeenCalled();
    } finally {
      browser.terminate();
      for (const server of [upstream, edge]) {
        for (const client of server.clients) client.terminate();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  });
});
