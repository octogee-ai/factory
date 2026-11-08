import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Firestore, QueryDocumentSnapshot } from "firebase-admin/firestore";
import { readAssignedSlugsForGateway } from "@octogee/core/assigned-roster";
import {
  BackendFailureError,
  MalformedRecordError,
  type Stored,
  type WatchRecords,
} from "@octogee/core/platform-state";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import {
  assignedSlugsFromUserMirror,
  createFleetInformer,
  FLEET_INFORMER_REATTACH_MS_DEFAULT,
  type FleetInformer,
  type MirroredAggregate,
  type MirrorDelivery,
} from "../fleet-informer.js";
import { createScriptedWatches, storeWithScriptedWatches, type ScriptedWatches } from "./fixtures/scripted-watches.js";

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

function fakeUsersDb() {
  const users: OwnedListener[] = [];
  const selects: string[][] = [];
  const attach = (onNext: (snap: FakeSnapshot) => void, onError: (err: Error) => void) => {
    const listener: OwnedListener = { onNext, onError, unsubscribed: false };
    users.push(listener);
    return () => {
      listener.unsubscribed = true;
    };
  };
  const db = {
    collection: (name: string) => {
      if (name !== "users") throw new Error(`unexpected collection ${name}`);
      return {
        onSnapshot: attach,
        select: (...fields: string[]) => {
          selects.push(fields);
          return { onSnapshot: attach };
        },
      };
    },
  } as unknown as Firestore;
  return { db, users, selects };
}

function lastListener(bucket: OwnedListener[]): OwnedListener {
  const listener = bucket.at(-1);
  if (!listener) throw new Error("no listener attached");
  return listener;
}

function startInformer(options: { reattachMs?: number; log?: (message: string) => void } = {}) {
  const { db, users, selects } = fakeUsersDb();
  const watches = createScriptedWatches();
  const store = storeWithScriptedWatches(createDocumentFixtureStore({}), watches);
  const informer = createFleetInformer({ db, store, log: options.log ?? vi.fn(), reattachMs: options.reattachMs });
  return { informer, watches, users, selects };
}

function record<A extends MirroredAggregate>(fields: Record<string, unknown>): Stored<WatchRecords[A]> {
  return { revision: "r1", ...fields } as unknown as Stored<WatchRecords[A]>;
}

const MIRRORS = [
  ["gateways", (informer: FleetInformer) => informer.gateways()],
  ["fleetRegistry", (informer: FleetInformer) => informer.fleetRegistry()],
  ["assignments", (informer: FleetInformer) => informer.assignments()],
] as const;

function gatewayRecord(gatewayId: string, fields: Record<string, unknown> = {}) {
  return record<"fleetRegistry">({ gatewayId, lifecycle: "serving", ...fields });
}

function malformed(gatewayId: string): MalformedRecordError {
  return new MalformedRecordError({ aggregate: "fleet-registry", key: gatewayId }, "is not this gateway's runtime record");
}

function listenerFailure(): BackendFailureError {
  return new BackendFailureError("firestore", "watch fleetRegistry", { cause: new Error("listen stream broke") });
}

