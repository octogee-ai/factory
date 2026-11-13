import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");
const script = path.join(repoRoot, "scripts/ops/prune-secret-manager-versions.sh");

type RunOptions = {
  apply?: boolean;
  project?: string;
  confirmation?: string;
  dirty?: boolean;
  latestDisabled?: boolean;
  failDestroy?: boolean;
};

function executable(file: string, source: string): void {
  writeFileSync(file, source);
  chmodSync(file, 0o755);
}

function runPruner(options: RunOptions = {}) {
  const temp = mkdtempSync(path.join(tmpdir(), "octogee-secret-version-prune-"));
  const calls = path.join(temp, "calls.log");
  writeFileSync(calls, "");

  executable(path.join(temp, "git"), `#!/usr/bin/env bash
set -euo pipefail
printf 'git %s\\n' "$*" >> "$FAKE_CALL_LOG"
case "$*" in
  *" status --porcelain") [[ "$FAKE_DIRTY" == "true" ]] && printf '%s\\n' ' M dirty' ;;
  *" fetch --quiet origin main") ;;
  *" rev-parse HEAD"|*" rev-parse refs/remotes/origin/main") printf '%s\\n' 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' ;;
  *) printf 'unexpected git call: %s\\n' "$*" >&2; exit 2 ;;
esac
`);

  executable(path.join(temp, "gcloud"), `#!/usr/bin/env bash
set -euo pipefail
printf 'gcloud %s\\n' "$*" >> "$FAKE_CALL_LOG"
case "$1 $2 $3" in
  "secrets list --project="*)
    printf '%s\\n' '[{"name":"projects/octogee/secrets/alpha"},{"name":"projects/octogee/secrets/beta"},{"name":"projects/octogee/secrets/byok-user-openai","labels":{"uid":"builder-uid"}},{"name":"projects/octogee/secrets/byosub-user-openai"},{"name":"projects/octogee/secrets/gateway-model-key-user","labels":{"octogee_kind":"gateway_model_key"}}]'
    ;;
  "secrets versions list")
    secret="$4"
    if [[ "$secret" == "alpha" ]]; then
      latest_state=ENABLED; [[ "$FAKE_LATEST_DISABLED" == "true" ]] && latest_state=DISABLED
      state2=ENABLED; [[ -f "$FAKE_DESTROYED_2" ]] && state2=DESTROYED
      state1=DISABLED; [[ -f "$FAKE_DESTROYED_1" ]] && state1=DESTROYED
      printf '[{"name":"projects/octogee/secrets/alpha/versions/3","state":"%s","createTime":"2026-07-22T03:00:00Z"},{"name":"projects/octogee/secrets/alpha/versions/2","state":"%s","createTime":"2026-07-22T02:00:00Z"},{"name":"projects/octogee/secrets/alpha/versions/1","state":"%s","createTime":"2026-07-22T01:00:00Z"}]\\n' "$latest_state" "$state2" "$state1"
    else
      printf '%s\\n' '[{"name":"projects/octogee/secrets/beta/versions/1","state":"ENABLED","createTime":"2026-07-22T01:00:00Z"}]'
    fi
    ;;
  "secrets versions destroy")
    [[ "$FAKE_FAIL_DESTROY" == "true" ]] && exit 1
    version="$4"
    touch "$FAKE_DESTROYED_DIR/$version"
    ;;
  "storage cp "*) ;;
  *) printf 'unexpected gcloud call: %s\\n' "$*" >&2; exit 2 ;;
esac
`);

  const project = options.project ?? "octogee";
  const args = [script, `--project=${project}`];
  if (options.apply) {
    args.push("--apply");
    args.push(`--confirm=${options.confirmation ?? `octogee/secret-versions/${project}`}`);
  }
  const result = spawnSync("bash", args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${temp}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      FAKE_CALL_LOG: calls,
      FAKE_DIRTY: options.dirty ? "true" : "false",
      FAKE_LATEST_DISABLED: options.latestDisabled ? "true" : "false",
      FAKE_FAIL_DESTROY: options.failDestroy ? "true" : "false",
      FAKE_DESTROYED_DIR: temp,
      FAKE_DESTROYED_1: path.join(temp, "1"),
      FAKE_DESTROYED_2: path.join(temp, "2"),
      SECRET_PRUNE_RUN_ID: "20260722t230000z",
    },
    encoding: "utf8",
  });
  const output = {
    ...result,
    calls: readFileSync(calls, "utf8").trim().split("\n").filter(Boolean),
  };
  rmSync(temp, { recursive: true, force: true });
  return output;
}

