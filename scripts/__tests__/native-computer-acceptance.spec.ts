import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

it.each([false, true])("releases the native execution after acceptance (input failure: %s)", (failInput) => {
  const root = mkdtempSync(join(tmpdir(), "computer-acceptance-"));
  roots.push(root);
  const log = join(root, "calls");
  writeFileSync(join(root, "openclaw"), `#!/bin/bash
printf '%s\\n' "$*" >> "$CALL_LOG"
[[ "$*" != *"--url"* && "$*" != *"--password"* ]] || exit 64
[[ "$OPENCLAW_GATEWAY_PASSWORD" == fixture ]] || exit 65
case "$*" in
  *"nodes status"*) echo '{"nodes":[{"nodeId":"fixture","displayName":"octogee-desktop","paired":true,"commands":["computer.act","screen.snapshot"]}]}' ;;
  *"screen.snapshot"*) echo '{"payload":{"displayFrameId":"fixture-frame","width":1440,"height":900}}' ;;
  *"__close_execution"*) echo '{}' ;;
  *"computer.act"*) [[ "$FAIL_INPUT" != true ]] || exit 42; echo '{}' ;;
  *) exit 66 ;;
esac
`, { mode: 0o755 });
  writeFileSync(join(root, "curl"), '#!/bin/bash\necho \'[{"class":"chromium","title":"Example Domain"}]\'\n', { mode: 0o755 });
  const result = spawnSync("bash", [resolve(__dirname, "../../infra/desktop/acceptance/native-computer.sh")], {
    encoding: "utf8", timeout: 5000,
    env: { ...process.env, PATH: `${root}:${process.env.PATH}`, CALL_LOG: log, OPENCLAW_GATEWAY_TOKEN: "fixture", FAIL_INPUT: String(failInput) },
  });
  expect(result.status, result.stderr).toBe(failInput ? 42 : 0);
  const calls = readFileSync(log, "utf8").trim().split("\n");
  expect(calls.at(-1)).toContain("__close_execution");
  const executionIds = calls.flatMap((line) => [...line.matchAll(/"executionId":"([^"]+)"/g)].map((match) => match[1]));
  expect(executionIds.length).toBeGreaterThanOrEqual(3);
  expect(new Set(executionIds).size).toBe(1);
  if (!failInput) {
    expect(calls.some((line) => line.includes('"action":"mouse_move"'))).toBe(true);
    expect(calls.some((line) => line.includes('"action":"left_click"'))).toBe(true);
  }
});
