import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const helperPath = path.resolve(import.meta.dirname, "../lib/env-extensions.sh");

function run(root: string, body: string): { status: number | null; stdout: string; stderr: string } {
  const script = [`source ${JSON.stringify(helperPath)}`, `load_env_extensions ${JSON.stringify(root)}`, body].join("\n");
  const result = spawnSync("bash", ["-euo", "pipefail", "-c", script], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const allHooks = [
  'run_env_hooks ${ENV_VERIFY_SECTIONS[@]+"${ENV_VERIFY_SECTIONS[@]}"}',
  'run_env_hooks ${ENV_REBUILD_STEPS_AFTER_ROLLOUT[@]+"${ENV_REBUILD_STEPS_AFTER_ROLLOUT[@]}"}',
  'run_env_hooks ${ENV_REBUILD_STEPS_AFTER_DEPLOY[@]+"${ENV_REBUILD_STEPS_AFTER_DEPLOY[@]}"}',
  'printf "done"',
].join("\n");

describe("env extensions", () => {
  it("says when no extensions are loaded and runs every hook point under nounset", () => {
    const root = mkdtempSync(path.join(tmpdir(), "octogee-env-ext-empty-"));
    const result = run(root, allHooks);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("No env extensions loaded\ndone");
  });

  it("sources each extension's env.sh and runs its hooks in registration order", () => {
    const root = mkdtempSync(path.join(tmpdir(), "octogee-env-ext-"));
    mkdirSync(path.join(root, "extra"));
    writeFileSync(path.join(root, "extra/env.sh"), [
      "ENV_VERIFY_SECTIONS+=(verify_extra)",
      "ENV_REBUILD_STEPS_AFTER_ROLLOUT+=(rollout_extra)",
      "ENV_REBUILD_STEPS_AFTER_DEPLOY+=(deploy_extra deploy_extra_again)",
      'verify_extra() { printf "verify;"; }',
      'rollout_extra() { printf "rollout;"; }',
      'deploy_extra() { printf "deploy;"; }',
      'deploy_extra_again() { printf "deploy-again;"; }',
    ].join("\n"));
    const result = run(root, allHooks);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("Env extensions loaded: extra\nverify;rollout;deploy;deploy-again;done");
  });

  it("propagates a failing hook", () => {
    const root = mkdtempSync(path.join(tmpdir(), "octogee-env-ext-fail-"));
    mkdirSync(path.join(root, "extra"));
    writeFileSync(path.join(root, "extra/env.sh"), "ENV_VERIFY_SECTIONS+=(verify_extra)\nverify_extra() { return 3; }\n");
    const result = run(root, 'run_env_hooks "${ENV_VERIFY_SECTIONS[@]}"\nprintf "after"');

    expect(result.status).toBe(3);
    expect(result.stdout).toBe("Env extensions loaded: extra\n");
  });

  it("is loaded by verify-env from its own directory before it runs the extension sections", () => {
    const source = readFileSync(path.resolve(import.meta.dirname, "../verify-env.sh"), "utf8");
    const helper = source.indexOf('source "$SCRIPT_DIR/lib/env-extensions.sh"');
    const load = source.indexOf('load_env_extensions "$SCRIPT_DIR"');
    const sections = source.indexOf('run_env_hooks ${ENV_VERIFY_SECTIONS[@]+"${ENV_VERIFY_SECTIONS[@]}"}');

    expect(helper).toBeGreaterThan(-1);
    expect(load).toBeGreaterThan(helper);
    expect(sections).toBeGreaterThan(load);
  });
});
