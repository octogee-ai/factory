import { afterEach, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readAuthProfileStore, writeAuthProfileStore, deleteAuthProfileStore } from "./auth-profile-store.js";
import { seedOpenClawAgentDb } from "./fixtures/openclaw-agent-db.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it("retains local SQLite auth storage for a SQLite agent", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-local-auth-")); roots.push(root);
  seedOpenClawAgentDb(root);
  await writeAuthProfileStore(root, { profiles: { fixture: { key: "synthetic" } } });
  expect(await readAuthProfileStore(root)).toEqual({ profiles: { fixture: { key: "synthetic" } } });
  await deleteAuthProfileStore(root);
  expect(await readAuthProfileStore(root)).toBeNull();
});

it("keeps shared auth in the SQLite state store when main has a PostgreSQL anchor", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-shared-auth-")); roots.push(root);
  const agentDir = path.join(root, "agents/main/agent");
  fs.mkdirSync(agentDir, { recursive: true }); fs.mkdirSync(path.join(root, "state"));
  const anchor = new DatabaseSync(path.join(agentDir, "openclaw-agent.sqlite"));
  anchor.exec("CREATE TABLE openclaw_engine_anchor(store_id TEXT, engine TEXT, schema TEXT)");
  anchor.prepare("INSERT INTO openclaw_engine_anchor VALUES (?, 'postgres', ?)").run("1514f000-4540-4f4e-92a1-831adeac3d5b", "octogee_agent_fixture"); anchor.close();
  const state = new DatabaseSync(path.join(root, "state/openclaw.sqlite"));
  state.exec("CREATE TABLE config_machine_state(state_key TEXT PRIMARY KEY, value_json TEXT, updated_at_ms INTEGER)");
  state.prepare("INSERT INTO config_machine_state VALUES ('auth.sharedStore', ?, 1)").run(JSON.stringify({ location: "state-db" })); state.close();
  await writeAuthProfileStore(agentDir, { profiles: { fixture: { key: "shared-synthetic" } } });
  expect(await readAuthProfileStore(agentDir)).toEqual({ profiles: { fixture: { key: "shared-synthetic" } } });
  await deleteAuthProfileStore(agentDir);
  expect(await readAuthProfileStore(agentDir)).toBeNull();
});
