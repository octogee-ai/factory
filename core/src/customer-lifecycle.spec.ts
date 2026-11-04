import { describe, it, expect, beforeEach, vi } from "vitest";
import { provisionCoachAutomation } from "./gateway-rpc.js";
import {
  addCustomerToGateway,
  cloneMissingProjects,
  cloneProjectsFromSnapshot,
  ConcurrentMountError,
  _resetInFlightUidsForTests,
  _inFlightUidsHasForTests,
  pubKeysMatch,
  removeCustomerFromGateway,
  restoreCustomerRuntimeFromSnapshot,
  type CustomerLifecycleAdapter,
  type ProjectCloneOptions,
  type ProjectCloneTarget,
  type UserSnapshot,
  type MmUpdate,
} from "./customer-lifecycle.js";

interface DiskState {
  customerDir: boolean;
  agentRuntime?: boolean;
  workspaceGitDir: boolean;
  gitRemote: boolean;
  sshKey: boolean;
  templatesWritten: boolean;

repoHasCommits: boolean;
}

interface MockState {
  user: UserSnapshot | null;
  disk: DiskState;
  
  calls: string[];
  
  writes: Array<{ field: string; value: unknown }>;
  cloneShouldFail: boolean;

cloneSimulatesEmptyRepo: boolean;
  initShouldFail: boolean;
  giteaRegisterShouldFail: boolean;

giteaRegisteredPubKey: string | null;

giteaRegisteredPubKeys?: string[];

giteaReadShouldThrow: boolean;

giteaReleaseShouldFail?: boolean;

  blobSyncShouldFail: boolean;
  reassertByotShouldFail?: boolean;
  reassertByotUserData?: Record<string, unknown>;
  reassertContextFilesShouldFail?: boolean;
  reassertContextFilesUserData?: Record<string, unknown>;
  communityMembershipCtx?: { uid: string; slug: string };
  byosub?: { restored: boolean; present: boolean };
  lastConfigPatchByosActive?: boolean;
  lastConfigPatchOpts?: Parameters<CustomerLifecycleAdapter["applyAddCustomerConfigPatch"]>[2];
  configPatchWithoutProjectIds: Array<readonly string[]>;
  configPatchFingerprint?: string;
  healthy: boolean;
  pendingProjects: ProjectCloneTarget[];
  cloneProjectCalls: Array<{
    projectSlug: string;
    giteaRepoName: string | null;
    opts: ProjectCloneOptions | undefined;
  }>;
  logs: string[];
  cloneProjectThrows?: boolean;
  cloneProjectLands?: boolean;

}

function deferredFlag(): { value: boolean } {
  return { value: false };
}

function makeAdapter(state: MockState): CustomerLifecycleAdapter {
  const record = (name: string) => state.calls.push(name);
  const write = (field: string, value: unknown) => {
    record(`write:${field}`);
    state.writes.push({ field, value });
  };
  return {
    log: (msg) => state.logs.push(msg),

    isConfiguredBuilderCustomer: () => true,
    configuredBuilderOverlayPresent: () => true,

    loadUserSnapshot: async () => state.user,

    setProvisioningStatus: async (_uid, status) => write("provisioning.openclaw.status", status),
    provisionCoachAutomation: async () => record("provisionCoachAutomation"),
    setRepoUrl: async (_uid, repoUrl) => write("provisioning.git.repoUrl", repoUrl),
    setMattermostFields: async (_uid, fields) => write("mattermost.*", fields),
    ensureAgentIds: async (_uid, agentIds) =>
      write("provisioning.openclaw.agentIds", agentIds),

    hasCustomerDir: () => state.disk.customerDir,
    hasCustomerAgentRuntime: () => state.disk.agentRuntime ?? state.disk.customerDir,
    hasWorkspaceGitDir: () => state.disk.workspaceGitDir,
    hasGitRemote: () => state.disk.gitRemote,
    ensureCustomerDirectories: () => {
      record("ensureCustomerDirectories");
      state.disk.customerDir = true;
    },
    writeCustomerTemplateFiles: async () => {
      record("writeCustomerTemplateFiles");
      state.disk.templatesWritten = true;
    },
    removePartialWorkspace: async () => {
      record("removePartialWorkspace");
      state.disk.customerDir = false;
      state.disk.workspaceGitDir = false;
      state.disk.gitRemote = false;
    },
    deleteDepartedCustomerState: async () => {
      record("deleteDepartedCustomerState");
      state.disk.customerDir = false;
      state.disk.workspaceGitDir = false;
      state.disk.gitRemote = false;
    },

    cloneWorkspaceRepo: async (_slug, _url) => {
      record("cloneWorkspaceRepo");
      if (state.cloneShouldFail) return false;

      if (state.disk.customerDir && !state.disk.workspaceGitDir) return false;
      state.disk.customerDir = true;
      state.disk.workspaceGitDir = true;
      state.disk.gitRemote = true;

if (!state.cloneSimulatesEmptyRepo) {
        state.disk.repoHasCommits = true;
      }
      return true;
    },
    initWorkspaceRepoFromExistingDir: async () => {
      record("initWorkspaceRepoFromExistingDir");
      if (state.initShouldFail) return null;
      state.disk.workspaceGitDir = true;
      state.disk.gitRemote = true;
      return "http://gitea/octogee/test-workspace";
    },

    hasCustomerSshKey: () => state.disk.sshKey,
    generateCustomerSshKey: () => {
      record("generateCustomerSshKey");
      state.disk.sshKey = true;

return "ssh-pubkey";
    },
    createGiteaUser: async (_slug, pubKey) => {
      record("createGiteaUser");
      if (state.giteaRegisterShouldFail) {
        throw new Error("gitea register failed");
      }

      if (state.giteaRegisteredPubKeys) {
        if (!state.giteaRegisteredPubKeys.includes(pubKey)) {
          state.giteaRegisteredPubKeys.push(pubKey);
        }
      } else {
        state.giteaRegisteredPubKey = pubKey;
      }
    },
    ensureGiteaOrg: async () => {
      record("ensureGiteaOrg");
    },
    ensureSystemConfigRepo: async () => {
      record("ensureSystemConfigRepo");
    },
    readLocalCustomerPubKey: () => (state.disk.sshKey ? "ssh-pubkey" : null),
    readGiteaCustomerPubKeys: async () => {
      if (state.giteaReadShouldThrow) {
        throw new Error("Gitea key read failed (test transient)");
      }
      return state.giteaRegisteredPubKeys ??
        (state.giteaRegisteredPubKey === null ? [] : [state.giteaRegisteredPubKey]);
    },
    deleteCustomerSshKey: async () => {
      record("deleteCustomerSshKey");
      state.disk.sshKey = false;
    },
    releaseGiteaUserKey: async (_slug, pubKey) => {
      record(`releaseGiteaUserKey:${pubKey}`);
      if (state.giteaReleaseShouldFail) throw new Error("gitea release failed");
    },

    blobSyncForSlug: async () => {
      record("blobSyncForSlug");
      if (state.blobSyncShouldFail) throw new Error("blob sync failed");
    },
    restoreByosubForAgent: async () => {
      record("restoreByosubForAgent");
      return state.byosub ?? { restored: false, present: false };
    },
    reassertByotForCustomer: async (userData) => {
      record("reassertByotForCustomer");
      state.reassertByotUserData = userData;
      if (state.reassertByotShouldFail) throw new Error("byot reassert failed");
    },
    reassertConvergedContextFilesForCustomer: async (userData) => {
      record("reassertConvergedContextFilesForCustomer");
      state.reassertContextFilesUserData = userData;
      if (state.reassertContextFilesShouldFail) throw new Error("context-file reassert failed");
    },

    listProjectsNeedingClone: async () => {
      record("listProjectsNeedingClone");
      return [...state.pendingProjects];
    },
    cloneProjectRepo: async (_slug, projectSlug, giteaRepoName, opts) => {
      record("cloneProjectRepo");
      state.cloneProjectCalls.push({ projectSlug, giteaRepoName, opts });
      if (state.cloneProjectThrows) throw new Error("gitea unreachable");
      if (state.cloneProjectLands === false) return false;
      // A landed clone leaves a .git behind, so the project no longer needs cloning —
      // listProjectsNeedingClone is an on-disk probe, not a static list.
      state.pendingProjects = state.pendingProjects.filter((p) => p.projectSlug !== projectSlug);
      return true;
    },

    provisionMattermostUser: async () => {
      record("provisionMattermostUser");
      const update: MmUpdate = {
        "mattermost.userId": "mm-user-123",
        "mattermost.channelId": "c".repeat(26),
        _coachPersonalToken: "coach-pat",
      };
      return update;
    },
    applyAddCustomerConfigPatch: async (_snap, _mm, opts) => {
      record("applyAddCustomerConfigPatch");
      state.lastConfigPatchOpts = opts;
      state.lastConfigPatchByosActive = opts?.byosActive ?? false;
      state.configPatchWithoutProjectIds.push([...(opts?.withoutProjectIds ?? [])]);
      return {
        elapsedMs: 42,
        ...(state.configPatchFingerprint
          ? { appliedFingerprint: state.configPatchFingerprint }
          : {}),
      };
    },
    applyRemoveCustomerConfigPatch: async () => {
      record("applyRemoveCustomerConfigPatch");
    },
    waitForAccountHealthy: async () => {
      record("waitForAccountHealthy");
      return state.healthy;
    },
    projectAgentsHealthy: async () => true,
    materializeBrokerProfiles: () => record("materializeBrokerProfiles"),

    notifyOpsOfSignup: async () => {
      record("notifyOpsOfSignup");
    },

    onMounted: () => record("onMounted"),
    onUnmounted: () => record("onUnmounted"),
    uidForSlug: async () => state.user?.uid ?? null,
    quiesceCustomer: async () => ({ drained: true, runningCount: 0 }),
    listExportPaths: async () => [],
    prepareImportDir: async () => "/tmp/import",
    prepareKeyImportDir: async () => "/tmp/import",
    activateImportedCustomer: async () => ({ appliedFingerprint: "fp-test" }),
  };
}

function snap(overrides: Partial<UserSnapshot> = {}): UserSnapshot {
  return {
    uid: "uid-test",
    slug: "test",
    tier: "trial",
    gatewayId: "gw-test",
    status: "",
    agentIds: [],
    repoUrl: "",
    mattermostUserId: null,
    channels: [{ scope: "workspace", kind: "coach-dm", channelId: "c".repeat(26) }],
    ownerName: "Test User",
    projectCheckoutScope: "workspace-and-projects",
    ...overrides,
  };
}

function emptyDisk(): DiskState {
  return {
    customerDir: false,
    workspaceGitDir: false,
    gitRemote: false,
    sshKey: false,
    templatesWritten: false,
    repoHasCommits: false,
  };
}

function makeState(snapshot: UserSnapshot | null, disk: DiskState): MockState {
  return {
    user: snapshot,
    disk,
    calls: [],
    writes: [],
    cloneShouldFail: false,
    cloneSimulatesEmptyRepo: false,
    initShouldFail: false,
    giteaRegisterShouldFail: false,
    giteaRegisteredPubKey: null,
    giteaReadShouldThrow: false,
    blobSyncShouldFail: false,
    healthy: true,
    pendingProjects: [],
    cloneProjectCalls: [],
    configPatchWithoutProjectIds: [],
    logs: [],
  };
}

const GITHUB_REPO_SOURCE = {
  provider: "github",
  owner: "octogee-ai",
  repo: "demo",
} as const;

function mountedDisk(): DiskState {
  return {
    ...emptyDisk(),
    customerDir: true,
    workspaceGitDir: true,
    gitRemote: true,
    sshKey: true,
  };
}

function mountedSnapshot(overrides: Partial<UserSnapshot> = {}): UserSnapshot {
  return snap({
    status: "complete",
    repoUrl: "http://gitea/octogee/test-workspace",
    mattermostUserId: "mm-user",
    ...overrides,
  });
}

