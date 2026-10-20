import { afterEach, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { exportAgentStoreSnapshots, prepareAgentStoreSnapshots, findPortableAgentStores } from "../lib/agent-store-snapshot.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "postgres-agent-handoff-")));
  roots.push(root);
  const agentId = "octogee-alice-coach";
  const relative = `agents/${agentId}/agent`;
  await fs.mkdir(path.join(root, relative), { recursive: true });
  const file = path.join(root, relative, "openclaw-agent.sqlite");
  const identity = { store_id: "1514f000-4540-4f4e-92a1-831adeac3d5b", schema: "octogee_agent_1514f00045404f4e" };
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE openclaw_engine_anchor (store_id TEXT, engine TEXT, schema TEXT)");
  db.prepare("INSERT INTO openclaw_engine_anchor VALUES (?, 'postgres', ?)").run(identity.store_id, identity.schema);
  db.close();
  return { root, agentId, file, identity };
}

it("detaches before carrying a PostgreSQL anchor and adopts it without a SQLite backup or restore", async () => {
  const { root, agentId, file, identity } = await fixture();
  const detachAgent = vi.fn(async () => undefined);
  const stageDir = path.join(root, "stage");
  await exportAgentStoreSnapshots({ sources: [{ cwd: root, path: `agents/${agentId}` }], exportRoot: stageDir, detachAgent });
  expect(detachAgent).toHaveBeenCalledExactlyOnceWith(agentId);
  const prepared = await prepareAgentStoreSnapshots({ stageDir, importDir: path.join(root, "target"), migrationId: "m1" });
  expect(prepared.stores).toHaveLength(1);
  const adopted = new DatabaseSync(prepared.stores[0]!.restoredPath, { readOnly: true });
  try {
    expect({ ...adopted.prepare("SELECT store_id, schema FROM openclaw_engine_anchor").get() }).toEqual(identity);
  } finally { adopted.close(); }
  expect(await fs.readFile(file)).toEqual(await fs.readFile(prepared.stores[0]!.restoredPath));
});

it.each(["missing", "failed"])("does not carry an anchor when detach is %s", async mode => {
  const { root, agentId, file } = await fixture();
  const detachAgent = mode === "failed" ? vi.fn(async () => { throw new Error("detach unavailable"); }) : undefined;
  await expect(exportAgentStoreSnapshots({ sources: [{ cwd: root, path: `agents/${agentId}` }], exportRoot: path.join(root, "stage") , detachAgent })).rejects.toThrow(mode === "failed" ? "detach unavailable" : "must be detached");
  expect((await fs.stat(file)).size).toBeGreaterThan(0);
  await expect(fs.stat(path.join(root, "stage"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("refuses an altered PostgreSQL anchor before installing it", async () => {
  const { root, agentId } = await fixture();
  const stageDir = path.join(root, "stage");
  await exportAgentStoreSnapshots({ sources: [{ cwd: root, path: `agents/${agentId}` }], exportRoot: stageDir, detachAgent: async () => undefined });
  const artifact = path.join(stageDir, `agents/${agentId}/agent/.octogee-snapshot/postgres-anchor/database.sqlite`);
  await fs.appendFile(artifact, "altered-anchor");
  await expect(prepareAgentStoreSnapshots({ stageDir, importDir: path.join(root, "target"), migrationId: "altered" })).rejects.toThrow("does not match its manifest");
});

it.each(["export", "import"])("refuses a SQLite agent %s after the fresh PostgreSQL cutover", async phase => {
  const { root, agentId, file } = await fixture();
  const stageDir = path.join(root, "stage");
  if (phase === "export") {
    const db = new DatabaseSync(file); db.exec("DROP TABLE openclaw_engine_anchor"); db.close();
    await expect(exportAgentStoreSnapshots({ sources: [{ cwd: root, path: `agents/${agentId}` }], exportRoot: stageDir })).rejects.toThrow("SQLite agent handoff is unsupported after the PostgreSQL cutover");
  } else {
    await exportAgentStoreSnapshots({ sources: [{ cwd: root, path: `agents/${agentId}` }], exportRoot: stageDir, detachAgent: async () => undefined });
    const artifact = path.join(stageDir, `agents/${agentId}/agent/.octogee-snapshot/postgres-anchor/database.sqlite`);
    const db = new DatabaseSync(artifact); db.exec("DROP TABLE openclaw_engine_anchor"); db.close();
    await expect(prepareAgentStoreSnapshots({ stageDir, importDir: path.join(root, "target"), migrationId: "sqlite" })).rejects.toThrow("SQLite agent handoff is unsupported after the PostgreSQL cutover");
  }
});

it("refuses duplicate source roots for one agent before detaching either store", async () => {
  const first = await fixture(), second = await fixture();
  const detachAgent = vi.fn(async () => undefined);
  await expect(exportAgentStoreSnapshots({ sources: [first, second].map(item => ({ cwd: item.root, path: `agents/${item.agentId}` })), exportRoot: path.join(first.root, "stage"), detachAgent })).rejects.toThrow("more than one database");
  expect(detachAgent).not.toHaveBeenCalled();
});

it("refuses an unexpected agent SQLite store while allowing Codex's separate SQLite family", async () => {
  const { root, agentId } = await fixture();
  await fs.mkdir(path.join(root, `agents/${agentId}/agent/codex-home`));
  await fs.writeFile(path.join(root, `agents/${agentId}/agent/codex-home/goals_1.sqlite`), "optional-fixture");
  const sources = [{ cwd: root, path: `agents/${agentId}` }];
  expect(await findPortableAgentStores(sources)).toHaveLength(1);
  await fs.writeFile(path.join(root, `agents/${agentId}/agent/stray.sqlite`), "unexpected-fixture");
  await expect(findPortableAgentStores(sources)).rejects.toThrow("unexpected OpenClaw SQLite store");
});
