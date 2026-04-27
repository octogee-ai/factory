/**
 * Tests for the unified customer-lifecycle contract.
 *
 * Drives every starting-state combination against a mock adapter that
 * records the call sequence:
 *
 *   - First-time provisioning (Firestore empty, disk empty)
 *   - Restore from Gitea (Firestore has repoUrl, disk empty)
 *   - Recovery (Firestore missing repoUrl, disk has stale dir without remote)
 *     ← This is the bug class that motivated the refactor.
 *   - Idempotent re-add (already complete + mounted → no-op)
 *   - Unmount + re-add (cleans local state, reclones via the restore branch)
 *
 * The adapter is the only side-effect surface, so each test asserts both
 * the steps array (what fired) AND the order of mutator calls (so we
 * know Firestore writes are paired with the operations they mirror).
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  addCustomerToGateway,
  ConcurrentMountError,
  _resetInFlightUidsForTests,
  removeCustomerFromGateway,
  type CustomerLifecycleAdapter,
  type UserSnapshot,
  type MmUpdate,
} from "../lib/customer-lifecycle.js";

// ── Mock adapter ────────────────────────────────────────────────────────────

interface DiskState {
  customerDir: boolean;
  workspaceGitDir: boolean;
  gitRemote: boolean;
  sshKey: boolean;
  templatesWritten: boolean;
  customerConfigWritten: boolean;
  /**
   * Mirrors `git rev-parse --verify HEAD` — true when the repo has at
   * least one commit. Used by the contract's empty-Gitea-clone branch
   * to decide whether to re-write templates after a mid-bootstrap
   * restore. Must be a git-level check, not a file-presence check
   * (system files like AGENTS.md are gitignored and never in Gitea).
   */
  repoHasCommits: boolean;
}

interface MockState {
  user: UserSnapshot | null;
  disk: DiskState;
  /** Calls in order — proves canonical Firestore writes are paired with the work. */
  calls: string[];
  /** Firestore field writes captured for assertions. */
  writes: Array<{ field: string; value: unknown }>;
  cloneShouldFail: boolean;
  /**
   * Simulates `git clone` of an empty Gitea repo: clone "succeeds" but
   * leaves no working tree files (no AGENTS.md). Mirrors the
   * mid-bootstrap restore case where provision time created the Gitea
   * repo without pushing the first commit.
   */
  cloneSimulatesEmptyRepo: boolean;
  initShouldFail: boolean;
  giteaRegisterShouldFail: boolean;
  blobSyncShouldFail: boolean;
  healthy: boolean;
  pendingProjects: Array<{ projectSlug: string; giteaRepoName: string }>;
  /** When set, the most recent scheduleBootGreetingCron call's params. */
  lastGreetingCronParams: unknown;
  /** Forces the greeting-cron scheduler to throw when true. */
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
    persistGiteaToken: async (_uid, username, token) =>
      write("system/config.gitea", { username, token }),
    setMattermostFields: async (_uid, fields) => write("mattermost.*", fields),
    setGreetingResult: async (_uid, result) =>
      write("provisioning.openclaw.greeting", result),
    setAgentIds: async (_uid, agentIds) =>
      write("provisioning.openclaw.agentIds", agentIds),

