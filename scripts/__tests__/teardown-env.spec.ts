import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");
const teardown = path.join(repoRoot, "scripts/teardown-env.sh");

function executable(file: string, source: string): void {
  writeFileSync(file, source);
  chmodSync(file, 0o755);
}

type TeardownOptions = {
  databaseFailure?: "inspect" | "delete" | "create" | "verify-command" | "verify-value";
  publicIp?: boolean;
  pvcFailure?: "inspect" | "delete" | "finalize";
  secretFailure?: "absent" | "error";
};

function runPrivateWestTeardown(options: TeardownOptions = {}) {
  const temp = mkdtempSync(path.join(tmpdir(), "octogee-teardown-private-west-"));
  const log = path.join(temp, "calls.log");
  const describeCount = path.join(temp, "describe-count");
  const deletedPvcs = path.join(temp, "deleted-pvcs");
  writeFileSync(log, "");
  writeFileSync(describeCount, "0");
  writeFileSync(deletedPvcs, "");

  executable(path.join(temp, "gcloud"), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_CALL_LOG"
case "$1 $2 $3" in
  "container clusters get-credentials") ;;
  "secrets versions access")
    case "$FAKE_SECRET_FAILURE" in
      absent) printf 'NOT_FOUND: secret does not exist\\n' >&2; exit 1 ;;
      error) printf 'PERMISSION_DENIED\\n' >&2; exit 2 ;;
      *) printf 'retained-password' ;;
    esac
    ;;
  "sql instances describe")
    if [[ "$FAKE_PUBLIC_IP" == "true" ]]; then
      printf 'PRIMARY\\n'
    else
      printf '%s\\n' '{"ipAddresses":[{"type":"PRIVATE","ipAddress":"10.0.0.4"}]}'
    fi
    ;;
  "sql databases delete")
    [[ "$FAKE_DATABASE_FAILURE" != "delete" ]]
    ;;
  "sql databases create")
    [[ "$FAKE_DATABASE_FAILURE" != "create" ]]
    ;;
  "sql databases describe")
    count="$(cat "$FAKE_DESCRIBE_COUNT")"
    count=$((count + 1))
    printf '%s' "$count" > "$FAKE_DESCRIBE_COUNT"
    if [[ "$FAKE_DATABASE_FAILURE" == "inspect" && "$count" == "1" ]]; then
      printf 'PERMISSION_DENIED\\n' >&2
      exit 2
    fi
    if [[ "$FAKE_DATABASE_FAILURE" == "verify-command" && "$count" == "2" ]]; then
      printf 'verification unavailable\\n' >&2
      exit 2
    fi
    if [[ "$FAKE_DATABASE_FAILURE" == "verify-value" && "$count" == "2" ]]; then
      printf 'wrong_database\\n'
    else
      printf '%s\\n' "$4"
    fi
    ;;
  "secrets list "*|"run services list "*) ;;
  *) printf 'unexpected gcloud call: %s\\n' "$*" >&2; exit 2 ;;
esac
`);

  executable(path.join(temp, "kubectl"), `#!/usr/bin/env bash
set -euo pipefail
printf 'kubectl %s\\n' "$*" >> "$FAKE_CALL_LOG"
case "$1 $2" in
  "config use-context") ;;
  "config current-context") printf 'gke_octogee_us-west1_octogee-gateway\\n' ;;
  "get pvc")
    pvc="$3"
    if [[ "$FAKE_PVC_FAILURE" == "inspect" && "$pvc" == "gitea-shared-storage" ]]; then
      printf 'persistentvolumeclaims is forbidden\\n' >&2
      exit 2
    fi
    if grep -Fxq "finalized:$pvc" "$FAKE_DELETED_PVCS"; then
      exit 0
    fi
    printf 'persistentvolumeclaim/%s\\n' "$pvc"
    ;;
  "delete pvc")
    pvc="$3"
    if [[ "$FAKE_PVC_FAILURE" == "delete" && "$pvc" == "gitea-shared-storage" ]]; then
      printf 'delete forbidden\\n' >&2
      exit 1
    fi
    printf 'deleted:%s\\n' "$pvc" >> "$FAKE_DELETED_PVCS"
    ;;
  "wait --for=delete")
    if [[ "$FAKE_PVC_FAILURE" == "finalize" && "$3" == "pvc/mattermost-data" ]]; then
      printf 'timed out waiting for PVC deletion\\n' >&2
      exit 1
    fi
    printf 'finalized:%s\\n' "\${3#pvc/}" >> "$FAKE_DELETED_PVCS"
    ;;
  *) ;;
esac
`);

  executable(path.join(temp, "helm"), `#!/usr/bin/env bash
