import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const script = resolve(repoRoot, "scripts/firebase-deploy-hosting.sh");

function fakeDeploy(directory: string): string {
  const path = join(directory, "deploy.sh");
  writeFileSync(path, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" > "$CAPTURE_ARGS"
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--config" ]; then
    cp "$2" "$CAPTURE_CONFIG"
    exit 0
  fi
  shift
done
`);
  chmodSync(path, 0o755);
  return path;
}

describe("firebase hosting deploy wrapper", () => {
  it("renders the selected SSR region into a temporary site config", () => {
    const directory = mkdtempSync(join(tmpdir(), "octogee-hosting-"));
    const argsPath = join(directory, "args.txt");
    const configPath = join(directory, "firebase.json");
    const result = spawnSync(
      "bash",
      [script, "site", "firebase-test", "us-west1"],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          CAPTURE_ARGS: argsPath,
          CAPTURE_CONFIG: configPath,
          DEPLOY_CMD: fakeDeploy(directory),
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    const args = readFileSync(argsPath, "utf8").trim().split("\n");
    const configArgument = args[args.indexOf("--config") + 1];
    expect(dirname(configArgument)).toBe(dirname(repoRoot));
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const site = config.hosting.find((entry: { target: string }) => entry.target === "site");
    expect(site.rewrites[0].run.region).toBe("us-west1");
  });

  it("requires an explicit SSR region only for the site target", () => {
    const missing = spawnSync("bash", [script, "site", "firebase-test"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain("SSR region");

    const directory = mkdtempSync(join(tmpdir(), "octogee-hosting-"));
    const result = spawnSync("bash", [script, "app", "firebase-test"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        CAPTURE_ARGS: join(directory, "args.txt"),
        CAPTURE_CONFIG: join(directory, "firebase.json"),
        DEPLOY_CMD: fakeDeploy(directory),
      },
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it("invokes an app deploy without site config under strict Bash", () => {
    const directory = mkdtempSync(join(tmpdir(), "octogee-hosting-"));
    const argsPath = join(directory, "args.txt");
    const result = spawnSync("bash", [script, "app", "firebase-test"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        CAPTURE_ARGS: argsPath,
        CAPTURE_CONFIG: join(directory, "firebase.json"),
        DEPLOY_CMD: fakeDeploy(directory),
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(argsPath, "utf8")).toBe("\n");
  });
});
