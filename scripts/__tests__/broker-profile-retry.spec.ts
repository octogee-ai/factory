import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DatabaseSync } from "node:sqlite";

import {
  _resetBrokerProfileLogStateForTests,
  materializeDeferredBrokerProfiles,
} from "../lib/fleet-provisioner.js";

/** The store openclaw creates at startup, reduced to the ownership stamp our
 *  auth-profile reads require — a bare file would pass a test against state
 *  the gateway rejects. */
function seedAgentStore(agentsDir: string, agentId: string): void {
  const dir = path.join(agentsDir, agentId, "agent");
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "openclaw-agent.sqlite"));
  try {
    db.exec(
      `CREATE TABLE IF NOT EXISTS auth_profile_store (store_key TEXT NOT NULL PRIMARY KEY, store_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
       CREATE TABLE IF NOT EXISTS schema_meta (meta_key TEXT NOT NULL PRIMARY KEY, role TEXT NOT NULL, schema_version INTEGER NOT NULL, agent_id TEXT, app_version TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
       PRAGMA user_version = 16;`,
    );
    db.prepare(
      `INSERT INTO schema_meta (meta_key, role, schema_version, agent_id, created_at, updated_at)
       VALUES ('primary', 'agent', 16, ?, 0, 0) ON CONFLICT(meta_key) DO NOTHING`,
    ).run(agentId);
  } finally {
    db.close();
  }
}

/** Mirrors what `openclaw secrets apply` persists, so the next sweep's
 *  idempotency read settles. */
function writeAppliedProfiles(agentsDir: string, planPath: string): void {
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8")) as {
    targets: Array<{ path: string; agentId: string; authProfileProvider: string; ref: unknown }>;
  };
  for (const target of plan.targets) {
    const dir = path.join(agentsDir, target.agentId, "agent");
    const db = new DatabaseSync(path.join(dir, "openclaw-agent.sqlite"));
    try {
      const row = db
        .prepare("SELECT store_json AS v FROM auth_profile_store WHERE store_key = 'primary'")
        .get() as { v?: string } | undefined;
      const store = (row?.v ? JSON.parse(row.v) : {}) as { profiles?: Record<string, unknown> };
      const profiles = store.profiles ?? {};
      profiles[target.path.replace(/^profiles\./, "").replace(/\.key$/, "")] = {
        type: "api_key",
        provider: target.authProfileProvider,
        keyRef: target.ref,
        key: "resolved",
      };
      db.prepare(
        `INSERT INTO auth_profile_store (store_key, store_json, updated_at) VALUES ('primary', ?, 0)
         ON CONFLICT(store_key) DO UPDATE SET store_json = excluded.store_json`,
      ).run(JSON.stringify({ ...store, profiles }));
    } finally {
      db.close();
    }
  }
}

/**
 * Only openclaw writes an agent's auth-profile store, and its `secrets apply`
 * can refuse at any moment a one-shot materialization happens to run — leaving
 * the catalog written but the broker profile absent, so the agent's first turn
 * fails on credentials. This sweep is therefore retried on a timer until every
 * rostered coach has its profile, and must stay quiet once it has nothing left
 * to do.
 */
describe("broker profile retry (level-triggered)", () => {
  const AGENT = "octogee-alice-coach";
  let agentsDir: string;
  let logs: string[];
  let applyOutcome: "refuse" | "accept";
  let run: ReturnType<typeof vi.fn>;
  const readConfig = () => ({ agents: { entries: { [AGENT]: { model: "house" } } } });
  const sweep = () =>
    materializeDeferredBrokerProfiles((m) => logs.push(m), {
      agentsDir,
      readConfig,
      secretsApply: { run },
    });

  beforeEach(() => {
    agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-bpr-"));
    logs = [];
    applyOutcome = "refuse";
    run = vi.fn((_command: string, args: string[]) => {
      const planPath = args[args.indexOf("--from") + 1]!;
      if (applyOutcome === "refuse") {
        return { status: 3, stdout: "", stderr: "gateway is not accepting secrets yet" };
      }
      writeAppliedProfiles(agentsDir, planPath);
      return { status: 0, stdout: "", stderr: "" };
    });
    _resetBrokerProfileLogStateForTests();
  });
  afterEach(() => {
    fs.rmSync(agentsDir, { recursive: true, force: true });
  });

  it("applies the profiles through openclaw's CLI rather than writing the store", () => {
    seedAgentStore(agentsDir, AGENT);
    applyOutcome = "accept";

    sweep();

    expect(run).toHaveBeenCalledWith(
      expect.any(String),
      ["secrets", "apply", "--from", expect.any(String), "--allow-exec"],
      expect.objectContaining({ env: expect.any(Object) }),
    );
  });

  it("reports a deferral while openclaw refuses the apply", () => {
    sweep();

    expect(logs.some((m) => m.includes("still deferred") && m.includes(AGENT))).toBe(true);
  });

  it("stays quiet while the deferral is unchanged — it runs on a timer", () => {
    sweep();
    const afterFirst = logs.length;

    sweep();
    sweep();

    expect(logs.length).toBe(afterFirst);
  });

  it("settles on a later pass once openclaw accepts the apply", () => {
    sweep();
    seedAgentStore(agentsDir, AGENT);
    applyOutcome = "accept";
    logs = [];

    sweep();

    expect(logs.some((m) => m.includes("settled"))).toBe(true);
    expect(logs.some((m) => m.includes("still deferred"))).toBe(false);
  });

  it("stops spawning the CLI once every profile has settled", () => {
    seedAgentStore(agentsDir, AGENT);
    applyOutcome = "accept";
    sweep();
    const afterFirst = run.mock.calls.length;

    sweep();

    expect(run.mock.calls.length).toBe(afterFirst);
  });

  it("survives an unreadable config rather than killing the timer", () => {
    materializeDeferredBrokerProfiles((m) => logs.push(m), {
      agentsDir,
      secretsApply: { run },
      readConfig: () => {
        throw new Error("config gone");
      },
    });

    expect(logs.some((m) => m.includes("config unreadable"))).toBe(true);
  });
});
