import express from "express";
import request from "supertest";
import { beforeEach, expect, it, vi } from "vitest";
import type { FileTarget, ResolveFileTargetOpts } from "../lib/fileTarget.js";

const h = vi.hoisted(() => ({
  target: null as FileTarget | null,
  options: [] as ResolveFileTargetOpts[],
  gitPush: vi.fn(),
  resolveProjectDir: vi.fn(),
  runWorkspaceGitMutation: vi.fn(),
}));

vi.mock("../lib/fileTarget.js", () => ({
  withFileTarget: (
    handler: (...args: unknown[]) => unknown,
    options: ResolveFileTargetOpts = {},
  ) => {
    h.options.push(options);
    return (req: unknown, res: unknown, next: unknown) =>
      handler(req, res, next, h.target);
  },
}));

vi.mock("../lib/workspace-git.js", () => ({
  gitBranches: vi.fn(),
  gitCheckout: vi.fn(),
  gitCommit: vi.fn(),
  gitCommitDiff: vi.fn(),
  gitDiff: vi.fn(),
  gitLog: vi.fn(),
  gitPush: (...args: unknown[]) => h.gitPush(...args),
  gitStatus: vi.fn(),
  resolveCustomerDir: vi.fn(),
  resolveProjectDir: (...args: unknown[]) => h.resolveProjectDir(...args),
  runWorkspaceGitMutation: (...args: unknown[]) => h.runWorkspaceGitMutation(...args),
}));

vi.mock("../middleware/logging.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { default: workspaceGitRouter } = await import("../routes/workspace/git.js");

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use("/api/workspace", workspaceGitRouter);
  return instance;
}

beforeEach(() => {
  h.target = {
    slug: "alice",
    projectSlug: "orbit",
    provider: "github",
    org: "octogee-ai",
    repoName: "orbit",
    gcsPrefix: "customers/alice/projects/orbit",
    githubToken: "gh-member-token",
    brokered: true,
  };
  h.gitPush.mockReset().mockResolvedValue({ ok: true });
  h.resolveProjectDir.mockReset().mockResolvedValue("/customers/alice/projects/orbit");
  h.runWorkspaceGitMutation.mockReset().mockImplementation(async (_dir, work) => ({
    ok: true,
    result: await work(),
  }));
});

it("resolves a caller token for remote writes and passes it only to git push", async () => {
  const res = await request(app())
    .post("/api/workspace/git/push")
    .send({ branch: "feature/member" });

  expect(res.status).toBe(200);
  expect(h.options).toContainEqual({ access: "write", resolveGithubToken: true });
  expect(h.gitPush).toHaveBeenCalledWith("/customers/alice/projects/orbit", {
    branch: "feature/member",
    githubToken: "gh-member-token",
  });
});
