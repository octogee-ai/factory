import { describe, expect, it, vi } from "vitest";
import { createMattermostChannelHost } from "../channel-host/mattermost.js";
import { COACH_PAT_DESCRIPTION, mintAndPersistCoachToken } from "./coach-pat.js";

type MmFake = (method: string, endpoint: string, body?: unknown) => Promise<unknown>;

function fetchOver(mmApiCall: MmFake): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const endpoint = String(input).replace("http://mm.test/api/v4", "");
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const result = await mmApiCall(init?.method ?? "GET", endpoint, body);
    return new Response(JSON.stringify(result ?? null), { status: 200 });
  }) as typeof fetch;
}

function mintDeps(d: ReturnType<typeof deps>) {
  return {
    secrets: d.secrets,
    channelHost: createMattermostChannelHost({
      baseUrl: "http://mm.test",
      adminToken: "admin",
      fetch: fetchOver(d.mmApiCall),
      log: d.log,
    }),
  };
}

function deps() {
  return {
    secrets: { put: vi.fn(async () => undefined) },
    mmApiCall: vi.fn<MmFake>(),
    log: vi.fn(),
  };
}

function mm(opts: {
  tokens?: unknown[];
  mintResult?: unknown;
  listError?: Error;
  mintError?: Error;
  revokeError?: Error;
}) {
  return vi.fn(async (method: string, endpoint: string, _body?: unknown) => {
    if (method === "GET" && endpoint.endsWith("/tokens")) {
      if (opts.listError) throw opts.listError;
      return opts.tokens ?? [];
    }
    if (method === "POST" && endpoint.endsWith("/tokens")) {
      if (opts.mintError) throw opts.mintError;
      return opts.mintResult;
    }
    if (method === "POST" && endpoint === "/users/tokens/revoke") {
      if (opts.revokeError) throw opts.revokeError;
      return {};
    }
    throw new Error(`unexpected mmApiCall: ${method} ${endpoint}`);
  });
}

describe("mintAndPersistCoachToken", () => {
  it("revokes stale coach tokens, mints a new PAT, and persists it under the user secret", async () => {
    const d = deps();
    d.mmApiCall = mm({
      tokens: [
        { id: "old-1", description: COACH_PAT_DESCRIPTION },
        { id: "keep", description: "other" },
      ],
      mintResult: { token: "coach-pat" },
    });

    await expect(mintAndPersistCoachToken(mintDeps(d), "uid-coach", "mm-coach")).resolves.toEqual({
      token: "coach-pat",
    });

    expect(d.mmApiCall).toHaveBeenCalledWith("POST", "/users/tokens/revoke", { token_id: "old-1" });
    expect(d.mmApiCall).toHaveBeenCalledWith("POST", "/users/mm-coach/tokens", {
      description: COACH_PAT_DESCRIPTION,
    });
    expect(d.secrets.put).toHaveBeenCalledWith("uid-coach", {
      kind: "coach-mattermost",
      secretId: "coachMattermost",
      projectId: null,
      personalToken: "coach-pat",
      mattermostUserId: "mm-coach",
      createdAt: { serverNow: true },
      rotatedAt: null,
    });
  });

  it("returns null without writing when the coach user id or minted token is missing", async () => {
    const d = deps();
    d.mmApiCall = mm({ mintResult: { token: "coach-pat" } });

    await expect(mintAndPersistCoachToken(mintDeps(d), "uid-coach", "")).resolves.toBeNull();
    expect(d.mmApiCall).not.toHaveBeenCalled();
    expect(d.secrets.put).not.toHaveBeenCalled();

    d.mmApiCall = mm({ mintResult: { ok: true } });
    await expect(mintAndPersistCoachToken(mintDeps(d), "uid-coach", "mm-coach")).resolves.toBeNull();
    expect(d.secrets.put).not.toHaveBeenCalled();
  });

  it("continues minting when stale-token listing or revoke fails", async () => {
    const d = deps();
    d.mmApiCall = mm({
      listError: new Error("list failed"),
      mintResult: { token: "coach-pat" },
    });

    await expect(mintAndPersistCoachToken(mintDeps(d), "uid-coach", "mm-coach")).resolves.toEqual({
      token: "coach-pat",
    });
    expect(d.log).toHaveBeenCalled();

    const d2 = deps();
    d2.mmApiCall = mm({
      tokens: [{ id: "old-1", description: COACH_PAT_DESCRIPTION }],
      revokeError: new Error("revoke failed"),
      mintResult: { token: "coach-pat" },
    });

    await expect(mintAndPersistCoachToken(mintDeps(d2), "uid-coach", "mm-coach")).resolves.toEqual({
      token: "coach-pat",
    });
    expect(d2.log).toHaveBeenCalled();
  });
});
