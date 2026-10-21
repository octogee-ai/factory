import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

function provision(missing: string) {
  const root = mkdtempSync(path.join(tmpdir(), "custom-postgres-"));
  const scripts = path.join(root, "scripts");
  const bin = path.join(root, "bin");
  mkdirSync(path.join(scripts, "lib"), { recursive: true });
  mkdirSync(path.join(scripts, "node_modules/.bin"), { recursive: true });
  mkdirSync(path.join(root, "terraform/environments/custom"), { recursive: true });
  mkdirSync(bin);
  for (const file of ["provision-namespace.sh", "lib/agent-store-postgres-secret.sh"]) {
    cpSync(path.resolve(import.meta.dirname, "..", file), path.join(scripts, file));
  }
  writeFileSync(path.join(scripts, "lib/deployment-target.sh"), `octogee_load_deployment_target() {
TARGET_CLUSTER_PROJECT=octogee; TARGET_CLOUD_SQL_PROJECT=octogee; TARGET_CLOUD_SQL_INSTANCE=octogee-pg
TARGET_CLOUD_SQL_MATTERMOST_PASSWORD_SECRET=mm; TARGET_CLOUD_SQL_GITEA_PASSWORD_SECRET=gitea
TARGET_CLUSTER_NAME=cluster; TARGET_KUBE_CONTEXT=explicit-context; TARGET_FIREBASE_PROJECT=octogee-test
TARGET_REGION=us-central1; TARGET_ID=test-central; TARGET_ENVIRONMENT=test; TARGET_CLOUD_SQL_CONNECTION=octogee:us-central1:octogee-pg
}
`);
  const stub = (file: string, body: string) => { writeFileSync(file, `#!/bin/bash\n${body}\n`); chmodSync(file, 0o755); };
  stub(path.join(scripts, "node_modules/.bin/tsx"), "printf '{}'");
  for (const tool of ["gcloud", "kubectl", "helm", "terraform", "psql", "cloud-sql-proxy", "sleep"]) {
    stub(path.join(bin, tool), `printf '%s\\n' '${tool}'" $*" >> "$TRACE"
${tool === "gcloud" ? 'if [[ "$*" == *"secrets versions access"* && "$*" == *"$MISSING"* && -n "$MISSING" ]]; then exit 9; fi; if [[ "$*" != *"secrets versions access"* || "$MISSING" != "empty-client" || "$*" != *"client-dsn"* ]]; then printf "%s" "postgres://fixture@10.20.30.40/octogee_agents_feat_alice"; fi' : ""}
${tool === "kubectl" ? 'if [[ "$*" == "config current-context" ]]; then printf explicit-context; fi; if [[ "$*" == "get namespace"* ]]; then exit 1; fi' : ""}
${tool === "helm" ? 'if [[ "$*" == "status"* ]]; then exit 1; fi' : ""}
${tool === "terraform" ? 'exit 42' : ""}`);
  }
  const trace = path.join(root, "trace");
  try {
    const result = spawnSync("bash", [path.join(scripts, "provision-namespace.sh"), "feat-alice", `--sha=${"a".repeat(40)}`, "--yes"], {
      encoding: "utf8", timeout: 5000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TRACE: trace, MISSING: missing },
    });
    return { ...result, calls: readFileSync(trace, "utf8") };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

describe("custom PostgreSQL prerequisites before destructive recreation", () => {
  it.each(["admin-dsn", "client-dsn", "empty-client"])("preserves the namespace when %s is unavailable", missing => {
    const result = provision(missing);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("before recreating this namespace");
    expect(result.calls).toContain(`--secret=agent-store-postgres-feat-alice-${missing === "empty-client" ? "client-dsn" : missing} --project=octogee-test`);
    expect(result.calls).not.toContain("helm status");
    expect(result.calls).not.toContain("kubectl delete");
    expect(result.calls).not.toContain("terraform");
  });

  it("checks both readable versions before proceeding to recreation", () => {
    const result = provision("");
    expect(result.status).toBe(42);
    const admin = result.calls.indexOf("--secret=agent-store-postgres-feat-alice-admin-dsn");
    const client = result.calls.indexOf("--secret=agent-store-postgres-feat-alice-client-dsn");
    expect(admin).toBeGreaterThan(-1);
    expect(client).toBeGreaterThan(admin);
    expect(result.calls.indexOf("helm status")).toBeGreaterThan(client);
    expect(result.calls).toContain("terraform init");
  });
});
