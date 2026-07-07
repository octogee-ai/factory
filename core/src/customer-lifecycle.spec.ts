import { describe, it, expect, beforeEach } from "vitest";
import {
  addCustomerToGateway,
  ConcurrentMountError,
  _resetInFlightUidsForTests,
  _inFlightUidsHasForTests,
  pubKeysMatch,
  removeCustomerFromGateway,
  restoreCustomerRuntimeFromSnapshot,
  type CustomerLifecycleAdapter,
  type UserSnapshot,
  type MmUpdate,
} from "./customer-lifecycle.js";

interface DiskState {
  customerDir: boolean;
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

giteaReadShouldThrow: boolean;

  blobSyncShouldFail: boolean;
  reassertByotShouldFail?: boolean;
  reassertByotUserData?: Record<string, unknown>;
  byosub?: { restored: boolean; present: boolean };
  lastConfigPatchByosActive?: boolean;
  healthy: boolean;
  pendingProjects: Array<{ projectSlug: string; giteaRepoName: string }>;
  
  lastGreetingCronParams: unknown;
  
  greetingCronShouldFail: boolean;
}

function makeAdapter(state: MockState): CustomerLifecycleAdapter {
  const record = (name: string) => state.calls.push(name);
  const write = (field: string, value: unknown) => {
    record(`write:${field}`);
    state.writes.push({ field, value });
  };
  return {
    log: () => {},

    loadUserSnapshot: async () => state.user,

    setProvisioningStatus: async (_uid, status) => write("provisioning.openclaw.status", status),
    setRepoUrl: async (_uid, repoUrl) => write("provisioning.git.repoUrl", repoUrl),
    setMattermostFields: async (_uid, fields) => write("mattermost.*", fields),
    setGreetingResult: async (_uid, result) =>
      write("provisioning.openclaw.greeting", result),
    setAgentIds: async (_uid, agentIds) =>
      write("provisioning.openclaw.agentIds", agentIds),

    hasCustomerDir: () => state.disk.customerDir,
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
    deleteCustomerDir: async () => {
      record("deleteCustomerDir");
      state.disk.customerDir = false;
      state.disk.workspaceGitDir = false;
      state.disk.gitRemote = false;
    },

    cloneWorkspaceRepo: async (_slug, _url) => {
      record("cloneWorkspaceRepo");
      if (state.cloneShouldFail) return false;

      if (state.disk.customerDir) return false;
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

state.giteaRegisteredPubKey = pubKey;
    },
    ensureGiteaOrg: async () => {
      record("ensureGiteaOrg");
    },
    readLocalCustomerPubKey: () => (state.disk.sshKey ? "ssh-pubkey" : null),
    readGiteaCustomerPubKey: async () => {
      if (state.giteaReadShouldThrow) {
        throw new Error("Gitea key read failed (test transient)");
      }
      return state.giteaRegisteredPubKey;
    },
    deleteCustomerSshKey: async () => {
      record("deleteCustomerSshKey");
      state.disk.sshKey = false;
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

    listProjectsNeedingClone: async () => state.pendingProjects,
    cloneProjectRepo: async () => {
      record("cloneProjectRepo");
      return true;
    },

    provisionMattermostUser: async () => {
      record("provisionMattermostUser");
      const update: MmUpdate = {
        "mattermost.userId": "mm-user-123",
        "mattermost.channelId": "channel-abc",
        _coachPersonalToken: "coach-pat",
      };
      return update;
    },
    scheduleBootGreetingCron: async (params) => {
      record("scheduleBootGreetingCron");
      state.lastGreetingCronParams = params;
      if (state.greetingCronShouldFail) {
        throw new Error("cron.add rejected: simulated failure");
      }
      return { jobId: "cron-job-abc" };
    },

    applyAddCustomerConfigPatch: async (_snap, _mm, opts) => {
      record("applyAddCustomerConfigPatch");
      state.lastConfigPatchByosActive = opts?.byosActive ?? false;
      return { elapsedMs: 42 };
    },
    applyRemoveCustomerConfigPatch: async () => {
      record("applyRemoveCustomerConfigPatch");
    },

    waitForAccountHealthy: async () => {
      record("waitForAccountHealthy");
      return state.healthy;
    },

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
    activateImportedCustomer: async () => {},
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
    greetingPosted: false,
    channels: [],
    ownerName: "Test User",
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
    lastGreetingCronParams: undefined,
    greetingCronShouldFail: false,
  };
}

describe("addCustomerToGateway — first-time provisioning", () => {
  let state: MockState;
  beforeEach(() => {
    state = makeState(snap({ status: "" }), emptyDisk());
  });

  it("runs the full first-time flow and writes Firestore in canonical order", async () => {
    const result = await addCustomerToGateway(makeAdapter(state), "uid-test");

    expect(result.newCustomer).toBe(true);

expect(result.steps).toEqual([
      "claim-slot",
      "ssh-key",
      "write-templates",
      "init-workspace-repo",
      "blob-sync",
      "mattermost-provision",
      "config-patch",
      "byot-reassert",
      "verify-channel-ready",
      "schedule-greeting-cron",
      "mark-complete",
      "notify-ops",
    ]);
  });

  it("ensures the per-workspace Gitea org BEFORE the workspace repo (#963)", async () => {
    await addCustomerToGateway(makeAdapter(state), "uid-test");

    const orgIdx = state.calls.indexOf("ensureGiteaOrg");
    const repoIdx = state.calls.indexOf("initWorkspaceRepoFromExistingDir");

expect(orgIdx).toBeGreaterThan(-1);
    expect(repoIdx).toBeGreaterThan(orgIdx);
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

  it("forwards the plan-resolution fields (subscription/selectedTier/trialStartedAt) to the reassert — a trial user's model picks must not defer to house_only at mount", async () => {
    state.user = snap({
      tier: "trial",
      subscription: { trialStartedAt: { _seconds: 1_783_500_000, _nanoseconds: 0 } },
      systemConfig: {
        agentModels: { "octogee-test-coach": { primary: "platform-openrouter/minimax/minimax-m3", fallbacks: [] } },
      },
    });
    await addCustomerToGateway(makeAdapter(state), "uid-test");

    const ud = state.reassertByotUserData ?? {};
    expect(ud.tier).toBe("trial");
    expect(ud.subscription).toEqual({ trialStartedAt: { _seconds: 1_783_500_000, _nanoseconds: 0 } });
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

  it("schedules the boot-greeting cron once and persists the job id", async () => {
    await addCustomerToGateway(makeAdapter(state), "uid-test");

    expect(state.calls).toContain("scheduleBootGreetingCron");
    expect(state.lastGreetingCronParams).toMatchObject({
      slug: "test",
      agentId: "octogee-test-coach",
      accountId: "test-coach",
    });
    const greetWrite = state.writes.find(
      (w) => w.field === "provisioning.openclaw.greeting",
    );
    expect(greetWrite?.value).toMatchObject({ ok: true, jobId: "cron-job-abc" });
  });

  it("only schedules the greeting cron AFTER the channel reports ready", async () => {
    await addCustomerToGateway(makeAdapter(state), "uid-test");

    const verifyIdx = state.calls.indexOf("waitForAccountHealthy");
    const cronIdx = state.calls.indexOf("scheduleBootGreetingCron");
    expect(verifyIdx).toBeGreaterThan(-1);
    expect(cronIdx).toBeGreaterThan(verifyIdx);
  });

  it("aborts loudly if the channel never reaches running+connected (no half-mounts)", async () => {
    state.healthy = false;
    await expect(addCustomerToGateway(makeAdapter(state), "uid-test")).rejects.toThrow(
      /didn't reach running\+connected/,
    );
    expect(state.calls).toContain("waitForAccountHealthy");
    expect(state.calls).not.toContain("scheduleBootGreetingCron");
    
    expect(state.writes.find((w) => w.field === "provisioning.openclaw.status" && w.value === "complete")).toBeUndefined();
  });

  it("throws on greeting cron failure so the fleet retries the whole mount", async () => {

state.greetingCronShouldFail = true;
    await expect(addCustomerToGateway(makeAdapter(state), "uid-test")).rejects.toThrow(
      /cron\.add rejected/,
    );

const greetWrite = state.writes.find(
      (w) => w.field === "provisioning.openclaw.greeting",
    );
    expect(greetWrite?.value).toMatchObject({ ok: false });
    expect(state.writes.find((w) => w.field === "provisioning.openclaw.status" && w.value === "complete")).toBeUndefined();
    expect(state.calls).not.toContain("notifyOpsOfSignup");
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
        greetingPosted: true,
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

  it("does NOT re-provision Mattermost or re-schedule the greeting cron", async () => {
    await addCustomerToGateway(makeAdapter(state), "uid-test");

    expect(state.calls).not.toContain("provisionMattermostUser");
    expect(state.calls).not.toContain("scheduleBootGreetingCron");
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
    expect(state.calls).toContain("deleteCustomerDir");
    expect(state.calls.indexOf("deleteCustomerDir")).toBeLessThan(
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
        greetingPosted: true,
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
        greetingPosted: true,
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
        greetingPosted: true,
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
        greetingPosted: true,
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

describe("addCustomerToGateway — operator gateway short-circuits when status=complete", () => {
  it("skips SSH-resync + Gitea ensure + blob-sync + byosub-restore + config-patch; only verify-channel-ready fires", async () => {
    const state = makeState(
      snap({
        status: "complete",
        agentIds: ["octogee-test-coach"],
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user-existing",
        greetingPosted: true,
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
    adapter.isOperatorGateway = () => true;
    adapter.customerCoachWiredInOpenclawConfig = () => true; // openclaw.json has the agent

    const result = await addCustomerToGateway(adapter, "uid-test");

    expect(result.newCustomer).toBe(false);
    expect(result.steps).toEqual(["verify-channel-ready"]);
    // Heavy / network-touching calls MUST NOT fire on an operator pod with a hot PVC
    expect(state.calls).not.toContain("ensureGiteaOrg");
    expect(state.calls).not.toContain("createGiteaUser");
    expect(state.calls).not.toContain("readGiteaCustomerPubKey");
    expect(state.calls).not.toContain("blobSyncForSlug");
    expect(state.calls).not.toContain("restoreByosubForAgent");
    expect(state.calls).not.toContain("applyAddCustomerConfigPatch");
    // The one thing operator-mode MUST keep — MM-side liveness verification
    expect(state.calls).toContain("waitForAccountHealthy");
    // Fleet heartbeat MUST register this customer as mounted, even on the
    // short-circuit path — Copilot review on PR #1182 caught a regression
    // here. Without it, fleet/heartbeat reports no mounted customers.
    expect(state.calls).toContain("onMounted");
  });

  it("does not short-circuit for a brand-new customer (status='')", async () => {
    // Even on an operator gateway, first-time onboarding must run the full
    // flow — the short-circuit only applies to status=complete (the PVC
    // already has the durable state we'd otherwise re-create).
    const state = makeState(snap({ status: "" }), emptyDisk());
    const adapter = makeAdapter(state);
    adapter.isOperatorGateway = () => true;

    const result = await addCustomerToGateway(adapter, "uid-test");
    expect(result.newCustomer).toBe(true);
    expect(result.steps).toContain("ssh-key");
    expect(result.steps).toContain("mattermost-provision");
    expect(result.steps).toContain("config-patch");
  });

  it("does NOT short-circuit when status=complete but openclaw.json has no agent yet (customer-move TO operator)", async () => {
    // Cowboy moves a customer from a cattle gateway to an operator. Their
    // Firestore status="complete" (from the cattle mount) but the new
    // operator's PVC has none of their state. Must run the full flow to
    // generate SSH key, register with Gitea, clone workspace, register the
    // agent in openclaw.json, provision MM, and verify.
    const state = makeState(
      snap({
        status: "complete",
        agentIds: ["octogee-test-coach"],
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user-existing",
        greetingPosted: true,
      }),
      emptyDisk(), // fresh PVC — no SSH key, no workspace, nothing
    );
    const adapter = makeAdapter(state);
    adapter.isOperatorGateway = () => true;
    adapter.customerCoachWiredInOpenclawConfig = () => false; // openclaw.json on this PVC doesn't know the agent

    const result = await addCustomerToGateway(adapter, "uid-test");

    // hasGitDir=false + repoUrl set → cloneWorkspaceRepo path
    expect(state.calls).toContain("generateCustomerSshKey");
    expect(state.calls).toContain("createGiteaUser");
    expect(state.calls).toContain("cloneWorkspaceRepo");
    expect(state.calls).toContain("ensureGiteaOrg");
    expect(state.calls).toContain("applyAddCustomerConfigPatch");
    expect(state.calls).toContain("waitForAccountHealthy");
    expect(result.steps).toContain("ssh-key");
    expect(result.steps).toContain("config-patch");
    expect(result.steps).toContain("verify-channel-ready");
  });

  it("crash-mid-flow recovery: SSH key on disk but openclaw.json missing agent → falls through to full flow", async () => {
    // Copilot review on PR #1182 surfaced this scenario: a previous mount
    // crashed AFTER generateCustomerSshKey but BEFORE applyAddCustomerConfigPatch
    // landed the agent into openclaw.json. The SSH key check alone would
    // short-circuit forever and verify would hang on an unregistered
    // agent. The agent-in-openclaw-config check fixes it by re-running
    // the full flow until config.patch lands.
    const state = makeState(
      snap({
        status: "complete",
        agentIds: ["octogee-test-coach"],
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user-existing",
        greetingPosted: true,
      }),
      {
        customerDir: true,
        workspaceGitDir: true,
        gitRemote: true,
        sshKey: true, // ← SSH key on disk from prior interrupted run
        templatesWritten: true,
        repoHasCommits: true,
      },
    );
    const adapter = makeAdapter(state);
    adapter.isOperatorGateway = () => true;
    adapter.customerCoachWiredInOpenclawConfig = () => false; // ← but config.patch never finished
    state.giteaRegisteredPubKey = "ssh-pubkey"; // matches what readLocalCustomerPubKey returns

    const result = await addCustomerToGateway(adapter, "uid-test");

    // The flow must run far enough to land the agent.
    expect(state.calls).toContain("applyAddCustomerConfigPatch");
    expect(state.calls).toContain("waitForAccountHealthy");
    expect(result.steps).toContain("config-patch");
    expect(result.steps).toContain("verify-channel-ready");
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
        greetingPosted: true,
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
    expect(result.steps).not.toContain("schedule-greeting-cron");
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
        greetingPosted: true,
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
        greetingPosted: true,
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

  it("does NOT resync when local + Gitea keys match (healthy state)", async () => {
    const state = makeState(
      snap({
        status: "complete",
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user",
        greetingPosted: true,
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
        greetingPosted: true,
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
  });

  it("throws when verify times out — restores must NOT silently succeed on a broken mount", async () => {
    const state = makeState(
      snap({
        status: "complete",
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user",
        greetingPosted: true,
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
        greetingPosted: true,
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
    expect(result.steps).toEqual(["config-patch-remove", "delete-dir"]);
    expect(state.calls).toContain("applyRemoveCustomerConfigPatch");
    expect(state.calls).toContain("deleteCustomerDir");
    expect(state.calls).toContain("onUnmounted");
    expect(state.writes).toEqual([]);
  });

  it("is a no-op when the customer was never mounted", async () => {
    const state = makeState(snap({ status: "" }), emptyDisk());

    const result = await removeCustomerFromGateway(makeAdapter(state), "uid-test");

    expect(result.wasMounted).toBe(false);
    expect(result.steps).toEqual([]);
    expect(state.calls).not.toContain("applyRemoveCustomerConfigPatch");
    expect(state.calls).not.toContain("deleteCustomerDir");
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
        greetingPosted: true,
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
    expect(reAdd.steps).not.toContain("schedule-greeting-cron");
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

    const state2 = makeState(snap({ status: "complete", agentIds: ["octogee-test-coach"], repoUrl: "http://gitea/octogee/test-workspace", mattermostUserId: "mm-x", greetingPosted: true }), { ...emptyDisk(), customerDir: true, workspaceGitDir: true, gitRemote: true, sshKey: true, repoHasCommits: true });
    const result = await addCustomerToGateway(makeAdapter(state2), "uid-test");
    expect(result.steps).toContain("verify-channel-ready");
  });

  it("throws a deadline error and releases the in-flight uid when a step hangs past mountDeadlineMs", async () => {
    const state = makeState(snap({ status: "" }), emptyDisk());
    const realAdapter = makeAdapter(state);
    const hangingAdapter: CustomerLifecycleAdapter = {
      ...realAdapter,
      loadUserSnapshot: () => new Promise(() => {}),
    };

    await expect(
      addCustomerToGateway(hangingAdapter, "uid-test", { mountDeadlineMs: 25 }),
    ).rejects.toThrow(/mountDeadlineMs.*25ms.*exceeded/i);

    expect(_inFlightUidsHasForTests("uid-test")).toBe(false);

    const state2 = makeState(snap({ status: "" }), emptyDisk());
    const retry = await addCustomerToGateway(makeAdapter(state2), "uid-test");
    expect(retry.steps).toContain("verify-channel-ready");
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

  it("does not call blobSyncForSlug during restore — the source rsync + the post-online loop own blob backfill", async () => {
    const state = makeState(snap({ status: "complete" }), emptyDisk());

    const result = await restoreCustomerRuntimeFromSnapshot(makeAdapter(state), state.user!);

    expect(state.calls).not.toContain("blobSyncForSlug");
    expect(result.steps).not.toContain("blob-sync");
    expect(result.steps).toContain("verify-channel-ready");
  });
});

describe("restoreCustomerRuntimeFromSnapshot — same-uid in-flight dedup", () => {
  beforeEach(() => {
    _resetInFlightUidsForTests();
  });

  it("throws a deadline error and releases the in-flight uid when a restore step hangs past mountDeadlineMs", async () => {
    const state = makeState(snap({ status: "complete" }), emptyDisk());
    const realAdapter = makeAdapter(state);
    const hangingAdapter: CustomerLifecycleAdapter = {
      ...realAdapter,
      hasCustomerSshKey: () => true,
      readLocalCustomerPubKey: () => "ssh-pubkey",
      readGiteaCustomerPubKey: async () => new Promise(() => {}),
    };

    await expect(
      restoreCustomerRuntimeFromSnapshot(hangingAdapter, state.user!, { mountDeadlineMs: 25 }),
    ).rejects.toThrow(/mountDeadlineMs.*25ms.*exceeded/i);

    expect(_inFlightUidsHasForTests("uid-test")).toBe(false);

    const state2 = makeState(snap({ status: "complete" }), emptyDisk());
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
    setRepoUrl: false,
    setMattermostFields: false,
    setGreetingResult: false,
    setAgentIds: false,
    hasCustomerDir: false,
    hasWorkspaceGitDir: false,
    hasGitRemote: false,
    repoHasCommits: false,
    ensureCustomerDirectories: false,
    writeCustomerTemplateFiles: false,
    deleteCustomerDir: false,
    hasCustomerSshKey: false,
    generateCustomerSshKey: false,
    createGiteaUser: false,
    ensureGiteaOrg: false,
    readLocalCustomerPubKey: false,
    readGiteaCustomerPubKey: false,
    deleteCustomerSshKey: false,
    blobSyncForSlug: false,
    restoreByosubForAgent: false,
    listProjectsNeedingClone: false,
    provisionMattermostUser: false,
    scheduleBootGreetingCron: false,
    applyAddCustomerConfigPatch: false,
    applyRemoveCustomerConfigPatch: false,
    waitForAccountHealthy: false,
    notifyOpsOfSignup: false,
    onMounted: false,
    onUnmounted: false,
    uidForSlug: false,
    quiesceCustomer: false,
    listExportPaths: false,
    prepareImportDir: false,
    prepareKeyImportDir: false,
    activateImportedCustomer: false,
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
      greetingPosted: true,
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
