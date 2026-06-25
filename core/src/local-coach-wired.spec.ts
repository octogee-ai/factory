import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  _resetMigratingInProcessPinsForTests,
  coachWiredInParsedConfig,
  customerCoachWiredInOpenclawConfig,
  hasMountedMarker,
  isMigratingInPinned,
  listLocalCoachWiredSlugs,
  listLocalCustomerDirs,
  listMigratingInSlugs,
  readOpenclawConfig,
  writeMigratingInPin,
  writeMountedMarker,
} from "./local-coach-wired";

const tmp: string[] = [];
function writeConfig(obj: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-"));
  tmp.push(dir);
  const p = path.join(dir, "openclaw.json");
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}
function wiredConfig(slugs: string[]) {
  return {
    agents: { list: slugs.map((s) => ({ id: `octogee-${s}-coach` })) },
    channels: { mattermost: { accounts: Object.fromEntries(slugs.map((s) => [`${s}-coach`, {}])) } },
    bindings: slugs.map((s) => ({
      agentId: `octogee-${s}-coach`,
      match: { channel: "mattermost", accountId: `${s}-coach`, peer: { kind: "group", id: `ch-${s}` } },
    })),
  };
}
afterEach(() => _resetMigratingInProcessPinsForTests());
afterAll(() => tmp.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

describe("customerCoachWiredInOpenclawConfig", () => {
  it("true when the coach agent + MM account + binding are all present", () => {
    expect(customerCoachWiredInOpenclawConfig(writeConfig(wiredConfig(["alice"])), "alice")).toBe(true);
  });

  it("false when the binding is missing", () => {
    const c = wiredConfig(["alice"]);
    c.bindings = [];
    expect(customerCoachWiredInOpenclawConfig(writeConfig(c), "alice")).toBe(false);
  });

  it("false when the Mattermost account is missing", () => {
    const c = wiredConfig(["alice"]);
    c.channels.mattermost.accounts = {};
    expect(customerCoachWiredInOpenclawConfig(writeConfig(c), "alice")).toBe(false);
  });

  it("false when the coach agent is missing from agents.list", () => {
    const c = wiredConfig(["alice"]);
    c.agents.list = [];
    expect(customerCoachWiredInOpenclawConfig(writeConfig(c), "alice")).toBe(false);
  });

  it("false when the config is unreadable / missing (no throw)", () => {
    expect(customerCoachWiredInOpenclawConfig("/no/such/openclaw.json", "alice")).toBe(false);
  });
});

describe("readOpenclawConfig", () => {
  it("parses a present config", () => {
    expect(readOpenclawConfig(writeConfig(wiredConfig(["alice"])))).toMatchObject({ agents: { list: [{ id: "octogee-alice-coach" }] } });
  });

  it("returns null when the config is missing / unparseable (no throw)", () => {
    expect(readOpenclawConfig("/no/such/openclaw.json")).toBeNull();
  });
});

describe("coachWiredInParsedConfig (pure — config parsed once, checked per slug)", () => {
  it("true for a wired slug, false for an absent one — same parsed config", () => {
    const config = wiredConfig(["alice", "bob"]);
    expect(coachWiredInParsedConfig(config, "alice")).toBe(true);
    expect(coachWiredInParsedConfig(config, "bob")).toBe(true);
    expect(coachWiredInParsedConfig(config, "carol")).toBe(false);
  });

  it("false when any of the three wiring parts is missing", () => {
    const noBinding = wiredConfig(["alice"]);
    noBinding.bindings = [];
    expect(coachWiredInParsedConfig(noBinding, "alice")).toBe(false);
  });

  it("false when the binding is not pinned to the slug's Mattermost account", () => {
    const wrongAccount = wiredConfig(["alice"]);
    wrongAccount.bindings = [
      {
        agentId: "octogee-alice-coach",
        match: { channel: "mattermost", accountId: "bob-coach", peer: { kind: "group", id: "ch-alice" } },
      },
    ];
    expect(coachWiredInParsedConfig(wrongAccount, "alice")).toBe(false);
  });
});

describe("listLocalCoachWiredSlugs", () => {
  it("returns coach-wired customer dirs sorted, excluding non-wired and non-dirs", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cust-"));
    tmp.push(root);
    for (const s of ["bob", "alice", "carol"]) fs.mkdirSync(path.join(root, s));
    fs.mkdirSync(path.join(root, "BadSlug"));
    fs.mkdirSync(path.join(root, "__proto__"));
    fs.writeFileSync(path.join(root, "not-a-dir"), "x");
    const wired = new Set(["alice", "BadSlug", "__proto__", "carol"]);
    expect(listLocalCoachWiredSlugs(root, (s) => wired.has(s))).toEqual(["alice", "carol"]);
  });

  it("returns [] when the customers dir does not exist", () => {
    expect(listLocalCoachWiredSlugs("/no/such/dir-xyz", () => true)).toEqual([]);
  });
});

