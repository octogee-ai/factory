import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CLONE_RETRY_DELAYS_MS,
  buildFleetHeartbeatSnapshot,
  buildFleetHealthResponse,
  buildFleetStateResponse,
  cloneRetryDelayMs,
  cloneRetryReady,
  customerEnsureRetryReady,
  cancelRemovedEviction,
  createConfiguredBuilderReconcileAdmission,
  createBuilderSurgeGateWiring,
  desiredEnsureLaneFingerprint,
  permanentConfigPatchRetryReady,
  ensureCustomerCheckoutsOnly,
  NEEDS_FULL_ATTACH_FINGERPRINT,
  evictLocalCustomer,
  evictLocalCustomerIfStillUndesired,
  gatewayServiceName,
  finalizeConvergedMount,
  pendingCloneAppliedFingerprint,
  pendingCloneOnlyStale,
  settleConvergence,
  selectStableContentStale,
  getEvictObservedSlugs,
  getMountObservedSlugs,
  probeSurgeReadiness,
  reconcileAddCustomerOptions,
  readMountedCustomersFromAssignedState,
  resolveFleetCapabilities,
  waitForOpenClawHealthz,
} from "../lib/fleet-provisioner.js";
import type { CustomerLifecycleAdapter } from "../lib/customer-lifecycle.js";
import type { SurgeOpenClawProcessSupervisorClient } from "../lib/surge-openclaw-process-gate.js";
import type { SurgeReadinessGate } from "../lib/surge-readiness.js";
import { startReconcileLoop } from "../lib/reconcile-loop.js";
import { startAfterSurgeReadiness } from "../lib/surge-reconcile-gate.js";
import {
  _resetMigratingInProcessPinsForTests,
  isMigratingInPinned,
  listLocalCustomerDirs,
  writeMigratingInPin,
} from "../lib/local-coach-wired.js";

const tmpDirs: string[] = [];

afterEach(() => _resetMigratingInProcessPinsForTests());
afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function mkDb(rows: Array<Record<string, unknown>>): Firestore {
  const docs = rows.map((row) => ({ data: () => row }));
  const query = {
    where: vi.fn(() => query),
    get: vi.fn(async () => ({ docs })),
  };
  return {
    collection: vi.fn(() => query),
  } as unknown as Firestore;
}

describe("settleConvergence — the applied-fingerprint gate", () => {
  const hooks = () => ({
    recordApplied: vi.fn(),
    rememberRetry: vi.fn(),
    forgetRetry: vi.fn(),
  });

  const pending = (slugs: string[]) => ({
    now: 1_000,
    slug: "alice",
    desiredFingerprint: "fp1",
    prior: undefined,
    result: { pendingProjectClones: slugs },
  });

  it("records the fingerprint and drops any backoff once every checkout has landed", () => {
    const h = hooks();
    settleConvergence(
      {
        now: 1_000,
        slug: "alice",
        desiredFingerprint: "fp1",
        prior: { attempts: 3, nextAt: 0, fingerprint: "fp1" },
        result: { pendingProjectClones: [] },
      },
      h,
    );
    expect(h.recordApplied).toHaveBeenCalledWith("alice", "fp1");
    expect(h.forgetRetry).toHaveBeenCalledWith("alice");
    expect(h.rememberRetry).not.toHaveBeenCalled();
  });

  it("THROWS while a checkout is absent — returning normally would fire the loop's onEnsureSuccess, which clears the very lastError an operator needs to see", () => {
    const h = hooks();
    expect(() => settleConvergence(pending(["camp"]), h)).toThrow(/camp/);
  });

  it("parks the customer on the pending-clone marker and schedules a backed-off retry while a checkout is absent", () => {
    const h = hooks();
    expect(() => settleConvergence(pending(["camp"]), h)).toThrow();
    expect(h.recordApplied).toHaveBeenCalledWith(
      "alice",
      pendingCloneAppliedFingerprint("fp1"),
    );
    expect(h.rememberRetry).toHaveBeenCalledWith("alice", {
      attempts: 1,
      nextAt: 1_000 + cloneRetryDelayMs(1),
      fingerprint: "fp1",
    });
  });

  it("never records the real fingerprint while a checkout is absent — the marker stays stale against every real fingerprint", () => {
    const h = hooks();
    expect(() => settleConvergence(pending(["camp"]), h)).toThrow();
    expect(h.recordApplied).not.toHaveBeenCalledWith("alice", "fp1");
    expect(pendingCloneOnlyStale(pendingCloneAppliedFingerprint("fp1"), "fp1")).toBe(true);
    expect(pendingCloneOnlyStale(pendingCloneAppliedFingerprint("fp1"), "fp2")).toBe(false);
    expect(pendingCloneOnlyStale("fp1", "fp1")).toBe(false);
    expect(pendingCloneOnlyStale(undefined, "fp1")).toBe(false);
  });

  it("records the post-attach fingerprint instead of relaunching a newly provisioned customer as stale", () => {
    const h = hooks();
    settleConvergence(
      {
        now: 1_000,
        slug: "alice",
        desiredFingerprint: "before-mattermost",
        prior: undefined,
        result: {
          pendingProjectClones: [],
          appliedFingerprint: "after-mattermost",
        },
      },
      h,
    );

    expect(h.recordApplied).toHaveBeenCalledWith("alice", "after-mattermost");
  });

  it("lengthens the backoff on repeat and caps it — never abandons, never hot-loops", () => {
    expect(cloneRetryDelayMs(1)).toBeLessThan(cloneRetryDelayMs(2));
    expect(cloneRetryDelayMs(2)).toBeLessThan(cloneRetryDelayMs(3));
    expect(cloneRetryDelayMs(99)).toBe(cloneRetryDelayMs(CLONE_RETRY_DELAYS_MS.length));
  });
});

