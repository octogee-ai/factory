import { afterEach, describe, expect, it, vi } from "vitest";
import { persistBuilderProjects, startProjectAutosave } from "../lib/project-persistence.js";
import { withBuilderClaim } from "./helpers/builder-claim.js";

afterEach(() => vi.useRealTimers());
describe("project remote save client", () => {
  it("requires the same owner and a current workload token", async () => {
    const deps = { env: withBuilderClaim({}, "alice"), readToken: vi.fn(async () => "jwt\n"), fetch: vi.fn(async () => Response.json({ projects: 2 })) };
    await expect(persistBuilderProjects("bob", deps)).rejects.toThrow(/slug/);
    expect(deps.readToken).not.toHaveBeenCalled();
    await persistBuilderProjects("alice", deps);
    expect(deps.fetch).toHaveBeenCalledWith("http://127.0.0.1:3001/internal/projects/flush", expect.objectContaining({ headers: expect.objectContaining({ "x-k8s-sa-token": "jwt" }), body: '{"slug":"alice"}' }));
    deps.readToken.mockResolvedValue("");
    await expect(persistBuilderProjects("alice", deps)).rejects.toThrow(/credential/);
  });
  it.each([new Response("", { status: 503 }), Response.json({ projects: "1" }), Response.json({})])("refuses an unsuccessful or malformed acknowledgement", async response => {
    await expect(persistBuilderProjects("alice", { env: withBuilderClaim({}, "alice"), readToken: async () => "jwt", fetch: vi.fn(async () => response) })).rejects.toThrow();
  });
  it("does not overlap slow saves and retries after a logged failure", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const save = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; })).mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    const log = vi.fn();
    const close = startProjectAutosave({ save, log }, 100);
    await vi.advanceTimersByTimeAsync(500);
    expect(save).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(100);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("offline"));
    await vi.advanceTimersByTimeAsync(100);
    expect(save).toHaveBeenCalledTimes(3);
    close();
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).toHaveBeenCalledTimes(3);
  });
});
