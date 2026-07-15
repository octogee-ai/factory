#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const GIT_BIN = "/usr/bin/git";

export function inspectCommittedDist({ packageDir }) {
  const tracked = git(packageDir, ["ls-files", "--", "dist"])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (tracked.length === 0) {
    return [{ kind: "missing", path: "dist" }];
  }

  return git(packageDir, [
    "status",
    "--porcelain=v1",
    "--ignored",
    "--untracked-files=all",
    "--",
    "dist",
  ])
    .split("\n")
    .filter(Boolean)
    .map(parseStatusLine);
}

export function verifyCommittedDist({
  packageDir,
  logFn = (message) => console.error(message),
}) {
  const drift = inspectCommittedDist({ packageDir });
  if (drift.length > 0) {
    throw new Error(
      `committed dist drift:\n${drift.map(({ kind, path }) => `  ${kind}: ${path}`).join("\n")}`,
    );
  }

  const checked = git(packageDir, ["ls-files", "--", "dist"])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean).length;
  logFn(`[committed-dist] ${checked} tracked files match the build`);
  return { checked };
}

function parseStatusLine(line) {
  const status = line.slice(0, 2);
  const filePath = line.slice(3);
  if (status === "??") return { kind: "untracked", path: filePath };
  if (status === "!!") return { kind: "ignored", path: filePath };
  if (status.includes("D")) return { kind: "deleted", path: filePath };
  return { kind: "modified", path: filePath };
}

function git(packageDir, args) {
  return execFileSync(GIT_BIN, args, {
    cwd: packageDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    verifyCommittedDist({ packageDir: process.cwd() });
  } catch (error) {
    console.error(
      `[committed-dist] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
