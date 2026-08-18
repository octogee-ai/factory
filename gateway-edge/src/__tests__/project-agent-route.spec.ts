import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  setProjectAgentEnabled: vi.fn(),
  logger: { error: vi.fn(), info: vi.fn() },
}));

vi.mock("../middleware/security.js", () => ({
  strictRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../middleware/logging.js", () => ({ logger: h.logger }));

vi.mock("../lib/project-agent-service.js", () => ({
  setProjectAgentEnabled: (...args: unknown[]) => h.setProjectAgentEnabled(...args),
}));

const { default: agentRouter } = await import("../routes/projects/agent.js");

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    req.uid = "owner-1";
    req.user = { username: "mira" };
    req.workspaceSlug = "mira";
    next();
  });
  a.use("/api/projects", agentRouter);
  return a;
}

beforeEach(() => {
  h.setProjectAgentEnabled.mockReset();
  h.logger.error.mockReset();
});

describe("POST /api/projects/:wid/:pid/agent", () => {
  it("relays the toggle to the service for the caller's own workspace", async () => {
    h.setProjectAgentEnabled.mockResolvedValue({
      status: 200,
      body: {
        success: true,
        enabled: true,
        mode: "scoped",
        status: "ready",
        provisioned: true,
      },
    });

    const resp = await request(app())
      .post("/api/projects/mira/orbit/agent")
      .send({ enabled: true });

    expect(resp.status).toBe(200);
    expect(resp.body).toEqual({
      success: true,
      enabled: true,
      mode: "scoped",
      status: "ready",
      provisioned: true,
    });
    expect(h.setProjectAgentEnabled).toHaveBeenCalledWith(
      { uid: "owner-1", userData: { username: "mira" }, workspaceId: "mira" },
      "orbit",
      true,
    );
  });

  it("refuses toggles against another workspace", async () => {
    const resp = await request(app())
      .post("/api/projects/victim/orbit/agent")
      .send({ enabled: true });

    expect(resp.status).toBe(403);
    expect(h.setProjectAgentEnabled).not.toHaveBeenCalled();
  });

  it("rejects non-boolean enabled instead of treating it as a destructive disable", async () => {
    const resp = await request(app())
      .post("/api/projects/mira/orbit/agent")
      .send({ enabled: "yes" });

    expect(resp.status).toBe(400);
    expect(h.setProjectAgentEnabled).not.toHaveBeenCalled();
  });

  it("relays explicit disable", async () => {
    h.setProjectAgentEnabled.mockResolvedValue({ status: 200, body: { success: true } });

    await request(app()).post("/api/projects/mira/orbit/agent").send({ enabled: false });

    expect(h.setProjectAgentEnabled).toHaveBeenCalledWith(expect.anything(), "orbit", false);
  });

  it("returns 500 and logs when the service throws", async () => {
    h.setProjectAgentEnabled.mockRejectedValue(new Error("boom"));

    const resp = await request(app()).post("/api/projects/mira/orbit/agent").send({ enabled: true });

    expect(resp.status).toBe(500);
    expect(h.logger.error).toHaveBeenCalled();
  });
});
