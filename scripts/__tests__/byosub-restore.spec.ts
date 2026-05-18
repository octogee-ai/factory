import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  planByosubRestores,
  restoreByosubCredentials,
  restoreByosubForAgents,
  agentIdsFromConfig,
  codexHomeDir,
  codexAuthJsonPath,
  codexStagingHomeDir,
  codexStagingAuthJsonPath,
  isSafeAgentId,
} from "../lib/byosub-restore.js";

const tmpDirs: string[] = [];
function mkTmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "byosub-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const OC = "/home/node/.openclaw";
const codexAuth = (agentId: string) =>
  `${OC}/agents/${agentId}/agent/codex-home/auth.json`;

// A *valid* codex CLI auth.json (the byosub-captured ChatGPT-sub blob).
// Restore now validate-before-writes: an openai item whose secret can't be
// mapped to an OAuthCredential fails the item (never half-writes), so every
// success-path fixture must carry a real `tokens.access_token`.
const jwt = (claims: Record<string, unknown>) =>
  "e30." + Buffer.from(JSON.stringify(claims)).toString("base64url") + ".s";
const codexBlob = () =>
  JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: jwt({
        email: "u@example.com",
        "https://api.openai.com/auth": { chatgpt_plan_type: "plus" },
      }),
      access_token: "acc-1",
      refresh_token: "ref-1",
      account_id: "acct-1",
    },
    last_refresh: "2026-05-18T00:11:06Z",
  });
// The per-agent auth-profiles.json byosub-restore now embeds (Plane-1 OAuth)
// — a sibling of codex-home, the SOLE openclaw-read codex credential store.
const apPathFor = (oc: string, agentId: string) =>
  path.join(oc, "agents", agentId, "agent", "auth-profiles.json");

describe("isSafeAgentId (shared path-safety boundary)", () => {
  it("accepts real coach agent ids", () => {
    expect(isSafeAgentId("octogee-smile-wring-011b-coach")).toBe(true);
    expect(isSafeAgentId("octogee-a-coach")).toBe(true);
  });
  it("rejects traversal / unsafe / oversized / non-string ids", () => {
    expect(isSafeAgentId("../../etc/passwd")).toBe(false);
    expect(isSafeAgentId("octogee/../x")).toBe(false);
    expect(isSafeAgentId("Octogee-A-Coach")).toBe(false);
    expect(isSafeAgentId("")).toBe(false);
    expect(isSafeAgentId("a".repeat(65))).toBe(false);
    expect(isSafeAgentId(undefined as unknown as string)).toBe(false);
    expect(isSafeAgentId(123 as unknown as string)).toBe(false);
  });
});

describe("codexHomeDir / codexAuthJsonPath (shared codex-home path atom)", () => {
  it("composes the per-agent codex-home — the C1a/A/B invariant path", () => {
    expect(codexHomeDir(OC, "octogee-ceckert-coach")).toBe(
      "/home/node/.openclaw/agents/octogee-ceckert-coach/agent/codex-home",
    );
  });

  it("auth.json sits directly in the codex-home dir", () => {
    expect(codexAuthJsonPath(OC, "octogee-a-coach")).toBe(
      codexAuth("octogee-a-coach"),
    );
  });

  it("staging codex-home is a sibling of the live one — never the same path", () => {
    const live = codexHomeDir(OC, "octogee-a-coach");
    const staging = codexStagingHomeDir(OC, "octogee-a-coach");
    expect(staging).not.toBe(live);
    expect(staging.startsWith(`${OC}/agents/octogee-a-coach/agent/`)).toBe(true);
    expect(codexStagingAuthJsonPath(OC, "octogee-a-coach")).toBe(
      `${staging}/auth.json`,
    );
  });

  it("is exactly the path planByosubRestores writes to (no drift between writer + restorer)", () => {
    const [item] = planByosubRestores({
      agentIds: ["octogee-a-coach"],
      byosub: { "octogee-a-coach": { provider: "openai", secretName: "s" } },
      openclawDir: OC,
    });
    expect(item.targetPath).toBe(codexAuthJsonPath(OC, "octogee-a-coach"));
  });
});

