

import { describe, it, expect } from "vitest";
import { applyGatewayPrefixStripInPlace, stripGatewayPrefix } from "../gateway-prefix.js";

describe("stripGatewayPrefix", () => {
  it("returns the original path when no /api/g/ prefix is present", () => {
    expect(stripGatewayPrefix("/api/openclaw/ws/abc")).toBe("/api/openclaw/ws/abc");
    expect(stripGatewayPrefix("/healthz")).toBe("/healthz");
    expect(stripGatewayPrefix("/")).toBe("/");
    expect(stripGatewayPrefix("")).toBe("");
  });

  it("strips /api/g/<gatewayId> from the start, keeping the remainder", () => {
    expect(stripGatewayPrefix("/api/g/gw-bender/api/openclaw/ws/abc")).toBe("/api/openclaw/ws/abc");
    expect(stripGatewayPrefix("/api/g/default/api/v4/users/me")).toBe("/api/v4/users/me");
    expect(stripGatewayPrefix("/api/g/gw-prod/healthz")).toBe("/healthz");
  });

  it("accepts gatewayIds matching the shared rendered-resource-safe shape", () => {
    expect(stripGatewayPrefix("/api/g/gw-customer-foo-bar/api/x")).toBe("/api/x");
    expect(stripGatewayPrefix("/api/g/gw-9/api/x")).toBe("/api/x");
    expect(stripGatewayPrefix("/api/g/default/api/x")).toBe("/api/x");
  });

  it("does NOT strip a malformed gatewayId (uppercase, leading hyphen, etc.) — falls through verbatim so downstream 404 sees the same input", () => {
    expect(stripGatewayPrefix("/api/g/UPPER-CASE/api/x")).toBe("/api/g/UPPER-CASE/api/x");
    expect(stripGatewayPrefix("/api/g/-leading-hyphen/api/x")).toBe("/api/g/-leading-hyphen/api/x");
    expect(stripGatewayPrefix("/api/g/has_underscore/api/x")).toBe("/api/g/has_underscore/api/x");
    
    expect(stripGatewayPrefix("/api/g/trailing-hyphen-/api/x")).toBe("/api/g/trailing-hyphen-/api/x");
    expect(stripGatewayPrefix("/api/g/" + "a".repeat(33) + "/api/x")).toBe(
      "/api/g/" + "a".repeat(33) + "/api/x",
    );
  });

  it("only strips the internal /api/g/<gw> sidecar prefix — not public /g/<gw>/ or mid-path", () => {
    
    expect(stripGatewayPrefix("/g/gw-bender/api/x")).toBe("/g/gw-bender/api/x");
    expect(stripGatewayPrefix("/something/api/g/gw-x/api")).toBe("/something/api/g/gw-x/api");
  });

  it("requires at least one character after /api/g/ (so the bare prefix doesn't accidentally match)", () => {
    expect(stripGatewayPrefix("/api/g/")).toBe("/api/g/");
    expect(stripGatewayPrefix("/api/g")).toBe("/api/g");
  });

  it("returns '/' for both `/api/g/<gw>/` and `/api/g/<gw>` (bare prefix → root path so downstream matchers keep leading-slash invariant)", () => {
    expect(stripGatewayPrefix("/api/g/gw-bender/")).toBe("/");
    expect(stripGatewayPrefix("/api/g/gw-bender")).toBe("/");
  });
});

describe("applyGatewayPrefixStripInPlace", () => {
  it.each([
    ["strips the prefix for downstream consumers", "/api/g/gw-bender/api/v4/users/me", "/api/v4/users/me", "/api/v4/users/me"],
    ["preserves the query string in req.url", "/api/g/gw-bender/api/v4/users?since=123", "/api/v4/users", "/api/v4/users?since=123"],
    ["leaves an unprefixed URL unchanged", "/healthz", "/healthz", "/healthz"],
  ])("%s", (_, url, expectedResult, expectedUrl) => {
    const req: { url?: string } = { url };
    const result = applyGatewayPrefixStripInPlace(req);
    expect(result).toBe(expectedResult);
    expect(req.url).toBe(expectedUrl);
  });

  it("is idempotent — a second call on the same req is a no-op", () => {
    const req: { url?: string } = { url: "/api/g/gw-bender/api/v4/users" };
    applyGatewayPrefixStripInPlace(req);
    const second = applyGatewayPrefixStripInPlace(req);
    expect(second).toBe("/api/v4/users");
    expect(req.url).toBe("/api/v4/users");
  });

  it("handles missing req.url gracefully (defensive — req shape comes from the http server)", () => {
    const req: { url?: string } = {};
    const result = applyGatewayPrefixStripInPlace(req);
    expect(result).toBe("");
    expect(req.url).toBeUndefined();
  });
});