describe("finalizeConvergedMount — the durable mount boundary", () => {
  it("stamps and marks the completed mount even while a project checkout is pending — the retry must be checkout-only, never a full re-attach", async () => {
    const stampMounted = vi.fn(async () => undefined);
    const writeMountMarker = vi.fn();
    const hooks = {
      recordApplied: vi.fn(),
      rememberRetry: vi.fn(),
      forgetRetry: vi.fn(),
    };

    await expect(finalizeConvergedMount({
      now: 1_000,
      slug: "alice",
      uid: "uid-alice",
      desiredFingerprint: "fp1",
      prior: undefined,
      result: { pendingProjectClones: ["camp"] },
      hooks,
      stampMounted,
      writeMountMarker,
    })).rejects.toThrow(/camp/);

    expect(hooks.rememberRetry).toHaveBeenCalledOnce();
    expect(hooks.recordApplied).toHaveBeenCalledWith(
      "alice",
      pendingCloneAppliedFingerprint("fp1"),
    );
    expect(stampMounted).toHaveBeenCalledWith("uid-alice", true);
    expect(writeMountMarker).toHaveBeenCalledWith("alice");
  });

  it("stamps and marks the mount before settling so the pending-clone throw cannot leave a completed mount unmarked", async () => {
    const events: string[] = [];
    const hooks = {
      recordApplied: vi.fn(() => events.push("applied")),
      rememberRetry: vi.fn(),
      forgetRetry: vi.fn(() => events.push("retry-forgotten")),
    };

    await finalizeConvergedMount({
      now: 1_000,
      slug: "alice",
      uid: "uid-alice",
      desiredFingerprint: "fp1",
      prior: undefined,
      result: { pendingProjectClones: [] },
      hooks,
      stampMounted: vi.fn(async () => {
        events.push("mounted-stamped");
      }),
      writeMountMarker: vi.fn(() => events.push("mount-marker")),
    });

    expect(events).toEqual([
      "mounted-stamped",
      "mount-marker",
      "retry-forgotten",
      "applied",
    ]);
  });
});

describe("ensureCustomerCheckoutsOnly — the pending-clone retry lane", () => {
  const adapterWith = (overrides: Record<string, unknown>) => ({
    log: vi.fn(),
    listProjectsNeedingClone: vi.fn(async () => []),
    cloneProjectRepo: vi.fn(async () => true),
    ...overrides,
  }) as unknown as CustomerLifecycleAdapter;

  it("routes the next converge to a full attach once the checkout lands, so the held-out project agent gets wired", async () => {
    const adapter = adapterWith({
      listProjectsNeedingClone: vi.fn(async () => []),
    });
    const hooks = {
      recordApplied: vi.fn(),
      rememberRetry: vi.fn(),
      forgetRetry: vi.fn(),
    };

    const outcome = await ensureCustomerCheckoutsOnly(
      adapter,
      { now: 1_000, slug: "alice", desiredFingerprint: "fp1", prior: undefined },
      hooks,
    );

    expect(outcome).toBe("noop");
    expect(hooks.recordApplied).toHaveBeenCalledWith("alice", NEEDS_FULL_ATTACH_FINGERPRINT);
    expect(hooks.forgetRetry).toHaveBeenCalledWith("alice");
    expect(pendingCloneOnlyStale(NEEDS_FULL_ATTACH_FINGERPRINT, "fp1")).toBe(false);
  });

  it("re-arms the marker and the lengthened backoff while the checkout is still absent, and throws so lastError persists", async () => {
    const adapter = adapterWith({
      listProjectsNeedingClone: vi.fn(async () => [
        { projectSlug: "camp", giteaRepoName: null },
      ]),
    });
    const hooks = {
      recordApplied: vi.fn(),
      rememberRetry: vi.fn(),
      forgetRetry: vi.fn(),
    };

    await expect(ensureCustomerCheckoutsOnly(
      adapter,
      {
        now: 1_000,
        slug: "alice",
        desiredFingerprint: "fp1",
        prior: { attempts: 2, nextAt: 0, fingerprint: "fp1" },
      },
      hooks,
    )).rejects.toThrow(/camp/);

    expect(hooks.recordApplied).toHaveBeenCalledWith(
      "alice",
      pendingCloneAppliedFingerprint("fp1"),
    );
    expect(hooks.rememberRetry).toHaveBeenCalledWith("alice", {
      attempts: 3,
      nextAt: 1_000 + cloneRetryDelayMs(3),
      fingerprint: "fp1",
    });
  });
});

describe("selectStableContentStale", () => {
  it("re-ensures a migrated target after cutover when its fingerprint was intentionally withheld", () => {
    const pending = new Map<string, string>();
    const desired = new Map([["august", "projects-ready"]]);
    const applied = new Map<string, string>();
    expect(selectStableContentStale(
      ["august"],
      desired,
      applied,
      pending,
    )).toEqual([]);
    expect(selectStableContentStale(
      ["august"],
      desired,
      applied,
      pending,
    )).toEqual(["august"]);
  });

  it("coalesces intermediate project provisioning fingerprints into one final re-ensure", () => {
    const pending = new Map<string, string>();
    const applied = new Map([["alice", "before-project"]]);

    expect(selectStableContentStale(
      ["alice"],
      new Map([["alice", "project-provisioning"]]),
      applied,
      pending,
    )).toEqual([]);
    expect(selectStableContentStale(
      ["alice"],
      new Map([["alice", "project-active"]]),
      applied,
      pending,
    )).toEqual([]);
    expect(selectStableContentStale(
      ["alice"],
      new Map([["alice", "project-active"]]),
      applied,
      pending,
    )).toEqual(["alice"]);

    applied.set("alice", "project-active");
    expect(selectStableContentStale(
      ["alice"],
      new Map([["alice", "project-active"]]),
      applied,
      pending,
    )).toEqual([]);
    expect(pending.has("alice")).toBe(false);
  });
});