describe("fleet informer — users listener", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("wakes placement only when eligible unassigned users change", () => {
    const { informer, users } = startInformer();
    const wake = vi.fn();
    const stop = informer.subscribeUnassignedUsers!(wake);
    const candidate = { username: "alice", onboardingStep: "complete", provisioning: { status: "in_progress" } };
    lastListener(users).onNext({ docs: [doc("alice", candidate)] });
    expect(wake).toHaveBeenCalledOnce();
    lastListener(users).onNext({ docs: [doc("alice", { ...candidate, displayName: "Alice" })] });
    expect(wake).toHaveBeenCalledOnce();
    lastListener(users).onNext({ docs: [doc("alice", { ...candidate, provisioning: { openclaw: { gatewayId: "shared-a" } } })] });
    expect(wake).toHaveBeenCalledTimes(2);
    stop();
    informer.stop();
  });

  it("attaches a users listener without a Firestore projection", () => {
    const { informer, selects, users } = startInformer();

    expect(users).toHaveLength(1);
    expect(selects).toEqual([]);
    informer.stop();
  });

  it("serves null before the initial users snapshot, docs sorted by id after", () => {
    const { informer, users } = startInformer();

    expect(informer.users()).toBeNull();

    lastListener(users).onNext({
      docs: [doc("uid-b", { username: "bee" }), doc("uid-a", { username: "aye" })],
    });

    expect(informer.users()?.map((d) => d.id)).toEqual(["uid-a", "uid-b"]);
    expect(informer.users()?.[0]?.data()).toEqual({ username: "aye" });
    informer.stop();
  });

  it("rebuilds the users mirror from each full snapshot — removed docs disappear", () => {
    const { informer, users } = startInformer();

    lastListener(users).onNext({
      docs: [doc("uid-a", { username: "aye" }), doc("uid-b", { username: "bee" })],
    });
    lastListener(users).onNext({ docs: [doc("uid-b", { username: "bee" })] });

    expect(informer.users()?.map((d) => d.id)).toEqual(["uid-b"]);
    informer.stop();
  });

  it("marks the users mirror stale on listener error and re-attaches after the delay", () => {
    const log = vi.fn();
    const { informer, users } = startInformer({ log });

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
    const log = vi.fn();
    const { informer, users } = startInformer({ log });

    lastListener(users).onError(new Error("PERMISSION_DENIED: listen rejected"));
    vi.advanceTimersByTime(FLEET_INFORMER_REATTACH_MS_DEFAULT);

    expect(log).toHaveBeenCalledWith(expect.stringContaining("PERMISSION_DENIED"));
    informer.stop();
  });

  it("schedules exactly one re-attach no matter how many errors a dead listener reports", () => {
    const { informer, users } = startInformer();

    lastListener(users).onError(new Error("first"));
    lastListener(users).onError(new Error("second"));

    vi.advanceTimersByTime(FLEET_INFORMER_REATTACH_MS_DEFAULT * 2);

    expect(users).toHaveLength(2);
    informer.stop();
  });

  it("honors a configured re-attach delay", () => {
    const { informer, users } = startInformer({ reattachMs: 5_000 });

    lastListener(users).onError(new Error("boom"));
    vi.advanceTimersByTime(4_999);
    expect(users).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(users).toHaveLength(2);
    informer.stop();
  });
});

