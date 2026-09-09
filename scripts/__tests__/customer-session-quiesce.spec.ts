import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { quiesceCustomerSessions } from "../lib/customer-session-quiesce.js";

const tempDirs: string[] = [];

function writeSessions(stateDir: string, agentId: string, statuses: string[]): void {
  const agentDir = path.join(stateDir, "agents", agentId, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  const db = new DatabaseSync(path.join(agentDir, "openclaw-agent.sqlite"));
  try {
    db.exec("CREATE TABLE IF NOT EXISTS session_nodes (current_session_id TEXT, status TEXT)");
    db.exec("DELETE FROM session_nodes");
    for (const [index, status] of statuses.entries()) {
      db.prepare("INSERT INTO session_nodes VALUES (?, ?)").run(String(index), status);
    }
  } finally {
    db.close();
  }
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("quiesceCustomerSessions", () => {
  it("counts coach and project-agent runs owned by only the requested customer", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-session-quiesce-"));
    tempDirs.push(stateDir);
    writeSessions(stateDir, "octogee-alice-coach", ["running"]);
    writeSessions(stateDir, "octogee-alice-proj-launch-coach", ["running"]);
    writeSessions(stateDir, "octogee-bob-coach", ["running"]);

    await expect(quiesceCustomerSessions("alice", {
      stateDir,
      timeoutMs: 0,
    })).resolves.toEqual({ drained: false, runningCount: 2 });
  });

  it("returns drained as soon as the customer's writers settle", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-session-quiesce-"));
    tempDirs.push(stateDir);
    writeSessions(stateDir, "octogee-alice-coach", ["running"]);
    let now = 0;

    await expect(quiesceCustomerSessions("alice", {
      stateDir,
      timeoutMs: 5_000,
      now: () => now,
      wait: async (delayMs) => {
        now += delayMs;
        writeSessions(stateDir, "octogee-alice-coach", ["done"]);
      },
    })).resolves.toEqual({ drained: true, runningCount: 0 });
    expect(now).toBe(1_000);
  });
  it("rejects an unreadable session store instead of reporting a drained customer", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-session-quiesce-"));
    tempDirs.push(stateDir);
    writeSessions(stateDir, "octogee-alice-coach", []);
    fs.writeFileSync(path.join(stateDir, "agents", "octogee-alice-coach", "agent", "openclaw-agent.sqlite"), "broken");
    await expect(quiesceCustomerSessions("alice", { stateDir, timeoutMs: 0 })).rejects.toThrow();
  });

  it("observes committed running turns in the live WAL", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-session-quiesce-"));
    tempDirs.push(stateDir);
    writeSessions(stateDir, "octogee-alice-coach", ["done"]);
    const store = path.join(stateDir, "agents", "octogee-alice-coach", "agent", "openclaw-agent.sqlite");
    const writer = new DatabaseSync(store);
    try {
      writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
      writer.exec("UPDATE session_nodes SET status='running'");
      await expect(quiesceCustomerSessions("alice", { stateDir, timeoutMs: 0 }))
        .resolves.toEqual({ drained: false, runningCount: 1 });
    } finally {
      writer.close();
    }
  });

});
