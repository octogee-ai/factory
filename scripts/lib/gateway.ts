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

      // Face model: default Haiku, per-customer override via faceModelOverrides
      const agentSlug = agent.id.replace(/^octogee-/, "").replace(/-coach$/, "");
      const faceOverrides: Record<string, string> = config.plugins?.entries?.["octogee-router"]?.config?.faceModelOverrides ?? {};
      const faceModel = faceOverrides[agentSlug] || "anthropic/claude-haiku-4-5";
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

  // Security: Explicit plugin allowlist
  config.plugins ??= {};
  if (!config.plugins.allow || !Array.isArray(config.plugins.allow)) {
    config.plugins.allow = ["mattermost", "octogee-router"];
    changed = true;
    log("Set plugins.allow = ['mattermost', 'octogee-router']");
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
  config.plugins.entries["octogee-router"] ??= {};
  config.plugins.entries["octogee-router"].config ??= {};

  if (changed) writeOpenClawConfig(config);
}

// ── Enforcement Overrides ───────────────────────────────────────────────────────

export async function syncEnforcementOverrides(): Promise<void> {
  const snap = await db
    .collection("users")
    .where("provisioning.openclaw.status", "==", "complete")
    .get();

  const overrides: Record<string, string> = {};
  for (const doc of snap.docs) {
    const data = doc.data();
    const slug = data.provisioning?.openclaw?.slug;
    const enforcement = data.faceBrainEnforcement;
    if (slug && enforcement && ["off", "observe", "soft", "hard"].includes(enforcement)) {
      if (enforcement !== "observe") {
        overrides[slug] = enforcement;
      }
    }
  }

  const config = readOpenClawConfig();
  config.plugins ??= {};
  config.plugins.entries ??= {};
  config.plugins.entries["octogee-router"] ??= {};
  config.plugins.entries["octogee-router"].config ??= {};

  const current = config.plugins.entries["octogee-router"].config.enforcementOverrides ?? {};
  if (JSON.stringify(overrides) !== JSON.stringify(current)) {
    config.plugins.entries["octogee-router"].config.enforcementOverrides = overrides;
    writeOpenClawConfig(config);
    const entries = Object.entries(overrides);
    log(`enforcement: synced overrides — ${entries.length ? entries.map(([s, e]) => `${s}=${e}`).join(", ") : "(all observe)"}`);
  }
}

// ── Brain Gating ─────────────────────────────────────────────────────────────────

/**
 * Sync brain-gated slugs from Firestore to router plugin config.
 * Free-tier users can't spawn Brain sub-agents.
 */
export async function syncBrainGatedSlugs(): Promise<void> {
  const snap = await db
    .collection("users")
    .where("provisioning.openclaw.status", "==", "complete")
    .where("tier", "==", "free")
    .get();

  const brainGatedSlugs: string[] = [];
  for (const doc of snap.docs) {
    const slug = doc.data().provisioning?.openclaw?.slug;
    if (slug) brainGatedSlugs.push(slug);
  }

  const config = readOpenClawConfig();
  config.plugins ??= {};
  config.plugins.entries ??= {};
  config.plugins.entries["octogee-router"] ??= {};
  config.plugins.entries["octogee-router"].config ??= {};

  const current = config.plugins.entries["octogee-router"].config.brainGatedSlugs ?? [];
  if (JSON.stringify(brainGatedSlugs.sort()) !== JSON.stringify([...current].sort())) {
    config.plugins.entries["octogee-router"].config.brainGatedSlugs = brainGatedSlugs;
    writeOpenClawConfig(config);
    log(`brain-gating: synced ${brainGatedSlugs.length} slug(s) — ${brainGatedSlugs.join(", ") || "(none)"}`);
  }
}

// ── Model Overrides (Face + Brain Knobs) ────────────────────────────────────────

