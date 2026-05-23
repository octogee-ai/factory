import { log, readOpenClawConfig, writeOpenClawConfig } from "./config.js";
import { db } from "./firebase.js";

export const agentToUid = new Map<string, string>();

export async function loadAgentToUidMapping(): Promise<void> {
  const snap = await db
    .collection("users")
    .where("provisioning.openclaw.status", "==", "complete")
    .get();

  for (const doc of snap.docs) {
    const oc = doc.data().provisioning?.openclaw;
    if (oc?.agentId)                    agentToUid.set(oc.agentId, doc.id);
    if (Array.isArray(oc?.agentIds))    oc.agentIds.forEach((id: string) => agentToUid.set(id, doc.id));
  }
  log(`agent-map: loaded ${agentToUid.size} entries`);
}

export function registerAgentIds(uid: string, agentIds: string[]): void {
  agentIds.forEach(id => agentToUid.set(id, uid));
}

export function ensureGatewayDefaults(): void {
  const config = readOpenClawConfig();
  config.channels ??= {};

  let changed = false;

  config.agents ??= {};
  config.agents.defaults ??= {};
  if (!config.agents.defaults.maxConcurrent || config.agents.defaults.maxConcurrent < 8) {
    config.agents.defaults.maxConcurrent = 8;
    changed = true;
    log("Set agents.defaults.maxConcurrent = 8");
  }
  if (!config.agents.defaults.subagents?.maxConcurrent || config.agents.defaults.subagents.maxConcurrent < 8) {
    config.agents.defaults.subagents ??= {};
    config.agents.defaults.subagents.maxConcurrent = 8;
    changed = true;
    log("Set agents.defaults.subagents.maxConcurrent = 8");
  }

  if (config.agents.defaults.verboseDefault !== "on") {
    config.agents.defaults.verboseDefault = "on";
    changed = true;
    log('Set agents.defaults.verboseDefault = "on" (Activity Stream Phase 1)');
  }

  const agentList = config.agents?.list ?? [];
  for (const agent of agentList) {
    if (/^octogee-.+-coach$/.test(agent.id)) {
      agent.tools ??= {};
      let agentChanged = false;

      if (!agent.tools.fs?.workspaceOnly) {
        agent.tools.fs = { workspaceOnly: true };
        agentChanged = true;
      }

      const deny = agent.tools.deny ?? [];
      const execDenyItems = deny.filter((t: string) => t === "exec" || t === "process");
      if (execDenyItems.length > 0) {
        agent.tools.deny = deny.filter((t: string) => t !== "exec" && t !== "process");
        agentChanged = true;
        log(`${agent.id} → removed exec/process from agent deny (moved to router plugin)`);
      }

      const faceModel = "anthropic/claude-sonnet-4-6";
      if (agent.model !== faceModel) {
        const oldModel = agent.model ?? "default";
        agent.model = faceModel;
        agentChanged = true;
        log(`Model: ${agent.id} → ${faceModel} (was ${oldModel})`);
      }

if (agent.heartbeat == null) {
        agent.heartbeat = { every: "60m", target: "last", lightContext: true };
        agentChanged = true;
        log(`${agent.id} → heartbeat default (every=60m, target=last, lightContext=true)`);
      }

      if (agentChanged) {
        changed = true;
        const denyList = agent.tools.deny ?? [];
        log(`Security: ${agent.id} → fs.workspaceOnly=true, deny=[${denyList.join(",")}]`);
      }
    }
  }

  config.tools ??= {};
  config.tools.subagents ??= {};
  config.tools.subagents.tools ??= {};
  const subDeny = config.tools.subagents.tools.deny ?? [];
  const filteredSubDeny = subDeny.filter((t: string) => !["exec", "process"].includes(t));
  if (filteredSubDeny.length !== subDeny.length || !config.tools.subagents.tools.deny) {
    config.tools.subagents.tools.deny = filteredSubDeny;
    changed = true;
    log("Brain tool access: ensured exec/process NOT denied for sub-agents");
  }

  config.agents.defaults.subagents ??= {};
  if (config.agents.defaults.subagents.model !== "anthropic/claude-sonnet-4-6") {
    config.agents.defaults.subagents.model = "anthropic/claude-sonnet-4-6";
    changed = true;
    log("Set agents.defaults.subagents.model = anthropic/claude-sonnet-4-6");
  }

  if (!config.agents.defaults.subagents.runTimeoutSeconds || config.agents.defaults.subagents.runTimeoutSeconds < 900) {
    config.agents.defaults.subagents.runTimeoutSeconds = 900;
    changed = true;
    log("Set agents.defaults.subagents.runTimeoutSeconds = 900");
  }

  if (config.tools.elevated?.enabled !== false) {
    config.tools.elevated = { enabled: false };
    changed = true;
    log("Set tools.elevated.enabled = false");
  }

  config.gateway ??= {};
  config.gateway.auth ??= {};
  if (!config.gateway.auth.rateLimit) {
    config.gateway.auth.rateLimit = { maxAttempts: 10, windowMs: 60000, lockoutMs: 300000 };
    changed = true;
    log("Set gateway.auth.rateLimit (10 attempts/60s, 5min lockout)");
  }

  if (changed) writeOpenClawConfig(config);
}
