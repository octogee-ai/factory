import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { acquireWorkspaceMutationLeaseSync } from "@octogee/core/workspace-mutation-lease";
import { workspaceMutationLeaseGitDir } from "./workspace-git.js";
import {
  cloneGithubProjectCheckout,
  githubCloneCredentialEnv,
} from "./github-project-clone.js";

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawn: vi.fn(original.spawn) };
});

const { spawn: realSpawn } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(spawn).mockReset().mockImplementation(realSpawn);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function seedProjectPlaceholder() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "github-project-checkout-"));
  roots.push(root);
  const customersRoot = path.join(root, "customers");
  vi.stubEnv("CUSTOMERS_DIR", customersRoot);
  const destination = path.join(customersRoot, "alice", "projects", "octo");
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(destination, "SOUL.md"), "preserve this identity\n");
  const source = path.join(root, "source");
  fs.mkdirSync(source);
  execFileSync("git", ["init", "-q", "-b", "main", source]);
  fs.writeFileSync(path.join(source, "README.md"), "canonical project\n");
  execFileSync("git", ["add", "README.md"], { cwd: source });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial"], { cwd: source });
  vi.mocked(spawn).mockImplementationOnce((command, args, options) => realSpawn(command, [
    ...args!.map((arg) => {
      if (arg === "https://github.com/octogee-ai/octogee.git") return source;
      if (arg === "protocol.file.allow=never") return "protocol.file.allow=always";
      return arg;
    }),
  ], options));
  const input = { customersRoot, builderSlug: "alice", projectSlug: "octo",
    repository: { owner: "octogee-ai", repo: "octogee" }, accessToken: "test-token" };
  return { root, destination, input };
}

describe("GitHub project clone broker", () => {
  it("installs a checkout over a template-only directory and preserves its files in quarantine", async () => {
    const { root, destination, input } = seedProjectPlaceholder();

    await expect(cloneGithubProjectCheckout(input)).resolves.toBe("cloned");

    expect(fs.readFileSync(path.join(destination, "README.md"), "utf8")).toBe("canonical project\n");
    expect(fs.statSync(path.join(destination, ".git")).isDirectory()).toBe(true);
    const quarantine = path.join(root, "git-worktree-quarantine", "alice");
    const saved = fs.readdirSync(quarantine);
    expect(saved).toHaveLength(1);
    expect(fs.readFileSync(path.join(quarantine, saved[0]!, "SOUL.md"), "utf8"))
      .toBe("preserve this identity\n");
    expect(await cloneGithubProjectCheckout(input)).toBe("exists");
  });

  it("preserves the placeholder when another project mutation owns its external lease", async () => {
    const { destination, input } = seedProjectPlaceholder();
    const lease = acquireWorkspaceMutationLeaseSync({
      workspaceDir: destination,
      gitDir: workspaceMutationLeaseGitDir(destination),
    });
    expect(lease).not.toBeNull();
    try {
      await expect(cloneGithubProjectCheckout(input)).rejects.toThrow("workspace mutation lease unavailable");
      expect(fs.readFileSync(path.join(destination, "SOUL.md"), "utf8")).toBe("preserve this identity\n");
      expect(fs.readdirSync(path.dirname(destination))).toEqual(["octo"]);
    } finally {
      lease?.release();
    }
  });

  it("keeps the clone credential in an environment variable for a scoped Git helper", () => {
    expect(githubCloneCredentialEnv("gho_secret")).toEqual({
      OCTOGEE_GITHUB_TOKEN: "gho_secret",
    });
  });

  it("rejects an unsafe destination before attempting a clone", async () => {
    await expect(cloneGithubProjectCheckout({
      customersRoot: "/tmp/customers",
      builderSlug: "../alice",
      projectSlug: "octo",
      repository: { owner: "octogee-ai", repo: "octogee" },
      accessToken: "gho_secret",
    })).rejects.toThrow("invalid GitHub project clone request");
  });
});
