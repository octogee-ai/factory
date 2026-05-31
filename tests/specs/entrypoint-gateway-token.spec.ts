import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
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

function runPublishBlock(opts: {
  profile?: string;
  nodeExit?: number;
}): {
  status: number | null;
  stderr: string;
  calledNode: boolean;
} {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-token-publish-"));
  try {
    const bin = path.join(tmp, "bin");
    fs.mkdirSync(bin);
    const marker = path.join(tmp, "node-called");
    const fakeNode = path.join(bin, "node");
    fs.writeFileSync(
      fakeNode,
      `#!/bin/sh\necho called > "${marker}"\nexit ${opts.nodeExit ?? 0}\n`,
    );
    fs.chmodSync(fakeNode, 0o755);

    const script = `
      set -e
      log() { echo "$*" >&2; }
      export GATEWAY_ID=gw-test
      export GCP_PROJECT_ID=octogee-test
      export GATEWAY_PROFILE="${opts.profile ?? ""}"
      export OPENCLAW_GATEWAY_TOKEN=token-for-test
      eval "$(sed -n '/^# Publish the fresh gateway auth token/,/^# ── Provision ops-agent/p' "${ENTRYPOINT}")"
    `;
    const r = spawnSync("sh", ["-c", script], {
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      },
    });
    return {
      status: r.status,
      stderr: r.stderr,
      calledNode: fs.existsSync(marker),
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe("infra/gateway/entrypoint.sh — gateway token Secret Manager publish boundary", () => {
  it("skips Secret Manager publish on operator gateways (locked KSA has no SM access)", () => {
    const result = runPublishBlock({ profile: "operator", nodeExit: 2 });
    expect(result.status).toBe(0);
    expect(result.calledNode).toBe(false);
    expect(result.stderr).toMatch(/operator profile: skipping gateway auth token Secret Manager publish/);
  });

  it("still publishes to Secret Manager for cattle gateways", () => {
    const result = runPublishBlock({ profile: "standard", nodeExit: 0 });
    expect(result.status).toBe(0);
    expect(result.calledNode).toBe(true);
    expect(result.stderr).toMatch(/gateway auth token published to Secret Manager/);
  });
});

function runnerBlockSource(): string {
  const src = fs.readFileSync(ENTRYPOINT, "utf8");
  const start = src.indexOf("TSX=/octogee/scripts/node_modules/.bin/tsx");
  const end = src.indexOf("# Builder-shell PTY server", start);
  if (start < 0 || end < 0) {
    throw new Error("could not locate runner startup block in entrypoint.sh");
  }
  return src.slice(start, end).replace(
    /supervise_runner\(\) \{[\s\S]*?\n\}\n/,
    [
      "supervise_runner() {",
      "  echo \"$1\" >> \"$RUNNER_MARKER\"",
      "}",
      "",
    ].join("\n"),
  );
}

function runRunnerBlock(profile: string): {
  status: number | null;
  stderr: string;
  runners: string[];
} {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "entrypoint-runners-"));
  try {
    const marker = path.join(tmp, "runners");
    const script = `
      set -e
      log() { echo "$*" >&2; }
      export GATEWAY_PROFILE="${profile}"
      export RUNNER_MARKER="${marker}"
      ${runnerBlockSource()}
    `;
    const r = spawnSync("sh", ["-c", script], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    });
    const runners = fs.existsSync(marker)
      ? fs.readFileSync(marker, "utf8").trim().split("\n").filter(Boolean)
      : [];
    return { status: r.status, stderr: r.stderr, runners };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe("infra/gateway/entrypoint.sh — locked operator platform provisioner boundary", () => {
  it("does not start platform-authoritative provisioner runners on operator gateways", () => {
    const result = runRunnerBlock("operator");
    expect(result.status).toBe(0);
    expect(result.runners).toContain("fleet-controller");
    expect(result.runners).toContain("site-build");
    expect(result.runners).toContain("preview-proxy");
    expect(result.runners).not.toContain("provisioner");
    expect(result.runners).not.toContain("byosub-syncback");
    expect(result.stderr).toMatch(/Operator platform provisioner disabled/);
  });

  it("keeps provisioner and byosub syncback running on cattle gateways", () => {
    const result = runRunnerBlock("standard");
    expect(result.status).toBe(0);
    expect(result.runners).toEqual([
      "provisioner",
      "site-build",
      "preview-proxy",
      "byosub-syncback",
    ]);
  });
});

// ── PVC operator-env seam ──────────────────────────────────────────────────
// Per GATEWAY-PLATFORM-SPEC.md §Operator-class customization surface:
// operator-class gateways (PVC home) get a single shell-sourceable env
// file at ~/.openclaw/secrets/operator.env for additional credentials/
// integrations the platform doesn't manage. Sourced by entrypoint.sh
// AFTER the platform require block so the operator can override their
// own gateway (but the intent is additive — personal Discord bots,
// custom MCP credentials, personal API keys). Survives every reschedule
// via PVC; helm-invisible. First proven on gw-bender 2026-05-24 when
// the Discord bot token rehome needed a place to live that didn't
// require a platform-wide K8s Secret edit.

function runOperatorEnvBlock(opts: {
  envFile?: string; // contents to write to operator.env (undefined = file absent)
  envFilePerm?: number;
}): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "operator-env-"));
  try {
    fs.mkdirSync(path.join(tmp, "secrets"), { recursive: true });
    if (opts.envFile !== undefined) {
      const filePath = path.join(tmp, "secrets", "operator.env");
      fs.writeFileSync(filePath, opts.envFile);
      if (opts.envFilePerm !== undefined) fs.chmodSync(filePath, opts.envFilePerm);
    }
    // Provide OPENCLAW_GATEWAY_TOKEN (required by the preceding block) so
    // the script doesn't fail-loud before reaching the operator-env block.
    // `eval` rather than `sed | sh` so the sourced env propagates into the
    // current shell where we can echo it back for assertion.
    const script = `
      set -e
      log() { echo "$*" >&2; }
      export OPENCLAW_GATEWAY_TOKEN=token-for-test
      export OPENCLAW_DIR="${tmp}"
      eval "$(sed -n '/^# ── Source operator-customization env/,/^# ── End operator-env/p' "${ENTRYPOINT}")"
      echo "DISCORD_BENDER_TOKEN=\${DISCORD_BENDER_TOKEN:-_unset_}"
      echo "PERSONAL_OPENAI_API_KEY=\${PERSONAL_OPENAI_API_KEY:-_unset_}"
    `;
    const r = spawnSync("sh", ["-c", script], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ── PVC openclaw.json token re-sync ────────────────────────────────────────
// Closes the chicken-and-egg gap discovered on gw-bender 2026-05-24:
//   K8s secret gateway-auth-token-<id> → env (new)         ← rotated
//   openclaw.json gateway.auth.token   (stale)              ← persisted by
//                                                            openclaw's own
//                                                            AJV-defaults
//                                                            round-trip
// Per #1160 the K8s secret is the source of truth; this re-syncs the
// PVC field from env on every boot so a rotation never leaves openclaw
// auth-stale forever. Runs in the `else` branch (openclaw.json already
// exists) — the fresh-template branch already gets the right token via
// envsubst. python3 (always in the image) avoids a jq dependency.

function runTokenResyncBlock(opts: {
  initialJson: unknown;
  envToken: string;
}): {
  status: number | null;
  stdout: string;
  stderr: string;
  finalJson: unknown;
} {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "token-resync-"));
  try {
    const jsonPath = path.join(tmp, "openclaw.json");
    fs.writeFileSync(jsonPath, JSON.stringify(opts.initialJson, null, 2));
    const script = `
      set -e
      log() { echo "$*" >&2; }
      export OPENCLAW_DIR="${tmp}"
      export OPENCLAW_GATEWAY_TOKEN="${opts.envToken}"
      export GATEWAY_ID=gw-test
      # The branch we're testing is the \`else\` arm — openclaw.json EXISTS.
      # Anchors are indented (inside else); allow leading whitespace in the sed pattern.
      eval "$(sed -n '/^[[:space:]]*# ── Re-sync openclaw.json gateway.auth.token/,/^[[:space:]]*# ── End re-sync/p' "${ENTRYPOINT}")"
    `;
    const r = spawnSync("sh", ["-c", script], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    });
    const finalJson = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, finalJson };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe("infra/gateway/entrypoint.sh — shell var export contract (subprocess visibility)", () => {
  // The re-sync block + publish-gateway-token.mjs + openclaw all run as
  // subprocesses and read OPENCLAW_DIR from their environment. If the
  // top-level OPENCLAW_DIR assignment isn't `export`ed, every subprocess
  // gets KeyError → `set -e` → crashloop. Caught by independent audit on
  // PR #1166 (the test harness happened to export OPENCLAW_DIR itself,
  // masking the production gap). Pin the contract structurally so the
  // export can never be removed without failing this test.
  it("exports OPENCLAW_DIR (visible to subprocesses; not just a shell-local var)", () => {
    const entrypoint = fs.readFileSync(ENTRYPOINT, "utf8");
    expect(entrypoint).toMatch(/^export\s+OPENCLAW_DIR=/m);
  });

  it("exports OPENCLAW_GATEWAY_TOKEN (regression guard — same class as OPENCLAW_DIR)", () => {
    const entrypoint = fs.readFileSync(ENTRYPOINT, "utf8");
    expect(entrypoint).toMatch(/^export\s+OPENCLAW_GATEWAY_TOKEN\b/m);
  });

  it("exports GATEWAY_ID (regression guard — referenced by envsubst child process)", () => {
    const entrypoint = fs.readFileSync(ENTRYPOINT, "utf8");
    expect(entrypoint).toMatch(/^export\s+GATEWAY_ID=/m);
  });
});