describe("addCustomerToGateway — first-time provisioning", () => {
  let state: MockState;
  beforeEach(() => {
    state = makeState(snap({ status: "" }), emptyDisk());
  });

  it("completes a new workspace after channel verification without posting a greeting", async () => {
    await addCustomerToGateway(makeAdapter(state), "uid-test");
    expect(state.calls).toContain("waitForAccountHealthy");
    expect(state.writes).toContainEqual({ field: "provisioning.openclaw.status", value: "complete" });
    expect(state.writes.some((write) => write.field.includes("greeting"))).toBe(false);
  });

  it("provisions coach monitoring after readiness and before durable completion", async () => {
    await addCustomerToGateway(makeAdapter(state), "uid-test");
    const provisioned = state.calls.indexOf("provisionCoachAutomation");
    expect(provisioned).toBeGreaterThan(state.calls.indexOf("waitForAccountHealthy"));
    expect(provisioned).toBeLessThan(state.calls.lastIndexOf("write:provisioning.openclaw.status"));
  });

  it("uses the newly created private coach channel while the snapshot is stale", async () => {
    const adapter = makeAdapter(state);
    const channelId = "c".repeat(26);
    const cronAdd = vi.fn(async () => ({ id: "initial-monitor" }));
    adapter.provisionMattermostUser = async () => ({ "mattermost.userId": "a".repeat(26), "mattermost.channelId": channelId });
    adapter.provisionCoachAutomation = async (customer) => {
      await provisionCoachAutomation({ cronAdd }, customer);
    };
    await addCustomerToGateway(adapter, "uid-test");
    expect(cronAdd).toHaveBeenCalledWith(expect.objectContaining({
      delivery: { mode: "announce", channel: "mattermost", accountId: "test-coach", to: `channel:${channelId}` },
    }));
  });

  it("refuses a missing private coach channel before monitoring or completion", async () => {
    const adapter = makeAdapter(state);
    adapter.provisionMattermostUser = async () => ({});
    adapter.provisionCoachAutomation = vi.fn(async () => {});
    await expect(addCustomerToGateway(adapter, "uid-test")).rejects.toThrow("has no private coach channel");
    expect(adapter.provisionCoachAutomation).not.toHaveBeenCalled();
    expect(state.writes).not.toContainEqual({ field: "provisioning.openclaw.status", value: "complete" });
  });

  it("uses only the canonical workspace coach channel on a provisioning retry", async () => {
    state.user = snap({ status: "provisioning", mattermostUserId: "a".repeat(26), channels: [
      { scope: "workspace", kind: "general", channelId: "g".repeat(26) },
      { scope: "project", projectId: "project", kind: "coach-dm", channelId: "p".repeat(26) },
      { scope: "workspace", kind: "coach-dm", channelId: "c".repeat(26) },
    ] });
    const adapter = makeAdapter(state);
    adapter.provisionCoachAutomation = vi.fn(async () => {});
    await addCustomerToGateway(adapter, "uid-test");
    expect(adapter.provisionCoachAutomation).toHaveBeenCalledWith({ slug: "test", coachChannelId: "c".repeat(26) });
  });

  it("refuses ambiguous private coach channel bindings before durable completion", async () => {
    state.user = snap({ status: "provisioning", mattermostUserId: "a".repeat(26), channels: [
      { scope: "workspace", kind: "coach-dm", channelId: "a".repeat(26) },
      { scope: "workspace", kind: "coach-dm", channelId: "b".repeat(26) },
    ] });
    await expect(addCustomerToGateway(makeAdapter(state), "uid-test")).rejects.toThrow("has no private coach channel");
    expect(state.writes).not.toContainEqual({ field: "provisioning.openclaw.status", value: "complete" });
  });

  it("keeps failed monitor provisioning pending and retries before completing", async () => {
    const adapter = makeAdapter(state);
    const provision = vi.fn().mockRejectedValueOnce(new Error("cron unavailable")).mockResolvedValue(undefined);
    adapter.provisionCoachAutomation = provision;
    await expect(addCustomerToGateway(adapter, "uid-test")).rejects.toThrow("cron unavailable");
    expect(state.writes).not.toContainEqual({ field: "provisioning.openclaw.status", value: "complete" });
    state.user = snap({ status: "provisioning", mattermostUserId: "mm-user" });
    await addCustomerToGateway(adapter, "uid-test");
    expect(provision).toHaveBeenCalledTimes(2);
    expect(state.writes).toContainEqual({ field: "provisioning.openclaw.status", value: "complete" });
  });

  it("does not recreate deleted monitoring during a completed customer reconcile", async () => {
    state.user = mountedSnapshot({ agentIds: ["octogee-test-coach"] });
    state.disk = mountedDisk();
    const adapter = makeAdapter(state);
    adapter.provisionCoachAutomation = vi.fn(async () => {});
    await addCustomerToGateway(adapter, "uid-test");
    expect(adapter.provisionCoachAutomation).not.toHaveBeenCalled();
  });

  it("runs the full first-time flow and writes Firestore in canonical order", async () => {
    const result = await addCustomerToGateway(makeAdapter(state), "uid-test");

    expect(result.newCustomer).toBe(true);

expect(result.steps).toEqual([
      "claim-slot",
      "ssh-key",
      "write-templates",
      "init-workspace-repo",
      "mattermost-provision",
      "config-patch",
      "verify-channel-ready",
      "byot-reassert",
      "context-files-reassert",
      "mark-complete",
      "blob-sync",
      "notify-ops",
    ]);
  });

  it("verifies channel readiness right after config convergence, before the byot re-assert", async () => {
    await addCustomerToGateway(makeAdapter(state), "uid-test");

    const patchIndex = state.calls.indexOf("applyAddCustomerConfigPatch");
    const verifyIndex = state.calls.indexOf("waitForAccountHealthy");
    const reassertIndex = state.calls.indexOf("reassertByotForCustomer");

    expect(verifyIndex).toBeGreaterThan(patchIndex);
    expect(reassertIndex).toBeGreaterThan(verifyIndex);
  });

  it("marks the Builder complete before community membership, blob sync and the ops notice", async () => {
    const adapter = {
      ...makeAdapter(state),
      reconcileCommunityMembership: async () => {
        state.calls.push("reconcileCommunityMembership");
      },
    };
    await addCustomerToGateway(adapter, "uid-test");

    const verifyIdx = state.calls.indexOf("waitForAccountHealthy");
    const completeIdx = state.calls.indexOf("write:provisioning.openclaw.status");
    const completeAt = state.calls.lastIndexOf("write:provisioning.openclaw.status");
    expect(state.writes.filter((w) => w.field === "provisioning.openclaw.status").map((w) => w.value))
      .toEqual(["provisioning", "complete"]);
    expect(completeIdx).toBeLessThan(verifyIdx);
    expect(completeAt).toBeGreaterThan(verifyIdx);
    for (const later of ["reconcileCommunityMembership", "blobSyncForSlug", "notifyOpsOfSignup"]) {
      expect(state.calls.indexOf(later), later).toBeGreaterThan(completeAt);
    }
  });

  it("names the coach agent on the Builder when the slot is claimed, before broker profiles start", async () => {
    await addCustomerToGateway(makeAdapter(state), "uid-test");

    const agentIdsIdx = state.calls.indexOf("write:provisioning.openclaw.agentIds");
    expect(agentIdsIdx).toBeGreaterThan(state.calls.indexOf("write:provisioning.openclaw.status"));
    expect(agentIdsIdx).toBeLessThan(state.calls.indexOf("materializeBrokerProfiles"));
    expect(state.writes.find((w) => w.field === "provisioning.openclaw.agentIds")?.value).toEqual(["octogee-test-coach"]);
  });

  it("starts broker profile materialization before Gitea and settles it for the config patch", async () => {
    let settled = false;
    const adapter = {
      ...makeAdapter(state),
      materializeBrokerProfiles: async () => {
        state.calls.push("materializeBrokerProfiles");
        await new Promise((resolve) => setTimeout(resolve, 5));
        settled = true;
      },
    };
    await addCustomerToGateway(adapter, "uid-test");

    expect(state.calls.indexOf("materializeBrokerProfiles")).toBeLessThan(state.calls.indexOf("createGiteaUser"));
    expect(state.lastConfigPatchOpts?.brokerProfilesReady).toBeInstanceOf(Promise);
    await state.lastConfigPatchOpts!.brokerProfilesReady;
    expect(settled).toBe(true);
  });

  it("keeps a failed early broker profile materialization non-fatal", async () => {
    let attempts = 0;
    const adapter = {
      ...makeAdapter(state),
      materializeBrokerProfiles: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("openclaw refused the secrets apply");
      },
    };
    const result = await addCustomerToGateway(adapter, "uid-test");

    expect(result.steps).toContain("mark-complete");
    await expect(state.lastConfigPatchOpts!.brokerProfilesReady).resolves.toBeUndefined();
    expect(state.logs.some((line) => line.includes("early broker profile materialization failed"))).toBe(true);
  });

  it("provisions the workspace repo and Mattermost concurrently", async () => {
    const adapter = {
      ...makeAdapter(state),
      initWorkspaceRepoFromExistingDir: async () => {
        const deadline = Date.now() + 500;
        while (!state.calls.includes("provisionMattermostUser")) {
          if (Date.now() > deadline) throw new Error("Mattermost provisioning waited for the Gitea repo");
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
        state.calls.push("initWorkspaceRepoFromExistingDir");
        return "http://gitea.local/test/workspace";
      },
    };
    const result = await addCustomerToGateway(adapter, "uid-test");

    expect(result.steps.slice(0, 5)).toEqual([
      "claim-slot", "ssh-key", "write-templates", "init-workspace-repo", "mattermost-provision",
    ]);
    expect(state.calls.indexOf("applyAddCustomerConfigPatch"))
      .toBeGreaterThan(state.calls.indexOf("initWorkspaceRepoFromExistingDir"));
  });

  it("waits for Mattermost provisioning to finish before a Gitea failure releases the mount", async () => {
    const mattermostDone = deferredFlag();
    const adapter = {
      ...makeAdapter(state),
      initWorkspaceRepoFromExistingDir: async () => {
        throw new Error("gitea down");
      },
      provisionMattermostUser: async () => {
        state.calls.push("provisionMattermostUser");
        await new Promise((resolve) => setTimeout(resolve, 20));
        mattermostDone.value = true;
        state.calls.push("provisionMattermostUser:done");
        return { "mattermost.userId": "mm-user-123", _coachPersonalToken: "coach-pat" };
      },
    };

    await expect(addCustomerToGateway(adapter, "uid-test")).rejects.toThrow("gitea down");

    expect(mattermostDone.value).toBe(true);
    expect(state.calls).toContain("provisionMattermostUser:done");
    expect(state.calls).not.toContain("applyAddCustomerConfigPatch");
  });

  it("retries the deferred broker profiles once the coach is verified, before marking the workspace complete", async () => {
    await addCustomerToGateway(makeAdapter(state), "uid-test");

    const verifyIdx = state.calls.indexOf("waitForAccountHealthy");
    const materializeIdx = state.calls.lastIndexOf("materializeBrokerProfiles");
    const completeIdx = state.calls.lastIndexOf("write:provisioning.openclaw.status");

    expect(materializeIdx).toBeGreaterThan(verifyIdx);
    expect(completeIdx).toBeGreaterThan(materializeIdx);
  });

  it("ensures the per-workspace Gitea org BEFORE the workspace repo (#963)", async () => {
    await addCustomerToGateway(makeAdapter(state), "uid-test");

    const orgIdx = state.calls.indexOf("ensureGiteaOrg");
    const repoIdx = state.calls.indexOf("initWorkspaceRepoFromExistingDir");

expect(orgIdx).toBeGreaterThan(-1);
    expect(repoIdx).toBeGreaterThan(orgIdx);
  });

  it("ensures the durable system_config repo for every customer, not just non-shared pods (#3196)", async () => {
    await addCustomerToGateway(makeAdapter(state), "uid-test");

    const orgIdx = state.calls.indexOf("ensureGiteaOrg");
    const systemConfigIdx = state.calls.indexOf("ensureSystemConfigRepo");

    expect(systemConfigIdx).toBeGreaterThan(-1);
    expect(systemConfigIdx).toBeGreaterThan(orgIdx);
  });

  it("converges BYOS from the durable ref on mount, BEFORE the config-patch reload (no user-doc signal needed)", async () => {
    state.byosub = { restored: true, present: true }; 
    const result = await addCustomerToGateway(makeAdapter(state), "uid-test");

    const restoreIdx = state.calls.indexOf("restoreByosubForAgent");
    const patchIdx = state.calls.indexOf("applyAddCustomerConfigPatch");

expect(restoreIdx).toBeGreaterThan(-1);
    expect(patchIdx).toBeGreaterThan(restoreIdx);
    expect(result.steps).toContain("byosub-restore");

expect(state.lastConfigPatchByosActive).toBe(true);
  });

it("re-mount over a healthy on-disk cred: byosActive stays true (no model clobber) but no byosub-restore step", async () => {
    state.byosub = { restored: false, present: true };
    const result = await addCustomerToGateway(makeAdapter(state), "uid-test");
    expect(state.calls).toContain("restoreByosubForAgent");
    expect(state.lastConfigPatchByosActive).toBe(true);
    expect(result.steps).not.toContain("byosub-restore");
  });

  it("is a self-no-op for non-BYOS customers (called, but no step, default model)", async () => {
    const result = await addCustomerToGateway(makeAdapter(state), "uid-test");
    expect(state.calls).toContain("restoreByosubForAgent");
    expect(result.steps).not.toContain("byosub-restore");
    expect(state.lastConfigPatchByosActive).toBe(false);
  });

  it("first-time BYOT provision: forwards byot state with a COMPLETE runtime status (the agent is mounted by config-patch), so the non-anthropic key is written, not skipped/cleared", async () => {
    // status "" is the first-provision reality: loadAndPrepareForMount never advances the
    // in-memory snapshot, so forwarding snapshot.status would derive input=null and skip
    // writing this BYOK customer's models.json. The reassert runs post-mount, so it must
    // tell deriveDesiredByotState the runtime is complete.
    state.user = snap({
      status: "",
      tier: "pro",
      byotActive: true,
      systemConfig: { byot: { provider: "openai", model: "gpt-4o" } },
    });
    const result = await addCustomerToGateway(makeAdapter(state), "uid-test");
    expect(state.calls).toContain("reassertByotForCustomer");
    expect(result.steps).toContain("byot-reassert");

    const ud = state.reassertByotUserData ?? {};
    expect(ud.username).toBe("test");
    expect(ud.byotActive).toBe(true);
    expect(ud.systemConfig).toEqual({ byot: { provider: "openai", model: "gpt-4o" } });
    expect(ud.tier).toBe("pro");
    expect(ud.provisioning).toEqual({
      openclaw: { status: "complete" },
    });
  });

  it("forwards the trial grant to the reassert so its configured plans survive the mount boundary", async () => {
    const claimedSeconds = Math.floor(Date.now() / 1000) - 2 * 86_400;
    const trialGrant = {
      schemaVersion: 3,
      offerId: "builder-signup",
      offerVersion: 1,
      personalTier: "personal",
      builderTier: "hobby",
      configHash: "config-a",
      claimedAt: { _seconds: claimedSeconds, _nanoseconds: 0 },
      endsAt: { _seconds: claimedSeconds + 7 * 86_400, _nanoseconds: 0 },
    };
    state.user = snap({
      tier: "personal_free",
      trialGrant,
      systemConfig: {
        agentModels: { "octogee-test-coach": { primary: "platform-openrouter/minimax/minimax-m3", fallbacks: [] } },
      },
    });
    await addCustomerToGateway(makeAdapter(state), "uid-test");

    const ud = state.reassertByotUserData ?? {};
    expect(ud.tier).toBe("personal_free");
    expect(ud.trialGrant).toBe(trialGrant);
  });

  it("forwards builderSubscription to the reassert — a credits builder's picks must not defer to house_only at mount", async () => {
    state.user = snap({
      tier: "personal_free",
      builderSubscription: { tier: "hobby", status: "active" },
      systemConfig: {
        agentModels: { "octogee-test-coach": { primary: "platform-openrouter/z-ai/glm-5.2", fallbacks: [] } },
      },
    });
    await addCustomerToGateway(makeAdapter(state), "uid-test");

    const ud = state.reassertByotUserData ?? {};
    expect(ud.builderSubscription).toEqual({ tier: "hobby", status: "active" });
  });

  it("a byot re-assert failure is non-fatal — the mount still completes", async () => {
    state.reassertByotShouldFail = true;
    const result = await addCustomerToGateway(makeAdapter(state), "uid-test");
    expect(state.calls).toContain("reassertByotForCustomer");
    expect(result.steps).not.toContain("byot-reassert");
    expect(result.steps).toContain("verify-channel-ready");
  });

  it("forwards the same plan-resolution fields to the context-file reassert as the byot reassert", async () => {
    state.user = snap({
      tier: "personal_free",
      builderSubscription: { tier: "hobby", status: "active" },
    });
    await addCustomerToGateway(makeAdapter(state), "uid-test");

    expect(state.calls).toContain("reassertConvergedContextFilesForCustomer");
    const ud = state.reassertContextFilesUserData ?? {};
    expect(ud.username).toBe("test");
    expect(ud.tier).toBe("personal_free");
    expect(ud.builderSubscription).toEqual({ tier: "hobby", status: "active" });
  });

  it("a context-file re-assert failure is non-fatal — the mount still completes", async () => {
    state.reassertContextFilesShouldFail = true;
    const result = await addCustomerToGateway(makeAdapter(state), "uid-test");
    expect(state.calls).toContain("reassertConvergedContextFilesForCustomer");
    expect(result.steps).not.toContain("context-files-reassert");
    expect(result.steps).toContain("verify-channel-ready");
  });

  it("a byot re-assert failure does not skip the context-file reassert (independent failure domains)", async () => {
    state.reassertByotShouldFail = true;
    const result = await addCustomerToGateway(makeAdapter(state), "uid-test");
    expect(result.steps).not.toContain("byot-reassert");
    expect(result.steps).toContain("context-files-reassert");
  });

  it("a context-file re-assert failure does not skip the byot reassert (independent failure domains)", async () => {
    state.reassertContextFilesShouldFail = true;
    const result = await addCustomerToGateway(makeAdapter(state), "uid-test");
    expect(result.steps).toContain("byot-reassert");
    expect(result.steps).not.toContain("context-files-reassert");
  });

  it("is a no-op when the adapter does not implement community membership reconciliation (optional method)", async () => {
    const result = await addCustomerToGateway(makeAdapter(state), "uid-test");
    expect(result.steps).not.toContain("community-membership");
  });

  it("reconciles community membership on first-time provisioning when the adapter supports it", async () => {
    const adapter = {
      ...makeAdapter(state),
      reconcileCommunityMembership: async (ctx: { uid: string; slug: string }) => {
        state.calls.push("reconcileCommunityMembership");
        state.communityMembershipCtx = ctx;
      },
    };
    const result = await addCustomerToGateway(adapter, "uid-test");
    expect(state.calls).toContain("reconcileCommunityMembership");
    expect(result.steps).toContain("community-membership");
    expect(state.communityMembershipCtx?.uid).toBe("uid-test");
    expect(state.communityMembershipCtx?.slug).toBe("test");
  });

  it("a community membership reconcile failure is non-fatal — the mount still completes", async () => {
    const adapter = {
      ...makeAdapter(state),
      reconcileCommunityMembership: async () => {
        state.calls.push("reconcileCommunityMembership");
        throw new Error("community reconcile failed");
      },
    };
    const result = await addCustomerToGateway(adapter, "uid-test");
    expect(state.calls).toContain("reconcileCommunityMembership");
    expect(result.steps).not.toContain("community-membership");
    expect(result.steps).toContain("verify-channel-ready");
  });

  it("writes provisioning.git.repoUrl IMMEDIATELY after the repo init succeeds", async () => {
    await addCustomerToGateway(makeAdapter(state), "uid-test");

    const initIdx = state.calls.indexOf("initWorkspaceRepoFromExistingDir");
    const writeIdx = state.calls.indexOf("write:provisioning.git.repoUrl");
    expect(initIdx).toBeGreaterThan(-1);
    expect(writeIdx).toBeGreaterThan(initIdx);
    const between = state.calls.slice(initIdx + 1, writeIdx);
    expect(between).toEqual([]);
  });

  it("aborts loudly if the initial workspace repo creation fails", async () => {
    state.initShouldFail = true;
    await expect(addCustomerToGateway(makeAdapter(state), "uid-test")).rejects.toThrow(
      /initial workspace repo creation failed/,
    );
    expect(state.writes.find((w) => w.field === "provisioning.git.repoUrl")).toBeUndefined();
  });

  it("aborts loudly if the channel never reaches running+connected (no half-mounts)", async () => {
    state.healthy = false;
    await expect(addCustomerToGateway(makeAdapter(state), "uid-test")).rejects.toThrow(
      /didn't reach running\+connected/,
    );
    expect(state.calls).toContain("waitForAccountHealthy");
    
    expect(state.writes.find((w) => w.field === "provisioning.openclaw.status" && w.value === "complete")).toBeUndefined();
  });

  it("notifies ops on first-time provision only", async () => {
    await addCustomerToGateway(makeAdapter(state), "uid-test");
    expect(state.calls).toContain("notifyOpsOfSignup");
  });
});

