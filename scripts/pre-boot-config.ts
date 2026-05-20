import * as fs from "fs";
import * as path from "path";
import {
  restoreByosubForAgents,
  agentIdsFromConfig,
} from "./lib/byosub-restore.js";

const OPENCLAW_DIR = process.env.HOME
  ? path.join(process.env.HOME, ".openclaw")
  : "/home/node/.openclaw";
const CONFIG_PATH = path.join(OPENCLAW_DIR, "openclaw.json");

const STALE_ROUTER_CONFIG_KEYS = [
  "advisorySlugs",
  "enforcementOverrides",
  "brainGatedSlugs",
  "faceModelOverrides",
  "brainModelOverrides",
];

function log(msg: string): void {
  const ts = new Date().toISOString().replace("Z", "+00:00");
  console.log(`${ts} [pre-boot] ${msg}`);
}

/**
 * Mutate `config` in place to bring it in line with gateway policy. Pure:
 * no I/O, no `process.env` reads — env is a parameter so tests can pass
 * synthetic envs without touching the real one. Returns whether anything
 * was changed; the caller decides whether to write back to disk.
 *
 * The order of patches mirrors the original inline implementation so the
 * log lines remain in the historical order operators are used to.
 */
export function applyPreBootPatches(
  config: any,
  env: NodeJS.ProcessEnv,
  logFn: (msg: string) => void = () => {},
): boolean {
  let changed = false;

  // Matches the default of a fresh `openclaw` install. Gateway policy
  // wins — a drifted value is reset to "coding" on next boot, same shape
  // as commands.native below.
  config.tools ??= {};
  if (config.tools.profile !== "coding") {
    config.tools.profile = "coding";
    changed = true;
    logFn(`set tools.profile=coding (gateway policy: openclaw "coding" defaults)`);
  }

  // REMOVED 2026-05-01: gateway.controlPlane.writeRateLimit
  // Was bumping the upstream control-plane write rate-limit (3-per-60s) to
  // 60-per-60s. The bump only worked when paired with our fork patch that
  // exposed the field as a config knob; that fork patch was dropped at the
  // v2026.4.29 roll-forward (never deployed in production, surgical reload
  // kept actual config.patch traffic well below the 3-per-60s cap on TEST).
  // Upstream still hard-codes the limit, so writing the field here is dead
  // drift — openclaw.json carried an unknown key on every boot. Bring this
  // back when (a) the upstream rate limit becomes a real bottleneck again
  // and (b) the field becomes configurable upstream or back on our fork.

  // F&F: the router has no runtime-tweakable config. All per-customer knobs
  // (enforcementOverrides, faceModelOverrides, brainModelOverrides,
  // brainGatedSlugs) were removed because every Firestore-driven write hit
  // `plugins.entries.octogee-router.config.*` → the default `plugins.*`
  // restart rule → fleet-wide MM WS bounce on every signup. Router runs on
  // built-in defaults (observe mode, no gating). Bring the knobs back via
  // applyConfigPatch + a plugin-scoped hotPrefixes declaration post-F&F.
  if (env.OCTOGEE_ROUTER_ENABLED === "false") {
    if (config.plugins?.allow && Array.isArray(config.plugins.allow)) {
      const before = config.plugins.allow.length;
      config.plugins.allow = config.plugins.allow.filter(
        (id: string) => id !== "octogee-router",
      );
      if (config.plugins.allow.length !== before) changed = true;
    }
    if (config.plugins?.entries?.["octogee-router"]) {
      delete config.plugins.entries["octogee-router"];
      changed = true;
      logFn("removed octogee-router from config because OCTOGEE_ROUTER_ENABLED=false");
    }
  } else {
    // Clean up any stale plugin config keys. These entries are harmless at
    // runtime (the router reads them with `?? {}` defaults) but leaving
    // them in the file means future `config.patch` diffs flag noise — and
    // when the knob returns, a stale shape could shadow fresh values.
    const pluginCfg = config.plugins?.entries?.["octogee-router"]?.config;
    if (pluginCfg && typeof pluginCfg === "object") {
      for (const key of STALE_ROUTER_CONFIG_KEYS) {
        if (pluginCfg[key] !== undefined) {
          delete pluginCfg[key];
          changed = true;
          logFn(`removed stale ${key} from octogee-router config (F&F: runtime syncs disabled)`);
        }
      }
    }
  }

  // Secret-rotation reconciliation: if MM_BOT_TOKEN in env differs from
  // what's on disk (k8s secret rotated since last boot), update in place.
  // Canonical location is `channels.mattermost.accounts.default.botToken`
  // (matches the template; no longer writes top-level `botToken` / `token`
  // legacy fields — OpenClaw reads from the accounts map).
  const envBotToken = env.MM_BOT_TOKEN;
  const envMmUrl = env.MM_URL;
  if (config.channels?.mattermost) {
    const mm = config.channels.mattermost;
    if (envBotToken) {
      mm.accounts ??= {};
      mm.accounts.default ??= {};
      if (mm.accounts.default.botToken !== envBotToken) {
        mm.accounts.default.botToken = envBotToken;
        changed = true;
        logFn(`MM bot token synced into accounts.default from MM_BOT_TOKEN env var`);
      }
    }
    if (envMmUrl && mm.baseUrl !== envMmUrl) {
      mm.baseUrl = envMmUrl;
      changed = true;
      logFn(`MM baseUrl synced from MM_URL env var: ${envMmUrl}`);
    }

    // Force native slash commands OFF.
    // Octogee users talk to Octo in natural language — we don't use native
    // MM slash commands (/help, /info, etc.). Leaving `commands.native` at
    // its OpenClaw default ("auto", which historically resolves false but
    // can be flipped to true by plugin capabilities) means the MM monitor
    // registers 5+ slash commands across every team on every account mount.
    // On reconnect (which happens every ~2-4 min due to upstream ping
    // dynamics) that's 50-100+ serial HTTP calls to MM per cycle — enough
    // event-loop load to miss the next WS ping window and cascade. Set both
    // channel-level and per-account `commands.native: false` so the early-
    // return in monitor-slash.ts:150-151 fires and skips the whole dance.
    mm.commands ??= {};
    if (mm.commands.native !== false) {
      mm.commands.native = false;
      changed = true;
      logFn(`forced channels.mattermost.commands.native=false (slash commands disabled)`);
    }
    // Per-account override too — monitor-slash.ts reads
    // `params.account.config.commands` which may or may not inherit from
    // the channel level depending on the plugin's resolution strategy.
    // Belt-and-suspenders: pin it on every existing account.
    if (mm.accounts && typeof mm.accounts === "object") {
      for (const [accountId, account] of Object.entries(mm.accounts as Record<string, any>)) {
        if (!account || typeof account !== "object") continue;
        account.commands ??= {};
        if (account.commands.native !== false) {
          account.commands.native = false;
          changed = true;
          logFn(`forced commands.native=false on accounts.${accountId}`);
        }
      }
    }
  }

  return changed;
}

