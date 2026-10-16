import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const paths = vi.hoisted(() => ({ root: `/tmp/octogee-placeholder-transfer-${process.pid}` }));
vi.mock("../lib/config.js", () => ({
  log: vi.fn(), OPENCLAW_DIR: `${paths.root}/source`,
  CUSTOMERS_DIR: `${paths.root}/source/customers`,
}));
const { seedDeferredProjectWorkspace } = await import("../lib/deferred-project-workspace.js");
const { sourceTransferRsyncArgs } = await import("../lib/source-transfer-rsync.js");
const source = `${paths.root}/source`;
const stage = `${paths.root}/stage`;
const target = `${paths.root}/target`;
const relative = "customers/alice/projects/octogee";

function transfer(mode: "pre" | "final") {
  fs.mkdirSync(stage, { recursive: true });
  const args = sourceTransferRsyncArgs(
    [{ cwd: source, path: "customers/alice" }], "/unused/local-transfer-password", stage, mode,
  );
  execFileSync("rsync", [
    "-a", "--relative", ...args.filter((arg) => arg.startsWith("--exclude=")),
    "customers/alice", `${stage}/`,
  ], { cwd: source });
}

function installStage() {
  fs.mkdirSync(target, { recursive: true });
  execFileSync("rsync", ["-a", `${stage}/`, `${target}/`]);
}

beforeEach(() => { fs.rmSync(paths.root, { recursive: true, force: true }); });
afterEach(() => { fs.rmSync(paths.root, { recursive: true, force: true }); });

describe("deferred project workspace transfer", () => {
  it("keeps the prepared canonical AGENTS symlink through the final Shared placeholder transfer", () => {
    seedDeferredProjectWorkspace("alice", "octogee");
    for (const name of ["SOUL.md", "USER.md", "IDENTITY.md"]) {
      fs.writeFileSync(path.join(source, relative, name), `existing ${name}\n`);
    }
    transfer("pre");
    installStage();
    const project = path.join(target, relative);
    fs.rmSync(path.join(project, "AGENTS.md"), { force: true });
    fs.writeFileSync(path.join(project, "CLAUDE.md"), "canonical project instructions\n");
    fs.symlinkSync("CLAUDE.md", path.join(project, "AGENTS.md"));
    execFileSync("git", ["init", "-q", project]);
    execFileSync("git", ["-C", project, "add", "AGENTS.md", "CLAUDE.md"]);
    execFileSync("git", ["-C", project, "-c", "user.name=Test", "-c", "user.email=test@octogee.test", "commit", "-qm", "canonical checkout"]);

    transfer("final");
    installStage();

    expect(fs.lstatSync(path.join(project, "AGENTS.md")).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(path.join(project, "AGENTS.md"))).toBe("CLAUDE.md");
    expect(fs.readFileSync(path.join(project, "CLAUDE.md"), "utf8")).toBe("canonical project instructions\n");
    expect(execFileSync("git", ["-C", project, "diff", "--name-only"], { encoding: "utf8" })).toBe("");
    for (const name of ["SOUL.md", "USER.md", "IDENTITY.md"]) {
      expect(fs.readFileSync(path.join(project, name), "utf8")).toBe(`existing ${name}\n`);
    }
    expect(fs.existsSync(path.join(source, relative, "AGENTS.md"))).toBe(true);
  });

  it("transfers authored AGENTS instructions instead of treating all project context as disposable", () => {
    seedDeferredProjectWorkspace("alice", "octogee");
    fs.appendFileSync(path.join(source, relative, "AGENTS.md"), "Customer authored instructions.\n");

    transfer("final");
    installStage();

    expect(fs.readFileSync(path.join(target, relative, "AGENTS.md"), "utf8"))
      .toBe(fs.readFileSync(path.join(source, relative, "AGENTS.md"), "utf8"));
  });
});