describe("addCustomerToGateway — restore from Gitea (post pod loss)", () => {
  let state: MockState;
  beforeEach(() => {
    
    state = makeState(
      snap({
        status: "complete",
        agentIds: ["octogee-test-coach"],
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user-existing",
      }),
      emptyDisk(),
    );
  });

  it("clones the workspace from Gitea instead of reinitializing", async () => {
    const result = await addCustomerToGateway(makeAdapter(state), "uid-test");

    expect(result.newCustomer).toBe(false);
    expect(result.steps).toContain("clone-workspace-repo");
    expect(result.steps).not.toContain("init-workspace-repo");
  });

  it("ensures customer workspace templates after the clone", async () => {
    const result = await addCustomerToGateway(makeAdapter(state), "uid-test");

    expect(result.steps).toContain("write-templates");
    expect(state.calls).toContain("writeCustomerTemplateFiles");
  });

  it("does NOT re-provision Mattermost", async () => {
    await addCustomerToGateway(makeAdapter(state), "uid-test");

    expect(state.calls).not.toContain("provisionMattermostUser");
    expect(state.calls).not.toContain("notifyOpsOfSignup");
  });

  it("aborts loudly on a clone failure (workspace data is at risk)", async () => {
    state.cloneShouldFail = true;
    await expect(addCustomerToGateway(makeAdapter(state), "uid-test")).rejects.toThrow(
      /workspace clone from .* failed/,
    );
  });

  it("removes a partial non-git customer dir before cloning from Gitea", async () => {
    state.disk.customerDir = true;
    state.disk.workspaceGitDir = false;
    state.disk.gitRemote = false;

    const result = await addCustomerToGateway(makeAdapter(state), "uid-test");

    expect(result.steps).toContain("clone-workspace-repo");
    expect(state.calls).toContain("removePartialWorkspace");
    expect(state.calls).not.toContain("deleteDepartedCustomerState");
    expect(state.calls.indexOf("removePartialWorkspace")).toBeLessThan(
      state.calls.indexOf("cloneWorkspaceRepo"),
    );
  });

  it("does NOT pre-create the customer dir before the clone (would break git clone)", async () => {

await addCustomerToGateway(makeAdapter(state), "uid-test");

    const ensureIdx = state.calls.indexOf("ensureCustomerDirectories");
    const cloneIdx = state.calls.indexOf("cloneWorkspaceRepo");
    expect(cloneIdx).toBeGreaterThan(-1);

if (ensureIdx !== -1) {
      expect(ensureIdx).toBeGreaterThan(cloneIdx);
    }
  });

  it("still applies the config patch and verifies (the whole point of the restore)", async () => {
    const result = await addCustomerToGateway(makeAdapter(state), "uid-test");

    expect(state.calls).toContain("applyAddCustomerConfigPatch");
    expect(state.calls).toContain("waitForAccountHealthy");
    expect(result.steps).toContain("verify-channel-ready");
  });

  it("returns the exact snapshot fingerprint applied by the successful config patch", async () => {
    state.configPatchFingerprint = "post-mattermost-fingerprint";

    const result = await addCustomerToGateway(makeAdapter(state), "uid-test");

    expect(result.appliedFingerprint).toBe("post-mattermost-fingerprint");
  });

  it("passes publication custody and pending checkouts to the guarded adapter", async () => {
    const adapter = makeAdapter(state);
    const runtimePublication = { settled: Promise.resolve(), invalidateFingerprint: vi.fn() };
    const patch = adapter.applyAddCustomerConfigPatch;
    adapter.applyAddCustomerConfigPatch = async (...args) => {
      expect(args[2]?.runtimePublication).toBe(runtimePublication);
      const result = await patch(...args);
      return result;
    };

    await addCustomerToGateway(adapter, "uid-test", { runtimePublication });

    expect(state.lastConfigPatchOpts?.withoutProjectIds).toEqual([]);
  });

  it("refreshes the customer snapshot before reasserting cohort model state", async () => {
    const adapter = makeAdapter(state);
    const applyAddCustomerConfigPatch = adapter.applyAddCustomerConfigPatch;
    adapter.applyAddCustomerConfigPatch = async (...args) => {
      const result = await applyAddCustomerConfigPatch(...args);
      state.user = snap({
        status: "complete",
        agentIds: ["octogee-test-coach"],
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user-existing",
      });
      return result;
    };

    await addCustomerToGateway(adapter, "uid-test");

    expect(state.reassertByotUserData?.provisioning).toEqual({
      openclaw: { status: "complete" },
    });
  });
});

describe("addCustomerToGateway — recovery from orphan dir (the bug class)", () => {
  it("creates the Gitea repo AND writes Firestore in the same step", async () => {

const state = makeState(
      snap({
        status: "complete",
        agentIds: ["octogee-test-coach"],
        repoUrl: "",
        mattermostUserId: "mm-user-existing",
      }),
      { ...emptyDisk(), customerDir: true, workspaceGitDir: true, gitRemote: false },
    );

    const result = await addCustomerToGateway(makeAdapter(state), "uid-test");

    expect(result.steps).toContain("init-workspace-repo");
    const initIdx = state.calls.indexOf("initWorkspaceRepoFromExistingDir");
    const writeIdx = state.calls.indexOf("write:provisioning.git.repoUrl");
    expect(initIdx).toBeGreaterThan(-1);
    expect(writeIdx).toBeGreaterThan(initIdx);
    expect(state.calls.slice(initIdx + 1, writeIdx)).toEqual([]);
  });

  it("aborts loudly if the recovery init fails (no silent Firestore drift)", async () => {
    const state = makeState(
      snap({
        status: "complete",
        repoUrl: "",
        mattermostUserId: "mm-user-existing",
      }),
      { ...emptyDisk(), customerDir: true, workspaceGitDir: true, gitRemote: false },
    );
    state.initShouldFail = true;

    await expect(addCustomerToGateway(makeAdapter(state), "uid-test")).rejects.toThrow(
      /recovery workspace repo creation failed/,
    );
    expect(state.writes.find((w) => w.field === "provisioning.git.repoUrl")).toBeUndefined();
  });
});

describe("addCustomerToGateway — empty-Gitea restore (mid-bootstrap pod loss)", () => {
  it("re-writes templates when the cloned repo has no working tree", async () => {

const state = makeState(
      snap({
        status: "complete",
        agentIds: ["octogee-test-coach"],
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user-existing",
      }),
      emptyDisk(),
    );
    state.cloneSimulatesEmptyRepo = true;

    const result = await addCustomerToGateway(makeAdapter(state), "uid-test");

    expect(result.steps).toContain("clone-workspace-repo");
    expect(result.steps).toContain("write-templates");

const cloneIdx = state.calls.indexOf("cloneWorkspaceRepo");
    const writeIdx = state.calls.indexOf("writeCustomerTemplateFiles");
    expect(writeIdx).toBeGreaterThan(cloneIdx);
  });

});

