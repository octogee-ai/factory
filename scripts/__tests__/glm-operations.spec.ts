import { describe, it, expect, vi } from "vitest";
import {
  enqueueOperation,
  readOperation,
  awaitOperation,
  isTerminalStatus,
  type OperationsDb,
} from "../lib/glm-operations.js";
import { GLM_OPERATIONS_COLLECTION, type Operation } from "../../shared/types/glm.js";

function makeFakeDb(initial: Record<string, Record<string, unknown>> = {}) {
  const docs = new Map<string, Record<string, unknown>>(Object.entries(initial));
  let seq = 0;
  const added: Array<{ id: string; data: Record<string, unknown> }> = [];
  const db: OperationsDb = {
    collection(name) {
      expect(name).toBe(GLM_OPERATIONS_COLLECTION);
      return {
        async add(data) {
          const id = `op-${++seq}`;
          docs.set(id, data);
          added.push({ id, data });
          return { id };
        },
        doc(id) {
          return {
            async get() {
              const data = docs.get(id);
              return { exists: data !== undefined, id, data: () => data };
            },
          };
        },
      };
    },
  };
  return { db, docs, added };
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
    const { db, docs } = makeFakeDb();
    const id = await enqueueOperation(db, {
      kind: "migrate-customer",
      input: { uid: "u1", toGatewayId: "canary" },
      createdBy: "fleet-cli",
      now: () => 1234,
    });
    expect(id).toBe("op-1");
    const doc = docs.get("op-1")!;
    expect(doc).toMatchObject({
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
    const { db, docs } = makeFakeDb();
    await enqueueOperation(db, {
      kind: "retire-gateway",
      input: { gatewayId: "bender" },
      createdBy: "fleet-cli",
    });
    expect(docs.get("op-1")).toMatchObject({ gatewayId: "bender" });
    expect(docs.get("op-1")).not.toHaveProperty("inputUid");
  });
});

describe("readOperation", () => {
  it("returns null when the op does not exist", async () => {
    const { db } = makeFakeDb();
    expect(await readOperation(db, "missing")).toBeNull();
  });

  it("returns the op with its id merged in", async () => {
    const { db } = makeFakeDb({
      "op-1": { kind: "migrate-customer", status: "running", steps: [] },
    });
    const op = await readOperation(db, "op-1");
    expect(op).toMatchObject({ id: "op-1", status: "running" });
  });
});

describe("awaitOperation", () => {
  it("polls until the op reaches a terminal status and returns it", async () => {
    const base = { kind: "migrate-customer", createdBy: "fleet-cli", input: {} };
    const { db, docs } = makeFakeDb({
      "op-1": { ...base, status: "pending", steps: [] },
    });
    const transitions = [
      { status: "running", steps: [{ name: "quiesce-source", status: "running" }] },
      { status: "succeeded", steps: [{ name: "quiesce-source", status: "done" }] },
    ];
    let tick = 0;
    const sleep = vi.fn(async () => {
      const next = transitions[tick++] ?? transitions[transitions.length - 1];
      docs.set("op-1", { ...base, ...next });
    });
    const onUpdate = vi.fn();
    const op = await awaitOperation(db, "op-1", {
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
    const { db } = makeFakeDb({
      "op-1": { kind: "migrate-customer", status: "pending", steps: [], createdBy: "x", input: {} },
    });
    let calls = 0;
    const now = () => (calls++ === 0 ? 0 : 10_000);
    await expect(
      awaitOperation(db, "op-1", { pollMs: 1, timeoutMs: 1_000, now, sleep: vi.fn() }),
    ).rejects.toThrow(/did not finish within 1000ms/);
  });

  it("throws when the op disappears", async () => {
    const { db } = makeFakeDb();
    await expect(
      awaitOperation(db, "ghost", { now: () => 0, sleep: vi.fn() }),
    ).rejects.toThrow(/operation ghost not found/);
  });
});
