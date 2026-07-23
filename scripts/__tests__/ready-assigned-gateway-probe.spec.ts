import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const helper = path.join(repoRoot, "scripts/lib/ready-assigned-gateway-probe.sh");

type Gateway = { name: string; desired: number; ready: number; assigned: boolean };

function executable(file: string, source: string): void {
  writeFileSync(file, source);
  chmodSync(file, 0o755);
}

function run(gateways: Gateway[]) {
  const temp = mkdtempSync(path.join(tmpdir(), "ready-assigned-gateway-"));
  const payload = JSON.stringify({ items: gateways.map((gateway) => ({
    metadata: { name: gateway.name },
    spec: { replicas: gateway.desired },
    status: { readyReplicas: gateway.ready },
  })) });
  const assignedDeployments = gateways
    .filter((gateway) => gateway.assigned)
    .map((gateway) => gateway.name)
    .join(",");

  executable(path.join(temp, "kubectl"), `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *" get deployment "* ]]; then
  printf '%s\\n' "$FAKE_DEPLOYMENTS"
  exit 0
fi
if [[ "$*" == *" exec deployment/"* ]]; then
  args="$*"
  deployment="\${args#*exec deployment/}"
  deployment="\${deployment%% *}"
  if [[ ",$FAKE_ASSIGNED_DEPLOYMENTS," == *",$deployment,"* ]]; then
    printf 'Gitea broker read succeeded for tenant; workspace repo present\\n'
    exit 0
  fi
  printf '[gitea-broker-probe] gateway %s has no assigned tenant for the Gitea broker probe\\n' "$deployment" >&2
  exit 1
fi
printf 'unexpected kubectl call: %s\\n' "$*" >&2
exit 2
`);

  const result = spawnSync("bash", ["-euo", "pipefail", "-c", [
    `source ${JSON.stringify(helper)}`,
    "probe_ready_assigned_gateway_gitea_broker test-context test-namespace",
  ].join("\n")], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${temp}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      FAKE_DEPLOYMENTS: payload,
      FAKE_ASSIGNED_DEPLOYMENTS: assignedDeployments,
    },
  });
  rmSync(temp, { recursive: true, force: true });
  return result;
}

describe("ready assigned gateway Gitea broker probe", () => {
  it("skips an empty Ready default gateway and deterministically probes the assigned Ready gateway", () => {
    const result = run([
      { name: "octogee-gateway-default", desired: 1, ready: 1, assigned: false },
      { name: "octogee-gateway-builder-a", desired: 1, ready: 1, assigned: true },
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("octogee-gateway-builder-a");
  });

  it("does not choose an unready gateway even when it has an assignment", () => {
    const result = run([
      { name: "octogee-gateway-builder-a", desired: 1, ready: 0, assigned: true },
      { name: "octogee-gateway-builder-b", desired: 1, ready: 1, assigned: true },
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("octogee-gateway-builder-b");
  });

  it("fails loudly when no Ready gateway has an assigned tenant", () => {
    const result = run([
      { name: "octogee-gateway-default", desired: 1, ready: 1, assigned: false },
      { name: "octogee-gateway-builder-a", desired: 1, ready: 0, assigned: true },
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("No Ready gateway has an assigned tenant for the Gitea broker probe");
  });
});
