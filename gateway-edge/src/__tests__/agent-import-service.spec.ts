import { describe, expect, it, vi } from "vitest";

import { buildAgentImportConfigArtifacts } from "@octogee/shared/types/agent-import";
import {
  AgentImportService,
  type AgentImportRecord,
  type AgentImportServiceDeps,
  type StoredAgentImportPlan,
} from "../lib/agent-import-service.js";

const SOURCE_HEAD = "a".repeat(40);
const DESTINATION_HEAD = "b".repeat(40);
const IMPORT_COMMIT = "c".repeat(40);

function artifacts() {
  return buildAgentImportConfigArtifacts({
    meta: { lastTouchedVersion: "2025.4.3" },
    agents: {
      list: [{
        id: "moof",
        name: "Moof",
        persona: "Jack's trusty sidekick.",
        identity: { emoji: "🐮" },
        heartbeat: { every: "30m", lightContext: true },
        model: "anthropic/claude-sonnet",
      }],
    },
    channels: { telegram: { token: "must-never-cross" } },
  }, "moof");
}

function harness(overrides: Partial<AgentImportServiceDeps> = {}) {
  const records = new Map<string, AgentImportRecord>();
  const plans = new Map<string, StoredAgentImportPlan>();
  const archives = new Map<string, Buffer>();
  const cleanup = vi.fn();
  const deps: AgentImportServiceDeps = {
    newId: () => "import-1",
    now: () => new Date("2026-07-20T12:00:00.000Z"),
    readGithubToken: vi.fn(async () => "github-oauth"),
    cloneGithubSource: vi.fn(() => ({ repoDir: "/source", sourceHead: SOURCE_HEAD, cleanup })),
    extractLocalSource: vi.fn(async () => ({
      repoDir: "/source",
      sourceHead: SOURCE_HEAD,
      artifacts: artifacts(),
      manifest: { formatVersion: 1, sourceAgentId: "moof", hadGit: true, uncommittedFileCount: 0 },
      cleanup,
    })),
    inspectSource: vi.fn(async () => ({
      head: SOURCE_HEAD,
      commitCount: 14,
      fileCount: 9,
      totalBytes: 4200,
      workspaceDigest: `sha256:${"d".repeat(64)}`,
      secretFindings: [],
    })),
    workspaceState: vi.fn(() => ({ targetDir: "/target", head: DESTINATION_HEAD, clean: true })),
    runDoctor: vi.fn(async () => ({
      outcome: "migrated",
      doctorVersion: "2026.7.2",
      changedPaths: ["agents.list"],
      diagnostics: [],
      repairedCandidate: artifacts().doctorCandidate,
    })),
    putRecord: vi.fn(async (record) => { records.set(record.id, structuredClone(record)); }),
    getRecord: vi.fn(async (id) => records.get(id) ? structuredClone(records.get(id)!) : null),
    putPlan: vi.fn(async (id, plan) => { plans.set(id, structuredClone(plan)); }),
    getPlan: vi.fn(async (id) => plans.get(id) ? structuredClone(plans.get(id)!) : null),
    putArchive: vi.fn(async (id, archive) => { archives.set(id, Buffer.from(archive)); }),
    getArchive: vi.fn(async (id) => archives.get(id) ? Buffer.from(archives.get(id)!) : null),
    deleteStaging: vi.fn(async (id) => { plans.delete(id); archives.delete(id); }),
    applyRepository: vi.fn(async () => ({ importCommit: IMPORT_COMMIT, sourceRef: "refs/octogee/imports/import-1/source" })),
    rollbackRepository: vi.fn(async () => ({ rollbackCommit: "e".repeat(40) })),
    readIdentity: vi.fn(async () => ({ name: "Octo", persona: "Default", emoji: "🐙" })),
    syncIdentity: vi.fn(async () => undefined),
    withConfigLock: vi.fn(async (work) => work()),
    invokeOpenClaw: vi.fn()
      .mockResolvedValueOnce({
        hash: "config-before",
        config: { agents: { list: [{ id: "octogee-jack-coach", heartbeat: { every: "60m" } }] } },
      })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        hash: "config-after",
        config: { agents: { list: [{ id: "octogee-jack-coach", heartbeat: { every: "30m", lightContext: true } }] } },
      })
      .mockResolvedValueOnce({ status: "ok" })
      .mockResolvedValueOnce({
        hash: "config-before-rollback",
        config: { agents: { list: [{ id: "octogee-jack-coach", heartbeat: { every: "30m", lightContext: true } }] } },
      })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        hash: "config-after-rollback",
        config: { agents: { list: [{ id: "octogee-jack-coach", heartbeat: { every: "60m" } }] } },
      })
      .mockResolvedValueOnce({ status: "ok" }),
    ...overrides,
  };
  return { service: new AgentImportService(deps), deps, records, plans, archives, cleanup };
}

