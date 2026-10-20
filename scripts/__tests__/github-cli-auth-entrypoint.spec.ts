import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runGithubCliAuthConvergence } from "../entrypoints/github-cli-auth-hydrate.js";
import { GithubCliAuthError, type GithubCliAuthResult } from "../lib/github-cli-auth-hydrate.js";

const repoRoot = path.resolve(__dirname, "../..");

describe("Builder GitHub credentials", () => {
  it("starts supervised GitHub auth convergence on every Builder boot behind the standby overlay gate", () => {
    const entrypoint = readFileSync(path.join(repoRoot, "infra/gateway/entrypoint.sh"), "utf8");

    expect(entrypoint).toMatch(/if \[ "\$GATEWAY_CLASS_EFFECTIVE" = "builder" \]; then\n(?: {2}#[^\n]*\n)* {2}supervise_runner github-cli-auth 5000 \$BUILDER_OVERLAY_GATE "\$TSX" \/octogee\/scripts\/entrypoints\/github-cli-auth-hydrate\.ts\n/);
    expect(entrypoint).toContain([
      'BUILDER_OVERLAY_GATE=""',
      'if [ "${OCTOGEE_BUILDER_STANDBY_BOOT:-0}" = 1 ]; then',
      '  BUILDER_OVERLAY_GATE="$TSX /octogee/scripts/entrypoints/builder-claim.ts await-overlay"',
      "fi",
    ].join("\n"));
    expect(entrypoint.indexOf('BUILDER_OVERLAY_GATE=""')).toBeLessThan(entrypoint.indexOf("supervise_runner github-cli-auth"));
    expect(entrypoint.indexOf("github-cli-auth-hydrate.ts")).toBeLessThan(entrypoint.indexOf("supervise_runner surge-openclaw-supervisor"));
  });

  it("retries failures, refreshes again, and stops on shutdown without exposing raw errors", async () => {
    const controller = new AbortController();
    const hydrate = vi.fn<() => Promise<GithubCliAuthResult>>()
      .mockRejectedValueOnce(new GithubCliAuthError("GitHub materialization failed: HTTP 503"))
      .mockRejectedValueOnce(new Error("raw-provider-secret"))
      .mockResolvedValueOnce("hydrated")
      .mockResolvedValue("cleared");
    const warn = vi.fn();
    const log = vi.fn();
    const wait = vi.fn(async () => {
      if (hydrate.mock.calls.length === 5) controller.abort();
    });

    await runGithubCliAuthConvergence({ signal: controller.signal, hydrate, wait, warn, log });

    expect(hydrate).toHaveBeenCalledTimes(5);
    expect(wait).toHaveBeenCalledTimes(5);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("HTTP 503"));
    expect(JSON.stringify(warn.mock.calls)).not.toContain("raw-provider-secret");
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("does not schedule convergence on a shared gateway", async () => {
    const wait = vi.fn();
    await runGithubCliAuthConvergence({
      signal: new AbortController().signal,
      hydrate: vi.fn(async () => "skipped" as const),
      wait,
    });
    expect(wait).not.toHaveBeenCalled();
  });
});
