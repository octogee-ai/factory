import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { readPostgresAgentAnchor } from "@octogee/core/agent-postgres";
import { runBuilderRuntimeStateRestore } from "../entrypoints/builder-runtime-state-restore.js";
import { builderRuntimeStatePath } from "../lib/builder-runtime-state.js";
import { withBuilderClaim } from "./helpers/builder-claim.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const state = { storeId: "c8feb4c9-41a7-4be1-b863-fa07ef6d1bdd", schema: "octogee_state_c8feb4c941a74be1" };
async function fixture(runtime = "cluster", recorded = true) {
  const root = await mkdtemp(join(tmpdir(), "builder-boot-state-"));
  roots.push(root);
  const env = withBuilderClaim({ GATEWAY_CLASS: "builder", GATEWAY_RUNTIME_KIND: runtime, GATEWAY_ID: "alice-s-abc", OPENCLAW_STATE_DIR: root }, "alice");
  const broker = {
    readAgentAnchors: vi.fn(async () => ({ anchors: [], ...(recorded ? { state } : {}) })),
    builderRuntimeStateDownloadUrl: vi.fn(async () => ({ url: "https://storage.example/legacy", method: "GET" as const, gcsPath: "legacy", expiresAt: "later" })),
  };
  const dependencies = {
    broker,
    verifyState: vi.fn(async () => undefined),
    fetchImpl: vi.fn(async () => new Response("old-sqlite-checkpoint")),
    runOpenClaw: vi.fn(async () => ({ code: 0, stdout: JSON.stringify({ ok: true }) })),
  };
  return { root, env, dependencies, broker };
}
it("recovers the recorded PostgreSQL identity before consulting a legacy SQLite checkpoint", async () => {
  const f = await fixture();
  await runBuilderRuntimeStateRestore(f.env, f.dependencies);
  expect(readPostgresAgentAnchor(builderRuntimeStatePath(f.root))).toEqual(state);
  expect(f.dependencies.verifyState).toHaveBeenCalledExactlyOnceWith(state);
  expect(f.broker.builderRuntimeStateDownloadUrl).not.toHaveBeenCalled();
  expect(f.dependencies.runOpenClaw).not.toHaveBeenCalled();
});
it("refuses missing PostgreSQL state without falling back to an old checkpoint", async () => {
  const f = await fixture();
  f.dependencies.verifyState.mockRejectedValue(new Error("state schema missing"));
  await expect(runBuilderRuntimeStateRestore(f.env, f.dependencies)).rejects.toThrow("state schema missing");
  expect(f.dependencies.fetchImpl).not.toHaveBeenCalled();
  await expect(stat(builderRuntimeStatePath(f.root))).rejects.toMatchObject({ code: "ENOENT" });
});
it.each([["cluster", false], ["gce-vm", true]] as const)("retains checkpoint recovery for %s without an applicable PG identity", async (runtime, recorded) => {
  const f = await fixture(runtime, recorded);
  await runBuilderRuntimeStateRestore(f.env, f.dependencies);
  expect(f.dependencies.runOpenClaw).toHaveBeenCalledOnce();
  expect(f.dependencies.verifyState).not.toHaveBeenCalled();
});
it("preserves existing local SQLite state without consulting a remote record", async () => {
  const f = await fixture();
  await mkdir(join(f.root, "state"));
  const db = new DatabaseSync(builderRuntimeStatePath(f.root));
  db.exec("CREATE TABLE local_state (value TEXT)");
  db.close();
  await runBuilderRuntimeStateRestore(f.env, f.dependencies);
  expect(f.broker.readAgentAnchors).not.toHaveBeenCalled();
  expect(f.dependencies.fetchImpl).not.toHaveBeenCalled();
});
