import type { OperationsDocRef, OperationsTransaction } from "@octogee/core/operation-audit";
import { FieldValue, type Firestore } from "firebase-admin/firestore";

export const forceMigrationTarget = { operationId: "move-1", uid: "u1", slug: "alice", fromGatewayId: "builder-a", toGatewayId: "shared-b" };

export function forceMigrationHarness() {
  const docs = new Map<string, Record<string, any>>([
    ["glmOperations/move-1", {
      kind: "migrate-customer", status: "pending", createdAt: 0, startedAt: null, completedAt: null,
      input: { uid: "u1", fromGatewayId: "builder-a", toGatewayId: "shared-b", source: "placement" },
      attempts: 3, firstStartedAt: 100, nextAttemptAt: 9000, lastProgressAt: 450, steps: [],
      attemptHistory: [{ attempt: 3, startedAt: 400, completedAt: 450, error: "sessions.list UNAVAILABLE", steps: [
        { name: "pre-sync-state", status: "done" },
        { name: "quiesce-source", status: "failed" },
        { name: "rollback:unmount-target", status: "done" },
      ] }],
      schedulerHandoff: { migrationId: "mig-move-1:scheduler:3", uid: "u1", slug: "alice", fromGatewayId: "builder-a", toGatewayId: "shared-b" },
    }],
    ["users/u1", { username: "alice", provisioning: { openclaw: {
      gatewayId: "builder-a", status: "complete", migration: { state: "preparing", phase: "waiting", operationId: "move-1", startedAt: 400 },
    } } }],
    ["gateways/builder-a/assignments/u1", { uid: "u1", slug: "alice", gatewayId: "builder-a", state: "serving", epoch: 75, updatedByOperationId: "move-1" }],
    ["gateways/builder-a", { gatewayClass: "builder", ownerUid: "u1", builderSlug: "alice", runtime: "cluster", desiredStatus: "draining", desiredRelease: 1, liveRelease: 1 }],
    ["gateways/shared-b", { gatewayClass: "shared", desiredStatus: "running", desiredRelease: 1, liveRelease: 1 }],
  ]);
  const writes: Array<{ path: string; data: Record<string, unknown> }> = [];
  let transactions = 0;
  let beforeTransaction: ((at: number) => void) | undefined;
  const snapshot = (path: string) => ({ exists: docs.has(path), id: path.split("/").at(-1)!, data: () => structuredClone(docs.get(path)) });
  const ref = (path: string) => ({ path, id: path.split("/").at(-1)!, get: async () => snapshot(path) });
  function query(path: string, field: string, value: unknown) {
    return { query: true, path, field, value, limit: () => query(path, field, value), get: async () => {
      const matching = [...docs].filter(([key, doc]) => key.startsWith(`${path}/`) && key.split("/").length === path.split("/").length + 1 &&
        field.split(".").reduce((current: any, part) => current?.[part], doc) === value)
        .map(([key]) => ({ ...snapshot(key), ref: ref(key) }));
      return { docs: matching, size: matching.length, empty: matching.length === 0 };
    } };
  }
  const db = {
    doc: (path: string) => ref(path),
    collection: (path: string) => ({ doc: (id: string) => ref(`${path}/${id}`), where: (field: string, _op: string, value: unknown) => query(path, field, value), add: async () => { throw new Error("must not enqueue another migration"); } }),
    async runTransaction<T>(body: (transaction: OperationsTransaction) => Promise<T>) {
      beforeTransaction?.(++transactions);
      const staged: Array<{ path: string; data: Record<string, unknown>; create: boolean }> = [];
      const transaction: OperationsTransaction = {
        get: async (reference) => {
          const selected = reference as OperationsDocRef & { path: string; query?: boolean; field: string; value: unknown };
          if (!selected.query) return snapshot(selected.path);
          return query(selected.path, selected.field, selected.value).get() as never;
        },
        create: (reference, data) => staged.push({ path: (reference as OperationsDocRef & { path: string }).path, data, create: true }),
        update: (reference, data) => staged.push({ path: (reference as OperationsDocRef & { path: string }).path, data, create: false }),
      };
      const result = await body(transaction);
      for (const write of staged) {
        if (write.create && docs.has(write.path)) throw new Error("already exists");
        const next = { ...docs.get(write.path) };
        for (const [key, value] of Object.entries(write.data)) {
          const parts = key.split(".");
          const field = parts.pop()!;
          const parent = parts.reduce((obj, part) => obj[part] ??= {}, next);
          if (value && typeof value === "object" && "isEqual" in value && typeof value.isEqual === "function" && value.isEqual(FieldValue.delete())) delete parent[field];
          else parent[field] = value;
        }
        docs.set(write.path, next);
        writes.push(write);
      }
      return result;
    },
  };
  return { db: db as unknown as Firestore, docs, writes, op: () => docs.get("glmOperations/move-1")!, beforeTransaction: (hook: typeof beforeTransaction) => { beforeTransaction = hook; } };
}