describe("infra/gateway/entrypoint.sh — openclaw.json token re-sync (PVC drift fix)", () => {
  it("overwrites a stale gateway.auth.token with the env value", () => {
    const result = runTokenResyncBlock({
      initialJson: {
        gateway: { auth: { token: "stale-token-from-prior-boot" } },
        agents: { list: [{ id: "test" }] },
      },
      envToken: "fresh-env-token",
    });
    expect(result.status).toBe(0);
    const j = result.finalJson as { gateway: { auth: { token: string } } };
    expect(j.gateway.auth.token).toBe("fresh-env-token");
  });

  it("preserves every other field in openclaw.json (only touches gateway.auth.token)", () => {
    const initial = {
      gateway: { auth: { token: "stale" }, other: "preserve me" },
      agents: { list: [{ id: "octogee-ops-gw-bender", identity: { name: "Bender" } }] },
      channels: { discord: { enabled: true } },
    };
    const result = runTokenResyncBlock({ initialJson: initial, envToken: "fresh" });
    expect(result.status).toBe(0);
    const j = result.finalJson as Record<string, unknown> & {
      gateway: { auth: { token: string }; other: string };
    };
    expect(j.gateway.auth.token).toBe("fresh");
    expect(j.gateway.other).toBe("preserve me");
    expect(j.agents).toEqual(initial.agents);
    expect(j.channels).toEqual(initial.channels);
  });

  it("creates gateway.auth.token if absent (defensive: legacy openclaw.json without that field)", () => {
    const result = runTokenResyncBlock({
      initialJson: { agents: { list: [] } },
      envToken: "newly-seeded",
    });
    expect(result.status).toBe(0);
    const j = result.finalJson as { gateway?: { auth?: { token?: string } } };
    expect(j.gateway?.auth?.token).toBe("newly-seeded");
  });
});

