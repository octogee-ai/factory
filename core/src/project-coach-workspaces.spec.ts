import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectCoachRepoTransport, projectCoachWorkspace, restoreProjectCoachWorkspaces, saveProjectCoachWorkspaces } from "./project-coach-workspaces.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(await fs.realpath(tmpdir()), "project-coaches-test-"));
  roots.push(root);
  const remote = path.join(root, "project_coaches.git");
  execFileSync("/usr/bin/git", ["init", "--bare", "--initial-branch=main", remote]);
  const customerDir = path.join(root, "customers", "alice");
  const workspace = projectCoachWorkspace(customerDir, "orbit");
  await fs.mkdir(path.join(workspace, "memory"), { recursive: true });
  await fs.writeFile(path.join(workspace, "AGENTS.md"), "original instructions");
  await fs.writeFile(path.join(workspace, "IDENTITY.md"), "original persona");
  return { remote, customerDir, workspace, transport: { remote, ssh: "" }, slug: "alice", projects: ["orbit"] };
}

function tree(remote: string): string {
  return execFileSync("/usr/bin/git", ["--git-dir", remote, "ls-tree", "-r", "--name-only", "main"], { encoding: "utf8" });
}

it("routes project coach Git through the Gateway SSH alias when GIT_SSH_HOST names the service", () => {
  vi.stubEnv("GIT_SSH_HOST", "octogee-gitea-ssh.octogee-test.svc.cluster.local");
  try {
    const transport = projectCoachRepoTransport({ customerDir: "/home/node/.openclaw/customers/alice", slug: "alice" });
    expect(transport.remote).toBe("git@gitea:alice/project_coaches.git");
    expect(transport.ssh).toContain('-F /home/node/.ssh/config');
    expect(transport.ssh).toContain('-i "/home/node/.openclaw/customer-keys/alice/id_ed25519"');
  } finally {
    vi.unstubAllEnvs();
  }
});

describe.skipIf(process.platform !== "linux")("private project coach repository", () => {
  it("restores a cold workspace with its exact persona and memory and preserves retained edits", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.workspace, "memory", "2026-11-06.md"), "daily note");
    await fs.writeFile(path.join(f.workspace, ".env"), "secret");
    const checkout = path.join(f.customerDir, "projects", "orbit");
    await fs.mkdir(checkout, { recursive: true });
    await fs.writeFile(path.join(checkout, "AGENTS.md"), "GitHub project instructions");

    await saveProjectCoachWorkspaces(f, f.transport);
    expect(tree(f.remote)).toBe("orbit/AGENTS.md\norbit/IDENTITY.md\norbit/memory/2026-11-06.md\n");
    await fs.rm(f.workspace, { recursive: true });
    await restoreProjectCoachWorkspaces(f, f.transport);
    expect(await fs.readFile(path.join(f.workspace, "IDENTITY.md"), "utf8")).toBe("original persona");
    expect(await fs.readFile(path.join(f.workspace, "memory", "2026-11-06.md"), "utf8")).toBe("daily note");
    expect(await fs.readFile(path.join(checkout, "AGENTS.md"), "utf8")).toBe("GitHub project instructions");
    await fs.writeFile(path.join(f.workspace, "AGENTS.md"), "unsaved local edit");
    await restoreProjectCoachWorkspaces(f, f.transport);
    expect(await fs.readFile(path.join(f.workspace, "AGENTS.md"), "utf8")).toBe("unsaved local edit");
  });

  it("finishes an interrupted restore and leaves a complete retained workspace alone", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.workspace, "SOUL.md"), "saved soul");
    await fs.writeFile(path.join(f.workspace, "BOOTSTRAP.md"), "initial bootstrap");
    await fs.writeFile(path.join(f.workspace, "memory", "2026-11-06.md"), "daily note");
    await saveProjectCoachWorkspaces(f, f.transport);
    await fs.rm(f.workspace, { recursive: true });
    await fs.mkdir(f.workspace, { recursive: true });
    await fs.writeFile(path.join(f.workspace, "AGENTS.md"), "retained local instructions");
    await restoreProjectCoachWorkspaces(f, f.transport);
    expect(await fs.readFile(path.join(f.workspace, "AGENTS.md"), "utf8")).toBe("retained local instructions");
    expect(await fs.readFile(path.join(f.workspace, "SOUL.md"), "utf8")).toBe("saved soul");
    expect(await fs.readFile(path.join(f.workspace, "memory", "2026-11-06.md"), "utf8")).toBe("daily note");
    await fs.unlink(path.join(f.workspace, "BOOTSTRAP.md"));
    await restoreProjectCoachWorkspaces(f, f.transport);
    await expect(fs.stat(path.join(f.workspace, "BOOTSTRAP.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("skips the remote on clean ticks and rejects a changed assignment before publishing a new snapshot", async () => {
    const f = await fixture();
    await saveProjectCoachWorkspaces(f, f.transport);
    await saveProjectCoachWorkspaces(f, { remote: "/unreachable", ssh: "" });
    await fs.writeFile(path.join(f.workspace, "SOUL.md"), "new persona notes");
    let calls = 0;
    await expect(saveProjectCoachWorkspaces({ ...f, assertCurrent: async () => {
      if (++calls === 2) throw new Error("assignment changed");
    } }, f.transport)).rejects.toThrow("assignment changed");
    expect(tree(f.remote)).not.toContain("SOUL.md");
  });

  it("rejects a linked workspace parent and leaves other files outside the private repository", async () => {
    const f = await fixture();
    const other = path.join(path.dirname(path.dirname(f.customerDir)), "other");
    const system = path.join(f.customerDir, ".system");
    await fs.rename(system, other);
    await fs.symlink(other, system);
    await expect(saveProjectCoachWorkspaces(f, f.transport)).rejects.toThrow();
    expect(await fs.readFile(path.join(other, "project-coaches", "orbit", "IDENTITY.md"), "utf8")).toBe("original persona");
  });
});