describe("addCustomerToGateway — configured Builder overlay", () => {
  function configuredProjectState(): MockState {
    const state = makeState(snap({
      status: "complete",
      agentIds: ["octogee-test-coach"],
      repoUrl: "http://gitea/octogee/test-workspace",
      mattermostUserId: "mm-user-existing",
      projectAgents: [{ projectId: "launchroom", enabled: true, mmUserId: "project-bot", token: "project-pat" }],
    }), {
      customerDir: true,
      workspaceGitDir: true,
      gitRemote: true,
      sshKey: true,
      templatesWritten: true,
      repoHasCommits: true,
    });
    state.giteaRegisteredPubKey = "ssh-pubkey";
    state.pendingProjects = [{ projectSlug: "launchroom", giteaRepoName: "launchroom" }];
    return state;
  }

  it.each([true, false])("reconciles configured project agents after checkout convergence (checkout lands: %s)", async (checkoutLands) => {
    const state = configuredProjectState();
    state.cloneProjectLands = checkoutLands;
    const adapter = makeAdapter(state);
    const runtimePublication = { settled: Promise.resolve(), invalidateFingerprint: vi.fn() };
    adapter.isBuilderGateway = () => true;
    adapter.reconcileConfiguredBuilderProjectAgents = async (snapshot, opts) => {
      expect(snapshot).toBe(state.user);
      expect(state.calls).toContain("cloneProjectRepo");
      expect(opts?.withoutProjectIds).toEqual(checkoutLands ? [] : ["launchroom"]);
      expect(opts?.runtimePublication).toBe(runtimePublication);
      state.calls.push("reconcileConfiguredBuilderProjectAgents");
      return { elapsedMs: 10, appliedFingerprint: "project-activation" };
    };

    const result = await addCustomerToGateway(adapter, "uid-test", { convergeContent: true, runtimePublication });

    expect(state.calls).toContain("reconcileConfiguredBuilderProjectAgents");
    expect(state.calls).not.toContain("applyAddCustomerConfigPatch");
    expect(state.calls).not.toContain("writeCustomerTemplates");
    expect(result.appliedFingerprint).toBe("project-activation");
    expect(result.steps).toContain("config-patch");
  });

  it("finishes a coach-wired Builder overlay attach while its Mattermost coach is still dormant", async () => {
    const state = configuredProjectState();
    state.healthy = false;
    const adapter = makeAdapter(state);
    adapter.isBuilderGateway = () => true;
    adapter.customerCoachWiredInOpenclawConfig = () => true;
    adapter.reconcileConfiguredBuilderProjectAgents = async () => {
      state.calls.push("reconcileConfiguredBuilderProjectAgents");
      return { elapsedMs: 0, appliedFingerprint: "project-activation" };
    };
    adapter.materializeBrokerProfiles = async () => {
      throw new Error("Agent model profiles are not ready: octogee-test-coach");
    };

    const result = await addCustomerToGateway(adapter, "uid-test", { convergeContent: true });

    expect(state.calls).not.toContain("waitForAccountHealthy");
    expect(state.calls).toContain("onMounted");
    expect(result.steps).not.toContain("verify-channel-ready");
    expect(result.appliedFingerprint).toBe("project-activation");
  });

  it("does not mark a configured Builder mounted when project activation fails", async () => {
    const state = configuredProjectState();
    const adapter = makeAdapter(state);
    adapter.isBuilderGateway = () => true;
    adapter.reconcileConfiguredBuilderProjectAgents = async () => {
      throw new Error("project routing activation failed");
    };

    await expect(addCustomerToGateway(adapter, "uid-test")).rejects.toThrow("project routing activation failed");
    expect(state.calls).not.toContain("onMounted");
    expect(state.calls).not.toContain("applyAddCustomerConfigPatch");
  });

  it.each([true, false])("defers project runtime reconciliation until OpenClaw starts (hook available: %s)", async (hasHook) => {
    const state = configuredProjectState();
    const adapter = makeAdapter(state);
    adapter.isBuilderGateway = () => true;
    adapter.customerCoachWiredInOpenclawConfig = () => true;
    if (hasHook) {
      adapter.reconcileConfiguredBuilderProjectAgents = async () => {
        state.calls.push("reconcileConfiguredBuilderProjectAgents");
        return { elapsedMs: 0, appliedFingerprint: "must-not-be-applied-before-startup" };
      };
    }

    const result = await addCustomerToGateway(adapter, "uid-test", {
      convergeContent: true,
      deferRuntimeVerification: true,
    });

    expect(state.calls).toContain("cloneProjectRepo");
    expect(state.calls).not.toContain("reconcileConfiguredBuilderProjectAgents");
    expect(state.calls).not.toContain("waitForAccountHealthy");
    expect(result.appliedFingerprint).toBeUndefined();
    expect(result.steps).not.toContain("config-patch");
    expect(state.logs.some((line) => line.includes("project runtime reconciliation deferred until OpenClaw starts"))).toBe(true);
  });

  it("rejects a configured project snapshot when the adapter cannot reconcile its agents", async () => {
    const state = configuredProjectState();
    const adapter = makeAdapter(state);
    adapter.isBuilderGateway = () => true;

    await expect(addCustomerToGateway(adapter, "uid-test")).rejects.toThrow("configured Builder project reconciliation is unavailable");
    expect(state.calls).not.toContain("onMounted");
  });

  it("converges project checkouts without replacing a mounted Builder overlay when its snapshot changed", async () => {
    const state = makeState(
      snap({
        status: "complete",
        agentIds: ["octogee-test-coach"],
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user-existing",
      }),
      {
        customerDir: true,
        workspaceGitDir: true,
        gitRemote: true,
        sshKey: true,
        templatesWritten: true,
        repoHasCommits: true,
      },
    );
    state.giteaRegisteredPubKey = "ssh-pubkey";
    state.pendingProjects = [
      { projectSlug: "launchroom", giteaRepoName: "launchroom" },
    ];
    const adapter = makeAdapter(state);
    adapter.isBuilderGateway = () => true;
    adapter.customerCoachWiredInOpenclawConfig = () => true;
    adapter.customerMountMarked = () => true;

    const result = await addCustomerToGateway(adapter, "uid-test", {
      convergeContent: true,
    });

    expect(result.steps).toContain("project-clone");
    expect(result.pendingProjectClones).toEqual([]);
    expect(state.calls).toContain("cloneProjectRepo");
    expect(state.calls).not.toContain("applyAddCustomerConfigPatch");
  });

  it("verifies the SSH key but skips unrelated convergence when the durable workspace is ready", async () => {
    const state = makeState(
      snap({
        status: "complete",
        agentIds: ["octogee-test-coach"],
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user-existing",
      }),
      {
        customerDir: true,
        workspaceGitDir: true,
        gitRemote: true,
        sshKey: true,
        templatesWritten: true,
        repoHasCommits: true,
      },
    );

    const adapter = makeAdapter(state);
    adapter.isBuilderGateway = () => true;
    adapter.customerCoachWiredInOpenclawConfig = () => true; // openclaw.json has the agent
    state.giteaRegisteredPubKey = "ssh-pubkey";

    const result = await addCustomerToGateway(adapter, "uid-test");

    expect(result.newCustomer).toBe(false);
    expect(result.steps).toEqual([]);
    expect(state.calls).not.toContain("ensureGiteaOrg");
    expect(state.calls).not.toContain("createGiteaUser");
    expect(state.calls).not.toContain("blobSyncForSlug");
    expect(state.calls).toContain("restoreByosubForAgent");
    expect(state.calls).not.toContain("applyAddCustomerConfigPatch");
    expect(state.calls).not.toContain("waitForAccountHealthy");
    // Fleet heartbeat MUST register this customer as mounted, even on the
    // short-circuit path — Copilot review on PR #1182 caught a regression
    // here. Without it, fleet/heartbeat reports no mounted customers.
    expect(state.calls).toContain("onMounted");
  });

  it("defers only runtime verification for a configured Builder overlay", async () => {
    const state = makeState(
      snap({
        status: "complete",
        agentIds: ["octogee-test-coach"],
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user-existing",
      }),
      {
        customerDir: true,
        workspaceGitDir: true,
        gitRemote: true,
        sshKey: true,
        templatesWritten: true,
        repoHasCommits: true,
      },
    );
    state.giteaRegisteredPubKey = "ssh-pubkey";
    const adapter = makeAdapter(state);
    adapter.isBuilderGateway = () => true;
    adapter.customerCoachWiredInOpenclawConfig = () => true;

    const result = await addCustomerToGateway(adapter, "uid-test", {
      deferRuntimeVerification: true,
    });

    expect(result.steps).not.toContain("verify-channel-ready");
    expect(state.calls).not.toContain("waitForAccountHealthy");
    expect(state.calls).toContain("onMounted");
    expect(state.calls).not.toContain("applyAddCustomerConfigPatch");
  });

  it("restores the subscription store for a configured Builder overlay before OpenClaw starts", async () => {
    const state = makeState(
      snap({
        status: "complete",
        agentIds: ["octogee-test-coach"],
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user-existing",
      }),
      {
        customerDir: true,
        workspaceGitDir: true,
        gitRemote: true,
        sshKey: true,
        templatesWritten: true,
        repoHasCommits: true,
      },
    );
    state.giteaRegisteredPubKey = "ssh-pubkey";
    state.byosub = { restored: true, present: true };
    const adapter = makeAdapter(state);
    adapter.isBuilderGateway = () => true;
    adapter.customerCoachWiredInOpenclawConfig = () => true;

    const result = await addCustomerToGateway(adapter, "uid-test", {
      deferRuntimeVerification: true,
    });

    expect(state.calls).toContain("restoreByosubForAgent");
    expect(state.calls.indexOf("restoreByosubForAgent")).toBeLessThan(state.calls.indexOf("onMounted"));
    expect(result.steps).toContain("byosub-restore");
    expect(state.calls).not.toContain("applyAddCustomerConfigPatch");
  });

  it("recovers an unmarked configured Builder overlay without replacing its config during content convergence", async () => {
    const state = makeState(
      snap({
        status: "complete",
        agentIds: ["octogee-test-coach"],
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user-existing",
      }),
      {
        customerDir: true,
        agentRuntime: true,
        workspaceGitDir: true,
        gitRemote: true,
        sshKey: true,
        templatesWritten: true,
        repoHasCommits: true,
      },
    );
    state.giteaRegisteredPubKey = "ssh-pubkey";
    const adapter = makeAdapter(state);
    adapter.isBuilderGateway = () => true;
    adapter.customerCoachWiredInOpenclawConfig = () => true;
    adapter.customerMountMarked = () => false;

    const result = await addCustomerToGateway(adapter, "uid-test", {
      convergeContent: true,
    });

    expect(result.steps).toEqual([]);
    expect(state.calls).toContain("onMounted");
    expect(state.calls).not.toContain("applyAddCustomerConfigPatch");
    expect(state.calls).not.toContain("removePartialWorkspace");
    expect(state.calls).not.toContain("cloneWorkspaceRepo");
  });

  it("keeps a marked Builder content converge overlay-safe", async () => {
    const state = makeState(
      snap({
        status: "complete",
        agentIds: ["octogee-test-coach"],
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user-existing",
      }),
      {
        customerDir: true,
        agentRuntime: true,
        workspaceGitDir: true,
        gitRemote: true,
        sshKey: true,
        templatesWritten: true,
        repoHasCommits: true,
      },
    );
    const adapter = makeAdapter(state);
    adapter.isBuilderGateway = () => true;
    adapter.customerCoachWiredInOpenclawConfig = () => true;
    adapter.customerMountMarked = () => true;
    state.pendingProjects = [{ projectSlug: "launchroom", giteaRepoName: "launchroom" }];
    state.cloneProjectLands = false;

    const result = await addCustomerToGateway(adapter, "uid-test", { convergeContent: true });

    expect(result.pendingProjectClones).toEqual(["launchroom"]);
    expect(state.calls).toContain("cloneProjectRepo");
    expect(state.calls).not.toContain("applyAddCustomerConfigPatch");
  });

  it("resyncs a drifted Gitea SSH key before the complete/wired fast path returns", async () => {
    const state = makeState(
      snap({
        status: "complete",
        agentIds: ["octogee-test-coach"],
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user-existing",
      }),
      {
        customerDir: true,
        workspaceGitDir: true,
        gitRemote: true,
        sshKey: true,
        templatesWritten: true,
        repoHasCommits: true,
      },
    );
    state.giteaRegisteredPubKey = "ssh-stale-from-old-pod";
    const adapter = makeAdapter(state);
    adapter.isBuilderGateway = () => true;
    adapter.customerCoachWiredInOpenclawConfig = () => true;

    const result = await addCustomerToGateway(adapter, "uid-test");

    expect(result.steps).toEqual(["ssh-key-resync"]);
    expect(state.giteaRegisteredPubKey).toBe("ssh-pubkey");
    expect(state.calls).toContain("createGiteaUser");
    expect(state.calls).not.toContain("ensureGiteaOrg");
    expect(state.calls).not.toContain("applyAddCustomerConfigPatch");
  });

  it("does not short-circuit for a brand-new customer (status='')", async () => {
    const state = makeState(snap({ status: "" }), emptyDisk());
    const adapter = makeAdapter(state);
    adapter.isBuilderGateway = () => true;

    const result = await addCustomerToGateway(adapter, "uid-test");
    expect(result.newCustomer).toBe(true);
    expect(result.steps).toContain("ssh-key");
    expect(result.steps).toContain("mattermost-provision");
    expect(result.steps).toContain("config-patch");
  });

  it("rehydrates a missing workspace below a configured Builder overlay without rewriting that overlay", async () => {
    const state = makeState(
      snap({
        status: "complete",
        agentIds: ["octogee-test-coach"],
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user-existing",
      }),
      emptyDisk(),
    );
    const adapter = makeAdapter(state);
    adapter.isBuilderGateway = () => true;
    adapter.customerCoachWiredInOpenclawConfig = () => true;

    const result = await addCustomerToGateway(adapter, "uid-test");

    expect(result.steps).toContain("ssh-key");
    expect(result.steps).toContain("clone-workspace-repo");
    expect(state.calls).toContain("cloneWorkspaceRepo");
    expect(state.calls).not.toContain("applyAddCustomerConfigPatch");
  });

  it("attaches a Discord-only Builder overlay without a canonical Mattermost coach", async () => {
    const state = makeState(
      snap({
        status: "complete",
        agentIds: ["octogee-test-coach"],
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user-existing",
      }),
      emptyDisk(), // fresh PVC — no SSH key, no workspace, nothing
    );
    const adapter = makeAdapter(state);
    adapter.isBuilderGateway = () => true;
    adapter.customerCoachWiredInOpenclawConfig = () => false;

    const result = await addCustomerToGateway(adapter, "uid-test");

    expect(state.calls).toContain("generateCustomerSshKey");
    expect(state.calls).toContain("createGiteaUser");
    expect(state.calls).toContain("cloneWorkspaceRepo");
    expect(state.calls).not.toContain("applyAddCustomerConfigPatch");
    expect(state.calls).not.toContain("waitForAccountHealthy");
    expect(state.calls).toContain("onMounted");
    expect(result.pendingProjectClones).toEqual([]);
    expect(result.steps).toContain("clone-workspace-repo");
  });

  it("fails without rewriting when a complete Builder overlay is unavailable", async () => {
    const state = makeState(
      snap({
        status: "complete",
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user-existing",
      }),
      emptyDisk(),
    );
    const adapter = makeAdapter(state);
    adapter.isBuilderGateway = () => true;
    adapter.configuredBuilderOverlayPresent = () => false;

    await expect(addCustomerToGateway(adapter, "uid-test")).rejects.toThrow(
      /configured Builder system-config overlay is unavailable/u,
    );

    expect(state.calls).not.toContain("applyAddCustomerConfigPatch");
  });

  it("repairs the canonical Git metadata without deleting a coach-wired workspace", async () => {
    const state = makeState(
      snap({
        status: "complete",
        agentIds: ["octogee-test-coach"],
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user-existing",
      }),
      {
        customerDir: true,
        workspaceGitDir: true,
        gitRemote: false,
        sshKey: true,
        templatesWritten: true,
        repoHasCommits: false,
      },
    );
    state.giteaRegisteredPubKey = "ssh-pubkey";
    const adapter = makeAdapter(state);
    adapter.isBuilderGateway = () => true;
    adapter.customerCoachWiredInOpenclawConfig = () => true;

    const result = await addCustomerToGateway(adapter, "uid-test");

    expect(state.calls).toContain("cloneWorkspaceRepo");
    expect(state.calls).not.toContain("removePartialWorkspace");
    expect(state.calls).not.toContain("initWorkspaceRepoFromExistingDir");
    expect(state.disk.sshKey).toBe(true);
    expect(result.steps).toContain("clone-workspace-repo");
  });

  it("does not rewrite an already configured Builder overlay when the agent runtime dir is absent", async () => {
    const state = makeState(
      snap({
        status: "complete",
        agentIds: ["octogee-test-coach"],
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user-existing",
      }),
      {
        customerDir: true,
        agentRuntime: false,
        workspaceGitDir: true,
        gitRemote: true,
        sshKey: true,
        templatesWritten: true,
        repoHasCommits: true,
      },
    );
    const adapter = makeAdapter(state);
    adapter.isBuilderGateway = () => true;
    adapter.customerCoachWiredInOpenclawConfig = () => true;

    await addCustomerToGateway(adapter, "uid-test");

    expect(state.calls).not.toContain("applyAddCustomerConfigPatch");
    expect(state.calls).toContain("onMounted");
  });

  it("does not overwrite a complete Builder overlay when its platform coach wiring is absent", async () => {
    const state = makeState(
      snap({
        status: "complete",
        agentIds: ["octogee-test-coach"],
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user-existing",
      }),
      {
        customerDir: true,
        workspaceGitDir: true,
        gitRemote: true,
        sshKey: true,
        templatesWritten: true,
        repoHasCommits: true,
      },
    );
    const adapter = makeAdapter(state);
    adapter.isBuilderGateway = () => true;
    adapter.customerCoachWiredInOpenclawConfig = () => false;
    state.giteaRegisteredPubKey = "ssh-pubkey";

    const result = await addCustomerToGateway(adapter, "uid-test");

    expect(state.calls).not.toContain("applyAddCustomerConfigPatch");
    expect(state.calls).not.toContain("waitForAccountHealthy");
    expect(result.pendingProjectClones).toEqual([]);
  });
});

