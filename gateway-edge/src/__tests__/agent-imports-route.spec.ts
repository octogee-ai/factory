import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AGENT_IMPORT_ERROR_STATUS, createAgentImportsRouter } from "../routes/agent-imports.js";

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
    latest: vi.fn().mockResolvedValue({ id: "imp-1", status: "complete", importCommit: "c".repeat(40) }),
    rollback: vi.fn().mockResolvedValue({ id: "imp-1", status: "rolled_back" }),
    abandon: vi.fn().mockResolvedValue({ id: "imp-1", status: "abandoned" }),
  };
  const authorize = vi.fn().mockResolvedValue({
    slug: "alice",
    gatewayId: "gw-alice",
    workspacePolicy: { preserveConvergedContextFiles: false },
  });
  const listGithubSources = vi.fn().mockResolvedValue({
    repos: [{ owner: "jack", repo: "moof", defaultBranch: "main" }],
    truncated: false,
  });
  const deps = {
    createRuntime: vi.fn(() => ({ service, authorize, listGithubSources })),
    localGatewayId: () => "gw-alice",
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.uid = "uid-alice";
    req.headers.authorization = "Bearer firebase-token";
    next();
  });
  app.use("/api/g/:gatewayId/agent-imports", createAgentImportsRouter(deps));
  return { app, deps, service, authorize, listGithubSources };
}

