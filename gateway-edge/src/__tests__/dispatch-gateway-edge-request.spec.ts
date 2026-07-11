import { describe, it, expect, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";

import { dispatchGatewayEdgeRequest } from "../index.js";
import { chatProxyHandleRequest } from "../chat-proxy/proxy.js";

function mockReq(url: string, method = "GET"): IncomingMessage {
  return { url, method, headers: {}, resume: vi.fn() } as unknown as IncomingMessage;
}

function mockRes(): ServerResponse {
  return {
    headersSent: false,
    setHeader: vi.fn(),
    writeHead: vi.fn(),
    end: vi.fn(),
  } as unknown as ServerResponse;
}

describe("dispatchGatewayEdgeRequest — fleet-prefix raw-passthrough seam", () => {
  it("hands a non-chat-proxy scoped path to the app with req.url UNCHANGED — fleet prefix intact, no blanket strip", () => {
    const app = vi.fn();
    const url = "/api/g/gw-bender/internal/builder-shell/kill";
    const req = mockReq(url, "POST");
    const res = mockRes();

    dispatchGatewayEdgeRequest(req, res, app);

    expect(app).toHaveBeenCalledTimes(1);
    expect(app).toHaveBeenCalledWith(req, res);
    expect(req.url).toBe(url);
  });

  it.each(["/healthz", "/healthz/bridge", "/internal/openclaw/agent-control/callback"])(
    "routes chat-proxy-owned path %s to the chat proxy, never the app",
    (path) => {
      const app = vi.fn();
      const req = mockReq(path);
      const res = mockRes();

      dispatchGatewayEdgeRequest(req, res, app);

      expect(app).not.toHaveBeenCalled();
    },
  );

  it.each([
    "/api/g/gw-bender/healthz",
    "/api/g/gw-bender/healthz/bridge",
    "/api/g/gw-bender/internal/openclaw/agent-control/callback",
  ])(
    "strips the fleet prefix before the chat-proxy ownership check — %s routes to the proxy, never the app",
    (path) => {
      const app = vi.fn();
      const req = mockReq(path);
      const res = mockRes();

      dispatchGatewayEdgeRequest(req, res, app);

      expect(app).not.toHaveBeenCalled();
    },
  );

  it("leaves the legacy approval callback unowned and unreachable even through the raw proxy handler", async () => {
    const app = vi.fn();
    const req = mockReq("/api/openclaw/approval/callback", "POST");
    const res = mockRes();
    dispatchGatewayEdgeRequest(req, res, app);
    expect(app).toHaveBeenCalledWith(req, res);

    const directReq = mockReq("/api/openclaw/approval/callback", "POST");
    const directRes = mockRes();
    await chatProxyHandleRequest(directReq, directRes);
    expect(directRes.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
  });
});
