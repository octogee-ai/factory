import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  inspectCommittedDist,
  verifyCommittedDist,
} from "../ops/verify-committed-dist.mjs";

const GIT_BIN = "/usr/bin/git";
const REPO_ROOT = path.dirname(fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../core")));
const fixtures: string[] = [];

function git(root: string, args: string[]): string {
  return execFileSync(GIT_BIN, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-committed-dist-"));
  fixtures.push(root);
  fs.mkdirSync(path.join(root, "dist"));
  fs.writeFileSync(path.join(root, "dist", "index.js"), "export const value = 1;\n");
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.email", "test@octogee.com"]);
  git(root, ["config", "user.name", "Octogee Test"]);
  git(root, ["add", "dist/index.js"]);
  git(root, ["commit", "--quiet", "-m", "fixture"]);
  return root;
}

afterEach(() => {
  for (const root of fixtures.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("verify-committed-dist", () => {
  it("accepts a clean tracked dist tree", () => {
    const packageDir = fixture();

    expect(inspectCommittedDist({ packageDir })).toEqual([]);
    expect(verifyCommittedDist({ packageDir, logFn: () => undefined })).toEqual({
      checked: 1,
    });
  });

  it.each([
    {
      name: "modified",
      expected: { kind: "modified", path: "dist/index.js" },
      mutate(packageDir: string) {
        fs.writeFileSync(path.join(packageDir, "dist", "index.js"), "export const value = 2;\n");
      },
    },
    {
      name: "deleted",
      expected: { kind: "deleted", path: "dist/index.js" },
      mutate(packageDir: string) {
        fs.rmSync(path.join(packageDir, "dist", "index.js"));
      },
    },
    {
      name: "untracked",
      expected: { kind: "untracked", path: "dist/new.js" },
      mutate(packageDir: string) {
        fs.writeFileSync(path.join(packageDir, "dist", "new.js"), "export {};\n");
      },
    },
    {
      name: "ignored",
      expected: { kind: "ignored", path: "dist/index.js.map" },
      mutate(packageDir: string) {
        fs.writeFileSync(path.join(packageDir, ".gitignore"), "dist/*.map\n");
        git(packageDir, ["add", ".gitignore"]);
        git(packageDir, ["commit", "--quiet", "-m", "ignore maps"]);
        fs.writeFileSync(path.join(packageDir, "dist", "index.js.map"), "{}\n");
      },
    },
  ])("reports $name output with its exact path", ({ expected, mutate }) => {
    const packageDir = fixture();
    mutate(packageDir);

    expect(inspectCommittedDist({ packageDir })).toEqual([expected]);
    expect(() => verifyCommittedDist({ packageDir, logFn: () => undefined })).toThrow(
      `${expected.kind}: ${expected.path}`,
    );
  });

  it("fails when dist has no tracked output", () => {
    const packageDir = fixture();
    git(packageDir, ["rm", "--quiet", "dist/index.js"]);
    git(packageDir, ["commit", "--quiet", "-m", "remove output"]);

    expect(inspectCommittedDist({ packageDir })).toEqual([
      { kind: "missing", path: "dist" },
    ]);
  });

  it.each(["core", "shared"])(
    "tracks %s dist and permits future build output",
    (packageName) => {
      const tracked = git(REPO_ROOT, ["ls-files", `${packageName}/dist`])
        .split("\n")
        .filter(Boolean);
      const ignoreRule = git(REPO_ROOT, [
        "check-ignore",
        "--verbose",
        "--no-index",
        `${packageName}/dist/new-output.js`,
      ]);

      expect(tracked.length).toBeGreaterThan(0);
      expect(ignoreRule).toMatch(/:![^\t]+\t/);
    },
  );
});