describe("planByosubRestores", () => {
  it("returns [] for undefined/empty byosub", () => {
    expect(
      planByosubRestores({ agentIds: ["octogee-a-coach"], byosub: undefined, openclawDir: OC }),
    ).toEqual([]);
    expect(
      planByosubRestores({ agentIds: ["octogee-a-coach"], byosub: {}, openclawDir: OC }),
    ).toEqual([]);
  });

  it("plans an openai restore into the per-agent codex-home (not ~/.codex)", () => {
    const plan = planByosubRestores({
      agentIds: ["octogee-ceckert-coach", "octogee-ops-gw-bender"],
      byosub: {
        "octogee-ceckert-coach": { provider: "openai", secretName: "byosub-uid1-openai" },
      },
      openclawDir: OC,
    });
    expect(plan).toEqual([
      {
        agentId: "octogee-ceckert-coach",
        provider: "openai",
        secretName: "byosub-uid1-openai",
        targetPath: codexAuth("octogee-ceckert-coach"),
      },
    ]);
  });

  it("plans independently for many customers on one shared gateway", () => {
    const plan = planByosubRestores({
      agentIds: ["octogee-a-coach", "octogee-b-coach", "octogee-ops-x"],
      byosub: {
        "octogee-a-coach": { provider: "openai", secretName: "byosub-a-openai" },
        "octogee-b-coach": { provider: "openai", secretName: "byosub-b-openai" },
      },
      openclawDir: OC,
    });
    expect(plan.map((p) => p.agentId).sort()).toEqual([
      "octogee-a-coach",
      "octogee-b-coach",
    ]);
    expect(plan.find((p) => p.agentId === "octogee-b-coach")!.targetPath).toBe(
      codexAuth("octogee-b-coach"),
    );
  });

  it("skips + logs a ref whose agent is not present on this gateway", () => {
    const logs: string[] = [];
    const plan = planByosubRestores({
      agentIds: ["octogee-a-coach"],
      byosub: { "octogee-ghost-coach": { provider: "openai", secretName: "s" } },
      openclawDir: OC,
      logFn: (m) => logs.push(m),
    });
    expect(plan).toEqual([]);
    expect(logs.join("\n")).toMatch(/octogee-ghost-coach.*not present|not on this gateway/i);
  });

  it("defers anthropic (Chunk E) — skips + logs, does not plan", () => {
    const logs: string[] = [];
    const plan = planByosubRestores({
      agentIds: ["octogee-a-coach"],
      byosub: { "octogee-a-coach": { provider: "anthropic", secretName: "byosub-a-anthropic" } },
      openclawDir: OC,
      logFn: (m) => logs.push(m),
    });
    expect(plan).toEqual([]);
    expect(logs.join("\n")).toMatch(/anthropic/i);
  });

  it("skips + logs an unknown provider", () => {
    const logs: string[] = [];
    const plan = planByosubRestores({
      agentIds: ["octogee-a-coach"],
      byosub: { "octogee-a-coach": { provider: "grok" as never, secretName: "s" } },
      openclawDir: OC,
      logFn: (m) => logs.push(m),
    });
    expect(plan).toEqual([]);
    expect(logs.join("\n")).toMatch(/unknown provider|grok/i);
  });

  it("rejects path-traversal / unsafe agent ids (Firestore-sourced keys)", () => {
    const logs: string[] = [];
    const longId = "x".repeat(200);
    // Build byosub the way Firestore .data() delivers it — JSON-shaped, so
    // `__proto__` is an OWN key (an object literal would set the prototype).
    const byosub = JSON.parse(
      `{"../../etc":{"provider":"openai","secretName":"s1"},` +
        `"a/b":{"provider":"openai","secretName":"s2"},` +
        `"foo bar":{"provider":"openai","secretName":"s3"},` +
        `"Up$er":{"provider":"openai","secretName":"s4"},` +
        `"${longId}":{"provider":"openai","secretName":"s5"},` +
        `"__proto__":{"provider":"openai","secretName":"s6"}}`,
    );
    const plan = planByosubRestores({
      agentIds: ["../../etc", "a/b", "foo bar", "Up$er", longId, "__proto__"],
      byosub,
      openclawDir: OC,
      logFn: (m) => logs.push(m),
    });
    // every key is unsafe: traversal chars / space / $ / uppercase / >64 / underscore
    expect(plan).toEqual([]);
    expect(logs.join("\n")).toMatch(/unsafe|invalid agent id/i);
    // and the `__proto__` own key didn't pollute Object.prototype
    expect(({} as Record<string, unknown>).secretName).toBeUndefined();
  });
});

