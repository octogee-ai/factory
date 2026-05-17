/**
 * Backgrounded by infra/gateway/entrypoint.sh. Watches each BYO-sub
 * customer-agent's per-agent codex-home/auth.json and, on a content change
 * (codex rotated the token in place), records it. **Observe-only** first
 * ship (spec §8 / Chunk B): zero secret reads, zero writes, zero IAM — it
 * is the detection mechanism AND the natural-rotation data collector. The
 * `active` push (workspace-api-mediated per R2) is a tested-but-unwired
 * follow-on. Codex access tokens are ~10-day and rotation is lenient, so a
 * slow poll is fine — this is not a hot path.
 */
import * as fs from "fs";
import * as path from "path";
import { agentIdsFromConfig, planByosubRestores } from "./lib/byosub-restore.js";
import {
  syncBackSweep,
  type AuthFingerprint,
  type SyncBackTarget,
} from "./lib/byosub-syncback.js";

const OPENCLAW_DIR = process.env.HOME
  ? path.join(process.env.HOME, ".openclaw")
  : "/home/node/.openclaw";
const CONFIG_PATH = path.join(OPENCLAW_DIR, "openclaw.json");
const INTERVAL_MS = Number(process.env.BYOSUB_SYNCBACK_INTERVAL_MS) || 300_000;

function log(msg: string): void {
  const ts = new Date().toISOString().replace("Z", "+00:00");
  console.log(`${ts} [byosub-syncback] ${msg}`);
}

async function loadTargets(): Promise<SyncBackTarget[]> {
  let config: unknown;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed module-const path
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return [];
  }
  const gatewayId = process.env.GATEWAY_ID;
  if (!gatewayId) return [];
  let byosub: Record<string, { provider: "openai" | "anthropic"; secretName: string }> | undefined;
  try {
    const { db } = await import("./lib/firebase.js");
    const snap = await db.collection("glmGateways").doc(gatewayId).get();
    byosub = snap.exists
      ? (snap.data() as { byosub?: typeof byosub } | undefined)?.byosub
      : undefined;
  } catch (e) {
    log(`WARN: glmGateways fetch failed — ${(e as Error).message}`);
    return [];
  }
  return planByosubRestores({
    agentIds: agentIdsFromConfig(config),
    byosub,
    openclawDir: OPENCLAW_DIR,
    logFn: log,
  }).map((p) => ({ agentId: p.agentId, authPath: p.targetPath }));
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
  // Never crash the pod — this is a best-effort observer.
  main().catch((err) => {
    console.error(`[byosub-syncback] fatal: ${err.message}`);
    process.exit(0);
  });
}

export { loadTargets };
