import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createAgentImportsRouter } from "../routes/agent-imports.js";

const artifacts = {
  formatVersion: 1,
  portableAgent: { sourceAgentId: "moof", name: "Moof" },
  configInventory: [{ path: "agents.list[].name", valueType: "string", classification: "portable", selectedAgent: true }],
  doctorCandidate: { agents: { list: [{ id: "moof", name: "Moof" }] } },
};

function harness() {
  const service = {
    previewGithub: vi.fn().mockResolvedValue({ id: "imp-1", approvalHash: "sha256:approval" }),
    previewLocal: vi.fn().mockResolvedValue({ id: "imp-2", approvalHash: "sha256:local" }),
    apply: vi.fn().mockResolvedValue({ id: "imp-1", status: "complete" }),
    get: vi.fn().mockResolvedValue({ id: "imp-1", status: "previewed" }),
    rollback: vi.fn().mockResolvedValue({ id: "imp-1", status: "rolled_back" }),
  };
  const deps = {
    service,
    localGatewayId: () => "gw-alice",
    resolveUserGateway: vi.fn().mockResolvedValue({ slug: "alice", gatewayId: "gw-alice" }),
    isProvisioned: vi.fn().mockResolvedValue(true),
    listGithubSources: vi.fn().mockResolvedValue({ repos: [{ owner: "jack", repo: "moof", defaultBranch: "main" }], truncated: false }),
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.uid = "uid-alice";
    next();
  });
  app.use("/api/g/:gatewayId/agent-imports", createAgentImportsRouter(deps));
  return { app, deps, service };
}

describe("agent imports route", () => {
  beforeEach(() => vi.clearAllMocks());

  it("previews a GitHub repository for the authenticated local gateway owner", async () => {
    const { app, service } = harness();
    await request(app)
      .post("/api/g/gw-alice/agent-imports/preview/github")
      .send({ owner: "jack", repo: "moof", branch: "main", artifacts })
      .expect(201, { id: "imp-1", approvalHash: "sha256:approval" });

    expect(service.previewGithub).toHaveBeenCalledWith({
      uid: "uid-alice",
      slug: "alice",
      gatewayId: "gw-alice",
      owner: "jack",
      repo: "moof",
      branch: "main",
      artifacts,
    });
  });

  it("does not reveal whether an import exists across gateway boundaries", async () => {
    const { app, deps, service } = harness();
    deps.resolveUserGateway.mockResolvedValue({ slug: "alice", gatewayId: "gw-other" });

    await request(app).get("/api/g/gw-alice/agent-imports/imp-1").expect(404, { error: "not_found" });
    expect(service.get).not.toHaveBeenCalled();
  });

  it("requires completed OpenClaw provisioning", async () => {
    const { app, deps } = harness();
    deps.isProvisioned.mockResolvedValue(false);
    const response = await request(app)
      .post("/api/g/gw-alice/agent-imports/preview/github")
      .send({ owner: "jack", repo: "moof", branch: "main", artifacts })
      .expect(409, { error: "openclaw_not_ready" });
    expect(response.body).toEqual({ error: "openclaw_not_ready" });
  });

  it("lists import-only GitHub sources with the existing connector", async () => {
    const { app, deps } = harness();
    await request(app).get("/api/g/gw-alice/agent-imports/sources/github").expect(200, {
      repos: [{ owner: "jack", repo: "moof", defaultBranch: "main" }],
      truncated: false,
    });
    expect(deps.listGithubSources).toHaveBeenCalledWith("uid-alice");
  });

  it("returns a typed reconnect response without leaking connector failures", async () => {
    const { app, deps } = harness();
    deps.listGithubSources.mockRejectedValue(Object.assign(new Error("GitHub not connected"), { code: "github_not_connected" }));
    await request(app).get("/api/g/gw-alice/agent-imports/sources/github").expect(422, {
      error: "github_not_connected",
      message: "GitHub not connected",
    });
  });

  it("returns a typed rejection for a structurally unsafe Git history", async () => {
    const { app, service } = harness();
    service.previewGithub.mockRejectedValue(Object.assign(new Error("source history contains a blocked path"), {
      code: "unsafe_git_entry",
    }));
    const response = await request(app)
      .post("/api/g/gw-alice/agent-imports/preview/github")
      .send({ owner: "jack", repo: "moof", branch: "main", artifacts })
      .expect(422, {
        error: "unsafe_git_entry",
        message: "source history contains a blocked path",
      });
    expect(response.body).toEqual({
      error: "unsafe_git_entry",
      message: "source history contains a blocked path",
    });
  });

  it("accepts exactly one normalized local archive", async () => {
    const { app, service } = harness();
    await request(app)
      .post("/api/g/gw-alice/agent-imports/preview/local")
      .attach("archive", Buffer.from("normalized"), { filename: "moof.zip", contentType: "application/zip" })
      .expect(201, { id: "imp-2", approvalHash: "sha256:local" });
    expect(service.previewLocal).toHaveBeenCalledWith({
      uid: "uid-alice",
      slug: "alice",
      gatewayId: "gw-alice",
      archive: Buffer.from("normalized"),
    });
  });

  it("rejects multipart requests containing more than one local archive", async () => {
    const { app, service } = harness();
    await request(app)
      .post("/api/g/gw-alice/agent-imports/preview/local")
      .attach("archive", Buffer.from("first"), { filename: "moof.zip", contentType: "application/zip" })
      .attach("archive", Buffer.from("second"), { filename: "other.zip", contentType: "application/zip" })
      .expect(400, {
        error: "invalid_local_archive",
        message: "exactly one ZIP archive under 32 MiB is required",
      });
    expect(service.previewLocal).not.toHaveBeenCalled();
  });

  it("admits only one local archive preview at a time per gateway process", async () => {
    const { app, service } = harness();
    let release!: () => void;
    const blocked = new Promise<{ id: string; approvalHash: string }>((resolve) => {
      release = () => resolve({ id: "imp-2", approvalHash: "sha256:local" });
    });
    service.previewLocal.mockReturnValueOnce(blocked);
    const first = request(app)
      .post("/api/g/gw-alice/agent-imports/preview/local")
      .attach("archive", Buffer.from("normalized"), { filename: "moof.zip", contentType: "application/zip" })
      .expect(201)
      .then((response) => response);
    while (service.previewLocal.mock.calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));

    const second = await request(app)
      .post("/api/g/gw-alice/agent-imports/preview/local")
      .attach("archive", Buffer.from("normalized"), { filename: "moof.zip", contentType: "application/zip" });
    expect(second.status).toBe(429);
    expect(second.body).toEqual({ error: "local_import_busy" });

    release();
    await first;
  });

  it("binds apply, status, and rollback to the authenticated owner", async () => {
    const { app, service } = harness();
    await request(app)
      .post("/api/g/gw-alice/agent-imports/imp-1/apply")
      .send({ approvalHash: "sha256:approval" })
      .expect(200, { id: "imp-1", status: "complete" });
    await request(app).get("/api/g/gw-alice/agent-imports/imp-1").expect(200);
    await request(app).post("/api/g/gw-alice/agent-imports/imp-1/rollback").expect(200);

    expect(service.apply).toHaveBeenCalledWith({ importId: "imp-1", uid: "uid-alice", approvalHash: "sha256:approval" });
    expect(service.get).toHaveBeenCalledWith({ importId: "imp-1", uid: "uid-alice" });
    expect(service.rollback).toHaveBeenCalledWith({ importId: "imp-1", uid: "uid-alice" });
  });
});