describe("Secret Manager version pruning", () => {
  it("defaults to a metadata-only dry run", () => {
    const result = runPruner();

    expect(result.status, result.stderr).toBe(0);
    expect(result.calls.some((call) => call.includes("versions destroy"))).toBe(false);
    expect(result.calls.some((call) => call.startsWith("gcloud storage cp"))).toBe(false);
    expect(result.calls.some((call) => call.includes("byok-user-openai"))).toBe(false);
    expect(result.calls.some((call) => call.includes("byosub-user-openai"))).toBe(false);
    expect(result.calls.some((call) => call.includes("gateway-model-key-user"))).toBe(false);
    expect(JSON.parse(result.stdout)).toMatchObject({
      phase: "secret-manager-version-prune",
      project: "octogee",
      mode: "dry-run",
      excludedUserCredentials: 3,
      candidates: [
        { secret: "alpha", keptVersion: "3", versions: [{ version: "2" }, { version: "1" }] },
      ],
    });
  });

  it("destroys every superseded enabled or disabled version and uploads a receipt", () => {
    const result = runPruner({ apply: true });

    expect(result.status, result.stderr).toBe(0);
    expect(result.calls.filter((call) => call.includes("versions destroy"))).toHaveLength(2);
    expect(result.calls.some((call) => call.startsWith("gcloud storage cp"))).toBe(true);
    expect(JSON.parse(result.stdout)).toMatchObject({
      project: "octogee",
      mode: "apply",
      destroyedVersions: 2,
      cleanup: "verified",
    });
  });

  it("requires exact confirmation and clean merged main before apply", () => {
    const wrong = runPruner({ apply: true, confirmation: "wrong" });
    const dirty = runPruner({ apply: true, dirty: true });

    expect(wrong.status).not.toBe(0);
    expect(wrong.stderr).toContain("requires --confirm=octogee/secret-versions/octogee");
    expect(wrong.calls).toEqual([]);
    expect(dirty.status).not.toBe(0);
    expect(dirty.stderr).toContain("working tree must be clean");
    expect(dirty.calls.some((call) => call.startsWith("gcloud "))).toBe(false);
  });

  it("refuses to prune when the newest version is not enabled", () => {
    const result = runPruner({ latestDisabled: true });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("newest version is not enabled");
    expect(result.calls.some((call) => call.includes("versions destroy"))).toBe(false);
  });

  it("fails loudly and withholds the receipt when destruction fails", () => {
    const result = runPruner({ apply: true, failDestroy: true });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Failed to destroy superseded version");
    expect(result.calls.some((call) => call.startsWith("gcloud storage cp"))).toBe(false);
  });

  it("rejects projects outside the exact platform allowlist", () => {
    const result = runPruner({ project: "other" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "Project must be octogee, octogee-test, octogee-data-test, or octogee-data-prod",
    );
    expect(result.calls).toEqual([]);
  });

  it("prunes the octogee-test data project", () => {
    const dryRun = runPruner({ project: "octogee-test" });
    const applied = runPruner({ project: "octogee-test", apply: true });

    expect(dryRun.status, dryRun.stderr).toBe(0);
    expect(JSON.parse(dryRun.stdout)).toMatchObject({ project: "octogee-test", mode: "dry-run" });
    expect(applied.status, applied.stderr).toBe(0);
    expect(applied.calls.filter((call) => call.includes("versions destroy"))).toHaveLength(2);
    expect(JSON.parse(applied.stdout)).toMatchObject({
      project: "octogee-test",
      mode: "apply",
      destroyedVersions: 2,
      cleanup: "verified",
    });
  });

  it("derives the confirmation string from the octogee-test project", () => {
    const result = runPruner({ project: "octogee-test", apply: true, confirmation: "octogee/secret-versions/octogee" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("requires --confirm=octogee/secret-versions/octogee-test");
    expect(result.calls).toEqual([]);
  });

  it("still accepts the previously allowed platform projects", () => {
    for (const project of ["octogee", "octogee-data-test", "octogee-data-prod"]) {
      const result = runPruner({ project });

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ project, mode: "dry-run" });
    }
  });
});
