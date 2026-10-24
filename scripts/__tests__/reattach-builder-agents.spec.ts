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
          message: mode === "already-configured" ? `agent "${f.agentId}" already exists` : "deletion cleanup is still pending" } }) }
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

it.each([
  ["successful exit", 0, false, "cli_error", "exact"],
  ["different exit", 2, false, "cli_error", "exact"],
  ["successful envelope", 1, true, "cli_error", "exact"],
  ["different error type", 1, false, "rpc_error", "exact"],
  ["foreign agent", 1, false, "cli_error", "foreign"],
  ["additional refusal", 1, false, "cli_error", "additional"],
  ["obsolete duplicate message", 1, false, "cli_error", "obsolete"],
  ["missing error", 1, false, "cli_error", "missing"],
  ["invalid JSON", 1, false, "cli_error", "invalid"],
] as const)("refuses an unproven Native duplicate receipt: %s", async (_name, code, ok, type, mode) => {
  const f = await fixture();
  const before = await fs.readFile(f.destinationPath);
  const duplicate = `agent "${f.agentId}" already exists`;
  const message = mode === "foreign" ? 'agent "octogee-other-coach" already exists'
    : mode === "additional" ? `${duplicate}; restoration is blocked`
      : mode === "obsolete" ? `Agent "${f.agentId}" already exists.` : duplicate;
  const run = vi.fn(async (args: string[]) => args[1] === "list"
    ? { code: 0, stdout: JSON.stringify([{ id: f.agentId, workspace: f.workspace, agentDir: f.agentDir }]) }
    : { code, stdout: mode === "invalid" ? "not JSON" : JSON.stringify({ ok,
      ...(mode === "missing" ? {} : { error: { type, message } }),
    }) });
  const log = vi.fn();

  await expect(reattachBuilderAgents({ stores: [f], env: { OPENCLAW_STATE_DIR: f.root }, run, log,
    assertHeld: async () => {},
  })).rejects.toThrow(/Native/);
  expect(run).toHaveBeenCalledTimes(2);
  expect(log).not.toHaveBeenCalled();
  expect(await fs.readFile(f.destinationPath)).toEqual(before);
});

it("refuses a missing carried anchor before invoking Native", async () => {
  const f = await fixture();
  await fs.unlink(f.destinationPath);
  const run = vi.fn();
  await expect(reattachBuilderAgents({ stores: [f], env: {}, run, log: vi.fn(), assertHeld: async () => {} }))
    .rejects.toThrow("Carried Builder anchor is missing");
  expect(run).not.toHaveBeenCalled();
  await expect(fs.access(f.destinationPath)).rejects.toThrow();
});

it("restores a carried project absent from the fresh Builder roster through Native", async () => {
  const coach = await fixture();
  const agentId = "octogee-chris-proj-demo-coach";
  const agentDir = path.join(coach.root, "agents", agentId, "agent");
  const project = { agentId, agentDir, destinationPath: path.join(agentDir, "openclaw-agent.sqlite"),
    workspace: path.join(coach.workspace, "projects", "demo") };
  await fs.mkdir(agentDir, { recursive: true });
  await fs.copyFile(coach.destinationPath, project.destinationPath);
  const database = new DatabaseSync(project.destinationPath);
  database.prepare("UPDATE openclaw_engine_anchor SET store_id = ?").run("2514f000-4540-4f4e-92a1-831adeac3d5b");
  database.close();
  const before = await fs.readFile(project.destinationPath);
  const resolveCarriedProjectWorkspace = vi.fn(async (id: string) => id === agentId ? project.workspace : null);
  const run = vi.fn(async (args: string[]) => args[1] === "list"
    ? { code: 0, stdout: JSON.stringify([{ id: coach.agentId, workspace: coach.workspace, agentDir: coach.agentDir }]) }
    : { code: 0, stdout: JSON.stringify({ agentId: args[2], workspace: args[args.indexOf("--workspace") + 1], agentDir: args[args.indexOf("--agent-dir") + 1] }) });

  await expect(reattachBuilderAgents({ stores: [coach, project], env: { OPENCLAW_STATE_DIR: coach.root }, run, log: vi.fn(),
    assertHeld: async () => {}, resolveCarriedProjectWorkspace })).resolves.toBeUndefined();

  expect(resolveCarriedProjectWorkspace).toHaveBeenCalledTimes(3);
  expect(resolveCarriedProjectWorkspace.mock.calls.every(([id]) => id === agentId)).toBe(true);
  expect(run.mock.calls.map(([args]) => args)).toContainEqual([
    "agents", "add", agentId, "--workspace", project.workspace, "--agent-dir", agentDir, "--non-interactive", "--json",
  ]);
  expect(await fs.readFile(project.destinationPath)).toEqual(before);
});

