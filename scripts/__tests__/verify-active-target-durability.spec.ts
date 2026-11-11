import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");
const script = path.join(
  repoRoot,
  "scripts/ops/verify-active-target-durability.sh",
);

type RunOptions = {
  attachment?: "expected" | "missing";
  activeMappings?: "expected" | "missing-prod" | "candidate-test";
  alertPolicy?:
    | "expected"
    | "west-only"
    | "missing-channels"
    | "wrong-evaluation"
    | "wrong-severity";
};

function executable(file: string, source: string): void {
  writeFileSync(file, source);
  chmodSync(file, 0o755);
}

function runVerifier(options: RunOptions = {}) {
  const temp = mkdtempSync(path.join(tmpdir(), "octogee-active-durability-"));
  const log = path.join(temp, "calls.log");
  const targets = path.join(temp, "targets.json");
  writeFileSync(log, "");
  const activeTargets =
    options.activeMappings === "missing-prod"
      ? { test: "test-central" }
      : { prod: "prod-central", test: "test-central" };
  writeFileSync(
    targets,
    JSON.stringify({
      activeTargets,
      targets: {
        "prod-central": {
          lifecycle: "active",
          clusterProjectId: "octogee",
          region: "us-central1",
          clusterName: "octogee-gateway",
          namespace: "octogee",
        },
        "test-central": {
          lifecycle:
            options.activeMappings === "candidate-test"
              ? "candidate"
              : "active",
          clusterProjectId: "octogee",
          region: "us-central1",
          clusterName: "octogee-gateway",
          namespace: "shared-test",
        },
      },
    }),
  );

  executable(
    path.join(temp, "kubectl"),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'kubectl %s\\n' "$*" >> "$FAKE_CALL_LOG"
namespace=octogee
target=prod
if [[ "$*" == *"--namespace=shared-test"* || "$*" == *"pv-test-"* ]]; then namespace=shared-test; target=test; fi
case "$*" in
  *" get pvc gitea-shared-storage "*) printf '{"metadata":{"name":"gitea-shared-storage","namespace":"%s"},"spec":{"volumeName":"pv-%s-gitea"},"status":{"phase":"Bound"}}\\n' "$namespace" "$target" ;;
  *" get pvc mattermost-data "*) printf '{"metadata":{"name":"mattermost-data","namespace":"%s"},"spec":{"volumeName":"pv-%s-mattermost"},"status":{"phase":"Bound"}}\\n' "$namespace" "$target" ;;
  *" get pv pv-"*"-gitea "*) printf '{"metadata":{"name":"pv-%s-gitea"},"spec":{"claimRef":{"namespace":"%s","name":"gitea-shared-storage"},"csi":{"driver":"pd.csi.storage.gke.io","volumeHandle":"projects/octogee/zones/us-central1-a/disks/disk-%s-gitea"}}}\\n' "$target" "$namespace" "$target" ;;
  *" get pv pv-"*"-mattermost "*) printf '{"metadata":{"name":"pv-%s-mattermost"},"spec":{"claimRef":{"namespace":"%s","name":"mattermost-data"},"csi":{"driver":"pd.csi.storage.gke.io","volumeHandle":"projects/octogee/zones/us-central1-b/disks/disk-%s-mattermost"}}}\\n' "$target" "$namespace" "$target" ;;
  *) printf 'unexpected kubectl call: %s\\n' "$*" >&2; exit 2 ;;
