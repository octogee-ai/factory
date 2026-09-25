import {
  GATEWAY_KEY_TITLE,
  gatewayKeyOwnerId,
  gatewayKeyTitle,
  isManagedGatewayKeyTitle,
} from "@octogee/core/gitea-naming";
import { podBelongsToGateway } from "@octogee/core/gateway-live-release";
import { gatewayVmPodName } from "@octogee/shared/types/glm";

import type { GatewayPodDiagnostics } from "./lib/kube-ops.js";

export const GITEA_PAGE_SIZE = 50;

export type GiteaGatewayKeyGcMode = "dry-run" | "enforce";

export function parseGiteaGatewayKeyGcMode(raw: string | undefined): GiteaGatewayKeyGcMode {
  if (raw === "dry-run" || raw === "enforce") return raw;
  throw new Error(`GITEA_GATEWAY_KEY_GC_MODE must be dry-run or enforce (got ${raw ?? "<unset>"})`);
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

export interface GiteaGatewayKeyGcDeps {
  gitea: GiteaKeyAdmin;
  readLiveOwnerIds: () => Promise<ReadonlySet<string>>;
  mode: GiteaGatewayKeyGcMode;
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
  return { managed: 0, live: 0, legacy: 0, young: 0, stale: 0, deleted: 0 };
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
  return `managed=${census.managed} live=${census.live} legacy=${census.legacy} young=${census.young} stale=${census.stale} deleted=${census.deleted}`;
}

async function sweepUser(
  deps: GiteaGatewayKeyGcDeps,
  pacer: Pacer,
  username: string,
  liveTitles: ReadonlySet<string>,
  cutoff: number,
): Promise<{ census: UserKeyCensus; finished: boolean }> {
  const keys = await readAllPages(pacer, (page) => deps.gitea.listUserKeys(username, page));
  const census: UserKeyCensus = { username, ...emptyTotals() };
  const stale: GiteaPublicKeyRecord[] = [];
  for (const key of keys) {
    const keyClass = classifyKey(key, liveTitles, cutoff);
    if (keyClass === "unmanaged") continue;
    census.managed += 1;
    census[keyClass] += 1;
    if (keyClass === "stale") stale.push(key);
  }
  if (deps.mode === "enforce") {
    for (const key of stale) {
      if (pacer.remaining < 1) break;
      if (await pacer.call(() => deps.gitea.deleteUserKey(username, key.id))) census.deleted += 1;
    }
  }
  const finished = deps.mode === "dry-run" || census.deleted === census.stale;
  if (census.managed > 0 && (deps.mode === "dry-run" || census.stale > 0)) {
    deps.log(`[gitea-key-gc] ${username} ${censusLine(census)} (${deps.mode})`);
  }
  return { census, finished };
}

function addCensus(totals: Omit<UserKeyCensus, "username">, census: UserKeyCensus, finished: boolean): void {
  totals.deleted += census.deleted;
  if (!finished) return;
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
  const liveOwners = await deps.readLiveOwnerIds();
  const liveTitles = new Set([...liveOwners].map((owner) => gatewayKeyTitle(owner)));
  const cutoff = snapshotAt - deps.graceMs;
  const pacer = createPacer(deps, state);
  state.pass ??= await startPass(pacer, deps);
  const pass = state.pass;
  const users: UserKeyCensus[] = [];

  while (pass.next < pass.usernames.length && pacer.remaining > 0) {
    const username = pass.usernames[pass.next];
    const { census, finished } = await sweepUser(deps, pacer, username, liveTitles, cutoff);
    users.push(census);
    addCensus(pass.totals, census, finished);
    if (!finished) break;
    pass.next += 1;
  }

  const passCompleted = pass.next >= pass.usernames.length;
  if (passCompleted) {
    deps.log(
      `[gitea-key-gc] pass complete users=${pass.usernames.length} ${censusLine(pass.totals)} (${deps.mode})`,
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
  gateways: readonly OwnerSourceDoc[];
  glmGateways: readonly OwnerSourceDoc[];
  readGatewayPodDiagnosticsBatch: (
    gatewayIds: readonly string[],
  ) => Promise<Record<string, GatewayPodDiagnostics>>;
}

function vmOwnerId(doc: OwnerSourceDoc): string | null {
  const data = doc.data();
  const vm = data?.vm as { instanceId?: unknown } | null | undefined;
  const instanceId = vm?.instanceId;
  if (typeof instanceId !== "string" || !/^\d+$/u.test(instanceId)) return null;
  const gatewayId = typeof data?.gatewayId === "string" ? data.gatewayId : doc.id;
  return gatewayKeyOwnerId(gatewayId, gatewayVmPodName(gatewayId, instanceId));
}

export async function readLiveGatewayOwnerIds(sources: LiveGatewayOwnerSources): Promise<Set<string>> {
  const gatewayIds = new Set<string>();
  for (const doc of [...sources.gateways, ...sources.glmGateways]) {
    gatewayIds.add(doc.id);
    const gatewayId = doc.data()?.gatewayId;
    if (typeof gatewayId === "string" && gatewayId) gatewayIds.add(gatewayId);
  }
  const ids = [...gatewayIds].sort();
  const diagnostics = await sources.readGatewayPodDiagnosticsBatch(ids);
  const owners = new Set<string>();
  for (const instanceId of ids) {
    const observed = diagnostics[instanceId];
    if (!observed || observed.status === "unknown") {
      throw new Error(
        `gateway pod liveness is unknown for ${instanceId}: ${observed?.error ?? "not observed"}`,
      );
    }
    for (const pod of observed.pods) {
      for (const gatewayId of ids) {
        if (podBelongsToGateway(gatewayId, pod.name)) owners.add(gatewayKeyOwnerId(gatewayId, pod.name));
      }
    }
  }
  for (const doc of sources.glmGateways) {
    const owner = vmOwnerId(doc);
    if (owner) owners.add(owner);
  }
  return owners;
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
