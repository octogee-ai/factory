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
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_DIR: openclawDir,
      },
    });

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr.trim())).toMatchObject({
      service: "pre-boot-config", severity: "ERROR",
      timestamp: expect.stringMatching(/^\d{4}-.*Z$/),
      message: expect.stringContaining("[pre-boot] Fatal:"),
    });
  });

  it("patches the config without initializing Firebase, whatever credentials the pod carries", () => {
    const openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-preboot-dbless-"));
    temporaryDirectories.push(openclawDir);
    const configPath = path.join(openclawDir, "openclaw.json");
    fs.writeFileSync(configPath, "{}", "utf8");
    const credentialPath = path.join(openclawDir, "service-account.json");
    fs.writeFileSync(credentialPath, "{}", "utf8");

    const result = spawnSync(tsx, [entrypoint], {
      encoding: "utf8",
      env: {
        ...process.env,
        GOOGLE_APPLICATION_CREDENTIALS: credentialPath,
        HOME: openclawDir,
        OCTOGEE_PREBOOT_FIRESTORE: "true",
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_DIR: openclawDir,
        SA_KEY_PATH: credentialPath,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("Firebase");
    expect(JSON.parse(fs.readFileSync(configPath, "utf8")).agents.defaults.typingMode).toBe("instant");
  });
});
