import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");
const script = path.join(repoRoot, "scripts/ops/reconcile-pvc-snapshot-schedules.sh");

type RunOptions = {
  apply?: boolean;
  target?: string;
  policy?: "absent" | "expected" | "unexpected";
  schedule?: "expected" | "missing" | "unbounded";
  claimMismatch?: boolean;
};

function executable(file: string, source: string): void {
  writeFileSync(file, source);
  chmodSync(file, 0o755);
}

function runReconciler(options: RunOptions = {}) {
  const temp = mkdtempSync(path.join(tmpdir(), "octogee-central-pvc-snapshots-"));
  const log = path.join(temp, "calls.log");
  writeFileSync(log, "");
  const target = options.target ?? "test-central";
  const region = "us-central1";
  const namespace = "octogee-test";
  const policyName = "octogee-central-pvc-daily";

  executable(path.join(temp, "kubectl"), `#!/usr/bin/env bash
set -euo pipefail
printf 'kubectl %s\\n' "$*" >> "$FAKE_CALL_LOG"
case "$*" in
  *" get pvc gitea-shared-storage "*)
    printf '{"metadata":{"name":"gitea-shared-storage","namespace":"%s"},"spec":{"volumeName":"pv-gitea"},"status":{"phase":"Bound"}}\\n' "$FAKE_NAMESPACE"
    ;;
  *" get pvc mattermost-data "*)
    printf '{"metadata":{"name":"mattermost-data","namespace":"%s"},"spec":{"volumeName":"pv-mattermost"},"status":{"phase":"Bound"}}\\n' "$FAKE_NAMESPACE"
    ;;
  *" get pv pv-gitea "*)
    claim="$([[ "$FAKE_CLAIM_MISMATCH" == "true" ]] && printf other || printf gitea-shared-storage)"
    printf '{"metadata":{"name":"pv-gitea"},"spec":{"claimRef":{"namespace":"%s","name":"%s"},"csi":{"driver":"pd.csi.storage.gke.io","volumeHandle":"projects/octogee-test/zones/%s-a/disks/disk-gitea"}}}\\n' "$FAKE_NAMESPACE" "$claim" "$FAKE_REGION"
    ;;
  *" get pv pv-mattermost "*)
    printf '{"metadata":{"name":"pv-mattermost"},"spec":{"claimRef":{"namespace":"%s","name":"mattermost-data"},"csi":{"driver":"pd.csi.storage.gke.io","volumeHandle":"projects/octogee-test/zones/%s-b/disks/disk-mattermost"}}}\\n' "$FAKE_NAMESPACE" "$FAKE_REGION"
    ;;
  *)
    printf 'unexpected kubectl call: %s\\n' "$*" >&2
    exit 2
    ;;
esac
`);

  executable(path.join(temp, "gcloud"), `#!/usr/bin/env bash
set -euo pipefail
printf 'gcloud %s\\n' "$*" >> "$FAKE_CALL_LOG"
EXPECTED="https://www.googleapis.com/compute/v1/projects/octogee-test/regions/$FAKE_REGION/resourcePolicies/$FAKE_POLICY_NAME"
case "$1 $2 $3" in
  "compute resource-policies describe")
    if [[ "$FAKE_SCHEDULE" == "missing" ]]; then
      printf '%s\n' 'resource policy not found' >&2
      exit 1
    fi
    if [[ "$FAKE_SCHEDULE" == "unbounded" ]]; then
      printf '{"name":"%s","region":"https://www.googleapis.com/compute/v1/projects/octogee-test/regions/%s","snapshotSchedulePolicy":{"schedule":{"dailySchedule":{"daysInCycle":1,"startTime":"08:00"}},"retentionPolicy":{"maxRetentionDays":999,"onSourceDiskDelete":"KEEP_AUTO_SNAPSHOTS"},"snapshotProperties":{"storageLocations":["%s"]}}}\\n' "$FAKE_POLICY_NAME" "$FAKE_REGION" "$FAKE_REGION"
    else
      printf '{"name":"%s","region":"https://www.googleapis.com/compute/v1/projects/octogee-test/regions/%s","snapshotSchedulePolicy":{"schedule":{"dailySchedule":{"daysInCycle":1,"startTime":"08:00"}},"retentionPolicy":{"maxRetentionDays":14,"onSourceDiskDelete":"APPLY_RETENTION_POLICY"},"snapshotProperties":{"storageLocations":["%s"]}}}\\n' "$FAKE_POLICY_NAME" "$FAKE_REGION" "$FAKE_REGION"
    fi
    ;;
  "compute disks describe")
    disk="$4"
    if [[ "$FAKE_POLICY" == "unexpected" ]]; then
      printf '{"resourcePolicies":["https://www.googleapis.com/compute/v1/projects/octogee-test/regions/%s/resourcePolicies/other-policy"]}\\n' "$FAKE_REGION"
    elif [[ "$FAKE_POLICY" == "expected" ]] || grep -q "^gcloud compute disks add-resource-policies \${disk} " "$FAKE_CALL_LOG"; then
      printf '{"resourcePolicies":["%s"]}\\n' "$EXPECTED"
    else
      printf '%s\\n' '{"resourcePolicies":[]}'
    fi
    ;;
  "compute disks add-resource-policies") ;;
  "storage cp "*) ;;
  *)
    printf 'unexpected gcloud call: %s\\n' "$*" >&2
    exit 2
    ;;
esac
`);

  const args = [script, `--target=${target}`];
  if (options.apply) args.push("--apply");
  const result = spawnSync("bash", args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${temp}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      FAKE_CALL_LOG: log,
      FAKE_POLICY: options.policy ?? "absent",
      FAKE_SCHEDULE: options.schedule ?? "expected",
      FAKE_CLAIM_MISMATCH: options.claimMismatch ? "true" : "false",
      FAKE_NAMESPACE: namespace,
      FAKE_REGION: region,
      FAKE_POLICY_NAME: policyName,
    },
    encoding: "utf8",
  });

  const output = {
    ...result,
    calls: readFileSync(log, "utf8").trim().split("\n").filter(Boolean),
  };
  rmSync(temp, { recursive: true, force: true });
  return output;
}

