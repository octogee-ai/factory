import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";

import { buildAgentImportConfigArtifacts } from "@octogee/shared/types/agent-import";
import {
  AgentImportSourceError,
  extractLocalAgentImportArchive,
  githubAgentImportCloneEnvironment,
  githubAgentImportCloneUrl,
} from "../lib/agent-import-source.js";

const roots: string[] = [];

function temp(name: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  roots.push(root);
  return root;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function sourceRepo(): string {
  const repo = temp("agent-import-local-source");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Jack");
  git(repo, "config", "user.email", "jack@example.invalid");
  fs.writeFileSync(path.join(repo, "MEMORY.md"), "old memory\n");
  fs.mkdirSync(path.join(repo, "bin"));
  fs.writeFileSync(path.join(repo, "bin", "moof"), "#!/bin/sh\necho moof\n", { mode: 0o755 });
  git(repo, "add", "MEMORY.md", "bin/moof");
  git(repo, "commit", "-q", "-m", "old memory");
  fs.writeFileSync(path.join(repo, "MEMORY.md"), "new uncommitted memory\n");
  fs.writeFileSync(path.join(repo, "SOUL.md"), "I am Moof.\n");
  return repo;
}

function artifacts() {
  return buildAgentImportConfigArtifacts({
    meta: { lastTouchedVersion: "2025.4.3" },
    agents: { list: [{ id: "moof", name: "Moof", heartbeat: { every: "30m" } }] },
    gateway: { auth: { token: "must-not-be-in-artifacts" } },
  }, "moof");
}

async function localArchive(repo: string): Promise<Buffer> {
  const zip = new JSZip();
  const config = artifacts();
  zip.file("manifest.json", JSON.stringify({
    formatVersion: 1,
    sourceAgentId: "moof",
    hadGit: true,
    uncommittedFileCount: 2,
  }));
  zip.file("portable-agent.json", JSON.stringify(config.portableAgent));
  zip.file("config-inventory.json", JSON.stringify(config.configInventory));
  zip.file("doctor-candidate.json", JSON.stringify(config.doctorCandidate));
  zip.file("workspace/MEMORY.md", fs.readFileSync(path.join(repo, "MEMORY.md")));
  zip.file("workspace/SOUL.md", fs.readFileSync(path.join(repo, "SOUL.md")));
  zip.file("workspace/bin/moof", fs.readFileSync(path.join(repo, "bin", "moof")));
  for (const relative of ["HEAD", "packed-refs", "shallow"]) {
    const file = path.join(repo, ".git", relative);
    if (fs.existsSync(file)) zip.file(`git/${relative}`, fs.readFileSync(file));
  }
  for (const rootName of ["objects", "refs"]) {
    const root = path.join(repo, ".git", rootName);
    if (!fs.existsSync(root)) continue;
    const visit = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const absolute = path.join(dir, entry.name);
        if (entry.isDirectory()) visit(absolute);
        else zip.file(`git/${path.relative(path.join(repo, ".git"), absolute).split(path.sep).join("/")}`, fs.readFileSync(absolute));
      }
    };
    visit(root);
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("GitHub agent import source", () => {
  it("uses a token-free URL and passes OAuth only through ephemeral git environment", () => {
    expect(githubAgentImportCloneUrl("jack", "moof")).toBe("https://github.com/jack/moof.git");
    const env = githubAgentImportCloneEnvironment("gho_private", { PATH: "/bin", OTHER_SECRET: "drop" });
    expect(env).toMatchObject({
      PATH: "/usr/local/bin:/usr/bin:/bin",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: "Authorization: Bearer gho_private",
    });
    expect(env).not.toHaveProperty("OTHER_SECRET");
    expect(githubAgentImportCloneUrl("jack", "moof")).not.toContain("gho_private");
  });

  it("rejects owner, repo, and branch injection", () => {
    expect(() => githubAgentImportCloneUrl("jack/evil", "moof")).toThrow(AgentImportSourceError);
    expect(() => githubAgentImportCloneUrl("jack", "--upload-pack=evil")).toThrow(AgentImportSourceError);
  });
});

describe("local agent import archive", () => {
  it("reconstructs safe Git history and commits the uploaded working tree tip", async () => {
    const source = sourceRepo();
    const extracted = await extractLocalAgentImportArchive(await localArchive(source), { tmpRoot: temp("extract-root") });
    try {
      expect(extracted.artifacts.portableAgent.name).toBe("Moof");
      expect(extracted.manifest).toMatchObject({ hadGit: true, uncommittedFileCount: 2 });
      expect(git(extracted.repoDir, "rev-list", "--count", extracted.sourceHead)).toBe("2");
      expect(fs.readFileSync(path.join(extracted.repoDir, "MEMORY.md"), "utf8"))
        .toBe("new uncommitted memory\n");
      expect(fs.readFileSync(path.join(extracted.repoDir, "SOUL.md"), "utf8")).toBe("I am Moof.\n");
      expect(git(extracted.repoDir, "ls-tree", extracted.sourceHead, "bin/moof")).toContain("100755");
      expect(JSON.stringify(extracted.artifacts)).not.toContain("must-not-be-in-artifacts");
    } finally {
      extracted.cleanup();
    }
  });

  it("rejects forbidden archive entries before writing them", async () => {
    const zip = new JSZip();
    zip.file("manifest.json", JSON.stringify({ formatVersion: 1, sourceAgentId: "moof", hadGit: false, uncommittedFileCount: 0 }));
    const config = artifacts();
    zip.file("portable-agent.json", JSON.stringify(config.portableAgent));
    zip.file("config-inventory.json", JSON.stringify(config.configInventory));
    zip.file("doctor-candidate.json", JSON.stringify(config.doctorCandidate));
    zip.file("workspace/.env", "API_KEY=nope");

    await expect(extractLocalAgentImportArchive(
      await zip.generateAsync({ type: "nodebuffer" }),
      { tmpRoot: temp("extract-root") },
    )).rejects.toMatchObject({ code: "unsafe_archive_entry" });
  });

  it("rejects declared expansion limits before extracting ZIP entry contents", async () => {
    const zip = new JSZip();
    const config = artifacts();
    zip.file("manifest.json", JSON.stringify({ formatVersion: 1, sourceAgentId: "moof", hadGit: false, uncommittedFileCount: 0 }));
    zip.file("portable-agent.json", JSON.stringify(config.portableAgent));
    zip.file("config-inventory.json", JSON.stringify(config.configInventory));
    zip.file("doctor-candidate.json", JSON.stringify(config.doctorCandidate));
    zip.file("workspace/MEMORY.md", "x".repeat(128));

    await expect(extractLocalAgentImportArchive(
      await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
      { tmpRoot: temp("extract-root"), maxEntryBytes: 64 },
    )).rejects.toMatchObject({ code: "archive_too_large" });
  });

  it("rejects a highly compressed oversized blob on a non-HEAD ref before checkout", async () => {
    const source = sourceRepo();
    git(source, "checkout", "-q", "-b", "hidden-large-object");
    fs.writeFileSync(path.join(source, "huge.txt"), "x".repeat(4096));
    git(source, "add", "huge.txt");
    git(source, "commit", "-q", "-m", "compressed oversized blob");
    git(source, "checkout", "-q", "main");

    await expect(extractLocalAgentImportArchive(
      await localArchive(source),
      { tmpRoot: temp("extract-root"), maxGitBlobBytes: 1024 },
    )).rejects.toMatchObject({ code: "archive_too_large" });
  });

  it("rejects replacement refs smuggled through packed-refs", async () => {
    const source = sourceRepo();
    const zip = await JSZip.loadAsync(await localArchive(source));
    const head = git(source, "rev-parse", "HEAD");
    zip.file("git/packed-refs", `# pack-refs with: peeled fully-peeled sorted\n${head} refs/replace/${head}\n`);

    await expect(extractLocalAgentImportArchive(
      await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
      { tmpRoot: temp("extract-root") },
    )).rejects.toMatchObject({ code: "unsafe_archive_entry" });
  });

  it("drops an ordinary packed remote-tracking ref while retaining importable history", async () => {
    const source = sourceRepo();
    const head = git(source, "rev-parse", "HEAD");
    git(source, "update-ref", "refs/remotes/origin/main", head);
    git(source, "pack-refs", "--all");

    const extracted = await extractLocalAgentImportArchive(
      await localArchive(source),
      { tmpRoot: temp("extract-root") },
    );
    try {
      expect(git(extracted.repoDir, "rev-parse", "HEAD")).toBe(extracted.sourceHead);
      expect(fs.readFileSync(path.join(extracted.repoDir, ".git", "packed-refs"), "utf8"))
        .not.toContain("refs/remotes/origin/main");
    } finally {
      extracted.cleanup();
    }
  });
});
