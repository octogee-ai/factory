import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createAgentImportDoctorClient,
  readAgentImportWorkspaceState,
  storeAgentImportBlob,
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

  it("reports the exact clean main workspace head used by preview", () => {
    const targetDir = repo();
    expect(readAgentImportWorkspaceState("alice", { customersRoot: path.dirname(targetDir), targetDir })).toMatchObject({
      targetDir,
      clean: true,
      head: expect.stringMatching(/^[0-9a-f]{40}$/),
    });
    fs.writeFileSync(path.join(targetDir, "README.md"), "changed\n");
    expect(readAgentImportWorkspaceState("alice", { customersRoot: path.dirname(targetDir), targetDir }).clean).toBe(false);
  });

  it("stores imported binary data in the tenant workspace prefix", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const bucket = { file: vi.fn(() => ({ save })) };
    const result = await storeAgentImportBlob({
      bucket,
      slug: "alice",
      importId: "imp-1",
      filePath: "images/moof.png",
      contents: Buffer.from("png"),
      mimeType: "image/png",
      now: new Date("2026-07-20T12:00:00Z"),
    });
    expect(bucket.file).toHaveBeenCalledWith("customers/alice/agent-imports/imp-1/images/moof.png");
    expect(save).toHaveBeenCalledWith(Buffer.from("png"), { metadata: { contentType: "image/png" } });
    expect(result).toEqual({
      type: "blob",
      gcsPath: "customers/alice/agent-imports/imp-1/images/moof.png",
      size: 3,
      mimeType: "image/png",
      uploadedAt: "2026-07-20T12:00:00.000Z",
    });
  });
});
