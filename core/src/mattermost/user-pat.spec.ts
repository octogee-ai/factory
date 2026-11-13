import { describe, expect, it, vi } from "vitest";
import { USER_PAT_DESCRIPTION, revokeAndMintUserPat } from "./user-pat.js";

function deps() {
  return {
    mmApiCall: vi.fn(),
    writeUserSecret: vi.fn(async () => undefined),
    now: vi.fn(() => ({ __op: "serverTimestamp" })),
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

describe("revokeAndMintUserPat", () => {
  it("revokes stale Octogee user tokens before writing the newly minted token", async () => {
    const d = deps();
    d.mmApiCall = mm({
      tokens: [
        { id: "old-1", description: USER_PAT_DESCRIPTION },
        { id: "old-2", description: USER_PAT_DESCRIPTION },
        { id: "keep", description: "other" },
      ],
      mintResult: { token: "pat-new-1234" },
    });

    const result = await revokeAndMintUserPat(d, "uid-user", "mm-user");

    expect(result).toEqual({
      outcome: "rotated",
      newTokenLastFour: "1234",
      revokedTokenIds: ["old-1", "old-2"],
    });
    expect(d.mmApiCall).toHaveBeenCalledWith("POST", "/users/tokens/revoke", { token_id: "old-1" });
    expect(d.mmApiCall).toHaveBeenCalledWith("POST", "/users/tokens/revoke", { token_id: "old-2" });
    expect(d.mmApiCall).toHaveBeenCalledWith("POST", "/users/mm-user/tokens", {
      description: USER_PAT_DESCRIPTION,
    });
    expect(d.writeUserSecret).toHaveBeenCalledWith("uid-user", {
      personalToken: "pat-new-1234",
      rotatedAt: { __op: "serverTimestamp" },
    });
  });

  it("returns mm-user-missing without touching Mattermost when the user user id is absent", async () => {
    const d = deps();

    await expect(revokeAndMintUserPat(d, "uid-user", "")).resolves.toEqual({
      outcome: "mm-user-missing",
    });

    expect(d.mmApiCall).not.toHaveBeenCalled();
    expect(d.writeUserSecret).not.toHaveBeenCalled();
  });

  it("treats list and revoke failures as non-blocking but does not persist failed mints", async () => {
    const d = deps();
    d.mmApiCall = mm({
      listError: new Error("list failed"),
      mintResult: { token: "pat-new-1234" },
    });

    await expect(revokeAndMintUserPat(d, "uid-user", "mm-user")).resolves.toMatchObject({
      outcome: "rotated",
      revokedTokenIds: [],
    });

    d.writeUserSecret.mockClear();
    d.mmApiCall = mm({ mintError: new Error("mint failed") });

    await expect(revokeAndMintUserPat(d, "uid-user", "mm-user")).resolves.toMatchObject({
      outcome: "mint-failed",
    });
    expect(d.writeUserSecret).not.toHaveBeenCalled();
  });
});
