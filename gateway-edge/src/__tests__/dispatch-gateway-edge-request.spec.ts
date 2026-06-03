import { describe, it, expect, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";

import { dispatchGatewayEdgeRequest } from "../index.js";

function mockReq(url: string, method = "GET"): IncomingMessage {
  return { url, method, headers: {} } as unknown as IncomingMessage;
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

  it.each(["/healthz", "/healthz/bridge", "/api/openclaw/approval/callback"])(
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
    "/api/g/gw-bender/api/openclaw/approval/callback",
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
});
