import * as fs from "node:fs/promises";
import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readProjectRestoreReady, writeProjectRestoreReady, withMaterializedProjectAssets, withProjectAssetManifest } from "./project-asset-state.js";

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

  it("binds readiness to manifest content while retaining unaffected materialized assets", async () => {
    const prefix = "customers/alice/projects/demo";
    const entry = { type: "blob" as const, gcsPath: `${prefix}/asset.bin`, size: 3, mimeType: "application/octet-stream", uploadedAt: "first" };
    const manifest = JSON.stringify({ "asset.bin": entry });
    await mkdir(path.join(root, ".files"));
    await writeFile(path.join(root, ".files/manifest.json"), manifest);
    await writeProjectRestoreReady(root, "alice", "demo");
    await withMaterializedProjectAssets(root, prefix, async files => { files["asset.bin"] = entry; });
    await writeFile(path.join(root, "README.md"), "unrelated text change");
    await writeFile(path.join(root, ".files/manifest.json"), manifest);
    expect(await readProjectRestoreReady(root, "alice", "demo")).toBe(true);
    expect(await withMaterializedProjectAssets(root, prefix, async files => files)).toEqual({ "asset.bin": entry });

    await writeFile(path.join(root, ".files/manifest.json"), JSON.stringify({ "asset.bin": { ...entry, uploadedAt: "second" } }));

    expect(await readProjectRestoreReady(root, "alice", "demo")).toBe(false);
    expect(await withMaterializedProjectAssets(root, prefix, async files => files)).toEqual({ "asset.bin": entry });
    await writeProjectRestoreReady(root, "alice", "demo");
    expect(await readProjectRestoreReady(root, "alice", "demo")).toBe(true);
  });

  it("keeps owned local manifest edits restored with matching materialized receipts", async () => {
    const prefix = "customers/alice/projects/demo";
    const entry = { type: "blob" as const, gcsPath: `${prefix}/asset.bin`, size: 3, mimeType: "application/octet-stream", uploadedAt: "first" };
    await writeProjectRestoreReady(root, "alice", "demo");

    await withProjectAssetManifest(root, prefix, async manifest => {
      manifest["asset.bin"] = entry;
      await withMaterializedProjectAssets(root, prefix, async files => { files["asset.bin"] = entry; });
    });

    expect(await readProjectRestoreReady(root, "alice", "demo")).toBe(true);
    expect(await withMaterializedProjectAssets(root, prefix, async files => files)).toEqual({ "asset.bin": entry });
  });

  it.each(["absent", "stale"])("does not create readiness for an %s receipt through local manifest edits", async state => {
    const prefix = "customers/alice/projects/demo";
    if (state === "stale") {
      await writeProjectRestoreReady(root, "alice", "demo");
      await mkdir(path.join(root, ".files"));
      await writeFile(path.join(root, ".files/manifest.json"), "{}");
    }
    await withProjectAssetManifest(root, prefix, async manifest => {
      manifest["asset.bin"] = { type: "blob", gcsPath: `${prefix}/asset.bin`, size: 3, mimeType: "application/octet-stream", uploadedAt: "first" };
    });
    expect(await readProjectRestoreReady(root, "alice", "demo")).toBe(false);
  });

  it.each(["callback", "publication"])("does not renew readiness after a local manifest %s failure", async phase => {
    const prefix = "customers/alice/projects/demo";
    await writeProjectRestoreReady(root, "alice", "demo");
    const receipt = path.join(parent, ".octogee-state/demo.json");
    const before = await fs.readFile(receipt, "utf8");
    if (phase === "publication") {
      const renameFile = fs.rename;
      vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
        if (String(destination).endsWith("/manifest.json")) throw new Error("publication failed");
        await renameFile(source, destination);
      });
    }
    await expect(withProjectAssetManifest(root, prefix, async manifest => {
      manifest["asset.bin"] = { type: "blob", gcsPath: `${prefix}/asset.bin`, size: 3, mimeType: "application/octet-stream", uploadedAt: "first" };
      if (phase === "callback") throw new Error("callback failed");
    })).rejects.toThrow(`${phase} failed`);
    expect(await fs.readFile(receipt, "utf8")).toBe(before);
  });

  it("distinguishes absent manifests without creating asset directories during readiness reads", async () => {
    await writeProjectRestoreReady(root, "alice", "demo");
    await mkdir(path.join(root, ".files"));
    await writeFile(path.join(root, ".files/manifest.json"), "{}");
    expect(await readProjectRestoreReady(root, "alice", "demo")).toBe(false);
    await writeProjectRestoreReady(root, "alice", "demo");
    await rm(path.join(root, ".files"), { recursive: true });
    expect(await readProjectRestoreReady(root, "alice", "demo")).toBe(false);
    expect(await fs.readdir(root)).toEqual([".git"]);
  });

  it.each(["directory", "manifest"])("rejects a substituted %s symlink when reading asset identity", async kind => {
    await mkdir(path.join(root, ".files"));
    await writeFile(path.join(root, ".files/manifest.json"), "{}");
    await writeProjectRestoreReady(root, "alice", "demo");
    const original = path.join(root, kind === "directory" ? ".files" : ".files/manifest.json");
    const outside = path.join(parent, "outside");
    await rename(original, outside);
    await symlink(outside, original);
    await expect(readProjectRestoreReady(root, "alice", "demo")).rejects.toThrow();
    await expect(writeProjectRestoreReady(root, "alice", "demo")).rejects.toThrow();
  });

  it("rejects an oversized manifest before accepting restore readiness", async () => {
    await writeProjectRestoreReady(root, "alice", "demo");
    await mkdir(path.join(root, ".files"));
    await writeFile(path.join(root, ".files/manifest.json"), Buffer.alloc(10 * 1024 * 1024 + 1));
    await expect(readProjectRestoreReady(root, "alice", "demo")).rejects.toThrow("invalid project asset state file");
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
