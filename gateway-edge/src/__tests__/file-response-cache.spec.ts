import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  cachedWorkspaceFileResponse,
  clearWorkspaceFileResponseCache,
  invalidateWorkspaceFileResponseCache,
  workspaceFileCacheKey,
  workspaceFileTargetCacheKey,
} from "../routes/workspace/file-response-cache.js";
import type { FileTarget } from "../lib/fileTarget.js";

const target: FileTarget = {
  slug: "alice",
  projectSlug: null,
  provider: "gitea",
  org: "alice",
  repoName: "workspace",
  gcsPrefix: "customers/alice",
  sudoUser: "ws-alice",
  brokered: false,
};

const key = workspaceFileCacheKey("list", target, "");

beforeEach(() => clearWorkspaceFileResponseCache());

describe("cachedWorkspaceFileResponse", () => {
  it("separates full owner responses from brokered workspace-member responses", () => {
    expect(workspaceFileTargetCacheKey(target)).not.toBe(workspaceFileTargetCacheKey({
      ...target,
      brokered: true,
      workspaceMemberBrokered: true,
    }));
  });

  it("caches the loaded value and reuses it on subsequent reads", async () => {
    const load = vi.fn().mockResolvedValue("v1");
    expect(await cachedWorkspaceFileResponse(key, 1000, load)).toBe("v1");
    expect(await cachedWorkspaceFileResponse(key, 1000, load)).toBe("v1");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("de-dupes concurrent loads for the same key", async () => {
    const load = vi.fn().mockResolvedValue("v1");
    const [a, b] = await Promise.all([
      cachedWorkspaceFileResponse(key, 1000, load),
      cachedWorkspaceFileResponse(key, 1000, load),
    ]);
    expect([a, b]).toEqual(["v1", "v1"]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does NOT cache a load that raced an invalidation (the write wins)", async () => {
    let resolveLoad: (v: string) => void = () => {};
    const load = vi.fn().mockImplementation(() => new Promise<string>((r) => { resolveLoad = r; }));

    const inflightRead = cachedWorkspaceFileResponse(key, 1000, load); // load started
    invalidateWorkspaceFileResponseCache(target);                      // a write invalidates mid-load
    resolveLoad("stale");
    expect(await inflightRead).toBe("stale"); // caller still gets its result

    // The stale value must not have been re-inserted — the next read re-loads.
    const load2 = vi.fn().mockResolvedValue("fresh");
    expect(await cachedWorkspaceFileResponse(key, 1000, load2)).toBe("fresh");
    expect(load2).toHaveBeenCalledTimes(1);
  });
});
