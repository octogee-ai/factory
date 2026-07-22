import { describe, expect, it, vi } from "vitest";

import { ensureOwnedDedicatedGatewaysRetired } from "../lib/customer-ops/customer-gateway-retirement.js";

interface Root {
  ownerUid: string | null;
  gatewayClass: "shared" | "builder" | "operator";
  desiredStatus: "running" | "paused" | "retired";
}

function harness(
  roots: Record<string, Root>,
  operations: Record<string, Record<string, unknown>> = {},
) {
  const deleted: string[] = [];
  const gatewayRef = (id: string) => ({
    path: `gateways/${id}`,
    get: async () => ({ exists: roots[id] !== undefined, data: () => roots[id] }),
  });
  const operationRef = (id: string) => ({
    path: `glmOperations/${id}`,
    get: async () => ({ exists: operations[id] !== undefined, data: () => operations[id] }),
  });
  const db = {
    collection: (name: string) => ({
      doc: (id: string) => name === "gateways" ? gatewayRef(id) : operationRef(id),
      where: (_field: string, _op: string, uid: string) => ({
        get: async () => ({
          docs: name === "gateways"
            ? Object.entries(roots)
                .filter(([, root]) => root.ownerUid === uid)
                .map(([id, root]) => ({ id, data: () => root, ref: gatewayRef(id) }))
            : [],
        }),
      }),
    }),
    recursiveDelete: async (ref: { path: string }) => {
      deleted.push(ref.path);
      if (ref.path.startsWith("gateways/")) delete roots[ref.path.slice("gateways/".length)];
      if (ref.path.startsWith("glmOperations/")) delete operations[ref.path.slice("glmOperations/".length)];
    },
  };
  return { db, deleted };
}

describe("owned customer gateway retirement", () => {
  it("retires the owned Operator gateway while the user's current placement is shared", async () => {
    const { db } = harness({
      default: { ownerUid: null, gatewayClass: "shared", desiredStatus: "running" },
      "builder-alice": { ownerUid: "uid-1", gatewayClass: "operator", desiredStatus: "running" },
    });
    const claimRetirement = vi.fn(async () => ({ version: 1 }));

    await expect(ensureOwnedDedicatedGatewaysRetired({
      db: db as never,
      uid: "uid-1",
      deletionId: "delete-1",
      now: 100,
      claimRetirement: claimRetirement as never,
    })).resolves.toBe("retirement-pending");

    expect(claimRetirement).toHaveBeenCalledWith(expect.objectContaining({
      gatewayId: "builder-alice",
      operationId: "delete-retire-delete-1-builder-alice",
    }));
  });

  it("deletes every durable gateway root only after its retirement operation succeeds", async () => {
    const operationId = "delete-retire-delete-1-builder-alice";
    const { db, deleted } = harness(
      {
        "builder-alice": { ownerUid: "uid-1", gatewayClass: "operator", desiredStatus: "retired" },
      },
      { [operationId]: { status: "succeeded" } },
    );

    await expect(ensureOwnedDedicatedGatewaysRetired({
      db: db as never,
      uid: "uid-1",
      deletionId: "delete-1",
      now: 100,
      claimRetirement: vi.fn() as never,
    })).resolves.toBe("retired");

    expect(deleted).toEqual([
      "gateways/builder-alice",
      `glmOperations/${operationId}`,
    ]);
  });

  it("leaves shared gateways alone even if malformed ownership data points at the customer", async () => {
    const { db } = harness({
      default: { ownerUid: "uid-1", gatewayClass: "shared", desiredStatus: "running" },
    });
    const claimRetirement = vi.fn();

    await expect(ensureOwnedDedicatedGatewaysRetired({
      db: db as never,
      uid: "uid-1",
      deletionId: "delete-1",
      now: 100,
      claimRetirement: claimRetirement as never,
    })).resolves.toBe("not-owned");
    expect(claimRetirement).not.toHaveBeenCalled();
  });
});
