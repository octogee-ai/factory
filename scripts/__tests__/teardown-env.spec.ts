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
  databaseOwner?: "mattermost" | "gitea" | "cloudsqlsuperuser" | "unexpected";
  sqlOwnerJobFailure?: boolean;
  publicIp?: boolean;
  pvcFailure?: "inspect" | "delete" | "finalize";
  secretFailure?: "absent" | "error";
  storageFailure?: boolean;
  storageListFailure?: boolean;
  storageEmpty?: boolean;
  storageResidual?: boolean;
  missingServiceAccount?: boolean;
  functionListFailure?: boolean;
  functionDeleteFailure?: boolean;
  functions?: Array<{ name: string; generation: "GEN_1" | "GEN_2" }>;
  functionInventory?: string;
  interactiveInput?: string;
};

function runPrivateCentralTeardown(options: TeardownOptions = {}) {
  const temp = mkdtempSync(path.join(tmpdir(), "octogee-teardown-private-central-"));
  const log = path.join(temp, "calls.log");
  const describeCount = path.join(temp, "describe-count");
  const deletedPvcs = path.join(temp, "deleted-pvcs");
  const storageRemoved = path.join(temp, "storage-removed");
  const sqlOwnerManifest = path.join(temp, "sql-owner-manifest.yaml");
  const serviceAccount = path.join(temp, "service-account.json");
  writeFileSync(log, "");
  writeFileSync(describeCount, "0");
  writeFileSync(deletedPvcs, "");
  writeFileSync(sqlOwnerManifest, "");
  writeFileSync(serviceAccount, '{"project_id":"octogee-data-test"}');

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
  "secrets list "*) ;;
  "functions list "*)
    if [[ "$FAKE_FUNCTION_LIST_FAILURE" == "true" ]]; then
      printf 'PERMISSION_DENIED\\n' >&2
      exit 2
    fi
    printf '%b' "$FAKE_FUNCTION_INVENTORY"
    ;;
  "functions delete "*) [[ "$FAKE_FUNCTION_DELETE_FAILURE" != "true" ]] ;;
  "storage buckets describe") ;;
  "storage ls --all-versions")
    if [[ "$FAKE_STORAGE_LIST_FAILURE" == "true" ]]; then
      printf 'PERMISSION_DENIED\\n' >&2
      exit 2
    fi
    if [[ "$FAKE_STORAGE_EMPTY" == "true" ]]; then
      printf 'ERROR: (gcloud.storage.ls) One or more URLs matched no objects.\\n' >&2
      exit 1
    fi
    if [[ "$FAKE_STORAGE_RESIDUAL" == "true" || ! -f "$FAKE_STORAGE_REMOVED" ]]; then
      printf 'gs://octogee-data-test.firebasestorage.app/nested/object.txt#2\\n'
      printf 'gs://octogee-data-test.firebasestorage.app/nested/object.txt#1\\n'
    else
      printf 'ERROR: (gcloud.storage.ls) One or more URLs matched no objects.\\n' >&2
      exit 1
    fi
    ;;
  "storage rm --all-versions")
    [[ "$FAKE_STORAGE_FAILURE" != "true" ]] || exit 1
    : > "$FAKE_STORAGE_REMOVED"
    ;;
  *) printf 'unexpected gcloud call: %s\\n' "$*" >&2; exit 2 ;;
esac
`);

  executable(path.join(temp, "kubectl"), `#!/usr/bin/env bash
