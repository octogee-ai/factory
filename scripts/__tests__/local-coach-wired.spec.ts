import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  coachWiredInParsedConfig,
  customerCoachWiredInOpenclawConfig,
  listLocalCoachWiredSlugs,
  readOpenclawConfig,
} from "../lib/local-coach-wired";

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
