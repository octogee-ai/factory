import { describe, expect, it, vi } from "vitest";

import { gatewayKeyOwnerId, gatewayKeyTitle } from "../gitea-naming.js";
import {
  createGiteaKeyAdminClient,
  runGiteaKeySweep,
  type GiteaKeyAdmin,
  type GiteaKeySweepDeps,
  type GiteaPublicKeyRecord,
} from "./gitea-key-sweep.js";
import { createGitKeySweepState } from "./types.js";

const NOW = Date.parse("2026-09-25T22:00:00Z");
const HOUR = 60 * 60 * 1000;
const LIVE_OWNER = gatewayKeyOwnerId("shared-0", "octogee-gateway-shared-0-7d9f-abcde");
const DEAD_OWNER = gatewayKeyOwnerId("shared-0", "octogee-gateway-shared-0-7d9f-zzzzz");

function managedKey(id: number, owner: string, createdAt: number | null = NOW - 48 * HOUR): GiteaPublicKeyRecord {
  return { id, title: gatewayKeyTitle(owner), key: `ssh-ed25519 KEY${id} octogee@gateway`, createdAt };
}

class FakeGitea implements GiteaKeyAdmin {
  readonly deleted: Array<{ username: string; id: number }> = [];
  calls = 0;

  constructor(readonly keys: Map<string, GiteaPublicKeyRecord[]>) {}

  async listUsernames(page: number): Promise<string[]> {
    this.calls += 1;
    return page === 1 ? [...this.keys.keys()] : [];
  }

  async listUserKeys(username: string, page: number): Promise<GiteaPublicKeyRecord[]> {
    this.calls += 1;
    return (this.keys.get(username) ?? []).slice((page - 1) * 50, page * 50);
  }

  async deleteUserKey(username: string, keyId: number): Promise<boolean> {
    this.calls += 1;
    const keys = this.keys.get(username) ?? [];
    const index = keys.findIndex((key) => key.id === keyId);
    if (index === -1) return false;
    keys.splice(index, 1);
    this.deleted.push({ username, id: keyId });
    return true;
  }
}

function holders(owners: string[]) {
  return { owners: new Set(owners) };
}

function legacyKey(id: number, material: string, createdAt: number | null = NOW - 90 * 24 * HOUR): GiteaPublicKeyRecord {
  const key = `ssh-ed25519 ${material} octogee@gateway`;
  return { id, title: id % 2 === 0 ? "octogee-gateway" : gatewayKeyTitle(`ssh-ed25519 ${material}`), key, createdAt };
}

function deps(
  gitea: GiteaKeyAdmin,
  overrides: Partial<GiteaKeySweepDeps> = {},
): GiteaKeySweepDeps & { logs: string[]; sleeps: number[] } {
  const logs: string[] = [];
  const sleeps: number[] = [];
  return {
    gitea,
    readLiveKeyHolders: async () => holders([LIVE_OWNER]),
    mode: "enforce",
    maxCallsPerTick: 1000,
    minCallIntervalMs: 0,
    graceMs: HOUR,
    now: () => NOW,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    log: (message) => logs.push(message),
    logs,
    sleeps,
    ...overrides,
  };
}

