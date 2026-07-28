import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// resolveOne is exported for in-process unit coverage of the broker call; the
// resolver's main() is import-guarded, so this import is inert.
import { resolveOne as resolveOneRaw, BROKER_BASE_URL, KSA_TOKEN_PATH } from "../secret-resolver.mjs";
const resolveOne = resolveOneRaw as (
  id: string,
  deps?: {
    token?: string;
    fetchImpl?: (
      url: string,
      init: { method: string; headers: Record<string, string>; body: string },
    ) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
  },
) => Promise<string>;

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

  it("uses an absolute Node interpreter when OpenClaw executes the resolver directly", () => {
    expect(fs.readFileSync(RESOLVER, "utf8").split("\n")[0]).toBe(
      "#!/usr/local/bin/node",
    );
  });

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

  it("accepts a known slug + provider and forwards to the broker (which fails without a KSA token here → errors, not a Refusal)", async () => {
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

  it.each([
    "agent-model-token-octogee-alice-coach",
    "agent-model-token-openrouter-octogee-alice-coach",
    "agent-model-token-openai-octogee-alice-coach",
    "agent-embedding-token-openai-octogee-alice-coach",
  ])("accepts the known ref %s", async (id) => {
    const stdin = JSON.stringify({ protocolVersion: 1, provider: "gcp-secret-manager", ids: [id] });
    const out = await runResolver(envFor(), stdin);
    const res = parseResponse(out.stdout);
    expect(out.stderr).toContain(`accept id="${id}"`);
    if (res.errors?.[id]) {
      expect(res.errors[id].message).not.toMatch(/^Refused by resolver:/);
    }
  });

  it("refuses an agent-model-token ref for an unknown slug (same allowlist as byok)", async () => {
    const id = "agent-model-token-octogee-eve-coach";
    const stdin = JSON.stringify({ protocolVersion: 1, provider: "gcp-secret-manager", ids: [id] });
    const out = await runResolver(envFor(), stdin);
    const res = parseResponse(out.stdout);
    expect(res.errors?.[id]?.message).toMatch(/no provisioned agent dir/);
  });

  it("refuses the retired platform embedding ref grammar", async () => {
    const id = "platform-openai-embedding-octogee-eve-coach";
    const stdin = JSON.stringify({ protocolVersion: 1, provider: "gcp-secret-manager", ids: [id] });
    const out = await runResolver(envFor(), stdin);
    const res = parseResponse(out.stdout);
    expect(res.errors?.[id]?.message).toMatch(/does not match/);
  });
});

describe("resolveOne — brokered byok materialization (unit, injected deps)", () => {
  it("POSTs { id } to /internal/byok/api-key with the KSA token and returns the value", async () => {
    let seen: { url: string; init: { headers: Record<string, string>; body: string } } | undefined;
    const v = await resolveOne("byok-tester5-grok", {
      token: "ksa-tok",
      fetchImpl: async (url, init) => {
        seen = { url, init };
        return { ok: true, status: 200, json: async () => ({ value: "xai-key-tester5" }) };
      },
    });
    expect(v).toBe("xai-key-tester5");
    expect(seen?.url).toBe(`${BROKER_BASE_URL}/internal/byok/api-key`);
    expect(seen?.init.headers["x-k8s-sa-token"]).toBe("ksa-tok");
    expect(JSON.parse(seen!.init.body)).toEqual({ id: "byok-tester5-grok" });
  });

  it("routes an agent-model-token id to /internal/byok/agent-model-token with the embedded agentId", async () => {
    let seen: { url: string; init: { body: string } } | undefined;
    const v = await resolveOne("agent-model-token-octogee-tester5-coach", {
      token: "ksa-tok",
      fetchImpl: async (url, init) => {
        seen = { url, init };
        return { ok: true, status: 200, json: async () => ({ value: "ogk_shared-1_abc" }) };
      },
    });
    expect(v).toBe("ogk_shared-1_abc");
    expect(seen?.url).toBe(`${BROKER_BASE_URL}/internal/byok/agent-model-token`);
    expect(JSON.parse(seen!.init.body)).toEqual({ agentId: "octogee-tester5-coach" });
  });

  it("routes an OpenRouter agent-model-token id with an explicit provider", async () => {
    let seen: { url: string; init: { body: string } } | undefined;
    const v = await resolveOne("agent-model-token-openrouter-octogee-tester5-coach", {
      token: "ksa-tok",
      fetchImpl: async (url, init) => {
        seen = { url, init };
        return { ok: true, status: 200, json: async () => ({ value: "ogk_shared-1_glm" }) };
      },
    });
    expect(v).toBe("ogk_shared-1_glm");
    expect(seen?.url).toBe(`${BROKER_BASE_URL}/internal/byok/agent-model-token`);
    expect(JSON.parse(seen!.init.body)).toEqual({
      agentId: "octogee-tester5-coach",
      provider: "openrouter",
    });
  });

  it("routes an OpenAI agent-model-token id with an explicit provider", async () => {
    let seen: { url: string; init: { body: string } } | undefined;
    const v = await resolveOne("agent-model-token-openai-octogee-tester5-coach", {
      token: "ksa-tok",
      fetchImpl: async (url, init) => {
        seen = { url, init };
        return { ok: true, status: 200, json: async () => ({ value: "ogk_shared-1_oai" }) };
      },
    });
    expect(v).toBe("ogk_shared-1_oai");
    expect(seen?.url).toBe(`${BROKER_BASE_URL}/internal/byok/agent-model-token`);
    expect(JSON.parse(seen!.init.body)).toEqual({
      agentId: "octogee-tester5-coach",
      provider: "openai",
    });
  });

  it("routes an OpenAI embedding token with an explicit purpose", async () => {
    let seen: { url: string; init: { body: string } } | undefined;
    const v = await resolveOne("agent-embedding-token-openai-octogee-tester5-coach", {
      token: "ksa-tok",
      fetchImpl: async (url, init) => {
        seen = { url, init };
        return { ok: true, status: 200, json: async () => ({ value: "ogk_shared-1_embed" }) };
      },
    });
    expect(v).toBe("ogk_shared-1_embed");
    expect(seen?.url).toBe(`${BROKER_BASE_URL}/internal/byok/agent-model-token`);
    expect(JSON.parse(seen!.init.body)).toEqual({
      agentId: "octogee-tester5-coach",
      provider: "openai",
      purpose: "embeddings",
    });
  });


  it("throws on a non-ok broker response (fail loud → surfaces as errors[id], never a silent empty)", async () => {
    await expect(
      resolveOne("byok-tester5-grok", {
        token: "t",
        fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }),
      }),
    ).rejects.toThrow(/403/);
  });

  it("throws on a malformed broker response with no value", async () => {
    await expect(
      resolveOne("byok-tester5-grok", {
        token: "t",
        fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
      }),
    ).rejects.toThrow(/malformed/);
  });

  it("defaults (no broker env) to same-namespace short DNS + the mounted gateway-broker token — existing-config compatible (#1730 P1)", () => {
    // Existing gateways preserve a pre-broker passEnv, so the resolver must work
    // without FLEET_BROKER_URL / OCTOGEE_API_SA_TOKEN_PATH being forwarded.
    if (!process.env.FLEET_BROKER_URL && !process.env.OCTOGEE_API_URL) {
      expect(BROKER_BASE_URL).toBe("http://octogee-api:3001");
    }
    if (!process.env.OCTOGEE_API_SA_TOKEN_PATH) {
      expect(KSA_TOKEN_PATH).toBe("/var/run/secrets/octogee-gateway-broker/token");
    }
  });
});
