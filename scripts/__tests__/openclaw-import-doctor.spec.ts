import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { upgradeImportedAgentStores } from "../lib/openclaw-import-doctor.js";
import type { OpenClawCommand } from "../lib/openclaw-cli.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "import-doctor-test-"))); roots.push(root);
  const agentId = "octogee-alice-coach", storeId = "14d620f0-129f-4a72-b1cd-55ad563db8dc", schema = "octogee_agent_14d620f0129f4a72";
  const anchorPath = path.join(root, "agents", agentId, "agent", "openclaw-agent.sqlite");
  await fs.mkdir(path.dirname(anchorPath), { recursive: true });
  const db = new DatabaseSync(anchorPath); db.exec("CREATE TABLE openclaw_engine_anchor (store_id TEXT, engine TEXT, schema TEXT)");
  db.prepare("INSERT INTO openclaw_engine_anchor VALUES (?, 'postgres', ?)").run(storeId, schema); db.close();
  const stores = [{ agentId, anchorPath, storeId, schema }];
  const assertCurrent = vi.fn(async () => {});
  let version = 37;
  const query = vi.fn(async () => [{ store_id: storeId, version, role: "agent", agent_id: agentId, schema_version: version }]);
  const run = vi.fn<OpenClawCommand>(async (args, { env }) => {
    if (args[0] === "database") return { code: 1, stdout: JSON.stringify({ schema: "openclaw.agent-schema-preflight.v1", agentId,
      databasePath: args[2], status: "indeterminate", foundVersion: null, requiresWrite: false, targetVersion: 38 }) };
    expect(env.OPENCLAW_STATE_DIR).not.toBe(root);
    expect(env.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
    const config = JSON.parse(await fs.readFile(env.OPENCLAW_CONFIG_PATH!, "utf8"));
    if (config.database.families?.agent?.engine === "postgres") {
      expect(Object.keys(config.agents.entries)).toEqual([agentId]);
      expect(await fs.readFile(path.join(env.OPENCLAW_STATE_DIR!, "agents", agentId, "agent", "openclaw-agent.sqlite"))).toEqual(await fs.readFile(anchorPath));
      expect(config.database.families.state).toBeUndefined();
      version = 38;
    }
    return { code: 0, stdout: "" };
  });
  return { root, stores, assertCurrent, run, query: query as unknown as typeof import("@octogee/core/agent-postgres").queryAgentStore, env: { OPENCLAW_AGENT_STORE_DSN: "postgresql://synthetic", OPENCLAW_GATEWAY_TOKEN: "secret" } };
}

it("runs Native Doctor against only the carried PostgreSQL agent in private state and preserves the original anchor", async () => {
  const f = await fixture(); const before = await fs.readFile(f.stores[0]!.anchorPath);
  await upgradeImportedAgentStores(f);
  expect(f.run).toHaveBeenCalledTimes(3);
  expect(f.run.mock.calls.map(([args]) => args)).toEqual([
    expect.arrayContaining(["database", "preflight-agent"]),
    ["setup", "--baseline", "--skip-bootstrap", "--json"],
    ["doctor", "--fix", "--non-interactive"],
  ]);
  expect(f.assertCurrent.mock.calls.length).toBeGreaterThanOrEqual(4);
  expect(await fs.readFile(f.stores[0]!.anchorPath)).toEqual(before);
  for (const [, options] of f.run.mock.calls) await expect(fs.stat(options.env.OPENCLAW_STATE_DIR!)).rejects.toMatchObject({ code: "ENOENT" });
});

it("refuses an anchor that differs from the authorized roster before running Doctor", async () => {
  const f = await fixture(); f.stores[0]!.schema = "octogee_agent_foreign";
  await expect(upgradeImportedAgentStores(f)).rejects.toThrow(/anchor/i);
  expect(f.run).not.toHaveBeenCalled();
});

it("fails closed if custody changes during Native Doctor", async () => {
  const f = await fixture();
  const original = f.run.getMockImplementation()!;
  f.run.mockImplementation(async (args, options) => {
    if (args[0] === "doctor" && JSON.parse(await fs.readFile(options.env.OPENCLAW_CONFIG_PATH!, "utf8")).database.families?.agent) {
      f.assertCurrent.mockRejectedValue(new Error("custody lost")); return { code: 0, stdout: "" };
    }
    return original(args, options);
  });
  await expect(upgradeImportedAgentStores(f)).rejects.toThrow("custody lost");
});

