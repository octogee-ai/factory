import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

type LaunchOptions = { keyboard?: boolean; bus?: boolean; busFailures?: number; existing?: object };

function launch({ keyboard = true, bus = true, busFailures = 0, existing }: LaunchOptions = {}) {
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
  for (const name of ["mkdir", "ls", "grep", "head", "cat"]) {
    const executable = spawnSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf8" });
    if (executable.status !== 0) throw new Error(`Missing test dependency: ${name}`);
    symlinkSync(executable.stdout.trim(), join(bin, name));
  }
  symlinkSync(process.execPath, join(bin, "node"));
  const stub = (name: string, body: string) => writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  stub("curl", "exit 0");
  stub("sleep", "exit 0");
  stub("openclaw", 'printf "%s\\n" "$*"; printf "display=%s\\n" "$DISPLAY"; printf "bus=%s\\n" "$DBUS_SESSION_BUS_ADDRESS"');
  if (keyboard) stub("wtype", "exit 0");
  if (bus) {
    writeFileSync(join(root, "bus-failures"), String(busFailures));
    stub("dbus-send", `printf '%s\\n' "$DBUS_SESSION_BUS_ADDRESS $*" >> "${root}/bus-calls"
remaining="$(cat "${root}/bus-failures")"
if [ "$remaining" -gt 0 ]; then echo $((remaining - 1)) > "${root}/bus-failures"; exit 1; fi`);
  }
  const result = spawnSync("/bin/bash", [resolve(__dirname, "../../infra/gateway/desktop-node.sh")], {
    encoding: "utf8", timeout: 2000,
    env: { PATH: bin, HOME: root, XDG_RUNTIME_DIR: runtime, OCTOGEE_DESKTOP_NODE_NAME: "test-desktop", OPENCLAW_GATEWAY_PASSWORD: "fixture" },
  });
  const configPath = join(root, ".openclaw/openclaw.json");
  const busCallsPath = join(root, "bus-calls");
  return {
    ...result,
    config: existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : null,
    busCalls: existsSync(busCallsPath) ? readFileSync(busCallsPath, "utf8").trim().split("\n") : [],
    runtime,
  };
}

it("refuses to advertise computer control without its Wayland keyboard helper", () => {
  const result = launch({ keyboard: false });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("wtype is required for CUA Wayland keyboard input");
  expect(result.stdout).not.toContain("node run");
});

it("refuses to advertise computer control without a client for the desktop's accessibility bus", () => {
  const result = launch({ bus: false });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("dbus-send is required to reach the desktop's accessibility bus");
  expect(result.stdout).not.toContain("node run");
});

it.each([undefined, { plugins: { entries: { "cua-computer": { enabled: true } } }, nodeHost: { browserProxy: { enabled: true } } }])(
  "configures desktop streaming and removes browser advertising on every boot: %j", (existing) => {
    const result = launch({ existing });
    expect(result.status).toBe(0);
    expect(result.config.nodeHost.browserProxy.enabled).toBe(false);
    expect(result.config.desktop.host).toEqual({
      enabled: true, managed: false, port: 5901,
      passwordFile: `${result.runtime}/octogee-openclaw-vnc/password`,
    });
    expect(result.config.plugins.entries["cua-computer"].enabled).toBe(true);
  },
);

it("checks the driver and connects on the desktop's session bus once its accessibility bus answers", () => {
  const result = launch();
  expect(result.status).toBe(0);
  expect(result.busCalls).toEqual([
    `unix:path=${result.runtime}/bus --session --print-reply --reply-timeout=5000 --dest=org.a11y.Bus /org/a11y/bus org.a11y.Bus.GetAddress`,
  ]);
  expect(result.stdout).toContain("doctor --lint --only cua-computer/driver-artifacts");
  expect(result.stdout).toContain("node run --host 127.0.0.1 --port 18789 --display-name test-desktop");
  expect(result.stdout).toContain("display=:0");
  expect(result.stdout).toContain(`bus=unix:path=${result.runtime}/bus`);
});

it("keeps the CUA driver stopped until the accessibility bus answers", () => {
  const result = launch({ busFailures: 2 });
  expect(result.status).toBe(0);
  expect(result.busCalls).toHaveLength(3);
  const waits = result.stdout.split("\n").filter((line) => line.includes("waiting for the accessibility bus (org.a11y.Bus)"));
  expect(waits).toHaveLength(2);
  expect(result.stdout.lastIndexOf(waits[1])).toBeLessThan(result.stdout.indexOf("doctor --lint"));
});
