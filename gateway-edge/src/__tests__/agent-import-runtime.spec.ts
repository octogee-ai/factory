import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createAgentImportDoctorClient,
  invokeLocalOpenClaw,
  readAgentImportWorkspaceState,
  type AgentImportOpenClawDeps,
} from "../lib/agent-import-runtime.js";

const roots: string[] = [];

function repo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-import-runtime-test-"));
  roots.push(root);
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  spawnSync("git", ["config", "user.email", "test@octogee.invalid"], { cwd: root });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: root });
  fs.writeFileSync(path.join(root, "README.md"), "safe\n");
  spawnSync("git", ["add", "."], { cwd: root });
  spawnSync("git", ["commit", "-qm", "initial"], { cwd: root });
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("agent import runtime", () => {
  it("uses the shared authenticated local upstream for import RPCs", async () => {
    const ws = { close: vi.fn() };
    const rpc = {
      call: vi.fn(async () => ({ ok: true as const, result: { outcome: "unchanged" } })),
      dispose: vi.fn(),
    };
    const deps = {
      gatewayId: () => "eggman-devdays",
      gatewayUrl: () => "http://127.0.0.1:18789",
      openAuthenticatedUpstream: vi.fn(async () => ws),
      attachRpcClient: vi.fn(() => rpc),
    } as unknown as AgentImportOpenClawDeps;

    await expect(invokeLocalOpenClaw("config.doctor", { candidate: {} }, deps))
      .resolves.toEqual({ outcome: "unchanged" });

    expect(deps.openAuthenticatedUpstream).toHaveBeenCalledWith({
      gatewayId: "eggman-devdays",
      url: "http://127.0.0.1:18789",
    });
    expect(rpc.call).toHaveBeenCalledWith("config.doctor", { candidate: {} });
    expect(rpc.dispose).toHaveBeenCalledTimes(1);
    expect(ws.close).toHaveBeenCalledTimes(1);
  });

  it("sends the secret-free doctor candidate only to the authenticated pod-local doctor", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      outcome: "unchanged",
      doctorVersion: "2026.7.1",
      changedPaths: [],
      diagnostics: [],
      repairedCandidate: { agents: { list: [{ id: "moof" }] } },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const run = createAgentImportDoctorClient({
      baseUrl: "http://127.0.0.1:3003",
      token: "gateway-secret",
      fetchImpl,
    });

    await expect(run({ agents: { list: [{ id: "moof" }] } })).resolves.toMatchObject({ outcome: "unchanged" });
    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:3003/agent-import/doctor", {
      method: "POST",
      headers: { authorization: "Bearer gateway-secret", "content-type": "application/json" },
      body: JSON.stringify({ candidate: { agents: { list: [{ id: "moof" }] } } }),
      signal: expect.any(AbortSignal),
    });
  });

  it("fails closed when the current-version doctor is unavailable", async () => {
    const run = createAgentImportDoctorClient({
      baseUrl: "http://127.0.0.1:3003",
      token: "gateway-secret",
      fetchImpl: vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 })),
    });
    await expect(run({ agents: {} })).rejects.toThrow("doctor rejected candidate (503)");
  });

  it("reports the exact clean main workspace head used by preview", async () => {
    const targetDir = repo();
    await expect(readAgentImportWorkspaceState("alice", { usersRoot: path.dirname(targetDir), targetDir })).resolves.toMatchObject({
      targetDir,
      clean: true,
      head: expect.stringMatching(/^[0-9a-f]{40}$/),
    });
    fs.writeFileSync(path.join(targetDir, "README.md"), "changed\n");
    await expect(readAgentImportWorkspaceState("alice", { usersRoot: path.dirname(targetDir), targetDir }))
      .resolves.toMatchObject({ clean: false });
  });

});
