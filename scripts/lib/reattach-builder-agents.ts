import * as path from "node:path";
import { readPostgresAgentAnchor } from "@octogee/core/agent-postgres";
import type { PreparedAgentStore } from "./agent-store-snapshot.js";
import { runOpenClaw, type OpenClawCommand, type OpenClawCommandResult } from "./openclaw-cli.js";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nativeJson(stdout: string): unknown {
  try { return JSON.parse(stdout) as unknown; }
  catch { throw new Error("Native agent reattachment returned invalid JSON"); }
}

function restorationOutcome(
  result: OpenClawCommandResult,
  expected: { agentId: string; workspace: string; agentDir: string },
): "restored" | "already-configured" {
  const payload = nativeJson(result.stdout);
  if (result.code === 0 && record(payload) && payload.agentId === expected.agentId &&
      payload.workspace === expected.workspace && payload.agentDir === expected.agentDir) return "restored";
  if (result.code === 1 && record(payload) && payload.ok === false && record(payload.error) &&
      payload.error.type === "cli_error" && payload.error.message === `Agent "${expected.agentId}" already exists.`) {
    return "already-configured";
  }
  throw new Error(`Native carried-agent restoration failed for ${expected.agentId} (exit ${result.code})`);
}

export async function reattachBuilderAgents(input: {
  stores: readonly Pick<PreparedAgentStore, "agentId" | "destinationPath">[];
  env: NodeJS.ProcessEnv;
  assertHeld: () => Promise<void>;
  signal?: AbortSignal;
  run?: OpenClawCommand;
  log: (message: string) => void;
}): Promise<void> {
  if (input.stores.length === 0) return;
  const assertCurrent = async () => {
    input.signal?.throwIfAborted();
    await input.assertHeld();
    input.signal?.throwIfAborted();
  };
  await assertCurrent();
  const stores = input.stores.map(store => {
    const anchor = readPostgresAgentAnchor(store.destinationPath);
    if (!anchor) throw new Error(`Carried Builder anchor is missing for ${store.agentId}`);
    return { ...store, anchor };
  });
  const assertAnchors = (selected: typeof stores) => {
    for (const store of selected) {
      const current = readPostgresAgentAnchor(store.destinationPath);
      if (current?.storeId !== store.anchor.storeId || current.schema !== store.anchor.schema) {
        throw new Error(`Native agent reattachment changed the carried anchor for ${store.agentId}`);
      }
    }
  };
  const run = input.run ?? runOpenClaw;
  const listed = await run(["agents", "list", "--json"], { env: input.env, signal: input.signal });
  await assertCurrent();
  assertAnchors(stores);
  if (listed.code !== 0) throw new Error(`Native carried-agent roster inspection failed (exit ${listed.code})`);
  const roster = nativeJson(listed.stdout);
  if (!Array.isArray(roster)) throw new Error("Native carried-agent roster is not an array");
  for (const store of stores) {
    const matches = roster.filter((row: unknown) => record(row) && row.id === store.agentId);
    const row: unknown = matches[0];
    if (matches.length !== 1 || !record(row) || typeof row.workspace !== "string" ||
        !path.isAbsolute(row.workspace) || row.agentDir !== path.dirname(store.destinationPath)) {
      throw new Error(`Native roster does not match the carried Builder agent ${store.agentId}`);
    }
    await assertCurrent();
    const result = await run([
      "agents", "add", store.agentId, "--workspace", row.workspace,
      "--agent-dir", row.agentDir, "--non-interactive", "--json",
    ], { env: input.env, signal: input.signal });
    await assertCurrent();
    assertAnchors([store]);
    const outcome = restorationOutcome(result, { agentId: store.agentId, workspace: row.workspace, agentDir: row.agentDir });
    input.log(outcome === "restored"
      ? `[migration-rsync] Native restored carried Builder agent ${store.agentId}`
      : `[migration-rsync] Native reports ${store.agentId} already configured; startup admission remains required`);
  }
  assertAnchors(stores);
}
