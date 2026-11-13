import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const repoRoot = path.resolve(import.meta.dirname, "../../..");
export const testCentral = JSON.parse(readFileSync(path.join(repoRoot, "core/src/deployment-targets.json"), "utf8")).targets["test-central"];
const testKubeContext = `gke_${testCentral.clusterProjectId}_${testCentral.region}_${testCentral.clusterName}`;

export interface FakeRun {
  readonly root?: string;
  readonly env?: Record<string, string>;
  readonly curlBody?: string;
}

export function runAgainstFakes(script: string, args: readonly string[], gcloudBody: string, kubectlBody: string, run: FakeRun = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "platform-state-wiring-"));
  const trace = path.join(dir, "trace");
  writeFileSync(path.join(dir, "gcloud"), `#!/bin/bash\nprintf '%s\\n' "$*" >> "$TRACE"\n${gcloudBody}\n`);
  writeFileSync(path.join(dir, "kubectl"), `#!/bin/bash\nprintf '%s\\n' "$*" >> "$TRACE"\n${kubectlBody}\n`);
  for (const name of ["gcloud", "kubectl"]) chmodSync(path.join(dir, name), 0o755);
  if (run.curlBody !== undefined) {
    writeFileSync(path.join(dir, "curl"), `#!/bin/bash\n${run.curlBody}\n`);
    chmodSync(path.join(dir, "curl"), 0o755);
  }
  const root = run.root ?? repoRoot;
  const result = spawnSync("bash", [path.join(root, script), ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...run.env, PATH: `${dir}:${process.env.PATH}`, TRACE: trace, KUBE_CONTEXT: testKubeContext },
  });
  const calls = existsSync(trace) ? readFileSync(trace, "utf8") : "";
  rmSync(dir, { recursive: true, force: true });
  return { result, calls, output: result.stdout + result.stderr };
}

export function repositoryWithoutEnvFiles(): string {
  const root = mkdtempSync(path.join(tmpdir(), "setup-secrets-repo-"));
  for (const entry of readdirSync(repoRoot)) {
    if (entry === ".git" || entry.startsWith(".env")) continue;
    symlinkSync(path.join(repoRoot, entry), path.join(root, entry));
  }
  return root;
}