describe("fleet informer — store watch mirrors", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("watches gateways, the fleet registry and assignments across the whole fleet", () => {
    const { informer, watches } = startInformer();

    for (const [aggregate] of MIRRORS) {
      expect(watches.attachCount(aggregate)).toBe(1);
      expect(watches.latest(aggregate).filter).toEqual({});
    }
    expect(watches.attachCount("builders")).toBe(0);
    informer.stop();
  });

  it.each(MIRRORS)("serves null before the first %s snapshot and records sorted by key after it", (aggregate, read) => {
    const { informer, watches } = startInformer();
    expect(read(informer)).toBeNull();

    watches.latest(aggregate).snapshot([
      record({ gatewayId: "shared-b", uid: "uid-a" }),
      record({ gatewayId: "shared-a", uid: "uid-a" }),
    ]);

    expect(read(informer)?.map((stored) => stored.gatewayId)).toEqual(["shared-a", "shared-b"]);
    informer.stop();
  });

  it("applies added, modified and removed changes as deltas", () => {
    const { informer, watches } = startInformer();
    const watch = watches.latest("fleetRegistry");
    watch.snapshot([gatewayRecord("shared-blue"), gatewayRecord("bender")]);

    watch.changes([
      { type: "modified", key: "bender", record: gatewayRecord("bender", { lifecycle: "failed" }) },
      { type: "removed", key: "shared-blue", record: null },
      { type: "added", key: "alice-b", record: gatewayRecord("alice-b") },
    ]);

    expect(informer.fleetRegistry()?.map((stored) => [stored.gatewayId, stored.lifecycle])).toEqual([
      ["alice-b", "serving"],
      ["bender", "failed"],
    ]);
    informer.stop();
  });

  it("keys assignments by gateway and uid, so one Builder's assignments on two gateways both stay mirrored", () => {
    const { informer, watches } = startInformer();
    const watch = watches.latest("assignments");
    watch.snapshot([
      record<"assignments">({ gatewayId: "shared-blue", uid: "uid-a", state: "quiescing" }),
      record<"assignments">({ gatewayId: "shared-green", uid: "uid-a", state: "serving" }),
    ]);
    watch.changes([{ type: "removed", key: "shared-blue/uid-a", record: null }]);

    expect(informer.assignments()?.map((stored) => [stored.gatewayId, stored.uid, stored.state])).toEqual([
      ["shared-green", "uid-a", "serving"],
    ]);
    informer.stop();
  });

  it("goes stale on a backend failure and recovers on the store's own resubscribe without re-attaching", () => {
    const { informer, watches } = startInformer();
    const watch = watches.latest("fleetRegistry");
    watch.snapshot([gatewayRecord("shared-blue")]);

    watch.error(listenerFailure());
    expect(informer.fleetRegistry()).toBeNull();
    watch.changes([{ type: "added", key: "bender", record: gatewayRecord("bender") }]);
    expect(informer.fleetRegistry()).toBeNull();
    watch.resync();
    expect(informer.fleetRegistry()).toBeNull();
    watch.snapshot([gatewayRecord("bender")]);

    expect(informer.fleetRegistry()?.map((stored) => stored.gatewayId)).toEqual(["bender"]);
    vi.advanceTimersByTime(FLEET_INFORMER_REATTACH_MS_DEFAULT * 2);
    expect(watches.attachCount("fleetRegistry")).toBe(1);
    informer.stop();
  });

  it("stays stale through a snapshot that dropped a malformed record and re-attaches once after the delay", () => {
    const log = vi.fn();
    const { informer, watches } = startInformer({ log, reattachMs: 5_000 });
    const first = watches.latest("fleetRegistry");

    first.error(malformed("broken"));
    first.error(malformed("broken-too"));
    first.snapshot([gatewayRecord("shared-blue")]);
    expect(informer.fleetRegistry()).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining(`fleet-registry "broken" is malformed`));

    vi.advanceTimersByTime(4_999);
    expect(watches.attachCount("fleetRegistry")).toBe(1);
    vi.advanceTimersByTime(1);
    expect(watches.attachCount("fleetRegistry")).toBe(2);
    expect(first.open).toBe(false);

    watches.latest("fleetRegistry").snapshot([gatewayRecord("shared-blue")]);
    expect(informer.fleetRegistry()?.map((stored) => stored.gatewayId)).toEqual(["shared-blue"]);
    informer.stop();
  });

  it("goes stale when a record already mirrored turns malformed and re-attaches", () => {
    const { informer, watches } = startInformer();
    const watch = watches.latest("fleetRegistry");
    watch.snapshot([gatewayRecord("shared-blue"), gatewayRecord("bender")]);

    watch.error(malformed("bender"));
    watch.changes([{ type: "removed", key: "bender", record: null }]);

    expect(informer.fleetRegistry()).toBeNull();
    vi.advanceTimersByTime(FLEET_INFORMER_REATTACH_MS_DEFAULT);
    expect(watches.attachCount("fleetRegistry")).toBe(2);
    informer.stop();
  });

  it("serves the valid runtime records and the malformed keys while malformed records are the only staleness", () => {
    const { informer, watches } = startInformer();
    const watch = watches.latest("fleetRegistry");
    watch.error(malformed("broken"));
    watch.snapshot([gatewayRecord("shared-blue"), gatewayRecord("bender")]);
    watch.changes([{ type: "added", key: "alice-b", record: gatewayRecord("alice-b") }]);
    watch.error(malformed("bender"));
    watch.changes([{ type: "removed", key: "bender", record: null }]);

    expect(informer.fleetRegistry()).toBeNull();
    expect(informer.fleetRegistryWithoutMalformed()).toEqual({
      records: [gatewayRecord("alice-b"), gatewayRecord("shared-blue")],
      malformedKeys: ["bender", "broken"],
    });
    informer.stop();
  });

  it("serves the strict mirror again once a valid record replaces the only malformed one", () => {
    const { informer, watches } = startInformer();
    const watch = watches.latest("fleetRegistry");
    watch.snapshot([gatewayRecord("shared-blue")]);
    watch.error(malformed("bender"));
    expect(informer.fleetRegistry()).toBeNull();

    watch.changes([{ type: "added", key: "bender", record: gatewayRecord("bender") }]);

    expect(informer.fleetRegistry()?.map((stored) => stored.gatewayId)).toEqual(["bender", "shared-blue"]);
    expect(informer.fleetRegistryWithoutMalformed()?.malformedKeys).toEqual([]);
    informer.stop();
  });

  it("carries the valid runtime records across a malformed-record re-attach until the new snapshot", () => {
    const { informer, watches } = startInformer({ reattachMs: 5_000 });
    const first = watches.latest("fleetRegistry");
    first.error(malformed("broken"));
    first.snapshot([gatewayRecord("shared-blue")]);
    vi.advanceTimersByTime(5_000);
    const second = watches.latest("fleetRegistry");
    second.error(malformed("broken"));

    expect(watches.attachCount("fleetRegistry")).toBe(2);
    expect(informer.fleetRegistryWithoutMalformed()).toEqual({ records: [gatewayRecord("shared-blue")], malformedKeys: ["broken"] });

    second.snapshot([gatewayRecord("bender")]);
    expect(informer.fleetRegistryWithoutMalformed()).toEqual({ records: [gatewayRecord("bender")], malformedKeys: ["broken"] });
    informer.stop();
  });

  it.each([
    ["a backend failure", (watch: ReturnType<ScriptedWatches["latest"]>) => watch.error(listenerFailure())],
    ["a resync", (watch: ReturnType<ScriptedWatches["latest"]>) => watch.resync()],
    ["a closed watch", (watch: ReturnType<ScriptedWatches["latest"]>) => watch.reject(new Error("listener threw"))],
  ])("serves no valid runtime records after %s", async (_label, interrupt) => {
    const { informer, watches } = startInformer();
    const watch = watches.latest("fleetRegistry");
    watch.error(malformed("broken"));
    watch.snapshot([gatewayRecord("shared-blue")]);

    interrupt(watch);
    await vi.advanceTimersByTimeAsync(0);

    expect(informer.fleetRegistryWithoutMalformed()).toBeNull();
    expect(informer.fleetRegistry()).toBeNull();
    informer.stop();
  });

  it("re-attaches after the watch closes with an error", async () => {
    const log = vi.fn();
    const { informer, watches } = startInformer({ log });
    const watch = watches.latest("gateways");
    watch.snapshot([record<"gateways">({ gatewayId: "shared-blue" })]);

    watch.reject(new Error("listener threw"));
    await vi.advanceTimersByTimeAsync(0);

    expect(informer.gateways()).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("gateways watch closed: listener threw"));
    await vi.advanceTimersByTimeAsync(FLEET_INFORMER_REATTACH_MS_DEFAULT);
    expect(watches.attachCount("gateways")).toBe(2);
    informer.stop();
  });

  it("logs a staleness transition once, not per error or read", () => {
    const log = vi.fn();
    const { informer, watches } = startInformer({ log });
    const watch = watches.latest("gateways");
    watch.snapshot([]);

    watch.error(listenerFailure());
    watch.error(listenerFailure());
    informer.gateways();
    informer.gateways();

    expect(log.mock.calls.filter(([message]) => String(message).includes("gateways mirror stale"))).toHaveLength(1);
    informer.stop();
  });

  it("delivers each snapshot as a reset and each changes event as changes to subscribers", () => {
    const { informer, watches } = startInformer();
    const deliveries: MirrorDelivery<"gateways">[] = [];
    const unsubscribe = informer.subscribe("gateways", (delivery) => deliveries.push(delivery));
    const watch = watches.latest("gateways");
    const root = record<"gateways">({ gatewayId: "shared-blue" });

    watch.snapshot([root]);
    watch.changes([{ type: "removed", key: "shared-blue", record: null }]);
    unsubscribe();
    watch.snapshot([]);

    expect(deliveries).toEqual([
      { kind: "reset", records: [root] },
      { kind: "changes", changes: [{ type: "removed", key: "shared-blue", record: null }] },
    ]);
    informer.stop();
  });

  it("keeps mirroring and delivering when one subscriber throws", () => {
    const log = vi.fn();
    const { informer, watches } = startInformer({ log });
    const delivered = vi.fn();
    informer.subscribe("fleetRegistry", () => {
      throw new Error("subscriber broke");
    });
    informer.subscribe("fleetRegistry", delivered);

    watches.latest("fleetRegistry").snapshot([gatewayRecord("shared-blue")]);

    expect(delivered).toHaveBeenCalledOnce();
    expect(informer.fleetRegistry()).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("fleetRegistry subscriber failed: subscriber broke"));
    informer.stop();
  });

  it("stop() closes every watch, unsubscribes users and cancels pending re-attaches", () => {
    const { informer, watches, users } = startInformer();
    watches.latest("fleetRegistry").error(malformed("broken"));
    lastListener(users).onError(new Error("boom"));

    informer.stop();

    for (const [aggregate] of MIRRORS) expect(watches.latest(aggregate).open).toBe(false);
    expect(lastListener(users).unsubscribed).toBe(true);
    vi.advanceTimersByTime(FLEET_INFORMER_REATTACH_MS_DEFAULT * 2);
    expect(watches.attachCount("fleetRegistry")).toBe(1);
    expect(users).toHaveLength(1);
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
