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
  publish?: string;
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
      export GATEWAY_AUTH_SECRET_MANAGER_PUBLISH="${opts.publish ?? ""}"
      export OPENCLAW_GATEWAY_TOKEN=token-for-test
      eval "$(sed -n '/^# Publish the fresh gateway auth token/,/^# ── End gateway auth token publish/p' "${ENTRYPOINT}")"
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
  it("skips Secret Manager publish by default on standard gateways", () => {
    const result = runPublishBlock({ profile: "standard", nodeExit: 2 });
    expect(result.status).toBe(0);
    expect(result.calledNode).toBe(false);
    expect(result.stderr).toMatch(/skipping gateway auth token Secret Manager publish/);
  });

  it("skips Secret Manager publish by default on operator gateways", () => {
    const result = runPublishBlock({ profile: "operator", nodeExit: 2 });
    expect(result.status).toBe(0);
    expect(result.calledNode).toBe(false);
    expect(result.stderr).toMatch(/skipping gateway auth token Secret Manager publish/);
  });

  it("publishes to Secret Manager only when explicitly requested", () => {
    const result = runPublishBlock({ profile: "standard", nodeExit: 0, publish: "true" });
    expect(result.status).toBe(0);
    expect(result.calledNode).toBe(true);
    expect(result.stderr).toMatch(/gateway auth token published to Secret Manager/);
  });
});


function runnerBlockSource(): string {
  const src = fs.readFileSync(ENTRYPOINT, "utf8");
  const earlyStart = src.indexOf("# BuilderShell comes up before the durable restore");
  const earlyEnd = src.indexOf("# ── Owner-bound runtime system_config restore", earlyStart);
  const start = src.indexOf("# ── In-pod runners:");
  const end = src.indexOf("# ── Runner metrics exporter", start);
  if (earlyStart < 0 || earlyEnd < 0 || start < 0 || end < 0) {
    throw new Error("could not locate runner startup block in entrypoint.sh");
  }
  return [
    "supervise_runner() {",
    "  echo \"$1\" >> \"$RUNNER_MARKER\"",
    "}",
    src.slice(earlyStart, earlyEnd),
    src.slice(start, end),
  ].join("\n");
}

function runRunnerBlock(
  profile: string,
  opts: { operatorShellsEnabled?: string; gatewayClass?: string } = {},
): {
  status: number | null;
  stderr: string;
  runners: string[];
} {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "entrypoint-runners-"));
  try {
    const marker = path.join(tmp, "runners");
    const gatewayClass = opts.gatewayClass ?? (profile === "operator" ? "operator" : "shared");
    const script = `
      set -e
      log() { echo "$*" >&2; }
      export GATEWAY_PROFILE="${profile}"
      export GATEWAY_CLASS_EFFECTIVE="${gatewayClass}"
      export OPERATOR_SHELLS_ENABLED="${opts.operatorShellsEnabled ?? ""}"
      export RUNNER_MARKER="${marker}"
      TSX=/octogee/scripts/node_modules/.bin/tsx
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
  it("starts only the db-less controller and neutral side runners on operator gateways", () => {
    const result = runRunnerBlock("operator");
    expect(result.status).toBe(0);
    expect(result.runners).toContain("fleet-controller");
    expect(result.runners).toContain("preview-proxy");
    expect(result.runners).not.toContain("provisioner");
    expect(result.runners).not.toContain("site-build");
    expect(result.runners).not.toContain("byosub-syncback");
    expect(result.runners).not.toContain("builder-shell");
    expect(result.stderr).toMatch(/Operator site-build-api disabled/);
    expect(result.stderr).toMatch(/Builder-shell disabled/);
  });

  it("starts the db-less fleet controller and cattle side runners on standard gateways, never builder-shell", () => {
    const result = runRunnerBlock("standard", { operatorShellsEnabled: "true" });
    expect(result.status).toBe(0);
    expect(result.runners).toEqual([
      "fleet-controller",
      "site-build",
      "preview-proxy",
      "byosub-syncback",
    ]);
  });

  it("starts builder-shell on explicitly unlocked builder gateways", () => {
    const result = runRunnerBlock("standard", {
      gatewayClass: "builder",
      operatorShellsEnabled: "true",
    });
    expect(result.status).toBe(0);
    expect(result.runners).toEqual([
      "builder-shell",
      "fleet-controller",
      "site-build",
      "preview-proxy",
      "byosub-syncback",
      "system-config-watch",
    ]);
  });

  it("starts builder-shell on explicitly unlocked operator gateways", () => {
    const result = runRunnerBlock("operator", { operatorShellsEnabled: "true" });
    expect(result.status).toBe(0);
    expect(result.runners).toContain("fleet-controller");
    expect(result.runners).toContain("preview-proxy");
    expect(result.runners).toContain("builder-shell");
    expect(result.runners).not.toContain("site-build");
    expect(result.runners).not.toContain("byosub-syncback");
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

describe("infra/gateway/entrypoint.sh — shell var export contract (subprocess visibility)", () => {
  // OpenClaw and the config helpers run as subprocesses and read OPENCLAW_DIR
  // from their environment. If the
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

  it("exports GATEWAY_ID (regression guard — referenced by OpenClaw config substitution)", () => {
    const entrypoint = fs.readFileSync(ENTRYPOINT, "utf8");
    expect(entrypoint).toMatch(/^export\s+GATEWAY_ID=/m);
  });
});

describe("infra/gateway/entrypoint.sh — gateway token stays outside durable config", () => {
  it("does not patch OPENCLAW_GATEWAY_TOKEN into openclaw.json", () => {
    const entrypoint = fs.readFileSync(ENTRYPOINT, "utf8");
    expect(entrypoint).not.toMatch(/setdefault\("gateway"[\s\S]*\["token"\]/);
    expect(entrypoint).not.toMatch(/gateway\.auth\.token re-synced/);
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