describe("addCustomerToGateway — idempotent re-add", () => {
  it("is a near-no-op on a fully-mounted customer (only patch + verify fire)", async () => {
    const state = makeState(
      snap({
        status: "complete",
        agentIds: ["octogee-test-coach"],
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user-existing",
      }),
      {
        customerDir: true,
        workspaceGitDir: true,
        gitRemote: true,
        sshKey: true,
        templatesWritten: true,
        repoHasCommits: true,
      },
    );

    const result = await addCustomerToGateway(makeAdapter(state), "uid-test");

    expect(result.newCustomer).toBe(false);
    expect(result.steps).not.toContain("claim-slot");
    expect(result.steps).not.toContain("write-templates");
    expect(result.steps).not.toContain("clone-workspace-repo");
    expect(result.steps).not.toContain("init-workspace-repo");
    expect(result.steps).not.toContain("ssh-key");
    expect(result.steps).not.toContain("mattermost-provision");
    expect(result.steps).not.toContain("notify-ops");
    expect(result.steps).toContain("blob-sync");
    expect(result.steps).toContain("config-patch");
    expect(result.steps).toContain("verify-channel-ready");
  });
});

describe("addCustomerToGateway — partial-state scenarios", () => {
  it("FAILS LOUD when Gitea SSH key registration fails — and rolls back the local key", async () => {

const state = makeState(
      snap({
        status: "complete",
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user",
      }),
      emptyDisk(),
    );
    state.giteaRegisterShouldFail = true;

    await expect(
      addCustomerToGateway(makeAdapter(state), "uid-test"),
    ).rejects.toThrow(/SSH key registration failed/);

    expect(state.calls).toContain("generateCustomerSshKey");
    expect(state.calls).toContain("createGiteaUser");

expect(state.calls).toContain("deleteCustomerSshKey");
    expect(state.disk.sshKey).toBe(false);
    
    expect(state.writes.find((w) => w.field === "system/config.gitea")).toBeUndefined();
  });

  it("rolls back local SSH key when Gitea registration appears to succeed but the key isn't actually persisted", async () => {

const state = makeState(
      snap({
        status: "complete",
        repoUrl: "http://gitea/octogee/test-workspace",
      }),
      emptyDisk(),
    );

const adapter = makeAdapter(state);
    const orig = adapter.createGiteaUser;
    adapter.createGiteaUser = async (slug, pubKey) => {
      
      await orig(slug, pubKey);
      state.giteaRegisteredPubKey = null;
    };

    await expect(addCustomerToGateway(adapter, "uid-test")).rejects.toThrow(
      /SSH key registration failed.*giteaPub=absent/,
    );
    expect(state.calls).toContain("deleteCustomerSshKey");
    expect(state.disk.sshKey).toBe(false);
  });

  it("self-heals stale Gitea-side key on existing-key path (the ceckert bug)", async () => {

const state = makeState(
      snap({
        status: "complete",
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user",
      }),
      {
        ...emptyDisk(),
        customerDir: true,
        workspaceGitDir: true,
        gitRemote: true,
        sshKey: true,
        repoHasCommits: true,
      },
    );
    
    state.giteaRegisteredPubKey = "ssh-stale-from-old-pod";

    const result = await addCustomerToGateway(makeAdapter(state), "uid-test");

expect(state.calls).toContain("createGiteaUser");
    expect(result.steps).toContain("ssh-key-resync");
    
    expect(state.calls).not.toContain("generateCustomerSshKey");
    
    expect(state.giteaRegisteredPubKey).toBe("ssh-pubkey");
  });

  it("accepts the local key when an older rollout key is listed first", async () => {
    const state = makeState(
      snap({
        status: "complete",
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user",
      }),
      {
        ...emptyDisk(),
        customerDir: true,
        workspaceGitDir: true,
        gitRemote: true,
        sshKey: true,
        repoHasCommits: true,
      },
    );
    state.giteaRegisteredPubKeys = ["ssh-stale-from-old-pod"];

    const result = await addCustomerToGateway(makeAdapter(state), "uid-test");

    expect(result.steps).toContain("ssh-key-resync");
    expect(state.giteaRegisteredPubKeys).toEqual([
      "ssh-stale-from-old-pod",
      "ssh-pubkey",
    ]);
  });

  it("does not resync when the local key follows an older rollout key", async () => {
    const state = makeState(
      snap({
        status: "complete",
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user",
      }),
      {
        ...emptyDisk(),
        customerDir: true,
        workspaceGitDir: true,
        gitRemote: true,
        sshKey: true,
        repoHasCommits: true,
      },
    );
    state.giteaRegisteredPubKeys = ["ssh-stale-from-old-pod", "ssh-pubkey"];

    const result = await addCustomerToGateway(makeAdapter(state), "uid-test");

    expect(result.steps).not.toContain("ssh-key-resync");
    expect(state.calls).not.toContain("createGiteaUser");
  });

  it("does NOT resync when local + Gitea keys match (healthy state)", async () => {
    const state = makeState(
      snap({
        status: "complete",
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user",
      }),
      {
        ...emptyDisk(),
        customerDir: true,
        workspaceGitDir: true,
        gitRemote: true,
        sshKey: true,
        repoHasCommits: true,
      },
    );
    
    state.giteaRegisteredPubKey = "ssh-pubkey";

    const result = await addCustomerToGateway(makeAdapter(state), "uid-test");

    expect(result.steps).not.toContain("ssh-key");
    expect(result.steps).not.toContain("ssh-key-resync");
    expect(state.calls).not.toContain("createGiteaUser");
  });

  it("reclaims a matching existing Gitea key when a target mount requires ownership", async () => {
    const state = makeState(
      snap({
        status: "complete",
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user",
      }),
      {
        ...emptyDisk(),
        customerDir: true,
        workspaceGitDir: true,
        gitRemote: true,
        sshKey: true,
        repoHasCommits: true,
      },
    );
    state.giteaRegisteredPubKey = "ssh-pubkey";
    const adapter = makeAdapter(state);
    adapter.isBuilderGateway = () => true;

    const result = await addCustomerToGateway(adapter, "uid-test", {
      reclaimExistingSshKey: true,
    });

    expect(result.steps).toContain("ssh-key-resync");
    expect(state.calls).toContain("createGiteaUser");
  });

  it("treats transient Gitea-read failure as ERROR, not as 'key absent' (no spurious resync)", async () => {

const state = makeState(
      snap({
        status: "complete",
        repoUrl: "http://gitea/octogee/test-workspace",
      }),
      {
        ...emptyDisk(),
        customerDir: true,
        workspaceGitDir: true,
        gitRemote: true,
        sshKey: true,
        repoHasCommits: true,
      },
    );
    state.giteaRegisteredPubKey = "ssh-pubkey";
    state.giteaReadShouldThrow = true;

    await expect(
      addCustomerToGateway(makeAdapter(state), "uid-test"),
    ).rejects.toThrow(/Gitea key read failed/);
    
    expect(state.calls).not.toContain("createGiteaUser");
  });

  it("clones project repos that have giteaRepoName but no on-disk clone", async () => {
    const state = makeState(
      snap({
        status: "complete",
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user",
      }),
      {
        ...emptyDisk(),
        customerDir: true,
        workspaceGitDir: true,
        gitRemote: true,
        sshKey: true,
      },
    );
    state.pendingProjects = [
      { projectSlug: "p1", giteaRepoName: "test-p1" },
      { projectSlug: "p2", giteaRepoName: "test-p2" },
    ];

    const result = await addCustomerToGateway(makeAdapter(state), "uid-test");

    const cloneCalls = state.calls.filter((c) => c === "cloneProjectRepo");
    expect(cloneCalls).toHaveLength(2);
    expect(result.steps.filter((s) => s === "project-clone")).toHaveLength(2);
    expect(result.pendingProjectClones).toEqual([]);
  });

  it("clones a GitHub-backed project from its repoSource, not the Gitea mirror", async () => {
    const state = makeState(mountedSnapshot(), mountedDisk());
    state.pendingProjects = [
      { projectSlug: "gh", giteaRepoName: "test-gh", repoSource: GITHUB_REPO_SOURCE },
    ];

    const result = await addCustomerToGateway(makeAdapter(state), "uid-test");

    expect(state.cloneProjectCalls).toEqual([
      {
        projectSlug: "gh",
        giteaRepoName: "test-gh",
        opts: { repoSource: GITHUB_REPO_SOURCE },
      },
    ]);
    expect(result.steps).toContain("project-clone");
    expect(result.pendingProjectClones).toEqual([]);
  });

  it("does not pass a GitHub credential for a Gitea-only project", async () => {
    const state = makeState(mountedSnapshot(), mountedDisk());
    state.pendingProjects = [{ projectSlug: "camp", giteaRepoName: "test-camp" }];

    await addCustomerToGateway(makeAdapter(state), "uid-test");

    expect(state.cloneProjectCalls).toEqual([
      { projectSlug: "camp", giteaRepoName: "test-camp", opts: undefined },
    ]);
  });

  it("delegates a GitHub-backed clone without exposing a credential to the lifecycle", async () => {
    const state = makeState(mountedSnapshot(), mountedDisk());
    state.pendingProjects = [
      { projectSlug: "gh", giteaRepoName: null, repoSource: GITHUB_REPO_SOURCE },
    ];

    await addCustomerToGateway(makeAdapter(state), "uid-test");

    expect(state.cloneProjectCalls).toEqual([
      { projectSlug: "gh", giteaRepoName: null, opts: { repoSource: GITHUB_REPO_SOURCE } },
    ]);
  });

  it("clones a GitHub-backed project that never got a Gitea repo", async () => {
    const state = makeState(mountedSnapshot(), mountedDisk());
    state.pendingProjects = [
      { projectSlug: "gh", giteaRepoName: null, repoSource: GITHUB_REPO_SOURCE },
    ];

    const result = await addCustomerToGateway(makeAdapter(state), "uid-test");

    expect(state.cloneProjectCalls).toEqual([
      { projectSlug: "gh", giteaRepoName: null, opts: { repoSource: GITHUB_REPO_SOURCE } },
    ]);
    expect(result.steps).toContain("project-clone");
  });

  it("leaves a Gitea-backed project's clone free of repoSource options", async () => {
    const state = makeState(mountedSnapshot(), mountedDisk());
    state.pendingProjects = [{ projectSlug: "camp", giteaRepoName: "test-camp" }];

    await addCustomerToGateway(makeAdapter(state), "uid-test");

    expect(state.cloneProjectCalls).toEqual([
      { projectSlug: "camp", giteaRepoName: "test-camp", opts: undefined },
    ]);
  });

  it("keeps a project with no checkout source pending and does not activate its agent", async () => {
    const state = makeState(mountedSnapshot(), mountedDisk());
    state.pendingProjects = [
      { projectSlug: "orphan", giteaRepoName: null },
      { projectSlug: "camp", giteaRepoName: "test-camp" },
    ];

    const result = await addCustomerToGateway(makeAdapter(state), "uid-test");

    expect(state.cloneProjectCalls.map((c) => c.projectSlug)).toEqual(["camp"]);
    expect(result.pendingProjectClones).toEqual(["orphan"]);
    expect(state.configPatchWithoutProjectIds.at(-1)).toEqual(["orphan"]);
    expect(state.logs).toContainEqual(expect.stringContaining("test/orphan"));
    expect(state.logs.find((l) => l.includes("test/orphan"))).toMatch(
      /no Gitea repo and no GitHub repoSource/,
    );
  });

  it("never probes or clones project checkouts for a workspace-only mount", async () => {
    const state = makeState(
      snap({
        status: "complete",
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user",
        projectCheckoutScope: "workspace-only",
      }),
      { ...emptyDisk(), customerDir: true, workspaceGitDir: true, gitRemote: true, sshKey: true },
    );
    state.pendingProjects = [{ projectSlug: "camp", giteaRepoName: "test-camp" }];

    const result = await addCustomerToGateway(makeAdapter(state), "uid-test");

    expect(state.calls).not.toContain("listProjectsNeedingClone");
    expect(state.calls).not.toContain("cloneProjectRepo");
    expect(result.pendingProjectClones).toEqual([]);
  });

  it("converges project checkouts before attaching the coach", async () => {
    const state = makeState(
      snap({
        status: "complete",
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user",
      }),
      { ...emptyDisk(), customerDir: true, workspaceGitDir: true, gitRemote: true, sshKey: true },
    );
    state.pendingProjects = [{ projectSlug: "camp", giteaRepoName: "test-camp" }];

    await addCustomerToGateway(makeAdapter(state), "uid-test");

    expect(state.calls.indexOf("cloneProjectRepo")).toBeLessThan(
      state.calls.indexOf("applyAddCustomerConfigPatch"),
    );
  });

  it("includes a project agent in the single config patch after its checkout lands", async () => {
    const state = makeState(
      snap({
        status: "complete",
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user",
      }),
      { ...emptyDisk(), customerDir: true, workspaceGitDir: true, gitRemote: true, sshKey: true },
    );
    state.pendingProjects = [{ projectSlug: "camp", giteaRepoName: "test-camp" }];

    const result = await addCustomerToGateway(makeAdapter(state), "uid-test");

    expect(result.pendingProjectClones).toEqual([]);
    expect(state.configPatchWithoutProjectIds).toEqual([[]]);
  });

  it("patches the config once when every project checkout is already on disk", async () => {
    const state = makeState(mountedSnapshot(), mountedDisk());

    await addCustomerToGateway(makeAdapter(state), "uid-test");

    expect(state.configPatchWithoutProjectIds).toEqual([[]]);
  });

  it("attaches the coach when an optional project checkout can never clone — a GitHub project on a shared gateway must not strand the Builder", async () => {
    const state = makeState(
      snap({
        status: "complete",
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user",
      }),
      { ...emptyDisk(), customerDir: true, workspaceGitDir: true, gitRemote: true, sshKey: true },
    );
    state.pendingProjects = [
      { projectSlug: "octogee", giteaRepoName: null, repoSource: GITHUB_REPO_SOURCE },
    ];
    state.cloneProjectThrows = true;

    const result = await addCustomerToGateway(makeAdapter(state), "uid-test");

    expect(state.calls).toContain("applyAddCustomerConfigPatch");
    expect(state.calls).toContain("waitForAccountHealthy");
    expect(result.pendingProjectClones).toEqual(["octogee"]);
    expect(state.configPatchWithoutProjectIds).toEqual([["octogee"]]);
  });

  it("surfaces a project whose clone did not land as pending — a swallowed failure must not read as converged", async () => {
    const state = makeState(
      snap({
        status: "complete",
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user",
      }),
      { ...emptyDisk(), customerDir: true, workspaceGitDir: true, gitRemote: true, sshKey: true },
    );
    state.pendingProjects = [{ projectSlug: "camp", giteaRepoName: "test-camp" }];
    state.cloneProjectLands = false;

    const result = await addCustomerToGateway(makeAdapter(state), "uid-test");

    expect(result.pendingProjectClones).toEqual(["camp"]);
    expect(state.configPatchWithoutProjectIds).toEqual([["camp"]]);
  });

  it("surfaces a clone that throws as pending, so the next reconcile retries instead of stranding the checkout", async () => {
    const state = makeState(
      snap({
        status: "complete",
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user",
      }),
      { ...emptyDisk(), customerDir: true, workspaceGitDir: true, gitRemote: true, sshKey: true },
    );
    state.pendingProjects = [{ projectSlug: "camp", giteaRepoName: "test-camp" }];
    state.cloneProjectThrows = true;

    const result = await addCustomerToGateway(makeAdapter(state), "uid-test");

    expect(result.pendingProjectClones).toEqual(["camp"]);
    expect(state.configPatchWithoutProjectIds).toEqual([["camp"]]);
  });

  it("throws when verify times out — restores must NOT silently succeed on a broken mount", async () => {
    const state = makeState(
      snap({
        status: "complete",
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user",
      }),
      {
        ...emptyDisk(),
        customerDir: true,
        workspaceGitDir: true,
        gitRemote: true,
        sshKey: true,
      },
    );
    state.healthy = false;

    await expect(addCustomerToGateway(makeAdapter(state), "uid-test")).rejects.toThrow(
      /didn't reach running\+connected/,
    );

expect(state.calls).toContain("onMounted");
  });
});

