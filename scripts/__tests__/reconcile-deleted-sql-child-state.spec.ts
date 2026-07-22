import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const subject = resolve(__dirname, "../ops/reconcile-deleted-sql-child-state.sh");
const selector = resolve(__dirname, "../ops/terraform-protection-targets.mjs");
const candidates = [
  'google_sql_database.environment["gitea_prod"]',
  'google_sql_database.environment["gitea_test"]',
  'google_sql_database.environment["mattermost_prod"]',
  'google_sql_database.environment["mattermost_test"]',
];

type Harness = ReturnType<typeof createHarness>;
const roots: string[] = [];

const createHarness = (stateAddresses = candidates) => {
  const root = mkdtempSync(join(tmpdir(), "octogee-sql-state-reconcile-"));
  roots.push(root);
  const fakeBin = join(root, "bin");
  const stateFile = join(root, "state.txt");
  const commandLog = join(root, "commands.log");
  const uploadDir = join(root, "uploads");
  const tempDir = join(root, "receipts");
  const terraform = join(fakeBin, "terraform");
  const gcloud = join(fakeBin, "gcloud");
  spawnSync("mkdir", ["-p", fakeBin, uploadDir, tempDir]);
  writeFileSync(stateFile, `${stateAddresses.join("\n")}\n`);
  writeFileSync(commandLog, "");
  writeFileSync(
    terraform,
    `#!/usr/bin/env bash
set -euo pipefail
printf 'terraform %s\\n' "$*" >>"$FAKE_COMMAND_LOG"
if [[ "$1" == "state" && "$2" == "list" ]]; then
  cat "$FAKE_STATE_FILE"
  exit 0
fi
if [[ "$1" == "state" && "$2" == "rm" ]]; then
  address="$3"
  if [[ "\${FAIL_STATE_RM_ADDRESS:-}" == "$address" && ! -f "$FAKE_STATE_RM_FAILURE_MARKER" ]]; then
    : >"$FAKE_STATE_RM_FAILURE_MARKER"
    exit 9
  fi
  grep -Fvx -- "$address" "$FAKE_STATE_FILE" >"$FAKE_STATE_FILE.next" || true
  mv "$FAKE_STATE_FILE.next" "$FAKE_STATE_FILE"
  exit 0
fi
exit 10
`,
  );
  writeFileSync(
    gcloud,
    `#!/usr/bin/env bash
set -euo pipefail
printf 'gcloud %s\\n' "$*" >>"$FAKE_COMMAND_LOG"
if [[ "$1" == "sql" && "$2" == "instances" && "$3" == "list" ]]; then
  if [[ "\${FAIL_SQL_DISCOVERY:-false}" == "true" ]]; then exit 8; fi
  printf '%s' "\${FAKE_SQL_INVENTORY:-}"
  exit 0
fi
if [[ "$1" == "storage" && "$2" == "cp" ]]; then
  destination="$4"
  if [[ "\${FAIL_COMPLETION_UPLOAD:-false}" == "true" && "$destination" == *-sql-child-state-retirement-* && "$destination" != *-pre-sql-child-state-retirement-* ]]; then
    exit 7
  fi
  cp "$3" "$FAKE_UPLOAD_DIR/$(basename "$destination")"
  exit 0
fi
exit 11
`,
  );
  chmodSync(terraform, 0o755);
  chmodSync(gcloud, 0o755);
  return {
    root,
    stateFile,
    commandLog,
    uploadDir,
    tempDir,
    terraform,
    failureMarker: join(root, "state-rm.failed"),
  };
};