set -euo pipefail
printf 'kubectl %s\\n' "$*" >> "$FAKE_CALL_LOG"
case "$1 $2" in
  "config use-context") ;;
  "config current-context") printf 'gke_octogee_us-central1_octogee-gateway\\n' ;;
  "get serviceaccount") printf 'octogee-api@octogee.iam.gserviceaccount.com\\n' ;;
  "get deployment/mattermost") printf 'deployment.apps/mattermost\\n' ;;
  "get deployment/gitea") printf 'deployment.apps/gitea\\n' ;;
  "get endpoints") printf '10.0.0.4\\n' ;;
  "scale deployment"|"scale statefulset") ;;
  "apply -f") cat >> "$FAKE_SQL_OWNER_MANIFEST" ;;
  "logs job/"*)
    if [[ "$FAKE_SQL_OWNER_JOB_FAILURE" == "true" ]]; then
      printf 'owner query failed\\n' >&2
      exit 1
    fi
    case "$2" in
      *mattermost*)
        owner="$FAKE_DATABASE_OWNER_MATTERMOST"
        if [[ "$owner" == cloudsqlsuperuser ]] && grep -q '^sql databases delete mattermost_test ' "$FAKE_CALL_LOG"; then owner=mattermost; fi
        printf 'OCTOGEE_DATABASE_OWNER=%s\\n' "$owner"
        ;;
      *gitea*)
        owner="$FAKE_DATABASE_OWNER_GITEA"
        if [[ "$owner" == cloudsqlsuperuser ]] && grep -q '^sql databases delete gitea_test ' "$FAKE_CALL_LOG"; then owner=gitea; fi
        printf 'OCTOGEE_DATABASE_OWNER=%s\\n' "$owner"
        ;;
      *) printf 'unexpected SQL owner job %s\\n' "$2" >&2; exit 2 ;;
    esac
    ;;
  "delete job") ;;
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
  executable(path.join(temp, "firebase"), "#!/usr/bin/env bash\nset -euo pipefail\nprintf 'firebase %s\\n' \"$*\" >> \"$FAKE_CALL_LOG\"\n");
  executable(path.join(temp, "npx"), "#!/usr/bin/env bash\nset -euo pipefail\nprintf 'npx %s\\n' \"$*\" >> \"$FAKE_CALL_LOG\"\n");

  const args = [teardown, "--env=test", "--deployment-target=test-central", "--full"];
  if (!options.interactiveInput) args.push("--yes");
  const result = spawnSync("bash", args, {
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
      FAKE_STORAGE_FAILURE: options.storageFailure ? "true" : "false",
      FAKE_STORAGE_LIST_FAILURE: options.storageListFailure ? "true" : "false",
      FAKE_STORAGE_EMPTY: options.storageEmpty ? "true" : "false",
      FAKE_STORAGE_RESIDUAL: options.storageResidual ? "true" : "false",
      FAKE_STORAGE_REMOVED: storageRemoved,
      FAKE_SQL_OWNER_MANIFEST: sqlOwnerManifest,
      FAKE_SQL_OWNER_JOB_FAILURE: options.sqlOwnerJobFailure ? "true" : "false",
      FAKE_DATABASE_OWNER_MATTERMOST: options.databaseOwner === "unexpected" ? "legacy-owner" : options.databaseOwner ?? "mattermost",
      FAKE_DATABASE_OWNER_GITEA: options.databaseOwner === "unexpected" ? "legacy-owner" : options.databaseOwner ?? "gitea",
      FAKE_FUNCTION_LIST_FAILURE: options.functionListFailure ? "true" : "false",
      FAKE_FUNCTION_DELETE_FAILURE: options.functionDeleteFailure ? "true" : "false",
      FAKE_FUNCTION_INVENTORY: options.functionInventory
        ?? `${(options.functions ?? []).map(({ name, generation }) => `${name},${generation}`).join("\n")}${options.functions?.length ? "\n" : ""}`,
      SA_KEY_PATH: options.missingServiceAccount ? path.join(temp, "missing-service-account.json") : serviceAccount,
    },
    input: options.interactiveInput,
    encoding: "utf8",
  });

  return {
    ...result,
    calls: readFileSync(log, "utf8").trim().split("\n").filter(Boolean),
    sqlOwnerManifest: readFileSync(sqlOwnerManifest, "utf8"),
  };
}

