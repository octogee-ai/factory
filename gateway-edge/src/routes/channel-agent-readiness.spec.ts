import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
vi.mock("../middleware/logging.js", () => ({ logger: { error: vi.fn() } }));
import { createChannelAgentReadinessRouter } from "./channel-agent-readiness.js";
const channelId = "a".repeat(26);
function setup() {
  const authorization = { gatewayId: "gateway-alice", workspaceId: "alice", project: null,
    channelId, agentId: "octogee-alice-coach", agentMmUserId: "b".repeat(26), peerKind: "group" };
  const authorize = vi.fn(async () => ({ kind: "authorized" as const, authorization }));
  const read = vi.fn(async () => false);
  const deps = { authorize, read, localGatewayId: () => "gateway-alice" };
  const app = express();
  app.disable("x-powered-by");
  app.use("/g/:gatewayId/channel-agent-readiness", createChannelAgentReadinessRouter(deps as never));
  return { app, ...deps };
}
const path = `/g/gateway-alice/channel-agent-readiness/${channelId}`;
describe("channel Agent readiness route", () => {
  it.each([false, true])("reports only readiness metadata for an authorized member (%s)", async (ready) => {
    const h = setup(); h.read.mockResolvedValue(ready);
    const r = await request(h.app).get(path).set("authorization", "Bearer caller");
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.body).toEqual({ channelId, agentMmUserId: "b".repeat(26), ready });
    expect(h.authorize).toHaveBeenCalledWith({ gatewayId: "gateway-alice", channelId, authorization: "Bearer caller" });
    expect(h.read).toHaveBeenCalledWith({ workspaceId: "alice", project: null, channelId, agentId: "octogee-alice-coach", peerKind: "group" });
  });
  it.each(["not_found", "unauthenticated"])("never reads native configuration for broker refusal: %s", async (kind) => {
    const h = setup(); h.authorize.mockResolvedValue({ kind } as never);
    const r = await request(h.app).get(path);
    expect(r.status).toBe(kind === "unauthenticated" ? 401 : 404);
    expect(h.read).not.toHaveBeenCalled();
  });
  it.each(["gateway-other", "invalid channel"])("refuses malformed or nonlocal scope: %s", async (scope) => {
    const h = setup();
    const r = await request(h.app).get(scope === "gateway-other" ? path.replace("gateway-alice", scope) : path.replace(channelId, scope));
    expect(r.status).toBe(404); expect(h.authorize).not.toHaveBeenCalled(); expect(h.read).not.toHaveBeenCalled();
  });
  it.each(["read", "authorize"] as const)("returns a retryable error on %s outage", async (dependency) => {
    const h = setup(); h[dependency].mockRejectedValue(new Error("upstream closed"));
    expect((await request(h.app).get(path)).status).toBe(503);
    if (dependency === "authorize") expect(h.read).not.toHaveBeenCalled();
  });
});