describe("addCustomerToGateway — failure modes", () => {
  it("throws if the user doc does not exist", async () => {
    const state = makeState(null, emptyDisk());
    await expect(addCustomerToGateway(makeAdapter(state), "uid-missing")).rejects.toThrow(
      /user doc not found/,
    );
  });
});

describe("removeCustomerFromGateway", () => {
  it("removes the customer from openclaw config + disk; persistent state untouched", async () => {
    const state = makeState(
      snap({
        status: "complete",
        agentIds: ["octogee-test-coach"],
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user",
      }),
      {
        customerDir: true,
        workspaceGitDir: true,
        gitRemote: true,
        sshKey: true,
        templatesWritten: true,
        repoHasCommits: true,
      },
    );

    const result = await removeCustomerFromGateway(makeAdapter(state), "uid-test");

    expect(result.wasMounted).toBe(true);
    expect(result.steps).toEqual(["config-patch-remove", "delete-dir", "release-gitea-key"]);
    expect(state.calls).toContain("applyRemoveCustomerConfigPatch");
    expect(state.calls).toContain("deleteDepartedCustomerState");
    expect(state.calls).not.toContain("removePartialWorkspace");
    expect(state.calls).toContain("onUnmounted");
    expect(state.writes).toEqual([]);
  });

  it("releases this gateway's Gitea key and forgets the local keypair once the customer is gone", async () => {
    const state = makeState(mountedSnapshot(), mountedDisk());

    await removeCustomerFromGateway(makeAdapter(state), "uid-test");

    const release = state.calls.indexOf("releaseGiteaUserKey:ssh-pubkey");
    expect(release).toBeGreaterThan(state.calls.indexOf("applyRemoveCustomerConfigPatch"));
    expect(state.calls.indexOf("deleteCustomerSshKey")).toBeGreaterThan(release);
    expect(state.disk.sshKey).toBe(false);
  });

  it("keeps the local keypair and finishes the unmount when the Gitea release fails", async () => {
    const state = makeState(mountedSnapshot(), mountedDisk());
    state.giteaReleaseShouldFail = true;

    const result = await removeCustomerFromGateway(makeAdapter(state), "uid-test");

    expect(result.steps).toEqual(["config-patch-remove", "delete-dir"]);
    expect(state.calls).toContain("onUnmounted");
    expect(state.calls).not.toContain("deleteCustomerSshKey");
    expect(state.disk.sshKey).toBe(true);
    expect(state.logs.some((line) => line.includes("Gitea key release failed"))).toBe(true);
  });

  it("does not release a Gitea key when the eviction is cancelled", async () => {
    const state = makeState(mountedSnapshot(), mountedDisk());
    const adapter: CustomerLifecycleAdapter = {
      ...makeAdapter(state),
      applyRemoveCustomerConfigPatch: async () => {
        state.calls.push("applyRemoveCustomerConfigPatch");
        return ["test"];
      },
    };

    const result = await removeCustomerFromGateway(adapter, "uid-test", {
      evictionBatch: ["test"],
      currentEvictionBatch: async () => [],
    });

    expect(result.retained).toBe(true);
    expect(state.calls.some((call) => call.startsWith("releaseGiteaUserKey"))).toBe(false);
    expect(state.disk.sshKey).toBe(true);
  });

  it("deletes a mounted customer's departed state even when its workspace is already gone", async () => {
    const state = makeState(snap({ status: "complete" }), emptyDisk());

    const result = await removeCustomerFromGateway(makeAdapter(state), "uid-test");

    expect(result.wasMounted).toBe(true);
    expect(result.steps).toEqual(["config-patch-remove", "delete-dir"]);
    expect(state.calls).toContain("deleteDepartedCustomerState");
  });

  it("is a no-op when the customer was never mounted", async () => {
    const state = makeState(snap({ status: "" }), emptyDisk());

    const result = await removeCustomerFromGateway(makeAdapter(state), "uid-test");

    expect(result.wasMounted).toBe(false);
    expect(result.steps).toEqual([]);
    expect(state.calls).not.toContain("applyRemoveCustomerConfigPatch");
    expect(state.calls).not.toContain("deleteDepartedCustomerState");
  });

  it("retains an admitted Builder overlay when a known customer is evicted", async () => {
    const state = makeState(mountedSnapshot(), mountedDisk());
    const adapter: CustomerLifecycleAdapter = {
      ...makeAdapter(state),
      isBuilderGateway: () => true,
      isConfiguredBuilderCustomer: () => true,
      configuredBuilderOverlayPresent: () => true,
      clearMountMarker: () => state.calls.push("clearMountMarker"),
      clearCustomerMigratingIn: () => state.calls.push("clearCustomerMigratingIn"),
    };

    const result = await removeCustomerFromGateway(adapter, "uid-test");

    expect(result).toEqual({ wasMounted: true, steps: [], retained: true });
    expect(state.calls).toContain("clearMountMarker");
    expect(state.calls).toContain("clearCustomerMigratingIn");
    expect(state.calls).toContain("onUnmounted");
    expect(state.calls).not.toContain("applyRemoveCustomerConfigPatch");
    expect(state.calls).not.toContain("deleteDepartedCustomerState");
  });

  it("fails closed for the configured Builder when its overlay is unavailable", async () => {
    const state = makeState(mountedSnapshot(), mountedDisk());
    const adapter: CustomerLifecycleAdapter = {
      ...makeAdapter(state),
      isBuilderGateway: () => true,
      isConfiguredBuilderCustomer: () => true,
      configuredBuilderOverlayPresent: () => false,
      clearMountMarker: () => state.calls.push("clearMountMarker"),
      clearCustomerMigratingIn: () => state.calls.push("clearCustomerMigratingIn"),
    };

    await expect(removeCustomerFromGateway(adapter, "uid-test")).rejects.toThrow(
      /configured Builder system-config overlay is unavailable/,
    );

    expect(state.calls).not.toContain("applyRemoveCustomerConfigPatch");
    expect(state.calls).not.toContain("deleteDepartedCustomerState");
    expect(state.calls).not.toContain("clearMountMarker");
    expect(state.calls).not.toContain("clearCustomerMigratingIn");
    expect(state.calls).not.toContain("onUnmounted");
  });
});

describe("unmount + re-add round trip", () => {
  it("re-add after remove follows the clone branch (Firestore state preserved)", async () => {
    const state = makeState(
      snap({
        status: "complete",
        agentIds: ["octogee-test-coach"],
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user",
      }),
      {
        customerDir: true,
        workspaceGitDir: true,
        gitRemote: true,
        sshKey: true,
        repoHasCommits: true,
        templatesWritten: true,
      },
    );
    const adapter = makeAdapter(state);

    await removeCustomerFromGateway(adapter, "uid-test");
    state.calls = [];
    state.writes = [];

    const reAdd = await addCustomerToGateway(adapter, "uid-test");

    expect(reAdd.steps).toContain("clone-workspace-repo");
    expect(reAdd.steps).not.toContain("init-workspace-repo");
    expect(reAdd.steps).not.toContain("mattermost-provision");
    expect(reAdd.steps).not.toContain("notify-ops");
  });
});

describe("addCustomerToGateway — same-uid in-flight dedup", () => {
  beforeEach(() => {
    _resetInFlightUidsForTests();
  });

  it("throws ConcurrentMountError when a second mount is started for the same uid mid-flight", async () => {

const state = makeState(snap({ status: "" }), emptyDisk());
    const realAdapter = makeAdapter(state);

    let releaseFirst!: () => void;
    const firstReleased = new Promise<void>((r) => { releaseFirst = r; });

    const dedupAdapter: CustomerLifecycleAdapter = {
      ...realAdapter,
      loadUserSnapshot: async (uid) => {
        await firstReleased;
        return realAdapter.loadUserSnapshot(uid);
      },
    };

    const firstRun = addCustomerToGateway(dedupAdapter, "uid-test");

await Promise.resolve();
    await Promise.resolve();

await expect(addCustomerToGateway(dedupAdapter, "uid-test")).rejects.toBeInstanceOf(
      ConcurrentMountError,
    );

releaseFirst();
    const result = await firstRun;
    expect(result.steps).toContain("verify-channel-ready");
  });

  it("clears the in-flight uid on success so a follow-up mount works", async () => {
    const state = makeState(snap({ status: "" }), emptyDisk());
    await addCustomerToGateway(makeAdapter(state), "uid-test");

    const state2 = makeState(snap({ status: "complete", agentIds: ["octogee-test-coach"], repoUrl: "http://gitea/octogee/test-workspace", mattermostUserId: "mm-x" }), { ...emptyDisk(), customerDir: true, workspaceGitDir: true, gitRemote: true, sshKey: true, repoHasCommits: true });
    const result = await addCustomerToGateway(makeAdapter(state2), "uid-test");
    expect(result.steps).toContain("verify-channel-ready");
  });

  it("reports a deadline-raced Builder workspace clone only after its post-deadline tree mutation settles", async () => {
    const state = makeState(
      snap({
        status: "complete",
        repoUrl: "http://gitea/octogee/test-workspace",
      }),
      emptyDisk(),
    );
    const realAdapter = makeAdapter(state);
    realAdapter.isBuilderGateway = () => true;
    let cloneStarted!: () => void;
    const cloneStartedPromise = new Promise<void>((resolve) => {
      cloneStarted = resolve;
    });
    let releaseClone!: () => void;
    const clone = new Promise<void>((resolve) => {
      releaseClone = resolve;
    });
    const hangingAdapter: CustomerLifecycleAdapter = {
      ...realAdapter,
      cloneWorkspaceRepo: async (slug, repoUrl) => {
        cloneStarted();
        await clone;
        return realAdapter.cloneWorkspaceRepo(slug, repoUrl);
      },
    };
    let workSettled: Promise<void> | undefined;

    const mounting = addCustomerToGateway(hangingAdapter, "uid-test", {
        mountDeadlineMs: 25,
        onWorkSettled: (settled) => {
          workSettled = settled;
        },
      });
    await cloneStartedPromise;

    await expect(mounting).rejects.toThrow(/mountDeadlineMs.*25ms.*exceeded/i);

    let callbackSettled = false;
    void workSettled?.then(() => {
      callbackSettled = true;
    });
    await Promise.resolve();
    expect(workSettled).toBeDefined();
    expect(callbackSettled).toBe(false);
    expect(_inFlightUidsHasForTests("uid-test")).toBe(true);

    const state2 = makeState(snap({ status: "" }), emptyDisk());
    await expect(addCustomerToGateway(makeAdapter(state2), "uid-test")).rejects.toBeInstanceOf(ConcurrentMountError);

    releaseClone();
    await workSettled;
    expect(callbackSettled).toBe(true);
    expect(state.calls).toContain("cloneWorkspaceRepo");
    expect(state.calls).toContain("ensureCustomerDirectories");
    expect(state.calls).toContain("writeCustomerTemplateFiles");
    expect(_inFlightUidsHasForTests("uid-test")).toBe(false);
    const retry = await addCustomerToGateway(makeAdapter(state2), "uid-test");
    expect(retry.steps).toContain("verify-channel-ready");
  });

  it("names the hung step in the deadline error", async () => {
    const state = makeState(snap({ status: "" }), emptyDisk());
    const realAdapter = makeAdapter(state);
    const hangingAdapter: CustomerLifecycleAdapter = {
      ...realAdapter,
      readGiteaCustomerPubKeys: () => new Promise(() => {}),
    };

    await expect(
      addCustomerToGateway(hangingAdapter, "uid-test", { mountDeadlineMs: 25 }),
    ).rejects.toThrow(/step "ssh-key" is hung/);
  });

  it("names load-snapshot as the hung step when the snapshot fetch never returns", async () => {
    const state = makeState(snap({ status: "" }), emptyDisk());
    const realAdapter = makeAdapter(state);
    const hangingAdapter: CustomerLifecycleAdapter = {
      ...realAdapter,
      loadUserSnapshot: () => new Promise(() => {}),
    };

    await expect(
      addCustomerToGateway(hangingAdapter, "uid-test", { mountDeadlineMs: 25 }),
    ).rejects.toThrow(/step "load-snapshot" is hung/);
  });

  it("stops the inner pipeline at the next checkpoint after mountDeadlineMs trips", async () => {
    const state = makeState(snap({ status: "" }), emptyDisk());
    const realAdapter = makeAdapter(state);
    let blobSyncCalled = false;
    const slowAdapter: CustomerLifecycleAdapter = {
      ...realAdapter,
      loadUserSnapshot: async (uid: string) => {
        await new Promise<void>((r) => setTimeout(r, 80));
        return realAdapter.loadUserSnapshot(uid);
      },
      blobSyncForSlug: async (slug: string) => {
        blobSyncCalled = true;
        return realAdapter.blobSyncForSlug(slug);
      },
    };

    await expect(
      addCustomerToGateway(slowAdapter, "uid-test", { mountDeadlineMs: 25 }),
    ).rejects.toThrow(/mountDeadlineMs.*25ms.*exceeded/i);

    await new Promise<void>((r) => setTimeout(r, 120));
    expect(blobSyncCalled).toBe(false);
  });

  it("aborts an external AbortSignal observer so callers can react to the deadline trip", async () => {
    const state = makeState(snap({ status: "" }), emptyDisk());
    const realAdapter = makeAdapter(state);
    const slowAdapter: CustomerLifecycleAdapter = {
      ...realAdapter,
      loadUserSnapshot: async () => new Promise(() => {}),
    };

    let externalSignalAborted = false;
    const aborter = await addCustomerToGateway(slowAdapter, "uid-test", {
      mountDeadlineMs: 25,
      onSignalCreated: (signal) => {
        signal.addEventListener("abort", () => {
          externalSignalAborted = true;
        });
      },
    }).catch((e) => e);
    expect(String(aborter)).toMatch(/mountDeadlineMs/);
    expect(externalSignalAborted).toBe(true);
  });

  it("clears the in-flight uid on failure so the fleet can retry", async () => {
    const state = makeState(snap({ status: "" }), emptyDisk());
    state.healthy = false;

    await expect(addCustomerToGateway(makeAdapter(state), "uid-test")).rejects.toThrow(
      /didn't reach running\+connected/,
    );

    const state2 = makeState(snap({ status: "" }), emptyDisk());
    const result = await addCustomerToGateway(makeAdapter(state2), "uid-test");
    expect(result.steps).toContain("verify-channel-ready");
  });

  it("isolates uids — different uids run concurrently without dedup interference", async () => {
    const stateA = makeState(snap({ uid: "uid-a", slug: "alice" }), emptyDisk());
    const stateB = makeState(snap({ uid: "uid-b", slug: "bob" }), emptyDisk());

    const [resA, resB] = await Promise.all([
      addCustomerToGateway(makeAdapter(stateA), "uid-a"),
      addCustomerToGateway(makeAdapter(stateB), "uid-b"),
    ]);
    expect(resA.steps).toContain("verify-channel-ready");
    expect(resB.steps).toContain("verify-channel-ready");
  });
});

