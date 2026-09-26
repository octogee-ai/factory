import { slugFromAssignedUser } from "@octogee/core/assigned-roster";
import {
  GATEWAY_KEY_TITLE,
  gatewayKeyOwnerId,
  gatewayKeyTitle,
  giteaUsername,
  isManagedGatewayKeyTitle,
} from "@octogee/core/gitea-naming";
import { podBelongsToGateway } from "@octogee/core/gateway-live-release";
import { gatewayVmPodName } from "@octogee/shared/types/glm";

import type { GatewayPodDiagnostics } from "./lib/kube-ops.js";

export const GITEA_PAGE_SIZE = 50;

export type GiteaGatewayKeyGcMode = "dry-run" | "enforce";

export function parseGiteaGatewayKeyGcMode(
  raw: string | undefined,
  envName = "GITEA_GATEWAY_KEY_GC_MODE",
): GiteaGatewayKeyGcMode {
  if (raw === "dry-run" || raw === "enforce") return raw;
  throw new Error(`${envName} must be dry-run or enforce (got ${raw ?? "<unset>"})`);
}

export interface GiteaPublicKeyRecord {
  id: number;
  title: string;
  key: string;
  createdAt: number | null;
}

export interface GiteaKeyAdmin {
  listUsernames(page: number): Promise<string[]>;
  listUserKeys(username: string, page: number): Promise<GiteaPublicKeyRecord[]>;
  deleteUserKey(username: string, keyId: number): Promise<boolean>;
}

export interface LiveKeyHolders {
  owners: ReadonlySet<string>;
  ownersByUsername: ReadonlyMap<string, ReadonlySet<string>>;
  legacyBlocked: string | null;
}

export interface GiteaGatewayKeyGcDeps {
  gitea: GiteaKeyAdmin;
  readLiveKeyHolders: () => Promise<LiveKeyHolders>;
  mode: GiteaGatewayKeyGcMode;
  legacyMode: GiteaGatewayKeyGcMode;
  maxCallsPerTick: number;
  minCallIntervalMs: number;
  graceMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (message: string) => void;
}

export interface UserKeyCensus {
  username: string;
  managed: number;
  live: number;
  legacy: number;
  young: number;
  stale: number;
  deleted: number;
  legacyStale: number;
  legacyDeleted: number;
}

interface SweepPass {
  usernames: string[];
  next: number;
  totals: Omit<UserKeyCensus, "username">;
}

export interface GiteaGatewayKeyGcState {
  pass: SweepPass | null;
  lastCallAt: number | null;
}

export interface GiteaGatewayKeyGcTickResult {
  users: UserKeyCensus[];
  passCompleted: boolean;
  calls: number;
}

type KeyClass = "unmanaged" | "live" | "legacy" | "young" | "stale";

export function createGiteaGatewayKeyGcState(): GiteaGatewayKeyGcState {
  return { pass: null, lastCallAt: null };
}

function emptyTotals(): Omit<UserKeyCensus, "username"> {
  return { managed: 0, live: 0, legacy: 0, young: 0, stale: 0, deleted: 0, legacyStale: 0, legacyDeleted: 0 };
}

function publicKeyIdentity(pubKey: string): string {
  return pubKey.trim().split(/\s+/u).slice(0, 2).join(" ");
}

function classifyKey(key: GiteaPublicKeyRecord, liveTitles: ReadonlySet<string>, cutoff: number): KeyClass {
  if (!isManagedGatewayKeyTitle(key.title)) return "unmanaged";
  if (liveTitles.has(key.title)) return "live";
  if (key.title === GATEWAY_KEY_TITLE || key.title === gatewayKeyTitle(publicKeyIdentity(key.key))) {
    return "legacy";
  }
  if (key.createdAt === null || key.createdAt > cutoff) return "young";
  return "stale";
}

function createPacer(deps: GiteaGatewayKeyGcDeps, state: GiteaGatewayKeyGcState) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    get remaining() {
      return deps.maxCallsPerTick - calls;
    },
    async call<T>(fn: () => Promise<T>): Promise<T> {
      if (state.lastCallAt !== null) {
        const wait = state.lastCallAt + deps.minCallIntervalMs - deps.now();
        if (wait > 0) await deps.sleep(wait);
      }
      calls += 1;
      try {
        return await fn();
      } finally {
        state.lastCallAt = deps.now();
      }
    },
  };
}