describe("AgentImportService preview", () => {
  it("previews GitHub history with current Doctor and stores no OAuth token or source credential", async () => {
    const h = harness();
    const preview = await h.service.previewGithub({
      uid: "uid-jack",
      slug: "jack",
      gatewayId: "shared-1",
      owner: "jack",
      repo: "moof",
      branch: "main",
      artifacts: artifacts(),
    });

    expect(preview).toMatchObject({
      id: "import-1",
      source: { kind: "github", owner: "jack", repo: "moof", branch: "main", head: SOURCE_HEAD },
      workspace: { commitCount: 14, fileCount: 9, historyPreserved: true },
      doctor: { outcome: "migrated", doctorVersion: "2026.7.2" },
    });
    expect(preview.approvalHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(preview.config.decisions).toContainEqual(expect.objectContaining({
      path: "model.primary",
      disposition: "reauth_then_apply",
    }));
    expect(JSON.stringify([...h.records.values()])).not.toContain("github-oauth");
    expect(JSON.stringify([...h.plans.values()])).not.toContain("must-never-cross");
    expect(h.cleanup).toHaveBeenCalledOnce();
  });

  it("falls back to the safe config when Doctor cannot migrate the source", async () => {
    const h = harness({
      runDoctor: vi.fn(async () => ({
        outcome: "unsupported",
        doctorVersion: "2026.7.2",
        changedPaths: [],
        diagnostics: ["doctor_exit_2"],
      })),
    });
    const preview = await h.service.previewGithub({
      uid: "uid-jack",
      slug: "jack",
      gatewayId: "shared-1",
      owner: "jack",
      repo: "moof",
      branch: "main",
      artifacts: artifacts(),
    });

    expect(preview.config.effectiveOutcome).toBe("safe_baseline");
    expect(preview.config.runtimePatch).toEqual({});
    expect(preview.workspace.historyPreserved).toBe(true);
  });

  it("falls back to the safe config when the current Doctor is unavailable", async () => {
    const h = harness({
      runDoctor: vi.fn(async () => { throw new Error("doctor unavailable"); }),
    });
    const preview = await h.service.previewGithub({
      uid: "uid-jack",
      slug: "jack",
      gatewayId: "shared-1",
      owner: "jack",
      repo: "moof",
      branch: "main",
      artifacts: artifacts(),
    });

    expect(preview.doctor).toMatchObject({
      outcome: "failed",
      doctorVersion: "unavailable",
      diagnostics: ["doctor_unavailable"],
    });
    expect(preview.config.effectiveOutcome).toBe("safe_baseline");
  });

  it("stages a normalized local archive and uses its locally reduced artifacts", async () => {
    const h = harness();
    const archive = Buffer.from("normalized zip bytes");
    const preview = await h.service.previewLocal({
      uid: "uid-jack",
      slug: "jack",
      gatewayId: "shared-1",
      archive,
    });

    expect(preview.source.kind).toBe("local");
    expect(h.deps.putArchive).toHaveBeenCalledWith("import-1", archive);
    expect(h.archives.get("import-1")).toEqual(archive);
  });

  it("publishes no preview record when durable local archive staging fails", async () => {
    const h = harness({
      putArchive: vi.fn(async () => { throw new Error("GCS unavailable"); }),
    });
    await expect(h.service.previewLocal({
      uid: "uid-jack",
      slug: "jack",
      gatewayId: "shared-1",
      archive: Buffer.from("normalized zip bytes"),
    })).rejects.toThrow("GCS unavailable");
    expect(h.records.size).toBe(0);
    expect(h.deps.deleteStaging).toHaveBeenCalledWith("import-1");
  });
});

describe("AgentImportService apply and rollback", () => {
  it("requires the exact preview hash, imports history, updates identity, and patches only the Octogee coach", async () => {
    const h = harness();
    const preview = await h.service.previewGithub({
      uid: "uid-jack",
      slug: "jack",
      gatewayId: "shared-1",
      owner: "jack",
      repo: "moof",
      branch: "main",
      artifacts: artifacts(),
    });

    await expect(h.service.apply({ uid: "uid-jack", importId: preview.id, approvalHash: "wrong" }))
      .rejects.toMatchObject({ code: "approval_mismatch" });
    const completed = await h.service.apply({
      uid: "uid-jack",
      importId: preview.id,
      approvalHash: preview.approvalHash,
    });

    expect(h.deps.applyRepository).toHaveBeenCalledWith(expect.objectContaining({
      sourceHead: SOURCE_HEAD,
      destinationHead: DESTINATION_HEAD,
      importId: "import-1",
      slug: "jack",
    }));
    expect(h.deps.syncIdentity).toHaveBeenCalledWith("uid-jack", {
      name: "Moof",
      persona: "Jack's trusty sidekick.",
      emoji: "🐮",
    });
    const identityCheckpointCall = vi.mocked(h.deps.putRecord).mock.calls.findIndex(([record]) =>
      record.previousIdentity?.name === "Octo"
    );
    expect(vi.mocked(h.deps.putRecord).mock.invocationCallOrder[identityCheckpointCall])
      .toBeLessThan(vi.mocked(h.deps.syncIdentity).mock.invocationCallOrder[0]);
    expect(h.deps.invokeOpenClaw).toHaveBeenNthCalledWith(2, "config.patch", {
      raw: JSON.stringify({
        agents: { list: [{ id: "octogee-jack-coach", heartbeat: { every: "30m", lightContext: true } }] },
      }),
      baseHash: "config-before",
    });
    const runtimeCheckpointCall = vi.mocked(h.deps.putRecord).mock.calls.findIndex(([record]) =>
      record.previousRuntime?.heartbeat !== undefined
    );
    expect(vi.mocked(h.deps.putRecord).mock.invocationCallOrder[runtimeCheckpointCall])
      .toBeLessThan(vi.mocked(h.deps.invokeOpenClaw).mock.invocationCallOrder[1]);
    expect(completed).toMatchObject({
      status: "complete",
      importCommit: IMPORT_COMMIT,
      configOutcome: "applied",
    });
    expect(h.deps.deleteStaging).toHaveBeenCalledWith("import-1");
  });

  it("completes on the safe baseline when local config RPC rejects the optional delta", async () => {
    const invokeOpenClaw = vi.fn()
      .mockResolvedValueOnce({
        hash: "config-before",
        config: { agents: { list: [{ id: "octogee-jack-coach", heartbeat: { every: "60m" } }] } },
      })
      .mockRejectedValueOnce(new Error("config patch rejected"))
      .mockResolvedValueOnce({
        hash: "config-rollback",
        config: { agents: { list: [{ id: "octogee-jack-coach", heartbeat: { every: "60m" } }] } },
      })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        hash: "config-restored",
        config: { agents: { list: [{ id: "octogee-jack-coach", heartbeat: { every: "60m" } }] } },
      })
      .mockResolvedValueOnce({ status: "ok" });
    const h = harness({ invokeOpenClaw });
    const preview = await h.service.previewGithub({
      uid: "uid-jack",
      slug: "jack",
      gatewayId: "shared-1",
      owner: "jack",
      repo: "moof",
      branch: "main",
      artifacts: artifacts(),
    });
    const completed = await h.service.apply({ uid: "uid-jack", importId: preview.id, approvalHash: preview.approvalHash });

    expect(completed.status).toBe("complete");
    expect(completed.configOutcome).toBe("safe_baseline");
    expect(completed.warnings).toContain("config_delta_rejected");
    expect(invokeOpenClaw).toHaveBeenNthCalledWith(4, "config.patch", expect.objectContaining({
      raw: JSON.stringify({
        agents: { list: [{ id: "octogee-jack-coach", heartbeat: { every: "60m" } }] },
      }),
    }));
  });

  it("fails instead of claiming a safe baseline when reverse-patch readback is wrong", async () => {
    const invokeOpenClaw = vi.fn()
      .mockResolvedValueOnce({
        hash: "config-before",
        config: { agents: { list: [{ id: "octogee-jack-coach", heartbeat: { every: "60m" } }] } },
      })
      .mockRejectedValueOnce(new Error("config patch rejected"))
      .mockResolvedValueOnce({
        hash: "config-rollback",
        config: { agents: { list: [{ id: "octogee-jack-coach", heartbeat: { every: "30m" } }] } },
      })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        hash: "config-still-wrong",
        config: { agents: { list: [{ id: "octogee-jack-coach", heartbeat: { every: "30m" } }] } },
      });
    const h = harness({ invokeOpenClaw });
    const preview = await h.service.previewGithub({
      uid: "uid-jack",
      slug: "jack",
      gatewayId: "shared-1",
      owner: "jack",
      repo: "moof",
      branch: "main",
      artifacts: artifacts(),
    });

    await expect(h.service.apply({ uid: "uid-jack", importId: preview.id, approvalHash: preview.approvalHash }))
      .rejects.toMatchObject({ code: "config_readback_failed" });
    expect(h.records.get(preview.id)?.status).toBe("failed");
  });

  it("resumes from the durable workspace checkpoint after an interrupted apply", async () => {
    const syncIdentity = vi.fn()
      .mockRejectedValueOnce(new Error("Firestore temporarily unavailable"))
      .mockResolvedValue(undefined);
    const h = harness({ syncIdentity });
    const preview = await h.service.previewGithub({
      uid: "uid-jack",
      slug: "jack",
      gatewayId: "shared-1",
      owner: "jack",
      repo: "moof",
      branch: "main",
      artifacts: artifacts(),
    });
    await expect(h.service.apply({ uid: "uid-jack", importId: preview.id, approvalHash: preview.approvalHash }))
      .rejects.toThrow("Firestore temporarily unavailable");

    const completed = await h.service.apply({ uid: "uid-jack", importId: preview.id, approvalHash: preview.approvalHash });
    expect(completed.status).toBe("complete");
    expect(completed.error).toBeUndefined();
    expect(h.deps.applyRepository).toHaveBeenCalledTimes(1);
  });

  it("reconciles an exact prior Git import when its checkpoint write was interrupted", async () => {
    let workspaceHead = DESTINATION_HEAD;
    const applyRepository = vi.fn(async () => {
      workspaceHead = IMPORT_COMMIT;
      return { importCommit: IMPORT_COMMIT, sourceRef: "refs/octogee/imports/import-1/source" };
    });
    const h = harness({
      workspaceState: vi.fn(() => ({ targetDir: "/target", head: workspaceHead, clean: true })),
      applyRepository,
    });
    const preview = await h.service.previewGithub({
      uid: "uid-jack",
      slug: "jack",
      gatewayId: "shared-1",
      owner: "jack",
      repo: "moof",
      branch: "main",
      artifacts: artifacts(),
    });
    const putRecord = h.deps.putRecord;
    let interruptCheckpoint = true;
    h.deps.putRecord = vi.fn(async (record) => {
      if (record.importCommit && interruptCheckpoint) {
        interruptCheckpoint = false;
        throw new Error("Firestore checkpoint unavailable");
      }
      await putRecord(record);
    });

    await expect(h.service.apply({ uid: "uid-jack", importId: preview.id, approvalHash: preview.approvalHash }))
      .rejects.toThrow("Firestore checkpoint unavailable");
    const completed = await h.service.apply({ uid: "uid-jack", importId: preview.id, approvalHash: preview.approvalHash });

    expect(completed.status).toBe("complete");
    expect(completed.importCommit).toBe(IMPORT_COMMIT);
    expect(applyRepository).toHaveBeenCalledTimes(2);
  });

  it("keeps a completed import complete when staging cleanup must be retried", async () => {
    const h = harness({
      deleteStaging: vi.fn(async () => { throw new Error("GCS cleanup unavailable"); }),
    });
    const preview = await h.service.previewGithub({
      uid: "uid-jack",
      slug: "jack",
      gatewayId: "shared-1",
      owner: "jack",
      repo: "moof",
      branch: "main",
      artifacts: artifacts(),
    });

    const completed = await h.service.apply({ uid: "uid-jack", importId: preview.id, approvalHash: preview.approvalHash });

    expect(completed.status).toBe("complete");
    expect(completed.warnings).toContain("staging_cleanup_pending");
  });

  it("coalesces concurrent apply requests for the same approved import", async () => {
    let releaseApply!: () => void;
    const applyStarted = new Promise<void>((resolve) => { releaseApply = resolve; });
    let continueApply!: () => void;
    const applyRepository = vi.fn(async () => {
      releaseApply();
      await new Promise<void>((resolve) => { continueApply = resolve; });
      return { importCommit: IMPORT_COMMIT, sourceRef: "refs/octogee/imports/import-1/source" };
    });
    const h = harness({ applyRepository });
    const preview = await h.service.previewGithub({
      uid: "uid-jack",
      slug: "jack",
      gatewayId: "shared-1",
      owner: "jack",
      repo: "moof",
      branch: "main",
      artifacts: artifacts(),
    });

    const first = h.service.apply({ uid: "uid-jack", importId: preview.id, approvalHash: preview.approvalHash });
    await applyStarted;
    const second = h.service.apply({ uid: "uid-jack", importId: preview.id, approvalHash: preview.approvalHash });
    continueApply();
    const [left, right] = await Promise.all([first, second]);

    expect(left).toEqual(right);
    expect(applyRepository).toHaveBeenCalledOnce();
  });

  it("rolls back the workspace and prior identity without deleting imported history", async () => {
    const h = harness();
    const preview = await h.service.previewGithub({
      uid: "uid-jack",
      slug: "jack",
      gatewayId: "shared-1",
      owner: "jack",
      repo: "moof",
      branch: "main",
      artifacts: artifacts(),
    });
    await h.service.apply({ uid: "uid-jack", importId: preview.id, approvalHash: preview.approvalHash });
    const rolledBack = await h.service.rollback({ uid: "uid-jack", importId: preview.id });

    expect(h.deps.rollbackRepository).toHaveBeenCalledWith(expect.objectContaining({
      importCommit: IMPORT_COMMIT,
      destinationHead: DESTINATION_HEAD,
    }));
    expect(h.deps.syncIdentity).toHaveBeenLastCalledWith("uid-jack", {
      name: "Octo",
      persona: "Default",
      emoji: "🐙",
    });
    expect(rolledBack.status).toBe("rolled_back");
  });

  it("resumes rollback after Git succeeded but its checkpoint write was interrupted", async () => {
    const h = harness();
    const preview = await h.service.previewGithub({
      uid: "uid-jack",
      slug: "jack",
      gatewayId: "shared-1",
      owner: "jack",
      repo: "moof",
      branch: "main",
      artifacts: artifacts(),
    });
    await h.service.apply({ uid: "uid-jack", importId: preview.id, approvalHash: preview.approvalHash });
    const putRecord = h.deps.putRecord;
    let interruptCheckpoint = true;
    h.deps.putRecord = vi.fn(async (record) => {
      if (record.rollbackCommit && interruptCheckpoint) {
        interruptCheckpoint = false;
        throw new Error("rollback checkpoint unavailable");
      }
      await putRecord(record);
    });

    await expect(h.service.rollback({ uid: "uid-jack", importId: preview.id }))
      .rejects.toThrow("rollback checkpoint unavailable");
    const rolledBack = await h.service.rollback({ uid: "uid-jack", importId: preview.id });

    expect(rolledBack.status).toBe("rolled_back");
    expect(h.deps.rollbackRepository).toHaveBeenCalledTimes(2);
  });
});
