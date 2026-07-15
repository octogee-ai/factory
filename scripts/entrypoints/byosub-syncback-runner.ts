

import * as fs from "fs";
import * as path from "path";
import {
  agentIdsFromConfig,
  codexAuthJsonPath,
  isSafeAgentId,
} from "../lib/byosub-restore.js";
import {
  syncBackSweep,
  type AuthFingerprint,
  type SyncBackTarget,
} from "../lib/byosub-syncback.js";
import { openClawConfigPath, openClawDir } from "../lib/openclaw-config-path.js";

const OPENCLAW_DIR = openClawDir();
const CONFIG_PATH = openClawConfigPath();
const INTERVAL_MS = Number(process.env.BYOSUB_SYNCBACK_INTERVAL_MS) || 300_000;

function log(msg: string): void {
  const ts = new Date().toISOString().replace("Z", "+00:00");
  console.log(`${ts} [byosub-syncback] ${msg}`);
}

async function loadTargets(): Promise<SyncBackTarget[]> {
  if ((process.env.GATEWAY_CLASS ?? "") === "shared") return [];

  let config: unknown;
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return [];
  }
  return agentIdsFromConfig(config)
    .filter(isSafeAgentId)
    .map((agentId) => ({ agentId, authPath: codexAuthJsonPath(OPENCLAW_DIR, agentId) }));
}

async function main(): Promise<void> {
  log(`starting (mode=observe interval=${INTERVAL_MS}ms)`);
  let prev = new Map<string, AuthFingerprint | null>();
  const tick = async (): Promise<void> => {
    try {
      const targets = await loadTargets();
      if (!targets.length) return;
      const r = await syncBackSweep({ targets, prev, mode: "observe", logFn: log });
      prev = r.prev;
      if (r.observed) log(`sweep: observed ${r.observed} credential change(s)`);
    } catch (e) {
      log(`WARN: sweep tick error — ${(e as Error).message}`);
    }
  };
  await tick();
  setInterval(() => void tick(), INTERVAL_MS);
}

const isEntrypoint =
  (process.argv[1] && process.argv[1].endsWith("byosub-syncback-runner.ts")) ||
  process.argv[1]?.endsWith("byosub-syncback-runner.js");
if (isEntrypoint) {
  
  main().catch((err) => {
    console.error(`[byosub-syncback] fatal: ${err.message}`);
    process.exit(0);
  });
}

export { loadTargets };