type Pacer = ReturnType<typeof createPacer>;

async function readAllPages<T>(pacer: Pacer, readPage: (page: number) => Promise<T[]>): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; ; page += 1) {
    const pageItems = await pacer.call(() => readPage(page));
    items.push(...pageItems);
    if (pageItems.length < GITEA_PAGE_SIZE) return items;
  }
}

function censusLine(census: Omit<UserKeyCensus, "username">): string {
  return `managed=${census.managed} live=${census.live} legacy=${census.legacy} young=${census.young} stale=${census.stale} deleted=${census.deleted} legacyStale=${census.legacyStale} legacyDeleted=${census.legacyDeleted}`;
}

function modesLine(deps: GiteaGatewayKeyGcDeps): string {
  return `(${deps.mode}, legacy ${deps.legacyMode})`;
}

interface LegacyPlan {
  deletable: GiteaPublicKeyRecord[];
  blocked: string | null;
}

function missingHolderKeys(
  username: string,
  keys: readonly GiteaPublicKeyRecord[],
  holders: LiveKeyHolders,
): string[] {
  const titles = new Set(keys.map((key) => key.title));
  const required = holders.ownersByUsername.get(username) ?? new Set<string>();
  return [...required].filter((owner) => !titles.has(gatewayKeyTitle(owner))).sort();
}

function planLegacyDeletion(
  username: string,
  keys: readonly GiteaPublicKeyRecord[],
  classes: ReadonlyMap<GiteaPublicKeyRecord, KeyClass>,
  holders: LiveKeyHolders,
  cutoff: number,
): LegacyPlan {
  if (holders.legacyBlocked !== null) return { deletable: [], blocked: holders.legacyBlocked };
  if (!username.startsWith(giteaUsername(""))) return { deletable: [], blocked: "not a Builder user" };
  const missing = missingHolderKeys(username, keys, holders);
  if (missing.length > 0) return { deletable: [], blocked: `live holders without an owner key: ${missing.join(",")}` };
  const liveMaterial = new Set(
    keys.filter((key) => classes.get(key) === "live").map((key) => publicKeyIdentity(key.key)),
  );
  const deletable = keys.filter(
    (key) =>
      classes.get(key) === "legacy" &&
      key.createdAt !== null &&
      key.createdAt <= cutoff &&
      !liveMaterial.has(publicKeyIdentity(key.key)),
  );
  return { deletable, blocked: null };
}

async function deleteKeys(
  deps: GiteaGatewayKeyGcDeps,
  pacer: Pacer,
  username: string,
  keys: readonly GiteaPublicKeyRecord[],
): Promise<number> {
  let deleted = 0;
  for (const key of keys) {
    if (pacer.remaining < 1) break;
    if (await pacer.call(() => deps.gitea.deleteUserKey(username, key.id))) deleted += 1;
  }
  return deleted;
}

function shouldLogUser(deps: GiteaGatewayKeyGcDeps, census: UserKeyCensus, legacyBlocked: string | null): boolean {
  if (census.managed === 0) return false;
  if (deps.mode === "dry-run" || deps.legacyMode === "dry-run") return true;
  return census.stale > 0 || census.legacyStale > 0 || (census.legacy > 0 && legacyBlocked !== null);
}