describe("reconcileAddCustomerOptions", () => {
  it("forces the full lifecycle path when snapshot fingerprints drive convergence", () => {
    expect(reconcileAddCustomerOptions(true)).toEqual({ convergeContent: true });
    expect(reconcileAddCustomerOptions(false)).toEqual({});
  });
});

describe("cloneRetryReady — holds a stranded slug off the hot path between attempts", () => {
  it("is ready when nothing is pending", () => {
    expect(cloneRetryReady(undefined, "fp1", 1_000)).toBe(true);
  });

  it("waits out the backoff, so a wedged checkout cannot re-ensure the customer every 15s", () => {
    const prior = { attempts: 2, nextAt: 5_000, fingerprint: "fp1" };
    expect(cloneRetryReady(prior, "fp1", 4_999)).toBe(false);
    expect(cloneRetryReady(prior, "fp1", 5_000)).toBe(true);
  });

  it("converges IMMEDIATELY on genuine drift — a new project must never wait out a backoff earned by an unrelated stranded one", () => {
    const prior = { attempts: 5, nextAt: 9_000_000, fingerprint: "fp1" };
    expect(cloneRetryReady(prior, "fp2", 1_000)).toBe(true);
  });
});

describe("customerEnsureRetryReady", () => {
  const pendingClone = { attempts: 1, nextAt: 5_000, fingerprint: "fp1" };

  it("holds a cold or unmounted customer until its project-clone backoff expires", () => {
    expect(customerEnsureRetryReady({
      cloneRetry: pendingClone,
      desiredFingerprint: "fp1",
      now: 4_999,
      permanentConfigPatchRetry: undefined,
      desiredEnsureFingerprint: "fleet-fp1",
    })).toBe(false);
  });

  it("bypasses clone backoff immediately when the desired customer fingerprint changes", () => {
    expect(customerEnsureRetryReady({
      cloneRetry: pendingClone,
      desiredFingerprint: "fp2",
      now: 1_001,
      permanentConfigPatchRetry: undefined,
      desiredEnsureFingerprint: "fleet-fp2",
    })).toBe(true);
  });

  it("still holds the ensure lane for an unchanged permanent config-patch failure", () => {
    expect(customerEnsureRetryReady({
      cloneRetry: undefined,
      desiredFingerprint: "fp1",
      now: 5_000,
      permanentConfigPatchRetry: { fingerprint: "fleet-fp1" },
      desiredEnsureFingerprint: "fleet-fp1",
    })).toBe(false);
  });
});

describe("permanentConfigPatchRetryReady", () => {
  it("holds an unchanged invalid patch and immediately re-enables it for a changed desired fingerprint", () => {
    const unchanged = desiredEnsureLaneFingerprint(
      new Map([["alice", "fp1"], ["bob", "fp2"]]),
    );
    const reordered = desiredEnsureLaneFingerprint(
      new Map([["bob", "fp2"], ["alice", "fp1"]]),
    );
    const changed = desiredEnsureLaneFingerprint(
      new Map([["alice", "fp3"], ["bob", "fp2"]]),
    );

    expect(reordered).toBe(unchanged);
    expect(permanentConfigPatchRetryReady({ fingerprint: unchanged }, unchanged)).toBe(false);
    expect(permanentConfigPatchRetryReady({ fingerprint: unchanged }, changed)).toBe(true);
  });
});

describe("readMountedCustomersFromAssignedState", () => {
  it("seeds assigned complete customers only when local state is present and wired", async () => {
    const db = mkDb([
      { provisioning: { openclaw: { slug: "ceckert" } } },
      { provisioning: { openclaw: { slug: "missing-dir" } } },
      { provisioning: { openclaw: { slug: "unwired" } } },
      { provisioning: { openclaw: { slug: "no-runtime" } } },
      { provisioning: { openclaw: { slug: "no-git" } } },
      { provisioning: { openclaw: { slug: "no-origin" } } },
      { provisioning: { openclaw: { slug: "ceckert" } } },
      { username: "fallback" },
    ]);
    const hasCustomerDir = vi.fn((slug: string) => slug !== "missing-dir");
    const customerCoachWiredInOpenclawConfig = vi.fn(
      (slug: string) => slug !== "unwired",
    );

    await expect(
      readMountedCustomersFromAssignedState(db, "gw-bender", {
        hasCustomerDir,
        customerCoachWiredInOpenclawConfig,
        hasCustomerAgentRuntime: (slug) => slug !== "no-runtime",
        hasWorkspaceGitDir: (slug) => slug !== "no-git",
        hasGitRemote: (slug) => slug !== "no-origin",
      }),
    ).resolves.toEqual(["ceckert", "fallback"]);
  });

  it("falls back to customer-dir presence when the adapter has no config wiring probe", async () => {
    const db = mkDb([
      { provisioning: { openclaw: { slug: "alice" } } },
      { provisioning: { openclaw: { slug: "bob" } } },
    ]);

    await expect(
      readMountedCustomersFromAssignedState(db, "gw-a", {
        hasCustomerDir: (slug) => slug === "bob",
        hasWorkspaceGitDir: () => true,
        hasGitRemote: () => true,
      }),
    ).resolves.toEqual(["bob"]);
  });

  it("seeds a Builder-owned overlay only after its local mount marker is written", async () => {
    const db = mkDb([
      { provisioning: { openclaw: { slug: "discord-builder" } } },
      { provisioning: { openclaw: { slug: "unmounted-builder" } } },
    ]);

    await expect(
      readMountedCustomersFromAssignedState(db, "gw-builder", {
        isBuilderGateway: () => true,
        isConfiguredBuilderCustomer: (slug) => slug === "discord-builder",
        hasCustomerDir: () => true,
        configuredBuilderOverlayPresent: () => true,
        customerMountMarked: (slug) => slug === "discord-builder",
        customerCoachWiredInOpenclawConfig: () => false,
        hasCustomerAgentRuntime: () => false,
        hasWorkspaceGitDir: () => true,
        hasGitRemote: () => true,
      }),
    ).resolves.toEqual(["discord-builder"]);
  });
});

