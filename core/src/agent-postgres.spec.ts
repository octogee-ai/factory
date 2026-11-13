import { afterEach, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPostgresAgentAnchor } from "./agent-postgres.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("propagates an anchor read failure instead of identifying a SQLite store", () => {
  const root = mkdtempSync(join(tmpdir(), "octogee-locked-anchor-"));
  roots.push(root);
  const file = join(root, "openclaw-agent.sqlite");
  const writer = new DatabaseSync(file);
  try {
    writer.exec("CREATE TABLE openclaw_engine_anchor(store_id TEXT, engine TEXT, schema TEXT)");
    writer.exec("BEGIN EXCLUSIVE");
    expect(() => readPostgresAgentAnchor(file)).toThrow("locked");
  } finally { writer.close(); }
});