describe("runGiteaKeySweep", () => {
  it("deletes managed keys that are stale or legacy and predate the grace window, keeping live, young, and user keys", async () => {
    const userKey = { id: 1, title: "my laptop", key: "ssh-ed25519 LAPTOP", createdAt: NOW - 90 * 24 * HOUR };
    const bareLegacy = { id: 2, title: "octogee-gateway", key: "ssh-ed25519 BARE", createdAt: NOW - 90 * 24 * HOUR };
    const pubKeyTitled = {
      id: 3,
      title: gatewayKeyTitle("ssh-ed25519 PUBTITLED"),
      key: "ssh-ed25519 PUBTITLED octogee-acme@gateway",
      createdAt: NOW - 90 * 24 * HOUR,
    };
    const live = managedKey(4, LIVE_OWNER);
    const stale = managedKey(5, DEAD_OWNER);
    const young = managedKey(6, gatewayKeyOwnerId("shared-1", "octogee-gateway-shared-1-new"), NOW - 5 * 60 * 1000);
    const undated = managedKey(7, gatewayKeyOwnerId("shared-2", "octogee-gateway-shared-2-x"), null);
    const gitea = new FakeGitea(new Map([
      ["ws-jack", [userKey, bareLegacy, pubKeyTitled, live, stale, young, undated]],
    ]));
    const state = createGitKeySweepState();

    const result = await runGiteaKeySweep(deps(gitea), state);

    expect(gitea.deleted).toEqual([
      { username: "ws-jack", id: 5 },
      { username: "ws-jack", id: 2 },
      { username: "ws-jack", id: 3 },
    ]);
    expect(result.users).toEqual([
      { username: "ws-jack", managed: 6, live: 1, legacy: 2, young: 2, stale: 1, deleted: 1, legacyStale: 2, legacyDeleted: 2 },
    ]);
    expect(result.passCompleted).toBe(true);
    expect(state.pass).toBeNull();
  });

  it("reports per-user counts in dry-run without deleting anything", async () => {
    const gitea = new FakeGitea(new Map([
      ["ws-jack", [managedKey(1, LIVE_OWNER), managedKey(2, DEAD_OWNER), managedKey(3, "gone/pod")]],
      ["ws-empty", []],
    ]));
    const d = deps(gitea, { mode: "dry-run" });

    const result = await runGiteaKeySweep(d, createGitKeySweepState());

    expect(gitea.deleted).toEqual([]);
    expect(result.users).toEqual([
      { username: "ws-jack", managed: 3, live: 1, legacy: 0, young: 0, stale: 2, deleted: 0, legacyStale: 0, legacyDeleted: 0 },
      { username: "ws-empty", managed: 0, live: 0, legacy: 0, young: 0, stale: 0, deleted: 0, legacyStale: 0, legacyDeleted: 0 },
    ]);
    expect(d.logs.some((line) => line.includes("ws-jack") && line.includes("stale=2") && line.includes("dry-run"))).toBe(true);
    expect(d.logs.some((line) => line.includes("pass complete") && line.includes("stale=2"))).toBe(true);
  });

  it("spreads a large backlog over ticks within the per-tick Gitea call budget", async () => {
    const backlog = Array.from({ length: 120 }, (_, index) => managedKey(index + 10, `dead/${index}`));
    const gitea = new FakeGitea(new Map([
      ["ws-jack", [managedKey(1, LIVE_OWNER), ...backlog]],
      ["ws-jill", [managedKey(2, DEAD_OWNER)]],
    ]));
    const state = createGitKeySweepState();
    const d = deps(gitea, { maxCallsPerTick: 40 });

    const first = await runGiteaKeySweep(d, state);
    expect(first.calls).toBeLessThanOrEqual(40);
    expect(first.passCompleted).toBe(false);
    expect(gitea.deleted.length).toBeGreaterThan(0);

    let ticks = 1;
    while (state.pass !== null && ticks < 20) {
      const result = await runGiteaKeySweep(d, state);
      expect(result.calls).toBeLessThanOrEqual(40);
      ticks += 1;
    }

    expect(state.pass).toBeNull();
    expect(gitea.keys.get("ws-jack")).toEqual([managedKey(1, LIVE_OWNER)]);
    expect(gitea.keys.get("ws-jill")).toEqual([]);
    expect(ticks).toBeGreaterThan(3);
  });

  it("paces consecutive Gitea calls at least the minimum interval apart", async () => {
    let clock = NOW;
    const gitea = new FakeGitea(new Map([["ws-jack", [managedKey(2, DEAD_OWNER), managedKey(3, "gone/pod")]]]));
    const d = deps(gitea, {
      minCallIntervalMs: 250,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    const callTimes: number[] = [];
    const original = gitea.deleteUserKey.bind(gitea);
    gitea.deleteUserKey = async (username, id) => {
      callTimes.push(clock);
      return original(username, id);
    };

    await runGiteaKeySweep(d, createGitKeySweepState());

    expect(callTimes).toHaveLength(2);
    expect(callTimes[1] - callTimes[0]).toBeGreaterThanOrEqual(250);
  });

  it("deletes nothing when gateway liveness cannot be read", async () => {
    const gitea = new FakeGitea(new Map([["ws-jack", [managedKey(2, DEAD_OWNER)]]]));
    const d = deps(gitea, {
      readLiveKeyHolders: async () => {
        throw new Error("kubectl get gateway pods failed");
      },
    });

    await expect(runGiteaKeySweep(d, createGitKeySweepState())).rejects.toThrow(
      /kubectl get gateway pods failed/,
    );
    expect(gitea.deleted).toEqual([]);
  });

  it("keeps a key registered after the liveness snapshot even when its owner is not yet observed", async () => {
    const gitea = new FakeGitea(new Map([
      ["ws-jack", [managedKey(2, "surge-3/octogee-gateway-surge-3-new", NOW - 30 * 60 * 1000)]],
    ]));

    await runGiteaKeySweep(deps(gitea), createGitKeySweepState());

    expect(gitea.deleted).toEqual([]);
  });
});

describe("runGiteaKeySweep legacy keys", () => {
  it("deletes old legacy keys whose key material no live gateway holds after stale owner keys", async () => {
    const live = managedKey(1, LIVE_OWNER);
    const userAdded = { id: 2, title: "my laptop", key: "ssh-ed25519 LAPTOP", createdAt: NOW - 90 * 24 * HOUR };
    const oldBare = legacyKey(4, "OLDBARE");
    const oldPubTitled = legacyKey(5, "OLDPUB");
    const youngLegacy = legacyKey(6, "YOUNG", NOW - 30 * 60 * 1000);
    const undatedLegacy = legacyKey(8, "UNDATED", null);
    const heldLegacy = { ...legacyKey(10, "SHARED"), key: live.key };
    const staleOwnerKey = managedKey(11, DEAD_OWNER);
    const gitea = new FakeGitea(new Map([
      ["ws-jack", [live, userAdded, oldBare, oldPubTitled, youngLegacy, undatedLegacy, heldLegacy, staleOwnerKey]],
    ]));
    const d = deps(gitea);

    const result = await runGiteaKeySweep(d, createGitKeySweepState());

    expect(gitea.deleted).toEqual([
      { username: "ws-jack", id: 11 },
      { username: "ws-jack", id: 4 },
      { username: "ws-jack", id: 5 },
    ]);
    expect(result.users[0]).toMatchObject({ legacy: 5, legacyStale: 2, legacyDeleted: 2, stale: 1, deleted: 1 });
    expect(d.logs.some((line) => line.includes("ws-jack") && line.includes("legacyDeleted=2"))).toBe(true);
    expect(result.passCompleted).toBe(true);
  });

  it("deletes a user's old legacy keys even while a live gateway has not registered its owner key", async () => {
    const otherLiveOwner = gatewayKeyOwnerId("shared-0", "octogee-gateway-shared-0-7d9f-other");
    const gitea = new FakeGitea(new Map([
      ["ws-jill", [managedKey(1, LIVE_OWNER), legacyKey(4, "OLDBARE"), legacyKey(5, "OLDPUB")]],
    ]));
    const d = deps(gitea, { readLiveKeyHolders: async () => holders([LIVE_OWNER, otherLiveOwner]) });

    await runGiteaKeySweep(d, createGitKeySweepState());

    expect(gitea.deleted).toEqual([{ username: "ws-jill", id: 4 }, { username: "ws-jill", id: 5 }]);
  });

  it("deletes old legacy keys for a user no live gateway serves", async () => {
    const gitea = new FakeGitea(new Map([["ws-parked", [legacyKey(4, "OLDBARE"), legacyKey(5, "OLDPUB")]]]));

    await runGiteaKeySweep(deps(gitea), createGitKeySweepState());

    expect(gitea.deleted).toEqual([{ username: "ws-parked", id: 4 }, { username: "ws-parked", id: 5 }]);
  });

  it("never deletes legacy keys of a Gitea user that is not a user", async () => {
    const gitea = new FakeGitea(new Map([["octogee-admin", [legacyKey(4, "OLDBARE")]]]));

    await runGiteaKeySweep(deps(gitea), createGitKeySweepState());

    expect(gitea.deleted).toEqual([]);
  });

  it("counts deletable legacy keys in dry-run without deleting", async () => {
    const gitea = new FakeGitea(new Map([["ws-parked", [legacyKey(4, "OLDBARE"), managedKey(11, DEAD_OWNER)]]]));
    const d = deps(gitea, { mode: "dry-run" });

    const result = await runGiteaKeySweep(d, createGitKeySweepState());

    expect(gitea.deleted).toEqual([]);
    expect(result.users[0]).toMatchObject({ stale: 1, legacyStale: 1, deleted: 0, legacyDeleted: 0 });
    expect(d.logs.some((line) => line.includes("pass complete") && line.includes("legacyStale=1") && line.includes("dry-run"))).toBe(true);
  });

  it("spreads a legacy backlog over ticks within the per-tick call budget", async () => {
    const backlog = Array.from({ length: 90 }, (_, index) => legacyKey(index + 100, `OLD${index}`));
    const gitea = new FakeGitea(new Map([["ws-jack", [managedKey(1, LIVE_OWNER), ...backlog]]]));
    const state = createGitKeySweepState();
    const d = deps(gitea, { maxCallsPerTick: 30 });

    let ticks = 0;
    do {
      const result = await runGiteaKeySweep(d, state);
      expect(result.calls).toBeLessThanOrEqual(30);
      ticks += 1;
    } while (state.pass !== null && ticks < 20);

    expect(gitea.keys.get("ws-jack")).toEqual([managedKey(1, LIVE_OWNER)]);
    expect(ticks).toBeGreaterThan(2);
  });
});

describe("createGiteaKeyAdminClient", () => {
  const API = "http://gitea.test:3000/api/v1";

  function json(status: number, body: unknown): Response {
    return new Response(status === 204 ? null : JSON.stringify(body), { status });
  }

  it("lists users and keys page by page with the admin token", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      const href = String(url);
      if (href.startsWith(`${API}/admin/users?`)) return json(200, [{ login: "ws-jack" }, { login: "ws-jill" }]);
      return json(200, [
        { id: 7, title: "octogee-gateway-abc", key: "ssh-ed25519 K", created_at: "2026-09-01T00:00:00Z" },
        { id: 8, title: "laptop", key: "ssh-ed25519 L", created_at: "not a date" },
      ]);
    });
    const client = createGiteaKeyAdminClient({ apiUrl: API, token: "admin-tok", fetchImpl });

    await expect(client.listUsernames(2)).resolves.toEqual(["ws-jack", "ws-jill"]);
    await expect(client.listUserKeys("ws-jack", 3)).resolves.toEqual([
      { id: 7, title: "octogee-gateway-abc", key: "ssh-ed25519 K", createdAt: Date.parse("2026-09-01T00:00:00Z") },
      { id: 8, title: "laptop", key: "ssh-ed25519 L", createdAt: null },
    ]);
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      `${API}/admin/users?limit=50&page=2`,
      `${API}/users/ws-jack/keys?limit=50&page=3`,
    ]);
    expect(fetchImpl.mock.calls[0][1]?.headers).toMatchObject({ Authorization: "token admin-tok" });
  });

  it("deletes a key through the admin API and treats an already-gone key as not deleted", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json(204, null))
      .mockResolvedValueOnce(json(404, { message: "not found" }))
      .mockResolvedValueOnce(json(500, { message: "boom" }));
    const client = createGiteaKeyAdminClient({ apiUrl: API, token: "admin-tok", fetchImpl });

    await expect(client.deleteUserKey("ws-jack", 7)).resolves.toBe(true);
    await expect(client.deleteUserKey("ws-jack", 8)).resolves.toBe(false);
    await expect(client.deleteUserKey("ws-jack", 9)).rejects.toThrow(/delete key 9 for ws-jack failed: 500/);
    expect(fetchImpl.mock.calls[0]).toEqual([
      `${API}/admin/users/ws-jack/keys/7`,
      expect.objectContaining({ method: "DELETE" }),
    ]);
  });
});
