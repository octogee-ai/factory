import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { inspectConfiguredBuilderAgentStores } from "../lib/openclaw-builder-store-preflight.js";
import type { OpenClawCommand } from "../lib/openclaw-cli.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture(versions = [25, 24]) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "builder-store-inspection-"))); roots.push(root);
  const ids = ["octogee-jefe-coach", "octogee-unmatched-route"];
  const configPath = path.join(root, "openclaw.json"), procRoot = path.join(root, "proc");
  await fs.mkdir(procRoot);
  await fs.writeFile(configPath, JSON.stringify({ agents: { list: ids.map(id => ({ id })) } }));
  for (const [index, id] of ids.entries()) {
    const file = path.join(root, "agents", id, "agent/openclaw-agent.sqlite"); await fs.mkdir(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file); db.exec(`PRAGMA user_version=${versions[index]}; CREATE TABLE history(body TEXT); INSERT INTO history VALUES ('preserved')`); db.close();
  }
  const run = vi.fn<OpenClawCommand>(async (args, { env }) => {
    expect(args.slice(0, 2)).toEqual(["database", "preflight-agent"]);
    expect(args[2]).not.toContain(root); expect(env.OPENCLAW_STATE_DIR).not.toBe(root);
    expect(env.OPENCLAW_GATEWAY_TOKEN).toBeUndefined(); expect(env.OPENCLAW_CONFIG_READONLY).toBe("1");
    const config = JSON.parse(await fs.readFile(env.OPENCLAW_CONFIG_PATH!, "utf8"));
    expect(config.agents.entries).toEqual({}); expect(config.plugins).toEqual({ enabled: false });
    for (const suffix of ["-wal", "-shm", "-journal"]) await expect(fs.stat(args[2]! + suffix)).rejects.toMatchObject({ code: "ENOENT" });
    const db = new DatabaseSync(args[2]!, { readOnly: true }); const version = db.prepare("PRAGMA user_version").get()!.user_version;
    expect(db.prepare("SELECT body FROM history").get()!.body).toBe("preserved"); db.close();
    return { code: version === 25 ? 0 : 1, stdout: JSON.stringify({ schema: "openclaw.agent-schema-preflight.v1", agentId: args[4], databasePath: args[2], foundVersion: version, targetVersion: 25, status: version === 25 ? "exact" : "incompatible" }) };
  });
  return { root, stateDir: root, configPath, procRoot, ids, run };
}
it("inspects the configured coach and dormant auth anchor without modifying either SQLite family", async () => {
  const f = await fixture(), before = await Promise.all(f.ids.map(id => fs.readFile(path.join(f.root, "agents", id, "agent/openclaw-agent.sqlite"))));
  await expect(inspectConfiguredBuilderAgentStores(f)).resolves.toBe("repair-required");
  expect(f.run).toHaveBeenCalledTimes(2);
  expect(f.run.mock.calls.map(([args]) => args[4]).sort()).toEqual(f.ids.sort());
  for (const [i, id] of f.ids.entries()) expect(await fs.readFile(path.join(f.root, "agents", id, "agent/openclaw-agent.sqlite"))).toEqual(before[i]);
  for (const [, options] of f.run.mock.calls) await expect(fs.stat(options.env.OPENCLAW_STATE_DIR!)).rejects.toMatchObject({ code: "ENOENT" });
});
it("includes committed WAL rows in the private preflight while retaining original family bytes and inodes", async () => {
  const f = await fixture([25, 25]), file = path.join(f.root, "agents", f.ids[1]!, "agent/openclaw-agent.sqlite"), db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; INSERT INTO history VALUES ('wal-preserved')");
  const family = await Promise.all(["", "-wal", "-shm"].map(async suffix => ({ file: file + suffix, bytes: await fs.readFile(file + suffix), stat: await fs.stat(file + suffix) })));
  const original = f.run.getMockImplementation()!;
  f.run.mockImplementation(async (args, options) => {
    const result = await original(args, options);
    if (args[4] === f.ids[1]) { const copy = new DatabaseSync(args[2]!, { readOnly: true }); expect(copy.prepare("SELECT count(*) AS n FROM history").get()!.n).toBe(2); copy.close(); }
    return result;
  });
  try { await expect(inspectConfiguredBuilderAgentStores(f)).resolves.toBe("exact");
    for (const item of family) { expect(await fs.readFile(item.file)).toEqual(item.bytes); expect((await fs.stat(item.file)).ino).toBe(item.stat.ino); }
  } finally { db.close(); }
});
it("refuses native indeterminate, newer schema and malformed preflight reports instead of requesting Doctor", async () => {
  for (const kind of ["indeterminate", "newer", "malformed"]) {
    const f = await fixture(); f.run.mockImplementation(async args => ({ code: 1, stdout: kind === "malformed" ? "not-json" : JSON.stringify({ schema: "openclaw.agent-schema-preflight.v1", agentId: args[4], databasePath: args[2], foundVersion: kind === "newer" ? 26 : null, targetVersion: 25, status: kind === "newer" ? "incompatible" : "indeterminate", reason: "inspection refused" }) }));
    await expect(inspectConfiguredBuilderAgentStores(f)).rejects.toThrow(/verify|invalid|refused/);
  }
});
it("refuses malformed configured paths, corrupt state and linked families before startup", async () => {
  const f = await fixture(), anchor = path.join(f.root, "agents", f.ids[1]!, "agent/openclaw-agent.sqlite");
  await fs.writeFile(anchor, "corrupt database"); await expect(inspectConfiguredBuilderAgentStores(f)).rejects.toThrow();
  await fs.rename(anchor, anchor + ".original"); await fs.symlink(anchor + ".original", anchor); await expect(inspectConfiguredBuilderAgentStores(f)).rejects.toThrow(/canonical/);
  await fs.writeFile(f.configPath, JSON.stringify({ agents: { list: [{ id: "octogee-jefe-coach", agentDir: "../outside" }] } }));
  await expect(inspectConfiguredBuilderAgentStores(f)).rejects.toThrow();
});
it("refuses a configured store held by a writer before invoking native inspection", async () => {
  const f = await fixture(), directory = path.join(f.procRoot, "741"); await fs.mkdir(path.join(directory, "fd"), { recursive: true });
  await fs.mkdir(path.join(directory, "fdinfo")); await fs.symlink(path.join(f.root, "agents", f.ids[1]!, "agent/openclaw-agent.sqlite"), path.join(directory, "fd", "3"));
  await fs.writeFile(path.join(directory, "fdinfo", "3"), "flags: 02\n");
  await expect(inspectConfiguredBuilderAgentStores(f)).rejects.toThrow("still held open"); expect(f.run).not.toHaveBeenCalled();
});