describe("agent imports route", () => {
  beforeEach(() => vi.clearAllMocks());

  it("maps every typed import failure to an actionable HTTP response", () => {
    const codes = [
      "approval_mismatch", "archive_too_large", "binary_too_large", "coach_config_missing",
      "config_changed", "config_get_failed", "config_readback_failed", "config_rollback_unsafe",
      "destination_branch", "destination_changed", "destination_dirty", "destination_restore_failed",
      "forbidden", "git_command_failed", "git_lfs_unsupported", "git_source_invalid",
      "github_clone_failed", "github_not_connected", "import_not_found", "import_plan_missing",
      "invalid_archive", "invalid_archive_metadata", "invalid_config_artifact", "invalid_git_head",
      "invalid_git_history", "invalid_git_tree", "invalid_github_source", "invalid_github_token",
      "invalid_import_id", "invalid_import_state", "invalid_platform_manifest", "invalid_source_config",
      "local_archive_missing", "rollback_window_closed", "secret_scan_failed", "source_agent_ambiguous",
      "source_agent_not_found", "source_changed", "unsafe_archive_entry", "unsafe_config_artifact",
      "unsafe_git_entry", "unsafe_platform_path", "workspace_busy", "workspace_policy_changed",
    ];
    expect(codes.filter((code) => !AGENT_IMPORT_ERROR_STATUS[code])).toEqual([]);
  });

  it("abandons a pre-commit recovery record for the authenticated owner", async () => {
    const { app, service } = harness();

    await request(app)
      .post("/api/g/gw-alice/agent-imports/imp-1/abandon")
      .send({})
      .expect(200, { id: "imp-1", status: "abandoned" });

    expect(service.abandon).toHaveBeenCalledWith({ uid: "uid-alice", importId: "imp-1" });
  });

  it("previews a GitHub repository for the authenticated local gateway owner", async () => {
    const { app, authorize, service } = harness();
    await request(app)
      .post("/api/g/gw-alice/agent-imports/preview/github")
      .send({ owner: "jack", repo: "moof", branch: "main", artifacts })
      .expect(201, { id: "imp-1", approvalHash: "sha256:approval" });

    expect(service.previewGithub).toHaveBeenCalledWith({
      uid: "uid-alice",
      slug: "alice",
      gatewayId: "gw-alice",
      workspacePolicy: { preserveConvergedContextFiles: false },
      owner: "jack",
      repo: "moof",
      branch: "main",
      artifacts,
    });
    expect(authorize).toHaveBeenCalledWith("preview");
  });

  it("bounds preview work while keeping the import journal available", async () => {
    const { app, authorize, service } = harness();
    const client = request(app);
    const preview = () => client.post("/api/g/gw-alice/agent-imports/preview/github")
      .send({ owner: "jack", repo: "moof", branch: "main", artifacts });
    for (let attempt = 0; attempt < 12; attempt++) await preview().expect(201);
    await preview().expect(429);
    expect(authorize).toHaveBeenCalledTimes(12);
    expect(service.previewGithub).toHaveBeenCalledTimes(12);
    await client.get("/api/g/gw-alice/agent-imports/latest").expect(200);
  });

  it("does not reveal whether an import exists across gateway boundaries", async () => {
    const { app, authorize, deps, service } = harness();

    await request(app).get("/api/g/gw-other/agent-imports/imp-1").expect(404, { error: "not_found" });
    expect(service.get).not.toHaveBeenCalled();
    expect(deps.createRuntime).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
  });

  it("requires completed OpenClaw provisioning", async () => {
    const { app, authorize } = harness();
    authorize.mockRejectedValue(Object.assign(new Error("OpenClaw not ready"), {
      code: "openclaw_not_ready",
    }));
    const response = await request(app)
      .post("/api/g/gw-alice/agent-imports/preview/github")
      .send({ owner: "jack", repo: "moof", branch: "main", artifacts })
      .expect(409, { error: "openclaw_not_ready", message: "OpenClaw not ready" });
    expect(response.body).toEqual({ error: "openclaw_not_ready", message: "OpenClaw not ready" });
  });

  it("lists import-only GitHub sources with the existing connector", async () => {
    const { app, authorize, listGithubSources } = harness();
    await request(app).get("/api/g/gw-alice/agent-imports/sources/github").expect(200, {
      repos: [{ owner: "jack", repo: "moof", defaultBranch: "main" }],
      truncated: false,
    });
    expect(listGithubSources).toHaveBeenCalledOnce();
    expect(authorize).toHaveBeenCalledWith("source_listing");
  });

  it("returns a typed reconnect response without leaking connector failures", async () => {
    const { app, listGithubSources } = harness();
    listGithubSources.mockRejectedValue(Object.assign(new Error("GitHub not connected"), { code: "github_not_connected" }));
    await request(app).get("/api/g/gw-alice/agent-imports/sources/github").expect(422, {
      error: "github_not_connected",
      message: "GitHub not connected",
    });
  });

  it("returns an actionable client error when the authorized GitHub clone fails", async () => {
    const { app, service } = harness();
    service.previewGithub.mockRejectedValue(Object.assign(new Error("GitHub repository could not be cloned"), {
      code: "github_clone_failed",
    }));

    await request(app)
      .post("/api/g/gw-alice/agent-imports/preview/github")
      .send({ owner: "jack", repo: "moof", branch: "main", artifacts })
      .expect(422, {
        error: "github_clone_failed",
        message: "GitHub repository could not be cloned",
      });
    expect(service.previewGithub).toHaveBeenCalledOnce();
  });

  it("returns only sanitized secret finding coordinates", async () => {
    const { app, service } = harness();
    service.previewGithub.mockRejectedValue(Object.assign(new Error("source contains credentials"), {
      code: "secret_findings",
      findings: [{ ruleId: "github-pat", path: "memory/old.md", commit: "a".repeat(40), secret: "never" }],
    }));

    const response = await request(app)
      .post("/api/g/gw-alice/agent-imports/preview/github")
      .send({ owner: "jack", repo: "moof", branch: "main", artifacts })
      .expect(422);

    expect(response.body.findings).toEqual([{
      ruleId: "github-pat", path: "memory/old.md", commit: "a".repeat(40),
    }]);
    expect(JSON.stringify(response.body)).not.toContain("never");
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
    const { app, authorize, service } = harness();
    await request(app)
      .post("/api/g/gw-alice/agent-imports/preview/local")
      .attach("archive", Buffer.from("normalized"), { filename: "moof.zip", contentType: "application/zip" })
      .expect(201, { id: "imp-2", approvalHash: "sha256:local" });
    expect(service.previewLocal).toHaveBeenCalledWith({
      uid: "uid-alice",
      slug: "alice",
      gatewayId: "gw-alice",
      workspacePolicy: { preserveConvergedContextFiles: false },
      archive: Buffer.from("normalized"),
    });
    expect(authorize).toHaveBeenCalledWith("preview");
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

  it("binds each intent to the authenticated local gateway owner", async () => {
    const { app, service, authorize } = harness();
    await request(app)
      .post("/api/g/gw-alice/agent-imports/imp-1/apply")
      .send({ approvalHash: "sha256:approval" })
      .expect(200, { id: "imp-1", status: "complete" });
    await request(app).get("/api/g/gw-alice/agent-imports/imp-1").expect(200);
    await request(app).get("/api/g/gw-alice/agent-imports/latest").expect(200);
    await request(app).post("/api/g/gw-alice/agent-imports/imp-1/rollback").expect(200);
    await request(app).post("/api/g/gw-alice/agent-imports/imp-1/abandon").expect(200);

    expect(service.apply).toHaveBeenCalledWith({
      importId: "imp-1",
      uid: "uid-alice",
      approvalHash: "sha256:approval",
      workspacePolicy: { preserveConvergedContextFiles: false },
    });
    expect(service.get).toHaveBeenCalledWith({ importId: "imp-1", uid: "uid-alice" });
    expect(service.latest).toHaveBeenCalledWith({ uid: "uid-alice" });
    expect(service.rollback).toHaveBeenCalledWith({ importId: "imp-1", uid: "uid-alice" });
    expect(service.abandon).toHaveBeenCalledWith({ importId: "imp-1", uid: "uid-alice" });
    expect(authorize.mock.calls.map(([intent]) => intent)).toEqual([
      "apply",
      "status",
      "status",
      "rollback",
      "abandon",
    ]);
  });
});
