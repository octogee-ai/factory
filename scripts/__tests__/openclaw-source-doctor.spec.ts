import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { preflightAgentDatabase } from "../lib/agent-store-preflight.js";
import { verifySourceDoctorAgentStores } from "../lib/openclaw-source-doctor.js";
import type { OpenClawCommand } from "../lib/openclaw-cli.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture(version = 25) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "source-doctor-stores-"))); roots.push(root);
  const agentIds = ["alice", "bob", "charlie", "delta", "echo", "foxtrot"].map((slug) => `octogee-${slug}-coach`);
  for (const agentId of agentIds) {
    const file = path.join(root, "agents", agentId, "agent/openclaw-agent.sqlite"); await fs.mkdir(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file); db.exec(`PRAGMA user_version=${version}; CREATE TABLE history(body TEXT); INSERT INTO history VALUES ('preserved')`); db.close();
  }
  const run = vi.fn<OpenClawCommand>(async (args, { env }) => {
    expect(env.OPENCLAW_STATE_DIR).not.toBe(root);
    expect(env.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
    expect(env.OPENCLAW_CONFIG_READONLY).toBe("1");
    const config = JSON.parse(await fs.readFile(env.OPENCLAW_CONFIG_PATH!, "utf8"));
    expect(config.plugins).toEqual({ enabled: false });
    if (args[0] === "backup") {
      const agentId = args[args.indexOf("--agent") + 1]!;
      expect(config.agents.entries[agentId].agentDir).toBe(path.join(root, "agents", agentId, "agent"));
      const snapshotPath = path.join(args[args.indexOf("--repository") + 1]!, "snapshot");
      await fs.mkdir(snapshotPath);
      await fs.copyFile(path.join(root, "agents", agentId, "agent/openclaw-agent.sqlite"), path.join(snapshotPath, "database.sqlite"));
      return { code: 0, stdout: JSON.stringify({ ok: true, snapshotPath }) };
    }
    expect(args.slice(0, 2)).toEqual(["database", "preflight-agent"]);
    expect(args[2]).not.toContain(root);
    expect(config.agents?.entries?.[args[4]!]).toBeUndefined();
    const db = new DatabaseSync(args[2]!, { readOnly: true }); const foundVersion = db.prepare("PRAGMA user_version").get()?.user_version; db.close();
    return { code: foundVersion === 25 ? 0 : 1, stdout: JSON.stringify({ schema: "openclaw.agent-schema-preflight.v1", agentId: args[4], databasePath: args[2], foundVersion, targetVersion: 25, status: foundVersion === 25 ? "exact" : "incompatible" }) };
  });
  return { root, agentIds, run, env: { OPENCLAW_STATE_DIR: root } };
}
it("verifies all requested canonical stores against the installed native preflight without replacing their history", async () => {
  const f = await fixture(); await verifySourceDoctorAgentStores(f.agentIds, f); expect(f.run).toHaveBeenCalledTimes(12);
  for (const agentId of f.agentIds) { const db = new DatabaseSync(path.join(f.root, "agents", agentId, "agent/openclaw-agent.sqlite"), { readOnly: true }); expect(db.prepare("SELECT body FROM history").get()?.body).toBe("preserved"); db.close(); }
});
it("refuses success when a requested store still requires native repair", async () => {
  const f = await fixture(24); await expect(verifySourceDoctorAgentStores(f.agentIds, f)).rejects.toThrow("incompatible");
});
it("refuses a linked requested store before invoking native preflight", async () => {
  const f = await fixture(), file = path.join(f.root, "agents", f.agentIds[0]!, "agent/openclaw-agent.sqlite");
  await fs.rename(file, file + ".retained"); await fs.symlink(file + ".retained", file);
  await expect(verifySourceDoctorAgentStores(f.agentIds, f)).rejects.toThrow("not canonical"); expect(f.run).not.toHaveBeenCalled();
});

it("verifies consolidated copies while preserving live SQLite sidecars and removing only private verification files", async () => {
  const f = await fixture();
  const file = path.join(f.root, "agents", f.agentIds[0]!, "agent/openclaw-agent.sqlite");
  await fs.writeFile(file + "-wal", "retained-wal"); await fs.writeFile(file + "-shm", "retained-shm");
  await verifySourceDoctorAgentStores(f.agentIds, f);
  expect(await fs.readFile(file + "-wal", "utf8")).toBe("retained-wal");
  expect(await fs.readFile(file + "-shm", "utf8")).toBe("retained-shm");
  for (const [args, { env }] of f.run.mock.calls) {
    await expect(fs.stat(env.OPENCLAW_STATE_DIR!)).rejects.toMatchObject({ code: "ENOENT" });
    if (args[0] === "database") await expect(fs.stat(args[2]!)).rejects.toMatchObject({ code: "ENOENT" });
  }
});
it("preserves a native refusal reason when the copied-store schema version is indeterminate", async () => {
  const file = "/private/verification/database.sqlite", agentId = "octogee-alice-coach";
  const reason = "Agent preflight requires a consolidated snapshot with no SQLite sidecars.";
  const run = vi.fn<OpenClawCommand>().mockResolvedValue({ code: 1, stdout: JSON.stringify({
    schema: "openclaw.agent-schema-preflight.v1", agentId, databasePath: file,
    foundVersion: null, targetVersion: 25, status: "indeterminate", reason,
  }) });
  await expect(preflightAgentDatabase(file, agentId, run, { env: {} })).rejects.toThrow(reason);
});