async function sweepUser(
  deps: GiteaGatewayKeyGcDeps,
  pacer: Pacer,
  username: string,
  snapshot: TickSnapshot,
): Promise<{ census: UserKeyCensus; finished: boolean }> {
  const keys = await readAllPages(pacer, (page) => deps.gitea.listUserKeys(username, page));
  const census: UserKeyCensus = { username, ...emptyTotals() };
  const classes = new Map<GiteaPublicKeyRecord, KeyClass>();
  for (const key of keys) {
    const keyClass = classifyKey(key, snapshot.liveTitles, snapshot.cutoff);
    classes.set(key, keyClass);
    if (keyClass === "unmanaged") continue;
    census.managed += 1;
    census[keyClass] += 1;
  }
  const legacy = planLegacyDeletion(username, keys, classes, snapshot.holders, snapshot.cutoff);
  census.legacyStale = legacy.deletable.length;
  if (deps.mode === "enforce") {
    census.deleted = await deleteKeys(deps, pacer, username, keys.filter((key) => classes.get(key) === "stale"));
  }
  const staleFinished = deps.mode === "dry-run" || census.deleted === census.stale;
  if (staleFinished && deps.legacyMode === "enforce") {
    census.legacyDeleted = await deleteKeys(deps, pacer, username, legacy.deletable);
  }
  const finished = staleFinished && (deps.legacyMode === "dry-run" || census.legacyDeleted === census.legacyStale);
  if (shouldLogUser(deps, census, legacy.blocked)) {
    const blocked = legacy.blocked !== null && census.legacy > 0 ? ` legacyBlocked="${legacy.blocked}"` : "";
    deps.log(`[gitea-key-gc] ${username} ${censusLine(census)}${blocked} ${modesLine(deps)}`);
  }
  return { census, finished };
}

interface TickSnapshot {
  holders: LiveKeyHolders;
  liveTitles: ReadonlySet<string>;
  cutoff: number;
}

function addCensus(totals: Omit<UserKeyCensus, "username">, census: UserKeyCensus, finished: boolean): void {
  totals.deleted += census.deleted;
  totals.legacyDeleted += census.legacyDeleted;
  if (!finished) return;
  totals.legacyStale += census.legacyStale;
  totals.managed += census.managed;
  totals.live += census.live;
  totals.legacy += census.legacy;
  totals.young += census.young;
  totals.stale += census.stale;
}

async function startPass(pacer: Pacer, deps: GiteaGatewayKeyGcDeps): Promise<SweepPass> {
  const usernames = await readAllPages(pacer, (page) => deps.gitea.listUsernames(page));
  return { usernames, next: 0, totals: emptyTotals() };
}

export async function runGiteaGatewayKeyGcTick(
  deps: GiteaGatewayKeyGcDeps,
  state: GiteaGatewayKeyGcState,
): Promise<GiteaGatewayKeyGcTickResult> {
  const snapshotAt = deps.now();
  const holders = await deps.readLiveKeyHolders();
  const snapshot: TickSnapshot = {
    holders,
    liveTitles: new Set([...holders.owners].map((owner) => gatewayKeyTitle(owner))),
    cutoff: snapshotAt - deps.graceMs,
  };
  const pacer = createPacer(deps, state);
  state.pass ??= await startPass(pacer, deps);
  const pass = state.pass;
  const users: UserKeyCensus[] = [];

  while (pass.next < pass.usernames.length && pacer.remaining > 0) {
    const username = pass.usernames[pass.next];
    const { census, finished } = await sweepUser(deps, pacer, username, snapshot);
    users.push(census);
    addCensus(pass.totals, census, finished);
    if (!finished) break;
    pass.next += 1;
  }

  const passCompleted = pass.next >= pass.usernames.length;
  if (passCompleted) {
    deps.log(
      `[gitea-key-gc] pass complete users=${pass.usernames.length} ${censusLine(pass.totals)} ${modesLine(deps)}`,
    );
    state.pass = null;
  }
  return { users, passCompleted, calls: pacer.calls };
}

interface OwnerSourceDoc {
  id: string;
  data(): Record<string, unknown> | undefined;
}

export interface LiveGatewayOwnerSources {
  users: readonly OwnerSourceDoc[];
  runningMigrations: readonly OwnerSourceDoc[];
  gateways: readonly OwnerSourceDoc[];
  glmGateways: readonly OwnerSourceDoc[];
  readGatewayPodDiagnosticsBatch: (
    gatewayIds: readonly string[],
  ) => Promise<Record<string, GatewayPodDiagnostics>>;
}