describe("listLocalCustomerDirs (raw on-disk dirs — the evict-observed set)", () => {
  it("returns every safe-slug dir sorted, ignoring coach-wiring (so partial dirs are seen)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dirs-"));
    tmp.push(root);
    for (const s of ["bob", "alice", "partial"]) fs.mkdirSync(path.join(root, s));
    fs.mkdirSync(path.join(root, "BadSlug"));
    fs.writeFileSync(path.join(root, "not-a-dir"), "x");
    expect(listLocalCustomerDirs(root)).toEqual(["alice", "bob", "partial"]);
  });

  it("returns [] when the customers dir does not exist", () => {
    expect(listLocalCustomerDirs("/no/such/dir-xyz")).toEqual([]);
  });

  it("includes valid 2-char slugs (the username contract is 2..24, not 3+)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dirs2-"));
    tmp.push(root);
    for (const s of ["jo", "x9", "ab"]) fs.mkdirSync(path.join(root, s));
    fs.mkdirSync(path.join(root, "a")); // 1 char — below the 2-char minimum
    fs.mkdirSync(path.join(root, "-bad")); // leading hyphen — rejected by USERNAME_RE
    expect(listLocalCustomerDirs(root)).toEqual(["ab", "jo", "x9"]);
    // ...and coach-wired observation sees them too (this is the regression: a 2-char customer
    // was previously invisible → never mounted-reported, never evicted).
    expect(listLocalCoachWiredSlugs(root, () => true)).toEqual(["ab", "jo", "x9"]);
  });
});

describe("listMigratingInSlugs (the /health migrating-in signal for Cowboy's poller)", () => {
  it("returns only on-disk slugs with a fresh pin, sorted", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lmig-"));
    tmp.push(root);
    for (const s of ["alice", "incoming", "stale"]) fs.mkdirSync(path.join(root, s));
    writeMigratingInPin(root, "incoming");
    writeMigratingInPin(root, "stale");
    const old = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(path.join(root, "stale", ".system", ".migrating-in"), old, old);
    _resetMigratingInProcessPinsForTests();
    expect(listMigratingInSlugs(root, 5 * 60_000)).toEqual(["incoming"]);
  });

  it("reports a process pin even when restore replaces the customer dir", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lmig-"));
    tmp.push(root);
    fs.mkdirSync(path.join(root, "incoming"));
    writeMigratingInPin(root, "incoming");
    fs.rmSync(path.join(root, "incoming"), { recursive: true, force: true });
    fs.mkdirSync(path.join(root, "incoming"));

    expect(isMigratingInPinned(root, "incoming", 5 * 60_000)).toBe(true);
    expect(listMigratingInSlugs(root, 5 * 60_000)).toEqual(["incoming"]);
  });
});

describe("mounted marker (the post-config completion gate)", () => {
  it("hasMountedMarker is false until writeMountedMarker stamps it", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mark-"));
    tmp.push(root);
    fs.mkdirSync(path.join(root, "alice"));
    expect(hasMountedMarker(root, "alice")).toBe(false);
    writeMountedMarker(root, "alice");
    expect(hasMountedMarker(root, "alice")).toBe(true);
  });

  it("writeMountedMarker creates the .system dir if the slug dir is bare", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mark-"));
    tmp.push(root);
    fs.mkdirSync(path.join(root, "bob"));
    writeMountedMarker(root, "bob");
    expect(hasMountedMarker(root, "bob")).toBe(true);
  });

  it("stamps the marker under .system/ (gitignored — pod-local, never cloned back)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mark-"));
    tmp.push(root);
    fs.mkdirSync(path.join(root, "carol"));
    writeMountedMarker(root, "carol");
    expect(fs.existsSync(path.join(root, "carol", ".system", ".mounted"))).toBe(true);
  });

  it("hasMountedMarker is false for an absent slug dir (no throw)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mark-"));
    tmp.push(root);
    expect(hasMountedMarker(root, "ghost")).toBe(false);
  });
});

describe("migrating-in pin (guards a freshly-imported customer from the evict direction)", () => {
  it("isMigratingInPinned is false until writeMigratingInPin stamps it, then true within TTL", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "migp-"));
    tmp.push(root);
    fs.mkdirSync(path.join(root, "alice"));
    expect(isMigratingInPinned(root, "alice", 60_000)).toBe(false);
    writeMigratingInPin(root, "alice");
    expect(isMigratingInPinned(root, "alice", 60_000)).toBe(true);
  });

  it("self-expires: a pin older than the TTL is ignored (failed-migration orphan becomes evictable)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "migp-"));
    tmp.push(root);
    fs.mkdirSync(path.join(root, "bob"));
    writeMigratingInPin(root, "bob");
    const stale = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(path.join(root, "bob", ".system", ".migrating-in"), stale, stale);
    _resetMigratingInProcessPinsForTests();
    expect(isMigratingInPinned(root, "bob", 5 * 60_000)).toBe(false);
  });

  it("isMigratingInPinned is false for an absent pin (no throw)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "migp-"));
    tmp.push(root);
    expect(isMigratingInPinned(root, "ghost", 60_000)).toBe(false);
  });

  it("clears an inherited .mounted marker (a migration import must re-earn its own marker)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "migp-"));
    tmp.push(root);
    fs.mkdirSync(path.join(root, "incoming"));
    writeMountedMarker(root, "incoming"); // simulate the source's marker arriving in the tarball
    writeMigratingInPin(root, "incoming");
    expect(hasMountedMarker(root, "incoming")).toBe(false);
    expect(isMigratingInPinned(root, "incoming", 60_000)).toBe(true);
  });
});
