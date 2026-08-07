import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OpenClawSecretsApplyError,
  applyOpenClawSecretsPlan,
  authProfileApiKeyTarget,
  buildOpenClawSecretsPlan,
  type OpenClawSecretsPlan,
} from "./openclaw-secrets-apply.js";

const tmpDirs: string[] = [];

function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "secrets-apply-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function target() {
  return authProfileApiKeyTarget({
    agentId: "octogee-alice-coach",
    profileId: "anthropic:default",
    provider: "anthropic",
    refId: "agent-model-token-octogee-alice-coach",
  });
}

function plan(): OpenClawSecretsPlan {
  return buildOpenClawSecretsPlan([target()], () => new Date("2026-08-07T00:00:00.000Z"));
}

describe("authProfileApiKeyTarget", () => {
  it("addresses the profile's key by path and carries the exec ref the resolver answers", () => {
    expect(target()).toEqual({
      type: "auth-profiles.api_key.key",
      path: "profiles.anthropic:default.key",
      ref: {
        source: "exec",
        provider: "gcp-secret-manager",
        id: "agent-model-token-octogee-alice-coach",
      },
      agentId: "octogee-alice-coach",
      authProfileProvider: "anthropic",
    });
  });
});

describe("buildOpenClawSecretsPlan", () => {
  it("stamps the manual plan envelope openclaw's secrets apply expects", () => {
    expect(plan()).toEqual({
      version: 1,
      protocolVersion: 1,
      generatedAt: "2026-08-07T00:00:00.000Z",
      generatedBy: "manual",
      targets: [target()],
    });
  });
});

describe("applyOpenClawSecretsPlan", () => {
  it("runs `secrets apply --from <plan> --allow-exec` against a 0600 plan file", () => {
    const tmpRoot = mkTmp();
    let seen: { file: string; mode: number; body: unknown } | null = null;
    const run = vi.fn((_command: string, args: string[]) => {
      const file = args[args.indexOf("--from") + 1]!;
      seen = {
        file,
        mode: fs.statSync(file).mode & 0o777,
        body: JSON.parse(fs.readFileSync(file, "utf8")),
      };
      return { status: 0, stdout: "applied 1 target", stderr: "" };
    });

    applyOpenClawSecretsPlan(plan(), { run, tmpRoot, command: "openclaw" });

    expect(run).toHaveBeenCalledWith(
      "openclaw",
      ["secrets", "apply", "--from", expect.any(String), "--allow-exec"],
      expect.objectContaining({ env: expect.any(Object) }),
    );
    expect(seen!.mode).toBe(0o600);
    expect(seen!.body).toEqual(plan());
  });

  it("adds --dry-run when the caller asks for one", () => {
    const run = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));

    applyOpenClawSecretsPlan(plan(), { run, tmpRoot: mkTmp(), dryRun: true });

    expect(run.mock.calls[0]![1]).toEqual([
      "secrets",
      "apply",
      "--from",
      expect.any(String),
      "--allow-exec",
      "--dry-run",
    ]);
  });

  it("deletes the plan file even when the command fails", () => {
    const tmpRoot = mkTmp();
    let planPath = "";
    const run = vi.fn((_command: string, args: string[]) => {
      planPath = args[args.indexOf("--from") + 1]!;
      return { status: 3, stdout: "", stderr: "resolver refused agent-model-token-…" };
    });

    expect(() => applyOpenClawSecretsPlan(plan(), { run, tmpRoot })).toThrow(
      OpenClawSecretsApplyError,
    );
    expect(fs.existsSync(planPath)).toBe(false);
  });

  it("names the exit status and stderr so a failed apply is never silent", () => {
    const run = vi.fn(() => ({ status: 3, stdout: "", stderr: "exec resolver returned errors" }));

    expect(() => applyOpenClawSecretsPlan(plan(), { run, tmpRoot: mkTmp() })).toThrow(
      /exit 3.*exec resolver returned errors/s,
    );
  });

  it("surfaces a spawn failure rather than treating it as applied", () => {
    const run = vi.fn(() => ({
      status: null,
      stdout: "",
      stderr: "",
      error: new Error("spawn openclaw ENOENT"),
    }));

    expect(() => applyOpenClawSecretsPlan(plan(), { run, tmpRoot: mkTmp() })).toThrow(
      /spawn openclaw ENOENT/,
    );
  });

  it("does not run the command at all for an empty plan", () => {
    const run = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));

    applyOpenClawSecretsPlan(buildOpenClawSecretsPlan([]), { run, tmpRoot: mkTmp() });

    expect(run).not.toHaveBeenCalled();
  });
});
