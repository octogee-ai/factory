import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];
const scriptsDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const tsx = path.join(scriptsDir, "node_modules/.bin/tsx");
const entrypoint = path.join(scriptsDir, "entrypoints/pre-boot-config.ts");

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("pre-boot config entrypoint", () => {
  it("exits nonzero when the durable OpenClaw config is malformed", () => {
    const openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-preboot-fatal-"));
    temporaryDirectories.push(openclawDir);
    const configPath = path.join(openclawDir, "openclaw.json");
    fs.writeFileSync(configPath, "{ malformed", "utf8");

    const result = spawnSync(tsx, [entrypoint], {
      encoding: "utf8",
      env: {
        ...process.env,
        GATEWAY_CLASS: "shared",
        HOME: openclawDir,
        OCTOGEE_PREBOOT_FIRESTORE: "false",
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_DIR: openclawDir,
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("[pre-boot] Fatal:");
  });
});
