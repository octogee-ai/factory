import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { reattachBuilderAgents } from "../lib/reattach-builder-agents.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reattach-builder-"));
  roots.push(root);
  const agentId = "octogee-chris-coach";
  const agentDir = path.join(root, "agents", agentId, "agent");
  const destinationPath = path.join(agentDir, "openclaw-agent.sqlite");
  await fs.mkdir(agentDir, { recursive: true });
  const database = new DatabaseSync(destinationPath);
  database.exec("CREATE TABLE openclaw_engine_anchor(store_id TEXT, engine TEXT, schema TEXT)");
  database.prepare("INSERT INTO openclaw_engine_anchor VALUES (?, 'postgres', ?)")
    .run("1514f000-4540-4f4e-92a1-831adeac3d5b", "octogee_agent_fixture");
  database.close();
  return { root, agentId, agentDir, destinationPath, workspace: path.join(root, "customers", "chris") };
}

it.each(["already-configured", "refused", "wrong-receipt", "wrong-roster", "anchor-changed", "gate-lost", "invalid-json"])(
  "keeps Native restoration admission and carried identity intact for %s",
  async (mode) => {
    const f = await fixture();
    let held = true;
    const log = vi.fn();
    const run = vi.fn(async (args: string[]) => {
      if (args[1] === "list") {
        if (mode === "gate-lost") held = false;
        return { code: 0, stdout: mode === "invalid-json" ? "not JSON" : JSON.stringify([
          { id: f.agentId, workspace: f.workspace, agentDir: mode === "wrong-roster" ? path.join(f.root, "other") : f.agentDir },
        ]) };
      }
      if (mode === "anchor-changed") {
        const database = new DatabaseSync(f.destinationPath);
        database.prepare("UPDATE openclaw_engine_anchor SET store_id = ?")
          .run("2514f000-4540-4f4e-92a1-831adeac3d5b");
        database.close();
      }
      return mode === "already-configured" || mode === "refused"
        ? { code: 1, stdout: JSON.stringify({ ok: false, error: { type: "cli_error",
          message: mode === "already-configured" ? `Agent "${f.agentId}" already exists.` : "deletion cleanup is still pending" } }) }
        : { code: 0, stdout: JSON.stringify({ agentId: mode === "wrong-receipt" ? "other-agent" : f.agentId,
          workspace: f.workspace, agentDir: f.agentDir }) };
    });
    const result = reattachBuilderAgents({ stores: [f], env: { OPENCLAW_STATE_DIR: f.root }, run, log,
      assertHeld: async () => { if (!held) throw new Error("target is no longer held"); } });

    if (mode === "already-configured") {
      await expect(result).resolves.toBeUndefined();
      expect(log).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("startup admission remains required"));
    } else {
      await expect(result).rejects.toThrow(mode === "gate-lost" ? "no longer held" : /Native/);
      expect(log).not.toHaveBeenCalled();
    }
    expect(run).toHaveBeenCalledTimes(["wrong-roster", "gate-lost", "invalid-json"].includes(mode) ? 1 : 2);
  },
);

it("refuses a missing carried anchor before invoking Native", async () => {
  const f = await fixture();
  await fs.unlink(f.destinationPath);
  const run = vi.fn();
  await expect(reattachBuilderAgents({ stores: [f], env: {}, run, log: vi.fn(), assertHeld: async () => {} }))
    .rejects.toThrow("Carried Builder anchor is missing");
  expect(run).not.toHaveBeenCalled();
  await expect(fs.access(f.destinationPath)).rejects.toThrow();
});