    hasCustomerDir: () => state.disk.customerDir,
    hasWorkspaceGitDir: () => state.disk.workspaceGitDir,
    hasGitRemote: () => state.disk.gitRemote,
    repoHasCommits: () => state.disk.repoHasCommits,
    ensureCustomerDirectories: () => {
      record("ensureCustomerDirectories");
      state.disk.customerDir = true;
    },
    writeCustomerTemplateFiles: async () => {
      record("writeCustomerTemplateFiles");
      state.disk.templatesWritten = true;
      // writeCustomerTemplateFiles itself doesn't create commits — only
      // a successful subsequent commit/push (or clone of a populated
      // repo) flips repoHasCommits.
      return { dataApiKey: "test-data-api-key" };
    },
    writeCustomerConfig: () => {
      record("writeCustomerConfig");
      state.disk.customerConfigWritten = true;
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
      // Mirror real `git clone` semantics: refuses to land into a
      // non-empty directory. The orchestrator must NOT pre-create the
      // customer dir tree before the clone branch runs. (Original P0:
      // pre-create looped restore on every cattle-pod restart.)
      if (state.disk.customerDir) return false;
      state.disk.customerDir = true;
      state.disk.workspaceGitDir = true;
      state.disk.gitRemote = true;
      // Empty-repo clone has no commits. Otherwise the clone delivered
      // a populated history (i.e. agent finished bootstrap + pushed).
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
    createGiteaUser: async () => {
      record("createGiteaUser");
      if (state.giteaRegisterShouldFail) {
        throw new Error("gitea register failed");
      }
      return "gitea-pat-token";
    },

    blobSyncForSlug: async () => {
      record("blobSyncForSlug");
      if (state.blobSyncShouldFail) throw new Error("blob sync failed");
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

    applyAddCustomerConfigPatch: async () => {
      record("applyAddCustomerConfigPatch");
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
  };
}

// ── Snapshot factories ──────────────────────────────────────────────────────

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
    customerConfigWritten: false,
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
    blobSyncShouldFail: false,
    healthy: true,
    pendingProjects: [],
    lastGreetingCronParams: undefined,
    greetingCronShouldFail: false,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("addCustomerToGateway — first-time provisioning", () => {
  let state: MockState;
  beforeEach(() => {
    state = makeState(snap({ status: "" }), emptyDisk());
  });

  it("runs the full first-time flow and writes Firestore in canonical order", async () => {
    const result = await addCustomerToGateway(makeAdapter(state), "uid-test");

    expect(result.newCustomer).toBe(true);
    // verify-channel-ready runs BEFORE the greeting cron is scheduled — the
    // cron's announce delivery only lands when the MM channel is up, so we
    // gate the schedule on a real ready signal. Notify-ops is last so a
    // half-finished mount doesn't ping #ops.
    expect(result.steps).toEqual([
      "claim-slot",
      "write-templates",
      "init-workspace-repo",
      "ssh-key",
      "blob-sync",
      "mattermost-provision",
      "config-patch",
      "verify-channel-ready",
      "schedule-greeting-cron",
      "mark-complete",
      "notify-ops",
    ]);
  });

  it("writes provisioning.git.repoUrl IMMEDIATELY after the repo init succeeds", async () => {
    await addCustomerToGateway(makeAdapter(state), "uid-test");

    const initIdx = state.calls.indexOf("initWorkspaceRepoFromExistingDir");
    const writeIdx = state.calls.indexOf("write:provisioning.git.repoUrl");
    expect(initIdx).toBeGreaterThan(-1);
    expect(writeIdx).toBeGreaterThan(initIdx);
    // No other side-effect steps should slip between init and the canonical write.
    const between = state.calls.slice(initIdx + 1, writeIdx);
    expect(between).toEqual([]);
  });

  it("aborts loudly if the initial workspace repo creation fails", async () => {
    state.initShouldFail = true;
    await expect(addCustomerToGateway(makeAdapter(state), "uid-test")).rejects.toThrow(
      /initial workspace repo creation failed/,
    );
    // Critically: no Firestore repoUrl write happened on a failed init.
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
    // Verify ran, cron schedule did NOT — fleet retries the whole mount.
    expect(state.calls).toContain("waitForAccountHealthy");
    expect(state.calls).not.toContain("scheduleBootGreetingCron");
    // mark-complete and notify-ops also did not happen — half-mounts shouldn't
    // ping #ops or flip provisioning.openclaw.status to complete.
    expect(state.writes.find((w) => w.field === "provisioning.openclaw.status" && w.value === "complete")).toBeUndefined();
  });

  it("throws on greeting cron failure so the fleet retries the whole mount", async () => {
    // Cron-schedule is now FATAL: the frontend interstitial gates the
    // user redirect on the agent having actually posted, so silently
    // skipping the cron would deadlock the user on the loading screen.
    // Fleet retry is the right recovery — verify-channel-ready will
    // pass again on the next attempt and the cron schedule will be retried.
    state.greetingCronShouldFail = true;
    await expect(addCustomerToGateway(makeAdapter(state), "uid-test")).rejects.toThrow(
      /cron\.add rejected/,
    );

    // The failure reason was persisted before the throw so we can see it
    // in Firestore even if the mount never completes.
    const greetWrite = state.writes.find(
      (w) => w.field === "provisioning.openclaw.greeting",
    );
    expect(greetWrite?.value).toMatchObject({ ok: false });
    // Mark-complete + notify-ops did NOT fire — half-mounts mustn't ping
    // #ops or flip provisioning status to complete.
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
    // Already-provisioned customer: status=complete, repoUrl set, mm provisioned,
    // greeting posted. Disk is empty (fresh pod).
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
    expect(result.steps).not.toContain("write-templates");
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

  it("does NOT pre-create the customer dir before the clone (would break git clone)", async () => {
    // Regression for the P0 in PR #703: previously the orchestrator called
    // ensureCustomerDirectories before deciding clone-vs-init. Pre-created
    // subdirs (projects/, memory/, ideas/, .system/) made `git clone` fail
    // with "destination path 'slug' already exists and is not an empty
    // directory" on every cattle-gateway restart.
    await addCustomerToGateway(makeAdapter(state), "uid-test");

    const ensureIdx = state.calls.indexOf("ensureCustomerDirectories");
    const cloneIdx = state.calls.indexOf("cloneWorkspaceRepo");
    expect(cloneIdx).toBeGreaterThan(-1);
    // ensureCustomerDirectories may run after the clone (to fill in subdirs
    // not in the repo), but never before.
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
});

describe("addCustomerToGateway — recovery from orphan dir (the bug class)", () => {
  it("creates the Gitea repo AND writes Firestore in the same step", async () => {
    // Disk has the workspace dir but no remote — exactly the state git-sync's
    // recovery branch used to handle by creating a Gitea repo and discarding
    // the returned repoUrl. The contract must heal both disk and Firestore.
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
    // Mid-bootstrap restore: provision created the Gitea repo + wrote
    // repoUrl to Firestore but never pushed (the agent hadn't deleted
    // BOOTSTRAP.md yet). Pod cycles, restore enters the clone branch,
    // clone "succeeds" with an empty working tree. Without the
    // template-restore the agent wakes up with no AGENTS.md to read.
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

    // Both clone AND write-templates fire.
    expect(result.steps).toContain("clone-workspace-repo");
    expect(result.steps).toContain("write-templates");
    // Order: clone before write-templates (we only know the repo is
    // empty after the clone returns).
    const cloneIdx = state.calls.indexOf("cloneWorkspaceRepo");
    const writeIdx = state.calls.indexOf("writeCustomerTemplateFiles");
    expect(writeIdx).toBeGreaterThan(cloneIdx);
  });

  it("does NOT re-write templates when the clone delivers a populated working tree", async () => {
    // Normal restore (post-bootstrap completion + first push): the
    // clone has AGENTS.md + everything. Re-writing templates would
    // clobber the customer's actual identity files.
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
    // cloneSimulatesEmptyRepo defaults false → AGENTS.md lands via clone.

    const result = await addCustomerToGateway(makeAdapter(state), "uid-test");

    expect(result.steps).toContain("clone-workspace-repo");
    expect(result.steps).not.toContain("write-templates");
    expect(state.calls).not.toContain("writeCustomerTemplateFiles");
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
        customerConfigWritten: true,
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
    // Always-fire steps: blob sync (idempotent pull), config patch, verify.
    expect(result.steps).toContain("blob-sync");
    expect(result.steps).toContain("config-patch");
    expect(result.steps).toContain("verify-channel-ready");
  });
});

describe("addCustomerToGateway — partial-state scenarios", () => {
  it("regenerates SSH key + Gitea token if missing on disk (non-fatal on register failure)", async () => {
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

    const result = await addCustomerToGateway(makeAdapter(state), "uid-test");

    expect(state.calls).toContain("generateCustomerSshKey");
    expect(state.calls).toContain("createGiteaUser");
    // Non-fatal: completes despite the registration failure.
    expect(result.steps).toContain("verify-channel-ready");
    expect(state.writes.find((w) => w.field === "system/config.gitea")).toBeUndefined();
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
    // Tightening from "warns but completes" to "throws": a restore that
    // can't reach running+connected is a real failure (the user lands in
    // an empty channel forever). Better to fail and let the fleet retry.
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
    // The MM-config patch landed before the verify failed, so onMounted
    // still fires (we want pod-local bookkeeping to track the patch).
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

// ── removeCustomerFromGateway ───────────────────────────────────────────────

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
        customerConfigWritten: true,
      },
    );

    const result = await removeCustomerFromGateway(makeAdapter(state), "uid-test");

    expect(result.wasMounted).toBe(true);
    expect(result.steps).toEqual(["config-patch-remove", "delete-dir"]);
    expect(state.calls).toContain("applyRemoveCustomerConfigPatch");
    expect(state.calls).toContain("deleteCustomerDir");
    expect(state.calls).toContain("onUnmounted");
    // Persistent state guard: no Firestore writes touch the user doc.
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
        customerConfigWritten: true,
      },
    );
    const adapter = makeAdapter(state);

    await removeCustomerFromGateway(adapter, "uid-test");
    state.calls = []; // Reset call log to inspect the second op cleanly.
    state.writes = [];

    const reAdd = await addCustomerToGateway(adapter, "uid-test");

    // Clone (not init) because Firestore still has repoUrl.
    expect(reAdd.steps).toContain("clone-workspace-repo");
    expect(reAdd.steps).not.toContain("init-workspace-repo");
    // No re-greeting / re-mm-provision / re-notify.
    expect(reAdd.steps).not.toContain("schedule-greeting-cron");
    expect(reAdd.steps).not.toContain("mattermost-provision");
    expect(reAdd.steps).not.toContain("notify-ops");
  });
});

// ── Same-uid in-flight dedup ────────────────────────────────────────────────

describe("addCustomerToGateway — same-uid in-flight dedup", () => {
  beforeEach(() => {
    _resetInFlightUidsForTests();
  });

  it("throws ConcurrentMountError when a second mount is started for the same uid mid-flight", async () => {
    // Build an adapter where loadUserSnapshot blocks until we release it,
    // so we can keep one mount mid-flight while starting a second.
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

    // Yield to let firstRun begin and add uid-test to the in-flight set.
    await Promise.resolve();
    await Promise.resolve();

    // Second mount for SAME uid — must throw before doing any work.
    await expect(addCustomerToGateway(dedupAdapter, "uid-test")).rejects.toBeInstanceOf(
      ConcurrentMountError,
    );

    // Release the first run; let it complete normally.
    releaseFirst();
    const result = await firstRun;
    expect(result.steps).toContain("verify-channel-ready");
  });

  it("clears the in-flight uid on success so a follow-up mount works", async () => {
    const state = makeState(snap({ status: "" }), emptyDisk());
    await addCustomerToGateway(makeAdapter(state), "uid-test");

    // Subsequent mount for same uid should NOT throw — the first finished.
    const state2 = makeState(snap({ status: "complete", agentIds: ["octogee-test-coach"], repoUrl: "http://gitea/octogee/test-workspace", mattermostUserId: "mm-x", greetingPosted: true }), { ...emptyDisk(), customerDir: true, workspaceGitDir: true, gitRemote: true, sshKey: true, repoHasCommits: true });
    const result = await addCustomerToGateway(makeAdapter(state2), "uid-test");
    expect(result.steps).toContain("verify-channel-ready");
  });

  it("clears the in-flight uid on failure so the fleet can retry", async () => {
    const state = makeState(snap({ status: "" }), emptyDisk());
    state.healthy = false; // Forces verify-channel-ready to throw.

    await expect(addCustomerToGateway(makeAdapter(state), "uid-test")).rejects.toThrow(
      /didn't reach running\+connected/,
    );

    // Retry attempt with a healthy state — should NOT see ConcurrentMountError.
    const state2 = makeState(snap({ status: "" }), emptyDisk());
    const result = await addCustomerToGateway(makeAdapter(state2), "uid-test");
    expect(result.steps).toContain("verify-channel-ready");
  });

  it("isolates uids — different uids run concurrently without dedup interference", async () => {
    const stateA = makeState(snap({ uid: "uid-a", slug: "alice" }), emptyDisk());
    const stateB = makeState(snap({ uid: "uid-b", slug: "bob" }), emptyDisk());

    // Concurrent mounts for DIFFERENT uids — both must succeed.
    const [resA, resB] = await Promise.all([
      addCustomerToGateway(makeAdapter(stateA), "uid-a"),
      addCustomerToGateway(makeAdapter(stateB), "uid-b"),
    ]);
    expect(resA.steps).toContain("verify-channel-ready");
    expect(resB.steps).toContain("verify-channel-ready");
  });
});
