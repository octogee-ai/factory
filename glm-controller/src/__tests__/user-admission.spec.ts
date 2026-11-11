import { describe, expect, it, vi } from "vitest";
import { FenceMismatchError, type PlatformStateStore } from "@octogee/core/platform-state";
import {
  placementPassOptions,
  reconcileUserAdmissions,
  type UserAdmissionRequest,
  type UserAdmissionSource,
} from "../user-admission.js";

const alice: UserAdmissionRequest = { uid: "alice", slug: "alice", persona: { vibe: "calm" } };
const bob: UserAdmissionRequest = { uid: "bob", slug: "bob", persona: null };

function alreadyAdmitted(uid: string): FenceMismatchError {
  return new FenceMismatchError(
    { aggregate: "builders", key: uid },
    "absent",
    { provisioningStatus: null },
    { provisioningStatus: "in_progress" },
  );
}

function slugConflict(uid: string): FenceMismatchError {
  return new FenceMismatchError({ aggregate: "builders", key: uid }, "present", { slug: uid }, { slug: "someone-else" });
}

function harness(requests: readonly UserAdmissionRequest[]) {
  const pending = new Map(requests.map((request) => [request.uid, request]));
  const admit = vi.fn(async (_uid: string, _input: unknown): Promise<void> => undefined);
  const log = vi.fn();
  const source = {
    listPending: vi.fn(async (): Promise<readonly UserAdmissionRequest[]> => [...pending.values()]),
    markAdmitted: vi.fn(async (uid: string): Promise<void> => {
      pending.delete(uid);
    }),
    subscribe: vi.fn((_wake: () => void) => () => undefined),
  } satisfies UserAdmissionSource;
  const store = { users: { records: { admit } } } as unknown as PlatformStateStore;
  return { admit, log, pending, source, deps: { store, source, log } };
}

describe("reconcileUserAdmissions", () => {
  it("admits each pending user with a server-time start, then applies the recorded decision", async () => {
    const run = harness([alice, bob]);

    await expect(reconcileUserAdmissions(run.deps)).resolves.toEqual({
      admitted: ["alice", "bob"],
      duplicates: [],
      failed: [],
    });

    expect(run.admit.mock.calls).toEqual([
      ["alice", { slug: "alice", persona: { vibe: "calm" }, provisioningStartedAt: { serverNow: true } }],
      ["bob", { slug: "bob", persona: null, provisioningStartedAt: { serverNow: true } }],
    ]);
    expect(run.source.markAdmitted.mock.calls).toEqual([["alice"], ["bob"]]);
    expect(run.pending.size).toBe(0);
  });

  it("treats an existing provisioning status as a duplicate delivery and still applies the decision", async () => {
    const run = harness([alice]);
    run.admit.mockRejectedValueOnce(alreadyAdmitted("alice"));

    await expect(reconcileUserAdmissions(run.deps)).resolves.toEqual({
      admitted: [],
      duplicates: ["alice"],
      failed: [],
    });

    expect(run.source.markAdmitted).toHaveBeenCalledWith("alice");
    expect(run.log).not.toHaveBeenCalledWith(expect.stringContaining("⚠"));
  });

  it("keeps a slug conflict pending and reports it", async () => {
    const run = harness([alice]);
    run.admit.mockRejectedValue(slugConflict("alice"));

    await expect(reconcileUserAdmissions(run.deps)).resolves.toEqual({
      admitted: [],
      duplicates: [],
      failed: ["alice"],
    });

    expect(run.source.markAdmitted).not.toHaveBeenCalled();
    expect(run.log).toHaveBeenCalledWith(expect.stringMatching(/⚠ could not admit alice: .*slug/u));
  });

  it("keeps a failed admission pending, continues with the next user, and retries on the next pass", async () => {
    const run = harness([alice, bob]);
    run.admit.mockRejectedValueOnce(new Error("store unavailable"));

    await expect(reconcileUserAdmissions(run.deps)).resolves.toEqual({
      admitted: ["bob"],
      duplicates: [],
      failed: ["alice"],
    });
    expect(run.log).toHaveBeenCalledWith(expect.stringContaining("⚠ could not admit alice: store unavailable"));
    expect([...run.pending.keys()]).toEqual(["alice"]);

    await expect(reconcileUserAdmissions(run.deps)).resolves.toEqual({
      admitted: ["alice"],
      duplicates: [],
      failed: [],
    });
    expect(run.pending.size).toBe(0);
  });

  it("converges through the fence when the apply step was interrupted after the admission committed", async () => {
    const run = harness([alice]);
    run.source.markAdmitted.mockRejectedValueOnce(new Error("firestore unavailable"));

    await expect(reconcileUserAdmissions(run.deps)).resolves.toEqual({
      admitted: [],
      duplicates: [],
      failed: ["alice"],
    });
    expect(run.log).toHaveBeenCalledWith(
      expect.stringContaining("⚠ admitted alice but could not apply the recorded decision: firestore unavailable"),
    );

    run.admit.mockRejectedValueOnce(alreadyAdmitted("alice"));
    await expect(reconcileUserAdmissions(run.deps)).resolves.toEqual({
      admitted: [],
      duplicates: ["alice"],
      failed: [],
    });
    expect(run.pending.size).toBe(0);
  });

  it("logs a source read failure instead of throwing", async () => {
    const run = harness([]);
    run.source.listPending.mockRejectedValueOnce(new Error("firestore unavailable"));

    await expect(reconcileUserAdmissions(run.deps)).resolves.toEqual({ admitted: [], duplicates: [], failed: [] });

    expect(run.log).toHaveBeenCalledWith(expect.stringContaining("⚠ could not read pending admissions: firestore unavailable"));
  });
});

