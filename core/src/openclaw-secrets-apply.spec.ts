import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OpenClawSecretsApplyError,
  applyOpenClawSecretsPlan,
  authProfileApiKeyTarget,
  buildOpenClawSecretsPlan,
} from "./openclaw-secrets-apply.js";

function target() {
  return authProfileApiKeyTarget({
    agentId: "octogee-alice-coach",
    profileId: "anthropic:default",
    provider: "anthropic",
    refId: "agent-model-token-octogee-alice-coach",
  });
}

function plan() {
  return buildOpenClawSecretsPlan([target()], () => new Date("2026-08-07T00:00:00.000Z"));
}

const temporaryDirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function cliFixture(body: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "secrets-apply-cli-"));
  temporaryDirs.push(dir);
  const executable = path.join(dir, "openclaw");
  const capture = path.join(dir, "capture.json");
  await writeFile(executable, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
  vi.stubEnv("PATH", `${dir}${path.delimiter}${process.env.PATH ?? ""}`);
  vi.stubEnv("SECRETS_APPLY_CAPTURE", capture);
  return capture;
}

describe("authProfileApiKeyTarget", () => {
  it("addresses the profile key using the broker exec reference", () => {
    expect(target()).toEqual({
      type: "auth-profiles.api_key.key",
      path: "profiles.anthropic:default.key",
      ref: { source: "exec", provider: "gcp-secret-manager", id: "agent-model-token-octogee-alice-coach" },
      agentId: "octogee-alice-coach",
      authProfileProvider: "anthropic",
    });
  });
});

describe("applyOpenClawSecretsPlan", () => {
  it("asynchronously submits the whole plan to the standard CLI and removes its private temporary file", async () => {
    const capture = await cliFixture(`
const fs = require("node:fs");
const args = process.argv.slice(2);
const filename = args[args.indexOf("--from") + 1];
fs.writeFileSync(process.env.SECRETS_APPLY_CAPTURE, JSON.stringify({args, filename, mode: fs.statSync(filename).mode & 0o777, plan: JSON.parse(fs.readFileSync(filename, "utf8"))}));
setTimeout(() => process.stdout.write(JSON.stringify({mode:"write",changed:true,warningCount:0})), 100);
`);
    let settled = false;
    const pending = applyOpenClawSecretsPlan(plan()).finally(() => { settled = true; });
    await vi.waitFor(() => access(capture), { interval: 5 });
    expect(settled).toBe(false);
    await pending;
    const observed = JSON.parse(await readFile(capture, "utf8"));
    expect(observed.plan).toEqual(plan());
    expect(observed.args).toEqual(["secrets", "apply", "--from", observed.filename, "--allow-exec", "--json"]);
    expect(observed.mode).toBe(0o600);
    await expect(access(observed.filename)).rejects.toThrow();
  });

  it("turns a CLI refusal into the existing deferrable error and cleans up the plan", async () => {
    const capture = await cliFixture(`
const fs = require("node:fs");
fs.writeFileSync(process.env.SECRETS_APPLY_CAPTURE, process.argv[process.argv.indexOf("--from") + 1]);
process.stdout.write(JSON.stringify({ok:false,error:{message:"provider refused"}}));
process.exitCode = 1;
`);
    await expect(applyOpenClawSecretsPlan(plan())).rejects.toThrow("provider refused");
    await expect(access(await readFile(capture, "utf8"))).rejects.toThrow();
  });

  it.each(["not JSON", '{"ok":false,"error":{"message":"provider refused"}}', '{"mode":"dry-run","changed":true}'])(
    "rejects an invalid success acknowledgment: %s",
    async (stdout) => {
      await cliFixture(`process.stdout.write(${JSON.stringify(stdout)});`);
      await expect(applyOpenClawSecretsPlan(plan())).rejects.toThrow(OpenClawSecretsApplyError);
    },
  );

  it("does not run the CLI for an empty plan", async () => {
    const apply = vi.fn();
    await applyOpenClawSecretsPlan(buildOpenClawSecretsPlan([]), { apply });
    expect(apply).not.toHaveBeenCalled();
  });

  it("preserves unexpected caller errors for the reconciliation owner", async () => {
    const error = new TypeError("bad plan construction");
    await expect(applyOpenClawSecretsPlan(plan(), { apply: async () => { throw error; } })).rejects.toBe(error);
  });
});
