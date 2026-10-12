import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
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
  const run = vi.fn<OpenClawCommand>(async (args) => {
    expect(args.slice(0, 2)).toEqual(["database", "preflight-agent"]);
    const db = new DatabaseSync(args[2]!, { readOnly: true }); const foundVersion = db.prepare("PRAGMA user_version").get()?.user_version; db.close();
    return { code: foundVersion === 25 ? 0 : 1, stdout: JSON.stringify({ schema: "openclaw.agent-schema-preflight.v1", agentId: args[4], databasePath: args[2], foundVersion, targetVersion: 25, status: foundVersion === 25 ? "exact" : "incompatible" }) };
  });
  return { root, agentIds, run, env: { OPENCLAW_STATE_DIR: root } };
}
it("verifies all requested canonical stores against the installed native preflight without replacing their history", async () => {
  const f = await fixture(); await verifySourceDoctorAgentStores(f.agentIds, f); expect(f.run).toHaveBeenCalledTimes(6);
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
