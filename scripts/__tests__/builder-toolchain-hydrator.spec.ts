import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  extractToolchainArchive,
  hydrateBuilderToolchain,
  readToolchainStatus,
  runBuilderToolchainHydrationLoop,
  type BuilderToolchainManifest,
} from "../lib/builder-toolchain-hydrator.js";
import { resolveToolchainCommand } from "../lib/builder-toolchain-wrapper.js";
import { runBuilderToolchainCommand } from "../entrypoints/builder-toolchain-command.js";

const tempRoots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "octogee-toolchain-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function manifestFor(archive: Uint8Array): BuilderToolchainManifest {
  return {
    schemaVersion: 1,
    id: "acp-2026-08-30",
    artifact: {
      format: "tar.gz",
      sha256: sha256(archive),
      sizeBytes: archive.byteLength,
      unpackedSizeBytes: 32,
    },
    commands: {
      claude: "bin/claude",
      codex: "bin/codex",
    },
  };
}

async function writePinnedManifest(
  root: string,
  manifest: BuilderToolchainManifest,
): Promise<{ manifestPath: string; manifestSha256: string }> {
  const raw = `${JSON.stringify(manifest)}\n`;
  const manifestPath = path.join(root, "manifest.json");
  await fs.writeFile(manifestPath, raw);
  return { manifestPath, manifestSha256: sha256(raw) };
}

async function fakeExtract(input: { destination: string }): Promise<{ unpackedSizeBytes: number }> {
  await fs.mkdir(path.join(input.destination, "bin"), { recursive: true });
  await fs.writeFile(path.join(input.destination, "bin", "claude"), "#!/bin/sh\necho claude\n");
  await fs.writeFile(path.join(input.destination, "bin", "codex"), "#!/bin/sh\necho codex\n");
  return { unpackedSizeBytes: 32 };
}