describe("restoreCustomerRuntimeFromSnapshot — blob backfill stays out of the migration-critical path", () => {
  beforeEach(() => {
    _resetInFlightUidsForTests();
  });

  it("keeps the restored gateway's SSH key registered after the previous owner unmounts", async () => {
    const state = makeState(snap({ status: "complete" }), emptyDisk());
    state.disk.sshKey = true;
    state.giteaRegisteredPubKey = "ssh-pubkey";
    let keyOwner = "native";
    const adapter = makeAdapter(state);
    adapter.createGiteaUser = async () => { keyOwner = "shared"; };

    await restoreCustomerRuntimeFromSnapshot(adapter, state.user!);
    if (keyOwner === "native") state.giteaRegisteredPubKey = null;

    expect(keyOwner).toBe("shared");
    expect(await adapter.readGiteaCustomerPubKeys("test")).toEqual(["ssh-pubkey"]);
  });

  it("shares one preparation deadline and request signal across snapshot project refreshes", async () => {
    const state = makeState(snap({ status: "complete", projects: [
      { projectSlug: "first", giteaRepoName: "first" },
      { projectSlug: "second", giteaRepoName: "second" },
    ] }), emptyDisk());
    const adapter = makeAdapter(state);
    const controller = new AbortController();
    await cloneProjectsFromSnapshot(adapter, state.user!, { signal: controller.signal });
    const [first, second] = state.cloneProjectCalls;
    expect(first.opts?.refreshLeaseDeadlineMs).toEqual(expect.any(Number));
    expect(second.opts?.refreshLeaseDeadlineMs).toBe(first.opts?.refreshLeaseDeadlineMs);
    expect(first.opts?.signal).toBe(controller.signal);
    expect(second.opts?.signal).toBe(controller.signal);
  });

  it("does not start the next snapshot project after its owning request aborts", async () => {
    const state = makeState(snap({ status: "complete", projects: [
      { projectSlug: "first", giteaRepoName: "first" },
      { projectSlug: "second", giteaRepoName: "second" },
    ] }), emptyDisk());
    const adapter = makeAdapter(state);
    const controller = new AbortController();
    const clone = vi.fn(async () => {
      controller.abort(new Error("finish import cancelled"));
      return false;
    });
    adapter.cloneProjectRepo = clone;
    await expect(cloneProjectsFromSnapshot(adapter, state.user!, { signal: controller.signal }))
      .rejects.toThrow("finish import cancelled");
    expect(clone).toHaveBeenCalledOnce();
  });

  it("requires Gitea project checkouts to refresh during runtime restoration", async () => {
    const state = makeState(snap({
      status: "complete",
      projects: [{ projectSlug: "proofproj", giteaRepoName: "proofproj" }],
    }), emptyDisk());
    const adapter = makeAdapter(state);
    const clone = vi.fn(adapter.cloneProjectRepo);
    adapter.cloneProjectRepo = clone;

    await restoreCustomerRuntimeFromSnapshot(adapter, state.user!);

    expect(clone).toHaveBeenCalledWith(state.user!.slug, "proofproj", "proofproj", expect.objectContaining({ refreshRemote: true }));
  });

  it("does not publish a restored mount when an active project runtime is missing", async () => {
    const state = makeState(snap({ status: "complete" }), emptyDisk());
    const adapter = makeAdapter(state);
    adapter.projectAgentsHealthy = async () => false;
    adapter.writeMountMarker = () => { throw new Error("must not mark an incomplete restore"); };
    await expect(restoreCustomerRuntimeFromSnapshot(adapter, state.user!)).rejects.toThrow("project agents are not connected");
  });

  it("verifies only project agents admitted after checkout restoration", async () => {
    const state = makeState(snap({
      status: "complete",
      projects: [{ projectSlug: "pending", giteaRepoName: "test-pending" }],
      projectAgents: [
        { projectId: "pending", enabled: true, mmUserId: "pending-bot", token: "pending-pat", status: "ready" },
        { projectId: "ready", enabled: true, mmUserId: "ready-bot", token: "ready-pat", status: "ready" },
      ],
    }), emptyDisk());
    state.cloneProjectLands = false;
    const adapter = makeAdapter(state);
    const verified: UserSnapshot[] = [];
    adapter.projectAgentsHealthy = async (snapshot) => {
      verified.push(snapshot);
      return !snapshot.projectAgents?.some((agent) => agent.projectId === "pending");
    };
    const result = await restoreCustomerRuntimeFromSnapshot(adapter, state.user!);
    expect(result.restored).toBe(true);
    expect(state.configPatchWithoutProjectIds).toEqual([["pending"]]);
    expect(verified[0].projectAgents?.map((agent) => agent.projectId)).toEqual(["ready"]);
  });

  it("does not publish a restored mount after cancellation during project verification", async () => {
    const state = makeState(snap({ status: "complete" }), emptyDisk());
    const adapter = makeAdapter(state);
    const controller = new AbortController();
    adapter.projectAgentsHealthy = async () => {
      controller.abort(new Error("restore cancelled"));
      return true;
    };
    let marked = false;
    adapter.writeMountMarker = () => { marked = true; };
    await expect(restoreCustomerRuntimeFromSnapshot(adapter, state.user!, { signal: controller.signal })).rejects.toThrow("restore cancelled");
    expect(marked).toBe(false);
  });

  it("returns the applied fingerprint and pending checkouts so the caller can record convergence", async () => {
    const state = makeState(snap({
      status: "complete",
      projects: [{ projectSlug: "pending", giteaRepoName: "test-pending" }],
      projectAgents: [
        { projectId: "pending", enabled: true, mmUserId: "pending-bot", token: "pending-pat", status: "ready" },
      ],
    }), emptyDisk());
    state.configPatchFingerprint = "restored-fingerprint";
    state.cloneProjectLands = false;
    const adapter = makeAdapter(state);
    adapter.projectAgentsHealthy = async (snapshot) =>
      !snapshot.projectAgents?.some((agent) => agent.projectId === "pending");

    const result = await restoreCustomerRuntimeFromSnapshot(adapter, state.user!);

    expect(result.appliedFingerprint).toBe("restored-fingerprint");
    expect(result.pendingProjectClones).toEqual(["pending"]);
  });

  it("reports converged state only when every re-assert completed", async () => {
    const state = makeState(snap({ status: "complete" }), emptyDisk());
    state.configPatchFingerprint = "restored-fingerprint";

    const converged = await restoreCustomerRuntimeFromSnapshot(makeAdapter(state), state.user!);
    expect(converged.convergedState).toBe(true);

    _resetInFlightUidsForTests();
    state.reassertByotShouldFail = true;
    const incomplete = await restoreCustomerRuntimeFromSnapshot(makeAdapter(state), state.user!);
    expect(incomplete.restored).toBe(true);
    expect(incomplete.convergedState).toBe(false);
  });

  it("stamps the mount marker once the restored runtime is verified", async () => {
    const state = makeState(snap({ status: "complete" }), emptyDisk());
    const marked: string[] = [];
    const adapter = makeAdapter(state);
    adapter.writeMountMarker = (slug) => { marked.push(slug); };

    const result = await restoreCustomerRuntimeFromSnapshot(adapter, state.user!);

    expect(result.restored).toBe(true);
    expect(marked).toEqual(["test"]);
  });

  it("does not call blobSyncForSlug during restore — the source rsync + the post-online loop own blob backfill", async () => {
    const state = makeState(snap({ status: "complete" }), emptyDisk());

    const result = await restoreCustomerRuntimeFromSnapshot(makeAdapter(state), state.user!);

    expect(state.calls).not.toContain("blobSyncForSlug");
    expect(result.steps).not.toContain("blob-sync");
    expect(result.steps).toContain("verify-channel-ready");
  });

  it("restores only the workspace when the target checkout scope is workspace-only", async () => {
    const state = makeState(
      snap({
        status: "complete",
        projectCheckoutScope: undefined,
        projects: [
          { projectSlug: "camp", giteaRepoName: "test-camp", provisioningState: "active" },
        ],
      }),
      emptyDisk(),
    );
    const adapter = makeAdapter(state);
    adapter.projectCheckoutScope = () => "workspace-only";

    await restoreCustomerRuntimeFromSnapshot(adapter, state.user!);

    expect(state.calls).not.toContain("cloneProjectRepo");
  });

  it("restores isolated project checkouts before establishing the coach", async () => {
    const state = makeState(
      snap({
        status: "complete",
        projects: [
          { projectSlug: "camp", giteaRepoName: "test-camp", provisioningState: "active" },
        ],
      }),
      emptyDisk(),
    );

    await restoreCustomerRuntimeFromSnapshot(makeAdapter(state), state.user!);

    expect(state.calls.indexOf("cloneProjectRepo")).toBeLessThan(
      state.calls.indexOf("applyAddCustomerConfigPatch"),
    );
  });

  it("restores a GitHub-backed project from its repoSource even with no Gitea repo", async () => {
    const state = makeState(
      snap({
        status: "complete",
        projects: [
          {
            projectSlug: "gh",
            giteaRepoName: null,
            repoSource: GITHUB_REPO_SOURCE,
            provisioningState: "active",
          },
          { projectSlug: "camp", giteaRepoName: "test-camp", provisioningState: "active" },
        ],
      }),
      emptyDisk(),
    );

    const result = await restoreCustomerRuntimeFromSnapshot(makeAdapter(state), state.user!);

    expect(state.cloneProjectCalls).toEqual([
      { projectSlug: "gh", giteaRepoName: null, opts: { repoSource: GITHUB_REPO_SOURCE } },
      { projectSlug: "camp", giteaRepoName: "test-camp", opts: expect.objectContaining({ refreshRemote: true }) },
    ]);
    expect(result.steps.filter((s) => s === "project-clone")).toHaveLength(2);
  });

  it("skips a restored project whose owner turned the checkout off, and clones the rest", async () => {
    const state = makeState(
      snap({
        status: "complete",
        projects: [
          {
            projectSlug: "gh",
            giteaRepoName: null,
            repoSource: GITHUB_REPO_SOURCE,
            provisioningState: "active",
            checkoutEnabled: false,
          },
          { projectSlug: "camp", giteaRepoName: "test-camp", provisioningState: "active" },
        ],
      }),
      emptyDisk(),
    );

    await restoreCustomerRuntimeFromSnapshot(makeAdapter(state), state.user!);

    expect(state.cloneProjectCalls).toEqual([
      { projectSlug: "camp", giteaRepoName: "test-camp", opts: expect.objectContaining({ refreshRemote: true }) },
    ]);
    expect(state.logs.find((l) => l.includes("test/gh"))).toMatch(/turned off by its owner/);
  });

  it("skips a restored project with neither checkout source, and says so", async () => {
    const state = makeState(
      snap({
        status: "complete",
        projects: [{ projectSlug: "orphan", giteaRepoName: null, provisioningState: "active" }],
      }),
      emptyDisk(),
    );

    await restoreCustomerRuntimeFromSnapshot(makeAdapter(state), state.user!);

    expect(state.cloneProjectCalls).toEqual([]);
    expect(state.logs.find((l) => l.includes("test/orphan"))).toMatch(
      /no Gitea repo and no GitHub repoSource/,
    );
  });

  it("repairs imported Git metadata without deleting the imported workspace", async () => {
    const state = makeState(
      snap({
        status: "complete",
        repoUrl: "http://gitea/octogee/test-workspace",
      }),
      {
        customerDir: true,
        agentRuntime: true,
        workspaceGitDir: true,
        gitRemote: false,
        sshKey: true,
        templatesWritten: true,
        repoHasCommits: false,
      },
    );
    state.giteaRegisteredPubKey = "ssh-pubkey";

    const result = await restoreCustomerRuntimeFromSnapshot(
      makeAdapter(state),
      state.user!,
    );

    expect(state.calls).toContain("cloneWorkspaceRepo");
    expect(state.calls).not.toContain("removePartialWorkspace");
    expect(result.steps).toContain("clone-workspace-repo");
  });

  it("reconciles community membership on restore — an existing Builder self-heals after a gateway restart", async () => {
    const state = makeState(snap({ status: "complete" }), emptyDisk());
    const adapter = {
      ...makeAdapter(state),
      reconcileCommunityMembership: async (ctx: { uid: string; slug: string }) => {
        state.calls.push("reconcileCommunityMembership");
        state.communityMembershipCtx = ctx;
      },
    };

    const result = await restoreCustomerRuntimeFromSnapshot(adapter, state.user!);

    expect(state.calls).toContain("reconcileCommunityMembership");
    expect(result.steps).toContain("community-membership");
    expect(state.communityMembershipCtx?.uid).toBe(state.user!.uid);
  });
});