/**
 * Sync per-customer Face and Brain model overrides from Firestore.
 *
 * Firestore fields (on user doc):
 *   faceModel  — e.g. "anthropic/claude-sonnet-4-6" (overrides default Haiku)
 *   brainModel — e.g. "anthropic/claude-opus-4-6" (overrides default Sonnet)
 *
 * Written to router plugin config as:
 *   faceModelOverrides:  { "slug": "anthropic/claude-sonnet-4-6" }
 *   brainModelOverrides: { "slug": "anthropic/claude-opus-4-6" }
 *
 * ensureGatewayDefaults() reads faceModelOverrides to set agent.model.
 * The router plugin reads brainModelOverrides when spawning Brain sub-agents.
 *
 * Operator-visible trade-off: only customers with a NON-default model get
 * an override entry. Provisioning a new customer on default models does
 * NOT add a key → no full gateway restart. The first Ops-Dashboard flip
 * from default → custom for a given customer DOES add a key → one full
 * restart. Every subsequent edit on that customer is a value change →
 * hot reload. This is the right trade-off because provisioning is the
 * more common path.
 */
export async function syncModelOverrides(): Promise<void> {
  const snap = await db
    .collection("users")
    .where("provisioning.openclaw.status", "==", "complete")
    .get();

  // Only write overrides for customers who have opted into a non-default
  // model. Writing defaults for every customer triggers OpenClaw's config
  // reload to see a new key under plugins.entries.*.config.* on first
  // provisioning, which requires a FULL gateway restart. Customers on the
  // shipped defaults don't need an override entry — `ensureGatewayDefaults`
  // already falls back to the default when the slug key is absent.
  //
  // Trade-off: the first Ops-Dashboard switch from default → custom for a
  // given customer becomes a key-addition (full restart), while every
  // subsequent tweak on the same customer is a value change (hot reload).
  // Provisioning no longer costs a restart, which is the more common path.
  const DEFAULT_FACE_MODEL = "anthropic/claude-haiku-4-5";
  const DEFAULT_BRAIN_MODEL = "anthropic/claude-sonnet-4-6";
  const faceOverrides: Record<string, string> = {};
  const brainOverrides: Record<string, string> = {};

  for (const doc of snap.docs) {
    const data = doc.data();
    const slug = data.provisioning?.openclaw?.slug;
    if (!slug) continue;

    if (typeof data.faceModel === "string" && data.faceModel && data.faceModel !== DEFAULT_FACE_MODEL) {
      faceOverrides[slug] = data.faceModel;
    }
    if (typeof data.brainModel === "string" && data.brainModel && data.brainModel !== DEFAULT_BRAIN_MODEL) {
      brainOverrides[slug] = data.brainModel;
    }
  }

  const config = readOpenClawConfig();
  config.plugins ??= {};
  config.plugins.entries ??= {};
  config.plugins.entries["octogee-router"] ??= {};
  config.plugins.entries["octogee-router"].config ??= {};

  const currentFace = config.plugins.entries["octogee-router"].config.faceModelOverrides ?? {};
  const currentBrain = config.plugins.entries["octogee-router"].config.brainModelOverrides ?? {};

  let changed = false;

  if (JSON.stringify(faceOverrides) !== JSON.stringify(currentFace)) {
    config.plugins.entries["octogee-router"].config.faceModelOverrides = faceOverrides;
    changed = true;
  }

  if (JSON.stringify(brainOverrides) !== JSON.stringify(currentBrain)) {
    config.plugins.entries["octogee-router"].config.brainModelOverrides = brainOverrides;
    changed = true;
  }

  if (changed) {
    writeOpenClawConfig(config);

    // Also update agent models for face overrides (ensureGatewayDefaults reads from config,
    // but we need to apply immediately when overrides change at runtime)
    for (const agent of config.agents?.list ?? []) {
      if (!/^octogee-.+-coach$/.test(agent.id)) continue;
      const agentSlug = agent.id.replace(/^octogee-/, "").replace(/-coach$/, "");
      const targetModel = faceOverrides[agentSlug] || "anthropic/claude-haiku-4-5";
      if (agent.model !== targetModel) {
        log(`model-override: ${agent.id} face → ${targetModel}`);
        agent.model = targetModel;
      }
    }
    if (Object.keys(faceOverrides).length > 0 || Object.keys(brainOverrides).length > 0) {
      writeOpenClawConfig(config);
    }

    // Log only non-default entries so the line stays readable at scale.
    const faceCustom = Object.entries(faceOverrides).filter(([, m]) => m !== DEFAULT_FACE_MODEL);
    const brainCustom = Object.entries(brainOverrides).filter(([, m]) => m !== DEFAULT_BRAIN_MODEL);
    const parts: string[] = [];
    if (faceCustom.length) parts.push(`face: ${faceCustom.map(([s, m]) => `${s}=${m.split("/").pop()}`).join(", ")}`);
    if (brainCustom.length) parts.push(`brain: ${brainCustom.map(([s, m]) => `${s}=${m.split("/").pop()}`).join(", ")}`);
    log(`model-overrides: ${parts.length ? parts.join(" | ") : "(all defaults)"} (seeded ${Object.keys(faceOverrides).length} slug(s))`);
  }
}

