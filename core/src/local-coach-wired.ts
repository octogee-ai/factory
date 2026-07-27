import * as fs from "node:fs";
import * as path from "node:path";
import {
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  USERNAME_RE,
} from "@octogee/shared/types/identity";

// Firestore-free local view of which customers this pod hosts with a wired coach.
// An operator pod holds NO platform credentials, so it derives its own mounted set
// from the PVC + the openclaw config rather than reading gateways/{id} from Firestore
// (which 403s). Single-sourced here so the fleet pull-reporting (fleet-local-migration-
// adapter, PR #1431) and the chat-proxy coach reconcile can't drift.
// See docs/decisions/DECISIONS.md ("Operator-gateway site deploys" / zero-credential pod).

// Mirrors customerCoachAgentId in fleet-http-migration.ts — the coach agent-id convention.
// Inlined to keep this module node:fs-only (importable into gateway-edge + scripts alike).
const customerCoachAgentId = (slug: string): string => `octogee-${slug}-coach`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Slug validity = the shared username contract (USERNAME_RE + 2..24 length), single-sourced —
// a local copy of this regex had drifted to a 3-char minimum, making valid 2-char customers
// invisible to the observers below (never mounted-reported, never evicted). USERNAME_RE matches
// only [a-z0-9] + single hyphens, so it also rules out path traversal (no ., /, \).
function isSafeSlug(value: string): boolean {
  return (
    value.length >= USERNAME_MIN_LENGTH &&
    value.length <= USERNAME_MAX_LENGTH &&
    USERNAME_RE.test(value)
  );
}

function isMattermostAccountBinding(binding: unknown, agentId: string, accountId: string): boolean {
  if (!isRecord(binding) || binding.agentId !== agentId || !isRecord(binding.match)) return false;
  return binding.match.channel === "mattermost" && binding.match.accountId === accountId;
}

export interface OpenclawConfig {
  agents?: { list?: Array<unknown>; entries?: Record<string, unknown> };
  channels?: { mattermost?: { accounts?: Record<string, unknown> } };
  bindings?: Array<unknown>;
}

/** Read + parse the openclaw config once; null on any read/parse failure. */
export function readOpenclawConfig(configPath: string): OpenclawConfig | null {
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf-8")) as OpenclawConfig;
  } catch {
    return null;
  }
}

/**
 * True iff `slug`'s coach is fully wired in an already-parsed config: its coach
 * agent is in `agents.list` or keyed `agents.entries`, its `{slug}-coach` Mattermost account exists, and
 * a Mattermost binding references both the coach agent and that account. Pure:
 * callers that check many slugs parse the config once (see readOpenclawConfig).
 */
export function coachWiredInParsedConfig(config: OpenclawConfig, slug: string): boolean {
  if (!isSafeSlug(slug)) return false;
  const agentId = customerCoachAgentId(slug);
  const accountId = `${slug}-coach`;
  const agents = config.agents?.list;
  const entries = config.agents?.entries;
  const accounts = config.channels?.mattermost?.accounts;
  const bindings = config.bindings;
  return Boolean(
    (isRecord(entries)
      ? Object.prototype.hasOwnProperty.call(entries, agentId)
      : Array.isArray(agents) && agents.some((entry) => isRecord(entry) && entry.id === agentId)) &&
      accounts &&
      Object.prototype.hasOwnProperty.call(accounts, accountId) &&
      Array.isArray(bindings) &&
      bindings.some((binding) => isMattermostAccountBinding(binding, agentId, accountId)),
  );
}

/** Convenience single-slug check (reads + parses the config per call). */
export function customerCoachWiredInOpenclawConfig(configPath: string, slug: string): boolean {
  const config = readOpenclawConfig(configPath);
  return config ? coachWiredInParsedConfig(config, slug) : false;
}

// The mount-completion marker the reconcile's mount direction keys off (vs bare coach-wiring)
// to close the post-config wedge. Single-writer: a pod earns its own marker as ensure's last
// step. It must not be INHERITED, or it falsely marks an incomplete mount done. Two inheritance
// paths are blocked: (1) Gitea — it lives under .system/, which workspaceGitignore() excludes,
// so a roll's re-clone never carries it; (2) migration — writeMigratingInPin clears it on
// import, so the target re-earns it after cutover. See DECISIONS.md "Fleet placement is a
// level-triggered reconcile".
const MOUNTED_MARKER_REL = path.join(".system", ".mounted");

function mountedMarkerPath(customersDir: string, slug: string): string {
  return path.join(customersDir, slug, MOUNTED_MARKER_REL);
}

/** True iff the slug's mount-completion marker is present (the LAST step a successful
 *  ensure writes). Never throws — an absent dir/marker is simply false. */
export function hasMountedMarker(customersDir: string, slug: string): boolean {
  return fs.existsSync(mountedMarkerPath(customersDir, slug));
}

/** Stamp the mount-completion marker — the LAST step of a successful ensure, written only
 *  after the customer is fully provisioned. Ensures .system/ exists first. */
export function writeMountedMarker(customersDir: string, slug: string): void {
  const markerPath = mountedMarkerPath(customersDir, slug);
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(markerPath, "");
}

