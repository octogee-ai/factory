import * as path from "node:path";
import { readPostgresAgentAnchor } from "@octogee/core/agent-postgres";
import { parseAgentId } from "../../shared/types/identity.js";
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

type CarriedAgentStore = Pick<PreparedAgentStore, "agentId" | "destinationPath">;
type ProjectWorkspaceResolver = (agentId: string) => Promise<string | null>;
type CarriedAgentRegistration = { agentId: string; workspace: string; agentDir: string; configured: boolean };

function requiresProjectAuthority(registration: CarriedAgentRegistration): boolean {
  return !registration.configured || parseAgentId(registration.agentId).kind === "project";
}

async function assertProjectAuthority(registration: CarriedAgentRegistration, resolveProject?: ProjectWorkspaceResolver): Promise<void> {
  if (!requiresProjectAuthority(registration)) return;
  if (await resolveProject?.(registration.agentId) !== registration.workspace) {
    throw new Error(`Carried Builder project authority changed for ${registration.agentId}`);
  }
}

async function carriedAgentRegistration(store: CarriedAgentStore, roster: unknown[], resolveProject?: ProjectWorkspaceResolver): Promise<CarriedAgentRegistration> {
  const matches = roster.filter((row: unknown) => record(row) && row.id === store.agentId);
  const row: unknown = matches[0];
  const agentDir = path.dirname(store.destinationPath);
  if (matches.length > 1) throw new Error(`Native roster has duplicate carried Builder agent ${store.agentId}`);
  if (matches.length === 1) {
    if (!record(row) || typeof row.workspace !== "string" || !path.isAbsolute(row.workspace) || row.agentDir !== agentDir) {
      throw new Error(`Native roster does not match the carried Builder agent ${store.agentId}`);
    }
    const registration = { agentId: store.agentId, workspace: row.workspace, agentDir, configured: true };
    await assertProjectAuthority(registration, resolveProject);
    return registration;
  }
  const workspace = await resolveProject?.(store.agentId);
  if (typeof workspace !== "string" || !path.isAbsolute(workspace)) {
    throw new Error(`Native roster does not match the carried Builder agent ${store.agentId}`);
  }
  return { agentId: store.agentId, workspace, agentDir, configured: false };
}

export async function reattachBuilderAgents(input: {
  stores: readonly CarriedAgentStore[];
  env: NodeJS.ProcessEnv;
  assertHeld: () => Promise<void>;
  signal?: AbortSignal;
  run?: OpenClawCommand;
  resolveCarriedProjectWorkspace?: ProjectWorkspaceResolver;
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
  const registrations = [];
  for (const store of stores) {
    const registration = await carriedAgentRegistration(store, roster, input.resolveCarriedProjectWorkspace);
    if (requiresProjectAuthority(registration) && (!input.env.OPENCLAW_STATE_DIR || registration.agentDir !==
        path.join(input.env.OPENCLAW_STATE_DIR, "agents", store.agentId, "agent"))) {
      throw new Error(`Native carried project agentDir is not canonical for ${store.agentId}`);
    }
    await assertCurrent();
    assertAnchors(stores);
    registrations.push({ store, registration });
  }
  for (const { store, registration } of registrations) {
    await assertProjectAuthority(registration, input.resolveCarriedProjectWorkspace);
    await assertCurrent();
    assertAnchors(stores);
    const result = await run([
      "agents", "add", store.agentId, "--workspace", registration.workspace,
      "--agent-dir", registration.agentDir, "--non-interactive", "--json",
    ], { env: input.env, signal: input.signal });
    await assertProjectAuthority(registration, input.resolveCarriedProjectWorkspace);
    await assertCurrent();
    assertAnchors([store]);
    const outcome = restorationOutcome(result, registration);
    if (outcome === "already-configured" && !registration.configured) {
      throw new Error(`Native carried-agent roster changed during project restoration for ${store.agentId}`);
    }
    input.log(outcome === "restored"
      ? `[migration-rsync] Native restored carried Builder agent ${store.agentId}`
      : `[migration-rsync] Native reports ${store.agentId} already configured; startup admission remains required`);
  }
  assertAnchors(stores);
}
