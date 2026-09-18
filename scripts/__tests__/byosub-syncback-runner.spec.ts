import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DatabaseSync } from "node:sqlite";

const tmp: string[] = [];
const originalEnv = { ...process.env };

function mkHome(config: unknown): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "byosub-syncback-home-"));
  tmp.push(home);
  const openclaw = path.join(home, ".openclaw");
  fs.mkdirSync(openclaw, { recursive: true });
  fs.writeFileSync(path.join(openclaw, "openclaw.json"), JSON.stringify(config));
  return home;
}

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  process.env = { ...originalEnv };
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("byosub-syncback-runner loadTargets", () => {
  it("does not attempt Firestore discovery on shared gateways", async () => {
    process.env.HOME = mkHome({
      agents: {
        list: [{ id: "octogee-tester19-coach" }],
      },
    });
    process.env.GATEWAY_ID = "default-green";
    process.env.GATEWAY_CLASS = "shared";

    const firebaseImport = vi.fn();
    vi.doMock("../lib/firebase.js", () => {
      firebaseImport();
      throw new Error("shared gateways must not import firebase");
    });

    const { loadTargets } = await import("../entrypoints/byosub-syncback-runner.js");

    await expect(loadTargets()).resolves.toEqual([]);
    expect(firebaseImport).not.toHaveBeenCalled();
  });
});

const COACH = "octogee-tester19-coach";
const PROJECT_AGENT = "octogee-tester19-proj-garden-coach";

const jwt = (claims: Record<string, unknown>) =>
  "e30." + Buffer.from(JSON.stringify(claims)).toString("base64url") + ".sig";

function codexStore(refresh: string, iat: number): unknown {
  return {
    version: 1,
    profiles: {
      "openai-codex:default": {
        type: "oauth",
        provider: "openai",
        access: jwt({ iat, exp: iat + 864_000 }),
        refresh,
        expires: (iat + 864_000) * 1000,
      },
    },
  };
}

function writeSharedStore(home: string, store: unknown): void {
  const dir = path.join(home, ".openclaw", "state");
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "openclaw.sqlite"));
  db.exec(
    "CREATE TABLE IF NOT EXISTS config_machine_state (state_key TEXT NOT NULL PRIMARY KEY, value_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL) STRICT",
  );
  const upsert = db.prepare(
    "INSERT INTO config_machine_state VALUES (?, ?, 1) ON CONFLICT(state_key) DO UPDATE SET value_json = excluded.value_json",
  );
  upsert.run("auth.sharedStore", JSON.stringify({ location: "state-db" }));
  upsert.run("authProfiles.store", JSON.stringify(store));
  db.close();
}

function writeAgentStore(home: string, agentId: string, store: unknown): void {
  const dir = path.join(home, ".openclaw", "agents", agentId, "agent");
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "openclaw-agent.sqlite"));
  db.exec(
    "CREATE TABLE auth_profile_store (store_key TEXT NOT NULL PRIMARY KEY, store_json TEXT NOT NULL, updated_at INTEGER NOT NULL)",
  );
  db.prepare("INSERT INTO auth_profile_store VALUES ('primary', ?, 1)").run(JSON.stringify(store));
  db.close();
}

function writeStaleCodexHomeAuth(home: string, agentId: string): void {
  const authPath = path.join(home, ".openclaw", "agents", agentId, "agent", "codex-home", "auth.json");
  fs.mkdirSync(path.dirname(authPath), { recursive: true });
  fs.writeFileSync(authPath, JSON.stringify({ tokens: { access_token: "stale", refresh_token: "r0" } }));
}

function builderHome(): string {
  const home = mkHome({
    agents: { entries: { [COACH]: {}, [PROJECT_AGENT]: {}, "../../not-an-agent": {} } },
  });
  process.env.HOME = home;
  process.env.GATEWAY_ID = "tester19-m-abc";
  process.env.GATEWAY_CLASS = "builder";
  return home;
}

async function loadRunner() {
  const push = vi.fn(async () => ({ changed: true, destroyed: 0 }));
  vi.doMock("../lib/byot-sync-runtime.js", () => ({ brokerPushByosubCred: push }));
  const { sweepOnce } = await import("../entrypoints/byosub-syncback-runner.js");
  return { push, sweepOnce };
}

function pushedTokens(push: ReturnType<typeof vi.fn>): Array<{ agentId: string; refresh: string; lastRefresh: string }> {
  return push.mock.calls.map(([agentId, provider, payload]) => {
    expect(provider).toBe("openai");
    const parsed = JSON.parse(payload as string);
    return { agentId: agentId as string, refresh: parsed.tokens.refresh_token, lastRefresh: parsed.last_refresh };
  });
}

describe("byosub-syncback-runner sweepOnce", () => {
  it("pushes the rotated credential from OpenClaw's shared auth store under the coach, ignoring codex-home auth.json", async () => {
    const home = builderHome();
    writeStaleCodexHomeAuth(home, COACH);
    writeSharedStore(home, codexStore("r1", 1_789_736_218));
    const { push, sweepOnce } = await loadRunner();

    const first = await sweepOnce(new Map());
    expect(pushedTokens(push)).toEqual([
      { agentId: COACH, refresh: "r1", lastRefresh: "2026-09-18T12:56:58.000Z" },
    ]);

    push.mockClear();
    const second = await sweepOnce(first.prev);
    expect(push).not.toHaveBeenCalled();

    writeSharedStore(home, codexStore("r2", 1_789_740_000));
    await sweepOnce(second.prev);
    expect(pushedTokens(push)).toEqual([
      { agentId: COACH, refresh: "r2", lastRefresh: "2026-09-18T14:00:00.000Z" },
    ]);
  });

  it("reads each agent's own auth store when OpenClaw has no shared store", async () => {
    const home = builderHome();
    writeStaleCodexHomeAuth(home, COACH);
    writeAgentStore(home, COACH, codexStore("r1", 1_789_736_218));
    const { push, sweepOnce } = await loadRunner();

    await sweepOnce(new Map());

    expect(pushedTokens(push)).toEqual([
      { agentId: COACH, refresh: "r1", lastRefresh: "2026-09-18T12:56:58.000Z" },
    ]);
  });

  it("pushes nothing while the auth store holds no ChatGPT credential", async () => {
    const home = builderHome();
    writeStaleCodexHomeAuth(home, COACH);
    writeSharedStore(home, { version: 1, profiles: {} });
    const { push, sweepOnce } = await loadRunner();

    await sweepOnce(new Map());

    expect(push).not.toHaveBeenCalled();
  });
});
