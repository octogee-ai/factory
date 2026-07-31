import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { quiesceCustomerSessions } from "../lib/customer-session-quiesce.js";

const tempDirs: string[] = [];

function writeSessions(stateDir: string, agentId: string, statuses: string[]): void {
  const sessionsDir = path.join(stateDir, "agents", agentId, "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionsDir, "sessions.json"),
    JSON.stringify({ sessions: statuses.map((status) => ({ status })) }),
  );
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
  });
});
