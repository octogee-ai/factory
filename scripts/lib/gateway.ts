/**
 * Octogee Provisioner — Gateway Configuration
 */

import { log, readOpenClawConfig, writeOpenClawConfig } from "./config.js";
import { db } from "./firebase.js";

// ── Agent-to-UID Mapping ────────────────────────────────────────────────────────

export const agentToUid = new Map<string, string>();

/** Build / refresh the shared agentId → UID map from Firestore. */
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

/** Register newly provisioned agent IDs in the shared map. */
export function registerAgentIds(uid: string, agentIds: string[]): void {
  agentIds.forEach(id => agentToUid.set(id, uid));
}

// ── Gateway Defaults ────────────────────────────────────────────────────────────

/**
 * Ensure global gateway settings are applied to the config on every startup.
 * Idempotent — safe to run repeatedly.
 */
export function ensureGatewayDefaults(): void {
  const config = readOpenClawConfig();
  config.channels ??= {};

  let changed = false;

  // Agent concurrency
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

  // Security: Enforce tool restrictions on ALL existing Coach agents.
  const agentList = config.agents?.list ?? [];
  for (const agent of agentList) {
    if (/^octogee-.+-coach$/.test(agent.id)) {
      agent.tools ??= {};
      let agentChanged = false;

      if (!agent.tools.fs?.workspaceOnly) {
        agent.tools.fs = { workspaceOnly: true };
        agentChanged = true;
      }

      // exec/process blocking moved to router plugin
      const deny = agent.tools.deny ?? [];
      const execDenyItems = deny.filter((t: string) => t === "exec" || t === "process");
      if (execDenyItems.length > 0) {
        agent.tools.deny = deny.filter((t: string) => t !== "exec" && t !== "process");
        agentChanged = true;
        log(`${agent.id} → removed exec/process from agent deny (moved to router plugin)`);
      }

      // Face model: Sonnet 4.6 for F&F. Per-customer overrides were driven
      // by writes to `plugins.entries.octogee-router.config.faceModelOverrides`,
      // which tripped the `plugins.*` restart rule — the exact cascade that
      // bounced every tenant's MM WS on signup. Removed for F&F; bring back
      // via applyConfigPatch + a plugin-hot-reload declaration when the
      // per-customer model knob actually ships.
      const faceModel = "anthropic/claude-sonnet-4-6";
      if (agent.model !== faceModel) {
        const oldModel = agent.model ?? "default";
        agent.model = faceModel;
        agentChanged = true;
        log(`Model: ${agent.id} → ${faceModel} (was ${oldModel})`);
      }

      // Heartbeat: ensure target + lightContext for brain status monitoring
      agent.heartbeat ??= { every: "45s" };
      if (agent.heartbeat.target !== "last" || !agent.heartbeat.lightContext || agent.heartbeat.every !== "45s") {
        agent.heartbeat.every = "45s";
        agent.heartbeat.target = "last";
        agent.heartbeat.lightContext = true;
        agentChanged = true;
        log(`${agent.id} → heartbeat target=last, lightContext=true`);
      }

      if (agentChanged) {
        changed = true;
        const denyList = agent.tools.deny ?? [];
        log(`Security: ${agent.id} → fs.workspaceOnly=true, deny=[${denyList.join(",")}]`);
      }
    }
  }

  // Brain (sub-agent) tool access
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

  // Brain model
  config.agents.defaults.subagents ??= {};
  if (config.agents.defaults.subagents.model !== "anthropic/claude-sonnet-4-6") {
    config.agents.defaults.subagents.model = "anthropic/claude-sonnet-4-6";
    changed = true;
    log("Set agents.defaults.subagents.model = anthropic/claude-sonnet-4-6");
  }

  // Brain timeout
  if (!config.agents.defaults.subagents.runTimeoutSeconds || config.agents.defaults.subagents.runTimeoutSeconds < 900) {
    config.agents.defaults.subagents.runTimeoutSeconds = 900;
    changed = true;
    log("Set agents.defaults.subagents.runTimeoutSeconds = 900");
  }

  // Security: Disable elevated tools globally
  if (config.tools.elevated?.enabled !== false) {
    config.tools.elevated = { enabled: false };
    changed = true;
    log("Set tools.elevated.enabled = false");
  }

  const routerEnabled = process.env.OCTOGEE_ROUTER_ENABLED !== "false";

  // Security: Explicit plugin allowlist. octogee-mattermost-tools is always
  // on (no tier gate per docs/COACH-MATTERMOST-TOOLS-SPEC.md §3.1). The
  // plugin's `enabled: true` in plugins.entries means nothing if it's not
  // also in this allowlist — OpenClaw's loader gates on allow first.
  config.plugins ??= {};
  const desiredAllow = routerEnabled
    ? ["mattermost", "octogee-router", "octogee-mattermost-tools"]
    : ["mattermost", "octogee-mattermost-tools"];
  if (JSON.stringify(config.plugins.allow ?? []) !== JSON.stringify(desiredAllow)) {
    config.plugins.allow = desiredAllow;
    changed = true;
    log(`Set plugins.allow = ${JSON.stringify(desiredAllow)}`);
  }

  // Security: Gateway auth rate limiting
  config.gateway ??= {};
  config.gateway.auth ??= {};
  if (!config.gateway.auth.rateLimit) {
    config.gateway.auth.rateLimit = { maxAttempts: 10, windowMs: 60000, lockoutMs: 300000 };
    changed = true;
    log("Set gateway.auth.rateLimit (10 attempts/60s, 5min lockout)");
  }

  // Plugin config structure
  config.plugins ??= {};
  config.plugins.entries ??= {};
  if (routerEnabled) {
    config.plugins.entries["octogee-router"] ??= {};
    config.plugins.entries["octogee-router"].config ??= {};
  } else if (config.plugins.entries["octogee-router"]) {
    delete config.plugins.entries["octogee-router"];
    changed = true;
    log("Removed octogee-router plugin entry because OCTOGEE_ROUTER_ENABLED=false");
  }

  if (changed) writeOpenClawConfig(config);
}

// ── Removed for F&F: per-customer router config syncs ──────────────────────────
//
// The following sync functions used to write to
// `plugins.entries.octogee-router.config.*`:
//
//   - syncEnforcementOverrides  (per-customer faceBrainEnforcement)
//   - syncBrainGatedSlugs       (free-tier brain gating)
//   - syncModelOverrides        (per-customer face/brain model)
//
// Each wrote openclaw.json directly, which chokidar picked up and fed into
// the reload plan. `plugins.*` matches `BASE_RELOAD_RULES_TAIL` with
// `kind: "restart"` — a FULL GATEWAY RESTART — so every onSnapshot fire on
// `users/{uid}` (including the terminal `provisioning.openclaw.status =
// "complete"` write) bounced every tenant's MM WS.
//
// F&F defaults (sonnet-4-6 face, observe-only router, no brain gating,
// liberal tools) don't need any of these knobs. Bring them back post-F&F
// via `applyConfigPatch` + a plugin-scoped `hotPrefixes` declaration so
// value tweaks hot-reload instead of restarting the pod.