const run = (harness: Harness, environment: Record<string, string> = {}) =>
  spawnSync(
    "bash",
    [
      subject,
      "--project=octogee",
      "--instance=octogee-pg-west",
      `--terraform-bin=${harness.terraform}`,
      `--selector=${selector}`,
      "--receipt-bucket=gs://octogee-test/receipts",
      "--run-timestamp=20260722T203000Z",
      "--git-commit=9379a5e5b",
      `--temp-dir=${harness.tempDir}`,
      ...candidates.map((address) => `--candidate=${address}`),
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${join(harness.root, "bin")}:${process.env.PATH}`,
        FAKE_STATE_FILE: harness.stateFile,
        FAKE_COMMAND_LOG: harness.commandLog,
        FAKE_UPLOAD_DIR: harness.uploadDir,
        FAKE_STATE_RM_FAILURE_MARKER: harness.failureMarker,
        ...environment,
      },
    },
  );

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("deleted Cloud SQL child-state reconciliation", () => {
  it("does nothing when the exact Cloud SQL parent is present", () => {
    const harness = createHarness();
    const result = run(harness, { FAKE_SQL_INVENTORY: "octogee-pg-west\n" });

    expect(result.status).toBe(0);
    expect(readFileSync(harness.stateFile, "utf8").trim().split("\n")).toEqual(candidates);
    expect(readFileSync(harness.commandLog, "utf8")).not.toContain("state rm");
    expect(readdirSync(harness.uploadDir)).toEqual([]);
  });

  it("fails closed when Cloud SQL inventory discovery fails", () => {
    const harness = createHarness();
    const result = run(harness, { FAIL_SQL_DISCOVERY: "true" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Cloud SQL inventory discovery failed; refusing state retirement");
    expect(readFileSync(harness.commandLog, "utf8")).not.toContain("state rm");
  });

  it("removes only the allowlisted children and uploads intent plus verified completion", () => {
    const unrelated = "google_compute_network.west";
    const harness = createHarness([...candidates, unrelated]);
    const result = run(harness);

    expect(result.status).toBe(0);
    expect(readFileSync(harness.stateFile, "utf8").trim()).toBe(unrelated);
    const uploads = readdirSync(harness.uploadDir);
    expect(uploads.some((name) => name.includes("pre-sql-child-state-retirement"))).toBe(true);
    const completion = uploads.find(
      (name) => name.includes("sql-child-state-retirement") && !name.includes("pre-sql-child-state-retirement"),
    );
    expect(completion).toBeDefined();
    const receipt = JSON.parse(readFileSync(join(harness.uploadDir, completion!), "utf8"));
    expect(receipt.retiredThisRun).toEqual(candidates);
    expect(receipt.verifiedAbsentStateAddresses).toEqual(candidates);
    expect(receipt.remainingStateAddresses).toEqual([]);
  });

  it("resumes a partial state-removal failure and proves completion", () => {
    const harness = createHarness();
    const first = run(harness, { FAIL_STATE_RM_ADDRESS: candidates[1] });

    expect(first.status).not.toBe(0);
    expect(readFileSync(harness.stateFile, "utf8").trim().split("\n")).toEqual(candidates.slice(1));

    const second = run(harness, { FAIL_STATE_RM_ADDRESS: candidates[1] });
    expect(second.status).toBe(0);
    expect(readFileSync(harness.stateFile, "utf8")).toBe("");
  });

  it("publishes completion on rerun after interruption following the last removal", () => {
    const harness = createHarness();
    const first = run(harness, { FAIL_COMPLETION_UPLOAD: "true" });

    expect(first.status).not.toBe(0);
    expect(readFileSync(harness.stateFile, "utf8")).toBe("");

    const second = run(harness);
    expect(second.status).toBe(0);
    const completion = readdirSync(harness.uploadDir).find(
      (name) => name.includes("sql-child-state-retirement") && !name.includes("pre-sql-child-state-retirement"),
    );
    expect(completion).toBeDefined();
    const receipt = JSON.parse(readFileSync(join(harness.uploadDir, completion!), "utf8"));
    expect(receipt.retiredThisRun).toEqual([]);
    expect(receipt.verifiedAbsentStateAddresses).toEqual(candidates);
    expect(receipt.remainingStateAddresses).toEqual([]);
  });
});
