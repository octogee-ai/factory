import { describe, it, expect, vi } from "vitest";
import { createMattermostChannelHost } from "@octogee/core/channel-host";
import { mintAndPersistCoachToken } from "../lib/mattermost.js";

type MmFake = (method: string, endpoint: string, body?: any) => Promise<unknown>;

function hostDeps(deps: { put: any; now: () => any; log: (msg: string) => void; mmApiCall: MmFake }) {
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const endpoint = String(input).replace("http://mm.test/api/v4", "");
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const result = await deps.mmApiCall(init?.method ?? "GET", endpoint, body);
    return new Response(JSON.stringify(result ?? null), { status: 200 });
  }) as typeof fetch;
  return {
    secrets: { put: deps.put },
    now: deps.now,
    channelHost: createMattermostChannelHost({
      baseUrl: "http://mm.test",
      adminToken: "admin",
      fetch: fetchImpl,
      log: deps.log,
    }),
  };
}

function mkDeps() {
  const put = vi.fn().mockResolvedValue(undefined);
  const mmApiCall = vi.fn(async (method: string, endpoint: string) => {
    if (method === "GET" && endpoint.endsWith("/tokens")) return [];
    return undefined;
  });
  const now = vi.fn(() => ({ serverNow: true }));
  const log = vi.fn();
  return { put, mmApiCall, now, log };
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

    await mintAndPersistCoachToken(hostDeps(deps), "uid-chris", "coach-mm-id-1");

    expect(deps.mmApiCall).toHaveBeenCalledWith(
      "POST",
      "/users/coach-mm-id-1/tokens",
      { description: "Octogee coach agent (OpenClaw)" },
    );
  });

  it("stores the PAT as the coach channel-host secret", async () => {
    const deps = mkDeps();
    deps.mmApiCall = scriptMm({ postResult: { token: "pat-abc123" } });

    await mintAndPersistCoachToken(hostDeps(deps), "uid-chris", "coach-mm-id-1");

    expect(deps.put).toHaveBeenCalledTimes(1);
    expect(deps.put).toHaveBeenCalledWith("uid-chris", expect.objectContaining({
      kind: "coach-mattermost",
      secretId: "coachMattermost",
      personalToken: "pat-abc123",
    }));
  });

  it("returns the minted token on success", async () => {
    const deps = mkDeps();
    deps.mmApiCall = scriptMm({ postResult: { token: "pat-abc123" } });

    const result = await mintAndPersistCoachToken(hostDeps(deps), "uid-chris", "coach-mm-id-1");

    expect(result).toEqual({ token: "pat-abc123" });
  });

  it("returns null when MM returns no token (no orphan Firestore doc)", async () => {
    const deps = mkDeps();
    deps.mmApiCall = scriptMm({ postResult: {} });

    const result = await mintAndPersistCoachToken(hostDeps(deps), "uid-chris", "coach-mm-id-1");

    expect(result).toBeNull();
    expect(deps.put).not.toHaveBeenCalled();
  });

  it("returns null when MM throws on mint (no silent crash, no orphan doc)", async () => {
    const deps = mkDeps();
    deps.mmApiCall = scriptMm({ postError: new Error("mm down") });

    const result = await mintAndPersistCoachToken(hostDeps(deps), "uid-chris", "coach-mm-id-1");

    expect(result).toBeNull();
    expect(deps.put).not.toHaveBeenCalled();
  });

  it("does not write when coachMmUserId is empty (guard against provisioner regressions)", async () => {
    const deps = mkDeps();
    deps.mmApiCall = scriptMm({ postResult: { token: "pat-abc123" } });

    const result = await mintAndPersistCoachToken(hostDeps(deps), "uid-chris", "");

    expect(result).toBeNull();
    expect(deps.mmApiCall).not.toHaveBeenCalled();
    expect(deps.put).not.toHaveBeenCalled();
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

    await mintAndPersistCoachToken(hostDeps(deps), "uid-chris", "coach-mm-id-1");

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

    const result = await mintAndPersistCoachToken(hostDeps(deps), "uid-chris", "coach-mm-id-1");

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

    const result = await mintAndPersistCoachToken(hostDeps(deps), "uid-chris", "coach-mm-id-1");

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

    const result = await mintAndPersistCoachToken(hostDeps(deps), "uid-chris", "coach-mm-id-1");

    expect(result).toEqual({ token: "pat-new" });
    expect(deps.log).toHaveBeenCalled();
  });
});
