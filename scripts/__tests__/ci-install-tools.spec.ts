import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../..");
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "octogee-install-tools-"));
  const tool = (name: string, body: string) => writeFileSync(join(directory, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  tool("timeout", `echo "$*" >> "${directory}/timeout.log"\nshift 2\nexec "$@"`);
  tool("sleep", `echo "$*" >> "${directory}/sleep.log"`);
  tool("apt-get", `count=$(( $(cat "${directory}/count" 2>/dev/null || echo 0) + 1 ))
echo "$count" > "${directory}/count"
echo "$DEBIAN_FRONTEND $*" >> "${directory}/apt.log"
echo "apt-get $*" >> "${directory}/events.log"
[[ "$count" -gt "\${FAILURES:-0}" ]] || exit "\${FAILURE_STATUS:-100}"`);
  tool("dpkg", `echo "$DEBIAN_FRONTEND dpkg $*" >> "${directory}/events.log"`);
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

const aptGet = (failures: number | [number, number], ...args: string[]) => spawnSync("bash", ["-c", 'source ci/install-tools.sh && apt_get "$@"', "apt_get", ...args], {
  cwd: repoRoot, encoding: "utf8", env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, FAILURES: String([failures].flat()[0]), FAILURE_STATUS: String([failures].flat()[1] ?? 100) },
});
const lines = (name: string) => readFileSync(join(directory, name), "utf8").trim().split("\n");

it("bounds each apt-get attempt with a timeout and retries a failed one", () => {
  const result = aptGet(2, "update");
  expect(result.status, result.stderr).toBe(0);
  expect(lines("timeout.log")).toEqual(Array(3).fill(expect.stringMatching(/^--kill-after=30 180 apt-get -o Acquire::Retries=3 .*Acquire::http::Timeout=60 .*update$/)));
  expect(lines("apt.log")[0]).toMatch(/^noninteractive /);
  expect(lines("sleep.log")).toEqual(["10", "20"]);
  expect(result.stderr).toContain("apt-get update: attempt 1 of 3 exited 100; retrying in 10s");
  expect(result.stderr).toContain("apt-get update: attempt 2 of 3 exited 100; retrying in 20s");
  expect(lines("events.log").filter(line => line.includes("dpkg"))).toEqual([]);
});

it("gives an install a long limit and recovers the package database before retrying a killed one", () => {
  const result = aptGet([1, 124], "install", "-y", "postgresql-common");
  expect(result.status, result.stderr).toBe(0);
  expect(lines("timeout.log").filter(line => line.includes(" apt-get "))).toEqual(Array(2).fill(expect.stringMatching(/^--kill-after=30 900 apt-get .*install -y postgresql-common$/)));
  expect(lines("events.log")).toEqual([
    "apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=60 -o Acquire::https::Timeout=60 install -y postgresql-common",
    "noninteractive dpkg --configure -a",
    "apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=60 -o Acquire::https::Timeout=60 install -y postgresql-common",
  ]);
  expect(result.stderr).toContain("apt-get install -y postgresql-common: attempt 1 of 3 exited 124; retrying in 10s");
});

it("fails the step after the last attempt instead of waiting forever", () => {
  const result = aptGet(5, "install", "-y", "postgresql-common");
  expect(result.status).not.toBe(0);
  expect(lines("apt.log")).toHaveLength(3);
  expect(lines("sleep.log")).toEqual(["10", "20"]);
  expect(result.stderr).toContain("apt-get install -y postgresql-common: attempt 3 of 3 exited 100; giving up");
});
