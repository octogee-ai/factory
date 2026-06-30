import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileTarget } from "../lib/fileTarget.js";

const h = vi.hoisted(() => ({
  target: null as FileTarget | null,
  listIssues: vi.fn(),
  listLabels: vi.fn(),
  createIssue: vi.fn(),
  moveIssue: vi.fn(),
}));

vi.mock("../lib/fileTarget.js", () => ({
  withFileTarget:
    (handler: (...args: unknown[]) => unknown) =>
    (req: unknown, res: unknown, next: unknown) =>
      handler(req, res, next, h.target),
}));

vi.mock("../lib/issues.js", () => {
  class NotAnIssueError extends Error {
    constructor(num: number) {
      super(`#${num} is a pull request, not an issue`);
      this.name = "NotAnIssueError";
    }
  }

  return {
    listIssues: (...args: unknown[]) => h.listIssues(...args),
    listLabels: (...args: unknown[]) => h.listLabels(...args),
    createIssue: (...args: unknown[]) => h.createIssue(...args),
    moveIssue: (...args: unknown[]) => h.moveIssue(...args),
    NotAnIssueError,
  };
});

const { default: issuesRouter } = await import("../routes/workspace/issues.js");
const { NotAnIssueError } = await import("../lib/issues.js");

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/workspace", issuesRouter);
  return a;
}

function target(overrides: Partial<FileTarget> = {}): FileTarget {
  return {
    slug: "alice",
    projectSlug: "rocket",
    provider: "gitea",
    org: "octogee-alice",
    repoName: "rocket",
    gcsPrefix: "customers/alice/projects/rocket",
    sudoUser: "ws-alice",
    ...overrides,
  };
}

beforeEach(() => {
  h.target = target();
  h.listIssues.mockReset().mockResolvedValue([{ number: 1, title: "Ship", labels: [], state: "open" }]);
  h.listLabels.mockReset().mockResolvedValue([{ name: "status:todo", color: "c5def5" }]);
  h.createIssue.mockReset().mockResolvedValue({ number: 2, title: "New", labels: ["status:todo"], state: "open" });
  h.moveIssue.mockReset().mockResolvedValue({ number: 1, title: "Ship", labels: ["status:doing"], state: "open" });
});

describe("workspace issues route", () => {
  it("requires project-scoped targets for Board issue reads", async () => {
    h.target = target({ projectSlug: null });

    const res = await request(app()).get("/api/workspace/issues").expect(403);

    expect(res.body).toEqual({ error: "The Board is project-scoped", code: "PROJECT_ONLY" });
    expect(h.listIssues).not.toHaveBeenCalled();
  });

  it("returns issues and labels for project targets", async () => {
    const res = await request(app()).get("/api/workspace/issues").expect(200);

    expect(h.listIssues).toHaveBeenCalledWith(h.target);
    expect(h.listLabels).toHaveBeenCalledWith(h.target);
    expect(res.body).toEqual({
      issues: [{ number: 1, title: "Ship", labels: [], state: "open" }],
      labels: [{ name: "status:todo", color: "c5def5" }],
    });
  });

  it("validates create issue input before calling the provider", async () => {
    await request(app()).post("/api/workspace/issues").send({ title: "" }).expect(400, {
      error: "Missing title",
    });
    await request(app()).post("/api/workspace/issues").send({ title: "x".repeat(251) }).expect(400, {
      error: "Title too long",
    });
    await request(app()).post("/api/workspace/issues").send({ title: "New", status: "blocked" }).expect(400, {
      error: "Invalid column",
    });

    expect(h.createIssue).not.toHaveBeenCalled();
  });

  it("creates issues with trimmed titles and default backlog status", async () => {
    const res = await request(app()).post("/api/workspace/issues").send({ title: "  New  ", body: "Body" }).expect(201);

    expect(h.createIssue).toHaveBeenCalledWith(h.target, {
      title: "New",
      body: "Body",
      status: "backlog",
    });
    expect(res.body).toEqual({ issue: { number: 2, title: "New", labels: ["status:todo"], state: "open" } });
  });

  it("validates move input before calling the provider", async () => {
    await request(app()).patch("/api/workspace/issues/0/move").send({ status: "doing" }).expect(400, {
      error: "Invalid issue number",
    });
    await request(app()).patch("/api/workspace/issues/1/move").send({ status: "blocked" }).expect(400, {
      error: "Invalid column",
    });

    expect(h.moveIssue).not.toHaveBeenCalled();
  });

  it("moves issues and maps pull-request numbers to not found", async () => {
    const moved = await request(app()).patch("/api/workspace/issues/1/move").send({ status: "doing" }).expect(200);
    expect(h.moveIssue).toHaveBeenCalledWith(h.target, 1, "doing");
    expect(moved.body).toEqual({ issue: { number: 1, title: "Ship", labels: ["status:doing"], state: "open" } });

    h.moveIssue.mockRejectedValueOnce(new NotAnIssueError(2));
    await request(app()).patch("/api/workspace/issues/2/move").send({ status: "done" }).expect(404, {
      error: "Issue not found",
    });
  });
});