// The migrating-in pin guards a freshly-imported customer (coach-wired on the target before
// cutover makes it desired-there) from the reconcile's EVICT direction only. Time-bounded by
// mtime so it needs no explicit clear (post-cutover the slug is desired anyway; a failed-
// migration orphan self-expires for lazy eviction). Under .system/.
const MIGRATING_IN_MARKER_REL = path.join(".system", ".migrating-in");

// Also keep a process-local TTL pin. During restore, cloneWorkspaceRepo intentionally removes
// and recreates customers/<slug>, which can erase the disk pin while the reconcile loop is
// still running. The process pin covers that short same-pod window; the disk pin remains the
// restart/health signal.
const migratingInProcessPins = new Map<string, { root: string; slug: string; atMs: number }>();

function migratingInPinPath(customersDir: string, slug: string): string {
  return path.join(customersDir, slug, MIGRATING_IN_MARKER_REL);
}

function processPinKey(customersDir: string, slug: string): string {
  return `${path.resolve(customersDir)}\0${slug}`;
}

function pruneAndCheckProcessPin(customersDir: string, slug: string, ttlMs: number): boolean {
  const key = processPinKey(customersDir, slug);
  const pin = migratingInProcessPins.get(key);
  if (!pin) return false;
  if (Date.now() - pin.atMs < ttlMs) return true;
  migratingInProcessPins.delete(key);
  return false;
}

function listProcessPinnedSlugs(customersDir: string, ttlMs: number): string[] {
  const root = path.resolve(customersDir);
  const slugs: string[] = [];
  for (const [key, pin] of migratingInProcessPins) {
    if (pin.root !== root) continue;
    if (Date.now() - pin.atMs >= ttlMs) {
      migratingInProcessPins.delete(key);
      continue;
    }
    if (isSafeSlug(pin.slug)) slugs.push(pin.slug);
  }
  return slugs;
}

export function _resetMigratingInProcessPinsForTests(): void {
  migratingInProcessPins.clear();
}

/** True iff a migrating-in pin exists for the slug AND is newer than ttlMs. Never throws. */
export function isMigratingInPinned(customersDir: string, slug: string, ttlMs: number): boolean {
  if (pruneAndCheckProcessPin(customersDir, slug, ttlMs)) return true;
  try {
    const ageMs = Date.now() - fs.statSync(migratingInPinPath(customersDir, slug)).mtimeMs;
    return ageMs < ttlMs;
  } catch {
    return false;
  }
}

/**
 * Stamp the migrating-in pin (import handler, before activation). Ensures .system/ exists.
 * Also clears any .mounted marker that rode in on the migration tarball: an import is NOT a
 * completed mount on THIS pod, so the target must re-earn its own marker after cutover rather
 * than inherit the source's — keeping .mounted single-writer (a pod's own ensure) and the
 * post-config wedge guard intact.
 */
export function writeMigratingInPin(customersDir: string, slug: string): void {
  const root = path.resolve(customersDir);
  const pinPath = migratingInPinPath(customersDir, slug);
  fs.mkdirSync(path.dirname(pinPath), { recursive: true });
  fs.rmSync(mountedMarkerPath(customersDir, slug), { force: true });
  fs.writeFileSync(pinPath, "");
  migratingInProcessPins.set(processPinKey(customersDir, slug), { root, slug, atMs: Date.now() });
}

/**
 * On-disk customer dirs with a fresh migrating-in pin. Reported via the gateway's /health so
 * Cowboy's operator-gateway poller skips them as eviction candidates while a migration is
 * importing-but-not-yet-cut-over (the operator path has no in-pod reconcile, so Cowboy drives
 * eviction off /health — without this it would drain a fresh import pre-cutover).
 */
export function listMigratingInSlugs(customersDir: string, ttlMs: number): string[] {
  const slugs = new Set<string>(listProcessPinnedSlugs(customersDir, ttlMs));
  for (const slug of listLocalCustomerDirs(customersDir)) {
    if (isMigratingInPinned(customersDir, slug, ttlMs)) slugs.add(slug);
  }
  return [...slugs].sort((a, b) => a.localeCompare(b));
}

/**
 * Raw on-disk customer dirs (safe-slug-named directories under customersDir), WITHOUT the
 * coach-wired filter. The reconcile's evict direction observes this — so a partial/junk dir
 * left by a mount that died before its config patch is still drained once it's unassigned
 * (coach-wired presence would never see it). Never throws — a missing dir is [].
 */
export function listLocalCustomerDirs(customersDir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(customersDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter(isSafeSlug)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * The pod's honest mounted set, read WITHOUT Firestore: customer dirs present on the
 * PVC whose coach is wired. Cowboy polls this via /health and intersects it with the
 * assigned roster on the trusted side; the chat-proxy uses it to reconcile coaches.
 */
export function listLocalCoachWiredSlugs(
  customersDir: string,
  isCoachWired: (slug: string) => boolean,
): string[] {
  return listLocalCustomerDirs(customersDir).filter((slug) => isCoachWired(slug));
}
