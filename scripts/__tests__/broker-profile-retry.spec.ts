import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DatabaseSync } from "node:sqlite";

import { OpenClawSecretsApplyError } from "@octogee/core/agent-model-token-materializer";
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

/** Mirrors what openclaw's secrets.apply persists, so the next sweep's
 *  idempotency read settles. */
function writeAppliedProfiles(
  agentsDir: string,
  plan: {
    targets: Array<{ path: string; agentId: string; authProfileProvider: string; ref: unknown }>;
  },
): void {
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
  let apply: ReturnType<typeof vi.fn>;
  let reloadFails: boolean;
  let reload: ReturnType<typeof vi.fn>;
  const readConfig = () => ({ agents: { entries: { [AGENT]: { model: "house" } } } });
  const sweep = () =>
    materializeDeferredBrokerProfiles((m) => logs.push(m), {
      agentsDir,
      readConfig,
      secretsApply: { apply },
      secretsReload: { secretsReload: reload },
    });

  beforeEach(() => {
    agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-bpr-"));
    logs = [];
    applyOutcome = "refuse";
    reloadFails = false;
    apply = vi.fn(async (plan: Parameters<typeof writeAppliedProfiles>[1]) => {
      if (applyOutcome === "refuse") {
        throw new OpenClawSecretsApplyError("secret provider unavailable", 1);
      }
      writeAppliedProfiles(agentsDir, plan);
      return { mode: "write", changed: true };
    });
    reload = vi.fn(async () => {
      if (reloadFails) throw new Error("snapshot reload unavailable");
      return { ok: true, warningCount: 0 };
    });
    _resetBrokerProfileLogStateForTests();
  });
  afterEach(() => {
    fs.rmSync(agentsDir, { recursive: true, force: true });
  });

  it("applies the profiles through openclaw's standard secrets apply", async () => {
    seedAgentStore(agentsDir, AGENT);
    applyOutcome = "accept";

    await sweep();

    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({ generatedBy: "manual", targets: expect.any(Array) }),
    );
  });

  it("reloads the active secret snapshot after profiles are accepted", async () => {
    seedAgentStore(agentsDir, AGENT);
    applyOutcome = "accept";

    await sweep();

    expect(reload).toHaveBeenCalledOnce();
    expect(apply.mock.invocationCallOrder[0]).toBeLessThan(reload.mock.invocationCallOrder[0]);
  });

  it("shares one in-flight sweep across overlapping startup and retry callers", async () => {
    seedAgentStore(agentsDir, AGENT);
    applyOutcome = "accept";
    let releaseApply!: () => void;
    const applyBlocked = new Promise<void>((resolve) => {
      releaseApply = resolve;
    });
    apply = vi.fn(async (plan: Parameters<typeof writeAppliedProfiles>[1]) => {
      await applyBlocked;
      writeAppliedProfiles(agentsDir, plan);
      return { mode: "write", changed: true };
    });

    const startup = sweep();
    await vi.waitFor(() => expect(apply).toHaveBeenCalledOnce());
    const retryTimer = sweep();

    expect(retryTimer).toBe(startup);
    expect(apply).toHaveBeenCalledOnce();

    releaseApply();
    const [startupResult, retryResult] = await Promise.all([startup, retryTimer]);

    expect(startupResult).toBe(retryResult);
    expect(startupResult).toEqual({ settled: true, deferred: [] });
    expect(apply).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();

    const afterSettlement = sweep();
    expect(afterSettlement).not.toBe(startup);
    await expect(afterSettlement).resolves.toEqual({ settled: true, deferred: [] });
  });

  it("clears a failed in-flight sweep so a later caller can retry", async () => {
    const failed = materializeDeferredBrokerProfiles(() => {
      throw new Error("log sink unavailable");
    }, {
      agentsDir,
      readConfig: () => {
        throw new Error("config unavailable");
      },
    });

    await expect(failed).rejects.toThrow("log sink unavailable");

    seedAgentStore(agentsDir, AGENT);
    applyOutcome = "accept";
    await expect(sweep()).resolves.toEqual({ settled: true, deferred: [] });
    expect(apply).toHaveBeenCalledOnce();
  });

  it("retries a failed snapshot reload after the profile store has settled", async () => {
    seedAgentStore(agentsDir, AGENT);
    applyOutcome = "accept";
    reloadFails = true;

    await sweep();
    reloadFails = false;
    await sweep();

    expect(apply).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("reports a deferral while openclaw refuses the apply", async () => {
    await sweep();

    expect(logs.some((m) => m.includes("still deferred") && m.includes(AGENT))).toBe(true);
  });

  it("stays quiet while the deferral is unchanged — it runs on a timer", async () => {
    await sweep();
    const afterFirst = logs.length;

    await sweep();
    await sweep();

    expect(logs.length).toBe(afterFirst);
  });

  it("settles on a later pass once openclaw accepts the apply", async () => {
    await sweep();
    seedAgentStore(agentsDir, AGENT);
    applyOutcome = "accept";
    logs = [];

    await sweep();

    expect(logs.some((m) => m.includes("settled"))).toBe(true);
    expect(logs.some((m) => m.includes("still deferred"))).toBe(false);
  });

  it("stops calling the gateway once every profile has settled", async () => {
    seedAgentStore(agentsDir, AGENT);
    applyOutcome = "accept";
    await sweep();
    const afterFirst = apply.mock.calls.length;

    await sweep();

    expect(apply.mock.calls.length).toBe(afterFirst);
  });

  it("survives an unreadable config rather than killing the timer", async () => {
    await materializeDeferredBrokerProfiles((m) => logs.push(m), {
      agentsDir,
      secretsApply: { apply },
      readConfig: () => {
        throw new Error("config gone");
      },
    });

    expect(logs.some((m) => m.includes("config unreadable"))).toBe(true);
  });
});
