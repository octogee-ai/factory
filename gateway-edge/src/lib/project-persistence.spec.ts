import { mkdtemp, mkdir, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { persistBuilderProjects } from "./project-persistence.js";
import { writeProjectRestoreReady } from "@octogee/core/project-asset-state";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "projects-save-"));
  await mkdir(path.join(root, "builder", "projects", "demo"), { recursive: true });
  await writeProjectRestoreReady(path.join(root, "builder/projects/demo"), "builder", "demo");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
function deps() {
  return { resolveProject: vi.fn(async (_root, slug, project): Promise<string | null> => path.join(root, slug, "projects", project)),
    githubToken: vi.fn(async () => undefined),
    divert: vi.fn(async () => ({ failures: [] as string[], failedPaths: [] as string[], diverted: [] })),
    commit: vi.fn(async (_dir, options) => {
      const prepared = await options.beforeCommit();
      return prepared.ok ? { ok: true, result: { pushed: true } } : prepared;
    }) };
}
describe("Builder project persistence", () => {
  it("does not save a replacement checkout before its own restoration completes", async () => {
    const dir = path.join(root, "builder/projects/demo");
    await rename(dir, path.join(root, "retained-demo"));
    await mkdir(dir);
    const d = deps();
    await expect(persistBuilderProjects({ root, slug: "builder" }, d)).rejects.toThrow(/restore/);
    expect(d.commit).not.toHaveBeenCalled();
    await writeProjectRestoreReady(dir, "builder", "demo");
    await expect(persistBuilderProjects({ root, slug: "builder" }, d)).resolves.toEqual({ projects: 1 });
  });
  it("refuses to save until project restoration has completed", async () => {
    await rm(path.join(root, "builder/projects/.octogee-state/demo.json"));
    const d = deps();
    await expect(persistBuilderProjects({ root, slug: "builder" }, d)).rejects.toThrow();
    expect(d.commit).not.toHaveBeenCalled();
  });
  it("uses the leased commit path and waits for remote binary storage before committing", async () => {
    const d = deps();
    expect(await persistBuilderProjects({ root, slug: "builder" }, d)).toEqual({ projects: 1 });
    expect(d.divert).toHaveBeenCalledWith(path.join(root, "builder/projects/demo"), { slug: "builder", projectSlug: "demo", gcsPrefix: "customers/builder/projects/demo" });
    expect(d.commit.mock.calls[0][1].message).toBe("autosave: project changes");
  });
  it("does not acknowledge a local commit whose remote push failed", async () => {
    const d = deps();
    d.commit.mockResolvedValue({ ok: true, result: { pushed: false, pushError: "remote unavailable" } });
    await expect(persistBuilderProjects({ root, slug: "builder" }, d)).rejects.toThrow(/remote/);
    d.commit.mockResolvedValue({ ok: true, result: { pushed: true } });
    await expect(persistBuilderProjects({ root, slug: "builder" }, d)).resolves.toEqual({ projects: 1 });
    expect(d.commit).toHaveBeenCalledTimes(2);
  });
  it("fails on binary save failure without creating a commit", async () => {
    const d = deps();
    d.divert.mockResolvedValue({ failures: ["offline"], failedPaths: ["asset.png"], diverted: [] });
    await expect(persistBuilderProjects({ root, slug: "builder" }, d)).rejects.toThrow(/BLOB_DIVERSION_FAILED/);
  });
  it("refuses missing repositories and symlinks instead of claiming they are backed up", async () => {
    const d = deps();
    d.resolveProject.mockResolvedValue(null);
    await expect(persistBuilderProjects({ root, slug: "builder" }, d)).rejects.toThrow(/repository/);
    await symlink(path.join(root, "builder/projects/demo"), path.join(root, "builder/projects/escape"));
    await expect(persistBuilderProjects({ root, slug: "builder" }, deps())).rejects.toThrow(/directory/);
  });
});