describe("restoreByosubCredentials", () => {
  it("atomically writes auth.json (0600) into the agent codex-home, creating dirs", async () => {
    const oc = mkTmp();
    const item = {
      agentId: "octogee-a-coach",
      provider: "openai" as const,
      secretName: "byosub-a-openai",
      targetPath: path.join(oc, "agents", "octogee-a-coach", "agent", "codex-home", "auth.json"),
    };
    const r = await restoreByosubCredentials({
      plan: [item],
      fetchSecret: async () => codexBlob(),
    });
    expect(r).toEqual({ restored: 1, failed: 0 });
    expect(fs.existsSync(item.targetPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(item.targetPath, "utf-8")).auth_mode).toBe("chatgpt");
    expect(fs.statSync(item.targetPath).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(item.targetPath + ".tmp")).toBe(false);

    // Plane-1: the codex credential openclaw actually reads is the embedded
    // <agentDir>/auth-profiles.json (envelope v1, openai-codex:default oauth),
    // written atomically (0600, no leftover .tmp) as a sibling of codex-home.
    const ap = apPathFor(oc, "octogee-a-coach");
    expect(fs.existsSync(ap)).toBe(true);
    expect(fs.statSync(ap).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(ap + ".tmp")).toBe(false);
    const store = JSON.parse(fs.readFileSync(ap, "utf-8"));
    expect(store.version).toBe(1);
    expect(store.profiles["openai-codex:default"]).toMatchObject({
      type: "oauth",
      provider: "openai-codex",
      access: "acc-1",
      refresh: "ref-1",
      expires: 0,
      accountId: "acct-1",
      chatgptPlanType: "plus",
      email: "u@example.com",
      copyToAgents: true,
    });
  });

  it("validate-before-write: an unmappable blob fails the item — no codex-home, no auth-profiles (never half-flip routing)", async () => {
    const oc = mkTmp();
    const item = {
      agentId: "octogee-a-coach",
      provider: "openai" as const,
      secretName: "byosub-a-openai",
      targetPath: path.join(oc, "agents", "octogee-a-coach", "agent", "codex-home", "auth.json"),
    };
    const logs: string[] = [];
    const r = await restoreByosubCredentials({
      plan: [item],
      // tokens present but no access_token → buildCodexAuthProfilesStore throws
      fetchSecret: async () => '{"auth_mode":"chatgpt","tokens":{"refresh_token":"rt"}}',
      logFn: (m) => logs.push(m),
    });
    expect(r).toEqual({ restored: 0, failed: 1 });
    expect(fs.existsSync(item.targetPath)).toBe(false);
    expect(fs.existsSync(item.targetPath + ".tmp")).toBe(false);
    const ap = apPathFor(oc, "octogee-a-coach");
    expect(fs.existsSync(ap)).toBe(false);
    expect(fs.existsSync(ap + ".tmp")).toBe(false);
    expect(logs.join("\n")).toMatch(/octogee-a-coach|access_token/);
  });

  it("cross-pair atomicity (Copilot #989): a staging failure on auth-profiles.json aborts BEFORE codex-home is promoted — no half-promoted pair", async () => {
    const oc = mkTmp();
    const agentId = "octogee-a-coach";
    const item = {
      agentId,
      provider: "openai" as const,
      secretName: "byosub-a-openai",
      targetPath: path.join(oc, "agents", agentId, "agent", "codex-home", "auth.json"),
    };
    // Force the auth-profiles.json staging write to fail deterministically:
    // pre-create its .tmp path as a *directory* so fs.writeFileSync(apTmp)
    // throws EISDIR. With both temps staged before either rename, this must
    // abort with codex-home/auth.json NOT promoted (pre-fix it was renamed
    // into place first → the partial pair Copilot flagged).
    const agentDir = path.join(oc, "agents", agentId, "agent");
    fs.mkdirSync(path.join(agentDir, "auth-profiles.json.tmp"), { recursive: true });
    const logs: string[] = [];
    const r = await restoreByosubCredentials({
      plan: [item],
      fetchSecret: async () => codexBlob(),
      logFn: (m) => logs.push(m),
    });
    expect(r).toEqual({ restored: 0, failed: 1 });
    // The bug: codex-home/auth.json must not exist (never promoted).
    expect(fs.existsSync(item.targetPath)).toBe(false);
    expect(fs.existsSync(item.targetPath + ".tmp")).toBe(false);
    // auth-profiles.json itself was never written (only the .tmp dir blocker).
    expect(fs.existsSync(apPathFor(oc, agentId))).toBe(false);
    expect(logs.join("\n")).toMatch(/octogee-a-coach/);
  });

  it("isolates per-item failure: one bad fetch does not abort the others; never throws", async () => {
    const oc = mkTmp();
    const mk = (a: string, s: string) => ({
      agentId: a,
      provider: "openai" as const,
      secretName: s,
      targetPath: path.join(oc, "agents", a, "agent", "codex-home", "auth.json"),
    });
    const logs: string[] = [];
    const r = await restoreByosubCredentials({
      plan: [mk("octogee-a-coach", "ok"), mk("octogee-b-coach", "boom")],
      fetchSecret: async (s) => {
        if (s === "boom") throw new Error("secret access denied");
        return codexBlob();
      },
      logFn: (m) => logs.push(m),
    });
    expect(r).toEqual({ restored: 1, failed: 1 });
    expect(fs.existsSync(mk("octogee-a-coach", "ok").targetPath)).toBe(true);
    expect(fs.existsSync(mk("octogee-b-coach", "boom").targetPath)).toBe(false);
    expect(logs.join("\n")).toMatch(/octogee-b-coach|secret access denied/);
  });
});

