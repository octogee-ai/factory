import { describe, expect, it, vi } from "vitest";
import { MalformedRecordError } from "../../errors.js";
import type { WatchChange, WatchEvent, WatchRequest } from "../../store.js";
import { NOW, useUserFixture, type UserFixture } from "./fixtures/users.js";
import { dsn, recordingListener, type RecordingListener } from "./fixtures/harness.js";

const WAIT = { timeout: 20_000, interval: 20 };

type UsersListener = RecordingListener<"builders">;

function changesOf(listener: UsersListener): WatchChange<"builders">[] {
  return listener.events.flatMap((event) => (event.kind === "changes" ? [...event.changes] : []));
}

function summary(listener: UsersListener): string[] {
  return changesOf(listener).map((change) => `${change.type}:${change.key}`);
}

function snapshotOf(event: WatchEvent<"builders"> | undefined) {
  if (event?.kind !== "snapshot") throw new Error(`expected a snapshot, got ${event?.kind}`);
  return event.records;
}

async function watched({ store }: UserFixture, request: WatchRequest<"builders">): Promise<UsersListener> {
  const listener = recordingListener<"builders">();
  store.watch(request, listener);
  await vi.waitFor(() => expect(listener.events.length).toBeGreaterThan(0), WAIT);
  return listener;
}

async function untilChange(listener: UsersListener, expected: object): Promise<void> {
  await vi.waitFor(() => expect(changesOf(listener)).toContainEqual(expect.objectContaining(expected)), WAIT);
}

describe.skipIf(!dsn)("PostgreSQL user watch", { timeout: 30_000 }, () => {
  const fixture = useUserFixture();

  it("delivers the users on a gateway with their roles and roster, then arrivals, changes and departures", async () => {
    const { records, place, assign, harness } = fixture();
    for (const uid of ["alice", "bob", "carol"]) await records.create({ uid, createdAt: NOW });
    await records.patch("alice", { role: "admin" });
    await records.patch("bob", { role: "user" });
    await place("alice", "g1");
    await place("bob", "g2");
    await place("carol", "g2");

    const listener = await watched(fixture(), { aggregate: "builders", filter: { gatewayId: "g1" } });
    expect(snapshotOf(listener.events[0])).toEqual([expect.objectContaining({ uid: "alice", role: "admin", revision: expect.any(String) })]);

    await assign("g1", "bob");
    await records.setGatewayMirror("bob", { gatewayId: "g1" }, { gatewayId: "g2" });
    await untilChange(listener, { type: "added", key: "bob", record: expect.objectContaining({ uid: "bob", role: "user" }) });

    await records.patch("alice", { workspaceId: "alice" });
    await untilChange(listener, { type: "modified", key: "alice", record: expect.objectContaining({ workspaceId: "alice", role: "admin" }) });

    await harness.query("INSERT INTO $schema.user_agents (uid, agent_id) VALUES ('carol', 'octogee-carol-site')");
    await harness.query("INSERT INTO $schema.user_agents (uid, agent_id) VALUES ('alice', 'octogee-alice-site')");
    await untilChange(listener, {
      type: "modified",
      key: "alice",
      record: expect.objectContaining({ agents: { agentIds: ["octogee-alice-site"], activatedAgents: [] } }),
    });

    await records.setGatewayMirror("alice", { clear: true });
    await untilChange(listener, { type: "removed", key: "alice", record: null });

    expect(summary(listener)).toEqual(["added:bob", "modified:alice", "modified:alice", "removed:alice"]);
    expect(listener.errors).toEqual([]);
  });

  it("follows one user by uid from absent through admitted, roster changes and deletion", async () => {
    const { records } = fixture();
    await records.create({ uid: "bob", createdAt: NOW });
    const listener = await watched(fixture(), { aggregate: "builders", filter: { uid: "alice" } });
    expect(snapshotOf(listener.events[0])).toEqual([]);

    await records.admit("alice", { slug: "alice", persona: null, provisioningStartedAt: NOW });
    await untilChange(listener, { type: "added", key: "alice", record: expect.objectContaining({ admitted: true, role: null }) });
    await records.patch("bob", { workspaceId: "bob" });
    await records.addAgents("alice", ["octogee-alice-coach"]);
    await untilChange(listener, {
      type: "modified",
      key: "alice",
      record: expect.objectContaining({ agents: { agentIds: ["octogee-alice-coach"], activatedAgents: [] } }),
    });
    await records.delete("alice");
    await untilChange(listener, { type: "removed", key: "alice" });

    expect(summary(listener)).toEqual(["added:alice", "modified:alice", "removed:alice"]);
    expect(listener.errors).toEqual([]);
  });

  it("watches every user when the filter is empty", async () => {
    const { records } = fixture();
    await records.create({ uid: "alice", createdAt: NOW });
    const listener = await watched(fixture(), { aggregate: "builders", filter: {} });
    expect(snapshotOf(listener.events[0]).map((record) => record.uid)).toEqual(["alice"]);

    await records.create({ uid: "bob", createdAt: NOW });
    await untilChange(listener, { type: "added", key: "bob" });
    expect(listener.errors).toEqual([]);
  });

  it("reports a user it cannot decode and keeps delivering the others", async () => {
    const { records, place, harness } = fixture();
    for (const uid of ["alice", "broken"]) {
      await records.create({ uid, createdAt: NOW });
      await place(uid, "g1");
    }
    await harness.query(`UPDATE $schema.users SET restore_fence = '"x"'::jsonb WHERE uid = 'broken'`);

    const listener = await watched(fixture(), { aggregate: "builders", filter: { gatewayId: "g1" } });

    expect(snapshotOf(listener.events[0]).map((record) => record.uid)).toEqual(["alice"]);
    expect(listener.errors).toEqual([
      expect.objectContaining({
        constructor: MalformedRecordError,
        record: { aggregate: "builder", key: "broken" },
        detail: "restore_fence is not a map",
      }),
    ]);
  });
});