const SECRET_BEARING_KEYS = new Set([
  "apiKey",
  "key",
  "token",
  "secret",
  "password",
  "botToken",
]);

// keyRef/tokenRef are SecretRef *objects*; a string value is an inline secret.
const SECRETREF_OBJECT_KEYS = new Set(["keyRef", "tokenRef"]);

// Computed assignment of these keys can poison Object.prototype.
const PROTO_POLLUTION_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * Reject a slow/unreachable promise so a degraded dependency cannot stall
 * the boot path. Caller treats rejection as "proceed without it".
 */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
  });
  return Promise.race([p.finally(() => clearTimeout(timer)), timeout]);
}

function stripInlineSecrets(
  node: unknown,
  pathLabel: string,
  logFn: (msg: string) => void,
): void {
  if (!isPlainObject(node)) return;
  for (const key of Object.keys(node)) {
    if (PROTO_POLLUTION_KEYS.has(key)) {
      Reflect.deleteProperty(node, key);
      logFn(`dropped unsafe key ${pathLabel}.${key} (prototype pollution)`);
      continue;
    }
    const val = Reflect.get(node, key);
    const secretBearing =
      SECRET_BEARING_KEYS.has(key) || SECRETREF_OBJECT_KEYS.has(key);
    if (secretBearing && typeof val === "string") {
      Reflect.deleteProperty(node, key);
      logFn(
        `dropped inline plaintext secret at ${pathLabel}.${key} — per-gateway overrides must reference Secret Manager via keyRef/tokenRef/SecretRef`,
      );
      continue;
    }
    if (val && typeof val === "object") {
      stripInlineSecrets(val, `${pathLabel}.${key}`, logFn);
    }
  }
}

function valueEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function deepMergeInto(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): boolean {
  let changed = false;
  for (const [key, sv] of Object.entries(source)) {
    if (PROTO_POLLUTION_KEYS.has(key)) continue;
    const tv = Reflect.get(target, key);
    if (isPlainObject(sv) && isPlainObject(tv)) {
      if (deepMergeInto(tv, sv)) changed = true;
    } else if (!Reflect.has(target, key) || !valueEqual(tv, sv)) {
      Reflect.set(target, key, sv);
      changed = true;
    }
  }
  return changed;
}

/**
 * Deep-merge a per-gateway `openclawOverrides` blob into the rendered
 * config. Pure: no I/O, no env. Arrays replace (not concat). Inline
 * plaintext secrets are stripped + logged. Caller runs this before
 * applyPreBootPatches so gateway policy wins. Design:
 * docs/specs/PER-GATEWAY-CONFIG-SPEC.md.
 */
export function applyGatewayOverrides(
  config: Record<string, unknown>,
  overrides: unknown,
  logFn: (msg: string) => void = () => {},
): boolean {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    return false;
  }
  const sanitized = structuredClone(overrides) as Record<string, unknown>;
  stripInlineSecrets(sanitized, "openclawOverrides", logFn);
  if (Object.keys(sanitized).length === 0) return false;
  return deepMergeInto(config, sanitized);
}

// ── Phase 1: ~/.gitconfig first-boot hydration ───────────────────────
// Every Builder needs `git` to Just Work on their gateway pod — name,
// email, autoSetupRemote, default branch — without an operator runbook
// step. Octogee already has the identity in Firebase Auth; this seam
// writes it. Contract: NEVER FAILS (smart defaults cascade through
// every gap), idempotent (existing file is left alone — operator wins),
// boot-safe (no throw, even on Firestore outage / disk full).
//
// Multi-tenant cattle gets a generic identity here so commits don't fail;
// per-agent isolation via `GIT_CONFIG_GLOBAL` per agent is Phase 2 — see
// BYO-SUBSCRIPTION-OAUTH-SPEC §2a Plane 2.

const FALLBACK_NAME = "Octogee Builder";
const FALLBACK_EMAIL_DOMAIN = "users.noreply.octogee.com";
const FALLBACK_GENERIC_LOCAL = "builder";

/**
 * Pure: inverse of `coachAgentId(slug)` (scripts/lib/byosub-onboarding.ts).
 * Returns the canonical workspace slug for a coach agent id, or null
 * when the id doesn't match the platform naming.
 */
export function slugFromCoachAgentId(agentId: string): string | null {
  const m = /^octogee-(.+)-coach$/.exec(agentId);
  return m ? m[1] : null;
}

/**
 * Pure: returns the single workspace slug present in the agent set, or
 * null when there are zero or multiple distinct slugs (multi-tenant
 * cattle, ops-only gateway, fresh gateway). Callers branch on null to
 * decide between "real Builder identity" and "generic gateway identity."
 */
export function pickSoleTenantSlug(agentIds: readonly string[]): string | null {
  const slugs = new Set<string>();
  for (const id of agentIds) {
    const slug = slugFromCoachAgentId(id);
    if (slug) slugs.add(slug);
  }
  return slugs.size === 1 ? [...slugs][0] : null;
}

// C0 control chars + DEL. A `\n` in a Firebase Auth displayName would let
// the value inject a new gitconfig section ("Chris\n[user]\nname = Evil")
// → either a malicious foothold or a corrupted file that breaks `git`.
// Strip them defensively at the boundary; an empty result is treated as
// nullish so the fallback cascade fires.
// eslint-disable-next-line no-control-regex -- matching control chars is the entire point: strip them to prevent gitconfig section injection via \n in displayName.
const SAFE_GITCONFIG_VALUE_RE = /[\x00-\x1F\x7F]/g;

