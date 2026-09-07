import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function launch(withKeyboard: boolean) {
  const root = mkdtempSync(join(tmpdir(), "desktop-node-"));
  roots.push(root);
  const bin = join(root, "bin");
  const runtime = join(root, "runtime");
  mkdirSync(bin);
  mkdirSync(runtime);
  writeFileSync(join(runtime, "wayland-1"), "");
  for (const name of ["mkdir", "ls", "grep", "head"]) symlinkSync(`/usr/bin/${name}`, join(bin, name));
  const stub = (name: string, body: string) => writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  stub("curl", "exit 0");
  stub("openclaw", 'printf "%s\\n" "$*"; printf "display=%s\\n" "$DISPLAY"');
  if (withKeyboard) stub("wtype", "exit 0");
  return spawnSync("/bin/bash", [resolve(__dirname, "../../infra/gateway/desktop-node.sh")], {
    encoding: "utf8", timeout: 2000,
    env: { PATH: bin, HOME: root, XDG_RUNTIME_DIR: runtime, OCTOGEE_DESKTOP_NODE_NAME: "test-desktop", OPENCLAW_GATEWAY_PASSWORD: "fixture" },
  });
}

it("refuses to advertise computer control without its Wayland keyboard helper", () => {
  const result = launch(false);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("wtype is required for CUA Wayland keyboard input");
  expect(result.stdout).not.toContain("node run");
});

it("checks the driver and connects when the Wayland keyboard helper is installed", () => {
  const result = launch(true);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("doctor --lint --only cua-computer/driver-artifacts");
  expect(result.stdout).toContain("node run --host 127.0.0.1 --port 18789 --display-name test-desktop");
  expect(result.stdout).toContain("display=:0");
});
