import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Pins the contract of infra/gateway/resolve-gateway-token.sh (sourced by
// entrypoint.sh). The bug this guards against (bender, 2026-05-23):
// entrypoint generated a fresh random OPENCLAW_GATEWAY_TOKEN every boot,
// but the on-disk openclaw.json was preserved across boots — when an
// operator had set a token in openclaw.json for external driving (Discord,
// remote Mac Studio bridge), the env (random) and the file (operator-set)
// drifted permanently. openclaw authed against the on-disk value; the
// in-pod provisioner authed via env; every provisioner→openclaw RPC failed
// with token_mismatch.

const HELPER = path.resolve(
  __dirname,
  "../../infra/gateway/resolve-gateway-token.sh",
);

function runHelper(opts: {
  openclawJson?: unknown;
  envToken?: string;
}): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gw-token-"));
  try {
    if (opts.openclawJson !== undefined) {
      fs.writeFileSync(
        path.join(tmp, "openclaw.json"),
        JSON.stringify(opts.openclawJson),
      );
    }
    // Source the real helper; print the resulting token.
    const script = `. "${HELPER}"; printf '%s' "$OPENCLAW_GATEWAY_TOKEN"`;
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: tmp,
      OPENCLAW_DIR: tmp,
    };
    if (opts.envToken !== undefined) env.OPENCLAW_GATEWAY_TOKEN = opts.envToken;
    const r = spawnSync("sh", ["-c", script], { encoding: "utf8", env });
    if (r.status !== 0) {
      throw new Error(`sh failed (status=${r.status}): ${r.stderr}`);
    }
    return r.stdout;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe("infra/gateway/resolve-gateway-token.sh (gateway-auth-token resolution; bender drift fix)", () => {
  it("env-provided OPENCLAW_GATEWAY_TOKEN wins over an on-disk token", () => {
    const got = runHelper({
      envToken: "env-wins-token",
      openclawJson: { gateway: { auth: { token: "should-not-be-used" } } },
    });
    expect(got).toBe("env-wins-token");
  });

  it("REGRESSION GUARD: existing openclaw.json gateway.auth.token is preserved when env is unset (drift fix — operator-set tokens survive every reboot)", () => {
    const got = runHelper({
      openclawJson: { gateway: { auth: { token: "operator-set-token" } } },
    });
    expect(got).toBe("operator-set-token");
  });

  it("falls back to a fresh 48-hex random when neither env nor on-disk token present", () => {
    const got = runHelper({ openclawJson: { gateway: { auth: {} } } });
    expect(got).toMatch(/^[a-f0-9]{48}$/);
  });

  it("falls back to a fresh random when openclaw.json missing entirely", () => {
    const got = runHelper({});
    expect(got).toMatch(/^[a-f0-9]{48}$/);
  });

  it("empty-string env value still falls through to on-disk (treats empty as 'unset' — matches the bug shape we saw on bender)", () => {
    const got = runHelper({
      envToken: "",
      openclawJson: { gateway: { auth: { token: "from-disk-when-env-empty" } } },
    });
    expect(got).toBe("from-disk-when-env-empty");
  });

  // Copilot review C1: OPENCLAW_DIR was interpolated directly into the
  // inline Python source ("open('$DIR/openclaw.json')"). A path containing a
  // single quote (or other Python-significant char) would break the Python
  // parse, the helper would silently fall back to random, AND it'd be an
  // injection surface. Fix: pass the path as argv to python3 so it's
  // treated as data, not code.
  it("REGRESSION GUARD (Copilot C1): path containing a single quote does not break extraction (injection-safe)", () => {
    const baseTmp = fs.mkdtempSync(path.join(os.tmpdir(), "gw-tok-base-"));
    const trickyDir = path.join(baseTmp, "has'quote");
    fs.mkdirSync(trickyDir);
    fs.writeFileSync(
      path.join(trickyDir, "openclaw.json"),
      JSON.stringify({ gateway: { auth: { token: "survived-the-quote" } } }),
    );
    try {
      const script = `. "${HELPER}"; printf '%s' "$OPENCLAW_GATEWAY_TOKEN"`;
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: trickyDir,
        OPENCLAW_DIR: trickyDir,
      };
      const r = spawnSync("sh", ["-c", script], { encoding: "utf8", env });
      if (r.status !== 0) {
        throw new Error(`sh failed (status=${r.status}): ${r.stderr}`);
      }
      expect(r.stdout).toBe("survived-the-quote");
    } finally {
      fs.rmSync(baseTmp, { recursive: true, force: true });
    }
  });
});
