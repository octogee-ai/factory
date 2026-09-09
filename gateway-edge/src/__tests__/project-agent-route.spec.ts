import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  provisionProjectAgent: vi.fn(),
  logger: { error: vi.fn(), info: vi.fn() },
}));

vi.mock("../middleware/security.js", () => ({
  strictRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../middleware/logging.js", () => ({ logger: h.logger }));

vi.mock("../lib/project-agent-service.js", () => ({
  provisionProjectAgent: (...args: unknown[]) => h.provisionProjectAgent(...args),
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
  h.provisionProjectAgent.mockReset();
  h.logger.error.mockReset();
});

describe("POST /api/projects/:wid/:pid/agent", () => {
  it("provisions the project agent for the caller's own workspace", async () => {
    h.provisionProjectAgent.mockResolvedValue({
      status: 200,
      body: { success: true, status: "provisioning", provisioned: true },
    });

    const resp = await request(app()).post("/api/projects/mira/orbit/agent").send({});

    expect(resp.status).toBe(200);
    expect(resp.body).toEqual({ success: true, status: "provisioning", provisioned: true });
    expect(h.provisionProjectAgent).toHaveBeenCalledWith({ uid: "owner-1", workspaceId: "mira" }, "orbit");
  });

  it("refuses provisioning against another workspace", async () => {
    const resp = await request(app()).post("/api/projects/victim/orbit/agent").send({});

    expect(resp.status).toBe(403);
    expect(h.provisionProjectAgent).not.toHaveBeenCalled();
  });

  it("returns 500 and logs when the service throws", async () => {
    h.provisionProjectAgent.mockRejectedValue(new Error("boom"));

    const resp = await request(app()).post("/api/projects/mira/orbit/agent").send({});

    expect(resp.status).toBe(500);
    expect(h.logger.error).toHaveBeenCalled();
  });
});