describe("agentIdsFromConfig", () => {
  it("returns [] when config has no agents.list", () => {
    expect(agentIdsFromConfig(undefined)).toEqual([]);
    expect(agentIdsFromConfig(null)).toEqual([]);
    expect(agentIdsFromConfig({})).toEqual([]);
    expect(agentIdsFromConfig({ agents: {} })).toEqual([]);
    expect(agentIdsFromConfig({ agents: { list: "nope" } })).toEqual([]);
  });

  it("extracts non-empty string ids only", () => {
    expect(
      agentIdsFromConfig({
        agents: {
          list: [
            { id: "octogee-ceckert-coach" },
            { id: "octogee-ops-gw-bender" },
            {},
            { id: "" },
            { id: 5 },
            null,
          ],
        },
      }),
    ).toEqual(["octogee-ceckert-coach", "octogee-ops-gw-bender"]);
  });
});

describe("restoreByosubForAgents (shared plan+restore composition)", () => {
  it("no-op when nothing to plan → {restored:0,failed:0,planned:0}, no fs", async () => {
    const oc = mkTmp();
    let fetched = false;
    const r = await restoreByosubForAgents({
      agentIds: ["octogee-a-coach"],
      byosub: undefined,
      openclawDir: oc,
      fetchSecret: async () => {
        fetched = true;
        return "x";
      },
    });
    expect(r).toEqual({ restored: 0, failed: 0, planned: 0 });
    expect(fetched).toBe(false);
  });

  it("plans + restores the per-agent codex-home for a present oauth agent", async () => {
    const oc = mkTmp();
    const r = await restoreByosubForAgents({
      agentIds: ["octogee-tester-70-coach"],
      byosub: {
        "octogee-tester-70-coach": { provider: "openai", secretName: "byosub-uid-openai" },
      },
      openclawDir: oc,
      fetchSecret: async () => codexBlob(),
    });
    expect(r).toEqual({ restored: 1, failed: 0, planned: 1 });
    expect(
      JSON.parse(fs.readFileSync(codexAuthJsonPath(oc, "octogee-tester-70-coach"), "utf-8"))
        .auth_mode,
    ).toBe("chatgpt");
    // shared composition also embeds the Plane-1 auth-profiles.json
    expect(
      JSON.parse(fs.readFileSync(apPathFor(oc, "octogee-tester-70-coach"), "utf-8")).profiles[
        "openai-codex:default"
      ].provider,
    ).toBe("openai-codex");
  });

  it("never throws on a bad secret — {failed:1, planned:1}", async () => {
    const oc = mkTmp();
    const r = await restoreByosubForAgents({
      agentIds: ["octogee-tester-70-coach"],
      byosub: {
        "octogee-tester-70-coach": { provider: "openai", secretName: "boom" },
      },
      openclawDir: oc,
      fetchSecret: async () => {
        throw new Error("secret denied");
      },
    });
    expect(r).toEqual({ restored: 0, failed: 1, planned: 1 });
  });
});