describe("full teardown for private-only Cloud SQL", { timeout: 15_000 }, () => {
  it("drops app-owned private databases through an exact-target in-cluster owner job before API recreation", () => {
    const result = runPrivateCentralTeardown();

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(result.calls).toContainEqual(expect.stringContaining("kubectl scale deployment/mattermost"));
    expect(result.calls).toContainEqual(expect.stringContaining("kubectl get serviceaccount octogee-api"));
    expect(result.calls).toContainEqual(expect.stringContaining("kubectl apply -f -"));
    expect(result.calls).not.toContainEqual(expect.stringContaining("sql databases delete mattermost_test"));
    expect(result.calls).not.toContainEqual(expect.stringContaining("sql databases delete gitea_test"));
    expect(result.calls).not.toContainEqual(expect.stringContaining("sql databases create mattermost_test"));
    expect(result.calls).not.toContainEqual(expect.stringContaining("sql databases create gitea_test"));
    expect(result.sqlOwnerManifest).toContain("name: mattermost-cloud-sql");
    expect(result.sqlOwnerManifest).toContain("name: gitea-credentials");
    expect(result.sqlOwnerManifest).toContain("cloud-sql-proxy");
    expect(result.sqlOwnerManifest).toContain("mattermost_test");
    expect(result.sqlOwnerManifest).toContain("gitea_test");
    expect(result.sqlOwnerManifest).toContain('CREATE DATABASE :\\"database\\";');
  });

  it("fails closed before data cleanup when a private database owner is not the target app user", () => {
    const result = runPrivateCentralTeardown({ databaseOwner: "unexpected" });

    expect(result.status).toBe(1);
    expect(`${result.stderr}\n${result.stdout}`).toContain("private Cloud SQL owner reset job returned unexpected owner 'legacy-owner' for mattermost_test");
    expect(result.calls.some((call) => call.startsWith("sql databases create"))).toBe(false);
    expect(result.calls.some((call) => call.startsWith("firebase firestore:delete"))).toBe(false);
  });

  it("fails closed before data cleanup when the private owner job cannot complete", () => {
    const result = runPrivateCentralTeardown({ sqlOwnerJobFailure: true });

    expect(result.status).toBe(1);
    expect(`${result.stderr}\n${result.stdout}`).toContain("could not read private Cloud SQL owner reset job output for mattermost_test");
    expect(result.calls.some((call) => call.startsWith("sql databases create"))).toBe(false);
    expect(result.calls.some((call) => call.startsWith("firebase firestore:delete"))).toBe(false);
  });

  it("uses the Cloud SQL Admin API only when the database is API-owned", () => {
    const result = runPrivateCentralTeardown({ databaseOwner: "cloudsqlsuperuser" });

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(result.calls).toContainEqual(expect.stringContaining("sql databases delete mattermost_test"));
    expect(result.calls).toContainEqual(expect.stringContaining("sql databases delete gitea_test"));
  });
  it("keeps TEST full-reset Secret Manager and Storage mutations inside the resolved data project", () => {
    const source = readFileSync(teardown, "utf8");

    expect(source).toContain('gcloud secrets list --project="$FIREBASE_PROJECT"');
    expect(source).toContain('gcloud secrets delete "$sm" --project="$FIREBASE_PROJECT"');
    expect(source).not.toContain('gcloud secrets list --project=octogee');
    expect(source).toContain('FIREBASE_STORAGE_BUCKET="gs://${FIREBASE_PROJECT}.firebasestorage.app"');
    expect(source).toContain(
      'gcloud storage ls --all-versions "$FIREBASE_STORAGE_BUCKET/**" --project="$TARGET_STORAGE_PROJECT"',
    );
    expect(source).toContain(
      'gcloud storage rm --all-versions "$FIREBASE_STORAGE_BUCKET/**" --project="$TARGET_STORAGE_PROJECT" --quiet',
    );
    expect(source).not.toContain("gcloud storage rm --recursive");
    expect(source).not.toContain("gcloud storage objects list");
  });

  it("keeps the Auth preflight before data deletion", () => {
    const source = readFileSync(teardown, "utf8");

    expect(source).toContain("delete-firebase-auth-users.ts");
    expect(source).toContain("run_auth_cleanup --verify");
  });

  it("uses ADC for the Auth preflight when the optional service-account key is absent", () => {
    const result = runPrivateCentralTeardown({ missingServiceAccount: true });

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(result.calls.some((call) => call.startsWith("npx ") && call.includes("--verify") && !call.includes("--service-account"))).toBe(true);
    expect(result.calls.some((call) => call.startsWith("sql databases"))).toBe(true);
  });

  it("fails before Firestore or Auth cleanup when the target Storage bucket cannot be wiped", () => {
    const result = runPrivateCentralTeardown({ storageFailure: true });

    expect(result.status).toBe(1);
    expect(`${result.stderr}\n${result.stdout}`).toContain("Firebase Storage wipe failed");
    expect(result.calls).toContainEqual(
      expect.stringContaining("storage rm --all-versions gs://octogee-test.firebasestorage.app/** --project=octogee-test --quiet"),
    );
    expect(result.calls.some((call) => call.startsWith("firebase firestore:delete"))).toBe(false);
    expect(result.calls.some((call) => call.startsWith("npx ") && !call.includes("--verify"))).toBe(false);
  });

  it("allows an already-empty target Storage bucket to complete the reset", () => {
    const result = runPrivateCentralTeardown({ storageEmpty: true });

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(result.calls.some((call) => call.startsWith("storage rm"))).toBe(false);
    expect(result.stdout).toContain("Firebase Storage already empty");
  });

  it("fails closed when target Storage generations cannot be listed", () => {
    const result = runPrivateCentralTeardown({ storageListFailure: true });

    expect(result.status).toBe(1);
    expect(`${result.stderr}\n${result.stdout}`).toContain("Firebase Storage listing failed");
    expect(`${result.stderr}\n${result.stdout}`).toContain("PERMISSION_DENIED");
    expect(result.calls.some((call) => call.startsWith("storage rm"))).toBe(false);
    expect(result.calls.some((call) => call.startsWith("firebase firestore:delete"))).toBe(false);
  });

  it("fails before Firestore or Auth cleanup when generations remain after Storage deletion", () => {
    const result = runPrivateCentralTeardown({ storageResidual: true });

    expect(result.status).toBe(1);
    expect(`${result.stderr}\n${result.stdout}`).toContain("Firebase Storage still contains object generations");
    expect(result.calls.filter((call) => call.startsWith("storage ls --all-versions"))).toHaveLength(2);
    expect(result.calls.some((call) => call.startsWith("firebase firestore:delete"))).toBe(false);
    expect(result.calls.some((call) => call.startsWith("npx ") && !call.includes("--verify"))).toBe(false);
  });

  it("fails closed when Cloud Function discovery is unavailable", () => {
    const result = runPrivateCentralTeardown({ functionListFailure: true });

    expect(result.status).toBe(1);
    expect(`${result.stderr}\n${result.stdout}`).toContain("could not list Cloud Functions");
    expect(result.calls.some((call) => call.startsWith("npx ") && !call.includes("--verify"))).toBe(false);
  });

  it("fails closed when Cloud Function inventory has an unknown generation", () => {
    const result = runPrivateCentralTeardown({ functionInventory: "mystery,GEN_3\n" });

    expect(result.status).toBe(1);
    expect(`${result.stderr}\n${result.stdout}`).toContain(
      "unexpected Cloud Function inventory row 'mystery,GEN_3'",
    );
    expect(result.calls.some((call) => call.startsWith("functions delete"))).toBe(false);
    expect(result.calls.some((call) => call.startsWith("storage "))).toBe(false);
  });

  it("waits for every Cloud Function deletion and stops on the first failure", () => {
    const result = runPrivateCentralTeardown({
      functions: [
        { name: "function-a", generation: "GEN_1" },
        { name: "function-b", generation: "GEN_2" },
      ],
      functionDeleteFailure: true,
    });

    expect(result.status).toBe(1);
    expect(`${result.stderr}\n${result.stdout}`).toContain("could not delete GEN_1 Cloud Function function-a");
    expect(result.calls).toContainEqual(expect.stringContaining("functions delete function-a"));
    expect(result.calls).not.toContainEqual(expect.stringContaining("functions delete function-b"));
    expect(result.calls.some((call) => call.startsWith("npx ") && !call.includes("--verify"))).toBe(false);
  });

  it("quiesces Gen 1 and Gen 2 functions before wiping Firebase data and never deletes Cloud Run services", () => {
    const result = runPrivateCentralTeardown({
      functions: [
        { name: "legacyTrigger", generation: "GEN_1" },
        { name: "onSignup", generation: "GEN_2" },
        { name: "octogee-chat-proxy", generation: "GEN_2" },
      ],
    });
    const functionList = result.calls.findIndex((call) => call.startsWith("functions list --regions=us-central1"));
    const gen1Delete = result.calls.findIndex((call) => call.startsWith("functions delete legacyTrigger"));
    const gen2Delete = result.calls.findIndex((call) => call.startsWith("functions delete onSignup"));
    const storageWipe = result.calls.findIndex((call) => call.startsWith("storage rm"));
    const firestoreWipe = result.calls.findIndex((call) => call.startsWith("firebase firestore:delete"));

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(functionList).toBeGreaterThanOrEqual(0);
    expect(gen1Delete).toBeGreaterThan(functionList);
    expect(gen2Delete).toBeGreaterThan(gen1Delete);
    expect(storageWipe).toBeGreaterThan(gen2Delete);
    expect(firestoreWipe).toBeGreaterThan(gen2Delete);
    expect(result.calls.some((call) => call.startsWith("functions delete octogee-chat-proxy"))).toBe(false);
    expect(result.calls.some((call) => call.startsWith("run services delete"))).toBe(false);
  });

  it("aborts an interactive full reset when a required wipe is declined", () => {
    const result = runPrivateCentralTeardown({ interactiveInput: "y\ny\nn\ny\ny\n" });

    expect(result.status).toBe(1);
    expect(`${result.stderr}\n${result.stdout}`).toContain("Full teardown cancelled; Firebase Storage objects remain");
    expect(result.stdout).not.toContain("Teardown complete");
    expect(result.calls.some((call) => call.startsWith("firebase firestore:delete"))).toBe(false);
  });

  it("describes full teardown as deleting its durable PVCs", () => {
    const result = spawnSync("bash", [teardown, "--help"], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("deletes durable PVCs");
    expect(result.stdout).not.toContain("Still preserves PVCs");
  });

  it("prints the explicit orchestrator seed before Helm so a fresh reset cannot reach release unconfigured", () => {
    const source = readFileSync(teardown, "utf8");
    const seed = source.indexOf("# 1b. Seed Firestore bootstrap config");
    const helm = source.indexOf("# 2. Helm install");
    expect(seed).toBeGreaterThan(-1);
    expect(seed).toBeLessThan(helm);
    expect(source).toContain(
      "npx tsx ops/seed-orchestrator-config.ts --env=$ENV$TARGET_ARG",
    );
    expect(source).not.toContain("glm-controller self-seeds config/orchestrator");
  });

  it("resets test-central through target-owned in-cluster credentials without a local proxy", () => {
    const result = runPrivateCentralTeardown();

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(result.calls).not.toContainEqual(expect.stringContaining("sql databases create mattermost_test"));
    expect(result.calls).toContainEqual(expect.stringContaining("sql databases describe mattermost_test"));
    expect(result.calls).not.toContainEqual(expect.stringContaining("sql databases create gitea_test"));
    expect(result.calls).toContainEqual(expect.stringContaining("sql databases describe gitea_test"));
    expect(result.stdout).toContain("Private Cloud SQL owner reset completed before Helm uninstall");
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
    ["inspect", "could not inspect PVC gitea-shared-storage", false],
    ["delete", "delete request failed for PVC gitea-shared-storage", false],
    ["finalize", "PVC mattermost-data did not finalize", true],
  ] as const)("fails closed when durable PVC %s fails", (pvcFailure, message, databaseResetStarted) => {
    const result = runPrivateCentralTeardown({ pvcFailure });

    expect(result.status).toBe(1);
    expect(`${result.stderr}\n${result.stdout}`).toContain(message);
    expect(result.calls.some((call) => call.startsWith("sql databases"))).toBe(databaseResetStarted);
  });

  it.each([
    ["inspect", "could not inspect mattermost_test", "sql databases delete mattermost_test"],
    ["delete", "delete failed for API-owned mattermost_test", "sql databases describe gitea_test"],
    ["verify-command", "verification failed for mattermost_test", "sql databases describe gitea_test"],
    ["verify-value", "verification returned 'wrong_database' for mattermost_test", "sql databases describe gitea_test"],
  ] as const)(
    "fails closed when the Cloud SQL Admin API %s boundary fails",
    (databaseFailure, message, forbiddenCall) => {
      const result = runPrivateCentralTeardown({
        databaseFailure,
        databaseOwner: databaseFailure === "delete" ? "cloudsqlsuperuser" : undefined,
      });

      expect(result.status).toBe(1);
      expect(`${result.stderr}\n${result.stdout}`).toContain(message);
      expect(result.calls).not.toContainEqual(expect.stringContaining(forbiddenCall));
      expect(result.calls.some((call) => call.startsWith("secrets list"))).toBe(false);
      expect(result.stderr).not.toContain("Authentication failed");
    },
  );

  it("distinguishes an absent password secret from a Secret Manager read failure", () => {
    const absent = runPrivateCentralTeardown({ secretFailure: "absent", publicIp: true });
    expect(absent.status).toBe(1);
    expect(absent.stdout).toContain("MM_DB_PASSWORD:    absent");
    expect(absent.stderr).not.toContain("gcloud auth or network");

    const failed = runPrivateCentralTeardown({ secretFailure: "error", publicIp: true });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("PERMISSION_DENIED");
    expect(failed.stderr).toContain("gcloud auth or network");
  });

  it("does not mislabel a reachable-proxy transport failure as a password mismatch", () => {
    const result = runPrivateCentralTeardown({ publicIp: true });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("transport/config failure, not a credential mismatch");
    expect(result.stderr).toContain("Fix Cloud SQL proxy/private-network reachability and retry.");
    expect(result.stderr).not.toContain("Authentication failed");
  });
});
