import { describe, it, expect, vi } from "vitest";
import { mintAndPersistCoachToken } from "../lib/mattermost.js";

function mkDeps() {
  const setSpy = vi.fn().mockResolvedValue(undefined);
  const doc2 = vi.fn(() => ({ set: setSpy }));
  const collection2 = vi.fn(() => ({ doc: doc2 }));
  const doc1 = vi.fn(() => ({ collection: collection2 }));
  const collection1 = vi.fn(() => ({ doc: doc1 }));
  const db = { collection: collection1 } as any;
  const mmApiCall = vi.fn(async (method: string, endpoint: string) => {
    if (method === "GET" && endpoint.endsWith("/tokens")) return [];
    return undefined;
  });
  const now = vi.fn(() => ({ __op: "serverTimestamp" }));
  const log = vi.fn();
  return { db, mmApiCall, now, log, setSpy, collection1, doc1, collection2, doc2 };
}

function scriptMm(opts: {
  tokens?: any[];
  postResult?: any;
  listError?: Error;
  postError?: Error;
  revokeError?: Error;
}) {
  return vi.fn(async (method: string, endpoint: string, _body?: any) => {
    if (method === "GET" && endpoint.endsWith("/tokens")) {
      if (opts.listError) throw opts.listError;
      return opts.tokens ?? [];
    }
    if (method === "POST" && endpoint.endsWith("/tokens")) {
      if (opts.postError) throw opts.postError;
      return opts.postResult;
    }
    if (method === "POST" && endpoint === "/users/tokens/revoke") {
      if (opts.revokeError) throw opts.revokeError;
      return {};
    }
    throw new Error(`unexpected mmApiCall: ${method} ${endpoint}`);
  });
}

describe("mintAndPersistCoachToken", () => {
  it("calls MM to mint a PAT for the given coach user id with a stable description", async () => {
    const deps = mkDeps();
    deps.mmApiCall = scriptMm({ postResult: { token: "pat-abc123" } });

    await mintAndPersistCoachToken(deps, "uid-chris", "coach-mm-id-1");

    expect(deps.mmApiCall).toHaveBeenCalledWith(
      "POST",
      "/users/coach-mm-id-1/tokens",
      { description: "Octogee coach agent (OpenClaw)" },
    );
  });

  it("writes the PAT to users/{uid}/secrets/coachMattermost with the expected shape", async () => {
    const deps = mkDeps();
    deps.mmApiCall = scriptMm({ postResult: { token: "pat-abc123" } });

    await mintAndPersistCoachToken(deps, "uid-chris", "coach-mm-id-1");

    expect(deps.collection1).toHaveBeenCalledWith("users");
    expect(deps.doc1).toHaveBeenCalledWith("uid-chris");
    expect(deps.collection2).toHaveBeenCalledWith("secrets");
    expect(deps.doc2).toHaveBeenCalledWith("coachMattermost");

    expect(deps.setSpy).toHaveBeenCalledTimes(1);
    expect(deps.setSpy).toHaveBeenCalledWith({
      personalToken: "pat-abc123",
      coachMmUserId: "coach-mm-id-1",
      createdAt: { __op: "serverTimestamp" },
    });
  });

  it("returns the minted token on success", async () => {
    const deps = mkDeps();
    deps.mmApiCall = scriptMm({ postResult: { token: "pat-abc123" } });

    const result = await mintAndPersistCoachToken(deps, "uid-chris", "coach-mm-id-1");

    expect(result).toEqual({ token: "pat-abc123" });
  });

  it("returns null when MM returns no token (no orphan Firestore doc)", async () => {
    const deps = mkDeps();
    deps.mmApiCall = scriptMm({ postResult: {} });

    const result = await mintAndPersistCoachToken(deps, "uid-chris", "coach-mm-id-1");

    expect(result).toBeNull();
    expect(deps.setSpy).not.toHaveBeenCalled();
  });

  it("returns null when MM throws on mint (no silent crash, no orphan doc)", async () => {
    const deps = mkDeps();
    deps.mmApiCall = scriptMm({ postError: new Error("mm down") });

    const result = await mintAndPersistCoachToken(deps, "uid-chris", "coach-mm-id-1");

    expect(result).toBeNull();
    expect(deps.setSpy).not.toHaveBeenCalled();
  });

  it("does not write when coachMmUserId is empty (guard against provisioner regressions)", async () => {
    const deps = mkDeps();
    deps.mmApiCall = scriptMm({ postResult: { token: "pat-abc123" } });

    const result = await mintAndPersistCoachToken(deps, "uid-chris", "");

    expect(result).toBeNull();
    expect(deps.mmApiCall).not.toHaveBeenCalled();
    expect(deps.setSpy).not.toHaveBeenCalled();
  });
});

describe("mintAndPersistCoachToken — replace-not-append (PR3 P0 #2)", () => {
  it("revokes existing Octogee-description tokens before minting a new one", async () => {
    const deps = mkDeps();
    deps.mmApiCall = scriptMm({
      tokens: [
        { id: "tok-old-1", description: "Octogee coach agent (OpenClaw)" },
        { id: "tok-unrelated", description: "Some other token" },
        { id: "tok-old-2", description: "Octogee coach agent (OpenClaw)" },
      ],
      postResult: { token: "pat-new" },
    });

    await mintAndPersistCoachToken(deps, "uid-chris", "coach-mm-id-1");

    const revokeCalls = deps.mmApiCall.mock.calls.filter(
      (c: any[]) => c[0] === "POST" && c[1] === "/users/tokens/revoke",
    );
    expect(revokeCalls).toHaveLength(2);
    expect(revokeCalls.map((c: any[]) => c[2].token_id).sort()).toEqual(
      ["tok-old-1", "tok-old-2"],
    );
  });

  it("mints successfully when there are no existing tokens", async () => {
    const deps = mkDeps();
    deps.mmApiCall = scriptMm({ tokens: [], postResult: { token: "pat-new" } });

    const result = await mintAndPersistCoachToken(deps, "uid-chris", "coach-mm-id-1");

    expect(result).toEqual({ token: "pat-new" });
    const revokeCalls = deps.mmApiCall.mock.calls.filter(
      (c: any[]) => c[0] === "POST" && c[1] === "/users/tokens/revoke",
    );
    expect(revokeCalls).toHaveLength(0);
  });

  it("continues to mint when listing tokens throws (non-blocking revoke)", async () => {
    const deps = mkDeps();
    deps.mmApiCall = scriptMm({
      listError: new Error("mm 500"),
      postResult: { token: "pat-new" },
    });

    const result = await mintAndPersistCoachToken(deps, "uid-chris", "coach-mm-id-1");

    expect(result).toEqual({ token: "pat-new" });
    expect(deps.log).toHaveBeenCalled();
    const warnMsg = (deps.log.mock.calls[0] as unknown as string[])[0];
    expect(warnMsg).toContain("coach-mm-id-1");
  });

  it("continues to mint when a single revoke throws (non-blocking)", async () => {
    const deps = mkDeps();
    deps.mmApiCall = scriptMm({
      tokens: [{ id: "tok-old", description: "Octogee coach agent (OpenClaw)" }],
      revokeError: new Error("mm 403"),
      postResult: { token: "pat-new" },
    });

    const result = await mintAndPersistCoachToken(deps, "uid-chris", "coach-mm-id-1");

    expect(result).toEqual({ token: "pat-new" });
    expect(deps.log).toHaveBeenCalled();
  });
});
