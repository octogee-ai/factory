import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const helper = path.resolve(import.meta.dirname, "../lib/agent-store-postgres-secret.sh");

function materialize(missing = false) {
  const dir = mkdtempSync(path.join(tmpdir(), "agent-store-secret-"));
  const trace = path.join(dir, "trace");
  const payload = path.join(dir, "payload");
  writeFileSync(path.join(dir, "gcloud"), `#!/bin/bash
printf '%s\\n' "$*" >> "$TRACE"
[[ "$*" == *"--project=octogee-test"* ]] || exit 8
if [[ "$*" == *"client-dsn"* && "$MISSING" == 1 ]]; then exit 9; fi
printf 'postgres://private-credential@10.89.0.3/octogee_agents_test'
`);
  writeFileSync(path.join(dir, "kubectl"), `#!/bin/bash
printf '%s\\n' "$*" >> "$TRACE"
if [[ "$*" == *"create secret"* ]]; then
  for arg in "$@"; do
    if [[ "$arg" == --from-file=* ]]; then
      file="\${arg#*=}"; file="\${file#*=}"
      [[ "$(stat ${process.platform === "darwin" ? "-f %Lp" : "-c %a"} "$file")" == 600 ]] || exit 10
      cat "$file" >> "$PAYLOAD"
      printf '%s\\n' "$file" >> "$TRACE"
    fi
  done
  printf 'materialized-secret'
else cat >/dev/null; fi
`);
  for (const name of ["gcloud", "kubectl"]) chmodSync(path.join(dir, name), 0o755);
  const result = spawnSync("bash", ["-euo", "pipefail", "-c", `source "$HELPER"; materialize_agent_store_postgres_secret octogee-test octogee-test explicit-context`], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, TRACE: trace, PAYLOAD: payload, MISSING: missing ? "1" : "0", HELPER: helper },
  });
  const calls = existsSync(trace) ? readFileSync(trace, "utf8") : "";
  const data = existsSync(payload) ? readFileSync(payload, "utf8") : "";
  const temporaryFiles = calls.split("\n").filter((line) => line.startsWith("/") && line.endsWith("-dsn"));
  const cleaned = temporaryFiles.every((file) => !existsSync(file));
  rmSync(dir, { recursive: true, force: true });
  return { result, calls, data, cleaned };
}

describe("PostgreSQL agent-store secret materialization", () => {
  it("reads the environment's existing versions and applies both keys through private files", () => {
    const { result, calls, data, cleaned } = materialize();
    expect(result.status, result.stderr).toBe(0);
    expect(data).toBe("postgres://private-credential@10.89.0.3/octogee_agents_test".repeat(2));
    expect(calls).toContain("--context=explicit-context");
    expect(calls).toContain("-n octogee-test");
    expect(calls).toContain("apply -f -");
    expect(calls).not.toContain("private-credential");
    expect(result.stdout + result.stderr).not.toContain("private-credential");
    expect(cleaned).toBe(true);
  });

  it("leaves the Kubernetes secret unchanged when either source version is unavailable", () => {
    const { result, calls, cleaned } = materialize(true);
    expect(result.status).not.toBe(0);
    expect(calls).not.toContain("create secret");
    expect(calls).not.toContain("apply -f -");
    expect(cleaned).toBe(true);
  });
});
