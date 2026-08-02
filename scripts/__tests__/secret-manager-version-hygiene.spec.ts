import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");

const writers = [
  { label: "setup-gitea.sh", file: path.join(repoRoot, "scripts/setup-gitea.sh") },
  { label: "setup-secrets.sh", file: path.join(repoRoot, "scripts/setup-secrets.sh") },
];

const helperNames = [
  "secret_manager_destroy_superseded_versions",
  "secret_manager_persist_version_file",
  "secret_manager_persist_value",
];

function extractFunction(source: string, name: string): string {
  const opening = `\n${name}() {\n`;
  const start = source.indexOf(opening);
  if (start < 0) {
    throw new Error(`shell function ${name} is not defined`);
  }
  const end = source.indexOf("\n}\n", start);
  if (end < 0) {
    throw new Error(`shell function ${name} is not terminated`);
  }
  return source.slice(start + 1, end + 3);
}

const fakeGcloud = `#!/usr/bin/env bash
set -uo pipefail
printf 'gcloud %s\\n' "$*" >> "$FAKE_CALL_LOG"

project=""
secret=""
data_file=""
positional=()
for arg in "$@"; do
  case "$arg" in
    --project=*) project="\${arg#--project=}" ;;
    --secret=*) secret="\${arg#--secret=}" ;;
    --data-file=*) data_file="\${arg#--data-file=}" ;;
    --*) ;;
    *) positional+=("$arg") ;;
  esac
done

secret_dir() { printf '%s/%s/%s' "$FAKE_SM_DIR" "$project" "$1"; }

highest_version() {
  local dir="$1" max=0 file version
  for file in "$dir"/*.state; do
    [[ -e "$file" ]] || continue
    version="$(basename "$file" .state)"
    if (( version > max )); then max="$version"; fi
  done
  printf '%s' "$max"
}

case "\${positional[0]:-} \${positional[1]:-}" in
  "secrets describe")
    [[ -d "$(secret_dir "\${positional[2]}")" ]] || exit 1
    ;;
  "secrets create")
    name="\${positional[2]}"
    dir="$(secret_dir "$name")"
    if [[ -d "$dir" ]]; then echo "already exists: $name" >&2; exit 1; fi
    if [[ "$FAKE_FAIL_CREATE" == "$name" ]]; then echo "fake create failure" >&2; exit 1; fi
    mkdir -p "$dir"
    cp "$data_file" "$dir/1.payload"
    printf 'ENABLED' > "$dir/1.state"
    ;;
  "secrets versions")
    case "\${positional[2]}" in
      access)
        dir="$(secret_dir "$secret")"
        [[ -d "$dir" ]] || exit 1
        version="$(highest_version "$dir")"
        [[ "$version" == "0" ]] && exit 1
        [[ "$(cat "$dir/$version.state")" == "ENABLED" ]] || exit 1
        cat "$dir/$version.payload"
        ;;
      add)
        name="\${positional[3]}"
        dir="$(secret_dir "$name")"
        [[ -d "$dir" ]] || { echo "missing secret: $name" >&2; exit 1; }
        if [[ "$FAKE_FAIL_ADD" == "$name" ]]; then echo "fake add failure" >&2; exit 1; fi
        version="$(( $(highest_version "$dir") + 1 ))"
        cp "$data_file" "$dir/$version.payload"
        printf 'ENABLED' > "$dir/$version.state"
        ;;
      list)
        name="\${positional[3]}"
        dir="$(secret_dir "$name")"
        [[ -d "$dir" ]] || { echo "missing secret: $name" >&2; exit 1; }
        if [[ "$FAKE_FAIL_LIST" == "$name" ]]; then echo "fake list failure" >&2; exit 1; fi
        for file in "$dir"/*.state; do
          [[ -e "$file" ]] || continue
          version="$(basename "$file" .state)"
          printf 'projects/%s/secrets/%s/versions/%s\\t%s\\n' "$project" "$name" "$version" "$(cat "$file")"
        done
        ;;
      destroy)
        version="\${positional[3]}"
        dir="$(secret_dir "$secret")"
        if [[ "$FAKE_FAIL_DESTROY" == "$secret" ]]; then echo "fake destroy failure" >&2; exit 1; fi
        printf 'DESTROYED' > "$dir/$version.state"
        ;;
      *) echo "unexpected gcloud versions call: $*" >&2; exit 2 ;;
    esac
    ;;
  *) echo "unexpected gcloud call: $*" >&2; exit 2 ;;
esac
`;

type SeededVersion = { payload: string; state?: "ENABLED" | "DISABLED" | "DESTROYED" };

type HygieneRun = {
  helpers: string;
  call: string;
  project?: string;
  secret: string;
  versions?: Record<number, SeededVersion>;
  failCreate?: string;
  failAdd?: string;
  failList?: string;
  failDestroy?: string;
};

type HygieneResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  calls: string[];
  versions: { version: number; state: string; payload: string }[];
};

