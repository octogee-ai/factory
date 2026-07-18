import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ensureConfiguredAgentRuntimeDirs } from "../entrypoints/ensure-configured-agent-runtime-dirs.js";

const temporaryDirs: string[] = [];

function makeTemporaryDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-agent-runtime-"));
  temporaryDirs.push(dir);
  return dir;
}

function writeConfig(dir: string, agents: unknown[]): string {
  const configPath = path.join(dir, "openclaw.json");
  fs.writeFileSync(configPath, JSON.stringify({ agents: { list: agents } }));
  return configPath;
}

afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("ensureConfiguredAgentRuntimeDirs", () => {
  it("creates the resolver-visible runtime directory for each configured customer coach", () => {
    const root = makeTemporaryDir();
    const configPath = writeConfig(root, [
      { id: "octogee-alice-coach" },
      { id: "octogee-bob-coach" },
    ]);
    const agentsDir = path.join(root, "agents");

    expect(ensureConfiguredAgentRuntimeDirs({ configPath, agentsDir })).toEqual(
      ["octogee-alice-coach", "octogee-bob-coach"],
    );
    expect(
      fs.statSync(path.join(agentsDir, "octogee-alice-coach", "agent")).mode &
        0o777,
    ).toBe(0o700);
    expect(
      fs.statSync(path.join(agentsDir, "octogee-bob-coach", "agent")).mode &
        0o777,
    ).toBe(0o700);
  });

  it("runs before OpenClaw starts", () => {
    const entrypoint = fs.readFileSync(
      path.resolve("..", "infra/gateway/entrypoint.sh"),
      "utf8",
    );
    const initializer = entrypoint.indexOf(
      "ensure-configured-agent-runtime-dirs.ts",
    );
    const gatewayStart = entrypoint.indexOf(
      "openclaw gateway run --bind lan --port 18789",
    );

    expect(initializer).toBeGreaterThanOrEqual(0);
    expect(gatewayStart).toBeGreaterThan(initializer);
  });

  it("does not create paths for non-platform or malformed agent identifiers", () => {
    const root = makeTemporaryDir();
    const configPath = writeConfig(root, [
      { id: "main" },
      { id: "octogee-../../coach" },
      { id: "octogee-alice-project-sales" },
      { id: "octogee-alice-coach" },
    ]);
    const agentsDir = path.join(root, "agents");

    expect(ensureConfiguredAgentRuntimeDirs({ configPath, agentsDir })).toEqual(
      ["octogee-alice-coach"],
    );
    expect(
      fs.existsSync(path.join(agentsDir, "octogee-alice-coach", "agent")),
    ).toBe(true);
    expect(fs.existsSync(path.join(root, "coach", "agent"))).toBe(false);
  });

  it("fails loudly when durable config cannot be parsed", () => {
    const root = makeTemporaryDir();
    const configPath = path.join(root, "openclaw.json");
    fs.writeFileSync(configPath, "{");

    expect(() =>
      ensureConfiguredAgentRuntimeDirs({
        configPath,
        agentsDir: path.join(root, "agents"),
      }),
    ).toThrow(/invalid JSON/u);
  });
});
