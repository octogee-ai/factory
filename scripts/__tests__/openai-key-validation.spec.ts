import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const helper = path.join(repoRoot, "scripts/lib/openai-key-validation.sh");

function probe(options: { status?: number; exitCode?: number } = {}) {
  const temp = mkdtempSync(path.join(tmpdir(), "openai-key-validation-"));
  const argsLog = path.join(temp, "args.log");
  const stdinLog = path.join(temp, "stdin.log");
  const curl = path.join(temp, "curl");
  const apiKey = "sk-live-secret-that-must-not-leak";
  writeFileSync(curl, `#!/usr/bin/env bash
printf '%s\n' "$@" > "$FAKE_CURL_ARGS"
cat > "$FAKE_CURL_STDIN"
if [[ "$FAKE_CURL_EXIT" != "0" ]]; then
  printf 'simulated transport failure\n' >&2
  exit "$FAKE_CURL_EXIT"
fi
printf '%s' "$FAKE_CURL_STATUS"
`);
  chmodSync(curl, 0o755);

  const result = spawnSync("bash", ["-euo", "pipefail", "-c", [
    `source ${JSON.stringify(helper)}`,
    'validate_openai_api_key "$OPENAI_KEY"',
  ].join("\n")], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${temp}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      OPENAI_KEY: apiKey,
      FAKE_CURL_ARGS: argsLog,
      FAKE_CURL_STDIN: stdinLog,
      FAKE_CURL_STATUS: String(options.status ?? 200),
      FAKE_CURL_EXIT: String(options.exitCode ?? 0),
    },
  });
  const args = readFileSync(argsLog, "utf8");
  const stdin = readFileSync(stdinLog, "utf8");
  rmSync(temp, { recursive: true, force: true });
  return { ...result, apiKey, args, stdin };
}

describe("OpenAI platform-key validation", () => {
  it("uses the no-token-cost models endpoint without putting the key in argv", () => {
    const result = probe();

    expect(result.status, result.stderr).toBe(0);
    expect(result.args).toContain("https://api.openai.com/v1/models");
    expect(result.args).toContain("@-");
    expect(result.args).not.toContain(result.apiKey);
    expect(result.stdin).toBe(`Authorization: Bearer ${result.apiKey}\n`);
    expect(`${result.stdout}${result.stderr}`).not.toContain(result.apiKey);
  });

  it("rejects an unauthorized key without echoing it", () => {
    const result = probe({ status: 401 });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("OpenAI credential validation returned HTTP 401");
    expect(`${result.stdout}${result.stderr}`).not.toContain(result.apiKey);
  });

  it("rejects transport failures without echoing the key", () => {
    const result = probe({ exitCode: 7 });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("OpenAI credential validation request failed");
    expect(`${result.stdout}${result.stderr}`).not.toContain(result.apiKey);
  });
});