function runHygiene(options: HygieneRun): HygieneResult {
  const temp = mkdtempSync(path.join(tmpdir(), "octogee-secret-hygiene-"));
  const binDir = path.join(temp, "bin");
  const stateDir = path.join(temp, "sm");
  const project = options.project ?? "octogee";
  mkdirSync(binDir);
  mkdirSync(path.join(stateDir, project), { recursive: true });

  const gcloud = path.join(binDir, "gcloud");
  writeFileSync(gcloud, fakeGcloud);
  chmodSync(gcloud, 0o755);

  const calls = path.join(temp, "calls.log");
  writeFileSync(calls, "");

  const secretDir = path.join(stateDir, project, options.secret);
  if (options.versions) {
    mkdirSync(secretDir, { recursive: true });
    for (const [version, seeded] of Object.entries(options.versions)) {
      writeFileSync(path.join(secretDir, `${version}.payload`), seeded.payload);
      writeFileSync(path.join(secretDir, `${version}.state`), seeded.state ?? "ENABLED");
    }
  }

  const harness = path.join(temp, "harness.sh");
  writeFileSync(harness, ["set -euo pipefail", 'TARGET_REGION="us-central1"', options.helpers, options.call].join("\n"));

  const result = spawnSync("bash", [harness], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      FAKE_CALL_LOG: calls,
      FAKE_SM_DIR: stateDir,
      FAKE_FAIL_CREATE: options.failCreate ?? "",
      FAKE_FAIL_ADD: options.failAdd ?? "",
      FAKE_FAIL_LIST: options.failList ?? "",
      FAKE_FAIL_DESTROY: options.failDestroy ?? "",
    },
    encoding: "utf8",
  });

  const versions: HygieneResult["versions"] = [];
  const stateFiles = existsSync(secretDir)
    ? readdirSync(secretDir).filter((name) => name.endsWith(".state"))
    : [];
  for (const entry of stateFiles) {
    const version = Number(entry.replace(/\.state$/, ""));
    versions.push({
      version,
      state: readFileSync(path.join(secretDir, entry), "utf8"),
      payload: readFileSync(path.join(secretDir, `${version}.payload`), "utf8"),
    });
  }
  versions.sort((left, right) => left.version - right.version);

  const output = {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    calls: readFileSync(calls, "utf8").trim().split("\n").filter(Boolean),
    versions,
  };
  rmSync(temp, { recursive: true, force: true });
  return output;
}

describe("Secret Manager version hygiene helper parity", () => {
  it("keeps both bootstrap writers on the same helper text", () => {
    const [gitea, secrets] = writers.map((writer) => {
      const source = readFileSync(writer.file, "utf8");
      return helperNames.map((name) => extractFunction(source, name)).join("\n");
    });

    expect(gitea).toBe(secrets);
  });
});

