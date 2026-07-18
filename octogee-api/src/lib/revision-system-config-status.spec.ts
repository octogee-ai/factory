import { describe, expect, it, vi } from "vitest";

import { recordRevisionSystemConfigStatus } from "./revision-system-config-status.js";

describe("gateway system config status telemetry", () => {
  it("updates the matching stable runtime heartbeat", async () => {
    const update = vi.fn();
    const ref = {};
    const db = {
      collection: vi.fn(() => ({ doc: vi.fn(() => ref) })),
      runTransaction: vi.fn(async (body: (transaction: unknown) => Promise<unknown>) => body({
        get: vi.fn(async () => ({
          exists: true,
          data: () => ({ docKind: "runtime", gatewayId: "bender", release: 7, lifecycle: "serving" }),
        })),
        update,
      })),
    };

    await expect(recordRevisionSystemConfigStatus(db as never, {
      gatewayId: "bender",
      revisionId: "bender",
      status: { state: "clean", acceptedCommit: "a".repeat(40) },
    })).resolves.toBe(true);
    expect(update).toHaveBeenCalledWith(ref, {
      "heartbeat.configStatus": expect.objectContaining({
        state: "clean",
        acceptedCommit: "a".repeat(40),
      }),
    });
  });

  it("refuses a mismatched or legacy revision document", async () => {
    const update = vi.fn();
    const db = {
      collection: vi.fn(() => ({ doc: vi.fn(() => ({})) })),
      runTransaction: vi.fn(async (body: (transaction: unknown) => Promise<unknown>) => body({
        get: vi.fn(async () => ({
          exists: true,
          data: () => ({ docKind: "revision", gateway: "other", revisionId: "bender-r7" }),
        })),
        update,
      })),
    };

    await expect(recordRevisionSystemConfigStatus(db as never, {
      gatewayId: "bender",
      revisionId: "bender",
      status: { state: "error" },
    })).resolves.toBe(false);
    expect(update).not.toHaveBeenCalled();
  });
});
