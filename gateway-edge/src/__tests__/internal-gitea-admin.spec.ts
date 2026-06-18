import express from "express";
import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";

import * as giteaAdmin from "../lib/gitea-admin.js";
import { readAssignedSlugsForGateway } from "../../../scripts/lib/assigned-roster.js";
import giteaAdminRoutes from "../routes/internal/gitea-admin.js";

vi.mock("../lib/db.js", () => ({
  db: {},
}));

vi.mock("../../../scripts/lib/assigned-roster.js", () => ({
  readAssignedSlugsForGateway: vi.fn(async () => ["acme"]),
}));

vi.mock("../lib/gitea-admin.js", () => ({
  ensureGiteaUser: vi.fn(async () => {}),
  readGiteaUserPubKey: vi.fn(async () => "ssh-ed25519 KEY octogee"),
  ensureGiteaOrgForWorkspace: vi.fn(async () => {}),
  ensureWorkspaceRepo: vi.fn(async () => {}),
  ensureSystemConfigRepo: vi.fn(async () => {}),
  ensureProjectRepo: vi.fn(async () => {}),
  repoExists: vi.fn(async () => true),
  archiveRepo: vi.fn(async () => {}),
}));

function app(boundGatewayId: string | null = "bender") {
  const a = express();
  a.use(express.json());
  if (boundGatewayId) {
    a.use((req, _res, next) => {
      req.boundTenant = {
        kind: "gateway",
        gatewayId: boundGatewayId,
        ownerUid: `owner-${boundGatewayId}`,
      };
      next();
    });
  }
  a.use("/internal/gitea", giteaAdminRoutes);
  return a;
}

function authed(req: request.Test) {
  // Auth is the gateway tenant-binding injected by app(); the legacy
  // internal-service-key is retired.
  return req;
}

