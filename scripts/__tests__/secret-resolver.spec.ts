/**
 * Integration tests for scripts/secret-resolver.mjs — spawn the real
 * resolver as a child process and feed it the OpenClaw exec protocol over
 * stdin/stdout, exactly like the gateway does in prod.
 *
 * Focus: the defense-in-depth checks added to harden against cross-customer
 * key access (id grammar + known-slug allowlist + audit log). Tests do
 * NOT verify GCP Secret Manager resolution — that path requires real
 * Workload Identity creds and is covered by manual prod testing.
 *
 * Why spawn-based: secret-resolver.mjs has top-level side effects
 * (PROJECT_ID assertion, AGENTS_DIR scan) that make in-process unit
 * imports awkward. Spawning matches the actual prod invocation exactly,
 * which is the right granularity for a security-critical boundary.
 */
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

/** Run the resolver with the given env + stdin payload. Resolves with the
 *  full outcome — never throws on non-zero exit (we want to inspect the
 *  protocol response). */
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
  // The resolver protocol is jsonOnly on stdout — any non-JSON write
  // corrupts the payload the gateway reads in production (see file header).
  // Enforce that here too so a regression that accidentally logs to stdout
  // (e.g. someone writes `console.log(...)` instead of `process.stderr.write`)
  // surfaces as a test failure, not silent protocol corruption in prod.
  const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]);
}

describe("secret-resolver — defense-in-depth", () => {
  let agentsDir: string;

  beforeAll(() => {
    agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-resolver-test-"));
    // Two known customers — the slug allowlist is built from these dirs.
    fs.mkdirSync(path.join(agentsDir, "octogee-alice-coach", "agent"), { recursive: true });
    fs.mkdirSync(path.join(agentsDir, "octogee-bob-coach", "agent"), { recursive: true });
    // Junk dirs that shouldn't show up in the allowlist.
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
      // Wipe ADC so the SM client fails fast on accepted ids — we don't
      // want the test to make real API calls.
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

    // Every malformed id must surface in `errors[id]` with the resolver's
    // refusal message — nothing should leak through to GCP.
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

    // Audit trail: every reject should appear on stderr so an operator can
    // forensically tell "agent X tried to read Y but was blocked".
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

    // eve isn't in agentsDir → the allowlist check stops her id before any
    // SM call. This is the layer that makes "agent A asks for slug=admin"
    // not work even if 'admin' would otherwise be a valid grammar match.
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

    // Validation accepts → audit shows accept, NOT reject. The negative
    // assertion catches a regression that flips accept ↔ reject (or logs
    // both) — accept-only is the contract.
    expect(out.stderr).toContain(`accept id="${id}"`);
    expect(out.stderr).not.toContain(`reject id="${id}"`);
    // SM call will fail (no real creds) — but the failure message is from
    // GCP, not from our refusal. Either errors absent (fluky network) or
    // present with a non-"Refused" message.
    if (res.errors?.[id]) {
      expect(res.errors[id].message).not.toMatch(/^Refused by resolver:/);
    }
  });

  it("fails closed when AGENTS_DIR can't be read — every id with a slug check is refused", async () => {
    // Point the resolver at a non-existent dir to exercise the catch path
    // in loadKnownSlugs. Pre-fix this returned null and validateId
    // skipped the slug check (fail-open). Post-fix it returns an empty
    // Set so every grammar-valid id gets rejected with "no provisioned
    // agent dir" — a loud, visible failure that's exactly the signal we
    // want from a misconfigured deploy.
    const id = "byok-alice-anthropic/latest"; // would be valid in normal config
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
    // 25 unknown-slug ids — all reject — but only the first 10 get a
    // detail audit line, then a single summary line for the suppressed
    // remainder.
    const ids = Array.from({ length: 25 }, (_, i) => `byok-attacker${i}-anthropic/latest`);
    const stdin = JSON.stringify({
      protocolVersion: 1,
      provider: "gcp-secret-manager",
      ids,
    });
    const out = await runResolver(envFor(), stdin);
    const res = parseResponse(out.stdout);

    // All 25 still surface in errors[] for the caller — only the stderr
    // forensic trail is capped.
    expect(Object.keys(res.errors || {})).toHaveLength(25);

    // Count the per-id audit lines on stderr.
    const rejectLines = (out.stderr.match(/\[secret-resolver\/audit\] reject id=/g) || []).length;
    expect(rejectLines).toBe(10);
    expect(out.stderr).toContain("reject-summary suppressed=15");
  });

  it("partially resolves a mixed batch — accepts known slugs, rejects unknown ones in the same call", async () => {
    const stdin = JSON.stringify({
      protocolVersion: 1,
      provider: "gcp-secret-manager",
      ids: [
        "byok-alice-anthropic/latest", // ✓ known slug
        "byok-eve-anthropic/latest",   // ✗ unknown slug
        "byok-bob-openai/latest",      // ✓ known slug
      ],
    });
    const out = await runResolver(envFor(), stdin);
    const res = parseResponse(out.stdout);

    // The refused id MUST surface as "Refused" — it never reaches SM.
    expect(res.errors?.["byok-eve-anthropic/latest"]?.message).toMatch(/^Refused by resolver:/);
    // The accepted ids may surface as SM auth errors (no creds in test) but
    // not as "Refused" — they made it past validation.
    if (res.errors?.["byok-alice-anthropic/latest"]) {
      expect(res.errors["byok-alice-anthropic/latest"].message).not.toMatch(/^Refused by resolver:/);
    }
  });
});
