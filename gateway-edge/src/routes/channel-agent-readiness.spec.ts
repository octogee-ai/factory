import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
vi.mock("../lib/db.js", () => ({ db: {} }));
vi.mock("../middleware/auth.js", () => ({ requireAuth: (req: { uid?: string }, _res: unknown, next: () => void) => { req.uid = "member"; next(); } }));
vi.mock("../middleware/logging.js", () => ({ logger: { error: vi.fn() } }));
import { createChannelAgentReadinessRouter } from "./channel-agent-readiness.js";
const channelId = "a".repeat(26);
function setup() {
  const target = { ownerUid: "owner", workspaceSlug: "alice", agentId: "octogee-alice-coach", agentMmUserId: "coach-mm" };
  const client = { getJson: vi.fn(async () => ({ type: "P", delete_at: 0 })) };
  const authorize = vi.fn(async () => ({ forbidden: false as const, target, client, callerMmUserId: "member-mm" }));
  const read = vi.fn(async () => false);
  const ownerGatewayId = vi.fn(async () => "gateway-alice");
  const deps = { authorize, read, ownerGatewayId, localGatewayId: () => "gateway-alice" };
  const app = express();
  app.disable("x-powered-by");
  app.use("/g/:gatewayId/channel-agent-readiness", createChannelAgentReadinessRouter(deps as never));
  return { app, ...deps, client };
}
const path = `/g/gateway-alice/channel-agent-readiness/${channelId}`;
describe("channel Agent readiness route", () => {
  it.each([false, true])("reports only readiness metadata for an authorized member (%s)", async (ready) => {
    const h = setup();h.read.mockResolvedValue(ready);
    const r = await request(h.app).get(path);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ channelId, agentMmUserId: "coach-mm", ready });
    expect(h.authorize).toHaveBeenCalledWith("member", channelId);
    expect(h.read).toHaveBeenCalledWith({ workspaceId: "alice", project: null, channelId, agentId: "octogee-alice-coach", peerKind: "group" });
  });
  it.each(["missing", "forbidden", "wrong-gateway", "moved-owner", "archived"])("does not read native configuration for %s access", async (failure) => {
    const h = setup();
    if (failure === "missing") h.authorize.mockResolvedValue(null as never);
    if (failure === "forbidden") h.authorize.mockResolvedValue({ forbidden: true } as never);
    if (failure === "moved-owner") h.ownerGatewayId.mockResolvedValue("gateway-other");
    if (failure === "archived") h.client.getJson.mockResolvedValue({ type: "P", delete_at: 1 });
    const r = await request(h.app).get(failure === "wrong-gateway" ? path.replace("gateway-alice", "gateway-other") : path);
    expect(r.status).toBe(404);expect(h.read).not.toHaveBeenCalled();
  });
  it("returns a retryable error while the native runtime reloads", async () => {
    const h = setup();h.read.mockRejectedValue(new Error("upstream closed"));
    expect((await request(h.app).get(path)).status).toBe(503);
  });
  it.each(["O", "P"])("selects the canonical native session kind for live channel type %s", async (type) => {
    const h = setup();
    h.client.getJson.mockResolvedValue({ type, delete_at: 0 });
    expect((await request(h.app).get(path)).status).toBe(200);
    expect(h.read).toHaveBeenCalledWith(expect.objectContaining({ peerKind: type === "P" ? "group" : "channel" }));
  });
  it.each(["D", "G", "unknown"])("rejects unsupported native conversation type %s without reading session metadata", async (type) => {
    const h = setup();
    h.client.getJson.mockResolvedValue({ type, delete_at: 0 });
    expect((await request(h.app).get(path)).status).toBe(404);
    expect(h.read).not.toHaveBeenCalled();
  });
});
