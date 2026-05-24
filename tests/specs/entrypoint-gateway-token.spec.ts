import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import * as path from "node:path";

// Pins the contract of the OPENCLAW_GATEWAY_TOKEN require block in
// infra/gateway/entrypoint.sh.
//
// Pre-PR #TBD: entrypoint sourced infra/gateway/resolve-gateway-token.sh,
// which had three fallback layers (env > openclaw.json > fresh random per
// boot). The fresh-random branch caused token drift across reboots on
// operator gateways where openclaw.json was edited out-of-band, and the
// kubectl-set-env workaround that filled the gap on bender's gateway-edge
// container led to field-manager collision that silently dropped
// INTERNAL_SERVICE_KEY when the helm chart did its next dedup pass.
//
// New model: platform-owned. Cowboy creates a per-gateway K8s secret
// `gateway-auth-token-<id>`; the chart threads OPENCLAW_GATEWAY_TOKEN via
// secretKeyRef on every container that needs it. Entrypoint REQUIRES the
// env to be non-empty — no fallback, no in-pod generation. If the secret
// is missing the chart fails to render. If somehow the env is empty
// anyway, entrypoint crash-loops the pod with a FATAL banner so the
// failure surfaces in `kubectl describe pod` rather than silently
// producing a gateway nobody can authenticate against.

const ENTRYPOINT = path.resolve(__dirname, "../../infra/gateway/entrypoint.sh");

function runGuardBlock(envToken: string | undefined): {
  status: number | null;
  stderr: string;
} {
  // Run JUST the `require token` guard from entrypoint.sh, not the whole
  // boot — extract the single line via sed so the rest of the entrypoint
  // (which would try to do real K8s/MM/Gitea work) doesn't execute.
  const script = `
    set -e
    log() { echo "$*" >&2; }
    # Mirror the exact guard from entrypoint.sh — keep this in sync if the
    # message format changes there.
    sed -n '/^# ── Require OPENCLAW_GATEWAY_TOKEN/,/^# ── End require/p' "${ENTRYPOINT}" | sh
  `;
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
  };
  if (envToken !== undefined) env.OPENCLAW_GATEWAY_TOKEN = envToken;
  const r = spawnSync("sh", ["-c", script], { encoding: "utf8", env });
  return { status: r.status, stderr: r.stderr };
}

describe("infra/gateway/entrypoint.sh — OPENCLAW_GATEWAY_TOKEN platform-owned (fail-loud)", () => {
  it("accepts a non-empty OPENCLAW_GATEWAY_TOKEN from env (the chart's secretKeyRef path)", () => {
    const result = runGuardBlock("a".repeat(48));
    expect(result.status).toBe(0);
  });

  it("FATAL when OPENCLAW_GATEWAY_TOKEN is empty (Cowboy didn't seed gateway-auth-token-<id>, or chart-secret binding broke)", () => {
    const result = runGuardBlock("");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/OPENCLAW_GATEWAY_TOKEN/);
    expect(result.stderr).toMatch(/FATAL/i);
  });

  it("FATAL when OPENCLAW_GATEWAY_TOKEN is unset entirely (e.g. accidentally trimmed from the chart's env block)", () => {
    const result = runGuardBlock(undefined);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/OPENCLAW_GATEWAY_TOKEN/);
    expect(result.stderr).toMatch(/FATAL/i);
  });
});
