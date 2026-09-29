import { once } from "node:events";
import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

const cleanups: Array<() => Promise<void> | void> = [];
const previous = {
  gatewayToken: process.env.OPENCLAW_GATEWAY_TOKEN,
  brokerUrl: process.env.OPENCLAW_RUNTIME_BROKER_URL,
  gatewayId: process.env.GATEWAY_ID,
};

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const [name, value] of Object.entries({
    OPENCLAW_GATEWAY_TOKEN: previous.gatewayToken,
    OPENCLAW_RUNTIME_BROKER_URL: previous.brokerUrl,
    GATEWAY_ID: previous.gatewayId,
  })) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  vi.resetModules();
});

async function startServer() {
  process.env.OPENCLAW_GATEWAY_TOKEN = "gateway-token";
  process.env.OPENCLAW_RUNTIME_BROKER_URL = "http://127.0.0.1:3001";
  process.env.GATEWAY_ID = "gateway-1";
  vi.resetModules();
  const { chatProxyHandleRequest } = await import("../proxy.js");
  const server = http.createServer((req, res) => {
    void chatProxyHandleRequest(req, res);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

describe("chat proxy Activity intake route", () => {
  it.each([
    ["/internal/openclaw/activity/v1/events", { error: "unauthorized", retryable: false }],
    ["/internal/openclaw/notifications/v1/final-reply", { error: "unauthorized" }],
  ])("installs %s and rejects an unauthenticated request before parsing", async (path, error) => {
    const base = await startServer();
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual(error);
  });
});