function mkObservedAdapter(over: Partial<CustomerLifecycleAdapter>): CustomerLifecycleAdapter {
  return {
    hasCustomerAgentRuntime: () => true,
    hasWorkspaceGitDir: () => true,
    hasGitRemote: () => true,
    ...over,
  } as CustomerLifecycleAdapter;
}

describe("configured Builder surge release", () => {
  it("reconciles and mounts the held imported tree before permitting OpenClaw", async () => {
    vi.stubEnv("GATEWAY_BUILDER_SLUG", "ceckert-test");
    vi.stubEnv("POD_UID", "target-pod");
    try {
      const events: string[] = [];
      let mounted = false;
      const adapter = {
        isBuilderGateway: () => true,
        isConfiguredBuilderCustomer: (slug: string) => slug === "ceckert-test",
        configuredBuilderOverlayPresent: () => true,
        listLocalCustomerSlugs: () => mounted ? ["ceckert-test"] : [],
        customerMountMarked: () => mounted,
        hasWorkspaceGitDir: () => true,
        hasGitRemote: () => true,
      } as unknown as CustomerLifecycleAdapter;
      const processGate = {
        status: vi.fn(async () => {
          events.push("status");
          return {
            version: 1 as const,
            podUid: "target-pod",
            role: "target" as const,
            mode: "held" as const,
            phase: "held" as const,
            migrationId: "mig-builder",
            slug: "ceckert-test",
            targetPodUid: "target-pod",
          };
        }),
        permit: vi.fn(async () => {
          events.push("permit");
          return {
            version: 1 as const,
            podUid: "target-pod",
            role: "target" as const,
            mode: "permitted" as const,
            phase: "running" as const,
            migrationId: "mig-builder",
            slug: "ceckert-test",
            targetPodUid: "target-pod",
          };
        }),
        hold: vi.fn(),
        settle: vi.fn(async () => {
          events.push("settle");
          return {
            version: 1 as const,
            podUid: "target-pod",
            role: "normal" as const,
            mode: "permitted" as const,
            phase: "running" as const,
          };
        }),
      } as unknown as SurgeOpenClawProcessSupervisorClient;
      const surgeReadiness = {
        release: vi.fn(async () => {
          events.push("release");
        }),
      } as unknown as SurgeReadinessGate;
      const reconcileImportedWorkspace = vi.fn((slug: string) => {
        events.push(`reconcile:${slug}`);
      });
      const attachConfiguredBuilderBeforeOpenClaw = vi.fn(async () => {
        events.push("attach");
        mounted = true;
        return "ceckert-test";
      });
      const wiring = createBuilderSurgeGateWiring({
        adapter,
        processGate,
        surgeReadiness,
        waitForGatewayReady: async () => {
          events.push("ready");
        },
        log: () => undefined,
        reconcileImportedWorkspace,
        attachConfiguredBuilderBeforeOpenClaw,
      });

      await wiring.releaseSurgeReadiness({
        migrationId: "mig-builder",
        targetPodUid: "target-pod",
      });

      expect(events).toEqual([
        "status",
        "reconcile:ceckert-test",
        "attach",
        "permit",
        "ready",
        "release",
        "settle",
      ]);
      expect(vi.mocked(processGate.permit)).toHaveBeenCalledWith({
        migrationId: "mig-builder",
        slug: "ceckert-test",
        targetPodUid: "target-pod",
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("does not reconcile a released-marker target until its Builder process gate is permitted", async () => {
    vi.useFakeTimers();
    vi.stubEnv("GATEWAY_BUILDER_SLUG", "ceckert-test");
    try {
      let mode: "held" | "permitted" = "held";
      const logs: string[] = [];
      const processGate = {
        status: vi.fn(async () => ({
          version: 1 as const,
          podUid: "target-pod",
          role: "target" as const,
          mode,
          phase: mode === "held" ? "held" as const : "running" as const,
          migrationId: "mig-builder",
          slug: "ceckert-test",
          targetPodUid: "target-pod",
        })),
      } as unknown as SurgeOpenClawProcessSupervisorClient;
      const admission = createConfiguredBuilderReconcileAdmission({
        processGate,
        log: (message) => logs.push(message),
      });
      const getMountObserved = vi.fn(() => [] as string[]);
      const getEvictObserved = vi.fn(() => ["stale"]);
      const readDesired = vi.fn(async () => ["ceckert-test"]);
      const add = vi.fn();
      const mount = vi.fn();
      const workspace = vi.fn();
      const evict = vi.fn();
      const start = vi.fn(() => startReconcileLoop({
        gatewayId: "builder",
        intervalMs: 10,
        canReconcile: admission,
        getMountObserved,
        getEvictObserved,
        readDesired,
        ensureSlug: async () => {
          add();
          mount();
          workspace();
          return "mounted" as const;
        },
        unmountSlug: async () => {
          evict();
          return "drained" as const;
        },
        log: (message) => logs.push(message),
      }));
      const stop = startAfterSurgeReadiness({
        released: async () => true,
        start,
        log: (message) => logs.push(message),
      });

      await vi.advanceTimersByTimeAsync(10);

      expect(start).toHaveBeenCalledOnce();
      expect(getMountObserved).not.toHaveBeenCalled();
      expect(getEvictObserved).not.toHaveBeenCalled();
      expect(readDesired).not.toHaveBeenCalled();
      expect(add).not.toHaveBeenCalled();
      expect(mount).not.toHaveBeenCalled();
      expect(workspace).not.toHaveBeenCalled();
      expect(evict).not.toHaveBeenCalled();
      expect(logs).toContain(
        "[surge-handoff] reconcile paused while configured Builder process gate is target/held",
      );

      mode = "permitted";
      await vi.advanceTimersByTimeAsync(10);

      expect(add).toHaveBeenCalledOnce();
      expect(mount).toHaveBeenCalledOnce();
      expect(workspace).toHaveBeenCalledOnce();
      expect(evict).toHaveBeenCalledOnce();
      stop();
    } finally {
      vi.unstubAllEnvs();
      vi.useRealTimers();
    }
  });

  it("fails closed without repeating a Builder process-gate status error", async () => {
    const logs: string[] = [];
    const admission = createConfiguredBuilderReconcileAdmission({
      processGate: {
        status: vi.fn(async () => {
          throw new Error("supervisor unavailable");
        }),
      } as unknown as SurgeOpenClawProcessSupervisorClient,
      log: (message) => logs.push(message),
    });

    await expect(admission()).resolves.toBe(false);
    await expect(admission()).resolves.toBe(false);

    expect(logs).toEqual([
      "[surge-handoff] reconcile paused while configured Builder process gate has status error: supervisor unavailable",
    ]);
  });

  it("waits for an active Builder mount after holding the target reservation", async () => {
    vi.stubEnv("GATEWAY_BUILDER_SLUG", "ceckert-test");
    vi.stubEnv("POD_UID", "target-pod");
    try {
      let releaseDrain: (() => void) | undefined;
      const events: string[] = [];
      const processGate = {
        hydrate: vi.fn(async () => {
          events.push("hydrate");
          return {
            version: 1 as const,
            podUid: "target-pod",
            role: "target" as const,
            mode: "held" as const,
            phase: "held" as const,
            migrationId: "mig-builder",
            slug: "ceckert-test",
            targetPodUid: "target-pod",
          };
        }),
      } as unknown as SurgeOpenClawProcessSupervisorClient;
      const wiring = createBuilderSurgeGateWiring({
        adapter: {
          isBuilderGateway: () => true,
          isConfiguredBuilderCustomer: (slug: string) => slug === "ceckert-test",
          configuredBuilderOverlayPresent: () => true,
        } as CustomerLifecycleAdapter,
        processGate,
        surgeReadiness: {} as SurgeReadinessGate,
        waitForGatewayReady: async () => undefined,
        log: () => undefined,
        waitForActiveProvisioningDrain: () => new Promise<void>((resolve) => {
          events.push("wait-for-mount");
          releaseDrain = resolve;
        }),
      });

      let settled = false;
      const reserved = wiring.reserveSurgeTarget({
        migrationId: "mig-builder",
        slug: "ceckert-test",
      }).then(() => {
        settled = true;
      });
      await Promise.resolve();

      expect(events).toEqual(["hydrate", "wait-for-mount"]);
      expect(settled).toBe(false);

      releaseDrain?.();
      await reserved;

      expect(settled).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("observed split — evict keys off raw presence, mount off completion", () => {
  it("evict-observed = RAW on-disk dirs (not coach-wired), so a partial/junk dir is drainable", () => {
    const a = mkObservedAdapter({
      listLocalCustomerDirs: () => ["alice", "bob", "partial"], // partial: dir present, no coach
      listLocalCustomerSlugs: () => ["alice", "bob"], // coach-wired subset
    });
    expect(getEvictObservedSlugs(a)).toEqual(["alice", "bob", "partial"]);
  });

  it("evict-observed skips a migrating-in slug (no draining a fresh import pre-cutover)", () => {
    const a = mkObservedAdapter({
      listLocalCustomerDirs: () => ["alice", "incoming"],
      customerMigratingIn: (s) => s === "incoming",
    });
    expect(getEvictObservedSlugs(a)).toEqual(["alice"]); // incoming guarded from eviction
  });

  it("evict-observed keeps a restored import guarded after the customer dir is replaced", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-mig-pin-"));
    tmpDirs.push(root);
    fs.mkdirSync(path.join(root, "incoming"));
    writeMigratingInPin(root, "incoming");
    fs.rmSync(path.join(root, "incoming"), { recursive: true, force: true });
    fs.mkdirSync(path.join(root, "incoming"));
    const a = mkObservedAdapter({
      listLocalCustomerDirs: () => listLocalCustomerDirs(root),
      customerMigratingIn: (s) => isMigratingInPinned(root, s, 5 * 60_000),
    });

    expect(getEvictObservedSlugs(a)).toEqual([]);
  });

  it("evict-observed retains only the admitted Builder overlay", () => {
    const a = mkObservedAdapter({
      isBuilderGateway: () => true,
      isConfiguredBuilderCustomer: (slug) => slug === "builder",
      configuredBuilderOverlayPresent: () => false,
      listLocalCustomerDirs: () => ["builder", "foreign", "partial"],
    });

    expect(getEvictObservedSlugs(a)).toEqual(["foreign", "partial"]);
  });

  it("mount-observed excludes a coach-wired-but-unmarked slug (the post-config wedge)", () => {
    const a = mkObservedAdapter({
      listLocalCustomerSlugs: () => ["alice", "bob"], // both coach-wired
      customerMountMarked: (s) => s === "alice", // only alice fully mounted
    });
    expect(getMountObservedSlugs(a)).toEqual(["alice"]); // bob still in toMount
  });

  it("mount-observed excludes marked customers missing runtime or durable workspace state", () => {
    const a = mkObservedAdapter({
      listLocalCustomerSlugs: () => ["healthy", "no-runtime", "no-git", "no-origin"],
      customerMountMarked: () => true,
      hasCustomerAgentRuntime: (slug) => slug !== "no-runtime",
      hasWorkspaceGitDir: (slug) => slug !== "no-git",
      hasGitRemote: (slug) => slug !== "no-origin",
    });

    expect(getMountObservedSlugs(a)).toEqual(["healthy"]);
  });

  it("mount-observed requires a readable Builder overlay even when runtime directories exist", () => {
    const a = mkObservedAdapter({
      isBuilderGateway: () => true,
      isConfiguredBuilderCustomer: () => true,
      listLocalCustomerSlugs: () => ["discord-builder"],
      customerMountMarked: () => true,
      configuredBuilderOverlayPresent: () => false,
      hasCustomerAgentRuntime: () => true,
      hasWorkspaceGitDir: () => true,
      hasGitRemote: () => true,
    });

    expect(getMountObservedSlugs(a)).toEqual([]);
  });

  it("mount-observed counts every coach-wired slug when no marker probe exists", () => {
    const a = mkObservedAdapter({
      listLocalCustomerSlugs: () => ["alice"],
      // no customerMountMarked
    });
    expect(getMountObservedSlugs(a)).toEqual(["alice"]);
  });

  it("mount-observed is PIN-BLIND: a migrated coach-wired+marked slug is observed despite its pin", () => {
    // Regression guard: the migrating-in pin must NOT suppress mount-observed (or the
    // post-cutover target would re-ensure every tick for the pin's TTL). The pin only
    // gates eviction.
    const a = mkObservedAdapter({
      listLocalCustomerSlugs: () => ["migrated"],
      customerMountMarked: () => true,
      customerMigratingIn: () => true,
    });
    expect(getMountObservedSlugs(a)).toEqual(["migrated"]);
  });
});

describe("evictLocalCustomer — complete local teardown", () => {
  function adapter(overrides: Partial<CustomerLifecycleAdapter>): CustomerLifecycleAdapter {
    return {
      log: vi.fn(),
      uidForSlug: vi.fn(async () => null),
      applyRemoveCustomerConfigPatch: vi.fn(async () => undefined),
      hasCustomerDir: vi.fn(() => true),
      deleteCustomerDir: vi.fn(async () => undefined),
      ...overrides,
    } as CustomerLifecycleAdapter;
  }

  it("prefers the imported-customer teardown for an unassigned slug", async () => {
    const removeImportedCustomerBySlug = vi.fn(async () => ({
      wasMounted: true,
      steps: ["config-patch-remove", "delete-dir"] as const,
    }));
    const onUnmounted = vi.fn();
    const stampMounted = vi.fn(async () => undefined);
    const onLocalStateRemoved = vi.fn();
    const a = adapter({ removeImportedCustomerBySlug, onUnmounted });

    await expect(evictLocalCustomer({
      adapter: a,
      slug: "departed",
      stampMounted,
      onLocalStateRemoved,
    })).resolves.toBe("deleted-user");

    expect(removeImportedCustomerBySlug).toHaveBeenCalledWith("departed", undefined, undefined);
    expect(a.applyRemoveCustomerConfigPatch).not.toHaveBeenCalled();
    expect(a.deleteCustomerDir).not.toHaveBeenCalled();
    expect(onUnmounted).toHaveBeenCalledWith("departed");
    expect(stampMounted).not.toHaveBeenCalled();
    expect(onLocalStateRemoved).toHaveBeenCalledWith("departed");
  });

  it("preserves the manual fallback for adapters without imported-customer teardown", async () => {
    const onUnmounted = vi.fn();
    const onLocalStateRemoved = vi.fn();
    const a = adapter({ onUnmounted });

    await expect(evictLocalCustomer({
      adapter: a,
      slug: "departed",
      stampMounted: vi.fn(async () => undefined),
      onLocalStateRemoved,
    })).resolves.toBe("deleted-user");

    expect(a.applyRemoveCustomerConfigPatch).toHaveBeenCalledWith(
      "departed",
      "octogee-departed-coach",
      undefined,
      undefined,
    );
    expect(a.deleteCustomerDir).toHaveBeenCalledWith("departed");
    expect(onUnmounted).toHaveBeenCalledWith("departed");
    expect(onLocalStateRemoved).toHaveBeenCalledWith("departed");
  });

  it("clears runtime and fingerprint bookkeeping when teardown races with another cleanup", async () => {
    const onUnmounted = vi.fn();
    const onLocalStateRemoved = vi.fn();
    const a = adapter({
      removeImportedCustomerBySlug: vi.fn(async () => ({ wasMounted: false, steps: [] })),
      onUnmounted,
    });

    await expect(evictLocalCustomer({
      adapter: a,
      slug: "departed",
      stampMounted: vi.fn(async () => undefined),
      onLocalStateRemoved,
    })).resolves.toBe("noop");

    expect(onUnmounted).toHaveBeenCalledWith("departed");
    expect(onLocalStateRemoved).toHaveBeenCalledWith("departed");
  });

  it("keeps assigned-customer mounted state and local bookkeeping cleanup", async () => {
    const stampMounted = vi.fn(async () => undefined);
    const onLocalStateRemoved = vi.fn();
    const a = adapter({
      uidForSlug: vi.fn(async () => "uid-alice"),
      loadUserSnapshot: vi.fn(async () => ({
        uid: "uid-alice",
        slug: "alice",
        tier: "trial",
        gatewayId: "bender",
        status: "complete",
        agentIds: ["octogee-alice-coach"],
        repoUrl: "",
        mattermostUserId: null,
        greetingPosted: false,
        channels: [],
        ownerName: "Alice",
        projects: [],
      })),
    });

    await expect(evictLocalCustomer({
      adapter: a,
      slug: "alice",
      stampMounted,
      onLocalStateRemoved,
    })).resolves.toBe("drained");

    expect(stampMounted).toHaveBeenCalledWith("uid-alice", false);
    expect(onLocalStateRemoved).toHaveBeenCalledWith("alice");
  });

  it("retains local state and invalidates mount completion when re-admitted after config removal", async () => {
    const onRetainedAfterConfigRemoval = vi.fn();
    const onLocalStateRemoved = vi.fn();
    const a = adapter({
      removeImportedCustomerBySlug: vi.fn(async () => ({
        wasMounted: true,
        steps: ["config-patch-remove"] as const,
        retained: true,
      })),
    });

    await expect(evictLocalCustomer({
      adapter: a,
      slug: "alice",
      currentEvictionBatch: vi.fn(async () => []),
      onRetainedAfterConfigRemoval,
      stampMounted: vi.fn(async () => undefined),
      onLocalStateRemoved,
    })).resolves.toBe("noop");

    expect(onRetainedAfterConfigRemoval).toHaveBeenCalledWith("alice");
    expect(onLocalStateRemoved).not.toHaveBeenCalled();
  });

  it("retains a matching Builder overlay before the missing-user fallback can mutate it", async () => {
    const onRetainedAfterConfigRemoval = vi.fn();
    const onLocalStateRemoved = vi.fn();
    const onUnmounted = vi.fn();
    const clearMountMarker = vi.fn();
    const clearCustomerMigratingIn = vi.fn();
    const a = adapter({
      isBuilderGateway: () => true,
      isConfiguredBuilderCustomer: (slug) => slug === "builder",
      configuredBuilderOverlayPresent: (slug) => slug === "builder",
      onUnmounted,
      clearMountMarker,
      clearCustomerMigratingIn,
    });

    await expect(evictLocalCustomer({
      adapter: a,
      slug: "builder",
      onRetainedAfterConfigRemoval,
      stampMounted: vi.fn(async () => undefined),
      onLocalStateRemoved,
    })).resolves.toBe("noop");

    expect(a.uidForSlug).not.toHaveBeenCalled();
    expect(a.applyRemoveCustomerConfigPatch).not.toHaveBeenCalled();
    expect(a.deleteCustomerDir).not.toHaveBeenCalled();
    expect(clearMountMarker).toHaveBeenCalledWith("builder");
    expect(clearCustomerMigratingIn).toHaveBeenCalledWith("builder");
    expect(onUnmounted).toHaveBeenCalledWith("builder");
    expect(onRetainedAfterConfigRemoval).toHaveBeenCalledWith("builder");
    expect(onLocalStateRemoved).not.toHaveBeenCalled();
  });

  it("fails closed for a matching Builder owner with an unreadable overlay", async () => {
    const a = adapter({
      isBuilderGateway: () => true,
      isConfiguredBuilderCustomer: () => true,
      configuredBuilderOverlayPresent: () => false,
    });

    await expect(evictLocalCustomer({
      adapter: a,
      slug: "builder",
      stampMounted: vi.fn(async () => undefined),
      onLocalStateRemoved: vi.fn(),
    })).rejects.toThrow(/configured Builder system-config overlay is unavailable/);

    expect(a.uidForSlug).not.toHaveBeenCalled();
    expect(a.applyRemoveCustomerConfigPatch).not.toHaveBeenCalled();
    expect(a.deleteCustomerDir).not.toHaveBeenCalled();
  });
});

describe("cancelRemovedEviction", () => {
  it("invalidates a re-admitted Builder only when its config-removal marker existed", () => {
    const invalidate = vi.fn();
    const removed = {
      cancelPendingEviction: vi.fn(() => true),
    } as unknown as CustomerLifecycleAdapter;
    const untouched = {
      cancelPendingEviction: vi.fn(() => false),
    } as unknown as CustomerLifecycleAdapter;

    expect(cancelRemovedEviction(removed, "b", invalidate)).toBe(true);
    expect(cancelRemovedEviction(untouched, "c", invalidate)).toBe(false);
    expect(invalidate).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalledWith("b");
  });
});

describe("evictLocalCustomerIfStillUndesired", () => {
  it("does not run stale cleanup after the Builder is re-admitted", async () => {
    const evict = vi.fn(async () => "drained" as const);

    await expect(evictLocalCustomerIfStillUndesired({
      slug: "alice",
      evictionBatch: ["alice"],
      readDesired: vi.fn(async () => ["alice"]),
      evict,
    })).resolves.toBe("noop");

    expect(evict).not.toHaveBeenCalled();
  });

  it("runs cleanup once when the latest desired roster still excludes the Builder", async () => {
    const evict = vi.fn(async () => "drained" as const);

    await expect(evictLocalCustomerIfStillUndesired({
      slug: "alice",
      evictionBatch: ["alice"],
      readDesired: vi.fn(async () => ["bob"]),
      evict,
    })).resolves.toBe("drained");

    expect(evict).toHaveBeenCalledWith(["alice"], expect.any(Function));
  });

  it("filters re-admitted Builders from the shared config-removal batch", async () => {
    const evict = vi.fn(async () => "drained" as const);

    await expect(evictLocalCustomerIfStillUndesired({
      slug: "alice",
      evictionBatch: ["alice", "bob"],
      readDesired: vi.fn(async () => ["bob"]),
      evict,
    })).resolves.toBe("drained");

    expect(evict).toHaveBeenCalledWith(["alice"], expect.any(Function));
  });
});

describe("in-pod gateway heartbeat", () => {
  it("waits on the lightweight health endpoint instead of retrying authenticated RPC", async () => {
    const probeHealthz = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const sleep = vi.fn(async () => undefined);

    await expect(waitForOpenClawHealthz({ probeHealthz, sleep })).resolves.toBeUndefined();

    expect(probeHealthz).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 1_000);
    expect(sleep).toHaveBeenNthCalledWith(2, 1_000);
  });

  it("uses lightweight local health without opening an authenticated RPC on every probe", async () => {
    const probeHealthz = vi.fn(async () => true);

    await expect(probeSurgeReadiness({
      runtimeStatus: "ready",
      handoffReleased: true,
      probeHealthz,
    })).resolves.toEqual({ ready: true, openclawUp: true });
    expect(probeHealthz).toHaveBeenCalledOnce();

    probeHealthz.mockResolvedValueOnce(false);
    await expect(probeSurgeReadiness({
      runtimeStatus: "ready",
      handoffReleased: true,
      probeHealthz,
    })).resolves.toEqual({ ready: false, openclawUp: false });

    probeHealthz.mockClear();
    await expect(probeSurgeReadiness({
      runtimeStatus: "booting",
      handoffReleased: true,
      probeHealthz,
    })).resolves.toEqual({ ready: false, openclawUp: false });
    expect(probeHealthz).not.toHaveBeenCalled();
  });

  it("keeps readiness open while a Builder is actively provisioning", async () => {
    const probeHealthz = vi.fn(async () => false);

    await expect(probeSurgeReadiness({
      runtimeStatus: "ready",
      handoffReleased: true,
      provisioning: true,
      probeHealthz,
    })).resolves.toEqual({ ready: true, openclawUp: true });

    expect(probeHealthz).not.toHaveBeenCalled();
  });

  it("reports the OpenClaw runtime version through the signed fleet state endpoint", () => {
    expect(
      buildFleetStateResponse({
        status: "ready",
        gatewayId: "default",
        podUid: "pod-uid-1",
        version: "sha-1",
        openclawVersion: "2026.7.1",
        startedAt: 42,
        customers: ["alice"],
        migratingIn: [],
      }),
    ).toMatchObject({ openclawVersion: "2026.7.1", podUid: "pod-uid-1", customers: ["alice"] });
  });

  it("keeps the unauthenticated probe body free of tenant identity", () => {
    const probe = buildFleetHealthResponse({
      status: "ready",
      podUid: "pod-uid-1",
      startedAt: 42,
    });

    expect(probe).toEqual({ status: "ready", podUid: "pod-uid-1", startedAt: 42 });
  });

  it("keys the heartbeat snapshot by the bare gateway id (GATEWAY-SIMPLE-ROLL-SPEC)", () => {
    const snap = buildFleetHeartbeatSnapshot({
      gatewayId: "default",
      status: "ready",
      version: "sha-1",
      openclawVersion: "2026.7.1",
      mountedCustomers: ["alice"],
      internalUrl: "http://octogee-gateway-default.ns.svc.cluster.local:18789",
      startedAt: 42,
    });
    expect(snap).toMatchObject({ gatewayId: "default", status: "ready" });
    expect(snap).not.toHaveProperty("revisionId");
    expect(snap.openclawVersion).toBe("2026.7.1");
  });

  it("refuses an empty gateway id so a misconfigured pod cannot write anonymous telemetry", () => {
    expect(() =>
      buildFleetHeartbeatSnapshot({
        gatewayId: "",
        status: "booting",
        version: "v",
        openclawVersion: "v",
        mountedCustomers: [],
        internalUrl: "http://gw",
        startedAt: 1,
      }),
    ).toThrow("gatewayId is required");
  });

  it("points the heartbeat internalUrl at the stable bare-id Service", () => {
    expect(gatewayServiceName({ gatewayId: "default" })).toBe("octogee-gateway-default");
    expect(() => gatewayServiceName({ gatewayId: "" })).toThrow("gatewayId is required");
  });
});

describe("resolveFleetCapabilities — observability vs provisioning seam", () => {
  it("cattle (platformState + reportState + db): reports AND provisions", () => {
    expect(
      resolveFleetCapabilities({ platformState: true, reportState: true, hasDb: true }),
    ).toEqual({ reportMounted: true, provision: true, needsStateDeps: true });
  });

  it("operator (db-less: platformState=false, reportState=false, no db): no capabilities — Cowboy owns reporting + eviction", () => {
    expect(
      resolveFleetCapabilities({ platformState: false, reportState: false, hasDb: false }),
    ).toEqual({ reportMounted: false, provision: false, needsStateDeps: false });
  });

  it("report-only with db (platformState=false, reportState=true, db): reports, does NOT provision", () => {
    expect(
      resolveFleetCapabilities({ platformState: false, reportState: true, hasDb: true }),
    ).toEqual({ reportMounted: true, provision: false, needsStateDeps: true });
  });

  it("no db: neither reports nor provisions, regardless of flags", () => {
    expect(
      resolveFleetCapabilities({ platformState: true, reportState: true, hasDb: false }),
    ).toEqual({ reportMounted: false, provision: false, needsStateDeps: false });
  });

  it("the two axes are independent: provision without reporting", () => {
    expect(
      resolveFleetCapabilities({ platformState: true, reportState: false, hasDb: true }),
    ).toEqual({ reportMounted: false, provision: true, needsStateDeps: false });
  });

  it("brokered db-less gateway: provisions local mounts without Firestore state deps", () => {
    expect(
      resolveFleetCapabilities({
        platformState: true,
        reportState: false,
        localReconcile: true,
        hasDb: false,
        hasBrokeredRoster: true,
      }),
    ).toEqual({ reportMounted: false, provision: true, needsStateDeps: false });
  });

  it("brokered Builder gateway: provisions local mounts while platformState stays false", () => {
    expect(
      resolveFleetCapabilities({
        platformState: false,
        reportState: false,
        localReconcile: true,
        hasDb: false,
        hasBrokeredRoster: true,
      }),
    ).toEqual({ reportMounted: false, provision: true, needsStateDeps: false });
  });
});