function safeOrNull(v: string | undefined | null): string | null {
  if (typeof v !== "string") return null;
  const cleaned = v.replace(SAFE_GITCONFIG_VALUE_RE, "").trim();
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Pure: resolve a gitconfig-safe `{name, email}` from whatever's
 * available — never throws, never returns empty/whitespace/control-char
 * fields. All inputs are stripped of C0 control characters before the
 * cascade so a `\n` in `displayName` can't inject a section. Cascade:
 *  - Firebase Auth `displayName + email` (best, the canonical source)
 *  - `displayName` + slug-derived noreply email
 *  - slug-derived name + Firebase `email`
 *  - slug-derived name + slug-derived noreply email
 *  - generic `Octogee Builder` + generic noreply
 */
function resolveGitIdentity(input: {
  user: { displayName?: string; email?: string } | null;
  slug: string | null;
}): { name: string; email: string } {
  const cleanName = safeOrNull(input.user?.displayName);
  const cleanEmail = safeOrNull(input.user?.email);
  const cleanSlug = safeOrNull(input.slug);
  const name = cleanName ?? cleanSlug ?? FALLBACK_NAME;
  const email =
    cleanEmail ??
    (cleanSlug
      ? `${cleanSlug}@${FALLBACK_EMAIL_DOMAIN}`
      : `${FALLBACK_GENERIC_LOCAL}@${FALLBACK_EMAIL_DOMAIN}`);
  return { name, email };
}

/**
 * Pure: build the gitconfig file content from a resolved identity. This
 * is the first-boot seed — the comment header tells operators they can
 * edit it freely; pre-boot only writes the file when it doesn't exist.
 */
export function buildGitconfigContent(identity: {
  name: string;
  email: string;
}): string {
  return [
    "# Octogee-managed first-boot gitconfig seed.",
    "# Subsequent boots leave this file alone — edit freely.",
    "[user]",
    `\tname = ${identity.name}`,
    `\temail = ${identity.email}`,
    "[push]",
    "\tautoSetupRemote = true",
    "[init]",
    "\tdefaultBranch = main",
    "",
  ].join("\n");
}

/**
 * Orchestrator: first-boot seed of `~/.gitconfig` with smart defaults.
 * Never throws — boot must not be blocked by Firestore drift, partial
 * user data, or a write failure. Idempotent — an existing file is the
 * "operator owns this" signal.
 *
 * Returns `true` iff a file was written.
 */
export async function hydrateGitIdentity(deps: {
  gitconfigPath: string;
  agentIds: readonly string[];
  fetchUserBySlug: (
    slug: string,
  ) => Promise<{ displayName?: string; email?: string } | null>;
  fileExists: (p: string) => boolean;
  writeFile: (p: string, content: string) => void;
  logFn?: (msg: string) => void;
}): Promise<boolean> {
  const log = deps.logFn ?? (() => {});

  // A throwing fileExists must not break the "never throws" contract;
  // treat the failure as "couldn't tell, assume absent" — at worst we
  // overwrite a file that turned out to exist, which is no worse than
  // the file never existing in the first place (first-boot seed).
  let alreadyPresent = false;
  try {
    alreadyPresent = deps.fileExists(deps.gitconfigPath);
  } catch (e) {
    log(
      `gitconfig: fileExists check threw — treating as absent and proceeding: ${(e as Error).message}`,
    );
  }
  if (alreadyPresent) {
    return false;
  }

  const slug = pickSoleTenantSlug(deps.agentIds);
  let user: { displayName?: string; email?: string } | null = null;
  if (slug) {
    try {
      user = await deps.fetchUserBySlug(slug);
    } catch (e) {
      log(
        `gitconfig: firestore lookup for slug=${slug} failed, using fallback identity — ${(e as Error).message}`,
      );
    }
  }

  const identity = resolveGitIdentity({ user, slug });
  const content = buildGitconfigContent(identity);

  try {
    deps.writeFile(deps.gitconfigPath, content);
    log(
      `gitconfig: seeded ${deps.gitconfigPath} for ${identity.name} <${identity.email}>${
        slug ? ` (slug=${slug})` : " (no single tenant — generic identity)"
      }`,
    );
    return true;
  } catch (e) {
    log(
      `WARN: failed to write ${deps.gitconfigPath} — ${(e as Error).message} (boot continues)`,
    );
    return false;
  }
}

async function applyGlmDesiredState(
  config: Record<string, unknown>,
  logFn: (msg: string) => void,
): Promise<boolean> {
  const gatewayId = process.env.GATEWAY_ID;
  if (!gatewayId) return false;
  let overridesChanged = false;
  try {
    const { db } = await import("./lib/firebase.js");
    const snap = await withTimeout(
      db.collection("glmGateways").doc(gatewayId).get(),
      4000,
    );
    const data = snap.exists
      ? (snap.data() as
          | {
              openclawOverrides?: unknown;
              byosub?: Record<
                string,
                { provider: "openai" | "anthropic"; secretName: string }
              >;
            }
          | undefined)
      : undefined;
    if (data?.openclawOverrides) {
      overridesChanged = applyGatewayOverrides(
        config,
        data.openclawOverrides,
        logFn,
      );
      if (overridesChanged) {
        logFn(`applied openclawOverrides from glmGateways/${gatewayId}`);
      }
    }
    const { readSecret } = await import("./lib/secret-manager.js");
    // Per-fetch 4s bound caps boot latency under tenancy; a timeout falls
    // to the catch → WARN, boot continues.
    const r = await restoreByosubForAgents({
      agentIds: agentIdsFromConfig(config),
      byosub: data?.byosub,
      openclawDir: OPENCLAW_DIR,
      fetchSecret: (name) => withTimeout(readSecret(name), 4000),
      logFn,
    });
    if (r.planned > 0) {
      logFn(
        `byosub: restore complete for glmGateways/${gatewayId} — ${r.restored} restored, ${r.failed} failed`,
      );
    }
  } catch (e) {
    logFn(
      `WARN: could not fetch/apply glmGateways/${gatewayId} openclawOverrides/byosub — booting on template + policy only: ${(e as Error).message}`,
    );
  }
  return overridesChanged;
}

async function main(): Promise<void> {
  // Read config in try/catch rather than existsSync-then-read — avoids
  // TOCTOU (CodeQL js/file-system-race). The writeFileSync later in this
  // function also needs this file to exist, and reading it up front means
  // we short-circuit on ENOENT before opening a Firestore connection.
  let configRaw: string;
  try {
    configRaw = fs.readFileSync(CONFIG_PATH, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      log("No openclaw.json found — skipping pre-boot config");
      return;
    }
    throw e;
  }
  const config = JSON.parse(configRaw);

  const overridesChanged = await applyGlmDesiredState(config, log);

  const policyChanged = applyPreBootPatches(config, process.env, log);

  if (overridesChanged || policyChanged) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
    log("openclaw.json patched (per-gateway overrides / env / stale-key cleanup)");
  } else {
    log("no changes needed");
  }

  // First-boot ~/.gitconfig seed. Separate try/catch — a failure here
  // never blocks openclaw start. Runs after openclaw.json work because
  // we read the agent set from the parsed config.
  try {
    const homeDir = process.env.HOME ?? "/home/node";
    const gitconfigPath = path.join(homeDir, ".gitconfig");
    const { db } = await import("./lib/firebase.js");
    await hydrateGitIdentity({
      gitconfigPath,
      agentIds: agentIdsFromConfig(config),
      fetchUserBySlug: async (slug) => {
        // Try the canonical post-provision field first, then fall back
        // to `username` for legacy/partial user docs (mirrors the
        // resolution doctrine in scripts/lib/workspace-slugs.ts and
        // scripts/ops/fleet.ts findUserBySlug).
        const tryByField = async (
          field: string,
        ): Promise<{ displayName?: string; email?: string } | null> => {
          const snap = await withTimeout(
            db.collection("users").where(field, "==", slug).limit(1).get(),
            4000,
          );
          if (snap.empty) return null;
          const d = snap.docs[0].data() as Record<string, unknown>;
          return {
            displayName:
              typeof d.displayName === "string" ? d.displayName : undefined,
            email: typeof d.email === "string" ? d.email : undefined,
          };
        };
        return (
          (await tryByField("provisioning.openclaw.slug")) ??
          (await tryByField("username"))
        );
      },
      fileExists: (p) => {
        try {
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- p is path.join(HOME, ".gitconfig"), trusted-internal
          fs.statSync(p);
          return true;
        } catch {
          return false;
        }
      },
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- p is path.join(HOME, ".gitconfig"), trusted-internal
      writeFile: (p, c) => fs.writeFileSync(p, c, { mode: 0o644 }),
      logFn: log,
    });
  } catch (e) {
    log(
      `WARN: gitconfig hydration step failed — ${(e as Error).message} (boot continues)`,
    );
  }
}

// Only run main() when this file is the entrypoint, not when imported by
// tests. ESM doesn't have `require.main === module`; we check process.argv.
const isEntrypoint = process.argv[1] && process.argv[1].endsWith("pre-boot-config.ts") || process.argv[1]?.endsWith("pre-boot-config.js");
if (isEntrypoint) {
  main().catch((err) => {
    // Non-fatal — provisioner will handle it on boot
    console.error(`[pre-boot] Warning: ${err.message}`);
    process.exit(0); // Don't block gateway startup
  });
}