esac
`,
  );

  executable(
    path.join(temp, "gcloud"),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'gcloud %s\\n' "$*" >> "$FAKE_CALL_LOG"
case "$1 $2 $3" in
  "compute resource-policies describe")
    printf '%s\\n' '{"name":"octogee-central-pvc-daily","region":"https://www.googleapis.com/compute/v1/projects/octogee/regions/us-central1","snapshotSchedulePolicy":{"schedule":{"dailySchedule":{"daysInCycle":1,"startTime":"08:00"}},"retentionPolicy":{"maxRetentionDays":14,"onSourceDiskDelete":"APPLY_RETENTION_POLICY"},"snapshotProperties":{"storageLocations":["us-central1"]}}}'
    ;;
  "compute disks describe")
    if [[ "$FAKE_ATTACHMENT" == "missing" ]]; then printf '%s\\n' '{"resourcePolicies":[]}'
    else printf '%s\\n' '{"resourcePolicies":["https://www.googleapis.com/compute/v1/projects/octogee/regions/us-central1/resourcePolicies/octogee-central-pvc-daily"]}'
    fi
    ;;
  "monitoring policies list")
    query='max by (alertname, severity, location, namespace, gateway_id) (ALERTS{project_id="octogee", location=~"us-central1", cluster=~"octogee-gateway", alertstate="firing", severity="critical"})'
    warning="\${query/critical/warning}"
    channels='["projects/octogee/notificationChannels/email"]'
    critical_severity=CRITICAL
    warning_severity=WARNING
    evaluation=30s
    if [[ "$FAKE_ALERT_POLICY" == "west-only" ]]; then query='ALERTS{location="us-west1", severity="critical"}'; warning='ALERTS{location="us-west1", severity="warning"}'; fi
    if [[ "$FAKE_ALERT_POLICY" == "missing-channels" ]]; then channels='[]'; fi
    if [[ "$FAKE_ALERT_POLICY" == "wrong-evaluation" ]]; then evaluation=60s; fi
    if [[ "$FAKE_ALERT_POLICY" == "wrong-severity" ]]; then critical_severity=WARNING; fi
    jq -cn --arg critical "$query" --arg warning "$warning" --argjson channels "$channels" --arg criticalSeverity "$critical_severity" --arg warningSeverity "$warning_severity" --arg evaluation "$evaluation" '[{displayName:"Octogee workload critical",enabled:true,severity:$criticalSeverity,notificationChannels:$channels,conditions:[{conditionPrometheusQueryLanguage:{query:$critical,duration:"0s",evaluationInterval:$evaluation}}]},{displayName:"Octogee workload warning",enabled:true,severity:$warningSeverity,notificationChannels:$channels,conditions:[{conditionPrometheusQueryLanguage:{query:$warning,duration:"0s",evaluationInterval:$evaluation}}]}]'
    ;;
  *) printf 'unexpected gcloud call: %s\\n' "$*" >&2; exit 2 ;;
esac
`,
  );

  const result = spawnSync("bash", [script, `--targets-file=${targets}`], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${temp}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      FAKE_CALL_LOG: log,
      FAKE_ATTACHMENT: options.attachment ?? "expected",
      FAKE_ALERT_POLICY: options.alertPolicy ?? "expected",
    },
    encoding: "utf8",
  });
  const calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
  rmSync(temp, { recursive: true, force: true });
  return { ...result, calls };
}

describe("active target durability verification", () => {
  it("accepts active targets only when both durable disks and workload alert regions match", () => {
    const result = runVerifier();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Active target durability verified");
    expect(
      result.calls.filter((call) => call.includes("compute disks describe")),
    ).toHaveLength(4);
  });

  it("fails closed when a durable PVC disk lacks its exact snapshot schedule", () => {
    const result = runVerifier({ attachment: "missing" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("lacks required snapshot schedule");
    expect(
      result.calls.some((call) => call.includes("monitoring policies list")),
    ).toBe(false);
  });

  it.each([
    [
      "PROD mapping is missing",
      "missing-prod",
      "activeTargets.prod is required",
    ],
    [
      "TEST mapping is not active",
      "candidate-test",
      "activeTargets.test must map to a lifecycle active target",
    ],
  ] as const)("fails closed when %s", (_case, activeMappings, message) => {
    const result = runVerifier({ activeMappings });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
    expect(result.calls).toEqual([]);
  });

  it.each([
    ["workload paging omits an active target region", "west-only"],
    ["notification channels are empty", "missing-channels"],
    ["the evaluation interval drifts", "wrong-evaluation"],
    ["the policy severity drifts", "wrong-severity"],
  ] as const)("fails closed when %s", (_case, alertPolicy) => {
    const result = runVerifier({ alertPolicy });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "workload alert scope does not cover active targets",
    );
  });
});
