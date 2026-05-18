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
      fetchSecret: async () => '{"auth_mode":"chatgpt","tokens":{"refresh_token":"rt"}}',
    });
    expect(r).toEqual({ restored: 1, failed: 0 });
    expect(fs.existsSync(item.targetPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(item.targetPath, "utf-8")).auth_mode).toBe("chatgpt");
    expect(fs.statSync(item.targetPath).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(item.targetPath + ".tmp")).toBe(false);
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
        return "{}";
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
      fetchSecret: async () => '{"auth_mode":"chatgpt"}',
    });
    expect(r).toEqual({ restored: 1, failed: 0, planned: 1 });
    expect(
      JSON.parse(fs.readFileSync(codexAuthJsonPath(oc, "octogee-tester-70-coach"), "utf-8"))
        .auth_mode,
    ).toBe("chatgpt");
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