// ── Wait for Gateway ────────────────────────────────────────────────────────────

/** Injectable seam for tests — defaults to the real implementation. */
export interface WaitForGatewayDeps {
  /** Probe implementation: returns true when the gateway is RPC-ready. */
  probe: (timeoutMs: number) => Promise<boolean>;
  /** Sleep for `ms` — overrideable so tests don't actually wait. */
  sleep: (ms: number) => Promise<void>;
  /** Milliseconds budget options. Pinned on the call for tests. */
  maxWaitMs?: number;
  pollMs?: number;
  probeBudgetMs?: number;
}

/**
 * Block until the OpenClaw gateway can actually service RPC calls — not just
 * return HTTP 200 on GET /.
 *
 * The previous HTTP-GET probe returned true as soon as Express bound to
 * 18789, which can happen tens of seconds before OpenClaw finishes loading
 * plugins + channels. On the April 16 TEST deploy this let the provisioner
 * race the gateway's boot: it started provisioning `cke123`, called
 * `config.patch` RPC, and the server took 21.4s to answer `config.get`
 * because plugin init was still blocking the event loop. The 10s client
 * timeout fired first, the provisioner fell back to file-write, and the
 * chokidar watcher wasn't fully armed yet so `[cke123-coach] starting
 * channel` never fired — the coach stayed offline until pod restart.
 *
 * The fix: probe `rpc.isGatewayUp()` (a full connect-handshake + cheap
 * `channels.status` roundtrip). That doesn't return true until the RPC
 * subsystem is actually serving — plugins loaded, handlers registered,
 * event loop not pinned on init work. Uses `createGatewayRpc`'s
 * `openclaw.json` token fallback so it works without env-var plumbing.
 */
export async function waitForGateway(deps?: Partial<WaitForGatewayDeps>): Promise<void> {
  const maxWaitMs = deps?.maxWaitMs ?? 120_000;
  const pollMs = deps?.pollMs ?? 3_000;
  // Budget per-probe tightly so we don't pin a full timeout on every slow
  // startup probe. If the gateway is truly busy (plugins loading), the
  // probe returns false fast and we retry.
  const probeBudgetMs = deps?.probeBudgetMs ?? 2_500;
  const sleep = deps?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  // Default probe: real RPC client. Tests inject a stub.
  let rpc: { isGatewayUp(ms?: number): Promise<boolean>; close(): Promise<void> } | undefined;
  const probe =
    deps?.probe ??
    (async (timeoutMs: number) => {
      if (!rpc) {
        const { createGatewayRpc } = await import("./gateway-rpc.js");
        rpc = createGatewayRpc({
          connectTimeoutMs: probeBudgetMs,
          callTimeoutMs: probeBudgetMs,
        });
      }
      return rpc.isGatewayUp(timeoutMs);
    });

  const start = Date.now();
  log("Waiting for OpenClaw gateway RPC to be ready...");

  try {
    while (Date.now() - start < maxWaitMs) {
      if (await probe(probeBudgetMs)) {
        const elapsed = Math.round((Date.now() - start) / 1000);
        log(`✅ Gateway is ready — RPC responding (${elapsed}s)`);
        return;
      }
      await sleep(pollMs);
    }
  } finally {
    if (rpc) await rpc.close();
  }

  log("⚠ Gateway RPC probe timed out — proceeding anyway");
}