for (const writer of writers) {
  const source = readFileSync(writer.file, "utf8");
  const helpers = () => helperNames.map((name) => extractFunction(source, name)).join("\n");
  const persist = (secret: string, value: string, project = "octogee") =>
    `secret_manager_persist_value ${JSON.stringify(secret)} ${JSON.stringify(value)} ${JSON.stringify(project)}`;

  describe(`${writer.label} Secret Manager version hygiene`, () => {
    it("creates the secret when Secret Manager has none", () => {
      const result = runHygiene({
        helpers: helpers(),
        secret: "gitea-api-token-test",
        call: persist("gitea-api-token-test", "token-one"),
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.versions).toEqual([{ version: 1, state: "ENABLED", payload: "token-one" }]);
      expect(result.calls.some((call) => call.includes("versions add"))).toBe(false);
      expect(result.calls.some((call) => call.includes("versions destroy"))).toBe(false);
    });

    it("skips the add entirely when the value already matches the latest payload", () => {
      const result = runHygiene({
        helpers: helpers(),
        secret: "gitea-api-token-test",
        versions: { 1: { payload: "token-one" } },
        call: persist("gitea-api-token-test", "token-one"),
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.versions).toEqual([{ version: 1, state: "ENABLED", payload: "token-one" }]);
      expect(result.calls.some((call) => call.includes("versions add"))).toBe(false);
      expect(result.calls.some((call) => call.includes("versions list"))).toBe(false);
    });

    it("treats a payload that differs only by trailing bytes as changed", () => {
      const result = runHygiene({
        helpers: helpers(),
        secret: "gitea-api-token-test",
        versions: { 1: { payload: "token-one\n" } },
        call: persist("gitea-api-token-test", "token-one"),
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.versions).toEqual([
        { version: 1, state: "DESTROYED", payload: "token-one\n" },
        { version: 2, state: "ENABLED", payload: "token-one" },
      ]);
    });

    it("destroys every older live version once a new version is added", () => {
      const result = runHygiene({
        helpers: helpers(),
        secret: "gitea-api-token-test",
        versions: {
          1: { payload: "token-one" },
          2: { payload: "token-two", state: "DISABLED" },
          3: { payload: "token-three" },
        },
        call: persist("gitea-api-token-test", "token-four"),
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.versions).toEqual([
        { version: 1, state: "DESTROYED", payload: "token-one" },
        { version: 2, state: "DESTROYED", payload: "token-two" },
        { version: 3, state: "DESTROYED", payload: "token-three" },
        { version: 4, state: "ENABLED", payload: "token-four" },
      ]);
      expect(result.calls.filter((call) => call.includes("versions destroy"))).toHaveLength(3);
    });

    it("keeps the numerically newest version when version numbers pass ten", () => {
      const result = runHygiene({
        helpers: helpers(),
        secret: "gitea-api-token-test",
        versions: {
          9: { payload: "token-nine" },
          10: { payload: "token-ten" },
        },
        call: persist("gitea-api-token-test", "token-next"),
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.versions).toEqual([
        { version: 9, state: "DESTROYED", payload: "token-nine" },
        { version: 10, state: "DESTROYED", payload: "token-ten" },
        { version: 11, state: "ENABLED", payload: "token-next" },
      ]);
    });

    it("adds a version when the secret exists with no accessible version", () => {
      const result = runHygiene({
        helpers: helpers(),
        secret: "gitea-api-token-test",
        versions: { 1: { payload: "token-one", state: "DESTROYED" } },
        call: persist("gitea-api-token-test", "token-two"),
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.versions).toEqual([
        { version: 1, state: "DESTROYED", payload: "token-one" },
        { version: 2, state: "ENABLED", payload: "token-two" },
      ]);
      expect(result.calls.some((call) => call.includes("versions destroy"))).toBe(false);
    });

    it("reports every destroy failure on stderr and still reports the value persisted", () => {
      const result = runHygiene({
        helpers: helpers(),
        secret: "gitea-api-token-test",
        versions: { 1: { payload: "token-one" }, 2: { payload: "token-two" } },
        failDestroy: "gitea-api-token-test",
        call: persist("gitea-api-token-test", "token-three"),
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toContain(
        "Failed to destroy superseded Secret Manager version octogee/gitea-api-token-test/1",
      );
      expect(result.stderr).toContain(
        "Failed to destroy superseded Secret Manager version octogee/gitea-api-token-test/2",
      );
      expect(result.stderr).toContain("Superseded Secret Manager versions remain for octogee/gitea-api-token-test");
      expect(result.versions).toContainEqual({ version: 3, state: "ENABLED", payload: "token-three" });
    });

    it("reports a version listing failure on stderr rather than destroying blind", () => {
      const result = runHygiene({
        helpers: helpers(),
        secret: "gitea-api-token-test",
        versions: { 1: { payload: "token-one" } },
        failList: "gitea-api-token-test",
        call: persist("gitea-api-token-test", "token-two"),
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toContain("Could not list Secret Manager versions for octogee/gitea-api-token-test");
      expect(result.calls.some((call) => call.includes("versions destroy"))).toBe(false);
    });

    it("fails loudly and nonzero when the value cannot be persisted", () => {
      const added = runHygiene({
        helpers: helpers(),
        secret: "gitea-api-token-test",
        versions: { 1: { payload: "token-one" } },
        failAdd: "gitea-api-token-test",
        call: persist("gitea-api-token-test", "token-two"),
      });
      const created = runHygiene({
        helpers: helpers(),
        secret: "gitea-api-token-test",
        failCreate: "gitea-api-token-test",
        call: persist("gitea-api-token-test", "token-one"),
      });

      expect(added.status).not.toBe(0);
      expect(added.stderr).toContain("Could not add Secret Manager version for octogee/gitea-api-token-test");
      expect(added.calls.some((call) => call.includes("versions destroy"))).toBe(false);
      expect(created.status).not.toBe(0);
      expect(created.stderr).toContain("Could not create Secret Manager secret octogee/gitea-api-token-test");
    });

    it("persists a file payload byte for byte", () => {
      const result = runHygiene({
        helpers: helpers(),
        secret: "FLEET_CONTROLLER_PRIVATE_KEY",
        project: "octogee-test",
        versions: { 1: { payload: "old-key\n" } },
        call: [
          'payload="$(mktemp)"',
          `printf '%s' 'new-key
' > "$payload"`,
          'secret_manager_persist_version_file "FLEET_CONTROLLER_PRIVATE_KEY" "$payload" "octogee-test"',
        ].join("\n"),
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.versions).toEqual([
        { version: 1, state: "DESTROYED", payload: "old-key\n" },
        { version: 2, state: "ENABLED", payload: "new-key\n" },
      ]);
    });

    it("routes every Secret Manager write through the shared hygiene helper", () => {
      const addSites = source.split("gcloud secrets versions add").length - 1;
      const createSites = source.split("gcloud secrets create").length - 1;
      const helperBody = extractFunction(source, "secret_manager_persist_version_file");

      expect(addSites).toBe(1);
      expect(createSites).toBe(1);
      expect(helperBody).toContain("gcloud secrets versions add");
      expect(helperBody).toContain("gcloud secrets create");
      expect(source).not.toContain("versionDestroyTtl");
      expect(source).not.toContain("--version-destroy-ttl");
    });
  });
}
