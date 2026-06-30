import { describe, expect, it, vi } from "vitest";
import { BUILDER_PAT_DESCRIPTION, revokeAndMintBuilderPat } from "./builder-pat.js";

function deps() {
  return {
    mmApiCall: vi.fn(),
    writeBuilderSecret: vi.fn(async () => undefined),
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

describe("revokeAndMintBuilderPat", () => {
  it("revokes stale Octogee builder tokens before writing the newly minted token", async () => {
    const d = deps();
    d.mmApiCall = mm({
      tokens: [
        { id: "old-1", description: BUILDER_PAT_DESCRIPTION },
        { id: "old-2", description: BUILDER_PAT_DESCRIPTION },
        { id: "keep", description: "other" },
      ],
      mintResult: { token: "pat-new-1234" },
    });

    const result = await revokeAndMintBuilderPat(d, "uid-builder", "mm-builder");

    expect(result).toEqual({
      outcome: "rotated",
      newTokenLastFour: "1234",
      revokedTokenIds: ["old-1", "old-2"],
    });
    expect(d.mmApiCall).toHaveBeenCalledWith("POST", "/users/tokens/revoke", { token_id: "old-1" });
    expect(d.mmApiCall).toHaveBeenCalledWith("POST", "/users/tokens/revoke", { token_id: "old-2" });
    expect(d.mmApiCall).toHaveBeenCalledWith("POST", "/users/mm-builder/tokens", {
      description: BUILDER_PAT_DESCRIPTION,
    });
    expect(d.writeBuilderSecret).toHaveBeenCalledWith("uid-builder", {
      personalToken: "pat-new-1234",
      rotatedAt: { __op: "serverTimestamp" },
    });
  });

  it("returns mm-user-missing without touching Mattermost when the builder user id is absent", async () => {
    const d = deps();

    await expect(revokeAndMintBuilderPat(d, "uid-builder", "")).resolves.toEqual({
      outcome: "mm-user-missing",
    });

    expect(d.mmApiCall).not.toHaveBeenCalled();
    expect(d.writeBuilderSecret).not.toHaveBeenCalled();
  });

  it("treats list and revoke failures as non-blocking but does not persist failed mints", async () => {
    const d = deps();
    d.mmApiCall = mm({
      listError: new Error("list failed"),
      mintResult: { token: "pat-new-1234" },
    });

    await expect(revokeAndMintBuilderPat(d, "uid-builder", "mm-builder")).resolves.toMatchObject({
      outcome: "rotated",
      revokedTokenIds: [],
    });

    d.writeBuilderSecret.mockClear();
    d.mmApiCall = mm({ mintError: new Error("mint failed") });

    await expect(revokeAndMintBuilderPat(d, "uid-builder", "mm-builder")).resolves.toMatchObject({
      outcome: "mint-failed",
    });
    expect(d.writeBuilderSecret).not.toHaveBeenCalled();
  });
});
