import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DatabaseSync } from "node:sqlite";

import {
  _resetBrokerProfileLogStateForTests,
  materializeDeferredBrokerProfiles,
} from "../lib/fleet-provisioner.js";

/** The store openclaw creates at startup, reduced to the ownership stamp our
 *  auth-profile writes require — a bare file would pass a test against state
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

/**
 * Only openclaw creates an agent's auth-profile store, and for an agent mounted
 * after boot that can happen after every one-shot materialization has already
 * run — leaving the catalog written but the broker profile absent, so the
 * agent's first turn fails on credentials. This sweep is therefore retried on a
 * timer until every rostered coach has its profile, and must stay quiet once it
 * has nothing left to do.
 */
describe("broker profile retry (level-triggered)", () => {
  const AGENT = "octogee-alice-coach";
  let agentsDir: string;
  let logs: string[];
  const readConfig = () => ({ agents: { list: [{ id: AGENT }] } });
  const sweep = () =>
    materializeDeferredBrokerProfiles((m) => logs.push(m), { agentsDir, readConfig });

  beforeEach(() => {
    agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-bpr-"));
    logs = [];
    _resetBrokerProfileLogStateForTests();
  });
  afterEach(() => {
    fs.rmSync(agentsDir, { recursive: true, force: true });
  });

  const storePath = () => path.join(agentsDir, AGENT, "agent", "openclaw-agent.sqlite");

  it("reports a deferral while openclaw has not created the store", () => {
    sweep();

    expect(fs.existsSync(storePath())).toBe(false);
    expect(logs.some((m) => m.includes("still deferred") && m.includes(AGENT))).toBe(true);
  });

  it("stays quiet while the deferral is unchanged — it runs on a timer", () => {
    sweep();
    const afterFirst = logs.length;

    sweep();
    sweep();

    expect(logs.length).toBe(afterFirst);
  });

  it("materializes the profile on a later pass once the store appears", () => {
    sweep();
    expect(fs.existsSync(storePath())).toBe(false);

    seedAgentStore(agentsDir, AGENT);
    logs = [];
    sweep();

    expect(logs.some((m) => m.includes("settled"))).toBe(true);
    expect(logs.some((m) => m.includes("still deferred"))).toBe(false);
  });

  it("survives an unreadable config rather than killing the timer", () => {
    materializeDeferredBrokerProfiles((m) => logs.push(m), {
      agentsDir,
      readConfig: () => {
        throw new Error("config gone");
      },
    });

    expect(logs.some((m) => m.includes("config unreadable"))).toBe(true);
  });
});
