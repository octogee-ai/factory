import { describe, expect, it, vi } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import type { PlatformStateStore } from "@octogee/core/platform-state";

import {
  accountCreatedAtMillis,
  parseBackfillUserCreatedAtArgs,
  planCreatedAtBackfill,
  writeCreatedAt,
} from "../ops/backfill-user-created-at.js";

const NOW = 1_794_000_000_000;

function storeHolding(current: { createdAt: number | null } | null) {
  const create = vi.fn(async (): Promise<void> => undefined);
  const records = { get: vi.fn(async () => current), create };
  const transaction = vi.fn(async (_options: unknown, body: (tx: unknown) => Promise<unknown>) => body({ users: { records } }));
  return { create, store: { transaction } as unknown as Pick<PlatformStateStore, "transaction"> };
}

describe("backfill-user-created-at", () => {
  it("is a dry run by default, needs an environment, and rejects stray arguments", () => {
    expect(parseBackfillUserCreatedAtArgs(["--env=test"])).toEqual({ environment: "test", apply: false });
    expect(parseBackfillUserCreatedAtArgs(["--env=prod", "--apply"])).toEqual({ environment: "prod", apply: true });
    expect(() => parseBackfillUserCreatedAtArgs([])).toThrow(/--env/);
    expect(() => parseBackfillUserCreatedAtArgs(["--env=test", "--force"])).toThrow(/--force/);
  });

  it("reads an account creation time stored as a timestamp or as milliseconds and nothing else", () => {
    expect(accountCreatedAtMillis(Timestamp.fromMillis(NOW))).toBe(NOW);
    expect(accountCreatedAtMillis(NOW)).toBe(NOW);
    for (const value of [undefined, null, "2026-11-11", 0, Number.NaN, { seconds: 1 }]) {
      expect(accountCreatedAtMillis(value)).toBeNull();
    }
  });

  it("takes the account creation time first, then the provisioning start, and reports a user with neither", () => {
    const plan = planCreatedAtBackfill(
      [
        { uid: "dated", createdAt: NOW, provisioning: { startedAt: NOW + 9 } },
        { uid: "account", createdAt: null, provisioning: { startedAt: NOW + 9 } },
        { uid: "started", createdAt: null, provisioning: { startedAt: NOW + 2 } },
        { uid: "neither", createdAt: null, provisioning: {} },
      ],
      new Map([["dated", NOW - 5], ["account", NOW + 1]]),
    );

    expect(plan).toEqual({
      dated: 1,
      backfills: [
        { uid: "account", createdAt: NOW + 1, source: "account" },
        { uid: "started", createdAt: NOW + 2, source: "provisioning-start" },
      ],
      unresolved: ["neither"],
    });
  });

  it("writes only to a user that still exists without a creation time", async () => {
    const backfill = { uid: "alice", createdAt: NOW, source: "account" } as const;

    const undated = storeHolding({ createdAt: null });
    await expect(writeCreatedAt(undated.store, backfill)).resolves.toBe("written");
    expect(undated.create).toHaveBeenCalledWith({ uid: "alice", createdAt: NOW });

    const dated = storeHolding({ createdAt: NOW - 1 });
    await expect(writeCreatedAt(dated.store, backfill)).resolves.toBe("already-dated");
    expect(dated.create).not.toHaveBeenCalled();

    const gone = storeHolding(null);
    await expect(writeCreatedAt(gone.store, backfill)).resolves.toBe("user-gone");
    expect(gone.create).not.toHaveBeenCalled();
  });
});
