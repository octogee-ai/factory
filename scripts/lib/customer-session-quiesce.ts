import * as fs from "node:fs";
import * as path from "node:path";

import { agentIdBelongsToSlug } from "../../shared/types/agent-models.js";
import {
  customerCoachAgentId,
  readAgentSessions,
  resolveOpenClawStateDir,
} from "./fleet-http-migration.js";

export interface CustomerSessionQuiesceOptions {
  timeoutMs: number;
  log?: (message: string) => void;
  stateDir?: string;
  now?: () => number;
  wait?: (delayMs: number) => Promise<void>;
}

function stateDirectoryEntries(directory: string): fs.Dirent[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true });
}

function customerAgentIds(stateDir: string, slug: string): string[] {
  const agentIds = new Set([customerCoachAgentId(slug)]);
  for (const entry of stateDirectoryEntries(path.join(stateDir, "agents"))) {
    if (entry.isDirectory() && agentIdBelongsToSlug(entry.name, slug)) {
      agentIds.add(entry.name);
    }
  }
  return [...agentIds].sort();
}

export async function quiesceCustomerSessions(
  slug: string,
  opts: CustomerSessionQuiesceOptions,
): Promise<{ drained: boolean; runningCount: number }> {
  const stateDir = opts.stateDir ?? resolveOpenClawStateDir();
  const now = opts.now ?? Date.now;
  const wait = opts.wait ?? ((delayMs: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const deadline = now() + opts.timeoutMs;
  let runningCount = 0;
  do {
    runningCount = 0;
    for (const agentId of customerAgentIds(stateDir, slug)) {
      const sessions = await readAgentSessions(stateDir, agentId);
      runningCount += sessions.filter((session) => session.status === "running").length;
    }
    if (runningCount === 0) return { drained: true, runningCount: 0 };
    opts.log?.(`[quiesce:${slug}] ${runningCount} running session(s); waiting`);
    const remainingMs = deadline - now();
    if (remainingMs <= 0) break;
    await wait(Math.min(1_000, remainingMs));
  } while (now() < deadline);
  return { drained: false, runningCount };
}
