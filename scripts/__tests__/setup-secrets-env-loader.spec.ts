import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");
const helperPath = path.join(repoRoot, "scripts/lib/shell-env.sh");

function runLoader(envFile: string, env: Record<string, string> = {}): string {
  const script = [
    `source ${JSON.stringify(helperPath)}`,
    `load_env_file ${JSON.stringify(envFile)}`,
    `printf '%s\\n' "$RESEND_FROM_EMAIL" "$RESEND_FROM_NAME" "$UNQUOTED_VALUE"`,
  ].join("\n");
  const res = spawnSync("bash", ["-euo", "pipefail", "-c", script], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf-8",
  });
  if (res.status !== 0) {
    throw new Error(`loader failed:\nstdout=${res.stdout}\nstderr=${res.stderr}`);
  }
  return res.stdout;
}

describe("setup-secrets env loader", () => {
  it("removes surrounding .env quotes before values are materialized into Kubernetes secrets", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "octogee-env-loader-"));
    const envFile = path.join(dir, ".env.test");
    writeFileSync(
      envFile,
      [
        `RESEND_FROM_EMAIL="notifications@octogee.com"`,
        `RESEND_FROM_NAME="Octogee"`,
        `UNQUOTED_VALUE=plain`,
      ].join("\n"),
    );

    expect(runLoader(envFile)).toBe("notifications@octogee.com\nOctogee\nplain\n");
  });

  it("preserves already-exported values when the .env file contains a blank assignment", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "octogee-env-loader-"));
    const envFile = path.join(dir, ".env.test");
    writeFileSync(
      envFile,
      [
        `RESEND_FROM_EMAIL=`,
        `RESEND_FROM_NAME=""`,
        `UNQUOTED_VALUE=plain`,
      ].join("\n"),
    );

    expect(
      runLoader(envFile, {
        RESEND_FROM_EMAIL: "existing@example.com",
        RESEND_FROM_NAME: "Existing Sender",
      }),
    ).toBe("existing@example.com\nExisting Sender\nplain\n");
  });
});
