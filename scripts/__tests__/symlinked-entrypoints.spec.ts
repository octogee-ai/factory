import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { overlayTree } from "../ops/overlay.mjs";

const scriptsDir = resolve(import.meta.dirname, "..");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function linkedScripts(): { root: string; scripts: string } {
  const root = mkdtempSync(join(tmpdir(), "octogee-linked-scripts-"));
  roots.push(root);
  const scripts = join(root, "scripts");
  symlinkSync(scriptsDir, scripts, "dir");
  return { root, scripts };
}

describe("package scripts reached through a symlinked scripts directory", () => {
  it.each([
    { script: "ops/run-emulator-vitest.mjs", args: ["--not-an-option"], error: "[emulator-vitest]" },
    { script: "ops/sync-local-file-deps.mjs", args: ["--not-an-option"], error: "[file-deps] Unknown argument" },
    { script: "ops/verify-committed-dist.mjs", args: [], error: "[committed-dist]" },
    { script: "ops/overlay.mjs", args: [], error: "usage: overlay.mjs" },
  ])("$script runs instead of exiting cleanly without doing anything", ({ script, args, error }) => {
    const { root, scripts } = linkedScripts();
    const result = spawnSync(process.execPath, [join(scripts, script), ...args], { cwd: root, encoding: "utf8" });
    expect(result.stderr).toContain(error);
    expect(result.status).not.toBe(0);
  });
});

const platformDir = resolve(scriptsDir, "..");
const emulatorPackages = readdirSync(platformDir).filter((name) => {
  const manifest = join(platformDir, name, "package.json");
  return existsSync(manifest) && Boolean(JSON.parse(readFileSync(manifest, "utf8")).scripts?.["test:emulator"]);
});

const RECORD_CONFIG = `#!/bin/sh
while [ $# -gt 0 ]; do
  if [ "$1" = --config ]; then config=$2; fi
  shift
done
case "$config" in /*) ;; *) config="$(pwd -P)/$config" ;; esac
printf '%s' "$config" > "$CONFIG_RECORD"
`;

describe("platform emulator commands in a product overlay", () => {
  it("covers the platform packages that run emulator suites", () => {
    expect(emulatorPackages).toEqual(["gateway-edge", "glm-controller", "octogee-api", "scripts"]);
  });

  it.each(emulatorPackages)("%s runs the overlaid package's emulator config", (pkg) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "octogee-overlay-emulator-")));
    roots.push(root);
    const write = (file: string, content: string) => {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), content);
    };
    write("platform/scripts/package.json", "{}");
    write(`platform/${pkg}/package.json`, readFileSync(join(platformDir, pkg, "package.json"), "utf8"));
    write(`platform/${pkg}/vitest.emulator.config.ts`, "");
    write(`product/${pkg}/src/__tests__/product.emulator.spec.ts`, "");
    write("bin/node", RECORD_CONFIG);
    chmodSync(join(root, "bin/node"), 0o755);
    overlayTree({ platform: join(root, "platform"), product: join(root, "product"), out: join(root, ".overlay") });

    const command = JSON.parse(readFileSync(join(root, ".overlay", pkg, "package.json"), "utf8")).scripts["test:emulator"];
    const record = join(root, "config-record");
    const result = spawnSync("/bin/sh", ["-c", command], {
      cwd: join(root, ".overlay", pkg), encoding: "utf8",
      env: { PATH: `${join(root, "bin")}:/usr/bin:/bin`, CONFIG_RECORD: record },
    });
    expect(result.stderr).toBe("");
    expect(realpathSync(readFileSync(record, "utf8"))).toBe(join(root, ".overlay", pkg, "vitest.emulator.config.ts"));
  });
});
