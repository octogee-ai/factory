import { describe, expect, it, vi } from "vitest";
import { applyCookiesOverCdp, compareStoredCookies, type CdpCookie, type CdpCookieTransport } from "./cdp-cookies.js";

const cookies: CdpCookie[] = [
  { name: "a", value: "1", domain: "example.com", path: "/", secure: true, httpOnly: false },
];

function fakeFetch(targets: unknown): typeof fetch {
  return vi.fn(async () => ({ ok: true, status: 200, json: async () => targets }) as unknown as Response) as unknown as typeof fetch;
}

function jarTransport(jar: unknown[], sent: Array<{ id: number; method: string; params?: unknown }> = []): CdpCookieTransport & { close: ReturnType<typeof vi.fn<() => void>> } {
  let handler: ((frame: Record<string, unknown>) => void) | undefined;
  return {
    send: (frame) => {
      sent.push(frame);
      const result = frame.method === "Network.getAllCookies" ? { cookies: jar } : {};
      setTimeout(() => handler?.({ id: frame.id, result }), 0);
    },
    onMessage: (next) => { handler = next; },
    close: vi.fn<() => void>(),
  };
}

describe("applyCookiesOverCdp", () => {
  it("sends Network.setCookies, reads the jar back, and counts only cookies Chromium actually stored", async () => {
    const sent: Array<{ id: number; method: string; params?: unknown }> = [];
    const requested: CdpCookie[] = [
      ...cookies,
      { name: "b", value: "2", domain: ".example.com", path: "/", secure: false, httpOnly: false },
      { name: "c", value: "3", domain: "example.com", path: "/app", secure: true, httpOnly: true },
    ];
    const transport = jarTransport([
      { name: "a", value: "1", domain: "example.com", path: "/", secure: true, httpOnly: false },
      { name: "b", value: "stale", domain: ".example.com", path: "/", secure: false, httpOnly: false },
    ], sent);
    const outcome = await applyCookiesOverCdp(requested, {
      cdpUrl: "http://127.0.0.1:9222",
      fetchImpl: fakeFetch([{ type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/1" }]),
      connect: async () => transport,
    });
    expect(outcome).toEqual({ stored: 1, dropped: [{ name: "b", domain: ".example.com" }, { name: "c", domain: "example.com" }] });
    expect(sent.map((frame) => frame.method)).toEqual(["Network.setCookies", "Network.getAllCookies"]);
    expect(sent[0]).toEqual({ id: 1, method: "Network.setCookies", params: { cookies: requested } });
    expect(transport.close).toHaveBeenCalled();
  });

  it("distinguishes stored siblings by source scheme, source port and partition ancestry", () => {
    const secure: CdpCookie = { name: "s", value: "new", domain: "example.com", path: "/", secure: true, httpOnly: false, sourceScheme: "Secure", sourcePort: 443 };
    expect(compareStoredCookies([secure], [{ name: "s", value: "new", domain: "example.com", path: "/", secure: true, httpOnly: false, sourceScheme: "NonSecure", sourcePort: 80 }]))
      .toEqual({ stored: 0, dropped: [{ name: "s", domain: "example.com" }] });
    expect(compareStoredCookies([secure], [
      { name: "s", value: "old", domain: "example.com", path: "/", secure: true, httpOnly: false, sourceScheme: "NonSecure", sourcePort: 80 },
      { name: "s", value: "new", domain: "example.com", path: "/", secure: true, httpOnly: false, sourceScheme: "Secure", sourcePort: 443 },
    ])).toEqual({ stored: 1, dropped: [] });
    const partitioned: CdpCookie = { name: "p", value: "1", domain: "embed.example", path: "/", secure: true, httpOnly: false, partitionKey: { topLevelSite: "https://top.example", hasCrossSiteAncestor: false } };
    expect(compareStoredCookies([partitioned], [{ name: "p", value: "1", domain: "embed.example", path: "/", secure: true, httpOnly: false, partitionKey: { topLevelSite: "https://top.example", hasCrossSiteAncestor: true } }]))
      .toEqual({ stored: 0, dropped: [{ name: "p", domain: "embed.example" }] });
    const unscoped: CdpCookie = { name: "u", value: "1", domain: "example.com", path: "/", secure: false, httpOnly: false };
    expect(compareStoredCookies([unscoped], [{ name: "u", value: "1", domain: "example.com", path: "/", secure: false, httpOnly: false, sourceScheme: "NonSecure", sourcePort: 80 }]))
      .toEqual({ stored: 1, dropped: [] });
  });

  it("counts a cookie as stored only when its secure, httpOnly and sameSite attributes survived", () => {
    const requested: CdpCookie = { name: "k", value: "v", domain: "example.com", path: "/", secure: false, httpOnly: true, sameSite: "Lax" };
    const exact = { name: "k", value: "v", domain: "example.com", path: "/", secure: false, httpOnly: true, sameSite: "Lax" };
    const dropped = { stored: 0, dropped: [{ name: "k", domain: "example.com" }] };
    expect(compareStoredCookies([requested], [{ ...exact, secure: true }])).toEqual(dropped);
    expect(compareStoredCookies([requested], [{ ...exact, httpOnly: false }])).toEqual(dropped);
    expect(compareStoredCookies([requested], [{ ...exact, sameSite: "None" }])).toEqual(dropped);
    expect(compareStoredCookies([requested], [{ ...exact, secure: true }, exact])).toEqual({ stored: 1, dropped: [] });
    const { sameSite: _unset, ...withoutSameSite } = requested;
    expect(compareStoredCookies([withoutSameSite], [{ ...exact, sameSite: "Lax" }])).toEqual({ stored: 1, dropped: [] });
  });

  it("matches a partitioned cookie only inside its own partition", async () => {
    const partitioned: CdpCookie = { name: "p", value: "1", domain: "embed.example", path: "/", secure: true, httpOnly: false, partitionKey: { topLevelSite: "https://top.example", hasCrossSiteAncestor: true } };
    const unpartitionedOnly = jarTransport([{ name: "p", value: "1", domain: "embed.example", path: "/", secure: true, httpOnly: false }]);
    const deps = { cdpUrl: "http://127.0.0.1:9222", fetchImpl: fakeFetch([{ type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/1" }]) };
    expect(await applyCookiesOverCdp([partitioned], { ...deps, connect: async () => unpartitionedOnly })).toEqual({ stored: 0, dropped: [{ name: "p", domain: "embed.example" }] });
    const inPartition = jarTransport([{ name: "p", value: "1", domain: "embed.example", path: "/", secure: true, httpOnly: false, partitionKey: { topLevelSite: "https://top.example", hasCrossSiteAncestor: true } }]);
    expect(await applyCookiesOverCdp([partitioned], { ...deps, connect: async () => inPartition })).toEqual({ stored: 1, dropped: [] });
  });

  it("rejects when CDP returns an error frame", async () => {
    const transport: CdpCookieTransport = {
      send: () => {},
      onMessage: (next) => setTimeout(() => next({ id: 1, error: { message: "bad cookie" } }), 0),
      close: vi.fn(),
    };
    await expect(applyCookiesOverCdp(cookies, {
      cdpUrl: "http://127.0.0.1:9222",
      fetchImpl: fakeFetch([{ type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/1" }]),
      connect: async () => transport,
    })).rejects.toThrow(/setCookies failed/u);
  });

  it("does nothing for an empty cookie list", async () => {
    const fetchImpl = fakeFetch([]);
    expect(await applyCookiesOverCdp([], { cdpUrl: "http://127.0.0.1:9222", fetchImpl })).toEqual({ stored: 0, dropped: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws when no page target is available", async () => {
    await expect(applyCookiesOverCdp(cookies, {
      cdpUrl: "http://127.0.0.1:9222",
      fetchImpl: fakeFetch([]),
      connect: async () => ({ send: () => {}, onMessage: () => {}, close: () => {} }),
    })).rejects.toThrow(/page target/u);
  });

  it("refuses a non-loopback CDP endpoint before contacting it", async () => {
    const fetchImpl = fakeFetch([]);
    await expect(applyCookiesOverCdp(cookies, { cdpUrl: "http://evil.example.com:9222", fetchImpl }))
      .rejects.toThrow(/loopback/u);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a non-loopback websocket target returned by CDP", async () => {
    await expect(applyCookiesOverCdp(cookies, {
      cdpUrl: "http://127.0.0.1:9222",
      fetchImpl: fakeFetch([{ type: "page", webSocketDebuggerUrl: "ws://evil.example.com:9222/devtools/page/1" }]),
      connect: async () => ({ send: () => {}, onMessage: () => {}, close: () => {} }),
    })).rejects.toThrow(/loopback/u);
  });

  it("accepts the [::1] IPv6 loopback endpoint", async () => {
    const transport = jarTransport([{ name: "a", value: "1", domain: "example.com", path: "/", secure: true, httpOnly: false }]);
    const outcome = await applyCookiesOverCdp(cookies, {
      cdpUrl: "http://[::1]:9222",
      fetchImpl: fakeFetch([{ type: "page", webSocketDebuggerUrl: "ws://[::1]:9222/devtools/page/1" }]),
      connect: async () => transport,
    });
    expect(outcome).toEqual({ stored: 1, dropped: [] });
  });
});