it("rejects duplicate stores and a live anchor sidecar", async () => {
  const f = await fixture();
  await expect(upgradeImportedAgentStores({ ...f, stores: [...f.stores, { ...f.stores[0]!, agentId: "octogee-bob-coach" }] })).rejects.toThrow(/unique/);
  await fs.writeFile(`${f.stores[0]!.anchorPath}-wal`, "writer active");
  await expect(upgradeImportedAgentStores(f)).rejects.toThrow(/not closed/);
  expect(f.run).not.toHaveBeenCalled();
});

it("reports a failing Native Doctor without publishing a successful upgrade", async () => {
  const f = await fixture();
  const original = f.run.getMockImplementation()!;
  f.run.mockImplementation(async (args, options) => args[0] === "doctor" && JSON.parse(await fs.readFile(options.env.OPENCLAW_CONFIG_PATH!, "utf8")).database.families?.agent
    ? { code: 1, stdout: "" } : original(args, options));
  await expect(upgradeImportedAgentStores(f)).rejects.toThrow(/PostgreSQL upgrade failed/);
  for (const [, options] of f.run.mock.calls) await expect(fs.stat(options.env.OPENCLAW_STATE_DIR!)).rejects.toMatchObject({ code: "ENOENT" });
});

it("detects replacement of a carried anchor while Native Doctor runs", async () => {
  const f = await fixture();
  const original = f.run.getMockImplementation()!;
  f.run.mockImplementation(async (args, options) => {
    if (args[0] === "doctor" && JSON.parse(await fs.readFile(options.env.OPENCLAW_CONFIG_PATH!, "utf8")).database.families?.agent) {
      await fs.writeFile(f.stores[0]!.anchorPath, "replaced"); return { code: 0, stdout: "" };
    }
    return original(args, options);
  });
  await expect(upgradeImportedAgentStores(f)).rejects.toThrow(/anchor changed/);
});

it("skips Doctor when all authorized PostgreSQL agents already match the installed Native schema", async () => {
  const f = await fixture();
  const query = vi.fn(async () => [{ store_id: f.stores[0]!.storeId, version: 38, role: "agent", agent_id: f.stores[0]!.agentId, schema_version: 38 }]);
  f.run.mockImplementation(async (args) => {
    expect(args.slice(0, 2)).toEqual(["database", "preflight-agent"]);
    return { code: 1, stdout: JSON.stringify({ schema: "openclaw.agent-schema-preflight.v1", agentId: f.stores[0]!.agentId,
      databasePath: args[2], status: "indeterminate", foundVersion: null, requiresWrite: false, targetVersion: 38 }) };
  });
  await upgradeImportedAgentStores({ ...f, query: query as unknown as typeof import("@octogee/core/agent-postgres").queryAgentStore });
  expect(f.run).toHaveBeenCalledTimes(1);
});

it.each(["newer", "wrong-owner", "partial-upgrade"] as const)("refuses agent adoption when PostgreSQL metadata is %s", async problem => {
  const f = await fixture();
  const version = problem === "newer" ? 39 : 37;
  const query = vi.fn(async () => [{ store_id: f.stores[0]!.storeId, version, role: "agent",
    agent_id: problem === "wrong-owner" ? "octogee-foreign-coach" : f.stores[0]!.agentId, schema_version: version }]);
  await expect(upgradeImportedAgentStores({ ...f, query: query as unknown as typeof import("@octogee/core/agent-postgres").queryAgentStore })).rejects.toThrow(/metadata mismatch/);
  expect(f.run.mock.calls.filter(([args]) => args[0] === "doctor")).toHaveLength(problem === "partial-upgrade" ? 1 : 0);
});


it.each(["refused", "timeout", "custody"])("does not upgrade PostgreSQL after private setup %s", async failure => {
  const f = await fixture(), original = f.run.getMockImplementation()!;
  f.run.mockImplementation(async (args, options) => {
    if (args[0] !== "setup") return original(args, options);
    expect(options.timeoutMs).toBeGreaterThan(0);
    expect(options.env.HOME).toBe(options.env.OPENCLAW_STATE_DIR);
    if (failure === "timeout") throw new Error("setup timeout");
    if (failure === "custody") f.assertCurrent.mockRejectedValue(new Error("setup custody lost"));
    return { code: failure === "refused" ? 2 : 0, stdout: "" };
  });
  await expect(upgradeImportedAgentStores(f)).rejects.toThrow(failure === "refused" ? /bootstrap setup failed/ : /setup (timeout|custody lost)/);
  expect(f.run.mock.calls.some(([args]) => args[0] === "doctor")).toBe(false);
});
