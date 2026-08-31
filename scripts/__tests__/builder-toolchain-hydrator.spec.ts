import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BuilderToolchainHydrationError,
  runBuilderToolchainHydrationLoop,
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

describe("Builder toolchain hydration loop", () => {
  it("waits for interactive readiness, retries with backoff, and never turns hydration into readiness", async () => {
    const states: string[] = [];
    const probes = [false, false, true];
    const hydrate = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("transient"), { reasonCode: "npm-install-failed" }))
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

  it("keeps assignment-gated credential retries on the initial cadence", async () => {
    const hydrate = vi.fn()
      .mockRejectedValueOnce(new BuilderToolchainHydrationError(
        "npm-proxy-credentials-unavailable",
      ))
      .mockRejectedValueOnce(new BuilderToolchainHydrationError(
        "npm-proxy-credentials-unavailable",
      ))
      .mockResolvedValue({
        schemaVersion: 1,
        status: "ready",
        updatedAt: "2026-08-30T00:00:00.000Z",
      });
    const sleeps: number[] = [];

    await runBuilderToolchainHydrationLoop({
      probeInteractiveReadiness: async () => true,
      hydrate,
      writeStatus: async () => {},
      sleep: async (ms) => { sleeps.push(ms); },
      waitAfterReady: async () => {},
      initialBackoffMs: 5_000,
      maxBackoffMs: 40_000,
    });

    expect(hydrate).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([5_000, 5_000]);
  });

  it("retries immutable ready publication without hydrating the toolchain again", async () => {
    const ready = {
      schemaVersion: 1 as const,
      status: "ready" as const,
      updatedAt: "2026-08-30T00:00:00.000Z",
    };
    const hydrate = vi.fn(async () => ready);
    const ensureReadyPublished = vi.fn()
      .mockRejectedValueOnce(new Error("assignment not cut over"))
      .mockResolvedValueOnce(undefined);
    const sleeps: number[] = [];

    await runBuilderToolchainHydrationLoop({
      probeInteractiveReadiness: async () => true,
      hydrate,
      ensureReadyPublished,
      writeStatus: async () => {},
      sleep: async (ms) => { sleeps.push(ms); },
      waitAfterReady: async () => {},
      initialBackoffMs: 5_000,
      maxBackoffMs: 40_000,
    });

    expect(hydrate).toHaveBeenCalledTimes(1);
    expect(ensureReadyPublished.mock.calls).toEqual([[ready], [ready]]);
    expect(sleeps).toEqual([5_000]);
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
      reasonCode: "npm-install-failed",
    }));
    await expect(resolveToolchainCommand({ root, command: "codex" })).resolves.toMatchObject({
      kind: "unavailable",
      exitCode: 69,
      message: expect.stringMatching(/unavailable.*npm-install-failed/i),
    });
  });

  it("executes an active npm bin and preserves its exit status", async () => {
    const home = await tempRoot();
    const root = path.join(home, ".octogee", "toolchains");
    const digest = "a".repeat(64);
    const objectPath = path.join(root, "objects", `sha256-${digest}`);
    await fs.mkdir(path.join(objectPath, "node_modules", ".bin"), { recursive: true });
    await fs.writeFile(path.join(objectPath, "node_modules", ".bin", "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await fs.writeFile(path.join(objectPath, "node_modules", ".bin", "codex"), "#!/bin/sh\nexit 7\n", { mode: 0o755 });
    await fs.writeFile(path.join(objectPath, ".toolchain-lock.json"), JSON.stringify({
      schemaVersion: 1,
      lockSha256: digest,
      commands: {
        claude: "node_modules/.bin/claude",
        codex: "node_modules/.bin/codex",
      },
    }));
    await fs.symlink(`objects/sha256-${digest}`, path.join(root, "active"));
    await fs.writeFile(path.join(root, "status.json"), JSON.stringify({
      schemaVersion: 1,
      status: "ready",
      updatedAt: "2026-08-30T00:00:00.000Z",
    }));
    await fs.writeFile(path.join(root, "detail.json"), JSON.stringify({
      schemaVersion: 1,
      status: "ready",
      lockSha256: digest,
    }));

    await expect(runBuilderToolchainCommand(["codex"], { HOME: home })).resolves.toBe(7);
  });
});
