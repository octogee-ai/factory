import { describe, expect, it, vi } from "vitest";
import { COACH_PAT_DESCRIPTION, mintAndPersistCoachToken } from "./coach-pat.js";

function deps() {
  const set = vi.fn(async () => undefined);
  const secretDoc = vi.fn(() => ({ set }));
  const secrets = vi.fn(() => ({ doc: secretDoc }));
  const userDoc = vi.fn(() => ({ collection: secrets }));
  const users = vi.fn(() => ({ doc: userDoc }));
  return {
    db: { collection: users },
    mmApiCall: vi.fn(),
    now: vi.fn(() => ({ __op: "serverTimestamp" })),
    log: vi.fn(),
    set,
    users,
    userDoc,
    secrets,
    secretDoc,
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

    await expect(mintAndPersistCoachToken(d, "uid-coach", "mm-coach")).resolves.toEqual({
      token: "coach-pat",
    });

    expect(d.mmApiCall).toHaveBeenCalledWith("POST", "/users/tokens/revoke", { token_id: "old-1" });
    expect(d.mmApiCall).toHaveBeenCalledWith("POST", "/users/mm-coach/tokens", {
      description: COACH_PAT_DESCRIPTION,
    });
    expect(d.users).toHaveBeenCalledWith("users");
    expect(d.userDoc).toHaveBeenCalledWith("uid-coach");
    expect(d.secrets).toHaveBeenCalledWith("secrets");
    expect(d.secretDoc).toHaveBeenCalledWith("coachMattermost");
    expect(d.set).toHaveBeenCalledWith({
      personalToken: "coach-pat",
      coachMmUserId: "mm-coach",
      createdAt: { __op: "serverTimestamp" },
    });
  });

  it("returns null without writing when the coach user id or minted token is missing", async () => {
    const d = deps();
    d.mmApiCall = mm({ mintResult: { token: "coach-pat" } });

    await expect(mintAndPersistCoachToken(d, "uid-coach", "")).resolves.toBeNull();
    expect(d.mmApiCall).not.toHaveBeenCalled();
    expect(d.set).not.toHaveBeenCalled();

    d.mmApiCall = mm({ mintResult: { ok: true } });
    await expect(mintAndPersistCoachToken(d, "uid-coach", "mm-coach")).resolves.toBeNull();
    expect(d.set).not.toHaveBeenCalled();
  });

  it("continues minting when stale-token listing or revoke fails", async () => {
    const d = deps();
    d.mmApiCall = mm({
      listError: new Error("list failed"),
      mintResult: { token: "coach-pat" },
    });

    await expect(mintAndPersistCoachToken(d, "uid-coach", "mm-coach")).resolves.toEqual({
      token: "coach-pat",
    });
    expect(d.log).toHaveBeenCalled();

    const d2 = deps();
    d2.mmApiCall = mm({
      tokens: [{ id: "old-1", description: COACH_PAT_DESCRIPTION }],
      revokeError: new Error("revoke failed"),
      mintResult: { token: "coach-pat" },
    });

    await expect(mintAndPersistCoachToken(d2, "uid-coach", "mm-coach")).resolves.toEqual({
      token: "coach-pat",
    });
    expect(d2.log).toHaveBeenCalled();
  });
});