describe("Builder toolchain hydration", () => {
  it("verifies both pins, streams under HOME, publishes state, and atomically activates once", async () => {
    const home = await tempRoot();
    const root = path.join(home, ".octogee", "toolchains");
    const archive = new TextEncoder().encode("immutable-toolchain");
    const manifest = manifestFor(archive);
    const pin = await writePinnedManifest(home, manifest);
    const published: string[] = [];
    const fetchArtifact = vi.fn(async () => new Response(archive, { status: 200 }));

    await expect(hydrateBuilderToolchain({
      root,
      ...pin,
      artifactUrl: "https://artifacts.example.test/acp.tar.gz?signature=secret",
      fetchArtifact,
      extractArchive: fakeExtract,
      publishStatus: async (status) => { published.push(status.status); },
    })).resolves.toMatchObject({ status: "ready" });

    expect(fetchArtifact).toHaveBeenCalledTimes(1);
    expect(published).toEqual(["downloading", "verifying", "ready"]);
    expect(await fs.readlink(path.join(root, "active"))).toBe(
      `objects/sha256-${manifest.artifact.sha256}`,
    );
    expect(await fs.stat(path.join(root, "objects", `sha256-${manifest.artifact.sha256}`, "bin", "claude")))
      .toMatchObject({ mode: expect.any(Number) });
    const status = await readToolchainStatus(root);
    expect(status).toEqual({
      schemaVersion: 1,
      status: "ready",
      updatedAt: expect.any(String),
    });
    expect(Object.keys(status!)).toHaveLength(3);
    expect(JSON.stringify(status)).not.toContain("signature=secret");

    await expect(hydrateBuilderToolchain({
      root,
      ...pin,
      artifactUrl: "https://artifacts.example.test/acp.tar.gz?signature=expired",
      fetchArtifact: async () => { throw new Error("must not fetch an active digest"); },
      extractArchive: fakeExtract,
    })).resolves.toMatchObject({ status: "ready" });
  });

  it("keeps local activation successful when remote status publication fails", async () => {
    const home = await tempRoot();
    const root = path.join(home, ".octogee", "toolchains");
    const archive = new TextEncoder().encode("immutable-toolchain");
    const manifest = manifestFor(archive);
    const pin = await writePinnedManifest(home, manifest);
    const log = vi.fn();

    await expect(hydrateBuilderToolchain({
      root,
      ...pin,
      artifactUrl: "https://artifacts.example.test/acp.tar.gz",
      fetchArtifact: async () => new Response(archive),
      extractArchive: fakeExtract,
      publishStatus: async () => { throw new Error("broker unavailable"); },
      log,
    })).resolves.toMatchObject({ status: "ready" });

    expect(log).toHaveBeenCalledWith(expect.stringMatching(/status publication failed/));
    await expect(readToolchainStatus(root)).resolves.toMatchObject({ status: "ready" });
  });

  it("fails closed without activation when the archive digest does not match", async () => {
    const home = await tempRoot();
    const root = path.join(home, ".octogee", "toolchains");
    const expected = new TextEncoder().encode("expected");
    const manifest = manifestFor(expected);
    const pin = await writePinnedManifest(home, manifest);

    await expect(hydrateBuilderToolchain({
      root,
      ...pin,
      artifactUrl: "https://artifacts.example.test/acp.tar.gz",
      fetchArtifact: async () => new Response("tampered", { status: 200 }),
      extractArchive: fakeExtract,
    })).rejects.toMatchObject({ reasonCode: "artifact-digest-mismatch" });

    await expect(fs.lstat(path.join(root, "active"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readToolchainStatus(root)).resolves.toMatchObject({
      schemaVersion: 1,
      status: "failed",
      updatedAt: expect.any(String),
    });
  });

  it("rejects an unpinned manifest and non-HTTPS artifact before network access", async () => {
    const home = await tempRoot();
    const root = path.join(home, ".octogee", "toolchains");
    const archive = new TextEncoder().encode("archive");
    const pin = await writePinnedManifest(home, manifestFor(archive));
    const fetchArtifact = vi.fn();

    await expect(hydrateBuilderToolchain({
      root,
      ...pin,
      manifestSha256: "0".repeat(64),
      artifactUrl: "https://artifacts.example.test/acp.tar.gz",
      fetchArtifact,
      extractArchive: fakeExtract,
    })).rejects.toMatchObject({ reasonCode: "manifest-digest-mismatch" });
    expect(fetchArtifact).not.toHaveBeenCalled();

    await expect(hydrateBuilderToolchain({
      root,
      ...pin,
      artifactUrl: "http://registry.example.test/acp.tar.gz",
      fetchArtifact,
      extractArchive: fakeExtract,
    })).rejects.toMatchObject({ reasonCode: "invalid-artifact-url" });
    expect(fetchArtifact).not.toHaveBeenCalled();
  });

  it("leaves a fresh concurrent lock alone and reports pending rather than racing activation", async () => {
    const home = await tempRoot();
    const root = path.join(home, ".octogee", "toolchains");
    const archive = new TextEncoder().encode("archive");
    const pin = await writePinnedManifest(home, manifestFor(archive));
    await fs.mkdir(path.join(root, ".hydrate.lock"), { recursive: true });

    await expect(hydrateBuilderToolchain({
      root,
      ...pin,
      artifactUrl: "https://artifacts.example.test/acp.tar.gz",
      fetchArtifact: async () => new Response(archive),
      extractArchive: fakeExtract,
    })).resolves.toMatchObject({ status: "pending" });
  });

  it("replaces a corrupt object for the pinned digest instead of getting stuck across retries", async () => {
    const home = await tempRoot();
    const root = path.join(home, ".octogee", "toolchains");
    const archive = new TextEncoder().encode("archive");
    const manifest = manifestFor(archive);
    const pin = await writePinnedManifest(home, manifest);
    const objectPath = path.join(root, "objects", `sha256-${manifest.artifact.sha256}`);
    await fs.mkdir(objectPath, { recursive: true });
    await fs.writeFile(path.join(objectPath, "partial"), "interrupted");

    await expect(hydrateBuilderToolchain({
      root,
      ...pin,
      artifactUrl: "https://artifacts.example.test/acp.tar.gz",
      fetchArtifact: async () => new Response(archive),
      extractArchive: fakeExtract,
    })).resolves.toMatchObject({ status: "ready" });
    await expect(fs.lstat(path.join(objectPath, "partial"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("waits for interactive readiness, retries with backoff, and never turns hydration into readiness", async () => {
    const states: string[] = [];
    const probes = [false, false, true];
    const hydrate = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("transient"), { reasonCode: "download-failed" }))
      .mockResolvedValue({
        schemaVersion: 1,
        status: "ready",
        updatedAt: "2026-08-30T00:00:00.000Z",
      });
    const sleeps: number[] = [];

    await runBuilderToolchainHydrationLoop({
      probeInteractiveReadiness: async () => probes.shift() ?? true,
      hydrate,
      writeStatus: async (status) => { states.push(status); },
      sleep: async (ms) => { sleeps.push(ms); },
      waitAfterReady: async () => {},
      initialBackoffMs: 1_000,
      maxBackoffMs: 8_000,
    });

    expect(hydrate).toHaveBeenCalledTimes(2);
    expect(states).toEqual(["pending"]);
    expect(sleeps).toEqual([1_000, 1_000, 1_000]);
  });
});

describe("Builder toolchain archive boundary", () => {
  it("rejects links and traversal entries instead of extracting them", async () => {
    const home = await tempRoot();
    const archivePath = path.join(home, "unsafe.tar.gz");
    const destination = path.join(home, "out");
    const tar = await import("tar");
    await fs.mkdir(path.join(home, "source"));
    await fs.symlink("../../outside", path.join(home, "source", "escape"));
    await tar.c({ cwd: path.join(home, "source"), gzip: true, file: archivePath }, ["escape"]);

    await expect(extractToolchainArchive({
      archivePath,
      destination,
      expectedUnpackedSizeBytes: 0,
    })).rejects.toMatchObject({ reasonCode: "unsafe-archive" });
    await expect(fs.lstat(path.join(destination, "escape"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("Builder toolchain stable wrappers", () => {
  it("reports loading/unavailable states with stable exit codes instead of ENOENT", async () => {
    const root = await tempRoot();
    await fs.writeFile(path.join(root, "status.json"), JSON.stringify({
      schemaVersion: 1,
      status: "downloading",
      updatedAt: "2026-08-30T00:00:00.000Z",
    }));

    await expect(resolveToolchainCommand({ root, command: "claude" })).resolves.toMatchObject({
      kind: "loading",
      exitCode: 75,
      message: expect.stringMatching(/loading/i),
    });

    await fs.writeFile(path.join(root, "status.json"), JSON.stringify({
      schemaVersion: 1,
      status: "failed",
      updatedAt: "2026-08-30T00:00:01.000Z",
    }));
    await fs.writeFile(path.join(root, "detail.json"), JSON.stringify({
      schemaVersion: 1,
      status: "failed",
      reasonCode: "download-failed",
    }));
    await expect(resolveToolchainCommand({ root, command: "codex" })).resolves.toMatchObject({
      kind: "unavailable",
      exitCode: 69,
      message: expect.stringMatching(/unavailable.*download-failed/i),
    });
  });

  it("executes the active payload and preserves its exit status", async () => {
    const home = await tempRoot();
    const root = path.join(home, ".octogee", "toolchains");
    const digest = "a".repeat(64);
    const objectPath = path.join(root, "objects", `sha256-${digest}`);
    const manifest = manifestFor(new TextEncoder().encode("irrelevant"));
    manifest.artifact.sha256 = digest;
    await fs.mkdir(path.join(objectPath, "bin"), { recursive: true });
    await fs.writeFile(path.join(objectPath, "bin", "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await fs.writeFile(path.join(objectPath, "bin", "codex"), "#!/bin/sh\nexit 7\n", { mode: 0o755 });
    await fs.writeFile(path.join(objectPath, ".toolchain-manifest.json"), JSON.stringify(manifest));
    await fs.symlink(`objects/sha256-${digest}`, path.join(root, "active"));
    await fs.writeFile(path.join(root, "status.json"), JSON.stringify({
      schemaVersion: 1,
      status: "ready",
      updatedAt: "2026-08-30T00:00:00.000Z",
    }));
    await fs.writeFile(path.join(root, "detail.json"), JSON.stringify({
      schemaVersion: 1,
      status: "ready",
      artifactSha256: digest,
    }));

    await expect(runBuilderToolchainCommand(["codex"], { HOME: home })).resolves.toBe(7);
  });
});
