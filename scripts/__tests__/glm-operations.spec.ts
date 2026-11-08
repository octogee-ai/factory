import { describe, it, expect, vi } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import {
  buildOperationAuditIntent,
  enqueueOperation,
  readOperation,
  awaitOperation,
  isTerminalStatus,
} from "../lib/glm-operations.js";

function makeFixtureStore(initial: Record<string, Record<string, unknown>> = {}) {
  const docs = new Map<string, Record<string, unknown>>(
    Object.entries(initial).map(([id, row]) => [`glmOperations/${id}`, row]),
  );
  return { store: createDocumentFixtureStore(docs), docs };
}

describe("isTerminalStatus", () => {
  it("treats succeeded/failed/rolled-back as terminal, pending/running as not", () => {
    expect(isTerminalStatus("succeeded")).toBe(true);
    expect(isTerminalStatus("failed")).toBe(true);
    expect(isTerminalStatus("rolled-back")).toBe(true);
    expect(isTerminalStatus("pending")).toBe(false);
    expect(isTerminalStatus("running")).toBe(false);
  });
});

describe("enqueueOperation", () => {
  it("writes a pending op with kind/input/createdBy and returns the new id", async () => {
    const { store, docs } = makeFixtureStore();
    const id = await enqueueOperation(store, {
      kind: "migrate-customer",
      input: { uid: "u1", toGatewayId: "canary" },
      createdBy: "fleet-cli",
      now: () => 1234,
    });
    expect([...docs.keys()]).toEqual([`glmOperations/${id}`]);
    const doc = docs.get(`glmOperations/${id}`)!;
    expect(doc).toEqual({
      kind: "migrate-customer",
      status: "pending",
      createdBy: "fleet-cli",
      createdAt: 1234,
      startedAt: null,
      completedAt: null,
      input: { uid: "u1", toGatewayId: "canary" },
      steps: [],
      inputUid: "u1",
    });
  });

  it("mirrors a gatewayId from input to the top-level field for controller indexing", async () => {
    const { store, docs } = makeFixtureStore();
    const id = await enqueueOperation(store, {
      kind: "retire-gateway",
      input: { gatewayId: "bender" },
      createdBy: "fleet-cli",
    });
    expect(docs.get(`glmOperations/${id}`)).toMatchObject({ gatewayId: "bender" });
    expect(docs.get(`glmOperations/${id}`)).not.toHaveProperty("inputUid");
  });
});

const auditIntent = {
  actor: "fleet-cli:chris",
  forced: true,
  what: "move release alias",
  why: "candidate verified in TEST",
  target: { gatewayId: "bender" },
  preActionStatus: { alias: "stable", target: "sha-old" },
  mutation: {
    aliases: [{ alias: "stable", target: "sha-next" }],
    gatewayId: "bender",
  },
  aliasPlan: [{ alias: "stable", expectedTarget: "sha-old", intendedTarget: "sha-next" }],
  releaseRollout: { releaseId: "v1.2.3", rolloutOperationId: "rollout-1" },
  testProvenance: { environment: "test" as const, sourceCommit: "abc123", verifiedAt: 1000 },
};

describe("operation audit journal", () => {
  it("builds a deterministic audit intent with release, alias, and TEST provenance", () => {
    const first = buildOperationAuditIntent({ ...auditIntent, now: () => 1234 });
    const second = buildOperationAuditIntent({
      ...auditIntent,
      mutation: { gatewayId: "bender", aliases: [{ target: "sha-next", alias: "stable" }] },
      now: () => 5678,
    });

    expect(first.id).toBe(second.id);
    expect(first.document).toMatchObject({
      recordType: "audit",
      schemaVersion: 1,
      status: "recorded",
      lifecycleStage: "intent-recorded",
      idempotencyKey: first.document.mutationFingerprint,
      mutation: auditIntent.mutation,
      aliasPlan: auditIntent.aliasPlan,
      releaseRollout: auditIntent.releaseRollout,
      testProvenance: auditIntent.testProvenance,
      createdAt: 1234,
      completedAt: null,
    });
  });

  it("rejects a cyclic nested array instead of recursing while fingerprinting intent", () => {
    const aliases: unknown[] = [];
    aliases.push(aliases);

    expect(() => buildOperationAuditIntent({
      ...auditIntent,
      mutation: { aliases },
      now: () => 1234,
    })).toThrow("operation audit mutation contains a cycle");
  });
});

describe("readOperation", () => {
  it("returns null when the op does not exist", async () => {
    const { store } = makeFixtureStore();
    expect(await readOperation(store, "missing")).toBeNull();
  });

  it("returns the op with its id merged in", async () => {
    const { store } = makeFixtureStore({
      "op-1": { kind: "migrate-customer", status: "running", steps: [] },
    });
    const op = await readOperation(store, "op-1");
    expect(op).toMatchObject({ id: "op-1", status: "running" });
  });
});

describe("awaitOperation", () => {
  it("polls until the op reaches a terminal status and returns it", async () => {
    const base = { kind: "migrate-customer", createdBy: "fleet-cli", input: {} };
    const { store, docs } = makeFixtureStore({
      "op-1": { ...base, status: "pending", steps: [] },
    });
    const transitions = [
      { status: "running", steps: [{ name: "quiesce-source", status: "running" }] },
      { status: "succeeded", steps: [{ name: "quiesce-source", status: "done" }] },
    ];
    let tick = 0;
    const sleep = vi.fn(async () => {
      const next = transitions[tick++] ?? transitions[transitions.length - 1];
      docs.set("glmOperations/op-1", { ...base, ...next });
    });
    const onUpdate = vi.fn();
    const op = await awaitOperation(store, "op-1", {
      pollMs: 1,
      timeoutMs: 10_000,
      now: () => 0,
      sleep,
      onUpdate,
    });
    expect(op.status).toBe("succeeded");
    // onUpdate fires once per distinct step set: [] → running → done
    expect(onUpdate).toHaveBeenCalledTimes(3);
  });

  it("throws when the op never finishes before the timeout", async () => {
    const { store } = makeFixtureStore({
      "op-1": { kind: "migrate-customer", status: "pending", steps: [], createdBy: "x", input: {} },
    });
    let calls = 0;
    const now = () => (calls++ === 0 ? 0 : 10_000);
    await expect(
      awaitOperation(store, "op-1", { pollMs: 1, timeoutMs: 1_000, now, sleep: vi.fn() }),
    ).rejects.toThrow(/did not finish within 1000ms/);
  });

  it("throws when the op disappears", async () => {
    const { store } = makeFixtureStore();
    await expect(
      awaitOperation(store, "ghost", { now: () => 0, sleep: vi.fn() }),
    ).rejects.toThrow(/operation ghost not found/);
  });
});