set -euo pipefail
case "$1" in status) exit 1 ;; list) ;; *) ;; esac
`);
  executable(path.join(temp, "cloud-sql-proxy"), "#!/usr/bin/env bash\nset -euo pipefail\nsleep 300\n");
  executable(path.join(temp, "lsof"), "#!/usr/bin/env bash\nset -euo pipefail\nexit 1\n");
  executable(path.join(temp, "nc"), "#!/usr/bin/env bash\nset -euo pipefail\n");
  executable(path.join(temp, "psql"), "#!/usr/bin/env bash\nset -euo pipefail\necho 'connection to server failed: Connection refused' >&2\nexit 1\n");
  executable(path.join(temp, "firebase"), "#!/usr/bin/env bash\nset -euo pipefail\n");

  const result = spawnSync("bash", [teardown, "--env=test", "--deployment-target=test-west", "--full", "--yes"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${temp}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      FAKE_CALL_LOG: log,
      FAKE_DATABASE_FAILURE: options.databaseFailure ?? "",
      FAKE_DESCRIBE_COUNT: describeCount,
      FAKE_DELETED_PVCS: deletedPvcs,
      FAKE_PUBLIC_IP: options.publicIp ? "true" : "false",
      FAKE_PVC_FAILURE: options.pvcFailure ?? "",
      FAKE_SECRET_FAILURE: options.secretFailure ?? "",
      SA_KEY_PATH: path.join(temp, "missing-service-account.json"),
    },
    encoding: "utf8",
  });

  return {
    ...result,
    calls: readFileSync(log, "utf8").trim().split("\n").filter(Boolean),
  };
}

describe("full teardown for private-only Cloud SQL", { timeout: 15_000 }, () => {
  it("describes full teardown as deleting its durable PVCs", () => {
    const result = spawnSync("bash", [teardown, "--help"], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("deletes durable PVCs");
    expect(result.stdout).not.toContain("Still preserves PVCs");
  });

  it("resets test-west through the Cloud SQL Admin API without a local proxy", () => {
    const result = runPrivateWestTeardown();

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(result.calls).toContainEqual(expect.stringContaining("sql databases delete mattermost_test"));
    expect(result.calls).toContainEqual(expect.stringContaining("sql databases create mattermost_test"));
    expect(result.calls).toContainEqual(expect.stringContaining("sql databases describe mattermost_test"));
    expect(result.calls).toContainEqual(expect.stringContaining("sql databases delete gitea_test"));
    expect(result.calls).toContainEqual(expect.stringContaining("sql databases create gitea_test"));
    expect(result.calls).toContainEqual(expect.stringContaining("sql databases describe gitea_test"));
    expect(result.stdout).toContain("Cloud SQL API confirmed both recreated databases");
    expect(result.calls).toContainEqual(expect.stringContaining("kubectl wait --for=delete pvc/gitea-shared-storage"));
    expect(result.calls).toContainEqual(expect.stringContaining("kubectl wait --for=delete pvc/mattermost-data"));
    expect(result.stdout).toContain("Durable PVCs confirmed absent");
    expect(result.stdout).toContain(
      "BOOTSTRAP_GATEWAY_IMAGE=<tested release SHA>@sha256:<octogee-gateway digest from release receipt>",
    );
    expect(result.stdout).toContain(
      "glm-controller.bootstrapDefaultGateway.imageTag=$BOOTSTRAP_GATEWAY_IMAGE",
    );
  });

  it.each([
    ["inspect", "could not inspect PVC gitea-shared-storage"],
    ["delete", "delete request failed for PVC gitea-shared-storage"],
    ["finalize", "PVC mattermost-data did not finalize"],
  ] as const)("fails closed when durable PVC %s fails", (pvcFailure, message) => {
    const result = runPrivateWestTeardown({ pvcFailure });

    expect(result.status).toBe(1);
    expect(`${result.stderr}\n${result.stdout}`).toContain(message);
    expect(result.calls.some((call) => call.startsWith("sql databases"))).toBe(false);
  });

  it.each([
    ["inspect", "could not inspect mattermost_test", "sql databases delete mattermost_test"],
    ["delete", "delete failed for mattermost_test", "sql databases create mattermost_test"],
    ["create", "create failed for mattermost_test", "sql databases describe gitea_test"],
    ["verify-command", "verification failed for mattermost_test", "sql databases describe gitea_test"],
    ["verify-value", "verification returned 'wrong_database' for mattermost_test", "sql databases describe gitea_test"],
  ] as const)(
    "fails closed when the Cloud SQL Admin API %s boundary fails",
    (databaseFailure, message, forbiddenCall) => {
      const result = runPrivateWestTeardown({ databaseFailure });

      expect(result.status).toBe(1);
      expect(`${result.stderr}\n${result.stdout}`).toContain(message);
      expect(result.calls).not.toContainEqual(expect.stringContaining(forbiddenCall));
      expect(result.calls.some((call) => call.startsWith("secrets list"))).toBe(false);
      expect(result.stderr).not.toContain("Authentication failed");
    },
  );

  it("distinguishes an absent password secret from a Secret Manager read failure", () => {
    const absent = runPrivateWestTeardown({ secretFailure: "absent" });
    expect(absent.status).toBe(1);
    expect(absent.stdout).toContain("MM_DB_PASSWORD:    absent");
    expect(absent.stderr).not.toContain("gcloud auth or network");

    const failed = runPrivateWestTeardown({ secretFailure: "error" });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("PERMISSION_DENIED");
    expect(failed.stderr).toContain("gcloud auth or network");
  });

  it("does not mislabel a reachable-proxy transport failure as a password mismatch", () => {
    const result = runPrivateWestTeardown({ publicIp: true });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("transport/config failure, not a credential mismatch");
    expect(result.stderr).toContain("Fix Cloud SQL proxy/private-network reachability and retry.");
    expect(result.stderr).not.toContain("Authentication failed");
  });
});