it.each(["noncanonical-agent-dir", "missing-workspace", "duplicate-roster", "roster-changed", "hold-lost"] as const)(
  "keeps an unconfigured carried project closed when %s",
  async mode => {
    const f = await fixture();
    const projectId = "octogee-chris-proj-demo-coach";
    const agentDir = path.join(f.root, "agents", projectId, mode === "noncanonical-agent-dir" ? "other" : "agent");
    const destinationPath = path.join(agentDir, "openclaw-agent.sqlite");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.copyFile(f.destinationPath, destinationPath);
    let held = true;
    const workspace = path.join(f.workspace, "projects", "demo");
    const run = vi.fn(async (args: string[]) => args[1] === "list"
      ? { code: 0, stdout: JSON.stringify(mode === "duplicate-roster" ? [
        { id: projectId, workspace, agentDir }, { id: projectId, workspace, agentDir },
      ] : []) }
      : { code: 1, stdout: JSON.stringify({ ok: false, error: { type: "cli_error", message: `agent "${projectId}" already exists` } }) });
    const before = await fs.readFile(destinationPath);
    await expect(reattachBuilderAgents({ stores: [{ agentId: projectId, destinationPath }], env: { OPENCLAW_STATE_DIR: f.root }, run,
      log: vi.fn(), assertHeld: async () => { if (!held) throw new Error("target hold lost"); },
      resolveCarriedProjectWorkspace: async () => {
        if (mode === "hold-lost") held = false;
        return mode === "missing-workspace" ? null : workspace;
      },
    })).rejects.toThrow(/Native|hold lost/);
    expect(run).toHaveBeenCalledTimes(mode === "roster-changed" ? 2 : 1);
    expect(await fs.readFile(destinationPath)).toEqual(before);
  },
);

it.each(["earlier-agent-add", "project-add"] as const)("rechecks carried project authority across %s", async mode => {
  const coach = await fixture();
  const agentId = "octogee-chris-proj-demo-coach";
  const agentDir = path.join(coach.root, "agents", agentId, "agent");
  const destinationPath = path.join(agentDir, "openclaw-agent.sqlite");
  const workspace = path.join(coach.workspace, "projects", "demo");
  await fs.mkdir(agentDir, { recursive: true });
  await fs.copyFile(coach.destinationPath, destinationPath);
  const before = await fs.readFile(destinationPath);
  let enabled = true;
  const run = vi.fn(async (args: string[]) => {
    if (args[1] === "list") return { code: 0, stdout: JSON.stringify([
      { id: coach.agentId, workspace: coach.workspace, agentDir: coach.agentDir },
    ]) };
    await Promise.resolve();
    if (args[2] === (mode === "earlier-agent-add" ? coach.agentId : agentId)) enabled = false;
    return { code: 0, stdout: JSON.stringify({ agentId: args[2], workspace: args[args.indexOf("--workspace") + 1],
      agentDir: args[args.indexOf("--agent-dir") + 1] }) };
  });

  await expect(reattachBuilderAgents({ stores: [coach, { agentId, destinationPath }], env: { OPENCLAW_STATE_DIR: coach.root }, run,
    log: vi.fn(), assertHeld: async () => {}, resolveCarriedProjectWorkspace: async () => enabled ? workspace : null,
  })).rejects.toThrow("Carried Builder project authority changed");

  expect(run.mock.calls.some(([args]) => args[1] === "add" && args[2] === agentId)).toBe(mode === "project-add");
  expect(await fs.readFile(destinationPath)).toEqual(before);
});

