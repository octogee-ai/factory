import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const temporaryDirectories: string[] = [];

function executable(path: string, contents: string): void {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function createHarness(): { root: string; script: string; log: string } {
  const root = mkdtempSync(join(tmpdir(), "octogee-monitoring-iap-"));
  temporaryDirectories.push(root);
  const scripts = join(root, "scripts");
  const bin = join(root, "bin");
  const log = join(root, "calls.log");
  mkdirSync(join(scripts, "lib"), { recursive: true });
  mkdirSync(bin);
  copyFileSync(
    join(repoRoot, "scripts/setup-monitoring-iap.sh"),
    join(scripts, "setup-monitoring-iap.sh"),
  );
  executable(
    join(scripts, "lib/deployment-target.sh"),
    `octogee_load_deployment_target() {
  TARGET_LIFECYCLE=active
  TARGET_ID=test-west
  TARGET_CLUSTER_NAME=octogee-gateway
  TARGET_REGION=us-west1
  TARGET_CLUSTER_PROJECT=octogee
  TARGET_KUBE_CONTEXT=gke_us-west1_octogee
}
`,
  );
  executable(
    join(scripts, "setup-monitoring-secrets.sh"),
    `#!/usr/bin/env bash
printf 'secrets:%s\n' "$*" >>"$OCTOGEE_MONITORING_TEST_LOG"
`,
  );
  executable(
    join(scripts, "setup-monitoring.sh"),
    `#!/usr/bin/env bash
printf 'setup:%s\n' "$*" >>"$OCTOGEE_MONITORING_TEST_LOG"
`,
  );
  executable(
    join(bin, "gcloud"),
    `#!/usr/bin/env bash
exit 0
`,
  );
  executable(
    join(bin, "kubectl"),
    `#!/usr/bin/env bash
if [[ "$*" == "config current-context" ]]; then
  printf '%s\n' gke_us-west1_octogee
elif [[ "$*" == get\\ computeclass\\ * ]]; then
  printf '%s\n' True
fi
`,
  );
  executable(join(bin, "helm"), "#!/usr/bin/env bash\nexit 0\n");
  return { root, script: join(scripts, "setup-monitoring-iap.sh"), log };
}

function runHarness(
  harness: { root: string; script: string; log: string },
  args: string[],
): string[] {
  execFileSync("bash", [harness.script, "--target=test-west", ...args], {
    env: {
      ...process.env,
      OCTOGEE_MONITORING_TEST_LOG: harness.log,
      PATH: `${join(harness.root, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    },
    stdio: "pipe",
  });
  return readFileSync(harness.log, "utf8").trim().split("\n");
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("monitoring IAP setup", () => {
  it(
    "propagates clean-environment admin secret bootstrap through both setup phases",
    () => {
      expect(runHarness(createHarness(), ["--bootstrap-secret"])).toEqual([
        "secrets:--target=test-west --iap --bootstrap-secret",
        "setup:--target=test-west --iap --bootstrap-secret",
      ]);
    },
    15_000,
  );

  it(
    "keeps admin and IAP secret adoption modes distinct",
    () => {
      expect(
        runHarness(createHarness(), [
          "--adopt-existing-secret",
          "--adopt-existing-iap-secret",
        ]),
      ).toEqual([
        "secrets:--target=test-west --iap --adopt-existing-secret --adopt-existing-iap-secret",
        "setup:--target=test-west --iap --adopt-existing-secret",
      ]);
    },
    15_000,
  );
});
