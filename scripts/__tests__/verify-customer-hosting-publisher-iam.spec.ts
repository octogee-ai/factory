import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");
const verifier = path.join(repoRoot, "scripts/verify-customer-hosting-publisher-iam.sh");
const publisher = "serviceAccount:octogee-project-publisher@octogee-customer-hosting-test.iam.gserviceaccount.com";
const ksa = "serviceAccount:octogee-test.svc.id.goog[octogee-test/octogee-project-publisher]";

function policy(bindings: Array<{ role: string; members: string[] }>): string {
  return JSON.stringify({ bindings });
}

function runVerifier(overrides: {
  args?: string[];
  projectPolicy?: string;
  serviceAccountPolicy?: string;
  journalPolicy?: string;
} = {}) {
  const temp = mkdtempSync(path.join(tmpdir(), "octogee-customer-hosting-iam-"));
  const gcloud = path.join(temp, "gcloud");
  writeFileSync(gcloud, `#!/usr/bin/env bash
set -euo pipefail
case "$1 $2 $3" in
  "projects get-iam-policy octogee-customer-hosting-test") printf '%s\\n' "$FAKE_PROJECT_POLICY" ;;
  "iam service-accounts get-iam-policy") printf '%s\\n' "$FAKE_SERVICE_ACCOUNT_POLICY" ;;
  "storage buckets get-iam-policy") printf '%s\\n' "$FAKE_JOURNAL_POLICY" ;;
  *) printf 'unexpected gcloud call: %s\\n' "$*" >&2; exit 2 ;;
esac
`);
  chmodSync(gcloud, 0o755);

  return spawnSync("bash", [verifier, ...(overrides.args ?? ["--target=test-central"])], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${temp}:${process.env.PATH}`,
      FAKE_PROJECT_POLICY: overrides.projectPolicy ?? policy([
        { role: "roles/firebasehosting.admin", members: [publisher] },
        { role: "roles/viewer", members: ["serviceAccount:unrelated@example.iam.gserviceaccount.com"] },
      ]),
      FAKE_SERVICE_ACCOUNT_POLICY: overrides.serviceAccountPolicy ?? policy([
        { role: "roles/iam.workloadIdentityUser", members: [ksa] },
      ]),
      FAKE_JOURNAL_POLICY: overrides.journalPolicy ?? policy([
        { role: "roles/storage.objectCreator", members: [publisher] },
        { role: "roles/storage.objectViewer", members: [publisher] },
      ]),
    },
    encoding: "utf8",
  });
}

describe("user Hosting publisher IAM verifier", () => {
  it("accepts only the exact publisher, Workload Identity, and journal grants", () => {
    const result = runVerifier();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("verified for test-central");
  });

  it("rejects an additional project role on the publisher", () => {
    const result = runVerifier({
      projectPolicy: policy([
        { role: "roles/firebasehosting.admin", members: [publisher] },
        { role: "roles/storage.admin", members: [publisher] },
      ]),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unexpected publisher project IAM");
  });

  it("rejects API or runner authority in the user Hosting project", () => {
    const result = runVerifier({
      projectPolicy: policy([
        { role: "roles/firebasehosting.admin", members: [publisher] },
        { role: "roles/viewer", members: ["serviceAccount:octogee-api@octogee-test.iam.gserviceaccount.com"] },
      ]),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Forbidden API or runner IAM");
  });

  it("rejects Workload Identity from the PROD cluster's pool that TEST used before its own project", () => {
    const result = runVerifier({
      serviceAccountPolicy: policy([
        {
          role: "roles/iam.workloadIdentityUser",
          members: ["serviceAccount:octogee.svc.id.goog[octogee-test/octogee-project-publisher]"],
        },
      ]),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unexpected publisher Workload Identity IAM");
  });

  it("rejects missing append-only journal authority", () => {
    const result = runVerifier({
      journalPolicy: policy([
        { role: "roles/storage.objectViewer", members: [publisher] },
      ]),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unexpected publisher journal IAM");
  });

  it.each(["staging", "build-week-central"])(
    "rejects unsupported target %s without reading IAM",
    (target) => {
      const result = runVerifier({ args: [`--target=${target}`] });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain("Unsupported deployment target");
    },
  );
});
