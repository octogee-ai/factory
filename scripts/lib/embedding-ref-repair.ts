import type { GatewayDoc } from "../../shared/types/gateway-releases.js";
import {
  PLATFORM_EMBEDDING_SECRET_PREFIX,
  platformOpenAiEmbeddingSecretId,
  rebindPlatformEmbeddingRefs,
} from "./openclaw-config-builders.js";

// Operator repair for the r2 wedge class: a source pod whose persisted config
// carries platform embedding SecretRefs shifted onto the wrong coach (OpenClaw
// redacted-array round-trip). Follows the prod adapter's incident-proven
// recipe: hash from rpc.configGet, BASE from the pod's UNREDACTED disk config
// (configGet output is redacted — full-applying it would clobber literal
// secrets), rebound agents.list only, then config.apply + rpc-view verify.

export interface EmbeddingRefMismatch {
  agentId: string;
  currentId: string;
  expectedId: string;
}

export interface EmbeddingRefRepairPlan {
  agentsConfigured: number;
  mismatched: EmbeddingRefMismatch[];
  absentAgentDirs: string[];
  nextAgentsList: unknown[] | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function platformRefId(entry: unknown): { agentId: string; refId: string } | null {
  if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.length === 0) return null;
  const memorySearch = entry.memorySearch;
  if (!isRecord(memorySearch)) return null;
  const remote = memorySearch.remote;
  if (!isRecord(remote)) return null;
  const apiKey = remote.apiKey;
  if (
    !isRecord(apiKey) ||
    typeof apiKey.id !== "string" ||
    !apiKey.id.startsWith(PLATFORM_EMBEDDING_SECRET_PREFIX)
  ) {
    return null;
  }
  return { agentId: entry.id, refId: apiKey.id };
}

export function planEmbeddingRefRepair(
  config: unknown,
  opts: { agentDirExists: (agentId: string) => boolean },
): EmbeddingRefRepairPlan {
  const list = (config as { agents?: { list?: unknown } } | undefined)?.agents?.list;
  const agents = Array.isArray(list) ? list : [];
  const mismatched: EmbeddingRefMismatch[] = [];
  const absentAgentDirs: string[] = [];
  for (const entry of agents) {
    const ref = platformRefId(entry);
    if (!ref) continue;
    const expectedId = platformOpenAiEmbeddingSecretId(ref.agentId);
    if (ref.refId !== expectedId) {
      mismatched.push({ agentId: ref.agentId, currentId: ref.refId, expectedId });
    }
    if (!opts.agentDirExists(ref.agentId)) {
      absentAgentDirs.push(ref.agentId);
    }
  }
  return {
    agentsConfigured: agents.length,
    mismatched,
    absentAgentDirs,
    nextAgentsList: mismatched.length > 0 ? rebindPlatformEmbeddingRefs(agents) : null,
  };
}

// A repair may only target the gateway's single stable-name instance
// (GATEWAY-SIMPLE-ROLL-SPEC): the bare gateway id.
export function repairTargetRevisionAllowed(root: GatewayDoc, revisionId: string): boolean {
  return revisionId === root.gatewayId;
}

export interface RunEmbeddingRefRepairOptions {
  rpc: {
    configGet: () => Promise<{ config: unknown; hash: string }>;
    configApply: (config: object, baseHash: string) => Promise<unknown>;
  };
  readUnredactedConfig: () => Promise<unknown>;
  agentDirExists: (agentId: string) => boolean;
  dryRun: boolean;
  log: (msg: string) => void;
}

export interface RunEmbeddingRefRepairResult {
  plan: EmbeddingRefRepairPlan;
  applied: boolean;
  verified: boolean;
}

export async function runEmbeddingRefRepair(
  opts: RunEmbeddingRefRepairOptions,
): Promise<RunEmbeddingRefRepairResult> {
  const { hash } = await opts.rpc.configGet();
  const base = await opts.readUnredactedConfig();
  if (!isRecord(base)) {
    throw new Error("unredacted config read returned a non-object — refusing to repair");
  }
  const plan = planEmbeddingRefRepair(base, { agentDirExists: opts.agentDirExists });
  for (const m of plan.mismatched) {
    opts.log(
      `[embedding-repair] ${m.agentId}: ${m.currentId} → ${m.expectedId}${opts.dryRun ? " (dry-run)" : ""}`,
    );
  }
  if (plan.mismatched.length === 0) {
    opts.log(
      `[embedding-repair] every platform embedding ref is already bound to its own agent (${plan.agentsConfigured} agents)`,
    );
    return { plan, applied: false, verified: plan.absentAgentDirs.length === 0 };
  }
  if (opts.dryRun) {
    opts.log(
      `[embedding-repair] dry-run: ${plan.mismatched.length} ref(s) would be rebound; rerun with apply to write`,
    );
    return { plan, applied: false, verified: false };
  }
  if (plan.absentAgentDirs.length > 0) {
    throw new Error(
      `[embedding-repair] refusing to apply: absent agent dir(s) for ${plan.absentAgentDirs.join(", ")} — ` +
        "a rebound ref would still refuse to resolve; remove or remount those coaches first",
    );
  }
  const next = structuredClone(base);
  const agents = isRecord(next.agents) ? next.agents : {};
  next.agents = { ...agents, list: plan.nextAgentsList };
  await opts.rpc.configApply(next, hash);
  opts.log(`[embedding-repair] config.apply OK — rebound ${plan.mismatched.length} ref(s)`);

  const after = await opts.rpc.configGet();
  const verify = planEmbeddingRefRepair(after.config, { agentDirExists: opts.agentDirExists });
  if (verify.mismatched.length > 0) {
    throw new Error(
      `[embedding-repair] post-apply verification still sees ${verify.mismatched.length} mismatched ref(s) — ` +
        "the running config did not converge; inspect config.get output before retrying",
    );
  }
  opts.log("[embedding-repair] verified: rpc view reports zero mismatched refs");
  return { plan, applied: true, verified: true };
}