describe("infra/gateway/entrypoint.sh — PVC operator.env seam", () => {
  it("sources operator.env from $OPENCLAW_DIR/secrets/operator.env and exports its vars (the bender Discord rehome path)", () => {
    const result = runOperatorEnvBlock({
      envFile: "DISCORD_BENDER_TOKEN=test-bender-token-value\n",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("DISCORD_BENDER_TOKEN=test-bender-token-value");
  });

  it("supports multiple operator-defined vars in one file (additive secrets pattern, not just Discord)", () => {
    const result = runOperatorEnvBlock({
      envFile: [
        "DISCORD_BENDER_TOKEN=token-1",
        "PERSONAL_OPENAI_API_KEY=key-2",
      ].join("\n"),
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("DISCORD_BENDER_TOKEN=token-1");
    expect(result.stdout).toContain("PERSONAL_OPENAI_API_KEY=key-2");
  });

  it("no-ops cleanly when operator.env is absent (cattle gateways without operator overrides)", () => {
    const result = runOperatorEnvBlock({ envFile: undefined });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("DISCORD_BENDER_TOKEN=_unset_");
  });

  it("ignores blank lines and # comments (standard shell env-file convention)", () => {
    const result = runOperatorEnvBlock({
      envFile: [
        "# Operator's personal credentials",
        "",
        "DISCORD_BENDER_TOKEN=token-with-comments-around",
        "# trailing comment",
      ].join("\n"),
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("DISCORD_BENDER_TOKEN=token-with-comments-around");
  });
});