it.each(["disabled", "workspace-changed"] as const)("rechecks current project authority on a partially registered retry: %s", async mode => {
  const f = await fixture();
  const agentId = "octogee-chris-proj-demo-coach";
  const agentDir = path.join(f.root, "agents", agentId, "agent");
  const destinationPath = path.join(agentDir, "openclaw-agent.sqlite");
  const workspace = path.join(f.workspace, "projects", "demo");
  await fs.mkdir(agentDir, { recursive: true });
  await fs.copyFile(f.destinationPath, destinationPath);
  const before = await fs.readFile(destinationPath);
  let registered = false, enabled = true, currentWorkspace = workspace;
  const resolveCarriedProjectWorkspace = vi.fn(async () => enabled ? currentWorkspace : null);
  const run = vi.fn(async (args: string[]) => {
    if (args[1] === "list") return { code: 0, stdout: JSON.stringify(registered ? [{ id: agentId, workspace, agentDir }] : []) };
    if (registered) return { code: 1, stdout: JSON.stringify({ ok: false,
      error: { type: "cli_error", message: `agent "${agentId}" already exists` } }) };
    registered = true;
    enabled = false;
    return { code: 0, stdout: JSON.stringify({ agentId, workspace, agentDir }) };
  });
  const input = { stores: [{ agentId, destinationPath }], env: { OPENCLAW_STATE_DIR: f.root }, run,
    log: vi.fn(), assertHeld: async () => {}, resolveCarriedProjectWorkspace };
  await expect(reattachBuilderAgents(input)).rejects.toThrow("Carried Builder project authority changed");
  expect(registered).toBe(true);
  const checksAfterFirst = resolveCarriedProjectWorkspace.mock.calls.length;
  if (mode === "workspace-changed") { enabled = true; currentWorkspace = path.join(f.workspace, "other"); }

  await expect(reattachBuilderAgents(input)).rejects.toThrow("Carried Builder project authority changed");

  expect(resolveCarriedProjectWorkspace.mock.calls.length).toBeGreaterThan(checksAfterFirst);
  expect(run.mock.calls.filter(([args]) => args[1] === "add")).toHaveLength(1);
  enabled = true;
  currentWorkspace = workspace;
  await expect(reattachBuilderAgents(input)).resolves.toBeUndefined();
  expect(run.mock.calls.filter(([args]) => args[1] === "add")).toHaveLength(2);
  expect(await fs.readFile(destinationPath)).toEqual(before);
});

it.each(["missing-authority", "wrong-workspace", "noncanonical-agent-dir"] as const)("refuses a configured carried project before restoring any agent: %s", async mode => {
  const f = await fixture();
  const agentId = "octogee-chris-proj-demo-coach";
  const agentDir = path.join(f.root, "agents", agentId, mode === "noncanonical-agent-dir" ? "other" : "agent");
  const destinationPath = path.join(agentDir, "openclaw-agent.sqlite");
  const workspace = path.join(f.workspace, "projects", "demo");
  await fs.mkdir(agentDir, { recursive: true });
  await fs.copyFile(f.destinationPath, destinationPath);
  const before = await fs.readFile(destinationPath);
  const run = vi.fn(async (args: string[]) => args[1] === "list" ? { code: 0, stdout: JSON.stringify([
    { id: f.agentId, workspace: f.workspace, agentDir: f.agentDir },
    { id: agentId, workspace: mode === "wrong-workspace" ? path.join(f.workspace, "other") : workspace, agentDir },
  ]) } : { code: 1, stdout: JSON.stringify({ ok: false,
    error: { type: "cli_error", message: `agent "${args[2]}" already exists` } }) });
  await expect(reattachBuilderAgents({ stores: [f, { agentId, destinationPath }], env: { OPENCLAW_STATE_DIR: f.root }, run,
    log: vi.fn(), assertHeld: async () => {},
    resolveCarriedProjectWorkspace: mode === "missing-authority" ? undefined : async () => workspace,
  })).rejects.toThrow(/authority changed|agentDir is not canonical/);
  expect(run).toHaveBeenCalledOnce();
  expect(await fs.readFile(destinationPath)).toEqual(before);
});

it("preserves configured custom-agent restoration without project authority", async () => {
  const f = await fixture();
  const agentId = "custom-retained-agent";
  const resolveCarriedProjectWorkspace = vi.fn(async () => null);
  const run = vi.fn(async (args: string[]) => args[1] === "list"
    ? { code: 0, stdout: JSON.stringify([{ id: agentId, workspace: f.workspace, agentDir: f.agentDir }]) }
    : { code: 1, stdout: JSON.stringify({ ok: false, error: { type: "cli_error", message: `agent "${agentId}" already exists` } }) });
  await expect(reattachBuilderAgents({ stores: [{ agentId, destinationPath: f.destinationPath }], env: { OPENCLAW_STATE_DIR: f.root },
    run, log: vi.fn(), assertHeld: async () => {}, resolveCarriedProjectWorkspace })).resolves.toBeUndefined();
  expect(resolveCarriedProjectWorkspace).not.toHaveBeenCalled();
});
