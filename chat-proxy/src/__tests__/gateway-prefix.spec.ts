// Dual-mount URL-prefix stripping for the chat-proxy fleet routing.
//
// `chat-proxy-fleet-ingress` routes `/g/<gatewayId>/*` to the per-instance
// chat-proxy Service so a user lands in the right gateway's pod (where
// chat-proxy can bridge upstream same-pod to its own openclaw sidecar).
// Once the request arrives at the chat-proxy, the `/g/<gatewayId>` prefix
// is purely a routing artifact — the chat-proxy's own route matchers
// (`/api/openclaw/ws/<uuid>`, `/api/mattermost/...`, `/api/v4/...`, etc.)
// don't know about it. `stripGatewayPrefix` peels it off at the entry
// point so every downstream matcher works unchanged on both
// `/api/<p>` AND `/g/<gw>/api/<p>` (the gateway-edge dual-mount pattern,
// mirrored here).

import { describe, it, expect } from "vitest";
import { applyGatewayPrefixStripInPlace, stripGatewayPrefix } from "../gateway-prefix.js";

describe("stripGatewayPrefix", () => {
  it("returns the original path when no /g/ prefix is present", () => {
    expect(stripGatewayPrefix("/api/openclaw/ws/abc")).toBe("/api/openclaw/ws/abc");
    expect(stripGatewayPrefix("/healthz")).toBe("/healthz");
    expect(stripGatewayPrefix("/")).toBe("/");
    expect(stripGatewayPrefix("")).toBe("");
  });

  it("strips /g/<gatewayId> from the start, keeping the remainder", () => {
    expect(stripGatewayPrefix("/g/gw-bender/api/openclaw/ws/abc")).toBe("/api/openclaw/ws/abc");
    expect(stripGatewayPrefix("/g/default/api/v4/users/me")).toBe("/api/v4/users/me");
    expect(stripGatewayPrefix("/g/gw-prod/healthz")).toBe("/healthz");
  });

  it("accepts gatewayIds matching /^[a-z0-9][a-z0-9-]{0,62}$/ (same shape as resolveBridgeGatewayId, prevents ReDoS)", () => {
    expect(stripGatewayPrefix("/g/gw-customer-foo-bar/api/x")).toBe("/api/x");
    expect(stripGatewayPrefix("/g/gw-9/api/x")).toBe("/api/x");
    expect(stripGatewayPrefix("/g/default/api/x")).toBe("/api/x");
  });

  it("does NOT strip a malformed gatewayId (uppercase, leading hyphen, etc.) — falls through verbatim so downstream 404 sees the same input", () => {
    expect(stripGatewayPrefix("/g/UPPER-CASE/api/x")).toBe("/g/UPPER-CASE/api/x");
    expect(stripGatewayPrefix("/g/-leading-hyphen/api/x")).toBe("/g/-leading-hyphen/api/x");
    expect(stripGatewayPrefix("/g/has_underscore/api/x")).toBe("/g/has_underscore/api/x");
    // > 63 chars (1 + 62 + at-cap) is the upper bound; one over should not strip
    expect(stripGatewayPrefix("/g/" + "a".repeat(64) + "/api/x")).toBe(
      "/g/" + "a".repeat(64) + "/api/x",
    );
  });

  it("only strips /g/<gw> as a path segment — not /g/<gw>/ inside the middle of a path", () => {
    expect(stripGatewayPrefix("/api/g/gw-bender/something")).toBe("/api/g/gw-bender/something");
    expect(stripGatewayPrefix("/something/g/gw-x/api")).toBe("/something/g/gw-x/api");
  });

  it("requires at least one character after /g/ (so /g/ alone or trailing slash variants don't accidentally match)", () => {
    expect(stripGatewayPrefix("/g/")).toBe("/g/");
    expect(stripGatewayPrefix("/g")).toBe("/g");
  });

  it("returns '/' for both `/g/<gw>/` and `/g/<gw>` (bare prefix → root path so downstream matchers keep leading-slash invariant)", () => {
    expect(stripGatewayPrefix("/g/gw-bender/")).toBe("/");
    // No trailing slash. Previously returned "" which broke downstream
    // matchers that assume paths start with /. Now returns "/" for symmetry
    // with the trailing-slash form.
    expect(stripGatewayPrefix("/g/gw-bender")).toBe("/");
  });
});

describe("applyGatewayPrefixStripInPlace", () => {
  it("mutates req.url to the stripped path so downstream consumers (forwardMmRest, approvalCallbackHandler) see post-strip", () => {
    const req: { url?: string } = { url: "/g/gw-bender/api/v4/users/me" };
    const result = applyGatewayPrefixStripInPlace(req);
    expect(result).toBe("/api/v4/users/me");
    expect(req.url).toBe("/api/v4/users/me");
  });

  it("preserves query string when stripping", () => {
    const req: { url?: string } = { url: "/g/gw-bender/api/v4/users?since=123" };
    const result = applyGatewayPrefixStripInPlace(req);
    expect(result).toBe("/api/v4/users");
    expect(req.url).toBe("/api/v4/users?since=123");
  });

  it("leaves req.url unchanged when no /g/ prefix present", () => {
    const req: { url?: string } = { url: "/healthz" };
    const result = applyGatewayPrefixStripInPlace(req);
    expect(result).toBe("/healthz");
    expect(req.url).toBe("/healthz");
  });

  it("is idempotent — a second call on the same req is a no-op", () => {
    const req: { url?: string } = { url: "/g/gw-bender/api/v4/users" };
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
