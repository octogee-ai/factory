import { describe, expect, it, vi } from "vitest";
import { loadOpenClawProfileAppearance } from "./profile-appearance.js";

vi.mock("../lib/db.js", () => { throw new Error("Gateway profile reads must not use Google ADC"); });
const session = { uid: "uid-A", gatewayId: "bender", revisionId: "bender", sessionId: "opaque-session", brokerProfile: "native-owner" as const };
const env = { OPENCLAW_CONTROL_BROKER_URL: "https://broker.test" };

describe("Gateway profile broker client", () => {
  it("uses the authenticated broker session and receives profile bytes without Google credentials", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ displayName: "Chris", avatar: { revision: "one", avatarBase64: Buffer.from("jpeg").toString("base64") } })));
    const result = await loadOpenClawProfileAppearance(session, env, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith("https://broker.test/internal/openclaw-control/profile", expect.objectContaining({
      method: "POST", body: JSON.stringify({ gatewayId: "bender", revisionId: "bender", sessionId: "opaque-session" }), signal: expect.any(AbortSignal),
    }));
    expect(result.displayName).toBe("Chris");
    expect(result.avatar!.revision).toBe("one");
    expect(await result.avatar!.read()).toEqual(Buffer.from("jpeg"));
  });
  it("preserves an absent name and avatar", async () => {
    expect(await loadOpenClawProfileAppearance(session, env, async () => new Response(JSON.stringify({ displayName: null, avatar: null })))).toEqual({ displayName: null, avatar: null });
  });
  it.each([403, 404, 409, 500])("reports broker status %s", async (status) => {
    await expect(loadOpenClawProfileAppearance(session, env, async () => new Response(null, { status }))).rejects.toThrow(String(status));
  });
  it.each([
    {}, { displayName: 12, avatar: null }, { displayName: null, avatar: {} },
    { displayName: null, avatar: { revision: "one", avatarBase64: "invalid!" } },
    { displayName: null, avatar: { revision: "one", avatarBase64: "a".repeat(700_000) } },
  ])("rejects malformed broker appearance %#", async (body) => {
    await expect(loadOpenClawProfileAppearance(session, env, async () => new Response(JSON.stringify(body)))).rejects.toThrow("Invalid profile broker response");
  });
});
