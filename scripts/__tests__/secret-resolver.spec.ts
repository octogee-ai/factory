import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const RESOLVER = path.join(__dirname, "..", "secret-resolver.mjs");

interface SpawnOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function runResolver(env: Record<string, string>, stdinPayload: string): Promise<SpawnOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [RESOLVER], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b.toString("utf8")));
    child.stderr.on("data", (b) => (stderr += b.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ exitCode: code, stdout, stderr }));
    child.stdin.end(stdinPayload);
  });
}

interface ResolverResponse {
  protocolVersion: number;
  values: Record<string, string>;
  errors?: Record<string, { message: string }>;
}

function parseResponse(stdout: string): ResolverResponse {
  const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]);
}

describe("secret-resolver — defense-in-depth", () => {
  let agentsDir: string;

  beforeAll(() => {
    agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-resolver-test-"));
    fs.mkdirSync(path.join(agentsDir, "octogee-alice-coach", "agent"), { recursive: true });
    fs.mkdirSync(path.join(agentsDir, "octogee-bob-coach", "agent"), { recursive: true });
    fs.mkdirSync(path.join(agentsDir, "main"), { recursive: true });
    fs.mkdirSync(path.join(agentsDir, "octogee-ops-gw-test"), { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(agentsDir, { recursive: true, force: true });
  });

  function envFor(): Record<string, string> {
    return {
      OPENCLAW_AGENTS_DIR: agentsDir,
      GCP_PROJECT_ID: "octogee-resolver-test",
      GOOGLE_APPLICATION_CREDENTIALS: "/dev/null",
    };
  }

  it("rejects ids that don't match the byok-{slug}-{provider} grammar", async () => {
    const stdin = JSON.stringify({
      protocolVersion: 1,
      provider: "gcp-secret-manager",
      ids: [
        "../../../../etc/passwd",
        "byok-/anthropic",
        "byok-alice-",
        "byok-alice-anthropic-extra",
        "completely-unrelated-secret",
      ],
    });
    const out = await runResolver(envFor(), stdin);
    const res = parseResponse(out.stdout);

    for (const id of [
      "../../../../etc/passwd",
      "byok-/anthropic",
      "byok-alice-",
      "byok-alice-anthropic-extra",
      "completely-unrelated-secret",
    ]) {
      expect(res.errors?.[id]?.message).toMatch(/^Refused by resolver:/);
    }
    expect(Object.keys(res.values)).toHaveLength(0);

    expect(out.stderr).toContain("[secret-resolver/audit] reject");
  });

  it("rejects unknown slugs even if the grammar matches", async () => {
    const id = "byok-eve-anthropic/latest";
    const stdin = JSON.stringify({
      protocolVersion: 1,
      provider: "gcp-secret-manager",
      ids: [id],
    });
    const out = await runResolver(envFor(), stdin);
    const res = parseResponse(out.stdout);

    expect(res.errors?.[id]?.message).toMatch(/no provisioned agent dir/);
    expect(out.stderr).toContain(`reject id="${id}"`);
  });

  it("rejects unsupported providers", async () => {
    const id = "byok-alice-mistral/latest";
    const stdin = JSON.stringify({
      protocolVersion: 1,
      provider: "gcp-secret-manager",
      ids: [id],
    });
    const out = await runResolver(envFor(), stdin);
    const res = parseResponse(out.stdout);
    expect(res.errors?.[id]?.message).toMatch(/Refused by resolver:/);
  });

  it("accepts a known slug + provider and forwards to SM (which fails on the test creds, surfacing in errors)", async () => {
    const id = "byok-alice-anthropic/latest";
    const stdin = JSON.stringify({
      protocolVersion: 1,
      provider: "gcp-secret-manager",
      ids: [id],
    });
    const out = await runResolver(envFor(), stdin);
    const res = parseResponse(out.stdout);

    expect(out.stderr).toContain(`accept id="${id}"`);
    expect(out.stderr).not.toContain(`reject id="${id}"`);
    if (res.errors?.[id]) {
      expect(res.errors[id].message).not.toMatch(/^Refused by resolver:/);
    }
  });

  it("fails closed when AGENTS_DIR can't be read — every id with a slug check is refused", async () => {
    const id = "byok-alice-anthropic/latest";
    const stdin = JSON.stringify({
      protocolVersion: 1,
      provider: "gcp-secret-manager",
      ids: [id],
    });
    const out = await runResolver(
      { ...envFor(), OPENCLAW_AGENTS_DIR: "/nonexistent/path/octogee-fail-closed-test" },
      stdin,
    );
    const res = parseResponse(out.stdout);
    expect(res.errors?.[id]?.message).toMatch(/no provisioned agent dir/);
    expect(out.stderr).toContain("could not enumerate AGENTS_DIR");
  });

  it("caps audit-log volume on rejection floods (no log-bill DoS, no haystack hide)", async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `byok-attacker${i}-anthropic/latest`);
    const stdin = JSON.stringify({
      protocolVersion: 1,
      provider: "gcp-secret-manager",
      ids,
    });
    const out = await runResolver(envFor(), stdin);
    const res = parseResponse(out.stdout);

    expect(Object.keys(res.errors || {})).toHaveLength(25);

    const rejectLines = (out.stderr.match(/\[secret-resolver\/audit\] reject id=/g) || []).length;
    expect(rejectLines).toBe(10);
    expect(out.stderr).toContain("reject-summary suppressed=15");
  });

  it("partially resolves a mixed batch — accepts known slugs, rejects unknown ones in the same call", async () => {
    const stdin = JSON.stringify({
      protocolVersion: 1,
      provider: "gcp-secret-manager",
      ids: [
        "byok-alice-anthropic/latest",
        "byok-eve-anthropic/latest",
        "byok-bob-openai/latest",
      ],
    });
    const out = await runResolver(envFor(), stdin);
    const res = parseResponse(out.stdout);

    expect(res.errors?.["byok-eve-anthropic/latest"]?.message).toMatch(/^Refused by resolver:/);
    if (res.errors?.["byok-alice-anthropic/latest"]) {
      expect(res.errors["byok-alice-anthropic/latest"].message).not.toMatch(/^Refused by resolver:/);
    }
  });
});
