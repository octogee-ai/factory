import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const temporaryDirectories: string[] = [];

function executable(path: string, contents: string): void {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function createHarness(): {
  root: string;
  script: string;
  iapScript: string;
  log: string;
} {
  const root = mkdtempSync(join(tmpdir(), "octogee-monitoring-"));
  temporaryDirectories.push(root);
  const scripts = join(root, "scripts");
  const bin = join(root, "bin");
  const log = join(root, "calls.log");
  mkdirSync(join(scripts, "lib"), { recursive: true });
  mkdirSync(join(root, "helm", "monitoring"), { recursive: true });
  mkdirSync(bin);
  copyFileSync(
    join(repoRoot, "scripts/setup-monitoring.sh"),
    join(scripts, "setup-monitoring.sh"),
  );
  copyFileSync(
    join(repoRoot, "scripts/setup-monitoring-iap.sh"),
    join(scripts, "setup-monitoring-iap.sh"),
  );
  copyFileSync(
    join(repoRoot, "scripts/lib/monitoring-platform-preflight.sh"),
    join(scripts, "lib/monitoring-platform-preflight.sh"),
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
  TARGET_PLATFORM_COMPUTE_CLASS=octogee-platform-test-spot
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
    join(scripts, "verify-monitoring.sh"),
    `#!/usr/bin/env bash
printf 'verify:%s\n' "$*" >>"$OCTOGEE_MONITORING_TEST_LOG"
`,
  );
  executable(
    join(bin, "gcloud"),
    `#!/usr/bin/env bash
if [[ "$*" == *"compute addresses describe"* ]]; then
  printf 'static-ip:%s\n' "$*" >>"$OCTOGEE_MONITORING_TEST_LOG"
fi
exit 0
`,
  );
  executable(
    join(bin, "kubectl"),
    `#!/usr/bin/env bash
if [[ "$*" == "config current-context" ]]; then
  printf '%s\n' gke_us-west1_octogee
elif [[ "$*" == *"get computeclass octogee-platform-test-spot"* ]]; then
  printf 'computeclass:%s\n' "$OCTOGEE_MONITORING_COMPUTE_CLASS" >>"$OCTOGEE_MONITORING_TEST_LOG"
  [[ "$OCTOGEE_MONITORING_COMPUTE_CLASS" != missing ]] || exit 1
  [[ "$OCTOGEE_MONITORING_COMPUTE_CLASS" != unhealthy ]] && printf '%s' True || printf '%s' False
fi
`,
  );
  executable(
    join(bin, "helm"),
    `#!/usr/bin/env bash
printf 'helm:%s\n' "$*" >>"$OCTOGEE_MONITORING_TEST_LOG"
`,
  );
  return {
    root,
    script: join(scripts, "setup-monitoring.sh"),
    iapScript: join(scripts, "setup-monitoring-iap.sh"),
    log,
  };
}

function runHarness(
  computeClass: "healthy" | "missing" | "unhealthy",
  args: string[] = [],
  entrypoint: "setup" | "iap" = "setup",
): { status: number | null; calls: string[]; stderr: string } {
  const harness = createHarness();
  const result = spawnSync(
    "bash",
    [
      entrypoint === "iap" ? harness.iapScript : harness.script,
      "--target=test-west",
      ...args,
    ],
    {
      env: {
        ...process.env,
        OCTOGEE_MONITORING_COMPUTE_CLASS: computeClass,
        OCTOGEE_MONITORING_TEST_LOG: harness.log,
        PATH: `${join(harness.root, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      },
      encoding: "utf8",
    },
  );
  let calls: string[] = [];
  try {
    calls = readFileSync(harness.log, "utf8").trim().split("\n");
  } catch {
    calls = [];
  }
  return { status: result.status, calls, stderr: result.stderr };
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("monitoring setup", () => {
  it.each(["missing", "unhealthy"] as const)(
    "fails before secrets or Helm when the target platform ComputeClass is %s",
    (computeClass) => {
      const result = runHarness(computeClass);

      expect(result.status).toBe(1);
      expect(result.calls).toEqual([`computeclass:${computeClass}`]);
      expect(result.stderr).toContain(
        "Platform ComputeClass is unavailable or unhealthy",
      );
    },
  );

  it("preflights the healthy target platform ComputeClass before mutation", () => {
    const result = runHarness("healthy");

    expect(result.status).toBe(0);
    expect(result.calls[0]).toBe("computeclass:healthy");
    expect(result.calls[1]).toBe("secrets:--target=test-west");
    expect(result.calls[2]).toContain(
      "helm:upgrade --install grafana",
    );
    expect(result.calls.at(-1)).toBe("verify:--target=test-west");
  });

  it("keeps uninstall available when the platform ComputeClass is already absent", () => {
    const result = runHarness("missing", ["--uninstall"]);

    expect(result.status).toBe(0);
    expect(result.calls).toEqual([
      "helm:uninstall grafana --namespace monitoring --kube-context gke_us-west1_octogee --ignore-not-found",
    ]);
  });

  it.each(["missing", "unhealthy"] as const)(
    "fails the IAP path before secrets, static IP, or Helm when the target platform ComputeClass is %s",
    (computeClass) => {
      const result = runHarness(computeClass, [], "iap");

      expect(result.status).toBe(1);
      expect(result.calls).toEqual([`computeclass:${computeClass}`]);
      expect(result.stderr).toContain(
        "Platform ComputeClass is unavailable or unhealthy",
      );
    },
  );

  it("preflights the healthy IAP path before secrets, static IP, and Helm", () => {
    const result = runHarness("healthy", [], "iap");

    expect(result.status).toBe(0);
    expect(result.calls[0]).toBe("computeclass:healthy");
    expect(result.calls[1]).toBe("secrets:--target=test-west --iap");
    expect(result.calls[2]).toContain(
      "static-ip:compute addresses describe grafana-ip",
    );
    expect(
      result.calls.findIndex((call) => call.startsWith("helm:")),
    ).toBeGreaterThan(2);
  });
});
