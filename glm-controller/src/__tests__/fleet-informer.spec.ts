import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Firestore, QueryDocumentSnapshot } from "firebase-admin/firestore";
import { readAssignedSlugsForGateway } from "@octogee/core/assigned-roster";
import {
  assignedSlugsFromUserMirror,
  createFleetInformer,
  FLEET_INFORMER_REATTACH_MS_DEFAULT,
  type FleetInformer,
} from "../fleet-informer.js";

type FakeDoc = QueryDocumentSnapshot;

interface FakeSnapshot {
  docs: FakeDoc[];
}

interface OwnedListener {
  onNext: (snap: FakeSnapshot) => void;
  onError: (err: Error) => void;
  unsubscribed: boolean;
}

function doc(id: string, data: Record<string, unknown>): FakeDoc {
  return { id, data: () => data } as unknown as QueryDocumentSnapshot;
}

function fakeOwnedListenerDb() {
  const users: OwnedListener[] = [];
  const assignments: OwnedListener[] = [];
  const selects: string[][] = [];
  const attach = (bucket: OwnedListener[]) =>
    (onNext: (snap: FakeSnapshot) => void, onError: (err: Error) => void) => {
      const listener: OwnedListener = { onNext, onError, unsubscribed: false };
      bucket.push(listener);
      return () => {
        listener.unsubscribed = true;
      };
    };
  const db = {
    collection: (name: string) => {
      if (name !== "users") throw new Error(`unexpected collection ${name}`);
      return {
        onSnapshot: attach(users),
        select: (...fields: string[]) => {
          selects.push(fields);
          return { onSnapshot: attach(users) };
        },
      };
    },
    collectionGroup: (name: string) => {
      if (name !== "assignments") throw new Error(`unexpected collection group ${name}`);
      return { onSnapshot: attach(assignments) };
    },
  } as unknown as Firestore;
  return { db, users, assignments, selects };
}

function lastListener(bucket: OwnedListener[]): OwnedListener {
  const listener = bucket.at(-1);
  if (!listener) throw new Error("no listener attached");
  return listener;
}