function vmOwner(doc: OwnerSourceDoc): { gatewayId: string; owner: string } | null {
  const data = doc.data();
  const vm = data?.vm as { instanceId?: unknown } | null | undefined;
  const instanceId = vm?.instanceId;
  if (typeof instanceId !== "string" || !/^\d+$/u.test(instanceId)) return null;
  const gatewayId = typeof data?.gatewayId === "string" ? data.gatewayId : doc.id;
  return { gatewayId, owner: gatewayKeyOwnerId(gatewayId, gatewayVmPodName(gatewayId, instanceId)) };
}

async function readOwnersByGateway(sources: LiveGatewayOwnerSources): Promise<Map<string, Set<string>>> {
  const gatewayIds = new Set<string>();
  for (const doc of [...sources.gateways, ...sources.glmGateways]) {
    gatewayIds.add(doc.id);
    const gatewayId = doc.data()?.gatewayId;
    if (typeof gatewayId === "string" && gatewayId) gatewayIds.add(gatewayId);
  }
  const ids = [...gatewayIds].sort();
  const diagnostics = await sources.readGatewayPodDiagnosticsBatch(ids);
  const ownersByGateway = new Map<string, Set<string>>();
  const addOwner = (gatewayId: string, owner: string) => {
    const owners = ownersByGateway.get(gatewayId) ?? new Set<string>();
    owners.add(owner);
    ownersByGateway.set(gatewayId, owners);
  };
  for (const instanceId of ids) {
    const observed = diagnostics[instanceId];
    if (!observed || observed.status === "unknown") {
      throw new Error(
        `gateway pod liveness is unknown for ${instanceId}: ${observed?.error ?? "not observed"}`,
      );
    }
    for (const pod of observed.pods) {
      for (const gatewayId of ids) {
        if (podBelongsToGateway(gatewayId, pod.name)) addOwner(gatewayId, gatewayKeyOwnerId(gatewayId, pod.name));
      }
    }
  }
  for (const doc of sources.glmGateways) {
    const vm = vmOwner(doc);
    if (vm) addOwner(vm.gatewayId, vm.owner);
  }
  return ownersByGateway;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

interface BuilderGateways {
  gatewaysBySlug: Map<string, Set<string>>;
  legacyBlocked: string | null;
}

type Place = (slug: string, gatewayId: string | null) => void;

function placeAssignedBuilders(sources: LiveGatewayOwnerSources, place: Place): Map<string, string> {
  const slugByUid = new Map<string, string>();
  for (const doc of sources.users) {
    const data = doc.data();
    const slug = slugFromAssignedUser(data);
    if (!slug) continue;
    slugByUid.set(doc.id, slug);
    const openclaw = (data?.provisioning as { openclaw?: { gatewayId?: unknown } } | undefined)?.openclaw;
    place(slug, stringField(openclaw?.gatewayId));
  }
  for (const doc of [...sources.gateways, ...sources.glmGateways]) {
    const data = doc.data();
    const slug = stringField(data?.builderSlug);
    if (slug) place(slug, stringField(data?.gatewayId) ?? doc.id);
  }
  return slugByUid;
}

function placeMigratingBuilders(
  sources: LiveGatewayOwnerSources,
  slugByUid: ReadonlyMap<string, string>,
  place: Place,
): string[] {
  const unattributed: string[] = [];
  for (const doc of sources.runningMigrations) {
    const input = doc.data()?.input as { uid?: unknown; fromGatewayId?: unknown; toGatewayId?: unknown } | undefined;
    const uid = stringField(input?.uid);
    const slug = uid ? slugByUid.get(uid) : undefined;
    if (!slug) {
      unattributed.push(doc.id);
      continue;
    }
    place(slug, stringField(input?.fromGatewayId));
    place(slug, stringField(input?.toGatewayId));
  }
  return unattributed.sort();
}

function builderGateways(sources: LiveGatewayOwnerSources): BuilderGateways {
  const gatewaysBySlug = new Map<string, Set<string>>();
  const place: Place = (slug, gatewayId) => {
    if (!gatewayId) return;
    const gateways = gatewaysBySlug.get(slug) ?? new Set<string>();
    gateways.add(gatewayId);
    gatewaysBySlug.set(slug, gateways);
  };
  const slugByUid = placeAssignedBuilders(sources, place);
  const unattributed = placeMigratingBuilders(sources, slugByUid, place);
  const legacyBlocked = unattributed.length > 0
    ? `running migrations name no known Builder: ${unattributed.join(",")}`
    : null;
  return { gatewaysBySlug, legacyBlocked };
}

export async function readLiveGatewayKeyHolders(sources: LiveGatewayOwnerSources): Promise<LiveKeyHolders> {
  const ownersByGateway = await readOwnersByGateway(sources);
  const owners = new Set([...ownersByGateway.values()].flatMap((held) => [...held]));
  const { gatewaysBySlug, legacyBlocked } = builderGateways(sources);
  const ownersByUsername = new Map<string, Set<string>>();
  for (const [slug, gatewayIds] of gatewaysBySlug) {
    const held = [...gatewayIds].flatMap((gatewayId) => [...(ownersByGateway.get(gatewayId) ?? [])]);
    if (held.length > 0) ownersByUsername.set(giteaUsername(slug), new Set(held));
  }
  return { owners, ownersByUsername, legacyBlocked };
}

export interface GiteaKeyAdminClientDeps {
  apiUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}

function parseCreatedAt(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toKeyRecord(raw: unknown): GiteaPublicKeyRecord {
  const key = raw as { id?: unknown; title?: unknown; key?: unknown; created_at?: unknown };
  if (typeof key.id !== "number" || typeof key.title !== "string" || typeof key.key !== "string") {
    throw new Error("gitea list keys returned a key without id, title, or key");
  }
  return { id: key.id, title: key.title, key: key.key, createdAt: parseCreatedAt(key.created_at) };
}

function toUsername(raw: unknown): string {
  const login = (raw as { login?: unknown }).login;
  if (typeof login !== "string" || !login) throw new Error("gitea list users returned a user without login");
  return login;
}

export function createGiteaKeyAdminClient(deps: GiteaKeyAdminClientDeps): GiteaKeyAdmin {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const headers = { Authorization: `token ${deps.token}`, Accept: "application/json" };

  async function getArray(path: string, op: string): Promise<unknown[]> {
    const resp = await fetchImpl(`${deps.apiUrl}${path}`, { method: "GET", headers });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`gitea ${op} failed: ${resp.status} ${body.slice(0, 200)}`);
    }
    const json: unknown = await resp.json();
    if (!Array.isArray(json)) throw new Error(`gitea ${op} failed: response is not an array`);
    return json;
  }

  return {
    async listUsernames(page) {
      const users = await getArray(`/admin/users?limit=${GITEA_PAGE_SIZE}&page=${page}`, "list users");
      return users.map(toUsername);
    },
    async listUserKeys(username, page) {
      const keys = await getArray(
        `/users/${encodeURIComponent(username)}/keys?limit=${GITEA_PAGE_SIZE}&page=${page}`,
        `list keys for ${username}`,
      );
      return keys.map(toKeyRecord);
    },
    async deleteUserKey(username, keyId) {
      const resp = await fetchImpl(
        `${deps.apiUrl}/admin/users/${encodeURIComponent(username)}/keys/${keyId}`,
        { method: "DELETE", headers },
      );
      if (resp.status === 404) return false;
      if (resp.ok) return true;
      const body = await resp.text().catch(() => "");
      throw new Error(`gitea delete key ${keyId} for ${username} failed: ${resp.status} ${body.slice(0, 200)}`);
    },
  };
}

export interface StartGiteaGatewayKeyGcDeps extends GiteaGatewayKeyGcDeps {
  intervalMs: number;
  runTick?: typeof runGiteaGatewayKeyGcTick;
}

export function startGiteaGatewayKeyGc(deps: StartGiteaGatewayKeyGcDeps): () => void {
  const tick = deps.runTick ?? runGiteaGatewayKeyGcTick;
  const state = createGiteaGatewayKeyGcState();
  let stopped = false;
  let running = false;
  const timer = setInterval(() => {
    if (stopped || running) return;
    running = true;
    (async () => {
      try {
        await tick(deps, state);
      } catch (err) {
        deps.log(`[gitea-key-gc] ⚠ tick failed — ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        running = false;
      }
    })();
  }, deps.intervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
