import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const script = readFileSync(resolve(__dirname, "../ensure-namespace-security.sh"), "utf8");

describe("ensure-namespace-security", () => {
  it("applies the versioned Restricted PSA labels only to deployment targets with a WEST boundary", () => {
    expect(script).toContain("TARGET_NETWORK_POLICY_ENFORCE_DEFAULT_DENY");
    expect(script).toContain('pod-security.kubernetes.io/enforce=restricted');
    expect(script).toContain('pod-security.kubernetes.io/audit=restricted');
    expect(script).toContain('pod-security.kubernetes.io/warn=restricted');
    expect(script).toContain('pod-security.kubernetes.io/enforce-version=latest');
    expect(script).toContain('pod-security.kubernetes.io/audit-version=latest');
    expect(script).toContain('pod-security.kubernetes.io/warn-version=latest');
  });

  it("requires an explicit target and mode, creates the namespace idempotently, and fails loudly for unknown modes", () => {
    expect(script).toContain("--deployment-target=TARGET");
    expect(script).toContain("--mode=warn-audit|enforce");
    expect(script).toContain('create namespace "$TARGET_NAMESPACE"');
    expect(script).toContain('Unknown mode: $MODE');
  });

  it("pins every namespace mutation to the resolved target context", () => {
    const temp = mkdtempSync(join(tmpdir(), "octogee-namespace-security-"));
    const bin = join(temp, "bin");
    const log = join(temp, "kubectl.log");
    const node = join(bin, "node");
    const kubectl = join(bin, "kubectl");
    mkdirSync(bin);
    writeFileSync(node, `#!/usr/bin/env bash
printf '%s\n' \
  'target_id=test-west' \
  'namespace=octogee-test-west' \
  'kube_context=gke_octogee_us-west1_octogee-gateway' \
  'network_policy_enforce_default_deny=true'
`);
    writeFileSync(kubectl, `#!/usr/bin/env bash
printf '%s\n' "$*" >> "$KUBECTL_LOG"
if [[ "$1" != "--context" || "$2" != "gke_octogee_us-west1_octogee-gateway" ]]; then
  exit 64
fi
if [[ "$3" == "get" && "$4" == "namespace" ]]; then
  exit 1
fi
`);
    chmodSync(node, 0o755);
    chmodSync(kubectl, 0o755);

    const result = spawnSync("bash", [resolve(__dirname, "../ensure-namespace-security.sh"),
      "--deployment-target=test-west",
      "--mode=enforce",
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        KUBECTL_LOG: log,
      },
    });

    expect(result.status, result.stderr).toBe(0);
    const calls = readFileSync(log, "utf8").trim().split("\n");
    expect(calls).toHaveLength(3);
    expect(calls.every((call) =>
      call.startsWith("--context gke_octogee_us-west1_octogee-gateway "))).toBe(true);
  });
});
