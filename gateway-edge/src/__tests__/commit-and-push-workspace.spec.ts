import { describe, it, expect, vi } from "vitest";
import { commitAndPushWorkspace, type CommitAndPushDeps } from "../lib/workspace-git.js";

const author = { name: "acme", email: "acme@octogee.local" };

type CommitFn = CommitAndPushDeps["gitCommit"];
type PushFn = CommitAndPushDeps["gitPush"];

const commitOk = (empty: boolean): CommitFn => async () => ({
  ok: true,
  result: { sha: empty ? "" : "abc123", empty },
});
const commitFail: CommitFn = async () => ({
  ok: false,
  error: { code: "GIT_FAILED", cwd: "/d", status: 1, stderr: "boom" },
});
const pushOk: PushFn = async () => ({ ok: true });
const pushFail: PushFn = async () => ({
  ok: false,
  error: { code: "GIT_FAILED", cwd: "/d", status: 1, stderr: "rejected" },
});
const mutationDeps = (
  gitCommit: CommitFn,
  gitPush: PushFn,
  release = vi.fn(),
): CommitAndPushDeps => ({
  gitCommit,
  gitPush,
  acquireMutationLease: () => ({ ownerToken: "lease", release }),
});

describe("commitAndPushWorkspace", () => {
  it("is a clean no-op when there is nothing to commit — and never pushes", async () => {
    let pushed = false;
    const push: PushFn = async () => {
      pushed = true;
      return { ok: true };
    };
    const r = await commitAndPushWorkspace("/d", { message: "m", author }, mutationDeps(commitOk(true), push));
    expect(r).toEqual({ ok: true, result: { committed: false, pushed: false, nothingToCommit: true } });
    expect(pushed).toBe(false);
  });

  it("commits then pushes on success", async () => {
    const release = vi.fn();
    const r = await commitAndPushWorkspace("/d", { message: "m", author }, mutationDeps(commitOk(false), pushOk, release));
    expect(r).toEqual({ ok: true, result: { committed: true, pushed: true, nothingToCommit: false } });
    expect(release).toHaveBeenCalledOnce();
  });

  it("forwards excludePathspecs to gitCommit — the workspace-lane projects/ exclusion rides through", async () => {
    let seen: unknown;
    const commit: CommitFn = async (_dir, options) => {
      seen = options;
      return { ok: true, result: { sha: "abc123", empty: false } };
    };
    await commitAndPushWorkspace(
      "/d",
      { message: "m", author, excludePathspecs: ["projects"] },
      mutationDeps(commit, pushOk),
    );
    expect(seen).toMatchObject({ excludePathspecs: ["projects"] });
  });

  it("returns committed-but-not-pushed (with pushError) when push fails — not fatal", async () => {
    const r = await commitAndPushWorkspace("/d", { message: "m", author }, mutationDeps(commitOk(false), pushFail));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.result).toMatchObject({ committed: true, pushed: false, nothingToCommit: false });
      expect(r.result.pushError).toContain("git failed");
    }
  });

  it("propagates a commit failure as a hard error (no push attempted)", async () => {
    let pushed = false;
    const push: PushFn = async () => {
      pushed = true;
      return { ok: true };
    };
    const r = await commitAndPushWorkspace("/d", { message: "m", author }, mutationDeps(commitFail, push));
    expect(r.ok).toBe(false);
    expect(pushed).toBe(false);
  });

  it("returns WORKSPACE_BUSY without invoking git when an import holds the shared lease", async () => {
    const commit = commitOk(false);
    const deps: CommitAndPushDeps = {
      gitCommit: vi.fn(commit),
      gitPush: vi.fn(pushOk),
      acquireMutationLease: () => null,
    };

    const result = await commitAndPushWorkspace("/d", { message: "m", author }, deps);

    expect(result).toEqual({
      ok: false,
      error: { code: "WORKSPACE_BUSY", cwd: "/d" },
    });
    expect(deps.gitCommit).not.toHaveBeenCalled();
    expect(deps.gitPush).not.toHaveBeenCalled();
  });
});
