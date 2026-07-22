import express from "express";
import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";

import * as giteaAdmin from "../lib/gitea-admin.js";
import {
  hasRunningInboundMigrationForSlug,
  readAssignedSlugsForGateway,
} from "@octogee/core/assigned-roster";
import giteaAdminRoutes from "../routes/internal/gitea-admin.js";

const mocks = vi.hoisted(() => {
  const state = {
    operationDocs: [] as Record<string, unknown>[],
    users: new Map<string, Record<string, unknown>>(),
    gateways: new Map<string, Record<string, unknown>>(),
  };
  const valueAtPath = (data: Record<string, unknown>, path: string): unknown => {
    let cursor: unknown = data;
    for (const part of path.split(".")) {
      if (!cursor || typeof cursor !== "object") return undefined;
      cursor = (cursor as Record<string, unknown>)[part];
    }
    return cursor;
  };
  const queryFor = (name: string) => {
    const filters: Array<{ field: string; value: unknown }> = [];
    const query = {
      where: vi.fn((field: string, _op: string, value: unknown) => {
        filters.push({ field, value });
        return query;
      }),
      limit: vi.fn(() => query),
      get: vi.fn(async () => {
        const entries =
          name === "glmOperations"
            ? state.operationDocs.map((data, index) => [`op-${index}`, data] as const)
            : [...state.users.entries()];
        const docs = entries
          .filter(([, data]) =>
            filters.every((filter) => valueAtPath(data, filter.field) === filter.value),
          )
          .map(([id, data]) => ({
            id,
            exists: true,
            data: () => data,
          }));
        return { docs };
      }),
    };
    return query;
  };
  const db = {
    collection: vi.fn((name: string) => {
      if (name === "glmOperations") return queryFor(name);
      if (name === "users") {
        return Object.assign(queryFor(name), {
          doc: vi.fn((uid: string) => ({
            get: vi.fn(async () => {
              const data = state.users.get(uid);
              return {
                exists: data !== undefined,
                data: () => data,
              };
            }),
          })),
        });
      }
      if (name === "gateways") {
        return {
          doc: vi.fn((gatewayId: string) => ({
            get: vi.fn(async () => {
              const data = state.gateways.get(gatewayId);
              return {
                exists: data !== undefined,
                data: () => data,
              };
            }),
          })),
        };
      }
      throw new Error(`unexpected collection: ${name}`);
    }),
  };
  return { state, db };
});

vi.mock("../lib/db.js", () => ({
  db: mocks.db,
}));

vi.mock("@octogee/core/assigned-roster", () => ({
  hasRunningInboundMigrationForSlug: vi.fn(async () => false),
  readAssignedSlugsForGateway: vi.fn(async () => ["acme"]),
  slugFromAssignedUser: vi.fn((data: Record<string, unknown> | undefined) => {
    const provisioning = data?.provisioning as Record<string, unknown> | undefined;
    const openclaw = provisioning?.openclaw as Record<string, unknown> | undefined;
    return openclaw?.slug ?? data?.username ?? null;
  }),
}));

vi.mock("../lib/gitea-admin.js", () => ({
  deleteGiteaUserPubKey: vi.fn(async () => {}),
  ensureGiteaUser: vi.fn(async () => {}),
  readGiteaUserPubKey: vi.fn(async () => "ssh-ed25519 OLD predecessor"),
  readGiteaUserPubKeys: vi.fn(async () => ["ssh-ed25519 OLD predecessor", "ssh-ed25519 KEY octogee"]),
  ensureGiteaOrgForWorkspace: vi.fn(async () => {}),
  ensureWorkspaceRepo: vi.fn(async () => {}),
  ensureSystemConfigRepo: vi.fn(async () => {}),
  ensureProjectRepo: vi.fn(async () => {}),
  repoExists: vi.fn(async () => true),
  archiveRepo: vi.fn(async () => {}),
}));

function app(
  boundGatewayId: string | null = "bender",
  podGatewayId: string | null = "bender",
) {
  const a = express();
  a.use(express.json());
  if (boundGatewayId) {
    a.use((req, _res, next) => {
      req.boundTenant = {
        kind: "gateway",
        gatewayId: boundGatewayId,
        ownerUid: `owner-${boundGatewayId}`,
        ...(podGatewayId
          ? { podName: `octogee-gateway-${podGatewayId}-5bc5949d46-p946t` }
          : {}),
      };
      next();
    });
  }
  a.use("/internal/gitea", giteaAdminRoutes);
  return a;
}

