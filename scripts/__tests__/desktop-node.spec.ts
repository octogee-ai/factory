import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function launch(withKeyboard: boolean, existing?: object) {
  const root = mkdtempSync(join(tmpdir(), "desktop-node-"));
  roots.push(root);
  const bin = join(root, "bin");
  const runtime = join(root, "runtime");
  mkdirSync(bin);
  mkdirSync(runtime);
  if (existing) {
    mkdirSync(join(root, ".openclaw"));
    writeFileSync(join(root, ".openclaw/openclaw.json"), JSON.stringify(existing));
  }
  writeFileSync(join(runtime, "wayland-1"), "");
  for (const name of ["mkdir", "ls", "grep", "head"]) {
    const executable = spawnSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf8" });
    if (executable.status !== 0) throw new Error(`Missing test dependency: ${name}`);
    symlinkSync(executable.stdout.trim(), join(bin, name));
  }
  symlinkSync(process.execPath, join(bin, "node"));
  const stub = (name: string, body: string) => writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  stub("curl", "exit 0");
  stub("openclaw", 'printf "%s\\n" "$*"; printf "display=%s\\n" "$DISPLAY"');
  if (withKeyboard) stub("wtype", "exit 0");
  const result = spawnSync("/bin/bash", [resolve(__dirname, "../../infra/gateway/desktop-node.sh")], {
    encoding: "utf8", timeout: 2000,
    env: { PATH: bin, HOME: root, XDG_RUNTIME_DIR: runtime, OCTOGEE_DESKTOP_NODE_NAME: "test-desktop", OPENCLAW_GATEWAY_PASSWORD: "fixture" },
  });
  return { ...result, config: withKeyboard ? JSON.parse(readFileSync(join(root, ".openclaw/openclaw.json"), "utf8")) : null, runtime };
}

it("refuses to advertise computer control without its Wayland keyboard helper", () => {
  const result = launch(false);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("wtype is required for CUA Wayland keyboard input");
  expect(result.stdout).not.toContain("node run");
});

it.each([undefined, { plugins: { entries: { "cua-computer": { enabled: true } } }, nodeHost: { browserProxy: { enabled: true } } }])(
  "configures desktop streaming and removes browser advertising on every boot: %j", (existing) => {
    const result = launch(true, existing);
    expect(result.status).toBe(0);
    expect(result.config.nodeHost.browserProxy.enabled).toBe(false);
    expect(result.config.desktop.host).toEqual({
      enabled: true, managed: false, port: 5901,
      passwordFile: `${result.runtime}/octogee-openclaw-vnc/password`,
    });
    expect(result.config.plugins.entries["cua-computer"].enabled).toBe(true);
  },
);

it("checks the driver and connects when the Wayland keyboard helper is installed", () => {
  const result = launch(true);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("doctor --lint --only cua-computer/driver-artifacts");
  expect(result.stdout).toContain("node run --host 127.0.0.1 --port 18789 --display-name test-desktop");
  expect(result.stdout).toContain("display=:0");
});
