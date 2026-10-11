import * as fs from "node:fs/promises";
import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readProjectRestoreReady, writeProjectRestoreReady } from "./project-asset-state.js";

vi.mock("node:fs/promises", async importOriginal => ({ ...await importOriginal<typeof import("node:fs/promises")>() }));

let parent: string;
let root: string;
describe.skipIf(process.platform !== "linux")("project checkout restore readiness", () => {
  beforeEach(async () => {
    parent = await mkdtemp(path.join(tmpdir(), "project-ready-"));
    root = path.join(parent, "demo");
    await mkdir(root);
  });
  afterEach(async () => { vi.restoreAllMocks(); await rm(parent, { recursive: true, force: true }); });

  it("does not create Git or restore-state directories when reading an empty placeholder", async () => {
    expect(await readProjectRestoreReady(root, "alice", "demo")).toBe(false);
    expect(await fs.readdir(root)).toEqual([]);
    expect(await fs.readdir(parent)).toEqual(["demo"]);
  });

  it("does not recreate a missing restore-state directory for an existing checkout", async () => {
    await writeProjectRestoreReady(root, "alice", "demo");
    await rm(path.join(parent, ".octogee-state"), { recursive: true });
    expect(await readProjectRestoreReady(root, "alice", "demo")).toBe(false);
    expect(await fs.readdir(parent)).toEqual(["demo"]);
  });

  it("requires restoration again after the checkout is replaced", async () => {
    expect(await readProjectRestoreReady(root, "alice", "demo")).toBe(false);
    await writeProjectRestoreReady(root, "alice", "demo");
    expect(await readProjectRestoreReady(root, "alice", "demo")).toBe(true);
    await rename(root, `${root}-quarantined`);
    await mkdir(root);
    expect(await readProjectRestoreReady(root, "alice", "demo")).toBe(false);
    await writeProjectRestoreReady(root, "alice", "demo");
    expect(await readProjectRestoreReady(root, "alice", "demo")).toBe(true);
  });

  it("shares readiness across container-specific inode and device numbers", async () => {
    await writeProjectRestoreReady(root, "alice", "demo");
    const lstat = fs.lstat;
    vi.spyOn(fs, "lstat").mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
      const stat = await lstat(...args);
      Object.assign(stat, { dev: Number(stat.dev) + 100, ino: Number(stat.ino) + 100 });
      return stat;
    }) as typeof fs.lstat);
    expect(await readProjectRestoreReady(root, "alice", "demo")).toBe(true);
    await rename(root, `${root}-old`);
    await mkdir(root);
    expect(await readProjectRestoreReady(root, "alice", "demo")).toBe(false);
  });

  it("shares readiness for external Git metadata but rehydrates a recreated checkout", async () => {
    const pointer = "gitdir: /private-metadata/project.git\n";
    await writeFile(path.join(root, ".git"), pointer);
    await writeProjectRestoreReady(root, "alice", "demo");
    expect(await readProjectRestoreReady(root, "alice", "demo")).toBe(true);
    expect(await fs.readFile(path.join(root, ".git"), "utf8")).toBe(pointer);
    await rename(root, `${root}-old`);
    await mkdir(root);
    await writeFile(path.join(root, ".git"), pointer);
    expect(await readProjectRestoreReady(root, "alice", "demo")).toBe(false);
  });

  it("rejects a symlink substituted for the restored checkout", async () => {
    await writeProjectRestoreReady(root, "alice", "demo");
    await rename(root, `${root}-quarantined`);
    await symlink(`${root}-quarantined`, root);
    await expect(readProjectRestoreReady(root, "alice", "demo")).rejects.toThrow(/directory/);
  });

  it("rejects another owner's restore marker", async () => {
    await writeProjectRestoreReady(root, "alice", "demo");
    await expect(readProjectRestoreReady(root, "bob", "demo")).rejects.toThrow(/owner/);
  });
});
