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

function runPrivateWestTeardown(options: { failDatabaseCreate?: boolean; publicIp?: boolean } = {}) {
  const temp = mkdtempSync(path.join(tmpdir(), "octogee-teardown-private-west-"));
  const log = path.join(temp, "calls.log");
  writeFileSync(log, "");

  executable(path.join(temp, "gcloud"), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_CALL_LOG"
case "$1 $2 $3" in
  "container clusters get-credentials") ;;
  "secrets versions access") printf 'retained-password' ;;
  "sql instances describe")
    if [[ "$FAKE_PUBLIC_IP" == "true" ]]; then
      printf 'PRIMARY\\n'
    else
      printf '%s\\n' '{"ipAddresses":[{"type":"PRIVATE","ipAddress":"10.0.0.4"}]}'
    fi
    ;;
  "sql databases delete") ;;
  "sql databases create") [[ "$FAKE_FAIL_DATABASE_CREATE" != "true" ]] ;;
  "sql databases describe") printf '%s\\n' "$4" ;;
  "secrets list "*|"run services list "*) ;;
  *) printf 'unexpected gcloud call: %s\\n' "$*" >&2; exit 2 ;;
esac
`);

  executable(path.join(temp, "kubectl"), `#!/usr/bin/env bash
set -euo pipefail
case "$1 $2" in
  "config use-context") ;;
  "config current-context") printf 'gke_octogee_us-west1_octogee-gateway\\n' ;;
  "get pvc") exit 1 ;;
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
      FAKE_FAIL_DATABASE_CREATE: options.failDatabaseCreate ? "true" : "false",
      FAKE_PUBLIC_IP: options.publicIp ? "true" : "false",
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
  });

  it("fails closed when the Cloud SQL Admin API cannot recreate a private database", () => {
    const result = runPrivateWestTeardown({ failDatabaseCreate: true });

    expect(result.status).toBe(1);
    expect(`${result.stderr}\n${result.stdout}`).toContain("Cloud SQL Admin API create failed for mattermost_test");
    expect(result.stderr).not.toContain("Authentication failed");
  });

  it("does not mislabel a reachable-proxy transport failure as a password mismatch", () => {
    const result = runPrivateWestTeardown({ publicIp: true });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("transport/config failure, not a credential mismatch");
    expect(result.stderr).toContain("Fix Cloud SQL proxy/private-network reachability and retry.");
    expect(result.stderr).not.toContain("Authentication failed");
  });
});