describe("placementPassOptions", () => {
  it("admits before it places, in one pass", async () => {
    const run = harness([alice]);
    const order: string[] = [];
    run.admit.mockImplementation(async () => {
      order.push("admit");
    });
    const runPlacementPass = vi.fn(async () => {
      order.push("place");
    });

    await placementPassOptions({ admission: run.deps, runPlacementPass }).runPass("deps");

    expect(order).toEqual(["admit", "place"]);
    expect(runPlacementPass).toHaveBeenCalledWith("deps");
  });

  it("still places when pending admissions cannot be read", async () => {
    const run = harness([]);
    run.source.listPending.mockRejectedValueOnce(new Error("firestore unavailable"));
    const runPlacementPass = vi.fn(async () => undefined);

    await placementPassOptions({ admission: run.deps, runPlacementPass }).runPass("deps");

    expect(runPlacementPass).toHaveBeenCalledOnce();
  });

  it("wakes the loop from either subscription and unsubscribes both", () => {
    const run = harness([]);
    const stopAdmissions = vi.fn();
    const stopUnassigned = vi.fn();
    run.source.subscribe.mockReturnValue(stopAdmissions);
    let wakeUnassigned = (): void => undefined;
    const wake = vi.fn();

    const stop = placementPassOptions({
      admission: run.deps,
      runPlacementPass: async () => undefined,
      subscribeUnassigned: (notify) => {
        wakeUnassigned = notify;
        return stopUnassigned;
      },
    }).subscribe?.(wake);

    run.source.subscribe.mock.calls[0]?.[0]();
    wakeUnassigned();
    expect(wake).toHaveBeenCalledTimes(2);

    stop?.();
    expect(stopAdmissions).toHaveBeenCalledOnce();
    expect(stopUnassigned).toHaveBeenCalledOnce();
  });

  it("runs only the placement pass and its subscription when no admission source is installed", async () => {
    const runPlacementPass = vi.fn(async () => "placed");
    const subscribeUnassigned = vi.fn((_wake: () => void) => () => undefined);

    const options = placementPassOptions({ admission: null, runPlacementPass, subscribeUnassigned });

    await expect(options.runPass("deps")).resolves.toBe("placed");
    expect(options.subscribe).toBe(subscribeUnassigned);
  });
});