describe("fleet informer — owned listeners (users + assignments)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("attaches a users listener without a Firestore projection", () => {
    const { db, selects, users } = fakeOwnedListenerDb();
    const informer = createFleetInformer({ db, log: vi.fn() });

    expect(users).toHaveLength(1);
    expect(selects).toEqual([]);
    informer.stop();
  });

  it("serves null before the initial users snapshot, docs sorted by id after", () => {
    const { db, users } = fakeOwnedListenerDb();
    const informer = createFleetInformer({ db, log: vi.fn() });

    expect(informer.users()).toBeNull();

    lastListener(users).onNext({
      docs: [doc("uid-b", { username: "bee" }), doc("uid-a", { username: "aye" })],
    });

    expect(informer.users()?.map((d) => d.id)).toEqual(["uid-a", "uid-b"]);
    expect(informer.users()?.[0]?.data()).toEqual({ username: "aye" });
    informer.stop();
  });

  it("rebuilds the users mirror from each full snapshot — removed docs disappear", () => {
    const { db, users } = fakeOwnedListenerDb();
    const informer = createFleetInformer({ db, log: vi.fn() });

    lastListener(users).onNext({
      docs: [doc("uid-a", { username: "aye" }), doc("uid-b", { username: "bee" })],
    });
    lastListener(users).onNext({ docs: [doc("uid-b", { username: "bee" })] });

    expect(informer.users()?.map((d) => d.id)).toEqual(["uid-b"]);
    informer.stop();
  });

  it("mirrors the assignments collection group", () => {
    const { db, assignments } = fakeOwnedListenerDb();
    const informer = createFleetInformer({ db, log: vi.fn() });

    expect(informer.assignments()).toBeNull();
    lastListener(assignments).onNext({
      docs: [doc("uid-a", { uid: "uid-a", slug: "alice", gatewayId: "shared-blue", state: "serving" })],
    });

    expect(informer.assignments()?.map((d) => d.data().slug)).toEqual(["alice"]);
    informer.stop();
  });

  it("marks the users mirror stale on listener error and re-attaches after the delay", () => {
    const { db, users } = fakeOwnedListenerDb();
    const log = vi.fn();
    const informer = createFleetInformer({ db, log });

    lastListener(users).onNext({ docs: [doc("uid-a", { username: "aye" })] });
    expect(informer.users()).not.toBeNull();

    lastListener(users).onError(new Error("listen stream broke"));
    expect(informer.users()).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("listen stream broke"));

    expect(users).toHaveLength(1);
    vi.advanceTimersByTime(FLEET_INFORMER_REATTACH_MS_DEFAULT);
    expect(users).toHaveLength(2);

    lastListener(users).onNext({ docs: [doc("uid-b", { username: "bee" })] });
    expect(informer.users()?.map((d) => d.id)).toEqual(["uid-b"]);
    informer.stop();
  });

  it("logs the listener error even when the mirror was never fresh", () => {
    const { db, users } = fakeOwnedListenerDb();
    const log = vi.fn();
    const informer = createFleetInformer({ db, log });

    lastListener(users).onError(new Error("PERMISSION_DENIED: listen rejected"));
    vi.advanceTimersByTime(FLEET_INFORMER_REATTACH_MS_DEFAULT);

    expect(log).toHaveBeenCalledWith(expect.stringContaining("PERMISSION_DENIED"));
    informer.stop();
  });

  it("schedules exactly one re-attach no matter how many errors a dead listener reports", () => {
    const { db, users } = fakeOwnedListenerDb();
    const informer = createFleetInformer({ db, log: vi.fn() });

    lastListener(users).onError(new Error("first"));
    lastListener(users).onError(new Error("second"));

    vi.advanceTimersByTime(FLEET_INFORMER_REATTACH_MS_DEFAULT * 2);

    expect(users).toHaveLength(2);
    informer.stop();
  });

  it("honors a configured re-attach delay", () => {
    const { db, users } = fakeOwnedListenerDb();
    const informer = createFleetInformer({ db, log: vi.fn(), reattachMs: 5_000 });

    lastListener(users).onError(new Error("boom"));
    vi.advanceTimersByTime(4_999);
    expect(users).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(users).toHaveLength(2);
    informer.stop();
  });

  it("stop() unsubscribes owned listeners and cancels pending re-attach timers", () => {
    const { db, users, assignments } = fakeOwnedListenerDb();
    const informer = createFleetInformer({ db, log: vi.fn() });

    lastListener(users).onError(new Error("boom"));
    informer.stop();

    expect(lastListener(assignments).unsubscribed).toBe(true);
    vi.advanceTimersByTime(FLEET_INFORMER_REATTACH_MS_DEFAULT * 2);
    expect(users).toHaveLength(1);
  });
});

