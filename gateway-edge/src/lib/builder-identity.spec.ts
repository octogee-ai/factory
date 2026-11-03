import { afterEach, describe, expect, it, vi } from "vitest";
import type { BuilderIdentity } from "@octogee/shared/types/builder-identity";
import {
  BUILDER_IDENTITY_POLL_MS,
  BUILDER_IDENTITY_RETRY_MS,
  builderIdentity,
  claimedBuilderIdentity,
  createBuilderIdentityStore,
  installBuilderIdentityStore,
} from "./builder-identity.js";

const CLAIMED: BuilderIdentity = {
  gatewayId: "b-alice", state: "claimed", ownerUid: "uid-alice", builderSlug: "alice", leaseId: "lease", generation: 1,
};
const UNSETTLED: BuilderIdentity = { gatewayId: "b-alice", state: "unavailable", reason: "retiring" };

function harness(replies: Array<BuilderIdentity | Error>) {
  const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
  const read = vi.fn(async () => {
    const reply = replies.shift();
    if (!reply) throw new Error("no reply scripted");
    if (reply instanceof Error) throw reply;
    return reply;
  });
  const log = vi.fn();
  const store = createBuilderIdentityStore({
    read,
    log,
    schedule: (callback, delayMs) => { scheduled.push({ callback, delayMs }); return () => undefined; },
  });
  const tick = async () => { await vi.waitFor(() => expect(read).toHaveBeenCalled()); };
  const runNext = async () => {
    const next = scheduled.shift();
    if (!next) throw new Error("nothing scheduled");
    next.callback();
    await Promise.resolve();
    await Promise.resolve();
  };
  return { store, read, log, scheduled, tick, runNext };
}

afterEach(() => installBuilderIdentityStore(createBuilderIdentityStore({ read: async () => UNSETTLED, log: () => undefined })));

describe("gateway-edge Builder identity", () => {
  it("reports no identity until the broker has answered", () => {
    const h = harness([CLAIMED]);
    installBuilderIdentityStore(h.store);
    expect(builderIdentity()).toBeNull();
    expect(claimedBuilderIdentity()).toBeNull();
  });

  it("keeps polling an unsettled identity and stops once the broker reports the claim", async () => {
    const h = harness([UNSETTLED, CLAIMED]);
    installBuilderIdentityStore(h.store);
    h.store.start();
    await h.tick();
    await vi.waitFor(() => expect(h.scheduled).toHaveLength(1));
    expect(h.scheduled[0].delayMs).toBe(BUILDER_IDENTITY_POLL_MS);
    expect(builderIdentity()).toEqual(UNSETTLED);
    expect(claimedBuilderIdentity()).toBeNull();

    await h.runNext();
    await vi.waitFor(() => expect(claimedBuilderIdentity()).toEqual(CLAIMED));
    expect(h.scheduled).toHaveLength(0);
  });

  it("logs a failed broker read, keeps the last answer, and retries on the slower interval", async () => {
    const h = harness([new Error("broker returned 503"), CLAIMED]);
    installBuilderIdentityStore(h.store);
    h.store.start();
    await vi.waitFor(() => expect(h.log).toHaveBeenCalledWith(expect.stringContaining("broker returned 503")));
    expect(h.scheduled[0].delayMs).toBe(BUILDER_IDENTITY_RETRY_MS);
    expect(builderIdentity()).toBeNull();

    await h.runNext();
    await vi.waitFor(() => expect(claimedBuilderIdentity()).toEqual(CLAIMED));
  });
});
