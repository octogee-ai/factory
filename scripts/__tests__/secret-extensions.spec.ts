import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const helperPath = path.resolve(import.meta.dirname, "../lib/secret-extensions.sh");

function run(root: string, body: string): { status: number | null; stdout: string; stderr: string } {
  const script = ['source "$1"', 'load_secret_extensions "$2"', body].join("\n");
  const result = spawnSync("bash", ["-euo", "pipefail", "-c", script, "--", helperPath, root], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("secret extensions", () => {
  it("says when no extensions are loaded and runs under nounset", () => {
    const root = mkdtempSync(path.join(tmpdir(), "octogee-secret-ext-empty-"));
    const result = run(root, [
      'run_secret_steps ${SECRET_SETUP_STEPS[@]+"${SECRET_SETUP_STEPS[@]}"}',
      'printf "reason=[%s]" "$(secret_key_invalid_reason some-secret key value)"',
    ].join("\n"));

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("No secret extensions loaded\nreason=[]");
  });

  it("sources each extension's secrets.sh and runs its registered steps and validators", () => {
    const root = mkdtempSync(path.join(tmpdir(), "octogee-secret-ext-"));
    mkdirSync(path.join(root, "extra"));
    writeFileSync(path.join(root, "extra/secrets.sh"), [
      "SECRET_SETUP_STEPS+=(setup_extra)",
      "SECRET_KEY_VALIDATORS+=(extra_reason)",
      'setup_extra() { printf "setup-extra;"; }',
      'extra_reason() { [[ "$1:$2" == "extra:key" && "$3" != ok ]] && printf "INVALID"; return 0; }',
    ].join("\n"));
    const result = run(root, [
      'run_secret_steps ${SECRET_SETUP_STEPS[@]+"${SECRET_SETUP_STEPS[@]}"}',
      'printf "bad=[%s];" "$(secret_key_invalid_reason extra key nope)"',
      'printf "good=[%s];" "$(secret_key_invalid_reason extra key ok)"',
      'printf "other=[%s]" "$(secret_key_invalid_reason other key nope)"',
    ].join("\n"));

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("Secret extensions loaded: extra\nsetup-extra;bad=[INVALID];good=[];other=[]");
  });

  it("propagates a failing registered step", () => {
    const root = mkdtempSync(path.join(tmpdir(), "octogee-secret-ext-fail-"));
    mkdirSync(path.join(root, "extra"));
    writeFileSync(path.join(root, "extra/secrets.sh"), "SECRET_SETUP_STEPS+=(setup_extra)\nsetup_extra() { return 3; }\n");
    const result = run(root, 'run_secret_steps "${SECRET_SETUP_STEPS[@]}"\nprintf "after"');

    expect(result.status).toBe(3);
    expect(result.stdout).toBe("Secret extensions loaded: extra\n");
  });
});
