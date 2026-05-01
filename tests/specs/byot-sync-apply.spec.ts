/**
 * Filesystem-side tests for byot-sync.applyByotState.
 *
 * Critical behaviors:
 *   - REFUSES to write when the agent dir doesn't exist (no auto-mkdir)
 *     — this protects against silently materializing orphan agent
 *     directories when BYOT flips on for an unprovisioned customer.
 *   - Writes auth-profiles.json with mode 0o600.
 *   - Idempotent: returns false when the on-disk content already matches.
 *   - Removes the file (and reports change) when disabled.
 *   - Atomic write — never leaves a half-written file behind.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

let TMP_ROOT: string;

beforeEach(async () => {
  TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "byot-sync-test-"));
  process.env.OPENCLAW_AGENTS_DIR = path.join(TMP_ROOT, "agents");
  // Force re-import so the module picks up the new env var.
  vi.resetModules();
});

afterEach(() => {
  delete process.env.OPENCLAW_AGENTS_DIR;
  if (TMP_ROOT && fs.existsSync(TMP_ROOT)) {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  }
});

async function loadModule() {
  return await import("../../scripts/lib/byot-sync");
}

function agentDirFor(slug: string): string {
  return path.join(TMP_ROOT, "agents", `octogee-${slug}-coach`, "agent");
}

function profilePath(slug: string): string {
  return path.join(agentDirFor(slug), "auth-profiles.json");
}

describe("applyByotState — agent-dir guard", () => {
  test("refuses to write when the agent dir does not exist (no orphan dirs)", async () => {
    const { applyByotState } = await loadModule();
    const slug = "no-agent-yet";
    const changed = applyByotState(slug, { slug, provider: "anthropic" });
    expect(changed).toBe(false);
    expect(fs.existsSync(agentDirFor(slug))).toBe(false);
    expect(fs.existsSync(profilePath(slug))).toBe(false);
  });

  test("disable on a slug with no agent dir is a quiet no-op (no false 'changed')", async () => {
    const { applyByotState } = await loadModule();
    expect(applyByotState("no-agent-yet", null)).toBe(false);
  });
});

describe("applyByotState — enabled write path", () => {
  test("writes auth-profiles.json with mode 0o600 when agent dir exists", async () => {
    const { applyByotState } = await loadModule();
    const slug = "smile-wring-011b";
    fs.mkdirSync(agentDirFor(slug), { recursive: true });

    const changed = applyByotState(slug, { slug, provider: "anthropic" });
    expect(changed).toBe(true);

    const target = profilePath(slug);
    expect(fs.existsSync(target)).toBe(true);

    const stat = fs.statSync(target);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  test("idempotent — second call returns false when content already matches", async () => {
    const { applyByotState } = await loadModule();
    const slug = "smile-wring-011b";
    fs.mkdirSync(agentDirFor(slug), { recursive: true });

    expect(applyByotState(slug, { slug, provider: "anthropic" })).toBe(true);
    expect(applyByotState(slug, { slug, provider: "anthropic" })).toBe(false);
  });

  test("written content is JSON with the expected SecretRef shape", async () => {
    const { applyByotState } = await loadModule();
    const slug = "smile-wring-011b";
    fs.mkdirSync(agentDirFor(slug), { recursive: true });

    applyByotState(slug, { slug, provider: "anthropic" });

    const written = JSON.parse(fs.readFileSync(profilePath(slug), "utf8"));
    expect(written.profiles["anthropic:default"].type).toBe("api_key");
    // Top-level provider is REQUIRED — OpenClaw's
    // coercePersistedAuthProfileStore drops entries without it.
    expect(written.profiles["anthropic:default"].provider).toBe("anthropic");
    expect(written.profiles["anthropic:default"].keyRef).toEqual({
      source: "exec",
      provider: "gcp-secret-manager",
      id: `byok-${slug}-anthropic/latest`,
    });
  });

  test("never embeds plaintext key (defense-in-depth — only SecretRef)", async () => {
    const { applyByotState } = await loadModule();
    const slug = "smile-wring-011b";
    fs.mkdirSync(agentDirFor(slug), { recursive: true });

    applyByotState(slug, { slug, provider: "anthropic" });
    const raw = fs.readFileSync(profilePath(slug), "utf8");
    expect(raw).not.toContain("sk-ant-");
    expect(raw).not.toMatch(/"key"\s*:/); // sibling plaintext field MUST NOT appear
  });

  test("no .tmp file lingers after successful write (atomic rename)", async () => {
    const { applyByotState } = await loadModule();
    const slug = "smile-wring-011b";
    fs.mkdirSync(agentDirFor(slug), { recursive: true });

    applyByotState(slug, { slug, provider: "anthropic" });
    const tmp = `${profilePath(slug)}.tmp`;
    expect(fs.existsSync(tmp)).toBe(false);
  });
});

describe("applyByotState — provider switch reconciliation (Phase 2)", () => {
  test("anthropic → openai-compatible removes auth-profiles.json AND writes models.json", async () => {
    const { applyByotState } = await loadModule();
    const slug = "smile-wring-011b";
    fs.mkdirSync(agentDirFor(slug), { recursive: true });

    // Start: anthropic BYOT.
    applyByotState(slug, { slug, provider: "anthropic" });
    const authPath = profilePath(slug);
    const modelsPath = path.join(agentDirFor(slug), "models.json");
    expect(fs.existsSync(authPath)).toBe(true);
    expect(fs.existsSync(modelsPath)).toBe(false);

    // Switch: openai-compatible.
    const changed = applyByotState(slug, {
      slug,
      provider: "openai-compatible",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "anthropic/claude-3.5-sonnet",
    });
    expect(changed).toBe(true);

    // auth-profiles.json must be GONE; models.json must exist.
    expect(fs.existsSync(authPath)).toBe(false);
    expect(fs.existsSync(modelsPath)).toBe(true);

    // models.json content has the expected shape (api adapter + keyRef + models[]).
    const mj = JSON.parse(fs.readFileSync(modelsPath, "utf8"));
    expect(mj.providers[`custom-${slug}`].api).toBe("openai-completions");
    expect(mj.providers[`custom-${slug}`].apiKey.source).toBe("exec");
    expect(mj.providers[`custom-${slug}`].models).toEqual([
      { id: "anthropic/claude-3.5-sonnet", name: "anthropic/claude-3.5-sonnet" },
    ]);
  });

  test("openai-compatible → anthropic removes models.json AND writes auth-profiles.json", async () => {
    const { applyByotState } = await loadModule();
    const slug = "smile-wring-011b";
    fs.mkdirSync(agentDirFor(slug), { recursive: true });

    applyByotState(slug, { slug, provider: "openai-compatible", baseUrl: "https://x/v1", model: "a/b" });
    const modelsPath = path.join(agentDirFor(slug), "models.json");
    expect(fs.existsSync(modelsPath)).toBe(true);

    applyByotState(slug, { slug, provider: "anthropic" });
    expect(fs.existsSync(modelsPath)).toBe(false);
    expect(fs.existsSync(profilePath(slug))).toBe(true);
  });

  test("openai → openai-compatible removes auth-profiles.json AND writes models.json", async () => {
    const { applyByotState } = await loadModule();
    const slug = "smile-wring-011b";
    fs.mkdirSync(agentDirFor(slug), { recursive: true });

    applyByotState(slug, { slug, provider: "openai", model: "openai/gpt-4o" });
    expect(fs.existsSync(profilePath(slug))).toBe(true);

    applyByotState(slug, { slug, provider: "openai-compatible", baseUrl: "https://x/v1", model: "a/b" });
    expect(fs.existsSync(profilePath(slug))).toBe(false);
    expect(fs.existsSync(path.join(agentDirFor(slug), "models.json"))).toBe(true);
  });

  test("disable from any provider removes BOTH BYOT files", async () => {
    const { applyByotState } = await loadModule();
    const slug = "smile-wring-011b";
    fs.mkdirSync(agentDirFor(slug), { recursive: true });

    applyByotState(slug, { slug, provider: "openai-compatible", baseUrl: "https://x/v1", model: "a/b" });
    expect(fs.existsSync(path.join(agentDirFor(slug), "models.json"))).toBe(true);

    applyByotState(slug, null);
    expect(fs.existsSync(profilePath(slug))).toBe(false);
    expect(fs.existsSync(path.join(agentDirFor(slug), "models.json"))).toBe(false);
  });
});

describe("applyByotState — disabled remove path", () => {
  test("removes auth-profiles.json when disabled and file existed", async () => {
    const { applyByotState } = await loadModule();
    const slug = "smile-wring-011b";
    fs.mkdirSync(agentDirFor(slug), { recursive: true });
    applyByotState(slug, { slug, provider: "anthropic" });
    expect(fs.existsSync(profilePath(slug))).toBe(true);

    expect(applyByotState(slug, null)).toBe(true);
    expect(fs.existsSync(profilePath(slug))).toBe(false);
  });

  test("disable when no file present is a no-op (returns false)", async () => {
    const { applyByotState } = await loadModule();
    const slug = "smile-wring-011b";
    fs.mkdirSync(agentDirFor(slug), { recursive: true });
    expect(applyByotState(slug, null)).toBe(false);
  });
});

describe("applyByotState — `.byot-managed` marker (auth-profiles.json collision guard)", () => {
  // OpenClaw's own per-agent auth caching layer also writes
  // auth-profiles.json into the same agent dir. Without the marker,
  // applyByotState(slug, null) would happily delete OpenClaw's cache on
  // every Firestore tick — the watcher fires on every usage update,
  // every agent turn writes a usage update, so OpenClaw's cache got
  // wiped each turn → re-resolution + secrets.reload + channel restart →
  // first-message slowness. The marker is the proof-of-prior-BYOT-write
  // that tells us a file under one of the BYOT_FILES names was actually
  // created by us and is therefore safe to delete.

  function markerPath(slug: string): string {
    return path.join(agentDirFor(slug), ".byot-managed");
  }

  test("disable WITHOUT a marker leaves a pre-existing auth-profiles.json untouched", async () => {
    const { applyByotState } = await loadModule();
    const slug = "smile-wring-011b";
    const dir = agentDirFor(slug);
    fs.mkdirSync(dir, { recursive: true });

    // Simulate OpenClaw having written its own auth-profiles.json — same
    // path we'd target, but no marker so applyByotState must leave it.
    const openclawCacheBody = '{"profiles":{"sample":{"type":"oauth"}}}';
    fs.writeFileSync(profilePath(slug), openclawCacheBody);
    expect(fs.existsSync(markerPath(slug))).toBe(false);

    expect(applyByotState(slug, null)).toBe(false);
    expect(fs.existsSync(profilePath(slug))).toBe(true);
    expect(fs.readFileSync(profilePath(slug), "utf8")).toBe(openclawCacheBody);
  });

  test("BYOT-on writes the marker file alongside auth-profiles.json", async () => {
    const { applyByotState } = await loadModule();
    const slug = "smile-wring-011b";
    fs.mkdirSync(agentDirFor(slug), { recursive: true });

    expect(applyByotState(slug, { slug, provider: "anthropic" })).toBe(true);
    expect(fs.existsSync(markerPath(slug))).toBe(true);

    const markerContent = JSON.parse(fs.readFileSync(markerPath(slug), "utf8"));
    expect(typeof markerContent.managedSince).toBe("string");
  });

  test("BYOT-on idempotent: second call does NOT rewrite the marker", async () => {
    const { applyByotState } = await loadModule();
    const slug = "smile-wring-011b";
    fs.mkdirSync(agentDirFor(slug), { recursive: true });

    applyByotState(slug, { slug, provider: "anthropic" });
    const firstMarker = fs.readFileSync(markerPath(slug), "utf8");

    // Sleep so any ISO timestamp regeneration would visibly differ.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(applyByotState(slug, { slug, provider: "anthropic" })).toBe(false);
    const secondMarker = fs.readFileSync(markerPath(slug), "utf8");
    expect(secondMarker).toBe(firstMarker);
  });

  test("disable WITH the marker present removes both BYOT_FILES AND the marker", async () => {
    const { applyByotState } = await loadModule();
    const slug = "smile-wring-011b";
    fs.mkdirSync(agentDirFor(slug), { recursive: true });

    applyByotState(slug, { slug, provider: "anthropic" });
    expect(fs.existsSync(profilePath(slug))).toBe(true);
    expect(fs.existsSync(markerPath(slug))).toBe(true);

    expect(applyByotState(slug, null)).toBe(true);
    expect(fs.existsSync(profilePath(slug))).toBe(false);
    expect(fs.existsSync(markerPath(slug))).toBe(false);
  });

  test("re-enable after disable rewrites both auth-profiles.json AND the marker", async () => {
    const { applyByotState } = await loadModule();
    const slug = "smile-wring-011b";
    fs.mkdirSync(agentDirFor(slug), { recursive: true });

    applyByotState(slug, { slug, provider: "anthropic" });
    applyByotState(slug, null);
    expect(fs.existsSync(profilePath(slug))).toBe(false);
    expect(fs.existsSync(markerPath(slug))).toBe(false);

    expect(applyByotState(slug, { slug, provider: "anthropic" })).toBe(true);
    expect(fs.existsSync(profilePath(slug))).toBe(true);
    expect(fs.existsSync(markerPath(slug))).toBe(true);
  });

  test("BYOT-on writes marker even when content already matches (pre-marker rollouts)", async () => {
    // Pre-marker code paths (or any prior rollout that wrote
    // BYOT_FILES without writing the marker) must self-heal: the
    // first applyByotState call after this code ships should backfill
    // the marker even though no file content changes. Otherwise the
    // BYOT-off path stays a permanent no-op for those users and we
    // can never clean up their stale BYOT files.
    const { applyByotState } = await loadModule();
    const slug = "smile-wring-011b";
    fs.mkdirSync(agentDirFor(slug), { recursive: true });

    // Bootstrap files via the current code, then forcibly remove the
    // marker to simulate a pre-marker rollout state on disk.
    applyByotState(slug, { slug, provider: "anthropic" });
    fs.unlinkSync(markerPath(slug));
    expect(fs.existsSync(profilePath(slug))).toBe(true);
    expect(fs.existsSync(markerPath(slug))).toBe(false);

    // Re-apply the same input. File content already matches → no file
    // changes → `changed === false`. But the marker MUST be written
    // anyway so disable can find it on next BYOT-off.
    const changed = applyByotState(slug, { slug, provider: "anthropic" });
    expect(changed).toBe(false);
    expect(fs.existsSync(markerPath(slug))).toBe(true);

    // And now disable cleans up correctly.
    expect(applyByotState(slug, null)).toBe(true);
    expect(fs.existsSync(profilePath(slug))).toBe(false);
    expect(fs.existsSync(markerPath(slug))).toBe(false);
  });
});
