import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

const fetchSpy = vi.fn();
beforeEach(() => {
  fetchSpy.mockReset();
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => vi.unstubAllGlobals());

import { probeProviderKey } from "../billing/provider-probe.js";

function jsonResponse(status = 200, body: any = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("probeProviderKey routing", () => {
  test("anthropic → POST https://api.anthropic.com/v1/messages with x-api-key", async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, { id: "msg_1" }));
    const r = await probeProviderKey({ provider: "anthropic", apiKey: "sk-ant-xxx" });
    expect(r.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.method).toBe("POST");
    expect(init.headers["x-api-key"]).toBe("sk-ant-xxx");
  });

  test("openai → GET https://api.openai.com/v1/models with Bearer auth (no token cost)", async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, { data: [] }));
    const r = await probeProviderKey({ provider: "openai", apiKey: "sk-foobarbarbarbarbarbarbarbarbarbar" });
    expect(r.ok).toBe(true);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/models");
    expect(init.method).toBe("GET");
    expect(init.headers["authorization"] || init.headers.Authorization).toBe(
      "Bearer sk-foobarbarbarbarbarbarbarbarbarbar",
    );
  });

  test("openai-compatible → GET {baseUrl}/models with Bearer auth", async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, { data: [{ id: "anthropic/claude-3.5-sonnet" }] }));
    const r = await probeProviderKey({
      provider: "openai-compatible",
      apiKey: "sk-or-v1-abc",
      baseUrl: "https://openrouter.ai/api/v1",
    });
    expect(r.ok).toBe(true);
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/models");
  });

  test("openai-compatible respects a baseUrl that already ends in /", async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, { data: [] }));
    await probeProviderKey({
      provider: "openai-compatible",
      apiKey: "x",
      baseUrl: "https://openrouter.ai/api/v1/",
    });
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/models");
  });

  test("openai-compatible without baseUrl returns user-fault probe failure", async () => {
    const r = await probeProviderKey({
      provider: "openai-compatible",
      apiKey: "x",
    });
    expect(r.ok).toBe(false);
    expect(r.classification).toBe("user");
    expect(r.error).toMatch(/baseUrl/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("classifies 401 as user", async () => {
    fetchSpy.mockResolvedValue(jsonResponse(401, { error: { type: "authentication_error" } }));
    const r = await probeProviderKey({ provider: "openai", apiKey: "sk-bad" });
    expect(r.ok).toBe(false);
    expect(r.classification).toBe("user");
    expect(r.httpStatus).toBe(401);
  });

  test("classifies 429 as transient", async () => {
    fetchSpy.mockResolvedValue(jsonResponse(429, { error: { type: "rate_limit_error" } }));
    const r = await probeProviderKey({ provider: "openai", apiKey: "sk-foobarbarbarbarbarbarbarbarbarbar" });
    expect(r.ok).toBe(false);
    expect(r.classification).toBe("transient");
  });

  test("network error classifies as transient", async () => {
    fetchSpy.mockRejectedValue(new Error("ECONNRESET"));
    const r = await probeProviderKey({ provider: "openai", apiKey: "sk-foobarbarbarbarbarbarbarbarbarbar" });
    expect(r.ok).toBe(false);
    expect(r.classification).toBe("transient");
  });
});
