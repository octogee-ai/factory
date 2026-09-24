import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  quiesceCustomerSessions,
  quiesceCustomerSessionsBounded,
  sessionStoreForPath,
  type BoundedQuiesceOptions,
} from "../lib/customer-session-quiesce.js";

const tempDirs: string[] = [];

function writeSessions(stateDir: string, agentId: string, sessions: Array<[key: string, status: string]>): string {
  const agentDir = path.join(stateDir, "agents", agentId, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  const storePath = path.join(agentDir, "openclaw-agent.sqlite");
  const db = new DatabaseSync(storePath);
  try {
    db.exec("CREATE TABLE IF NOT EXISTS session_nodes (session_key TEXT, current_session_id TEXT, status TEXT)");
    db.exec("DELETE FROM session_nodes");
    for (const [index, [key, status]] of sessions.entries()) {
      db.prepare("INSERT INTO session_nodes VALUES (?, ?, ?)").run(key, String(index), status);
    }
  } finally {
    db.close();
  }
  return storePath;
}

function mkStateDir(): string {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-session-quiesce-"));
  tempDirs.push(stateDir);
  return stateDir;
}

function clockedRpc() {
  return {
    configGet: vi.fn(async () => ({ config: { agents: { entries: { "octogee-alice-coach": {} } } } })),
    schedulerMigration: vi.fn(async (request: { operationId: string; phase: string; agentIds?: string[] }) => ({
      operationId: request.operationId, phase: request.phase, agentIds: request.agentIds ?? [], drained: true,
    })),
    sessionsAbort: vi.fn(async () => ({ ok: true as const, abortedRunId: "run-1", status: "aborted" as const })),
  };
}

function harness(stateDir: string, overrides: Partial<BoundedQuiesceOptions> = {}) {
  let now = 0;
  const waits: number[] = [];
  const rpc = clockedRpc();
  const opts: BoundedQuiesceOptions = {
    rpc: rpc as unknown as BoundedQuiesceOptions["rpc"],
    slug: "alice",
    agentIds: ["octogee-alice-coach"],
    stores: [sessionStoreForPath(path.join(stateDir, "agents", "octogee-alice-coach", "sessions", "sessions.json"))],
    now: () => now,
    wait: async (delayMs) => {
      waits.push(delayMs);
      now += delayMs;
    },
    log: vi.fn(),
    ...overrides,
  };
  return { rpc, opts, waits, clock: () => now };
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("quiesceCustomerSessions (pre-stop drain)", () => {
  it("counts coach and project-agent runs owned by only the requested customer", async () => {
    const stateDir = mkStateDir();
    writeSessions(stateDir, "octogee-alice-coach", [["agent:octogee-alice-coach:main", "running"]]);
    writeSessions(stateDir, "octogee-alice-proj-launch-coach", [["agent:octogee-alice-proj-launch-coach:main", "running"]]);
    writeSessions(stateDir, "octogee-bob-coach", [["agent:octogee-bob-coach:main", "running"]]);

    await expect(quiesceCustomerSessions("alice", { stateDir, timeoutMs: 0 }))
      .resolves.toEqual({ drained: false, runningCount: 2 });
  });

  it("returns drained as soon as the customer's writers settle", async () => {
    const stateDir = mkStateDir();
    writeSessions(stateDir, "octogee-alice-coach", [["agent:octogee-alice-coach:main", "running"]]);
    let now = 0;

    await expect(quiesceCustomerSessions("alice", {
      stateDir,
      timeoutMs: 5_000,
      now: () => now,
      wait: async (delayMs) => {
        now += delayMs;
        writeSessions(stateDir, "octogee-alice-coach", [["agent:octogee-alice-coach:main", "done"]]);
      },
    })).resolves.toEqual({ drained: true, runningCount: 0 });
    expect(now).toBe(1_000);
  });

  it("rejects an unreadable session store instead of reporting a drained customer", async () => {
    const stateDir = mkStateDir();
    const storePath = writeSessions(stateDir, "octogee-alice-coach", []);
    fs.writeFileSync(storePath, "broken");
    await expect(quiesceCustomerSessions("alice", { stateDir, timeoutMs: 0 })).rejects.toThrow();
  });
});

describe("sessionStoreForPath", () => {
  it("names the agent that owns a session store from its path", () => {
    expect(sessionStoreForPath(path.join("/state", "agents", "octogee-alice-proj-app-coach", "sessions", "sessions.json")))
      .toEqual({ agentId: "octogee-alice-proj-app-coach", path: path.join("/state", "agents", "octogee-alice-proj-app-coach", "sessions", "sessions.json") });
    expect(() => sessionStoreForPath("/state/sessions.json")).toThrow(/names no agent/u);
  });
});

describe("quiesceCustomerSessionsBounded", () => {
  it("returns drained immediately, without a grace wait, when nothing is running", async () => {
    const stateDir = mkStateDir();
    writeSessions(stateDir, "octogee-alice-coach", [["agent:octogee-alice-coach:main", "done"]]);
    const h = harness(stateDir, { schedulerMigrationId: "handoff-1" });

    await expect(quiesceCustomerSessionsBounded(h.opts)).resolves.toEqual({ drained: true, runningCount: 0, abortedSessions: 0 });
    expect(h.waits).toEqual([]);
    expect(h.rpc.sessionsAbort).not.toHaveBeenCalled();
    expect(h.rpc.schedulerMigration).toHaveBeenCalledWith({ operationId: "handoff-1", phase: "hold", agentIds: ["octogee-alice-coach"] });
  });

  it("lets a running turn settle inside the grace window and never aborts it", async () => {
    const stateDir = mkStateDir();
    writeSessions(stateDir, "octogee-alice-coach", [["agent:octogee-alice-coach:main", "running"]]);
    const h = harness(stateDir, {
      graceMs: 20_000,
      wait: async (delayMs) => {
        h.waits.push(delayMs);
        writeSessions(stateDir, "octogee-alice-coach", [["agent:octogee-alice-coach:main", "done"]]);
      },
    });

    await expect(quiesceCustomerSessionsBounded(h.opts)).resolves.toEqual({ drained: true, runningCount: 0, abortedSessions: 0 });
    expect(h.waits).toEqual([1_000]);
    expect(h.rpc.sessionsAbort).not.toHaveBeenCalled();
  });

  it("aborts every still-running session of the customer's agents through sessions.abort once the grace elapses", async () => {
    const stateDir = mkStateDir();
    writeSessions(stateDir, "octogee-alice-coach", [
      ["agent:octogee-alice-coach:main", "running"],
      ["agent:octogee-alice-coach:mattermost:channel", "done"],
    ]);
    const projectStore = writeSessions(stateDir, "octogee-alice-proj-app-coach", [["agent:octogee-alice-proj-app-coach:cron", "running"]]);
    const h = harness(stateDir, { graceMs: 2_000, recheckMs: 10_000 });
    h.opts.stores = [...h.opts.stores, sessionStoreForPath(projectStore)];
    h.rpc.sessionsAbort.mockImplementation(async () => {
      writeSessions(stateDir, "octogee-alice-coach", [["agent:octogee-alice-coach:main", "killed"]]);
      writeSessions(stateDir, "octogee-alice-proj-app-coach", [["agent:octogee-alice-proj-app-coach:cron", "killed"]]);
      return { ok: true as const, abortedRunId: "run-1", status: "aborted" as const };
    });

    await expect(quiesceCustomerSessionsBounded(h.opts)).resolves.toEqual({ drained: true, runningCount: 0, abortedSessions: 2 });
    expect(h.rpc.sessionsAbort.mock.calls.map(([request]) => request)).toEqual([
      { key: "agent:octogee-alice-coach:main", agentId: "octogee-alice-coach", clearQueued: true },
      { key: "agent:octogee-alice-proj-app-coach:cron", agentId: "octogee-alice-proj-app-coach", clearQueued: true },
    ]);
    expect(h.clock()).toBe(2_000);
  });

  it("is bounded by grace plus recheck even when the agent never settles, and reports not drained", async () => {
    const stateDir = mkStateDir();
    writeSessions(stateDir, "octogee-alice-coach", [["agent:octogee-alice-coach:main", "running"]]);
    const h = harness(stateDir, { graceMs: 3_000, recheckMs: 2_000 });

    await expect(quiesceCustomerSessionsBounded(h.opts)).resolves.toEqual({ drained: false, runningCount: 1, abortedSessions: 1 });
    expect(h.clock()).toBe(5_000);
    expect(h.rpc.sessionsAbort).toHaveBeenCalledTimes(1);
  });

  it("keeps polling the scheduler hold until its in-flight run is gone, aborting that run like any session", async () => {
    const stateDir = mkStateDir();
    writeSessions(stateDir, "octogee-alice-coach", [["agent:octogee-alice-coach:cron", "running"]]);
    const h = harness(stateDir, { schedulerMigrationId: "handoff-1", graceMs: 1_000, recheckMs: 5_000 });
    let holds = 0;
    h.rpc.schedulerMigration.mockImplementation(async (request) => {
      holds += 1;
      return { operationId: request.operationId, phase: request.phase, agentIds: request.agentIds ?? [], drained: holds > 3 };
    });
    h.rpc.sessionsAbort.mockImplementation(async () => {
      writeSessions(stateDir, "octogee-alice-coach", [["agent:octogee-alice-coach:cron", "killed"]]);
      return { ok: true as const, abortedRunId: "run-cron", status: "aborted" as const };
    });

    await expect(quiesceCustomerSessionsBounded(h.opts)).resolves.toEqual({ drained: true, runningCount: 0, abortedSessions: 1 });
    expect(holds).toBe(4);
  });

  it("refuses to abort a running session whose store carries no session key", async () => {
    const stateDir = mkStateDir();
    const agentDir = path.join(stateDir, "agents", "octogee-alice-coach", "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    const db = new DatabaseSync(path.join(agentDir, "openclaw-agent.sqlite"));
    try {
      db.exec("CREATE TABLE session_nodes (session_key TEXT, current_session_id TEXT, status TEXT)");
      db.prepare("INSERT INTO session_nodes VALUES (NULL, 's', 'running')").run();
    } finally {
      db.close();
    }
    const h = harness(stateDir, { graceMs: 0 });

    await expect(quiesceCustomerSessionsBounded(h.opts)).rejects.toThrow(/no session key/u);
    expect(h.rpc.sessionsAbort).not.toHaveBeenCalled();
  });

  it("only waits for the grace window when the caller owns the stop itself", async () => {
    const stateDir = mkStateDir();
    writeSessions(stateDir, "octogee-alice-coach", [["agent:octogee-alice-coach:main", "running"]]);
    const h = harness(stateDir, { graceMs: 2_000, abortAfterGrace: false });

    await expect(quiesceCustomerSessionsBounded(h.opts)).resolves.toEqual({ drained: false, runningCount: 1, abortedSessions: 0 });
    expect(h.rpc.sessionsAbort).not.toHaveBeenCalled();
    expect(h.clock()).toBe(2_000);
  });
});