function isolatedGateway(overrides: Record<string, unknown> = {}) {
  return {
    gatewayId: "bender",
    createdAt: 1,
    createdBy: "admin",
    updatedAt: 2,
    updatedBy: "admin",
    latestRelease: 2,
    desiredRelease: 2,
    liveRelease: 1,
    desiredStatus: "running",
    configSchemaVersion: 1,
    profile: "operator",
    gatewayClass: "operator",
    imageProfile: "operator",
    sizingTier: null,
    computeClass: null,
    gcpProject: null,
    gatewayContainerSecurityContext: null,
    serviceAccountName: "octogee-gw-bender",
    serviceAccount: null,
    operatorAccess: null,
    ownerUid: "owner-bender",
    builderSlug: "acme",
    openclawOverrides: null,
    modelBrokerLimits: null,
    preemption: null,
    ...overrides,
  };
}

function authed(req: request.Test) {
  // Auth is the gateway tenant-binding injected by app(); the legacy
  // internal-service-key is retired.
  return req;
}

const BENDER_KEY_OWNER = "bender/octogee-gateway-bender-5bc5949d46-p946t";

describe("internal gitea-admin route", () => {
  beforeEach(() => {
    process.env.GATEWAY_ID = "bender";
    vi.clearAllMocks();
    mocks.state.operationDocs.length = 0;
    mocks.state.users.clear();
    mocks.state.gateways.clear();
    vi.mocked(hasRunningInboundMigrationForSlug).mockResolvedValue(false);
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
    expect(giteaAdmin.ensureGiteaUser).toHaveBeenCalledWith(
      "acme",
      "ssh-ed25519 AAA",
      BENDER_KEY_OWNER,
    );
  });

  it("release-user-key removes only the authenticated gateway pod's submitted key", async () => {
    const res = await authed(
      request(app()).post("/internal/gitea/release-user-key"),
    ).send({ slug: "acme", pubKey: "ssh-ed25519 OLD predecessor" });
    expect(res.status).toBe(204);
    expect(giteaAdmin.deleteGiteaUserPubKey).toHaveBeenCalledWith(
      "acme",
      "ssh-ed25519 OLD predecessor",
      BENDER_KEY_OWNER,
    );
  });

  it("lets a predecessor pod release only its owner-bound key after cutover", async () => {
    const res = await authed(
      request(app()).post("/internal/gitea/release-user-key"),
    ).send({ slug: "acme", pubKey: "ssh-ed25519 OLD predecessor" });

    expect(res.status).toBe(204);
    expect(readAssignedSlugsForGateway).not.toHaveBeenCalled();
    expect(giteaAdmin.deleteGiteaUserPubKey).toHaveBeenCalledWith(
      "acme",
      "ssh-ed25519 OLD predecessor",
      BENDER_KEY_OWNER,
    );
  });

  it("uses the bound gateway identity from octogee-api TokenReview instead of GATEWAY_ID env", async () => {
    delete process.env.GATEWAY_ID;
    delete process.env.INTERNAL_SERVICE_KEY;

    const res = await request(app("bender"))
      .post("/internal/gitea/ensure-user")
      .send({ slug: "acme", pubKey: "ssh-ed25519 AAA" });

    expect(res.status).toBe(204);
    expect(readAssignedSlugsForGateway).toHaveBeenCalledWith(expect.anything(), "bender");
    expect(giteaAdmin.ensureGiteaUser).toHaveBeenCalledWith(
      "acme",
      "ssh-ed25519 AAA",
      BENDER_KEY_OWNER,
    );
  });

  it("ensure-user → 403 when slug is not assigned to this gateway, before touching Gitea", async () => {
    const res = await authed(
      request(app()).post("/internal/gitea/ensure-user"),
    ).send({ slug: "victim", pubKey: "ssh-ed25519 AAA" });
    expect(res.status).toBe(403);
    expect(giteaAdmin.ensureGiteaUser).not.toHaveBeenCalled();
  });

  it("allows the target gateway during a running inbound customer migration", async () => {
    vi.mocked(readAssignedSlugsForGateway).mockResolvedValueOnce([]);
    vi.mocked(hasRunningInboundMigrationForSlug).mockResolvedValueOnce(true);

    const res = await authed(
      request(app()).get("/internal/gitea/user-pubkey").query({ slug: "acme" }),
    );

    expect(res.status).toBe(200);
    expect(hasRunningInboundMigrationForSlug).toHaveBeenCalledWith(
      expect.anything(),
      "bender",
      "acme",
    );
    expect(giteaAdmin.readGiteaUserPubKey).toHaveBeenCalledWith("acme");
  });

  it("allows the authenticated stable gateway pod to bootstrap its configured builder", async () => {
    vi.mocked(readAssignedSlugsForGateway).mockResolvedValueOnce([]);
    mocks.state.gateways.set("bender", isolatedGateway());

    const res = await authed(
      request(app()).post("/internal/gitea/ensure-user"),
    ).send({ slug: "acme", pubKey: "ssh-ed25519 AAA" });

    expect(res.status).toBe(204);
    expect(giteaAdmin.ensureGiteaUser).toHaveBeenCalledWith(
      "acme",
      "ssh-ed25519 AAA",
      BENDER_KEY_OWNER,
    );
  });

  it("denies a pod outside the gateway's own Deployment from bootstrapping the configured builder", async () => {
    vi.mocked(readAssignedSlugsForGateway).mockResolvedValueOnce([]);
    mocks.state.gateways.set("bender", isolatedGateway());

    const res = await request(app("bender", "other"))
      .post("/internal/gitea/ensure-user")
      .send({ slug: "acme", pubKey: "ssh-ed25519 AAA" });

    expect(res.status).toBe(403);
    expect(giteaAdmin.ensureGiteaUser).not.toHaveBeenCalled();
  });

  it("allows the initial stable pod before the gateway has a live release", async () => {
    vi.mocked(readAssignedSlugsForGateway).mockResolvedValueOnce([]);
    mocks.state.gateways.set("bender", isolatedGateway({
      latestRelease: 1,
      desiredRelease: 1,
      liveRelease: null,
      liveRevisionId: null,
      trafficRevisionId: null,
    }));

    const res = await request(app("bender", "bender"))
      .post("/internal/gitea/ensure-user")
      .send({ slug: "acme", pubKey: "ssh-ed25519 AAA" });

    expect(res.status).toBe(204);
    expect(giteaAdmin.ensureGiteaUser).toHaveBeenCalledWith(
      "acme",
      "ssh-ed25519 AAA",
      BENDER_KEY_OWNER,
    );
  });

  it("denies bootstrap without an authenticated pod identity", async () => {
    vi.mocked(readAssignedSlugsForGateway).mockResolvedValueOnce([]);
    mocks.state.gateways.set("bender", isolatedGateway());

    const res = await request(app("bender", null))
      .post("/internal/gitea/ensure-user")
      .send({ slug: "acme", pubKey: "ssh-ed25519 AAA" });

    expect(res.status).toBe(403);
    expect(giteaAdmin.ensureGiteaUser).not.toHaveBeenCalled();
  });

  it.each([
    { desiredStatus: "retired" },
    { retireAfter: 10 },
    { retirementClaim: { operationId: "retire-1", version: 1 } },
  ])("keeps configured-builder bootstrap identity-pure across lifecycle state: %o", async (override) => {
    vi.mocked(readAssignedSlugsForGateway).mockResolvedValueOnce([]);
    mocks.state.gateways.set("bender", isolatedGateway(override));

    const res = await request(app())
      .post("/internal/gitea/ensure-user")
      .send({ slug: "acme", pubKey: "ssh-ed25519 AAA" });

    expect(res.status).toBe(204);
    expect(giteaAdmin.ensureGiteaUser).toHaveBeenCalledWith(
      "acme",
      "ssh-ed25519 AAA",
      BENDER_KEY_OWNER,
    );
  });

  it("denies unassigned slugs when the inbound migration helper does not allow them", async () => {
    vi.mocked(readAssignedSlugsForGateway).mockResolvedValueOnce([]);

    const res = await authed(
      request(app()).get("/internal/gitea/user-pubkey").query({ slug: "acme" }),
    );

    expect(res.status).toBe(403);
    expect(hasRunningInboundMigrationForSlug).toHaveBeenCalledWith(
      expect.anything(),
      "bender",
      "acme",
    );
    expect(giteaAdmin.readGiteaUserPubKey).not.toHaveBeenCalled();
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

  it("user-pubkey keeps the singular response for a predecessor image during a roll", async () => {
    const res = await authed(request(app()).get("/internal/gitea/user-pubkey").query({ slug: "acme" }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pubKey: "ssh-ed25519 OLD predecessor" });
    expect(giteaAdmin.readGiteaUserPubKey).toHaveBeenCalledWith("acme");
  });

  it("user-pubkey → 200 { pubKey: null } when no managed key exists", async () => {
    vi.mocked(giteaAdmin.readGiteaUserPubKey).mockResolvedValueOnce(null);
    const res = await authed(request(app()).get("/internal/gitea/user-pubkey").query({ slug: "acme" }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pubKey: null });
  });

  it("user-pubkeys → 200 { pubKeys } for surge-safe membership checks", async () => {
    const res = await authed(request(app()).get("/internal/gitea/user-pubkeys").query({ slug: "acme" }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      pubKeys: ["ssh-ed25519 OLD predecessor", "ssh-ed25519 KEY octogee"],
    });
    expect(giteaAdmin.readGiteaUserPubKeys).toHaveBeenCalledWith("acme");
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
