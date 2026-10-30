import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  provisionProjectAgent: vi.fn(),
  update: vi.fn(), owner: true, configured: true, archived: false,
  logger: { error: vi.fn(), info: vi.fn() },
}));

vi.mock("../middleware/security.js", () => ({
  strictRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../middleware/logging.js", () => ({ logger: h.logger }));

vi.mock("../lib/project-agent-service.js", () => ({
  provisionProjectAgent: (...args: unknown[]) => h.provisionProjectAgent(...args),
}));

vi.mock('../lib/withProject.js', () => ({ withProject: async (req: any, res: any, wid: string, pid: string, options: any, run: any) => {
  if (options.ownerOnly && !h.owner) { res.status(403).json({ error: 'owner required' }); return; }
  if (options.requireActive && h.archived) { res.status(409).json({ error: 'archived' }); return; }
  await run({ project: { agent: h.configured ? {} : null }, projectRef: { update: h.update } });
} }));
vi.mock('../lib/db.js', () => ({ FieldValue: { serverTimestamp: () => 'timestamp' } }));
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
  h.update.mockReset().mockResolvedValue(undefined); h.owner = true; h.configured = true; h.archived = false;
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

describe('project agent voice settings', () => {
  it('stores and clears only the project voice', async () => {
    const api = app();
    expect((await request(api).put('/api/projects/mira/orbit/agent/voice').send({ voice: 'cedar' })).body).toEqual({ voice: 'cedar' });
    expect(h.update).toHaveBeenCalledWith({ 'agent.voice': 'cedar', updatedAt: 'timestamp' });
    expect((await request(api).put('/api/projects/mira/orbit/agent/voice').send({ voice: '' })).status).toBe(200);
    expect(h.update).toHaveBeenLastCalledWith({ 'agent.voice': '', updatedAt: 'timestamp' });
  });
  it.each([{ voice: '<script>' }, { voice: 'cedar', agentId: 'foreign' }, {}])('rejects invalid settings %j', async body => {
    expect((await request(app()).put('/api/projects/mira/orbit/agent/voice').send(body)).status).toBe(400);
    expect(h.update).not.toHaveBeenCalled();
  });
  it.each(['owner', 'configured', 'archived'] as const)('rejects unavailable %s authority', async kind => {
    if (kind === 'archived') h.archived = true; else h[kind] = false;
    expect((await request(app()).put('/api/projects/mira/orbit/agent/voice').send({ voice: 'cedar' })).status).toBe(kind === 'owner' ? 403 : 409);
    expect(h.update).not.toHaveBeenCalled();
  });
});