describe("restoreCustomerRuntimeFromSnapshot — same-uid in-flight dedup", () => {
  beforeEach(() => {
    _resetInFlightUidsForTests();
  });

  it("retains restore exclusivity against both restore and reconcile until late work settles", async () => {
    const state = makeState(snap({ status: "complete" }), emptyDisk());
    const realAdapter = makeAdapter(state);
    let releaseRead!: () => void;
    const read = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const hangingAdapter: CustomerLifecycleAdapter = {
      ...realAdapter,
      hasCustomerSshKey: () => true,
      readLocalCustomerPubKey: () => "ssh-pubkey",
      readGiteaCustomerPubKeys: async () => {
        await read;
        return ["ssh-pubkey"];
      },
    };
    let workSettled: Promise<void> | undefined;

    await expect(
      restoreCustomerRuntimeFromSnapshot(hangingAdapter, state.user!, {
        mountDeadlineMs: 25,
        onWorkSettled: (settled) => {
          workSettled = settled;
        },
      }),
    ).rejects.toThrow(/mountDeadlineMs.*25ms.*exceeded/i);

    expect(_inFlightUidsHasForTests("uid-test")).toBe(true);
    const state2 = makeState(snap({ status: "complete" }), emptyDisk());
    await expect(addCustomerToGateway(makeAdapter(state2), "uid-test")).rejects.toBeInstanceOf(ConcurrentMountError);
    await expect(restoreCustomerRuntimeFromSnapshot(makeAdapter(state2), state2.user!)).rejects.toBeInstanceOf(ConcurrentMountError);
    releaseRead();
    await workSettled;
    expect(_inFlightUidsHasForTests("uid-test")).toBe(false);

    const retry = await restoreCustomerRuntimeFromSnapshot(makeAdapter(state2), state2.user!);
    expect(retry.steps).toContain("verify-channel-ready");
  });
});

describe("pubKeysMatch", () => {

it("matches identical keys", () => {
    const k = "ssh-ed25519 AAAAC3Nz...etc octogee-chris@gateway";
    expect(pubKeysMatch(k, k)).toBe(true);
  });

  it("matches same type + key bytes with different comments", () => {
    const a = "ssh-ed25519 AAAAC3Nz...etc octogee-chris@gateway";
    const b = "ssh-ed25519 AAAAC3Nz...etc anything-else";
    expect(pubKeysMatch(a, b)).toBe(true);
  });

  it("matches when one side has trailing whitespace", () => {
    const a = "ssh-ed25519 AAAAC3Nz...etc octogee-chris@gateway\n";
    const b = "ssh-ed25519 AAAAC3Nz...etc octogee-chris@gateway";
    expect(pubKeysMatch(a, b)).toBe(true);
  });

  it("rejects different key bytes (the drift case)", () => {
    const a = "ssh-ed25519 AAAAC3Nz...stale octogee-chris@gateway";
    const b = "ssh-ed25519 AAAAC3Nz...fresh octogee-chris@gateway";
    expect(pubKeysMatch(a, b)).toBe(false);
  });

  it("rejects different key types", () => {
    const a = "ssh-ed25519 AAAAC3Nz...";
    const b = "ssh-rsa     AAAAB3Nz...";
    expect(pubKeysMatch(a, b)).toBe(false);
  });
});

describe("addCustomerToGateway — org-ensure precedes EVERY repo-touching path (the #963 incomplete-rollout class)", () => {

const ADAPTER_REPO_TOUCHING: Record<keyof CustomerLifecycleAdapter, boolean> = {
    cloneWorkspaceRepo: true,
    initWorkspaceRepoFromExistingDir: true,
    cloneProjectRepo: true,
    log: false,
    loadUserSnapshot: false,
    setProvisioningStatus: false,
    provisionCoachAutomation: false,
    setRepoUrl: false,
    setMattermostFields: false,
    ensureAgentIds: false,
    hasCustomerDir: false,
    hasWorkspaceGitDir: false,
    hasGitRemote: false,
    repoHasCommits: false,
    ensureCustomerDirectories: false,
    writeCustomerTemplateFiles: false,
    removePartialWorkspace: false,
    deleteDepartedCustomerState: false,
    hasCustomerSshKey: false,
    generateCustomerSshKey: false,
    createGiteaUser: false,
    ensureGiteaOrg: false,
    readLocalCustomerPubKey: false,
    readGiteaCustomerPubKeys: false,
    deleteCustomerSshKey: false,
    releaseGiteaUserKey: false,
    blobSyncForSlug: false,
    restoreByosubForAgent: false,
    listProjectsNeedingClone: false,
    provisionMattermostUser: false,
    applyAddCustomerConfigPatch: false,
    applyRemoveCustomerConfigPatch: false,
    waitForAccountHealthy: false,
    projectAgentsHealthy: false,
    notifyOpsOfSignup: false,
    onMounted: false,
    onUnmounted: false,
    uidForSlug: false,
    quiesceCustomer: false,
    listExportPaths: false,
    prepareImportDir: false,
    prepareKeyImportDir: false,
    activateImportedCustomer: false,
    recordAppliedFingerprint: false,
  };

  const REPO_TOUCHING = (
    Object.keys(ADAPTER_REPO_TOUCHING) as Array<keyof CustomerLifecycleAdapter>
  ).filter((k) => ADAPTER_REPO_TOUCHING[k]);

  it("classifies exactly the clone/init workspace+project methods as repo-touching", () => {
    expect([...REPO_TOUCHING].sort()).toEqual(
      [
        "cloneProjectRepo",
        "cloneWorkspaceRepo",
        "initWorkspaceRepoFromExistingDir",
      ].sort(),
    );
  });

  const mounted = (over: Partial<UserSnapshot> = {}) =>
    snap({
      status: "complete",
      agentIds: ["octogee-test-coach"],
      repoUrl: "http://gitea/octogee/test-workspace",
      mattermostUserId: "mm-user",
      ...over,
    });

  const scenarios: Array<{
    name: string;
    state: () => MockState;
    expectRepoTouch: boolean;
  }> = [
    {
      name: "first-time provision (init-workspace)",
      state: () => makeState(snap({ status: "" }), emptyDisk()),
      expectRepoTouch: true,
    },
    {
      name: "restore from Gitea (clone-workspace)",
      state: () => makeState(mounted(), emptyDisk()),
      expectRepoTouch: true,
    },
    {
      name: "empty-Gitea restore (clone then template re-apply)",
      state: () => {
        const s = makeState(mounted(), emptyDisk());
        s.cloneSimulatesEmptyRepo = true;
        return s;
      },
      expectRepoTouch: true,
    },
    {
      name: "recovery from orphan dir (recovery init-workspace)",
      state: () =>
        makeState(mounted({ repoUrl: "" }), {
          ...emptyDisk(),
          customerDir: true,
          workspaceGitDir: true,
          gitRemote: false,
        }),
      expectRepoTouch: true,
    },
    {
      name: "pending project clone (workspace already healthy)",
      state: () => {
        const s = makeState(mounted(), {
          ...emptyDisk(),
          customerDir: true,
          workspaceGitDir: true,
          gitRemote: true,
          sshKey: true,
          repoHasCommits: true,
        });
        s.giteaRegisteredPubKey = "ssh-pubkey";
        s.pendingProjects = [{ projectSlug: "p1", giteaRepoName: "test-p1" }];
        return s;
      },
      expectRepoTouch: true,
    },
    {
      name: "idempotent re-add (no repo touch — org still ensured)",
      state: () =>
        makeState(mounted(), {
          customerDir: true,
          workspaceGitDir: true,
          gitRemote: true,
          sshKey: true,
          templatesWritten: true,
          repoHasCommits: true,
        }),
      expectRepoTouch: false,
    },
  ];

  it.each(scenarios)("$name", async ({ state, expectRepoTouch }) => {
    const st = state();

    if (st.giteaRegisteredPubKey === null) st.giteaRegisteredPubKey = "ssh-pubkey";
    await addCustomerToGateway(makeAdapter(st), "uid-test");

    const orgIdx = st.calls.indexOf("ensureGiteaOrg");

expect(orgIdx).toBeGreaterThan(-1);

    const repoTouchIdxs = REPO_TOUCHING.map((m) => st.calls.indexOf(m)).filter(
      (i) => i !== -1,
    );
    if (expectRepoTouch) {
      expect(repoTouchIdxs.length).toBeGreaterThan(0);
      expect(Math.min(...repoTouchIdxs)).toBeGreaterThan(orgIdx);
    } else {
      expect(repoTouchIdxs).toEqual([]);
    }
  });
});

describe("cloneMissingProjects — GitHub checkouts hydrate only on the owner's Builder runtime", () => {
  const targets: ProjectCloneTarget[] = [
    { projectSlug: "hedgeherd", giteaRepoName: "chris-hedgeherd" },
    { projectSlug: "octogee", giteaRepoName: null, repoSource: { provider: "github", owner: "octogee-ai", repo: "octogee" } },
  ];

  function adapterFor(ownerRuntime: boolean, cloned: Set<string>) {
    const cloneProjectRepo = vi.fn(async (_slug: string, projectSlug: string) => {
      cloned.add(projectSlug);
      return true;
    });
    const seedDeferredProjectWorkspace = vi.fn(async () => undefined);
    const adapter = {
      log: vi.fn(),
      isBuilderGateway: () => ownerRuntime,
      isConfiguredBuilderCustomer: () => ownerRuntime,
      listProjectsNeedingClone: vi.fn(async () => targets.filter((t) => !cloned.has(t.projectSlug))),
      cloneProjectRepo,
      seedDeferredProjectWorkspace,
    } as unknown as CustomerLifecycleAdapter;
    return { adapter, cloneProjectRepo, seedDeferredProjectWorkspace };
  }

  it("defers the GitHub project on a shared gateway and still clones the Gitea one", async () => {
    const { adapter, cloneProjectRepo } = adapterFor(false, new Set());

    const result = await cloneMissingProjects(adapter, "chris");

    expect(cloneProjectRepo).toHaveBeenCalledTimes(1);
    expect(cloneProjectRepo.mock.calls[0][1]).toBe("hedgeherd");
    expect(result).toEqual({ steps: ["project-clone"], pending: [], deferred: ["octogee"] });
  });

  it("leaves a deferred project a workspace OpenClaw will not call vanished", async () => {
    const { adapter, seedDeferredProjectWorkspace } = adapterFor(false, new Set());

    await cloneMissingProjects(adapter, "chris");

    expect(seedDeferredProjectWorkspace).toHaveBeenCalledWith("chris", "octogee");
    expect(seedDeferredProjectWorkspace).toHaveBeenCalledTimes(1);
  });

  it("defers the GitHub project even on the owner's runtime when a migration import asks it to", async () => {
    const { adapter, cloneProjectRepo } = adapterFor(true, new Set());

    const result = await cloneMissingProjects(adapter, "chris", { githubCheckouts: "defer" });

    expect(cloneProjectRepo).toHaveBeenCalledTimes(1);
    expect(cloneProjectRepo.mock.calls[0][1]).toBe("hedgeherd");
    expect(result).toEqual({ steps: ["project-clone"], pending: [], deferred: ["octogee"] });
  });

  it("attempts the GitHub project on the owner's Builder runtime and reports it pending when it fails", async () => {
    const { adapter, cloneProjectRepo } = adapterFor(true, new Set());
    cloneProjectRepo.mockImplementation(async (_slug: string, projectSlug: string) => projectSlug === "hedgeherd");
    (adapter.listProjectsNeedingClone as ReturnType<typeof vi.fn>).mockImplementation(async () =>
      cloneProjectRepo.mock.calls.length === 0 ? targets : targets.filter((t) => t.projectSlug === "octogee"));

    const result = await cloneMissingProjects(adapter, "chris");

    expect(cloneProjectRepo).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ steps: ["project-clone"], pending: ["octogee"], deferred: [] });
  });

  it("does not probe checkouts for an already cancelled owner", async () => {
    const { adapter, cloneProjectRepo } = adapterFor(true, new Set());
    const controller = new AbortController();
    controller.abort(new Error("finish import cancelled"));

    await expect(cloneMissingProjects(adapter, "chris", { signal: controller.signal }))
      .rejects.toThrow("finish import cancelled");

    expect(adapter.listProjectsNeedingClone).not.toHaveBeenCalled();
    expect(cloneProjectRepo).not.toHaveBeenCalled();
  });

  it("does not clone after its initial checkout probe is cancelled", async () => {
    const { adapter, cloneProjectRepo } = adapterFor(true, new Set());
    const controller = new AbortController();
    adapter.listProjectsNeedingClone = vi.fn(async () => {
      controller.abort(new Error("finish import cancelled"));
      return targets;
    });

    await expect(cloneMissingProjects(adapter, "chris", { signal: controller.signal }))
      .rejects.toThrow("finish import cancelled");

    expect(cloneProjectRepo).not.toHaveBeenCalled();
  });

  it.each(["gitea", "github"] as const)("propagates cancellation from a %s clone instead of starting another project", async provider => {
    const { adapter } = adapterFor(true, new Set());
    const ordered = provider === "gitea" ? targets : [...targets].reverse();
    adapter.listProjectsNeedingClone = vi.fn(async () => ordered);
    const controller = new AbortController();
    const clone = vi.fn(async () => {
      controller.abort(new Error("finish import cancelled"));
      throw new Error("clone interrupted");
    });
    adapter.cloneProjectRepo = clone;

    await expect(cloneMissingProjects(adapter, "chris", { signal: controller.signal }))
      .rejects.toThrow("finish import cancelled");

    expect(clone).toHaveBeenCalledExactlyOnceWith("chris", ordered[0].projectSlug, ordered[0].giteaRepoName,
      expect.objectContaining({ signal: controller.signal }));
    expect(adapter.listProjectsNeedingClone).toHaveBeenCalledOnce();
  });

  it("does not report hydration complete after its final checkout probe is cancelled", async () => {
    const { adapter } = adapterFor(true, new Set());
    const controller = new AbortController();
    adapter.listProjectsNeedingClone = vi.fn()
      .mockResolvedValueOnce([targets[0]])
      .mockImplementationOnce(async () => {
        controller.abort(new Error("finish import cancelled"));
        return [];
      });

    await expect(cloneMissingProjects(adapter, "chris", { signal: controller.signal }))
      .rejects.toThrow("finish import cancelled");
  });
});

describe("lifecycle log identity", () => {
  it("binds each concurrent removal's canonical Builder slug and clears it afterwards", async () => {
    const { createServiceLogger } = await import("@octogee/shared/server/service-logger");
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation(line => { lines.push(String(line)); });
    try {
      const logger = createServiceLogger("provisioner");
      await Promise.all(["alice", "bob"].map(async slug => {
        const adapter = makeAdapter(makeState(snap({ uid: slug, slug }), emptyDisk()));
        adapter.log = message => logger.info(message);
        await removeCustomerFromGateway(adapter, slug);
      }));
      expect(lines.map(line => JSON.parse(line).builderSlug).sort()).toEqual(["alice", "bob"]);
      logger.info("Shared work");
      expect(JSON.parse(lines.at(-1)!).builderSlug).toBeUndefined();
    } finally { spy.mockRestore(); }
  });
});