describe("internal gitea-admin route", () => {
  beforeEach(() => {
    process.env.GATEWAY_ID = "bender";
    vi.clearAllMocks();
    vi.mocked(readAssignedSlugsForGateway).mockResolvedValue(["acme"]);
  });

  it("rejects requests without a bound gateway identity (401)", async () => {
    const res = await request(app(null)).post("/internal/gitea/ensure-user").send({ slug: "acme", pubKey: "k" });
    expect(res.status).toBe(401);
    expect(giteaAdmin.ensureGiteaUser).not.toHaveBeenCalled();
  });

  it("ensure-user → 204 and calls the lib with slug + pubKey", async () => {
    const res = await authed(
      request(app()).post("/internal/gitea/ensure-user"),
    ).send({ slug: "acme", pubKey: "ssh-ed25519 AAA" });
    expect(res.status).toBe(204);
    expect(readAssignedSlugsForGateway).toHaveBeenCalledWith(expect.anything(), "bender");
    expect(giteaAdmin.ensureGiteaUser).toHaveBeenCalledWith("acme", "ssh-ed25519 AAA");
  });

  it("uses the bound gateway identity from octogee-api TokenReview instead of GATEWAY_ID env", async () => {
    delete process.env.GATEWAY_ID;
    delete process.env.INTERNAL_SERVICE_KEY;

    const res = await request(app("bender"))
      .post("/internal/gitea/ensure-user")
      .send({ slug: "acme", pubKey: "ssh-ed25519 AAA" });

    expect(res.status).toBe(204);
    expect(readAssignedSlugsForGateway).toHaveBeenCalledWith(expect.anything(), "bender");
    expect(giteaAdmin.ensureGiteaUser).toHaveBeenCalledWith("acme", "ssh-ed25519 AAA");
  });

  it("ensure-user → 403 when slug is not assigned to this gateway, before touching Gitea", async () => {
    const res = await authed(
      request(app()).post("/internal/gitea/ensure-user"),
    ).send({ slug: "victim", pubKey: "ssh-ed25519 AAA" });
    expect(res.status).toBe(403);
    expect(giteaAdmin.ensureGiteaUser).not.toHaveBeenCalled();
  });

  it("ensure-user → 502 when assignment lookup fails, before touching Gitea", async () => {
    vi.mocked(readAssignedSlugsForGateway).mockRejectedValueOnce(new Error("firestore down"));
    const res = await authed(
      request(app()).post("/internal/gitea/ensure-user"),
    ).send({ slug: "acme", pubKey: "ssh-ed25519 AAA" });
    expect(res.status).toBe(502);
    expect(giteaAdmin.ensureGiteaUser).not.toHaveBeenCalled();
  });

  it("ensure-user → 400 when pubKey missing", async () => {
    const res = await authed(request(app()).post("/internal/gitea/ensure-user")).send({ slug: "acme" });
    expect(res.status).toBe(400);
    expect(giteaAdmin.ensureGiteaUser).not.toHaveBeenCalled();
  });

  it("user-pubkey → 200 { pubKey } from the lib", async () => {
    const res = await authed(request(app()).get("/internal/gitea/user-pubkey").query({ slug: "acme" }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pubKey: "ssh-ed25519 KEY octogee" });
    expect(giteaAdmin.readGiteaUserPubKey).toHaveBeenCalledWith("acme");
  });

  it("user-pubkey → 200 { pubKey: null } when the lib returns null", async () => {
    vi.mocked(giteaAdmin.readGiteaUserPubKey).mockResolvedValueOnce(null);
    const res = await authed(request(app()).get("/internal/gitea/user-pubkey").query({ slug: "acme" }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pubKey: null });
  });

  it("ensure-org → 204 and calls the lib with slug", async () => {
    const res = await authed(request(app()).post("/internal/gitea/ensure-org")).send({ slug: "acme" });
    expect(res.status).toBe(204);
    expect(giteaAdmin.ensureGiteaOrgForWorkspace).toHaveBeenCalledWith("acme");
  });

  it("ensure-workspace-repo → 204", async () => {
    const res = await authed(request(app()).post("/internal/gitea/ensure-workspace-repo")).send({ slug: "acme" });
    expect(res.status).toBe(204);
    expect(giteaAdmin.ensureWorkspaceRepo).toHaveBeenCalledWith("acme");
  });

  it("ensure-system-config-repo → 204", async () => {
    const res = await authed(request(app()).post("/internal/gitea/ensure-system-config-repo")).send({ slug: "acme" });
    expect(res.status).toBe(204);
    expect(giteaAdmin.ensureSystemConfigRepo).toHaveBeenCalledWith("acme");
  });

  it("ensure-project-repo → 204 with slug + projectName", async () => {
    const res = await authed(request(app()).post("/internal/gitea/ensure-project-repo")).send({
      slug: "acme",
      projectName: "mygame",
    });
    expect(res.status).toBe(204);
    expect(giteaAdmin.ensureProjectRepo).toHaveBeenCalledWith("acme", "mygame");
  });

  it("repo-exists → 200 { exists }", async () => {
    const res = await authed(request(app()).get("/internal/gitea/repo-exists").query({ org: "acme", repo: "workspace" }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ exists: true });
    expect(giteaAdmin.repoExists).toHaveBeenCalledWith("acme", "workspace");
  });

  it("repo-exists accepts only the fixed system_config repo underscore exception", async () => {
    const ok = await authed(request(app()).get("/internal/gitea/repo-exists").query({ org: "acme", repo: "system_config" }));
    expect(ok.status).toBe(200);
    expect(giteaAdmin.repoExists).toHaveBeenCalledWith("acme", "system_config");

    const bad = await authed(request(app()).get("/internal/gitea/repo-exists").query({ org: "acme", repo: "not_config" }));
    expect(bad.status).toBe(400);
  });

  it("archive-repo → 204 with org + repo", async () => {
    const res = await authed(request(app()).post("/internal/gitea/archive-repo")).send({ org: "acme", repo: "workspace" });
    expect(res.status).toBe(204);
    expect(giteaAdmin.archiveRepo).toHaveBeenCalledWith("acme", "workspace");
  });

  it("archive-repo → 403 when org is not assigned to this gateway, before touching Gitea", async () => {
    const res = await authed(request(app()).post("/internal/gitea/archive-repo")).send({ org: "victim", repo: "workspace" });
    expect(res.status).toBe(403);
    expect(giteaAdmin.archiveRepo).not.toHaveBeenCalled();
  });

  it("→ 502 when the lib throws (fail loud, no silent success)", async () => {
    vi.mocked(giteaAdmin.ensureGiteaUser).mockRejectedValueOnce(new Error("gitea down"));
    const res = await authed(request(app()).post("/internal/gitea/ensure-user")).send({ slug: "acme", pubKey: "ssh-ed25519 AAA" });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/gitea down/);
  });

  it("rejects path-traversal / malformed slug with 400 — never reaches the admin lib", async () => {
    for (const slug of ["../admin", "ws/../../x", "Acme", "a b", ""]) {
      const res = await authed(request(app()).post("/internal/gitea/ensure-user")).send({ slug, pubKey: "ssh-ed25519 AAA" });
      expect(res.status, `slug=${JSON.stringify(slug)}`).toBe(400);
    }
    expect(giteaAdmin.ensureGiteaUser).not.toHaveBeenCalled();
  });

  it("rejects a non-SSH pubKey with 400", async () => {
    const res = await authed(request(app()).post("/internal/gitea/ensure-user")).send({ slug: "acme", pubKey: "not-a-key" });
    expect(res.status).toBe(400);
    expect(giteaAdmin.ensureGiteaUser).not.toHaveBeenCalled();
  });

  it("rejects malformed projectName / org / repo with 400", async () => {
    const r1 = await authed(request(app()).post("/internal/gitea/ensure-project-repo")).send({ slug: "acme", projectName: "../x" });
    expect(r1.status).toBe(400);
    const r2 = await authed(request(app()).get("/internal/gitea/repo-exists").query({ org: "acme", repo: "a/b" }));
    expect(r2.status).toBe(400);
    const r3 = await authed(request(app()).post("/internal/gitea/archive-repo")).send({ org: "../etc", repo: "workspace" });
    expect(r3.status).toBe(400);
    expect(giteaAdmin.ensureProjectRepo).not.toHaveBeenCalled();
    expect(giteaAdmin.repoExists).not.toHaveBeenCalled();
    expect(giteaAdmin.archiveRepo).not.toHaveBeenCalled();
  });
});
