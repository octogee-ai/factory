import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  resolveCustomerDir: vi.fn(),
  resolveProjectDir: vi.fn(),
  commitAndPushWorkspace: vi.fn(),
  isSafeSlug: vi.fn(),
  resolveCommitAuthor: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));

vi.mock("../lib/workspace-git.js", () => ({
  resolveCustomerDir: h.resolveCustomerDir,
  resolveProjectDir: h.resolveProjectDir,
  commitAndPushWorkspace: h.commitAndPushWorkspace,
  isSafeSlug: h.isSafeSlug,
}));

vi.mock("../routes/workspace/helpers.js", () => ({
  resolveCommitAuthor: h.resolveCommitAuthor,
}));

vi.mock("../middleware/logging.js", () => ({
  logger: { warn: h.warn, info: h.info },
}));

import workspaceCommitRouter from "../routes/internal/workspace-commit.js";

const originalCustomersDir = process.env.CUSTOMERS_DIR;

function app() {
  const server = express();
  server.use(express.json());
  server.use("/internal/workspace", workspaceCommitRouter);
  return server;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.isSafeSlug.mockImplementation((slug: string) => /^[a-z0-9-]+$/.test(slug));
  h.resolveCustomerDir.mockResolvedValue("/customers/acme");
  h.resolveCommitAuthor.mockReturnValue({ name: "Octogee Agent", email: "agent@octogee.test" });
  h.commitAndPushWorkspace.mockResolvedValue({
    ok: true,
    result: { committed: true, pushed: true, nothingToCommit: false },
  });
});

afterEach(() => {
  if (originalCustomersDir === undefined) {
    delete process.env.CUSTOMERS_DIR;
  } else {
    process.env.CUSTOMERS_DIR = originalCustomersDir;
  }
});

describe("internal workspace commit route", () => {
  it("rejects invalid slugs and oversized commit messages before touching the workspace", async () => {
    await request(app()).post("/internal/workspace/commit").send({ slug: "not valid" }).expect(400, {
      error: "Invalid slug",
      code: "BAD_SLUG",
    });
    await request(app())
      .post("/internal/workspace/commit")
      .send({ slug: "acme", message: "x".repeat(5_001) })
      .expect(400, {
        error: "Commit message too long",
        code: "MESSAGE_TOO_LONG",
      });

    expect(h.resolveCustomerDir).not.toHaveBeenCalled();
    expect(h.commitAndPushWorkspace).not.toHaveBeenCalled();
  });

  it("returns a retryable 503 when the customer working tree is unavailable", async () => {
    h.resolveCustomerDir.mockResolvedValue(null);

    await request(app()).post("/internal/workspace/commit").send({ slug: "acme" }).expect(503, {
      error: "Working tree temporarily unavailable; retry shortly.",
      code: "CUSTOMER_DIR_MISSING",
    });

    expect(h.warn).toHaveBeenCalledWith(expect.stringContaining("working tree not accessible slug=acme"));
    expect(h.commitAndPushWorkspace).not.toHaveBeenCalled();
  });

  it("commits with a trimmed message and resolved agent author", async () => {
    const res = await request(app())
      .post("/internal/workspace/commit")
      .send({ slug: "acme", message: "  checkpoint work  " })
      .expect(200);

    expect(h.resolveCustomerDir).toHaveBeenCalledWith("/home/node/.openclaw/customers", "acme");
    expect(h.resolveCommitAuthor).toHaveBeenCalledWith(undefined, "acme");
    expect(h.commitAndPushWorkspace).toHaveBeenCalledWith("/customers/acme", {
      message: "checkpoint work",
      author: { name: "Octogee Agent", email: "agent@octogee.test" },
      excludePathspecs: ["projects"],
    });
    expect(res.body).toEqual({ committed: true, pushed: true, nothingToCommit: false });
    expect(h.info).toHaveBeenCalledWith(expect.stringContaining("internal/workspace/commit slug=acme"));
  });

  it("uses the default commit message and custom customer root when no message is provided", async () => {
    process.env.CUSTOMERS_DIR = "/custom/customers";

    await request(app()).post("/internal/workspace/commit").send({ slug: "acme" }).expect(200);

    expect(h.resolveCustomerDir).toHaveBeenCalledWith("/custom/customers", "acme");
    expect(h.commitAndPushWorkspace).toHaveBeenCalledWith("/customers/acme", expect.objectContaining({
      message: "agent: workspace commit",
    }));

    delete process.env.CUSTOMERS_DIR;
  });

  it("returns git command failures and logs push-only failures", async () => {
    h.commitAndPushWorkspace.mockResolvedValueOnce({ ok: false, error: { code: "COMMIT_FAILED" } });

    await request(app()).post("/internal/workspace/commit").send({ slug: "acme" }).expect(500, {
      error: "git command failed",
      code: "COMMIT_FAILED",
    });
    expect(h.warn).toHaveBeenCalledWith(expect.stringContaining("git error slug=acme code=COMMIT_FAILED"));

    h.commitAndPushWorkspace.mockResolvedValueOnce({
      ok: true,
      result: { committed: true, pushed: false, nothingToCommit: false, pushError: "rejected" },
    });
    await request(app()).post("/internal/workspace/commit").send({ slug: "acme" }).expect(200, {
      committed: true,
      pushed: false,
      nothingToCommit: false,
    });
    expect(h.warn).toHaveBeenCalledWith(expect.stringContaining("committed but push failed slug=acme: rejected"));
  });

  it("returns a retryable conflict while an import holds the workspace lease", async () => {
    h.commitAndPushWorkspace.mockResolvedValueOnce({
      ok: false,
      error: { code: "WORKSPACE_BUSY", cwd: "/customers/acme" },
    });

    const response = await request(app()).post("/internal/workspace/commit").send({ slug: "acme" }).expect(409, {
      error: "Workspace is busy; retry shortly.",
      code: "WORKSPACE_BUSY",
    });

    expect(response.body.code).toBe("WORKSPACE_BUSY");
  });
});

describe("internal workspace commit route — Vegas project lane", () => {
  it("commits the project clone when a project is given", async () => {
    h.resolveProjectDir.mockResolvedValue("/customers/acme/projects/orbit");

    await request(app())
      .post("/internal/workspace/commit")
      .send({ slug: "acme", project: "orbit", message: "checkpoint" })
      .expect(200);

    expect(h.resolveProjectDir).toHaveBeenCalledWith(process.env.CUSTOMERS_DIR || "/home/node/.openclaw/customers", "acme", "orbit");
    expect(h.commitAndPushWorkspace).toHaveBeenCalledWith(
      "/customers/acme/projects/orbit",
      expect.objectContaining({ message: "checkpoint" }),
    );
    const options = h.commitAndPushWorkspace.mock.calls[0][1] as { excludePathspecs?: string[] };
    expect(options.excludePathspecs).toBeUndefined();
  });

  it("rejects malformed project ids before touching the tree", async () => {
    await request(app())
      .post("/internal/workspace/commit")
      .send({ slug: "acme", project: "Not-Valid!" })
      .expect(400, { error: "Invalid project", code: "BAD_PROJECT" });

    expect(h.commitAndPushWorkspace).not.toHaveBeenCalled();
  });

  it("503s when the project clone is missing, without committing the workspace instead", async () => {
    h.resolveProjectDir.mockResolvedValue(null);

    await request(app())
      .post("/internal/workspace/commit")
      .send({ slug: "acme", project: "orbit" })
      .expect(503);

    expect(h.commitAndPushWorkspace).not.toHaveBeenCalled();
  });
});
