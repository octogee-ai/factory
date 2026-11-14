import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createBrokeredProjectBlobHydrator, type ProjectBlobHydrationClient } from "./project-blob-materialization.js";
import { readProjectRestoreReady, withMaterializedProjectAssets } from "./project-asset-state.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

it.skipIf(process.platform !== "linux").each(["equal", "different", "identity", "generation", "checksum", "changed-local", "quota"] as const)("verifies an existing mutable project asset without replacing local bytes: %s", async scenario => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "project-imported-asset-"));
  roots.push(root);
  await fs.mkdir(path.join(root, ".git"));
  await fs.mkdir(path.join(root, ".files"));
  const original = Buffer.from(scenario === "different" ? "local work" : "avatar bytes");
  const remote = Buffer.from("avatar bytes");
  const entry = { type: "blob", gcsPath: "customers/alice/projects/demo/agent-avatar.png", size: remote.length, mimeType: "image/png", uploadedAt: "2026-10-23" };
  const file = path.join(root, "agent-avatar.png");
  await fs.writeFile(file, original);
  await fs.writeFile(path.join(root, ".files/manifest.json"), JSON.stringify({ "agent-avatar.png": entry }));
  const before = await fs.stat(file, { bigint: true });
  // eslint-disable-next-line sonarjs/hashing -- fixture matches the GCS integrity checksum
  const checksum = createHash("md5").update(remote).digest("base64");
  const client = { workspaceManifestReadUrl: vi.fn(), blobMaterializationReadUrl: vi.fn<ProjectBlobHydrationClient["blobMaterializationReadUrl"]>(async () => ({
    generation: "17", size: remote.length, md5Hash: checksum,
    download: { method: "GET", url: "https://signed.test/avatar", gcsPath: scenario === "identity" ? "customers/other/avatar.png" : entry.gcsPath, expiresAt: "later" },
  })) } satisfies ProjectBlobHydrationClient;
  vi.stubGlobal("fetch", vi.fn(async () => {
    if (scenario === "changed-local") await fs.writeFile(file, "new local bytes");
    return new Response(scenario === "checksum" ? Buffer.alloc(remote.length) : remote, { headers: { "x-goog-generation": scenario === "generation" ? "18" : "17" } });
  }));
  const hydrate = createBrokeredProjectBlobHydrator(client);
  const result = hydrate({ slug: "alice", project: "demo", destination: root, preserveExisting: true, allowDeferred: true, markRestoreReady: true, maxBytes: scenario === "quota" ? 1 : 1024 });
  if (scenario === "equal") {
    await expect(result).resolves.toMatchObject({ bytes: remote.length, files: 0 });
    expect(await readProjectRestoreReady(root, "alice", "demo")).toBe(true);
    expect(await withMaterializedProjectAssets(root, "customers/alice/projects/demo", async files => files)).toEqual({ "agent-avatar.png": entry });
    const after = await fs.stat(file, { bigint: true });
    expect([after.ino, after.mtimeNs, after.ctimeNs]).toEqual([before.ino, before.mtimeNs, before.ctimeNs]);
  } else {
    await expect(result).rejects.toThrow();
    expect(await readProjectRestoreReady(root, "alice", "demo")).toBe(false);
    expect(await withMaterializedProjectAssets(root, "customers/alice/projects/demo", async files => files)).toEqual({});
  }
  expect(await fs.readFile(file)).toEqual(scenario === "changed-local" ? Buffer.from("new local bytes") : original);
  expect(client.workspaceManifestReadUrl).not.toHaveBeenCalled();
  if (scenario === "quota") expect(client.blobMaterializationReadUrl).not.toHaveBeenCalled();
});