describe("fleet informer — reconciler-fed mirrors (gateways + glmGateways)", () => {
  function fedInformer(): FleetInformer {
    const { db } = fakeOwnedListenerDb();
    return createFleetInformer({ db, log: vi.fn() });
  }

  it("serves null until the first reset delivery arrives", () => {
    const informer = fedInformer();
    expect(informer.gateways()).toBeNull();
    expect(informer.glmGateways()).toBeNull();

    informer.ingestGlmGateways(
      [{ type: "added", doc: doc("shared-blue", { docKind: "runtime" }) }],
      { reset: true },
    );

    expect(informer.glmGateways()?.map((d) => d.id)).toEqual(["shared-blue"]);
    expect(informer.gateways()).toBeNull();
    informer.stop();
  });

  it("applies added/modified/removed docChanges as deltas", () => {
    const informer = fedInformer();
    informer.ingestGateways(
      [
        { type: "added", doc: doc("shared-blue", { desiredStatus: "running" }) },
        { type: "added", doc: doc("bender", { desiredStatus: "running" }) },
      ],
      { reset: true },
    );

    informer.ingestGateways([
      { type: "modified", doc: doc("bender", { desiredStatus: "retired" }) },
      { type: "removed", doc: doc("shared-blue", {}) },
    ]);

    expect(informer.gateways()?.map((d) => [d.id, d.data().desiredStatus])).toEqual([
      ["bender", "retired"],
    ]);
    informer.stop();
  });

  it("a reset delivery drops docs deleted while the listener was down", () => {
    const informer = fedInformer();
    informer.ingestGlmGateways(
      [
        { type: "added", doc: doc("shared-blue", { docKind: "runtime" }) },
        { type: "added", doc: doc("bender", { docKind: "runtime" }) },
      ],
      { reset: true },
    );
    informer.markGlmGatewaysStale("stream error");
    expect(informer.glmGateways()).toBeNull();

    informer.ingestGlmGateways(
      [{ type: "added", doc: doc("shared-blue", { docKind: "runtime" }) }],
      { reset: true },
    );

    expect(informer.glmGateways()?.map((d) => d.id)).toEqual(["shared-blue"]);
    informer.stop();
  });

  it("delta ingestion after a stale mark does not resurrect freshness", () => {
    const informer = fedInformer();
    informer.ingestGateways(
      [{ type: "added", doc: doc("shared-blue", {}) }],
      { reset: true },
    );
    informer.markGatewaysStale("stream error");

    informer.ingestGateways([{ type: "added", doc: doc("bender", {}) }]);

    expect(informer.gateways()).toBeNull();
    informer.stop();
  });

  it("logs staleness transitions once, not per read", () => {
    const { db } = fakeOwnedListenerDb();
    const log = vi.fn();
    const informer = createFleetInformer({ db, log });
    informer.ingestGateways([], { reset: true });

    informer.markGatewaysStale("stream error");
    informer.markGatewaysStale("stream error");
    informer.gateways();
    informer.gateways();

    const staleLogs = log.mock.calls.filter(([msg]) =>
      String(msg).includes("gateways mirror stale"),
    );
    expect(staleLogs).toHaveLength(1);
    informer.stop();
  });
});

describe("assignedSlugsFromUserMirror", () => {
  const userDocs = [
    doc("uid-a", {
      username: "alice",
      provisioning: { openclaw: { gatewayId: "shared-blue", slug: "alice" } },
    }),
    doc("uid-b", {
      username: "bob-fallback",
      provisioning: { openclaw: { gatewayId: "shared-blue" } },
    }),
    doc("uid-c", {
      username: "carol",
      provisioning: { openclaw: { gatewayId: "bender", slug: "carol" } },
    }),
    doc("uid-d", { username: "dave" }),
  ];

  it("resolves the assigned slugs for a gateway from mirror docs", () => {
    expect(assignedSlugsFromUserMirror(userDocs, "shared-blue").sort()).toEqual([
      "alice",
      "bob-fallback",
    ]);
    expect(assignedSlugsFromUserMirror(userDocs, "bender")).toEqual(["carol"]);
    expect(assignedSlugsFromUserMirror(userDocs, "ghost")).toEqual([]);
  });

  it("matches readAssignedSlugsForGateway on identical data", async () => {
    const queryDb = {
      collection: (name: string) => {
        if (name !== "users") throw new Error(`unexpected collection ${name}`);
        return {
          where: (field: string, op: string, value: unknown) => {
            expect(field).toBe("provisioning.openclaw.gatewayId");
            expect(op).toBe("==");
            return {
              get: async () => ({
                docs: userDocs.filter((d) => {
                  const provisioning = d.data().provisioning as
                    | Record<string, unknown>
                    | undefined;
                  const openclaw = provisioning?.openclaw as
                    | Record<string, unknown>
                    | undefined;
                  return openclaw?.gatewayId === value;
                }),
              }),
            };
          },
        };
      },
    };
    const direct = await readAssignedSlugsForGateway(
      queryDb as never,
      "shared-blue",
    );
    expect(assignedSlugsFromUserMirror(userDocs, "shared-blue").sort()).toEqual(
      [...direct].sort(),
    );
  });
});
