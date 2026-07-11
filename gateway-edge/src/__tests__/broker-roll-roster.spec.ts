import { describe, expect, it, vi } from "vitest";
import {
  createBrokerRollRosterSubscription,
  readBrokerRollRoster,
} from "../broker-roll-roster.js";

const brokerUrl = "http://octogee-api.octogee-test.svc.cluster.local:3001";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("broker roll roster", () => {
  it("reads the full sanitized assignment roster through the tenant-bound fleet broker", async () => {
    const fetcher = vi.fn(async () =>
      response({
        assignments: [
          { uid: "uid-a", revisionId: "default-r2", state: "serving", epoch: 3 },
          { uid: "uid-b", revisionId: "default-r7", state: "migrating", epoch: 4 },
        ],
      }),
    );

    const docs = await readBrokerRollRoster({
      brokerUrl,
      gatewayId: "default",
      revisionId: "default-r2",
      fetcher,
    });

    expect(fetcher).toHaveBeenCalledWith(
      `${brokerUrl}/internal/fleet/assignment-roster`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ gatewayId: "default", revisionId: "default-r2" }),
      }),
    );
    expect(docs.map((doc) => ({ id: doc.id, ...doc.data() }))).toEqual([
      { id: "uid-a", uid: "uid-a", revisionId: "default-r2", state: "serving", epoch: 3 },
      { id: "uid-b", uid: "uid-b", revisionId: "default-r7", state: "migrating", epoch: 4 },
    ]);
  });

  it("rejects a malformed broker roster instead of treating missing entries as local traffic", async () => {
    await expect(
      readBrokerRollRoster({
        brokerUrl,
        gatewayId: "default",
        revisionId: "default-r2",
        fetcher: async () => response({ assignments: [{ uid: "uid-a", revisionId: "other-r2" }] }),
      }),
    ).rejects.toThrow(/malformed assignment roster/u);
  });

  it("drops the store into its existing reconnect path when a broker poll fails", async () => {
    const onDocs = vi.fn();
    const onError = vi.fn();
    let nextPoll: (() => void) | null = null;
    const unsubscribe = createBrokerRollRosterSubscription({
      brokerUrl,
      gatewayId: "default",
      revisionId: "default-r2",
      fetcher: async () => response({ error: "unavailable" }, 503),
      schedule: (callback) => {
        nextPoll = callback;
        return () => undefined;
      },
    })(onDocs, onError);

    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));

    expect(onDocs).not.toHaveBeenCalled();
    expect(nextPoll).toBeNull();
    unsubscribe();
  });

  it("times out a black-holed broker read so the roster store drops readiness and reconnects", async () => {
    vi.useFakeTimers();
    try {
      const onDocs = vi.fn();
      const onError = vi.fn();
      const fetcher = vi.fn((_url: string | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) throw new Error("broker request must carry an AbortSignal");
          signal.addEventListener("abort", () => reject(new Error("aborted by deadline")), { once: true });
        }),
      );
      const unsubscribe = createBrokerRollRosterSubscription({
        brokerUrl,
        gatewayId: "default",
        revisionId: "default-r2",
        fetcher,
        requestTimeoutMs: 10,
      })(onDocs, onError);

      await vi.advanceTimersByTimeAsync(10);

      expect(onDocs).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/timed out/u) }));
      expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out a broker read whose BODY black-holes after headers, instead of retaining the stale roster", async () => {
    vi.useFakeTimers();
    try {
      const onDocs = vi.fn();
      const onError = vi.fn();
      const fetcher = vi.fn(async (_url: string | URL, init?: RequestInit) => {
        if (!init?.signal) throw new Error("broker request must carry an AbortSignal");
        return new Response(new ReadableStream({ start: () => undefined }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });
      const unsubscribe = createBrokerRollRosterSubscription({
        brokerUrl,
        gatewayId: "default",
        revisionId: "default-r2",
        fetcher,
        requestTimeoutMs: 10,
      })(onDocs, onError);

      await vi.advanceTimersByTimeAsync(10);

      expect(onDocs).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/timed out/u) }));
      expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  it("polls again after each successful broker snapshot", async () => {
    const onDocs = vi.fn();
    const onError = vi.fn();
    let nextPoll: (() => void) | null = null;
    const fetcher = vi.fn(async () => response({ assignments: [] }));
    const unsubscribe = createBrokerRollRosterSubscription({
      brokerUrl,
      gatewayId: "default",
      revisionId: "default-r2",
      fetcher,
      schedule: (callback) => {
        nextPoll = callback;
        return () => undefined;
      },
    })(onDocs, onError);

    await vi.waitFor(() => expect(onDocs).toHaveBeenCalledTimes(1));
    if (!nextPoll) throw new Error("successful poll should schedule its successor");
    nextPoll();
    await vi.waitFor(() => expect(onDocs).toHaveBeenCalledTimes(2));

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();
    unsubscribe();
  });
});
