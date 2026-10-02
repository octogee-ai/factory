import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Request, Response } from "express";
import { createBuilderSurgeGateWiring, createToolchainReadinessHandler } from "../lib/fleet-provisioner.js";
import type { CustomerLifecycleAdapter } from "../lib/customer-lifecycle.js";
import { writeActivationManifest, type MigrationActivationManifest } from "../lib/migration-activation-manifest.js";
import type { SurgeOpenClawProcessSupervisorClient } from "../lib/surge-openclaw-process-gate.js";
import type { SurgeReadinessGate } from "../lib/surge-readiness.js";

const temporaryDirectories: string[] = [];
const request = { migrationId: "prepare-alice", slug: "alice", targetPodUid: "target-pod" };

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryDirectories.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

function manifest(fingerprint: string): MigrationActivationManifest {
  return {
    version: 2, slug: request.slug, appliedFingerprint: fingerprint,
    agentId: "octogee-alice-coach", accountId: "alice-coach",
    agent: { id: "octogee-alice-coach", model: "custom-model" },
    mattermostAccount: { botToken: "coach-token" },
    bindings: [{ agentId: "octogee-alice-coach", match: { channel: "mattermost", accountId: "alice-coach" } }],
    projectAgents: [],
  };
}

async function preparationFixture() {
  vi.stubEnv("GATEWAY_BUILDER_SLUG", request.slug);
  vi.stubEnv("POD_UID", request.targetPodUid);
  vi.stubEnv("OCTOGEE_BUILDER_TOOLCHAIN_LOCK_SHA256", "");
  vi.stubEnv("OCTOGEE_BUILDER_TOOL_GROUPS_SHA256", "");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "builder-preparation-"));
  temporaryDirectories.push(root);
  await writeActivationManifest(root, manifest("initial"));
  let mounted = false;
  let cloned = false;
  const cloneProjectRepo = vi.fn(async () => { cloned = true; return true; });
  const loadUserSnapshot = vi.fn(async () => ({ uid: "uid-alice", slug: request.slug, projects: [] }));
  const adapter = {
    uidForSlug: async () => "uid-alice",
    loadUserSnapshot,
    log: vi.fn(),
    isBuilderGateway: () => true,
    isConfiguredBuilderCustomer: (slug: string) => slug === request.slug,
    configuredBuilderOverlayPresent: () => true,
    customerMountMarked: () => mounted,
    listLocalCustomerSlugs: () => mounted ? [request.slug] : [],
    hasWorkspaceGitDir: () => true,
    hasGitRemote: () => true,
    listProjectsNeedingClone: async () => cloned ? [] : [{
      projectSlug: "new-project", giteaRepoName: null,
      repoSource: { provider: "github", owner: "alice", repo: "new-project" },
    }],
    cloneProjectRepo,
  } as unknown as CustomerLifecycleAdapter;
  const attach = vi.fn(async () => { mounted = true; return request.slug; });
  const state = { version: 1, podUid: request.targetPodUid, role: "target", mode: "held", phase: "held", ...request };
  const processGate = {
    status: vi.fn(async () => state), claimTargetCompletion: vi.fn(async () => state),
    permit: vi.fn(async () => state), releaseTarget: vi.fn(async () => state),
  } as unknown as SurgeOpenClawProcessSupervisorClient;
  const ready = vi.fn(async () => undefined);
  const wiring = createBuilderSurgeGateWiring({
    openclawDir: root, adapter, processGate,
    surgeReadiness: {} as SurgeReadinessGate, waitForGatewayReady: ready,
    log: vi.fn(), provisioning: { beginProvisioning: vi.fn(), finishProvisioning: vi.fn() },
    attachConfiguredBuilderBeforeOpenClaw: attach,
  });
  return { root, adapter, attach, ready, processGate, cloneProjectRepo, wiring, loadUserSnapshot };
}

describe("offline Builder preparation", () => {
  it.each(["same", "manifest", "projects"])("hydrates GitHub before permitting OpenClaw and reconciles changed inputs=%s", async (changed) => {
    const fixture = await preparationFixture();
    await fixture.wiring.prepareSurgeTarget(request);
    expect(fixture.cloneProjectRepo).toHaveBeenCalledWith(request.slug, "new-project", null, expect.objectContaining({ repoSource: expect.objectContaining({ provider: "github" }) }));
    expect(fixture.attach).toHaveBeenCalledOnce();
    expect(fixture.processGate.permit).not.toHaveBeenCalled();
    expect(fixture.ready).not.toHaveBeenCalled();
    if (changed === "manifest") await writeActivationManifest(fixture.root, manifest("updated-source"));
    if (changed === "projects") fixture.loadUserSnapshot.mockResolvedValue({ uid: "uid-alice", slug: request.slug, projects: [{ projectSlug: "added-project" }] } as never);
    await fixture.wiring.releaseSurgeReadiness(request);
    expect(fixture.attach).toHaveBeenCalledTimes(changed === "same" ? 1 : 2);
    expect(fixture.processGate.permit).toHaveBeenCalledExactlyOnceWith(request);
    expect(fixture.processGate.releaseTarget).toHaveBeenCalledExactlyOnceWith(request);
    expect(fixture.ready).toHaveBeenCalledOnce();
  });

  it("fails preparation while a required repository is still absent", async () => {
    const fixture = await preparationFixture();
    fixture.cloneProjectRepo.mockImplementation(async () => false);
    await expect(fixture.wiring.prepareSurgeTarget(request)).rejects.toThrow("pending repositories: new-project");
    expect(fixture.processGate.permit).not.toHaveBeenCalled();
  });

  it("requires the exact held target reservation before attaching", async () => {
    const fixture = await preparationFixture();
    await expect(fixture.wiring.prepareSurgeTarget({ ...request, targetPodUid: "replaced-pod" })).rejects.toThrow("not reserved by this migration");
    expect(fixture.attach).not.toHaveBeenCalled();
    expect(fixture.cloneProjectRepo).not.toHaveBeenCalled();
  });
});

describe("Builder toolchain readiness", () => {
  it.each(["held", "hydrated", "starting", "serving"] as const)("requires durable mount and prepared lifecycle state: %s", async (phase) => {
    const fixture = await preparationFixture();
    const status = vi.fn();
    const json = vi.fn();
    const res = { status: status.mockReturnValue({ json }) } as unknown as Response;
    const handler = createToolchainReadinessHandler({ adapter: fixture.adapter, prelaunchState: async () => phase, log: vi.fn() });
    await handler({} as Request, res, vi.fn());
    expect(status).toHaveBeenLastCalledWith(503);
    await fixture.wiring.prepareSurgeTarget(request);
    await handler({} as Request, res, vi.fn());
    expect(status).toHaveBeenLastCalledWith(phase === "held" ? 503 : 200);
    expect(json).toHaveBeenLastCalledWith({ ready: phase !== "held", prelaunchState: phase });
    expect(fixture.processGate.permit).not.toHaveBeenCalled();
  });
});