describe("durable PVC snapshot schedule reconciliation", () => {
  it("verifies both exact PVC disks without mutating an already-converged target", () => {
    const result = runReconciler({ policy: "expected" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.calls.filter((call) => call.includes("resource-policies describe"))).toHaveLength(1);
    expect(result.calls.filter((call) => call.includes("disks describe"))).toHaveLength(2);
    expect(result.calls.some((call) => call.includes("add-resource-policies"))).toBe(false);
    expect(JSON.parse(result.stdout)).toMatchObject({
      target: "test-central",
      namespace: "octogee-test",
      mode: "verify",
      disks: [
        { pvc: "gitea-shared-storage", disk: "disk-gitea", attachedThisRun: false },
        { pvc: "mattermost-data", disk: "disk-mattermost", attachedThisRun: false },
      ],
    });
  });

  it("attaches Central's exact schedule to both fresh PVC disks", () => {
    const result = runReconciler({ apply: true, target: "test-central" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.calls.filter((call) => call.includes("add-resource-policies"))).toHaveLength(2);
    expect(result.calls.filter((call) => call.includes("--resource-policies=octogee-central-pvc-daily"))).toHaveLength(2);
  });

  it("refuses to inspect disks when the Terraform-managed schedule is absent", () => {
    const result = runReconciler({ apply: true, schedule: "missing" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Durable PVC snapshot schedule is unavailable");
    expect(result.calls.some((call) => call.startsWith("kubectl "))).toBe(false);
    expect(result.calls.some((call) => call.includes("disks "))).toBe(false);
  });

  it("refuses an unbounded or keep-on-delete snapshot schedule", () => {
    const result = runReconciler({ apply: true, schedule: "unbounded" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("identity or configuration is invalid");
    expect(result.calls.some((call) => call.startsWith("kubectl "))).toBe(false);
  });

  it("fails verification when either reviewed disk lacks the schedule", () => {
    const result = runReconciler();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("has no durable PVC snapshot schedule");
    expect(result.calls.some((call) => call.includes("add-resource-policies"))).toBe(false);
  });

  it("attaches and re-verifies the exact policy before uploading a receipt", () => {
    const result = runReconciler({ apply: true });

    expect(result.status, result.stderr).toBe(0);
    expect(result.calls.filter((call) => call.includes("add-resource-policies"))).toHaveLength(2);
    expect(result.calls.filter((call) => call.includes("disks describe"))).toHaveLength(4);
    expect(result.calls.filter((call) => call.startsWith("gcloud storage cp"))).toHaveLength(1);
    expect(JSON.parse(result.stdout).disks).toEqual([
      expect.objectContaining({ pvc: "gitea-shared-storage", attachedThisRun: true }),
      expect.objectContaining({ pvc: "mattermost-data", attachedThisRun: true }),
    ]);
  });

  it("refuses an unexpected existing disk policy without mutation", () => {
    const result = runReconciler({ apply: true, policy: "unexpected" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unexpected resource policy");
    expect(result.calls.some((call) => call.includes("add-resource-policies"))).toBe(false);
  });

  it("refuses a PV that is not bound back to the exact reviewed claim", () => {
    const result = runReconciler({ apply: true, claimMismatch: true });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("claimRef does not match");
    expect(result.calls.some((call) => call.includes("compute disks"))).toBe(false);
  });

  it("refuses unknown targets before querying Kubernetes", () => {
    const result = runReconciler({ apply: true, target: "unknown-target" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unknown deployment target: unknown-target");
    expect(result.calls).toEqual([]);
  });
});
