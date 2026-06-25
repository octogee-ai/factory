import { describe, it, expect } from "vitest";
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

describe("commitAndPushWorkspace", () => {
  it("is a clean no-op when there is nothing to commit — and never pushes", async () => {
    let pushed = false;
    const push: PushFn = async () => {
      pushed = true;
      return { ok: true };
    };
    const r = await commitAndPushWorkspace("/d", { message: "m", author }, { gitCommit: commitOk(true), gitPush: push });
    expect(r).toEqual({ ok: true, result: { committed: false, pushed: false, nothingToCommit: true } });
    expect(pushed).toBe(false);
  });

  it("commits then pushes on success", async () => {
    const r = await commitAndPushWorkspace("/d", { message: "m", author }, { gitCommit: commitOk(false), gitPush: pushOk });
    expect(r).toEqual({ ok: true, result: { committed: true, pushed: true, nothingToCommit: false } });
  });

  it("returns committed-but-not-pushed (with pushError) when push fails — not fatal", async () => {
    const r = await commitAndPushWorkspace("/d", { message: "m", author }, { gitCommit: commitOk(false), gitPush: pushFail });
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
    const r = await commitAndPushWorkspace("/d", { message: "m", author }, { gitCommit: commitFail, gitPush: push });
    expect(r.ok).toBe(false);
    expect(pushed).toBe(false);
  });
});
